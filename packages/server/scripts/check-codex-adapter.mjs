/**
 * Chequeo del adaptador de Codex y de lo que el hito 25 saco del de Claude Code
 * para compartirlo.
 *
 *   npx tsx scripts/check-codex-adapter.mjs
 *
 * Por ahora cubre:
 *
 *  - A: el seguidor generico por offset (`agents/jsonl-follower.ts`): lineas
 *    partidas, numero de linea, archivo que encoge, tope y paginado. Es la
 *    pieza que el seguidor de Claude Code y el de Codex comparten, y un cambio
 *    silencioso ahi cambia los ids de conversaciones ya entregadas.
 *  - B: el envio por piezas (`buildSubmissionWrites`), con Claude Code byte por
 *    byte igual que antes, los literales nuevos de `shared` y lo que la web
 *    deriva de ellos sin JSX.
 *  - M5: la fila de escrituras por terminal (`terminal-write-queue.ts`): orden,
 *    separacion entre piezas, interrupcion y la guarda antes de cada pieza.
 *  - C: el adaptador de Codex sin registrar: rutas, mapeo del rollout, medidor,
 *    seguidor, busqueda del archivo, escaneo, descubrimiento y llamadas
 *    abiertas.
 *  - D: lo generico que el hito 24 difirio: donde cae una pestana nueva, el
 *    libro de actividad, `workspace.json` con pestanas de otras CLIs, sesiones
 *    archivadas, el hub que cambia de sesion, el indice con un escaneo null y
 *    el gancho posterior al lanzamiento.
 *  - E4: el watcher con una raiz de historial que todavia no existe.
 *  - E1–E3: el adaptador de Codex registrado: capacidades, lanzamiento, entorno,
 *    gancho de descubrimiento, carpetas protegidas y el registro de la app.
 *  - A6: el arranque y el cartel de la web cuentan CLIs disponibles, no
 *    registradas: con Claude Code sola no cambia nada.
 *  - M7: la demo no ve ninguna CLI de verdad (`scripts/demo/isolation.mjs`).
 *  - W: la web con dos CLIs, sin JSX: tandas de herramientas de Codex, con que
 *    CLI abre el `+` (boton partido), el menu, las insignias, la espera de la
 *    sesion, y la llamada abierta (A1) de punta a punta: protocolo y hub.
 *
 * El registro de terminales y el socket no se importan (cargan `node-pty`): lo
 * que deciden esta sacado a modulos puros, y eso es lo que se prueba.
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME` y `CODEX_HOME`
 * apuntando a una carpeta temporal propia, fijadas **antes** de importar nada:
 * nunca lee ni escribe el `~/.claude` ni el `~/.codex` de verdad. No importa
 * nada que cargue `node-pty`.
 */

