/**
 * Chequeo del seguimiento incremental del JSONL.
 *
 *   npx tsx scripts/check-conversation-follower.mjs [carpeta-temporal]
 *
 * Cubre lo que no se puede ver a ojo y es justo donde este codigo se rompe:
 * lineas partidas al medio, caracteres UTF-8 cortados entre dos lecturas,
 * tipos de linea desconocidos, archivos que encogen y el paginado hacia atras.
 *
 * Trabaja sobre un archivo temporal propio: **nunca** escribe en
 * ~/.claude/projects, que es de la CLI y solo se lee.
 */

import { appendFile, mkdir, rm, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { ConversationFollower } from '../src/conversation-follower.ts';
import { ModelVariantRegistry } from '../src/model-variants.ts';

const dir = process.argv[2] ?? path.join(process.cwd(), '.check-follower');
await mkdir(dir, { recursive: true });
const file = path.join(dir, 'follower.jsonl');
await rm(file, { force: true });

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const line = (o) => JSON.stringify(o) + '\n';
const userMsg = (id, text) => line({
  type: 'user', uuid: id, timestamp: new Date().toISOString(), cwd: 'D:/x',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const asstMsg = (id, text, usage, model = 'claude-opus-5') => line({
  type: 'assistant', uuid: id, timestamp: new Date().toISOString(),
  message: { role: 'assistant', model, content: [{ type: 'text', text }], usage },
});

const follower = new ConversationFollower(file);

// 1. Archivo inexistente
let r = await follower.poll();
check('archivo inexistente -> waiting, sin eventos', follower.getState() === 'waiting' && r.added.length === 0);

// 2. Primer contenido
await writeFile(file, userMsg('u1', 'hola') + asstMsg('a1', 'respuesta', {
  input_tokens: 10, cache_read_input_tokens: 5000, cache_creation_input_tokens: 100, output_tokens: 40,
}));
r = await follower.poll();
check('lectura inicial -> 2 eventos', r.added.length === 2, `estado ${follower.getState()}`);
check('medidor: 10 + 5000 + 100 = 5110', follower.getUsage().lastRequestTokens === 5110,
  `dio ${follower.getUsage().lastRequestTokens}`);
check('ventana de claude-opus-5 = 200k', follower.getUsage().contextWindow === 200000);

// 3. Incremental: solo lo nuevo
await appendFile(file, userMsg('u2', 'otra'));
r = await follower.poll();
check('append -> solo el evento nuevo', r.added.length === 1 && r.added[0].eventId === 'u2');

// 4. Linea a medias: no se emite hasta que cierre
const partial = asstMsg('a2', 'a medias', { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 });
const half = Math.floor(partial.length / 2);
await appendFile(file, partial.slice(0, half));
r = await follower.poll();
check('linea incompleta -> no se emite nada', r.added.length === 0);
await appendFile(file, partial.slice(half));
r = await follower.poll();
check('al completarse -> se emite', r.added.length === 1 && r.added[0].eventId === 'a2');

// 5. UTF-8 partido por la mitad de un caracter
const emojiLine = userMsg('u3', 'ñandú 🐍 fin');
const buf = Buffer.from(emojiLine, 'utf8');
const snakeAt = buf.indexOf(Buffer.from('🐍', 'utf8'));
const handle = await open(file, 'a');
await handle.write(buf.subarray(0, snakeAt + 2)); // corta el emoji al medio
await handle.close();
r = await follower.poll();
check('corte a mitad de un caracter multibyte -> nada aun', r.added.length === 0);
const handle2 = await open(file, 'a');
await handle2.write(buf.subarray(snakeAt + 2));
await handle2.close();
r = await follower.poll();
const text = r.added[0]?.parts[0]?.kind === 'text' ? r.added[0].parts[0].text : '';
check('texto multibyte reconstruido intacto', text === 'ñandú 🐍 fin', JSON.stringify(text));

// 6. Tipos desconocidos se ignoran sin romper
await appendFile(file, line({ type: 'file-history-delta', messageId: 'x' })
  + line({ type: 'inventado-en-el-futuro', lo: 'que sea' })
  + line({ type: 'cost-state', totalCostUSD: 42 })
  + '{ esto no es json\n'
  + userMsg('u4', 'sigo vivo'));
r = await follower.poll();
check('tipos desconocidos y json roto -> ignorados, el resto sigue', r.added.length === 1 && r.added[0].eventId === 'u4');

// 7. Modelo desconocido -> sin ventana
await appendFile(file, asstMsg('a3', 'x', { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 3 }, 'gpt-5.6-terra'));
await follower.poll();
check('modelo desconocido -> ventana null, tokens igual', follower.getUsage().contextWindow === null && follower.getUsage().lastRequestTokens === 7);

// 8. El archivo encoge -> reset
await writeFile(file, userMsg('nuevo1', 'archivo reemplazado'));
r = await follower.poll();
check('archivo truncado -> reset y relectura', r.reset === true && r.added.length === 1 && r.added[0].eventId === 'nuevo1');

// 9. Paginado
for (let i = 0; i < 50; i++) await appendFile(file, userMsg(`p${i}`, `mensaje ${i}`));
await follower.poll();
const tail = follower.getTail(10);
check('getTail(10) -> 10 ultimos y hasMore', tail.events.length === 10 && tail.hasMore === true);
const page = follower.getPageBefore(tail.events[0].eventId, 5);
check('getPageBefore -> 5 anteriores', page.events.length === 5 && page.events.at(-1).eventId === 'p39' && page.events[0].eventId === 'p35',
  page.events.at(-1)?.eventId);

/*
  10. Ventana de contexto: la variante del modelo.

  Esto se rompio de verdad y en silencio. El `model` de una linea `assistant`
  viene SIN el sufijo de variante —dice `claude-opus-5` corra la sesion con
  200k o con 1M— asi que el medidor mostraba 200k en sesiones de 1M. El unico
  lugar del JSONL que trae el sufijo son las claves de `modelUsage` de las
  lineas `cost-state`.

  Es exactamente el tipo de bug que no se ve usando la app: el numero esta, la
  barra se dibuja, y esta mal.
*/
const costState = (models) => line({
  type: 'cost-state', totalCostUSD: 1,
  modelUsage: Object.fromEntries(models.map((m) => [m, { inputTokens: 1, outputTokens: 1 }])),
});
const flatUsage = (tokens) => ({
  input_tokens: tokens, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5,
});

// 10a. El cost-state del propio archivo recupera la variante, **venga donde
// venga**. En la vida real viene al final (§4.5.1: linea 614 de 671), o sea
// despues del assistant cuya ventana corrige.
const fileB = path.join(dir, 'variant.jsonl');
await writeFile(fileB, asstMsg('b1', 'x', flatUsage(1000)) + costState(['claude-opus-5[1m]']));
const followerB = new ConversationFollower(fileB);
await followerB.poll();
check('cost-state del archivo -> ventana 1M', followerB.getUsage().contextWindow === 1000000,
  `dio ${followerB.getUsage().contextWindow}`);
check('el modelo se reporta con su variante',
  followerB.getUsage().lastModel === 'claude-opus-5[1m]', followerB.getUsage().lastModel);

// 10b. Sin cost-state en el archivo manda lo que sabe la instalacion. Es el
// caso comun: una sesion recien abierta todavia no escribio ninguno.
const install = new ModelVariantRegistry();
install.observe('claude-opus-5[1m]', 1000);
const fileC = path.join(dir, 'install.jsonl');
await writeFile(fileC, asstMsg('c1', 'x', flatUsage(1000)));
const followerC = new ConversationFollower(fileC, install);
await followerC.poll();
check('sin cost-state -> la variante de la instalacion da 1M',
  followerC.getUsage().contextWindow === 1000000, `dio ${followerC.getUsage().contextWindow}`);

// 10c. Gana la observacion mas reciente, no la mayor. Volver a 200k tiene que
// verse: quedarse con el maximo historico dibuja una barra optimista para
// siempre.
const back = new ModelVariantRegistry();
back.observe('claude-opus-5[1m]', 1000);
back.observe('claude-opus-5', 2000);
check('gana la observacion mas reciente, no la mayor',
  back.resolve('claude-opus-5') === 'claude-opus-5', back.resolve('claude-opus-5'));
back.observe('claude-opus-5[1m]', 500);
check('una observacion vieja no pisa a una nueva',
  back.resolve('claude-opus-5') === 'claude-opus-5');

// 10c-bis. Un mismo cost-state trae la base con sufijo y sin el, y el desnudo
// llega segundo (medido: 5 lineas asi en esta instalacion, el desnudo siempre
// ultimo). Entran las dos con el mtime del archivo, o sea con el MISMO `at`:
// sin desempate, el desnudo pisa al bueno por orden de recorrido y el medidor
// vuelve a decir 200k en una sesion de 1M.
const tie = new ModelVariantRegistry();
tie.observeCostState({ modelUsage: { 'claude-opus-5[1m]': {}, 'claude-opus-5': {} } }, 1000);
check('a igualdad de tiempo, el id desnudo no pisa al que declara variante',
  tie.resolve('claude-opus-5') === 'claude-opus-5[1m]', tie.resolve('claude-opus-5'));

// Y en el orden inverso da lo mismo: no depende de como venga el objeto.
const tieReverse = new ModelVariantRegistry();
tieReverse.observeCostState({ modelUsage: { 'claude-opus-5': {}, 'claude-opus-5[1m]': {} } }, 1000);
check('y tampoco depende del orden de las claves',
  tieReverse.resolve('claude-opus-5') === 'claude-opus-5[1m]', tieReverse.resolve('claude-opus-5'));

// Pero un desnudo MAS NUEVO si manda: es el caso "volvi a 200k" de 10c, que no
// se puede perder por arreglar el empate.
const later = new ModelVariantRegistry();
later.observeCostState({ modelUsage: { 'claude-opus-5[1m]': {}, 'claude-opus-5': {} } }, 1000);
later.observe('claude-opus-5', 2000);
check('un desnudo posterior sigue ganando',
  later.resolve('claude-opus-5') === 'claude-opus-5', later.resolve('claude-opus-5'));

// 10c-ter. La ventana ANTES de la primera respuesta.
//
// El medidor ya no dice "sin respuestas medidas": dibuja la barra vacia y, al
// lado, el limite que le corresponde al modelo configurado. El alias de
// `settings.json` no dice la variante (`opus` a secas), asi que el limite sale
// del historial de la instalacion — pero **solo** de las observaciones que
// declaran variante.
//
// Ese matiz es el que hace que esta fuente sirva. Medido el 02-09-2026 sobre
// esta maquina: los tres archivos mas recientes traen `claude-opus-5` solo,
// sin ningun `[1m]` al lado, y sin embargo uno de ellos reporto una peticion de
// 275.960 tokens — que no entra en 200k. El id desnudo no significa "volvi a
// 200k", significa "esta linea no declara la variante"; si contara, una pestana
// recien abierta anunciaria 200k en una instalacion que corre en 1M.
const { readAgentDefaults } = await import('../src/agent-defaults.ts');
const projectDir = path.join(dir, 'proyecto');
const settingsFile = path.join(projectDir, '.claude', 'settings.json');
await mkdir(path.dirname(settingsFile), { recursive: true });

await writeFile(settingsFile, JSON.stringify({
  model: 'opus',
  modelSettings: { 'claude-opus-5': { effortLevel: 'xhigh' } },
}));
const plain = await readAgentDefaults(projectDir);
check('el alias configurado se lee tal cual', plain.model === 'opus', String(plain.model));
check('y su esfuerzo se casa por familia', plain.effort === 'xhigh', String(plain.effort));

const configured = new ModelVariantRegistry();
configured.observe('claude-opus-5[1m]', 1000);
check('el alias configurado toma la variante que usa la instalacion',
  configured.windowForConfigured('opus') === 1000000,
  String(configured.windowForConfigured('opus')));
check('otra familia sin observar no hereda la ventana de la que si',
  configured.windowForConfigured('sonnet') === null,
  String(configured.windowForConfigured('sonnet')));

const virgin = new ModelVariantRegistry();
check('sin ninguna observacion, el alias corto no inventa 200k',
  virgin.windowForConfigured('opus') === null, String(virgin.windowForConfigured('opus')));
check('pero un alias que declara variante manda solo',
  virgin.windowForConfigured('opus[1m]') === 1000000,
  String(virgin.windowForConfigured('opus[1m]')));
check('un modelo que no conocemos sigue sin ventana',
  virgin.windowForConfigured('gpt-5.6-terra') === null);
check('y sin modelo configurado tampoco hay ventana',
  virgin.windowForConfigured(null) === null);

// El caso medido que decide el diseno: un desnudo posterior no puede bajar la
// ventana de la barra inicial, porque no es evidencia de nada.
const bareLater = new ModelVariantRegistry();
bareLater.observe('claude-opus-5[1m]', 1000);
bareLater.observe('claude-opus-5', 2000);
check('un id desnudo posterior no baja la ventana de la barra inicial',
  bareLater.windowForConfigured('opus') === 1000000,
  String(bareLater.windowForConfigured('opus')));
// Pero `resolve` no cambia: ahi el mas reciente sigue mandando, y si se
// equivoca lo corrigen los tokens medidos.
check('y resolve sigue devolviendo la observacion mas reciente',
  bareLater.resolve('claude-opus-5') === 'claude-opus-5',
  bareLater.resolve('claude-opus-5'));

// Y al reves, que es el orden en que llegan de verdad: el historial se recorre
// por directorio, no por fecha, asi que un `[1m]` VIEJO entra despues de un
// desnudo nuevo. Si la observacion util se descartara por vieja —el `return`
// que le corresponde a `byBase`— la barra inicial se quedaria sin limite en una
// instalacion que tiene `[1m]` por todos lados. Pasó en vivo.
const outOfOrder = new ModelVariantRegistry();
outOfOrder.observe('claude-opus-5', 2000);
outOfOrder.observe('claude-opus-5[1m]', 1000);
check('un [1m] mas viejo que un desnudo no se pierde',
  outOfOrder.windowForConfigured('opus') === 1000000,
  String(outOfOrder.windowForConfigured('opus')));

// Y una familia sin variante larga si se resuelve con el nombre desnudo: haiku
// no ofrece `[1m]`, asi que ahi no hay ambiguedad que cuidar.
const shortOnly = new ModelVariantRegistry();
shortOnly.observe('claude-haiku-4-5-20251001', 1000);
check('una familia sin variante larga toma la ventana del nombre desnudo',
  shortOnly.windowForConfigured('haiku') === 200000,
  String(shortOnly.windowForConfigured('haiku')));

// 10c-quater. La variante que declara la CONFIGURACION.
//
// El agujero que quedaba: `message.model` no trae el sufijo nunca, asi que una
// sesion de 1M se veia como una de 200k hasta que apareciera un `cost-state`.
// Reportado en vivo — la barra decia "69.8k / 200k" con `"model": "opus[1m]"`
// escrito en settings.json. La CLI reescribe ese archivo cuando acepta un
// `/model`, asi que es la fuente, y el comando solo dispara la relectura.
const configFile = path.join(dir, 'configurada.jsonl');
await writeFile(configFile, asstMsg('cf1', 'x', flatUsage(1000)));

const longConfigured = new ConversationFollower(configFile);
longConfigured.setConfiguredAlias('opus[1m]');
await longConfigured.poll();
check('la variante configurada completa la que el archivo no dice',
  longConfigured.getUsage().lastModel === 'claude-opus-5[1m]',
  String(longConfigured.getUsage().lastModel));
check('y con ella la ventana pasa a 1M',
  longConfigured.getUsage().contextWindow === 1000000,
  String(longConfigured.getUsage().contextWindow));

// Un alias sin sufijo no dice "elegi 200k", dice "este nombre no menciona la
// ventana": no puede bajar nada.
const shortAlias = new ConversationFollower(configFile);
shortAlias.setConfiguredAlias('opus');
await shortAlias.poll();
check('un alias sin variante no toca el modelo observado',
  shortAlias.getUsage().lastModel === 'claude-opus-5',
  String(shortAlias.getUsage().lastModel));

// Ni cruza familias: lo configurado para sonnet no describe a un opus.
const otherFamily = new ConversationFollower(configFile);
otherFamily.setConfiguredAlias('sonnet[1m]');
await otherFamily.poll();
check('la configuracion de otra familia no se aplica',
  otherFamily.getUsage().lastModel === 'claude-opus-5',
  String(otherFamily.getUsage().lastModel));

// El camino de vuelta: de 1M a 200k. Reportado en vivo — con `/model opus`
// confirmado por la CLI ("Set model to `Opus 5`", sin "1M context"), el combo y
// la barra seguian en 1M. La regla de "solo agregar el sufijo" lo bloqueaba, y
// esa regla vale para un id observado, no para un alias que el usuario eligio.
const backToShortFile = path.join(dir, 'vuelta-a-200k.jsonl');
await writeFile(backToShortFile,
  asstMsg('bs1', 'x', flatUsage(1000)) +
  line({ type: 'cost-state', modelUsage: { 'claude-opus-5[1m]': {} } }));
const backFollower = new ConversationFollower(backToShortFile);
backFollower.setConfiguredAlias('opus[1m]');
await backFollower.poll();
check('mientras corre en 1M, la ventana es de 1M',
  backFollower.getUsage().contextWindow === 1000000,
  String(backFollower.getUsage().contextWindow));

await appendFile(backToShortFile, line({
  type: 'user', uuid: 'bs2', timestamp: new Date().toISOString(),
  message: {
    role: 'user',
    content: '<command-name>/model</command-name><command-args>opus</command-args>',
  },
}));
await backFollower.poll();
backFollower.setConfiguredAlias('opus');   // lo que el hub relee de settings.json
backFollower.recomputeModel();
check('tras un /model a la variante corta, la barra baja a 200k',
  backFollower.getUsage().contextWindow === 200000,
  String(backFollower.getUsage().contextWindow));
check('y el modelo pierde el sufijo',
  backFollower.getUsage().lastModel === 'claude-opus-5',
  String(backFollower.getUsage().lastModel));

// Y el detalle que lo rompia en vivo: `modelUsage` de `cost-state` es un
// ACUMULADO de la sesion. Despues de cambiar a la variante corta, los
// `cost-state` siguientes siguen listando `claude-opus-5[1m]` de los turnos
// viejos — para siempre. Si esa fuente ganara, volver a 200k no moveria la
// barra nunca. Medido sobre una sesion real de esta maquina.
await appendFile(backToShortFile,
  line({ type: 'cost-state', modelUsage: { 'claude-opus-5[1m]': {}, 'claude-opus-5': {} } }) +
  asstMsg('bs3', 'y', flatUsage(1200)));
await backFollower.poll();
check('un cost-state acumulado no revive la variante que ya se abandono',
  backFollower.getUsage().contextWindow === 200000,
  String(backFollower.getUsage().contextWindow));

// Sin `/model` de por medio, en cambio, la configuracion NO baja nada: una
// sesion del historial corrio con lo que corrio, y la configuracion de hoy no
// reescribe ese pasado.
const historic = path.join(dir, 'historica.jsonl');
await writeFile(historic,
  asstMsg('hi1', 'x', flatUsage(1000)) +
  line({ type: 'cost-state', modelUsage: { 'claude-opus-5[1m]': {} } }));
const historicFollower = new ConversationFollower(historic);
historicFollower.setConfiguredAlias('opus');
await historicFollower.poll();
check('sin /model, la configuracion no le baja la ventana al historial',
  historicFollower.getUsage().contextWindow === 1000000,
  String(historicFollower.getUsage().contextWindow));

// Y el `/model` que pasa por la conversacion marca la configuracion como vieja
// para que el hub la relea. Se mira la invocacion, no su argumento.
const commandFile = path.join(dir, 'comando.jsonl');
await writeFile(commandFile, asstMsg('cm1', 'x', flatUsage(1000)));
const commandFollower = new ConversationFollower(commandFile);
await commandFollower.poll();
check('sin comandos, la configuracion no se relee',
  commandFollower.takeConfiguredStale() === false);

await appendFile(commandFile, line({
  type: 'user', uuid: 'cm2', timestamp: new Date().toISOString(),
  message: {
    role: 'user',
    content: '<command-name>/model</command-name><command-args>opus[1m]</command-args>',
  },
}));
await commandFollower.poll();
check('un /model marca la configuracion para releer',
  commandFollower.takeConfiguredStale() === true);
check('y se consume una sola vez',
  commandFollower.takeConfiguredStale() === false);

// Releida la configuracion, la cuenta se rehace sin esperar otra respuesta.
commandFollower.setConfiguredAlias('opus[1m]');
commandFollower.recomputeModel();
check('recomputeModel mueve la barra en el acto',
  commandFollower.getUsage().contextWindow === 1000000,
  String(commandFollower.getUsage().contextWindow));

// 10d. Sin saber nada del modelo, los tokens medidos alcanzan: 255k no entran
// en 200k, asi que la ventana no es de 200k. Es la red que no depende de
// ningun nombre, y son los numeros reales de una sesion de esta maquina.
const fileD = path.join(dir, 'observed.jsonl');
await writeFile(fileD, asstMsg('d1', 'x', {
  input_tokens: 2, cache_read_input_tokens: 253963, cache_creation_input_tokens: 1568, output_tokens: 5,
}));
const followerD = new ConversationFollower(fileD);
await followerD.poll();
check('255k medidos -> la ventana sube a 1M y se marca deducida',
  followerD.getUsage().contextWindow === 1000000 && followerD.getUsage().contextWindowEstimated === true,
  `${followerD.getUsage().contextWindow} / estimada=${followerD.getUsage().contextWindowEstimated}`);

// 10e. Un limite que si alcanza no se toca ni se marca.
const fileE = path.join(dir, 'fits.jsonl');
await writeFile(fileE, asstMsg('e1', 'x', flatUsage(1000)));
const followerE = new ConversationFollower(fileE);
await followerE.poll();
check('los tokens entran -> 200k sin marcar',
  followerE.getUsage().contextWindow === 200000 && followerE.getUsage().contextWindowEstimated === false);

// 10f. Un modelo desconocido no gana ventana por tener muchos tokens.
const fileF = path.join(dir, 'unknown.jsonl');
await writeFile(fileF, asstMsg('f1', 'x', flatUsage(900000), 'gpt-5.6-terra'));
const followerF = new ConversationFollower(fileF);
await followerF.poll();
check('modelo desconocido con muchos tokens -> sigue sin ventana',
  followerF.getUsage().contextWindow === null);

// ---------------------------------------------------------------------------
// 11. Duracion del turno, esfuerzo e imagenes (hito 9)
// ---------------------------------------------------------------------------

const turnFile = path.join(dir, 'turnos.jsonl');
const turnLine = (parentUuid, durationMs) =>
  line({ type: 'system', subtype: 'turn_duration', parentUuid, durationMs, uuid: 'sys-' + parentUuid });

// 11a. La duracion llega en la misma lectura que su mensaje: viaja dentro.
await writeFile(turnFile, userMsg('t-u1', 'hola') + asstMsg('t-a1', 'ahi va') + turnLine('t-a1', 4321));
const turnFollower = new ConversationFollower(turnFile);
let tr = await turnFollower.poll();
const withDuration = tr.added.find((e) => e.eventId === 't-a1');
check('la duracion del turno se pega al mensaje', withDuration?.durationMs === 4321,
  String(withDuration?.durationMs));
check('y no se manda por separado si viajo dentro', tr.turns.length === 0);
check('turn_duration no genera una tarjeta propia', tr.added.length === 2);

// 11b. La duracion llega en una lectura posterior: se manda suelta.
await appendFile(turnFile, asstMsg('t-a2', 'otra'));
await turnFollower.poll();
await appendFile(turnFile, turnLine('t-a2', 77000));
tr = await turnFollower.poll();
check('si llega despues, se manda como actualizacion',
  tr.turns.length === 1 && tr.turns[0].eventId === 't-a2' && tr.turns[0].durationMs === 77000,
  JSON.stringify(tr.turns));
check('y no reenvia el mensaje entero', tr.added.length === 0);

// 11c. Una duracion que apunta a un mensaje que no tenemos no rompe nada.
await appendFile(turnFile, turnLine('no-existe', 100));
tr = await turnFollower.poll();
check('una duracion huerfana se ignora', tr.turns.length === 0 && tr.added.length === 0);

// 11d. El esfuerzo sale de la raiz de la linea, no de `message`.
const effortFile = path.join(dir, 'esfuerzo.jsonl');
await writeFile(effortFile, line({
  type: 'assistant', uuid: 'e-1', timestamp: new Date().toISOString(), effort: 'xhigh',
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'x' }] },
}));
const effortFollower = new ConversationFollower(effortFile);
const effortResult = await effortFollower.poll();
check('el esfuerzo se lee de la raiz de la linea',
  effortResult.added[0]?.effort === 'xhigh', String(effortResult.added[0]?.effort));

