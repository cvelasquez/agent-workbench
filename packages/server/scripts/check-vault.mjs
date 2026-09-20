/**
 * Chequeo de la copia propia (hito 28).
 *
 *   npx tsx scripts/check-vault.mjs
 *
 * La copia es lo que queda cuando el historial de una CLI ya no esta: un
 * formato que se lee mal, o una fila que se abre con la CLI equivocada, no se
 * nota usando la app hasta el dia en que hace falta. Cada caso de la
 * especificacion tiene su bloque, numerado igual:
 *
 *  - 1: los parsers de `shared` (cabecera, cuerpo, `SessionSummary`, estado y
 *    mensajes `vault.*`), el indice completando `storage` y `partial`, lo que
 *    la web deriva de un id importado, y los textos de la copia en la web
 *    (`vault-ui.ts`): la linea de la barra solo encendida (C9), las marcas,
 *    cuando se ofrece "Activar" y la tabla de la medicion.
 *  - 2: los topes por sesion (`FollowOptions`) en los cuatro adaptadores, leidos
 *    por `history.follow` de cada uno: sin opciones, lo de siempre; con los de
 *    la copia, el texto y la entrada enteros y el resultado a 64 000. Un
 *    historial de 4 100 eventos sin paginar. `wholeRead`, `sqlCutLength`, los
 *    cortes con nombre de OpenCode y `rootExists`.
 *  - 3: las rutas y los nombres saneados de la copia, y la ida y vuelta: fixture
 *    nativo de cada CLI -> `readWholeSession` -> `serializeSession` -> disco ->
 *    catalogo -> cuerpo, que recortado con `TRANSPORT_LIMITS` es el hilo de
 *    siempre. Las reglas del catalogo (formato ajeno, id que no casa, `.tmp`).
 *  - 4: imagenes: iguales dentro de una sesion son un solo asset, un asset que ya
 *    esta no se reescribe, reusadas y ausentes.
 *  - 5: la escritura atomica: `rename` con `EPERM` que se reintenta, temporales
 *    que no quedan, `vault.json`.
 *  - 6: lo que `readWholeSession` no deja pasar: una fuente sin `wholeRead`, una
 *    lectura que pagina, un origen que no se encuentra.
 *  - 7 a 10: el escritor sobre el indice real. La huella (dos pasadas no
 *    reescriben, tocar el nativo si, otra revision tambien), la calma con un
 *    reloj de mentira, las archivadas, la pasada en seco, encender, los ajustes y
 *    la memoria. Y las mitades de 4, 5 y 6 que dependen de la pasada: imagenes
 *    reusadas sin leer, temporales viejos, un fallo que no corta y un disco
 *    lleno que si.
 *  - 11: el indice mezcla la copia: `vaultOnlySessions` (nativa gana, listed,
 *    missing, unreadable, importadas, sin terminar), el estado de cada `list()`,
 *    la rama sin ningun historial nativo (C3), un `list()` que lanza, las
 *    emisiones durante el escaneo y cuando el catalogo cambia.
 *  - 12: el Markdown (cercas que el contenido no cierra, enlaces de imagen que
 *    llegan al asset, aviso de parcial, nombres saneados) y lo que el servicio
 *    hace con el: abrir una fila "copia" y exportar un proyecto sin escribir la
 *    copia, tambien apagada.
 *  - 13: mudar la copia: `moveVault` copia sin pisar ni borrar, las carpetas que
 *    se rechazan, un selector parado en una carpeta protegida, y el servicio
 *    (mudanza, ocupado, estado espaciado y pasadas solo por cambios nativos).
 *  - 14: los importadores de un solo uso sobre fixtures inventados
 *    (`fixtures/vault-fixtures.mjs`): los chats de Gemini CLI (avisos
 *    saltados, sin respuesta, herramientas, tokens, `--cwd` casado) y el
 *    rescate de Antigravity IDE (solo las filas del IDE de esa carpeta, solo los
 *    `.md` de su `brain/<id>/`, la base original intacta, la temporal borrada).
 *    Y `pnpm vault:import`: en seco no crea nada, `--write` escribe, reimportar
 *    deja lo mismo, un formato ajeno no se pisa.
 *  - 15: estaticos. La carpeta del IDE solo la nombra su importador (las dos
 *    expresiones de C8, sobre el codigo sin comentarios), la copia no abre la
 *    red, el servidor no llega a los importadores, y ningun importador pide
 *    todas las columnas ni nombra credenciales.
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA` y las carpetas XDG apuntando a
 * una carpeta temporal propia, fijadas **antes** de importar nada: nunca lee
 * ni escribe el historial de ninguna CLI de verdad. No importa nada que cargue
 * `node-pty`. Los textos son inventados.
 */

import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setLocale } from '../../web/src/i18n/index.ts';
import { serverTextMessage as es } from '../../web/src/i18n/server-text.ts';

// Los textos de la interfaz salen de `t()` (§6.23): este chequeo los compara
// con el español de siempre, así que lo fija antes de la primera comparación.
await setLocale('es');

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-vault-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
process.env['CODEX_HOME'] = path.join(root, 'codex');
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
delete process.env['OPENCODE_DB'];
delete process.env['OPENCODE_MODELS_PATH'];
delete process.env['OPENCODE_MODELS_URL'];

const shared = await import('@agent-workbench/shared');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (value) => JSON.stringify(value);
/** Igualdad estructural, con el orden de las claves normalizado. */
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]))
      : value;
const sameShape = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

/** Espera a que `condition()` sea verdad, con plazo. Nunca un sleep fijo. */
async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. Parsers, indice y web
// ---------------------------------------------------------------------------

const UUID = '0b1e2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

// --- 1a. Los ids de sesion de la barra ---
{
  const { AGENT_IDS, IMPORTED_AGENT_IDS, IMPORTED_AGENT_LABELS, SESSION_AGENT_IDS, isAgentId, isImportedAgentId } = shared;
  check('1 SESSION_AGENT_IDS son las CLIs con adaptador y despues las importadas, en ese orden',
    same(SESSION_AGENT_IDS, [...AGENT_IDS, ...IMPORTED_AGENT_IDS]), show(SESSION_AGENT_IDS));
  check('1 ningun id importado es de una CLI con adaptador',
    IMPORTED_AGENT_IDS.every((id) => !AGENT_IDS.includes(id)));
  check('1 isAgentId: una CLI si, una importada no',
    isAgentId('claude-code') && isAgentId('antigravity') && !isAgentId('gemini-cli') && !isAgentId('antigravity-ide') && !isAgentId('nope'));
  check('1 isImportedAgentId: al reves',
    isImportedAgentId('gemini-cli') && isImportedAgentId('antigravity-ide') && !isImportedAgentId('codex'));
  check('1 cada importada tiene su nombre para mostrar',
    IMPORTED_AGENT_IDS.every((id) => typeof IMPORTED_AGENT_LABELS[id] === 'string' && IMPORTED_AGENT_LABELS[id].length > 0));
}

// --- 1b. La cabecera ---
const header = (overrides = {}) => ({
  kind: 'header',
  format: 1,
  agent: 'claude-code',
  sessionId: UUID,
  cwd: 'C:\\proyectos\\demo',
  group: `vault:claude-code:${UUID}`,
  title: 'Probemos la conexion del proyecto de prueba',
  titleSource: 'first-message',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_500_000,
  cliVersionAtCopy: '2.1.263',
  partial: false,
  stepCount: null,
  usage: {
    lastRequestTokens: 12, lastOutputTokens: 3, lastModel: 'modelo-de-prueba', contextWindow: null,
    contextWindowEstimated: false, totalInputTokens: 12, totalOutputTokens: 3, totalCacheReadTokens: 0,
    assistantMessages: 1,
  },
  eventCount: 2,
  documentCount: 0,
  imageCount: 1,
  source: { kind: 'native', mtimeMs: 1_700_000_500_000, sizeBytes: 4096, writerRevision: 1 },
  writtenAt: 1_700_000_600_000,
  ...overrides,
});
{
  const { parseVaultHeader } = shared;
  const valid = header();
  check('1 cabecera valida: sale igual', same(parseVaultHeader(valid), valid), show(parseVaultHeader(valid)));
  // La vuelta por JSON, que es como se lee de disco.
  check('1 cabecera valida despues de JSON', same(parseVaultHeader(JSON.parse(JSON.stringify(valid))), valid));

  check('1 format 2 -> null: una app mas nueva escribio ahi', parseVaultHeader(header({ format: 2 })) === null);
  check('1 format "1" como texto -> null', parseVaultHeader(header({ format: '1' })) === null);
  check('1 kind distinto de header -> null', parseVaultHeader(header({ kind: 'event' })) === null);
  check('1 agent desconocido -> null', parseVaultHeader(header({ agent: 'nope' })) === null);
  check('1 agent importado -> valida',
    parseVaultHeader(header({ agent: 'gemini-cli', group: 'Gemini CLI · carpeta desconocida', cwd: '' }))?.agent === 'gemini-cli');
  for (const bad of ['../x', 'a/b', 'C:x', 'a\\b', '.oculto', '', 'x'.repeat(129)]) {
    check(`1 sessionId ${show(bad.length > 20 ? `${bad.slice(0, 5)}… (${bad.length})` : bad)} -> null`,
      parseVaultHeader(header({ sessionId: bad })) === null);
  }
  check('1 sessionId de OpenCode (ses_…) -> valida', parseVaultHeader(header({ sessionId: 'ses_4f2a9c1b0dEXAMPLE' })) !== null);
  for (const field of ['title', 'titleSource', 'updatedAt', 'partial', 'eventCount', 'documentCount', 'imageCount', 'source', 'writtenAt', 'cwd', 'group']) {
    const broken = header();
    delete broken[field];
    check(`1 sin ${field} -> null`, parseVaultHeader(broken) === null);
  }
  check('1 source import con importador desconocido -> null',
    parseVaultHeader(header({ source: { kind: 'import', importer: 'otro', importedAt: 1 } })) === null);
  check('1 source import conocido -> valida',
    parseVaultHeader(header({ source: { kind: 'import', importer: 'antigravity-ide-rescue', importedAt: 5 }, partial: true, stepCount: 42 }))?.stepCount === 42);
  check('1 createdAt con texto -> null', parseVaultHeader(header({ createdAt: 'ayer' })) === null);
  const withoutNullable = header();
  delete withoutNullable.createdAt;
  delete withoutNullable.cliVersionAtCopy;
  delete withoutNullable.stepCount;
  const tolerant = parseVaultHeader(withoutNullable);
  check('1 los campos que admiten null, ausentes, salen null',
    tolerant !== null && tolerant.createdAt === null && tolerant.cliVersionAtCopy === null && tolerant.stepCount === null, show(tolerant));
  const badUsage = parseVaultHeader(header({ usage: { lastRequestTokens: 'mucho' } }));
  check('1 usage invalido -> la cabecera vale con usage null', badUsage !== null && badUsage.usage === null, show(badUsage?.usage));
}

// --- 1c. El cuerpo ---
const event = (overrides = {}) => ({
  eventId: 'e1', role: 'user', at: 1_700_000_100_000,
  parts: [{ kind: 'text', text: 'Probemos la conexion del proyecto de prueba', truncated: false }, { kind: 'image', index: 0, mediaType: 'image/png', source: 'content' }],
  model: null, usage: null, effort: null, durationMs: null, queued: false,
  ...overrides,
});
const imageRef = (overrides = {}) => ({
  index: 0, source: 'content', mediaType: 'image/png', asset: `${'a'.repeat(32)}.png`, bytes: 120, ...overrides,
});
{
  const { parseVaultBodyLine } = shared;
  const eventLine = { kind: 'event', event: event(), images: [imageRef()] };
  check('1 linea event valida: sale igual', same(parseVaultBodyLine(eventLine), eventLine), show(parseVaultBodyLine(eventLine)));
  check('1 event con evento invalido (sin eventId) -> null',
    parseVaultBodyLine({ kind: 'event', event: event({ eventId: '' }), images: [imageRef()] }) === null);
  check('1 event con role desconocido -> null',
    parseVaultBodyLine({ kind: 'event', event: event({ role: 'system' }), images: [imageRef()] }) === null);
  check('1 event sin images -> null', parseVaultBodyLine({ kind: 'event', event: event() }) === null);
  check('1 event con menos imagenes que partes image -> null',
    parseVaultBodyLine({ kind: 'event', event: event(), images: [] }) === null);
  check('1 imagen con asset que es una ruta -> null',
    parseVaultBodyLine({ kind: 'event', event: event(), images: [imageRef({ asset: '../../credenciales.png' })] }) === null);
  check('1 imagen sin asset (no se pudo leer) -> valida',
    parseVaultBodyLine({ kind: 'event', event: event(), images: [imageRef({ asset: null })] })?.images[0]?.asset === null);
  check('1 kind desconocido -> null', parseVaultBodyLine({ kind: 'bookmark', text: 'x' }) === null);
  check('1 no objeto -> null', parseVaultBodyLine('hola') === null && parseVaultBodyLine(null) === null);

  const doc = { kind: 'document', origin: 'agent-document', name: 'plan.md', modifiedAt: 1_700_000_000_000, text: '# Plan de prueba', truncated: false };
  check('1 document valido: sale igual', same(parseVaultBodyLine(doc), doc));
  check('1 document origin plan -> null: los planes no entran en el 28', parseVaultBodyLine({ ...doc, origin: 'plan' }) === null);
  check('1 document con nombre que trae carpeta -> null',
    parseVaultBodyLine({ ...doc, name: 'brain/plan.md' }) === null && parseVaultBodyLine({ ...doc, name: 'a\\plan.md' }) === null);
}

// --- 1d. SessionSummary con storage y partial ---
{
  const { parseSessionSummary, parseProjectSummary } = shared;
  const base = { sessionId: UUID, cwd: 'C:\\p', title: 't', titleSource: 'none', updatedAt: 1, sizeBytes: 2, archived: false };
  const legacy = parseSessionSummary({ ...base, agent: 'codex' });
  check('1 parseSessionSummary sin storage -> native y partial false',
    legacy?.storage === 'native' && legacy.partial === false, show(legacy));
  const noAgent = parseSessionSummary(base);
  check('1 sin agent sigue siendo claude-code', noAgent?.agent === 'claude-code' && noAgent.storage === 'native');
  const imported = parseSessionSummary({ ...base, agent: 'gemini-cli', storage: 'vault', partial: false });
  check('1 con agent gemini-cli -> valida, de la copia', imported?.agent === 'gemini-cli' && imported.storage === 'vault', show(imported));
  const rescued = parseSessionSummary({ ...base, agent: 'antigravity-ide', storage: 'vault', partial: true });
  check('1 partial true se conserva', rescued?.partial === true);
  check('1 storage desconocido -> native', parseSessionSummary({ ...base, storage: 'nube' })?.storage === 'native');
  check('1 partial que no es true -> false', parseSessionSummary({ ...base, partial: 'si' })?.partial === false);
  check('1 agent desconocido sigue descartando la sesion', parseSessionSummary({ ...base, agent: 'nope' }) === null);
  const project = parseProjectSummary({
    key: 'c:\\p', fallbackName: '', cwd: 'C:\\p', cwdExists: true, lastActivityAt: 1,
    sessions: [{ ...base, agent: 'antigravity-ide', storage: 'vault', partial: true }, { ...base, sessionId: 'otra', agent: 'nope' }],
  });
  check('1 un proyecto conserva la importada y descarta la desconocida',
    project?.sessions.length === 1 && project.sessions[0].agent === 'antigravity-ide', show(project?.sessions));
}

// --- 1e. El estado del dialogo ---
const measure = (overrides = {}) => ({
  agent: 'claude-code', sessions: 3, eventBytes: 9000, images: 1, imageBytes: 100, skippedArchived: 2,
  skippedEmpty: 0, unsupported: 0, failed: 1, failureReasons: [{ key: 'vaultReasonOriginMissing' }], ...overrides,
});
const status = (overrides = {}) => ({
  enabled: true, dir: 'C:\\copia', isDefaultDir: false, state: 'writing', progress: { done: 1, total: 4 },
  sessions: 10, passSessions: 7, bytes: 2048, lastPassAt: 1_700_000_000_000, pending: 2,
  measurement: { measuredAt: 1, durationMs: 20, byAgent: [measure()], memoryProjects: 1, memoryBytes: 10 },
  previousDir: null, lastError: null, ...overrides,
});
{
  const { parseVaultStatus } = shared;
  check('1 estado valido: sale igual', same(parseVaultStatus(status()), status()), show(parseVaultStatus(status())));
  const off = status({ enabled: false, state: 'off', progress: null, lastPassAt: null, measurement: null, previousDir: 'D:\\vieja', lastError: { key: 'raw', params: { text: 'disco lleno' } } });
  check('1 estado apagado, con nulls y textos: sale igual', same(parseVaultStatus(off), off));
  const broken = [
    ['state desconocido', { state: 'durmiendo' }],
    ['sin dir', { dir: undefined }],
    ['enabled con texto', { enabled: 'si' }],
    ['progress roto', { progress: { done: 'uno', total: 4 } }],
    ['sessions negativo', { sessions: -1 }],
    ['sin passSessions', { passSessions: undefined }],
    ['passSessions con texto', { passSessions: 'dos' }],
    ['lastPassAt con texto', { lastPassAt: 'hoy' }],
    ['lastError con numero', { lastError: 5 }],
    ['lastError como frase suelta (antes del hito 34)', { lastError: 'disco lleno' }],
    ['medicion rota', { measurement: { measuredAt: 1 } }],
    ['fila de medicion rota', { measurement: { measuredAt: 1, durationMs: 2, byAgent: [measure({ failureReasons: [3] })], memoryProjects: 0, memoryBytes: 0 } }],
  ];
  for (const [what, overrides] of broken) {
    const value = status(overrides);
    for (const key of Object.keys(overrides)) if (overrides[key] === undefined) delete value[key];
    // Una fila rota de una CLI conocida se filtra como una desconocida; la
    // medicion entera no se cae, pero la fila no puede aparecer.
    if (what === 'fila de medicion rota') {
      const parsed = parseVaultStatus(value);
      check(`1 estado con ${what}: la fila no sale`, parsed !== null && parsed.measurement?.byAgent.length === 0, show(parsed?.measurement));
      continue;
    }
    check(`1 estado con ${what} -> null`, parseVaultStatus(value) === null);
  }
  const future = parseVaultStatus(status({
    measurement: { measuredAt: 1, durationMs: 2, byAgent: [measure({ agent: 'otra-cli' }), measure({ agent: 'gemini-cli' })], memoryProjects: 0, memoryBytes: 0 },
  }));
  check('1 una fila de una fuente que este cliente no conoce se filtra, la importada queda',
    future?.measurement?.byAgent.length === 1 && future.measurement.byAgent[0].agent === 'gemini-cli', show(future?.measurement));
}

// --- 1f. Los mensajes vault.* ---
{
  const { PROTOCOL_VERSION, SERVER_ERROR_CODES, parseClientMessage, parseServerMessage, encodeServerMessage } = shared;
  check('1 el protocolo sube a la 8 (hito 34: los textos viajan como clave)', PROTOCOL_VERSION === 8, String(PROTOCOL_VERSION));
  check('1 vault-failed es un codigo de error', SERVER_ERROR_CODES.includes('vault-failed'));
  const client = (value) => parseClientMessage(JSON.stringify(value));
  check('1 vault.measure y vault.reveal sin campos',
    same(client({ type: 'vault.measure', extra: 1 }), { type: 'vault.measure' }) && same(client({ type: 'vault.reveal' }), { type: 'vault.reveal' }));
  check('1 vault.enable exige un booleano',
    same(client({ type: 'vault.enable', enabled: false }), { type: 'vault.enable', enabled: false }) && client({ type: 'vault.enable', enabled: 'true' }) === null);
  check('1 vault.setDir lleva un selector y ninguna ruta',
    same(client({ type: 'vault.setDir', pickerId: 'p1', dir: 'C:\\otra' }), { type: 'vault.setDir', pickerId: 'p1' }) && client({ type: 'vault.setDir' }) === null);
  check('1 vault.exportProject exige la clave', client({ type: 'vault.exportProject', projectKey: '' }) === null &&
    same(client({ type: 'vault.exportProject', projectKey: 'c:\\p' }), { type: 'vault.exportProject', projectKey: 'c:\\p' }));
  check('1 vault.openSession con id importado',
    same(client({ type: 'vault.openSession', agent: 'antigravity-ide', sessionId: UUID }), { type: 'vault.openSession', agent: 'antigravity-ide', sessionId: UUID }));
  for (const bad of ['../x', 'a/b', 'C:x']) {
    check(`1 vault.openSession con sessionId ${show(bad)} -> null`, client({ type: 'vault.openSession', agent: 'claude-code', sessionId: bad }) === null);
  }
  check('1 vault.openSession con agent desconocido -> null', client({ type: 'vault.openSession', agent: 'nope', sessionId: UUID }) === null);

  const statusMessage = { type: 'vault.status', status: status() };
  check('1 vault.status ida y vuelta', same(parseServerMessage(encodeServerMessage(statusMessage)), statusMessage));
  check('1 vault.status con estado roto -> null', parseServerMessage(JSON.stringify({ type: 'vault.status', status: status({ state: 'x' }) })) === null);
  check('1 vault.exported ida y vuelta',
    same(parseServerMessage(JSON.stringify({ type: 'vault.exported', projectKey: 'k', sessions: 3 })), { type: 'vault.exported', projectKey: 'k', sessions: 3 }));
  const error = parseServerMessage(JSON.stringify({ type: 'error', code: 'vault-failed', text: { key: 'vaultMeasureFirst' } }));
  check('1 un error vault-failed conserva su codigo', error?.code === 'vault-failed' && es(error.text) === 'Mide primero cuánto ocuparía.', show(error));
}

// --- 1g. El indice completa storage y partial ---
{
  const { AgentRegistry } = await import('../src/agents/registry.ts');
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { sessionFilePath } = await import('../src/agents/claude-code/paths.ts');
  const { SessionIndex } = await import('../src/session-index.ts');

  const projectCwd = path.join(root, 'proyectos', 'demo-indice');
  await mkdir(projectCwd, { recursive: true });
  const file = sessionFilePath(projectCwd, UUID);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({
    type: 'user', uuid: 'u1', timestamp: new Date().toISOString(), cwd: projectCwd,
    message: { role: 'user', content: 'Probemos la conexion del proyecto de prueba' },
  }) + '\n');

  const sessionsOf = (index) => index.getProjects().flatMap((project) => project.sessions);
  const adapters = [];
  for (const phase of ['en frio', 'desde la cache']) {
    const adapter = createClaudeCodeAdapter();
    adapters.push(adapter);
    const index = new SessionIndex(new AgentRegistry([adapter]));
    await index.start();
    const ready = await waitFor(() => index.getStatus().state === 'ready');
    const sessions = sessionsOf(index);
    check(`1 indice ${phase}: la sesion nativa sale con storage native y partial false`,
      ready && sessions.length === 1 && sessions[0].storage === 'native' && sessions[0].partial === false, show(sessions));
    // Lo que emite el indice pasa por el parser del cliente sin perder nada.
    const parsed = shared.parseSessionSummary(JSON.parse(JSON.stringify(sessions[0] ?? null)));
    check(`1 indice ${phase}: el resumen emitido vuelve igual por el parser`, sameShape(parsed, sessions[0]), show(parsed));
  }
  for (const adapter of adapters) adapter.dispose?.();
}

// --- 1h. La web: insignia, etiqueta, reanudar y archivar historial ---
{
  const ui = await import('../../web/src/agent-ui.ts');
  const history = await import('../../web/src/archive-history.ts');
  const agentInfo = (id, label, available) => ({
    id, label, command: id, available, version: available ? `${label} 1.0` : null, installUrl: 'https://example.com',
    missingMessage: available ? null : { key: 'raw', params: { text: 'falta' } }, capabilities: shared.NO_CAPABILITIES, environmentNotice: null,
  });
  const onlyClaude = [agentInfo('claude-code', 'Claude Code', true), agentInfo('codex', 'Codex', false)];
  const both = [agentInfo('claude-code', 'Claude Code', true), agentInfo('codex', 'Codex', true)];
  const none = [agentInfo('claude-code', 'Claude Code', false)];

  check('1 sessionAgentView de una importada con una sola CLI: insignia y sin aviso',
    same(ui.sessionAgentView('gemini-cli', onlyClaude, false), { badge: true, unavailableTitle: null }),
    show(ui.sessionAgentView('gemini-cli', onlyClaude, false)));
  check('1 sessionAgentView de una importada sin ninguna CLI instalada: igual',
    same(ui.sessionAgentView('antigravity-ide', none, false), { badge: true, unavailableTitle: null }));
  check('1 sessionAgentView de una CLI no cambia',
    same(ui.sessionAgentView('claude-code', onlyClaude, false), { badge: false, unavailableTitle: null }) &&
    same(ui.sessionAgentView('codex', onlyClaude, false), { badge: true, unavailableTitle: 'La CLI Codex no está instalada.' }));

  check('1 etiqueta de una importada: la de shared, sin hello',
    ui.sessionAgentLabel('antigravity-ide', []) === 'Antigravity IDE' && ui.sessionAgentLabel('gemini-cli', both) === 'Gemini CLI');
  check('1 etiqueta de una CLI: la que anuncia el servidor, o el id',
    ui.sessionAgentLabel('codex', both) === 'Codex' && ui.sessionAgentLabel('opencode', both) === 'opencode');
  check('1 dos letras: importadas y CLIs',
    ui.agentShortLabel('gemini-cli') === 'GC' && ui.agentShortLabel('antigravity-ide') === 'AI' && ui.agentShortLabel('claude-code') === 'CC');
  const shorts = [...shared.AGENT_IDS, ...shared.IMPORTED_AGENT_IDS].map((id) => ui.agentShortLabel(id));
  check('1 las dos letras no se repiten entre CLIs e importadas', new Set(shorts).size === shorts.length, show(shorts));

  const row = (agent, storage, updatedAt = 1) => ({ agent, storage, updatedAt });
  check('1 resumableSession: nativa de una CLI si; importada no; copia de una CLI no',
    ui.resumableSession(row('codex', 'native')) && !ui.resumableSession(row('gemini-cli', 'vault')) &&
    !ui.resumableSession(row('claude-code', 'vault')));
  check('1 latestSessionAgent ignora una importada mas reciente',
    ui.latestSessionAgent([row('codex', 'native', 5), row('antigravity-ide', 'vault', 9)]) === 'codex');
  check('1 latestSessionAgent con solo importadas -> null', ui.latestSessionAgent([row('gemini-cli', 'vault', 9)]) === null);
  check('1 projectAgent de un proyecto con una importada al final abre con la CLI de la nativa',
    ui.projectAgent([], { cwd: 'C:\\p', sessions: [row('codex', 'native', 5), row('gemini-cli', 'vault', 9)] }, 'win32', both, 'claude-code') === 'codex');

  const summary = (sessionId, agent, updatedAt) => ({
    agent, sessionId, cwd: '', title: sessionId, titleSource: 'first-message', updatedAt, sizeBytes: 1,
    archived: false, storage: shared.isAgentId(agent) ? 'native' : 'vault', partial: false,
  });
  const projects = [{
    key: 'p', fallbackName: '', cwd: 'p', cwdExists: true, lastActivityAt: 3,
    sessions: [summary('gem', 'gemini-cli', 1), summary('cc', 'claude-code', 2), summary('ag', 'antigravity-ide', 3)],
  }];
  check('1 archivar historial de una importada: sus ids',
    same(history.sessionsToArchiveBefore(projects, 'gemini-cli', 10, new Set()), ['gem']));
  check('1 las importadas van despues de las CLIs del hello, en orden de aparicion',
    same(history.archiveCandidatesByAgent(projects, 10, new Set(), ['claude-code', 'codex']),
      [{ agent: 'claude-code', count: 1 }, { agent: 'gemini-cli', count: 1 }, { agent: 'antigravity-ide', count: 1 }]),
    show(history.archiveCandidatesByAgent(projects, 10, new Set(), ['claude-code', 'codex'])));
}