import { appendFile, mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-codex-'));
const home = path.join(root, 'home');
const codexHome = path.join(root, 'codex');
await mkdir(home, { recursive: true });
await mkdir(path.join(codexHome, 'sessions'), { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
process.env['CODEX_HOME'] = codexHome;
// El registro de la app tambien trae el adaptador de OpenCode (hito 26): sus carpetas, adentro.
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
delete process.env['OPENCODE_DB'];
delete process.env['OPENCODE_MODELS_PATH'];
delete process.env['OPENCODE_MODELS_URL'];

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const work = path.join(root, 'work');
await mkdir(work, { recursive: true });
const line = (o) => JSON.stringify(o) + '\n';

// ---------------------------------------------------------------------------
// A. JsonlFollower (paso 1: D2)
// ---------------------------------------------------------------------------

const { JsonlFollower } = await import('../src/agents/jsonl-follower.ts');

/**
 * Sink de prueba: anota que lineas le llegaron y cuantas veces se reinicio.
 * Un registro `{ skip: true }` no genera evento; el resto, uno de texto con el
 * `id` del registro o `line-<n>`.
 */
class RecordingSink {
  lines = [];
  resets = 0;
  consume(record, lineNumber) {
    this.lines.push(lineNumber);
    if (record.skip === true) return null;
    return {
      eventId: typeof record.id === 'string' ? record.id : `line-${lineNumber}`,
      role: 'user',
      at: 0,
      parts: [{ kind: 'text', text: typeof record.text === 'string' ? record.text : '', truncated: false }],
      model: null,
      usage: null,
      effort: null,
      durationMs: null,
      queued: false,
    };
  }
  reset() {
    this.resets += 1;
  }
}

const ids = (events) => events.map((event) => event.eventId).join(',');

// A1. Sin archivo, o sin ruta todavia.
{
  const missing = new JsonlFollower(path.join(work, 'no-existe.jsonl'), new RecordingSink());
  const r = await missing.poll();
  check('A1 archivo inexistente -> waiting, sin reset ni eventos',
    missing.getState() === 'waiting' && r.reset === false && r.added.length === 0);

  const sink = new RecordingSink();
  const pathless = new JsonlFollower(null, sink);
  const r2 = await pathless.poll();
  check('A1 filePath null -> waiting, sin reset ni eventos, sin llamar al sink',
    pathless.filePath === null && pathless.getState() === 'waiting' &&
    r2.reset === false && r2.added.length === 0 && sink.lines.length === 0);

  let threw = false;
  try {
    missing.setPath(path.join(work, 'otra.jsonl'));
  } catch {
    threw = true;
  }
  check('A1 setPath con una ruta ya fijada lanza', threw);

  const late = path.join(work, 'tardia.jsonl');
  await writeFile(late, line({ id: 'x1', text: 'hola' }));
  pathless.setPath(late);
  const r3 = await pathless.poll();
  check('A1 setPath sobre null fija la ruta y la siguiente lectura la sigue',
    pathless.filePath === late && pathless.getState() === 'live' && ids(r3.added) === 'x1');
}

// A2. Una linea partida en tres escrituras, cortando una ñ y un emoji al medio.
{
  const file = path.join(work, 'partida.jsonl');
  await writeFile(file, '');
  const follower = new JsonlFollower(file, new RecordingSink());
  await follower.poll();

  const bytes = Buffer.from(line({ id: 'u1', text: 'ñandú 🐍 fin' }), 'utf8');
  const enye = bytes.indexOf(Buffer.from('ñ', 'utf8'));
  const snake = bytes.indexOf(Buffer.from('🐍', 'utf8'));
  const pieces = [bytes.subarray(0, enye + 1), bytes.subarray(enye + 1, snake + 2), bytes.subarray(snake + 2)];
  const counts = [];
  let last = null;
  for (const piece of pieces) {
    await appendFile(file, piece);
    last = await follower.poll();
    counts.push(last.added.length);
  }
  const text = last.added[0]?.parts[0]?.text;
  check('A2 corte a mitad de ñ y de emoji -> nada hasta completar la linea, despues un evento',
    counts.join(',') === '0,0,1', counts.join(','));
  check('A2 el texto llega intacto', text === 'ñandú 🐍 fin', JSON.stringify(text));
}

// A3. El numero de linea cuenta vacias e invalidas.
{
  const file = path.join(work, 'numeros.jsonl');
  await writeFile(
    file,
    line({ text: 'uno' }) + '   \n' + line({ text: 'tres' }) + '{"esto no es json\n' + line({ text: 'cinco' }),
  );
  const sink = new RecordingSink();
  const follower = new JsonlFollower(file, sink);
  const r = await follower.poll();
  check('A3 el sink recibe las lineas 1, 3 y 5 (la vacia y la invalida cuentan y no le llegan)',
    sink.lines.join(',') === '1,3,5', sink.lines.join(','));
  check('A3 los ids de respaldo siguen ese numero', ids(r.added) === 'line-1,line-3,line-5', ids(r.added));

  const skipSink = new RecordingSink();
  const skipFile = path.join(work, 'nulos.jsonl');
  await writeFile(skipFile, line({ id: 'a' }) + line({ skip: true }) + line({ id: 'b' }));
  const skipping = new JsonlFollower(skipFile, skipSink);
  const r2 = await skipping.poll();
  check('A3 un null del sink no se guarda como evento',
    ids(r2.added) === 'a,b' && skipping.eventCount() === 2 && skipping.find('a') !== undefined);
}

// A4. Si el archivo encoge o desaparece, se reinicia y avisa al sink una vez.
{
  const file = path.join(work, 'encoge.jsonl');
  await writeFile(file, line({ id: 'e1' }) + line({ id: 'e2' }));
  const sink = new RecordingSink();
  const follower = new JsonlFollower(file, sink);
  await follower.poll();

  await truncate(file, 0);
  await appendFile(file, line({ id: 'n1' }));
  const r = await follower.poll();
  check('A4 truncado -> reset true y sink.reset() una vez', r.reset === true && sink.resets === 1,
    `reset ${r.reset}, resets ${sink.resets}`);
  check('A4 despues del reset solo quedan los eventos nuevos, con la numeracion desde 1',
    ids(follower.getTail(10).events) === 'n1' && sink.lines.at(-1) === 1, ids(follower.getTail(10).events));

  await rm(file);
  const r2 = await follower.poll();
  check('A4 borrado con eventos -> reset true, waiting y sink.reset() otra vez',
    r2.reset === true && follower.getState() === 'waiting' && sink.resets === 2);
  const r3 = await follower.poll();
  check('A4 sigue sin archivo -> sin otro reset', r3.reset === false && sink.resets === 2);
}

// A5. Tope de eventos.
{
  const file = path.join(work, 'tope.jsonl');
  await writeFile(file, [1, 2, 3, 4, 5].map((n) => line({ id: `t${n}` })).join(''));
  const follower = new JsonlFollower(file, new RecordingSink(), { maxEvents: 3 });
  const r = await follower.poll();
  const tail = follower.getTail(10);
  check('A5 la lectura devuelve los 5, pero se guardan los 3 mas nuevos',
    r.added.length === 5 && follower.eventCount() === 3 && ids(tail.events) === 't3,t4,t5', ids(tail.events));
  check('A5 getTail(10) avisa que hay mas (se descartaron dos)', tail.hasMore === true);
  check('A5 un evento descartado ya no se encuentra', follower.find('t1') === undefined);
}

// A6. Paginado hacia atras, igual que el de Claude Code.
{
  const file = path.join(work, 'paginas.jsonl');
  const stamp = new Date().toISOString();
  const claudeLines = [];
  for (let n = 1; n <= 7; n++) {
    claudeLines.push(line({
      type: 'user', uuid: `p${n}`, timestamp: stamp, cwd: 'D:/x',
      message: { role: 'user', content: [{ type: 'text', text: `mensaje ${n}` }] },
    }));
  }
  await writeFile(file, claudeLines.join(''));

  /** Sink que usa el `uuid` como id, como hace Claude Code. */
  const uuidSink = new RecordingSink();
  const generic = new JsonlFollower(file, {
    consume: (record, lineNumber, events) => uuidSink.consume({ id: record.uuid, text: '' }, lineNumber, events),
    reset: () => uuidSink.reset(),
  });
  await generic.poll();

  const page = (cursor, limit) => {
    const result = generic.getPageBefore(cursor, limit);
    return `${ids(result.events)}|${result.hasMore}`;
  };
  check('A6 pagina intermedia: los 3 anteriores y hay mas', page('p6', 3) === 'p3,p4,p5|true', page('p6', 3));
  check('A6 pagina que llega al principio: sin mas', page('p3', 5) === 'p1,p2|false', page('p3', 5));
  check('A6 antes del primero: vacio y sin mas', page('p1', 5) === '|false', page('p1', 5));
  check('A6 cursor desconocido: vacio y sin mas', page('nadie', 5) === '|false', page('nadie', 5));
  const tail = generic.getTail(3);
  check('A6 getTail(3): los 3 ultimos y hay mas', ids(tail.events) === 'p5,p6,p7' && tail.hasMore === true);

  // Contra el seguidor de Claude Code sobre el mismo archivo.
  const { ConversationFollower } = await import('../src/agents/claude-code/conversation-follower.ts');
  const claude = new ConversationFollower(file);
  await claude.poll();
  const cases = [['p6', 3], ['p3', 5], ['p1', 5], ['p7', 1], ['p4', 100], ['nadie', 2]];
  const same = cases.every(([cursor, limit]) => {
    const a = claude.getPageBefore(cursor, limit);
    const b = generic.getPageBefore(cursor, limit);
    return ids(a.events) === ids(b.events) && a.hasMore === b.hasMore;
  });
  check('A6 mismas paginas que ConversationFollower', same);

  // Con eventos descartados por el tope, el principio visible todavia tiene mas.
  const capped = new JsonlFollower(file, {
    consume: (record, lineNumber, events) => uuidSink.consume({ id: record.uuid }, lineNumber, events),
    reset: () => undefined,
  }, { maxEvents: 4 });
  await capped.poll();
  const cappedPage = capped.getPageBefore('p5', 10);
  check('A6 con descartados: el tramo que llega al primero guardado igual avisa que hay mas',
    ids(cappedPage.events) === 'p4' && cappedPage.hasMore === true, `${ids(cappedPage.events)}|${cappedPage.hasMore}`);
}

// ---------------------------------------------------------------------------
// B. Literales compartidos y envio por piezas (paso 2)
// ---------------------------------------------------------------------------

const shared = await import('@agent-workbench/shared');
const {
  buildSubmission,
  buildSubmissionWrites,
  fileReference,
  MAX_SUBMIT_CHARS,
} = await import('../src/pty-input.ts');
const { CLAUDE_CODE_INPUT, CLAUDE_CODE_CAPABILITIES } = await import('../src/agents/claude-code/index.ts');

const PS = '\x1b[200~';
const PE = '\x1b[201~';
const P = (x) => `${PS}${x}${PE}`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (value) => JSON.stringify(value);
const BARE = { imageReference: 'bare-path-paste', pasteMarkers: true };
const BARE_RAW = { imageReference: 'bare-path-paste', pasteMarkers: false };
const img1 = process.platform === 'win32' ? 'C:\\Temp\\pegadas x\\p-1.png' : '/tmp/pegadas x/p-1.png';
const img2 = process.platform === 'win32' ? 'C:\\Temp\\pegadas x\\p-2.png' : '/tmp/pegadas x/p-2.png';

// B1. Claude Code: una sola pieza, byte por byte lo de antes.
{
  check('B1 claude-code declara una sola forma: at-quoted, sin separacion, con marcadores',
    same(CLAUDE_CODE_INPUT, { imageReference: 'at-quoted', pieceGapMs: 0, pasteMarkers: true, enterSeparately: false, interruptPresses: 1 }),
    show(CLAUDE_CODE_INPUT));
  check('B1 la forma de escribir imagenes es la que se le promete a la interfaz',
    CLAUDE_CODE_INPUT.imageReference === CLAUDE_CODE_CAPABILITIES.imagesByPath);

  const cases = [
    ['hola', [], {}],
    ['una\ndos', [], {}],
    ['que ves?', [img1], {}],
    ['', [img1, img2], {}],
    ['hola', [], { send: false }],
    ['  con  espacios  \r\n', [img2], { send: true }],
  ];
  for (const [text, images, options] of cases) {
    const writes = buildSubmissionWrites(text, images, CLAUDE_CODE_INPUT, options);
    const today = buildSubmission(text, images.map((p) => fileReference(p)), options);
    check(`B1 ${show(text)} con ${images.length} imagen(es) ${show(options)} === [buildSubmission]`,
      Array.isArray(writes) && writes.length === 1 && writes[0] === today, show(writes));
  }
  check('B1 contra el literal de siempre',
    same(buildSubmissionWrites('hola', [img1], CLAUDE_CODE_INPUT), [`${PS}@"${img1}" hola${PE}\r`]));
  check('B1 cuadro vacio -> null, igual que buildSubmission',
    buildSubmissionWrites('  \n ', [], CLAUDE_CODE_INPUT) === null && buildSubmission('  \n ', []) === null);
}

// B2. at-quoted sin marcadores: el mismo contenido, una pieza, sin delimitadores.
{
  const raw = buildSubmissionWrites('hola', [img1], { imageReference: 'at-quoted', pasteMarkers: false });
  check('B2 at-quoted sin marcadores: una pieza, sin ESC[200~ y con el Enter al final',
    same(raw, [`@"${img1}" hola\r`]), show(raw));
  const plain = buildSubmissionWrites('hola', [], { imageReference: null, pasteMarkers: true });
  check('B2 sin estilo de imagenes y sin imagenes: el pegado de siempre', same(plain, [buildSubmission('hola', [])]), show(plain));
  check('B2 sin estilo de imagenes y con imagenes: null (no se manda el texto sin ellas)',
    buildSubmissionWrites('hola', [img1], { imageReference: null, pasteMarkers: true }) === null);
}

// B3. bare-path-paste: una pieza por imagen, otra por el texto, y el Enter aparte.
{
  const writes = buildSubmissionWrites('que ves?', [img1, img2], BARE);
  check('B3 dos rutas y texto -> [P(r1), P(r2), P(texto), \\r]',
    same(writes, [P(img1), P(img2), P('que ves?'), '\r']), show(writes));
  const raw = buildSubmissionWrites('que ves?', [img1, img2], BARE_RAW);
  check('B3 sin marcadores -> [r1, r2, texto, \\r]', same(raw, [img1, img2, 'que ves?', '\r']), show(raw));
  check('B3 la ruta va sola: sin @ ni comillas', fileReference(img1, 'bare-path-paste') === img1);
  const multi = buildSubmissionWrites('una\r\ndos', [], BARE);
  check('B3 los saltos internos quedan dentro del pegado del texto, sin \\r adentro',
    same(multi, [P('una\ndos'), '\r']), show(multi));
}

// B4. Saneo y bordes.
{
  const nasty = buildSubmissionWrites('inocente\x1b[201~ls -la', [`${img1}\x1b[201~`], BARE);
  check('B4 un ESC[201~ en la ruta o en el texto no sobrevive',
    same(nasty, [P(img1), P('inocentels -la'), '\r']), show(nasty));
  const quiet = buildSubmissionWrites('hola', [img1], BARE, { send: false });
  check('B4 send:false -> sin la pieza del Enter', same(quiet, [P(img1), P('hola')]), show(quiet));
  check('B4 texto vacio y sin imagenes -> null', buildSubmissionWrites(' \n\t ', [], BARE) === null);
  const onlyImages = buildSubmissionWrites('   ', [img1], BARE);
  check('B4 solo imagenes -> sus pegados y el Enter, sin pegado de texto', same(onlyImages, [P(img1), '\r']), show(onlyImages));
  const long = buildSubmissionWrites('x'.repeat(MAX_SUBMIT_CHARS + 50), [], BARE);
  check('B4 el texto se recorta al tope', long !== null && long[0] === P('x'.repeat(MAX_SUBMIT_CHARS)) && long.length === 2);
}

// B5. Protocolo.
{
  const { parseServerMessage, parseAgentInfo, EMPTY_CONTEXT_USAGE } = shared;
  const reset = (extra) => JSON.stringify({
    type: 'conversation.reset', terminalId: 't1', state: 'waiting', events: [], hasMore: false,
    usage: EMPTY_CONTEXT_USAGE, permissionMode: null, defaults: { model: null, effort: null, contextWindow: null },
    waitingFor: null, ...extra,
  });
  const empty = parseServerMessage(reset({ sessionId: '' }));
  check('B5 conversation.reset con sessionId vacio -> se acepta con sessionId ""',
    empty !== null && empty.type === 'conversation.reset' && empty.sessionId === '', show(empty));
  const known = parseServerMessage(reset({ sessionId: 's1' }));
  check('B5 conversation.reset con sessionId -> igual que siempre', known?.sessionId === 's1');
  check('B5 conversation.reset sin sessionId -> null', parseServerMessage(reset({})) === null);
  check('B5 conversation.reset con sessionId no string -> null', parseServerMessage(reset({ sessionId: 7 })) === null);

  const info = parseAgentInfo({
    id: 'codex', label: 'Codex', command: 'codex', installUrl: 'https://example.com/codex', available: true,
    version: 'codex-cli 0.154.0', missingMessage: null, environmentNotice: null,
    capabilities: { imagesByPath: 'bare-path-paste', contextWindowSource: 'token-count' },
  });
  check('B5 parseAgentInfo conserva id codex, bare-path-paste y token-count',
    info?.id === 'codex' && info.capabilities.imagesByPath === 'bare-path-paste' &&
    info.capabilities.contextWindowSource === 'token-count', show(info));
  check('B5 un id que no es de ningun adaptador sigue siendo null',
    parseAgentInfo({ id: 'antigravity', label: 'x', command: 'x', installUrl: 'x' }) === null);
}

// B6. Ids. OpenCode entra detras en el hito 26, sin mover a las dos de antes.
{
  const { AGENT_IDS, MEMORY_AGENT_IDS } = shared;
  check('B6 AGENT_IDS es claude-code, despues codex y despues opencode',
    same([...AGENT_IDS], ['claude-code', 'codex', 'opencode']), AGENT_IDS.join(','));
  check('B6 AGENT_IDS contenido en MEMORY_AGENT_IDS', AGENT_IDS.every((id) => MEMORY_AGENT_IDS.includes(id)));
}

// B7. Web: la entrada de codex y la ventana del medidor en vacio.
{
  const ui = await import('../../web/src/agent-ui.ts');
  check('B7 insignias: CC y CX', ui.AGENT_UI['claude-code'].shortLabel === 'CC' && ui.AGENT_UI.codex.shortLabel === 'CX');
  check('B7 codex carga AGENTS.md y tiene sus atajos',
    ui.AGENT_UI.codex.instructionsFile === 'AGENTS.md' && ui.AGENT_UI.codex.shortcuts.length === 11 &&
    ui.AGENT_UI.codex.shortcuts[0].keys === 'Esc');
  check('B7 claude-code sin nota bajo los atajos, codex con la de Alt + flechas',
    ui.AGENT_UI['claude-code'].shortcutsNote === null && /Alt \+ ←/.test(ui.AGENT_UI.codex.shortcutsNote ?? ''));

  const idle = (source, window, fallback) => ui.meterIdleWindow(source, { contextWindow: window }, fallback);
  check('B7 medidor en vacio, claude-code sin configuracion: sin limite aunque el uso traiga uno',
    idle('usage-with-variants', 200000, null) === null);
  check('B7 medidor en vacio, claude-code con configuracion: el de la configuracion',
    idle('usage-with-variants', 200000, 1000000) === 1000000);
  check('B7 medidor en vacio, token-count: la ventana que ya anuncio el turno', idle('token-count', 258400, null) === 258400);
  check('B7 medidor en vacio, token-count sin turno todavia: sin limite', idle('token-count', null, null) === null);
  check('B7 medidor en vacio, la configuracion gana tambien con token-count', idle('token-count', 258400, 128000) === 128000);
  check('B7 medidor en vacio, sin fuente: sin limite', idle(null, 258400, null) === null);
}

// ---------------------------------------------------------------------------
// M5. Fila de escrituras por terminal (paso 2)
// ---------------------------------------------------------------------------

const { TerminalWriteQueue } = await import('../src/terminal-write-queue.ts');

/** Una espera que anota cuanto se pidio y cede el turno sin tardar de verdad. */
const makeWait = (waits) => async (ms) => {
  waits.push(ms);
  await new Promise((resolve) => setImmediate(resolve));
};

// M5.1 Dos envios de varias piezas no se intercalan.
{
  const waits = [];
  const queue = new TerminalWriteQueue({ wait: makeWait(waits) });
  const log = [];
  const write = (piece) => { log.push(piece); return true; };
  const outcomes = [];
  await Promise.all([
    queue.enqueue('t1', async (lane) => { outcomes.push(await lane.writePieces(['a1', 'a2', 'a3'], 400, write)); }),
    queue.enqueue('t1', async (lane) => { outcomes.push(await lane.writePieces(['b1', 'b2', 'b3'], 400, write)); }),
  ]);
  check('M5.1 en orden y sin intercalar', log.join(',') === 'a1,a2,a3,b1,b2,b3', log.join(','));
  check('M5.1 la separacion va entre piezas, nunca antes de la primera', same(waits, [400, 400, 400, 400]), show(waits));
  check('M5.1 las dos tandas dicen written', same(outcomes, ['written', 'written']));
  check('M5.1 la fila se olvida al vaciarse', queue.busyTerminals() === 0);

  const zero = [];
  const flat = new TerminalWriteQueue({ wait: makeWait(zero) });
  await flat.enqueue('t1', async (lane) => { await lane.writePieces(['x', 'y'], 0, () => true); });
  check('M5.1 con separacion 0 no se espera', zero.length === 0);
}

// M5.2 La interrupcion corta lo que falta y descarta lo encolado, salvo lo no interrumpible.
{
  const queue = new TerminalWriteQueue({ wait: makeWait([]) });
  const log = [];
  let dropped = 0;
  let outcomeA = null;
  const write = (piece) => {
    log.push(piece);
    if (piece === 'a1') {
      queue.interrupt('t1');
      log.push('ESC');
    }
    return true;
  };
  let startedB = false;
  const jobs = [
    queue.enqueue('t1', async (lane) => { outcomeA = await lane.writePieces(['a1', 'a2', '\r'], 400, write); }),
    queue.enqueue('t1', async (lane) => { startedB = true; await lane.writePieces(['b1', '\r'], 400, write); },
      { onDropped: () => { dropped += 1; } }),
    queue.enqueue('t1', async (lane) => { await lane.writePieces(['m1', 'm2'], 120, write); }, { interruptible: false }),
  ];
  // Encolado despues de la interrupcion: tiene que salir.
  await new Promise((resolve) => setImmediate(resolve));
  jobs.push(queue.enqueue('t1', async (lane) => { await lane.writePieces(['c1'], 0, write); }));
  await Promise.all(jobs);
  check('M5.2 lo que faltaba del envio en curso no se escribe', outcomeA === 'interrupted' && !log.includes('a2'), log.join(','));
  check('M5.2 lo encolado antes de la interrupcion se descarta sin empezar', !startedB && dropped === 1 && !log.includes('b1'));
  check('M5.2 lo no interrumpible sigue, y lo encolado despues sale',
    log.join(',') === 'a1,ESC,m1,m2,c1', log.join(','));
  check('M5.2 la fila se olvida al vaciarse', queue.busyTerminals() === 0);
}

// M5.3 Una terminal que no acepta corta la tanda, y la fila sigue.
{
  const queue = new TerminalWriteQueue({ wait: makeWait([]) });
  const log = [];
  let outcome = null;
  await Promise.all([
    queue.enqueue('t1', async (lane) => {
      outcome = await lane.writePieces(['x1', 'x2'], 400, (piece) => { log.push(piece); return false; });
    }),
    queue.enqueue('t1', async (lane) => { await lane.writePieces(['y1'], 0, (piece) => { log.push(piece); return true; }); }),
  ]);
  check('M5.3 refused en la primera pieza y la segunda no se intenta', outcome === 'refused' && log.join(',') === 'x1,y1', log.join(','));
}

// M5.4 Un trabajo que lanza no traba la fila ni rechaza su promesa.
{
  const queue = new TerminalWriteQueue({ wait: makeWait([]) });
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  let rejected = false;
  let after = false;
  try {
    await Promise.all([
      queue.enqueue('t1', async () => { throw new Error('roto'); }).catch(() => { rejected = true; }),
      queue.enqueue('t1', async () => { after = true; }),
    ]);
  } finally {
    console.error = original;
  }
  check('M5.4 la promesa no se rechaza, se anota y el siguiente corre',
    !rejected && after && errors.length === 1 && errors[0].includes('roto'), errors.join(' | '));
}

// M5.5 Cada terminal tiene su fila: una trabada no frena a la otra, ni la interrupcion cruza.
{
  const queue = new TerminalWriteQueue({ wait: makeWait([]) });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const log = [];
  const slow = queue.enqueue('t1', async (lane) => {
    await gate;
    await lane.writePieces(['t1'], 0, (piece) => { log.push(piece); return true; });
  });
  queue.enqueue('t2', async () => undefined);
  queue.interrupt('t2');
  await queue.enqueue('t2', async (lane) => { await lane.writePieces(['t2'], 0, (piece) => { log.push(piece); return true; }); });
  check('M5.5 la otra terminal escribe mientras la primera espera', log.join(',') === 't2', log.join(','));
  release();
  await slow;
  check('M5.5 la interrupcion de t2 no toco a t1', log.join(',') === 't2,t1', log.join(','));

  queue.interrupt('nadie');
  let ran = false;
  await queue.enqueue('nadie', async () => { ran = true; });
  check('M5.5 interrumpir una terminal sin fila no afecta lo que se encola despues', ran && queue.busyTerminals() === 0);
}

// M5.6 La guarda se pregunta antes de cada pieza, y un no corta lo que falta (A1).
{
  const queue = new TerminalWriteQueue({ wait: makeWait([]) });
  const log = [];
  const write = (piece) => { log.push(piece); return true; };
  let asked = 0;
  // La llamada aparece despues de escribir la ruta de la imagen: el texto y el Enter no salen.
  const guard = async () => {
    asked += 1;
    await new Promise((resolve) => setImmediate(resolve));
    return !log.includes('ruta');
  };
  let outcome = null;
  await queue.enqueue('t1', async (lane) => { outcome = await lane.writePieces(['ruta', 'texto', '\r'], 400, write, guard); });
  check('M5.6 la guarda dice que no a mitad: blocked, y ni el texto ni el Enter se escriben',
    outcome === 'blocked' && log.join(',') === 'ruta' && asked === 2, `${outcome} ${log.join(',')} ${asked}`);

  const open = [];
  let allowed = null;
  await queue.enqueue('t1', async (lane) => { allowed = await lane.writePieces(['a', 'b', '\r'], 400, (p) => { open.push(p); return true; }, () => true); });
  check('M5.6 con la guarda en si: todas', allowed === 'written' && open.join(',') === 'a,b,\r');

  const early = [];
  let blockedFirst = null;
  await queue.enqueue('t1', async (lane) => { blockedFirst = await lane.writePieces(['x', '\r'], 400, (p) => { early.push(p); return true; }, () => false); });
  check('M5.6 con la guarda en no desde el principio: no se escribe nada', blockedFirst === 'blocked' && early.length === 0);

  // Un Esc mientras la guarda lee el archivo gana: la pieza no sale.
  const raced = [];
  let racedOutcome = null;
  await queue.enqueue('t1', async (lane) => {
    racedOutcome = await lane.writePieces(['y', '\r'], 400, (p) => { raced.push(p); return true; }, async () => {
      queue.interrupt('t1');
      return true;
    });
  });
  check('M5.6 una interrupcion durante la guarda: interrupted y nada escrito', racedOutcome === 'interrupted' && raced.length === 0);
  check('M5.6 la fila se olvida al vaciarse', queue.busyTerminals() === 0);
}

// ---------------------------------------------------------------------------
// C. El adaptador de Codex, sin registrar (paso 3)
// ---------------------------------------------------------------------------

const zlib = await import('node:zlib');
const paths = await import('../src/agents/codex/paths.ts');
const lines = await import('../src/agents/codex/rollout-lines.ts');
const { CodexRolloutSink } = await import('../src/agents/codex/rollout-sink.ts');
const { CodexSessionFollower } = await import('../src/agents/codex/session-follower.ts');
const { findRollout } = await import('../src/agents/codex/find-rollout.ts');
const { loadRolloutImage } = await import('../src/agents/codex/rollout-image.ts');
const { scanRollout } = await import('../src/agents/codex/rollout-scan.ts');
const { createCodexHistory } = await import('../src/agents/codex/history.ts');
const { CodexSessionDiscovery, pickPendingTab } = await import('../src/agents/codex/discovery.ts');

const DAY = 86_400_000;
const win = process.platform === 'win32';
const CWD = win ? 'D:\\Mi App' : '/home/u/mi-app';
const OTHER_CWD = win ? 'D:\\Otra' : '/home/u/otra';
const sessionsRoot = path.join(codexHome, 'sessions');
const archivedRoot = path.join(codexHome, 'archived_sessions');

/** Un PNG de 1x1 de verdad, armado aca: firma, IHDR, IDAT y IEND con su CRC. */
function png1x1() {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}
const PNG = png1x1();

// ---- Fixtures con la forma de §3 de la especificacion, textos inventados ----

const cid = (n) => `019e0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const iso = (ms) => new Date(ms).toISOString();
const BASE = Date.UTC(2026, 4, 5, 14, 12, 27, 787);
const rec = (ms, type, payload, extra = {}) => line({ timestamp: iso(ms), type, payload, ...extra });

const sessionMeta = ({ id, createdAt = BASE, cwd = CWD, source = 'cli', historyMode, forkedFromId }) =>
  rec(createdAt + 5000, 'session_meta', {
    id, timestamp: iso(createdAt), cwd, originator: 'codex-tui', cli_version: '0.154.0', source,
    model_provider: 'openai', base_instructions: { text: 'Instrucciones de base.' },
    ...(historyMode === undefined ? {} : { history_mode: historyMode }),
    ...(forkedFromId === undefined ? {} : { forked_from_id: forkedFromId }),
  });
const taskStarted = (ms, window = 258400) => rec(ms, 'event_msg', {
  type: 'task_started', turn_id: 'turno-1', started_at: 1, model_context_window: window, collaboration_mode_kind: 'default',
});
const developer = (ms) => rec(ms, 'response_item', {
  type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…' }],
});
const environmentContext = (ms) => rec(ms, 'response_item', {
  type: 'message', role: 'user', content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${CWD}</cwd>\n</environment_context>` }],
});
const turnContext = (ms, options = {}) => {
  const model = options.model ?? 'gpt-5.5';
  return rec(ms, 'turn_context', {
    turn_id: 'turno-1', cwd: options.cwd ?? CWD, approval_policy: 'on-request', model,
    collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: null } },
    ...('effort' in options ? (options.effort === null ? {} : { effort: options.effort }) : { effort: 'high' }),
    summary: 'none',
  });
};
/** El `message/user` y el `user_message`, con imagenes `{ mediaType, data }` si hay. */
const userPair = (ms, text, images = [], { withPath = true } = {}) => {
  const content = [];
  images.forEach((image, i) => {
    const label = `[Image #${i + 1}]`;
    content.push({ type: 'input_text', text: withPath ? `<image name=${label} path="C:\\tmp\\p-${i + 1}.png">` : `<image name=${label}>` });
    content.push({ type: 'input_image', image_url: `data:${image.mediaType};base64,${image.data}`, detail: 'auto' });
    content.push({ type: 'input_text', text: '</image>' });
  });
  content.push({ type: 'input_text', text });
  return rec(ms, 'response_item', { type: 'message', role: 'user', content }) +
    rec(ms + 1, 'event_msg', { type: 'user_message', message: text, images: [], local_images: images.map((_, i) => `C:\\tmp\\p-${i + 1}.png`), text_elements: [] });
};
const userMessageOnly = (ms, text) => rec(ms, 'event_msg', { type: 'user_message', message: text, images: [], local_images: [], text_elements: [] });
const assistant = (ms, text, phase = 'final_answer') => rec(ms, 'response_item', {
  type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], phase,
});
const agentMessage = (ms, text) => rec(ms, 'event_msg', { type: 'agent_message', message: text, phase: 'commentary' });
const reasoning = (ms) => rec(ms, 'response_item', { type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAAA' });
const fnCall = (ms, id, name, args) => rec(ms, 'response_item', { type: 'function_call', name, arguments: args, call_id: id });
const customCall = (ms, id, name, input) => rec(ms, 'response_item', { type: 'custom_tool_call', status: 'completed', call_id: id, name, input });
const fnOutput = (ms, id, output) => rec(ms, 'response_item', { type: 'function_call_output', call_id: id, output });
const customOutput = (ms, id, output) => rec(ms, 'response_item', { type: 'custom_tool_call_output', call_id: id, output });
const tokenCountNull = (ms) => rec(ms, 'event_msg', { type: 'token_count', info: null, rate_limits: {} });
const usageOf = (u) => ({
  input_tokens: u.input, cached_input_tokens: u.cached ?? 0, output_tokens: u.output ?? 0,
  reasoning_output_tokens: 0, ...(u.total === undefined ? {} : { total_tokens: u.total }),
});
const tokenCount = (ms, last, total, window = 258400) => rec(ms, 'event_msg', {
  type: 'token_count', info: { total_token_usage: usageOf(total), last_token_usage: usageOf(last), model_context_window: window }, rate_limits: {},
});
const execEnd = (ms, id) => rec(ms, 'event_msg', { type: 'exec_command_end', call_id: id, exit_code: 0, status: 'completed', aggregated_output: 'x' });
const turnEnd = (ms, type, durationMs) => rec(ms, 'event_msg', { type, turn_id: 'turno-1', completed_at: 1, duration_ms: durationMs });

const pad2 = (n) => String(n).padStart(2, '0');
const rolloutName = (ms, id) => {
  const d = new Date(ms);
  return `rollout-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}-${id}.jsonl`;
};
/** Escribe un rollout en la carpeta de dia local de `folderMs`, como Codex. */
async function writeRollout(base, id, content, folderMs) {
  const folder = paths.localDayFolder(base, folderMs);
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, rolloutName(folderMs, id));
  await writeFile(file, content);
  return file;
}

let sinkFiles = 0;
/** Lee un contenido con `JsonlFollower` + `CodexRolloutSink`. */
async function sinkRead(content, sessionId = '') {
  const file = path.join(work, `sink-${++sinkFiles}.jsonl`);
  await writeFile(file, content);
  const sink = new CodexRolloutSink(sessionId);
  const follower = new JsonlFollower(file, sink);
  const result = await follower.poll();
  return { sink, follower, result, file };
}
const shape = (events) => events.map((e) => `${e.eventId}:${e.role}:${e.parts.map((p) => p.kind).join('+')}`).join(',');

async function captureWarnings(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

// C1. paths.ts
{
  const name = paths.parseRolloutFileName('rollout-2026-05-05T11-12-27-019E0000-AAAA-7000-8000-000000000001.jsonl');
  check('C1 parseRolloutFileName: fecha, hora y uuid en minusculas',
    name !== null && name.year === 2026 && name.month === 5 && name.day === 5 && name.hour === 11 &&
    name.minute === 12 && name.second === 27 && name.sessionId === '019e0000-aaaa-7000-8000-000000000001', show(name));
  check('C1 .jsonl.zst no se lee',
    paths.parseRolloutFileName('rollout-2026-05-05T11-12-27-019e0000-aaaa-7000-8000-000000000001.jsonl.zst') === null);
  check('C1 la forma <uuid>_<rollout_id> no se lee',
    paths.parseRolloutFileName('rollout-2026-05-05T11-12-27-019e0000-aaaa-7000-8000-000000000001_019e0000-bbbb-7000-8000-000000000002.jsonl') === null);
  check('C1 history.jsonl no es un rollout', paths.parseRolloutFileName('history.jsonl') === null);

  const hex = BASE.toString(16).padStart(12, '0');
  const v7 = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8000-000000000001`;
  check('C1 uuidV7Millis de un v7 da su marca', paths.uuidV7Millis(v7) === BASE, String(paths.uuidV7Millis(v7)));
  check('C1 uuidV7Millis de un v4 es null', paths.uuidV7Millis('a1a1a1a1-1111-4111-8111-111111111111') === null);
  check('C1 uuidV7Millis de algo que no es uuid es null', paths.uuidV7Millis('019e0000-0000-7000-8000') === null);

  const lateNight = new Date(2026, 0, 1, 23, 59, 30).getTime();
  const earlyMorning = new Date(2026, 0, 2, 0, 0, 30).getTime();
  check('C1 localDayFolder usa la fecha local',
    paths.localDayFolder('R', lateNight) === path.join('R', '2026', '01', '01') &&
    paths.localDayFolder('R', earlyMorning) === path.join('R', '2026', '01', '02'));
  const folders = paths.localDayFolders('R', lateNight - DAY, earlyMorning + DAY);
  check('C1 localDayFolders cubre cada dia una vez y en orden',
    same(folders, ['2025/12/31', '2026/01/01', '2026/01/02', '2026/01/03'].map((d) => path.join('R', ...d.split('/')))), show(folders));
}

// C2. CODEX_HOME, y el que no es absoluto (B9).
{
  check('C2 con la variable, esa carpeta', paths.codexHome() === codexHome && paths.codexSessionsRoot() === sessionsRoot);
  const saved = process.env['CODEX_HOME'];
  try {
    process.env['CODEX_HOME'] = '';
    check('C2 vacia, ~/.codex del home', paths.codexHome() === path.join(os.homedir(), '.codex') && os.homedir() === home,
      String(paths.codexHome()));

    process.env['CODEX_HOME'] = 'codex-relativo';
    let listed = 'sin llamar';
    let roots = null;
    const warnings = await captureWarnings(async () => {
      const first = paths.codexHome();
      const second = paths.codexArchivedRoot();
      roots = createCodexHistory().roots();
      listed = await createCodexHistory().list();
      check('C2 relativa: null en todas', first === null && second === null && paths.codexSessionsRoot() === null);
    });
    check('C2 relativa: avisa una sola vez', warnings.length === 1 && warnings[0].includes('codex-relativo'), warnings.join(' | '));
    check('C2 relativa: el historial no declara raices ni lista nada', same(roots, []) && listed === null, show(listed));
    const found = await findRollout(cid(1));
    check('C2 relativa: findRollout no busca', found === null);

    if (win) {
      process.env['CODEX_HOME'] = '\\codex';
      const rooted = await captureWarnings(async () => {
        check('C2 win32: \\codex cuelga de la unidad actual y no vale', paths.codexHome() === null);
      });
      check('C2 win32: y avisa', rooted.length === 1);
    }
  } finally {
    process.env['CODEX_HOME'] = saved;
  }
}

// C3. Una conversacion basica: que lineas son tarjetas y cuales no.
{
  const args = { command: 'pnpm test', workdir: CWD, timeout_ms: 120000 };
  const content =
    sessionMeta({ id: cid(3) }) + taskStarted(BASE + 10) + developer(BASE + 11) + environmentContext(BASE + 12) +
    turnContext(BASE + 13) + userPair(BASE + 14, 'corré los tests del paquete') + tokenCountNull(BASE + 20) +
    reasoning(BASE + 30) + agentMessage(BASE + 31, 'Voy a correr los tests.') +
    assistant(BASE + 32, 'Voy a correr los tests.', 'commentary') + fnCall(BASE + 33, 'call_A1', 'shell_command', JSON.stringify(args)) +
    tokenCount(BASE + 34, { input: 13695, cached: 6528, output: 226, total: 13921 }, { input: 13695, cached: 6528, output: 226, total: 13921 }) +
    execEnd(BASE + 40, 'call_A1') + fnOutput(BASE + 41, 'call_A1', 'Exit code: 0\nWall time: 24.8 seconds\nOutput:\nok') +
    assistant(BASE + 50, 'Pasaron los 42 tests.') + turnEnd(BASE + 51, 'task_complete', 33643);
  const { result } = await sinkRead(content, cid(3));
  check('C3 eventos: usuario, comentario, llamada, resultado y respuesta final',
    shape(result.added) === 'line-7:user:text,line-11:assistant:text,line-12:assistant:tool-call,line-15:user:tool-result,line-16:assistant:text',
    shape(result.added));
  const [user, commentary, call, output, final] = result.added;
  check('C3 el mensaje del usuario sale de user_message, con su texto', user?.parts[0]?.text === 'corré los tests del paquete' && user.model === null);
  check('C3 la llamada lleva nombre, id y la entrada JSON indentada',
    call?.parts[0]?.name === 'shell_command' && call.parts[0].toolUseId === 'call_A1' &&
    call.parts[0].input === JSON.stringify(args, null, 2), show(call?.parts[0]));
  check('C3 el resultado casa con la llamada y no es error',
    output?.parts[0]?.toolUseId === 'call_A1' && output.parts[0].isError === false && output.parts[0].text.startsWith('Exit code: 0'));
  check('C3 las respuestas llevan modelo y esfuerzo del turno',
    commentary?.model === 'gpt-5.5' && commentary.effort === 'high' && final?.parts[0]?.text === 'Pasaron los 42 tests.');
  check('C3 la hora del evento es la de su linea', user?.at === BASE + 15);
  check('C3 el cierre del turno le pone la duracion a la ultima respuesta', final?.durationMs === 33643 && commentary?.durationMs === null);
}

// C4. Modelo y esfuerzo.
{
  const content =
    sessionMeta({ id: cid(4) }) + taskStarted(BASE) + turnContext(BASE + 1, { effort: 'high' }) + userPair(BASE + 2, 'uno') +
    assistant(BASE + 3, 'respuesta uno') + turnEnd(BASE + 4, 'task_complete', 10) +
    taskStarted(BASE + 5) + turnContext(BASE + 6, { effort: null, model: 'gpt-5.5-mini' }) + userPair(BASE + 7, 'dos') +
    assistant(BASE + 8, 'respuesta dos');
  const { result } = await sinkRead(content);
  const answers = result.added.filter((e) => e.role === 'assistant');
  check('C4 turn_context con effort high: la respuesta dice high y gpt-5.5',
    answers[0]?.effort === 'high' && answers[0].model === 'gpt-5.5', show(answers[0]));
  check('C4 turn_context sin effort y con reasoning_effort null: effort null, y el modelo nuevo',
    answers[1]?.effort === null && answers[1].model === 'gpt-5.5-mini', show(answers[1]));
}

// C5. Medidor (y B5: un token_count repetido no es otra respuesta).
{
  const file = path.join(work, 'medidor.jsonl');
  await writeFile(file, '');
  const sink = new CodexRolloutSink('');
  const follower = new JsonlFollower(file, sink);
  await follower.poll();
  check('C5 antes de todo: EMPTY_CONTEXT_USAGE', same(sink.getUsage(), shared.EMPTY_CONTEXT_USAGE));

  await appendFile(file, sessionMeta({ id: cid(5) }) + taskStarted(BASE, 258400) + turnContext(BASE + 1));
  await follower.poll();
  check('C5 tras task_started: la ventana, y cero respuestas',
    sink.getUsage().contextWindow === 258400 && sink.getUsage().assistantMessages === 0, show(sink.getUsage()));

  await appendFile(file, tokenCountNull(BASE + 2));
  await follower.poll();
  check('C5 token_count con info null: sin cambios',
    sink.getUsage().lastRequestTokens === 0 && sink.getUsage().assistantMessages === 0 && sink.getUsage().contextWindow === 258400);

  await appendFile(file, tokenCount(BASE + 3, { input: 13695, cached: 6528, output: 226, total: 13921 }, { input: 20000, cached: 9000, output: 500, total: 20500 }));
  await follower.poll();
  const u = sink.getUsage();
  check('C5 con info: last.input_tokens, totales, modelo, ventana exacta y una respuesta',
    u.lastRequestTokens === 13695 && u.lastOutputTokens === 226 && u.totalInputTokens === 20000 &&
    u.totalOutputTokens === 500 && u.totalCacheReadTokens === 9000 && u.lastModel === 'gpt-5.5' &&
    u.contextWindow === 258400 && u.contextWindowEstimated === false && u.assistantMessages === 1, show(u));

  await appendFile(file, tokenCount(BASE + 4, { input: 13695, output: 226, total: 13921 }, { input: 20000, cached: 9000, output: 500, total: 20500 }));
  await follower.poll();
  check('B5 el mismo total acumulado otra vez no suma una respuesta', sink.getUsage().assistantMessages === 1, String(sink.getUsage().assistantMessages));

  await appendFile(file, tokenCount(BASE + 5, { input: 30000, output: 10, total: 30010 }, { input: 50000, output: 510, total: 50510 }, 400000));
  await follower.poll();
  check('B5 un total mayor si suma, y la ventana del token_count manda',
    sink.getUsage().assistantMessages === 2 && sink.getUsage().contextWindow === 400000 && sink.getUsage().lastRequestTokens === 30000);

  await appendFile(file, tokenCount(BASE + 6, { input: 500, output: 5, total: 505 }, { input: 500, output: 5, total: 505 }));
  await follower.poll();
  check('B5 un total menor (proceso relanzado, cuenta de nuevo) tambien suma', sink.getUsage().assistantMessages === 3);

  await appendFile(file, tokenCount(BASE + 7, { input: 600 }, { input: 1100 }));
  await follower.poll();
  check('B5 sin total_tokens no hay como comparar: suma', sink.getUsage().assistantMessages === 4);
}

// C6. Duracion del turno.
{
  const id = cid(6);
  const ms = paths.uuidV7Millis(id);
  const file = await writeRollout(sessionsRoot, id,
    sessionMeta({ id }) + taskStarted(BASE) + userPair(BASE + 1, 'uno') + assistant(BASE + 3, 'a') + turnEnd(BASE + 4, 'task_complete', 1500),
    ms);
  const follower = new CodexSessionFollower(CWD, id);
  await follower.start();
  const first = await follower.poll();
  const answer = first.added.find((e) => e.role === 'assistant');
  check('C6 task_complete en la misma lectura: la duracion viaja dentro del evento y turns vacio',
    answer?.durationMs === 1500 && first.turns.length === 0, show(first.turns));

  await appendFile(file, taskStarted(BASE + 10) + userPair(BASE + 11, 'dos') + assistant(BASE + 13, 'b'));
  const second = await follower.poll();
  const b = second.added.find((e) => e.role === 'assistant');
  await appendFile(file, turnEnd(BASE + 14, 'task_complete', 2500));
  const third = await follower.poll();
  check('C6 task_complete en una lectura posterior: turns con el evento y su duracion',
    third.added.length === 0 && same(third.turns, [{ eventId: b?.eventId, durationMs: 2500 }]), show(third.turns));
  check('C6 y el evento guardado tambien la tiene', follower.getTail(10).events.find((e) => e.eventId === b?.eventId)?.durationMs === 2500);

  await appendFile(file, taskStarted(BASE + 20) + userPair(BASE + 21, 'tres') + assistant(BASE + 23, 'c') + turnEnd(BASE + 24, 'turn_aborted', 700));
  const fourth = await follower.poll();
  check('C6 turn_aborted con duration_ms: igual', fourth.added.find((e) => e.role === 'assistant')?.durationMs === 700);

  await appendFile(file, taskStarted(BASE + 30) + userPair(BASE + 31, 'cuatro') + turnEnd(BASE + 34, 'task_complete', 900));
  const fifth = await follower.poll();
  const tail = follower.getTail(20).events;
  check('C6 task_complete sin respuesta en el turno: no toca a nadie',
    fifth.turns.length === 0 && tail.filter((e) => e.durationMs === 900).length === 0 &&
    tail.find((e) => e.role === 'assistant' && e.parts[0]?.text === 'c')?.durationMs === 700, show(fifth.turns));

  // Un turno que se corto sin cierre (la CLI murio) no le presta su respuesta al siguiente.
  await appendFile(file, taskStarted(BASE + 40) + userPair(BASE + 41, 'cinco') + assistant(BASE + 43, 'd') +
    taskStarted(BASE + 50) + userPair(BASE + 51, 'seis') + turnEnd(BASE + 54, 'task_complete', 800));
  const sixth = await follower.poll();
  check('C6 un turno nuevo suelta la respuesta del turno sin cierre',
    sixth.added.find((e) => e.role === 'assistant')?.durationMs === null && sixth.turns.length === 0, show(sixth.turns));
}

// C7. Salidas de herramientas.
{
  const r = lines.readToolOutput;
  check('C7 Exit code: 1 es error', r('Exit code: 1\nWall time: 2 seconds\nOutput:\nfallo').isError === true);
  check('C7 Exit code: 0 no es error', r('Exit code: 0\nOutput:\nok').isError === false);
  check('C7 solo Wall time no es error', r('Wall time: 1.2 seconds\nOutput:\nok').isError === false);
  const patch = r(JSON.stringify({ output: 'Success. Updated the following files:\nA NOTAS.md\n', metadata: { exit_code: 2, duration_seconds: 0.1 } }));
  check('C7 JSON con metadata.exit_code 2: error y el texto es output',
    patch.isError === true && patch.text === 'Success. Updated the following files:\nA NOTAS.md\n', show(patch));
  check('C7 JSON con exit_code 0 no es error', r(JSON.stringify({ output: 'ok', metadata: { exit_code: 0 } })).isError === false);
  check('C7 un texto que empieza con { y no es ese JSON queda tal cual', r('{ no es json').text === '{ no es json');
  const items = r([{ type: 'input_text', text: 'hola' }, { type: 'input_image', image_url: 'data:image/png;base64,xx' }, { type: 'output_text', text: 'chau' }]);
  check('C7 array: textos unidos e imagenes contadas', items.text === 'hola\nchau' && items.imageCount === 1 && items.isError === false, show(items));
  const object = r({ content: [{ type: 'text', text: 'x' }], success: false });
  check('C7 objeto con content y success false: error', object.isError === true && object.text === 'x');
  const long = r('y'.repeat(5000));
  check('C7 5000 caracteres: recortado a 4000 y truncated', long.truncated === true && long.text.length === 4000);
  check('C7 otra cosa: vacio', same(r(42), { text: '', truncated: false, isError: false, imageCount: 0 }));

  const content =
    taskStarted(BASE) + customCall(BASE + 1, 'call_P1', 'apply_patch', '*** Begin Patch\n*** Add File: NOTAS.md\n+# Notas\n*** End Patch') +
    customOutput(BASE + 2, 'call_P1', JSON.stringify({ output: 'Success.', metadata: { exit_code: 0 } })) +
    fnCall(BASE + 3, 'call_X', 'shell_command', '{roto') + fnCall(BASE + 4, '', 'shell_command', '{}') +
    fnCall(BASE + 5, 'call_Y', '', '{}') + fnOutput(BASE + 6, '', 'Exit code: 0');
  const { result } = await sinkRead(content);
  check('C7 apply_patch: la entrada va tal cual, sin reformatear',
    result.added[0]?.parts[0]?.input === '*** Begin Patch\n*** Add File: NOTAS.md\n+# Notas\n*** End Patch');
  check('C7 custom_tool_call_output: el texto de output', result.added[1]?.parts[0]?.text === 'Success.' && result.added[1].role === 'user');
  check('C7 argumentos que no parsean: tal cual', result.added[2]?.parts[0]?.input === '{roto');
  check('C7 llamadas o salidas sin id o sin nombre no son tarjetas', result.added.length === 3, shape(result.added));
  const huge = await sinkRead(fnCall(BASE, 'call_Z', 'shell_command', JSON.stringify({ command: 'z'.repeat(3000) })));
  check('C7 la entrada se recorta a 2000', huge.result.added[0]?.parts[0]?.input.length === 2000 && huge.result.added[0].parts[0].truncated === true);
}

// C8. Imagenes.
{
  const png = { mediaType: 'image/png', data: PNG };
  const jpeg = { mediaType: 'image/jpeg', data: Buffer.from('no es un jpeg de verdad').toString('base64') };
  const id = cid(8);
  const file = await writeRollout(sessionsRoot, id,
    sessionMeta({ id }) + taskStarted(BASE) +
    userPair(BASE + 1, '[Image #1] qué ves acá', [png]) +
    userPair(BASE + 3, '[Image #1] [Image #2] compará', [png, jpeg], { withPath: false }) +
    userPair(BASE + 5, '[Image #1] [Image #2] y la otra', [png]) +
    rec(BASE + 7, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }] }) +
    tokenCountNull(BASE + 8) + userMessageOnly(BASE + 9, '[Image #1] lejos') +
    userPair(BASE + 10, '', [png]),
    paths.uuidV7Millis(id));
  const follower = new CodexSessionFollower(CWD, id);
  await follower.start();
  const { added } = await follower.poll();
  const users = added.filter((e) => e.role === 'user');
  check('C8 una imagen (formato con path): imagen 0 de content y el texto sin la etiqueta',
    same(users[0]?.parts, [{ kind: 'image', index: 0, mediaType: 'image/png', source: 'content' }, { kind: 'text', text: 'qué ves acá', truncated: false }]),
    show(users[0]?.parts));
  check('C8 dos imagenes (formato 0.128, sin path): las dos, con su tipo',
    same(users[1]?.parts.map((p) => p.kind === 'image' ? `${p.index}:${p.mediaType}` : p.text), ['0:image/png', '1:image/jpeg', 'compará']),
    show(users[1]?.parts));
  check('C8 [Image #2] sin segunda imagen queda en el texto', users[2]?.parts.at(-1)?.text === '[Image #2] y la otra', show(users[2]?.parts));
  check('C8 un user_message sin su message/user justo antes: sin imagen, etiqueta intacta',
    same(users[3]?.parts, [{ kind: 'text', text: '[Image #1] lejos', truncated: false }]), show(users[3]?.parts));
  check('C8 solo imagen, sin texto: una parte de imagen', same(users[4]?.parts.map((p) => p.kind), ['image']));

  const loaded = await follower.readImage(users[0].eventId, 0, 'content');
  check('C8 readImage: image/png y el base64 original', loaded?.mediaType === 'image/png' && loaded.data === PNG);
  const second = await follower.readImage(users[1].eventId, 1, 'content');
  check('C8 readImage de la segunda: la segunda', second?.mediaType === 'image/jpeg' && second.data === jpeg.data);
  check('C8 readImage con source attachment: null', (await follower.readImage(users[0].eventId, 0, 'attachment')) === null);
  check('C8 readImage de una posicion que no esta: null', (await follower.readImage(users[0].eventId, 1, 'content')) === null);
  check('C8 readImage de un evento sin imagenes: null', (await follower.readImage(users[3].eventId, 0, 'content')) === null);

  check('C8 loadRolloutImage de una linea que no es message/user: null', (await loadRolloutImage(file, 1, 0)) === null);
  check('C8 loadRolloutImage de un archivo que no existe: null', (await loadRolloutImage(path.join(work, 'no.jsonl'), 1, 0)) === null);
  check('C8 loadRolloutImage de una linea que no existe: null', (await loadRolloutImage(file, 9999, 0)) === null);

  const url = rec(BASE, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'https://example.com/x.png' }] });
  const bigData = 'A'.repeat(Math.ceil((shared.MAX_SUBMIT_IMAGE_BYTES + 10) * 4 / 3));
  const big = rec(BASE, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${bigData}` }] });
  const odd = path.join(work, 'imagenes-raras.jsonl');
  await writeFile(odd, url + big);
  check('C8 una imagen que no es data: null', (await loadRolloutImage(odd, 1, 0)) === null);
  check('C8 una imagen que pasa el tope: null', (await loadRolloutImage(odd, 2, 0)) === null);
}