// 11e. Una imagen viaja como referencia, nunca con sus bytes.
const imageFile = path.join(dir, 'imagen.jsonl');
const bytes = 'A'.repeat(5000);
await writeFile(imageFile, line({
  type: 'user', uuid: 'i-1', timestamp: new Date().toISOString(),
  message: { role: 'user', content: [
    { type: 'text', text: 'mira esto' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes } },
  ] },
}));
const imageFollower = new ConversationFollower(imageFile);
const imageResult = await imageFollower.poll();
const imagePart = imageResult.added[0]?.parts.find((part) => part.kind === 'image');
check('la imagen se convierte en referencia', imagePart !== undefined);
check('con su posicion dentro del mensaje', imagePart?.index === 1, String(imagePart?.index));
check('y sin un solo byte del contenido',
  !JSON.stringify(imageResult.added).includes(bytes.slice(0, 200)));

// 11f. El contenido se busca aparte, por eventId e indice.
const { loadConversationImage } = await import('../src/conversation-image.ts');
const loaded = await loadConversationImage(imageFile, 'i-1', 1);
check('la imagen se puede traer por (eventId, indice)',
  loaded?.data === bytes && loaded?.mediaType === 'image/png');
const missing = await loadConversationImage(imageFile, 'i-1', 0);
check('pedir un bloque que no es imagen devuelve null', missing === null);
const noEvent = await loadConversationImage(imageFile, 'no-existe', 0);
check('pedir un evento inexistente devuelve null', noEvent === null);