// --- 1i. La web de la copia: lo que dice la barra y el dialogo ---
{
  const vui = await import('../../web/src/vault-ui.ts');
  const fmt = await import('../../web/src/i18n/format.ts');
  const { parseVaultStatus, parseVaultMeasurement, NO_CAPABILITIES } = shared;
  const status = (overrides = {}) => ({
    enabled: false, dir: 'C:\\copia de prueba', isDefaultDir: true, state: 'off', progress: null, sessions: 0, passSessions: 0,
    bytes: 0, lastPassAt: null, pending: 0, measurement: null, previousDir: null, lastError: null, ...overrides,
  });
  const MB = 1024 * 1024;
  const measurement = {
    measuredAt: Date.now() - 2 * 60_000 - 500,
    durationMs: 12_400,
    byAgent: [
      { agent: 'claude-code', sessions: 3, eventBytes: 2 * MB, images: 2, imageBytes: 512 * 1024, skippedArchived: 4,
        skippedEmpty: 1, unsupported: 0, failed: 2, failureReasons: [{ key: 'vaultReasonOriginMissing' }] },
      { agent: 'antigravity', sessions: 1, eventBytes: 2048, images: 0, imageBytes: 0, skippedArchived: 0,
        skippedEmpty: 0, unsupported: 5, failed: 0, failureReasons: [] },
      { agent: 'gemini-cli', sessions: 2, eventBytes: 100, images: 0, imageBytes: 0, skippedArchived: 0,
        skippedEmpty: 0, unsupported: 0, failed: 0, failureReasons: [] },
    ],
    memoryProjects: 1,
    memoryBytes: 3000,
  };
  check('1 textos: los estados y la medicion de prueba pasan por el parser del cliente',
    parseVaultStatus(status({ enabled: true, state: 'writing', progress: { done: 1, total: 2 }, measurement })) !== null &&
    parseVaultMeasurement(measurement)?.byAgent.length === 3);

  check('1 textos: apagada no hay linea en la barra, tampoco midiendo (C9)',
    vui.vaultLineText(null) === null && vui.vaultLineText(status()) === null &&
    vui.vaultLineText(status({ state: 'measuring', progress: { done: 1, total: 4 }, measurement })) === null);
  check('1 textos: encendida sin ninguna pasada',
    vui.vaultLineText(status({ enabled: true, state: 'idle' })) === 'Copia propia · 0 sesiones · sin copiar todavía',
    show(vui.vaultLineText(status({ enabled: true, state: 'idle' }))));
  const withPass = status({ enabled: true, state: 'idle', sessions: 1, lastPassAt: Date.now() - 5 * 60_000 - 1000, pending: 3 });
  check('1 textos: encendida con pasada y sesiones esperando la calma',
    vui.vaultLineText(withPass) === 'Copia propia · 1 sesión · hace 5 min · 3 esperando', show(vui.vaultLineText(withPass)));
  check('1 textos: copiando con progreso, y mudando',
    vui.vaultLineText(status({ enabled: true, state: 'writing', sessions: 12, progress: { done: 4, total: 10 } })) ===
      'Copia propia · 12 sesiones · copiando 4 / 10' &&
    vui.vaultLineText(status({ enabled: true, state: 'moving', sessions: 2 })) === 'Copia propia · 2 sesiones · mudando de carpeta');

  check('1 textos: boton de la cabecera',
    vui.vaultButtonTitle(null) === 'Copia propia' &&
    vui.vaultButtonTitle(status()) === 'Copia propia: apagada. Configurar' &&
    vui.vaultButtonTitle(status({ enabled: true, state: 'idle' })) === 'Copia propia: encendida. Ver el estado y la carpeta');
  check('1 textos: estado del dialogo',
    vui.vaultStateText(status()) === 'Apagada' &&
    vui.vaultStateText(status({ enabled: true, state: 'idle' })) === 'Encendida' &&
    vui.vaultStateText(status({ state: 'measuring', progress: { done: 3, total: 9 } })) === 'Midiendo… 3 / 9' &&
    vui.vaultStateText(status({ enabled: true, state: 'writing' })) === 'Copiando…' &&
    vui.vaultStateText(status({ enabled: true, state: 'moving' })) === 'Mudando de carpeta…');

  const offer = (overrides) => vui.vaultActivateOffer(status(overrides));
  check('1 textos: "Activar" solo con medicion, o con sesiones que ya copio una pasada en la carpeta (D6, C18)',
    offer({}) === 'needs-measure' && offer({ measurement }) === 'measured' && offer({ sessions: 3, passSessions: 1 }) === 'existing' &&
    offer({ enabled: true, state: 'idle', measurement }) === 'enabled' && offer({ state: 'measuring', measurement }) === 'busy' &&
    offer({ state: 'moving', sessions: 3, passSessions: 3 }) === 'busy',
    show([offer({}), offer({ measurement }), offer({ sessions: 3, passSessions: 1 }), offer({ state: 'measuring', measurement })]));
  check('1 textos: una carpeta con solo sesiones importadas pide medir antes de "Activar" (R28-2)',
    offer({ sessions: 4, passSessions: 0 }) === 'needs-measure', show(offer({ sessions: 4, passSessions: 0 })));
  check('1 textos: "Medir" se bloquea con algo en curso o con el indice leyendo',
    vui.vaultMeasureBlockedReason(status(), true) === null &&
    vui.vaultMeasureBlockedReason(status(), false) === 'Todavía se está leyendo el historial. Mide cuando termine.' &&
    vui.vaultMeasureBlockedReason(status({ enabled: true, state: 'writing' }), true) !== null &&
    vui.vaultChangeDirBlockedReason(status({ enabled: true, state: 'idle' })) === null &&
    vui.vaultChangeDirBlockedReason(status({ state: 'moving' })) !== null);

  const agents = [
    { id: 'claude-code', label: 'Claude Code', command: 'claude', available: true, version: '1', installUrl: 'https://example.com',
      missingMessage: null, capabilities: NO_CAPABILITIES, environmentNotice: null },
    { id: 'antigravity', label: 'Antigravity CLI', command: 'agy', available: true, version: '1', installUrl: 'https://example.com',
      missingMessage: null, capabilities: NO_CAPABILITIES, environmentNotice: null },
  ];
  const view = vui.vaultMeasureView(measurement, agents);
  check('1 textos: tabla con los nombres del hello y de las importadas, en el orden del servidor',
    same(view.rows.map((row) => row.label), ['Claude Code', 'Antigravity CLI', 'Gemini CLI']), show(view.rows.map((row) => row.label)));
  check('1 textos: tamano por CLI = texto + imagenes; el total suma la memoria',
    view.rows[0]?.bytes === 2 * MB + 512 * 1024 &&
    same(view.total, { sessions: 6, bytes: 2 * MB + 512 * 1024 + 2048 + 100 + 3000, images: 2, skippedArchived: 4 }),
    show(view.total));
  check('1 textos: lo que no se copia dice por que',
    view.rows[0]?.note === 'No se copian: 1 vacía · 2 fallidas (no se encontró el origen)' &&
    view.rows[1]?.note === 'No se copian: 5 sin lectura completa' && view.rows[2]?.note === null,
    show(view.rows.map((row) => row.note)));
  check('1 textos: cuando y cuanto tardo la medicion', view.summary === 'Medido hace 2 min, en 12 s', show(view.summary));
  check('1 textos: tamanos y duraciones',
    fmt.formatBytes(0) === '0 B' && fmt.formatBytes(1023) === '1023 B' && fmt.formatBytes(1536) === '2 KB' &&
    fmt.formatBytes(5 * MB) === '5.0 MB' && fmt.formatBytes(3 * 1024 * MB) === '3.00 GB' &&
    fmt.formatRoughDuration(400) === 'menos de 1 s' && fmt.formatRoughDuration(185_000) === '3 min 5 s' &&
    fmt.formatRoughDuration(120_000) === '2 min');

  check('1 textos: una fila nativa no lleva marcas, ni con partial en true',
    same(vui.sessionVaultView({ storage: 'native', partial: true }), { copy: false, partial: false }));
  check('1 textos: una fila de la copia lleva "copia", y "parcial" solo si lo es',
    same(vui.sessionVaultView({ storage: 'vault', partial: false }), { copy: true, partial: false }) &&
    same(vui.sessionVaultView({ storage: 'vault', partial: true }), { copy: true, partial: true }));
  check('1 textos: las marcas dicen lo de la especificacion',
    vui.vaultMarkText() === 'copia' && vui.partialMarkText() === 'parcial' &&
    vui.vaultMarkTitle() === 'El historial de la CLI ya no tiene esta sesión. Se abre la copia propia, en Markdown.' &&
    vui.partialMarkTitle() === 'Sólo se rescató la ficha y los documentos: el contenido de la conversación está cifrado.');
  check('1 textos: el aviso de privacidad dice que viaja con la carpeta',
    vui.vaultPrivacyText().startsWith('Guarda lo mismo que el historial de cada CLI') &&
    vui.vaultPrivacyText().includes('eso viaja con ella') && vui.vaultArchivedText().includes('archivadas no se copian'));
  check('1 textos: exportar tiene tres titulos distintos y la carpeta anterior se nombra',
    new Set(['idle', 'exporting', 'done'].map((state) => vui.exportButtonTitle(state))).size === 3 &&
    vui.vaultPreviousDirText('D:\\vieja') === 'La carpeta anterior quedó intacta: D:\\vieja');

  /*
    Lo que un chequeo de funciones puras no ve: que la barra use esas funciones
    para decidir. Se mira el fuente, con expresiones exactas.
  */
  const webSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
  const sidebarSource = await readFile(path.join(webSrc, 'Sidebar.tsx'), 'utf8');
  const appSource = await readFile(path.join(webSrc, 'App.tsx'), 'utf8');
  const workspaceSource = await readFile(path.join(webSrc, 'useWorkspace.ts'), 'utf8');
  check('1 textos: la barra dibuja la linea solo si vaultLineText no es null, sin la linea "Copia propia apagada" (C9)',
    /const vaultLine = vaultLineText\(vault\);/.test(sidebarSource) && /\{vaultLine !== null && \(/.test(sidebarSource) &&
    !/copia propia apagada/i.test(sidebarSource) && !/copia propia apagada/i.test(appSource));
  // Desde el hito 37 una fila "copia" tampoco se abre en una ventana remota
  // (`onOpenVaultSession` null): abriria su Markdown en el escritorio del anfitrion.
  check('1 textos: las marcas de la fila salen de sessionVaultView y una fila nativa sigue deshabilitada como antes',
    /const vaultView = sessionVaultView\(session\);/.test(sidebarSource) &&
    /const openable = vaultView\.copy \? onOpenVaultSession !== null : canOpen && resumable;/.test(sidebarSource) &&
    /disabled=\{!openable\}/.test(sidebarSource));
  const chooseAt = appSource.indexOf('vault.chooseDir(pickerId);');
  check('1 textos: la carpeta se manda con el selector abierto, antes de cerrarlo',
    chooseAt !== -1 && appSource.indexOf('setPickerFor(null);', chooseAt) > chooseAt &&
    appSource.slice(chooseAt, appSource.indexOf('setPickerFor(null);', chooseAt)).split('\n').length <= 4);
  check('1 textos: un vault-failed no se repite en el cartel general',
    /if \(message\.code === 'vault-failed'\) break;/.test(workspaceSource));

  /*
    R28-4: con la copia apagada, "Exportar a Markdown" escondido no puede
    reservar su ancho en la fila del proyecto: cada nombre se cortaba unos 30 px
    antes que en el hito 27. Sin un navegador, se hace la cuenta con el CSS: el
    margen negativo tiene que descontar el ancho de los botones y el hueco de la
    fila, y escondidos no pueden tapar los clics del contador. Medido ademas en
    Chrome: el nombre mide lo mismo con el boton y sin el.

    Desde el hito 31 los botones ocultos son **dos** —exportar y archivar el
    proyecto— y el margen vive una sola vez en el grupo: con uno por boton, el
    segundo caia encima del primero. La cuenta cuenta los botones del fuente, asi
    que un tercero sin ajustar el margen falla aca en vez de pasar callado.
  */
  const stylesSource = (await readFile(path.join(webSrc, 'styles.css'), 'utf8')).replace(/\r\n/g, '\n');
  const blockOf = (selectorLine) => {
    const start = stylesSource.indexOf(`\n${selectorLine} {\n`);
    return start === -1 ? null : stylesSource.slice(start, stylesSource.indexOf('}', start));
  };
  const pxOf = (block, property) => {
    const match = block?.match(new RegExp(`\\n\\s*${property}:\\s*(-?\\d+(?:\\.\\d+)?)px;`));
    return match === null || match === undefined ? null : Number(match[1]);
  };
  const actionBlock = blockOf('.project-action');
  const groupBlock = blockOf('.project-actions');
  const shownBlock = blockOf('.project-row:hover .project-action,\n.project-action:focus-visible,\n.project-action-busy');
  const rowGap = pxOf(blockOf('.project-row'), 'gap');
  const actionWidth = pxOf(actionBlock, 'width');
  const groupGap = pxOf(groupBlock, 'gap');
  const groupMargin = pxOf(groupBlock, 'margin-left');
  // Cuantos botones ocultos tiene la fila, contados del JSX.
  const buttons = (sidebarSource.match(/className=\{`icon-button project-action\$\{/g) ?? []).length;
  const groupWidth =
    actionWidth === null || groupGap === null ? null : buttons * actionWidth + (buttons - 1) * groupGap;
  check('1 estilos: los dos botones ocultos no ocupan ancho en la fila del proyecto ni reciben clics; a la vista, si (C9, R28-4, hito 31)',
    rowGap !== null && actionWidth !== null && groupMargin !== null && groupWidth !== null &&
    buttons === 2 && groupWidth + rowGap + groupMargin === 0 &&
    (pxOf(actionBlock, 'min-width') ?? 0) <= actionWidth && /\n\s*pointer-events: none;/.test(actionBlock ?? '') &&
    /\n\s*opacity: 1;/.test(shownBlock ?? '') && /\n\s*pointer-events: auto;/.test(shownBlock ?? ''),
    show({ rowGap, actionWidth, buttons, groupGap, groupWidth, groupMargin, actionBlock, groupBlock, shownBlock }));
}

// ---------------------------------------------------------------------------
// 2. Topes por sesion: FollowOptions en los cuatro adaptadores
// ---------------------------------------------------------------------------

/** Los topes con los que lee la copia: texto y entrada sin recortar, resultado a 64 000. */
const VAULT_LIMITS = Object.freeze({ textMaxChars: Infinity, toolInputMaxChars: Infinity, toolResultMaxChars: 64_000 });
const WHOLE = Object.freeze({ limits: VAULT_LIMITS, maxEvents: Number.POSITIVE_INFINITY });

/** Un texto inventado de `length` caracteres exactos, que no empieza ni termina en blanco. */
const inventedText = (length, seed) => `${seed} ${'Probemos la conexion del proyecto de prueba '.repeat(Math.ceil(length / 40))}`.slice(0, length - 1) + '.';
const BIG_TEXT = inventedText(20_000, 'Texto');
const BIG_INPUT = inventedText(20_000, 'Entrada');
const BIG_RESULT = inventedText(300_000, 'Resultado');
/** Una entrada larga para el hilo (2 000) pero que OpenCode todavia indenta (16 000). */
const MID_INPUT = inventedText(10_000, 'Entrada media');

/**
 * Sigue una sesion por `history.follow` hasta que esta viva y una lectura no
 * trae nada, con tope de lecturas. Devuelve la cola entera.
 */
async function followWhole(adapter, target, options) {
  const follower = options === undefined ? adapter.history.follow(target) : adapter.history.follow(target, options);
  await follower.start();
  for (let round = 0; round < 5; round += 1) {
    const result = await follower.poll();
    if (follower.getState() === 'live' && result.added.length === 0 && !result.reset && round > 0) break;
  }
  return { state: follower.getState(), page: follower.getTail(Number.MAX_SAFE_INTEGER) };
}

/** Lo que importa de una lectura: el texto, la entrada y el resultado mas largos, con su marca. */
function measureParts(events) {
  const parts = events.flatMap((event) => event.parts);
  const longest = (kind, field) =>
    parts.filter((part) => part.kind === kind).sort((a, b) => b[field].length - a[field].length)[0] ?? null;
  const text = longest('text', 'text');
  const input = longest('tool-call', 'input');
  const result = longest('tool-result', 'text');
  return {
    text: text === null ? null : [text.text.length, text.truncated],
    textWhole: text !== null && text.text === BIG_TEXT,
    input: input === null ? null : [input.input.length, input.truncated],
    inputWhole: input !== null && input.input.includes(BIG_INPUT),
    result: result === null ? null : [result.text.length, result.truncated],
  };
}

/** Las dos lecturas de un fixture con topes: la del hilo y la de la copia. */
async function checkLimits(label, adapter, target) {
  const plain = await followWhole(adapter, target);
  const whole = await followWhole(adapter, target, WHOLE);
  const before = measureParts(plain.page.events);
  const after = measureParts(whole.page.events);
  check(`2 ${label}: sin opciones, como siempre (8 000, 2 000 y 4 000, recortados)`,
    plain.state === 'live' && same(before.text, [8000, true]) && same(before.input, [2000, true]) && same(before.result, [4000, true]),
    show(before));
  check(`2 ${label}: con los topes de la copia, el texto de 20 000 y la entrada enteros, el resultado a 64 000 recortado`,
    whole.state === 'live' && same(after.text, [20_000, false]) && after.textWhole && after.input?.[1] === false && after.inputWhole &&
    same(after.result, [64_000, true]), show(after));
}

/** 4 100 eventos: sin opciones pagina (4 000 y hay mas); con `maxEvents` infinito, todo y sin mas. */
async function checkNoPaging(label, adapter, target) {
  const plain = await followWhole(adapter, target);
  const whole = await followWhole(adapter, target, WHOLE);
  check(`2 ${label}: 4 100 eventos sin opciones -> la cola tiene 4 000 y hasMore`,
    plain.page.events.length === 4000 && plain.page.hasMore === true, `${plain.page.events.length} ${plain.page.hasMore}`);
  check(`2 ${label}: con maxEvents infinito, getTail trae los 4 100 y no pagina`,
    whole.page.events.length === 4100 && whole.page.hasMore === false, `${whole.page.events.length} ${whole.page.hasMore}`);
}

// --- 2a. transport-limits y el SQL de OpenCode ---
{
  const limits = await import('../src/agents/transport-limits.ts');
  const { OPENCODE_SQL, partCutParams } = await import('../src/agents/opencode/sql.ts');
  check('2 TRANSPORT_LIMITS son los de siempre',
    same(limits.TRANSPORT_LIMITS, { textMaxChars: 8000, toolInputMaxChars: 2000, toolResultMaxChars: 4000 }) && Object.isFrozen(limits.TRANSPORT_LIMITS),
    show(limits.TRANSPORT_LIMITS));
  check('2 sqlCutLength: finito -> tope + 1; infinito -> el maximo de 32 bits',
    limits.sqlCutLength(8000) === 8001 && limits.sqlCutLength(64_000) === 64_001 &&
    limits.sqlCutLength(Infinity) === 2_147_483_647 && limits.sqlCutLength(Number.NaN) === 2_147_483_647);
  check('2 partCutParams del hilo: los numeros que tenia la sentencia (8001, 16001, 4001)',
    same(partCutParams(limits.TRANSPORT_LIMITS), { $textCut: 8001, $inputCut: 16_001, $outputCut: 4001 }), show(partCutParams(limits.TRANSPORT_LIMITS)));
  check('2 partCutParams de la copia: texto y entrada sin corte, resultado a 64 001',
    same(partCutParams(VAULT_LIMITS), { $textCut: 2_147_483_647, $inputCut: 2_147_483_647, $outputCut: 64_001 }), show(partCutParams(VAULT_LIMITS)));
  const partStatements = [OPENCODE_SQL.partsForMessages, OPENCODE_SQL.partsSince];
  check('2 las dos sentencias de partes: enteras con nombre, sin ? y sin cortes fijos',
    partStatements.every((sql) => !sql.includes('?') && ['$textCut', '$inputCut', '$outputCut'].every((name) => sql.includes(name)) && !/\b(8001|16001|4001)\b/.test(sql)) &&
    OPENCODE_SQL.partsForMessages.includes('$ids') && OPENCODE_SQL.partsSince.includes('$s') && OPENCODE_SQL.partsSince.includes('$since'));
}

// --- 2b. Claude Code ---
{
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { sessionFilePath } = await import('../src/agents/claude-code/paths.ts');
  const adapter = createClaudeCodeAdapter();
  const cwd = path.join(root, 'proyectos', 'demo-topes-claude');
  await mkdir(cwd, { recursive: true });
  const at = new Date(Date.UTC(2026, 8, 14, 10, 0, 0)).toISOString();
  const line = (record) => `${JSON.stringify({ timestamp: at, cwd, ...record })}\n`;

  const id = '1a2b3c4d-0000-4000-8000-000000000001';
  const file = sessionFilePath(cwd, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file,
    line({ type: 'user', uuid: 'cc-u1', message: { role: 'user', content: BIG_TEXT } }) +
    line({ type: 'assistant', uuid: 'cc-a1', message: { role: 'assistant', model: 'modelo-de-prueba', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: 'notas.md', content: BIG_INPUT } },
    ] } }) +
    line({ type: 'user', uuid: 'cc-u2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: BIG_RESULT }] } }));
  check('2 claude-code declara wholeRead', adapter.history.wholeRead === true);
  await checkLimits('claude-code', adapter, { cwd, sessionId: id });

  const manyId = '1a2b3c4d-0000-4000-8000-000000000002';
  const manyFile = sessionFilePath(cwd, manyId);
  let many = '';
  for (let n = 0; n < 4100; n += 1) many += line({ type: 'user', uuid: `cc-m${n}`, message: { role: 'user', content: `Mensaje de prueba ${n}` } });
  await writeFile(manyFile, many);
  await checkNoPaging('claude-code', adapter, { cwd, sessionId: manyId });
  adapter.dispose();
}

// --- 2c. Codex ---
{
  const { createCodexAdapter } = await import('../src/agents/codex/index.ts');
  const codexPaths = await import('../src/agents/codex/paths.ts');
  const adapter = createCodexAdapter();
  const cwd = path.join(root, 'proyectos', 'demo-topes-codex');
  const pad2 = (n) => String(n).padStart(2, '0');
  const at = new Date(Date.UTC(2026, 8, 14, 10, 0, 0)).toISOString();
  const rec = (type, payload) => `${JSON.stringify({ timestamp: at, type, payload })}\n`;
  /** Escribe el rollout donde lo busca Codex: la carpeta del dia local del uuid v7. */
  const writeRollout = async (id, content) => {
    const ms = codexPaths.uuidV7Millis(id);
    const folder = codexPaths.localDayFolder(codexPaths.codexSessionsRoot(), ms);
    const d = new Date(ms);
    const name = `rollout-${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}-${pad2(d.getMinutes())}-${pad2(d.getSeconds())}-${id}.jsonl`;
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, name), content);
  };
  const meta = (id) => rec('session_meta', { id, timestamp: at, cwd, originator: 'codex-tui', cli_version: '0.154.0', source: 'cli' });

  const id = '019e0000-0000-7000-8000-000000000281';
  await writeRollout(id,
    meta(id) +
    rec('event_msg', { type: 'user_message', message: BIG_TEXT, images: [], local_images: [], text_elements: [] }) +
    rec('response_item', { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ path: 'notas.md', content: BIG_INPUT }), call_id: 'call_1' }) +
    rec('response_item', { type: 'function_call_output', call_id: 'call_1', output: BIG_RESULT }));
  check('2 codex declara wholeRead', adapter.history.wholeRead === true);
  await checkLimits('codex', adapter, { cwd, sessionId: id });

  const manyId = '019e0000-0000-7000-8000-000000000282';
  let many = meta(manyId);
  for (let n = 0; n < 4100; n += 1) {
    many += rec('event_msg', { type: 'user_message', message: `Mensaje de prueba ${n}`, images: [], local_images: [], text_elements: [] });
  }
  await writeRollout(manyId, many);
  await checkNoPaging('codex', adapter, { cwd, sessionId: manyId });
  adapter.dispose();
}

// --- 2d. OpenCode ---
{
  const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
  const { createOpenCodeHistory } = await import('../src/agents/opencode/history.ts');
  const { resolveOpenCodePaths } = await import('../src/agents/opencode/paths.ts');
  const { loadSqlite } = await import('../src/agents/sqlite.ts');
  const fixture = await import('./fixtures/opencode-db.mjs');
  const { dbFile } = resolveOpenCodePaths(process.env, os.homedir(), process.platform);

  const quietly = async (run) => {
    const original = console.warn;
    console.warn = () => undefined;
    try {
      return await run();
    } finally {
      console.warn = original;
    }
  };
  const history = (db, file) => createOpenCodeHistory({
    dbFile: file, db, signal: { subscribe: () => () => undefined }, catalog: { contextWindow: async () => null },
    platform: process.platform, sqlite: loadSqlite,
  });
  const busyDb = { status: () => 'error', all: () => { throw new Error('database is locked'); }, get: () => { throw new Error('database is locked'); } };
  check('2 opencode rootExists sin archivo configurado: false', (await history(busyDb, null).rootExists()) === false);
  check('2 opencode rootExists con la base que todavia no existe: false', (await history(busyDb, dbFile).rootExists()) === false);

  const assistant = (created) => ({
    parentID: 'msg_v01', role: 'assistant', mode: 'build', agent: 'build', providerID: 'openai', modelID: 'modelo-de-prueba',
    time: { created, completed: created + 50 }, finish: 'stop', cost: 0,
    tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const sessions = [
    fixture.sessionRow({ id: 'ses_v_topes', directory: 'D:/Prueba', title: 'Probemos los topes', time_created: 1000, time_updated: 1100 }),
    fixture.sessionRow({ id: 'ses_v_muchos', directory: 'D:/Prueba', title: 'Probemos muchos pasos', time_created: 2000, time_updated: 2100 }),
    // Para la ida y vuelta del caso 3: una entrada que el hilo tambien puede indentar (menos de 16 000).
    fixture.sessionRow({ id: 'ses_v_ida', directory: 'D:/Prueba', title: 'Probemos la ida y vuelta', time_created: 3000, time_updated: 3100 }),
  ];
  const user = fixture.messageRow('ses_v_topes', 'msg_v01', 1000, { role: 'user', time: { created: 1000 }, agent: 'build' });
  const step = fixture.messageRow('ses_v_topes', 'msg_v02', 1010, assistant(1010), 1060);
  const manyStep = fixture.messageRow('ses_v_muchos', 'msg_v10', 2010, assistant(2010), 2060);
  const parts = [
    fixture.partRow(user, 'prt_v01a', 1001, { type: 'text', text: 'Probemos la conexion' }),
    fixture.partRow(step, 'prt_v02a', 1011, { type: 'text', text: BIG_TEXT }),
    fixture.partRow(step, 'prt_v02b', 1012, {
      type: 'tool', tool: 'write', callID: 'call_v02b',
      state: { status: 'completed', input: { filePath: 'notas.md', content: BIG_INPUT }, output: BIG_RESULT, metadata: {}, time: { start: 1012, end: 1020 } },
    }),
  ];
  for (let n = 0; n < 4100; n += 1) {
    parts.push(fixture.partRow(manyStep, `prt_v10_${String(n).padStart(5, '0')}`, 2011 + n, { type: 'text', text: `Paso de prueba ${n}` }));
  }
  const tripUser = fixture.messageRow('ses_v_ida', 'msg_v20', 3000, { role: 'user', time: { created: 3000 }, agent: 'build' });
  const tripStep = fixture.messageRow('ses_v_ida', 'msg_v21', 3010, { ...assistant(3010), parentID: 'msg_v20' }, 3060);
  parts.push(
    fixture.partRow(tripUser, 'prt_v20a', 3001, { type: 'text', text: 'Probemos la ida y vuelta' }),
    fixture.partRow(tripStep, 'prt_v21a', 3011, { type: 'text', text: BIG_TEXT }),
    fixture.partRow(tripStep, 'prt_v21b', 3012, {
      type: 'tool', tool: 'write', callID: 'call_v21b',
      state: { status: 'completed', input: { filePath: 'notas.md', content: MID_INPUT }, output: BIG_RESULT, metadata: {}, time: { start: 3012, end: 3020 } },
    }),
  );
  const base = await fixture.createOpenCodeFixture(path.dirname(dbFile), {
    sessions, messages: [user, step, manyStep, tripUser, tripStep], parts, fileName: path.basename(dbFile),
  });

  check('2 opencode rootExists con la base en su sitio: true', (await history(busyDb, dbFile).rootExists()) === true);
  const busyList = await quietly(() => history(busyDb, dbFile).list());
  check('2 opencode con la base ocupada: list da null pero rootExists true (no es "sin historial")',
    busyList === null && (await history(busyDb, dbFile).rootExists()) === true);

  const adapter = createOpenCodeAdapter();
  check('2 opencode declara wholeRead y rootExists', adapter.history.wholeRead === true && typeof adapter.history.rootExists === 'function');
  check('2 opencode list lee la base de prueba', (await adapter.history.list())?.length === 3);
  await checkLimits('opencode', adapter, { cwd: 'D:\\Prueba', sessionId: 'ses_v_topes' });
  await checkNoPaging('opencode', adapter, { cwd: 'D:\\Prueba', sessionId: 'ses_v_muchos' });
  adapter.dispose();
  base.close();
}

// --- 2e. Antigravity CLI ---
{
  const { createAntigravityAdapter } = await import('../src/agents/antigravity/index.ts');
  const { transcriptPaths } = await import('../src/agents/antigravity/paths.ts');
  const adapter = createAntigravityAdapter({ settingsSignal: { subscribe: () => () => undefined, dispose: () => undefined } });
  check('2 antigravity declara wholeRead', adapter.history.wholeRead === true);
  check('2 antigravity rootExists sin la carpeta de conversaciones: false, y list null',
    (await adapter.history.rootExists()) === false && (await adapter.history.list()) === null);

  const at = new Date(Date.UTC(2026, 8, 14, 10, 0, 0)).toISOString();
  const step = (record) => `${JSON.stringify({ status: 'DONE', created_at: at, ...record })}\n`;
  const writeTranscript = async (id, content) => {
    const { full } = transcriptPaths(id);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  };

  const id = '2b3c4d5e-0000-4000-8000-000000000001';
  await writeTranscript(id,
    step({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>${BIG_TEXT}</USER_REQUEST>` }) +
    step({ step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', content: 'Escribo las notas.',
      tool_calls: [{ name: 'write_to_file', args: { TargetFile: 'notas.md', CodeContent: BIG_INPUT } }] }) +
    step({ step_index: 2, source: 'MODEL', type: 'CODE_ACTION', content: BIG_RESULT }));
  check('2 antigravity rootExists con la carpeta: true', (await adapter.history.rootExists()) === true);
  await checkLimits('antigravity', adapter, { cwd: '', sessionId: id });

  const manyId = '2b3c4d5e-0000-4000-8000-000000000002';
  let many = '';
  for (let n = 0; n < 4100; n += 1) {
    many += step({ step_index: n, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>Mensaje de prueba ${n}</USER_REQUEST>` });
  }
  await writeTranscript(manyId, many);
  await checkNoPaging('antigravity', adapter, { cwd: '', sessionId: manyId });
  adapter.dispose();
}

// ---------------------------------------------------------------------------
// 3 a 6. La copia en disco
// ---------------------------------------------------------------------------

const vaultPaths = await import('../src/vault/paths.ts');
const { assetName, imageKey, serializeSession } = await import('../src/vault/serialize.ts');
const { PagedHistoryError, UnsupportedHistoryError, readWholeSession } = await import('../src/vault/read-session.ts');
const vaultWrite = await import('../src/vault/write.ts');
const { VaultCatalog } = await import('../src/vault/catalog.ts');
const { TRANSPORT_LIMITS, limitEvent } = await import('../src/agents/transport-limits.ts');

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
/** Bytes con firma PNG y un contenido distinto por texto: alcanza para la firma y para el hash. */
const pngOf = (text) => Buffer.concat([PNG_SIGNATURE, Buffer.from(`imagen de prueba ${text}`)]);
const throws = (run) => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};
/** Los nombres de una carpeta, o [] si no existe. */
const namesIn = async (dir) => readdir(dir).catch(() => []);
const plain = (value) => JSON.parse(JSON.stringify(value));
const createHashHex = (bytes) => createHash('sha256').update(bytes).digest('hex');

const headerInput = (agent, sessionId, overrides = {}) => ({
  agent, sessionId, cwd: 'C:\\proyectos\\demo', title: 'Probemos la conexion del proyecto de prueba', titleSource: 'first-message',
  createdAt: null, updatedAt: 1_700_000_500_000, cliVersionAtCopy: null, partial: false, stepCount: null, usage: null,
  source: { kind: 'native', mtimeMs: 1_700_000_500_000, sizeBytes: 10, writerRevision: 1 }, writtenAt: 1_700_000_600_000,
  ...overrides,
});

/** Las imagenes de una sesion leida entera, como las va a leer el escritor. */
async function loadImages(whole) {
  const images = new Map();
  let reads = 0;
  for (const event of whole.events) {
    for (const part of event.parts) {
      if (part.kind !== 'image') continue;
      reads += 1;
      const loaded = await whole.readImage(event.eventId, part.index, part.source);
      if (loaded !== null) images.set(imageKey(event.eventId, part.source, part.index), { kind: 'loaded', data: Buffer.from(loaded.data, 'base64') });
    }
  }
  return { images, reads };
}

async function bodyOf(catalog, agent, sessionId) {
  const lines = [];
  for await (const line of catalog.readBody(agent, sessionId)) lines.push(line);
  return lines;
}

/** El primer evento donde dos listas difieren, para que un FALLO diga donde. */
function firstDifference(a, b) {
  const length = Math.max(a.length, b.length);
  for (let n = 0; n < length; n += 1) {
    if (!sameShape(a[n] ?? null, b[n] ?? null)) return `evento ${n}: ${show(a[n] ?? null).slice(0, 300)} / ${show(b[n] ?? null).slice(0, 300)}`;
  }
  return '';
}

// --- 3a. Rutas y nombres ---
{
  const { appConfigDir } = await import('../src/paths.ts');
  const { assetFile, defaultVaultDir, memoryDir, projectExportDir, projectFolderName, sanitizeFileName, sessionExportFile, sessionFile } = vaultPaths;
  const dir = path.join(root, 'copia-rutas');

  check('3 sanitizeFileName: CON, nul.txt y com1 llevan _ delante; CONSOLA no',
    sanitizeFileName('CON') === '_CON' && sanitizeFileName('nul.txt') === '_nul.txt' && sanitizeFileName('com1') === '_com1' &&
    sanitizeFileName('CONSOLA') === 'CONSOLA', show([sanitizeFileName('CON'), sanitizeFileName('nul.txt'), sanitizeFileName('com1')]));
  check('3 sanitizeFileName a:b*? -> a_b__', sanitizeFileName('a:b*?') === 'a_b__', sanitizeFileName('a:b*?'));
  check('3 sanitizeFileName: lo que parte cmd (& ^ % comillas) y los separadores pasan a _',
    sanitizeFileName('R&D ^100% "x"') === 'R_D _100_ _x_' && sanitizeFileName('a/b\\c') === 'a_b_c', sanitizeFileName('R&D ^100% "x"'));
  check('3 sanitizeFileName: 200 caracteres -> 80, o el tope pedido',
    sanitizeFileName('a'.repeat(200)).length === 80 && sanitizeFileName('b'.repeat(200), 20).length === 20);
  check('3 sanitizeFileName: acentos, eñes y otros alfabetos se conservan',
    sanitizeFileName('Café ñandú 日本') === 'Café ñandú 日本', sanitizeFileName('Café ñandú 日本'));
  check('3 sanitizeFileName: sin puntos ni espacios al final, y nunca vacio, . ni ..',
    sanitizeFileName('titulo. . ') === 'titulo' && sanitizeFileName('..') === '_' && sanitizeFileName('.') === '_' &&
    sanitizeFileName('') === '_' && sanitizeFileName('\u0000\u0007') === '__');

  check('3 sessionFile arma sessions/<agent>/<id>.jsonl y assets al lado',
    sessionFile(dir, 'codex', UUID) === path.join(dir, 'sessions', 'codex', `${UUID}.jsonl`) &&
    assetFile(dir, 'codex', UUID, `${'a'.repeat(32)}.png`) === path.join(dir, 'sessions', 'codex', `${UUID}.assets`, `${'a'.repeat(32)}.png`));
  for (const bad of ['../x', 'a/b', 'C:x', '.oculto', '']) {
    check(`3 un sessionId ${show(bad)} no se convierte en ruta`,
      throws(() => sessionFile(dir, 'codex', bad)) && throws(() => sessionExportFile(dir, 'codex', bad)));
  }
  check('3 una fuente desconocida no se convierte en ruta', throws(() => sessionFile(dir, '..', UUID)) && throws(() => sessionFile(dir, 'nope', UUID)));
  check('3 un asset que no es un hash no se convierte en ruta',
    throws(() => assetFile(dir, 'codex', UUID, '../x.png')) && throws(() => assetFile(dir, 'codex', UUID, `${'A'.repeat(32)}.png`)));

  const folder = projectFolderName('D:\\Proyectos\\R&D', 'win32');
  const hashOf = (name) => name.slice(-8);
  check('3 carpeta de proyecto: nombre saneado y 8 hex', /^R_D-[0-9a-f]{8}$/.test(folder), folder);
  check('3 carpeta de proyecto: la misma clave normalizada da el mismo hash',
    hashOf(projectFolderName('d:/proyectos/r&d/', 'win32')) === hashOf(folder));
  check('3 carpeta de proyecto: dos carpetas con el mismo nombre no se pisan',
    hashOf(projectFolderName('D:\\Otros\\R&D', 'win32')) !== hashOf(folder));
  check('3 carpeta de proyecto: la raiz de una unidad tiene nombre', projectFolderName('C:\\', 'win32').startsWith('proyecto-'));
  check('3 memoria, exportacion y la fila copia cuelgan de la carpeta de la copia',
    memoryDir(dir, 'D:\\Proyectos\\R&D', 'win32') === path.join(dir, 'memory', folder) &&
    projectExportDir(dir, 'D:\\Proyectos\\R&D', 'win32') === path.join(dir, 'export', folder) &&
    sessionExportFile(dir, 'gemini-cli', UUID) === path.join(dir, 'export', 'sesiones', `gemini-cli-${UUID}.md`));
  check('3 la carpeta por defecto es vault/ dentro de la de la app', defaultVaultDir() === path.join(appConfigDir(), 'vault'));
}

// --- 3b. Ida y vuelta por el seguidor de cada CLI ---
const vaultDir = path.join(root, 'copia');
{
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { createCodexAdapter } = await import('../src/agents/codex/index.ts');
  const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
  const { createAntigravityAdapter } = await import('../src/agents/antigravity/index.ts');

  // Los fixtures del caso 2, que siguen en el home temporal.
  const trips = [
    ['claude-code', createClaudeCodeAdapter(), { cwd: path.join(root, 'proyectos', 'demo-topes-claude'), sessionId: '1a2b3c4d-0000-4000-8000-000000000001' }],
    ['codex', createCodexAdapter(), { cwd: path.join(root, 'proyectos', 'demo-topes-codex'), sessionId: '019e0000-0000-7000-8000-000000000281' }],
    ['opencode', createOpenCodeAdapter(), { cwd: 'D:\\Prueba', sessionId: 'ses_v_ida' }],
    ['antigravity', createAntigravityAdapter({ settingsSignal: { subscribe: () => () => undefined, dispose: () => undefined } }),
      { cwd: '', sessionId: '2b3c4d5e-0000-4000-8000-000000000001' }],
  ];
  const catalog = new VaultCatalog();
  for (const [agent, adapter, target] of trips) {
    const normal = await followWhole(adapter, target);
    const whole = await readWholeSession(adapter.history, target, VAULT_LIMITS);
    check(`3 ${agent}: readWholeSession la lee viva, con los mismos eventos que el hilo`,
      whole?.state === 'live' && whole.events.length > 0 && whole.events.length === normal.page.events.length,
      `${whole?.state} ${whole?.events.length} / ${normal.page.events.length}`);
    if (whole === null) continue;

    const { images } = await loadImages(whole);
    const serialized = serializeSession({ header: headerInput(agent, target.sessionId, { cwd: target.cwd, usage: whole.usage }), events: whole.events, images });
    const written = await vaultWrite.writeSessionFile(vaultDir, serialized);
    check(`3 ${agent}: el archivo escrito es el texto serializado, byte a byte`,
      (await readFile(written.file, 'utf8')) === serialized.text && written.bytes === Buffer.byteLength(serialized.text));

    await catalog.load(vaultDir);
    const header = catalog.header(agent, target.sessionId);
    check(`3 ${agent}: el catalogo la lista con la cabecera escrita`,
      header !== null && sameShape(header, plain(serialized.header)) && header.eventCount === whole.events.length,
      show(header === null ? null : [header.agent, header.eventCount, header.imageCount]));

    const body = await bodyOf(catalog, agent, target.sessionId);
    const events = body.filter((line) => line.kind === 'event').map((line) => line.event);
    check(`3 ${agent}: el cuerpo trae los eventos tal como se leyeron`,
      body.length === whole.events.length && sameShape(events, plain(whole.events)), firstDifference(events, plain(whole.events)));
    check(`3 ${agent}: el texto de 20 000 esta entero en la copia`,
      events.some((event) => event.parts.some((part) => part.kind === 'text' && part.text === BIG_TEXT)));

    const recut = events.map((event) => limitEvent(event, TRANSPORT_LIMITS));
    const expected = plain(normal.page.events);
    check(`3 ${agent}: recortados otra vez con TRANSPORT_LIMITS, iguales a los del seguidor normal`,
      sameShape(recut, expected), firstDifference(recut, expected));
    adapter.dispose();
  }
  const summaries = catalog.summaries();
  check('3 summaries: las cuatro, con titulo, cwd, agrupador propio y tamano del archivo',
    summaries.length === 4 && summaries.every((summary) => summary.title === 'Probemos la conexion del proyecto de prueba' &&
      summary.group === `vault:${summary.agent}:${summary.sessionId}` && summary.partial === false && summary.sizeBytes > 0),
    show(summaries.map((summary) => [summary.agent, summary.group, summary.sizeBytes])));
  check('3 limitEvent no copia un evento que no hay que recortar',
    (() => { const small = event({ parts: [{ kind: 'text', text: 'corto', truncated: false }] }); return limitEvent(small, TRANSPORT_LIMITS) === small; })());
}

// --- 3c. Las reglas del catalogo ---
{
  const dir = path.join(root, 'copia-reglas');
  const catalog = new VaultCatalog();
  let changes = 0;
  const unsubscribe = catalog.onChange(() => { changes += 1; });

  await catalog.load(path.join(root, 'no-existe'));
  check('3 catalogo: una carpeta que no existe es una copia vacia, y avisa',
    catalog.summaries().length === 0 && catalog.stats().sessions === 0 && catalog.stats().bytes === 0 && changes === 1);

  const serialized = serializeSession({
    header: headerInput('claude-code', UUID),
    events: [event()],
    documents: [{ kind: 'document', origin: 'agent-document', name: 'plan.md', modifiedAt: null, text: '# Plan de prueba', truncated: false }],
  });
  const written = await vaultWrite.writeSessionFile(dir, serialized);
  const lines = serialized.text.trimEnd().split('\n');
  // A mano, entre el evento y el documento: una linea rota y una de un tipo que no se conoce.
  await writeFile(written.file, [lines[0], lines[1], '{ no es json', JSON.stringify({ kind: 'marcador', text: 'x' }), lines[2], ''].join('\n'));

  const agentDir = path.join(dir, 'sessions', 'codex');
  await mkdir(agentDir, { recursive: true });
  const foreignId = '0b1e2c3d-4e5f-4a6b-8c7d-000000000f02';
  const otherId = '0b1e2c3d-4e5f-4a6b-8c7d-000000000f03';
  await writeFile(path.join(agentDir, `${foreignId}.jsonl`), `${JSON.stringify(header({ agent: 'codex', sessionId: foreignId, format: 2 }))}\n`);
  await writeFile(path.join(agentDir, `${otherId}.jsonl`), `${JSON.stringify(header({ agent: 'codex', sessionId: foreignId }))}\n`);
  await mkdir(path.join(dir, 'sessions', 'otra-cli'), { recursive: true });
  await writeFile(path.join(dir, 'sessions', 'otra-cli', `${UUID}.jsonl`), `${JSON.stringify(header())}\n`);
  await writeFile(path.join(dir, 'sessions', 'claude-code', '.oculto.jsonl'), `${JSON.stringify(header({ sessionId: '.oculto' }))}\n`);
  const strayId = '0b1e2c3d-4e5f-4a6b-8c7d-000000000f04';
  await writeFile(`${path.join(dir, 'sessions', 'claude-code', `${strayId}.jsonl`)}.4242.a1b2c3.tmp`, `${JSON.stringify(header({ sessionId: strayId }))}\n`);

  changes = 0;
  await catalog.load(dir);
  const listed = catalog.summaries().map((summary) => `${summary.agent}/${summary.sessionId}`);
  check('3 catalogo: lista solo la sesion valida', same(listed, [`claude-code/${UUID}`]) && changes === 1, show(listed));
  check('3 catalogo: una cabecera de otro formato no se lista pero se recuerda (no se pisa)',
    catalog.header('codex', foreignId) === null && catalog.hasForeignFormat('codex', foreignId) === true);
  check('3 catalogo: una cabecera cuyo id no es el del archivo no se lista, y no es formato ajeno',
    catalog.header('codex', otherId) === null && catalog.hasForeignFormat('codex', otherId) === false);
  check('5 catalogo: un .tmp suelto con una cabecera valida no aparece', catalog.header('claude-code', strayId) === null);
  const size = (await stat(written.file)).size;
  check('3 catalogo: stats y sizeBytes son los del archivo', catalog.stats().sessions === 1 && catalog.stats().bytes === size &&
    catalog.summaries()[0].sizeBytes === size, show(catalog.stats()));

  const body = await bodyOf(catalog, 'claude-code', UUID);
  check('3 catalogo: el cuerpo salta la linea rota y el tipo desconocido, y sigue con el documento',
    same(body.map((line) => line.kind), ['event', 'document']) && body[1].name === 'plan.md', show(body.map((line) => line.kind)));
  check('3 catalogo: una sesion que no esta listada no tiene cuerpo',
    (await bodyOf(catalog, 'codex', foreignId)).length === 0 && (await bodyOf(catalog, 'codex', UUID)).length === 0);

  const laterId = '0b1e2c3d-4e5f-4a6b-8c7d-000000000f05';
  await vaultWrite.writeSessionFile(dir, serializeSession({ header: headerInput('gemini-cli', laterId, { cwd: '', group: 'Gemini CLI · carpeta desconocida' }), events: [] }));
  changes = 0;
  await catalog.refresh('gemini-cli', laterId);
  check('3 catalogo: refresh despues de escribir la lista y avisa una vez',
    catalog.header('gemini-cli', laterId)?.group === 'Gemini CLI · carpeta desconocida' && changes === 1, `${changes}`);
  await catalog.refresh('gemini-cli', laterId);
  check('3 catalogo: refresh sin cambios no avisa', changes === 1, `${changes}`);
  await rm(vaultPaths.sessionFile(dir, 'gemini-cli', laterId));
  await catalog.refresh('gemini-cli', laterId);
  check('3 catalogo: refresh de una borrada la saca y avisa', catalog.header('gemini-cli', laterId) === null && changes === 2);

  const empty = path.join(root, 'copia-vacia');
  await Promise.all([catalog.load(dir), catalog.load(empty)]);
  check('3 catalogo: dos cargas seguidas, gana la ultima carpeta', catalog.getDir() === empty && catalog.summaries().length === 0);
  unsubscribe();
  changes = 0;
  await catalog.load(dir);
  check('3 catalogo: sin oyente no avisa a nadie', changes === 0);
}

// --- 4. Imagenes ---
{
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { sessionFilePath } = await import('../src/agents/claude-code/paths.ts');
  const adapter = createClaudeCodeAdapter();
  const cwd = path.join(root, 'proyectos', 'demo-imagenes');
  const id = '1a2b3c4d-0000-4000-8000-000000000003';
  const file = sessionFilePath(cwd, id);
  await mkdir(path.dirname(file), { recursive: true });
  const at = new Date(Date.UTC(2026, 8, 14, 11, 0, 0)).toISOString();
  const line = (record) => `${JSON.stringify({ timestamp: at, cwd, ...record })}\n`;
  const image = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });
  const a = pngOf('a');
  const b = pngOf('b');
  await writeFile(file,
    line({ type: 'user', uuid: 'img-u1', message: { role: 'user', content: [{ type: 'text', text: 'Probemos dos capturas iguales' }, image(a), image(a)] } }) +
    line({ type: 'assistant', uuid: 'img-a1', message: { role: 'assistant', model: 'modelo-de-prueba', content: [{ type: 'text', text: 'Las veo.' }] } }) +
    line({ type: 'user', uuid: 'img-u2', message: { role: 'user', content: [{ type: 'text', text: 'Y esta otra' }, image(b)] } }));

  const whole = await readWholeSession(adapter.history, { cwd, sessionId: id }, VAULT_LIMITS);
  const { images, reads } = await loadImages(whole);
  check('4 las tres imagenes se leen por el seguidor', reads === 3 && images.size === 3, `${reads} ${images.size}`);
  const serialized = serializeSession({ header: headerInput('claude-code', id, { cwd }), events: whole.events, images });
  const assetA = assetName(a);
  const assetB = assetName(b);
  const refs = Object.fromEntries(serialized.text.trimEnd().split('\n').slice(1).map((raw) => JSON.parse(raw))
    .map((body) => [body.event.eventId, body.images.map((ref) => ref.asset)]));
  check('4 dos imagenes identicas en una sesion -> un solo asset; la tercera distinta -> dos',
    serialized.assets.size === 2 && serialized.header.imageCount === 2 && same(refs['img-u1'], [assetA, assetA]) && same(refs['img-u2'], [assetB]),
    show({ assets: [...serialized.assets.keys()], refs }));
  check('4 el asset se llama por el hash de sus bytes, con la extension de la firma',
    new RegExp(`^${createHashHex(a).slice(0, 32)}\\.png$`).test(assetA) && assetA !== assetB, assetA);

  const dir = path.join(root, 'copia-imagenes');
  const first = await vaultWrite.writeSessionFile(dir, serialized);
  const assetFolder = vaultPaths.assetsDir(dir, 'claude-code', id);
  const onDisk = (await namesIn(assetFolder)).sort();
  check('4 se escriben los dos assets, con los bytes originales',
    first.assetsWritten === 2 && same(onDisk, [assetA, assetB].sort()) && (await readFile(path.join(assetFolder, assetA))).equals(a), show(onDisk));
  const mtimeBefore = (await stat(path.join(assetFolder, assetA))).mtimeMs;
  const second = await vaultWrite.writeSessionFile(dir, serialized);
  check('4 escribir otra vez no reescribe un asset que ya esta',
    second.assetsWritten === 0 && (await stat(path.join(assetFolder, assetA))).mtimeMs === mtimeBefore);

  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const expectedBytes = (await stat(first.file)).size + a.length + b.length;
  check('4 stats del catalogo cuentan los assets', catalog.stats().bytes === expectedBytes, `${catalog.stats().bytes} / ${expectedBytes}`);
  const body = await bodyOf(catalog, 'claude-code', id);
  check('4 el cuerpo leido trae una referencia por parte image, en orden',
    same(body.map((l) => l.images.map((ref) => ref.asset)), [[assetA, assetA], [], [assetB]]), show(body.map((l) => l.images)));

  // En Claude Code el indice de una imagen de contenido es la posicion del bloque en el mensaje: el texto es el 0.
  const reused = new Map([
    [imageKey('img-u1', 'content', 1), { kind: 'reused', asset: assetA, bytes: a.length }],
    [imageKey('img-u1', 'content', 2), { kind: 'reused', asset: assetA, bytes: a.length }],
    [imageKey('img-u2', 'content', 1), { kind: 'reused', asset: '../fuera.png', bytes: 3 }],
  ]);
  const withReused = serializeSession({ header: headerInput('claude-code', id, { cwd }), events: whole.events, images: reused });
  const reusedRefs = withReused.text.trimEnd().split('\n').slice(1).map((raw) => JSON.parse(raw).images);
  check('4 una imagen reusada no trae bytes y conserva su asset; un asset que es ruta queda en null',
    withReused.assets.size === 0 && withReused.header.imageCount === 1 &&
    same(reusedRefs, [[{ index: 1, source: 'content', mediaType: 'image/png', asset: assetA, bytes: a.length }, { index: 2, source: 'content', mediaType: 'image/png', asset: assetA, bytes: a.length }], [], [{ index: 1, source: 'content', mediaType: 'image/png', asset: null, bytes: 0 }]]),
    show(reusedRefs));
  const none = serializeSession({ header: headerInput('claude-code', id, { cwd }), events: whole.events });
  check('4 sin imagenes leidas: todas con asset null y ningun asset',
    none.assets.size === 0 && none.header.imageCount === 0 && none.text.includes('"asset":null') && !none.text.includes(assetA));
  check('4 bytes sin firma de imagen -> .bin; JPEG -> .jpg',
    /^[0-9a-f]{32}\.bin$/.test(assetName(Buffer.from('no es una imagen'))) && assetName(Buffer.from('ffd8ffe000104a464946', 'hex')).endsWith('.jpg'));
  adapter.dispose();
}

// --- 5. Escritura atomica ---
{
  const dir = path.join(root, 'copia-atomica');
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'prueba.jsonl');
  await writeFile(target, 'viejo\n');
  const tmpLeft = async () => (await namesIn(dir)).filter((name) => name.endsWith('.tmp'));
  const eperm = () => Object.assign(new Error('EPERM simulado'), { code: 'EPERM' });

  const temporary = vaultWrite.temporaryPathFor(target);
  check('5 el temporal va al lado del destino: <nombre>.<pid>.<aleatorio>.tmp, distinto cada vez',
    temporary.startsWith(`${target}.${process.pid}.`) && temporary.endsWith('.tmp') && temporary !== vaultWrite.temporaryPathFor(target));

  let attempts = 0;
  const delays = [];
  const flaky = {
    ...vaultWrite.DEFAULT_WRITE_DEPS, platform: 'win32', delay: async (ms) => { delays.push(ms); },
    rename: async (from, to) => {
      attempts += 1;
      if (attempts <= 2) throw eperm();
      await rename(from, to);
    },
  };
  const wrote = await vaultWrite.writeFileAtomic(target, 'nuevo\n', flaky).then(() => true, () => false);
  check('5 un rename que falla con EPERM dos veces y despues funciona: queda escrito',
    wrote && attempts === 3 && same(delays, [100, 100]) && (await readFile(target, 'utf8')) === 'nuevo\n' && (await tmpLeft()).length === 0,
    `${attempts} ${show(delays)}`);

  let tries = 0;
  const broken = { ...flaky, rename: async () => { tries += 1; throw eperm(); } };
  const failed = await vaultWrite.writeFileAtomic(target, 'otro\n', broken).then(() => false, (error) => error.code === 'EPERM');
  check('5 si nunca se puede renombrar: lanza despues de 3 reintentos, sin temporal y con el archivo anterior intacto',
    failed && tries === 4 && (await readFile(target, 'utf8')) === 'nuevo\n' && (await tmpLeft()).length === 0, `${tries}`);

  tries = 0;
  await vaultWrite.writeFileAtomic(target, 'otro\n', { ...broken, platform: 'linux' }).catch(() => undefined);
  const onPosix = tries;
  tries = 0;
  const diskFull = { ...broken, rename: async () => { tries += 1; throw Object.assign(new Error('ENOSPC simulado'), { code: 'ENOSPC' }); } };
  await vaultWrite.writeFileAtomic(target, 'otro\n', diskFull).catch(() => undefined);
  check('5 no se reintenta fuera de Windows ni ante otro error', onPosix === 1 && tries === 1, `${onPosix} ${tries}`);

  const sessionDir = path.join(root, 'copia-atomica-sesion');
  let sessionAttempts = 0;
  const flakySession = {
    ...flaky, now: () => 1234,
    rename: async (from, to) => {
      if (to.endsWith('.jsonl')) {
        sessionAttempts += 1;
        if (sessionAttempts <= 2) throw eperm();
      }
      await rename(from, to);
    },
  };
  const serialized = serializeSession({ header: headerInput('codex', UUID), events: [event({ parts: [{ kind: 'text', text: 'Probemos', truncated: false }] })] });
  const sessionWrote = await vaultWrite.writeSessionFile(sessionDir, serialized, flakySession).then(() => true, () => false);
  const catalog = new VaultCatalog();
  await catalog.load(sessionDir);
  check('5 writeSessionFile con EPERM dos veces en el rename: la sesion queda escrita y listada',
    sessionWrote && sessionAttempts === 3 && catalog.header('codex', UUID) !== null &&
    (await namesIn(path.join(sessionDir, 'sessions', 'codex'))).filter((name) => name.endsWith('.tmp')).length === 0);
  const marker = await readFile(path.join(sessionDir, 'vault.json'), 'utf8').catch(() => '{}');
  check('5 vault.json se escribe con el formato 1', same(JSON.parse(marker), { format: 1, createdAt: 1234 }), marker);
  await vaultWrite.writeSessionFile(sessionDir, serialized, { ...flakySession, now: () => 9999 }).catch(() => undefined);
  check('5 vault.json no se reescribe en la escritura siguiente', (await readFile(path.join(sessionDir, 'vault.json'), 'utf8')) === marker);
  check('5 una cabecera que no se podria leer no se serializa',
    throws(() => serializeSession({ header: headerInput('codex', '../fuera'), events: [] })) &&
    throws(() => serializeSession({ header: headerInput('codex', UUID), events: [], documents: [{ kind: 'document', origin: 'agent-document', name: 'a/b.md', modifiedAt: null, text: '', truncated: false }] })));
}

// --- 6. Lo que readWholeSession no deja pasar ---
{
  const tail = (events, hasMore) => ({ events, hasMore });
  /** Un seguidor falso: cada poll consume un paso del guion. */
  const fakeHistory = ({ wholeRead = true, script = [], finalState = 'live', page = tail([event()], false) } = {}) => {
    const calls = [];
    let state = 'waiting';
    const follower = {
      label: 'seguidor-de-prueba',
      start: async () => { calls.push('start'); },
      poll: async () => {
        calls.push('poll');
        const step = script.shift() ?? {};
        if (step.throws) throw new Error('lectura rota de prueba');
        state = step.state ?? finalState;
        return { reset: step.reset === true, added: step.added ?? [], turns: [], plans: [], parts: [] };
      },
      getState: () => state,
      getUsage: () => shared.EMPTY_CONTEXT_USAGE,
      getTail: () => page,
      readImage: async () => null,
    };
    const history = {
      ...(wholeRead ? { wholeRead: true } : {}),
      follow: (target, options) => { calls.push({ follow: target.sessionId, options }); return follower; },
    };
    return { history, calls };
  };
  const target = { cwd: 'C:\\p', sessionId: UUID };
  const polls = (calls) => calls.filter((call) => call === 'poll').length;

  const paged = fakeHistory({ page: tail([event()], true) });
  const pagedError = await readWholeSession(paged.history, target, VAULT_LIMITS).then(() => null, (error) => error);
  check('6 un readWholeSession que ve hasMore -> lanza', pagedError instanceof PagedHistoryError, String(pagedError));

  const unsupported = fakeHistory({ wholeRead: false });
  const unsupportedError = await readWholeSession(unsupported.history, target, VAULT_LIMITS).then(() => null, (error) => error);
  check('6 una fuente sin wholeRead -> lanza sin llegar a seguirla',
    unsupportedError instanceof UnsupportedHistoryError && unsupported.calls.length === 0, String(unsupportedError));

  const ok = fakeHistory({ script: [{ added: [event()] }, {}] });
  const read = await readWholeSession(ok.history, target, VAULT_LIMITS);
  check('6 sigue con los topes pedidos y maxEvents infinito, start antes que poll, y corta en la primera lectura sin novedades',
    read?.state === 'live' && read.events.length === 1 && sameShape(ok.calls[0], { follow: UUID, options: { limits: VAULT_LIMITS, maxEvents: null } }) &&
    ok.calls[0].options.maxEvents === Number.POSITIVE_INFINITY && same(ok.calls.slice(1), ['start', 'poll', 'poll']), show(ok.calls));

  const resets = fakeHistory({ script: [{ added: [event()] }, { added: [event()] }, { added: [event()] }, { added: [event()] }, { reset: true }, { added: [event()] }, { added: [event()] }, { added: [event()] }, {}] });
  await readWholeSession(resets.history, target, VAULT_LIMITS);
  check('6 un reset vuelve a contar las lecturas', polls(resets.calls) === 9, `${polls(resets.calls)}`);

  const waiting = fakeHistory({ finalState: 'waiting' });
  check('6 un origen que no aparece -> null (no se encontro), despues de 5 lecturas',
    (await readWholeSession(waiting.history, target, VAULT_LIMITS)) === null && polls(waiting.calls) === 5, `${polls(waiting.calls)}`);
  const unavailable = fakeHistory({ finalState: 'unavailable' });
  check('6 un seguidor unavailable -> null', (await readWholeSession(unavailable.history, target, VAULT_LIMITS)) === null);

  const legacy = fakeHistory({ finalState: 'no-transcript', page: tail([], false) });
  const legacyRead = await readWholeSession(legacy.history, target, VAULT_LIMITS);
  check('6 no-transcript no es "no se encontro": sale sin eventos y lo dice', legacyRead?.state === 'no-transcript' && legacyRead.events.length === 0);

  const failing = fakeHistory({ script: [{ throws: true }] });
  const pollError = await readWholeSession(failing.history, target, VAULT_LIMITS).then(() => null, (error) => error);
  check('6 si el seguidor lanza, lanza', pollError?.message === 'lectura rota de prueba');

  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const adapter = createClaudeCodeAdapter();
  check('6 Claude Code con cwd vacio -> null, no una sesion vacia (C6)',
    (await readWholeSession(adapter.history, { cwd: '', sessionId: '1a2b3c4d-0000-4000-8000-000000000001' }, VAULT_LIMITS)) === null);
  check('6 Claude Code con una sesion que no existe -> null',
    (await readWholeSession(adapter.history, { cwd: path.join(root, 'proyectos', 'demo-topes-claude'), sessionId: '1a2b3c4d-0000-4000-8000-00000000dead' }, VAULT_LIMITS)) === null);
  adapter.dispose();
}

// ---------------------------------------------------------------------------
// 7 a 10. El escritor, y lo que de 4, 5 y 6 depende de la pasada
// ---------------------------------------------------------------------------

const { VaultWriter, VaultBusyError, VAULT_WRITER_REVISION, CALM_MS, PASS_DEBOUNCE_MS, ORIGIN_NOT_FOUND, MEASURE_FIRST_TEXT, enableRefusal } =
  await import('../src/vault/writer.ts');
const settingsModule = await import('../src/settings-store.ts');
const memoryCopy = await import('../src/vault/memory-copy.ts');
const { AgentRegistry: WriterRegistry } = await import('../src/agents/registry.ts');
const { SessionIndex: WriterSessionIndex } = await import('../src/session-index.ts');
const { createClaudeCodeAdapter: createWriterClaude } = await import('../src/agents/claude-code/index.ts');
const { createCodexAdapter: createWriterCodex } = await import('../src/agents/codex/index.ts');
const { sessionFilePath: writerSessionFile } = await import('../src/agents/claude-code/paths.ts');
const writerCodexPaths = await import('../src/agents/codex/paths.ts');

const MINUTE = 60_000;
const quiet = { warn: () => undefined };
const noneArchived = { has: () => false };
const settingsOf = (vault = {}) => ({ get: () => ({ version: 1, vault: { enabled: true, dir: null, toolResultMaxChars: 64_000, ...vault } }) });
const fileExists = (file) => stat(file).then(() => true, () => false);
const mtimeOf = async (file) => (await stat(file)).mtimeMs;
const minutesAgo = (minutes) => new Date(Date.now() - minutes * MINUTE);
/** Un turno de la cola de eventos: deja correr lo que se programo con setImmediate. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

/** Temporizadores de mentira: se anotan y se disparan a mano. */
function fakeTimers() {
  const handles = [];
  return {
    handles,
    set: (run, ms) => {
      const handle = { run, ms, cleared: false, fired: false };
      handles.push(handle);
      return handle;
    },
    clear: (handle) => {
      if (handle) handle.cleared = true;
    },
    active: () => handles.filter((handle) => !handle.cleared && !handle.fired),
    fire: (handle) => {
      handle.fired = true;
      handle.run();
    },
  };
}

const writerClaude = createWriterClaude();
const writerCodex = createWriterCodex();
const writerRegistry = new WriterRegistry([writerClaude, writerCodex]);
const writerIndex = new WriterSessionIndex(writerRegistry);

/** Lo que el indice real sabe de unas carpetas: cada caso ve solo sus sesiones del home de prueba. */
const indexView = (...cwds) => ({
  nativeSessions: () => writerIndex.nativeSessions().filter((session) => cwds.includes(session.cwd)),
  getProjects: () => writerIndex.getProjects().filter((project) => cwds.includes(project.cwd)),
});

const claudeAt = new Date(Date.UTC(2026, 8, 14, 12, 0, 0)).toISOString();
const claudeRecord = (cwd, record) => `${JSON.stringify({ timestamp: claudeAt, cwd, ...record })}\n`;
const userLine = (uuid, content) => ({ type: 'user', uuid, message: { role: 'user', content } });
const assistantLine = (uuid, text) => ({ type: 'assistant', uuid, message: { role: 'assistant', model: 'modelo-de-prueba', content: [{ type: 'text', text }] } });
const imageBlock = (bytes) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } });

/** Una sesion de Claude Code con fecha de modificacion `when` (vieja por defecto: ya en calma). */
async function writeClaudeSession(cwd, id, records, when = minutesAgo(10)) {
  await mkdir(cwd, { recursive: true });
  const file = writerSessionFile(cwd, id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, records.map((record) => claudeRecord(cwd, record)).join(''));
  await utimes(file, when, when);
  return file;
}

/** Un escritor con lo comun de estos casos. */
const writerFor = (options) => new VaultWriter({
  agents: writerRegistry, archived: noneArchived, settings: settingsOf(), platform: process.platform, log: quiet, ...options,
});

/** Una fuente cuyo seguidor pasa por `wrap` antes de llegar al escritor. */
const wrappedHistory = (history, wrap) => Object.create(history, {
  follow: { value: (target, options) => wrap(target, history.follow(target, options)) },
});
/** Un seguidor con un metodo cambiado; el resto, el del seguidor real. */
const overriding = (follower, name, replacement) => new Proxy(follower, {
  get: (target, property) => {
    if (property === name) return replacement;
    const value = target[property];
    return typeof value === 'function' ? value.bind(target) : value;
  },
});
/** Un registro que le da a claude-code otra fuente de historial. */
const agentsWith = (agent, history) => ({
  adapter: (id) => (id === agent ? { history } : writerRegistry.adapter(id)),
  get: (id) => writerRegistry.get(id),
});

// --- 7. Huella ---
{
  const cwd = path.join(root, 'proyectos', 'demo-huella');
  const id = '3c4d5e6f-0000-4000-8000-000000000701';
  const file = await writeClaudeSession(cwd, id, [userLine('h-u1', 'Probemos la huella'), assistantLine('h-a1', 'Primera respuesta.')]);
  await writerIndex.scan();
  const dir = path.join(root, 'copia-huella');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const make = (extra = {}) => writerFor({ index: indexView(cwd), catalog, ...extra });
  const copied = vaultPaths.sessionFile(dir, 'claude-code', id);

  check('7 nativeSessions del indice trae la sesion de prueba', indexView(cwd).nativeSessions().length === 1);
  check('7 VAULT_WRITER_REVISION es 1', VAULT_WRITER_REVISION === 1);
  const writer = make();
  const first = await writer.pass();
  const item = await writerClaude.history.item(file);
  const header1 = catalog.header('claude-code', id);
  check('7 primera pasada: escribe la sesion con la huella del origen',
    first?.written === 1 && header1?.eventCount === 2 && header1.cwd === cwd &&
    same(header1.source, { kind: 'native', mtimeMs: item.mtimeMs, sizeBytes: item.sizeBytes, writerRevision: 1 }),
    show({ first, source: header1?.source }));
  const mtime1 = await mtimeOf(copied);
  const text1 = await readFile(copied, 'utf8');

  const second = await writer.pass();
  check('7 dos pasadas sin cambios: la segunda no escribe (misma fecha y mismo contenido)',
    second?.written === 0 && second.unchanged === 1 && (await mtimeOf(copied)) === mtime1 && (await readFile(copied, 'utf8')) === text1, show(second));
  const fresh = await make().pass();
  check('7 otro proceso con la copia al dia: alcanza la huella de la cabecera, no escribe',
    fresh?.written === 0 && fresh.upToDate === 1 && (await mtimeOf(copied)) === mtime1, show(fresh));

  await appendFile(file, claudeRecord(cwd, userLine('h-u2', 'Y una pregunta mas')));
  await utimes(file, minutesAgo(5), minutesAgo(5));
  await writerIndex.scan();
  const third = await writer.pass();
  const body3 = await bodyOf(catalog, 'claude-code', id);
  const ids3 = body3.map((line) => line.event.eventId);
  check('7 el nativo crece: se reescribe entero, con el evento nuevo y sin duplicar',
    third?.written === 1 && catalog.header('claude-code', id)?.eventCount === 3 && ids3.length === 3 && new Set(ids3).size === 3, show({ third, ids3 }));

  await utimes(file, minutesAgo(4), minutesAgo(4));
  await writerIndex.scan();
  const fourth = await writer.pass();
  const body4 = await bodyOf(catalog, 'claude-code', id);
  check('7 tocar el nativo sin cambiarlo: se reescribe con los mismos eventos y la huella nueva',
    fourth?.written === 1 && sameShape(body4, body3) &&
    catalog.header('claude-code', id)?.source.mtimeMs === (await writerClaude.history.item(file)).mtimeMs, show(fourth));

  const bumped = await make({ writerRevision: 2 }).pass();
  check('7 otra revision del escritor: se reescribe aunque el origen no cambio',
    bumped?.written === 1 && catalog.header('claude-code', id)?.source.writerRevision === 2, show(bumped));
  const back = await make().pass();
  check('7 y con la revision 1 otra vez, tambien', back?.written === 1 && catalog.header('claude-code', id)?.source.writerRevision === 1);
}

// --- 8. Calma, pedidos agrupados y lo que corre al terminar ---
{
  const cwd = path.join(root, 'proyectos', 'demo-calma');
  const id = '3c4d5e6f-0000-4000-8000-000000000801';
  const T = Date.UTC(2026, 8, 14, 12, 0, 0);
  await writeClaudeSession(cwd, id, [userLine('c-u1', 'Probemos la calma')], new Date(T));
  await writerIndex.scan();
  const dir = path.join(root, 'copia-calma');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const clock = { now: T + 10_000 };
  const timers = fakeTimers();
  const writer = writerFor({ index: indexView(cwd), catalog, now: () => clock.now, timers });
  const copied = vaultPaths.sessionFile(dir, 'claude-code', id);

  check('8 CALM_MS es un minuto y los pedidos se juntan a 5 s', CALM_MS === 60_000 && PASS_DEBOUNCE_MS === 5_000);
  const first = await writer.pass();
  const calm = timers.active();
  check('8 cambiado hace 10 s: pendiente, sin escribir, y un temporizador a 50 s',
    first?.pending === 1 && first.written === 0 && writer.snapshot().pending === 1 && calm.length === 1 && calm[0].ms === 50_000 && !(await fileExists(copied)),
    show({ first, timers: calm.map((handle) => handle.ms) }));

  clock.now = T + 61_000;
  // Sin temporizador (la calma no se respeto) no hay nada que disparar: el FALLO de arriba ya lo dijo.
  if (calm[0] !== undefined) timers.fire(calm[0]);
  const wrote = await waitFor(() => writer.snapshot().lastPass?.written === 1 && writer.snapshot().activity === 'idle');
  check('8 hace 61 s: el temporizador corre la pasada y la escribe',
    wrote && (await fileExists(copied)) && writer.snapshot().pending === 0 && timers.active().length === 0, show(writer.snapshot().lastPass));

  writer.requestPass();
  writer.requestPass();
  const debounced = timers.active();
  check('8 dos pedidos seguidos: queda un solo temporizador, a 5 s del ultimo',
    debounced.length === 1 && debounced[0].ms === PASS_DEBOUNCE_MS && timers.handles.filter((handle) => handle.ms === PASS_DEBOUNCE_MS).length === 2,
    show(timers.handles.map((handle) => [handle.ms, handle.cleared])));

  let writings = 0;
  let previous = writer.snapshot().activity;
  writer.onChange(() => {
    const activity = writer.snapshot().activity;
    if (activity === 'writing' && previous !== 'writing') writings += 1;
    previous = activity;
  });
  const lastBefore = writer.snapshot().lastPass;
  const measuring = writer.measure();
  const refused = await writer.pass();
  writer.requestPass();
  const refusedAgain = await writer.pass();
  const busy = await writer.measure().then(() => null, (error) => error);
  check('8 con una medicion en curso: la pasada no corre en paralelo, y otra medicion da VaultBusyError',
    refused === null && refusedAgain === null && writer.snapshot().activity === 'measuring' && busy instanceof VaultBusyError);
  await measuring;
  const ran = await waitFor(() => writer.snapshot().lastPass !== lastBefore && writer.snapshot().activity === 'idle');
  await turn();
  await turn();
  check('8 ... y lo pedido corre una sola vez al terminar, y se lleva el temporizador pendiente',
    ran && writings === 1 && writer.snapshot().lastPass?.unchanged === 1 && timers.active().length === 0, `${writings} ${show(writer.snapshot().lastPass)}`);
  writer.dispose();
}

// --- 9. Archivadas ---
{
  const cwd = path.join(root, 'proyectos', 'demo-archivadas');
  const archivedId = '3c4d5e6f-0000-4000-8000-000000000901';
  const keptId = '3c4d5e6f-0000-4000-8000-000000000902';
  const archivedFile = await writeClaudeSession(cwd, archivedId, [userLine('a-u1', 'Probemos una archivada')]);
  await writeClaudeSession(cwd, keptId, [userLine('k-u1', 'Probemos una que queda')]);
  await writerIndex.scan();
  const dir = path.join(root, 'copia-archivadas');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const archived = new Set([archivedId]);
  const writer = writerFor({ index: indexView(cwd), catalog, archived });
  const archivedCopy = vaultPaths.sessionFile(dir, 'claude-code', archivedId);

  const first = await writer.pass();
  check('9 archivada: no se escribe y cuenta como archivada; la otra si',
    first?.written === 1 && first.skippedArchived === 1 && !(await fileExists(archivedCopy)) && catalog.header('claude-code', keptId) !== null, show(first));
  const measured = await writer.measure();
  check('9 la pasada en seco la cuenta en skippedArchived',
    measured.byAgent.length === 1 && measured.byAgent[0].skippedArchived === 1 && measured.byAgent[0].sessions === 1, show(measured.byAgent));

  archived.delete(archivedId);
  const restored = await writer.pass();
  check('9 restaurada: se escribe en la pasada siguiente', restored?.written === 1 && (await fileExists(archivedCopy)), show(restored));

  archived.add(archivedId);
  const mtime = await mtimeOf(archivedCopy);
  await utimes(archivedFile, minutesAgo(3), minutesAgo(3));
  await writerIndex.scan();
  const after = await writer.pass();
  check('9 archivada despues de copiada: la copia sigue ahi, sin tocar, aunque el nativo cambio',
    after?.skippedArchived === 1 && after.written === 0 && (await fileExists(archivedCopy)) && (await mtimeOf(archivedCopy)) === mtime &&
    catalog.header('claude-code', archivedId) !== null, show(after));

  const kept = writerIndex.nativeSessions().find((session) => session.summary.sessionId === keptId);
  const twin = { ...kept, ref: path.join(path.dirname(path.dirname(kept.ref)), 'OTRA-CARPETA', path.basename(kept.ref)) };
  const itemRefs = [];
  const spy = Object.create(writerClaude.history, {
    item: { value: async (ref) => { itemRefs.push(ref); return writerClaude.history.item(ref); } },
  });
  const dupCatalog = new VaultCatalog();
  await dupCatalog.load(path.join(root, 'copia-duplicadas'));
  const dupWriter = writerFor({ index: { nativeSessions: () => [kept, twin], getProjects: () => [] }, agents: agentsWith('claude-code', spy), catalog: dupCatalog });
  const dup = await dupWriter.pass();
  const dupMeasure = await dupWriter.measure();
  check('9 dos ref con el mismo (agent, sessionId): una sola escritura y una sola medicion, las de la primera',
    dup?.written === 1 && same(itemRefs, [kept.ref, kept.ref]) && dupMeasure.byAgent[0]?.sessions === 1, show({ dup, itemRefs: itemRefs.map((ref) => path.basename(path.dirname(ref))) }));

  // Archivar mientras corre la pasada (R28-1): una pasada larga dura minutos y el socket cambia el mismo `archived`.
  const midCwd = path.join(root, 'proyectos', 'demo-archivar-a-mitad');
  const midIds = ['3c4d5e6f-0000-4000-8000-000000000911', '3c4d5e6f-0000-4000-8000-000000000912'];
  const readingId = '3c4d5e6f-0000-4000-8000-000000000913';
  for (const id of midIds) await writeClaudeSession(midCwd, id, [userLine(`mid-${id.slice(-3)}`, 'Probemos archivar a mitad de pasada')]);
  await writeClaudeSession(midCwd, readingId, [userLine('mid-913', 'Probemos archivar mientras se lee')]);
  await writerIndex.scan();
  const midView = indexView(midCwd);
  const midArchived = new Set([readingId]);
  const itemIds = [];
  let archiveOther = true;
  const archivingSpy = Object.create(writerClaude.history, {
    item: {
      value: async (ref) => {
        const sessionId = midView.nativeSessions().find((session) => session.ref === ref)?.summary.sessionId;
        itemIds.push(sessionId);
        // En la primera sesion que se mira, el usuario archiva la otra.
        if (archiveOther) {
          archiveOther = false;
          midArchived.add(midIds.find((id) => id !== sessionId));
        }
        return writerClaude.history.item(ref);
      },
    },
  });
  const midCatalog = new VaultCatalog();
  const midDir = path.join(root, 'copia-archivar-a-mitad');
  await midCatalog.load(midDir);
  const midWriter = writerFor({ index: midView, catalog: midCatalog, archived: midArchived, agents: agentsWith('claude-code', archivingSpy) });
  const mid = await midWriter.pass();
  const lateArchived = midIds.find((id) => id !== itemIds[0]);
  check('9 archivada a mitad de la pasada, antes de llegarle: no se lee ni se escribe, y cuenta como archivada',
    mid?.written === 1 && mid.skippedArchived === 2 && itemIds.length === 1 &&
    !(await fileExists(vaultPaths.sessionFile(midDir, 'claude-code', lateArchived))) && midCatalog.header('claude-code', itemIds[0] ?? '') !== null,
    show({ mid, itemIds }));

  // Archivada mientras se lee entera: justo antes de escribir se vuelve a mirar.
  midArchived.delete(readingId);
  for (const id of midIds) midArchived.add(id);
  let archiveWhileReading = true;
  const whileReading = wrappedHistory(writerClaude.history, (target, follower) => {
    if (archiveWhileReading && target.sessionId === readingId) {
      archiveWhileReading = false;
      midArchived.add(readingId);
    }
    return follower;
  });
  const readingWriter = writerFor({ index: midView, catalog: midCatalog, archived: midArchived, agents: agentsWith('claude-code', whileReading) });
  const reading = await readingWriter.pass();
  check('9 archivada mientras se lee entera: no se escribe',
    reading?.written === 0 && reading.skippedArchived === 3 && archiveWhileReading === false &&
    !(await fileExists(vaultPaths.sessionFile(midDir, 'claude-code', readingId))), show(reading));
  midArchived.delete(readingId);
  const readingRestored = await readingWriter.pass();
  check('9 ... y restaurarla la copia en la pasada siguiente del mismo escritor (no quedo anotada como vista)',
    readingRestored?.written === 1 && (await fileExists(vaultPaths.sessionFile(midDir, 'claude-code', readingId))), show(readingRestored));
}

// --- 10. Pasada en seco y encender ---
{
  const cwd = path.join(root, 'proyectos', 'demo-seco');
  const png = pngOf('seco');
  const imageId = '3c4d5e6f-0000-4000-8000-000000001001';
  const archivedId = '3c4d5e6f-0000-4000-8000-000000001002';
  const orphanId = '3c4d5e6f-0000-4000-8000-000000001003';
  await writeClaudeSession(cwd, imageId, [
    userLine('s-u1', [{ type: 'text', text: 'Probemos una captura' }, imageBlock(png), imageBlock(png)]),
    assistantLine('s-a1', 'La veo.'),
  ]);
  await writeClaudeSession(cwd, archivedId, [userLine('s-u2', 'Probemos otra')]);
  await writeClaudeSession(cwd, orphanId, [userLine('s-u3', 'Probemos una sin carpeta')]);

  const codexId = '019e0000-0000-7000-8000-000000001004';
  const pad2 = (n) => String(n).padStart(2, '0');
  const ms = writerCodexPaths.uuidV7Millis(codexId);
  const day = new Date(ms);
  const folder = writerCodexPaths.localDayFolder(writerCodexPaths.codexSessionsRoot(), ms);
  const rollout = path.join(folder, `rollout-${day.getFullYear()}-${pad2(day.getMonth() + 1)}-${pad2(day.getDate())}T${pad2(day.getHours())}-${pad2(day.getMinutes())}-${pad2(day.getSeconds())}-${codexId}.jsonl`);
  const rec = (type, payload) => `${JSON.stringify({ timestamp: claudeAt, type, payload })}\n`;
  await mkdir(folder, { recursive: true });
  await writeFile(rollout,
    rec('session_meta', { id: codexId, timestamp: claudeAt, cwd, originator: 'codex-tui', cli_version: '0.154.0', source: 'cli' }) +
    rec('event_msg', { type: 'user_message', message: 'Probemos Codex en seco', images: [], local_images: [], text_elements: [] }));
  await utimes(rollout, minutesAgo(10), minutesAgo(10));
  await writerIndex.scan();

  const base = indexView(cwd);
  // La sesion sin carpeta: su resumen no dice donde reanudar, y Claude Code arma la ruta con eso (C6).
  const view = {
    nativeSessions: () => base.nativeSessions().map((session) =>
      session.summary.sessionId === orphanId ? { ...session, summary: { ...session.summary, cwd: '' } } : session),
    getProjects: base.getProjects,
  };
  const dir = path.join(root, 'copia-seco');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const archived = new Set([archivedId]);
  const off = writerFor({ index: view, catalog, archived, settings: settingsOf({ enabled: false }) });

  check('10 con la copia apagada la pasada no corre ni crea nada', (await off.pass()) === null && !(await fileExists(dir)));
  const measurement = await off.measure();
  const rows = Object.fromEntries(measurement.byAgent.map((row) => [row.agent, row]));
  check('10 pasada en seco (con la copia apagada): ninguna carpeta creada', !(await fileExists(dir)));
  check('10 claude-code: 1 sesion con una imagen unica (dos partes iguales), 1 archivada, 1 sin origen con su motivo',
    rows['claude-code']?.sessions === 1 && rows['claude-code'].images === 1 && rows['claude-code'].imageBytes === png.length &&
    rows['claude-code'].skippedArchived === 1 && rows['claude-code'].skippedEmpty === 0 && rows['claude-code'].failed === 1 &&
    same(rows['claude-code'].failureReasons, [ORIGIN_NOT_FOUND]) && rows['claude-code'].eventBytes > 0, show(rows['claude-code']));
  check('10 codex: 1 sesion en su propia fila, despues de claude-code',
    rows.codex?.sessions === 1 && rows.codex.eventBytes > 0 && same(measurement.byAgent.map((row) => row.agent), ['claude-code', 'codex']),
    show(measurement.byAgent));
  check('10 la medicion queda en el estado del escritor y el cliente la puede leer',
    off.snapshot().measurement === measurement && sameShape(shared.parseVaultMeasurement(plain(measurement)), plain(measurement)));

  const noWholeRead = Object.create(writerCodex.history, { wholeRead: { value: undefined } });
  const unsupported = await writerFor({ index: view, catalog, archived, agents: agentsWith('codex', noWholeRead) }).measure();
  const codexRow = unsupported.byAgent.find((row) => row.agent === 'codex');
  check('10 una fuente sin wholeRead cuenta como unsupported y no se lee', codexRow?.unsupported === 1 && codexRow.sessions === 0, show(codexRow));

  check('10 encender sin medicion y sin sesiones copiadas por una pasada: rechazado con su motivo',
    catalog.stats().passSessions === 0 && enableRefusal(false, catalog.stats().passSessions) === MEASURE_FIRST_TEXT);
  check('10 encender con medicion: se puede', enableRefusal(true, 0) === null);
  const store = new settingsModule.SettingsStore(path.join(root, 'ajustes-seco', 'settings.json'));
  await store.load();
  await store.update({ vault: { enabled: true } });
  const on = writerFor({ index: view, catalog, archived, settings: store });
  const firstPass = await on.pass();
  const sizeOf = async (agent, id) => (await stat(vaultPaths.sessionFile(dir, agent, id))).size;
  check('10 encendida: la primera pasada escribe lo que midio, con el mismo tamano',
    firstPass?.written === 2 && firstPass.failed === 1 && (await sizeOf('claude-code', imageId)) === rows['claude-code'].eventBytes &&
    (await sizeOf('codex', codexId)) === rows.codex.eventBytes,
    show({ firstPass, sizes: [await sizeOf('claude-code', imageId), rows['claude-code'].eventBytes, await sizeOf('codex', codexId), rows.codex.eventBytes] }));
  check('10 con sesiones que copio una pasada, encender ya no pide medir (C18)',
    catalog.stats().passSessions === 2 && enableRefusal(false, catalog.stats().passSessions) === null, show(catalog.stats()));
  check('10 el origen no encontrado no es un error de la pasada', on.snapshot().lastError === null, show(on.snapshot().lastError));
}

// --- 10. Ajustes ---
{
  const { SettingsStore, defaultAppSettings, parseAppSettings } = settingsModule;
  // Los ajustes traen ademas el acceso remoto (hito 37), apagado: lo cubre `check-remote-access.mjs`.
  const REMOTE_OFF = { enabled: false, port: 24837 };
  const folder = path.join(root, 'ajustes');
  const file = path.join(folder, 'settings.json');
  const warnings = [];
  const log = { warn: (message) => warnings.push(String(message)) };
  const store = new SettingsStore(file, { platform: 'win32', log });
  await store.load();
  check('10 ajustes sin archivo: apagada, carpeta por defecto, 64 000; y leer no crea nada',
    same(store.get(), { version: 1, vault: { enabled: false, dir: null, toolResultMaxChars: 64_000 }, remote: REMOTE_OFF }) &&
    !(await fileExists(folder)), show(store.get()));
  check('10 ajustes: no hay everEnabled (C18)', !('everEnabled' in store.get().vault) && !('everEnabled' in defaultAppSettings().vault));

  await mkdir(folder, { recursive: true });
  await writeFile(file, JSON.stringify({ version: 1, vault: { enabled: true, dir: 'copia\\relativa', toolResultMaxChars: 10 } }));
  await store.load();
  check('10 ajustes: una carpeta relativa vale null y se avisa; el tope se acota a 4 000',
    store.get().vault.enabled === true && store.get().vault.dir === null && store.get().vault.toolResultMaxChars === 4_000 &&
    warnings.some((warning) => warning.includes('relativa')), show({ settings: store.get(), warnings }));
  check('10 ajustes: tope enorme -> 1 000 000; texto -> 64 000; \\carpeta sin unidad no es absoluta en Windows; unidad y POSIX si',
    parseAppSettings({ version: 1, vault: { toolResultMaxChars: 5e9 } }, 'win32')?.vault.toolResultMaxChars === 1_000_000 &&
    parseAppSettings({ version: 1, vault: { toolResultMaxChars: 'mucho' } }, 'win32')?.vault.toolResultMaxChars === 64_000 &&
    parseAppSettings({ version: 1, vault: { dir: '\\copia' } }, 'win32')?.vault.dir === null &&
    parseAppSettings({ version: 1, vault: { dir: 'D:\\Copias' } }, 'win32')?.vault.dir === 'D:\\Copias' &&
    parseAppSettings({ version: 1, vault: { dir: '/home/prueba/copia' } }, 'linux')?.vault.dir === '/home/prueba/copia');

  const future = JSON.stringify({ version: 2, vault: { enabled: true, algoNuevo: 1 } });
  await writeFile(file, future);
  await store.load();
  check('10 ajustes de otra version: valores por defecto, y leer no toca el archivo',
    store.get().vault.enabled === false && (await readFile(file, 'utf8')) === future);
  await writeFile(file, '{ no es json');
  await store.load();
  check('10 ajustes ilegibles: valores por defecto', store.get().vault.enabled === false && (await readFile(file, 'utf8')) === '{ no es json');

  await store.update({ vault: { enabled: true, dir: 'D:\\Copias' } });
  check('10 ajustes: update escribe enseguida, sin temporales, y get lo refleja',
    same(JSON.parse(await readFile(file, 'utf8')), { version: 1, vault: { enabled: true, dir: 'D:\\Copias', toolResultMaxChars: 64_000 }, remote: REMOTE_OFF }) &&
    store.get().vault.dir === 'D:\\Copias' && (await namesIn(folder)).every((name) => !name.endsWith('.tmp')), show(store.get()));
  const rejected = await store.update({ vault: { dir: 'relativa' } }).then(() => false, () => true);
  check('10 ajustes: una carpeta relativa en update se rechaza y no cambia nada',
    rejected && store.get().vault.dir === 'D:\\Copias' && JSON.parse(await readFile(file, 'utf8')).vault.dir === 'D:\\Copias');
  await Promise.all([store.update({ vault: { enabled: false } }), store.update({ vault: { toolResultMaxChars: 100_000 } })]);
  const reloaded = new SettingsStore(file, { platform: 'win32', log });
  await reloaded.load();
  check('10 ajustes: dos cambios seguidos no se pisan',
    same(reloaded.get().vault, { enabled: false, dir: 'D:\\Copias', toolResultMaxChars: 100_000 }), show(reloaded.get()));
  check('10 ajustes: get devuelve algo congelado', Object.isFrozen(reloaded.get()) && Object.isFrozen(reloaded.get().vault));
}

// --- 10. Memoria ---
{
  const cwd = path.join(root, 'proyectos', 'demo-memoria');
  const memory = path.join(cwd, '.agents', 'memory');
  await mkdir(path.join(memory, 'sub'), { recursive: true });
  const index = '- [Nota](nota.md) — de prueba\n';
  const note = 'Probemos la memoria del proyecto de prueba\n';
  await writeFile(path.join(memory, 'MEMORY.md'), index);
  await writeFile(path.join(memory, 'nota.md'), note);
  await writeFile(path.join(memory, 'borrador.txt'), 'no se copia');
  await writeFile(path.join(memory, 'sub', 'otra.md'), 'tampoco: no es del primer nivel');
  const dir = path.join(root, 'copia-memoria');
  const target = vaultPaths.memoryDir(dir, cwd, process.platform);
  const bytes = Buffer.byteLength(index) + Buffer.byteLength(note);

  check('10 memoria medida: los dos .md del primer nivel, sin escribir',
    same(await memoryCopy.measureProjectMemory(cwd), { files: 2, bytes }) && !(await fileExists(dir)), show(await memoryCopy.measureProjectMemory(cwd)));
  const copied = await memoryCopy.copyProjectMemory(dir, cwd, process.platform);
  check('10 memoria: los .md copiados; el .txt y la subcarpeta no; source.json con el cwd; vault.json',
    same(copied, { files: 2, bytes }) && same((await namesIn(target)).sort(), ['MEMORY.md', 'nota.md', 'source.json']) &&
    JSON.parse(await readFile(path.join(target, 'source.json'), 'utf8')).cwd === cwd &&
    (await readFile(path.join(target, 'nota.md'), 'utf8')) === note && (await fileExists(path.join(dir, 'vault.json'))),
    show({ copied, names: await namesIn(target) }));
  check('10 memoria al dia: la segunda copia no escribe nada', same(await memoryCopy.copyProjectMemory(dir, cwd, process.platform), { files: 0, bytes: 0 }));

  await rm(path.join(memory, 'nota.md'));
  await writeFile(path.join(memory, 'MEMORY.md'), '- vacio, y mas largo que antes\n');
  const afterDelete = await memoryCopy.copyProjectMemory(dir, cwd, process.platform);
  check('10 memoria: un .md borrado del proyecto sigue en la copia; el que cambio se vuelve a copiar',
    afterDelete.files === 1 && (await readFile(path.join(target, 'nota.md'), 'utf8')) === note &&
    (await readFile(path.join(target, 'MEMORY.md'), 'utf8')).startsWith('- vacio'), show(afterDelete));

  const outside = path.join(root, 'afuera', 'agents-ajeno');
  await mkdir(path.join(outside, 'memory'), { recursive: true });
  await writeFile(path.join(outside, 'memory', 'secreto.md'), 'SECRETO de otro lado');
  const linked = path.join(root, 'proyectos', 'demo-memoria-enlace');
  await mkdir(linked, { recursive: true });
  const linkMade = await symlink(outside, path.join(linked, '.agents'), 'junction').then(() => true, () => false);
  const linkDir = path.join(root, 'copia-memoria-enlace');
  check('10 memoria: la junction de prueba existe y lleva afuera', linkMade && (await fileExists(path.join(linked, '.agents', 'memory', 'secreto.md'))));
  check('10 memoria: una junction .agents hacia afuera no se lee ni se copia',
    same(await memoryCopy.measureProjectMemory(linked), { files: 0, bytes: 0 }) &&
    same(await memoryCopy.copyProjectMemory(linkDir, linked, process.platform), { files: 0, bytes: 0 }) && !(await fileExists(linkDir)));

  const sessionId = '3c4d5e6f-0000-4000-8000-000000001011';
  await writeClaudeSession(cwd, sessionId, [userLine('m-u1', 'Probemos la memoria en la pasada')]);
  await writeClaudeSession(linked, '3c4d5e6f-0000-4000-8000-000000001012', [userLine('m-u2', 'Probemos el enlace en la pasada')]);
  await writerIndex.scan();
  const passDir = path.join(root, 'copia-memoria-pasada');
  const catalog = new VaultCatalog();
  await catalog.load(passDir);
  const report = await writerFor({ index: indexView(cwd, linked), catalog }).pass();
  check('10 la pasada copia la memoria de los proyectos con carpeta, y no la del enlace',
    report?.written === 2 && report.memoryFiles === 1 && (await fileExists(path.join(vaultPaths.memoryDir(passDir, cwd, process.platform), 'MEMORY.md'))) &&
    !(await fileExists(vaultPaths.memoryDir(passDir, linked, process.platform))), show(report));
}

// --- 4 (pasada). Una sesion que cambia no vuelve a leer las imagenes ya copiadas ---
{
  const cwd = path.join(root, 'proyectos', 'demo-imagenes-pasada');
  const id = '3c4d5e6f-0000-4000-8000-000000000401';
  const [a, b, c] = [pngOf('pasada a'), pngOf('pasada b'), pngOf('pasada c')];
  const file = await writeClaudeSession(cwd, id, [
    userLine('pi-u1', [{ type: 'text', text: 'Probemos dos capturas' }, imageBlock(a), imageBlock(b)]),
    assistantLine('pi-a1', 'Las veo.'),
  ]);
  await writerIndex.scan();
  const reads = [];
  const spy = wrappedHistory(writerClaude.history, (target, follower) => overriding(follower, 'readImage', (eventId, index, source) => {
    reads.push(imageKey(eventId, source, index));
    return follower.readImage(eventId, index, source);
  }));
  const dir = path.join(root, 'copia-imagenes-pasada');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const writer = writerFor({ index: indexView(cwd), catalog, agents: agentsWith('claude-code', spy) });
  const assets = () => namesIn(vaultPaths.assetsDir(dir, 'claude-code', id));

  const first = await writer.pass();
  check('4 primera pasada: lee las dos imagenes y escribe dos assets',
    first?.written === 1 && same(reads, ['pi-u1|content|1', 'pi-u1|content|2']) && (await assets()).length === 2, show({ first, reads }));

  reads.length = 0;
  await appendFile(file, claudeRecord(cwd, userLine('pi-u2', [{ type: 'text', text: 'Y una tercera' }, imageBlock(c)])));
  await utimes(file, minutesAgo(5), minutesAgo(5));
  await writerIndex.scan();
  const second = await writer.pass();
  check('4 segunda pasada con la sesion cambiada: readImage (espiado) solo para la nueva',
    second?.written === 1 && same(reads, ['pi-u2|content|1']) && catalog.header('claude-code', id)?.imageCount === 3 && (await assets()).length === 3,
    show({ second, reads }));

  reads.length = 0;
  await rm(path.join(vaultPaths.assetsDir(dir, 'claude-code', id), assetName(b)));
  await utimes(file, minutesAgo(4), minutesAgo(4));
  await writerIndex.scan();
  const third = await writer.pass();
  check('4 un asset que ya no esta en disco se vuelve a leer; los demas no',
    third?.written === 1 && same(reads, ['pi-u1|content|2']) && (await assets()).includes(assetName(b)), show({ third, reads }));

  reads.length = 0;
  await writer.measure();
  check('4 la pasada en seco no reusa aunque la copia esta al dia: lee las tres', reads.length === 3, show(reads));

  reads.length = 0;
  const bumped = await writerFor({ index: indexView(cwd), catalog, agents: agentsWith('claude-code', spy), writerRevision: 2 }).pass();
  check('4 otra revision del escritor no reusa: lee las tres', bumped?.written === 1 && reads.length === 3, show(reads));
}

// --- 5 (pasada). Temporales viejos ---
{
  const cwd = path.join(root, 'proyectos', 'demo-temporales');
  const id = '3c4d5e6f-0000-4000-8000-000000000501';
  await writeClaudeSession(cwd, id, [userLine('t-u1', 'Probemos los temporales')]);
  await writerIndex.scan();
  const dir = path.join(root, 'copia-temporales');
  const agentDir = path.join(dir, 'sessions', 'claude-code');
  const assetDir = path.join(agentDir, `${UUID}.assets`);
  await mkdir(assetDir, { recursive: true });
  const oldOwn = path.join(agentDir, `${UUID}.jsonl.4242.a1b2c3d4e5f6.tmp`);
  const oldAsset = path.join(assetDir, `${'b'.repeat(32)}.png.4242.0a1b2c3d4e5f.tmp`);
  const freshOwn = path.join(agentDir, `${UUID}.jsonl.4242.0123456789ab.tmp`);
  const foreign = path.join(agentDir, 'de-otro-programa.tmp');
  for (const file of [oldOwn, oldAsset, freshOwn, foreign]) await writeFile(file, 'temporal de prueba');
  for (const file of [oldOwn, oldAsset, foreign]) await utimes(file, minutesAgo(120), minutesAgo(120));
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  await writerFor({ index: indexView(cwd), catalog }).pass();
  check('5 la pasada borra los temporales propios de mas de 1 h (tambien en .assets) y deja los recientes y los ajenos',
    !(await fileExists(oldOwn)) && !(await fileExists(oldAsset)) && (await fileExists(freshOwn)) && (await fileExists(foreign)),
    show(await namesIn(agentDir)));
}

// --- 6 (pasada). Un fallo no corta la pasada; un disco lleno si ---
{
  const cwd = path.join(root, 'proyectos', 'demo-fallos');
  const brokenId = '3c4d5e6f-0000-4000-8000-000000000601';
  const goodId = '3c4d5e6f-0000-4000-8000-000000000602';
  await writeClaudeSession(cwd, brokenId, [userLine('f-u1', 'Probemos una que falla')]);
  await writeClaudeSession(cwd, goodId, [userLine('f-u2', 'Probemos la que sigue')]);
  await writerIndex.scan();
  const base = indexView(cwd);
  const brokenFirst = {
    nativeSessions: () => [...base.nativeSessions()].sort((x, y) => (x.summary.sessionId === brokenId ? -1 : y.summary.sessionId === brokenId ? 1 : 0)),
    getProjects: base.getProjects,
  };
  const paging = wrappedHistory(writerClaude.history, (target, follower) =>
    target.sessionId === brokenId ? overriding(follower, 'getTail', (limit) => ({ ...follower.getTail(limit), hasMore: true })) : follower);
  const warnings = [];
  const dir = path.join(root, 'copia-fallos');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const writer = writerFor({ index: brokenFirst, catalog, agents: agentsWith('claude-code', paging), log: { warn: (message) => warnings.push(String(message)) } });
  const report = await writer.pass();
  check('6 la pasada cuenta en failed la que pagina, con su motivo, y sigue con la siguiente',
    report?.failed === 1 && report.written === 1 && report.failureReasons.some((reason) => es(reason).includes('maxEvents')) &&
    catalog.header('claude-code', goodId) !== null && catalog.header('claude-code', brokenId) === null, show(report));
  const lastErrorText = (value) => (value === null ? '' : es(value));
  check('6 el fallo queda en lastError y en la consola', lastErrorText(writer.snapshot().lastError).includes(brokenId) && warnings.some((warning) => warning.includes(brokenId)),
    show(writer.snapshot().lastError));

  const items = [];
  const counting = Object.create(writerClaude.history, { item: { value: async (ref) => { items.push(ref); return writerClaude.history.item(ref); } } });
  const fullDir = path.join(root, 'copia-disco-lleno');
  const fullCatalog = new VaultCatalog();
  await fullCatalog.load(fullDir);
  const diskFull = { ...vaultWrite.DEFAULT_WRITE_DEPS, rename: async () => { throw Object.assign(new Error('ENOSPC simulado'), { code: 'ENOSPC' }); } };
  const full = writerFor({ index: brokenFirst, catalog: fullCatalog, agents: agentsWith('claude-code', counting), writeDeps: diskFull });
  const fullReport = await full.pass();
  check('6 disco lleno: la pasada se corta en la primera sesion, sin contarla como fallo ni seguir',
    fullReport?.aborted !== null && fullReport.written === 0 && fullReport.failed === 0 && items.length === 1 && lastErrorText(full.snapshot().lastError).includes('Disco lleno'),
    show({ fullReport, items: items.length }));
  const leftovers = [...(await namesIn(fullDir)), ...(await namesIn(path.join(fullDir, 'sessions', 'claude-code')))].filter((name) => name.endsWith('.tmp'));
  check('6 disco lleno: no quedan temporales', leftovers.length === 0, show(leftovers));
}

// ---------------------------------------------------------------------------
// 11. El indice mezcla la copia
// ---------------------------------------------------------------------------

const { vaultOnlySessions, nativeListState, buildProjects, SessionIndex: VaultIndex } = await import('../src/session-index.ts');
const { EventEmitter } = await import('node:events');

/** Una sesion de la copia escrita de verdad, con un evento de prueba. */
async function writeCopy(dir, agent, sessionId, overrides = {}) {
  const serialized = serializeSession({ header: headerInput(agent, sessionId, overrides), events: [event({ eventId: `${sessionId}-e1` })] });
  await vaultWrite.writeSessionFile(dir, serialized);
}
/** Lo que el indice sabe de una copia, sin disco. */
const vaultSummary = (overrides = {}) => ({
  agent: 'claude-code', sessionId: UUID, cwd: 'C:\\proyectos\\demo', group: `vault:claude-code:${UUID}`, title: 'Probemos la copia',
  titleSource: 'first-message', updatedAt: 1_700_000_900_000, sizeBytes: 321, partial: false, ...overrides,
});
/** Una sesion nativa ya indexada, sin disco. */
const nativeOf = (agent, sessionId, cwd, group = 'g') => ({
  agent, ref: `${agent}:${sessionId}`, group, cwd,
  summary: { agent, sessionId, cwd: cwd ?? '', title: 'Nativa', titleSource: 'first-message', updatedAt: 1_700_000_800_000, sizeBytes: 100, archived: false, storage: 'native', partial: false },
});
/** Una fuente de historial de mentira: sin nada salvo lo que se le pise. */
const fakeAdapter = (id, history = {}) => ({
  id,
  history: { list: async () => null, changedRefs: async () => null, item: async () => null, scan: async () => null, restored: () => undefined, ...history },
});
const fakeRegistry = (...adapters) => ({
  all: () => adapters.map((adapter) => ({ adapter, location: null })),
  adapter: (id) => adapters.find((adapter) => adapter.id === id),
});
const idsOf = (projects) => projects.flatMap((project) => project.sessions.map((session) => session.sessionId));
const sessionIn = (projects, sessionId) => projects.flatMap((project) => project.sessions).find((session) => session.sessionId === sessionId);
const rejectsWith = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};

// --- 11a. vaultOnlySessions, pura ---
{
  const states = new Map([['claude-code', 'listed'], ['codex', 'unreadable'], ['opencode', 'missing']]);
  const idA = '11a00001-0000-4000-8000-000000001101';
  check('11 nativa y copia del mismo par -> una sola, la nativa',
    vaultOnlySessions([nativeOf('claude-code', idA, 'C:\\x')], [vaultSummary({ sessionId: idA })], states, true).length === 0);
  const [only] = vaultOnlySessions([], [vaultSummary({ sessionId: idA, partial: true })], states, true);
  check('11 copia sin nativa con listed -> sale con storage vault, el partial de la cabecera y sin archivar',
    only?.summary.storage === 'vault' && only.summary.partial === true && only.summary.archived === false &&
    only.cwd === 'C:\\proyectos\\demo' && only.agent === 'claude-code' && only.summary.title === 'Probemos la copia', show(only));
  check('11 con unreadable -> no', vaultOnlySessions([], [vaultSummary({ agent: 'codex' })], states, true).length === 0);
  check('11 con missing -> si', vaultOnlySessions([], [vaultSummary({ agent: 'opencode' })], states, true).length === 1);
  check('11 una CLI sin estado en el mapa cuenta como missing', vaultOnlySessions([], [vaultSummary({ agent: 'antigravity' })], states, true).length === 1);
  check('11 importada -> si, aunque todas las CLIs esten ilegibles',
    vaultOnlySessions([], [vaultSummary({ agent: 'gemini-cli', cwd: '', group: 'Gemini CLI · carpeta desconocida' })],
      new Map([['claude-code', 'unreadable'], ['codex', 'unreadable']]), true).length === 1);
  check('11 ready false -> nada', vaultOnlySessions([], [vaultSummary(), vaultSummary({ agent: 'gemini-cli' })], states, false).length === 0);
  check('11 la misma copia dos veces -> una', vaultOnlySessions([], [vaultSummary(), vaultSummary()], states, true).length === 1);
  check('11 el mismo id en otra CLI no la tapa', vaultOnlySessions([nativeOf('codex', UUID, 'C:\\x')], [vaultSummary()], states, true).length === 1);

  const withCwd = vaultSummary({ agent: 'gemini-cli', sessionId: 'g1', cwd: 'C:\\proyectos\\gemini', group: 'compartido' });
  const withoutCwd = vaultSummary({ agent: 'gemini-cli', sessionId: 'g2', cwd: '', group: 'compartido' });
  const projects = buildProjects(vaultOnlySessions([], [withCwd, withoutCwd], states, true), 'win32');
  const orphan = projects.find((project) => project.sessions.some((session) => session.sessionId === 'g2'));
  check('11 buildProjects no le hereda a una copia el cwd de otra, aunque la cabecera diga el mismo grupo',
    projects.length === 2 && orphan?.cwd === '' && orphan.key === 'unknown:gemini-cli:compartido' && orphan.fallbackName === 'compartido',
    show(projects.map(({ key, cwd, sessions }) => ({ key, cwd, ids: sessions.map((s) => s.sessionId) }))));
  const native = nativeOf('claude-code', 'n1', 'C:\\proyectos\\nativo', 'C--proyectos-nativo');
  const copyInGroup = vaultSummary({ sessionId: 'c1', cwd: '', group: 'C--proyectos-nativo' });
  const merged = buildProjects([native, ...vaultOnlySessions([native], [copyInGroup], states, true)], 'win32');
  check('11 una copia sin cwd con el agrupador de la nativa cae en el proyecto de la nativa',
    merged.length === 1 && merged[0].sessions.length === 2 && merged[0].cwd === 'C:\\proyectos\\nativo', show(merged));
}

// --- 11b. El estado de cada list() ---
{
  const items = [{ ref: 'r', sessionId: 's', group: 'g', mtimeMs: 1, sizeBytes: 1 }];
  const states = [
    await nativeListState({}, { items, threw: false }),
    await nativeListState({}, { items: null, threw: false }),
    await nativeListState({}, { items: null, threw: true }),
    await nativeListState({ rootExists: async () => true }, { items: null, threw: false }),
    await nativeListState({ rootExists: async () => false }, { items: null, threw: true }),
    await nativeListState({ rootExists: async () => { throw new Error('x'); } }, { items: null, threw: false }),
  ];
  check('11 nativeListState: lista -> listed; null -> missing; lanzo -> unreadable; rootExists true -> unreadable, false -> missing, lanza -> unreadable',
    same(states, ['listed', 'missing', 'unreadable', 'unreadable', 'missing', 'unreadable']), show(states));
}

// --- 11c. El indice real con el catalogo ---
{
  const dir = path.join(root, 'copia-indice');
  const existingCwd = path.join(root, 'proyectos', 'demo-indice-copia');
  await mkdir(existingCwd, { recursive: true });
  const idClaude = '11c00001-0000-4000-8000-000000001111';
  const idCodex = '11c00002-0000-4000-8000-000000001112';
  const idGemini = '11c00003-0000-4000-8000-000000001113';
  await writeCopy(dir, 'claude-code', idClaude, { cwd: existingCwd, title: 'Probemos una copia de Claude Code' });
  await writeCopy(dir, 'codex', idCodex, { cwd: path.join(root, 'no-existe') });
  await writeCopy(dir, 'gemini-cli', idGemini, {
    cwd: '', group: 'Gemini CLI · carpeta desconocida', source: { kind: 'import', importer: 'gemini-cli-chats', importedAt: 1 },
  });
  const catalog = new VaultCatalog();
  await catalog.load(dir);

  // C3: ningun historial nativo.
  const index = new VaultIndex(fakeRegistry(fakeAdapter('claude-code'), fakeAdapter('codex')), { has: (id) => id === idCodex }, catalog);
  check('11 sin escanear, getProjects no trae copias', index.getProjects().length === 0);
  const emitted = [];
  index.on('projects', (projects, replace) => emitted.push({ projects, replace }));
  await index.scan();
  const last = emitted.at(-1);
  check('11 C3 sin ningun historial nativo: la emision final trae las copias, no un [] literal',
    index.getStatus().state === 'ready' && last?.replace === true && [idClaude, idCodex, idGemini].every((id) => idsOf(last.projects).includes(id)),
    show(emitted.map((entry) => ({ replace: entry.replace, ids: idsOf(entry.projects) }))));
  const projects = index.getProjects();
  const claudeProject = projects.find((project) => project.sessions.some((session) => session.sessionId === idClaude));
  const codexProject = projects.find((project) => project.sessions.some((session) => session.sessionId === idCodex));
  const geminiProject = projects.find((project) => project.sessions.some((session) => session.sessionId === idGemini));
  check('11 las copias salen con storage vault', projects.flatMap((project) => project.sessions).every((session) => session.storage === 'vault'));
  check('11 cwdExists de las copias: la carpeta que existe si, la que no, no',
    claudeProject?.cwdExists === true && codexProject?.cwdExists === false, show([claudeProject?.cwdExists, codexProject?.cwdExists]));
  check('11 una copia archivada sale marcada, como las nativas', sessionIn(projects, idCodex)?.archived === true && sessionIn(projects, idClaude)?.archived === false);
  check('11 la importada sin carpeta cae en su agrupador',
    geminiProject?.key === 'unknown:gemini-cli:Gemini CLI · carpeta desconocida' && geminiProject.fallbackName === 'Gemini CLI · carpeta desconocida', show(geminiProject));
  index.dispose();

  // Raiz presente e ilegible: las copias de esa CLI no se muestran; las demas, si.
  const busy = new VaultIndex(fakeRegistry(fakeAdapter('claude-code', { rootExists: async () => true }), fakeAdapter('codex')), undefined, catalog);
  await busy.scan();
  const busyIds = idsOf(busy.getProjects());
  check('11 raiz ilegible (rootExists true): su copia no sale como copia; la de otra CLI y la importada, si',
    !busyIds.includes(idClaude) && busyIds.includes(idCodex) && busyIds.includes(idGemini), show(busyIds));
  busy.dispose();

  // Un list() que lanza no se lleva el escaneo, y la sesion nativa gana sobre su copia.
  const nativeCodex = fakeAdapter('codex', {
    list: async () => [{ ref: 'ref-indice-codex', sessionId: idCodex, group: 'g-codex', mtimeMs: 5, sizeBytes: 7 }],
    scan: async () => ({ cwd: existingCwd, summary: { sessionId: idCodex, title: 'Nativa de Codex', titleSource: 'first-message', updatedAt: 5, sizeBytes: 7 }, extra: {} }),
  });
  const throwing = fakeAdapter('claude-code', { list: async () => { throw new Error('carpeta ilegible de prueba'); } });
  const mixed = new VaultIndex(fakeRegistry(throwing, nativeCodex), undefined, catalog);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  let scanError;
  try {
    scanError = await rejectsWith(mixed.scan());
  } finally {
    console.warn = originalWarn;
  }
  const mixedProjects = mixed.getProjects();
  const codexRows = mixedProjects.flatMap((project) => project.sessions).filter((session) => session.sessionId === idCodex);
  check('11 un list() que lanza: el escaneo llega a ready y esa CLI queda ilegible (su copia no sale)',
    scanError === null && mixed.getStatus().state === 'ready' && !idsOf(mixedProjects).includes(idClaude), show([scanError?.message, idsOf(mixedProjects)]));
  check('11 nativa y copia del mismo par en el indice: una fila, la nativa',
    codexRows.length === 1 && codexRows[0].storage === 'native' && codexRows[0].title === 'Nativa de Codex', show(codexRows));
  mixed.dispose();

  // Durante el escaneo no hay copias; la emision final si.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slowId = '11c00004-0000-4000-8000-000000001114';
  const slow = fakeAdapter('codex', {
    list: async () => [{ ref: 'ref-indice-lento', sessionId: slowId, group: 'g-lento', mtimeMs: 9, sizeBytes: 9 }],
    scan: async () => {
      await gate;
      return { cwd: existingCwd, summary: { sessionId: slowId, title: 'Lenta', titleSource: 'first-message', updatedAt: 9, sizeBytes: 9 }, extra: {} };
    },
  });
  const slowIndex = new VaultIndex(fakeRegistry(fakeAdapter('claude-code'), slow), undefined, catalog);
  const scanning = slowIndex.scan();
  const reachedScanning = await waitFor(() => slowIndex.getStatus().state === 'scanning');
  check('11 durante el escaneo, getProjects no trae copias', reachedScanning && !idsOf(slowIndex.getProjects()).some((id) => [idClaude, idGemini].includes(id)));
  release();
  await scanning;
  check('11 al terminar el escaneo, si', idsOf(slowIndex.getProjects()).includes(idClaude) && idsOf(slowIndex.getProjects()).includes(slowId));
  slowIndex.dispose();

  /*
    El catalogo cambia: el indice listo reemite **solo si cambio lo que las
    copias ponen en la barra** (R28-5). La pasada escribe sobre todo sesiones
    con nativa, y cada aviso era la barra entera a cada ventana. Cada caso que
    no debe emitir va seguido de uno que si: la emision que se espera es la
    prueba de que el aviso anterior ya se proceso.
  */
  let codexListed = true;
  const liveCodex = fakeAdapter('codex', {
    list: async () => (codexListed ? [{ ref: 'ref-indice-vivo', sessionId: idCodex, group: 'g-codex', mtimeMs: 5, sizeBytes: 7 }] : []),
    scan: nativeCodex.history.scan,
  });
  const live = new VaultIndex(fakeRegistry(fakeAdapter('claude-code'), liveCodex), undefined, catalog);
  await live.scan();
  const replaced = [];
  live.on('projects', (list, replace) => {
    if (replace) replaced.push(idsOf(list));
  });
  let catalogChanges = 0;
  const stopCounting = catalog.onChange(() => {
    catalogChanges += 1;
  });
  const settle = async () => {
    for (let n = 0; n < 5; n += 1) await turn();
  };

  // La pasada reescribe la copia de una sesion que tiene nativa: el catalogo avisa, la barra no cambia.
  await writeCopy(dir, 'codex', idCodex, { cwd: path.join(root, 'no-existe'), title: 'Codex reescrita por la pasada', writtenAt: 1_700_000_700_000 });
  await catalog.refresh('codex', idCodex);
  await settle();
  const twinChanges = catalogChanges;
  const idNew = '11c00005-0000-4000-8000-000000001115';
  await writeCopy(dir, 'claude-code', idNew, { cwd: existingCwd });
  await catalog.refresh('claude-code', idNew);
  const sawNew = await waitFor(() => replaced.some((ids) => ids.includes(idNew)));
  await settle();
  check('11 reescribir la copia de una sesion con nativa no reemite la barra; una copia nueva sin nativa, una vez',
    twinChanges === 1 && sawNew && replaced.length === 1 && replaced[0].includes(idNew), show({ twinChanges, replaced }));

  // Recargar el catalogo igual: nada. Con algo nuevo en disco (un importador): si.
  replaced.length = 0;
  await catalog.load(dir);
  await settle();
  const idLoaded = '11c00006-0000-4000-8000-000000001116';
  await writeCopy(dir, 'claude-code', idLoaded, { cwd: existingCwd });
  await catalog.load(dir);
  const sawLoaded = await waitFor(() => replaced.some((ids) => ids.includes(idLoaded)));
  await settle();
  check('11 recargar el catalogo sin cambios no reemite; con una copia nueva en disco, una vez',
    sawLoaded && replaced.length === 1, show(replaced));

  // Una emision por un cambio nativo tambien cuenta como la ultima barra enviada.
  codexListed = false;
  await live.scan();
  const codexAsCopy = idsOf(live.getProjects()).includes(idCodex);
  replaced.length = 0;
  await rm(vaultPaths.sessionFile(dir, 'codex', idCodex));
  await catalog.load(dir);
  const sawGone = await waitFor(() => replaced.some((ids) => !ids.includes(idCodex)));
  check('11 la nativa se va (la copia pasa a verse), y despues la copia tambien: se reemite sin ella',
    codexAsCopy && sawGone, show({ codexAsCopy, replaced }));

  stopCounting();
  live.dispose();
  const afterDispose = replaced.length;
  await writeCopy(dir, 'claude-code', '11c00007-0000-4000-8000-000000001117', { cwd: existingCwd });
  await catalog.load(dir);
  await settle();
  check('11 despues de dispose, el catalogo ya no hace reemitir', replaced.length === afterDispose, show([afterDispose, replaced.length]));
}

// ---------------------------------------------------------------------------
// 12. Markdown, abrir una fila "copia" y exportar
// ---------------------------------------------------------------------------

const markdown = await import('../src/vault/markdown.ts');
const { VaultService, VaultError, STATUS_INTERVAL_MS } = await import('../src/vault/service.ts');

/** Los bloques de codigo de un Markdown, leidos como los lee un visor (CommonMark). */
function fenceBlocks(text) {
  const blocks = [];
  let open = null;
  let current = [];
  for (const line of text.split('\n')) {
    if (open === null) {
      const match = /^(~{3,}|`{3,})\s*$/.exec(line);
      if (match) {
        open = match[1];
        current = [];
      }
      continue;
    }
    const closing = new RegExp(`^${open[0] === '~' ? '~' : '`'}{${open.length},}\\s*$`);
    if (closing.test(line)) {
      blocks.push(current.join('\n'));
      open = null;
    } else {
      current.push(line);
    }
  }
  return { blocks, unclosed: open !== null };
}
/** Los enlaces `(<...>)` de un Markdown. */
const linksIn = (text) => [...text.matchAll(/\]\(<([^>]+)>\)/g)].map((match) => match[1]);

// --- 12a. renderSessionMarkdown, puro ---
{
  const { renderSessionMarkdown, renderProjectIndex, fenced, formatDuration } = markdown;
  const RESULT = 'antes\n```\ncodigo de prueba\n```\n~~~~~\ndespues';
  const INPUT = '{\n  "command": "echo ~~~~ y ```"\n}';
  const asset = `${'b'.repeat(32)}.png`;
  const lines = [
    {
      kind: 'event',
      event: event({ eventId: 'm-u1', parts: [
        { kind: 'text', text: 'Probemos el Markdown', truncated: false },
        { kind: 'image', index: 0, mediaType: 'image/png', source: 'content' },
        { kind: 'image', index: 1, mediaType: 'image/png', source: 'content' },
      ] }),
      images: [imageRef({ asset }), imageRef({ index: 1, asset: null })],
    },
    {
      kind: 'event',
      event: event({
        eventId: 'm-a1', role: 'assistant', model: 'modelo-de-prueba', effort: 'high', durationMs: 110_000, at: 1_700_000_160_000,
        parts: [
          { kind: 'thinking' },
          { kind: 'text', text: 'Corro un comando.', truncated: false },
          { kind: 'tool-call', toolUseId: 't1', name: 'Bash', input: INPUT, truncated: false },
          { kind: 'tool-result', toolUseId: 't1', text: RESULT, isError: true, truncated: true, imageCount: 0 },
          { kind: 'question', toolUseId: 'q1', questions: [{ question: '¿Seguimos con la prueba?', header: 'Seguir', multiSelect: false,
            options: [{ label: 'Sí', description: 'Continuar' }, { label: 'No', description: '' }] }] },
          { kind: 'notice', notice: 'compacted', detail: '' },
        ],
      }),
      images: [],
    },
    { kind: 'event', event: event({ eventId: 'm-a2', role: 'assistant', parts: [{ kind: 'thinking' }] }), images: [] },
    { kind: 'document', origin: 'agent-document', name: 'plan.md', modifiedAt: 1_700_000_000_000, text: '# Plan de prueba', truncated: false },
  ];
  const partialHeader = header({ title: 'Probemos el Markdown', partial: true, stepCount: 42, documentCount: 1 });
  const text = renderSessionMarkdown(partialHeader, lines, {
    agentLabel: 'Claude Code',
    assetLink: (name) => `../../sessions/claude-code/${UUID}.assets/${name}`,
    fromCopy: true,
  });
  const { blocks, unclosed } = fenceBlocks(text);
  check('12 un resultado con ``` y ~~~~~ adentro queda entero dentro de su cerca', blocks.includes(RESULT) && !unclosed, show(blocks));
  check('12 la entrada de la herramienta, tambien', blocks.includes(INPUT), show(blocks));
  check('12 fenced: la cerca crece con la racha mas larga de tildes', fenced('a ~~~~~~~ b').startsWith('~~~~~~~~\n') && fenced('sin tildes').startsWith('~~~~\n'));
  check('12 enlace relativo de la imagen copiada, e "imagen no copiada" para la que no tiene asset',
    text.includes(`![imagen 1](<../../sessions/claude-code/${UUID}.assets/${asset}>)`) && text.includes('_imagen no copiada_'));
  check('12 partial: la ficha avisa con los pasos y los documentos',
    text.includes('> Historial parcial: la conversación original tenía 42 pasos') && text.includes('Se conservan la ficha y un documento.'));
  check('12 encabezado del asistente con modelo, esfuerzo y duracion',
    /^## Asistente · (\d\d-\d\d-\d{4} )?\d\d:\d\d · modelo-de-prueba · high · 1 min 50 s$/m.test(text), text.split('\n').filter((line) => line.startsWith('## ')).join(' | '));
  check('12 resultado con error y recortado, pregunta con sus opciones, aviso como cita',
    text.includes('**Resultado** (error) (recortado)') && text.includes('**Pregunta:** ¿Seguimos con la prueba?') &&
    text.includes('- Sí — Continuar') && /^- No$/m.test(text) && text.includes('> Contexto compactado.'));
  check('12 un turno que solo razono no deja seccion', (text.match(/^## Asistente/gm) ?? []).length === 1);
  check('12 los documentos van al final, bajo su titulo',
    text.indexOf('## Documentos') > text.indexOf('Contexto compactado') && text.includes('### plan.md\n') && text.includes('# Plan de prueba'));
  check('12 la ficha: titulo, CLI, sesion y copiada', text.startsWith('# Probemos el Markdown\n') && text.includes(`- CLI: Claude Code · sesión \`${UUID}\``) && text.includes('- Copiada el '));
  check('12 formatDuration', formatDuration(110_027) === '1 min 50 s' && formatDuration(45_000) === '45 s' && formatDuration(7_500_000) === '2 h 5 min');

  const webNotice = await import('../../web/src/conversation-notice.ts');
  const parts = [{ notice: 'compacted', detail: 'auto' }, { notice: 'interrupted', detail: '' }, { notice: 'error', detail: 'APIError: sin saldo' }];
  check('12 noticeText vive en shared y la web dice lo mismo',
    parts.every((part) => shared.noticeText(part) === webNotice.noticeText(part)) && shared.noticeText(parts[0]) === 'Contexto compactado automáticamente');

  const index = renderProjectIndex({
    name: 'demo', cwd: 'C:\\proyectos\\demo', exportedAt: 1_700_000_000_000, skipped: 1,
    entries: [
      { updatedAt: 1_700_000_000_000, agentLabel: 'Codex', title: 'Vieja', fileName: 'vieja.md', onlyInCopy: false, partial: false },
      { updatedAt: 1_700_000_900_000, agentLabel: 'Claude Code', title: 'Uno [x]', fileName: '2026-09-14 Uno _x_ [claude-code] 12345678.md', onlyInCopy: true, partial: true },
    ],
  });
  const indexOk = index.indexOf('Uno') < index.indexOf('Vieja') &&
    index.includes('[Uno \\[x\\]](<2026-09-14 Uno _x_ [claude-code] 12345678.md>) · copia · parcial') && index.includes('Una sesión no se pudo exportar');
  check('12 indice del proyecto: de la mas reciente a la mas vieja, corchetes escapados, marcas y lo que no se exporto',
    indexOk, indexOk ? '' : show(index));

  const { sanitizeFileName } = vaultPaths;
  check('12 sanitizeFileName CON, a:b*? y 200 caracteres',
    sanitizeFileName('CON') === '_CON' && sanitizeFileName('a:b*?') === 'a_b__' && sanitizeFileName('x'.repeat(200)).length === 80);
}

// --- 12b. Abrir una fila "copia" y exportar un proyecto ---
{
  const cwd = path.join(root, 'proyectos', 'demo-exportar');
  const idA = '12a00001-0000-4000-8000-000000001201';
  const idB = '12b00002-0000-4000-8000-000000001202';
  const idC = '12c00003-0000-4000-8000-000000001203';
  const idD = '12d00004-0000-4000-8000-000000001204';
  const png = pngOf('exportar');
  await writeClaudeSession(cwd, idA, [userLine('x-u1', [{ type: 'text', text: 'Probemos exportar' }, imageBlock(png)]), assistantLine('x-a1', 'Exportemos.')]);
  const fileB = await writeClaudeSession(cwd, idB, [userLine('x-u2', 'Probemos la que cambia')]);
  await writerIndex.scan();

  const dir = path.join(root, 'copia-exportar');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const firstPass = await writerFor({ index: indexView(cwd), catalog }).pass();
  check('12 preparacion: la pasada copia A y B', firstPass?.written === 2, show(firstPass));

  await appendFile(fileB, claudeRecord(cwd, assistantLine('x-a2', 'Respuesta que la copia no tiene todavia.')));
  await utimes(fileB, minutesAgo(5), minutesAgo(5));
  await writeClaudeSession(cwd, idC, [userLine('x-u3', 'Probemos una archivada')]);
  await writeCopy(dir, 'claude-code', idD, { cwd, title: 'Probemos una que solo esta en la copia' });
  await catalog.refresh('claude-code', idD);
  const copyB = vaultPaths.sessionFile(dir, 'claude-code', idB);
  const copyBMtime = await mtimeOf(copyB);
  const copyBSource = catalog.header('claude-code', idB)?.source;

  const archived = new Set([idC]);
  const index = new VaultIndex(writerRegistry, archived, catalog);
  await index.scan();
  const project = index.getProjects().find((candidate) => candidate.cwd === cwd);
  check('12 el proyecto tiene las cuatro, D como copia y C archivada',
    project?.sessions.length === 4 && sessionIn([project], idD)?.storage === 'vault' && sessionIn([project], idC)?.archived === true,
    show(project?.sessions.map(({ sessionId, storage, archived: isArchived }) => ({ sessionId, storage, isArchived }))));

  const revealed = [];
  const store = new settingsModule.SettingsStore(path.join(root, 'ajustes-exportar', 'settings.json'));
  await store.load();
  await store.update({ vault: { dir } });
  const service = new VaultService({
    agents: writerRegistry, index, archived, settings: store, catalog, platform: process.platform, homeDir: home,
    reveal: (target) => revealed.push(target), log: quiet,
  });

  const result = await service.exportProject(project.key);
  const folder = vaultPaths.projectExportDirFor(dir, project, process.platform);
  const names = (await namesIn(folder)).sort();
  const fileOf = (id) => names.find((name) => name.includes(`[claude-code] ${id.slice(0, 8)}`));
  const textOf = async (id) => readFile(path.join(folder, fileOf(id)), 'utf8');
  check('12 exportar: cuatro sesiones y el indice, con nombres <fecha> <titulo> [<cli>] <id8>.md',
    result.sessions === 4 && result.skipped === 0 && result.folder === folder && names.length === 5 && names.includes('index.md') &&
    names.filter((name) => name !== 'index.md').every((name) => /^\d{4}-\d{2}-\d{2} .+ \[claude-code\] [0-9a-f]{8}\.md$/.test(name)), show({ result, names }));
  const textA = await textOf(idA);
  const linksA = linksIn(textA);
  check('12 A esta al dia en la copia: sale de ahi, y el enlace de su imagen llega al asset',
    textA.includes('- Copiada el ') && linksA.length === 1 && (await fileExists(path.resolve(folder, linksA[0]))), show(linksA));
  const textB = await textOf(idB);
  check('12 B cambio: se lee del historial, con lo nuevo', textB.includes('Leída del historial') && textB.includes('Respuesta que la copia no tiene todavia.'));
  check('12 exportar no escribe la copia: la de B no se toco y C (archivada) no se copio',
    (await mtimeOf(copyB)) === copyBMtime && same(catalog.header('claude-code', idB)?.source, copyBSource) &&
    !(await fileExists(vaultPaths.sessionFile(dir, 'claude-code', idC))) && catalog.header('claude-code', idC) === null);
  check('12 la archivada se exporta igual: exportar es explicito', (await textOf(idC)).includes('Probemos una archivada'));
  const indexText = await readFile(path.join(folder, 'index.md'), 'utf8');
  const indexLinks = linksIn(indexText);
  const indexLinksOk = indexLinks.length === 4 && (await Promise.all(indexLinks.map((link) => fileExists(path.join(folder, link))))).every(Boolean) &&
    indexText.includes(`${fileOf(idD)}>) · copia`);
  check('12 el indice enlaza las cuatro, y cada enlace llega a su archivo; D marcada copia', indexLinksOk, indexLinksOk ? '' : show(indexLinks));
  check('12 exportar abre la carpeta', revealed.at(-1) === folder, show(revealed));
  const again = await service.exportProject(project.key);
  check('12 exportar dos veces reescribe los mismos archivos', again.sessions === 4 && (await namesIn(folder)).length === 5);
  const unknownProject = await rejectsWith(service.exportProject('unknown:nope:nada'));
  check('12 un proyecto que no esta -> VaultError', unknownProject instanceof VaultError, show(unknownProject?.message));

  const opened = await service.openSession('claude-code', idA);
  const openedText = await readFile(opened, 'utf8');
  const openedLinks = linksIn(openedText);
  check('12 abrir una fila copia: export/sesiones/<agent>-<id>.md, abierto, con el enlace de la imagen que llega al asset',
    opened === vaultPaths.sessionExportFile(dir, 'claude-code', idA) && revealed.at(-1) === opened && openedLinks.length === 1 &&
    (await fileExists(path.resolve(path.dirname(opened), openedLinks[0]))), show(openedLinks));
  check('12 abrir la de D (solo en la copia)', (await readFile(await service.openSession('claude-code', idD), 'utf8')).includes('Probemos una que solo esta en la copia'));
  const missing = await rejectsWith(service.openSession('claude-code', idC));
  check('12 una sesion que no esta en la copia -> "Esa sesión no está en la copia." y nada escrito',
    missing instanceof VaultError && es(missing.text) === 'Esa sesión no está en la copia.' &&
    !(await fileExists(vaultPaths.sessionExportFile(dir, 'claude-code', idC))), show(missing?.message));
  await service.reveal();
  check('12 abrir la carpeta de la copia', revealed.at(-1) === dir);
  service.dispose();
  index.dispose();

  // Con la copia apagada y sin carpeta: exporta leyendo el historial y no crea una copia.
  const emptyDir = path.join(root, 'copia-exportar-vacia');
  const emptyCatalog = new VaultCatalog();
  await emptyCatalog.load(emptyDir);
  const emptyIndex = new VaultIndex(writerRegistry, archived, emptyCatalog);
  await emptyIndex.scan();
  const emptyStore = new settingsModule.SettingsStore(path.join(root, 'ajustes-exportar-vacia', 'settings.json'));
  await emptyStore.load();
  const offService = new VaultService({
    agents: writerRegistry, index: emptyIndex, archived, settings: emptyStore, catalog: emptyCatalog, platform: process.platform,
    homeDir: home, reveal: (target) => revealed.push(target), log: quiet,
  });
  const notYet = await rejectsWith(offService.reveal());
  check('12 abrir la carpeta sin copia -> "Todavía no hay copia."', notYet instanceof VaultError && es(notYet.text) === 'Todavía no hay copia.', show(notYet?.message));
  const emptyProject = emptyIndex.getProjects().find((candidate) => candidate.cwd === cwd);
  const offResult = await offService.exportProject(emptyProject.key);
  const offFolder = vaultPaths.projectExportDirFor(emptyDir, emptyProject, process.platform);
  const offNames = await namesIn(offFolder);
  const offA = offNames.find((name) => name.includes(idA.slice(0, 8)));
  check('12 con la copia apagada exporta del historial, sin imagenes, y no crea vault.json ni sessions/',
    offResult.sessions === 3 && offA !== undefined && (await readFile(path.join(offFolder, offA), 'utf8')).includes('_imagen no copiada_') &&
    !(await fileExists(vaultPaths.vaultMarkerFile(emptyDir))) && !(await fileExists(path.join(emptyDir, 'sessions'))) && !emptyStore.get().vault.enabled,
    show({ offResult, offNames }));
  offService.dispose();
  emptyIndex.dispose();
}

// ---------------------------------------------------------------------------
// 13. Mudar la copia y el servicio
// ---------------------------------------------------------------------------

const moveModule = await import('../src/vault/move.ts');
const { DirectoryPickers } = await import('../src/directory-picker.ts');

// --- 13a. moveVault ---
{
  const { moveVault } = moveModule;
  const from = path.join(root, 'mudanza-origen');
  const to = path.join(root, 'mudanza-destino');
  const idOne = '13a00001-0000-4000-8000-000000001301';
  const idTwo = '13a00002-0000-4000-8000-000000001302';
  const agentDir = (base) => path.join(base, 'sessions', 'claude-code');
  const assetName13 = `${'c'.repeat(32)}.png`;
  const noteFile = path.join(from, 'memory', 'demo-12345678', 'nota.md');
  await mkdir(path.join(agentDir(from), `${idOne}.assets`), { recursive: true });
  await mkdir(path.dirname(noteFile), { recursive: true });
  await mkdir(path.join(from, 'export', 'sesiones'), { recursive: true });
  await mkdir(agentDir(to), { recursive: true });
  const originFiles = {
    [path.join(from, 'vault.json')]: '{"format":1,"createdAt":1}\n',
    [path.join(agentDir(from), `${idOne}.jsonl`)]: 'sesion uno del origen\n',
    [path.join(agentDir(from), `${idOne}.assets`, assetName13)]: 'bytes de imagen',
    [path.join(agentDir(from), `${idTwo}.jsonl`)]: 'sesion dos del origen\n',
    [noteFile]: '# Nota de prueba\n',
    [path.join(from, 'export', 'sesiones', 'x.md')]: '# exportado\n',
    [path.join(agentDir(from), `${idOne}.jsonl.123.abcdefabcdef.tmp`)]: 'temporal a medias',
  };
  for (const [file, content] of Object.entries(originFiles)) await writeFile(file, content);
  const old = new Date(Date.UTC(2026, 0, 2, 3, 4, 5));
  await utimes(noteFile, old, old);
  await writeFile(path.join(agentDir(to), `${idTwo}.jsonl`), 'sesion dos que ya estaba en el destino\n');

  const result = await moveVault(from, to);
  check('13 moveVault: copia lo que falta y cuenta lo que ya estaba', result.copied === 4 && result.skipped === 1, show(result));
  check('13 moveVault: no pisa un archivo existente distinto',
    (await readFile(path.join(agentDir(to), `${idTwo}.jsonl`), 'utf8')) === 'sesion dos que ya estaba en el destino\n');
  check('13 moveVault: sesiones, assets, vault.json y memoria en el destino',
    (await readFile(path.join(agentDir(to), `${idOne}.jsonl`), 'utf8')) === 'sesion uno del origen\n' &&
    (await fileExists(path.join(agentDir(to), `${idOne}.assets`, assetName13))) && (await fileExists(path.join(to, 'vault.json'))) &&
    (await fileExists(path.join(to, 'memory', 'demo-12345678', 'nota.md'))));
  check('13 moveVault: la nota conserva su fecha (la pasada no la reescribe)',
    Math.abs((await mtimeOf(path.join(to, 'memory', 'demo-12345678', 'nota.md'))) - old.getTime()) < 2000);
  check('13 moveVault: export/ y los temporales no se mudan',
    !(await fileExists(path.join(to, 'export'))) && !(await namesIn(agentDir(to))).some((name) => name.endsWith('.tmp')), show(await namesIn(agentDir(to))));
  const intact = await Promise.all(Object.entries(originFiles).map(async ([file, content]) => (await readFile(file, 'utf8').catch(() => null)) === content));
  check('13 moveVault: no borra ni cambia nada del origen', intact.every(Boolean), show(intact));
}

// --- 13b. Que carpetas se rechazan ---
{
  const { checkVaultTarget, canWriteInto } = moveModule;
  const win = { protectedDirs: ['C:\\Users\\prueba\\.CLAUDE'], platform: 'win32' };
  const kinds = [
    checkVaultTarget('D:\\Copia', 'copia-relativa', win),
    checkVaultTarget('D:\\Copia', 'c:\\users\\prueba\\.claude\\adentro', win),
    checkVaultTarget('D:\\Copia', 'd:\\copia\\', win),
    checkVaultTarget('D:\\Copia', 'D:\\Copia\\sub', win),
    checkVaultTarget('D:\\Datos\\copia', 'D:\\Datos', win),
    checkVaultTarget('D:\\Copia', 'D:\\Copia2', win),
    checkVaultTarget('D:\\Copia', 'E:\\Sync\\copia', win),
    checkVaultTarget('/home/u/copia', '/home/u/Copia', { protectedDirs: [], platform: 'linux' }),
  ].map((check13) => check13.kind);
  check('13 checkVaultTarget: relativa, protegida (sin importar mayusculas), misma, destino dentro, origen dentro, hermana con prefijo, otra unidad, posix con mayusculas',
    same(kinds, ['refused', 'refused', 'same', 'refused', 'refused', 'ok', 'ok', 'ok']), show(kinds));
  const probeDir = path.join(root, 'mudanza-escribible');
  check('13 canWriteInto: una carpeta escribible si, y no deja el temporal', (await canWriteInto(probeDir)) && (await namesIn(probeDir)).length === 0, show(await namesIn(probeDir)));
  const aFile = path.join(root, 'mudanza-archivo.txt');
  await writeFile(aFile, 'no soy carpeta');
  check('13 canWriteInto: debajo de un archivo no', !(await canWriteInto(path.join(aFile, 'sub'))));
}

/** Un indice de mentira para el servicio: listo, sin sesiones salvo las que se le pongan. */
function fakeServiceIndex() {
  const index = new EventEmitter();
  index.state = 'ready';
  index.natives = [];
  index.getStatus = () => ({ state: index.state, scannedFiles: 0, totalFiles: 0 });
  index.nativeSessions = () => index.natives;
  index.getProjects = () => [];
  return index;
}
/** Ajustes en memoria que cuentan las escrituras. */
function memorySettings(vault = {}) {
  let current = { version: 1, vault: { enabled: false, dir: null, toolResultMaxChars: 64_000, ...vault } };
  const store = {
    updates: 0,
    get: () => current,
    update: async (patch) => {
      store.updates += 1;
      current = { version: 1, vault: { ...current.vault, ...(patch.vault ?? {}) } };
    },
  };
  return store;
}
const serviceAgents = (protectedDirs = []) => ({ adapter: () => ({ history: {} }), get: () => null, protectedDirs: () => protectedDirs });

// --- 13c. Mudanza desde el servicio ---
{
  const oldDir = path.join(root, 'mudanza-servicio-vieja');
  const newDir = path.join(root, 'mudanza-servicio-nueva');
  const id = '13c00001-0000-4000-8000-000000001311';
  await writeCopy(oldDir, 'claude-code', id, { title: 'Probemos la mudanza' });
  const store = new settingsModule.SettingsStore(path.join(root, 'ajustes-mudanza', 'settings.json'));
  await store.load();
  await store.update({ vault: { dir: oldDir } });
  const catalog = new VaultCatalog();
  await catalog.load(oldDir);
  const service = new VaultService({
    agents: serviceAgents(), index: fakeServiceIndex(), archived: noneArchived, settings: store, catalog, platform: process.platform,
    homeDir: home, reveal: () => undefined, log: quiet, timers: fakeTimers(),
  });
  await service.setDir(newDir);
  check('13 mudar: ajuste, catalogo y archivos en la carpeta nueva; previousDir dice la vieja',
    store.get().vault.dir === newDir && catalog.getDir() === newDir && catalog.header('claude-code', id) !== null &&
    service.status().previousDir === oldDir && service.status().dir === newDir && service.status().state === 'off', show(service.status()));
  check('13 mudar: la carpeta vieja queda intacta', (await fileExists(vaultPaths.sessionFile(oldDir, 'claude-code', id))) && (await fileExists(vaultPaths.vaultMarkerFile(oldDir))));
  const variant = process.platform === 'win32' ? `${newDir.toUpperCase()}\\` : newDir;
  await service.setDir(variant);
  check('13 mudar a la misma carpeta (otra forma de escribirla): nada', store.get().vault.dir === newDir);

  let release;
  const holding = service.writer.exclusive('moving', () => new Promise((resolve) => { release = resolve; }));
  const busyMove = await rejectsWith(service.setDir(path.join(root, 'mudanza-otra')));
  const busyOpen = await rejectsWith(service.openSession('claude-code', id));
  check('13 con una mudanza en curso: mudar y abrir se rechazan con VaultError',
    busyMove instanceof VaultError && es(busyMove.text).includes('ocupada') && busyOpen instanceof VaultError, show([busyMove?.message, busyOpen?.message]));
  release?.();
  await holding.catch(() => undefined);
  service.dispose();
}

// --- 13d. Un selector parado en una carpeta protegida ---
{
  const protectedDir = path.join(home, '.cli-protegida-de-prueba');
  const inside = path.join(protectedDir, 'adentro');
  await mkdir(inside, { recursive: true });
  const settings = memorySettings();
  const catalog = new VaultCatalog();
  const startDir = path.join(root, 'copia-selector');
  await catalog.load(startDir);
  const service = new VaultService({
    agents: serviceAgents([protectedDir]), index: fakeServiceIndex(), archived: noneArchived, settings, catalog, platform: process.platform,
    homeDir: home, reveal: () => undefined, log: quiet, timers: fakeTimers(),
  });
  // El selector de la app no deja entrar ahi; este no conoce la carpeta, para probar que el servicio la rechaza igual.
  const pickers = new DirectoryPickers([]);
  const listing = await pickers.open();
  await pickers.enter(listing.pickerId, path.basename(protectedDir));
  await pickers.enter(listing.pickerId, 'adentro');
  const refused = await rejectsWith(service.setDirFromPicker(pickers, listing.pickerId));
  check('13 vault.setDir con el selector dentro de una carpeta protegida: rechazado sin escribir nada',
    refused instanceof VaultError && settings.updates === 0 && (await namesIn(inside)).length === 0 && catalog.getDir() === startDir,
    show([refused?.message, pickers.currentPath(listing.pickerId), await namesIn(inside)]));
  const geminiDir = path.join(home, '.gemini', 'adentro');
  await mkdir(geminiDir, { recursive: true });
  const gemini = await rejectsWith(service.setDir(geminiDir));
  check('13 ~/.gemini tampoco', gemini instanceof VaultError && settings.updates === 0 && (await namesIn(geminiDir)).length === 0, show(gemini?.message));
  const closed = await rejectsWith(service.setDirFromPicker(pickers, 'selector-que-no-existe'));
  check('13 un selector que no esta abierto -> VaultError', closed instanceof VaultError && es(closed.text) === 'Ese selector ya no está abierto.');
  pickers.closeAll();
  service.dispose();
}

// --- 13e. El servicio: encender, medir, estado espaciado y pasadas solo por cambios nativos ---
{
  const dir = path.join(root, 'copia-servicio');
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  let clock = 1_000_000;
  const timers = fakeTimers();
  const index = fakeServiceIndex();
  const settings = memorySettings();
  const archived = new Set();
  const service = new VaultService({
    agents: serviceAgents(), index, archived, settings, catalog, platform: process.platform, homeDir: home,
    reveal: () => undefined, log: quiet, timers, now: () => clock,
  });
  const statuses = [];
  service.onStatus((status) => statuses.push(status));
  service.start();

  const refused = await rejectsWith(service.setEnabled(true));
  check('13 encender sin medir y sin sesiones de una pasada: VaultError con el motivo, sin tocar los ajustes',
    refused instanceof VaultError && refused.text === MEASURE_FIRST_TEXT && settings.updates === 0 && !settings.get().vault.enabled, show(refused?.message));
  index.state = 'scanning';
  const early = await rejectsWith(service.measure());
  check('13 medir con el indice sin terminar: VaultError', early instanceof VaultError, show(early?.message));
  index.state = 'ready';
  const measureError = await rejectsWith(service.measure());
  check('13 medir con el indice listo y nada en curso', measureError === null && service.status().measurement !== null, show(measureError?.message));
  const wireStatus = plain(service.status());
  const wireOk = sameShape(shared.parseVaultStatus(wireStatus), wireStatus) && wireStatus.state === 'off' && wireStatus.dir === vaultPaths.defaultVaultDir();
  check('13 el estado que sale por el socket (con medicion) lo lee el parser del cliente', wireOk, wireOk ? '' : show(wireStatus));
  // Lo que dejo pendiente la medicion sale, y pasa el intervalo: el proximo aviso es inmediato.
  clock += STATUS_INTERVAL_MS;
  for (const handle of timers.active()) if (handle.ms <= STATUS_INTERVAL_MS) timers.fire(handle);
  clock += STATUS_INTERVAL_MS;

  statuses.length = 0;
  const handlesBefore = timers.handles.length;
  await service.setEnabled(false);
  const firstCount = statuses.length;
  await catalog.load(dir);
  await catalog.load(dir);
  const throttle = timers.handles.slice(handlesBefore).filter((handle) => handle.ms <= STATUS_INTERVAL_MS && !handle.cleared);
  check('13 estado: el primero sale ya; los siguientes dentro de 500 ms esperan uno solo',
    firstCount === 1 && statuses.length === 1 && throttle.length === 1 && throttle[0].ms === STATUS_INTERVAL_MS, show({ firstCount, statuses: statuses.length, throttle: throttle.map((h) => h.ms) }));
  clock += STATUS_INTERVAL_MS;
  if (throttle[0] !== undefined) timers.fire(throttle[0]);
  check('13 estado: al vencer sale el ultimo', statuses.length === 2 && statuses[1]?.state === 'off');

  const debounces = () => timers.handles.filter((handle) => handle.ms === PASS_DEBOUNCE_MS).length;
  await service.setEnabled(true);
  check('13 encender con medicion: ajuste escrito y una pasada enseguida',
    settings.get().vault.enabled === true && (await waitFor(() => service.writer.snapshot().lastPassAt !== null)), show(service.writer.snapshot()));
  await waitFor(() => service.writer.snapshot().activity === 'idle');
  const baseDebounces = debounces();
  index.emit('projects', [], true);
  check('13 el indice reemite sin cambios nativos (p. ej. porque la copia escribio): no pide pasada', debounces() === baseDebounces);
  index.natives = [nativeOf('claude-code', '13e00001-0000-4000-8000-000000001321', 'C:\\x')];
  index.emit('projects', [], true);
  check('13 una sesion nativa nueva: pide una pasada', debounces() === baseDebounces + 1);
  index.emit('projects', [], false);
  index.emit('projects', [], true);
  check('13 una emision parcial, o la misma otra vez: nada', debounces() === baseDebounces + 1);
  archived.add('13e00001-0000-4000-8000-000000001321');
  index.emit('projects', [], true);
  check('13 archivar (o restaurar) cambia lo que se copia: pide pasada', debounces() === baseDebounces + 2);
  await service.setEnabled(false);
  index.natives = [];
  index.emit('projects', [], true);
  check('13 con la copia apagada, las emisiones no piden pasadas', debounces() === baseDebounces + 2);
  service.dispose();
}

// --- 13f. Mudar a una carpeta con una copia vieja: la memoria del escritor no la da por buena (R28-3) ---
{
  const { moveVault } = moveModule;
  const cwd = path.join(root, 'proyectos', 'demo-mudanza-vieja');
  const id = '13f00001-0000-4000-8000-000000001331';
  const file = await writeClaudeSession(cwd, id, [userLine('mv-u1', 'Probemos la version uno')]);
  await writerIndex.scan();
  const dirB = path.join(root, 'copia-mudanza-b');
  const dirA = path.join(root, 'copia-mudanza-a');
  const catalog = new VaultCatalog();
  await catalog.load(dirB);
  const writer = writerFor({ index: indexView(cwd), catalog });
  const inB = vaultPaths.sessionFile(dirB, 'claude-code', id);

  const first = await writer.pass();
  const oldText = await readFile(inB, 'utf8');
  await appendFile(file, claudeRecord(cwd, userLine('mv-u2', 'Y la version dos')));
  await utimes(file, minutesAgo(5), minutesAgo(5));
  await writerIndex.scan();
  await moveVault(dirB, dirA);
  await catalog.load(dirA);
  const inA = await writer.pass();
  check('13 mudanza de ida: B con la version vieja, A con la nueva',
    first?.written === 1 && inA?.written === 1 && catalog.header('claude-code', id)?.eventCount === 2, show({ first, inA }));

  const back = await moveVault(dirA, dirB);
  await catalog.load(dirB);
  const stale = catalog.header('claude-code', id)?.eventCount;
  const afterBack = await writer.pass();
  const item = await writerClaude.history.item(file);
  check('13 volver a B, que conserva la copia vieja: la pasada del mismo escritor la reescribe con la huella del origen',
    back.skipped > 0 && stale === 1 && afterBack?.written === 1 && afterBack.unchanged === 0 &&
    catalog.header('claude-code', id)?.eventCount === 2 && catalog.header('claude-code', id)?.source.mtimeMs === item.mtimeMs,
    show({ back, stale, afterBack }));

  // Un sincronizador que devuelve la version vieja, y ⟳ relee el catalogo.
  await writeFile(inB, oldText);
  await catalog.load(dirB);
  const restored = await writer.pass();
  check('13 una version vieja del .jsonl que vuelve a la carpeta, releida: la pasada siguiente la reescribe',
    restored?.written === 1 && catalog.header('claude-code', id)?.eventCount === 2, show(restored));
  const settled = await writer.pass();
  check('13 ... y con la copia al dia, la siguiente ya no escribe', settled?.written === 0 && settled.unchanged === 1, show(settled));
}

// --- 13g. Importar antes de encender no habilita "Activar" sin medir (R28-2) ---
{
  const vui = await import('../../web/src/vault-ui.ts');
  const dir = path.join(root, 'copia-importada-antes');
  const importedId = '13g00001-0000-4000-8000-000000001341';
  // Lo mismo que deja `pnpm vault:import … --write`: writeSessionFile con fuente importada, que escribe vault.json.
  await writeCopy(dir, 'gemini-cli', importedId, {
    cwd: '', group: 'Gemini CLI · carpeta desconocida', source: { kind: 'import', importer: 'gemini-cli-chats', importedAt: 1 },
  });
  const catalog = new VaultCatalog();
  await catalog.load(dir);
  const settings = memorySettings({ dir });
  const service = new VaultService({
    agents: serviceAgents(), index: fakeServiceIndex(), archived: noneArchived, settings, catalog, platform: process.platform,
    homeDir: home, reveal: () => undefined, log: quiet, timers: fakeTimers(),
  });
  const importedStatus = service.status();
  const refused = await rejectsWith(service.setEnabled(true));
  check('13 carpeta con vault.json y solo sesiones importadas: encender sin medir se rechaza y la web no ofrece "Activar"',
    (await fileExists(vaultPaths.vaultMarkerFile(dir))) && importedStatus.sessions === 1 && importedStatus.passSessions === 0 &&
    vui.vaultActivateOffer(importedStatus) === 'needs-measure' &&
    refused instanceof VaultError && refused.text === MEASURE_FIRST_TEXT && settings.updates === 0,
    show({ importedStatus, refused: refused?.message }));

  const nativeId = '13g00002-0000-4000-8000-000000001342';
  await writeCopy(dir, 'claude-code', nativeId, { title: 'Probemos una copiada por una pasada' });
  await catalog.refresh('claude-code', nativeId);
  const copiedStatus = service.status();
  const accepted = await rejectsWith(service.setEnabled(true));
  check('13 con una sesion que escribio una pasada: "Activar" sin medir, en la web y en el servidor',
    copiedStatus.passSessions === 1 && vui.vaultActivateOffer(copiedStatus) === 'existing' && accepted === null && settings.get().vault.enabled === true,
    show({ copiedStatus, accepted: accepted?.message }));
  service.dispose();
}

writerClaude.dispose();
writerCodex.dispose();

// ---------------------------------------------------------------------------
// 14. Importadores de un solo uso
// ---------------------------------------------------------------------------

const vaultFixtures = await import('./fixtures/vault-fixtures.mjs');
const geminiImport = await import('../src/vault/importers/gemini-cli.ts');
const rescueImport = await import('../src/vault/importers/antigravity-ide.ts');
const importCommand = await import('../src/vault/importers/command.ts');
const { UNTITLED_SESSION_TITLE } = await import('../src/agents/session-title.ts');
const importSqlite = (await import('../src/agents/sqlite.ts')).loadSqlite();

/** Un home aparte del de los casos anteriores: el de Antigravity CLI (2e) ya tiene su `~/.gemini`. */
const importRoot = path.join(root, 'importadores');
const importHome = path.join(importRoot, 'home');
const importGemini = path.join(importHome, '.gemini');
const importTemp = path.join(importRoot, 'tmp');
const IMPORT_NOW = 1_800_000_000_000;

/** Los archivos de una carpeta, recursivo, relativos. [] si no existe. */
async function filesUnder(dir) {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath ?? entry.path, entry.name)))
    .sort();
}
/** Las copias de la base que dejo el rescate en la temporal. */
const rescueLeftovers = async () => (await namesIn(importTemp)).filter((name) => name.startsWith('rescue-'));
const stampOfFile = async (file) => {
  const info = await stat(file);
  return { size: info.size, mtimeMs: info.mtimeMs };
};

// --- 14a. Gemini CLI: el fixture ---
const GEMINI_CWD = 'D:\\Proyecto Demo';
const GEMINI_HASH = createHash('sha256').update(GEMINI_CWD).digest('hex');
const OTHER_GEMINI_HASH = createHash('sha256').update('C:\\otra carpeta de prueba').digest('hex');
const GID = {
  notices: 'a1a1a1a1-0000-4000-8000-000000001401',
  noReply: 'a1a1a1a1-0000-4000-8000-000000001402',
  tools: 'a1a1a1a1-0000-4000-8000-000000001403',
  unknown: 'a1a1a1a1-0000-4000-8000-000000001404',
};
const gt = (day, minute) => `2026-01-${String(day).padStart(2, '0')}T10:${String(minute).padStart(2, '0')}:00.000Z`;
const BIG_TOOL_OUTPUT = inventedText(70_000, 'Salida');
{
  const { geminiChat, geminiMessage, writeGeminiChat } = vaultFixtures;
  await writeGeminiChat(importGemini, GEMINI_HASH, 'session-2026-01-10T10-00-a1.json', geminiChat({
    sessionId: GID.notices, projectHash: GEMINI_HASH, startTime: gt(10, 0), lastUpdated: gt(10, 1),
    messages: [geminiMessage('n1', 'info', gt(10, 0), { content: 'Arrancando' }), geminiMessage('n2', 'info', gt(10, 1), { content: 'Cancelado' })],
  }));
  await writeGeminiChat(importGemini, GEMINI_HASH, 'session-2026-01-11T10-00-b2.json', geminiChat({
    sessionId: GID.noReply, projectHash: GEMINI_HASH, startTime: gt(11, 0), lastUpdated: gt(11, 2),
    messages: [
      geminiMessage('r1', 'user', gt(11, 0), { content: 'Probemos la conexion del proyecto de prueba' }),
      geminiMessage('r2', 'info', gt(11, 2), { content: 'Solicitud cancelada' }),
    ],
  }));
  await writeGeminiChat(importGemini, GEMINI_HASH, 'session-2026-01-12T10-00-c3.json', geminiChat({
    sessionId: GID.tools, projectHash: GEMINI_HASH, startTime: gt(12, 0), lastUpdated: gt(12, 9),
    messages: [
      geminiMessage('t1', 'user', gt(12, 0), { content: 'Revisá los dos archivos de configuracion de prueba' }),
      geminiMessage('t2', 'gemini', gt(12, 1), {
        model: 'gemini-demo-pro',
        thoughts: [{ subject: 'SECRETO-THOUGHT', description: 'SECRETO-THOUGHT razonamiento de prueba', timestamp: gt(12, 1) }],
        tokens: { input: 1000, output: 50, cached: 400, thoughts: 10, tool: 0, total: 1060 },
        toolCalls: [
          {
            id: 'call-1', name: 'read_file', args: { path: 'config/a.json' }, status: 'success', timestamp: gt(12, 1),
            result: [{ functionResponse: { id: 'call-1', name: 'read_file', response: { output: BIG_TOOL_OUTPUT } } }],
            resultDisplay: 'DISPLAY-QUE-NO-SE-USA', displayName: 'ReadFile', description: '', renderOutputAsMarkdown: false,
          },
          {
            id: 'call-2', name: 'read_file', args: { path: 'config/b.json' }, status: 'error', timestamp: gt(12, 2),
            result: [{ functionResponse: { id: 'call-2', name: 'read_file', response: { output: 'No existe el archivo de prueba' } } }, { text: 'detalle del error' }],
            resultDisplay: 'DISPLAY-QUE-NO-SE-USA', displayName: 'ReadFile', description: '', renderOutputAsMarkdown: false,
          },
        ],
      }),
      geminiMessage('t3', 'gemini', gt(12, 8), {
        content: 'Listo, revisé los dos archivos.', model: 'gemini-demo-pro',
        tokens: { input: 1500, output: 80, cached: 1200, thoughts: 0, tool: 0, total: 1580 },
        toolCalls: [{ id: 'call-3', name: 'list_directory', args: { dir: '.' }, status: 'success', result: [], resultDisplay: 'Listado mostrado' }],
      }),
      geminiMessage('t4', 'info', gt(12, 9), { content: 'Sesion guardada' }),
    ],
  }));
  await writeGeminiChat(importGemini, GEMINI_HASH, 'session-2026-01-13T10-00-rota.json', '{ esto no es json');
  await writeGeminiChat(importGemini, OTHER_GEMINI_HASH, 'session-2026-01-14T10-00-d4.json', geminiChat({
    sessionId: GID.unknown, projectHash: OTHER_GEMINI_HASH, startTime: gt(14, 0), lastUpdated: gt(14, 1),
    messages: [
      geminiMessage('u1', 'user', gt(14, 0), { content: 'Armemos el entorno de prueba' }),
      geminiMessage('u2', 'gemini', gt(14, 1), { content: 'Hecho.', model: 'gemini-demo-flash', tokens: { input: 10, output: 2, cached: 0, thoughts: 0, tool: 0, total: 12 } }),
    ],
  }));
  // El mismo sessionId que el chat sin respuesta, mas viejo: gana el otro.
  await writeGeminiChat(importGemini, OTHER_GEMINI_HASH, 'session-2026-01-01T10-00-e5.json', geminiChat({
    sessionId: GID.noReply, projectHash: OTHER_GEMINI_HASH, startTime: gt(1, 0), lastUpdated: gt(1, 1),
    messages: [geminiMessage('v1', 'user', gt(1, 0), { content: 'Version vieja del mismo chat' })],
  }));
  // Lo que vive al lado de los chats y no se abre nunca.
  const hashDir = path.join(importGemini, 'tmp', GEMINI_HASH);
  await writeFile(path.join(hashDir, 'logs.json'), JSON.stringify([{ message: 'SECRETO-LOGS' }]));
  await writeFile(path.join(hashDir, '.project_root'), 'SECRETO-PROJECT-ROOT');
  await writeFile(path.join(hashDir, 'chats', 'session-2026-01-15.jsonl'), `${JSON.stringify({ sessionId: 'b0b0b0b0-0000-4000-8000-000000001499', messages: [{ id: 'x', type: 'user', content: 'SECRETO-JSONL' }] })}\n`);
  await writeFile(path.join(hashDir, 'chats', 'notas.json'), JSON.stringify({ sessionId: 'b0b0b0b0-0000-4000-8000-000000001498', messages: [{ id: 'x', type: 'user', content: 'SECRETO-NOTAS' }] }));
}

// --- 14b. Gemini CLI: el plan y el mapeo ---
{
  const { matchProjectHash, cwdHashVariants, planGeminiCliImport, geminiSessionFiles, GEMINI_UNKNOWN_GROUP } = geminiImport;
  check('14 gemini: el hash casa con la carpeta tal cual, con la unidad en minuscula y en mayuscula',
    matchProjectHash(GEMINI_HASH, [GEMINI_CWD]) === GEMINI_CWD && matchProjectHash(GEMINI_HASH, ['d:\\Proyecto Demo']) === 'd:\\Proyecto Demo' &&
    matchProjectHash(GEMINI_HASH.toUpperCase(), ['d:\\Proyecto Demo']) === 'd:\\Proyecto Demo');
  check('14 gemini: nada mas que eso (C17): ni la barra final, ni otra carpeta, ni un hash sin forma',
    matchProjectHash(GEMINI_HASH, ['D:\\Proyecto Demo\\', 'C:\\otra']) === '' && matchProjectHash('xyz', [GEMINI_CWD]) === '' &&
    same(cwdHashVariants('/home/demo'), ['/home/demo']) && same(cwdHashVariants('d:\\x'), ['d:\\x', 'D:\\x']), show(cwdHashVariants('d:\\x')));

  const plan = await planGeminiCliImport({ geminiHome: importGemini, cwdCandidates: ['C:\\no-casa', 'd:\\Proyecto Demo'] });
  const byId = new Map(plan.chats.map((chat) => [chat.sessionId, chat]));
  check('14 gemini: encontrados los seis session-*.json (ni el .jsonl ni notas.json)', plan.found === 6, show(plan.found));
  check('14 gemini: se importan el sin respuesta, el de herramientas y el de otra carpeta',
    same([...byId.keys()].sort(), [GID.noReply, GID.tools, GID.unknown].sort()), show([...byId.keys()]));
  check('14 gemini: se saltan el de solo avisos, el roto y el duplicado mas viejo',
    sameShape(plan.skipped, { 'only-notices': 1, unreadable: 1, duplicate: 1 }), show(plan.skipped));
  check('14 gemini: --cwd con la unidad en minuscula casa, y queda como lo dio el usuario',
    plan.matchedCwd === 2 && byId.get(GID.tools)?.cwd === 'd:\\Proyecto Demo' && byId.get(GID.noReply)?.cwd === 'd:\\Proyecto Demo' && byId.get(GID.unknown)?.cwd === '');

  const noReply = byId.get(GID.noReply);
  check('14 gemini: el sin respuesta es un solo evento del usuario, del archivo mas nuevo, sin medidor',
    noReply?.events.length === 1 && noReply.events[0].role === 'user' && noReply.events[0].parts[0]?.text === 'Probemos la conexion del proyecto de prueba' &&
    noReply.usage === null && noReply.title === 'Probemos la conexion del proyecto de prueba' && noReply.titleSource === 'first-message' &&
    noReply.createdAt === Date.parse(gt(11, 0)) && noReply.updatedAt === Date.parse(gt(11, 2)), show(noReply));

  const tools = byId.get(GID.tools);
  const [userEvent, callsEvent, finalEvent] = tools?.events ?? [];
  check('14 gemini: tres eventos (usuario y dos del asistente); los info no', tools?.events.length === 3 &&
    userEvent?.role === 'user' && userEvent.eventId === 't1' && callsEvent?.role === 'assistant' && finalEvent?.role === 'assistant', show(tools?.events.map((e) => [e.eventId, e.role])));
  check('14 gemini: cada llamada y su resultado en el mismo evento, en orden',
    same(callsEvent?.parts.map((part) => [part.kind, part.toolUseId]), [['tool-call', 'call-1'], ['tool-result', 'call-1'], ['tool-call', 'call-2'], ['tool-result', 'call-2']]),
    show(callsEvent?.parts.map((part) => part.kind)));
  const [call1, result1, call2, result2] = callsEvent?.parts ?? [];
  check('14 gemini: la entrada es el JSON de args indentado, entero',
    call1?.name === 'read_file' && call1.input === JSON.stringify({ path: 'config/a.json' }, null, 2) && call1.truncated === false && call2?.input?.includes('config/b.json') === true);
  check('14 gemini: un resultado de 70 000 caracteres queda en 64 000 con truncated; resultDisplay no se usa si hay salida',
    result1?.text?.length === 64_000 && result1.truncated === true && result1.isError === false && result1.text === BIG_TOOL_OUTPUT.slice(0, 64_000), show([result1?.text?.length, result1?.truncated]));
  check('14 gemini: salidas y text del array unidos con salto de linea; status distinto de success es error',
    result2?.text === 'No existe el archivo de prueba\ndetalle del error' && result2.isError === true && result2.truncated === false, show(result2));
  check('14 gemini: sin salida, el resultado es resultDisplay; el texto del asistente va antes de sus llamadas',
    same(finalEvent?.parts.map((part) => part.kind), ['text', 'tool-call', 'tool-result']) && finalEvent.parts[0].text === 'Listo, revisé los dos archivos.' &&
    finalEvent.parts[2].text === 'Listado mostrado' && finalEvent.parts[2].isError === false, show(finalEvent?.parts));
  check('14 gemini: tokens por evento (input incluye lo cacheado) y modelo, sin esfuerzo',
    sameShape(callsEvent?.usage, { inputTokens: 600, outputTokens: 50, cacheReadInputTokens: 400, cacheCreationInputTokens: 0 }) &&
    callsEvent.model === 'gemini-demo-pro' && callsEvent.effort === null && finalEvent?.usage?.inputTokens === 300, show(callsEvent?.usage));
  check('14 gemini: el medidor de la cabecera es el del ultimo paso con tokens y los acumulados (C15)',
    sameShape(tools?.usage, {
      lastRequestTokens: 1500, lastOutputTokens: 80, lastModel: 'gemini-demo-pro', contextWindow: null, contextWindowEstimated: false,
      totalInputTokens: 900, totalOutputTokens: 130, totalCacheReadTokens: 1600, assistantMessages: 2,
    }), show(tools?.usage));
  check('14 gemini: el razonamiento no se guarda', !JSON.stringify(plan).includes('SECRETO-THOUGHT') && !JSON.stringify(plan).includes('DISPLAY-QUE-NO-SE-USA'));
  check('14 gemini: nada de lo que vive al lado de los chats', !JSON.stringify(plan).includes('SECRETO'));

  const files = geminiSessionFiles(plan, IMPORT_NOW);
  const headers = new Map(files.map((file) => [file.header.sessionId, file.header]));
  const allParse = files.every((file) => {
    const lines = file.text.trimEnd().split('\n').map((line) => JSON.parse(line));
    return shared.parseVaultHeader(lines[0]) !== null && lines.slice(1).every((line) => shared.parseVaultBodyLine(line) !== null) && lines.length === 1 + file.header.eventCount;
  });
  check('14 gemini: las sesiones se leen con los parsers de la copia', files.length === 3 && allParse);
  check('14 gemini: cabecera importada, sin carpeta va al grupo "carpeta desconocida"',
    headers.get(GID.unknown)?.group === GEMINI_UNKNOWN_GROUP && headers.get(GID.unknown)?.cwd === '' &&
    headers.get(GID.tools)?.group === `vault:gemini-cli:${GID.tools}` && headers.get(GID.tools)?.agent === 'gemini-cli' &&
    sameShape(headers.get(GID.tools)?.source, { kind: 'import', importer: 'gemini-cli-chats', importedAt: IMPORT_NOW }) &&
    headers.get(GID.tools)?.partial === false && headers.get(GID.tools)?.cliVersionAtCopy === null && headers.get(GID.tools)?.usage?.lastRequestTokens === 1500,
    show(headers.get(GID.unknown)));

  const tiny = await planGeminiCliImport({ geminiHome: importGemini, cwdCandidates: [], maxFileBytes: 64 });
  check('14 gemini: un archivo de mas del tope no se lee', tiny.chats.length === 0 && sameShape(tiny.skipped, { 'too-large': 5, unreadable: 1 }), show(tiny.skipped));
  const nowhere = await planGeminiCliImport({ geminiHome: path.join(importRoot, 'sin-gemini'), cwdCandidates: [] });
  check('14 gemini: sin ~/.gemini/tmp no hay nada que importar ni falla', nowhere.found === 0 && nowhere.chats.length === 0);
}

// --- 14c. Antigravity IDE: el fixture ---
const RID = (n) => `0f0e0d0c-0b0a-4908-8706-0000000014${String(n).padStart(2, '0')}`;
const RESCUE_WORKSPACE = 'D:\\demo-rescate';
const rescueDb = path.join(importGemini, 'antigravity-cli', 'conversation_summaries.db');
const rescueBrain = path.join(importGemini, 'antigravity', 'brain');
const GRANDE = `${'a'.repeat(1024 * 1024 - 1)}ñ y esto ya no entra`;
{
  const { summaryRow, writeSummariesDb } = vaultFixtures;
  await writeSummariesDb(importSqlite, rescueDb, [
    summaryRow(RID(1), { preview: 'Plan Del Instalador', step_count: 120, last_modified_time: '2026-02-11 09:15:00.1234567+00:00', workspace_uris: '["file:///d%3A/demo-rescate"]' }),
    summaryRow(RID(2), { preview: '', step_count: 30, last_modified_time: '0001-01-01 00:00:00+00:00', workspace_uris: '["file:///d:/demo-rescate"]' }),
    summaryRow(RID(3), { preview: 'Subcarpeta', step_count: 5, workspace_uris: '["file:///d%3A/demo-rescate/sub"]' }),
    summaryRow(RID(4), { preview: 'Otra Carpeta', step_count: 9, workspace_uris: '["file:///d%3A/otra-carpeta"]' }),
    summaryRow(RID(5), { preview: 'De La CLI', step_count: 4, workspace_uris: '["file:///d%3A/demo-rescate"]', app_data_dir: 'antigravity-cli' }),
    summaryRow(RID(6), { preview: 'Sin Carpeta', step_count: 2, workspace_uris: '' }),
    summaryRow('id-sin-forma-de-uuid', { preview: 'Id Raro', step_count: 1, workspace_uris: '["file:///D:/demo-rescate"]' }),
    summaryRow(RID(8), { preview: 'Nombre Parecido', step_count: 6, workspace_uris: '["file:///d%3A/demo-rescate-2"]' }),
    summaryRow(RID(9), { preview: 'Dos Carpetas', step_count: 7, last_modified_time: '2026-05-07 18:00:00+00:00', workspace_uris: '["file:///c%3A/otra","file:///d%3A/Demo-Rescate/"]' }),
  ]);

  const put = async (id, name, content, when) => {
    const file = path.join(rescueBrain, id, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
    if (when !== undefined) await utimes(file, new Date(when), new Date(when));
  };
  await put(RID(1), 'walkthrough.md', '# Recorrido de prueba\n\nPrimero se instala.', '2026-02-09T10:00:00Z');
  await put(RID(1), 'plan.md', '# Plan de prueba del instalador\n\nPaso 1: probar.', '2026-02-10T10:00:00Z');
  await put(RID(1), 'grande.md', GRANDE, '2026-02-11T08:00:00Z');
  await put(RID(1), 'foto.png', 'SECRETO-PNG');
  await put(RID(1), 'plan.md.resolved', 'SECRETO-RESOLVED');
  await put(RID(1), 'plan.md.resolved.0', 'SECRETO-RESOLVED-0');
  await put(RID(1), 'plan.md.metadata.json', '{"s":"SECRETO-METADATA"}');
  await put(RID(1), path.join('sub', 'anidado.md'), 'SECRETO-SUBCARPETA');
  await put(RID(2), 'diagnostico.md', '# Diagnostico de prueba', '2026-04-01T12:00:00Z');
  await put(RID(4), 'otro.md', 'SECRETO-OTRA-CARPETA');
  await put(RID(5), 'cli.md', 'SECRETO-DE-LA-CLI');
  await mkdir(path.join(importGemini, 'antigravity', 'conversations'), { recursive: true });
  await writeFile(path.join(importGemini, 'antigravity', 'conversations', `${RID(1)}.pb`), 'SECRETO-PB');
  // brain/<RID(9)> es una junction hacia afuera de brain/: no se sigue.
  const outside = path.join(importRoot, 'afuera-de-brain');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'robado.md'), 'SECRETO-JUNCTION');
  const linked = await symlink(outside, path.join(rescueBrain, RID(9)), 'junction').then(() => true, () => false);
  check('14 rescate: la junction de prueba existe y lleva afuera', linked && (await fileExists(path.join(rescueBrain, RID(9), 'robado.md'))));
}

// --- 14d. Antigravity IDE: el plan ---
{
  const { planAntigravityRescue, rescuedSessionFiles, RescueError } = rescueImport;
  const besideBefore = await namesIn(path.dirname(rescueDb));
  const dbBefore = await stampOfFile(rescueDb);
  check('14 rescate: la base del fixture quedo en WAL y cerrada: sin -wal ni -shm', same(besideBefore, ['conversation_summaries.db']), show(besideBefore));

  const plan = await planAntigravityRescue({ workspace: RESCUE_WORKSPACE, geminiHome: importGemini, platform: 'win32', now: () => IMPORT_NOW, tempRoot: importTemp });
  const byId = new Map(plan.conversations.map((conversation) => [conversation.conversationId, conversation]));
  check('14 rescate: casan solo las filas del IDE de esa carpeta, con las dos formas de URI y alguna de varias',
    same([...byId.keys()].sort(), [RID(1), RID(2), RID(9)]), show([...byId.keys()]));
  check('14 rescate: ni subcarpeta, ni otra carpeta, ni nombre parecido, ni sin carpeta (la fila de la CLI ni se cuenta)',
    plan.otherRows === 4 && plan.invalidIds === 1, show({ otherRows: plan.otherRows, invalidIds: plan.invalidIds }));
  check('14 rescate: pasos sumados y rango de fechas de la base', plan.steps === 157 &&
    plan.range?.from === Date.parse('2026-02-11T09:15:00.1234567+00:00') && plan.range?.to === Date.parse('2026-05-07T18:00:00+00:00'), show([plan.steps, plan.range]));

  const one = byId.get(RID(1));
  check('14 rescate: los .md del primer nivel, por fecha; ni imagenes, ni .resolved, ni metadata, ni subcarpetas',
    same(one?.documents.map((document) => document.name), ['walkthrough.md', 'plan.md', 'grande.md']), show(one?.documents.map((d) => d.name)));
  const grande = one?.documents.find((document) => document.name === 'grande.md');
  check('14 rescate: un .md de mas de 1 MB entra con su primer MB, sin cortar un caracter y con truncated',
    grande?.truncated === true && grande.text.length === 1024 * 1024 - 1 && !grande.text.includes('\uFFFD') && grande.bytes === Buffer.byteLength(GRANDE),
    show([grande?.text.length, grande?.truncated]));
  check('14 rescate: titulo del preview (ai), fecha de la base con espacio, creada con el .md mas viejo',
    one?.title === 'Plan Del Instalador' && one.titleSource === 'ai' && one.stepCount === 120 &&
    one.updatedAt === Date.parse('2026-02-11T09:15:00.1234567+00:00') && one.createdAt === Date.parse('2026-02-09T10:00:00Z'), show(one && { ...one, documents: undefined }));
  const two = byId.get(RID(2));
  check('14 rescate: sin preview y sin fecha en la base: sin titulo, y la fecha del .md',
    two?.title === UNTITLED_SESSION_TITLE && two.titleSource === 'none' && two.updatedAt === Date.parse('2026-04-01T12:00:00Z') && two.lastModifiedAt === 0,
    show(two && { ...two, documents: undefined }));
  const nine = byId.get(RID(9));
  check('14 rescate: una brain/<id> que es una junction hacia afuera no se lee', nine?.documents.length === 0 && nine.createdAt === null);
  check('14 rescate: documentos contados', plan.documents === 4 && plan.conversationsWithDocuments === 2 &&
    plan.documentBytes === one.documents.reduce((sum, document) => sum + document.bytes, 0) + two.documents[0].bytes, show([plan.documents, plan.conversationsWithDocuments, plan.documentBytes]));
  check('14 rescate: nada de lo que no es un .md de esas conversaciones, ni el raw_summary', !JSON.stringify(plan).includes('SECRETO'));

  const beside = await namesIn(path.dirname(rescueDb));
  const dbAfter = await stampOfFile(rescueDb);
  check('14 rescate: la base original conserva tamano y fecha, y no le aparecen -wal ni -shm',
    sameShape(dbAfter, dbBefore) && same(beside, ['conversation_summaries.db']), show({ dbBefore, dbAfter, beside }));
  check('14 rescate: la carpeta temporal no queda', (await rescueLeftovers()).length === 0, show(await namesIn(importTemp)));

  const files = rescuedSessionFiles(plan, IMPORT_NOW);
  const headerOne = files.find((file) => file.header.sessionId === RID(1))?.header;
  const bodyOne = files.find((file) => file.header.sessionId === RID(1))?.text.trimEnd().split('\n').slice(1).map((line) => shared.parseVaultBodyLine(JSON.parse(line)));
  check('14 rescate: cada conversacion es una sesion parcial, sin eventos, con sus documentos al final',
    files.length === 3 && headerOne?.agent === 'antigravity-ide' && headerOne.partial === true && headerOne.stepCount === 120 && headerOne.cwd === RESCUE_WORKSPACE &&
    headerOne.eventCount === 0 && headerOne.documentCount === 3 && headerOne.usage === null &&
    sameShape(headerOne.source, { kind: 'import', importer: 'antigravity-ide-rescue', importedAt: IMPORT_NOW }) &&
    same(bodyOne?.map((line) => [line?.kind, line?.origin, line?.name]), [['document', 'agent-document', 'walkthrough.md'], ['document', 'agent-document', 'plan.md'], ['document', 'agent-document', 'grande.md']]),
    show(headerOne));

  // Lo que no se puede: sin node:sqlite, sin base, y una base de otro formato.
  const noSqlite = await planAntigravityRescue({
    workspace: RESCUE_WORKSPACE, geminiHome: importGemini, platform: 'win32', now: () => IMPORT_NOW, tempRoot: importTemp,
    sqlite: () => ({ unavailable: 'node-too-old' }),
  }).then(() => null, (error) => error);
  check('14 rescate: sin node:sqlite, un error claro y nada en la temporal',
    noSqlite instanceof RescueError && noSqlite.message.includes('node:sqlite') && (await rescueLeftovers()).length === 0, show(noSqlite?.message));
  const noDb = await planAntigravityRescue({ workspace: RESCUE_WORKSPACE, geminiHome: path.join(importRoot, 'sin-gemini'), platform: 'win32', now: () => IMPORT_NOW, tempRoot: importTemp })
    .then(() => null, (error) => error);
  check('14 rescate: sin la base, un error que dice cual falta', noDb instanceof RescueError && noDb.message.includes('conversation_summaries.db'), show(noDb?.message));
  const oldHome = path.join(importRoot, 'home-formato-viejo', '.gemini');
  await vaultFixtures.writeSummariesDb(importSqlite, path.join(oldHome, 'antigravity-cli', 'conversation_summaries.db'),
    [{ conversation_id: RID(1), step_count: 1, last_modified_time: '2026-02-11 09:15:00+00:00', workspace_uris: '["file:///d%3A/demo-rescate"]', app_data_dir: 'antigravity' }],
    vaultFixtures.CREATE_SUMMARIES_WITHOUT_PREVIEW);
  const schema = await planAntigravityRescue({ workspace: RESCUE_WORKSPACE, geminiHome: oldHome, platform: 'win32', now: () => IMPORT_NOW, tempRoot: importTemp })
    .then(() => null, (error) => error);
  check('14 rescate: una base sin una columna que se lee no se lee, dice cual, y borra la temporal',
    schema instanceof RescueError && schema.message.includes('preview') && (await rescueLeftovers()).length === 0, show(schema?.message));
}

// --- 14e. pnpm vault:import ---
const importVault = path.join(importRoot, 'copia');
const importSettings = path.join(importRoot, 'settings.json');
await writeFile(importSettings, JSON.stringify({ version: 1, vault: { enabled: false, dir: importVault, toolResultMaxChars: 64_000 } }));
async function runImport(argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await importCommand.runVaultImport(argv, {
    out: (line) => out.push(line), err: (line) => err.push(line),
    homeDir: importHome, platform: 'win32', now: () => IMPORT_NOW, settingsPath: importSettings, tempRoot: importTemp, ...extra,
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
{
  const { collapseBackslashes, parseImportArgs } = importCommand;
  const usage = await Promise.all([
    runImport([]),
    runImport(['opencode']),
    runImport(['gemini-cli', '--cwd', 'relativo\\x']),
    runImport(['gemini-cli', '--workspace', RESCUE_WORKSPACE]),
    runImport(['antigravity-ide']),
    runImport(['antigravity-ide', '--workspace', RESCUE_WORKSPACE, '--cwd', GEMINI_CWD]),
    runImport(['gemini-cli', '--cwd']),
    runImport(['gemini-cli', '--borrar']),
  ]);
  check('14 script: sin importador, uno desconocido, rutas relativas, opciones cruzadas o sin valor: uso y salida 2',
    usage.every((run) => run.code === 2 && run.err.includes('Usage:')), show(usage.map((run) => [run.code, run.err.split('\n')[0]])));
  const help = await runImport(['--', 'gemini-cli', '--help']);
  check('14 script: --help sale 0', help.code === 0 && help.out.includes('pnpm vault:import antigravity-ide --workspace'));
  check('14 script: las barras que duplica pnpm se colapsan en Windows, la UNC conserva las dos del principio',
    collapseBackslashes('D:\\\\\\\\Proyecto Demo') === GEMINI_CWD && collapseBackslashes('\\\\\\\\srv\\\\share\\\\x') === '\\\\srv\\share\\x' &&
    same(parseImportArgs(['gemini-cli', '--cwd=D:\\\\Proyecto Demo', '--cwd', 'C:\\\\x'], 'win32'), { kind: 'run', importer: 'gemini-cli', cwds: [GEMINI_CWD, 'C:\\x'], workspace: null, write: false }) &&
    same(parseImportArgs(['gemini-cli', '--cwd', '/tmp//x'], 'linux').cwds, ['/tmp//x']),
    show(parseImportArgs(['gemini-cli', '--cwd=D:\\\\Proyecto Demo'], 'win32')));

  const dryGemini = await runImport(['gemini-cli', '--cwd', 'd:\\\\Proyecto Demo']);
  check('14 script: gemini-cli en seco dice cuantos, cuantos casan, que se salta, y sale 0',
    dryGemini.code === 0 && dryGemini.out.includes('Found: 6') && dryGemini.out.includes('To import: 3') && dryGemini.out.includes('with a matched folder: 2') &&
    dryGemini.out.includes('1: only notices') && dryGemini.out.includes('Dry run'), dryGemini.out + dryGemini.err);
  const dryRescue = await runImport(['antigravity-ide', '--workspace', RESCUE_WORKSPACE]);
  check('14 script: antigravity-ide en seco dice conversaciones, pasos, documentos y fechas, y sale 0',
    dryRescue.code === 0 && dryRescue.out.includes('Conversations: 3, with 157 steps') && dryRescue.out.includes('Documents: 4') &&
    dryRescue.out.includes('other folders: 4') && dryRescue.out.includes('To write: 3 partial sessions') && dryRescue.out.includes('Dry run') && !dryRescue.out.includes('SECRETO'),
    dryRescue.out + dryRescue.err);
  const noSqliteRun = await runImport(['antigravity-ide', '--workspace', RESCUE_WORKSPACE, '--write'], { sqlite: () => ({ unavailable: 'node-too-old' }) });
  check('14 script: sin node:sqlite el rescate sale 1 con el motivo, aun con --write',
    noSqliteRun.code === 1 && noSqliteRun.err.includes('node:sqlite') && !noSqliteRun.out.includes('Wrote'), show(noSqliteRun));
  check('14 script: sin --write no se crea nada, ni la carpeta de la copia, ni queda la temporal',
    !(await fileExists(importVault)) && (await rescueLeftovers()).length === 0);

  // Una copia de un formato mas nuevo en el lugar de un chat: no se pisa.
  const foreignFile = path.join(importVault, 'sessions', 'gemini-cli', `${GID.unknown}.jsonl`);
  const foreignText = `${JSON.stringify({ kind: 'header', format: 2, agent: 'gemini-cli', sessionId: GID.unknown })}\n`;
  await mkdir(path.dirname(foreignFile), { recursive: true });
  await writeFile(foreignFile, foreignText);
  const writeForeign = await runImport(['gemini-cli', '--cwd', 'd:\\Proyecto Demo', '--write']);
  check('14 script: --write no pisa una copia de un formato mas nuevo, y lo dice',
    writeForeign.code === 0 && writeForeign.out.includes('Wrote 2 sessions') && writeForeign.out.includes("Didn't overwrite 1 session") &&
    (await readFile(foreignFile, 'utf8')) === foreignText, writeForeign.out + writeForeign.err);
  await rm(foreignFile);

  const writeGemini = await runImport(['gemini-cli', '--cwd', 'd:\\Proyecto Demo', '--write']);
  const afterFirst = await filesUnder(importVault);
  const again = await runImport(['gemini-cli', '--cwd', 'd:\\Proyecto Demo', '--write']);
  const afterSecond = await filesUnder(importVault);
  check('14 script: gemini-cli --write escribe las tres; correrlo dos veces deja lo mismo',
    writeGemini.code === 0 && again.code === 0 && writeGemini.out.includes('Wrote 3 sessions') &&
    same(afterFirst, afterSecond) && same(afterFirst, ['vault.json', ...[GID.noReply, GID.tools, GID.unknown].map((id) => path.join('sessions', 'gemini-cli', `${id}.jsonl`))].sort()),
    show(afterSecond));

  const writeRescue = await runImport(['antigravity-ide', '--workspace', RESCUE_WORKSPACE, '--write']);
  check('14 script: antigravity-ide --write escribe las tres parciales', writeRescue.code === 0 && writeRescue.out.includes('Wrote 3 sessions'), writeRescue.out + writeRescue.err);

  const catalog = new VaultCatalog();
  await catalog.load(importVault);
  const listed = catalog.summaries();
  const geminiRows = listed.filter((row) => row.agent === 'gemini-cli');
  const rescueRows = listed.filter((row) => row.agent === 'antigravity-ide');
  check('14 script: el catalogo lista lo importado: Gemini CLI con su grupo, el IDE parcial bajo la carpeta',
    geminiRows.length === 3 && geminiRows.find((row) => row.sessionId === GID.unknown)?.group === geminiImport.GEMINI_UNKNOWN_GROUP &&
    geminiRows.find((row) => row.sessionId === GID.tools)?.cwd === 'd:\\Proyecto Demo' &&
    rescueRows.length === 3 && rescueRows.every((row) => row.partial === true && row.cwd === RESCUE_WORKSPACE), show(listed));
  const plan = await geminiImport.planGeminiCliImport({ geminiHome: importGemini, cwdCandidates: ['d:\\Proyecto Demo'] });
  const toolsBody = (await bodyOf(catalog, 'gemini-cli', GID.tools)).map((line) => line.event);
  check('14 script: el cuerpo escrito es el del plan, evento por evento',
    sameShape(toolsBody, plan.chats.find((chat) => chat.sessionId === GID.tools)?.events), firstDifference(toolsBody, plan.chats.find((chat) => chat.sessionId === GID.tools)?.events ?? []));
  const rescueBody = await bodyOf(catalog, 'antigravity-ide', RID(1));
  check('14 script: el rescate escrito trae sus documentos enteros, en orden',
    same(rescueBody.map((line) => line.name), ['walkthrough.md', 'plan.md', 'grande.md']) && rescueBody[1]?.text === '# Plan de prueba del instalador\n\nPaso 1: probar.' &&
    catalog.header('antigravity-ide', RID(1))?.stepCount === 120, show(rescueBody.map((line) => [line.name, line.text.length])));

  const written = await filesUnder(importVault);
  let leaked = [];
  for (const file of written) {
    if ((await readFile(path.join(importVault, file), 'latin1')).includes('SECRETO')) leaked.push(file);
  }
  check('14 script: ningun archivo de la copia contiene lo que no se tenia que leer', leaked.length === 0, show(leaked));
  check('14 script: en la copia solo vault.json y las sesiones (ni assets, ni export, ni memoria)',
    written.every((file) => file === 'vault.json' || /^sessions[\\/](gemini-cli|antigravity-ide)[\\/][^\\/]+\.jsonl$/.test(file)) && written.length === 7, show(written));

  // El script de verdad, en otro proceso: en seco no escribe nada en la carpeta de configuracion.
  const { spawnSync } = await import('node:child_process');
  const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'vault-import.mjs');
  const childAppdata = path.join(importRoot, 'appdata-del-script');
  const child = spawnSync(process.execPath, [...process.execArgv, script, 'gemini-cli', '--cwd', 'd:\\Proyecto Demo'], {
    env: { ...process.env, HOME: importHome, USERPROFILE: importHome, APPDATA: childAppdata },
    encoding: 'utf8', timeout: 60_000, windowsHide: true,
  });
  check('14 script: vault-import.mjs en otro proceso lee el ~/.gemini del home y en seco no crea nada',
    child.status === 0 && child.stdout.includes('with a matched folder: 2') && child.stdout.includes('Dry run') && !(await fileExists(childAppdata)),
    show({ status: child.status, stdout: child.stdout?.slice(0, 400), stderr: child.stderr?.slice(0, 400), error: child.error?.message }));
}

// --- 14f. El -wal de la base se copia con ella ---
{
  const writer = new importSqlite.DatabaseSync(rescueDb);
  writer.exec('PRAGMA wal_autocheckpoint = 0');
  vaultFixtures.insertSummaries(writer, [vaultFixtures.summaryRow(RID(10), {
    preview: 'Fila Que Solo Esta En El Wal', step_count: 3, last_modified_time: '2026-05-08 10:00:00+00:00', workspace_uris: '["file:///d%3A/demo-rescate"]',
  })]);
  const walSize = (await stat(`${rescueDb}-wal`).catch(() => null))?.size ?? 0;
  const plan = await rescueImport.planAntigravityRescue({ workspace: RESCUE_WORKSPACE, geminiHome: importGemini, platform: 'win32', now: () => IMPORT_NOW, tempRoot: importTemp })
    .then((value) => value, (error) => error);
  writer.close();
  check('14 rescate: con la base abierta por otro, lo que solo esta en el -wal tambien se ve',
    walSize > 0 && Array.isArray(plan?.conversations) && plan.conversations.some((conversation) => conversation.conversationId === RID(10)),
    show({ walSize, ids: plan?.conversations?.map((c) => c.conversationId), error: plan?.message }));
  check('14 rescate: y tampoco queda la temporal', (await rescueLeftovers()).length === 0);
}

// ---------------------------------------------------------------------------
// 15. Estaticos
// ---------------------------------------------------------------------------

{
  const typescript = (await import('typescript')).default;
  const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const packagesRoot = path.resolve(serverRoot, '..');
  const relativeToPackages = (file) => path.relative(packagesRoot, file).split(path.sep).join('/');

  /** El codigo sin comentarios: un comentario que nombra una carpeta no la lee. */
  const withoutComments = (file, text) => {
    const kind = file.endsWith('.tsx') ? typescript.ScriptKind.TSX : file.endsWith('.mjs') ? typescript.ScriptKind.JS : typescript.ScriptKind.TS;
    const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, false, kind);
    return typescript.createPrinter({ removeComments: true }).printFile(source);
  };
  const sourcesIn = async (dir) => {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name)).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
  };
  const appSources = [
    ...(await sourcesIn(path.join(serverRoot, 'src'))),
    ...(await sourcesIn(path.join(packagesRoot, 'shared', 'src'))),
    ...(await sourcesIn(path.join(packagesRoot, 'web', 'src'))),
    path.join(serverRoot, 'scripts', 'vault-import.mjs'),
  ];
  const importerFile = path.join(serverRoot, 'src', 'vault', 'importers', 'antigravity-ide.ts');
  const geminiFile = path.join(serverRoot, 'src', 'vault', 'importers', 'gemini-cli.ts');

  // C8: `.gemini` + separador + `antigravity` no seguido de `-` ni de letra, y `'antigravity', 'brain'` como argumentos seguidos.
  const IDE_FOLDER = /\.gemini(?:[\\/]|\\\\)+antigravity(?![-A-Za-z])/;
  const IDE_BRAIN_ARGS = /['"`]antigravity['"`]\s*,\s*['"`]brain['"`]/;
  const naming = [];
  const inComments = [];
  for (const file of appSources) {
    const raw = await readFile(file, 'utf8');
    if (!IDE_FOLDER.test(raw) && !IDE_BRAIN_ARGS.test(raw)) continue;
    const code = withoutComments(file, raw);
    if (IDE_FOLDER.test(code) || IDE_BRAIN_ARGS.test(code)) naming.push(relativeToPackages(file));
    else inComments.push(relativeToPackages(file));
  }
  check('15 la carpeta del IDE (C8) solo la nombra el codigo de importers/antigravity-ide.ts',
    same(naming, ['server/src/vault/importers/antigravity-ide.ts']), show({ naming, inComments }));
  check('15 las expresiones de C8 si ven la carpeta en un comentario: por eso se buscan sin comentarios',
    inComments.some((file) => file.startsWith('server/src/agents/antigravity/')), show(inComments));
  check('15 las expresiones de C8 casan con las dos formas de nombrarla',
    IDE_FOLDER.test('~/.gemini/antigravity/brain') && IDE_FOLDER.test("'.gemini\\\\antigravity'") && !IDE_FOLDER.test('~/.gemini/antigravity-cli/brain') &&
    IDE_BRAIN_ARGS.test("path.join(home, 'antigravity', 'brain')") && !IDE_BRAIN_ARGS.test("path.join(cliRoot(), 'brain')"));

  const vaultSources = await sourcesIn(path.join(serverRoot, 'src', 'vault'));
  const NETWORK = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?:node:)?(?:http|https|http2|net|tls|dgram)['"]|\bfetch\s*\(/;
  const online = [];
  for (const file of vaultSources) {
    if (NETWORK.test(withoutComments(file, await readFile(file, 'utf8')))) online.push(relativeToPackages(file));
  }
  check('15 server/src/vault/** (importadores incluidos) no abre la red', vaultSources.includes(importerFile) && online.length === 0 && NETWORK.test("import http from 'node:http'"), show(online));

  /** Los archivos a los que se llega por imports relativos desde `entry`. Sobre el texto crudo: un comentario de mas solo agrega aristas. */
  const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  const reachableFrom = async (entry) => {
    const seen = new Set();
    const queue = [entry];
    while (queue.length > 0) {
      const file = queue.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      const text = await readFile(file, 'utf8').catch(() => '');
      for (const match of text.matchAll(RELATIVE_IMPORT)) {
        const target = path.resolve(path.dirname(file), match[1]);
        const candidates = [target.replace(/\.js$/, '.ts'), target.replace(/\.js$/, '.tsx'), target, `${target}.ts`, path.join(target, 'index.ts')];
        for (const candidate of candidates) {
          if (await stat(candidate).then((info) => info.isFile(), () => false)) {
            queue.push(candidate);
            break;
          }
        }
      }
    }
    return seen;
  };
  const fromServer = await reachableFrom(path.join(serverRoot, 'src', 'index.ts'));
  const fromScript = await reachableFrom(path.join(serverRoot, 'scripts', 'vault-import.mjs'));
  const importersReached = [...fromServer].filter((file) => file.includes(`${path.sep}importers${path.sep}`)).map(relativeToPackages);
  check('15 src/index.ts no llega a importers/ (no entra al paquete de npm)',
    fromServer.size > 50 && fromServer.has(path.join(serverRoot, 'src', 'vault', 'service.ts')) && importersReached.length === 0, show({ size: fromServer.size, importersReached }));
  check('15 y el recorrido si los ve desde el script', fromScript.has(importerFile) && fromScript.has(geminiFile));

  const importerCode = withoutComments(importerFile, await readFile(importerFile, 'utf8'));
  const geminiCode = withoutComments(geminiFile, await readFile(geminiFile, 'utf8'));
  check('15 ningun importador pide todas las columnas (SELECT *)',
    !/SELECT\s+\*/i.test(importerCode) && !/SELECT\s+\*/i.test(geminiCode) && importerCode.includes('SELECT conversation_id, workspace_uris FROM conversation_summaries'));
  const CREDENTIALS = /oauth_creds|google_accounts|credentials|installation_id|trustedFolders|shell_history|logs\.json|\.project_root|keyring|['"`](?:conversations|\.env|config|mcp|history)['"`]/i;
  check('15 los importadores no nombran credenciales ni nada de ~/.gemini fuera de lo que leen',
    !CREDENTIALS.test(importerCode) && !CREDENTIALS.test(geminiCode) && CREDENTIALS.test("path.join(home, 'oauth_creds.json')"),
    show([importerCode.match(CREDENTIALS)?.[0], geminiCode.match(CREDENTIALS)?.[0]]));
}

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