// C9. Desconocido, ordinal y metadata.
{
  const unknown =
    rec(BASE, 'world_state', { anything: 1 }) + rec(BASE, 'token_usage_record', { x: 1 }) + rec(BASE, 'compacted', { message: 'x' }) +
    rec(BASE, 'event_msg', { type: 'item_completed', item: { type: 'function_call_output', call_id: 'c', output: 'Exit code: 0' } }) +
    rec(BASE, 'response_item', { type: 'local_shell_call', call_id: 'c' }) + line({ type: 'nuevo' }) +
    line({ timestamp: iso(BASE), type: 'response_item', payload: [1, 2] }) + line({ timestamp: iso(BASE), type: 'event_msg', payload: 'x' }) +
    rec(BASE, 'response_item', { type: 'message', role: 'developer', content: 'no es array' }) +
    rec(BASE, 'response_item', { type: 'message', role: 'assistant', content: 'no es array' });
  let threw = false;
  let added = [];
  try {
    ({ result: { added } } = await sinkRead(unknown));
  } catch {
    threw = true;
  }
  check('C9 lineas desconocidas o con forma rara: ningun evento ni excepcion', !threw && added.length === 0, shape(added));

  const plain = await sinkRead(assistant(BASE, 'hola'));
  const withOrdinal = await sinkRead(line({ timestamp: iso(BASE), ordinal: 7, type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hola' }] } }));
  const withMetadata = await sinkRead(line({ timestamp: iso(BASE), type: 'response_item', metadata: { a: 1 }, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'hola' }] } }));
  check('C9 una linea con ordinal da el mismo evento', same(plain.result.added, withOrdinal.result.added), show(withOrdinal.result.added));
  check('C9 un response_item con metadata de primer nivel da el mismo evento', same(plain.result.added, withMetadata.result.added));
}

// C10. El seguidor.
{
  let clock = 1_000_000;
  const id = cid(10);
  const follower = new CodexSessionFollower(CWD, id, { now: () => clock });
  check('C10 label sin archivo: codex:<id8>', follower.label === 'codex:019e0000', follower.label);
  await follower.start();
  await follower.poll();
  check('C10 sin archivo: waiting', follower.getState() === 'waiting');

  const file = await writeRollout(sessionsRoot, id, sessionMeta({ id }) + taskStarted(BASE) + userPair(BASE + 1, 'hola'), paths.uuidV7Millis(id));
  clock += 500;
  const early = await follower.poll();
  check('C10 el archivo aparecio, pero no se busca de nuevo antes de 2 s', follower.getState() === 'waiting' && early.added.length === 0);
  clock += 2000;
  const found = await follower.poll();
  check('C10 pasados 2 s se vuelve a buscar, lo encuentra y queda live',
    follower.getState() === 'live' && found.added.length === 1 && follower.label === file, follower.label);
  check('C10 noticeChange de su ruta: true', follower.noticeChange(file) === true);
  check('C10 noticeChange de otra ruta: false', follower.noticeChange(path.join(path.dirname(file), rolloutName(BASE, cid(11)))) === false);
  check('C10 plans, permisos y usage de Codex', same(follower.getPlanFiles(), []) && follower.getPermissionMode() === null);

  // El watcher antes que el reintento: se queda con el rollout que nombra su id.
  const watcherId = cid(12);
  const watched = new CodexSessionFollower(CWD, watcherId, { now: () => clock });
  await watched.start();
  const watchedFile = await writeRollout(sessionsRoot, watcherId, sessionMeta({ id: watcherId }) + userPair(BASE + 1, 'visto'), paths.uuidV7Millis(watcherId));
  check('C10 sin archivo, un aviso de un rollout de otra sesion: false', watched.noticeChange(file) === false);
  check('C10 sin archivo, un aviso con su id: true y se fija esa ruta', watched.noticeChange(watchedFile) === true && watched.label === watchedFile);
  const watchedPoll = await watched.poll();
  check('C10 y la lectura siguiente ya es live', watched.getState() === 'live' && watchedPoll.added.length === 1);

  const empty = new CodexSessionFollower(CWD, '');
  await empty.start();
  await empty.poll();
  check('C10 sessionId vacio: waiting, label sin sesion y noticeChange siempre false',
    empty.getState() === 'waiting' && empty.label === 'codex:(sin sesion)' && empty.noticeChange(file) === false &&
    empty.noticeChange(watchedFile) === false);
}

// C11. findRollout.
{
  const inDay = cid(20);
  const dayFile = await writeRollout(sessionsRoot, inDay, sessionMeta({ id: inDay }), paths.uuidV7Millis(inDay));
  check('C11 un v7 en la carpeta de su dia', (await findRollout(inDay)) === dayFile);
  check('C11 el id en mayusculas tambien', (await findRollout(inDay.toUpperCase())) === dayFile);

  const dayBefore = cid(21);
  const beforeFile = await writeRollout(sessionsRoot, dayBefore, sessionMeta({ id: dayBefore }), paths.uuidV7Millis(dayBefore) - DAY);
  check('C11 un v7 en la carpeta del dia anterior', (await findRollout(dayBefore)) === beforeFile);

  const archived = cid(22);
  await mkdir(archivedRoot, { recursive: true });
  const archivedFile = path.join(archivedRoot, rolloutName(BASE, archived));
  await writeFile(archivedFile, sessionMeta({ id: archived }));
  check('C11 en archived_sessions', (await findRollout(archived)) === archivedFile);

  const far = cid(23);
  await writeRollout(sessionsRoot, far, sessionMeta({ id: far }), paths.uuidV7Millis(far) + 5 * DAY);
  check('C11 un v7 a mas de un dia de su marca: null', (await findRollout(far)) === null);
  check('C11 un id que no existe: null', (await findRollout(cid(24))) === null);
  check('C11 algo que no es un uuid: null', (await findRollout('../../auth')) === null);

  const v4 = 'a4a4a4a4-4444-4444-8444-444444444444';
  const v4File = await writeRollout(sessionsRoot, v4, sessionMeta({ id: v4 }), Date.UTC(2020, 0, 15, 12));
  check('C11 un v4 guardado en cualquier carpeta: por el recorrido', (await findRollout(v4)) === v4File);
  const junk = path.join(sessionsRoot, 'basura');
  await mkdir(junk, { recursive: true });
  const lost = 'b5b5b5b5-5555-4555-8555-555555555555';
  await writeFile(path.join(junk, rolloutName(BASE, lost)), sessionMeta({ id: lost }));
  check('C11 el recorrido no entra en carpetas que no son de fecha', (await findRollout(lost)) === null);
}