// 11g. Los comandos que el usuario le da a la CLI no son conversacion.
//
// Hasta el hito 15 se desenvolvian y el hilo quedaba con cuatro tarjetas
// seguidas: `/model`, `opus[1m]`, `Set model to...`, `/effort`. Las cadenas de
// abajo son las de esta instalacion, copiadas del transcript.
const noiseFile = path.join(dir, 'ruido.jsonl');
const userRaw = (id, content) => line({
  type: 'user', uuid: id, timestamp: new Date().toISOString(),
  message: { role: 'user', content },
});
await writeFile(noiseFile,
  userRaw('n1', '<command-name>/model</command-name>\n            <command-message>model</command-message>\n            <command-args>opus[1m]</command-args>') +
  userRaw('n2', '<local-command-stdout>Set model to `Opus 5 (1M context)` and saved as your default for new sessions</local-command-stdout>') +
  userRaw('n3', '<bash-input>git status</bash-input>') +
  userRaw('n4', '<bash-stdout>On branch main</bash-stdout>') +
  userRaw('n5', '<local-command-caveat>Caveat: los mensajes de abajo salen de comandos locales</local-command-caveat>') +
  userRaw('n6', 'esto si lo escribi yo'));
const noiseFollower = new ConversationFollower(noiseFile);
const noiseResult = await noiseFollower.poll();
check('los comandos locales no generan tarjeta',
  noiseResult.added.length === 1 && noiseResult.added[0]?.eventId === 'n6',
  noiseResult.added.map((event) => event.eventId).join(','));

