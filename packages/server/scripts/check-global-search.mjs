/**
 * Chequeo de "Buscar en todo" (hito 29, §7).
 *
 *   npx tsx scripts/check-global-search.mjs
 *
 * Lo que se rompe en silencio en un buscador es lo que no encuentra: una tilde
 * que no se pliega, un resultado de herramienta que se cuela, una linea rota
 * que se lleva el resto de la sesion, un tope que no corta o una busqueda vieja
 * que contesta despues de la nueva. Cada caso de la especificacion tiene su
 * bloque, numerado igual:
 *
 *  - S1: "migracion" encuentra "Migración" en un texto del usuario, en uno del
 *    asistente y en el titulo (con `eventId` null); no en un resultado ni en la
 *    entrada de una herramienta. Por `VaultService.search`, sobre una copia
 *    escrita con el formato del 28 y leida por el catalogo. `foldForSearch`.
 *  - S2: el fragmento: 160 centrado con `…`, el acierto con su tilde, un emoji
 *    en cualquiera de los dos bordes que no se parte, un texto en NFD y los
 *    saltos de linea.
 *  - S3: 250 aciertos -> 200 y `results`; exactamente 200 no corta. Un reloj que
 *    pasa el tope de seguridad -> `time` con `sessionsScanned < sessionsTotal`,
 *    mirado cada 200 lineas y al empezar cada sesion.
 *  - S4: el orden: sesiones por fecha, y dentro el titulo y despues cada linea.
 *  - S5: la archivada solo con `includeArchived`.
 *  - S6: menos de 3 caracteres no lee nada (ni la lista de sesiones).
 *  - S7: la linea de 2 MB, la que no es JSON y la que no es un evento se saltan,
 *    y lo de despues aparece; una sesion que no se puede leer se salta sin
 *    llevarse la busqueda. La copia apagada busca igual; mudandose, no.
 *  - S8: una busqueda nueva cancela la anterior: el lector de la vieja se cierra
 *    (espia) y solo llega un resultado. Cerrar el socket tambien cancela, y
 *    `search.cancel` corta solo la de su id.
 *  - S9: recorre todo. Lo que el tope viejo de 1,5 s perdia: un texto en la
 *    sesion mas vieja y "sin resultados" de un texto que no existe, con un reloj
 *    que pasa los 1,5 s. Los avisos de progreso (el primero con el total, los
 *    nuevos en orden, espaciados), que cede el hilo al empezar cada sesion, que
 *    una cancelacion mientras cede corta ahi, y el tope de seguridad que dice
 *    cuantas quedaron sin mirar.
 *  - Protocolo: `search.global` (consulta recortada a 200), `search.progress`,
 *    `search.results` (aciertos de una fuente desconocida o que se salen del
 *    fragmento, fuera) y `search.cancel`.
 *  - W: la web (`global-search-ui.ts`): cuando se ve el conmutador (D21 y la
 *    copia), como se agrupan y resaltan los aciertos, que dice la linea de
 *    estado, que hace un clic; y en el fuente, que la barra y `App` decidan con
 *    esas funciones.
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA` y las carpetas XDG apuntando a
 * una carpeta temporal propia, fijadas **antes** de importar nada. No importa
 * nada que cargue `node-pty` ni lanza ninguna CLI. Los textos son inventados.
 */

import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-search-'));
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