// C12. scanRollout.
{
  const scanDir = path.join(work, 'scan');
  await mkdir(scanDir, { recursive: true });
  let n = 0;
  const scan = async (content, { id = cid(30), nameId = id } = {}) => {
    const file = path.join(scanDir, `${++n}-${rolloutName(BASE, nameId)}`);
    await writeFile(file, content);
    return scanRollout({ ref: file, sessionId: nameId, group: nameId, mtimeMs: 1234, sizeBytes: 99 });
  };

  const moved = win ? 'D:\\Mi App\\sub' : '/home/u/mi-app/sub';
  const cli = await scan(
    sessionMeta({ id: cid(30) }) + taskStarted(BASE) + turnContext(BASE + 1) + userPair(BASE + 2, '[Image #1] mirá <b>esto</b>', [{ mediaType: 'image/png', data: PNG }]) +
    assistant(BASE + 3, 'ok') + taskStarted(BASE + 4) + turnContext(BASE + 5, { cwd: moved }) + userPair(BASE + 6, 'segundo'));
  check('C12 cli: titulo del primer mensaje sin la etiqueta, first-message, cwd de meta y de reanudar el ultimo',
    cli !== null && cli.summary.title === 'mirá esto' && cli.summary.titleSource === 'first-message' &&
    cli.cwd === CWD && cli.resumeCwd === moved && cli.summary.sessionId === cid(30) &&
    cli.summary.updatedAt === 1234 && cli.summary.sizeBytes === 99 && same(cli.extra, {}), show(cli));
  const stayed = await scan(sessionMeta({ id: cid(30) }) + turnContext(BASE + 1) + userPair(BASE + 2, 'quieto'));
  check('C12 sin cambio de carpeta: resumeCwd null', stayed?.resumeCwd === null && stayed.cwd === CWD);
  const vscode = await scan(sessionMeta({ id: cid(30), source: 'vscode', historyMode: 'legacy' }) + userPair(BASE + 2, 'desde el editor'));
  check('C12 vscode y legacy: se lista', vscode?.summary.title === 'desde el editor');

  check('C12 exec: null', (await scan(sessionMeta({ id: cid(30), source: 'exec' }) + userPair(BASE, 'x'))) === null);
  check('C12 source objeto (subagente): null', (await scan(sessionMeta({ id: cid(30), source: { subagent: 'review' } }) + userPair(BASE, 'x'))) === null);
  check('C12 linea 0 que no es session_meta: null', (await scan(taskStarted(BASE) + sessionMeta({ id: cid(30) }) + userPair(BASE, 'x'))) === null);
  check('C12 history_mode desconocido: null', (await scan(sessionMeta({ id: cid(30), historyMode: 'otro' }) + userPair(BASE, 'x'))) === null);
  check('C12 id del nombre distinto de payload.id: null', (await scan(sessionMeta({ id: cid(31) }) + userPair(BASE, 'x'), { id: cid(31), nameId: cid(30) })) === null);
  check('C12 sin cwd: null', (await scan(sessionMeta({ id: cid(30), cwd: '' }) + userPair(BASE, 'x'))) === null);
  const untitled = await scan(sessionMeta({ id: cid(30) }) + taskStarted(BASE));
  check('C12 sin user_message: el titulo de una sesion sin titulo y none',
    untitled?.summary.title === 'Sesion sin titulo' && untitled.summary.titleSource === 'none', show(untitled?.summary));

  // Lo que usa scanRollout para no leer la cabeza de lo que no se lista.
  const { readHeadLines } = await import('../src/jsonl-reader.ts');
  const headFile = path.join(scanDir, 'cabeza.jsonl');
  await writeFile(headFile, 'uno\n\ndos\ntres\n');
  const asked = [];
  const cut = await readHeadLines(headFile, { maxLines: 40, maxBytes: 1024, stopAfter: (text, index) => { asked.push(`${index}:${text}`); return index === 0; } });
  check('C12 readHeadLines con stopAfter en true en la linea 0: esa sola, y no pregunta mas', same(cut, ['uno']) && same(asked, ['0:uno']), show([cut, asked]));
  asked.length = 0;
  const whole = await readHeadLines(headFile, { maxLines: 40, maxBytes: 1024, stopAfter: (text, index) => { asked.push(`${index}:${text}`); return false; } });
  check('C12 readHeadLines con stopAfter en false: todas, con el indice de las lineas no vacias',
    same(whole, ['uno', 'dos', 'tres']) && same(asked, ['0:uno', '1:dos', '2:tres']), show([whole, asked]));
  const plain = await readHeadLines(headFile, { maxLines: 2, maxBytes: 1024 });
  check('C12 readHeadLines sin stopAfter: como siempre', same(plain, ['uno', 'dos']), show(plain));
  const execTail = await scan(sessionMeta({ id: cid(30), source: 'exec' }) + userPair(BASE, 'x') + turnContext(BASE + 1, { cwd: moved }));
  check('C12 exec con cabeza y cola completas: null igual', execTail === null);
}

// E2 (adelantado): la fuente de historial, sin registrar el adaptador.
{
  const history = createCodexHistory();
  const roots = history.roots();
  check('E2 roots declara las dos raices aunque no existan',
    roots.length === 2 && roots[0].path === sessionsRoot && roots[0].depth === 3 &&
    roots[1].path === archivedRoot && roots[1].depth === 0, show(roots.map((r) => [r.path, r.depth])));
  const good = path.join(sessionsRoot, '2026', '05', '05', rolloutName(BASE, cid(40)));
  check('E2 accepts: un rollout si, history.jsonl y un .zst no',
    roots[0].accepts(good) && !roots[0].accepts(path.join(codexHome, 'history.jsonl')) && !roots[0].accepts(`${good}.zst`));
  check('E2 changedRefs de un rollout de sessions o de archived: [ruta]',
    same(await history.changedRefs(good), [good]) &&
    same(await history.changedRefs(path.join(archivedRoot, rolloutName(BASE, cid(41)))), [path.join(archivedRoot, rolloutName(BASE, cid(41)))]));
  check('E2 changedRefs de history.jsonl o de fuera de las raices: null',
    (await history.changedRefs(path.join(codexHome, 'history.jsonl'))) === null &&
    (await history.changedRefs(path.join(work, rolloutName(BASE, cid(42))))) === null);

  const zst = path.join(paths.localDayFolder(sessionsRoot, BASE), `${rolloutName(BASE, cid(43))}.zst`);
  await mkdir(path.dirname(zst), { recursive: true });
  await writeFile(zst, 'x');
  const listed = await history.list();
  const refs = listed?.map((item) => item.ref) ?? [];
  check('E2 list: los rollouts de sessions y de archived, sin .zst ni carpetas que no son de fecha',
    refs.length > 0 && refs.every((ref) => paths.parseRolloutFileName(path.basename(ref)) !== null) &&
    refs.some((ref) => ref.startsWith(archivedRoot)) && !refs.some((ref) => ref.includes('basura')), show(refs.length));
  const item = listed?.find((entry) => entry.sessionId === cid(20));
  check('E2 cada item: la sesion es su propio grupo', item !== undefined && item.group === cid(20) && item.sizeBytes > 0);
  check('E2 item de una ruta que ya no esta: null', (await history.item(path.join(sessionsRoot, rolloutName(BASE, cid(44))))) === null);
  check('E2 exists con y sin rollout', (await history.exists('', cid(20))) === true && (await history.exists(CWD, cid(45))) === false);
  check('E2 sin planes', history.plans === null);
}

// C13. pickPendingTab, pura.
{
  const key = (cwd, platform = 'win32') => shared.normalizeCwdKey(cwd, platform);
  const cand = (over) => ({ path: 'p', sessionId: cid(50), cwdKey: key('D:\\Mi App'), createdAt: 10_000, interactive: true, firstText: 'hola', ...over });
  const tab = (terminalId, launchedAt, over = {}) => ({ terminalId, cwdKey: key('D:\\Mi App'), launchedAt, submitted: [], ...over });

  const a = pickPendingTab(cand({ cwdKey: key('d:/mi app/') }), [tab('t1', 9_000)]);
  check('C13 (a) mismo cwd con otra mayuscula y barra final: elegida, por lanzamiento, segura',
    same(a, { terminalId: 't1', confirmedByText: false, uncertain: false, reason: null }), show(a));
  check('C13 (b) otro cwd: null', pickPendingTab(cand({ cwdKey: key('D:\\Otra') }), [tab('t1', 9_000)]) === null);
  check('C13 (c) rollout creado 2 s antes del lanzamiento: null', pickPendingTab(cand({ createdAt: 7_000 }), [tab('t1', 9_000)]) === null);
  check('C13 (c) dentro del margen de 1 s: elegida', pickPendingTab(cand({ createdAt: 8_200 }), [tab('t1', 9_000)])?.terminalId === 't1');

  const pair = [tab('vieja', 0), tab('nueva', 5_000)];
  check('C13 (d) rollout creado entre las dos: la primera', pickPendingTab(cand({ createdAt: 2_000 }), pair)?.terminalId === 'vieja');
  const d2 = pickPendingTab(cand({ createdAt: 7_000 }), pair);
  check('C13 (d) rollout despues de la segunda: la segunda, segura', d2?.terminalId === 'nueva' && d2.uncertain === false, show(d2));
  const e = pickPendingTab(cand({ createdAt: 2_000 }), [tab('vieja', 0), tab('nueva', 800)]);
  check('C13 (e) dos lanzamientos a 800 ms: la mas nueva y dudosa', e?.terminalId === 'nueva' && e.uncertain === true && /1,5 s/.test(e.reason ?? ''), show(e));
  const f = pickPendingTab(cand({ createdAt: 7_000 }), [tab('vieja', 0, { submitted: ['hola'] }), tab('nueva', 5_000)]);
  check('C13 (f) el texto casa con la mas vieja: la mas vieja, confirmada', f?.terminalId === 'vieja' && f.confirmedByText === true && f.uncertain === false, show(f));
  const g = pickPendingTab(cand({ firstText: 'otra cosa' }), [tab('t1', 9_000, { submitted: ['hola'] })]);
  check('C13 (g) la elegida mando otro texto: elegida y dudosa', g?.terminalId === 't1' && g.uncertain === true && /primer mensaje/.test(g.reason ?? ''), show(g));
  const twice = pickPendingTab(cand({ createdAt: 7_000 }), [tab('vieja', 0, { submitted: ['hola'] }), tab('nueva', 5_000, { submitted: ['hola'] })]);
  check('C13 dos pestanas mandaron el mismo texto: la mas nueva y dudosa', twice?.terminalId === 'nueva' && twice.uncertain === true && twice.confirmedByText === true);
  const h = pickPendingTab(cand({ firstText: null }), [tab('t1', 9_000)], [{ terminalId: 'casada', cwdKey: key('D:\\Mi App') }]);
  check('C13 (M4) otra pestana ya casada en el mismo proyecto: dudosa', h?.terminalId === 't1' && h.uncertain === true && /otra pestana/.test(h.reason ?? ''), show(h));
  const h2 = pickPendingTab(cand({}), [tab('t1', 9_000)], [{ terminalId: 'casada', cwdKey: key('D:\\Otra') }]);
  check('C13 (M4) casada en otro proyecto: segura', h2?.uncertain === false);
  const h3 = pickPendingTab(cand({}), [tab('t1', 9_000, { submitted: ['hola'] })], [{ terminalId: 'casada', cwdKey: key('D:\\Mi App') }]);
  check('C13 (M4) con el texto confirmado, la casada no la vuelve dudosa', h3?.confirmedByText === true && h3.uncertain === false);
  const linux = pickPendingTab(cand({ cwdKey: key('/Home/u', 'linux') }), [tab('t1', 9_000, { cwdKey: key('/home/u', 'linux') })]);
  check('C13 linux: las mayusculas cuentan', linux === null);
}

// C14. CodexSessionDiscovery de punta a punta.
{
  const discRoot = path.join(root, 'disc', 'sessions');
  await mkdir(discRoot, { recursive: true });
  // El reloj falso va por detras del de verdad: los rollouts se escriben con el
  // mtime real, y uno "anterior" a todo lanzamiento se salta sin leer.
  const T0 = Date.now() - 900_000;
  let clock = T0 + 20_000;
  const discovery = new CodexSessionDiscovery({ pollMs: 2_000_000_000, now: () => clock, sessionsRoot: () => discRoot });
  const reports = [];
  const register = (terminalId, launchedAt, cwd = CWD) =>
    discovery.register({ terminalId, cwd, launchedAt, reportSessionId: (id) => reports.push(`${terminalId}=${id}`) });
  const did = (n) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const writeDisc = (id, content, createdAt) => writeRollout(discRoot, id, content, createdAt);

  const hookA = register('tab-a', T0);
  const hookB = register('tab-b', T0 + 5_000);
  check('C14 dos pendientes y el sondeo andando', discovery.pendingCount() === 2 && discovery.isPolling());
  hookB.onSubmitted('  hola\r\n  codex ');

  await writeDisc(did(1), sessionMeta({ id: did(1), createdAt: T0 + 6_000 }) + taskStarted(T0 + 6_001) + userPair(T0 + 6_002, 'hola codex'), T0 + 6_000);
  await writeDisc(did(2), sessionMeta({ id: did(2), createdAt: T0 + 6_500, source: 'exec' }) + userPair(T0 + 6_501, 'otra app'), T0 + 6_500);
  await writeDisc(did(3), sessionMeta({ id: did(3), createdAt: T0 + 6_600, cwd: OTHER_CWD }) + userPair(T0 + 6_601, 'hola codex'), T0 + 6_600);
  const first = await captureWarnings(() => discovery.scanOnce());
  check('C14 una pasada: reportSessionId una vez, en la segunda, con su id', same(reports, [`tab-b=${did(1)}`]), show(reports));
  check('C14 confirmada por texto: sin aviso', first.length === 0, first.join(' | '));
  await discovery.scanOnce();
  check('C14 otra pasada: nada nuevo', reports.length === 1);

  const fileA = await writeDisc(did(4), sessionMeta({ id: did(4), createdAt: T0 + 1_000 }) + taskStarted(T0 + 1_001), T0 + 1_000);
  await discovery.scanOnce();
  check('C14 cabeza sin user_message leida hasta el final: no se asigna todavia', reports.length === 1 && discovery.pendingCount() === 1);
  await appendFile(fileA, userPair(T0 + 1_002, 'algo'));
  const second = await captureWarnings(() => discovery.scanOnce());
  check('C14 completada: se asigna a la primera', reports.at(-1) === `tab-a=${did(4)}`, show(reports));
  check('C14 con la segunda ya casada en el mismo proyecto: avisa (M4)', second.length === 1 && second[0].includes('otra pestana'), second.join(' | '));
  check('C14 sin pendientes el sondeo para', discovery.pendingCount() === 0 && !discovery.isPolling());

  // M2: 40 lineas sin user_message -> se casa sin texto en vez de esperar para siempre.
  clock = T0 + 60_000;
  const cwdC = win ? 'D:\\Proyecto C' : '/home/u/proyecto-c';
  register('tab-c', T0 + 30_000, cwdC);
  let crowded = sessionMeta({ id: did(5), createdAt: T0 + 31_000, cwd: cwdC });
  for (let i = 0; i < 45; i++) crowded += tokenCountNull(T0 + 31_001);
  await writeDisc(did(5), crowded + userPair(T0 + 31_100, 'tarde'), T0 + 31_000);
  await discovery.scanOnce();
  check('C14 (M2) tope de lineas sin user_message: se casa igual', reports.at(-1) === `tab-c=${did(5)}`, show(reports));

  // M2: rechazo definitivo de un candidato sin pestana elegible, y M4: fuera los /fork.
  clock = T0 + 200_000;
  const guard = register('tab-g', T0 + 100_000, win ? 'D:\\Guardia' : '/home/u/guardia');
  await writeDisc(did(6), sessionMeta({ id: did(6), createdAt: T0 + 150_000 }) + userPair(T0 + 150_001, 'nadie'), T0 + 150_000);
  await discovery.scanOnce();
  // Lanzada "antes" del rollout: no puede pasar, y por eso rechazarlo es seguro.
  const late = register('tab-h', T0 + 140_000);
  await writeDisc(did(7), sessionMeta({ id: did(7), createdAt: T0 + 160_000, forkedFromId: did(1) }) + userPair(T0 + 160_001, 'bifurcada'), T0 + 160_000);
  await captureWarnings(() => discovery.scanOnce());
  check('C14 (M2) un candidato sin elegible y viejo queda rechazado: no se lo lleva una pendiente posterior',
    !reports.some((r) => r.includes(did(6))), show(reports));
  check('C14 (M4) un rollout con forked_from_id no se asigna', !reports.some((r) => r.includes(did(7))), show(reports));

  const freshCwd = win ? 'D:\\Reciente' : '/home/u/reciente';
  await writeDisc(did(8), sessionMeta({ id: did(8), createdAt: clock - 1_000, cwd: freshCwd }) + userPair(clock - 999, 'recien'), clock - 1_000);
  await discovery.scanOnce();
  register('tab-i', clock - 5_000, freshCwd);
  await discovery.scanOnce();
  check('C14 (M2) uno creado hace menos de 2 s no se rechaza: lo toma la pendiente que llega', reports.at(-1) === `tab-i=${did(8)}`, show(reports));

  // Se recuerdan los ultimos cinco textos.
  const cwdJ = win ? 'D:\\Textos' : '/home/u/textos';
  const hookJ = register('tab-j', clock + 1_000, cwdJ);
  for (let i = 1; i <= 6; i++) hookJ.onSubmitted(`mensaje ${i}`);
  const cwdK = win ? 'D:\\Textos2' : '/home/u/textos2';
  const hookK = register('tab-k', clock + 1_000, cwdK);
  for (let i = 1; i <= 6; i++) hookK.onSubmitted(`mensaje ${i}`);
  clock += 10_000;
  await writeDisc(did(9), sessionMeta({ id: did(9), createdAt: clock - 5_000, cwd: cwdJ }) + userPair(clock - 4_999, 'mensaje 1'), clock - 5_000);
  await writeDisc(did(10), sessionMeta({ id: did(10), createdAt: clock - 5_000, cwd: cwdK }) + userPair(clock - 4_999, 'mensaje 6'), clock - 5_000);
  const texts = await captureWarnings(() => discovery.scanOnce());
  check('C14 un texto mas viejo que los ultimos cinco ya no confirma: avisa',
    reports.includes(`tab-j=${did(9)}`) && texts.some((w) => w.includes('primer mensaje')), texts.join(' | '));
  check('C14 el ultimo si confirma: sin aviso para esa', reports.includes(`tab-k=${did(10)}`) && texts.length === 1, texts.join(' | '));

  // Pasada final al salir el proceso.
  const cwdE = win ? 'D:\\Salida' : '/home/u/salida';
  const hookE = register('tab-e', clock + 1_000, cwdE);
  clock += 10_000;
  await writeDisc(did(11), sessionMeta({ id: did(11), createdAt: clock - 5_000, cwd: cwdE }) + userPair(clock - 4_999, 'chau'), clock - 5_000);
  const pendingBefore = discovery.pendingCount();
  hookE.onExit();
  check('C14 al salir, una pasada final encuentra el rollout que dejo',
    await waitFor(() => reports.includes(`tab-e=${did(11)}`)), show(reports));
  check('C14 y despues la suelta', await waitFor(() => discovery.pendingCount() === pendingBefore - 1));

  const running = discovery.scanOnce();
  check('C14 no corren dos pasadas a la vez', discovery.scanOnce() === running);
  await running;

  guard.cancel();
  late.cancel();
  hookA.cancel();
  hookB.cancel();
  hookB.cancel();
  check('C14 cancel de todas: sin pendientes y sin sondeo', discovery.pendingCount() === 0 && !discovery.isPolling());
  const reportsBefore = reports.length;
  guard.onSubmitted('tarde');
  await writeDisc(did(12), sessionMeta({ id: did(12), createdAt: T0 + 100_500, cwd: win ? 'D:\\Guardia' : '/home/u/guardia' }) + userPair(T0 + 100_501, 'tarde'), T0 + 100_500);
  await discovery.scanOnce();
  check('C14 una pestana cancelada no recibe nada', reports.length === reportsBefore);

  register('tab-z', clock);
  check('C14 registrar de nuevo arranca el sondeo', discovery.isPolling());
  discovery.dispose();
  check('C14 dispose: sin temporizador y sin pendientes', !discovery.isPolling() && discovery.pendingCount() === 0);
}