// Y lo que acompana a un comando sobrevive: se quita el envoltorio, no el
// mensaje. Un usuario que pega HTML tiene que seguir viendo su HTML.
await appendFile(noiseFile,
  userRaw('n7', '<bash-input>ls</bash-input>\nfijate esto') +
  userRaw('n8', 'mira este <div>ejemplo</div>'));
const mixed = await noiseFollower.poll();
check('lo escrito junto a un comando se conserva',
  mixed.added[0]?.parts[0]?.text === 'fijate esto',
  JSON.stringify(mixed.added[0]?.parts[0]));
check('una etiqueta que no es del arnes no se toca',
  mixed.added[1]?.parts[0]?.text === 'mira este <div>ejemplo</div>',
  JSON.stringify(mixed.added[1]?.parts[0]));

// 11h. Un mensaje escrito mientras el agente trabaja.
//
// No es una linea `user`: la CLI lo encola y lo devuelve como un `attachment`
// de tipo `queued_command`. Por eso no se veia en la conversacion. Las lineas
// de abajo son las del archivo real donde el usuario reporto el bug
// (lineas 409 a 413 de esa sesion).
const queueFile = path.join(dir, 'cola.jsonl');
const attach = (id, attachment) => line({
  type: 'attachment', uuid: id, timestamp: new Date().toISOString(),
  parentUuid: 'a1', attachment,
});
await writeFile(queueFile,
  line({ type: 'queue-operation', operation: 'enqueue', content: 'Ya esta activa la vpn' }) +
  line({ type: 'queue-operation', operation: 'remove', reason: 'absorbed_mid_turn',
    content: 'Ya esta activa la vpn' }) +
  attach('q1', { type: 'queued_command', prompt: 'Ya esta activa la vpn',
    commandMode: 'prompt', origin: { kind: 'human' } }));
