/**
 * Chequeo del adaptador de Pi (hito 43, CLAUDE.md 16) y de lo generico que
 * llego con el: las imagenes por linea, el comando de esfuerzo por CLI y los
 * mensajes en cola que la CLI devuelve a su editor.
 *
 *   npx tsx scripts/check-pi-adapter.mjs
 *
 * Cubre:
 *
 *  - P1: rutas y nombres. La carpeta de un proyecto, el nombre de un archivo de
 *    sesion, la forma de un id (uno hostil no llega a la linea de comando) y
 *    las variables de carpeta relativas, que no se leen.
 *  - P2: lo que dice cada linea, y el arbol: la rama activa, "en cola", la
 *    duracion del turno, los avisos de interrumpido y error, y que la firma del
 *    razonamiento no llega nunca a un evento.
 *  - P3: el seguidor sobre archivos: el medidor con la ventana del catalogo, un
 *    cambio de nivel sin eventos, la rama que obliga a rehacer, el archivo que
 *    aparece tarde, la huella, los topes del respaldo y las imagenes.
 *  - P4: el historial: raices, filtro de recorrido, listado, resumen y titulo.
 *  - P5: el catalogo y la localizacion **sin ejecutar nada**.
 *  - P6: el estado desde el archivo: solo lo escrito desde el lanzamiento, la
 *    calma tras un error, el dialogo de confianza, y que mensajes llegaron.
 *  - P7: el gancho de la pestana: el dialogo en la salida, y el cambio de
 *    sesion por `/fork`, por un mensaje de la app y por uno tecleado.
 *  - P8: los mensajes en cola al interrumpir, con el reloj inyectado: cuando se
 *    escribe la tecla que vacia el editor, y cuando no se escribe nada.
 *  - P9: lo que se le escribe a la pty: las imagenes por linea, y Claude Code
 *    byte por byte igual que antes.
 *  - P10: el adaptador registrado: capacidades contra un literal, lanzamiento,
 *    entorno sin variables nuevas y carpetas protegidas.
 *  - P11: la web, sin JSX.
 *  - P12: lo que el codigo de Pi no nombra nunca: credenciales, configuracion,
 *    y nada que lance un proceso.
 *
 * Trabaja con `HOME` y `USERPROFILE` en una carpeta temporal propia, fijadas
 * antes de importar nada: nunca lee ni escribe el `~/.pi` de verdad. No lanza
 * `pi` ni carga `node-pty`.
 */

import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setLocale } from '../../web/src/i18n/index.ts';

await setLocale('es');

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-pi-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
process.env['CODEX_HOME'] = path.join(root, 'codex');
for (const name of ['PI_CODING_AGENT_DIR', 'PI_CODING_AGENT_SESSION_DIR', 'OPENCODE_DB', 'OPENCODE_MODELS_PATH']) {
  delete process.env[name];
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const show = (value) => JSON.stringify(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Lo que el adaptador avisa por consola durante el chequeo, para no ensuciar la salida. */
const warnings = [];
const realWarn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(' '));

const shared = await import('@agent-workbench/shared');
const constants = await import('../src/agents/pi/constants.ts');
const paths = await import('../src/agents/pi/paths.ts');
const entries = await import('../src/agents/pi/session-entries.ts');
const { PiSessionTree, modelKey } = await import('../src/agents/pi/session-path.ts');
const { PiSessionFollower } = await import('../src/agents/pi/session-follower.ts');
const { loadPiImage } = await import('../src/agents/pi/session-image.ts');
const scan = await import('../src/agents/pi/session-scan.ts');
const historyModule = await import('../src/agents/pi/history.ts');
const catalogModule = await import('../src/agents/pi/catalog.ts');
const { locatePi } = await import('../src/agents/pi/locate.ts');
const liveModule = await import('../src/agents/pi/live.ts');
const tabWatch = await import('../src/agents/pi/tab-watch.ts');
const piIndex = await import('../src/agents/pi/index.ts');
const { TRANSPORT_LIMITS } = await import('../src/agents/transport-limits.ts');
const ptyInput = await import('../src/pty-input.ts');
const queued = await import('../src/queued-submits.ts');

// ---------------------------------------------------------------------------
// Datos de prueba
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 9, 12, 13, 0, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const line = (record) => `${JSON.stringify(record)}\n`;
const agentDir = path.join(home, '.pi', 'agent');
const sessionsRoot = path.join(agentDir, 'sessions');
const projectCwd = path.join(root, 'proyectos', 'demo');
const projectDir = path.join(sessionsRoot, paths.projectFolderName(projectCwd));
await mkdir(projectDir, { recursive: true });
await mkdir(projectCwd, { recursive: true });

const fileNameFor = (id, startedAt = T0) => `${iso(startedAt).replace(/[:.]/g, '-')}_${id}.jsonl`;
const sessionFile = (id, startedAt = T0, dir = projectDir) => path.join(dir, fileNameFor(id, startedAt));

const header = (id, cwd = projectCwd, extra = {}) => ({ type: 'session', version: 3, id, timestamp: iso(T0), cwd, ...extra });
const node = (type, id, parentId, at, body) => ({ type, id, parentId, timestamp: iso(at), ...body });
const modelChange = (id, parentId, at, provider, modelId) => node('model_change', id, parentId, at, { provider, modelId });
const thinkingChange = (id, parentId, at, thinkingLevel) => node('thinking_level_change', id, parentId, at, { thinkingLevel });
const systemMessage = (id, parentId, at) =>
  node('message', id, parentId, at, { message: { role: 'system', content: 'Eres un agente. '.repeat(40), sections: {}, toolsAdded: [], timestamp: at } });
const userMessage = (id, parentId, at, content) =>
  node('message', id, parentId, at, { message: { role: 'user', content: typeof content === 'string' ? [{ type: 'text', text: content }] : content, timestamp: at } });
const SIGNATURE = 'FIRMA-CIFRADA-QUE-NO-SE-LEE';
const assistantMessage = (id, parentId, at, options = {}) =>
  node('message', id, parentId, at, {
    message: {
      role: 'assistant',
      content: [
        ...(options.thinking ? [{ type: 'thinking', thinking: '', thinkingSignature: SIGNATURE }] : []),
        ...(options.text !== undefined ? [{ type: 'text', text: options.text, textSignature: SIGNATURE }] : []),
        ...(options.calls ?? []).map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.arguments })),
      ],
      api: 'openai-codex-responses',
      provider: options.provider ?? 'openai-codex',
      model: options.model ?? 'gpt-5.6-terra',
      usage: options.usage ?? { input: 1000, output: 20, cacheRead: 300, cacheWrite: 38, totalTokens: 1358 },
      stopReason: options.stopReason ?? 'stop',
      thinkingLevel: options.thinkingLevel ?? 'low',
      ...(options.errorMessage !== undefined ? { errorMessage: options.errorMessage } : {}),
      durationMs: 900,
      timestamp: at - 900,
    },
  });
const toolResult = (id, parentId, at, toolCallId, content, isError = false) =>
  node('message', id, parentId, at, { message: { role: 'toolResult', toolCallId, toolName: 'read', content, isError, timestamp: at } });
const bashExecution = (id, parentId, at, command, output, exitCode = 0) =>
  node('message', id, parentId, at, { message: { role: 'bashExecution', command, output, exitCode, cancelled: false, truncated: false, timestamp: at } });

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
const describe = (events) =>
  events
    .map((event) => `${event.role === 'user' ? 'U' : 'A'}:${event.parts.map((part) => (part.kind === 'text' ? part.text : part.kind === 'notice' ? `notice-${part.notice}` : part.kind)).join('+')}`)
    .join(' | ');

// ---------------------------------------------------------------------------
// P1. Rutas y nombres
// ---------------------------------------------------------------------------
{
  const windows = process.platform === 'win32';
  check('P1 la carpeta de un proyecto: sin barra inicial, y con / \\ : cambiados por -',
    windows
      ? paths.projectFolderName('D:\\Proyectos\\demo') === '--D--Proyectos-demo--'
      : paths.projectFolderName('/home/u/proyecto') === '--home-u-proyecto--',
    paths.projectFolderName(windows ? 'D:\\Proyectos\\demo' : '/home/u/proyecto'));
  check('P1 la forma de una carpeta de proyecto',
    paths.isProjectFolderName('--D--x--') && !paths.isProjectFolderName('bin') && !paths.isProjectFolderName('----'));

  const parsed = paths.parseSessionFileName('2026-10-12T18-59-53-780Z_a92a2c6b-f340-4ed0-8d05-ef259a9e1233.jsonl');
  check('P1 el nombre de un archivo dice el id y la hora de arranque',
    parsed?.sessionId === 'a92a2c6b-f340-4ed0-8d05-ef259a9e1233' && parsed.startedAt === Date.UTC(2026, 9, 12, 18, 59, 53, 780), show(parsed));
  check('P1 un id con guion bajo y punto se corta por la fecha, no por el primer _',
    paths.parseSessionFileName('2026-10-12T18-59-53-780Z_mi_sesion.v2.jsonl')?.sessionId === 'mi_sesion.v2');
  check('P1 lo que no es un archivo de sesion da null',
    ['rollout-2026-10-12T18-59-53-abc.jsonl', '2026-10-12T18-59-53-780Z_.jsonl', '2026-10-12T18-59-53-780Z_a b.jsonl',
      '2026-10-12T18-59-53-780Z_abc.json', '2026-10-12T18-59-53-780Zabc.jsonl', 'notas.jsonl'].every((name) => paths.parseSessionFileName(name) === null));

  const hostile = ['', '-x', 'x-', 'a b', 'a"b', 'a&calc', 'a|b', '../x', 'a/b', 'a\\b', '%PATH%', 'a^b', 'x'.repeat(129)];
  check('P1 un id con la forma que exige Pi pasa', ['a92a2c6b-f340-4ed0-8d05-ef259a9e1233', 'trabajo', 'a', 'mi_sesion.v2'].every(constants.isPiSessionId));
  check('P1 un id hostil no pasa: nada con espacios, comillas, barras o que empiece con guion',
    hostile.every((id) => !constants.isPiSessionId(id)), hostile.filter(constants.isPiSessionId).join(' '));

  check('P1 sin variables, la carpeta de Pi es ~/.pi/agent y las sesiones van por proyecto',
    paths.piAgentDir() === agentDir && same(paths.piSessionsLayout(), { root: sessionsRoot, flat: false }));
  process.env['PI_CODING_AGENT_DIR'] = 'relativa/pi';
  const before = warnings.length;
  check('P1 una PI_CODING_AGENT_DIR relativa no se lee, y se avisa una vez',
    paths.piAgentDir() === null && paths.piSessionsLayout() === null && paths.piAgentDir() === null && warnings.length === before + 1, show(warnings.slice(before)));
  process.env['PI_CODING_AGENT_DIR'] = '~/otra-pi';
  check('P1 Pi expande ~: se resuelve contra el home', paths.piAgentDir() === path.join(home, 'otra-pi'));
  const absolute = path.join(root, 'pi-en-otro-lado');
  process.env['PI_CODING_AGENT_DIR'] = absolute;
  check('P1 una PI_CODING_AGENT_DIR absoluta se usa', paths.piAgentDir() === absolute && paths.piModelsStorePath() === path.join(absolute, 'models-store.json'));
  delete process.env['PI_CODING_AGENT_DIR'];
  const flatDir = path.join(root, 'sesiones-sueltas');
  process.env['PI_CODING_AGENT_SESSION_DIR'] = flatDir;
  check('P1 con PI_CODING_AGENT_SESSION_DIR las sesiones van sueltas en esa carpeta',
    same(paths.piSessionsLayout(), { root: flatDir, flat: true }) && paths.sessionDirFor(projectCwd) === flatDir);
  process.env['PI_CODING_AGENT_SESSION_DIR'] = 'sesiones';
  check('P1 una carpeta de sesiones relativa tampoco se lee', paths.piSessionsLayout() === null);
  delete process.env['PI_CODING_AGENT_SESSION_DIR'];
  check('P1 la carpeta de sesiones de un proyecto', paths.sessionDirFor(projectCwd) === projectDir);
}

