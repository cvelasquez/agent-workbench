import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOpenCodeV2Fixture } from './fixtures/opencode-v2-db.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-opencode-v2-db-'));
const fixture = createOpenCodeV2Fixture(path.join(root, 'fixture.db'));
const { ReadOnlyDatabase, loadSqlite } = await import('../src/agents/sqlite.ts');
const { OPENCODE_V2_REQUIRED_COLUMNS, OPENCODE_V2_SQL } = await import('../src/agents/opencode/sql-v2.ts');
const { createOpenCodeV2History, readV2PartCall, readV2SessionParent, readV2PromptChoice } = await import('../src/agents/opencode/history-v2.ts');
const db = new ReadOnlyDatabase(fixture.file, { idleCloseMs:30000, required:OPENCODE_V2_REQUIRED_COLUMNS, label:'OpenCode fixture', sqlite:loadSqlite });
const history = createOpenCodeV2History({ dbFile:fixture.file, db, signal:{subscribe:()=>()=>{}},
  catalog:{contextWindow:async()=>64000}, platform:'win32', sqlite:loadSqlite });

try {
  const items = await history.list();
  assert.equal(items.length, 2, 'solo enumera sesiones raíz');
  assert.equal(await history.scan(items.find(x=>x.ref==='ses_empty')), null, 'sesión vacía sin título queda oculta');
  const scanned = await history.scan(items.find(x=>x.ref==='ses_test'));
  assert.equal(scanned.summary.title, 'Pregunta inicial');
  assert.equal(scanned.summary.titleSource, 'first-message');
  assert.equal(scanned.cwd, 'D:\\test project');
  assert.equal(await history.exists('', 'ses_test'), true);
  assert.equal(await history.exists('', 'ses_absent'), false);
  assert.equal(readV2SessionParent(db, 'ses_child'), 'ses_test');
  fixture.db.prepare('UPDATE session_v2 SET agent = ?, model = ? WHERE id = ?').run('plan',JSON.stringify({providerID:'fixture',id:'test-model',variant:'low'}),'ses_test');
  assert.deepEqual(readV2PromptChoice(db, 'ses_test'), {agent:'plan',providerID:'fixture',modelID:'test-model',variant:'low'});

  const follower = history.follow({sessionId:'ses_test',cwd:'D:\\test project'});
  await follower.start();
  const first = await follower.poll();
  assert.deepEqual(first.added.map(e=>e.role), ['user','assistant']);
  assert.equal(first.added[1].parts[0].text, 'Respuesta');
  assert.equal(first.added[1].at, 120);
  assert.equal(first.added[1].durationMs, 400);
  assert.equal(first.added[1].model, 'fixture/test-model');
  assert.ok(!JSON.stringify(first).includes('PRIVATE_REASONING'));
  assert.equal(follower.getUsage().contextWindow, 64000);
  assert.equal(follower.getUsage().lastRequestTokens, 1310);
  assert.equal((await follower.poll()).added.length, 0);

  fixture.message('msg_answer','assistant',2,{time:{created:120,completed:500},model:{providerID:'fixture',id:'test-model'},content:[{type:'reasoning',text:'PRIVATE_REASONING'}, {type:'text',text:'Respuesta extendida'}],finish:'stop'}, {updated:3500});
  const updated = await follower.poll();
  assert.equal(updated.parts[0].parts[0].text, 'Respuesta extendida', 'actualiza texto entregado');
  fixture.inbox('msg_queued','Mensaje en cola');
  fixture.inbox('msg_steer','Intervención',{delivery:'steer',seq:31});
  await follower.poll();
  assert.deepEqual(follower.queuedPrompts(0).map(q=>q.text), ['Mensaje en cola']);
  assert.deepEqual(follower.queuedPrompts(9000).map(q=>q.text), ['Mensaje en cola'],'la bandeja durable sigue visible al reanudar');
  fixture.db.prepare('DELETE FROM session_inbox WHERE id = ?').run('msg_queued');
  await follower.poll();
  assert.deepEqual(follower.queuedPrompts(0), []);

  fixture.message('msg_tool','assistant',4,{time:{created:550,completed:650},model:{providerID:'fixture',id:'test-model'},content:[
    {type:'tool',id:'call_test',name:'shell',time:{created:570,completed:630},state:{status:'completed',input:{command:'echo ok'},content:[{type:'text',text:'ok'}]}}
  ],finish:'stop'},{updated:4000});
  const tools = await follower.poll();
  assert.equal(tools.added[0].parts[0].toolUseId, 'call_test');
  assert.equal(tools.added[0].parts[1].text, 'ok');
  assert.equal(follower.getPageBefore(tools.added[0].eventId,1).events.length, 1);

  fixture.message('msg_error','assistant',5,{time:{created:700,completed:750},content:[],error:{type:'APIError',message:'Failure',response:{body:'PRIVATE_RESPONSE'}}},{updated:5000});
  const errors = await follower.poll();
  assert.match(errors.added[0].parts[0].detail,/APIError: Failure/);
  assert.ok(!JSON.stringify(errors).includes('PRIVATE_RESPONSE'));

  const limited = history.follow({sessionId:'ses_test',cwd:'D:\\test project'},{maxEvents:2,limits:{textMaxChars:5,toolInputMaxChars:5,toolResultMaxChars:5}});
  await limited.poll();
  assert.equal(limited.getTail(10).events.length, 2);
  assert.equal(limited.getTail(10).hasMore, true);
  fixture.db.prepare('UPDATE session_v2 SET revert = ? WHERE id = ?').run(JSON.stringify({messageID:'msg_tool'}),'ses_test');
  assert.equal((await follower.poll()).reset, true, 'revert elimina eventos posteriores');
  assert.ok(!follower.getTail(100).events.some(e=>e.parts.some(p=>p.toolUseId==='call_test')));

  fixture.db.prepare('UPDATE session_v2 SET revert = NULL WHERE id = ?').run('ses_test');
  fixture.message('msg_question','assistant',6,{time:{created:800,completed:850},content:[{
    type:'tool',id:'call_question',name:'question',time:{created:805,completed:830},state:{status:'completed',
      input:{questions:[{header:'Choice',question:'Choose one',options:[{label:'One',description:'First'},{label:'Two',description:'Second'}],multiple:false}]},
      content:[{type:'text',text:'Raw answer'}],metadata:{answers:[['One']],private:'PRIVATE_METADATA'}}
  }],finish:'tool-calls'},{updated:6000});
  await follower.poll();
  const questionEvent=follower.getTail(100).events.find(e=>e.parts.some(p=>p.toolUseId==='call_question'));
  assert.equal(questionEvent.parts[0].kind,'question');
  assert.equal(questionEvent.parts[1].text,'Choice: One');
  assert.ok(!JSON.stringify(questionEvent).includes('PRIVATE_METADATA'));
  assert.deepEqual(readV2PartCall(db,'call_question','ses_test'),{messageId:'msg_question',callId:'call_question'});
  assert.equal(readV2PartCall(db,'call_question','ses_child'),null);

  fixture.message('msg_compaction','compaction',7,{time:{created:900},status:'running',reason:'auto'},{updated:6500});
  await follower.poll();
  assert.ok(!follower.getTail(100).events.some(e=>e.parts.some(p=>p.notice==='compacted')),'compactar en curso no anuncia que terminó');
  assert.notEqual(follower.getUsage().compacted,true);
  fixture.message('msg_compaction','compaction',7,{time:{created:900},status:'failed',reason:'auto',error:{type:'APIError',message:'Compaction failed',responseBody:'PRIVATE_COMPACTION_ERROR'}},{updated:6600});
  await follower.poll();
  assert.ok(follower.getTail(100).events.some(e=>e.parts.some(p=>p.notice==='error'&&p.detail.includes('Compaction failed'))));
  assert.notEqual(follower.getUsage().compacted,true);
  assert.ok(!JSON.stringify(follower.getTail(100)).includes('PRIVATE_COMPACTION_ERROR'));
  fixture.message('msg_compaction','compaction',7,{time:{created:900},status:'completed',reason:'auto',summary:'PRIVATE_SUMMARY',tokens:{input:100,output:2,reasoning:0,cache:{read:0,write:0}}},{updated:7000});
  const compaction=await follower.poll();
  assert.ok(follower.getTail(100).events.some(e=>e.parts.some(p=>p.notice==='compacted')));
  assert.ok(!JSON.stringify(compaction).includes('PRIVATE_SUMMARY'));
  assert.equal(follower.getUsage().compacted,true);

  const limitedText=history.follow({sessionId:'ses_test',cwd:''},{limits:{textMaxChars:5,toolInputMaxChars:5,toolResultMaxChars:5},maxEvents:Infinity});
  await limitedText.poll();
  const userText=limitedText.getTail(100).events[0].parts[0];
  assert.equal(userText.text,'Pregu');
  assert.equal(userText.truncated,true);
  fixture.session('ses_other');
  fixture.message('msg_private','user',1,{text:'PRIVATE_OTHER_SESSION',time:{created:100}},{sessionID:'ses_other',updated:8000});
  await follower.poll();
  assert.ok(!JSON.stringify(follower.getTail(100)).includes('PRIVATE_OTHER_SESSION'));
  assert.ok((await history.changedRefs(fixture.file)).includes('ses_other'));
  fixture.db.prepare('DELETE FROM session_v2 WHERE id = ?').run('ses_other');
  assert.ok((await history.changedRefs(fixture.file)).includes('ses_other'));

  fixture.message('msg_image','user',8,{time:{created:1000},text:'Imagen de prueba',files:[
    {data:'aW1hZ2U=',mime:'image/png',source:{type:'inline'},name:'sample.png'},
    {data:'ZG9jdW1lbnQ=',mime:'text/plain',source:{type:'inline'},name:'sample.txt'},
  ]},{updated:8000});
  const imagePoll=await follower.poll();
  assert.equal(imagePoll.added[0].parts[0].kind,'image');
  assert.deepEqual(await follower.readImage('msg_image',0,'content'),{mediaType:'image/png',data:'aW1hZ2U='});
  assert.equal(await follower.readImage('msg_image',1,'content'),null);
  assert.equal(await follower.readImage('msg_private',0,'content'),null);
  assert.equal(await follower.readImage('msg_image',-1,'content'),null);
  assert.equal(db.get(OPENCODE_V2_SQL.image,{$s:'ses_test',$id:'msg_image',$index:0,$max:4}).data,null,'corta la imagen en SQL antes de traer sus datos');

  fixture.message('msg_imported','user',0,{time:{created:50},text:'Mensaje importado antes del cursor'},{updated:50});
  assert.equal((await follower.poll()).reset,true,'recarga mensajes importados fuera del cursor de tiempo');
  assert.equal(follower.getTail(100).events[0].parts[0].text,'Mensaje importado antes del cursor');

  const missingFile=path.join(root,'missing.db');
  const missingDb=new ReadOnlyDatabase(missingFile,{idleCloseMs:30000,required:OPENCODE_V2_REQUIRED_COLUMNS,label:'Missing fixture',sqlite:loadSqlite});
  const missingHistory=createOpenCodeV2History({dbFile:missingFile,db:missingDb,signal:{subscribe:()=>()=>{}},catalog:{contextWindow:async()=>null},platform:'win32',sqlite:loadSqlite});
  assert.equal(await missingHistory.list(),null);
  assert.equal(await missingHistory.rootExists(),false);
  const missingFollower=missingHistory.follow({sessionId:'ses_missing',cwd:''});
  await missingFollower.poll();
  assert.equal(missingFollower.getState(),'waiting');
  missingDb.close();

  fixture.message('msg_aborted','assistant',9,{time:{created:1200,completed:1250},content:[],finish:'error',error:{type:'aborted',message:'Step interrupted'}},{updated:9000});
  const interrupted=await follower.poll();
  assert.equal(interrupted.added[0].parts[0].notice,'interrupted','aborted V2 se muestra como interrupción');
  assert.equal(interrupted.added[0].parts[0].detail,'');

  fixture.session('ses_parts');
  fixture.message('msg_part_user','user',1,{time:{created:100},text:'Pregunta con partes'},{sessionID:'ses_parts'});
  fixture.message('msg_part_answer','assistant',2,{time:{created:120},content:[]},{sessionID:'ses_parts',updated:10000});
  const putPart=fixture.db.prepare('INSERT OR REPLACE INTO session_part VALUES (?,?,?,?,?,?,?,?)');
  putPart.run('msg_part_answer','ses_parts',0,'text',null,120,10001,JSON.stringify({type:'text',text:'Respuesta por partes'}));
  putPart.run('msg_part_answer','ses_parts',1,'reasoning',null,121,10001,JSON.stringify({type:'reasoning',text:'PRIVATE_PART_REASONING'}));
  putPart.run('msg_part_answer','ses_parts',2,'tool','call_part_question',122,10001,JSON.stringify({type:'tool',id:'call_part_question',name:'question',state:{status:'running',input:{questions:[{header:'Choice',question:'Choose',options:[{label:'One'}]}]}}}));
  const partsFollower=history.follow({sessionId:'ses_parts',cwd:''});
  await partsFollower.poll();
  assert.ok(JSON.stringify(partsFollower.getTail(100)).includes('Respuesta por partes'),'lee session_part cuando content está vacío');
  assert.ok(!JSON.stringify(partsFollower.getTail(100)).includes('PRIVATE_PART_REASONING'));
  assert.deepEqual(readV2PartCall(db,'call_part_question','ses_parts'),{messageId:'msg_part_answer',callId:'call_part_question'});
  putPart.run('msg_part_answer','ses_parts',0,'text',null,120,10002,JSON.stringify({type:'text',text:'Respuesta por partes extendida'}));
  const changedPart=await partsFollower.poll();
  assert.ok(changedPart.parts.some(update=>update.parts.some(part=>part.text==='Respuesta por partes extendida')),'detecta cambios solo en session_part');
  fixture.message('msg_part_answer','assistant',2,{time:{created:120},content:[{type:'text',text:'Copia inline'}]},{sessionID:'ses_parts',updated:10003});
  await partsFollower.poll();
  assert.ok(!JSON.stringify(partsFollower.getTail(100)).includes('Copia inline'),'prioriza la parte persistida sin duplicarla');

  const source = await readFile(new URL('../src/agents/opencode/sql-v2.ts',import.meta.url),'utf8');
  assert.ok(!/SELECT\s+\*/i.test(source));
  assert.ok(!source.includes("'$.reasoning'"));
  assert.ok(Object.keys(OPENCODE_V2_SQL).length > 5);
  console.log('OK OpenCode V2: historial, sesión vacía, texto incremental, herramientas y preguntas, errores seguros, cola, uso, límites, paginación, imágenes, aislamiento, compactación y revert');
} finally { db.close(); fixture.db.close(); }