const queueFollower = new ConversationFollower(queueFile);
const queued = await queueFollower.poll();
check('el mensaje encolado genera una tarjeta',
  queued.added.length === 1 && queued.added[0]?.eventId === 'q1',
  queued.added.map((event) => event.eventId).join(','));
check('con el texto que se escribio',
  queued.added[0]?.parts[0]?.text === 'Ya esta activa la vpn');
check('marcado como encolado', queued.added[0]?.queued === true);
check('y como mensaje del usuario', queued.added[0]?.role === 'user');

// Los avisos que se manda el agente a si mismo tienen la misma forma y NO son
// mensajes de nadie. Son 20 de los 26 `queued_command` de esta instalacion.
await appendFile(queueFile,
  attach('q2', { type: 'queued_command', commandMode: 'task-notification',
    prompt: '<task-notification><task-id>abc</task-id></task-notification>' }) +
  attach('q3', { type: 'queued_command', commandMode: 'prompt',
    origin: { kind: 'agent' }, prompt: 'esto no lo escribio el usuario' }) +
  attach('q4', { type: 'total_tokens_reminder', text: '<total_tokens>1</total_tokens>' }) +
  attach('q5', {}));
const queuedNoise = await queueFollower.poll();
check('un aviso de tarea no genera tarjeta',
  queuedNoise.added.length === 0,
  queuedNoise.added.map((event) => event.eventId).join(','));