// ---------------------------------------------------------------------------
// P2. Las lineas y el arbol
// ---------------------------------------------------------------------------
{
  const read = (record, n = 2) => entries.readEntry(record, n, TRANSPORT_LIMITS);
  check('P2 la cabecera no es una entrada del arbol, y se lee aparte',
    read(header('s1')) === null && same(entries.readHeader(header('s1', 'D:\\x', { parentSession: 'D:\\orig.jsonl' })),
      { sessionId: 's1', cwd: 'D:\\x', version: 3, parentSession: 'D:\\orig.jsonl', startedAt: T0 }));
  check('P2 una cabecera sin id o sin cwd no vale', entries.readHeader({ type: 'session', cwd: 'x' }) === null && entries.readHeader({ type: 'session', id: 'x' }) === null);

  const user = read(userMessage('u1', null, T0 + 1000, 'hola\nsegunda linea'));
  check('P2 un mensaje del usuario: su texto con los saltos, y una copia en una linea para casarlo',
    user?.id === 'u1' && user.parentId === null && user.at === T0 + 1000 && user.fact.kind === 'user' &&
    same(user.fact.parts, [{ kind: 'text', text: 'hola\nsegunda linea', truncated: false }]) && user.fact.plain === 'hola segunda linea', show(user));
  check('P2 el contenido como string suelto tambien se lee',
    read(node('message', 'u2', 'u1', T0, { message: { role: 'user', content: 'suelto' } }))?.fact.parts[0]?.text === 'suelto');

  const pastedPath = path.join(os.tmpdir(), 'agent-workbench', 'pasted', 'tab-1', 'pegada-1-0a1b2c3d.png');
  const withImages = read(userMessage('u3', null, T0, [
    { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' },
    { type: 'text', text: `Attached image: "${pastedPath}"\nAttached image: "C:\\fotos\\otra.png"\nque ves` },
  ]));
  check('P2 imagenes: la del mensaje, y la del cuadro reconocida por su ruta; otra ruta queda como texto',
    same(withImages.fact.parts, [
      { kind: 'image', index: 0, mediaType: 'image/jpeg', source: 'content' },
      { kind: 'image', index: 0, mediaType: 'image/png', source: 'pasted' },
      { kind: 'text', text: 'Attached image: "C:\\fotos\\otra.png"\nque ves', truncated: false },
    ]), show(withImages.fact.parts));
  check('P2 las rutas de las imagenes del cuadro, en orden', same(entries.pastedImagePaths(`Attached image: "${pastedPath}"\nhola`), [pastedPath]));

  const assistant = read(assistantMessage('a1', 'u1', T0 + 2000, {
    thinking: true, text: 'listo', calls: [{ id: 'call_1|fc_1', name: 'read', arguments: { path: 'D:\\x\\nota.txt' } }], stopReason: 'toolUse',
  }));
  check('P2 una respuesta: la marca de razonamiento, el texto y la llamada con sus argumentos',
    assistant.fact.kind === 'assistant' && same(assistant.fact.parts.map((part) => part.kind), ['thinking', 'text', 'tool-call']) &&
    assistant.fact.parts[2].toolUseId === 'call_1|fc_1' && assistant.fact.parts[2].name === 'read' &&
    assistant.fact.parts[2].input === JSON.stringify({ path: 'D:\\x\\nota.txt' }, null, 2) && assistant.fact.stopReason === 'toolUse', show(assistant.fact));
  check('P2 la firma del razonamiento y la del texto no quedan en ningun lado', !JSON.stringify(assistant).includes(SIGNATURE));
  check('P2 el uso con los nombres de Pi', same(assistant.fact.usage, { input: 1000, output: 20, cacheRead: 300, cacheWrite: 38, totalTokens: 1358 }));

  const result = read(toolResult('r1', 'a1', T0 + 2100, 'call_1|fc_1', [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: 'QUJD', mimeType: 'image/png' }]));
  check('P2 un resultado: su texto, casado por el id entero, y las imagenes solo contadas',
    same(result.fact, { kind: 'toolResult', toolCallId: 'call_1|fc_1',
      part: { kind: 'tool-result', toolUseId: 'call_1|fc_1', text: 'Read image file [image/png]', isError: false, truncated: false, imageCount: 1 } }), show(result.fact));
  check('P2 un comando ! del usuario', same(read(bashExecution('b1', 'r1', T0, 'echo hola', 'hola\n')).fact,
    { kind: 'bash', command: 'echo hola', output: 'hola\n', failed: false, truncated: false }));
  check('P2 un comando que fallo', read(bashExecution('b2', 'b1', T0, 'exit 3', '', 3)).fact.failed === true);
  check('P2 modelo, nivel y nombre',
    same(read(modelChange('m1', null, T0, 'openai-codex', 'gpt-5.5')).fact, { kind: 'model', provider: 'openai-codex', modelId: 'gpt-5.5' }) &&
    same(read(thinkingChange('t1', 'm1', T0, 'high')).fact, { kind: 'thinking', level: 'high' }) &&
    same(read(node('session_info', 'i1', 't1', T0, { name: '  mi sesion ' })).fact, { kind: 'info', name: 'mi sesion' }));
  check('P2 el prompt del sistema, una etiqueta y un tipo desconocido no dibujan nada pero sostienen el arbol',
    [systemMessage('s', null, T0), node('label', 'l', 's', T0, { label: 'x' }), node('algo_nuevo', 'n', 'l', T0, {})].every((record) => read(record)?.fact.kind === 'other'));
  check('P2 compactacion y resumen de rama son un aviso',
    read(node('compaction', 'c', null, T0, { summary: 'x' })).fact.kind === 'compaction' && read(node('branch_summary', 'bs', 'c', T0, { summary: 'x' })).fact.kind === 'compaction');
  check('P2 sin id, el de respaldo sale del numero de linea; sin parentId cuelga de la anterior',
    read({ type: 'message', timestamp: iso(T0), message: { role: 'user', content: 'x' } }, 7)?.id === 'line-7' &&
    read({ type: 'message', timestamp: iso(T0), message: { role: 'user', content: 'x' } }, 7)?.parentId === undefined);
  check('P2 una linea sin tipo no es una entrada', read({ id: 'x' }) === null);
  const long = read(userMessage('u9', null, T0, 'x'.repeat(9000)));
  check('P2 el texto se recorta al tope de transporte y lo dice', long.fact.parts[0].text.length === 8000 && long.fact.parts[0].truncated === true);
  check('P2 casar un mensaje con lo que mando la app: por el principio, sin importar espacios ni las lineas de imagenes de delante',
    entries.plainMatches(entries.plainText(`Attached image: "${pastedPath}"\nhola   que\ntal`), 'hola que tal') &&
    !entries.plainMatches(entries.plainText('otra cosa'), 'hola que tal') && !entries.plainMatches('x', '   '));

  // El arbol.
  const tree = new PiSessionTree();
  const feed = (record) => tree.add(read(record));
  feed(modelChange('m', null, T0, 'openai-codex', 'gpt-6.1-sol'));
  feed(thinkingChange('t', 'm', T0, 'medium'));
  check('P2 antes del primer mensaje el medidor ya dice modelo y nivel', modelKey(tree.meter.provider, tree.meter.modelId) === 'openai-codex/gpt-6.1-sol' && tree.meter.effort === 'medium');
  feed(systemMessage('s', 't', T0 + 10));
  const u1 = feed(userMessage('u1', 's', T0 + 1000, 'primero'));
  check('P2 un mensaje con el agente libre no esta en cola', u1.rebuilt === false && u1.added.length === 1 && u1.added[0].queued === false && u1.added[0].eventId === 'u1');
  feed(assistantMessage('a1', 'u1', T0 + 2000, { calls: [{ id: 'c1', name: 'bash', arguments: { command: 'ls' } }], stopReason: 'toolUse' }));
  const steering = feed(userMessage('u2', 'a1', T0 + 2500, 'mientras trabajas'));
  check('P2 un mensaje que cuelga de una respuesta con llamadas quedo en cola', steering.added[0].queued === true);
  feed(toolResult('r1', 'u2', T0 + 3000, 'c1', [{ type: 'text', text: 'ok' }]));
  const final = feed(assistantMessage('a2', 'r1', T0 + 6000, { text: 'hecho', model: 'gpt-5.6-terra', thinkingLevel: 'low' }));
  check('P2 la respuesta que cierra el turno lleva la duracion desde el mensaje que lo abrio, y el modelo y nivel con que corrio',
    final.added.length === 1 && final.added[0].durationMs === 5000 && final.added[0].model === 'openai-codex/gpt-5.6-terra' && final.added[0].effort === 'low' &&
    same(final.added[0].usage, { inputTokens: 1000, outputTokens: 20, cacheCreationInputTokens: 38, cacheReadInputTokens: 300 }), show(final.added[0]));
  check('P2 el medidor: lo que Pi dibuja en su pie, y los acumulados',
    tree.meter.lastRequestTokens === 1358 && tree.meter.lastOutputTokens === 20 && tree.meter.assistantMessages === 2 &&
    tree.meter.totalInputTokens === 2076 && tree.meter.totalOutputTokens === 40 && tree.meter.totalCacheReadTokens === 600, show(tree.meter));

  // El orden medido con Pi 1.1.0 (16.5): el mensaje en cola se escribe despues del
  // resultado de la herramienta en curso, colgando de el, y el turno sigue.
  const measured = new PiSessionTree();
  const feedMeasured = (record) => measured.add(read(record));
  feedMeasured(userMessage('u1', null, T0 + 1000, 'primero'));
  feedMeasured(assistantMessage('a1', 'u1', T0 + 2000, { calls: [{ id: 'c1', name: 'bash', arguments: { command: 'ping' } }], stopReason: 'toolUse' }));
  feedMeasured(toolResult('r1', 'a1', T0 + 8000, 'c1', [{ type: 'text', text: 'ok' }]));
  const delivered = feedMeasured(userMessage('u2', 'r1', T0 + 8003, 'ademas'));
  const closing = feedMeasured(assistantMessage('a2', 'u2', T0 + 10000, { text: 'las dos cosas' }));
  check('P2 medido: el mensaje en cola que Pi entrega cuelga del resultado de la herramienta, sale marcado y no corta el turno',
    delivered.rebuilt === false && delivered.added[0].queued === true && closing.added[0].durationMs === 9000 &&
    describe(measured.events) === 'U:primero | A:tool-call | U:tool-result | U:ademas | A:las dos cosas', describe(measured.events));

  feed(userMessage('u3', 'a2', T0 + 7000, 'otro'));
  const aborted = feed(assistantMessage('a3', 'u3', T0 + 9000, { text: 'iba por aca', stopReason: 'aborted', errorMessage: 'Operation aborted', usage: ZERO_USAGE }));
  check('P2 una respuesta interrumpida: lo que alcanzo a escribir y un aviso aparte, con la duracion en el aviso',
    aborted.added.length === 2 && aborted.added[0].parts[0].text === 'iba por aca' && aborted.added[0].durationMs === null && aborted.added[0].usage === null &&
    same(aborted.added[1].parts, [{ kind: 'notice', notice: 'interrupted', detail: '' }]) && aborted.added[1].eventId === 'a3:notice' && aborted.added[1].durationMs === 2000, show(aborted.added));
  feed(userMessage('u4', 'a3', T0 + 10000, 'otro mas'));
  const failed = feed(assistantMessage('a4', 'u4', T0 + 10500, { stopReason: 'error', errorMessage: `El modelo no esta disponible ${'x'.repeat(400)}`, usage: ZERO_USAGE }));
  check('P2 un error del proveedor es solo un aviso, con el detalle recortado',
    failed.added.length === 1 && failed.added[0].parts[0].notice === 'error' && failed.added[0].parts[0].detail.length === 300 && failed.added[0].parts[0].detail.startsWith('El modelo no esta disponible'));
  check('P2 ni la interrumpida ni la fallida cuentan para el medidor', tree.meter.assistantMessages === 2 && tree.meter.lastRequestTokens === 1358);
  const bashEvent = feed(bashExecution('b1', 'a4', T0 + 11000, 'echo hola', 'hola\n')).added[0];
  check('P2 un comando ! va del lado del usuario con forma de herramienta, y su resultado casa con su llamada',
    bashEvent.role === 'user' && bashEvent.parts[0].kind === 'tool-call' && bashEvent.parts[0].name === 'bash' && bashEvent.parts[0].input === 'echo hola' &&
    bashEvent.parts[1].kind === 'tool-result' && bashEvent.parts[1].toolUseId === bashEvent.parts[0].toolUseId && bashEvent.parts[1].text === 'hola\n');
  check('P2 la rama entera, en orden',
    describe(tree.events) === 'U:primero | A:tool-call | U:mientras trabajas | U:tool-result | A:hecho | U:otro | A:iba por aca | A:notice-interrupted | U:otro mas | A:notice-error | U:tool-call+tool-result', describe(tree.events));

  // Una entrada que cuelga de un punto anterior: se rehace la rama.
  const branched = feed(userMessage('u5', 'a2', T0 + 20000, 'por otro camino'));
  check('P2 una entrada que cuelga de otro punto rehace la rama: lo abandonado no se muestra',
    branched.rebuilt === true && branched.added.length === 0 &&
    describe(tree.events) === 'U:primero | A:tool-call | U:mientras trabajas | U:tool-result | A:hecho | U:por otro camino', describe(tree.events));
  check('P2 al rehacer, "en cola", la duracion y el medidor salen igual que al agregar',
    tree.events[2].queued === true && tree.events[4].durationMs === 5000 && tree.meter.assistantMessages === 2 && tree.events[5].queued === false);
  const next = feed(assistantMessage('a5', 'u5', T0 + 21000, { text: 'sigo' }));
  check('P2 despues de rehacer se vuelve a agregar de a una', next.rebuilt === false && next.added.length === 1 && tree.events.length === 7);

  const capped = new PiSessionTree({ maxEvents: 3 });
  let parent = null;
  for (let index = 0; index < 6; index += 1) {
    capped.add(read(userMessage(`c${index}`, parent, T0 + index, `m${index}`)));
    parent = `c${index}`;
  }
  check('P2 con tope, quedan los ultimos y se cuenta lo descartado', capped.events.length === 3 && capped.dropped === 3 && capped.events[0].eventId === 'c3');
  const orphan = new PiSessionTree();
  orphan.add(read(userMessage('x1', null, T0, 'uno')));
  const cut = orphan.add(read(userMessage('x3', 'x2-que-no-esta', T0, 'tres')));
  check('P2 un padre que no esta corta el camino ahi, sin colgarse', cut.rebuilt === true && describe(orphan.events) === 'U:tres');
  const linearTree = new PiSessionTree();
  linearTree.add(read({ type: 'message', timestamp: iso(T0), message: { role: 'user', content: 'viejo 1' } }, 2));
  linearTree.add(read({ type: 'message', timestamp: iso(T0), message: { role: 'user', content: 'viejo 2' } }, 3));
  check('P2 un formato sin arbol se lee en el orden del archivo', describe(linearTree.events) === 'U:viejo 1 | U:viejo 2' && linearTree.events[1].eventId === 'line-3');
}