// C14 (M4). Una pestana reanudada y viva cuenta como casada: sus /new avisan.
{
  const discRoot = path.join(root, 'disc-m4', 'sessions');
  await mkdir(discRoot, { recursive: true });
  const T0 = Date.now() - 900_000;
  const discovery = new CodexSessionDiscovery({ pollMs: 2_000_000_000, now: () => T0 + 60_000, sessionsRoot: () => discRoot });
  const reports = [];
  const did = (n) => `019f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const register = (terminalId, launchedAt) =>
    discovery.register({ terminalId, cwd: CWD, launchedAt, reportSessionId: (id) => reports.push(`${terminalId}=${id}`) });
  const writeNew = (n, createdAt, text) =>
    writeRollout(discRoot, did(n), sessionMeta({ id: did(n), createdAt }) + userPair(createdAt + 1, text), createdAt);

  // A se desperto con `codex resume` tras reiniciar; B se abre despues en el mismo proyecto.
  // En Windows con otra forma de escribir la misma carpeta: se compara por clave.
  const live = discovery.watchLive({ terminalId: 'tab-a', cwd: win ? 'd:/mi app/' : CWD });
  check('C14 (M4) la reanudada no queda pendiente ni arranca el sondeo', discovery.pendingCount() === 0 && !discovery.isPolling());
  live.onInput();
  const hookB = register('tab-b', T0 + 1_000);
  await writeNew(20, T0 + 5_000, 'desde la reanudada');
  const warned = await captureWarnings(() => discovery.scanOnce());
  check('C14 (M4) un /new en la reanudada y viva: se asigna, pero avisa',
    same(reports, [`tab-b=${did(20)}`]) && warned.length === 1 && warned[0].includes('otra pestana'), show([reports, warned]));

  // Al salir su proceso deja de contar; B tambien se cierra.
  live.onExit();
  hookB.cancel();
  const hookC = register('tab-c', T0 + 10_000);
  await writeNew(21, T0 + 12_000, 'sin nadie al lado');
  const quiet = await captureWarnings(() => discovery.scanOnce());
  check('C14 (M4) la reanudada ya salio: sin aviso', reports.at(-1) === `tab-c=${did(21)}` && quiet.length === 0, show([reports, quiet]));
  hookC.cancel();

  // Relanzada reanudando otra vez: el registro pone el gancho nuevo y despues cancela el viejo.
  const older = discovery.watchLive({ terminalId: 'tab-e', cwd: CWD });
  const newer = discovery.watchLive({ terminalId: 'tab-e', cwd: CWD });
  older.cancel();
  register('tab-f', T0 + 20_000);
  await writeNew(22, T0 + 22_000, 'tras relanzar');
  const relaunched = await captureWarnings(() => discovery.scanOnce());
  check('C14 (M4) cancelar el gancho viejo no suelta al del lanzamiento nuevo',
    reports.at(-1) === `tab-f=${did(22)}` && relaunched.length === 1 && relaunched[0].includes('otra pestana'), show([reports, relaunched]));
  newer.cancel();
  discovery.dispose();
}

// C16. Modo paginated: lo que escribe la TUI de la 0.154 (medido en la verificacion de cierre).
// El mensaje del usuario no es `user_message` sino `item_completed` de un `UserMessage`.
{
  const itemCompleted = (ms, item) => rec(ms, 'event_msg', {
    type: 'item_completed', thread_id: 'hilo', turn_id: 'turno-1', item, started_at_ms: ms, completed_at_ms: ms,
  });
  const userPaged = (ms, text) =>
    rec(ms, 'response_item', { type: 'message', id: 'msg_u', role: 'user', content: [{ type: 'input_text', text }] }) +
    itemCompleted(ms + 1, { type: 'UserMessage', id: 'u1', client_id: 'c1', content: [{ type: 'text', text, text_elements: [] }] });
  const agentPaged = (ms, text) => itemCompleted(ms, { type: 'AgentMessage', id: 'msg_a', content: [{ type: 'Text', text }], phase: 'final_answer' });
  const withOrdinals = (content) => content.split('\n').filter(Boolean)
    .map((raw, ordinal) => JSON.stringify({ ...JSON.parse(raw), ordinal })).join('\n') + '\n';
  const usage = { input: 15035, cached: 9984, output: 5, total: 15040 };
  const paged = (id, text, historyMode = 'paginated', createdAt = BASE, cwd = CWD) => withOrdinals(
    sessionMeta({ id, createdAt, cwd, historyMode }) + taskStarted(createdAt + 1) + developer(createdAt + 2) + environmentContext(createdAt + 3) +
    rec(createdAt + 4, 'world_state', { full: {}, state: {} }) + turnContext(createdAt + 5) + userPaged(createdAt + 6, text) +
    agentPaged(createdAt + 8, 'OK') + assistant(createdAt + 9, 'OK') + rec(createdAt + 10, 'token_usage_record', { usage: {} }) +
    tokenCount(createdAt + 11, usage, usage) + turnEnd(createdAt + 12, 'task_complete', 10951));

  const { result, sink } = await sinkRead(paged(cid(16), 'Respondé solo OK'), cid(16));
  check('C16 paginated: el mensaje del usuario sale del item_completed y la respuesta una sola vez',
    shape(result.added) === 'line-8:user:text,line-10:assistant:text', shape(result.added));
  check('C16 paginated: con su texto, y la duracion en la respuesta',
    result.added[0]?.parts[0]?.text === 'Respondé solo OK' && result.added[1]?.durationMs === 10951, show(result.added));
  check('C16 paginated: el medidor igual que en legacy',
    sink.getUsage().lastRequestTokens === 15035 && sink.getUsage().contextWindow === 258400 && sink.getUsage().assistantMessages === 1, show(sink.getUsage()));
  // La forma medida con una imagen pegada desde el cuadro en la 0.154.
  const imageId = cid(19);
  const imageFile = await writeRollout(sessionsRoot, imageId, withOrdinals(
    sessionMeta({ id: imageId, historyMode: 'paginated' }) + taskStarted(BASE + 1) +
    rec(BASE + 2, 'response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: '<image name=[Image #1] path="C:\\tmp\\pegada-1.png">' },
      { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'high' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: '[Image #1] De qué color es?' },
    ] }) +
    itemCompleted(BASE + 3, { type: 'UserMessage', id: 'u2', client_id: 'c2', content: [
      { type: 'local_image', path: 'C:\\tmp\\pegada-1.png' },
      { type: 'text', text: '[Image #1] De qué color es?', text_elements: [{ byte_range: { start: 0, end: 10 }, placeholder: '[Image #1]' }] },
    ] })), paths.uuidV7Millis(imageId));
  const imageFollower = new CodexSessionFollower(CWD, imageId);
  await imageFollower.start();
  const imagePoll = await imageFollower.poll();
  const imageUser = imagePoll.added.find((e) => e.role === 'user');
  check('C16 paginated con imagen: la miniatura y el texto sin la etiqueta',
    same(imageUser?.parts, [{ kind: 'image', index: 0, mediaType: 'image/png', source: 'content' }, { kind: 'text', text: 'De qué color es?', truncated: false }]), show(imageUser?.parts));
  const imageBytes = await imageFollower.readImage(imageUser?.eventId ?? '', 0, 'content');
  check('C16 paginated con imagen: los bytes salen del rollout', imageBytes?.data === PNG && imageFile.length > 0);

  const other = await sinkRead(itemCompleted(BASE, { type: 'FunctionCallOutput', call_id: 'x', output: 'ok' }) +
    itemCompleted(BASE + 1, { type: 'UserMessage' }) + itemCompleted(BASE + 2, { type: 'Plan', text: 'pasos' }));
  check('C16 un UserMessage sin contenido y los demas item_completed no generan eventos', other.result.added.length === 0, shape(other.result.added));

  const scanPaged = path.join(root, 'scan-paged');
  await mkdir(scanPaged, { recursive: true });
  const scanOne = async (id, content) => {
    const file = path.join(scanPaged, rolloutName(BASE, id));
    await writeFile(file, content);
    return scanRollout({ ref: file, sessionId: id, group: id, mtimeMs: 1, sizeBytes: 2 });
  };
  const listed = await scanOne(cid(17), paged(cid(17), '[Image #1] Respondé solo OK'));
  check('C16 paginated se lista, con el titulo del UserMessage', listed?.summary.title === 'Respondé solo OK' && listed.summary.titleSource === 'first-message', show(listed?.summary));
  check('C16 un modo que no se conoce no se lista', (await scanOne(cid(18), paged(cid(18), 'x', 'otro'))) === null);

  const discRoot = path.join(root, 'disc-paged', 'sessions');
  await mkdir(discRoot, { recursive: true });
  const T0 = Date.now() - 900_000;
  const discovery = new CodexSessionDiscovery({ pollMs: 2_000_000_000, now: () => T0 + 60_000, sessionsRoot: () => discRoot });
  const reports = [];
  const did = (n) => `019f1000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const cwdP = win ? 'D:\\Paginado' : '/home/u/paginado';
  const cwdQ = win ? 'D:\\Otro modo' : '/home/u/otro-modo';
  const hookP = discovery.register({ terminalId: 'tab-p', cwd: cwdP, launchedAt: T0, reportSessionId: (id) => reports.push(`tab-p=${id}`) });
  // La TUI en Windows pierde `¿` y `¡`: lo escrito tiene que confirmar igual.
  hookP.onSubmitted('¡Respondé solo OK!');
  const hookQ = discovery.register({ terminalId: 'tab-q', cwd: cwdQ, launchedAt: T0, reportSessionId: (id) => reports.push(`tab-q=${id}`) });
  await writeRollout(discRoot, did(1), paged(did(1), '[Image #1] Respondé solo OK!', 'paginated', T0 + 2_000, cwdP), T0 + 2_000);
  await writeRollout(discRoot, did(2), paged(did(2), 'x', 'otro', T0 + 2_000, cwdQ), T0 + 2_000);
  const warned = await captureWarnings(() => discovery.scanOnce());
  check('C16 descubrimiento en paginated: casada por texto y sin aviso', same(reports, [`tab-p=${did(1)}`]) && warned.length === 0, show([reports, warned]));
  check('C16 descubrimiento: un modo que no se lee no se asigna', !reports.some((r) => r.startsWith('tab-q')) && discovery.pendingCount() === 1);
  hookQ.cancel();
  discovery.dispose();
}

// C15. Una llamada abierta (A1).
{
  const t = BASE + 1_000;
  const open = await sinkRead(taskStarted(BASE) + userPair(BASE + 1, 'borrá la carpeta') + fnCall(t, 'call_O', 'shell_command', '{}'));
  check('C15 llamada sin resultado, de este proceso: true', open.sink.hasOpenToolCall(t - 5_000) === true);
  check('C15 la pty se lanzo despues de la llamada: false', open.sink.hasOpenToolCall(t + 5_000) === false);
  await appendFile(open.file, fnOutput(t + 10, 'call_O', 'Exit code: 0'));
  await open.follower.poll();
  check('C15 con su salida: false', open.sink.hasOpenToolCall(0) === false);

  const custom = await sinkRead(taskStarted(BASE) + customCall(t, 'call_C', 'apply_patch', '*** Begin Patch'));
  check('C15 custom_tool_call abierta: true', custom.sink.hasOpenToolCall(t) === true);
  await appendFile(custom.file, customOutput(t + 1, 'call_C', '{"output":"ok"}'));
  await custom.follower.poll();
  check('C15 con custom_tool_call_output: false', custom.sink.hasOpenToolCall(0) === false);

  for (const [label, closing] of [
    ['turn_aborted', turnEnd(t + 5, 'turn_aborted', 10)],
    ['task_complete', turnEnd(t + 5, 'task_complete', 10)],
    ['un task_started nuevo', taskStarted(t + 5)],
  ]) {
    const r = await sinkRead(taskStarted(BASE) + fnCall(t, 'call_Q', 'shell_command', '{}') + closing);
    check(`C15 llamada abierta y despues ${label}: false`, r.sink.hasOpenToolCall(0) === false);
  }
  const two = await sinkRead(taskStarted(BASE) + fnCall(t, 'call_1', 'shell_command', '{}') + fnCall(t + 1, 'call_2', 'shell_command', '{}') + fnOutput(t + 2, 'call_1', 'Exit code: 0'));
  check('C15 dos llamadas y una sola salida: true', two.sink.hasOpenToolCall(0) === true);
  const undated = await sinkRead(line({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: '{}', call_id: 'call_S' } }));
  check('C15 una llamada sin hora no se puede descartar como vieja: true', undated.sink.hasOpenToolCall(Date.now()) === true);
  undated.sink.reset();
  check('C15 reset: false', undated.sink.hasOpenToolCall(0) === false);

  /*
    El seguidor que usan el hub y el socket, sobre un rollout de verdad con una
    llamada abierta: un `return false` fijo, o uno que no pase el lanzamiento,
    no pasa esto.
  */
  const openId = cid(13);
  const openFile = await writeRollout(sessionsRoot, openId,
    sessionMeta({ id: openId }) + taskStarted(BASE) + userPair(BASE + 1, 'borrá la carpeta') + fnCall(t, 'call_F', 'shell_command', '{}'),
    paths.uuidV7Millis(openId));
  const follower = new CodexSessionFollower(CWD, openId);
  await follower.start();
  await follower.poll();
  check('C15 el seguidor de Codex lo delega en el sink: llamada abierta de este proceso, true', follower.hasOpenToolCall(t - 5_000) === true);
  check('C15 el seguidor de Codex pasa el lanzamiento: la pty es posterior, false', follower.hasOpenToolCall(t + 5_000) === false);
  await appendFile(openFile, fnOutput(t + 10, 'call_F', 'Exit code: 0'));
  await follower.poll();
  check('C15 el seguidor de Codex, despues de leer la salida: false', follower.hasOpenToolCall(t - 5_000) === false);

  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const claude = createClaudeCodeAdapter();
  const claudeFollower = claude.history.follow({ cwd: CWD, sessionId: 'dddddddd-4444-4444-8444-444444444444' });
  check('C15 Claude Code: siempre false', claudeFollower.hasOpenToolCall(0) === false);
  claude.dispose();
}

// ---------------------------------------------------------------------------
// D8. El indice con un scan que devuelve null, y el cwd de reanudar (paso 3)
// ---------------------------------------------------------------------------

{
  const { SessionIndex, migrateIndexCache } = await import('../src/session-index.ts');
  const { sessionIndexCachePath } = await import('../src/paths.ts');
  const { readFile } = await import('node:fs/promises');
  const readCache = async () => {
    try { return JSON.parse(await readFile(sessionIndexCachePath(), 'utf8')); } catch { return null; }
  };

  const projectDir = path.join(root, 'idx-proyecto');
  const resumeDir = path.join(projectDir, 'sub');
  await mkdir(resumeDir, { recursive: true });
  const items = [
    { ref: 'ref-a', sessionId: cid(60), group: cid(60), mtimeMs: 10, sizeBytes: 1 },
    { ref: 'ref-b', sessionId: cid(61), group: cid(61), mtimeMs: 20, sizeBytes: 1 },
    { ref: 'ref-c', sessionId: cid(62), group: cid(62), mtimeMs: 30, sizeBytes: 1 },
  ];
  const summaryOf = (item, title) => ({ sessionId: item.sessionId, title, titleSource: 'first-message', updatedAt: item.mtimeMs, sizeBytes: 1 });
  const scans = [];
  const scanners = {
    'ref-a': (item) => ({ cwd: projectDir, resumeCwd: resumeDir, summary: summaryOf(item, 'movida'), extra: {} }),
    'ref-b': () => null,
    'ref-c': (item) => ({ cwd: projectDir, resumeCwd: projectDir, summary: summaryOf(item, 'quieta'), extra: {} }),
  };
  const makeAgents = () => {
    const adapter = {
      id: 'codex',
      history: {
        roots: () => [], list: async () => items, changedRefs: async (p) => [p],
        item: async (ref) => items.find((i) => i.ref === ref) ?? null,
        scan: async (item) => { scans.push(item.ref); return scanners[item.ref](item); },
        restored: () => undefined, exists: async () => false, follow: () => { throw new Error('no'); }, plans: null,
      },
    };
    return { all: () => [{ adapter, location: null }], adapter: () => adapter };
  };

  const index = new SessionIndex(makeAgents());
  await index.scan();
  const sessions = index.getProjects().flatMap((p) => p.sessions);
  const status = index.getStatus();
  check('D8 el item con scan null cuenta como escaneado', status.scannedFiles === 3 && status.totalFiles === 3, show(status));
  check('D8 el item con scan null no esta en la barra', sessions.length === 2 && !sessions.some((s) => s.sessionId === cid(61)), show(sessions.map((s) => s.sessionId)));
  const projects = index.getProjects();
  check('D8 un solo proyecto, con la clave del cwd del archivo',
    projects.length === 1 && projects[0].key === shared.normalizeCwdKey(projectDir, process.platform));
  check('D8 resumeCwd distinto: el resumen lleva el de reanudar', sessions.find((s) => s.sessionId === cid(60))?.cwd === resumeDir);
  check('D8 resumeCwd igual: el del archivo', sessions.find((s) => s.sessionId === cid(62))?.cwd === projectDir);
  const cache = await readCache();
  check('D8 la cache no guarda el null', cache !== null && !('codex:ref-b' in cache.entries) && 'codex:ref-a' in cache.entries, show(Object.keys(cache?.entries ?? {})));
  check('D8 la cache guarda resumeCwd solo cuando difiere',
    cache?.entries['codex:ref-a']?.resumeCwd === resumeDir && !('resumeCwd' in (cache?.entries['codex:ref-c'] ?? {})), show(cache?.entries));

  scans.length = 0;
  const warm = new SessionIndex(makeAgents());
  await warm.start();
  check('D8 en caliente termina', await waitFor(() => warm.getStatus().state === 'ready'));
  const warmSessions = warm.getProjects().flatMap((p) => p.sessions);
  check('D8 en caliente solo se relee el null', same(scans, ['ref-b']), show(scans));
  check('D8 en caliente el cwd de reanudar sale de la cache', warmSessions.find((s) => s.sessionId === cid(60))?.cwd === resumeDir);

  // Una entrada vieja del mismo archivo, de cuando si se listaba.
  const stale = await readCache();
  stale.entries['codex:ref-b'] = {
    agent: 'codex', ref: 'ref-b', group: cid(61), mtimeMs: 5, sizeBytes: 1, cwd: projectDir,
    summary: { ...summaryOf(items[1], 'vieja'), archived: false }, extra: {},
  };
  await writeFile(sessionIndexCachePath(), JSON.stringify(stale));
  const again = new SessionIndex(makeAgents());
  await again.start();
  check('D8 con una entrada vieja: termina', await waitFor(() => again.getStatus().state === 'ready'));
  check('D8 la entrada vieja de un null se borra de la cache', await waitFor(async () => !('codex:ref-b' in ((await readCache())?.entries ?? {}))));
  check('D8 y no aparece en la barra', !again.getProjects().flatMap((p) => p.sessions).some((s) => s.sessionId === cid(61)));

  let emitted = 0;
  again.on('projects', () => { emitted += 1; });
  await rm(sessionIndexCachePath(), { force: true });
  await again.refreshPath('codex', 'ref-b');
  check('D8 refreshPath de un null no lo agrega', !again.getProjects().flatMap((p) => p.sessions).some((s) => s.sessionId === cid(61)));
  check('D8 refreshPath de un null que no estaba: ni reemite la barra ni reescribe la cache',
    emitted === 0 && (await readCache()) === null, `${emitted} avisos`);
  await again.refreshPath('codex', 'ref-a');
  check('D8 refreshPath de una que se lista: reemite y guarda', emitted === 1 && 'codex:ref-a' in ((await readCache())?.entries ?? {}), `${emitted} avisos`);
  items[0] = { ...items[0], mtimeMs: 11 };
  scanners['ref-a'] = () => null;
  await again.refreshPath('codex', 'ref-a');
  check('D8 refreshPath de una que dejo de listarse: la saca, reemite y la borra de la cache',
    emitted === 2 && !again.getProjects().flatMap((p) => p.sessions).some((s) => s.sessionId === cid(60)) &&
    !('codex:ref-a' in ((await readCache())?.entries ?? {})), `${emitted} avisos`);

  const entry = (extra) => ({
    version: 4,
    entries: { 'codex:r': { agent: 'codex', ref: 'r', group: 'g', mtimeMs: 1, sizeBytes: 1, cwd: '/p', summary: { ...summaryOf(items[0], 't'), archived: false }, extra: {}, ...extra } },
  });
  check('D8 cache: una entrada sin resumeCwd sigue valiendo', 'codex:r' in (migrateIndexCache(entry({}))?.entries ?? {}));
  check('D8 cache: con resumeCwd string se conserva', migrateIndexCache(entry({ resumeCwd: '/q' }))?.entries['codex:r']?.resumeCwd === '/q');
  check('D8 cache: con resumeCwd que no es un string no vacio se descarta',
    !('codex:r' in (migrateIndexCache(entry({ resumeCwd: 5 }))?.entries ?? {})) &&
    !('codex:r' in (migrateIndexCache(entry({ resumeCwd: '' }))?.entries ?? {})));
}

// ---------------------------------------------------------------------------
// D. Lo que el hito 24 difirio, en el servidor (paso 4)
// ---------------------------------------------------------------------------

// D1. Donde cae una pestana nueva: junto a las de su proyecto, por clave normalizada.
{
  const { insertionIndex } = await import('../src/tab-order.ts');
  const tabs = {
    a: { kind: 'agent', cwd: 'D:\\Mi App' },
    b: { kind: 'agent', cwd: 'D:\\otra' },
    a2: { kind: 'agent', cwd: 'D:\\MI APP\\' },
    s: { kind: 'shell', cwd: 'D:\\Mi App' },
  };
  const describe = (id) => tabs[id];
  const agentAt = (cwd) => ({ kind: 'agent', cwd });
  check('D1 win32: d:/mi app/ cae despues de D:\\Mi App', insertionIndex(['a', 'b'], describe, agentAt('d:/mi app/'), 'win32') === 1);
  check('D1 despues de la ultima del proyecto, no de la primera',
    insertionIndex(['a', 'b', 'a2'], describe, agentAt('D:\\Mi App'), 'win32') === 3);
  check('D1 una consola va al final', insertionIndex(['a', 'b'], describe, { kind: 'shell', cwd: 'D:\\Mi App' }, 'win32') === 2);
  check('D1 una consola del mismo cwd no agrupa', insertionIndex(['s', 'b'], describe, agentAt('D:\\Mi App'), 'win32') === 2);
  check('D1 sin ninguna del proyecto: al final', insertionIndex(['a', 'b'], describe, agentAt('D:\\nueva'), 'win32') === 2);
  check('D1 un id que ya no esta se salta', insertionIndex(['fantasma', 'a'], describe, agentAt('D:\\Mi App'), 'win32') === 2);
  const linux = { x: { kind: 'agent', cwd: '/Home/u' }, y: { kind: 'agent', cwd: '/otro' } };
  check('D1 linux: /Home/u y /home/u son dos proyectos',
    insertionIndex(['x', 'y'], (id) => linux[id], agentAt('/home/u'), 'linux') === 2 &&
    insertionIndex(['x', 'y'], (id) => linux[id], agentAt('/Home/u/'), 'linux') === 1);
}