// Un mensaje que sale de la cola por `dequeue` arranca su propio turno y llega
// como linea `user` normal. Si tambien se dibujara el `enqueue`, saldria dos
// veces: son 39 de los 69 encolados de esta instalacion.
await appendFile(queueFile,
  line({ type: 'queue-operation', operation: 'enqueue', content: 'el que sigue' }) +
  line({ type: 'queue-operation', operation: 'dequeue' }) +
  userMsg('q6', 'el que sigue'));
const dequeued = await queueFollower.poll();
check('el que sale por dequeue aparece una sola vez',
  dequeued.added.length === 1 && dequeued.added[0]?.eventId === 'q6',
  dequeued.added.map((event) => event.eventId).join(','));
check('y no queda marcado como encolado', dequeued.added[0]?.queued === false);

// ---------------------------------------------------------------------------
// Las imagenes que la CLI adjunta por ruta
// ---------------------------------------------------------------------------
//
// El cuadro de escritura no le pasa bytes a la CLI: le nombra la ruta del
// archivo (§5.3), y la CLI escribe **dos** lineas — el mensaje, y una
// `attachment` aparte con la imagen en base64. Medido sobre los 285 archivos
// de la instalacion: 17 adjuntos de imagen, los 17 con base64, los 17 colgando
// de una linea `user`, los 17 a una linea de distancia.
//
// Lo que se rompe en silencio aca es el texto: sin quitarle el `@"ruta"`, el
// hilo muestra sesenta caracteres de ruta al lado de la miniatura de esa misma
// imagen.