const shared = await import('@agent-workbench/shared');
const {
  GLOBAL_SEARCH_MAX_QUERY_CHARS,
  GLOBAL_SEARCH_MAX_RESULTS,
  GLOBAL_SEARCH_PROGRESS_MS,
  GLOBAL_SEARCH_SAFETY_MS,
  GLOBAL_SEARCH_SNIPPET_CHARS,
  SERVER_ERROR_CODES,
  findFolded,
  foldForSearch,
  foldQuery,
  parseClientMessage,
  parseGlobalSearchProgress,
  parseGlobalSearchResult,
  parseServerMessage,
} = shared;
const {
  GLOBAL_SEARCH_LINE_MAX_CHARS,
  GlobalSearchAbortedError,
  GlobalSearchSlot,
  decodeVaultEvent,
  lineMayMatch,
  makeSnippet,
  prefilterable,
  runGlobalSearch,
} = await import('../src/global-search.ts');
const { VaultCatalog } = await import('../src/vault/catalog.ts');
const { serializeSession } = await import('../src/vault/serialize.ts');
const { writeSessionFile } = await import('../src/vault/write.ts');
const vaultPaths = await import('../src/vault/paths.ts');
const { VaultService, VaultError } = await import('../src/vault/service.ts');
const ui = await import('../../web/src/global-search-ui.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const show = (value) => JSON.stringify(value)?.slice(0, 400) ?? String(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const notAborted = () => new AbortController().signal;
/** Deja correr lo que haya en la cola de eventos, una vuelta. */
const flushImmediate = () => new Promise((resolve) => setImmediate(resolve));

/** true si hay una mitad de un par sustituto sin la otra. */
function hasLoneSurrogate(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixture: cinco sesiones inventadas en una copia con el formato del 28
// ---------------------------------------------------------------------------

const T = Date.UTC(2026, 8, 14, 10, 0, 0);
let eventSeq = 0;
const text = (value) => ({ kind: 'text', text: value, truncated: false });
const ev = (role, parts, at = T + eventSeq * 1000, eventId = `ev-${++eventSeq}`) => ({
  eventId, role, at, parts, model: null, usage: null, effort: null, durationMs: null, queued: false,
});
const eventLine = (event) => JSON.stringify({ kind: 'event', event, images: [] });
const headerInput = (agent, sessionId, overrides = {}) => ({
  agent, sessionId, cwd: 'C:\\proyectos\\demo', title: 'Sesion de prueba', titleSource: 'first-message',
  createdAt: null, updatedAt: T, cliVersionAtCopy: null, partial: false, stepCount: null, usage: null,
  source: { kind: 'native', mtimeMs: T, sizeBytes: 10, writerRevision: 1 }, writtenAt: T,
  ...overrides,
});

/** Escribe una sesion en la copia; `insert` mete lineas crudas en esa posicion (0 es la cabecera). */
async function writeCopy(dir, agent, sessionId, overrides, events, insert = null) {
  const serialized = serializeSession({ header: headerInput(agent, sessionId, overrides), events });
  await writeSessionFile(dir, serialized);
  if (insert !== null) {
    const lines = serialized.text.trimEnd().split('\n');
    lines.splice(insert.at, 0, ...insert.lines);
    await writeFile(vaultPaths.sessionFile(dir, agent, sessionId), `${lines.join('\n')}\n`);
  }
}

const ID = {
  a: '11111111-1111-4111-8111-111111111111',
  b: '22222222-2222-4222-8222-222222222222',
  c: 'ses_archivada01',
  d: '44444444-4444-4444-8444-444444444444',
  e: '55555555-5555-4555-8555-555555555555',
};

const vaultDir = path.join(root, 'copia');
const a1 = ev('user', [text('Arrancamos la migración del esquema viejo')]);
const a2 = ev('assistant', [text('La Migración quedó lista para probar'), { kind: 'tool-call', toolUseId: 't1', name: 'Bash', input: 'migracion --dry-run', truncated: false }]);
const a3 = ev('user', [{ kind: 'tool-result', toolUseId: 't1', text: 'migracion aplicada en el resultado', isError: false, truncated: false, imageCount: 0 }]);
const a4 = ev('assistant', [text('Nada que decir de eso')]);
await writeCopy(vaultDir, 'claude-code', ID.a, { title: 'Revisar la Migración de datos', updatedAt: T + 5000 }, [a1, a2, a3, a4]);

const b1 = ev('user', [text('primero una migracion ascii')]);
const b2 = ev('assistant', [text('sin coincidencias aca')]);
const b3 = ev('user', [text('después de las líneas rotas: MIGRACIÓN final')]);
const bigEvent = ev('assistant', [text(`migracion ${'x'.repeat(2_000_000)}`)]);
await writeCopy(vaultDir, 'codex', ID.b, { title: 'Ajustar el importador', updatedAt: T + 4000 }, [b1, b2, b3], {
  at: 3,
  lines: ['{esto no es json migracion', eventLine(bigEvent), JSON.stringify({ kind: 'otra-cosa', text: 'migracion' })],
});

const c1 = ev('user', [text('una migración que quedó archivada')]);
await writeCopy(vaultDir, 'opencode', ID.c, { title: 'Sesion vieja', updatedAt: T + 3000 }, [c1]);

const d1 = ev('assistant', [text('otra migracion, pero importada')]);
await writeCopy(vaultDir, 'gemini-cli', ID.d, {
  cwd: '', group: 'Gemini CLI · carpeta desconocida', title: 'Chat importado', updatedAt: T + 2000,
  source: { kind: 'import', importer: 'gemini-cli-chats', importedAt: T },
}, [d1]);

await writeCopy(vaultDir, 'antigravity', ID.e, { title: 'Nada que ver', updatedAt: T + 1000 }, [ev('user', [text('hola')])]);

const catalog = new VaultCatalog();
await catalog.load(vaultDir);
check('preparacion: el catalogo lista las cinco', catalog.summaries().length === 5, show(catalog.summaries().map((s) => s.sessionId)));
const bigHeader = catalog.header('codex', ID.b);
check('preparacion: la sesion con lineas rotas sigue listada', bigHeader !== null);
const bodyA = [];
for await (const line of catalog.readBody('claude-code', ID.a)) bodyA.push(line.kind === 'event' ? line.event.eventId : line.kind);
// Si el resultado de la herramienta no se leyera, "no se encuentra ahi" pasaria sin probar nada.
check('preparacion: la copia devuelve los cuatro eventos de A, tambien el del resultado de herramienta',
  same(bodyA, [a1.eventId, a2.eventId, a3.eventId, a4.eventId]), show(bodyA));

function memorySettings(vault = {}) {
  let current = { version: 1, vault: { enabled: true, dir: vaultDir, toolResultMaxChars: 64_000, ...vault } };
  return {
    get: () => current,
    update: async (patch) => {
      current = { version: 1, vault: { ...current.vault, ...(patch.vault ?? {}) } };
    },
  };
}
function fakeIndex() {
  const index = new EventEmitter();
  index.getStatus = () => ({ state: 'ready', scannedFiles: 0, totalFiles: 0 });
  index.nativeSessions = () => [];
  index.getProjects = () => [];
  return index;
}
const quiet = { warn: () => {} };
const archivedIds = new Set([ID.c]);
const serviceFor = (settings = memorySettings()) =>
  new VaultService({
    agents: { adapter: () => { throw new Error('el buscador no usa adaptadores'); }, get: () => null, protectedDirs: () => [] },
    index: fakeIndex(),
    archived: archivedIds,
    settings,
    catalog,
    platform: process.platform,
    homeDir: home,
    reveal: () => {},
    log: quiet,
  });

const service = serviceFor();
const pairOf = (hit) => `${hit.sessionId}|${hit.eventId}`;

// ---------------------------------------------------------------------------
// S1: lo que se encuentra y lo que no
// ---------------------------------------------------------------------------
{
  const folded = foldForSearch('Ñandú İstanbul');
  check('S1 foldForSearch: minusculas sin tildes, con el mapa a la posicion original',
    folded.folded === 'nandu istanbul' && folded.map.length === folded.folded.length && folded.map[4] === 4, show(folded));
  check('S1 findFolded: "migracion" en "La Migración" da la posicion de la palabra entera',
    same(findFolded('La Migración', foldQuery('migracion')), { start: 3, end: 12 }));
  check('S1 findFolded: texto solo ASCII, sin distinguir mayusculas', same(findFolded('Una MIGRACION', foldQuery('Migración')), { start: 4, end: 13 }));
  check('S1 findFolded: sin aparicion -> null', findFolded('nada por aca', 'migracion') === null);

  const result = await service.search('migracion', { includeArchived: false, signal: notAborted() });
  const hitsA = result.hits.filter((hit) => hit.sessionId === ID.a);
  const titleHit = hitsA.find((hit) => hit.eventId === null);
  check('S1 el titulo "Revisar la Migración de datos": eventId, role y at null, y el fragmento es el titulo',
    titleHit !== undefined && titleHit.role === null && titleHit.at === null && titleHit.snippet === 'Revisar la Migración de datos' &&
    titleHit.snippet.slice(titleHit.matchStart, titleHit.matchStart + titleHit.matchLength) === 'Migración', show(titleHit));
  const userHit = hitsA.find((hit) => hit.eventId === a1.eventId);
  const assistantHit = hitsA.find((hit) => hit.eventId === a2.eventId);
  check('S1 en un texto del usuario ("migración"), con su rol, su fecha, su CLI y su carpeta',
    userHit?.role === 'user' && userHit.at === a1.at && userHit.agent === 'claude-code' && userHit.cwd === 'C:\\proyectos\\demo' &&
    userHit.snippet.slice(userHit.matchStart, userHit.matchStart + userHit.matchLength) === 'migración', show(userHit));
  check('S1 en un texto del asistente ("Migración")',
    assistantHit?.role === 'assistant' && assistantHit.snippet.slice(assistantHit.matchStart, assistantHit.matchStart + assistantHit.matchLength) === 'Migración', show(assistantHit));
  check('S1 ni en el resultado ni en la entrada de la herramienta: A tiene titulo, a1 y a2, y a2 una sola vez',
    same(hitsA.map(pairOf), [`${ID.a}|null`, `${ID.a}|${a1.eventId}`, `${ID.a}|${a2.eventId}`]), show(hitsA.map(pairOf)));
  const importedHit = result.hits.find((hit) => hit.sessionId === ID.d);
  check('S1 una importada: la fuente importada y la carpeta null', importedHit?.agent === 'gemini-cli' && importedHit.cwd === null, show(importedHit));
  check('S1 termina sin tope, con las cuatro no archivadas leidas', result.truncated === null && result.sessionsScanned === 4 && result.sessionsTotal === 4,
    show({ truncated: result.truncated, scanned: result.sessionsScanned, total: result.sessionsTotal }));
  check('S1 lo que sale lo acepta el parser del cliente, entero', same(parseGlobalSearchResult(JSON.parse(JSON.stringify(result))), result));
}

// ---------------------------------------------------------------------------
// S2: el fragmento
// ---------------------------------------------------------------------------
{
  /** El fragmento del primer acierto; sin acierto, uno vacio (y los casos fallan en vez de tirar el script). */
  const snippetIn = (source, query = 'migracion') => {
    const found = findFolded(source, foldQuery(query));
    return found === null
      ? { snippet: '', matchStart: 0, matchLength: 0, found: null }
      : { ...makeSnippet(source, found.start, found.end), found };
  };
  const long = `${'a'.repeat(300)}Migración${'b'.repeat(300)}`;
  const snip = snippetIn(long);
  // Contexto a cada lado del acierto, sin contar los `…`: centrado es que difieran en uno como mucho.
  const leftContext = snip.matchStart - 1;
  const rightContext = snip.snippet.length - 1 - (snip.matchStart + snip.matchLength);
  check('S2 160 centrado con … a los dos lados, y el acierto con su tilde',
    snip.snippet.startsWith('…') && snip.snippet.endsWith('…') && snip.snippet.length === GLOBAL_SEARCH_SNIPPET_CHARS + 2 &&
    snip.snippet.slice(snip.matchStart, snip.matchStart + snip.matchLength) === 'Migración' &&
    Math.abs(leftContext - rightContext) <= 1, show({ snippet: snip.snippet, leftContext, rightContext }));

  const short = makeSnippet('La Migración', 3, 12);
  check('S2 un texto corto sale entero y sin …', short.snippet === 'La Migración' && short.matchStart === 3 && short.matchLength === 9, show(short));

  const emoji = String.fromCodePoint(0x1f600);
  // El emoji ocupa [100, 102) y el acierto empieza en 176: el borde de 160 centrado cae en 101, su mitad baja.
  const leftText = `${'x'.repeat(100)}${emoji}${'y'.repeat(74)}Migración${'z'.repeat(300)}`;
  const left = snippetIn(leftText);
  check('S2 un emoji en el borde izquierdo no se parte',
    !hasLoneSurrogate(left.snippet) && left.snippet.startsWith('…') &&
    left.snippet.slice(left.matchStart, left.matchStart + left.matchLength) === 'Migración', show(left.snippet.slice(0, 12)));
  // El acierto termina en 309 y el emoji ocupa [384, 386): el borde derecho cae en 385, su mitad alta.
  const rightText = `${'x'.repeat(300)}Migración${'y'.repeat(75)}${emoji}${'z'.repeat(100)}`;
  const right = snippetIn(rightText);
  check('S2 un emoji en el borde derecho no se parte',
    !hasLoneSurrogate(right.snippet) && right.snippet.endsWith('…') &&
    right.snippet.slice(right.matchStart, right.matchStart + right.matchLength) === 'Migración', show(right.snippet.slice(-12)));
  // Sin la correccion, el borde caeria justo en el medio del emoji: el caso tiene que poder fallar.
  check('S2 (control) los dos bordes caen en el medio del emoji sin correrlos',
    left.found?.start === 176 && leftText.charCodeAt(176 - 75) >= 0xdc00 &&
    right.found?.end === 309 && rightText.charCodeAt(309 + 76 - 1) >= 0xd800 && rightText.charCodeAt(309 + 76 - 1) <= 0xdbff,
    show({ left: left.found, right: right.found }));

  const mark = String.fromCharCode(0x301);
  const nfdSnip = snippetIn(`La Migracio${mark}n del lunes`);
  check('S2 un texto en NFD: el acierto se lleva la tilde suelta',
    nfdSnip.snippet.slice(nfdSnip.matchStart, nfdSnip.matchStart + nfdSnip.matchLength) === `Migracio${mark}n`, show(nfdSnip.found));
  const nfdEnd = findFolded(`migracio${mark}`, foldQuery('migracio'));
  check('S2 la tilde suelta al final del texto tambien entra', nfdEnd?.end === 9, show(nfdEnd));

  const linesSnip = snippetIn('linea uno\r\nuna migración\tcon tabulador');
  check('S2 una sola linea: saltos y tabuladores pasan a espacio sin mover el acierto',
    !/[\r\n\t]/.test(linesSnip.snippet) && linesSnip.snippet.slice(linesSnip.matchStart, linesSnip.matchStart + linesSnip.matchLength) === 'migración', show(linesSnip));
}

// ---------------------------------------------------------------------------
// S3: los topes
// ---------------------------------------------------------------------------

/** Una sesion de mentira con lineas en el formato de la copia y un lector espia. */
function fakeSessions(defs) {
  const reads = [];
  const closed = [];
  const sessions = defs.map((def, position) => ({
    agent: def.agent ?? 'claude-code',
    sessionId: def.sessionId ?? `sesion-${position}`,
    cwd: def.cwd ?? 'C:\\proyectos\\demo',
    title: def.title ?? 'sin titulo',
    updatedAt: def.updatedAt ?? T - position,
    archived: def.archived ?? false,
  }));
  let sessionCalls = 0;
  const deps = {
    sessions: () => {
      sessionCalls += 1;
      return sessions;
    },
    readLines: async function* (session) {
      reads.push(session.sessionId);
      const def = defs[sessions.indexOf(session)];
      try {
        if (def.throwAt === 0) throw new Error('no se pudo abrir');
        let index = 0;
        for (const line of def.lines ?? []) {
          index += 1;
          if (def.throwAt === index) throw new Error('se corto la lectura');
          yield line;
        }
      } finally {
        closed.push(session.sessionId);
      }
    },
  };
  return { deps, reads, closed, sessionCalls: () => sessionCalls };
}
const matchingLines = (count, every = 1) =>
  Array.from({ length: count }, (_, index) =>
    eventLine(ev('assistant', [text((index + 1) % every === 0 ? `linea ${index + 1} con migración` : `linea ${index + 1} sin nada`)], T, `linea-${index + 1}`)));

{
  const many = fakeSessions([{ lines: matchingLines(250) }]);
  const result = await runGlobalSearch(many.deps, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S3 250 aciertos -> 200 y truncated results, la sesion sin contar como leida',
    result.hits.length === GLOBAL_SEARCH_MAX_RESULTS && result.truncated === 'results' && result.sessionsScanned === 0 && result.sessionsTotal === 1,
    show({ hits: result.hits.length, truncated: result.truncated, scanned: result.sessionsScanned }));
  check('S3 cortar a mitad cierra el lector', same(many.closed, ['sesion-0']), show(many.closed));

  const exact = fakeSessions([{ lines: matchingLines(200) }]);
  const exactResult = await runGlobalSearch(exact.deps, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S3 exactamente 200 no dice que hay mas', exactResult.hits.length === 200 && exactResult.truncated === null && exactResult.sessionsScanned === 1,
    show({ hits: exactResult.hits.length, truncated: exactResult.truncated }));

  // El tope de seguridad (30 s): un reloj que avanza 20 s por consulta corta al empezar la segunda sesion.
  let clock = 0;
  const slow = fakeSessions([{ title: 'una migracion' }, { title: 'otra migracion' }, { title: 'tercera migracion' }]);
  const slowResult = await runGlobalSearch({ ...slow.deps, now: () => (clock += 20_000) }, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S3 reloj que pasa el tope de seguridad entre sesiones -> time y sessionsScanned < sessionsTotal',
    slowResult.truncated === 'time' && slowResult.sessionsScanned === 1 && slowResult.sessionsTotal === 3 && slowResult.hits.length === slowResult.sessionsScanned,
    show({ truncated: slowResult.truncated, scanned: slowResult.sessionsScanned, hits: slowResult.hits.length }));

  // Un reloj que avanza 8 s por consulta, sobre una sola sesion de 1000 lineas: con el reloj
  // mirado cada 200 lineas corta en la 600 (59 aciertos, uno cada 10); mirado en cada linea
  // cortaria en la tercera.
  let lineClock = 0;
  const everyTen = fakeSessions([{ lines: matchingLines(1000, 10) }]);
  const lineResult = await runGlobalSearch({ ...everyTen.deps, now: () => (lineClock += 8_000) }, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S3 el reloj se mira cada 200 lineas: corta en la 600 con 59 aciertos',
    lineResult.truncated === 'time' && lineResult.hits.length === 59 && lineResult.hits.at(-1)?.eventId === 'linea-590' && lineResult.sessionsScanned === 0,
    show({ truncated: lineResult.truncated, hits: lineResult.hits.length, last: lineResult.hits.at(-1)?.eventId }));
}

// ---------------------------------------------------------------------------
// S4 y S5: el orden y las archivadas
// ---------------------------------------------------------------------------
{
  const result = await service.search('migracion', { includeArchived: false, signal: notAborted() });
  check('S4 por fecha descendente y, dentro, titulo primero y despues cada linea en orden',
    same(result.hits.map(pairOf), [
      `${ID.a}|null`, `${ID.a}|${a1.eventId}`, `${ID.a}|${a2.eventId}`,
      `${ID.b}|${b1.eventId}`, `${ID.b}|${b3.eventId}`,
      `${ID.d}|${d1.eventId}`,
    ]), show(result.hits.map(pairOf)));

  const ordered = fakeSessions([
    { sessionId: 'vieja', updatedAt: T, title: 'migracion vieja' },
    { sessionId: 'nueva', updatedAt: T + 10, title: 'migracion nueva' },
    { sessionId: 'media', updatedAt: T + 5, title: 'migracion media' },
  ]);
  const orderedResult = await runGlobalSearch(ordered.deps, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S4 la lista llega en cualquier orden y se lee por fecha', same(ordered.reads, ['nueva', 'media', 'vieja']) &&
    same(orderedResult.hits.map((hit) => hit.sessionId), ['nueva', 'media', 'vieja']), show(ordered.reads));

  check('S5 sin includeArchived la archivada no aparece ni cuenta', !result.hits.some((hit) => hit.sessionId === ID.c) && result.sessionsTotal === 4);
  const withArchived = await service.search('migracion', { includeArchived: true, signal: notAborted() });
  check('S5 con includeArchived aparece en su lugar por fecha',
    withArchived.sessionsTotal === 5 && same(withArchived.hits.map((hit) => hit.sessionId).filter((id, i, all) => all.indexOf(id) === i), [ID.a, ID.b, ID.c, ID.d]),
    show(withArchived.hits.map(pairOf)));
}

// ---------------------------------------------------------------------------
// S6: menos de 3 caracteres
// ---------------------------------------------------------------------------
{
  const spy = fakeSessions([{ lines: matchingLines(5) }]);
  const tooShort = await runGlobalSearch(spy.deps, '  mi  ', { includeArchived: false, signal: notAborted() });
  const empty = await runGlobalSearch(spy.deps, '', { includeArchived: false, signal: notAborted() });
  check('S6 "mi" y "" -> vacio, sin pedir la lista ni leer nada',
    tooShort.hits.length === 0 && tooShort.sessionsTotal === 0 && tooShort.truncated === null && empty.hits.length === 0 &&
    spy.reads.length === 0 && spy.sessionCalls() === 0, show({ reads: spy.reads, calls: spy.sessionCalls() }));
  const three = await runGlobalSearch(spy.deps, 'mig', { includeArchived: false, signal: notAborted() });
  check('S6 con 3 ya busca', three.hits.length === 5 && spy.reads.length === 1, show(three.hits.length));
  const emojiQuery = await runGlobalSearch(spy.deps, String.fromCodePoint(0x1f600).repeat(2), { includeArchived: false, signal: notAborted() });
  check('S6 se cuentan caracteres, no unidades: dos emojis no llegan a 3', emojiQuery.sessionsTotal === 0 && spy.reads.length === 1);
}

// ---------------------------------------------------------------------------
// S7: lo que se salta
// ---------------------------------------------------------------------------
{
  check('S7 (preparacion) la linea grande pasa del tope y es un evento valido',
    eventLine(bigEvent).length > GLOBAL_SEARCH_LINE_MAX_CHARS && decodeVaultEvent(eventLine(bigEvent))?.eventId === bigEvent.eventId);
  const result = await service.search('migracion', { includeArchived: false, signal: notAborted() });
  const hitsB = result.hits.filter((hit) => hit.sessionId === ID.b);
  check('S7 la linea de 2 MB, la que no es JSON y la que no es un evento se saltan, y lo de despues aparece',
    same(hitsB.map((hit) => hit.eventId), [b1.eventId, b3.eventId]) &&
    hitsB[1].snippet.slice(hitsB[1].matchStart, hitsB[1].matchStart + hitsB[1].matchLength) === 'MIGRACIÓN', show(hitsB));
  check('S7 decodeVaultEvent: basura, JSON que no es evento y un documento -> null',
    decodeVaultEvent('{roto') === null && decodeVaultEvent('{"kind":"otra-cosa"}') === null &&
    decodeVaultEvent(JSON.stringify({ kind: 'document', origin: 'agent-document', name: 'a.md', modifiedAt: null, text: 'migracion', truncated: false })) === null);

  const broken = fakeSessions([
    { sessionId: 'no-abre', updatedAt: T + 3, throwAt: 0, title: 'no abre' },
    { sessionId: 'se-corta', updatedAt: T + 2, lines: matchingLines(3), throwAt: 2 },
    { sessionId: 'sana', updatedAt: T + 1, lines: matchingLines(2) },
  ]);
  const brokenResult = await runGlobalSearch(broken.deps, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S7 una sesion que no abre o se corta se salta, cuenta como mirada y la busqueda sigue',
    same(brokenResult.hits.map((hit) => `${hit.sessionId}|${hit.eventId}`), ['se-corta|linea-1', 'sana|linea-1', 'sana|linea-2']) &&
    brokenResult.sessionsScanned === 3 && brokenResult.truncated === null, show(brokenResult.hits.map((hit) => `${hit.sessionId}|${hit.eventId}`)));

  // El prefiltro: una linea ASCII sin la consulta no se decodifica, y nada que la tenga se pierde.
  const backslash = String.fromCharCode(0x5c);
  const escapedLine = eventLine(ev('user', [text('placeholder-escapado')], T, 'escapada')).replace('placeholder-escapado', `la Migraci${backslash}u00f3n escapada`);
  const prefilterLines = [
    eventLine(ev('assistant', [{ kind: 'tool-result', toolUseId: 'r', text: `${'salida larga de un comando '.repeat(500)}`, isError: false, truncated: false, imageCount: 0 }], T, 'ascii-sin')),
    eventLine(ev('user', [{ kind: 'tool-result', toolUseId: 'r2', text: 'la migracion solo en un resultado', isError: false, truncated: false, imageCount: 0 }], T, 'ascii-resultado')),
    eventLine(ev('assistant', [text('una línea con tildes y sin la palabra')], T, 'tildes-sin')),
    escapedLine,
    eventLine(ev('user', [text('ella dijo "migracion" ayer')], T, 'comillas')),
  ];
  const decoded = [];
  const prefilterDeps = {
    ...fakeSessions([{ lines: prefilterLines }]).deps,
    decode: (line) => {
      const event = decodeVaultEvent(line);
      decoded.push(event?.eventId ?? 'nulo');
      return event;
    },
  };
  const prefilterResult = await runGlobalSearch(prefilterDeps, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S7 prefiltro: la linea ASCII sin la consulta no se decodifica; la de tildes, la escapada y la que la tiene, si',
    same(decoded, ['ascii-resultado', 'tildes-sin', 'escapada', 'comillas']), show(decoded));
  check('S7 prefiltro: no pierde nada: la escapada ("Migraci\\u00f3n") y la de comillas se encuentran',
    same(prefilterResult.hits.map((hit) => hit.eventId), ['escapada', 'comillas']), show(prefilterResult.hits.map((hit) => hit.eventId)));
  decoded.length = 0;
  const quoted = await runGlobalSearch(prefilterDeps, 'dijo "migracion"', { includeArchived: false, signal: notAborted() });
  check('S7 prefiltro: una consulta con comillas no filtra (JSON las escapa) y encuentra el texto',
    same(quoted.hits.map((hit) => hit.eventId), ['comillas']) && decoded.length === prefilterLines.length, show({ hits: quoted.hits.map((hit) => hit.eventId), decoded }));
  check('S7 prefilterable / lineMayMatch',
    prefilterable('migracion') && !prefilterable('dijo "x"') && !prefilterable(`a${backslash}b`) && !prefilterable('migración') && !prefilterable('') &&
    lineMayMatch('{"x":"Otra MIGRACION"}', 'migracion', true) && !lineMayMatch('{"x":"nada"}', 'migracion', true) &&
    lineMayMatch('{"x":"nada"}', 'migracion', false) && lineMayMatch('{"x":"tilde é"}', 'migracion', true));

  const failingList = await runGlobalSearch({ sessions: () => { throw new Error('sin lista'); }, readLines: async function* () {} }, 'migracion', {
    includeArchived: false, signal: notAborted(),
  }).then(() => null, (error) => error);
  check('S7 una lista que no se puede armar rechaza la busqueda (search-failed en el socket)', failingList instanceof Error && failingList.message === 'sin lista');

  const offService = serviceFor(memorySettings({ enabled: false }));
  const offResult = await offService.search('migracion', { includeArchived: false, signal: notAborted() });
  check('S7 con la copia apagada busca igual en lo que hay', offResult.hits.length === 6, show(offResult.hits.length));

  let release;
  const moving = service.writer.exclusive('moving', () => new Promise((resolve) => { release = resolve; }));
  const refused = await service.search('migracion', { includeArchived: false, signal: notAborted() }).then(() => null, (error) => error);
  release();
  await moving;
  check('S7 durante una mudanza se rechaza con VaultError', refused instanceof VaultError && /mudando/.test(refused.message), show(refused?.message));
  offService.dispose();
}

// ---------------------------------------------------------------------------
// S8: una busqueda nueva cancela la anterior
// ---------------------------------------------------------------------------
{
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  let firstLineRead;
  const firstLine = new Promise((resolve) => { firstLineRead = resolve; });
  let firstClosed = false;
  const firstDeps = {
    sessions: () => [{ agent: 'claude-code', sessionId: 'lenta', cwd: '', title: 'lenta', updatedAt: T, archived: false }],
    readLines: async function* () {
      try {
        yield eventLine(ev('user', [text('una migracion antes de trabarse')], T, 'lenta-1'));
        firstLineRead();
        await gate;
        yield eventLine(ev('user', [text('una migracion despues')], T, 'lenta-2'));
      } finally {
        firstClosed = true;
      }
    },
  };
  const secondDeps = fakeSessions([{ lines: matchingLines(2) }]).deps;

  const slot = new GlobalSearchSlot();
  const delivered = [];
  const deliver = (label) => (result) => {
    if (result !== null) delivered.push({ label, hits: result.hits.length });
  };
  const first = slot.run((signal) => runGlobalSearch(firstDeps, 'migracion', { includeArchived: false, signal })).then(deliver('primera'));
  await firstLine;
  const second = slot.run((signal) => runGlobalSearch(secondDeps, 'migracion', { includeArchived: false, signal })).then(deliver('segunda'));
  releaseGate();
  await Promise.all([first, second]);
  check('S8 la segunda aborta la primera: el lector de la primera se cierra y solo llega la segunda',
    firstClosed && same(delivered, [{ label: 'segunda', hits: 2 }]), show({ firstClosed, delivered }));

  let releaseClose;
  const closeGate = new Promise((resolve) => { releaseClose = resolve; });
  let readyForClose;
  const closeReady = new Promise((resolve) => { readyForClose = resolve; });
  let closedOnSocketClose = false;
  const closing = slot.run((signal) => runGlobalSearch({
    sessions: () => [{ agent: 'codex', sessionId: 'cierre', cwd: '', title: 'x', updatedAt: T, archived: false }],
    readLines: async function* () {
      try {
        yield eventLine(ev('user', [text('nada')], T, 'cierre-1'));
        readyForClose();
        await closeGate;
        yield eventLine(ev('user', [text('nada')], T, 'cierre-2'));
      } finally {
        closedOnSocketClose = true;
      }
    },
  }, 'migracion', { includeArchived: false, signal }));
  await closeReady;
  slot.cancel();
  releaseClose();
  check('S8 cerrar el socket (cancel) cancela: resuelve null y cierra el lector', (await closing) === null && closedOnSocketClose);

  const failing = await slot.run(() => Promise.reject(new Error('disco'))).then(() => 'resolvio', (error) => error);
  check('S8 un fallo que no es cancelacion llega a quien pidio', failing instanceof Error && failing.message === 'disco');
  const aborted = new AbortController();
  aborted.abort();
  const early = await runGlobalSearch(fakeSessions([{ lines: matchingLines(1) }]).deps, 'migracion', { includeArchived: false, signal: aborted.signal })
    .then(() => null, (error) => error);
  check('S8 una busqueda ya cancelada rechaza con GlobalSearchAbortedError', early instanceof GlobalSearchAbortedError);

  // search.cancel: solo la que corre con ese id; un pedido tardio de otra no la corta.
  let releaseById;
  const byIdGate = new Promise((resolve) => { releaseById = resolve; });
  let byIdReady;
  const byIdStarted = new Promise((resolve) => { byIdReady = resolve; });
  const slowDeps = {
    sessions: () => [{ agent: 'claude-code', sessionId: 'por-id', cwd: '', title: 'x', updatedAt: T, archived: false }],
    readLines: async function* () {
      yield eventLine(ev('user', [text('una migracion')], T, 'por-id-1'));
      byIdReady();
      await byIdGate;
      yield eventLine(ev('user', [text('otra migracion')], T, 'por-id-2'));
    },
  };
  const idSlot = new GlobalSearchSlot();
  const kept = idSlot.run((signal) => runGlobalSearch(slowDeps, 'migracion', { includeArchived: false, signal }), 'nueva');
  await byIdStarted;
  const wrongId = idSlot.cancel('vieja');
  releaseById();
  const keptResult = await kept;
  check('S8 cancel con el id de otra busqueda no corta la que corre', wrongId === false && keptResult?.hits.length === 2, show({ wrongId, hits: keptResult?.hits.length }));

  let releaseCancel;
  const cancelGate = new Promise((resolve) => { releaseCancel = resolve; });
  let cancelReady;
  const cancelStarted = new Promise((resolve) => { cancelReady = resolve; });
  const cancelled = idSlot.run((signal) => runGlobalSearch({
    ...slowDeps,
    readLines: async function* () {
      yield eventLine(ev('user', [text('una migracion')], T, 'cortada-1'));
      cancelReady();
      await cancelGate;
      yield eventLine(ev('user', [text('otra migracion')], T, 'cortada-2'));
    },
  }, 'migracion', { includeArchived: false, signal }), 'esta');
  await cancelStarted;
  const rightId = idSlot.cancel('esta');
  releaseCancel();
  check('S8 cancel con su id la corta: resuelve null y no contesta', rightId === true && (await cancelled) === null);
}

// ---------------------------------------------------------------------------
// S9: recorre todas las sesiones, cediendo el hilo y avisando lo que encuentra
// ---------------------------------------------------------------------------
{
  // Doce sesiones, y el reloj avanza 400 ms en cada consulta: casi 5 s, que el tope viejo de 1,5 s cortaba en la cuarta.
  const twelve = (lastLine) => fakeSessions(Array.from({ length: 12 }, (_, index) => ({
    sessionId: `s${String(index).padStart(2, '0')}`,
    updatedAt: T - index,
    lines: [eventLine(ev('user', [text(index === 11 ? lastLine : `nada en la ${index}`)], T, `s${index}-1`))],
  })));
  let clock = 0;
  const old = twelve('la migracion estaba en la mas vieja');
  const oldResult = await runGlobalSearch({ ...old.deps, now: () => (clock += 400) }, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S9 un texto que solo esta en la sesion mas vieja se encuentra aunque la busqueda tarde mas de 1,5 s',
    oldResult.truncated === null && oldResult.sessionsScanned === 12 && same(oldResult.hits.map((hit) => hit.sessionId), ['s11']),
    show({ truncated: oldResult.truncated, scanned: oldResult.sessionsScanned, hits: oldResult.hits.map((hit) => hit.sessionId) }));

  clock = 0;
  const none = twelve('tampoco esta aca');
  const noneResult = await runGlobalSearch({ ...none.deps, now: () => (clock += 400) }, 'murcielago', { includeArchived: false, signal: notAborted() });
  const noneText = ui.globalSearchStatusText({ searching: false, error: null, result: noneResult });
  check('S9 un texto que no existe termina sin tope, con las doce leidas, y dice "Sin resultados en 12 sesiones."',
    noneResult.truncated === null && noneResult.sessionsScanned === 12 && noneResult.hits.length === 0 && noneText === 'Sin resultados en 12 sesiones.',
    show({ truncated: noneResult.truncated, scanned: noneResult.sessionsScanned, noneText }));

  // El avance: diez sesiones con un acierto cada una, 100 ms por consulta.
  const ten = fakeSessions(Array.from({ length: 10 }, (_, index) => ({
    sessionId: `p${index}`,
    updatedAt: T - index,
    lines: [eventLine(ev('assistant', [text(`la migracion ${index}`)], T, `p${index}-1`))],
  })));
  let progressClock = 0;
  const progress = [];
  const progressResult = await runGlobalSearch({ ...ten.deps, now: () => (progressClock += 100) }, 'migracion', {
    includeArchived: false,
    signal: notAborted(),
    onProgress: (item) => progress.push({ ...item, at: progressClock }),
  });
  const delivered = progress.flatMap((item) => item.hits);
  const progressCount = progress.length;
  await flushImmediate();
  check('S9 el primer aviso sale enseguida, con el total y nada leido',
    progress[0]?.sessionsTotal === 10 && progress[0]?.sessionsScanned === 0 && progress[0]?.hits.length === 0, show(progress[0]));
  check('S9 los aciertos salen a medida que se encuentran: varios avisos, cada uno con los nuevos, en orden',
    progress.length >= 3 && progress.slice(1).every((item) => item.hits.length > 0 || item.sessionsScanned > 0) &&
    same(delivered.map((hit) => hit.eventId), progressResult.hits.slice(0, delivered.length).map((hit) => hit.eventId)) &&
    delivered.length < progressResult.hits.length,
    show(progress.map((item) => [item.sessionsScanned, item.hits.map((hit) => hit.eventId)])));
  check('S9 el avance no retrocede y los avisos van espaciados al menos GLOBAL_SEARCH_PROGRESS_MS',
    progress.every((item, index) => index === 0 || (item.sessionsScanned >= progress[index - 1].sessionsScanned && item.at - progress[index - 1].at >= GLOBAL_SEARCH_PROGRESS_MS)),
    show(progress.map((item) => [item.at, item.sessionsScanned])));
  check('S9 el resultado final los trae todos, y despues no llega ningun aviso',
    progressResult.hits.length === 10 && progressResult.truncated === null && progress.length === progressCount, show(progressResult.hits.length));

  /*
    Cede el hilo: con lectores que no esperan nada de afuera (todo microtareas),
    una busqueda que no cede termina entera antes de que corra ningun
    `setImmediate` pedido despues de lanzarla. Es lo que frenaba al servidor.
  */
  const busy = fakeSessions(Array.from({ length: 50 }, (_, index) => ({ sessionId: `b${index}`, lines: matchingLines(3) })));
  let finished = false;
  const running = runGlobalSearch(busy.deps, 'migracion', { includeArchived: false, signal: notAborted() }).then((value) => {
    finished = true;
    return value;
  });
  const finishedWhenTickRan = await new Promise((resolve) => setImmediate(() => resolve(finished)));
  const busyResult = await running;
  check('S9 cede el hilo: un setImmediate pedido despues de lanzarla corre antes de que termine, y la busqueda termina igual',
    finishedWhenTickRan === false && busyResult.hits.length === 150 && busyResult.sessionsScanned === 50, show({ finishedWhenTickRan, hits: busyResult.hits.length }));

  const yields = [];
  const counted = fakeSessions(Array.from({ length: 7 }, (_, index) => ({ sessionId: `y${index}`, lines: matchingLines(1) })));
  await runGlobalSearch({ ...counted.deps, yieldToLoop: async () => { yields.push(counted.reads.length); } }, 'migracion', { includeArchived: false, signal: notAborted() });
  check('S9 cede al empezar cada sesion, antes de leerla', same(yields, [0, 1, 2, 3, 4, 5, 6]), show(yields));

  // Una busqueda nueva que llega mientras cede corta la vieja ahi mismo, sin mas avisos.
  const controller = new AbortController();
  const afterAbort = [];
  let aborted = false;
  const cut = fakeSessions(Array.from({ length: 5 }, (_, index) => ({ sessionId: `c${index}`, lines: matchingLines(1) })));
  const cutError = await runGlobalSearch({
    ...cut.deps,
    yieldToLoop: async () => {
      if (cut.reads.length === 2) {
        controller.abort();
        aborted = true;
      }
    },
  }, 'migracion', { includeArchived: false, signal: controller.signal, onProgress: (item) => { if (aborted) afterAbort.push(item); } }).then(() => null, (error) => error);
  check('S9 cancelada mientras cede: rechaza con GlobalSearchAbortedError, no lee la siguiente ni avisa nada',
    cutError instanceof GlobalSearchAbortedError && same(cut.reads, ['c0', 'c1']) && afterAbort.length === 0, show({ reads: cut.reads, afterAbort: afterAbort.length }));

  // El tope de seguridad dice cuantas quedaron sin mirar.
  let safetyClock = 0;
  const safety = twelve('sin nada');
  const safetyResult = await runGlobalSearch({ ...safety.deps, now: () => (safetyClock += 7_000) }, 'murcielago', { includeArchived: false, signal: notAborted() });
  const safetyText = ui.globalSearchStatusText({ searching: false, error: null, result: safetyResult });
  check('S9 con el tope de seguridad (30 s): time, y la linea dice cuantas sesiones quedaron sin mirar',
    GLOBAL_SEARCH_SAFETY_MS === 30_000 && safetyResult.truncated === 'time' && safetyResult.sessionsScanned === 4 &&
    safetyText === 'Sin resultados: la búsqueda se cortó a los 30 s y quedaron 8 sesiones sin mirar.', show({ scanned: safetyResult.sessionsScanned, safetyText }));

  // Por el servicio, sobre la copia de verdad: el progreso llega y lo que suma es lo del final.
  const serviceProgress = [];
  const serviceResult = await service.search('migracion', { includeArchived: false, signal: notAborted(), onProgress: (item) => serviceProgress.push(item) });
  check('S9 VaultService.search pasa el avance: el primero con el total, y los aciertos avisados son un prefijo del final',
    serviceProgress[0]?.sessionsTotal === 4 && same(serviceProgress.flatMap((item) => item.hits).map(pairOf), serviceResult.hits.slice(0, serviceProgress.flatMap((item) => item.hits).length).map(pairOf)),
    show(serviceProgress.map((item) => item.sessionsScanned)));
}

// ---------------------------------------------------------------------------
// Protocolo
// ---------------------------------------------------------------------------
{
  const request = parseClientMessage(JSON.stringify({ type: 'search.global', searchId: 's1', query: 'x'.repeat(300), includeArchived: true }));
  check('protocolo search.global: la consulta se recorta a 200 y viaja includeArchived',
    request?.type === 'search.global' && request.query.length === GLOBAL_SEARCH_MAX_QUERY_CHARS && request.includeArchived === true, show(request));
  const plain = parseClientMessage(JSON.stringify({ type: 'search.global', searchId: 's2', query: 'mi' }));
  check('protocolo search.global: sin includeArchived es false, y una consulta corta es valida', plain?.includeArchived === false && plain.query === 'mi');
  check('protocolo search.global: sin searchId o con query que no es texto -> null',
    parseClientMessage(JSON.stringify({ type: 'search.global', query: 'migracion' })) === null &&
    parseClientMessage(JSON.stringify({ type: 'search.global', searchId: 's3', query: 5 })) === null);

  const hit = {
    agent: 'codex', sessionId: ID.b, cwd: null, title: 't', eventId: 'e1', role: 'user', at: T,
    snippet: 'una migracion', matchStart: 4, matchLength: 9,
  };
  const result = { query: 'migracion', hits: [hit], sessionsScanned: 1, sessionsTotal: 2, truncated: 'time' };
  const parsed = parseServerMessage(JSON.stringify({ type: 'search.results', searchId: 's1', result }));
  check('protocolo search.results completo', parsed?.type === 'search.results' && same(parsed.result, result), show(parsed));
  const filtered = parseGlobalSearchResult({
    ...result,
    hits: [hit, { ...hit, agent: 'otra-cli' }, { ...hit, matchStart: 10 }, { ...hit, role: 'system' }],
  });
  check('protocolo: un acierto de una fuente desconocida, que se sale del fragmento o con otro rol se descarta solo',
    filtered?.hits.length === 1, show(filtered?.hits.length));
  check('protocolo: truncated desconocido, escaneadas de mas o sin searchId -> null',
    parseGlobalSearchResult({ ...result, truncated: 'otro' }) === null &&
    parseGlobalSearchResult({ ...result, sessionsScanned: 3 }) === null &&
    parseServerMessage(JSON.stringify({ type: 'search.results', result })) === null);
  check('protocolo: truncated ausente es null', parseGlobalSearchResult({ ...result, truncated: undefined })?.truncated === null);
  check('protocolo: search-failed es un codigo conocido', SERVER_ERROR_CODES.includes('search-failed') &&
    parseServerMessage(JSON.stringify({ type: 'error', code: 'search-failed', message: 'x', requestId: 's1' }))?.code === 'search-failed');

  const progress = { query: 'migracion', hits: [hit], sessionsScanned: 1, sessionsTotal: 2 };
  const parsedProgress = parseServerMessage(JSON.stringify({ type: 'search.progress', searchId: 's1', progress }));
  check('protocolo search.progress completo', parsedProgress?.type === 'search.progress' && parsedProgress.searchId === 's1' && same(parsedProgress.progress, progress), show(parsedProgress));
  check('protocolo search.progress: aciertos malos fuera; escaneadas de mas, sin searchId o sin hits -> null',
    parseGlobalSearchProgress({ ...progress, hits: [hit, { ...hit, agent: 'otra-cli' }] })?.hits.length === 1 &&
    parseGlobalSearchProgress({ ...progress, sessionsScanned: 3 }) === null &&
    parseGlobalSearchProgress({ ...progress, hits: undefined }) === null &&
    parseServerMessage(JSON.stringify({ type: 'search.progress', progress })) === null);
  const cancel = parseClientMessage(JSON.stringify({ type: 'search.cancel', searchId: 's1' }));
  check('protocolo search.cancel: con searchId pasa, sin el -> null',
    same(cancel, { type: 'search.cancel', searchId: 's1' }) && parseClientMessage(JSON.stringify({ type: 'search.cancel' })) === null, show(cancel));
}

// ---------------------------------------------------------------------------
// W: la web
// ---------------------------------------------------------------------------
{
  const info = (id, available = true) => ({ id, label: id, available, version: null, capabilities: {} });
  const status = (overrides = {}) => ({ enabled: true, sessions: 3, ...overrides });
  check('W globalSearchVisible: una sola CLI -> no (D21), aunque la copia tenga sesiones',
    ui.globalSearchVisible([info('claude-code'), info('codex', false)], status()) === false);
  check('W globalSearchVisible: dos CLIs sin estado de la copia, o con la copia vacia -> no',
    ui.globalSearchVisible([info('claude-code'), info('codex')], null) === false &&
    ui.globalSearchVisible([info('claude-code'), info('codex')], status({ sessions: 0 })) === false);
  check('W globalSearchVisible: dos CLIs y sesiones en la copia -> si, tambien apagada',
    ui.globalSearchVisible([info('claude-code'), info('codex')], status()) === true &&
    ui.globalSearchVisible([info('claude-code'), info('codex')], status({ enabled: false })) === true);
  check('W el placeholder en titulos es el de siempre', ui.sidebarFilterPlaceholder('titles') === 'Filtrar proyectos y sesiones' &&
    ui.sidebarFilterPlaceholder('conversations') !== ui.sidebarFilterPlaceholder('titles'));
  check('W globalSearchTooShort cuenta caracteres recortados', ui.globalSearchTooShort(' mi ') && !ui.globalSearchTooShort('mig'));

  const result = await service.search('migracion', { includeArchived: false, signal: notAborted() });
  const groups = ui.groupSearchHits(result.hits);
  check('W groupSearchHits: una por sesion en el orden en que llegan, con el titulo aparte',
    same(groups.map((group) => group.sessionId), [ID.a, ID.b, ID.d]) && groups[0].titleHit !== null && groups[0].hits.length === 2 &&
    groups[1].titleHit === null && groups[1].lastAt === b3.at, show(groups.map((group) => [group.sessionId, group.hits.length])));
  const pieces = ui.snippetPieces(groups[0].hits[0], Infinity);
  check('W snippetPieces parte el fragmento alrededor del acierto',
    pieces.match === 'migración' && `${pieces.before}${pieces.match}${pieces.after}` === groups[0].hits[0].snippet, show(pieces));
  // Medido en la prueba en vivo: la barra recorta el fragmento a dos lineas, y un acierto al final de un mensaje largo quedaba escondido.
  const longBefore = { snippet: `…${'x'.repeat(100)}😀${'y'.repeat(20)}migración final`, matchStart: 0, matchLength: 9 };
  longBefore.matchStart = longBefore.snippet.indexOf('migración');
  const clamped = ui.snippetPieces(longBefore);
  check('W snippetPieces deja a lo sumo SNIPPET_LEAD_CHARS antes del acierto, con …',
    clamped.match === 'migración' && clamped.before.startsWith('…') && clamped.before.length <= ui.SNIPPET_LEAD_CHARS + 2 &&
    `${clamped.match}${clamped.after}` === longBefore.snippet.slice(longBefore.matchStart) &&
    longBefore.snippet.endsWith(clamped.before.slice(1) + clamped.match + clamped.after), show(clamped));
  const emojiCut = { snippet: `${'x'.repeat(20)}😀${'y'.repeat(ui.SNIPPET_LEAD_CHARS - 1)}migración`, matchStart: 0, matchLength: 9 };
  emojiCut.matchStart = emojiCut.snippet.indexOf('migración');
  const emojiPieces = ui.snippetPieces(emojiCut);
  check('W el recorte no parte un par sustituto', !/^…[\udc00-\udfff]/.test(emojiPieces.before) && !/[\ud800-\udbff]$/.test(emojiPieces.before.slice(0, 2)),
    show(emojiPieces.before.slice(0, 4)));
  const short = ui.snippetPieces({ snippet: 'ver migración acá', matchStart: 4, matchLength: 9 });
  check('W con poco texto antes, el fragmento queda igual', short.before === 'ver ' && short.after === ' acá');
  check('W al buscador del hilo va el texto como esta escrito, del primer mensaje del grupo',
    ui.groupThreadQuery(groups[0]) === 'migración' && ui.threadQueryFor(groups[1].hits[1]) === 'MIGRACIÓN' &&
    ui.groupThreadQuery({ ...groups[0], hits: [] }) === 'Migración');
  check('W searchHitRoleText', ui.searchHitRoleText({ role: 'user' }) === 'Pedido' && ui.searchHitRoleText({ role: 'assistant' }) === 'Respuesta' &&
    ui.searchHitRoleText({ role: null }) === 'Título');

  const statusTexts = [
    ui.globalSearchStatusText({ searching: true, error: null, result: null }),
    ui.globalSearchStatusText({ searching: false, error: 'No se pudo', result: null }),
    ui.globalSearchStatusText({ searching: false, error: null, result }),
    ui.globalSearchStatusText({ searching: false, error: null, result: { ...result, hits: [], truncated: null, sessionsScanned: 7, sessionsTotal: 7 } }),
    ui.globalSearchStatusText({ searching: false, error: null, result: { ...result, hits: [], truncated: null, sessionsScanned: 1, sessionsTotal: 1 } }),
    ui.globalSearchStatusText({ searching: false, error: null, result: { ...result, hits: [], truncated: null, sessionsScanned: 0, sessionsTotal: 0 } }),
    ui.globalSearchStatusText({ searching: false, error: null, result: { ...result, truncated: 'results' } }),
    ui.globalSearchStatusText({ searching: false, error: null, result: { ...result, hits: [], truncated: 'time', sessionsScanned: 1, sessionsTotal: 4 } }),
    ui.globalSearchStatusText({ searching: false, error: null, result: null }),
  ];
  check('W la linea de estado: buscando, error, cuantos, sin resultados con cuantas se miraron, tope de resultados, tope de seguridad con lo que quedo, nada',
    same(statusTexts, [
      'Buscando…',
      'No se pudo',
      '6 aciertos en 3 sesiones.',
      'Sin resultados en 7 sesiones.',
      'Sin resultados en 1 sesión.',
      'Sin resultados.',
      '6 aciertos en 3 sesiones: son los primeros, afiná la búsqueda para ver el resto.',
      'Sin resultados: la búsqueda se cortó a los 30 s y quedaron 3 sesiones sin mirar.',
      null,
    ]), show(statusTexts));

  // Mientras recorre: lo que lleva y lo encontrado, nunca "Sin resultados".
  const partialEmpty = ui.mergeSearchProgress(null, { query: 'migracion', hits: [], sessionsScanned: 3, sessionsTotal: 12 });
  const partialOne = ui.mergeSearchProgress(partialEmpty, { query: 'migracion', hits: result.hits.slice(0, 2), sessionsScanned: 5, sessionsTotal: 12 });
  const partialTwo = ui.mergeSearchProgress(partialOne, { query: 'migracion', hits: result.hits.slice(2, 3), sessionsScanned: 6, sessionsTotal: 12 });
  check('W mergeSearchProgress: suma los nuevos al final, toma el avance del aviso y no dice que termino',
    partialEmpty.hits.length === 0 && same(partialTwo.hits, result.hits.slice(0, 3)) && partialTwo.sessionsScanned === 6 &&
    partialTwo.sessionsTotal === 12 && partialTwo.truncated === null && partialOne.hits.length === 2, show(partialTwo.hits.length));
  const searchingTexts = [
    ui.globalSearchStatusText({ searching: true, error: null, result: partialEmpty }),
    ui.globalSearchStatusText({ searching: true, error: null, result: partialOne }),
  ];
  check('W buscando con avance: cuantas lleva de cuantas y lo encontrado por ahora, sin "Sin resultados"',
    same(searchingTexts, ['Buscando… 3 de 12 sesiones.', 'Buscando… 5 de 12 sesiones, 2 aciertos en 1 sesión por ahora.']), show(searchingTexts));

  const row = (overrides = {}) => ({
    agent: 'codex', sessionId: ID.b, cwd: 'c:\\proyectos\\demo', title: 't', titleSource: 'first-message', updatedAt: T,
    sizeBytes: 1, archived: false, storage: 'native', partial: false, ...overrides,
  });
  const project = (sessions, overrides = {}) => ({ key: 'k', fallbackName: '', cwd: 'C:\\proyectos\\demo', sessions, lastActivityAt: T, cwdExists: true, ...overrides });
  const terminal = (overrides = {}) => ({ terminalId: 'tab-1', kind: 'agent', cwd: 'C:\\proyectos\\demo', agent: 'codex', sessionId: ID.b, ...overrides });
  const context = (overrides = {}) => ({ projects: [project([row()])], terminals: [], platform: 'win32', canResume: () => true, ...overrides });
  const hitB = { agent: 'codex', sessionId: ID.b };
  check('W un clic sobre una sesion con pestana la activa',
    same(ui.searchHitAction(hitB, context({ terminals: [terminal({ kind: 'shell', agent: null }), terminal({ terminalId: 'tab-2' })] })), { kind: 'activate', terminalId: 'tab-2' }));
  const resume = ui.searchHitAction(hitB, context());
  check('W una nativa que se retoma: con su CLI y la carpeta de la fila (resumeCwdFor)',
    resume.kind === 'resume' && resume.cwd === 'C:\\proyectos\\demo' && resume.session.sessionId === ID.b, show(resume));
  check('W una archivada tambien se retoma, y la accion lo dice', ui.searchHitAction(hitB, context({ projects: [project([row({ archived: true })])] })).session?.archived === true);
  check('W la misma id de otra CLI no activa esa pestana', ui.searchHitAction(hitB, context({ terminals: [terminal({ agent: 'claude-code' })] })).kind === 'resume');
  check('W fila "copia", CLI sin instalar, carpeta borrada o fuera de la barra -> el Markdown de la copia',
    ui.searchHitAction(hitB, context({ projects: [project([row({ storage: 'vault' })])] })).kind === 'copy' &&
    ui.searchHitAction(hitB, context({ canResume: () => false })).kind === 'copy' &&
    ui.searchHitAction(hitB, context({ projects: [project([row()], { cwdExists: false })] })).kind === 'copy' &&
    ui.searchHitAction(hitB, context({ projects: [] })).kind === 'copy' &&
    ui.searchHitAction({ agent: 'gemini-cli', sessionId: ID.d }, context({ projects: [project([row({ agent: 'gemini-cli', sessionId: ID.d, storage: 'vault' })])] })).kind === 'copy');

  /*
    Lo que las funciones puras no ven: que la barra y `App` decidan con ellas.
    Expresiones exactas sobre el fuente, frágiles ante un refactor de esas lineas
    como las de `check-vault.mjs`.
  */
  const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
  const sidebarSource = await readFile(path.join(webSrc, 'Sidebar.tsx'), 'utf8');
  const appSource = await readFile(path.join(webSrc, 'App.tsx'), 'utf8');
  const workspaceSource = await readFile(path.join(webSrc, 'useWorkspace.ts'), 'utf8');
  check('W fuente: App decide el buscador con globalSearchVisible y le pasa null a la barra si no se ve',
    /const globalSearchShown = globalSearchVisible\(agents, vault\.status\);/.test(appSource) &&
    /globalSearchShown \? \{ \.\.\.globalSearch, vaultEnabled: vault\.status\?\.enabled === true \} : null/.test(appSource));
  check('W fuente: la barra solo dibuja el conmutador con buscador, y sin el busca en titulos',
    /\{globalSearch !== null && \(\s*<div className="sidebar-search-mode"/.test(sidebarSource) &&
    /const searchMode: SidebarSearchMode = globalSearch === null \? 'titles' : searchModeChoice;/.test(sidebarSource));
  check('W fuente: un clic en un acierto sale por searchHitAction', /const action = searchHitAction\(hit, \{/.test(appSource));
  check('W fuente: un search-failed no va al cartel general', /if \(message\.code === 'search-failed'\) break;/.test(workspaceSource));
  const hookSource = await readFile(path.join(webSrc, 'useGlobalSearch.ts'), 'utf8');
  const socketSource = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/terminal-socket.ts'), 'utf8');
  check('W fuente: el buscador suma los avisos de su busqueda con mergeSearchProgress',
    /case 'search\.progress':\s*if \(current\.current === null \|\| message\.searchId !== current\.current\) break;\s*setResult\(\(previous\) => mergeSearchProgress\(previous, message\.progress\)\);/.test(hookSource));
  check('W fuente: volver a la lista con una busqueda en camino la corta en el servidor',
    /if \(inFlight !== null\) connection\.send\(\{ type: 'search\.cancel', searchId: inFlight \}\);/.test(hookSource));
  check('W fuente: el socket manda el avance mientras no se cancelo, y search.cancel corta por id',
    /onProgress: \(progress\) => \{\s*if \(!signal\.aborted\) send\(socket, \{ type: 'search\.progress', searchId, progress \}\);/.test(socketSource) &&
    /case 'search\.cancel':\s*globalSearch\.cancel\(message\.searchId\);/.test(socketSource));
}

service.dispose();
await rm(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