// ---------------------------------------------------------------------------
// P3. El seguidor
// ---------------------------------------------------------------------------

const storeFile = path.join(agentDir, 'models-store.json');
const packageDir = path.join(root, 'instalacion', 'node_modules', '@earendil-works', 'pi-coding-agent');
const STORE = {
  'openai-codex': {
    models: [
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000, reasoning: true },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272000 },
      { id: 'sin-ventana', name: '' },
    ],
    checkedAt: 1, lastModified: 'x', etag: 'y',
  },
};
await writeFile(storeFile, JSON.stringify(STORE));
await mkdir(path.join(packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data'), { recursive: true });
await writeFile(path.join(packageDir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.1.0', bin: { pi: 'dist/bundle/cli.js' } }));
await writeFile(
  path.join(packageDir, 'node_modules', '@earendil-works', 'pi-ai', 'dist', 'providers', 'data', 'anthropic.json'),
  JSON.stringify({ 'anthropic-messages': { 'chat:claude-x': { id: 'claude-x', contextWindow: 200000 }, 'chat:roto': { id: 'roto' } } }),
);
const newCatalog = (extra = {}) => new catalogModule.PiModelCatalog({ storeFile: () => storeFile, packageDir: () => packageDir, ...extra });

{
  const id = '11111111-1111-4111-8111-111111111111';
  const file = sessionFile(id);
  const follower = new PiSessionFollower(projectCwd, id, { catalog: newCatalog() });
  await follower.start();
  let result = await follower.poll();
  check('P3 sin archivo todavia: esperando, sin eventos y sin reinicio',
    follower.getState() === 'waiting' && result.reset === false && result.added.length === 0 && follower.label === `pi:${id.slice(0, 8)}`);

  await writeFile(file,
    line(header(id)) + line(modelChange('m', null, T0, 'openai-codex', 'gpt-5.6-terra')) + line(thinkingChange('t', 'm', T0, 'low')) +
    line(systemMessage('s', 't', T0 + 5)) + line(userMessage('u1', 's', T0 + 1000, 'hola')));
  check('P3 el aviso del watcher con su archivo lo fija sin esperar el reintento', follower.noticeChange(file) === true && follower.label === file);
  check('P3 el aviso de otro archivo no es suyo', follower.noticeChange(sessionFile('22222222-2222-4222-8222-222222222222')) === false);
  result = await follower.poll();
  check('P3 la primera lectura trae el mensaje y el medidor ya dice modelo, nivel y ventana del catalogo',
    follower.getState() === 'live' && result.added.length === 1 && result.added[0].eventId === 'u1' &&
    same(follower.getUsage(), { ...shared.EMPTY_CONTEXT_USAGE, lastModel: 'openai-codex/gpt-5.6-terra', contextWindow: 272000, lastEffort: 'low' }), show(follower.getUsage()));

  await appendFile(file, line(assistantMessage('a1', 'u1', T0 + 3000, { text: 'buenas' })));
  result = await follower.poll();
  check('P3 la respuesta llega sola, con su uso', result.added.length === 1 && follower.getUsage().lastRequestTokens === 1358 && follower.getUsage().assistantMessages === 1 && result.usageChanged === false);

  await appendFile(file, line(thinkingChange('t2', 'a1', T0 + 4000, 'high')));
  result = await follower.poll();
  check('P3 un /thinking escribe su entrada en el acto: el uso cambia sin eventos', result.added.length === 0 && result.usageChanged === true && follower.getUsage().lastEffort === 'high');
  await appendFile(file, line(modelChange('m2', 't2', T0 + 4100, 'anthropic', 'claude-x')));
  await follower.poll();
  check('P3 un modelo que no esta en el catalogo de la cuenta toma la ventana del paquete instalado',
    follower.getUsage().lastModel === 'anthropic/claude-x' && follower.getUsage().contextWindow === 200000, show(follower.getUsage()));
  await appendFile(file, line(modelChange('m3', 'm2', T0 + 4200, 'propio', 'modelo-local')));
  await follower.poll();
  check('P3 un modelo que nadie conoce queda sin ventana, nunca con una inventada', follower.getUsage().contextWindow === null);
  result = await follower.poll();
  check('P3 sin nada nuevo no hay nada que avisar', result.added.length === 0 && result.usageChanged === false && result.reset === false);

  // Media linea: no se lee hasta que llega su salto.
  const half = line(userMessage('u2', 'm3', T0 + 5000, 'partido en dos'));
  await appendFile(file, half.slice(0, 40));
  result = await follower.poll();
  const afterHalf = result.added.length;
  await appendFile(file, half.slice(40));
  result = await follower.poll();
  check('P3 una linea a medio escribir espera a su salto', afterHalf === 0 && result.added.length === 1 && result.added[0].parts[0].text === 'partido en dos');

  await appendFile(file, line(userMessage('u3', 'a1', T0 + 6000, 'desde antes')));
  result = await follower.poll();
  const tail = follower.getTail(50);
  check('P3 una entrada que cuelga de otro punto pide rehacer la vista, y la cola es la rama nueva',
    result.reset === true && result.added.length === 0 && describe(tail.events) === 'U:hola | A:buenas | U:desde antes' && tail.hasMore === false, describe(tail.events));
  check('P3 paginar hacia atras', same(follower.getPageBefore('u3', 1).events.map((event) => event.eventId), ['a1']) && follower.getPageBefore('u3', 1).hasMore === true &&
    follower.getPageBefore('u1', 5).events.length === 0 && follower.getPageBefore('no-esta', 5).events.length === 0);
  check('P3 Pi no pide permisos: nunca hay una llamada que frene el cuadro, ni modo, ni planes',
    follower.hasOpenToolCall(0) === false && follower.getPermissionMode() === null && follower.getPlanFiles().length === 0);

  // Reescrito sin encoger (una migracion de formato): la huella lo ve.
  await writeFile(file,
    line(header(id, projectCwd, { version: 4 })) + line(userMessage('n1', null, T0 + 1000, `nuevo contenido ${'x'.repeat(4000)}`)));
  result = await follower.poll();
  check('P3 reescrito mas grande con otra cabecera: reinicia por la huella',
    result.reset === true && follower.getTail(10).events.length === 1 && follower.getTail(10).events[0].eventId === 'n1');
  await rm(file);
  result = await follower.poll();
  check('P3 si el archivo desaparece, se descarta lo leido', result.reset === true && follower.getState() === 'waiting' && follower.getTail(10).events.length === 0);
}

{
  // Los topes del respaldo, y el tope de eventos.
  const id = '33333333-3333-4333-8333-333333333333';
  const file = sessionFile(id);
  const bigText = 'y'.repeat(20000);
  let body = line(header(id));
  let parent = null;
  for (let index = 0; index < 30; index += 1) {
    body += line(userMessage(`u${index}`, parent, T0 + index * 10, index === 0 ? bigText : `mensaje ${index}`));
    parent = `u${index}`;
  }
  await writeFile(file, body);
  const transport = new PiSessionFollower(projectCwd, id, { catalog: newCatalog() });
  await transport.start();
  await transport.poll();
  check('P3 el hilo recorta a los topes de transporte', transport.getTail(100).events[0].parts[0].text.length === 8000 && transport.getTail(100).events[0].parts[0].truncated === true);
  const whole = new PiSessionFollower(projectCwd, id, {
    catalog: newCatalog(),
    limits: { textMaxChars: Infinity, toolInputMaxChars: Infinity, toolResultMaxChars: Infinity },
    maxEvents: Infinity,
  });
  await whole.start();
  await whole.poll();
  check('P3 con FollowOptions sin tope, el texto llega entero (wholeRead)',
    whole.getTail(100).events[0].parts[0].text.length === 20000 && whole.getTail(100).events[0].parts[0].truncated === false && whole.getTail(1000).events.length === 30);
  const small = new PiSessionFollower(projectCwd, id, { catalog: newCatalog(), maxEvents: 10 });
  await small.start();
  await small.poll();
  check('P3 con tope de eventos quedan los ultimos y se dice que hay mas', small.getTail(100).events.length === 10 && small.getTail(100).hasMore === true && small.getTail(100).events[0].eventId === 'u20');
  const noSession = new PiSessionFollower(projectCwd, '', { catalog: newCatalog() });
  await noSession.start();
  await noSession.poll();
  check('P3 sin id de sesion no busca nada', noSession.getState() === 'waiting' && noSession.label === 'pi:(no session)' && noSession.noticeChange(file) === false);
  const hostile = new PiSessionFollower(projectCwd, '../../auth', { catalog: newCatalog() });
  await hostile.start();
  check('P3 un id hostil no arma ninguna ruta', hostile.label === 'pi:../../au' && (await hostile.poll()).added.length === 0);
}

{
  // Imagenes.
  const id = '44444444-4444-4444-8444-444444444444';
  const file = sessionFile(id);
  const pastedDir = path.join(root, 'pegado');
  const tabDir = path.join(pastedDir, 'tab-1');
  await mkdir(tabDir, { recursive: true });
  // Un PNG de 1x1.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');
  // Las rutas tienen que tener la forma de las de `PasteStore`: `…/agent-workbench/pasted/<pestana>/pegada-N-<8 hex>.<ext>`.
  const realRoot = path.join(root, 'agent-workbench', 'pasted');
  const realTab = path.join(realRoot, 'tab-1');
  await mkdir(realTab, { recursive: true });
  const onDisk = path.join(realTab, 'pegada-1-0a1b2c3d.png');
  const gone = path.join(realTab, 'pegada-2-0a1b2c3e.png');
  const never = path.join(realTab, 'pegada-3-0a1b2c3f.png');
  await writeFile(onDisk, png);
  const secret = path.join(root, 'secreto.png');
  await writeFile(secret, png);
  const escape = path.join(realTab, '..', '..', '..', 'secreto.png');
  await writeFile(file,
    line(header(id)) +
    line(userMessage('u1', null, T0, [{ type: 'image', data: png.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: 'pegada en la CLI' }])) +
    line(userMessage('u2', 'u1', T0 + 10, `Attached image: "${onDisk}"\nAttached image: "${gone}"\nAttached image: "${never}"\nmira estas`)) +
    line(assistantMessage('a1', 'u2', T0 + 20, { calls: [{ id: 'c-gone', name: 'read', arguments: { path: gone } }], stopReason: 'toolUse' })) +
    line(toolResult('r1', 'a1', T0 + 30, 'c-gone', [{ type: 'text', text: 'Read image file [image/png]' }, { type: 'image', data: 'TEFJTUFHRU4=', mimeType: 'image/png' }])));
  const fromContent = await loadPiImage(file, 'u1', 0, 'content', realRoot);
  check('P3 una imagen del propio mensaje sale de su bloque', fromContent?.data === png.toString('base64') && fromContent.mediaType === 'image/png');
  check('P3 un indice que no existe da null', (await loadPiImage(file, 'u1', 3, 'content', realRoot)) === null && (await loadPiImage(file, 'u1', -1, 'content', realRoot)) === null);
  const fromDisk = await loadPiImage(file, 'u2', 0, 'pasted', realRoot);
  check('P3 una imagen del cuadro sale del archivo que dejo PasteStore, mientras exista', fromDisk?.data === png.toString('base64'));
  const fromRead = await loadPiImage(file, 'u2', 1, 'pasted', realRoot);
  check('P3 si ese archivo ya no esta, sale del resultado de la lectura del modelo', fromRead?.data === 'TEFJTUFHRU4=', show(fromRead));
  check('P3 sin archivo y sin lectura, la imagen ya no esta', (await loadPiImage(file, 'u2', 2, 'pasted', realRoot)) === null);
  check('P3 un evento que no existe, o una fuente que Pi no tiene, dan null',
    (await loadPiImage(file, 'no-esta', 0, 'content', realRoot)) === null && (await loadPiImage(file, 'u1', 0, 'attachment', realRoot)) === null &&
    (await loadPiImage(path.join(root, 'no-hay.jsonl'), 'u1', 0, 'content', realRoot)) === null);
  check('P3 una ruta que sale de la carpeta de lo pegado no se reconoce como imagen del cuadro',
    entries.pastedImagePaths(`Attached image: "${escape}"`).length === 0 && entries.pastedImagePaths(`Attached image: "${secret}"`).length === 0);
  void tabDir;
}

// ---------------------------------------------------------------------------
// P4. El historial
// ---------------------------------------------------------------------------
{
  const history = historyModule.createPiHistory(newCatalog());
  const roots = history.roots();
  check('P4 una raiz: sessions/, con profundidad 1 y filtro de recorrido', roots.length === 1 && roots[0].path === sessionsRoot && roots[0].depth === 1 && typeof roots[0].ignore === 'function');
  const slash = (value) => value.split(path.sep).join('/');
  const inProject = path.join(projectDir, fileNameFor('55555555-5555-4555-8555-555555555555'));
  check('P4 el recorrido entra a las carpetas de proyecto y mira solo sus .jsonl de sesion',
    roots[0].ignore(slash(sessionsRoot)) === false && roots[0].ignore(slash(projectDir)) === false && roots[0].ignore(slash(inProject)) === false &&
    roots[0].ignore(slash(path.join(sessionsRoot, 'otra-cosa'))) === true && roots[0].ignore(slash(path.join(projectDir, 'notas.txt'))) === true &&
    roots[0].ignore(slash(path.join(projectDir, 'sub', 'x.jsonl'))) === true && roots[0].ignore(slash(path.join(agentDir, 'auth.json'))) === true);
  check('P4 acepta solo archivos de sesion', roots[0].accepts(inProject) === true && roots[0].accepts(path.join(projectDir, 'x.jsonl')) === false);
  check('P4 declara wholeRead, relee cada segundo y no tiene planes', history.wholeRead === true && history.followPollMs === 1000 && history.plans === null);

  const named = '66666666-6666-4666-8666-666666666666';
  const plain = '77777777-7777-4777-8777-777777777777';
  const empty = '88888888-8888-4888-8888-888888888888';
  const foreign = '99999999-9999-4999-8999-999999999999';
  await writeFile(sessionFile(named),
    line(header(named)) + line(userMessage('u1', null, T0, 'el primer mensaje')) + line(node('session_info', 'i1', 'u1', T0, { name: 'viejo' })) +
    line(assistantMessage('a1', 'i1', T0 + 10, { text: 'ok' })) + line(node('session_info', 'i2', 'a1', T0 + 20, { name: 'Refactor del login' })));
  await writeFile(sessionFile(plain),
    line(header(plain)) + line(modelChange('m', null, T0, 'x', 'y')) + line(systemMessage('s', 'm', T0)) +
    line(userMessage('u1', 's', T0, `Attached image: "${path.join(os.tmpdir(), 'agent-workbench', 'pasted', 't', 'pegada-1-0a1b2c3d.png')}"\n  Arregla el\n  boton  `)));
  await writeFile(sessionFile(empty), line(header(empty)) + line(modelChange('m', null, T0, 'x', 'y')));
  await writeFile(sessionFile(foreign), line(header('otro-id-adentro')) + line(userMessage('u1', null, T0, 'hola')));
  await writeFile(path.join(projectDir, 'no-es-sesion.jsonl'), 'x\n');
  await mkdir(path.join(sessionsRoot, 'no-es-proyecto'), { recursive: true });
  await writeFile(path.join(sessionsRoot, 'no-es-proyecto', fileNameFor(named)), line(header(named)));

  const items = await history.list();
  const byId = new Map(items.map((item) => [item.sessionId, item]));
  check('P4 lista los archivos de sesion de las carpetas de proyecto, y nada mas',
    byId.has(named) && byId.has(plain) && byId.has(empty) && byId.has(foreign) && items.every((item) => item.group === path.basename(projectDir) && item.ref.startsWith(projectDir)), show(items.map((item) => item.sessionId)));
  const scanned = await history.scan(byId.get(named));
  check('P4 el titulo es el ultimo /name, y la carpeta sale de la primera linea',
    scanned.cwd === projectCwd && scanned.summary.title === 'Refactor del login' && scanned.summary.titleSource === 'custom' && scanned.summary.sessionId === named, show(scanned));
  const scannedPlain = await history.scan(byId.get(plain));
  check('P4 sin nombre, el primer mensaje del usuario, sin las lineas de imagenes',
    scannedPlain.summary.title === 'Arregla el boton' && scannedPlain.summary.titleSource === 'first-message', show(scannedPlain.summary));
  const scannedEmpty = await history.scan(byId.get(empty));
  check('P4 sin ningun mensaje, sin titulo', scannedEmpty.summary.titleSource === 'none' && scannedEmpty.summary.title.length > 0);
  check('P4 un archivo cuyo id de adentro no es el del nombre no se lista', (await history.scan(byId.get(foreign))) === null);
  check('P4 changedRefs: el propio archivo, y null para lo que no es de aca',
    same(await history.changedRefs(sessionFile(named)), [sessionFile(named)]) && (await history.changedRefs(path.join(projectDir, 'x.txt'))) === null &&
    (await history.changedRefs(path.join(root, fileNameFor(named)))) === null);
  check('P4 exists: por id, en la carpeta del proyecto o en cualquier otra',
    (await history.exists(projectCwd, named)) === true && (await history.exists(path.join(root, 'otro-cwd'), named)) === true &&
    (await history.exists(projectCwd, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')) === false && (await history.exists(projectCwd, '../x')) === false);
  check('P4 item de una ref que ya no esta da null', (await history.item(path.join(projectDir, fileNameFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')))) === null);

  process.env['PI_CODING_AGENT_DIR'] = path.join(root, 'pi-vacia');
  check('P4 sin la carpeta de sesiones, list da null: la raiz no existe', (await history.list()) === null);
  process.env['PI_CODING_AGENT_DIR'] = 'relativa';
  check('P4 con la carpeta de Pi relativa no hay raices ni lista', history.roots().length === 0 && (await history.list()) === null);
  delete process.env['PI_CODING_AGENT_DIR'];

  const flatDir = path.join(root, 'sesiones-sueltas');
  await mkdir(flatDir, { recursive: true });
  await writeFile(path.join(flatDir, fileNameFor(named)), line(header(named)));
  process.env['PI_CODING_AGENT_SESSION_DIR'] = flatDir;
  const flatRoots = history.roots();
  check('P4 con la carpeta de sesiones propia: sin profundidad, y se lista suelta',
    flatRoots.length === 1 && flatRoots[0].depth === 0 && flatRoots[0].path === flatDir && (await history.list()).length === 1);
  delete process.env['PI_CODING_AGENT_SESSION_DIR'];
}

// ---------------------------------------------------------------------------
// P5. El catalogo y la localizacion
// ---------------------------------------------------------------------------
{
  const models = catalogModule.storeModels(STORE);
  check('P5 los modelos de la cuenta, con nombre y ventana',
    same(models, [
      { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 272000 },
      { provider: 'openai-codex', id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', contextWindow: 272000 },
      { provider: 'openai-codex', id: 'sin-ventana', name: 'sin-ventana', contextWindow: null },
    ]), show(models));
  check('P5 un archivo que no tiene esa forma no da nada', catalogModule.storeModels(null).length === 0 && catalogModule.storeModels({ x: { models: 'no' } }).length === 0 && catalogModule.storeModels([1]).length === 0);
  const options = catalogModule.modelOptions(models);
  check('P5 las opciones del combo: proveedor/id como valor y como familia, el nombre y la ventana',
    same(options[0], { value: 'openai-codex/gpt-5.5', label: 'GPT-5.5', family: 'openai-codex/gpt-5.5', long: false, window: 272000 }) && options.length === 3, show(options));
  const several = catalogModule.modelOptions([...models, { provider: 'openai', id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 400000 }, { provider: 'openai', id: 'con espacio', name: 'x', contextWindow: 1 }, models[0]]);
  check('P5 con mas de un proveedor la etiqueta lo dice; sin repetidos ni valores con espacios',
    several.length === 4 && several[0].label === 'GPT-5.5 (openai-codex)' && several[3].label === 'GPT-5.5 (openai)' && several[3].value === 'openai/gpt-5.5', show(several.map((each) => each.label)));
  check('P5 casar lo observado con el combo: la opcion exacta, y la mas larga si una contiene a otra',
    shared.modelOptionFor('openai-codex/gpt-5.5', several)?.value === 'openai-codex/gpt-5.5' &&
    shared.modelOptionFor('openai-codex/gpt-5.5-codex', [...several, { value: 'openai-codex/gpt-5.5-codex', label: 'x', family: 'openai-codex/gpt-5.5-codex', long: false, window: null }])?.value === 'openai-codex/gpt-5.5-codex' &&
    shared.modelOptionFor('propio/local', several) === null);
  check('P5 el tope de la lista', catalogModule.modelOptions(Array.from({ length: 400 }, (_, index) => ({ provider: 'p', id: `m${index}`, name: `m${index}`, contextWindow: null }))).length === catalogModule.PI_MODEL_LIST_MAX);
  check('P5 las ventanas del catalogo del paquete', same([...catalogModule.packageWindows({ api: { 'chat:a': { id: 'a', contextWindow: 10 }, 'chat:b': { id: 'b' } } })], [['a', 10]]));

  const opened = [];
  let clock = 1_000;
  let stamp = 1;
  const { readFile } = await import('node:fs/promises');
  const catalog = newCatalog({
    readFile: (file) => { opened.push(file); return readFile(file, 'utf8'); },
    stat: async () => ({ mtimeMs: stamp, size: 10 }),
    now: () => clock,
  });
  check('P5 antes de leer nada la lista esta vacia', catalog.list().length === 0);
  check('P5 la primera lectura dice que la lista cambio', (await catalog.reload()) === true && catalog.list().length === 3);
  check('P5 releer sin cambios no vuelve a abrir el archivo', (await catalog.reload()) === false && opened.length === 1);
  check('P5 la ventana por proveedor y modelo, y null para lo que no esta',
    (await catalog.contextWindow('openai-codex', 'gpt-5.5')) === 272000 && (await catalog.contextWindow('openai-codex', 'sin-ventana')) === null &&
    (await catalog.contextWindow(null, 'gpt-5.5')) === null && (await catalog.contextWindow('openai-codex', null)) === null);
  check('P5 lo que falta se busca en el archivo de ese proveedor del paquete, una sola vez',
    (await catalog.contextWindow('anthropic', 'claude-x')) === 200000 && (await catalog.contextWindow('anthropic', 'roto')) === null &&
    (await catalog.contextWindow('anthropic', 'claude-x')) === 200000 && opened.filter((file) => file.endsWith('anthropic.json')).length === 1);
  check('P5 un id de proveedor que no puede ir en un nombre de archivo no abre nada',
    (await catalog.contextWindow('../../auth', 'x')) === null && (await catalog.contextWindow('a/b', 'x')) === null && !opened.some((file) => file.includes('auth')));
  // El catalogo del paquete puede estar dentro de sus dependencias o al lado: se prueban las dos.
  const packageData = `${path.sep}${['pi-ai', 'dist', 'providers', 'data'].join(path.sep)}${path.sep}`;
  check('P5 lo unico que se abre: models-store.json y el archivo de un proveedor del paquete',
    opened.every((file) => file === storeFile || (file.startsWith(path.dirname(packageDir)) && file.includes(packageData) && /^[a-z-]+\.json$/.test(path.basename(file)))), show(opened));
  stamp = 2;
  await writeFile(storeFile, JSON.stringify({ 'openai-codex': { models: [{ id: 'gpt-7', contextWindow: 500000 }] } }));
  check('P5 dentro del plazo no se vuelve a mirar', (await catalog.contextWindow('openai-codex', 'gpt-7')) === null);
  clock += catalogModule.PI_CATALOG_RECHECK_MS + 1;
  check('P5 pasado el plazo, un archivo que cambio se relee', (await catalog.contextWindow('openai-codex', 'gpt-7')) === 500000 && catalog.list().length === 1);
  await writeFile(storeFile, '{ a medio escribir');
  stamp = 3;
  check('P5 un archivo roto deja el catalogo vacio, sin lanzar', (await catalog.reload()) === true && catalog.list().length === 0);
  await writeFile(storeFile, JSON.stringify(STORE));
  const missing = new catalogModule.PiModelCatalog({ storeFile: () => path.join(root, 'no-hay.json'), packageDir: () => null });
  check('P5 sin archivo y sin paquete: nada, sin lanzar', (await missing.reload()) === false && (await missing.contextWindow('a', 'b')) === null);

  // Localizar.
  const { readFile: read } = await import('node:fs/promises');
  const installDir = path.join(root, 'instalacion');
  const shim = path.join(installDir, process.platform === 'win32' ? 'pi.cmd' : 'pi');
  await writeFile(shim, '@echo off\r\n');
  const reads = [];
  const deps = (found) => ({ findInPath: async () => found, readFile: (file) => { reads.push(file); return read(file, 'utf8'); }, realpath: async (file) => file });
  const npm = await locatePi(deps(shim));
  check('P5 instalada con npm: la version sale del package.json que esta junto al shim',
    npm?.version === '1.1.0' && npm.resolvedPath === shim && npm.packageDir === packageDir, show(npm));
  check('P5 un shim .cmd se lanza por el interprete de comandos; un ejecutable, directo',
    process.platform === 'win32' ? npm.prefixArgs.length === 2 && npm.prefixArgs[0] === '/c' && npm.prefixArgs[1] === shim : npm.file === shim && npm.prefixArgs.length === 0, show(npm));
  check('P5 sin pi en el PATH, null', (await locatePi(deps(null))) === null);

  const otherDir = path.join(root, 'otro-pi');
  await mkdir(path.join(otherDir, 'node_modules', '@earendil-works', 'pi-coding-agent'), { recursive: true });
  await writeFile(path.join(otherDir, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json'), JSON.stringify({ name: 'otro-paquete', version: '9.9.9' }));
  await writeFile(path.join(otherDir, 'pi.cmd'), '');
  const warnedBefore = warnings.length;
  check('P5 otro programa que se llama pi no es Pi: null, y se avisa una vez',
    (await locatePi(deps(path.join(otherDir, 'pi.cmd')))) === null && (await locatePi(deps(path.join(otherDir, 'pi.cmd')))) === null && warnings.length === warnedBefore + 1, show(warnings.slice(warnedBefore)));

  const managed = path.join(root, 'pi-managed');
  const release = path.join(managed, 'install', 'releases', '1.2.0', 'node_modules', '@earendil-works', 'pi-coding-agent');
  await mkdir(release, { recursive: true });
  await mkdir(path.join(managed, 'bin'), { recursive: true });
  await writeFile(path.join(release, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.2.0' }));
  await writeFile(path.join(managed, 'install', 'current-version'), '1.2.0\r\n');
  await writeFile(path.join(managed, 'bin', 'pi.cmd'), '');
  const fromInstaller = await locatePi(deps(path.join(managed, 'bin', 'pi.cmd')));
  check('P5 instalada con el instalador de pi.dev: la version vigente y su paquete', fromInstaller?.version === '1.2.0' && fromInstaller.packageDir === release, show(fromInstaller));
  await writeFile(path.join(managed, 'install', 'current-version'), '..\\..\\x');
  check('P5 una version que no puede ir en una ruta no arma ninguna', (await locatePi(deps(path.join(managed, 'bin', 'pi.cmd')))) === null);

  const linked = path.join(root, 'bin', 'pi');
  const viaLink = await locatePi({ findInPath: async () => linked, readFile: (file) => read(file, 'utf8'), realpath: async () => path.join(packageDir, 'dist', 'bundle', 'cli.js') });
  check('P5 un enlace al ejecutable del paquete: se sube desde su destino', viaLink?.version === '1.1.0' && viaLink.packageDir === packageDir);
  check('P5 para localizar solo se abren package.json y current-version',
    reads.every((file) => path.basename(file) === 'package.json' || path.basename(file) === 'current-version'), show(reads.map((file) => path.basename(file))));
}

// ---------------------------------------------------------------------------
// P6. El estado, desde el archivo
// ---------------------------------------------------------------------------
{
  let clock = T0 + 60_000;
  const launchedAt = clock;
  const live = new liveModule.PiLiveSessions({ now: () => clock, pollMs: 3_600_000 });
  const source = new liveModule.PiStatusSource(live);

  // Una sesion reanudada: lo que traia es de otro proceso.
  const resumed = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const file = sessionFile(resumed);
  await writeFile(file, line(header(resumed)) + line(userMessage('u0', null, T0 + 1000, 'quedo a medias ayer')));
  const seen = [];
  const stop = source.subscribe(resumed, (status) => seen.push(status === null ? 'sin proceso' : `${status.activity}${status.waitingFor ? `:${status.waitingFor}` : ''}`));
  check('P6 antes de que la sesion tenga proceso, la fuente dice que no hay', same(seen, ['sin proceso']));
  live.attach(resumed, { cwd: projectCwd, launchedAt });
  await live.tick();
  check('P6 una sesion que quedo a medias con otro proceso no esta trabajando al reabrirla', same(live.statusOf(resumed), { activity: 'idle', waitingFor: null }) && live.fileOf(resumed) === file);

  // Las horas de las entradas se cuentan desde el lanzamiento, aunque el reloj avance despues.
  const at = (offset) => launchedAt + offset;
  await appendFile(file, line(userMessage('u1', 'u0', at(1000), 'hola')));
  await live.tick();
  check('P6 desde el mensaje del usuario, trabajando', live.statusOf(resumed).activity === 'busy');
  await appendFile(file, line(assistantMessage('a1', 'u1', at(2000), { calls: [{ id: 'c1', name: 'bash', arguments: {} }], stopReason: 'toolUse' })));
  await live.tick();
  await appendFile(file, line(toolResult('r1', 'a1', at(3000), 'c1', [{ type: 'text', text: 'ok' }])));
  await live.tick();
  check('P6 con una llamada y su resultado sigue trabajando', live.statusOf(resumed).activity === 'busy');
  await appendFile(file, line(assistantMessage('a2', 'r1', at(4000), { text: 'listo' })));
  await live.tick();
  check('P6 la respuesta que cierra el turno la deja libre', live.statusOf(resumed).activity === 'idle');

  await appendFile(file, line(userMessage('u2', 'a2', at(5000), 'otra')) + line(assistantMessage('a3', 'u2', at(6000), { stopReason: 'error', errorMessage: 'rate limit', usage: ZERO_USAGE })));
  await live.tick();
  check('P6 tras un error del proveedor se espera: Pi puede reintentar sola', live.statusOf(resumed).activity === 'busy');
  clock += liveModule.PI_ERROR_CALM_MS + 10;
  await live.tick();
  check('P6 pasada la calma, libre', live.statusOf(resumed).activity === 'idle');

  live.setBlocked(resumed, true);
  check('P6 con el dialogo de confianza abierto, esperando al usuario', same(live.statusOf(resumed), { activity: 'waiting', waitingFor: liveModule.PI_TRUST_WAITING }));
  live.setBlocked(resumed, false);
  await appendFile(file, line(bashExecution('b1', 'a3', at(7000), 'echo x', 'x\n')));
  await live.tick();
  check('P6 un comando ! no la pone a trabajar', live.statusOf(resumed).activity === 'idle');
  check('P6 los cambios se avisan una vez cada uno, en orden',
    same(seen, ['sin proceso', 'idle', 'busy', 'idle', 'busy', 'idle', 'waiting:trust dialog', 'idle']), show(seen));

  // Que llego a la sesion.
  const sentA = { text: 'hola', at: at(900) };
  const sentB = { text: 'en cola\ncon dos lineas', at: at(4500) };
  check('P6 lo que la app mando y esta en la sesion, llego; lo que no esta, no',
    live.delivered(resumed, sentA) === true && live.delivered(resumed, sentB) === false && live.delivered(resumed, { text: 'hola', at: at(60_000) }) === false);
  check('P6 hubo algun mensaje desde tal momento', live.userMessageSince(resumed, at(4000)) === true && live.userMessageSince(resumed, at(9000)) === false);
  const interruptedAt = at(8000);
  let outcome = await live.check(resumed, [sentA, sentB], interruptedAt);
  check('P6 despues de interrumpir, mientras el archivo no cierra el turno, no esta asentado', outcome.settled === false && same(outcome.undelivered, ['en cola\ncon dos lineas']), show(outcome));
  await appendFile(file, line(userMessage('u3', 'b1', interruptedAt - 3000, 'larga')) + line(assistantMessage('a4', 'u3', interruptedAt + 60, { stopReason: 'aborted', errorMessage: 'Operation aborted', usage: ZERO_USAGE })));
  outcome = await live.check(resumed, [sentA, sentB], interruptedAt);
  check('P6 con la respuesta interrumpida escrita: asentado, y el mensaje en cola no llego', outcome.settled === true && same(outcome.undelivered, ['en cola\ncon dos lineas']), show(outcome));
  // Lo que mandan los combos (`/thinking`, `/model`) y un `!comando` pasan por el mismo cuadro,
  // pero Pi no los escribe como mensajes: que no esten en la sesion no quiere decir que quedaron en cola.
  const commands = [{ text: '/thinking high', at: at(4600) }, { text: '  /model openai-codex/gpt-5.5', at: at(4700) }, { text: '!echo hola', at: at(4800) }];
  outcome = await live.check(resumed, [...commands, sentB], interruptedAt);
  check('P6 un comando de barra o de shell nunca cuenta como mensaje sin entregar', same(outcome.undelivered, ['en cola\ncon dos lineas']), show(outcome));
  check('P6 que es un comando para Pi',
    ['/model x', ' /thinking', '!ls', '\n!!ls'].every(liveModule.isPiCommandText) && !['hola /model', 'ruta: C:/x', '¡hola!', ''].some(liveModule.isPiCommandText));
  check('P6 de una sesion sin proceso no se dice nada', same(await live.check('no-esta', [sentA], 0), { settled: false, undelivered: [] }));

  // Una sesion nueva: sin archivo hasta el primer mensaje.
  const fresh = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  live.attach(fresh, { cwd: projectCwd, launchedAt: clock });
  await live.tick();
  check('P6 una sesion nueva sin archivo esta libre', live.statusOf(fresh).activity === 'idle' && live.fileOf(fresh) === null);
  await writeFile(sessionFile(fresh), line(header(fresh)) + line(systemMessage('s', null, clock + 100)) + line(userMessage('u1', 's', clock + 200, 'primero')));
  await live.tick();
  check('P6 cuando nace su archivo, todo lo que trae es de este proceso', live.statusOf(fresh).activity === 'busy' && live.fileOf(fresh) === sessionFile(fresh));

  // Un archivo que se encuentra tarde se lee desde el principio: lo viejo se descarta por su hora.
  {
    let found = null;
    const lateLive = new liveModule.PiLiveSessions({ now: () => clock, pollMs: 3_600_000, findFile: async () => found });
    const lateId = 'abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd';
    const lateFile = sessionFile(lateId);
    await writeFile(lateFile, line(header(lateId)) + line(userMessage('u0', null, clock - 3_600_000, 'de hace una hora')));
    lateLive.attach(lateId, { cwd: projectCwd, launchedAt: clock });
    await lateLive.tick();
    found = lateFile;
    await lateLive.tick();
    check('P6 si el archivo se encuentra tarde, lo de antes del lanzamiento igual no cuenta', lateLive.statusOf(lateId).activity === 'idle' && lateLive.fileOf(lateId) === lateFile);
    await appendFile(lateFile, line(userMessage('u1', 'u0', clock + 100, 'de ahora')));
    await lateLive.tick();
    check('P6 y lo de despues, si', lateLive.statusOf(lateId).activity === 'busy');
    lateLive.dispose();
  }

  live.detach(resumed);
  check('P6 al soltarla, la fuente vuelve a decir que no hay proceso', live.statusOf(resumed) === null && seen.at(-1) === 'sin proceso');
  check('P6 "lista para recibir" no se promete nunca', (await source.waitUntilReady(fresh, 10)) === false);
  stop();
  source.dispose();
  check('P6 al soltar todo no queda ninguna sesion', live.statusOf(fresh) === null);
}

// ---------------------------------------------------------------------------
// P7. El gancho de la pestana
// ---------------------------------------------------------------------------
{
  const TITLE = ' \x1b[1mTrust project folder?\x1b[22m\x1b[K\r\n';
  const STARTED = '\x1b[?1049h\x1b[2J';
  check('P7 el dialogo de confianza abierto: su titulo, sin que la interfaz haya arrancado despues',
    tabWatch.trustDialogOpen(`Warning: ...\r\n${TITLE} → Trust\r\n`) === true && tabWatch.interfaceStarted(`${TITLE}`) === false);
  check('P7 contestado: la interfaz arranco despues del titulo', tabWatch.trustDialogOpen(`${TITLE}${STARTED}cabecera`) === false && tabWatch.interfaceStarted(`${TITLE}${STARTED}`) === true);
  check('P7 sin dialogo no hay nada abierto', tabWatch.trustDialogOpen(`${STARTED}cabecera`) === false && tabWatch.trustDialogOpen('') === false && tabWatch.interfaceStarted('') === false);
  check('P7 si el titulo vuelve a salir despues de arrancar, esta abierto otra vez', tabWatch.trustDialogOpen(`${STARTED}${TITLE}`) === true);

  let clock = T0 + 500_000;
  const launchedAt = clock;
  const live = new liveModule.PiLiveSessions({ now: () => clock, pollMs: 3_600_000, findFile: async () => null });
  const tabs = new Set();
  const dir = path.join(root, 'carpeta-de-sesiones');
  const own = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const fileOf = (id) => path.join(dir, fileNameFor(id));
  const make = (sessionId, options = {}) => {
    const state = { output: '', reported: [], files: [], peeks: new Map() };
    const watch = new tabWatch.PiTabWatch(
      { terminalId: `tab-${sessionId.slice(0, 4)}`, sessionId, cwd: options.cwd ?? projectCwd, launchedAt, readOutput: () => state.output, reportSessionId: (id) => state.reported.push(id) },
      { live, tabs: () => tabs, listSessions: async () => state.files, peek: async (file) => state.peeks.get(file) ?? null, sessionDir: () => dir, now: () => clock, timers: false },
    );
    tabs.add(watch);
    return { watch, state };
  };
  const info = (id, size, mtimeMs = clock) => ({ file: fileOf(id), size, mtimeMs });
  const peekOf = (id, lastUser, extra = {}) => ({ header: { sessionId: id, cwd: projectCwd, version: 3, parentSession: null, startedAt: T0, ...extra }, lastUser });

  const { watch, state } = make(own);
  state.files = [info(own, 100), info('ffffffff-ffff-4fff-8fff-ffffffffffff', 500, launchedAt - 600_000)];
  watch.start();
  await watch.scan();
  check('P7 la primera pasada solo saca la foto de la carpeta', state.reported.length === 0 && watch.currentFile === fileOf(own));

  // El dialogo, por la salida.
  state.output = `${TITLE}`;
  watch.checkTrust();
  check('P7 con el dialogo en la salida, la pestana queda esperando', same(live.statusOf(own), { activity: 'waiting', waitingFor: 'trust dialog' }));
  state.output = `${TITLE}${STARTED}`;
  watch.checkTrust();
  check('P7 cuando la interfaz arranca, deja de esperar', live.statusOf(own).activity === 'idle');

  // Otra sesion crece sin que esta pestana haya hecho nada: no es suya.
  const other = '12121212-1212-4121-8121-121212121212';
  state.files = [info(own, 100), info(other, 300)];
  state.peeks.set(fileOf(other), peekOf(other, { plain: 'un mensaje de otro lado', at: clock }));
  await watch.scan();
  check('P7 un archivo que crece sin un Enter ni un mensaje de esta pestana no es su sesion', state.reported.length === 0);

  // /fork: nombra su origen.
  const forked = '13131313-1313-4131-8131-131313131313';
  state.files = [info(own, 100), info(other, 300), info(forked, 900)];
  state.peeks.set(fileOf(forked), peekOf(forked, null, { parentSession: fileOf(own) }));
  await watch.scan();
  check('P7 /fork: el archivo nuevo nombra a este como origen, y la pestana pasa a el',
    same(state.reported, [forked]) && watch.currentFile === fileOf(forked) && live.statusOf(forked) !== null && live.statusOf(own) === null, show(state.reported));

  // /new y un mensaje del cuadro.
  const fresh = '14141414-1414-4141-8141-141414141414';
  watch.noteSubmitted('arranquemos de nuevo');
  clock += 300;
  state.files = [info(own, 100), info(other, 300), info(forked, 900), info(fresh, 700)];
  state.peeks.set(fileOf(fresh), peekOf(fresh, { plain: 'arranquemos de nuevo', at: clock - 200 }));
  await watch.scan();
  check('P7 /new y un mensaje de la app: aparece en otro archivo, y la pestana pasa a el', same(state.reported, [forked, fresh]) && watch.currentFile === fileOf(fresh));

  // /resume y un mensaje tecleado en la terminal.
  clock += 10_000;
  const hook = watch.hook();
  hook.onInput('\x1b[A');
  check('P7 una flecha no es un Enter', watch.lastEnterAt === null);
  hook.onInput('hola\r');
  check('P7 un Enter en la pty queda anotado', watch.lastEnterAt === clock);
  state.files = [info(own, 100), info(other, 800), info(forked, 900), info(fresh, 700)];
  state.peeks.set(fileOf(other), peekOf(other, { plain: 'hola', at: clock + 60 }));
  await watch.scan();
  check('P7 /resume y un mensaje tecleado: el archivo que crecio justo despues del Enter es la sesion', same(state.reported, [forked, fresh, other]));

  // Lo que frena un cambio.
  clock += 10_000;
  hook.onInput('\r');
  const late = '15151515-1515-4151-8151-151515151515';
  state.files = [...state.files, info(late, 400)];
  state.peeks.set(fileOf(late), peekOf(late, { plain: 'tarde', at: clock + 20_000 }));
  await watch.scan();
  check('P7 un mensaje que aparece mucho despues del Enter no se le asigna', state.reported.length === 3);
  const elsewhere = '16161616-1616-4161-8161-161616161616';
  hook.onInput('\r');
  state.files = [...state.files, info(elsewhere, 400)];
  state.peeks.set(fileOf(elsewhere), { header: { sessionId: elsewhere, cwd: path.join(root, 'otro-proyecto'), version: 3, parentSession: null, startedAt: T0 }, lastUser: { plain: 'x', at: clock + 50 } });
  await watch.scan();
  check('P7 una sesion de otra carpeta no cuenta, aunque este en la misma carpeta de sesiones', state.reported.length === 3);

  // Dos pestanas: una no se queda con la sesion de la otra.
  const second = make('17171717-1717-4171-8171-171717171717');
  second.state.files = [info('17171717-1717-4171-8171-171717171717', 50), ...state.files];
  second.watch.start();
  await second.watch.scan();
  clock += 5_000;
  second.watch.hook().onInput('\r');
  second.state.files = second.state.files.map((each) => (each.file === fileOf(other) ? { ...each, size: 2000 } : each));
  second.state.peeks.set(fileOf(other), peekOf(other, { plain: 'x', at: clock + 30 }));
  await second.watch.scan();
  check('P7 el archivo de la sesion de otra pestana viva no se toma', second.state.reported.length === 0);

  hook.cancel();
  second.watch.hook().cancel();
  check('P7 al soltar el gancho, la sesion queda sin proceso', live.statusOf(other) === null);
  const invalid = make('../../x');
  invalid.watch.start();
  invalid.watch.checkTrust();
  check('P7 un id que no es de Pi no engancha nada', live.statusOf('../../x') === null);
  invalid.watch.hook().cancel();
  live.dispose();
}

// ---------------------------------------------------------------------------
// P8. Los mensajes en cola al interrumpir
// ---------------------------------------------------------------------------
{
  const book = new queued.QueuedSubmitBook();
  book.note('t1', 'uno', 1000);
  book.note('t1', '   ', 1100);
  book.note('t1', 'dos', 1200);
  check('P8 el libro anota lo mandado, sin los vacios, y la interrupcion se lo lleva',
    same(book.take('t1'), [{ text: 'uno', at: 1000 }, { text: 'dos', at: 1200 }]) && book.take('t1').length === 0);
  book.note('t1', 'tres', 2000);
  book.forget('t1');
  check('P8 libre o sin proceso: lo anotado se olvida', book.take('t1').length === 0 && book.size() === 0);
  book.noteClearKey('t1', 5000);
  check('P8 la ultima tecla de vaciar se recuerda por pestana', book.lastClearKeyAt('t1') === 5000 && book.lastClearKeyAt('t2') === null);
  book.drop('t1');
  check('P8 al cerrar la pestana no queda nada', book.lastClearKeyAt('t1') === null);
  for (let index = 0; index < 30; index += 1) book.note('t3', `m${index}`, 10_000 + index);
  check('P8 el libro tiene tope', book.take('t3').length === 20);

  const run = async (options) => {
    let clock = 100_000;
    const log = [];
    const checks = [...options.checks];
    const outcome = await queued.reclaimQueuedSubmits({
      source: {
        clearGapMs: 750,
        check: async (target, submissions, interruptedAt) => {
          log.push(`check:${submissions.map((each) => each.text).join(',')}@${interruptedAt}`);
          return checks.length > 1 ? checks.shift() : checks[0];
        },
      },
      target: options.target ?? (() => ({ cwd: 'c', sessionId: 's' })),
      submissions: options.submissions ?? [{ text: 'A', at: 99_000 }, { text: 'B', at: 99_500 }],
      interruptedAt: 100_000,
      lastClearKeyAt: () => options.lastClearKeyAt ?? null,
      writeClearKey: () => { log.push(`clear@${clock}`); return options.accepts ?? true; },
      prefill: (text) => log.push(`prefill:${text}`),
      wait: async (ms) => { clock += ms; log.push(`wait:${ms}`); },
      now: () => clock,
    });
    return { outcome, log };
  };

  let result = await run({ checks: [{ settled: true, undelivered: [] }] });
  check('P8 todo lo mandado llego: no se escribe ninguna tecla', result.outcome === 'nothing' && same(result.log, ['check:A,B@100000']), show(result));
  result = await run({ checks: [{ settled: false, undelivered: ['B'] }, { settled: false, undelivered: ['B'] }, { settled: true, undelivered: ['B'] }] });
  check('P8 se espera a que el historial cierre el turno, y recien ahi se vacia el editor y el texto vuelve al cuadro',
    result.outcome === 'reclaimed' && same(result.log, ['check:A,B@100000', 'wait:250', 'check:A,B@100000', 'wait:250', 'check:A,B@100000', 'clear@100500', 'prefill:B']), show(result));
  result = await run({ checks: [{ settled: false, undelivered: ['B'] }] });
  check('P8 si el turno no queda cerrado a tiempo no se escribe nada: no se sabe que hay en el editor',
    result.outcome === 'not-settled' && !result.log.some((each) => each.startsWith('clear') || each.startsWith('prefill')) && result.log.filter((each) => each.startsWith('check')).length >= 16, show(result.log.length));
  result = await run({ checks: [{ settled: true, undelivered: ['A', 'B'] }], lastClearKeyAt: 99_600 });
  check('P8 una tecla de vaciar reciente —de la app o tecleada— se respeta: dos seguidas cierran la CLI',
    result.outcome === 'reclaimed' && same(result.log, ['check:A,B@100000', 'wait:350', 'clear@100350', 'prefill:A\n\nB']), show(result));
  result = await run({ checks: [{ settled: true, undelivered: ['B'] }], lastClearKeyAt: 90_000 });
  check('P8 una tecla vieja no hace esperar', same(result.log, ['check:A,B@100000', 'clear@100000', 'prefill:B']));
  result = await run({ checks: [{ settled: true, undelivered: ['B'] }], accepts: false });
  check('P8 si la terminal no acepta la tecla, el texto no vuelve al cuadro: estaria en los dos lados', result.outcome === 'refused' && !result.log.some((each) => each.startsWith('prefill')));
  result = await run({ checks: [{ settled: true, undelivered: ['B'] }], target: () => null });
  check('P8 una pestana que ya no tiene sesion no recibe nada', result.outcome === 'gone' && result.log.length === 0);
  result = await run({ checks: [{ settled: true, undelivered: ['C'] }], submissions: [{ text: 'C', at: 100_001 }] });
  check('P8 lo mandado despues de interrumpir no estaba en cola', result.outcome === 'nothing' && result.log.length === 0);
  result = await run({ checks: [{ settled: true, undelivered: [] }], submissions: [] });
  check('P8 sin nada anotado no se pregunta nada', result.outcome === 'nothing' && result.log.length === 0);
}

// ---------------------------------------------------------------------------
// P9. Lo que se escribe en la pty
// ---------------------------------------------------------------------------
{
  const P = (text) => `\x1b[200~${text}\x1b[201~`;
  const { PI_INPUT } = piIndex;
  const { CLAUDE_CODE_INPUT } = await import('../src/agents/claude-code/index.ts');
  check('P9 sin imagenes: un solo pegado con el Enter al final, como Claude Code',
    same(ptyInput.buildSubmissionWrites('hola\nmundo', [], PI_INPUT), [`${P('hola\nmundo')}\r`]));
  const a = 'C:\\tmp\\agent-workbench\\pasted\\t\\pegada-1-0a1b2c3d.png';
  const b = 'C:\\tmp\\agent-workbench\\pasted\\t\\pegada-2-0a1b2c3e.jpg';
  check('P9 con imagenes: una linea por imagen delante del texto, en el mismo pegado',
    same(ptyInput.buildSubmissionWrites('que ves', [a, b], PI_INPUT), [`${P(`Attached image: "${a}"\nAttached image: "${b}"\nque ves`)}\r`]),
    show(ptyInput.buildSubmissionWrites('que ves', [a, b], PI_INPUT)));
  check('P9 solo imagenes, sin texto', same(ptyInput.buildSubmissionWrites('  ', [a], PI_INPUT), [`${P(`Attached image: "${a}"`)}\r`]));
  check('P9 sin Enter cuando no se manda', same(ptyInput.buildSubmissionWrites('hola', [], PI_INPUT, { send: false }), [P('hola')]));
  check('P9 nada que mandar', ptyInput.buildSubmissionWrites('   ', [], PI_INPUT) === null);
  check('P9 lo que queda pegado es lo que la sesion va a guardar, y lo que se lee de vuelta',
    ptyInput.submissionPayload('que ves', [a], 'quoted-path-line') === `Attached image: "${a}"\nque ves` &&
    same(entries.pastedImagePaths(ptyInput.submissionPayload('que ves', [a], 'quoted-path-line')), [a]));
  check('P9 submissionPayload: sin estilo o con un pegado por imagen no hay un solo texto',
    ptyInput.submissionPayload('x', [a], null) === null && ptyInput.submissionPayload('x', [a], 'bare-path-paste') === null && ptyInput.submissionPayload('x', [], null) === 'x');
  check('P9 Claude Code, byte por byte igual que antes',
    same(ptyInput.buildSubmissionWrites('hola', ['/tmp/a b.png', '/tmp/c.png'], CLAUDE_CODE_INPUT), [`${P('@"/tmp/a b.png" @"/tmp/c.png" hola')}\r`]) &&
    ptyInput.buildSubmission('hola', ['@"/x.png"']) === `${P('@"/x.png" hola')}\r` && ptyInput.fileReference('/x y.png') === '@"/x y.png"');
  check('P9 la referencia de cada estilo', ptyInput.fileReference(a, 'quoted-path-line') === `Attached image: "${a}"` && ptyInput.fileReference(a, 'bare-path-paste') === a);
  check('P9 la tecla que vacia el editor es Ctrl+C, y un Esc interrumpe', ptyInput.CLEAR_EDITOR === '\x03' && same(ptyInput.buildInterruptKeys(PI_INPUT.interruptPresses), ['\x1b']));
  check('P9 un envio justo despues de lanzar espera a que Pi dibuje su interfaz',
    ptyInput.submitStartDelayMs(1000, 1500, PI_INPUT.readyAfterLaunchMs) === 2500 && ptyInput.submitStartDelayMs(1000, 9000, PI_INPUT.readyAfterLaunchMs) === 0);
  const refusal = ptyInput.submitRefusal({ label: 'Pi', approvesPendingOnCycle: false, waitingFor: 'trust dialog', waitingBlocksSubmit: true, activity: 'waiting', blind: false, openToolCall: false });
  check('P9 con el dialogo de confianza abierto, el envio se rechaza sin escribir', refusal !== null && refusal.key === 'waitingSubmit', show(refusal));
  check('P9 trabajando o libre, el envio pasa: un mensaje con el agente trabajando queda en cola',
    ptyInput.submitRefusal({ label: 'Pi', approvesPendingOnCycle: false, waitingFor: null, waitingBlocksSubmit: true, activity: 'busy', blind: false, openToolCall: false }) === null &&
    ptyInput.submitRefusal({ label: 'Pi', approvesPendingOnCycle: false, waitingFor: null, waitingBlocksSubmit: true, activity: 'idle', blind: false, openToolCall: true }) === null);
  check('P9 el comando de esfuerzo: /effort si nadie dice otro, y el de la CLI si lo dice',
    shared.effortCommand('high') === '/effort high' && shared.effortCommand('high', '/thinking') === '/thinking high' && shared.modelCommand('openai-codex/gpt-5.5') === '/model openai-codex/gpt-5.5');
}

// ---------------------------------------------------------------------------
// P10. El adaptador
// ---------------------------------------------------------------------------
{
  const adapter = piIndex.createPiAdapter({ locate: { findInPath: async () => null } });
  check('P10 id, etiqueta, comando y sitio', adapter.id === 'pi' && adapter.label === 'Pi' && adapter.command === 'pi' && adapter.installUrl === 'https://pi.dev');
  check('P10 AGENT_IDS lo nombra al final y la memoria lo conoce', shared.AGENT_IDS.at(-1) === 'pi' && shared.MEMORY_AGENT_IDS.includes('pi') && shared.MEMORY_AGENT_LABELS.pi === 'Pi');
  check('P10 las capacidades, contra un literal',
    same(piIndex.PI_BASE_CAPABILITIES, {
      sessionIdAtLaunch: true,
      resume: true,
      statusSource: true,
      readySignal: false,
      permissionCycle: null,
      models: null,
      efforts: [
        { value: 'off', label: 'Apagado' }, { value: 'minimal', label: 'Minimo' }, { value: 'low', label: 'Bajo' }, { value: 'medium', label: 'Medio' },
        { value: 'high', label: 'Alto' }, { value: 'xhigh', label: 'Muy alto' }, { value: 'max', label: 'Maximo' },
      ],
      questionCards: false,
      imagesByPath: 'quoted-path-line',
      fileMentions: null,
      rewind: false,
      contextWindowSource: 'usage-with-catalog',
      plans: false,
      waitingBlocksSubmit: true,
    }), show(piIndex.PI_BASE_CAPABILITIES));
  check('P10 como se le escribe, contra un literal',
    same(piIndex.PI_INPUT, { imageReference: 'quoted-path-line', pieceGapMs: 0, pasteMarkers: true, enterSeparately: false, interruptPresses: 1, transcriptReference: 'quoted-path', readyAfterLaunchMs: 3000 }), show(piIndex.PI_INPUT));
  check('P10 lo que promete la interfaz y lo que se escribe coinciden', adapter.capabilities.imagesByPath === adapter.input.imageReference);
  check('P10 sin la CLI y sin catalogo leido, las capacidades son las de base', same(adapter.capabilities, piIndex.PI_BASE_CAPABILITIES) && (await adapter.locate()) === null);
  check('P10 el texto de ausencia nombra el comando y el sitio', adapter.missingMessage().key === 'cliMissing' && same(adapter.missingMessage().params, { command: 'pi', url: 'https://pi.dev' }), show(adapter.missingMessage()));
  await adapter.prepare();
  check('P10 con el catalogo de la cuenta leido, el combo de modelo aparece; el resto no cambia',
    adapter.capabilities.models?.length === 3 && adapter.capabilities.models[0].value === 'openai-codex/gpt-5.5' && same({ ...adapter.capabilities, models: null }, piIndex.PI_BASE_CAPABILITIES));
  check('P10 las capacidades sobreviven al viaje al navegador', same(shared.parseAgentCapabilities(JSON.parse(JSON.stringify(adapter.capabilities))), adapter.capabilities));
  check('P10 releer la configuracion sin cambios dice que no cambio nada', (await adapter.refreshSetup()) === false);

  const location = { resolvedPath: 'C:\\npm\\pi.cmd', file: 'C:\\Windows\\cmd.exe', prefixArgs: ['/c', 'C:\\npm\\pi.cmd'], version: '1.1.0' };
  const proposed = 'abababab-abab-4bab-8bab-abababababab';
  const fresh = adapter.launch({ location, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: proposed, launchToken: 'x' });
  check('P10 una sesion nueva: --session-id con el id que propone la app, conocido desde el lanzamiento',
    fresh.file === location.file && same(fresh.args, ['/c', 'C:\\npm\\pi.cmd', '--session-id', proposed]) && same(fresh.session, { kind: 'known', sessionId: proposed }), show(fresh));
  const resumedId = 'mi_sesion.v2';
  const resumed = adapter.launch({ location, cwd: 'C:\\p', resumeSessionId: resumedId, proposedSessionId: proposed, launchToken: 'x' });
  check('P10 reanudar: el mismo comando, con el id de la sesion', same(resumed.args.slice(-2), ['--session-id', resumedId]) && resumed.session.sessionId === resumedId);
  check('P10 ningun argumento lleva espacios ni comillas: van detras de cmd /c', fresh.args.slice(2).every((arg) => /^[A-Za-z0-9._-]+$/.test(arg)));
  const throws = (input) => { try { adapter.launch(input); return false; } catch (error) { return /Invalid Pi session id/.test(String(error)); } };
  check('P10 un id hostil no llega a la linea de comando, ni al reanudar ni al proponer',
    throws({ location, cwd: 'C:\\p', resumeSessionId: 'x&calc', proposedSessionId: proposed, launchToken: 'x' }) &&
    throws({ location, cwd: 'C:\\p', resumeSessionId: 'a b', proposedSessionId: proposed, launchToken: 'x' }) &&
    throws({ location, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: '--help', launchToken: 'x' }));

  const base = { PATH: 'p', PI_TELEMETRY: '1', OTRA: 'x', VACIA: undefined };
  const environment = adapter.environment(base);
  check('P10 el entorno: una copia, sin quitar ni agregar nada, y sin aviso',
    same(environment.env, { PATH: 'p', PI_TELEMETRY: '1', OTRA: 'x' }) && environment.notice === null && !('PI_PROGRAM_STATUS' in environment.env));
  check('P10 las carpetas protegidas: ~/.pi entera', same(adapter.protectedDirs(), [path.join(home, '.pi')]));
  const elsewhere = path.join(root, 'pi-en-otro-lado');
  process.env['PI_CODING_AGENT_DIR'] = elsewhere;
  check('P10 con PI_CODING_AGENT_DIR en otro lado, esa tambien, sin dejar de proteger la de siempre', same(adapter.protectedDirs(), [elsewhere, path.join(home, '.pi')]));
  delete process.env['PI_CODING_AGENT_DIR'];
  check('P10 no anuncia modelo por defecto: settings.json no se abre', (await adapter.defaults('C:\\p')) === null);
  check('P10 publica su estado, sigue por archivo y deja leer entero',
    adapter.status !== null && adapter.history.wholeRead === true && adapter.questions === undefined && typeof adapter.prepare === 'function');
  check('P10 declara que devuelve a su editor lo que tenia en cola, con una separacion mayor a la ventana de Pi',
    adapter.queuedSubmits !== undefined && adapter.queuedSubmits.clearGapMs > 500 && same(await adapter.queuedSubmits.check({ cwd: 'c', sessionId: 'no-esta' }, [], 0), { settled: false, undelivered: [] }));

  const { chooseDelivery } = await import('../src/handoff/handoff.ts');
  check('P10 continuar hacia Pi queda prellenado: no hay senal de lista', chooseDelivery(piIndex.PI_BASE_CAPABILITIES) === 'prefill');
  const { transcriptReferenceFor } = await import('../src/handoff/transcript.ts');
  check('P10 el transcript de una continuacion se nombra entre comillas', transcriptReferenceFor('C:\\tmp\\t.md', adapter.input.transcriptReference) === '"C:\\tmp\\t.md"');

  // El gancho: engancha la sesion y la suelta.
  const spawned = { output: '', reported: [] };
  const hook = adapter.onSpawned({
    terminalId: 'tab-gancho', sessionId: proposed, cwd: projectCwd, resumed: false, pid: 1, launchedAt: Date.now(), launchToken: 'x',
    readOutput: () => spawned.output, write: () => true, onDone: () => undefined, reportSessionId: (id) => spawned.reported.push(id),
  });
  const statuses = [];
  const stop = adapter.status.subscribe(proposed, (status) => statuses.push(status?.activity ?? null));
  await adapter.status.refresh(proposed);
  check('P10 el gancho sobrevive a lo que se escribe y avisa el Enter y lo mandado', typeof hook.onInput === 'function' && typeof hook.onSubmitted === 'function' && hook.onExit === undefined);
  check('P10 con el proceso vivo y sin archivo, la pestana esta libre', statuses.at(-1) === 'idle', show(statuses));
  hook.cancel();
  check('P10 al soltar el gancho la sesion queda sin proceso', statuses.at(-1) === null, show(statuses));
  stop();

  const { createAgentRegistry } = await import('../src/agents/registry.ts');
  const registry = createAgentRegistry();
  check('P10 el registro de la app la trae al final', registry.all().at(-1).adapter.id === 'pi' && registry.all().length === 5);
  check('P10 sin ninguna instalada, Pi no es la de por defecto ni aparece disponible', registry.defaultAgent() === null && registry.list().at(-1).available === false && registry.list().at(-1).statusLine === null);
  check('P10 el selector de carpetas no lista ~/.pi', registry.protectedDirs().includes(path.join(home, '.pi')));
  check('P10 el entorno compuesto no gana ninguna variable por Pi', Object.keys(registry.composedEnvironment({ PATH: 'p', A: 'b' })).every((key) => key === 'PATH' || key === 'A'));
  await registry.disposeAll();
  await adapter.dispose();

  check('P10 el protocolo: el estilo nuevo de imagen y el motivo nuevo de un texto que vuelve al cuadro',
    shared.IMAGE_REFERENCE_STYLES.includes('quoted-path-line') && shared.COMPOSER_PREFILL_REASONS.includes('returned-by-cli') &&
    same(shared.parseServerMessage(JSON.stringify({ type: 'composer.prefill', terminalId: 't', text: 'x', reason: 'returned-by-cli' })), { type: 'composer.prefill', terminalId: 't', text: 'x', reason: 'returned-by-cli' }) &&
    shared.parseServerMessage(JSON.stringify({ type: 'composer.prefill', terminalId: 't', text: 'x', reason: 'otro' })) === null);
}

// ---------------------------------------------------------------------------
// P11. La web, sin JSX
// ---------------------------------------------------------------------------
{
  const ui = await import('../../web/src/agent-ui.ts');
  const capabilities = { ...piIndex.PI_BASE_CAPABILITIES, models: catalogModule.modelOptions(catalogModule.storeModels(STORE)) };
  check('P11 la insignia, el archivo de instrucciones y que no guarda lo elegido',
    ui.AGENT_UI.pi.shortLabel === 'PI' && ui.agentShortLabel('pi') === 'PI' && ui.instructionsFileFor('pi') === 'AGENTS.md' && ui.savesModelChoiceFor('pi') === false);
  check('P11 el combo de esfuerzo manda /thinking con Pi y /effort con las demas',
    ui.effortCommandFor('pi') === '/thinking' && ['claude-code', 'codex', 'opencode', 'antigravity'].every((id) => ui.effortCommandFor(id) === '/effort') && ui.effortCommandFor(null) === '/effort');
  const controls = ui.controlsFor(capabilities);
  check('P11 los controles: modelo, esfuerzo e imagenes; sin modo, sin planes, sin notas ni preguntas',
    controls.models.length === 3 && controls.efforts.length === 7 && controls.imagesAllowed === true && controls.modeCycle === null && controls.plansAvailable === false &&
    controls.noteSendable === false && controls.questionsAnswerable === false && controls.rewind === false && controls.fileMentions === false && controls.contextWindowSource === 'usage-with-catalog');
  check('P11 sin catalogo leido no hay combo de modelo', ui.controlsFor(piIndex.PI_BASE_CAPABILITIES).models === null);
  check('P11 el modelo observado casa con su opcion', ui.modelOptionIn(capabilities.models, 'openai-codex/gpt-5.6-terra')?.label === 'GPT-5.6 Terra' && ui.modelOptionIn(capabilities.models, 'otro/modelo') === null);
  check('P11 la opcion se lee con su ventana', shared.modelOptionLabel(capabilities.models[0]) === 'GPT-5.5 · 272k');
  check('P11 los atajos de Pi, traducidos', ui.AGENT_UI.pi.shortcuts.length === 10 && ui.AGENT_UI.pi.shortcuts.every((each) => each.description.length > 0 && !each.description.startsWith('agent.')) &&
    ui.AGENT_UI.pi.shortcuts.find((each) => each.keys === 'Ctrl + C')?.description === 'Vaciar el editor; dos veces, salir');
  check('P11 una pestana de Pi nace con su sesion: no espera descubrirla', ui.discoveringSession('pi', '', capabilities) === false);
  check('P11 el medidor: sin numero hasta la primera respuesta, y dice que el limite sale del catalogo',
    ui.meterMeasured('usage-with-catalog', { assistantMessages: 0, lastRequestTokens: 0 }) === false && ui.meterMeasured('usage-with-catalog', { assistantMessages: 1, lastRequestTokens: 5 }) === true &&
    ui.meterWindowOrigin('usage-with-catalog', { contextWindow: 272000, contextWindowEstimated: false }) !== null);
  check('P11 con el dialogo de confianza abierto, el cuadro dice que la CLI espera',
    ui.pendingApprovalNotice(capabilities, 'trust dialog', true) === 'La CLI está esperando una respuesta tuya.' && ui.pendingApprovalNotice(capabilities, null, true) === null &&
    ui.pendingApprovalNotice(capabilities, 'trust dialog', false) === null);
  check('P11 una llamada sin resultado no apaga el cuadro: Pi no pide permisos y su estado se ve', ui.openToolCallNotice(capabilities, true, 'Pi', true, 'busy') === null);
  check('P11 el aviso de un mensaje que volvio al cuadro',
    ui.queueReturnedText('Pi') === 'Pi no llegó a entregar el mensaje que mandaste mientras trabajaba: la interrupción llegó antes. Volvió al cuadro, sin mandar.' &&
    ui.queueReturnedText(null).startsWith('La CLI no llegó a entregar'));
  const info = (id, label, available) => ({ id, label, command: id, available, version: null, installUrl: '', missingMessage: null, capabilities: shared.NO_CAPABILITIES, environmentNotice: null, statusLine: null });
  const both = [info('claude-code', 'Claude Code', true), info('pi', 'Pi', true)];
  check('P11 con otra CLI instalada, se puede continuar hacia Pi y desde Pi',
    same(ui.continueTargets(both, 'claude-code').map((each) => each.id), ['pi']) && same(ui.continueTargets(both, 'pi').map((each) => each.id), ['claude-code']));
  check('P11 con Pi desinstalada, sus sesiones llevan insignia y dicen por que no se abren',
    ui.sessionAgentView('pi', [info('claude-code', 'Claude Code', true), info('pi', 'Pi', false)], false).unavailableTitle === 'La CLI Pi no está instalada.');
  check('P11 una opcion del combo se manda como /model proveedor/id', shared.modelCommand(capabilities.models[1].value) === '/model openai-codex/gpt-5.6-terra');
}

// ---------------------------------------------------------------------------
// P12. Lo que el codigo de Pi no nombra nunca
// ---------------------------------------------------------------------------
{
  const typescript = (await import('typescript')).default;
  const { readFile } = await import('node:fs/promises');
  const dir = path.join(import.meta.dirname, '..', 'src', 'agents', 'pi');
  /** El codigo sin comentarios: un comentario que nombra un archivo no lo abre. */
  const code = async (file) => {
    const text = await readFile(path.join(dir, file), 'utf8');
    const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, false, typescript.ScriptKind.TS);
    return typescript.createPrinter({ removeComments: true }).printFile(source);
  };
  const files = (await readdir(dir)).filter((file) => file.endsWith('.ts'));
  const sources = new Map();
  for (const file of files) sources.set(file, await code(file));
  const FORBIDDEN = ['auth.json', 'oauth.json', 'mcp-auth.json', 'models.json', 'mcp.json', 'settings.json', 'trust.json', 'keybindings.json', 'pi-debug.log', 'crashes.json'];
  const hits = [];
  for (const [file, text] of sources) {
    for (const name of FORBIDDEN) if (text.includes(name)) hits.push(`${file}: ${name}`);
  }
  check('P12 el codigo de Pi no nombra credenciales ni configuracion: ni auth.json, ni models.json, ni settings.json', files.length >= 10 && hits.length === 0, hits.join(', '));
  const raw = await readFile(path.join(dir, 'index.ts'), 'utf8');
  check('P12 esos nombres si estan en los comentarios: por eso se buscan sin ellos', raw.includes('auth.json') && raw.includes('settings.json'));
  // `exec(` a secas no: es tambien el de una expresion regular.
  const spawning = [...sources].filter(([, text]) => /child_process|execFile|\bspawn(Sync)?\(|\bfork\(/.test(text)).map(([file]) => file);
  check('P12 nada del adaptador lanza un proceso: la version se lee sin ejecutar pi', spawning.length === 0, spawning.join(', '));
  const writing = [...sources].filter(([, text]) => /\b(writeFile|appendFile|mkdir|rename|unlink|rm|rmdir|copyFile|truncate|utimes|chmod)\b/.test(text)).map(([file]) => file);
  check('P12 nada del adaptador escribe en disco', writing.length === 0, writing.join(', '));
  const environment = [...sources].filter(([, text]) => /process\.env\[[^\]]+\]\s*=|PI_PROGRAM_STATUS|PI_TELEMETRY/.test(text)).map(([file]) => file);
  check('P12 nada del adaptador fija una variable de entorno', environment.length === 0, environment.join(', '));

  // Leer no deja nada nuevo en la carpeta de Pi.
  const listAll = async (base) => {
    const out = [];
    const walk = async (current) => {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) await walk(full);
        else out.push(path.relative(base, full));
      }
    };
    await walk(base);
    return out.sort();
  };
  const beforeRead = await listAll(agentDir);
  const adapter = piIndex.createPiAdapter({ locate: { findInPath: async () => null } });
  await adapter.prepare();
  const items = (await adapter.history.list()) ?? [];
  for (const item of items) {
    const scanned = await adapter.history.scan(item);
    if (scanned === null) continue;
    const follower = adapter.history.follow({ cwd: scanned.cwd ?? projectCwd, sessionId: item.sessionId });
    await follower.start();
    await follower.poll();
  }
  await adapter.dispose();
  check('P12 listar, resumir y seguir no deja ningun archivo nuevo en la carpeta de Pi', items.length > 0 && same(await listAll(agentDir), beforeRead));
}

console.warn = realWarn;
await rm(root, { recursive: true, force: true }).catch(() => undefined);
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