const imgFile = path.join(dir, 'imagenes.jsonl');
const imgDir = 'C:\\Users\\Ana\\AppData\\Local\\Temp';
const pathOf = (name) => imgDir + '\\' + name;
// Un PNG de 1x1 de verdad: el lector exige base64 no vacio.
const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** Un mensaje del usuario con el contenido como string suelto, que es el caso real. */
const userStr = (id, text) => line({
  type: 'user', uuid: id, timestamp: new Date().toISOString(), cwd: 'D:/x',
  message: { role: 'user', content: text },
});
const imageAttach = (id, parentUuid, filename, base64 = PNG_1PX) => line({
  type: 'attachment', uuid: id, parentUuid, timestamp: new Date().toISOString(),
  attachment: {
    type: 'file', filename, displayPath: filename,
    content: { type: 'image', file: { base64, type: 'image/png', originalSize: 70 } },
  },
});

// 1. Las dos lineas en la misma lectura: el evento ya sale corregido.
await writeFile(imgFile,
  userStr('i1', '@"' + pathOf('pegada-1.png') + '" mira esto') +
  imageAttach('at1', 'i1', pathOf('pegada-1.png')));
const imgFollower = new ConversationFollower(imgFile);
const img = await imgFollower.poll();
check('mensaje con imagen adjunta -> un solo evento',
  img.added.length === 1 && img.added[0]?.eventId === 'i1',
  img.added.map((e) => e.eventId).join(','));
check('la imagen va primero y el texto despues',
  img.added[0]?.parts[0]?.kind === 'image' && img.added[0]?.parts[1]?.kind === 'text',
  img.added[0]?.parts.map((p) => p.kind).join(','));
check('la imagen se marca como adjunta, indice 0',
  img.added[0]?.parts[0]?.source === 'attachment' && img.added[0]?.parts[0]?.index === 0);
check('la ruta desaparece del texto',
  img.added[0]?.parts[1]?.text === 'mira esto',
  JSON.stringify(img.added[0]?.parts[1]?.text));
check('sin actualizacion suelta: viajo dentro del evento', img.parts.length === 0);

// 2. Las dos lineas en lecturas distintas: el evento ya viajo, y hay que
//    corregirlo con una actualizacion suelta.
const splitFile = path.join(dir, 'imagenes-cortadas.jsonl');
await writeFile(splitFile, userStr('i2', '@"' + pathOf('pegada-2.png') + '" y un texto'));
const splitFollower = new ConversationFollower(splitFile);
let split = await splitFollower.poll();
check('el mensaje solo -> sale con la ruta cruda',
  split.added.length === 1 && split.added[0]?.parts[0]?.kind === 'text',
  split.added[0]?.parts.map((p) => p.kind).join(','));
await appendFile(splitFile, imageAttach('at2', 'i2', pathOf('pegada-2.png')));
split = await splitFollower.poll();
check('la linea de la imagen sola -> no genera evento', split.added.length === 0);
check('pero si una actualizacion de partes',
  split.parts.length === 1 && split.parts[0]?.eventId === 'i2');
check('con la imagen y el texto ya limpio',
  split.parts[0]?.parts[0]?.kind === 'image' &&
  split.parts[0]?.parts[1]?.text === 'y un texto',
  split.parts[0]?.parts.map((p) => p.kind).join(','));

// 3. Dos imagenes en un mismo mensaje, **encadenadas**, que es lo que la CLI
//    escribe de verdad: el segundo adjunto cuelga del primero, no del mensaje.
//
//    Remedido sobre los 39 adjuntos de imagen de la instalacion: 34 cuelgan de
//    una linea `user` y 5 de otro adjunto — y esos 5 son exactamente los casos
//    en los que se veia la ruta cruda en vez de la miniatura. La version
//    anterior de esta prueba colgaba los dos del mensaje, que es una forma que
//    no pasa nunca, y por eso el bug paso por delante sin que nadie lo viera.
const twoFile = path.join(dir, 'dos-imagenes.jsonl');
await writeFile(twoFile,
  userStr('i3', '@"' + pathOf('a.png') + '" @"' + pathOf('b.png') + '" compara') +
  imageAttach('at3', 'i3', pathOf('a.png')) +
  imageAttach('at4', 'at3', pathOf('b.png')));
const twoFollower = new ConversationFollower(twoFile);
const two = await twoFollower.poll();
const twoParts = two.added[0]?.parts ?? [];
check('dos adjuntos encadenados -> dos partes de imagen',
  twoParts.filter((p) => p.kind === 'image').length === 2,
  twoParts.map((p) => p.kind).join(','));
check('numeradas 0 y 1, en orden',
  twoParts[0]?.index === 0 && twoParts[1]?.index === 1,
  twoParts.map((p) => p.index).join(','));
check('y las dos rutas fuera del texto',
  twoParts[2]?.text === 'compara',
  JSON.stringify(twoParts[2]?.text));

// 3b. Los bytes de la segunda tambien se encuentran: el que dibuja la miniatura
//     es otro camino, y tenia el mismo supuesto.
const secondBytes = await loadConversationImage(twoFile, 'i3', 1, 'attachment');
check('la segunda imagen encadenada se puede traer por (eventId, 1)',
  secondBytes?.data === PNG_1PX, String(secondBytes?.data).slice(0, 24));