// D2. El libro de actividad.
{
  const { ActivityBook } = await import('../src/terminal-activity.ts');
  const book = new ActivityBook();
  book.set('t1', 'busy');
  book.set('t2', 'idle');
  book.set('t1', 'waiting');
  check('D2 el mismo id dos veces: una entrada, con el ultimo valor y en su lugar',
    same(book.snapshot(), [{ terminalId: 't1', activity: 'waiting' }, { terminalId: 't2', activity: 'idle' }]), show(book.snapshot()));
  book.snapshot().push({ terminalId: 'intruso', activity: 'busy' });
  check('D2 el snapshot es una copia', book.snapshot().length === 2);
  book.delete('t1');
  check('D2 delete', same(book.snapshot(), [{ terminalId: 't2', activity: 'idle' }]));
  book.clear();
  check('D2 clear', book.snapshot().length === 0);
}

const workspace = await import('../src/workspace-store.ts');
const T = (agent, sessionId, cwd = '/p') => ({ agent, cwd, sessionId, label: '' });
const orderedIds = (state) => workspace.orderedTabs(state).map((e) => (e.kind === 'known' ? e.tab.sessionId : `ajena:${e.raw.sessionId}`)).join(',');

// D3. Lo que se guarda: vivas, y las que no se muestran de vuelta en su lugar.
{
  const live = [T('claude-code', 'c1'), T('claude-code', 'c2')];
  const unavailable = [
    { position: 1, tab: T('codex', 'x1') },
    { position: 5, tab: T('codex', 'x9') },
    { position: 0, tab: T('claude-code', 'c1') },
  ];
  const foreign = [{ position: 2, raw: { agent: 'antigravity', cwd: '/p', sessionId: 'o1', futuro: { a: 1 } } }];
  const merged = workspace.mergePersistedTabs(live, unavailable, foreign);
  check('D3 las no disponibles y las ajenas vuelven a su lugar, sin repetir una viva',
    orderedIds(merged) === 'c1,x1,ajena:o1,c2,x9', orderedIds(merged));
  check('D3 tabs son las conocidas en orden', merged.tabs.map((t) => t.sessionId).join(',') === 'c1,x1,c2,x9');
  check('D3 la ajena conserva el objeto crudo y su posicion', same(merged.foreignTabs, [{ position: 2, raw: foreign[0].raw }]), show(merged.foreignTabs));
  const tie = workspace.mergePersistedTabs([T('claude-code', 'c1')], [{ position: 0, tab: T('codex', 'p') }, { position: 0, tab: T('codex', 'q') }], []);
  check('D3 dos con la misma posicion conservan su orden', orderedIds(tie) === 'p,q,c1', orderedIds(tie));
  check('D3 sin nada que conservar: las vivas tal cual',
    same(workspace.mergePersistedTabs(live, [], []), { tabs: live, foreignTabs: [] }));
  const file = workspace.serializeState(merged);
  check('D3 al archivo: tabs solo con claude-code', same(file.tabs, live), show(file.tabs));
  check('D3 al archivo: el resto en otherTabs con su posicion',
    same(file.otherTabs, [{ ...T('codex', 'x1'), position: 1 }, { ...foreign[0].raw, position: 2 }, { ...T('codex', 'x9'), position: 4 }]), show(file.otherTabs));
  check('D3 con claude-code sola el archivo no lleva otherTabs', same(Object.keys(workspace.serializeState({ tabs: live, foreignTabs: [] })), ['version', 'tabs']));
}

// D4. workspace.json: una pestana de otra CLI nunca la lee mal una build anterior (M1).
{
  const { WorkspaceStore } = workspace;
  const { workspaceStatePath } = await import('../src/paths.ts');
  const { readFile } = await import('node:fs/promises');
  const statePath = workspaceStatePath();
  check('D4 workspace.json cae en la carpeta temporal', statePath.startsWith(root), statePath);
  await mkdir(path.dirname(statePath), { recursive: true });

  /** Copia literal del parser de la version 1 anterior al hito 24: no mira `agent`. */
  function legacyParseState(raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      if (parsed['version'] !== 1) return null;
      const rawTabs = parsed['tabs'];
      if (!Array.isArray(rawTabs)) return null;
      const tabs = [];
      for (const entry of rawTabs) {
        if (typeof entry !== 'object' || entry === null) continue;
        const cwd = entry['cwd'];
        const sessionId = entry['sessionId'];
        const label = entry['label'];
        if (typeof cwd !== 'string' || typeof sessionId !== 'string') continue;
        tabs.push({ cwd, sessionId, label: typeof label === 'string' ? label : '' });
      }
      return { tabs };
    } catch {
      return null;
    }
  }

  const store = new WorkspaceStore();
  // Una CLI que esta build no conoce: desde el hito 26, OpenCode ya no sirve de ejemplo.
  const ajena = { agent: 'antigravity', cwd: 'D:\\b', sessionId: 'sb', label: '', futuro: { x: 1 } };
  await writeFile(statePath, JSON.stringify({ version: 1, tabs: [{ agent: 'claude-code', cwd: 'D:\\a', sessionId: 'sa' }, ajena] }));
  let loaded;
  const warnings = await captureWarnings(async () => { loaded = await store.load(); });
  check('D4 un v1 con una pestana de una CLI desconocida: no se restaura', same(loaded.tabs, [T('claude-code', 'sa', 'D:\\a')]), show(loaded.tabs));
  check('D4 se conserva el objeto crudo, con su lugar', same(loaded.foreignTabs, [{ position: 1, raw: ajena }]), show(loaded.foreignTabs));
  check('D4 y se avisa', warnings.length === 1 && warnings[0].includes('D:\\b'), warnings.join(' | '));

  store.save(loaded);
  await store.flush();
  const writtenForeign = JSON.parse(await readFile(statePath, 'utf8'));
  check('D4 al guardar, la ajena sigue en el archivo, fuera de tabs',
    same(writtenForeign.tabs, [T('claude-code', 'sa', 'D:\\a')]) && same(writtenForeign.otherTabs, [{ ...ajena, position: 1 }]), show(writtenForeign));
  await captureWarnings(async () => { loaded = await store.load(); });
  check('D4 ida y vuelta con la ajena', same(loaded.foreignTabs, [{ position: 1, raw: ajena }]) && loaded.tabs.length === 1);

  const codexId = cid(70);
  const withCodex = { tabs: [T('claude-code', 'sa', 'D:\\a'), T('codex', codexId, 'D:\\c'), T('claude-code', 'sc', 'D:\\a')], foreignTabs: [] };
  store.save(withCodex);
  await store.flush();
  const raw = await readFile(statePath, 'utf8');
  const legacy = legacyParseState(raw);
  check('D4 el parser anterior no ve ninguna pestana con el id de la de Codex',
    legacy !== null && legacy.tabs.length === 2 && !legacy.tabs.some((tab) => tab.sessionId === codexId), show(legacy));
  check('D4 y ve las de claude-code en orden', legacy?.tabs.map((t) => t.sessionId).join(',') === 'sa,sc');
  const again = await store.load();
  check('D4 esta build la restaura en su lugar', orderedIds(again) === `sa,${codexId},sc`, orderedIds(again));
  check('D4 como pestana de codex', again.tabs[1]?.agent === 'codex');

  await writeFile(statePath, JSON.stringify({
    version: 1,
    tabs: [T('claude-code', 'k1'), { agent: 'codex', cwd: '/p', sessionId: 'viejo-formato', label: '' }],
    otherTabs: [
      'no es un objeto',
      { agent: 'codex', cwd: '/p', sessionId: 'sin-posicion', label: '' },
      { cwd: '/p', sessionId: 'sin-cli', label: '', position: 0 },
      { agent: 'codex', cwd: 5, sessionId: 'mal', position: 0 },
      { agent: 'codex', cwd: '/p', sessionId: 'primera', label: 'l', position: 0 },
    ],
  }));
  const messy = await store.load();
  check('D4 otherTabs: sin posicion al final, sin CLI o sin cwd se descarta, codex en tabs se acepta',
    orderedIds(messy) === 'primera,k1,viejo-formato,sin-posicion', orderedIds(messy));
}

// D5. archived-sessions sigue con el id solo: uuid v7, v4 y v5 no chocan (C23).
{
  const { ArchivedSessions } = await import('../src/archived-sessions.ts');
  const v7 = cid(71);
  const v4 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const v5 = 'aaaaaaaa-bbbb-5ccc-8ddd-eeeeeeeeeeee';
  const archived = new ArchivedSessions();
  await archived.load();
  check('D5 archivar los tres', archived.set([v7, v4, v5], true) === true);
  await archived.flush();
  const reloaded = new ArchivedSessions();
  await reloaded.load();
  check('D5 ida y vuelta: los tres presentes', reloaded.has(v7) && reloaded.has(v4) && reloaded.has(v5), show(reloaded.snapshot()));
}

// D6 y D7. El hub: una pestana que gana su sesion despues de lanzar.
{
  const { EventEmitter } = await import('node:events');
  const { ConversationHub } = await import('../src/conversation-hub.ts');

  const followers = [];
  const makeFollower = (sessionId) => {
    const follower = {
      sessionId, polls: 0, started: 0, label: `seguidor-${sessionId || 'vacio'}`,
      start: async () => { follower.started += 1; },
      poll: async () => { follower.polls += 1; return { reset: false, added: [], turns: [], plans: [], parts: [] }; },
      getState: () => (sessionId === '' ? 'waiting' : 'live'),
      getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }),
      getPermissionMode: () => null,
      getTail: () => ({ events: sessionId === '' ? [] : [{ eventId: 'line-1', role: 'user', parts: [] }], hasMore: false }),
      getPageBefore: () => ({ events: [], hasMore: false }),
      getPlanFiles: () => [],
      readImage: async () => null,
      noticeChange: () => true,
      hasOpenToolCall: (launchedAt) => sessionId !== '' && launchedAt < 100,
    };
    followers.push(follower);
    return follower;
  };
  const statusCalls = [];
  const makeAdapter = (id, sessionIdAtLaunch) => ({
    id,
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch },
    status: {
      subscribe: (sessionId) => { statusCalls.push(`+${sessionId}`); return () => statusCalls.push(`-${sessionId}`); },
    },
    history: { follow: ({ sessionId }) => makeFollower(sessionId), plans: null },
  });
  const adapters = { codex: makeAdapter('codex', false), 'fija-el-id': makeAdapter('fija-el-id', true) };
  const fakeAgents = { get: (id) => (adapters[id] === undefined ? null : { adapter: adapters[id], location: null }) };
  const descriptors = new Map();
  const registry = new EventEmitter();
  registry.get = (terminalId) => descriptors.get(terminalId) ?? null;
  // Sin pty viva: el aviso de llamada abierta lo prueba W7 aparte.
  registry.launchedAtOf = () => null;
  const describe = (terminalId, agent, sessionId) => ({
    terminalId, kind: 'agent', agent, cwd: CWD, sessionId, label: '', resumed: false,
    createdAt: 0, alive: true, exitCode: null, sleeping: false,
  });

  const hub = new ConversationHub(registry, fakeAgents);
  const resets = [];
  hub.on('reset', (terminalId) => resets.push(terminalId));

  descriptors.set('t-sin-id', describe('t-sin-id', 'fija-el-id', ''));
  const unavailable = await hub.subscribe('t-sin-id');
  check('D7 sin sesion, de una CLI que fija el id al lanzar: unavailable', unavailable?.state === 'unavailable');
  check('D7 y no se crea entrada ni seguidor', hub.getSnapshot('t-sin-id') === null && followers.length === 0);

  descriptors.set('t', describe('t', 'codex', ''));
  const waiting = await hub.subscribe('t');
  await hub.subscribe('t');
  check('D6 sin sesion, de una CLI que la descubre: waiting con sessionId vacio',
    waiting?.state === 'waiting' && waiting.sessionId === '' && hub.getSnapshot('t')?.sessionId === '', show(waiting));
  check('D6 se sigue con un seguidor de sesion vacia', followers.length === 1 && followers[0].sessionId === '' && followers[0].started === 1);
  check('D6 sin sesion no se mira el estado del proceso', statusCalls.length === 0, show(statusCalls));
  check('D6 hasOpenToolCall sin sesion: lo que diga el seguidor', hub.hasOpenToolCall('t', 0) === false);

  descriptors.set('t', describe('t', 'codex', 'S1'));
  registry.emit('session', 't', 'S1');
  check('D6 cambia la sesion: el hub avisa reset una vez', await waitFor(() => resets.length === 1) && same(resets, ['t']), show(resets));
  const oldFollower = followers[0];
  const newFollower = followers[1];
  check('D6 el snapshot ya es de la sesion nueva', hub.getSnapshot('t')?.sessionId === 'S1' && hub.getSnapshot('t')?.state === 'live');
  check('D6 el seguidor nuevo arranco y leyo', newFollower?.sessionId === 'S1' && newFollower.started === 1 && newFollower.polls >= 1);
  check('D6 y ahora si se mira el estado, con el id nuevo', same(statusCalls, ['+S1']), show(statusCalls));

  const oldPolls = oldFollower.polls;
  const newPolls = newFollower.polls;
  hub.onHistoryChanged('codex', path.join(sessionsRoot, 'x.jsonl'));
  check('D6 un aviso del historial lo lee el seguidor nuevo', await waitFor(() => newFollower.polls > newPolls));
  check('D6 el viejo no se vuelve a sondear', oldFollower.polls === oldPolls, `${oldFollower.polls} vs ${oldPolls}`);

  check('D6 hasOpenToolCall pregunta al seguidor nuevo con el lanzamiento',
    hub.hasOpenToolCall('t', 50) === true && hub.hasOpenToolCall('t', 500) === false && hub.hasOpenToolCall('no-existe', 50) === false);

  registry.emit('session', 't', 'S1');
  await hub.subscribe('t');
  hub.unsubscribe('t');
  check('D6 el mismo id otra vez no rehace nada', followers.length === 2 && resets.length === 1);

  descriptors.set('t', describe('t', 'codex', 'S2'));
  registry.emit('session', 't', 'S2');
  check('D6 otro cambio: suelta el estado del anterior', await waitFor(() => resets.length === 2) && same(statusCalls, ['+S1', '-S1', '+S2']), show(statusCalls));

  hub.unsubscribe('t');
  check('D6 los que miraban se conservaron: con uno menos sigue', hub.getSnapshot('t') !== null);
  hub.unsubscribe('t');
  check('D6 y con el ultimo se apaga', hub.getSnapshot('t') === null);

  descriptors.set('nadie', describe('nadie', 'codex', ''));
  registry.emit('session', 'nadie', 'S9');
  check('D6 un cambio en una pestana que nadie sigue no crea nada', followers.length === 3 && resets.length === 2);
  hub.disposeAll();
}

// D10. La relectura periodica: una CLI que escribe con el archivo abierto no le da
// avisos al watcher en Windows (medido con Codex en la verificacion de cierre).
{
  const { EventEmitter } = await import('node:events');
  const { ConversationHub } = await import('../src/conversation-hub.ts');
  const followers = [];
  const makeFollower = (sessionId) => {
    const follower = {
      sessionId, polls: 0, label: `seguidor-${sessionId || 'vacio'}`,
      start: async () => undefined,
      poll: async () => { follower.polls += 1; return { reset: false, added: [], turns: [], plans: [], parts: [] }; },
      getState: () => 'live',
      getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }),
      getPermissionMode: () => null,
      getTail: () => ({ events: [], hasMore: false }),
      getPageBefore: () => ({ events: [], hasMore: false }),
      getPlanFiles: () => [],
      readImage: async () => null,
      noticeChange: () => false,
      hasOpenToolCall: () => false,
    };
    followers.push(follower);
    return follower;
  };
  const makeAdapter = (id, followPollMs) => ({
    id,
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: false },
    status: null,
    history: { follow: ({ sessionId }) => makeFollower(sessionId), plans: null, followPollMs },
  });
  const adapters = { lenta: makeAdapter('lenta', 40), avisada: makeAdapter('avisada', null) };
  const descriptors = new Map();
  const registry = new EventEmitter();
  registry.get = (terminalId) => descriptors.get(terminalId) ?? null;
  registry.launchedAtOf = () => null;
  const describe = (terminalId, agent, sessionId) => ({
    terminalId, kind: 'agent', agent, cwd: CWD, sessionId, label: '', resumed: false,
    createdAt: 0, alive: true, exitCode: null, sleeping: false,
  });
  const hub = new ConversationHub(registry, { get: (id) => ({ adapter: adapters[id], location: null }) });

  descriptors.set('a', describe('a', 'avisada', 'S1'));
  descriptors.set('l', describe('l', 'lenta', ''));
  await hub.subscribe('a');
  await hub.subscribe('l');
  const [avisada, lenta] = followers;
  const baseA = avisada.polls;
  check('D10 con followPollMs, el hub relee sin ningun aviso del watcher', await waitFor(() => lenta.polls >= 3, 3000), String(lenta.polls));
  check('D10 con followPollMs null (Claude Code), solo lee con avisos', avisada.polls === baseA, `${avisada.polls} vs ${baseA}`);

  descriptors.set('l', describe('l', 'lenta', 'S2'));
  registry.emit('session', 'l', 'S2');
  const nueva = await waitFor(() => followers.length === 3) ? followers[2] : null;
  const viejoAntes = lenta.polls;
  check('D10 tras cambiar de sesion relee el seguidor nuevo', nueva !== null && await waitFor(() => nueva.polls >= 3, 3000), String(nueva?.polls));
  check('D10 y el viejo ya no', lenta.polls <= viejoAntes + 1, `${lenta.polls} vs ${viejoAntes}`);

  hub.unsubscribe('l');
  await new Promise((resolve) => setTimeout(resolve, 250));
  const alSoltar = nueva.polls;
  await new Promise((resolve) => setTimeout(resolve, 300));
  check('D10 al soltar la pestana deja de releer', nueva.polls === alSoltar, `${nueva.polls} vs ${alSoltar}`);
  hub.disposeAll();

  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  check('D10 los adaptadores: Codex relee cada segundo, Claude Code no',
    createCodexHistory().followPollMs === 1000 && createClaudeCodeAdapter().history.followPollMs === null);
}

// D9. El gancho posterior al lanzamiento: a quien le toca cada momento.
{
  const { LaunchHookSlot } = await import('../src/launch-hook-slot.ts');
  const makeHook = (members = {}) => {
    const calls = [];
    const hook = { cancel: () => calls.push('cancel') };
    for (const name of members.with ?? []) hook[name] = (arg) => calls.push(arg === undefined ? name : `${name}:${arg}`);
    return { hook, calls };
  };

  const plain = makeHook();
  const slot = new LaunchHookSlot();
  slot.set(plain.hook);
  slot.submitted('hola');
  slot.input();
  slot.input();
  check('D9 sin onInput, escribir cancela una vez y lo suelta', same(plain.calls, ['cancel']) && !slot.active, show(plain.calls));

  const lasting = makeHook({ with: ['onInput', 'onSubmitted', 'onExit'] });
  slot.set(lasting.hook);
  slot.submitted('hola');
  slot.input();
  check('D9 con onInput, escribir no lo suelta', same(lasting.calls, ['onSubmitted:hola', 'onInput']) && slot.active, show(lasting.calls));
  slot.exit();
  slot.exit();
  check('D9 al salir el proceso: onExit y no cancel, una vez', same(lasting.calls, ['onSubmitted:hola', 'onInput', 'onExit']) && !slot.active, show(lasting.calls));

  const noExit = makeHook();
  slot.set(noExit.hook);
  slot.exit();
  check('D9 sin onExit, salir cancela', same(noExit.calls, ['cancel']));

  const closing = makeHook({ with: ['onExit'] });
  slot.set(closing.hook);
  slot.cancel();
  slot.submitted('tarde');
  check('D9 cerrar cancela sin pasada final, y despues no llega nada', same(closing.calls, ['cancel']), show(closing.calls));

  const first = makeHook();
  const second = makeHook();
  slot.set(first.hook);
  slot.set(second.hook);
  check('D9 un lanzamiento nuevo cancela el gancho que quedaba', same(first.calls, ['cancel']) && second.calls.length === 0 && slot.active);
  slot.forget(first.hook);
  check('D9 el aviso tardio de un gancho viejo no suelta al nuevo', slot.active);
  slot.forget(second.hook);
  check('D9 el propio termina solo: se olvida sin cancelar', !slot.active && second.calls.length === 0);
  const empty = makeHook();
  slot.set(empty.hook);
  slot.set(null);
  check('D9 relanzar sin gancho cancela el que quedaba', same(empty.calls, ['cancel']) && !slot.active);

  // Un cancel que vuelve a entrar en el acto, como el `onDone` del contestador de Claude Code.
  let reentrant = 0;
  const selfForget = { cancel: () => { reentrant += 1; if (reentrant < 5) slot.input(); } };
  slot.set(selfForget);
  slot.input();
  check('D9 un cancel que vuelve a entrar no cancela dos veces', reentrant === 1 && !slot.active, String(reentrant));

  // Con los ganchos de verdad.
  const discovery = new CodexSessionDiscovery({ pollMs: 2_000_000_000, sessionsRoot: () => null });
  const real = new LaunchHookSlot();
  real.set(discovery.register({ terminalId: 'tab', cwd: CWD, launchedAt: Date.now(), reportSessionId: () => undefined }));
  real.input();
  check('D9 el descubrimiento de Codex sigue esperando aunque se escriba', discovery.pendingCount() === 1 && real.active);
  real.cancel();
  check('D9 y cerrar la pestana lo suelta', discovery.pendingCount() === 0);
  discovery.dispose();

  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const claude = createClaudeCodeAdapter();
  let outcome = null;
  const claudeSlot = new LaunchHookSlot();
  claudeSlot.set(claude.onSpawned({
    terminalId: 't', sessionId: 's', cwd: CWD, resumed: true, pid: 1, launchedAt: Date.now(),
    readOutput: () => '', write: () => true, onDone: (value) => { outcome = value; }, reportSessionId: () => undefined,
  }));
  claudeSlot.input();
  check('D9 el contestador de Claude Code se abandona en cuanto alguien escribe', outcome === 'cancelled' && !claudeSlot.active, String(outcome));
  claude.dispose();
}

