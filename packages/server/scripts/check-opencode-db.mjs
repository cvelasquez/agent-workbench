/**
 * Chequeo del hito 26: el historial de OpenCode, leido de su base SQLite.
 *
 *   npx tsx scripts/check-opencode-db.mjs
 *
 * Cubre:
 *
 *  - P: lo que el hito 26 necesitaba del 25 y el 25 no dejo, con la forma que
 *    tiene el codigo del 25 (paso 0): el gancho posterior al lanzamiento recibe
 *    lo que se escribe, y cuantos Esc interrumpen se declara por CLI. Con Claude
 *    Code y Codex, un Esc, como siempre.
 *  - 1: la parte `notice` de `shared` y su frase en la web; `conversation.reset`,
 *    `append` y `page` descartan el evento que no entienden en vez del lote
 *    entero; la fuente de ventana `usage-with-catalog` (paso 1).
 *  - 0: el aislamiento: las rutas de OpenCode caen dentro de la carpeta temporal.
 *  - 2: las sentencias de `OPENCODE_SQL`, leidas como texto (que no lean lo que
 *    no se lee, que filtren por sesion, mensaje o id, que ordenen por
 *    `time_created, id`) y corridas contra el fixture (que ninguna devuelva
 *    `SECRETO` y que ninguna recorra `part` o `message` enteras).
 *  - 3: `resolveOpenCodePaths`.
 *  - 4: `ReadOnlyDatabase` y `loadSqlite`, contra una base de prueba con el
 *    esquema real (`scripts/fixtures/opencode-db.mjs`).
 *  - 5: `DbChangeSignal`, con `stat` y temporizadores de mentira y contra la
 *    base de prueba con el escritor abierto; `session-watcher` con una raiz que
 *    trae `watch`.
 *  - 6 a 9: filas -> eventos (usuario, asistente, preguntas), el medidor y el
 *    catalogo de modelos (`events.ts`, `catalog.ts`).
 *  - 10 y 11: el seguidor, con la carga por tandas de mensajes, las lecturas
 *    incrementales, `usageChanged` y el `append` vacio del hub.
 *  - 12 a 14: el historial (`history.ts`), el adaptador con la guardia del id y
 *    su forma de escribir, el registro, `changedRefs`; y en la web, las tandas
 *    de herramientas y la entrada de `AGENT_UI`. Tambien `toTitle`, movido.
 *  - 15: el descubrimiento de la sesion de una pestana nueva (paso 7):
 *    `matchDiscoveries`, que cuenta como envio y que no (el `ESC[I` del foco
 *    no), el descubrimiento contra la base de prueba, y de punta a punta con el
 *    sondeo de verdad.
 *  - 8: el arranque (la linea `Historial`, solo cuando hay algo que decir), la
 *    demo sin variables de OpenCode y sin capturar si ve un historial o la CLI,
 *    y el piso de Node sin cambio (paso 8).
 *  - 16: las teclas de la interrupcion.
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA` y las `XDG_*` apuntando a una
 * carpeta temporal propia, y sin `OPENCODE_DB`, `OPENCODE_MODELS_PATH` ni
 * `OPENCODE_MODELS_URL`, todo **antes** de importar nada: nunca abre la base de
 * OpenCode de verdad. No importa nada que cargue `node-pty`.
 *
 * `node:sqlite` se carga por primera vez en el caso 4: es lo que deja probar
 * que el aviso experimental no sale. Nada antes de ese caso puede cargarlo.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-opencode-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg-config');
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
process.env['CODEX_HOME'] = path.join(root, 'codex');
delete process.env['OPENCODE_DB'];
delete process.env['OPENCODE_MODELS_PATH'];
delete process.env['OPENCODE_MODELS_URL'];

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (value) => JSON.stringify(value);

const shared = await import('@agent-workbench/shared');

// ---------------------------------------------------------------------------
// P. Lo que el 26 da por hecho del 25 (paso 0)
// ---------------------------------------------------------------------------

// P3. El gancho que sobrevive a lo que se escribe recibe lo escrito, tal cual.
{
  const { LaunchHookSlot } = await import('../src/launch-hook-slot.ts');
  const seen = [];
  const slot = new LaunchHookSlot();
  slot.set({ cancel: () => seen.push('cancel'), onInput: (data) => seen.push(data) });
  slot.input('\x1b[I');
  slot.input('hola\r');
  check('P3 onInput recibe cada escritura tal cual, y el gancho sigue vivo',
    same(seen, ['\x1b[I', 'hola\r']) && slot.active, show(seen));

  const plain = [];
  slot.set({ cancel: () => plain.push('cancel') });
  slot.input('x');
  slot.input('y');
  check('P3 sin onInput, escribir cancela una vez, como en el 25', same(plain, ['cancel']) && !slot.active, show(plain));
}

// P6. Cuantos Esc interrumpen: se declara por CLI, y las dos de antes siguen con uno.
{
  const { CLAUDE_CODE_INPUT } = await import('../src/agents/claude-code/index.ts');
  const { CODEX_INPUT } = await import('../src/agents/codex/index.ts');
  check('P6 claude-code interrumpe con un Esc', CLAUDE_CODE_INPUT.interruptPresses === 1, show(CLAUDE_CODE_INPUT));
  check('P6 codex interrumpe con un Esc', CODEX_INPUT.interruptPresses === 1, show(CODEX_INPUT));
}

// 16. Las teclas de la interrupcion.
{
  const { buildInterruptKeys, INTERRUPT } = await import('../src/pty-input.ts');
  check('16 INTERRUPT sigue siendo un Esc suelto', INTERRUPT === '\x1b');
  check('16 buildInterruptKeys(1) -> un Esc', same(buildInterruptKeys(1), ['\x1b']), show(buildInterruptKeys(1)));
  check('16 buildInterruptKeys(2) -> dos Esc, por separado', same(buildInterruptKeys(2), ['\x1b', '\x1b']), show(buildInterruptKeys(2)));
  check('16 nunca menos de uno: 0 o negativo -> un Esc', same(buildInterruptKeys(0), ['\x1b']) && same(buildInterruptKeys(-3), ['\x1b']));
  const odd = [2.5, Number.POSITIVE_INFINITY, Number.NaN].map((presses) => {
    try {
      return buildInterruptKeys(presses);
    } catch (error) {
      return String(error);
    }
  });
  check('16 un valor que no es un entero (2.5, infinito, NaN) -> un Esc, sin lanzar',
    same(odd, [['\x1b'], ['\x1b'], ['\x1b']]), show(odd));
}

// ---------------------------------------------------------------------------
// 1. La parte `notice` y los lotes de eventos (paso 1)
// ---------------------------------------------------------------------------

const { CONVERSATION_NOTICES, EMPTY_CONTEXT_USAGE, parseConversationEvent, parseConversationPart, parseServerMessage } = shared;

// 1a. El parser de la parte.
{
  check('1 los tres avisos, en orden', same(CONVERSATION_NOTICES, ['compacted', 'interrupted', 'error']), show(CONVERSATION_NOTICES));
  const parsed = CONVERSATION_NOTICES.map((notice) => parseConversationPart({ kind: 'notice', notice, detail: 'x' }));
  check('1 cada aviso con su detalle se lee igual',
    same(parsed, CONVERSATION_NOTICES.map((notice) => ({ kind: 'notice', notice, detail: 'x' }))), show(parsed));
  check('1 un aviso desconocido -> null', parseConversationPart({ kind: 'notice', notice: 'otro', detail: '' }) === null);
  check('1 sin aviso -> null', parseConversationPart({ kind: 'notice', detail: '' }) === null);
  check('1 detalle ausente -> vacio', same(parseConversationPart({ kind: 'notice', notice: 'interrupted' }),
    { kind: 'notice', notice: 'interrupted', detail: '' }));
  check('1 detalle que no es texto -> vacio', same(parseConversationPart({ kind: 'notice', notice: 'compacted', detail: 7 }),
    { kind: 'notice', notice: 'compacted', detail: '' }));
}

const event = (eventId, parts) => ({
  eventId, role: 'assistant', at: 1, parts, model: null, usage: null, effort: null, durationMs: null, queued: false,
});
const textPart = { kind: 'text', text: 'hola', truncated: false };
const noticePart = { kind: 'notice', notice: 'error', detail: 'APIError: sin saldo' };
const unknownPart = { kind: 'parte-del-futuro', x: 1 };

// 1b. El evento.
{
  check('1 un evento con un aviso se lee entero', same(parseConversationEvent(event('e1', [noticePart])), event('e1', [noticePart])));
  check('1 un evento con un aviso desconocido -> null',
    parseConversationEvent(event('e1', [{ kind: 'notice', notice: 'otro', detail: '' }])) === null);
}

// 1c. Los tres mensajes que llevan eventos descartan solo el que no entienden (M3).
{
  const events = [event('a', [textPart]), event('b', [unknownPart]), event('c', [noticePart])];
  const kept = (message) => message?.events.map((e) => e.eventId).join(',');

  const append = parseServerMessage(JSON.stringify({
    type: 'conversation.append', terminalId: 't', events, usage: EMPTY_CONTEXT_USAGE, permissionMode: null,
  }));
  check('1 conversation.append con un evento de parte desconocida conserva los demas', kept(append) === 'a,c', String(kept(append)));

  const reset = parseServerMessage(JSON.stringify({
    type: 'conversation.reset', terminalId: 't', sessionId: '', state: 'live', events, hasMore: true,
    usage: EMPTY_CONTEXT_USAGE, permissionMode: null, defaults: {}, waitingFor: null,
  }));
  check('1 conversation.reset igual, y el resto del mensaje intacto',
    kept(reset) === 'a,c' && reset?.hasMore === true && reset?.sessionId === '', String(kept(reset)));

  const page = parseServerMessage(JSON.stringify({ type: 'conversation.page', terminalId: 't', events, hasMore: true }));
  check('1 conversation.page igual', kept(page) === 'a,c' && page?.hasMore === true, String(kept(page)));

  const valid = [event('a', [textPart]), event('c', [noticePart])];
  const whole = parseServerMessage(JSON.stringify({
    type: 'conversation.append', terminalId: 't', events: valid, usage: EMPTY_CONTEXT_USAGE, permissionMode: null,
  }));
  check('1 con todos validos, el lote llega exacto', same(whole?.events, valid), String(kept(whole)));

  const notArray = (type, extra) => parseServerMessage(JSON.stringify({ type, terminalId: 't', events: 'x', ...extra }));
  check('1 events que no es una lista sigue siendo un mensaje invalido',
    notArray('conversation.append', { usage: EMPTY_CONTEXT_USAGE }) === null &&
    notArray('conversation.page', { hasMore: false }) === null &&
    notArray('conversation.reset', { sessionId: 's', state: 'live', usage: EMPTY_CONTEXT_USAGE }) === null);
}

// 1d. La frase del aviso en la web, que se dibuja, se copia y se busca igual.
{
  const { noticeText } = await import('../../web/src/conversation-notice.ts');
  check('1 web: compactado a mano y automatico',
    noticeText({ notice: 'compacted', detail: '' }) === 'Contexto compactado' &&
    noticeText({ notice: 'compacted', detail: 'auto' }) === 'Contexto compactado automáticamente');
  check('1 web: interrumpido', noticeText({ notice: 'interrupted', detail: '' }) === 'Interrumpido');
  check('1 web: error con el detalle del proveedor',
    noticeText({ notice: 'error', detail: 'APIError: sin saldo' }) === 'La CLI devolvió un error: APIError: sin saldo');
  check('1 web: error sin detalle, sin los dos puntos colgando', noticeText({ notice: 'error', detail: '' }) === 'La CLI devolvió un error');
}

// 1e. La fuente de ventana `usage-with-catalog`.
{
  const { CONTEXT_WINDOW_SOURCES, parseAgentCapabilities } = shared;
  check('1 usage-with-catalog es una fuente, detras de las dos de antes',
    same(CONTEXT_WINDOW_SOURCES, ['usage-with-variants', 'token-count', 'usage-with-catalog']), show(CONTEXT_WINDOW_SOURCES));
  check('1 usage-with-catalog sobrevive al viaje por la red',
    parseAgentCapabilities({ contextWindowSource: 'usage-with-catalog' }).contextWindowSource === 'usage-with-catalog');

  const webUi = await import('../../web/src/agent-ui.ts');
  check('1 medidor en vacio: el catalogo no anuncia limite antes de medir, salvo la configuracion',
    webUi.meterIdleWindow('usage-with-catalog', { contextWindow: 200000 }, null) === null &&
    webUi.meterIdleWindow('usage-with-catalog', { contextWindow: 200000 }, 1000) === 1000);
  const origin = (source, contextWindow, contextWindowEstimated) =>
    webUi.meterWindowOrigin(source, { contextWindow, contextWindowEstimated });
  check('1 medidor: con catalogo y ventana, el titulo dice de donde sale el limite',
    origin('usage-with-catalog', 200000, false) === 'limite del catalogo de modelos de la CLI');
  check('1 medidor: con catalogo y sin ventana, nada que decir', origin('usage-with-catalog', null, false) === null);
  check('1 medidor: con variantes, lo de siempre (solo la cota deducida)',
    origin('usage-with-variants', 200000, false) === null &&
    origin('usage-with-variants', 1000000, true) === 'limite deducido de los tokens medidos' &&
    origin('token-count', 258400, false) === null);
}

// ---------------------------------------------------------------------------
// Utilidades de lo que sigue
// ---------------------------------------------------------------------------

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = path.join(root, 'fixtures');

/** Espera por condicion, con tope. Nunca un `sleep` fijo. */
const waitFor = async (condition, timeoutMs = 3000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));
const captureWarnings = async (run) => {
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.map(String).join(' '));
  try {
    await run();
  } finally {
    console.warn = original;
  }
  return seen;
};
const throwsOn = (run) => errorOf(run) !== null;
const errorOf = (run) => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const { OPENCODE_SQL, OPENCODE_REQUIRED_COLUMNS } = await import('../src/agents/opencode/sql.ts');
const { resolveOpenCodePaths } = await import('../src/agents/opencode/paths.ts');
const sqliteModule = await import('../src/agents/sqlite.ts');
const fixture = await import('./fixtures/opencode-db.mjs');
const { createOpenCodeFixture, openCodeBaseContent, messageRow, partRow, sessionRow, OPENCODE_MODELS_FIXTURE } = fixture;
const nameOfSql = new Map(Object.entries(OPENCODE_SQL).map(([name, sql]) => [sql, name]));
const openDb = (file, extra = {}) =>
  new sqliteModule.ReadOnlyDatabase(file, { idleCloseMs: 60_000, required: OPENCODE_REQUIRED_COLUMNS, label: 'OpenCode', ...extra });
/** Una base que anota que sentencias corren y cuantas filas devuelve cada una. */
const spyDb = (inner) => {
  const calls = [];
  return {
    calls,
    status: () => inner.status(),
    all: (sql, ...params) => {
      const rows = inner.all(sql, ...params);
      calls.push({ name: nameOfSql.get(sql) ?? sql, rows: rows.length });
      return rows;
    },
    get: (sql, ...params) => {
      const row = inner.get(sql, ...params);
      calls.push({ name: nameOfSql.get(sql) ?? sql, rows: row === undefined ? 0 : 1 });
      return row;
    },
  };
};
const fakeCatalog = { contextWindow: async (provider, model) => (provider === 'openai' && model === 'gpt-5.6-terra' ? 1_050_000 : null) };

// ---------------------------------------------------------------------------
// 0. Aislamiento
// ---------------------------------------------------------------------------

{
  const inside = (candidate) => candidate !== null && path.resolve(candidate).toLowerCase().startsWith(path.resolve(root).toLowerCase());
  const resolved = resolveOpenCodePaths(process.env, os.homedir(), process.platform);
  check('0 el home del proceso es la carpeta temporal', inside(os.homedir()), os.homedir());
  check('0 la base, el catalogo y las cuatro carpetas de OpenCode caen dentro de la temporal',
    [resolved.dbFile, resolved.walFile, resolved.modelsFile, resolved.dataDir, resolved.configDir, resolved.cacheDir, resolved.stateDir].every(inside),
    show(resolved));
}

// ---------------------------------------------------------------------------
// 3. resolveOpenCodePaths
// ---------------------------------------------------------------------------