const firstBytes = await loadConversationImage(twoFile, 'i3', 0, 'attachment');
check('y la primera sigue saliendo', firstBytes?.data === PNG_1PX);
const thirdBytes = await loadConversationImage(twoFile, 'i3', 2, 'attachment');
check('pedir una tercera que no existe -> null', thirdBytes === null);

// 3c. Las dos colgando del mensaje tambien valen: es lo que hace la CLI cuando
//     hay una sola imagen por mensaje, y nada garantiza que no encadene menos
//     en otra version.
const flatFile = path.join(dir, 'dos-imagenes-planas.jsonl');
await writeFile(flatFile,
  userStr('i3b', '@"' + pathOf('a.png') + '" @"' + pathOf('b.png') + '" compara') +
  imageAttach('at3b', 'i3b', pathOf('a.png')) +
  imageAttach('at4b', 'i3b', pathOf('b.png')));
const flatFollower = new ConversationFollower(flatFile);
const flat = await flatFollower.poll();
const flatParts = flat.added[0]?.parts ?? [];
check('dos adjuntos del mismo mensaje -> dos partes igual',
  flatParts.filter((p) => p.kind === 'image').length === 2 && flatParts[2]?.text === 'compara',
  flatParts.map((p) => p.kind).join(','));

// 4. Un `@ruta` que la CLI **no** adjunto se sigue viendo: se quita el
//    envoltorio, no el mensaje (§4.12). Sin adjunto no hay miniatura que lo
//    reemplace, y borrarlo dejaria una frase que no se entiende.
const loneFile = path.join(dir, 'sin-adjunto.jsonl');
const loneText = 'proba con @"' + pathOf('no-existe.png') + '" a ver';
await writeFile(loneFile, userStr('i4', loneText));
const loneFollower = new ConversationFollower(loneFile);
const lone = await loneFollower.poll();
check('un @ruta sin adjunto no se toca',
  lone.added[0]?.parts[0]?.text === loneText,
  JSON.stringify(lone.added[0]?.parts[0]?.text));

// 5. Un mensaje que era **solo** la imagen no deja una tarjeta de texto vacia.
const onlyFile = path.join(dir, 'solo-imagen.jsonl');
await writeFile(onlyFile,
  userStr('i5', '@"' + pathOf('sola.png') + '"') +
  imageAttach('at5', 'i5', pathOf('sola.png')));
const onlyFollower = new ConversationFollower(onlyFile);
const only = await onlyFollower.poll();
check('un mensaje que era solo la imagen queda solo con la imagen',
  only.added[0]?.parts.length === 1 && only.added[0]?.parts[0]?.kind === 'image',
  only.added[0]?.parts.map((p) => p.kind).join(','));

// 6. Una ruta escrita a mano con separadores al reves. De los 17 adjuntos de
//    la instalacion, 3 no casan literal por esto: el `filename` lo normaliza la
//    CLI y lo tecleado no.
const slashFile = path.join(dir, 'barras.jsonl');
await writeFile(slashFile,
  userStr('i6', '@"C:/Users/Ana/AppData/Local/Temp/otra.png" que color es') +
  imageAttach('at6', 'i6', pathOf('otra.png')));
const slashFollower = new ConversationFollower(slashFile);
const slash = await slashFollower.poll();
check('una ruta con las barras al reves casa igual',
  slash.added[0]?.parts[1]?.text === 'que color es',
  JSON.stringify(slash.added[0]?.parts[1]?.text));

// ---------------------------------------------------------------------------
// Y los bytes, que viajan aparte
// ---------------------------------------------------------------------------
//
// Las imagenes no van con los eventos: viaja la referencia y el contenido se
// busca cuando la miniatura entra en pantalla. Las dos formas viven en sitios
// distintos del archivo y se piden con la misma llamada, asi que el `source` es
// lo unico que las separa.

const fromAttachment = await loadConversationImage(twoFile, 'i3', 1, 'attachment');
check('la segunda imagen adjunta se encuentra por su indice',
  fromAttachment?.data === PNG_1PX && fromAttachment?.mediaType === 'image/png',
  fromAttachment === null ? 'no la encontro' : fromAttachment.mediaType);
check('un indice que no existe devuelve null',
  (await loadConversationImage(twoFile, 'i3', 2, 'attachment')) === null);

// Sin `source` se buscan las del propio mensaje, que es lo que deja `Alt+V` en
// la solapa CLI. Las dos numeraciones son independientes y empiezan en cero.
const inlineFile = path.join(dir, 'pegada-en-la-cli.jsonl');
await writeFile(inlineFile, line({
  type: 'user', uuid: 'i7', timestamp: new Date().toISOString(),
  message: { role: 'user', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } },
    { type: 'text', text: 'que ves' },
  ] },
}));
const inlineFollower = new ConversationFollower(inlineFile);
const inline = await inlineFollower.poll();
check('una imagen pegada en la CLI sigue marcada como del contenido',
  inline.added[0]?.parts[0]?.source === 'content' && inline.added[0]?.parts[0]?.index === 0,
  String(inline.added[0]?.parts[0]?.source));
check('y sus bytes se encuentran por el otro camino',
  (await loadConversationImage(inlineFile, 'i7', 0, 'content'))?.data === PNG_1PX);

await rm(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLOS`);
process.exit(failures === 0 ? 0 : 1);