// ---------------------------------------------------------------------------
// E4. Una raiz de historial que todavia no existe (A3)
// ---------------------------------------------------------------------------

{
  const { watchSessions } = await import('../src/session-watcher.ts');
  const chokidar = (await import('chokidar')).default;
  const cliHome = path.join(root, 'e4-cli');
  const lateRoot = path.join(cliHome, 'sessions');
  await mkdir(cliHome, { recursive: true });
  const same4 = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  const watched = [];
  let ready = 0;
  const factory = (target, options) => {
    watched.push(target);
    const watcher = chokidar.watch(target, options);
    watcher.on('ready', () => { ready += 1; });
    return watcher;
  };
  const notices = [];
  const refreshed = [];
  const hub = { onHistoryChanged: (agent, filePath) => notices.push([agent, filePath]) };
  const index = { refreshPath: async (agent, filePath) => { refreshed.push([agent, filePath]); } };
  let probes = 0;
  const lateDef = {
    get path() { probes += 1; return lateRoot; },
    depth: 3,
    accepts: (filePath) => filePath.endsWith('.jsonl'),
    awaitWriteFinish: false,
  };
  const agents = { all: () => [{ adapter: { id: 'codex', history: { roots: () => [lateDef] } }, location: null }] };

  const stop = watchSessions(index, hub, agents, { rootProbeMs: 40, watch: factory });
  check('E4 mientras no existe se la mira con stat', await waitFor(() => probes >= 4));
  check('E4 y no se vigila nada: ni la raiz ni su padre', watched.length === 0, show(watched));

  const dayFolder = path.join(lateRoot, '2026', '05', '05');
  await mkdir(dayFolder, { recursive: true });
  const firstFile = path.join(dayFolder, rolloutName(BASE, cid(80)));
  await writeFile(firstFile, sessionMeta({ id: cid(80) }));
  check('E4 cuando aparece se vigila esa ruta exacta', await waitFor(() => watched.length === 1) && watched[0] === lateRoot, show(watched));
  check('E4 lo que ya traia le llega al hub', await waitFor(() => notices.some(([agent, p]) => agent === 'codex' && same4(p, firstFile))), show(notices));
  check('E4 y al indice', await waitFor(() => refreshed.some(([agent, p]) => agent === 'codex' && same4(p, firstFile))), show(refreshed));
  const probesAfter = probes;
  const before = notices.length;
  await appendFile(firstFile, userPair(BASE + 1, 'hola'));
  check('E4 despues, los cambios llegan por el watcher', await waitFor(() => notices.length > before), show(notices.length));
  // Ausencia: con el sondeo a 40 ms, en 300 ms habria siete pasadas mas.
  check('E4 y se deja de sondear', !(await waitFor(() => probes > probesAfter, 300)), `${probes} vs ${probesAfter}`);
  stop();

  // Una raiz que ya existe al arrancar: lo de antes no se avisa, lo nuevo si.
  const presentRoot = path.join(root, 'e4-presente');
  const oldFile = path.join(presentRoot, rolloutName(BASE, cid(81)));
  await mkdir(presentRoot, { recursive: true });
  await writeFile(oldFile, sessionMeta({ id: cid(81) }));
  notices.length = 0;
  watched.length = 0;
  ready = 0;
  const presentDef = { path: presentRoot, depth: 0, accepts: (filePath) => filePath.endsWith('.jsonl'), awaitWriteFinish: false };
  const stopPresent = watchSessions(index, hub, { all: () => [{ adapter: { id: 'codex', history: { roots: () => [presentDef] } }, location: null }] }, { rootProbeMs: 40, watch: factory });
  check('E4 una raiz existente se vigila de entrada', await waitFor(() => ready === 1) && same(watched, [presentRoot]), show(watched));
  const newFile = path.join(presentRoot, rolloutName(BASE, cid(82)));
  await writeFile(newFile, sessionMeta({ id: cid(82) }));
  check('E4 un archivo nuevo avisa', await waitFor(() => notices.some(([, p]) => same4(p, newFile))), show(notices));
  check('E4 el que ya estaba al arrancar no', !notices.some(([, p]) => same4(p, oldFile)), show(notices));
  stopPresent();
}

// ---------------------------------------------------------------------------
// E. Codex registrado (paso 5)
// ---------------------------------------------------------------------------

const { createCodexAdapter, CODEX_INSTALL_URL } = await import('../src/agents/codex/index.ts');
const { AgentRegistry, createAgentRegistry } = await import('../src/agents/registry.ts');
const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
const { summarizeAgents } = await import('../../web/src/agent-summary.ts');

const throwsOn = (run) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

// E1. El adaptador, miembro por miembro.
{
  const adapter = createCodexAdapter();
  check('E1 id, etiqueta, comando y guia de instalacion',
    adapter.id === 'codex' && adapter.label === 'Codex' && adapter.command === 'codex' &&
    adapter.installUrl === CODEX_INSTALL_URL && /^https:\/\//.test(CODEX_INSTALL_URL));
  check('E1 capacidades: exactamente las medidas', same(adapter.capabilities, {
    sessionIdAtLaunch: false,
    resume: true,
    statusSource: false,
    readySignal: false,
    permissionCycle: null,
    models: null,
    efforts: null,
    questionCards: false,
    imagesByPath: 'bare-path-paste',
    fileMentions: null,
    rewind: false,
    contextWindowSource: 'token-count',
    plans: false,
  }), show(adapter.capabilities));
  check('E1 envio: imagenes por ruta sola, 400 ms entre piezas, con marcadores',
    same(adapter.input, { imageReference: 'bare-path-paste', pieceGapMs: 400, pasteMarkers: true, enterSeparately: true, interruptPresses: 1 }),
    show(adapter.input));
  check('E1 lo que se escribe coincide con lo que se le promete a la interfaz',
    adapter.input.imageReference === adapter.capabilities.imagesByPath);
  const missing = adapter.missingMessage();
  check('E1 el texto de ausencia nombra el comando y la guia', missing.includes('"codex"') && missing.includes(CODEX_INSTALL_URL), missing);

  const id = cid(90);
  const plain = { resolvedPath: '/bin/codex', file: '/bin/codex', prefixArgs: [], version: 'codex-cli 0.154.0' };
  const shim = { resolvedPath: 'x.cmd', file: 'cmd.exe', prefixArgs: ['/c', 'x.cmd'], version: null };
  const fresh = adapter.launch({ location: plain, cwd: CWD, resumeSessionId: null, proposedSessionId: cid(91) });
  check('E1 sesion nueva: sin argumentos, el id se descubre y el propuesto no se usa',
    fresh.file === '/bin/codex' && same(fresh.args, []) && same(fresh.session, { kind: 'discover' }), show(fresh));
  const resumed = adapter.launch({ location: plain, cwd: CWD, resumeSessionId: id, proposedSessionId: cid(91) });
  check('E1 reanudar: resume <id> y la sesion es conocida',
    same(resumed.args, ['resume', id]) && same(resumed.session, { kind: 'known', sessionId: id }), show(resumed));
  const viaShim = adapter.launch({ location: shim, cwd: CWD, resumeSessionId: id, proposedSessionId: '' });
  const freshShim = adapter.launch({ location: shim, cwd: CWD, resumeSessionId: null, proposedSessionId: '' });
  check('E1 con el shim, los argumentos del interprete van primero',
    viaShim.file === 'cmd.exe' && same(viaShim.args, ['/c', 'x.cmd', 'resume', id]) && same(freshShim.args, ['/c', 'x.cmd']),
    show([viaShim.args, freshShim.args]));
  check('E1 un id con espacio, comilla o que no es uuid no llega a la linea de comando',
    throwsOn(() => adapter.launch({ location: shim, cwd: CWD, resumeSessionId: `${id} x`, proposedSessionId: '' })) &&
    throwsOn(() => adapter.launch({ location: shim, cwd: CWD, resumeSessionId: `"${id}"`, proposedSessionId: '' })) &&
    throwsOn(() => adapter.launch({ location: shim, cwd: CWD, resumeSessionId: 'a&calc', proposedSessionId: '' })));

  const base = { PATH: 'p', CLAUDE_CODE_CHILD_SESSION: '1', CODEX_HOME: 'x', VACIA: undefined };
  const environment = adapter.environment(base);
  check('E1 entorno: no quita nada, no agrega nada, sin aviso',
    same(environment.env, { PATH: 'p', CLAUDE_CODE_CHILD_SESSION: '1', CODEX_HOME: 'x' }) && environment.notice === null,
    show(environment));
  // `same` compara JSON, que se come las claves con undefined: esta va aparte.
  check('E1 entorno: un valor undefined no pasa', !('VACIA' in environment.env), Object.keys(environment.env).join(','));

  const context = (over) => ({
    terminalId: 'tab-e1', sessionId: '', cwd: CWD, resumed: false, pid: 1, launchedAt: Date.now(),
    readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: () => undefined, ...over,
  });
  const liveHook = adapter.onSpawned(context({ resumed: true, sessionId: id }));
  check('E1 reanudando: un gancho que solo anota la pestana viva (M4), sin descubrir ni recibir textos',
    liveHook !== null && typeof liveHook.cancel === 'function' && typeof liveHook.onInput === 'function' &&
    typeof liveHook.onExit === 'function' && liveHook.onSubmitted === undefined);
  liveHook?.cancel();

  // Una pestana nueva queda esperando su sesion, y el gancho la encuentra con el sondeo real.
  const e1Cwd = win ? 'D:\\Mi App E1' : '/home/u/mi-app-e1';
  const launchedAt = Date.now();
  const reported = [];
  const hook = adapter.onSpawned(context({ cwd: e1Cwd, launchedAt, reportSessionId: (sessionId) => reported.push(sessionId) }));
  check('E1 sesion nueva: gancho que sobrevive a lo que se escribe y mira al salir',
    hook !== null && typeof hook.cancel === 'function' && typeof hook.onInput === 'function' &&
    typeof hook.onExit === 'function' && typeof hook.onSubmitted === 'function');
  hook?.onSubmitted?.('mensaje de e1');
  const e1Id = cid(92);
  await writeRollout(sessionsRoot, e1Id,
    sessionMeta({ id: e1Id, createdAt: launchedAt + 300, cwd: e1Cwd }) + userPair(launchedAt + 400, 'mensaje de e1'), Date.now());
  check('E1 el descubrimiento del adaptador casa la sesion con la pestana, con su cwd y su hora',
    await waitFor(() => reported.length > 0) && same(reported, [e1Id]), show(reported));
  hook?.cancel();

  check('E1 sin configuracion que leer', (await adapter.defaults(CWD)) === null);
  check('E1 no publica su estado', adapter.status === null);
  check('E1 el historial lee el CODEX_HOME temporal', adapter.history.roots()[0]?.path === sessionsRoot, show(adapter.history.roots()));
  const dirs = adapter.protectedDirs();
  check('E1 protege el CODEX_HOME y la carpeta de siempre del home',
    same([...dirs].sort(), [codexHome, path.join(home, '.codex')].sort()), show(dirs));
  const savedHome = process.env['CODEX_HOME'];
  let relativeDirs = [];
  const warnings = await captureWarnings(() => {
    process.env['CODEX_HOME'] = 'codex-relativo-e1';
    relativeDirs = adapter.protectedDirs();
  });
  process.env['CODEX_HOME'] = savedHome;
  check('E1 con un CODEX_HOME relativo protege la del home y avisa',
    same(relativeDirs, [path.join(home, '.codex')]) && warnings.some((w) => w.includes('codex-relativo-e1')), show([relativeDirs, warnings]));
  adapter.dispose();
}

// E1. En el registro de la app.
{
  const registry = createAgentRegistry();
  check('E1 el registro de la app trae claude-code y despues codex (y opencode al final, desde el hito 26)',
    same(registry.all().map(({ adapter }) => adapter.id), ['claude-code', 'codex', 'opencode']));
  check('E1 sin ninguna instalada, ninguna por defecto', registry.defaultAgent() === null);
  const codexInfo = registry.list().find((info) => info.id === 'codex');
  check('E1 hello: codex ausente con su texto y sus capacidades',
    codexInfo !== undefined && codexInfo.available === false && codexInfo.missingMessage?.includes(CODEX_INSTALL_URL) === true &&
    same(codexInfo.capabilities, registry.adapter('codex').capabilities), show(codexInfo));
  const parsedInfo = shared.parseAgentInfo(JSON.parse(JSON.stringify(codexInfo)));
  check('E1 hello: el cliente la lee entera', parsedInfo !== null && same(parsedInfo.capabilities, codexInfo.capabilities), show(parsedInfo));

  registry.get('codex').location = { resolvedPath: '/bin/codex', file: '/bin/codex', prefixArgs: [], version: 'codex-cli 0.154.0' };
  check('E1 con codex sola, codex es la de por defecto', registry.defaultAgent() === 'codex');
  registry.get('claude-code').location = { resolvedPath: '/bin/claude', file: '/bin/claude', prefixArgs: [], version: '2.1.270' };
  check('E1 con las dos, sigue siendo claude-code', registry.defaultAgent() === 'claude-code');
  const protectedDirs = registry.protectedDirs();
  check('E1 el selector protege las carpetas de las dos',
    protectedDirs.includes(path.join(home, '.claude')) && protectedDirs.includes(codexHome), show(protectedDirs));

  // E3. El entorno compuesto (C22).
  const composed = registry.composedEnvironment({ CLAUDE_CODE_CHILD_SESSION: '1', CODEX_HOME: 'x', PATH: 'p', VACIA: undefined });
  check('E3 entorno compuesto: sin el marcador, con CODEX_HOME, sin nada nuevo',
    same(composed, { CODEX_HOME: 'x', PATH: 'p' }), show(composed));
  registry.disposeAll();
}

// A6. El arranque y el cartel cuentan CLIs disponibles.
{
  const { startupAgentLines, AVAILABLE_AGENTS_LABEL } = await import('../src/startup-summary.ts');
  const claude = (over = {}) => ({ id: 'claude-code', label: 'Claude Code', version: '2.1.270', resolvedPath: '/bin/claude', missingMessage: null, ...over });
  const codex = (over = {}) => ({ id: 'codex', label: 'Codex', version: 'codex-cli 0.154.0', resolvedPath: '/bin/codex', missingMessage: null, ...over });
  const claudeMissing = claude({ version: null, resolvedPath: null, missingMessage: 'falta claude' });
  const codexMissing = codex({ version: null, resolvedPath: null, missingMessage: 'falta codex' });

  const legacyAvailable = ['  CLI          2.1.270', '  Binario      /bin/claude'];
  check('A6 claude-code sola: las lineas de siempre y la de disponibles',
    same(startupAgentLines([claude()]), ['  CLIs disponibles  claude-code', ...legacyAvailable]), show(startupAgentLines([claude()])));
  const withoutCodex = startupAgentLines([claude(), codexMissing]);
  check('A6 claude-code instalada y codex no: identico a claude-code sola, sin nombrar codex',
    same(withoutCodex, startupAgentLines([claude()])) && !withoutCodex.join('\n').toLowerCase().includes('codex'), show(withoutCodex));
  check('A6 codex sola: sus lineas sin etiqueta',
    same(startupAgentLines([claudeMissing, codex()]), ['  CLIs disponibles  codex', '  CLI          codex-cli 0.154.0', '  Binario      /bin/codex']),
    show(startupAgentLines([claudeMissing, codex()])));
  check('A6 las dos: una linea por cada una, con su nombre',
    same(startupAgentLines([claude(), codex({ version: null })]), [
      '  CLIs disponibles  claude-code, codex',
      '  CLI (Claude Code)  2.1.270', '  Binario      /bin/claude',
      '  CLI (Codex)  version desconocida', '  Binario      /bin/codex',
    ]), show(startupAgentLines([claude(), codex({ version: null })])));
  check('A6 ninguna: el texto de la primera y las demas por nombre',
    same(startupAgentLines([claudeMissing, codexMissing]), [
      '  CLIs disponibles  ninguna', '  CLI          NO ENCONTRADA', '', '  falta claude', '  Tambien funciona con: Codex',
    ]), show(startupAgentLines([claudeMissing, codexMissing])));
  check('A6 ninguna con una sola registrada: lo de siempre, sin "tambien"',
    same(startupAgentLines([claudeMissing]), ['  CLIs disponibles  ninguna', '  CLI          NO ENCONTRADA', '', '  falta claude']),
    show(startupAgentLines([claudeMissing])));
  check('A6 la linea de disponibles empieza con su rotulo', startupAgentLines([claude()])[0].trim().startsWith(AVAILABLE_AGENTS_LABEL));

  // El cartel de la web, con el hello del registro real.
  const registry = createAgentRegistry();
  const claudeText = registry.adapter('claude-code').missingMessage();
  const none = summarizeAgents(registry.list(), true);
  check('A6 cartel sin ninguna: el de claude-code de siempre y "tambien funciona con: Codex, OpenCode"',
    none.cliAvailable === false && none.cliMissingMessage === `${claudeText}\nTambien funciona con: Codex, OpenCode`, show(none));
  registry.get('claude-code').location = { resolvedPath: '/bin/claude', file: '/bin/claude', prefixArgs: [], version: '2.1.270' };
  const onlyClaude = summarizeAgents(registry.list(), true);
  const alone = new AgentRegistry([createClaudeCodeAdapter()]);
  alone.get('claude-code').location = { resolvedPath: '/bin/claude', file: '/bin/claude', prefixArgs: [], version: '2.1.270' };
  const aloneSummary = summarizeAgents(alone.list(), true);
  check('A6 con claude-code instalada y codex no, la cabecera y el cartel son los de claude-code sola',
    same(onlyClaude, aloneSummary) && onlyClaude.cliVersion === '2.1.270' && onlyClaude.cliMissingMessage === null, show([onlyClaude, aloneSummary]));
  check('A6 con claude-code instalada y codex no, no se ofrece elegir CLI', shared.shouldOfferAgentChoice(registry.list()) === false);
  registry.disposeAll();
  alone.disposeAll();
}

// M7. La demo no ve ninguna CLI de verdad.
{
  const demo = await import('../../../scripts/demo/isolation.mjs');
  const { startupAgentLines } = await import('../src/startup-summary.ts');
  const delimiter = win ? ';' : ':';
  const pathext = '.EXE;.CMD';
  const options = { platform: process.platform, pathext };
  const m7 = path.join(root, 'm7');
  const tool = async (dir, name) => {
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, win ? `${name}.cmd` : name);
    await writeFile(file, win ? '@echo off\r\n' : '#!/bin/sh\n');
    if (!win) {
      const { chmod } = await import('node:fs/promises');
      await chmod(file, 0o755);
    }
    return file;
  };
  const bin = path.join(m7, 'bin');
  const nodeDir = path.join(m7, 'nodejs');
  const gitDir = path.join(m7, 'git con espacio');
  const realClaudeDir = path.join(m7, 'local-bin');
  const agyDir = path.join(m7, 'agy');
  const emptyDir = path.join(m7, 'vacia');
  await tool(bin, 'claude');
  await tool(nodeDir, 'codex');
  await tool(nodeDir, 'node');
  await tool(gitDir, 'git');
  await tool(realClaudeDir, 'claude');
  await tool(agyDir, 'agy');
  await mkdir(emptyDir, { recursive: true });
  if (win) await writeFile(path.join(emptyDir, 'codex'), 'sin extension');  // locate.ts no lo mira en Windows

  const original = [nodeDir, `"${gitDir}"`, realClaudeDir, agyDir, emptyDir, ''].join(delimiter);
  const filtered = demo.demoPath(bin, original, options);
  check('M7 PATH de la demo: la simulada primera y fuera toda carpeta con un comando de agente',
    filtered === [bin, gitDir, emptyDir].join(delimiter), filtered);
  check('M7 con ese PATH arranca', !throwsOn(() => demo.assertDemoPath(bin, filtered, options)));
  const rejection = (pathValue) => {
    try {
      demo.assertDemoPath(bin, pathValue, options);
      return '';
    } catch (error) {
      return error.message;
    }
  };
  check('M7 si ve codex no arranca, y dice donde', /encontro codex en/.test(rejection([bin, nodeDir, gitDir].join(delimiter))),
    rejection([bin, nodeDir, gitDir].join(delimiter)));
  check('M7 si ve agy no arranca', /encontro agy/.test(rejection([bin, agyDir, gitDir].join(delimiter))));
  check('M7 si claude resuelve fuera de la simulada no arranca', /simulada/.test(rejection([realClaudeDir, bin, gitDir].join(delimiter))));
  check('M7 sin git no arranca', /git/.test(rejection([bin, emptyDir].join(delimiter))));

  const base = {
    [win ? 'Path' : 'PATH']: original, PATHEXT: pathext, HOME: 'real', USERPROFILE: 'real', CODEX_HOME: 'real-codex',
    CLAUDE_CODE_CHILD_SESSION: '1', OPENCODE_DB: 'db', CODEX_SQLITE_HOME: 'sq', OTRA: 'se queda',
  };
  const demoHome = path.join(m7, 'home');
  const env = demo.demoEnvironment(base, { home: demoHome, bin, mainCwd: 'W:\\Proyectos\\x' });
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH');
  check('M7 entorno: un solo PATH, el filtrado', same(pathKeys, ['PATH']) && env['PATH'] === filtered, show(pathKeys));
  check('M7 entorno: home, configuracion y CODEX_HOME de la demo',
    env['HOME'] === demoHome && env['USERPROFILE'] === demoHome && env['CODEX_HOME'] === path.join(demoHome, '.codex') &&
    env['APPDATA'] === path.join(demoHome, 'AppData', 'Roaming') && env['LOCALAPPDATA'] === path.join(demoHome, 'AppData', 'Local') &&
    env['XDG_CONFIG_HOME'] === path.join(demoHome, '.config') && env['XDG_DATA_HOME'] === path.join(demoHome, '.local', 'share') &&
    env['AGENT_WORKBENCH_CWD'] === 'W:\\Proyectos\\x', show(env));
  check('M7 entorno: sin el marcador ni las bases de otras CLIs, y lo demas intacto',
    !('CLAUDE_CODE_CHILD_SESSION' in env) && !('OPENCODE_DB' in env) && !('CODEX_SQLITE_HOME' in env) && env['OTRA'] === 'se queda');

  const startup = ['  URL          http://127.0.0.1:1/?token=x', ...startupAgentLines([
    { id: 'claude-code', label: 'Claude Code', version: '2.1.263', resolvedPath: bin, missingMessage: null },
    { id: 'codex', label: 'Codex', version: 'codex-cli 0.154.0', resolvedPath: nodeDir, missingMessage: null },
  ])].join('\n');
  check('M7 la demo lee la linea de disponibles que imprime el servidor', same(demo.availableAgentsFromStartup(startup), ['claude-code', 'codex']));
  check('M7 sin la linea todavia: null', demo.availableAgentsFromStartup('  URL          http://127.0.0.1:1/') === null);
  check('M7 ninguna: lista vacia', same(demo.availableAgentsFromStartup('  CLIs disponibles  ninguna\n'), []));
  check('M7 las capturas solo con la simulada',
    !throwsOn(() => demo.assertOnlySimulatedAgent(['claude-code'])) &&
    throwsOn(() => demo.assertOnlySimulatedAgent(['claude-code', 'codex'])) &&
    throwsOn(() => demo.assertOnlySimulatedAgent(['codex'])) && throwsOn(() => demo.assertOnlySimulatedAgent([])));

  const { createRequire } = await import('node:module');
  const { fileURLToPath } = await import('node:url');
  const serverPackage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  let tsxCli = null;
  try {
    tsxCli = createRequire(serverPackage).resolve('tsx/cli');
  } catch {
    tsxCli = null;
  }
  check('M7 la demo encuentra el CLI de tsx desde el paquete del servidor', tsxCli !== null && /tsx/.test(tsxCli), String(tsxCli));
}