{
  const win = (env) => resolveOpenCodePaths(env, 'C:\\Users\\u', 'win32');
  const defaults = win({});
  check('3 win32 por defecto: carpetas bajo el home, la base en datos y el catalogo en cache', same(defaults, {
    dbFile: 'C:\\Users\\u\\.local\\share\\opencode\\opencode.db',
    walFile: 'C:\\Users\\u\\.local\\share\\opencode\\opencode.db-wal',
    modelsFile: 'C:\\Users\\u\\.cache\\opencode\\models.json',
    dataDir: 'C:\\Users\\u\\.local\\share\\opencode',
    configDir: 'C:\\Users\\u\\.config\\opencode',
    cacheDir: 'C:\\Users\\u\\.cache\\opencode',
    stateDir: 'C:\\Users\\u\\.local\\state\\opencode',
  }), show(defaults));
  const absolute = win({ OPENCODE_DB: 'D:\\prueba\\oc.db' });
  check('3 OPENCODE_DB absoluta: tal cual, con su -wal', absolute.dbFile === 'D:\\prueba\\oc.db' && absolute.walFile === 'D:\\prueba\\oc.db-wal', show(absolute));
  check('3 OPENCODE_DB relativa: dentro de la carpeta de datos',
    win({ OPENCODE_DB: 'otra.db' }).dbFile === 'C:\\Users\\u\\.local\\share\\opencode\\otra.db', show(win({ OPENCODE_DB: 'otra.db' })));
  const memory = win({ OPENCODE_DB: ':memory:' });
  check('3 OPENCODE_DB :memory: -> sin base', memory.dbFile === null && memory.walFile === null);
  check('3 una ruta colgada de la unidad actual (\\x.db) -> sin base', win({ OPENCODE_DB: '\\x.db' }).dbFile === null);
  const xdg = win({ XDG_DATA_HOME: 'E:\\datos', XDG_CACHE_HOME: 'E:\\cache', XDG_CONFIG_HOME: 'E:\\conf', XDG_STATE_HOME: 'E:\\estado' });
  check('3 XDG_* respetadas',
    xdg.dataDir === 'E:\\datos\\opencode' && xdg.dbFile === 'E:\\datos\\opencode\\opencode.db' && xdg.cacheDir === 'E:\\cache\\opencode' &&
    xdg.modelsFile === 'E:\\cache\\opencode\\models.json' && xdg.configDir === 'E:\\conf\\opencode' && xdg.stateDir === 'E:\\estado\\opencode', show(xdg));
  check('3 OPENCODE_MODELS_PATH gana, aun con OPENCODE_MODELS_URL',
    win({ OPENCODE_MODELS_PATH: 'E:\\m.json', OPENCODE_MODELS_URL: 'https://x.invalid' }).modelsFile === 'E:\\m.json');
  check('3 OPENCODE_MODELS_URL sin PATH -> sin catalogo', win({ OPENCODE_MODELS_URL: 'https://x.invalid' }).modelsFile === null);
  check('3 una variable vacia cuenta como ausente',
    same(win({ OPENCODE_DB: '', XDG_DATA_HOME: '', XDG_CACHE_HOME: '', OPENCODE_MODELS_PATH: '', OPENCODE_MODELS_URL: '' }), defaults));
  check('3 una XDG relativa no se lee: la resolveria el cwd de otro proceso', win({ XDG_DATA_HOME: 'datos' }).dbFile === null);
  const linux = resolveOpenCodePaths({ OPENCODE_DB: '/tmp/oc.db' }, '/home/u', 'linux');
  check('3 linux: rutas posix',
    linux.dbFile === '/tmp/oc.db' && linux.dataDir === '/home/u/.local/share/opencode' && linux.modelsFile === '/home/u/.cache/opencode/models.json', show(linux));
}

// ---------------------------------------------------------------------------
// 2. OPENCODE_SQL, leido como texto
// ---------------------------------------------------------------------------