// ---------------------------------------------------------------------------
// W. La web con dos CLIs (paso 6): boton partido, menu, insignias, la vista
// que espera su sesion y la llamada abierta (A1). Todo lo que decide la web
// vive en modulos sin JSX, y eso es lo que se prueba.
// ---------------------------------------------------------------------------

const webUi = await import('../../web/src/agent-ui.ts');
const { CODEX_CAPABILITIES } = await import('../src/agents/codex/index.ts');
const agentInfo = (id, label, available, extra = {}) => ({
  id, label, command: id, available, version: available ? `${label} 1.0` : null, installUrl: 'https://example.com',
  missingMessage: available ? null : 'falta', capabilities: shared.NO_CAPABILITIES, environmentNotice: null, ...extra,
});
const bothAgents = [agentInfo('claude-code', 'Claude Code', true), agentInfo('codex', 'Codex', true)];
const onlyClaudeAgents = [agentInfo('claude-code', 'Claude Code', true), agentInfo('codex', 'Codex', false)];
const noAgents = [agentInfo('claude-code', 'Claude Code', false), agentInfo('codex', 'Codex', false)];
const tab = (agent, cwd, kind = 'agent') => ({ kind, agent, cwd });

// W1. Las tandas de herramientas conocen los nombres de Codex, sin tocar los de Claude Code.
{
  const { TOOL_CATEGORIES, toolCategory } = await import('../../web/src/tool-categories.ts');
  const before = {
    shell: ['Bash', 'PowerShell', 'BashOutput', 'KillShell'], read: ['Read', 'NotebookRead'], find: ['Glob', 'Grep', 'LS'],
    edit: ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'], web: ['WebSearch', 'WebFetch', 'ToolSearch'], agent: ['Task', 'Agent'],
    todo: ['TodoWrite'],
  };
  const codexNames = ['shell_command', 'apply_patch', 'update_plan'];
  // Los de OpenCode (hito 26) se prueban en check-opencode-db.mjs, caso 14.
  const openCodeNames = ['bash', 'read', 'grep', 'glob', 'list', 'edit', 'write', 'webfetch', 'websearch', 'codesearch', 'task', 'todowrite', 'todoread'];
  const kept = Object.fromEntries(TOOL_CATEGORIES.map((entry) => [
    entry.key, entry.names.filter((name) => !codexNames.includes(name) && !openCodeNames.includes(name)),
  ]));
  check('W1 las categorias de Claude Code siguen exactamente iguales', same(kept, before), show(kept));
  check('W1 shell_command es un comando de consola',
    toolCategory('shell_command').key === 'shell' && toolCategory('shell_command').label === 'comandos de consola');
  check('W1 apply_patch es una edicion y update_plan una lista de tareas',
    toolCategory('apply_patch').key === 'edit' && toolCategory('update_plan').key === 'todo');
  check('W1 un nombre desconocido se agrupa por nombre y sin etiqueta',
    same(toolCategory('mcp__x__y'), { key: 'name:mcp__x__y', label: null }));
}

// W2. La CLI del ultimo trabajo en un proyecto: la regla de Alt+T.
{
  const tabs = [tab('claude-code', 'D:\\Mi App'), tab(null, 'D:\\Mi App', 'shell'), tab('codex', 'd:/mi app/'), tab('claude-code', 'D:\\otra')];
  check('W2 win32: la ultima pestana de agente del proyecto, con el cwd normalizado', webUi.lastAgentFor(tabs, 'D:\\Mi App', 'win32') === 'codex');
  check('W2 las consolas no cuentan, aunque traigan CLI', webUi.lastAgentFor([tab('codex', 'D:\\x'), tab(null, 'D:\\x', 'shell')], 'D:\\x', 'win32') === 'codex' &&
    webUi.lastAgentFor([tab('codex', 'D:\\x'), tab('claude-code', 'D:\\x', 'shell')], 'D:\\x', 'win32') === 'codex' &&
    webUi.lastAgentFor([tab(null, 'D:\\x', 'shell')], 'D:\\x', 'win32') === null);
  check('W2 linux: las mayusculas separan proyectos', webUi.lastAgentFor([tab('codex', '/Home/u')], '/home/u', 'linux') === null &&
    webUi.lastAgentFor([tab('codex', '/home/u/')], '/home/u', 'linux') === 'codex');
  check('W2 sin pestanas del proyecto: null', webUi.lastAgentFor(tabs, 'D:\\nada', 'win32') === null);
}

// W3. Con que CLI abre el + directo.
{
  const tabs = [tab('codex', 'D:\\Mi App')];
  check('W3 barra: la del ultimo trabajo en el proyecto', webUi.tabBarAgent(tabs, 'd:\\mi app', 'win32', bothAgents, 'claude-code') === 'codex');
  check('W3 barra: sin pestanas ahi, la de por defecto', webUi.tabBarAgent(tabs, 'D:\\otra', 'win32', bothAgents, 'claude-code') === 'claude-code');
  check('W3 barra: si la del proyecto ya no esta instalada, la de por defecto',
    webUi.tabBarAgent(tabs, 'D:\\Mi App', 'win32', onlyClaudeAgents, 'claude-code') === 'claude-code');
  check('W3 sin candidata instalada: la primera instalada', webUi.firstAvailableAgent([null, 'codex'], onlyClaudeAgents) === 'claude-code' &&
    webUi.firstAvailableAgent(['codex'], noAgents) === null);

  const project = { cwd: 'D:\\Mi App', sessions: [{ agent: 'claude-code', updatedAt: 1 }, { agent: 'codex', updatedAt: 5 }, { agent: 'claude-code', updatedAt: 3 }] };
  check('W3 proyecto sin pestanas: la CLI de la sesion mas reciente', webUi.projectAgent([], project, 'win32', bothAgents, 'claude-code') === 'codex');
  check('W3 proyecto con pestana: gana la pestana', webUi.projectAgent([tab('claude-code', 'D:\\Mi App')], project, 'win32', bothAgents, 'codex') === 'claude-code');
  check('W3 proyecto sin pestanas ni sesiones: la de por defecto',
    webUi.projectAgent([], { cwd: 'D:\\Mi App', sessions: [] }, 'win32', bothAgents, 'claude-code') === 'claude-code');
  check('W3 sin sesiones no hay CLI de la mas reciente', webUi.latestSessionAgent([]) === null);
}

// W4. El menu: que ofrece, donde arranca, como se mueve y donde se dibuja.
{
  const mixed = [agentInfo('claude-code', 'Claude Code', false), agentInfo('codex', 'Codex', true)];
  check('W4 el menu ofrece solo las instaladas, en orden', same(webUi.menuAgents(bothAgents).map((a) => a.id), ['claude-code', 'codex']) &&
    same(webUi.menuAgents(mixed).map((a) => a.id), ['codex']));
  check('W4 arranca en la preelegida, o en la primera', webUi.menuStartIndex(bothAgents, 'codex') === 1 &&
    webUi.menuStartIndex(bothAgents, null) === 0 && webUi.menuStartIndex(mixed, 'claude-code') === 0);
  check('W4 las flechas dan la vuelta', webUi.menuStep(0, -1, 2) === 1 && webUi.menuStep(1, 1, 2) === 0 && webUi.menuStep(0, 1, 2) === 1 &&
    webUi.menuStep(3, 1, 0) === 0);

  const viewport = { width: 1000, height: 800 };
  const menu = { width: 200, height: 80 };
  check('W4 debajo del boton y alineado a su izquierda', same(webUi.menuPlacement({ left: 100, top: 30, bottom: 56 }, menu, viewport), { left: 100, top: 58 }));
  check('W4 sin lugar abajo, arriba', same(webUi.menuPlacement({ left: 100, top: 760, bottom: 786 }, menu, viewport), { left: 100, top: 678 }));
  check('W4 por la derecha no se sale', webUi.menuPlacement({ left: 950, top: 30, bottom: 56 }, menu, viewport).left === 796);
  const tall = webUi.menuPlacement({ left: 10, top: 40, bottom: 60 }, { width: 200, height: 790 }, viewport);
  check('W4 sin lugar ni arriba ni abajo, lo mas abajo que entra', same(tall, { left: 10, top: 6 }), show(tall));
}

// W5. Insignias y filas de una CLI que no esta.
{
  check('W5 pestana: insignia solo con eleccion y con CLI', webUi.tabBadgeVisible(true, 'codex') && !webUi.tabBadgeVisible(false, 'codex') &&
    !webUi.tabBadgeVisible(true, null));
  check('W5 fila con dos instaladas: insignia y sin aviso', same(webUi.sessionAgentView('claude-code', bothAgents, true), { badge: true, unavailableTitle: null }));
  check('W5 fila de Codex con solo Claude Code: insignia y el aviso',
    same(webUi.sessionAgentView('codex', onlyClaudeAgents, false), { badge: true, unavailableTitle: 'La CLI Codex no está instalada.' }),
    show(webUi.sessionAgentView('codex', onlyClaudeAgents, false)));
  check('W5 fila de Claude Code con solo Claude Code: como siempre',
    same(webUi.sessionAgentView('claude-code', onlyClaudeAgents, false), { badge: false, unavailableTitle: null }));
  check('W5 sin ninguna instalada ni hello: nada fila por fila',
    same(webUi.sessionAgentView('claude-code', noAgents, false), { badge: false, unavailableTitle: null }) &&
    same(webUi.sessionAgentView('codex', [], false), { badge: false, unavailableTitle: null }));
}

// W6. La espera de la sesion y la llamada abierta, del lado de la web.
{
  const fixed = { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: true, statusSource: true };
  check('W6 Codex sin sesion todavia: descubriendo', webUi.discoveringSession('codex', '', CODEX_CAPABILITIES));
  check('W6 con sesion, o con una CLI que fija el id, o sin CLI: no',
    !webUi.discoveringSession('codex', '019e0000-0000-7000-8000-000000000001', CODEX_CAPABILITIES) &&
    !webUi.discoveringSession('claude-code', '', fixed) && !webUi.discoveringSession(null, '', CODEX_CAPABILITIES));
  const notice = webUi.openToolCallNotice(CODEX_CAPABILITIES, true, 'Codex', true);
  check('W6 llamada abierta en una CLI sin estado: el motivo, con su nombre',
    notice === 'Codex tiene una herramienta sin resultado: puede estar pidiendo una aprobación. Contestala en la solapa CLI.', String(notice));
  check('W6 sin llamada, sin proceso o con una CLI que publica su estado: nada',
    webUi.openToolCallNotice(CODEX_CAPABILITIES, false, 'Codex', true) === null &&
    webUi.openToolCallNotice(CODEX_CAPABILITIES, true, 'Codex', false) === null &&
    webUi.openToolCallNotice(fixed, true, 'Claude Code', true) === null);
}

// W7. La llamada abierta viaja del servidor: protocolo y hub.
{
  const { parseServerMessage, EMPTY_CONTEXT_USAGE } = shared;
  check('W7 conversation.toolCall se lee', same(parseServerMessage(JSON.stringify({ type: 'conversation.toolCall', terminalId: 't', open: true })),
    { type: 'conversation.toolCall', terminalId: 't', open: true }));
  check('W7 sin open, o no booleano: null',
    parseServerMessage(JSON.stringify({ type: 'conversation.toolCall', terminalId: 't' })) === null &&
    parseServerMessage(JSON.stringify({ type: 'conversation.toolCall', terminalId: 't', open: 'si' })) === null);
  const reset = (extra) => parseServerMessage(JSON.stringify({
    type: 'conversation.reset', terminalId: 't', sessionId: 's', state: 'live', events: [], hasMore: false,
    usage: EMPTY_CONTEXT_USAGE, permissionMode: null, defaults: {}, waitingFor: null, ...extra,
  }));
  check('W7 un reset sin el campo (servidor anterior) no bloquea', reset({})?.openToolCall === false);
  check('W7 un reset con la llamada abierta la trae', reset({ openToolCall: true })?.openToolCall === true);

  const { EventEmitter } = await import('node:events');
  const { ConversationHub } = await import('../src/conversation-hub.ts');
  const openCalls = [];
  // Llamadas ya escritas en el "archivo" que ninguna lectura vio todavia.
  const unread = [];
  // Cuantas veces se pregunto: el hub pregunta despues de cada lectura, asi que
  // es la condicion para saber que una lectura ya termino.
  let asked = 0;
  const makeFollower = () => ({
    label: 'rollout', start: async () => undefined,
    poll: async () => {
      openCalls.push(...unread.splice(0));
      return { reset: false, added: [], turns: [], plans: [], parts: [] };
    },
    getState: () => 'live', getUsage: () => ({ ...EMPTY_CONTEXT_USAGE }), getPermissionMode: () => null,
    getTail: () => ({ events: [], hasMore: false }), getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [], readImage: async () => null, noticeChange: () => true,
    hasOpenToolCall: (launchedAt) => {
      asked += 1;
      return openCalls.some((at) => at >= launchedAt);
    },
  });
  const adapterWith = (id, statusSource) => ({
    id, capabilities: { ...CODEX_CAPABILITIES, statusSource },
    status: statusSource ? { subscribe: () => () => undefined } : null,
    history: { follow: () => makeFollower(), plans: null },
  });
  const adapters = { codex: adapterWith('codex', false), 'con-estado': adapterWith('con-estado', true) };
  const registry = new EventEmitter();
  const descriptors = new Map([
    ['tx', { terminalId: 'tx', kind: 'agent', agent: 'codex', cwd: CWD, sessionId: 's1', label: '', resumed: false, createdAt: 0, alive: true, exitCode: null, sleeping: false }],
    ['ty', { terminalId: 'ty', kind: 'agent', agent: 'con-estado', cwd: CWD, sessionId: 's2', label: '', resumed: false, createdAt: 0, alive: true, exitCode: null, sleeping: false }],
  ]);
  const launched = new Map([['tx', 100], ['ty', 100]]);
  registry.get = (terminalId) => descriptors.get(terminalId) ?? null;
  registry.launchedAtOf = (terminalId) => launched.get(terminalId) ?? null;
  const hub = new ConversationHub(registry, { get: (id) => (adapters[id] === undefined ? null : { adapter: adapters[id], location: null }) });
  const toolCalls = [];
  hub.on('toolCall', (terminalId, open) => toolCalls.push([terminalId, open]));

  const first = await hub.subscribe('tx');
  check('W7 sin llamadas: el snapshot no bloquea y no se avisa nada', first?.openToolCall === false && toolCalls.length === 0, show(toolCalls));

  openCalls.push(150);
  hub.onHistoryChanged('codex', 'rollout');
  check('W7 aparece una llamada de este proceso: se avisa una vez', await waitFor(() => toolCalls.length === 1) && same(toolCalls, [['tx', true]]) &&
    hub.isToolCallOpen('tx') && hub.getSnapshot('tx')?.openToolCall === true, show(toolCalls));
  const askedBefore = asked;
  hub.onHistoryChanged('codex', 'rollout');
  check('W7 otra lectura con lo mismo no repite el aviso', await waitFor(() => asked > askedBefore) && toolCalls.length === 1, show(toolCalls));

  launched.set('tx', 200);
  registry.emit('changed');
  check('W7 la pty se relanzo: la llamada vieja quedo huerfana y se avisa que no bloquea',
    same(toolCalls, [['tx', true], ['tx', false]]) && !hub.isToolCallOpen('tx'), show(toolCalls));
  launched.set('tx', 120);
  registry.emit('changed');
  launched.delete('tx');
  registry.emit('changed');
  check('W7 sin pty viva no bloquea', same(toolCalls.slice(2), [['tx', true], ['tx', false]]), show(toolCalls));

  launched.set('tx', 100);
  const late = await hub.subscribe('tx');
  check('W7 al suscribirse con la llamada ya abierta, el snapshot la trae', late?.openToolCall === true, show(late));

  const withStatus = await hub.subscribe('ty');
  registry.emit('changed');
  check('W7 una CLI que publica su estado nunca bloquea por esto', withStatus?.openToolCall === false && !hub.isToolCallOpen('ty') &&
    toolCalls.every(([terminalId]) => terminalId !== 'ty'), show(toolCalls));
  check('W7 una pestana que nadie sigue: false', hub.isToolCallOpen('nadie') === false);

  // A1 antes de cada pieza: la llamada ya esta escrita y el watcher todavia no aviso.
  launched.set('tx', 1_000);
  registry.emit('changed');
  const beforeCheck = toolCalls.length;
  unread.push(1_500);
  check('W7 sin lectura, la llamada recien escrita no se ve', hub.hasOpenToolCall('tx', 1_000) === false);
  check('W7 checkOpenToolCall lee antes de contestar: true', (await hub.checkOpenToolCall('tx', 1_000)) === true);
  check('W7 y lo que leyo le llega al cliente como con el watcher',
    same(toolCalls.slice(beforeCheck), [['tx', true]]) && hub.isToolCallOpen('tx'), show(toolCalls.slice(beforeCheck)));
  check('W7 checkOpenToolCall de una pestana que nadie sigue: false', (await hub.checkOpenToolCall('nadie', 0)) === false);

  // Antes de la lectura inicial no se lee con aviso: duplicaria lo que trae el snapshot.
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  let slowPolls = 0;
  adapters.lento = {
    ...adapterWith('lento', false),
    history: {
      plans: null,
      follow: () => ({
        ...makeFollower(),
        start: () => startGate,
        poll: async () => { slowPolls += 1; return { reset: false, added: [], turns: [], plans: [], parts: [] }; },
      }),
    },
  };
  descriptors.set('tz', { ...descriptors.get('tx'), terminalId: 'tz', agent: 'lento', sessionId: 's3' });
  launched.set('tz', 5_000);
  const subscribing = hub.subscribe('tz');
  await new Promise((resolve) => setImmediate(resolve));
  const early = await hub.checkOpenToolCall('tz', 5_000);
  check('W7 checkOpenToolCall mientras arranca el seguidor: no lee', early === false && slowPolls === 0, `${early} ${slowPolls}`);
  releaseStart();
  await subscribing;
  check('W7 y la lectura inicial es la unica', slowPolls === 1, String(slowPolls));
  hub.disposeAll();
}

// W8. La cabecera con dos CLIs no repite el nombre que ya trae la version.
{
  const { summarizeAgents } = await import('../../web/src/agent-summary.ts');
  const two = summarizeAgents([
    agentInfo('claude-code', 'Claude Code', true, { version: '2.1.270 (Claude Code)' }),
    agentInfo('codex', 'Codex', true, { version: 'codex-cli 0.154.0' }),
  ], true);
  check('W8 las versiones que ya nombran su CLI van solas', two.cliVersion === '2.1.270 (Claude Code) · codex-cli 0.154.0', String(two.cliVersion));
  const bare = summarizeAgents([
    agentInfo('claude-code', 'Claude Code', true, { version: '2.1.263' }),
    agentInfo('codex', 'Codex', true, { version: null }),
  ], true);
  check('W8 las que no lo nombran llevan la etiqueta delante', bare.cliVersion === 'Claude Code 2.1.263 · Codex ?', String(bare.cliVersion));
  const alone = summarizeAgents(onlyClaudeAgents.map((a) => (a.available ? { ...a, version: '2.1.270 (Claude Code)' } : a)), true);
  check('W8 con una sola, la version tal cual, como siempre', alone.cliVersion === '2.1.270 (Claude Code)', String(alone.cliVersion));
}

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