{
  const statements = Object.entries(OPENCODE_SQL);
  const offenders = (predicate) => statements.filter(([name, sql]) => predicate(name, sql)).map(([name]) => name);
  const forbiddenTables = [
    'account', 'account_state', 'control_account', 'credential', 'session_share', 'permission', 'event', 'event_sequence',
    'project', 'project_directory', 'todo', 'session_message', 'session_input', 'session_context_epoch', 'workspace',
    'migration', '__drizzle_migrations', 'data_migration',
  ];
  check('2 ninguna sentencia hace SELECT *', same(offenders((_, sql) => /select\s+\*/i.test(sql)), []));
  check('2 $.url solo en imageUrlById',
    same(offenders((name, sql) => sql.includes('$.url') && name !== 'imageUrlById'), []) && OPENCODE_SQL.imageUrlById.includes('$.url'));
  const namingForbidden = offenders((_, sql) => forbiddenTables.some((table) => new RegExp(`\\b${table}\\b`, 'i').test(sql)));
  check('2 ninguna nombra una tabla que no se lee (credenciales, eventos, proyecto...)', same(namingForbidden, []), show(namingForbidden));
  check('2 de state.metadata, solo las respuestas de una pregunta',
    same(offenders((_, sql) => sql.replaceAll('$.state.metadata.answers', '').includes('$.state.metadata')), []));
  check('2 nunca cabeceras ni cuerpo de un error, ni los archivos de un patch',
    same(offenders((_, sql) => /responseHeaders|responseBody|\$\.files/.test(sql)), []));
  const textIsGuarded = (sql) => {
    const joinGuard = sql.includes("json_extract(p.data, '$.type') = 'text'");
    return sql.split('\n').filter((line) => line.includes("'$.text'"))
      .every((line) => line.includes("WHEN 'text'") || (joinGuard && line.includes("p.data, '$.text'")));
  };
  const unguardedText = offenders((_, sql) => !textIsGuarded(sql));
  check('2 $.text solo dentro de un CASE de tipo text, o junto al filtro de tipo text', same(unguardedText, []), show(unguardedText));
  /** Cada FROM sobre message o part, con lo que sigue hasta el proximo FROM. */
  const unfiltered = offenders((_, sql) => sql.split(/\bfrom\b/i).slice(1).some((segment) =>
    /^\s*(message|part)\b/i.test(segment) && !/\b(session_id|message_id|id)\s*(=|in\b)/i.test(segment)));
  check('2 toda lectura de message o part filtra por sesion, mensaje o id', same(unfiltered, []), show(unfiltered));
  const badOrder = offenders((_, sql) => [...sql.matchAll(/ORDER BY ([^\n]+)/gi)].some((match) => !/^(\w+\.)?time_created, (\w+\.)?id\b/.test(match[1])));
  check('2 todo ORDER BY es por (time_created, id)', same(badOrder, []), show(badOrder));

  const opencodeDir = path.join(serverDir, 'src', 'agents', 'opencode');
  const withSql = [];
  for (const file of (await readdir(opencodeDir)).filter((name) => name.endsWith('.ts') && name !== 'sql.ts')) {
    const text = await readFile(path.join(opencodeDir, file), 'utf8');
    if (/\b(SELECT|INSERT|UPDATE|DELETE|PRAGMA)\s/.test(text) || /\.(prepare|exec|iterate)\(/.test(text)) withSql.push(file);
  }
  check('2 fuera de sql.ts no hay SQL ni sentencias preparadas a mano', same(withSql, []), show(withSql));
  const sqliteSource = await readFile(path.join(serverDir, 'src', 'agents', 'sqlite.ts'), 'utf8');
  check('2 la base nunca se recorre con iterate(): un iterador vivo retiene el WAL', !sqliteSource.includes('.iterate('));
}

// ---------------------------------------------------------------------------
// 4. ReadOnlyDatabase y loadSqlite. Aca se carga node:sqlite por primera vez.
// ---------------------------------------------------------------------------

const { loadSqlite, loadSqliteFrom, ReadOnlyDatabase } = sqliteModule;
const unavailable = { unavailable: 'node-too-old' };

{
  const emitted = [];
  const spy = (...args) => emitted.push(args);
  const original = process.emitWarning;
  process.emitWarning = spy;
  let loaded;
  let restored = false;
  try {
    loaded = loadSqliteFrom(() => {
      process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');
      process.emitWarning('Otra cosa experimental', 'ExperimentalWarning');
      process.emitWarning(Object.assign(new Error('SQLite otra vez'), { name: 'ExperimentalWarning' }));
      process.emitWarning('SQLite, pero no experimental', { type: 'DeprecationWarning' });
      return { DatabaseSync: class {} };
    });
    restored = process.emitWarning === spy;
  } finally {
    process.emitWarning = original;
  }
  check('4 durante la carga se filtra solo el aviso experimental de SQLite, en sus formas',
    emitted.length === 2 && emitted[0][0] === 'Otra cosa experimental' && emitted[1][0] === 'SQLite, pero no experimental', show(emitted.map((args) => String(args[0]))));
  check('4 y process.emitWarning vuelve a ser el de antes', restored);
  check('4 con modulo, lo devuelve', typeof loaded?.DatabaseSync === 'function');
  check('4 sin cargador, sin modulo o con un cargador que lanza: node-too-old',
    same(loadSqliteFrom(undefined), unavailable) && same(loadSqliteFrom(() => undefined), unavailable) &&
    same(loadSqliteFrom(() => { throw new Error('x'); }), unavailable));

  /*
    R26-1: con `--experimental-sqlite` una version vieja devuelve el modulo,
    pero su constructor ignora `readOnly` y la base se abriria para escribir.
    Ni se pide el modulo.
  */
  const flagged = (version) => {
    let asked = false;
    const result = loadSqliteFrom(() => {
      asked = true;
      return { DatabaseSync: class {} };
    }, version);
    return { unavailable: 'unavailable' in result, asked };
  };
  const tooOld = ['22.9.0', '22.12.0', '23.0.0', '23.3.0', '20.18.1', 'v22.11.0', 'raro'].map(flagged);
  check('4 una version con el modulo detras de la bandera (22.9, 22.12, 23.0, 23.3), la 20 o una ilegible: node-too-old sin pedir el modulo',
    tooOld.every((result) => result.unavailable && !result.asked), show(tooOld));
  const recent = ['22.13.0', '22.14.0', '23.4.0', '24.0.0', 'v25.1.0'].map(flagged);
  check('4 la 22.13, la 23.4 y posteriores: lo pide y lo devuelve',
    recent.every((result) => !result.unavailable && result.asked), show(recent));
}

const warningsSeen = [];
const onWarning = (warning) => warningsSeen.push(`${warning.name}: ${warning.message}`);
process.on('warning', onWarning);
const emitBefore = process.emitWarning;
const realSqlite = loadSqlite();
// Los avisos salen en un nextTick: dos vueltas del bucle alcanzan.
await flushAsync();
await flushAsync();
process.off('warning', onWarning);
check('4 este Node trae node:sqlite', 'DatabaseSync' in realSqlite, process.version);
check('4 cargarlo no deja salir el aviso experimental y restaura process.emitWarning',
  !warningsSeen.some((warning) => warning.includes('SQLite')) && process.emitWarning === emitBefore, show(warningsSeen));

const base = await createOpenCodeFixture(path.join(fixturesDir, 'base'), openCodeBaseContent());

{
  const missingDir = path.join(root, 'c4-sin-base');
  await mkdir(missingDir, { recursive: true });
  const missing = openDb(path.join(missingDir, 'opencode.db'));
  check('4 archivo inexistente: missing antes de consultar', missing.status() === 'missing');
  check('4 y consultar devuelve vacio, sigue missing',
    same(missing.all(OPENCODE_SQL.listRoots), []) && missing.get(OPENCODE_SQL.sessionById, 'x') === undefined && missing.status() === 'missing');
  check('4 sin dejar ningun archivo en la carpeta', same(await readdir(missingDir), []), show(await readdir(missingDir)));

  let opened = 0;
  let closed = 0;
  class CountingDatabase extends realSqlite.DatabaseSync {
    constructor(...args) {
      super(...args);
      opened += 1;
    }
    close() {
      closed += 1;
      return super.close();
    }
  }
  const counting = () => ({ DatabaseSync: CountingDatabase });

  const reader = openDb(base.file, { sqlite: counting });
  check('4 lee las raices del fixture', reader.all(OPENCODE_SQL.listRoots).length === 3 && reader.status() === 'ok');
  base.insertSession({ id: 'ses_c4_nueva', directory: 'D:/Mi App', title: 'Nueva', time_created: 9000, time_updated: 9000 });
  check('4 lo que confirma un escritor con el lector abierto se ve sin reabrir',
    reader.all(OPENCODE_SQL.listRoots).length === 4 && opened === 1, `abiertas ${opened}`);
  const writeError = errorOf(() => reader.all("INSERT INTO project (id, worktree, time_created, time_updated, sandboxes) VALUES ('x', 'x', 1, 1, '[]')"));
  check('4 escribir falla: la base esta abierta en solo lectura', writeError !== null && /readonly/i.test(writeError), String(writeError));
  check('4 y la consulta siguiente reabre sola', reader.all(OPENCODE_SQL.listRoots).length === 4 && reader.status() === 'ok' && opened === 2, `abiertas ${opened}`);
  reader.close();
  base.remove('session', 'ses_c4_nueva');

  const idle = openDb(base.file, { sqlite: counting, idleCloseMs: 50 });
  const openedBefore = opened;
  const closedBefore = closed;
  idle.all(OPENCODE_SQL.rootStamps);
  check('4 sin consultas, la conexion se cierra sola', await waitFor(() => closed > closedBefore, 2000), `cerradas ${closed}`);
  check('4 y la siguiente consulta la reabre sin que se note',
    idle.all(OPENCODE_SQL.rootStamps).length === 3 && opened === openedBefore + 2, `abiertas ${opened - openedBefore}`);
  idle.close();

  const oldSchema = await createOpenCodeFixture(path.join(fixturesDir, 'sin-revert'), {
    ...openCodeBaseContent(), dropColumns: [{ table: 'session', column: 'revert' }],
  });
  let schemaDb;
  const schemaWarnings = await captureWarnings(async () => {
    schemaDb = openDb(oldSchema.file);
    schemaDb.all(OPENCODE_SQL.listRoots);
    schemaDb.all(OPENCODE_SQL.listRoots);
    schemaDb.get(OPENCODE_SQL.sessionById, 'ses_z_vieja');
  });
  check('4 una columna que falta: schema, todo vacio y un solo aviso con la tabla y la columna',
    schemaDb.status() === 'schema' && same(schemaDb.all(OPENCODE_SQL.listRoots), []) &&
    schemaWarnings.length === 1 && schemaWarnings[0].includes('session.revert'), show(schemaWarnings));
  schemaDb.close();
  oldSchema.close();

  let noSqliteStatus = null;
  const noSqliteWarnings = await captureWarnings(async () => {
    const db = openDb(base.file, { sqlite: () => unavailable });
    noSqliteStatus = db.status();
    db.all(OPENCODE_SQL.listRoots);
    db.all(OPENCODE_SQL.listRoots);
  });
  check('4 sin node:sqlite: no-sqlite antes de consultar, sin abrir nada', noSqliteStatus === 'no-sqlite');
  check('4 y un solo aviso, que dice que el historial necesita Node 22.13',
    noSqliteWarnings.length === 1 && noSqliteWarnings[0].includes('22.13'), show(noSqliteWarnings));
}

// ---------------------------------------------------------------------------
// 2. OPENCODE_SQL, corridas contra el fixture
// ---------------------------------------------------------------------------

{
  const db = openDb(base.file);
  const richIds = db.all(OPENCODE_SQL.messagesSince, 'ses_c_rica', 0).map((row) => row.id);
  const params = {
    listRoots: [], rootStamps: [], sessionById: ['ses_c_rica'], sessionExists: ['ses_c_rica'], sessionHasMessages: ['ses_c_rica'],
    firstUserText: ['ses_c_rica'], sessionSignature: [{ $s: 'ses_c_rica' }], messagesSince: ['ses_c_rica', 0],
    partCountsByMessage: ['ses_c_rica'], partsForMessages: [JSON.stringify(richIds)], partsSince: ['ses_c_rica', 0],
    imageParts: ['msg_c01'], imageUrlById: [{ $id: 'prt_c02g', $max: 100_000_000 }], discoveryRows: [0],
  };
  check('2 cada sentencia tiene sus parametros en este chequeo', same(Object.keys(params).sort(), Object.keys(OPENCODE_SQL).sort()));
  const leaks = [];
  const scans = [];
  for (const [name, sql] of Object.entries(OPENCODE_SQL)) {
    const args = params[name] ?? [];
    if (JSON.stringify(db.all(sql, ...args)).includes('SECRETO')) leaks.push(name);
    const plan = base.writer.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((row) => String(row.detail));
    if (plan.some((detail) => /\bSCAN (message|part)\b/.test(detail))) scans.push(`${name}: ${plan.join(' | ')}`);
  }
  check('2 corridas contra el fixture, ninguna devuelve SECRETO', same(leaks, []), show(leaks));
  check('2 ninguna recorre message ni part enteras (plan de consulta)', same(scans, []), show(scans));
  check('2 imageUrlById no lee la url de lo que no es una parte file',
    db.get(OPENCODE_SQL.imageUrlById, { $id: 'prt_c02g', $max: 100_000_000 }) === undefined);
  const capped = db.get(OPENCODE_SQL.imageUrlById, { $id: 'prt_c01a', $max: 1000 });
  check('2 imageUrlById por encima del tope devuelve null sin los bytes', capped !== undefined && capped.url === null, show(capped));
  db.close();
}

// ---------------------------------------------------------------------------
// 5. DbChangeSignal y el watcher
// ---------------------------------------------------------------------------

const { DbChangeSignal } = await import('../src/agents/opencode/db-signal.ts');

{
  const files = { db: 'X:\\oc\\opencode.db', wal: 'X:\\oc\\opencode.db-wal' };
  const stamps = new Map([
    [files.db, { mtimeMs: 1, size: 10 }],
    [files.wal, { mtimeMs: 1, size: 5 }],
    ['X:\\oc\\opencode.db-shm', { mtimeMs: 1, size: 3 }],
  ]);
  const statted = [];
  let failNext = false;
  let hold = null;
  const stat = async (file) => {
    statted.push(file);
    if (hold !== null) await hold;
    if (failNext) throw new Error('EBUSY');
    return stamps.get(file) ?? null;
  };
  const timers = { started: 0, cleared: 0, handle: null };
  const fakeTimers = {
    setInterval: (callback) => {
      timers.started += 1;
      timers.handle = { callback };
      return timers.handle;
    },
    clearInterval: (handle) => {
      if (handle === timers.handle) timers.cleared += 1;
    },
  };
  const signal = new DbChangeSignal(files, { stat, timers: fakeTimers });
  await signal.tick();
  check('5 sin suscriptores no hay temporizador ni stat', timers.started === 0 && statted.length === 0);

  const heardA = [];
  const heardB = [];
  const stopA = signal.subscribe(() => heardA.push(1));
  await flushAsync();
  check('5 el primer suscriptor arranca el sondeo, y la primera vuelta no avisa', timers.started === 1 && heardA.length === 0 && statted.length === 2);
  const stopB = signal.subscribe(() => heardB.push(1));
  check('5 un segundo suscriptor no arranca otro', timers.started === 1);
  check('5 solo se miran la base y el -wal', same([...new Set(statted)].sort(), [files.db, files.wal].sort()), show(statted));

  stamps.set(files.wal, { mtimeMs: 2, size: 5 });
  await signal.tick();
  check('5 cambia la fecha del -wal: avisa una vez a cada suscriptor', heardA.length === 1 && heardB.length === 1, show([heardA, heardB]));
  await signal.tick();
  check('5 sin cambios, no vuelve a avisar', heardA.length === 1 && heardB.length === 1);

  stamps.set('X:\\oc\\opencode.db-shm', { mtimeMs: 99, size: 99 });
  await signal.tick();
  check('5 un cambio del -shm (lo toca nuestra lectura) no avisa', heardA.length === 1);

  failNext = true;
  const tickError = await signal.tick().then(() => null, (error) => error);
  failNext = false;
  check('5 un stat que lanza no avisa ni rompe el sondeo', tickError === null && heardA.length === 1 && timers.cleared === 0);
  stamps.set(files.db, { mtimeMs: 3, size: 11 });
  await signal.tick();
  check('5 y la vuelta siguiente vuelve a avisar lo que cambio', heardA.length === 2);

  let release;
  hold = new Promise((resolve) => { release = resolve; });
  const before = statted.length;
  const first = signal.tick();
  await signal.tick();
  check('5 una vuelta no se solapa con la que sigue esperando un stat', statted.length === before + 2, `${statted.length - before} stat`);
  release();
  hold = null;
  await first;

  timers.handle.callback();
  await flushAsync();
  stopA();
  check('5 desuscribir a uno no detiene el sondeo', timers.cleared === 0);
  stopB();
  check('5 desuscribir al ultimo lo detiene', timers.cleared === 1);
  const afterStop = statted.length;
  await signal.tick();
  check('5 detenido, no mira nada', statted.length === afterStop);

  const noFiles = new DbChangeSignal(null, { stat, timers: fakeTimers });
  const startedBefore = timers.started;
  noFiles.subscribe(() => undefined)();
  check('5 sin base configurada, suscribirse no arranca nada', timers.started === startedBefore);
  signal.dispose();
  signal.subscribe(() => undefined);
  check('5 despues de dispose, suscribirse no arranca nada', timers.started === startedBefore);
}

{
  // Con el escritor abierto de verdad: el `-wal` cambia y la senal lo ve.
  const { statStamp } = await import('../src/agents/opencode/db-signal.ts');
  let stats = 0;
  const signal = new DbChangeSignal({ db: base.file, wal: base.walFile }, { intervalMs: 25, stat: (file) => { stats += 1; return statStamp(file); } });
  let heard = 0;
  const stop = signal.subscribe(() => { heard += 1; });
  // La primera vuelta fija la firma: se espera a que hayan corrido dos.
  check('5 la senal real sondea', await waitFor(() => stats >= 4, 3000));
  base.insertSession({ id: 'ses_c5_senal', directory: 'D:/Mi App', title: 'Senal', time_created: 9100, time_updated: 9100 });
  check('5 con el escritor abierto, un INSERT se avisa', await waitFor(() => heard > 0, 3000), `avisos ${heard}`);
  stop();
  signal.dispose();
  base.remove('session', 'ses_c5_senal');
}

{
  const { watchSessions } = await import('../src/session-watcher.ts');
  const notices = [];
  const refreshed = [];
  const hub = { onHistoryChanged: (agent, filePath) => notices.push([agent, filePath]) };
  const index = { refreshPath: async (agent, filePath) => { refreshed.push([agent, filePath]); } };
  let listener = null;
  let unsubscribed = 0;
  const dbFile = 'X:\\oc\\opencode.db';
  const root5 = {
    path: dbFile, depth: 0, accepts: (filePath) => filePath === dbFile, awaitWriteFinish: false,
    watch: (onChange) => {
      listener = onChange;
      return () => { unsubscribed += 1; };
    },
  };
  const chokidarCalls = [];
  const agents = { all: () => [{ adapter: { id: 'opencode', history: { roots: () => [root5] } }, location: null }] };
  const stop = watchSessions(index, hub, agents, { rootProbeMs: 40, watch: (target) => { chokidarCalls.push(target); throw new Error('sin chokidar'); } });
  check('5 watcher: una raiz con watch se suscribe ahi, sin chokidar ni sondeo', listener !== null && chokidarCalls.length === 0);
  listener(dbFile);
  check('5 watcher: el aviso llega al hub enseguida', same(notices, [['opencode', dbFile]]), show(notices));
  check('5 watcher: y al indice despues del agrupado', await waitFor(() => refreshed.length === 1, 3000) && same(refreshed, [['opencode', dbFile]]), show(refreshed));
  listener('X:\\oc\\otra.db');
  check('5 watcher: una ruta que la raiz no acepta no avisa', notices.length === 1);
  stop();
  check('5 watcher: cerrar desuscribe', unsubscribed === 1);
  listener(dbFile);
  check('5 watcher: y un aviso tardio ya no llega a nadie', notices.length === 1);
}

// ---------------------------------------------------------------------------
// 6 a 9. Filas -> eventos, uso y catalogo
// ---------------------------------------------------------------------------

const events = await import('../src/agents/opencode/events.ts');
const { buildEvents, buildUsage, applyRevert, parseRevert, toolParts } = events;

/** Las filas de una sesion, tal como las devuelve el SQL de verdad. */
const rowsOf = (db, sessionId) => {
  const messages = db.all(OPENCODE_SQL.messagesSince, sessionId, 0);
  const partsByMessage = new Map();
  for (const part of db.all(OPENCODE_SQL.partsSince, sessionId, 0)) {
    const list = partsByMessage.get(part.message_id) ?? [];
    list.push(part);
    partsByMessage.set(part.message_id, list);
  }
  return { messages, partsByMessage };
};

const rich = (() => {
  const db = openDb(base.file);
  const rows = rowsOf(db, 'ses_c_rica');
  db.close();
  return rows;
})();
const richBuilt = buildEvents({ ...rich, revert: null });
const byId = (id) => richBuilt.events.find((event) => event.eventId === id);

// 6. Usuario.
{
  // Mensajes por (time_created, id) y, dentro de cada uno, partes por (time_created, id).
  check('6 el orden de los eventos: el de los mensajes y, adentro, el de las partes', same(richBuilt.events.map((event) => event.eventId), [
    'msg_c01', 'prt_c02c', 'prt_c02d', 'prt_c02e', 'prt_c02f', 'prt_c02g', 'prt_c03b', 'prt_c03c', 'prt_c03d', 'prt_c03f',
    'msg_c04:compaction', 'msg_c06', 'msg_c07:error', 'msg_c08', 'msg_c09:error',
  ]), show(richBuilt.events.map((event) => event.eventId)));
  const shuffled = buildEvents({ messages: [...rich.messages].reverse(), partsByMessage: new Map([...rich.partsByMessage].map(([k, v]) => [k, [...v].reverse()])), revert: null });
  check('6 el orden no depende de como llegan las filas', same(shuffled.events, richBuilt.events));
  // Ids al reves que el tiempo: el campo de tiempo del id dio la vuelta el 14-08-2026.
  const c01 = rich.messages.find((m) => m.id === 'msg_c01');
  const c06 = rich.messages.find((m) => m.id === 'msg_c06');
  const flipped = buildEvents({
    messages: [{ ...c01, id: 'msg_z', time_created: 1 }, { ...c06, id: 'msg_a', time_created: 2 }],
    partsByMessage: new Map([
      ['msg_z', [{ ...rich.partsByMessage.get('msg_c06')[1], id: 'prt_z', message_id: 'msg_z' }]],
      ['msg_a', [{ ...rich.partsByMessage.get('msg_c06')[1], id: 'prt_a', message_id: 'msg_a' }]],
    ]),
    revert: null,
  });
  check('6 con los ids al reves que el tiempo, manda el tiempo', same(flipped.events.map((e) => e.eventId), ['msg_z', 'msg_a']), show(flipped.events.map((e) => e.eventId)));
  const user = byId('msg_c01');
  check('6 usuario: la imagen primero (indice 0, image/png, content), despues el texto; el adjunto de texto plano no',
    same(user?.parts, [
      { kind: 'image', index: 0, mediaType: 'image/png', source: 'content' },
      { kind: 'text', text: 'Mira la captura y revisa el tablero.', truncated: false },
    ]) && user.role === 'user' && user.at === 3100 && user.model === null, show(user));
  check('6 usuario: el texto sintetico no se dibuja', same(byId('msg_c06')?.parts, [{ kind: 'text', text: 'Segui con los graficos.', truncated: false }]));
  /*
    Medido en vivo con la 1.18.30: al adjuntar una ruta pegada, el TUI deja
    `[Image 1] ` en el texto. Con la imagen en el mensaje la etiqueta se va; sin
    ella, o con un numero que no llego, se queda.
  */
  const userParts = rich.partsByMessage.get('msg_c01');
  const withLabel = (text, keepImage) => buildEvents({
    messages: [{ ...c01, id: 'lbl' }],
    partsByMessage: new Map([['lbl', userParts
      .filter((part) => keepImage || part.type !== 'file')
      .map((part) => ({ ...part, message_id: 'lbl', ...(part.type === 'text' ? { text, text_length: text.length } : {}) }))]]),
    revert: null,
  }).events[0]?.parts.filter((part) => part.kind === 'text').map((part) => part.text);
  check('6 usuario: la etiqueta [Image 1] del TUI se quita con su imagen en el mensaje',
    same(withLabel('[Image 1] ¿Que color tiene?', true), ['¿Que color tiene?']), show(withLabel('[Image 1] ¿Que color tiene?', true)));
  check('6 usuario: [Image 2] sin segunda imagen, y [Image 1] sin ninguna, se quedan tal cual',
    same(withLabel('[Image 2] mira', true), ['[Image 2] mira']) && same(withLabel('[Image 1] mira ', false), ['[Image 1] mira ']),
    show([withLabel('[Image 2] mira', true), withLabel('[Image 1] mira ', false)]));
  check('6 usuario: un mensaje que solo trae la etiqueta y la imagen dibuja solo la imagen',
    same(withLabel('[Image 1] ', true), []), show(withLabel('[Image 1] ', true)));
  const compaction = byId('msg_c04:compaction');
  check('6 compactacion: un aviso aparte, automatico, en su posicion',
    same(compaction?.parts, [{ kind: 'notice', notice: 'compacted', detail: 'auto' }]) && compaction.role === 'assistant' && compaction.at === 3401, show(compaction));
  const synthetic = buildEvents({
    messages: [{ ...rich.messages[0], id: 'u', time_created: 1 }],
    partsByMessage: new Map([['u', [{ ...rich.partsByMessage.get('msg_c06')[0], message_id: 'u' }]]]),
    revert: null,
  });
  check('6 un usuario que solo trae texto sintetico no genera evento', same(synthetic.events, []), show(synthetic.events));
  const manual = buildEvents({
    messages: [{ ...rich.messages.find((m) => m.id === 'msg_c04'), id: 'u2' }],
    partsByMessage: new Map([['u2', [{ ...rich.partsByMessage.get('msg_c04')[0], message_id: 'u2', auto: 0 }]]]),
    revert: null,
  });
  check('6 una compactacion a mano lleva el detalle vacio', same(manual.events[0]?.parts, [{ kind: 'notice', notice: 'compacted', detail: '' }]));
}

// 7. Asistente.
{
  const text = byId('prt_c02c');
  check('7 un evento por texto, con eventId = part.id, cortado a 8000 y marcado',
    text?.parts.length === 1 && text.parts[0].kind === 'text' && text.parts[0].text.length === 8000 && text.parts[0].truncated === true &&
    text.at === 3203 && text.model === 'openai/gpt-5.6-terra' && text.effort === 'xhigh', show({ ...text, parts: text?.parts.map((p) => ({ ...p, text: p.text?.length })) }));
  check('7 la ñ y la tilde sobreviven al corte en SQL', text?.parts[0].text.startsWith('Análisis ñ'));
  check('7 razonamiento, step-start, step-finish y patch no generan eventos',
    !richBuilt.events.some((event) => ['prt_c02a', 'prt_c02b', 'prt_c02h', 'prt_c03a', 'prt_c03e', 'prt_c03g'].includes(event.eventId)));
  const bash = byId('prt_c02d');
  check('7 bash completed: llamada con la entrada indentada y resultado cortado a 4000',
    same(bash?.parts, [
      { kind: 'tool-call', toolUseId: 'prt_c02d', name: 'bash', input: JSON.stringify({ command: 'dir', workdir: 'D:\\Otro', timeout: 120000 }, null, 2), truncated: false },
      { kind: 'tool-result', toolUseId: 'prt_c02d', text: 'o'.repeat(4000), isError: false, truncated: true, imageCount: 0 },
    ]), show(bash?.parts.map((p) => ({ ...p, text: p.text?.length }))));
  check('7 read con error: resultado con isError',
    same(byId('prt_c02e')?.parts[1], { kind: 'tool-result', toolUseId: 'prt_c02e', text: 'File not found: D:\\Otro\\falta.txt', isError: true, truncated: false, imageCount: 0 }),
    show(byId('prt_c02e')?.parts));
  check('7 bash running: la llamada sin resultado', byId('prt_c02f')?.parts.length === 1 && byId('prt_c02f').parts[0].kind === 'tool-call');
  const write = byId('prt_c02g');
  check('7 una entrada de 20 000: cruda, cortada a 2000 y marcada; los adjuntos se cuentan',
    write?.parts[0].input.length === 2000 && write.parts[0].truncated === true && write.parts[0].input.startsWith('{"filePath"') &&
    write.parts[1].imageCount === 1 && write.parts[1].text === 'Wrote file successfully.', show(write?.parts.map((p) => ({ ...p, input: p.input?.length }))));
  check('7 el paso de compactacion (summary) no dibuja nada', !richBuilt.events.some((event) => event.eventId.startsWith('prt_c05') || event.eventId.startsWith('msg_c05')));
  check('7 MessageAbortedError -> interrumpido', same(byId('msg_c07:error')?.parts, [{ kind: 'notice', notice: 'interrupted', detail: '' }]));
  check('7 APIError -> error con nombre y mensaje',
    same(byId('msg_c09:error')?.parts, [{ kind: 'notice', notice: 'error', detail: 'APIError: Insufficient balance' }]) && byId('msg_c09:error').at === 3950,
    show(byId('msg_c09:error')));
  check('7 ningun string de ningun evento contiene SECRETO', !JSON.stringify(richBuilt.events).includes('SECRETO'));
  check('7 el uso va en el ultimo evento visible del mensaje, y solo ahi',
    same(write?.usage, { inputTokens: 1269, outputTokens: 499, cacheCreationInputTokens: 0, cacheReadInputTokens: 47616 }) &&
    byId('prt_c02d').usage === null && byId('prt_c02c').usage === null, show(write?.usage));
  check('7 duracion: del mensaje del usuario al cierre del ultimo paso, en su ultimo evento visible',
    byId('prt_c03f')?.durationMs === 290 && byId('msg_c09:error')?.durationMs === 150 && byId('prt_c02g')?.durationMs === null &&
    same([...richBuilt.turns], [['prt_c03f', 290], ['msg_c09:error', 150]]), show([...richBuilt.turns]));
  check('7 un paso sin cerrar (aborted sin completed) no da duracion', byId('msg_c07:error')?.durationMs === null);
  const onlyToolCalls = buildEvents({ messages: rich.messages.filter((m) => m.id === 'msg_c01' || m.id === 'msg_c02'), partsByMessage: rich.partsByMessage, revert: null });
  check('7 un paso cerrado que pidio herramientas no cierra el turno: sin duracion',
    onlyToolCalls.turns.size === 0 && onlyToolCalls.events.every((e) => e.durationMs === null), show([...onlyToolCalls.turns]));

  const revertMark = parseRevert('{"messageID":"msg_c06","snapshot":"x"}');
  check('7 parseRevert lee messageID y partID opcional',
    same(revertMark, { messageId: 'msg_c06', partId: null }) && same(parseRevert('{"messageID":"m","partID":"p"}'), { messageId: 'm', partId: 'p' }) &&
    parseRevert(null) === null && parseRevert('no es json') === null && parseRevert('{"x":1}') === null);
  const reverted = buildEvents({ ...rich, revert: revertMark });
  check('7 revert: se descartan el mensaje marcado y todo lo posterior',
    reverted.events.at(-1)?.eventId === 'msg_c04:compaction' && !reverted.events.some((event) => event.eventId === 'msg_c06'), show(reverted.events.map((e) => e.eventId)));
  const partReverted = buildEvents({ ...rich, revert: { messageId: 'msg_c03', partId: 'prt_c03d' } });
  check('7 revert con parte: de ese mensaje quedan las anteriores',
    same(partReverted.events.map((e) => e.eventId).slice(-3), ['prt_c02g', 'prt_c03b', 'prt_c03c']), show(partReverted.events.map((e) => e.eventId)));
}

// 8. Preguntas.
{
  check('8 pregunta completed: la pregunta estructurada y el resultado "<encabezado>: <respuesta>"', same(byId('prt_c03b')?.parts, [
    {
      kind: 'question', toolUseId: 'prt_c03b', questions: [{
        question: '¿Que formato preferis?', header: 'Formato', multiSelect: false,
        options: [{ label: 'Tabla', description: 'Filas y columnas' }, { label: 'Lista', description: 'Vinetas' }],
      }],
    },
    { kind: 'tool-result', toolUseId: 'prt_c03b', text: 'Formato: Tabla', isError: false, truncated: false, imageCount: 0 },
  ]), show(byId('prt_c03b')?.parts));
  check('8 pregunta running: sin resultado, y multiple -> multiSelect', same(byId('prt_c03c')?.parts, [{
    kind: 'question', toolUseId: 'prt_c03c', questions: [{
      question: '¿Que colores usas?', header: 'Colores', multiSelect: true, options: [{ label: 'Rojo', description: '' }, { label: 'Azul', description: '' }],
    }],
  }]), show(byId('prt_c03c')?.parts));
  check('8 entrada malformada: herramienta generica con su salida',
    byId('prt_c03d')?.parts[0].kind === 'tool-call' && byId('prt_c03d').parts[0].name === 'question' && byId('prt_c03d').parts[1].text === 'sin respuesta');
  const rowOf = (id) => [...rich.partsByMessage.values()].flat().find((part) => part.id === id);
  const noLabel = toolParts({ ...rowOf('prt_c03b'), input_json: JSON.stringify({ questions: [{ question: 'q', options: [{ label: 'a' }, { description: 'sin label' }] }] }) });
  check('8 una opcion sin label: todo o nada, cae a la generica', noLabel[0].kind === 'tool-call', show(noLabel));
  const badAnswers = toolParts({ ...rowOf('prt_c03b'), answers_json: 'no es json' });
  check('8 respuestas que no se entienden: el resultado es la salida de la CLI', badAnswers[1]?.text.startsWith('User has answered'), show(badAnswers[1]));
}

// 9. Uso y catalogo.
{
  const visible = applyRevert({ ...rich, revert: null }).messages;
  const usage = buildUsage(visible, 1_050_000);
  check('9 la ultima peticion es el paso mas reciente sin summary: input + cache.read + cache.write', same(usage, {
    lastRequestTokens: 50512, lastOutputTokens: 300, lastModel: 'openai/gpt-5.6-terra', contextWindow: 1_050_000,
    contextWindowEstimated: false, totalInputTokens: 168091, totalOutputTokens: 2723, totalCacheReadTokens: 95616, assistantMessages: 3,
  }), show(usage));
  check('9 tokens mayores que la ventana: sin ventana', buildUsage(visible, 40_000).contextWindow === null);
  check('9 sin catalogo: sin ventana', buildUsage(visible, null).contextWindow === null);
  const onlySummary = buildUsage(visible.filter((message) => message.id === 'msg_c05'), 1_050_000);
  check('9 si todos son summary, el mas reciente', onlySummary.lastRequestTokens === 164822 && onlySummary.assistantMessages === 1, show(onlySummary));
  check('9 los de 0 tokens no cuentan: sin pasos con tokens, el uso vacio',
    same(buildUsage(visible.filter((message) => message.id === 'msg_c07' || message.id === 'msg_c09'), 1_050_000), shared.EMPTY_CONTEXT_USAGE));

  const { ModelCatalog, catalogWindows } = await import('../src/agents/opencode/catalog.ts');
  const catalogFile = path.join(root, 'models.json');
  await writeFile(catalogFile, JSON.stringify(OPENCODE_MODELS_FIXTURE));
  const catalog = new ModelCatalog(catalogFile);
  check('9 catalogo: 1 050 000 con openai y 372 000 con otro, para el mismo modelo',
    (await catalog.contextWindow('openai', 'gpt-5.6-terra')) === 1_050_000 && (await catalog.contextWindow('otro', 'gpt-5.6-terra')) === 372_000);
  check('9 catalogo: modelo o proveedor ausente -> null',
    (await catalog.contextWindow('openai', 'nada')) === null && (await catalog.contextWindow(null, 'gpt-5.6-terra')) === null);
  check('9 catalogo: sin archivo configurado -> null', (await new ModelCatalog(null).contextWindow('openai', 'gpt-5.6-terra')) === null);
  check('9 catalogo: archivo inexistente -> null sin lanzar', (await new ModelCatalog(path.join(root, 'no-hay.json')).contextWindow('openai', 'gpt-5.6-terra')) === null);
  const invalidFile = path.join(root, 'invalido.json');
  await writeFile(invalidFile, '{ esto no es json');
  check('9 catalogo: JSON invalido -> null sin lanzar', (await new ModelCatalog(invalidFile).contextWindow('openai', 'gpt-5.6-terra')) === null);
  check('9 catalogo: limit.context que no es un numero se descarta',
    catalogWindows({ p: { models: { a: { limit: { context: '5' } }, b: { limit: {} }, c: { limit: { context: 7 } } } } }).size === 1);

  let clock = 0;
  let stats = 0;
  const reloading = new ModelCatalog(catalogFile, {
    now: () => clock,
    recheckMs: 1000,
    stat: async (file) => { stats += 1; return (await import('node:fs/promises')).stat(file); },
  });
  await reloading.contextWindow('openai', 'gpt-5.6-terra');
  await writeFile(catalogFile, JSON.stringify({ openai: { models: { 'gpt-5.6-terra': { limit: { context: 400000 } } } } }));
  await utimes(catalogFile, new Date(), new Date(Date.now() + 60_000));
  const statsBefore = stats;
  check('9 catalogo: dentro de la espera no se vuelve a mirar el archivo',
    (await reloading.contextWindow('openai', 'gpt-5.6-terra')) === 1_050_000 && stats === statsBefore);
  clock = 5000;
  check('9 catalogo: pasada la espera, un mtime distinto se relee', (await reloading.contextWindow('openai', 'gpt-5.6-terra')) === 400_000);
}

// ---------------------------------------------------------------------------
// 10 y 11. El seguidor
// ---------------------------------------------------------------------------

const { OpenCodeSessionFollower, messageBatches, diffEvents } = await import('../src/agents/opencode/session-follower.ts');
const followerOf = (db, sessionId, extra = {}) => new OpenCodeSessionFollower({ db, catalog: fakeCatalog, sessionId, dbFile: base.file, ...extra });

// 10. Carga y orden.
{
  const db = openDb(base.file);
  const follower = followerOf(db, 'ses_c_rica');
  check('10 antes de leer: waiting', follower.getState() === 'waiting');
  await follower.start();
  const first = await follower.poll();
  check('10 la carga inicial entrega los eventos en (time_created, id), igual que buildEvents',
    !first.reset && same(first.added, richBuilt.events) && follower.getState() === 'live', show(first.added.map((e) => e.eventId)));
  check('10 el uso sale con la ventana del catalogo', follower.getUsage().lastRequestTokens === 50512 && follower.getUsage().contextWindow === 1_050_000);
  const tail = follower.getTail(3);
  check('10 getTail: los ultimos, y dice que hay mas', same(tail.events.map((e) => e.eventId), ['msg_c07:error', 'msg_c08', 'msg_c09:error']) && tail.hasMore);
  const page = follower.getPageBefore('msg_c07:error', 2);
  check('10 getPageBefore: el tramo anterior', same(page.events.map((e) => e.eventId), ['msg_c04:compaction', 'msg_c06']) && page.hasMore);
  check('10 getPageBefore de un id que no esta: vacio', same(follower.getPageBefore('nada', 2), { events: [], hasMore: false }));
  check('10 label y aviso: la base y la sesion', follower.label === `${base.file}#ses_c_rica` && follower.noticeChange(base.file) && !follower.noticeChange(`${base.file}-wal`));
  check('10 sin ciclo de permisos ni planes', follower.getPermissionMode() === null && same(follower.getPlanFiles(), []));

  const bigImage = await follower.readImage('msg_c01', 0, 'content');
  check('10 readImage: los bytes exactos de la imagen, con su tipo',
    bigImage?.mediaType === 'image/png' && bigImage.data.length === fixture.BIG_IMAGE_BASE64_LENGTH && /^A+$/.test(bigImage.data.slice(0, 100)));
  const capped = followerOf(db, 'ses_c_rica', { imageUrlMaxChars: 1000 });
  check('10 readImage: por encima del tope -> null', (await capped.readImage('msg_c01', 0, 'content')) === null);
  check('10 readImage: indice que no esta, fuente attachment o indice invalido -> null',
    (await follower.readImage('msg_c01', 1, 'content')) === null && (await follower.readImage('msg_c01', 0, 'attachment')) === null &&
    (await follower.readImage('msg_c01', -1, 'content')) === null);

  const smallData = Buffer.from('png chico').toString('base64');
  base.insertSession({ id: 'ses_img', directory: 'D:/Otro', title: 'Imagen', time_created: 5000, time_updated: 5000 });
  const imgMessage = messageRow('ses_img', 'msg_img', 5001, { role: 'user', time: { created: 5001 } });
  base.insertMessage(imgMessage);
  base.insertPart(partRow(imgMessage, 'prt_img_txt', 5002, { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,aG9sYQ==' }));
  base.insertPart(partRow(imgMessage, 'prt_img_a', 5003, { type: 'file', mime: 'image/png', url: `data:image/png;base64,${smallData}` }));
  base.insertPart(partRow(imgMessage, 'prt_img_b', 5004, { type: 'file', mime: 'image/jpeg', url: 'data:image/png;base64,MAL' }));
  const imgFollower = followerOf(db, 'ses_img');
  const imgPoll = await imgFollower.poll();
  check('10 readImage del fixture chico: base64 exacta, contando solo las imagenes',
    same(await imgFollower.readImage('msg_img', 0, 'content'), { mediaType: 'image/png', data: smallData }) &&
    same(imgPoll.added[0]?.parts.map((p) => p.index), [0, 1]));
  check('10 readImage: una url que no dice el mismo tipo -> null', (await imgFollower.readImage('msg_img', 1, 'content')) === null);

  const nobody = followerOf(db, 'ses_no_existe');
  const nobodyPoll = await nobody.poll();
  check('10 sesion inexistente: waiting, sin reset', nobody.getState() === 'waiting' && !nobodyPoll.reset && nobodyPoll.added.length === 0);
  const empty = followerOf(db, '');
  await empty.poll();
  check('10 sin sesion todavia: waiting', empty.getState() === 'waiting' && empty.label.endsWith('(sin sesion)'));

  // Tandas: nueve mensajes de 100 partes.
  base.insertSession({ id: 'ses_lote', directory: 'D:/Otro', title: 'Lote', time_created: 6000, time_updated: 6000 });
  for (let m = 0; m < 9; m += 1) {
    const message = messageRow('ses_lote', `msg_l${m}`, 6000 + m * 200, { role: 'assistant', parentID: 'msg_nadie', time: { created: 6000 + m * 200 } });
    base.insertMessage(message);
    for (let p = 0; p < 100; p += 1) {
      base.insertPart(partRow(message, `prt_l${m}_${String(p).padStart(3, '0')}`, 6000 + m * 200 + p, { type: 'text', text: `parte ${m}.${p}` }));
    }
  }
  const spied = spyDb(db);
  let yields = 0;
  const batched = followerOf(spied, 'ses_lote', { yieldBetweenBatches: async () => { yields += 1; } });
  const batchedPoll = await batched.poll();
  const batchCalls = spied.calls.filter((call) => call.name === 'partsForMessages');
  check('10 con 900 partes, la carga va en tres tandas y ninguna pasa de 400 filas',
    batchCalls.length === 3 && batchCalls.every((call) => call.rows <= 400) && yields === 2, show(batchCalls));
  check('10 y la carga inicial nunca pide partsSince sobre la sesion entera', !spied.calls.some((call) => call.name === 'partsSince'));
  const single = followerOf(db, 'ses_lote', { partsPerBatch: 1_000_000 });
  check('10 el resultado es el mismo que en una sola tanda', same((await single.poll()).added, batchedPoll.added) && batchedPoll.added.length === 900);
  check('10 messageBatches: corta al llegar al tope, un mensaje enorme va solo, los vacios no se piden',
    same(messageBatches(['a', 'b', 'c', 'd', 'e'], new Map([['a', 300], ['b', 150], ['c', 0], ['d', 900], ['e', 1]]), 400), [['a', 'b'], ['d'], ['e']]));

  // Solo sesiones: sin la columna, las partes del fixture no se podrian insertar.
  const schemaFixture = await createOpenCodeFixture(path.join(fixturesDir, 'follower-schema'), {
    sessions: openCodeBaseContent().sessions, dropColumns: [{ table: 'part', column: 'time_updated' }],
  });
  const schemaDb = openDb(schemaFixture.file);
  const schemaFollower = followerOf(schemaDb, 'ses_c_rica');
  await captureWarnings(async () => { await schemaFollower.poll(); });
  check('10 una base sin las columnas que se leen: unavailable', schemaFollower.getState() === 'unavailable');
  schemaDb.close();
  schemaFixture.close();
  db.close();
}

// 11. Incremental.
{
  const db = openDb(base.file);
  const spied = spyDb(db);
  const tokens = (input, output, read) => ({ total: input + output + read, input, output, reasoning: 0, cache: { read, write: 0 } });
  base.insertSession({ id: 'ses_inc', directory: 'D:/Otro', title: 'Incremental', time_created: 20000, time_updated: 20000 });
  const user = messageRow('ses_inc', 'msg_i1', 20000, { role: 'user', time: { created: 20000 } });
  base.insertMessage(user);
  base.insertPart(partRow(user, 'prt_i1a', 20001, { type: 'text', text: 'hola' }));
  const stepData = { role: 'assistant', parentID: 'msg_i1', providerID: 'openai', modelID: 'gpt-5.6-terra', time: { created: 20100 }, tokens: tokens(0, 0, 0) };
  const step = messageRow('ses_inc', 'msg_i2', 20100, stepData);
  base.insertMessage(step);
  base.insertPart(partRow(step, 'prt_i2a', 20101, { type: 'text', text: 'Empiezo' }));
  base.insertPart(partRow(step, 'prt_i2b', 20102, { type: 'tool', tool: 'bash', state: { status: 'running', input: { command: 'dir' } } }));

  const follower = followerOf(spied, 'ses_inc');
  const first = await follower.poll();
  check('11 la carga inicial', same(first.added.map((e) => e.eventId), ['msg_i1', 'prt_i2a', 'prt_i2b']));
  check('11 una herramienta running de este proceso es una llamada abierta; de uno anterior, no',
    follower.hasOpenToolCall(20000) && !follower.hasOpenToolCall(30000));

  spied.calls.length = 0;
  const idle = await follower.poll();
  check('11 sin cambios: resultado vacio, y solo se preguntan la sesion y la firma',
    same(idle, { reset: false, added: [], turns: [], plans: [], parts: [] }) && same(spied.calls.map((c) => c.name), ['sessionById', 'sessionSignature']),
    show([idle, spied.calls]));

  base.insertPart(partRow(step, 'prt_i2c', 20103, { type: 'text', text: 'Sigo' }));
  const appended = await follower.poll();
  check('11 parte nueva al final -> added, sin releer la sesion entera',
    same(appended.added.map((e) => e.eventId), ['prt_i2c']) && !appended.reset && appended.parts.length === 0 &&
    !spied.calls.some((call) => call.name === 'partsForMessages'), show(appended));

  base.update('part', 'prt_i2a', { data: { type: 'text', text: 'Empiezo ahora' }, time_updated: 20200 });
  const grown = await follower.poll();
  check('11 texto que crece -> parts con ese evento',
    same(grown.parts, [{ eventId: 'prt_i2a', parts: [{ kind: 'text', text: 'Empiezo ahora', truncated: false }] }]) && grown.added.length === 0, show(grown));

  base.update('part', 'prt_i2b', { data: { type: 'tool', tool: 'bash', state: { status: 'completed', input: { command: 'dir' }, output: 'ok' } }, time_updated: 20300 });
  const finished = await follower.poll();
  check('11 herramienta running -> completed: parts con el resultado',
    finished.parts.length === 1 && finished.parts[0].eventId === 'prt_i2b' && finished.parts[0].parts[1]?.text === 'ok', show(finished));
  check('11 terminada, ya no es una llamada abierta', !follower.hasOpenToolCall(20000));

  base.update('message', 'msg_i2', {
    data: { ...stepData, time: { created: 20100, completed: 20400 }, finish: 'stop', tokens: tokens(1000, 50, 9000) }, time_updated: 20400,
  });
  const closed = await follower.poll();
  check('11 el paso que cierra el turno -> turns con completed - created, en el ultimo evento visible',
    same(closed.turns, [{ eventId: 'prt_i2c', durationMs: 400 }]) && closed.added.length === 0, show(closed));
  check('11 y los tokens que llegan al cerrar el paso marcan usageChanged (M2)',
    closed.usageChanged === true && follower.getUsage().lastRequestTokens === 10000 && follower.getUsage().contextWindow === 1_050_000, show(follower.getUsage()));
  const quiet = await follower.poll();
  check('11 sin cambios despues: sin usageChanged', quiet.usageChanged !== true);

  // 20300 es el mayor time_updated de las partes vistas: el cursor.
  base.insertPart(partRow(step, 'prt_i2d', 20104, { type: 'text', text: 'Otra' }, 20300));
  const sameCursor = await follower.poll();
  const ids = follower.getTail(100).events.map((event) => event.eventId);
  check('11 fila con time_updated igual al cursor: se lee una vez, sin duplicar',
    same(sameCursor.added.map((e) => e.eventId), ['prt_i2d']) && ids.length === new Set(ids).size, show(ids));

  base.insertPart(partRow(step, 'prt_i2e', 20105, { type: 'text', text: '' }, 20500));
  base.insertPart(partRow(step, 'prt_i2f', 20106, { type: 'text', text: 'Despues' }, 20600));
  const skipEmpty = await follower.poll();
  check('11 una parte vacia no se dibuja', same(skipEmpty.added.map((e) => e.eventId), ['prt_i2f']), show(skipEmpty));
  base.update('part', 'prt_i2e', { data: { type: 'text', text: 'Tarde' }, time_updated: 20700 });
  const late = await follower.poll();
  check('11 una parte vacia que se llena despues de un evento posterior ya entregado -> reset', late.reset === true, show(late));
  check('11 y despues del reset la vista trae todo en orden',
    same(follower.getTail(100).events.map((e) => e.eventId), ['msg_i1', 'prt_i2a', 'prt_i2b', 'prt_i2c', 'prt_i2d', 'prt_i2e', 'prt_i2f']));

  const extra = messageRow('ses_inc', 'msg_i3', 20800, { role: 'user', time: { created: 20800 } });
  base.insertMessage(extra);
  base.insertPart(partRow(extra, 'prt_i3a', 20801, { type: 'text', text: 'una mas' }));
  check('11 un mensaje nuevo -> added', same((await follower.poll()).added.map((e) => e.eventId), ['msg_i3']));
  base.remove('message', 'msg_i3');
  const removed = await follower.poll();
  check('11 mensaje borrado -> reset, y ya no esta', removed.reset === true && !follower.getTail(100).events.some((e) => e.eventId === 'msg_i3'), show(removed));

  base.update('session', 'ses_inc', { revert: JSON.stringify({ messageID: 'msg_i2' }), time_updated: 20900 });
  const revertPoll = await follower.poll();
  check('11 revert fijado -> reset, y desde ese mensaje desaparece todo',
    revertPoll.reset === true && same(follower.getTail(100).events.map((e) => e.eventId), ['msg_i1']), show(follower.getTail(100).events.map((e) => e.eventId)));

  base.remove('session', 'ses_inc');
  const gone = await follower.poll();
  check('11 la sesion borrada -> reset y waiting', gone.reset === true && follower.getState() === 'waiting' && follower.getTail(10).events.length === 0);

  check('11 diffEvents: un entregado que cambia de orden -> null',
    diffEvents([{ eventId: 'a', parts: [], durationMs: null }, { eventId: 'b', parts: [], durationMs: null }],
      [{ eventId: 'b', parts: [], durationMs: null }, { eventId: 'a', parts: [], durationMs: null }]) === null);
  db.close();
}

// 11. El hub manda un append vacio cuando solo cambio el uso (M2).
{
  const { ConversationHub } = await import('../src/conversation-hub.ts');
  const { AgentRegistry } = await import('../src/agents/registry.ts');
  const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
  const catalogFile = path.join(root, 'hub-models.json');
  await writeFile(catalogFile, JSON.stringify(OPENCODE_MODELS_FIXTURE));
  const adapter = createOpenCodeAdapter({ env: { OPENCODE_DB: base.file, OPENCODE_MODELS_PATH: catalogFile }, home, platform: process.platform });
  const registry = new AgentRegistry([adapter]);
  const tokens = (input, read) => ({ total: input + read, input, output: 10, reasoning: 0, cache: { read, write: 0 } });
  base.insertSession({ id: 'ses_hub', directory: 'D:/Otro', title: 'Hub', time_created: 30000, time_updated: 30000 });
  const hubUser = messageRow('ses_hub', 'msg_hub1', 30000, { role: 'user', time: { created: 30000 } });
  base.insertMessage(hubUser);
  base.insertPart(partRow(hubUser, 'prt_hub1a', 30001, { type: 'text', text: 'hola' }));
  const stepData = { role: 'assistant', parentID: 'msg_hub1', providerID: 'openai', modelID: 'gpt-5.6-terra', time: { created: 30100 }, tokens: tokens(0, 0) };
  base.insertMessage(messageRow('ses_hub', 'msg_hub2', 30100, stepData));
  base.insertPart(partRow({ id: 'msg_hub2', session_id: 'ses_hub' }, 'prt_hub2a', 30101, { type: 'text', text: 'Listo.' }));

  const descriptor = {
    terminalId: 't-oc', kind: 'agent', cwd: 'D:\\Otro', agent: 'opencode', sessionId: 'ses_hub', label: 't-oc', resumed: false,
    createdAt: 0, alive: true, exitCode: null, sleeping: false,
  };
  const hub = new ConversationHub({ get: (id) => (id === 't-oc' ? descriptor : null), on: () => undefined, launchedAtOf: () => null }, registry);
  const appends = [];
  hub.on('append', (...args) => appends.push(args));
  const snapshot = await hub.subscribe('t-oc');
  check('11 hub: la suscripcion trae la conversacion de OpenCode', same(snapshot?.events.map((e) => e.eventId), ['msg_hub1', 'prt_hub2a']) && snapshot.state === 'live');
  base.update('message', 'msg_hub2', { data: { ...stepData, time: { created: 30100, completed: 30200 }, finish: 'stop', tokens: tokens(2000, 30000) }, time_updated: 30200 });
  hub.onHistoryChanged('opencode', base.file);
  check('11 hub: solo cambio el uso -> un append sin eventos con el uso nuevo',
    await waitFor(() => appends.some(([, added, usage]) => added.length === 0 && usage.lastRequestTokens === 32000 && usage.contextWindow === 1_050_000), 3000),
    show(appends.map(([, added, usage]) => [added.length, usage.lastRequestTokens])));
  hub.disposeAll();
  registry.disposeAll();
}

// ---------------------------------------------------------------------------
// 12. El historial
// ---------------------------------------------------------------------------

const { createOpenCodeHistory, nativeCwd, DEFAULT_TITLE_PATTERN } = await import('../src/agents/opencode/history.ts');
const historyFixture = await createOpenCodeFixture(path.join(fixturesDir, 'historial'), openCodeBaseContent());
const historyOf = (file, extra = {}) => {
  const warnings = [];
  const subscriptions = [];
  const db = openDb(file);
  const history = createOpenCodeHistory({
    dbFile: file, db, catalog: fakeCatalog, platform: 'win32', sqlite: loadSqlite,
    signal: { subscribe: (listener) => { subscriptions.push(listener); return () => undefined; } },
    warn: (message) => warnings.push(message),
    ...extra,
  });
  return { history, db, warnings, subscriptions };
};

{
  const { history, db, warnings, subscriptions } = historyOf(historyFixture.file);
  const items = await history.list();
  check('12 list: las raices en (time_created, id), sin la hija', same(items?.map((item) => item.ref), ['ses_z_vieja', 'ses_a_nueva', 'ses_c_rica']), show(items));
  check('12 cada item: ref y sesion = id, fecha = time_updated, tamano 0, grupo = la carpeta como la escribio OpenCode',
    same(items?.[1], { ref: 'ses_a_nueva', sessionId: 'ses_a_nueva', group: 'D:\\Mi App', mtimeMs: 2400, sizeBytes: 0 }), show(items?.[1]));

  const scanned = await history.scan(items[1]);
  check('12 scan con titulo por defecto: el primer texto no sintetico, first-message, cwd nativo', same(scanned, {
    cwd: 'D:\\Mi App',
    summary: { sessionId: 'ses_a_nueva', title: 'Revisa las notas y propone un plan.', titleSource: 'first-message', updatedAt: 2400, sizeBytes: 0 },
    extra: {},
  }), show(scanned));
  const own = await history.scan(items[0]);
  check('12 scan con titulo propio: ai, y el cwd con / pasa a \\ en win32',
    own.summary.title === 'Ordenar el menu principal' && own.summary.titleSource === 'ai' && own.cwd === 'D:\\Mi App', show(own));
  check('12 las dos formas de la carpeta dan la misma clave de proyecto',
    shared.normalizeCwdKey(own.cwd, 'win32') === shared.normalizeCwdKey(scanned.cwd, 'win32'));
  const posix = historyOf(historyFixture.file, { platform: 'linux' });
  check('12 en otras plataformas el cwd va crudo', (await posix.history.scan(items[0])).cwd === 'D:/Mi App');
  posix.db.close();
  check('12 ningun aviso de sesion sin mensajes con raices que los tienen', warnings.length === 0, show(warnings));

  historyFixture.insertSession({ id: 'ses_vacia', directory: '', title: 'New session - 2026-09-02T10:00:00.000Z', time_created: 4000, time_updated: 4000 });
  const bare = await history.item('ses_vacia');
  const bareScan = await history.scan(bare);
  check('12 sin texto que sirva de titulo: "Sesion sin titulo", none; sin carpeta: grupo = la sesion y cwd null',
    bareScan.summary.title === 'Sesion sin titulo' && bareScan.summary.titleSource === 'none' && bareScan.cwd === null && bare.group === 'ses_vacia', show([bare, bareScan]));
  await history.scan(bare);
  check('12 una raiz sin mensajes avisa una sola vez', warnings.length === 1 && warnings[0].includes('message'), show(warnings));
  historyFixture.remove('session', 'ses_vacia');

  check('12 item: la hija no, una que no esta no, una raiz si',
    (await history.item('ses_hija')) === null && (await history.item('ses_nada')) === null && (await history.item('ses_c_rica'))?.mtimeMs === 3990);
  let missingScan;
  try { missingScan = await history.scan({ ...items[0], ref: 'ses_nada' }); } catch (error) { missingScan = error; }
  // R26-4: lanzar es "no se pudo leer", y el indice conservaria la sesion; una que ya no esta da null y se quita.
  check('12 scan de una sesion que ya no esta -> null, no lanza (el indice la quita)', missingScan === null, String(missingScan));
  check('12 exists: true y false', (await history.exists('D:\\Mi App', 'ses_c_rica')) === true && (await history.exists('D:\\Mi App', 'ses_nada')) === false);

  const roots = history.roots();
  check('12 roots: una, la base, sin chokidar (watch) y con accepts exacto',
    roots.length === 1 && roots[0].path === historyFixture.file && typeof roots[0].watch === 'function' && roots[0].awaitWriteFinish === false &&
    roots[0].accepts(historyFixture.file) && !roots[0].accepts(`${historyFixture.file}-wal`), show(roots));
  const heard = [];
  roots[0].watch((filePath) => heard.push(filePath));
  subscriptions[0]();
  check('12 roots: el aviso de la senal llega como un cambio de la base', same(heard, [historyFixture.file]));
  check('12 follow: el seguidor de OpenCode, y sin planes ni relectura periodica',
    history.follow({ cwd: 'D:\\Mi App', sessionId: 'ses_c_rica' }).label === `${historyFixture.file}#ses_c_rica` && history.plans === null && history.followPollMs === null);

  const noSqlite = historyOf(historyFixture.file, { sqlite: () => unavailable });
  check('12 sin node:sqlite no hay raiz', same(noSqlite.history.roots(), []));
  noSqlite.db.close();
  const inMemory = historyOf(historyFixture.file, { dbFile: null });
  check('12 con la base en memoria: sin raiz y sin historial', same(inMemory.history.roots(), []) && (await inMemory.history.list()) === null);
  inMemory.db.close();

  const absentDir = path.join(root, 'c12-sin-base');
  await mkdir(absentDir, { recursive: true });
  const absent = historyOf(path.join(absentDir, 'opencode.db'));
  check('12 base ausente: list null, exists false, y no se crea nada',
    (await absent.history.list()) === null && (await absent.history.exists('D:\\x', 'ses_c_rica')) === false && same(await readdir(absentDir), []));
  check('12 base ausente: la raiz se declara igual, para verla nacer', absent.history.roots().length === 1);
  absent.db.close();

  const oldSchema = historyOf(path.join(fixturesDir, 'sin-revert', 'opencode.db'));
  let oldList;
  await captureWarnings(async () => { oldList = await oldSchema.history.list(); });
  check('12 una base sin las columnas que se leen: list null, no una lista vacia que borraria la barra', oldList === null, show(oldList));
  oldSchema.db.close();

  check('12 nativeCwd', nativeCwd('D:/Mi App/', 'win32') === 'D:\\Mi App' && nativeCwd('D:/', 'win32') === 'D:\\' &&
    nativeCwd('//srv/share/x/', 'win32') === '\\\\srv\\share\\x' && nativeCwd('/home/u', 'win32') === '/home/u' &&
    nativeCwd('D:/x', 'linux') === 'D:/x' && nativeCwd('', 'win32') === null);
  check('12 los titulos por defecto de OpenCode', DEFAULT_TITLE_PATTERN.test('New session - 2026-09-01T10:00:00.000Z') &&
    DEFAULT_TITLE_PATTERN.test('Child session - 2026-09-01T10:00:00.000Z') && !DEFAULT_TITLE_PATTERN.test('New session - hola'));
  db.close();

  // El indice de verdad, con el adaptador de verdad: los proyectos y la hija.
  const { SessionIndex } = await import('../src/session-index.ts');
  const { AgentRegistry } = await import('../src/agents/registry.ts');
  const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
  const adapter = createOpenCodeAdapter({ env: { OPENCODE_DB: historyFixture.file }, home, platform: 'win32' });
  const index = new SessionIndex(new AgentRegistry([adapter]));
  await index.scan();
  const projects = index.getProjects();
  const sessions = projects.flatMap((project) => project.sessions);
  check('12 indice: las tres raices, de OpenCode, y la hija no',
    same(sessions.map((s) => s.sessionId).sort(), ['ses_a_nueva', 'ses_c_rica', 'ses_z_vieja']) && sessions.every((s) => s.agent === 'opencode'),
    show(sessions.map((s) => [s.sessionId, s.agent])));
  const miApp = projects.find((project) => project.sessions.some((s) => s.sessionId === 'ses_z_vieja'));
  check('12 indice: las dos formas de D:\\Mi App son un solo proyecto', miApp?.sessions.length === 2, show(projects.map((p) => [p.key, p.sessions.length])));
  adapter.dispose();

  // B8: el archivado propio de la app, por sessionId, con un id de OpenCode.
  const { ArchivedSessions } = await import('../src/archived-sessions.ts');
  const archived = new ArchivedSessions();
  await archived.load();
  archived.set(['ses_3f2a9c1b7e5d4a2b8c6e0f1a2b'], true);
  await archived.flush();
  const archivedAgain = new ArchivedSessions();
  await archivedAgain.load();
  check('12 un ses_... archivado va y vuelve', archivedAgain.has('ses_3f2a9c1b7e5d4a2b8c6e0f1a2b'));
}

// ---------------------------------------------------------------------------
// 13. El adaptador
// ---------------------------------------------------------------------------

{
  const opencode = await import('../src/agents/opencode/index.ts');
  const { buildSubmissionWrites } = await import('../src/pty-input.ts');
  const { createOpenCodeAdapter, OPENCODE_CAPABILITIES, OPENCODE_INPUT, OPENCODE_INSTALL_URL } = opencode;
  const customDb = path.join(root, 'proyecto-de-prueba', 'oc.db');
  const adapter = createOpenCodeAdapter({ env: { OPENCODE_DB: customDb }, home: 'C:\\Users\\u', platform: 'win32' });
  check('13 capacidades iguales al literal', same(adapter.capabilities, {
    sessionIdAtLaunch: false, resume: true, statusSource: false, readySignal: false, permissionCycle: null, models: null, efforts: null,
    questionCards: false, imagesByPath: 'bare-path-paste', fileMentions: null, rewind: false, contextWindowSource: 'usage-with-catalog', plans: false,
  }) && adapter.capabilities === OPENCODE_CAPABILITIES, show(adapter.capabilities));
  check('13 las capacidades sobreviven al viaje por la red', same(shared.parseAgentCapabilities(JSON.parse(JSON.stringify(adapter.capabilities))), adapter.capabilities));
  check('13 envio: imagenes por ruta pegada sola (medido en vivo), el Enter aparte, 400 ms y dos Esc', same(adapter.input, {
    imageReference: 'bare-path-paste', pieceGapMs: 400, pasteMarkers: true, enterSeparately: true, interruptPresses: 2,
  }) && adapter.input === OPENCODE_INPUT && adapter.input.imageReference === adapter.capabilities.imagesByPath, show(adapter.input));
  check('13 id, etiqueta, comando y enlace', adapter.id === 'opencode' && adapter.label === 'OpenCode' && adapter.command === 'opencode' &&
    adapter.installUrl === 'https://opencode.ai/docs/' && OPENCODE_INSTALL_URL === adapter.installUrl);
  check('13 el texto de no instalada nombra el comando y el enlace', adapter.missingMessage().includes('"opencode"') && adapter.missingMessage().includes(OPENCODE_INSTALL_URL));
  check('13 AGENT_IDS nombra al adaptador, al final', shared.AGENT_IDS.at(-1) === 'opencode' && shared.MEMORY_AGENT_IDS.includes('opencode'));

  const location = { resolvedPath: '/bin/opencode', file: '/bin/opencode', prefixArgs: [], version: '1.18.30' };
  const fresh = adapter.launch({ location, cwd: 'D:\\x', resumeSessionId: null, proposedSessionId: 'propuesto' });
  check('13 sesion nueva: sin argumentos, y se descubre', fresh.file === '/bin/opencode' && same(fresh.args, []) && same(fresh.session, { kind: 'discover' }), show(fresh));
  const id = 'ses_3f2a9c1b7e5d4a2b8c6e0f1a2b';
  const resumed = adapter.launch({ location, cwd: 'D:\\x', resumeSessionId: id, proposedSessionId: 'propuesto' });
  check('13 reanudar: -s con el id, conocido', same(resumed.args, ['-s', id]) && same(resumed.session, { kind: 'known', sessionId: id }), show(resumed));
  const shim = adapter.launch({ location: { resolvedPath: 'C:\\x.cmd', file: 'cmd.exe', prefixArgs: ['/c', 'x.cmd'], version: null }, cwd: 'D:\\x', resumeSessionId: id, proposedSessionId: '' });
  check('13 con un shim, los argumentos del interprete van primero', shim.file === 'cmd.exe' && same(shim.args, ['/c', 'x.cmd', '-s', id]), show(shim));
  const hostile = [`${id}&calc`, `ses_x&calc.exe`, `${id}"`, `ses_3f2a9c1b 7e5d4a2b8c6e0f1a2b`, `${id}^`, `${id}\r\n`, 'ses_', 'ses_corto', '3f2a9c1b-7e5d-4a2b-8c6e-0f1a2b3c4d5e', `SES_3f2a9c1b7e5d4a2b8c6e0f1a2b`];
  const shimLocation = { resolvedPath: 'C:\\x.cmd', file: 'cmd.exe', prefixArgs: ['/c', 'x.cmd'], version: null };
  const accepted = hostile.filter((value) =>
    errorOf(() => adapter.launch({ location: shimLocation, cwd: 'D:\\x', resumeSessionId: value, proposedSessionId: '' })) !== 'Id de sesion de OpenCode invalido.');
  check('13 un id con &, comillas, espacio, ^, salto de linea, corto o que no es ses_ lanza y no llega a los argumentos (A1)', same(accepted, []), show(accepted));

  const environment = adapter.environment({ PATH: 'p', OPENCODE_DB: 'x', CLAUDE_CODE_CHILD_SESSION: '1', VACIA: undefined });
  check('13 entorno: copia sin claves nuevas, sin undefined, sin quitar nada y sin aviso',
    same(environment, { env: { PATH: 'p', OPENCODE_DB: 'x', CLAUDE_CODE_CHILD_SESSION: '1' }, notice: null }), show(environment));
  check('13 defaults: null (opencode.json no se abre)', (await adapter.defaults('D:\\x')) === null);
  check('13 status: null', adapter.status === null);
  const context = (resumedFlag) => ({
    terminalId: 't', sessionId: '', cwd: 'D:\\x', resumed: resumedFlag, pid: 1, launchedAt: 1,
    readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: () => undefined,
  });
  check('13 onSpawned: una reanudacion ya sabe su sesion y no engancha nada', adapter.onSpawned(context(true)) === null);
  const discoveryHook = adapter.onSpawned(context(false));
  check('13 onSpawned: una sesion nueva engancha el descubrimiento, que sobrevive a lo que se escribe y mira al salir (paso 7)',
    discoveryHook !== null && typeof discoveryHook.cancel === 'function' && typeof discoveryHook.onInput === 'function' &&
    typeof discoveryHook.onSubmitted === 'function' && typeof discoveryHook.onExit === 'function', show(Object.keys(discoveryHook ?? {})));
  discoveryHook?.cancel();
  check('13 protectedDirs: las cuatro carpetas bajo el home, y no la de un OPENCODE_DB propio', same(adapter.protectedDirs(), [
    'C:\\Users\\u\\.local\\share\\opencode', 'C:\\Users\\u\\.config\\opencode', 'C:\\Users\\u\\.cache\\opencode', 'C:\\Users\\u\\.local\\state\\opencode',
  ]) && !adapter.protectedDirs().some((dir) => customDb.startsWith(dir)), show(adapter.protectedDirs()));
  adapter.dispose();

  const P = (text) => `\x1b[200~${text}\x1b[201~`;
  check('13 envio de OpenCode: el pegado y el Enter en dos piezas', same(buildSubmissionWrites('hola\nchau', [], OPENCODE_INPUT), [P('hola\nchau'), '\r']),
    show(buildSubmissionWrites('hola\nchau', [], OPENCODE_INPUT)));
  check('13 envio de OpenCode sin enviar: solo el pegado', same(buildSubmissionWrites('hola', [], OPENCODE_INPUT, { send: false }), [P('hola')]));
  // 17. Con lo medido en vivo: cada imagen en su pegado, la ruta sola y sin comillas aunque tenga espacios, antes del texto; el Enter al final.
  check('17 envio de OpenCode con imagenes: una pieza por ruta, sin comillas, despues el texto y el Enter',
    same(buildSubmissionWrites('hola', ['C:\\Mi Carpeta\\a.png', 'C:\\b.png'], OPENCODE_INPUT), [P('C:\\Mi Carpeta\\a.png'), P('C:\\b.png'), P('hola'), '\r']),
    show(buildSubmissionWrites('hola', ['C:\\Mi Carpeta\\a.png', 'C:\\b.png'], OPENCODE_INPUT)));
  check('17 una imagen sola, sin texto: su pegado y el Enter', same(buildSubmissionWrites('', ['C:\\a.png'], OPENCODE_INPUT), [P('C:\\a.png'), '\r']));
  check('17 un ESC[201~ en la ruta sale saneado', !(buildSubmissionWrites('x', ['C:\\a\x1b[201~b.png'], OPENCODE_INPUT)?.[0] ?? '').slice(6, -6).includes('\x1b'));
  check('13 un pegado de OpenCode no deja pasar un ESC[201~ del texto', same(buildSubmissionWrites('a\x1b[201~b', [], OPENCODE_INPUT)?.[0].includes('\x1b[201~b'), false));
  const { CLAUDE_CODE_INPUT } = await import('../src/agents/claude-code/index.ts');
  const { CODEX_INPUT } = await import('../src/agents/codex/index.ts');
  check('13 Claude Code sigue con una sola pieza y el Enter adentro', same(buildSubmissionWrites('hola', [], CLAUDE_CODE_INPUT), [`${P('hola')}\r`]));
  check('13 Codex declara el Enter aparte, que ya era asi', CODEX_INPUT.enterSeparately === true && same(buildSubmissionWrites('hola', [], CODEX_INPUT), [P('hola'), '\r']));

  const { createAgentRegistry } = await import('../src/agents/registry.ts');
  const registry = createAgentRegistry();
  check('13 registro: claude-code, codex y opencode, en ese orden', same(registry.all().map(({ adapter: a }) => a.id), ['claude-code', 'codex', 'opencode']));
  registry.get('opencode').location = { resolvedPath: '/bin/opencode', file: '/bin/opencode', prefixArgs: [], version: '1.18.30' };
  check('13 con opencode sola, es la de por defecto', registry.defaultAgent() === 'opencode');
  registry.get('codex').location = { resolvedPath: '/bin/codex', file: '/bin/codex', prefixArgs: [], version: 'codex-cli 0.154.0' };
  check('13 con codex tambien, gana codex', registry.defaultAgent() === 'codex');
  const info = registry.list().find((entry) => entry.id === 'opencode');
  const parsed = shared.parseAgentInfo(JSON.parse(JSON.stringify(info)));
  check('13 hello: el cliente lee la CLI entera', parsed !== null && parsed.id === 'opencode' && same(parsed.capabilities, info.capabilities) && parsed.available, show(parsed));
  const base13 = { PATH: 'p', CLAUDE_CODE_CHILD_SESSION: '1' };
  check('13 el entorno compuesto no cambia por opencode', same(registry.composedEnvironment(base13), { PATH: 'p' }));
  registry.disposeAll();
}

// ---------------------------------------------------------------------------
// 14. changedRefs
// ---------------------------------------------------------------------------

{
  const { history, db } = historyOf(historyFixture.file);
  check('14 una ruta ajena -> null', (await history.changedRefs('D:\\otra\\opencode.db')) === null && (await history.changedRefs(`${historyFixture.file}-wal`)) === null);
  const beforeList = await history.changedRefs(historyFixture.file);
  check('14 sin lista previa, todas las raices son nuevas', same(beforeList, ['ses_z_vieja', 'ses_a_nueva', 'ses_c_rica']), show(beforeList));
  await history.list();
  historyFixture.update('session', 'ses_z_vieja', { time_updated: 5000 });
  historyFixture.insertSession({ id: 'ses_nueva_raiz', directory: 'D:/Otro', title: 'Nueva', time_created: 4500, time_updated: 4500 });
  historyFixture.insertSession({ id: 'ses_hija_dos', parent_id: 'ses_a_nueva', directory: 'D:/Mi App', title: 'y (@explore subagent)', time_created: 4600, time_updated: 4600 });
  historyFixture.remove('session', 'ses_c_rica');
  const changed = await history.changedRefs(historyFixture.file);
  check('14 [nueva, cambiada, borrada], exacto, y la hija no', same(changed, ['ses_nueva_raiz', 'ses_z_vieja', 'ses_c_rica']), show(changed));
  check('14 una segunda llamada sin cambios -> []', same(await history.changedRefs(historyFixture.file), []));
  db.close();

  const garbage = path.join(root, 'no-es-una-base.db');
  await writeFile(garbage, 'esto no es sqlite, pero es lo bastante largo para parecer un archivo cualquiera '.repeat(20));
  const broken = historyOf(garbage);
  let brokenList;
  let brokenRefs;
  let brokenExists;
  await captureWarnings(async () => {
    brokenList = await broken.history.list();
    brokenRefs = await broken.history.changedRefs(garbage);
    brokenExists = await broken.history.exists('D:\\x', 'ses_c_rica');
  });
  check('14 base ilegible: list null, changedRefs [] y exists true (ante la duda se intenta -s)',
    brokenList === null && same(brokenRefs, []) && brokenExists === true, show([brokenList, brokenRefs, brokenExists]));
  broken.db.close();
}

/*
  R26-4: la base falla despues de que `changedRefs` ya dio la sesion por vista.
  Con `item` o `scan` fallando, antes la sesion se iba de la barra y no volvia
  hasta su proximo cambio. Ahora queda, y la vuelve a pedir el aviso siguiente.
*/
{
  const retryFixture = await createOpenCodeFixture(path.join(fixturesDir, 'reintento'), openCodeBaseContent());
  const inner = openDb(retryFixture.file);
  /** La proxima vez que corra esa sentencia, SQLITE_BUSY. Una sola vez. */
  const failOnce = new Set();
  const flaky = {
    status: () => inner.status(),
    all: (sql, ...params) => inner.all(sql, ...params),
    get: (sql, ...params) => {
      if (failOnce.delete(sql)) throw Object.assign(new Error('database is locked'), { errcode: 5 });
      return inner.get(sql, ...params);
    },
  };
  const { history, db: unused } = historyOf(retryFixture.file, { db: flaky });
  unused.close();

  // La fuente sola: la ref que no se pudo leer vuelve una vez en la proxima respuesta.
  await history.list();
  retryFixture.update('session', 'ses_z_vieja', { time_updated: 6000 });
  check('14 R26-4 fuente: la cambiada sale', same(await history.changedRefs(retryFixture.file), ['ses_z_vieja']));
  failOnce.add(OPENCODE_SQL.sessionById);
  let itemError = null;
  try { await history.item('ses_z_vieja'); } catch (error) { itemError = error; }
  check('14 R26-4 fuente: item con la base ocupada lanza, no da null', itemError instanceof Error, String(itemError));
  check('14 R26-4 fuente: sin cambios, el aviso siguiente la vuelve a dar, y el otro ya no',
    same(await history.changedRefs(retryFixture.file), ['ses_z_vieja']) && same(await history.changedRefs(retryFixture.file), []));

  // El indice de verdad sobre esa fuente.
  const { SessionIndex } = await import('../src/session-index.ts');
  const fakeAdapter = { id: 'opencode', history };
  const index = new SessionIndex({ all: () => [{ adapter: fakeAdapter, location: null }], adapter: () => fakeAdapter });
  await index.scan();
  const updatedOf = (id) => index.getProjects().flatMap((project) => project.sessions).find((s) => s.sessionId === id)?.updatedAt ?? null;
  check('14 R26-4 indice: las tres raices', ['ses_z_vieja', 'ses_a_nueva', 'ses_c_rica'].every((id) => updatedOf(id) !== null));

  retryFixture.update('session', 'ses_c_rica', { time_updated: 9000 });
  failOnce.add(OPENCODE_SQL.sessionById);
  await index.refreshPath('opencode', retryFixture.file);
  check('14 R26-4 indice: item falla una vez -> la sesion sigue en la barra, con lo que tenia', updatedOf('ses_c_rica') === 3990, show(updatedOf('ses_c_rica')));
  await index.refreshPath('opencode', retryFixture.file);
  check('14 R26-4 indice: el aviso siguiente, sin cambios en la base, la relee', updatedOf('ses_c_rica') === 9000, show(updatedOf('ses_c_rica')));

  // `ses_a_nueva` tiene el titulo por defecto: su primer texto solo lo pide scan, despues de un item que salio bien.
  retryFixture.update('session', 'ses_a_nueva', { time_updated: 9100 });
  failOnce.add(OPENCODE_SQL.firstUserText);
  await index.refreshPath('opencode', retryFixture.file);
  check('14 R26-4 indice: scan falla una vez -> la sesion sigue en la barra', updatedOf('ses_a_nueva') === 2400, show(updatedOf('ses_a_nueva')));
  await index.refreshPath('opencode', retryFixture.file);
  check('14 R26-4 indice: y el aviso siguiente la relee', updatedOf('ses_a_nueva') === 9100, show(updatedOf('ses_a_nueva')));

  retryFixture.remove('session', 'ses_z_vieja');
  await index.refreshPath('opencode', retryFixture.file);
  check('14 R26-4 indice: una borrada de verdad si se quita', updatedOf('ses_z_vieja') === null && updatedOf('ses_c_rica') === 9000);
  inner.close();
  retryFixture.close();
}

// ---------------------------------------------------------------------------
// 15. Descubrir la sesion de una pestana nueva (paso 7)
// ---------------------------------------------------------------------------

const discoveryModule = await import('../src/agents/opencode/discovery.ts');
const { matchDiscoveries, isTypedSubmission, OpenCodeSessionDiscovery, DISCOVERY_SKEW_MS } = discoveryModule;

// 15a. matchDiscoveries, pura.
{
  const key = (cwd) => shared.normalizeCwdKey(cwd, 'win32');
  const tab = (terminalId, launchedAt, submittedAt = null, cwd = 'd:\\mi app\\') => ({ terminalId, cwdKey: key(cwd), launchedAt, submittedAt });
  const row = (id, time_created, directory = 'D:/Mi App') => ({ id, directory, time_created });
  const brief = (assignments) => assignments.map(({ terminalId, sessionId, uncertain }) => [terminalId, sessionId, uncertain]);
  const none = new Set();

  check('15 el margen de relojes es de 2 s', DISCOVERY_SKEW_MS === 2000);
  check('15 una pendiente que envio y una fila del mismo proyecto (D:/Mi App contra d:\\mi app\\) -> asignada, sin duda',
    same(brief(matchDiscoveries([row('ses_1', 5000)], [tab('A', 4000, 4500)], none, 'win32')), [['A', 'ses_1', false]]));
  /*
    R26-3, con lo medido en vivo: la fila nace con el primer mensaje, nunca al
    lanzar. Sola y sin un envio que la explique, la abrio OpenCode Desktop u
    `opencode` en otra terminal: no se asigna.
  */
  const aloneSilent = matchDiscoveries([row('ses_1', 5000)], [tab('A', 4000)], none, 'win32');
  check('15 una pendiente sola que no envio nada -> nada: la fila es de otro proceso', same(aloneSilent, []), show(aloneSilent));
  // Sin margen para el envio: uno posterior a la fila, aunque sea por 1 ms, no pudo crearla.
  const aloneLate = matchDiscoveries([row('ses_1', 5000)], [tab('A', 4000, 5001)], none, 'win32');
  const aloneEdge = matchDiscoveries([row('ses_1', 5000)], [tab('A', 4000, 5000)], none, 'win32');
  check('15 una pendiente sola que envio 1 ms despues de la fila -> nada; a la misma hora -> sin duda',
    same(aloneLate, []) && same(brief(aloneEdge), [['A', 'ses_1', false]]), show([aloneLate, aloneEdge]));
  check('15 la misma fila en linux, con otra forma de la carpeta, no casa (la clave depende de la plataforma)',
    same(matchDiscoveries([row('ses_1', 5000)], [{ ...tab('A', 4000, 4500), cwdKey: shared.normalizeCwdKey('d:\\mi app\\', 'linux') }], none, 'linux'), []));
  check('15 una fila de antes del lanzamiento menos 2 s -> nada; justo en el borde -> asignada',
    same(matchDiscoveries([row('ses_1', 1999)], [tab('A', 4000, 1500)], none, 'win32'), []) &&
    same(brief(matchDiscoveries([row('ses_1', 2000)], [tab('A', 4000, 2000)], none, 'win32')), [['A', 'ses_1', false]]));
  check('15 otro proyecto -> nada', same(matchDiscoveries([row('ses_1', 5000, 'D:/Otro')], [tab('A', 4000, 4500)], none, 'win32'), []));
  check('15 una fila sin carpeta -> nada', same(matchDiscoveries([row('ses_1', 5000, '')], [{ ...tab('A', 4000, 4500), cwdKey: '' }], none, 'win32'), []));
  check('15 un id que este proceso ya asigno -> nada', same(matchDiscoveries([row('ses_1', 5000)], [tab('A', 4000, 4500)], new Set(['ses_1']), 'win32'), []));

  const secondSent = matchDiscoveries([row('ses_1', 9100)], [tab('A', 1000), tab('B', 3000, 9000)], none, 'win32');
  check('15 dos pendientes y solo la segunda envio antes de la fila -> la segunda, sin duda', same(brief(secondSent), [['B', 'ses_1', false]]), show(secondSent));
  const firstSent = matchDiscoveries([row('ses_1', 9100)], [tab('A', 1000, 9000), tab('B', 3000)], none, 'win32');
  check('15 dos pendientes y solo la lanzada primero envio -> esa, aunque la otra sea mas nueva', same(brief(firstSent), [['A', 'ses_1', false]]), show(firstSent));
  const nobodySent = matchDiscoveries([row('ses_1', 9100)], [tab('A', 3000), tab('B', 1000)], none, 'win32');
  check('15 dos sin envio -> nada: la fila es de otro proceso', same(nobodySent, []), show(nobodySent));
  const lateSend = matchDiscoveries([row('ses_1', 9100)], [tab('A', 1000, 9101), tab('B', 3000)], none, 'win32');
  check('15 un envio posterior a la fila no cuenta: sin otro envio, nada', same(lateSend, []), show(lateSend));
  const lateAndOnTime = matchDiscoveries([row('ses_1', 9100)], [tab('A', 1000, 9101), tab('B', 3000, 9000)], none, 'win32');
  check('15 uno tarde y otro a tiempo -> el de a tiempo, sin duda', same(brief(lateAndOnTime), [['B', 'ses_1', false]]), show(lateAndOnTime));
  check('15 una fila sin duda no lleva motivo', secondSent[0]?.reason === null);
  const bothBefore = matchDiscoveries([row('ses_1', 9100)], [tab('A', 1000, 8000), tab('B', 3000, 9000)], none, 'win32');
  check('15 dos que enviaron antes de la fila -> la del envio mas nuevo, dudosa y con motivo',
    same(brief(bothBefore), [['B', 'ses_1', true]]) && /varias/.test(bothBefore[0]?.reason ?? ''), show(bothBefore));

  const twoByTwo = matchDiscoveries([row('ses_2', 7100), row('ses_1', 5100)], [tab('A', 1000, 5000), tab('B', 1500, 7000)], none, 'win32');
  check('15 dos filas y dos pendientes -> una a cada una, en el orden de las filas, sin duda', same(brief(twoByTwo), [['A', 'ses_1', false], ['B', 'ses_2', false]]), show(twoByTwo));
  /*
    Una sesion ajena que nace poco antes de un envio: con un margen, iba
    primero en el orden y le ganaba a la sesion de la pestana.
  */
  const foreignFirst = matchDiscoveries([row('ses_ajena', 6500), row('ses_propia', 7400)], [tab('A', 1000, 7000)], none, 'win32');
  check('15 una sesion ajena nacida medio segundo antes del envio no le gana a la propia',
    same(brief(foreignFirst), [['A', 'ses_propia', false]]), show(foreignFirst));
  const bothAfter = matchDiscoveries([row('ses_1', 5100)], [tab('A', 1000, 5500), tab('B', 1500, 6000)], none, 'win32');
  check('15 si las dos enviaron despues de la fila -> nada', same(bothAfter, []), show(bothAfter));
  const sameTime = matchDiscoveries([row('ses_b', 5000), row('ses_a', 5000)], [tab('A', 1000, 4000)], none, 'win32');
  check('15 dos filas con la misma hora: se desempata por id, y la pestana se asigna una sola vez', same(brief(sameTime), [['A', 'ses_a', false]]), show(sameTime));

  const typed = ['\r', 'hola\r', 'a\rb'].map(isTypedSubmission);
  const notTyped = ['\x1b[I', '\x1b[O', '\x1b[200~hola\x1b[201~\r', '\x1b\r', '\x1b[?1;2c', 'hola', '', '\n'].map(isTypedSubmission);
  check('15 un Enter tecleado cuenta como envio; ESC[I, ESC[O, un pegado entre marcadores, Alt+Enter, respuestas de la terminal y texto sin Enter no',
    typed.every(Boolean) && notTyped.every((value) => !value), show([typed, notTyped]));
}

// 15b. OpenCodeSessionDiscovery contra una base de prueba, con un aviso de mentira.
{
  const found = await createOpenCodeFixture(path.join(fixturesDir, 'descubrimiento'), {});
  const listeners = new Set();
  const signal = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire: () => { for (const listener of [...listeners]) listener(); },
  };
  let clock = 0;
  const warnings = [];
  const db = openDb(found.file);
  const discovery = new OpenCodeSessionDiscovery({ db, signal, platform: 'win32', now: () => clock, warn: (message) => warnings.push(message) });
  const reports = [];
  const context = (terminalId, launchedAt, cwd = 'D:\\Proyecto') => ({ terminalId, cwd, launchedAt, reportSessionId: (id) => reports.push([terminalId, id]) });
  const insert = (id, time_created, directory = 'D:/Proyecto') => found.insertSession({ id, directory, title: 'New session - 2026-09-13T10:00:00.000Z', time_created, time_updated: time_created });

  check('15 sin pendientes no escucha la base', !discovery.isListening() && listeners.size === 0);
  insert('ses_temprana_000000000000000001', 10_500);
  const hookA = discovery.track(context('A', 10_000));
  check('15 track: escucha la base, y no asigna adentro de onSpawned', discovery.isListening() && listeners.size === 1 && discovery.pendingCount() === 1 && reports.length === 0, show(reports));
  // El envio que la creo, antes del intento inmediato: sin el, la asignacion saldria dudosa.
  clock = 10_400;
  hookA.onSubmitted('hola');
  await flushAsync();
  check('15 track: el intento inmediato corre despues, y encuentra la fila que ya estaba, sin aviso',
    same(reports, [['A', 'ses_temprana_000000000000000001']]) && warnings.length === 0, show([reports, warnings]));
  check('15 sin pendientes deja de escuchar', !discovery.isListening() && listeners.size === 0 && discovery.pendingCount() === 0);
  hookA.onInput('hola\r');
  hookA.onSubmitted('hola');
  hookA.onExit();
  check('15 un gancho ya casado ignora lo que se escribe y la salida', discovery.pendingCount() === 0 && reports.length === 1);

  reports.length = 0;
  const hookB = discovery.track(context('B', 20_000));
  const hookC = discovery.track(context('C', 21_000));
  await flushAsync();
  hookB.onInput('\x1b[I');
  hookC.onInput('\x1b[I');
  hookC.onInput('\x1b[?1;2c');
  clock = 25_000;
  hookB.onInput('listo\r');
  clock = 26_000;
  hookC.onInput('\x1b[200~otro\x1b[201~');
  insert('ses_de_b_00000000000000000001', 25_100);
  // Un segundo Enter antes de que se mire: cuenta el primer envio, que es el que pudo crear la sesion.
  clock = 28_000;
  hookB.onInput('\r');
  signal.fire();
  check('15 dos pestanas: el foco y las respuestas de la terminal no cuentan, el primer Enter tecleado en la lanzada primero decide, sin aviso',
    same(reports, [['B', 'ses_de_b_00000000000000000001']]) && warnings.length === 0 && discovery.pendingCount() === 1 && discovery.isListening(), show([reports, warnings]));

  const hookLate = discovery.track(context('D', 25_050));
  const hookGone = discovery.track(context('X', 25_060));
  await flushAsync();
  check('15 una fila ya asignada no se le da a otra pestana', reports.length === 1 && discovery.pendingCount() === 3, show(reports));
  hookGone.cancel();
  check('15 cancel suelta solo esa pestana', discovery.pendingCount() === 2 && discovery.isListening());

  // C y D esperan en el mismo proyecto y ninguna tecleo un Enter: decide el envio del cuadro, no el lanzamiento (D es la mas nueva).
  clock = 30_000;
  hookC.onSubmitted('mensaje del cuadro');
  insert('ses_de_c_00000000000000000001', 30_100);
  signal.fire();
  check('15 el envio del cuadro de escritura decide entre dos pestanas, sin aviso',
    same(reports.at(-1), ['C', 'ses_de_c_00000000000000000001']) && warnings.length === 0 && discovery.pendingCount() === 1, show([reports, warnings]));
  hookLate.cancel();
  check('15 con ninguna esperando deja de escuchar', discovery.pendingCount() === 0 && !discovery.isListening());
  hookB.cancel();
  hookC.cancel();

  const hookE = discovery.track(context('E', 40_000));
  await flushAsync();
  clock = 40_400;
  hookE.onSubmitted('hola');
  insert('ses_de_e_00000000000000000001', 40_500);
  hookE.onExit();
  check('15 al salir el proceso mira una vez mas, y despues suelta', same(reports.at(-1), ['E', 'ses_de_e_00000000000000000001']) && discovery.pendingCount() === 0);
  check('15 hasta aca, ninguna asignacion dudosa', warnings.length === 0, show(warnings));

  // R26-3: una pestana sola que no escribio, y una sesion que abre otro proceso en la misma carpeta.
  const hookS = discovery.track(context('S', 45_000));
  await flushAsync();
  insert('ses_de_otro_proceso_000000001', 46_000);
  signal.fire();
  const reportsBeforeS = reports.length;
  check('15 sola y sin envio: la sesion que nace en su carpeta no se le asigna, y la pestana sigue esperando la suya',
    reports.length === reportsBeforeS && discovery.pendingCount() === 1 && discovery.isListening() && warnings.length === 0,
    show([reports, warnings]));
  // Su propio envio, despues: la sesion que crea ese envio si es suya.
  clock = 47_000;
  hookS.onSubmitted('hola');
  insert('ses_de_s_00000000000000000001', 47_400);
  signal.fire();
  check('15 ...y la que nace despues de su envio si, sin aviso',
    same(reports.at(-1), ['S', 'ses_de_s_00000000000000000001']) && discovery.pendingCount() === 0 && warnings.length === 0,
    show([reports, warnings]));
  hookS.cancel();

  const hookF = discovery.track(context('F', 50_000));
  const hookG = discovery.track(context('G', 50_500));
  await flushAsync();
  insert('ses_ajena_de_dos_00000000000001', 51_000);
  signal.fire();
  check('15 dos sin envio: la sesion ajena no va a ninguna',
    reports.length === reportsBeforeS + 1 && discovery.pendingCount() === 2 && warnings.length === 0, show([reports, warnings]));
  clock = 52_000;
  hookF.onSubmitted('uno');
  clock = 52_100;
  hookG.onSubmitted('dos');
  insert('ses_dudosa_000000000000000001', 52_500);
  signal.fire();
  check('15 dos que enviaron antes de la fila: la del envio mas nuevo, y un aviso con la sesion',
    same(reports.at(-1), ['G', 'ses_dudosa_000000000000000001']) && warnings.length === 1 && warnings[0].includes('ses_dudosa_000000000000000001') && warnings[0].includes('reanuda'),
    show([reports, warnings]));
  hookF.cancel();
  hookG.cancel();

  const first = discovery.track(context('H', 60_000));
  const relaunched = discovery.track(context('H', 61_000));
  first.cancel();
  check('15 el cancel de un lanzamiento viejo no suelta al nuevo de la misma pestana', discovery.pendingCount() === 1 && discovery.isListening());
  relaunched.cancel();

  const failing = new OpenCodeSessionDiscovery({ db: { all: () => { throw new Error('database is locked'); } }, signal, platform: 'win32' });
  const failingHook = failing.track(context('I', 70_000));
  await flushAsync();
  let attemptError = null;
  try { failing.attempt(); } catch (error) { attemptError = error; }
  check('15 una base que falla no rompe el intento ni suelta la pestana', attemptError === null && failing.pendingCount() === 1);
  failingHook.cancel();
  failing.dispose();

  discovery.track(context('J', 80_000));
  discovery.dispose();
  check('15 dispose suelta todo y deja de escuchar', discovery.pendingCount() === 0 && !discovery.isListening() && listeners.size === 0);
  db.close();

  // 15c. De punta a punta: el adaptador de verdad, su sondeo de la base y el registro del gancho.
  const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
  const { LaunchHookSlot } = await import('../src/launch-hook-slot.ts');
  const adapter = createOpenCodeAdapter({ env: { OPENCODE_DB: found.file }, home, platform: 'win32' });
  const live = [];
  const hook = adapter.onSpawned({
    terminalId: 'K', sessionId: '', cwd: 'D:\\Proyecto', resumed: false, pid: 1, launchedAt: Date.now(),
    readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: (id) => live.push(id),
  });
  const slot = new LaunchHookSlot();
  slot.set(hook);
  slot.input('\x1b[I');
  slot.input('hola\r');
  check('15 el registro no suelta el descubrimiento con el foco ni con un Enter', slot.active);
  await flushAsync();
  /*
    Cambios ajenos primero, hasta que el sondeo avise uno: prueba que ya tiene
    su firma antes de que nazca la fila buscada. Uno solo podia caer antes de
    la primera vuelta del sondeo y quedar adentro de la firma, sin aviso.
  */
  const probe = [];
  const stopProbe = adapter.history.roots()[0].watch(() => probe.push(1));
  let foreign = 0;
  const probed = await waitFor(() => {
    if (probe.length > 0) return true;
    foreign += 1;
    found.insertSession({ id: `ses_ajena_${String(foreign).padStart(20, '0')}`, directory: 'D:/Otro', title: 'x', time_created: Date.now(), time_updated: Date.now() });
    return false;
  }, 5000);
  const liveId = 'ses_en_vivo_00000000000000001';
  found.insertSession({ id: liveId, directory: 'D:/Proyecto', title: 'x', time_created: Date.now(), time_updated: Date.now() });
  const heard = await waitFor(() => live.length > 0, 5000);
  check('15 de punta a punta: el aviso de la base casa la pestana con su sesion, y la ajena no',
    probed && heard && same(live, [liveId]), show(live));
  stopProbe();
  slot.cancel();
  adapter.dispose();

  /*
    Apagar el adaptador suelta tambien a las pestanas que esperaban: en el
    apagado los adaptadores se liberan antes que las pestanas, y la pasada final
    de cada salida no puede reabrir la base ya cerrada ni avisar una sesion.
  */
  const closing = createOpenCodeAdapter({ env: { OPENCODE_DB: found.file }, home, platform: 'win32' });
  const afterDispose = [];
  const waiting = closing.onSpawned({
    terminalId: 'L', sessionId: '', cwd: 'D:\\Cierre', resumed: false, pid: 2, launchedAt: Date.now(),
    readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: (id) => afterDispose.push(id),
  });
  closing.dispose();
  found.insertSession({ id: 'ses_tras_el_cierre_0000000001', directory: 'D:/Cierre', title: 'x', time_created: Date.now(), time_updated: Date.now() });
  await flushAsync();
  waiting.onExit();
  check('15 dispose del adaptador: una pestana que esperaba no se casa despues del cierre', same(afterDispose, []), show(afterDispose));
  closing.dispose();
  found.close();
}

// ---------------------------------------------------------------------------
// 8. El arranque, la demo y el piso de Node (paso 8)
// ---------------------------------------------------------------------------

{
  const { startupAgentLines, HISTORY_LABEL } = await import('../src/startup-summary.ts');
  const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { createCodexAdapter } = await import('../src/agents/codex/index.ts');
  const claude = (extra = {}) => ({ id: 'claude-code', label: 'Claude Code', version: '2.1.263', resolvedPath: '/bin/claude', missingMessage: null, ...extra });
  const opencode = (extra = {}) => ({ id: 'opencode', label: 'OpenCode', version: '1.18.30', resolvedPath: '/bin/opencode', missingMessage: null, ...extra });
  const missing = { resolvedPath: null, version: null, missingMessage: 'falta' };

  check('8 el rotulo de la linea es Historial', HISTORY_LABEL === 'Historial');
  const plain = startupAgentLines([claude()]);
  check('8 sin nota, las lineas de siempre (con el campo ausente o en null)',
    same(startupAgentLines([claude({ historyNote: null }), opencode({ ...missing, historyNote: null })]), plain) &&
    same(plain, ['  CLIs disponibles  claude-code', '  CLI          2.1.263', '  Binario      /bin/claude']), show(plain));
  const notInstalled = startupAgentLines([claude(), opencode({ ...missing, historyNote: 'D:\\datos\\opencode.db (solo lectura)' })]);
  check('8 OpenCode sin instalar y con base: las de siempre y al final la del historial, con su nombre',
    same(notInstalled, [...plain, '  Historial (OpenCode)  D:\\datos\\opencode.db (solo lectura)']), show(notInstalled));
  const both = startupAgentLines([claude(), opencode({ historyNote: 'D:\\datos\\opencode.db (solo lectura)' })]);
  check('8 con las dos instaladas, la del historial debajo de las de OpenCode', same(both, [
    '  CLIs disponibles  claude-code, opencode',
    '  CLI (Claude Code)  2.1.263', '  Binario      /bin/claude',
    '  CLI (OpenCode)  1.18.30', '  Binario      /bin/opencode', '  Historial    D:\\datos\\opencode.db (solo lectura)',
  ]), show(both));
  const alone = startupAgentLines([claude(missing), opencode({ historyNote: 'x (solo lectura)' })]);
  check('8 con OpenCode sola, sin nombre, como cualquier CLI sola', same(alone, [
    '  CLIs disponibles  opencode', '  CLI          1.18.30', '  Binario      /bin/opencode', '  Historial    x (solo lectura)',
  ]), show(alone));
  const nothing = startupAgentLines([claude(missing), opencode({ ...missing, historyNote: 'x (solo lectura)' })]);
  check('8 sin ninguna CLI, la del historial al final', nothing.at(-1) === '  Historial (OpenCode)  x (solo lectura)' && nothing.includes('  Tambien funciona con: OpenCode'), show(nothing));

  const noteDir = path.join(root, 'c8-arranque');
  await mkdir(noteDir, { recursive: true });
  const presentDb = await createOpenCodeFixture(path.join(noteDir, 'con-base'), {});
  const absentDb = path.join(noteDir, 'sin-base', 'opencode.db');
  const note = (env, sqlite, cliAvailable) => {
    const adapter = createOpenCodeAdapter({ env, home, platform: 'win32', ...(sqlite === null ? {} : { sqlite }) });
    try {
      return adapter.startupHistoryNote(cliAvailable);
    } finally {
      adapter.dispose();
    }
  };
  const noSqlite = () => unavailable;
  check('8 con base: la ruta y que es de solo lectura, instalada o no',
    note({ OPENCODE_DB: presentDb.file }, null, false) === `${presentDb.file} (solo lectura)` && note({ OPENCODE_DB: presentDb.file }, null, true) === `${presentDb.file} (solo lectura)`);
  check('8 sin base: nada, instalada o no (quien no usa OpenCode no ve una linea nueva)',
    note({ OPENCODE_DB: absentDb }, null, false) === null && note({ OPENCODE_DB: absentDb }, null, true) === null && !existsSync(path.dirname(absentDb)));
  check('8 sin base por defecto en el home de prueba: nada', note({}, null, false) === null);
  const oldNode = note({ OPENCODE_DB: presentDb.file }, noSqlite, false);
  check('8 sin node:sqlite y con base: el aviso de la version, que nombra 22.13',
    typeof oldNode === 'string' && oldNode.includes('22.13') && oldNode.includes('OpenCode') && oldNode.startsWith('no se lee'), String(oldNode));
  check('8 sin node:sqlite, sin base y sin la CLI: nada; con la CLI instalada: el aviso',
    note({ OPENCODE_DB: absentDb }, noSqlite, false) === null && (note({ OPENCODE_DB: absentDb }, noSqlite, true) ?? '').includes('22.13'));
  check('8 con la base en memoria: que no hay nada que leer', note({ OPENCODE_DB: ':memory:' }, null, false) === 'en memoria (no hay nada que leer)');
  presentDb.close();

  const claudeAdapter = createClaudeCodeAdapter();
  const codexAdapter = createCodexAdapter();
  check('8 Claude Code y Codex no dicen nada del historial al arrancar', claudeAdapter.startupHistoryNote === undefined && codexAdapter.startupHistoryNote === undefined);
  claudeAdapter.dispose();
  codexAdapter.dispose();

  const indexSource = await readFile(path.join(serverDir, 'src', 'index.ts'), 'utf8');
  check('8 el arranque le pide la nota a cada adaptador, con si su CLI esta', /historyNote:\s*agents\.get\(info\.id\)\?\.adapter\.startupHistoryNote\?\.\(info\.available\)/.test(indexSource));

  // La demo: sin variables de OpenCode del shell, con sus carpetas en el home falso, y sin capturar si ve un historial.
  const demo = await import('../../../scripts/demo/isolation.mjs');
  const demoHome = path.join(root, 'c8-demo-home');
  const shellEnv = {
    PATH: '', HOME: 'real', OPENCODE_DB: 'D:\\real\\opencode.db', OPENCODE_MODELS_PATH: 'D:\\real\\models.json', OPENCODE_MODELS_URL: 'https://example.invalid',
    OPENCODE_CONFIG: 'D:\\real\\opencode.json', OPENCODE_CONFIG_DIR: 'D:\\real\\config', OPENCODE_CONFIG_CONTENT: '{}', XDG_CACHE_HOME: 'D:\\real\\cache', XDG_STATE_HOME: 'D:\\real\\state', OTRA: 'se queda',
  };
  const demoEnv = demo.demoEnvironment(shellEnv, { home: demoHome, bin: path.join(root, 'c8-bin'), mainCwd: 'W:\\Proyectos\\x' });
  const leaked = Object.keys(demoEnv).filter((name) => name.toUpperCase().startsWith('OPENCODE_'));
  check('8 demo: ninguna variable OPENCODE_ del shell llega al servidor', same(leaked, []) && demoEnv['OTRA'] === 'se queda', show(leaked));
  check('8 demo: cache y estado debajo del home falso',
    demoEnv['XDG_CACHE_HOME'] === path.join(demoHome, '.cache') && demoEnv['XDG_STATE_HOME'] === path.join(demoHome, '.local', 'state'));
  const demoPaths = resolveOpenCodePaths(demoEnv, demoHome, process.platform);
  const underDemo = (candidate) => candidate !== null && path.resolve(candidate).toLowerCase().startsWith(path.resolve(demoHome).toLowerCase());
  check('8 demo: la base, el catalogo y las cuatro carpetas de OpenCode caen en el home falso',
    [demoPaths.dbFile, demoPaths.modelsFile, demoPaths.dataDir, demoPaths.configDir, demoPaths.cacheDir, demoPaths.stateDir].every(underDemo), show(demoPaths));
  const demoAdapter = createOpenCodeAdapter({ env: demoEnv, home: demoHome, platform: process.platform });
  check('8 demo: el adaptador de OpenCode no anuncia ningun historial', demoAdapter.startupHistoryNote(false) === null);
  demoAdapter.dispose();

  const startupOf = (agents) => ['  URL          http://127.0.0.1:1/?token=x', '  Modo         produccion', ...startupAgentLines(agents), '  Consola      C:\\x\\pwsh.exe'].join('\n');
  const clean = startupOf([claude(), opencode({ ...missing, historyNote: null })]);
  check('8 demo: el bloque de arranque esta completo recien con la linea Consola',
    demo.startupBlockComplete(clean) && !demo.startupBlockComplete(clean.slice(0, clean.indexOf('  Consola'))));
  check('8 demo: un arranque sin base no trae lineas de historial, y se captura',
    same(demo.historyLinesFromStartup(clean), []) && !throwsOn(() => demo.assertNoNativeHistory(demo.historyLinesFromStartup(clean))));
  const withBase = startupOf([claude(), opencode({ ...missing, historyNote: 'D:\\datos\\opencode.db (solo lectura)' })]);
  const historyLines = demo.historyLinesFromStartup(withBase);
  check('8 demo: con una base de OpenCode a mano, la linea se ve y no se captura',
    same(historyLines, ['Historial (OpenCode)  D:\\datos\\opencode.db (solo lectura)']) && throwsOn(() => demo.assertNoNativeHistory(historyLines)), show(historyLines));
  const withCli = startupOf([claude(), opencode()]);
  check('8 demo: con CLI (OpenCode) encontrada no se captura', withCli.includes('CLI (OpenCode)') &&
    throwsOn(() => demo.assertOnlySimulatedAgent(demo.availableAgentsFromStartup(withCli))));
  /*
    Las dos redes sirven solo si se usan: el servidor de la demo espera el bloque
    entero antes de leer las lineas, y las capturas no se toman sin pasar las dos
    comprobaciones. Arrancar la demo de verdad no entra en el chequeo (compila y
    abre Chrome), asi que se mira el texto.
  */
  const environmentSource = await readFile(path.join(serverDir, '..', '..', 'scripts', 'demo', 'environment.mjs'), 'utf8');
  const shotsSource = await readFile(path.join(serverDir, '..', '..', 'scripts', 'demo', 'shots.mjs'), 'utf8');
  check('8 demo: el servidor espera el bloque de arranque entero y devuelve sus lineas de historial',
    /agents !== null && startupBlockComplete\(buffer\)/.test(environmentSource) && /historyLines: historyLinesFromStartup\(buffer\)/.test(environmentSource));
  check('8 demo: shots.mjs no captura sin comprobar la CLI simulada y la ausencia de historiales',
    /^\s*assertOnlySimulatedAgent\(availableAgents\);/m.test(shotsSource) && /^\s*assertNoNativeHistory\(historyLines\);/m.test(shotsSource));

  // M8: el piso de Node no sube; lo que necesita 22.13 es solo el historial de OpenCode.
  const rootPackage = JSON.parse(await readFile(path.join(serverDir, '..', '..', 'package.json'), 'utf8'));
  const buildNpm = await readFile(path.join(serverDir, '..', '..', 'scripts', 'build-npm.mjs'), 'utf8');
  check('8 engines sigue en >=20 y el bundle en node20 (desvio declarado M8)',
    rootPackage.engines?.node === '>=20' && /target:\s*'node20'/.test(buildNpm), show(rootPackage.engines));
}

// ---------------------------------------------------------------------------
// W. La web y el titulo
// ---------------------------------------------------------------------------

{
  const { toolCategory } = await import('../../web/src/tool-categories.ts');
  const expected = {
    bash: 'shell', read: 'read', grep: 'find', glob: 'find', list: 'find', edit: 'edit', write: 'edit', apply_patch: 'edit',
    webfetch: 'web', websearch: 'web', codesearch: 'web', task: 'agent', todowrite: 'todo', todoread: 'todo',
  };
  const wrong = Object.entries(expected).filter(([name, key]) => toolCategory(name).key !== key);
  check('W tandas: los nombres de OpenCode tienen su categoria (M5)', same(wrong, []), show(wrong));
  check('W tandas: un MCP con prefijo de servidor se agrupa por nombre', same(toolCategory('jira_search'), { key: 'name:jira_search', label: null }));

  const ui = await import('../../web/src/agent-ui.ts');
  const entry = ui.AGENT_UI.opencode;
  check('W AGENT_UI: OC, AGENTS.md, Esc Esc primero y la nota de Ctrl + T',
    entry?.shortLabel === 'OC' && entry.instructionsFile === 'AGENTS.md' && entry.shortcuts[0]?.keys === 'Esc Esc' &&
    /Ctrl \+ T/.test(entry.shortcutsNote ?? '') && ui.AGENT_UI.codex.shortLabel === 'CX' && ui.AGENT_UI['claude-code'].shortLabel === 'CC', show(entry));
  // R26-2: xterm manda `\r` con Shift o sin el, y OpenCode lo toma como enviar.
  const newline = entry?.shortcuts.find((shortcut) => shortcut.description === 'Salto de línea');
  check('W AGENT_UI: el salto de linea de OpenCode en la terminal es Ctrl + J, y ningun atajo suyo promete Shift + Enter',
    newline?.keys === 'Ctrl + J' && !entry.shortcuts.some((shortcut) => /Shift \+ Enter/.test(shortcut.keys)), show(entry?.shortcuts));

  const title = await import('../src/agents/session-title.ts');
  const scan = await import('../src/agents/claude-code/session-scan.ts');
  check('T toTitle, movido sin cambios',
    title.toTitle('  <x>hola</x>\n```code```  mundo ') === 'hola mundo' && title.toTitle('a'.repeat(200)) === `${'a'.repeat(89)}…` &&
    title.TITLE_MAX_LENGTH === 90 && title.UNTITLED_SESSION_TITLE === 'Sesion sin titulo');
  check('T sin reexportaciones: session-scan ya no exporta toTitle ni el titulo vacio', scan.toTitle === undefined && scan.UNTITLED_SESSION_TITLE === undefined);
  const rolloutScan = await readFile(path.join(serverDir, 'src', 'agents', 'codex', 'rollout-scan.ts'), 'utf8');
  check('T Codex importa el titulo del modulo comun', rolloutScan.includes("from '../session-title.js'") && !rolloutScan.includes('claude-code/session-scan'));
}

historyFixture.close();
base.close();
await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
