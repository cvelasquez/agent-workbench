/**
 * Chequeo de los adaptadores de CLI y de lo que viaja con ellos.
 *
 *   npx tsx scripts/check-agent-registry.mjs
 *
 * El refactor que separa lo generico de lo que es de una CLI promete una sola
 * cosa: con Claude Code sola, la app hace exactamente lo que hacia. Todo lo que
 * puede romper esa promesa sin que se note a ojo tiene su caso aca — una
 * capacidad mal puesta esconde un control sin que falle nada, un argumento de
 * lanzamiento distinto cambia el modo de arranque, y un entorno con una
 * variable de mas es una violacion de la regla 2.1.
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA`, `XDG_CONFIG_HOME` y `CODEX_HOME`
 * apuntando a una carpeta temporal propia, fijadas **antes** de importar nada:
 * nunca lee ni escribe el `~/.claude` ni el `~/.codex` de verdad. No importa
 * nada que cargue `node-pty`.
 */

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-agents-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
// El registro de la app tambien trae el adaptador de Codex (hito 25).
process.env['CODEX_HOME'] = path.join(root, 'codex');
// Y el de OpenCode (hito 26): sus carpetas, adentro de la temporal.
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
delete process.env['OPENCODE_DB'];
delete process.env['OPENCODE_MODELS_PATH'];
delete process.env['OPENCODE_MODELS_URL'];

const shared = await import('@agent-workbench/shared');
const {
  AGENT_IDS,
  MEMORY_AGENT_IDS,
  NO_CAPABILITIES,
  asArrayFiltered,
  normalizeCwdKey,
  parseAgentCapabilities,
  parseAgentInfo,
  parsePermissionCycle,
  shouldOfferAgentChoice,
} = shared;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/** Igualdad estructural, con el orden de las claves normalizado. */
const sameShape = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

// ---------------------------------------------------------------------------
// 1. La clave de proyecto
// ---------------------------------------------------------------------------

const keyCases = [
  ['win32', 'D:\\agent explorer\\', 'd:\\agent explorer'],
  ['win32', 'd:/Agent Explorer', 'd:\\agent explorer'],
  ['win32', '\\\\?\\D:\\agent explorer', 'd:\\agent explorer'],
  ['win32', '\\\\?\\UNC\\srv\\share\\x\\', '\\\\srv\\share\\x'],
  ['win32', '\\\\srv\\\\share\\\\x', '\\\\srv\\share\\x'],
  ['win32', 'C:\\', 'c:\\'],
  ['win32', 'C:\\\\', 'c:\\'],
  ['linux', '/home/u/p/', '/home/u/p'],
  ['linux', '//home//u', '/home/u'],
  ['linux', '/', '/'],
  ['darwin', '/Users/u/p//', '/Users/u/p'],
  ['win32', '', ''],
  ['linux', '', ''],
];
for (const [platform, input, expected] of keyCases) {
  const got = normalizeCwdKey(input, platform);
  check(`clave ${platform} ${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, got === expected, JSON.stringify(got));
}
check(
  'win32: "D:\\Mi App" y "D:\\Mi-App" no se juntan',
  normalizeCwdKey('D:\\Mi App', 'win32') !== normalizeCwdKey('D:\\Mi-App', 'win32'),
);
check(
  'linux: las mayusculas importan',
  normalizeCwdKey('/Home/u', 'linux') !== normalizeCwdKey('/home/u', 'linux'),
);

// Con que cwd se reanuda una sesion desde la barra lateral.
{
  const { resumeCwdFor } = shared;
  check('reanudar: la sesion sin cwd usa el del proyecto', resumeCwdFor('', 'D:\\Agent X', 'win32') === 'D:\\Agent X');
  check('reanudar: el cwd de la sesion si difiere en algo que cambia el slug (barra final)',
    resumeCwdFor('D:\\Agent X\\', 'D:\\Agent X', 'win32') === 'D:\\Agent X\\');
  check('reanudar: un \\\\?\\ de mas tambien usa el de la sesion',
    resumeCwdFor('\\\\?\\D:\\Agent X', 'D:\\Agent X', 'win32') === '\\\\?\\D:\\Agent X');
  check('reanudar en win32: si solo cambian las mayusculas, el del proyecto, como antes del Hito 24',
    resumeCwdFor('d:\\agent x', 'D:\\Agent X', 'win32') === 'D:\\Agent X');
  check('reanudar en linux: otras mayusculas son otra carpeta, el de la sesion',
    resumeCwdFor('/home/agent-x', '/home/Agent-X', 'linux') === '/home/agent-x');
  check('reanudar: iguales, cualquiera', resumeCwdFor('D:\\Agent X', 'D:\\Agent X', 'win32') === 'D:\\Agent X');
}

// ---------------------------------------------------------------------------
// 6. Parsers de shared (lo que existe desde el paso 1)
// ---------------------------------------------------------------------------

check('parseAgentCapabilities({}) no declara nada', sameShape(parseAgentCapabilities({}), NO_CAPABILITIES));
check('parseAgentCapabilities de algo que no es objeto no declara nada',
  sameShape(parseAgentCapabilities('x'), NO_CAPABILITIES) && sameShape(parseAgentCapabilities(null), NO_CAPABILITIES));
{
  const wrong = parseAgentCapabilities({
    resume: 'true',
    rewind: 1,
    plans: true,
    imagesByPath: 'otro-estilo',
    fileMentions: 'at',
    contextWindowSource: 42,
    models: [{ value: 'opus', label: 'Opus', family: 'opus', long: 'no', window: 200000 }],
    efforts: [],
    permissionCycle: { modes: ['auto'], launchMode: 'auto', keyLabel: '' },
  });
  check('un booleano que no es true cae a false', wrong.resume === false && wrong.rewind === false && wrong.plans === true);
  check('un literal desconocido cae a null', wrong.imagesByPath === null && wrong.fileMentions === 'at' && wrong.contextWindowSource === null);
  check('una opcion de modelo mal formada invalida la lista', wrong.models === null, JSON.stringify(wrong.models));
  check('una lista de esfuerzos vacia es null', wrong.efforts === null);
  check('un ciclo sin nombre de tecla es null', wrong.permissionCycle === null);
}
{
  const models = [
    { value: 'default', label: 'Por defecto', family: '', long: false, window: null },
    { value: 'x[1m]', label: 'X', family: 'x', long: true, window: 1000000 },
  ];
  const parsed = parseAgentCapabilities({ models, efforts: [{ value: 'low', label: 'Bajo' }] });
  check('las opciones de modelo validas pasan enteras, con ventana null incluida', sameShape(parsed.models, models), JSON.stringify(parsed.models));
  check('los esfuerzos validos pasan', sameShape(parsed.efforts, [{ value: 'low', label: 'Bajo' }]));
}

const cycle = { modes: ['auto', 'default', 'acceptEdits', 'plan'], launchMode: 'auto', keyLabel: 'shift+tab' };
check('un ciclo valido se lee tal cual', sameShape(parsePermissionCycle(cycle), cycle));
check('un ciclo con un modo que no se conoce es null', parsePermissionCycle({ ...cycle, modes: ['auto', 'yolo'] }) === null);
check('un ciclo vacio es null', parsePermissionCycle({ ...cycle, modes: [] }) === null);
check('un punto de partida fuera del ciclo es null', parsePermissionCycle({ ...cycle, modes: ['default', 'plan'] }) === null);

const info = {
  id: 'claude-code',
  label: 'Claude Code',
  command: 'claude',
  available: true,
  version: '2.1.263',
  installUrl: 'https://example.com',
  missingMessage: null,
  capabilities: { resume: true },
  environmentNotice: 'child-session-marker',
};
const parsedInfo = parseAgentInfo(info);
check('parseAgentInfo lee una CLI conocida', parsedInfo !== null && parsedInfo.id === 'claude-code' && parsedInfo.available && parsedInfo.version === '2.1.263');
check('y sus capacidades pasan por su parser', parsedInfo?.capabilities.resume === true && parsedInfo?.capabilities.plans === false);
check('parseAgentInfo con un id que no se conoce es null', parseAgentInfo({ ...info, id: 'nope' }) === null);
check('parseAgentInfo sin label es null', parseAgentInfo({ ...info, label: undefined }) === null);
{
  const bare = parseAgentInfo({ ...info, available: 'yes', version: undefined, environmentNotice: 'otro' });
  check('available que no es true es false; ausentes son null',
    bare !== null && bare.available === false && bare.version === null && bare.environmentNotice === null);
}

const available = (id) => ({ ...parsedInfo, id, available: true });
const missing = (id) => ({ ...parsedInfo, id, available: false });
check('una disponible y una no: no se ofrece elegir', shouldOfferAgentChoice([available('a'), missing('b')]) === false);
check('dos disponibles: se ofrece elegir', shouldOfferAgentChoice([available('a'), available('b')]) === true);
check('ninguna: no se ofrece elegir', shouldOfferAgentChoice([]) === false);

{
  const even = (item) => (typeof item === 'number' && item % 2 === 0 ? item : null);
  check('asArrayFiltered descarta solo lo que no pasa', sameShape(asArrayFiltered([1, 2, 'x', 4], even), [2, 4]));
  check('asArrayFiltered de algo que no es array es null', asArrayFiltered({ length: 0 }, even) === null);
}

check(
  'toda CLI con adaptador es tambien una CLI de la memoria',
  AGENT_IDS.every((id) => MEMORY_AGENT_IDS.includes(id)),
  AGENT_IDS.join(','),
);

// ---------------------------------------------------------------------------
// 6. Parsers de shared: el descriptor de una pestana (paso 4)
// ---------------------------------------------------------------------------

{
  const { parseTerminalDescriptor, parseServerMessage } = shared;
  const descriptor = (overrides = {}) => ({
    terminalId: 't1', kind: 'agent', cwd: 'D:\\p', sessionId: 's1', label: '',
    resumed: false, createdAt: 1, alive: true, exitCode: null, sleeping: false,
    ...overrides,
  });

  check('descriptor sin agent, pestana de agente: es de claude-code (servidor anterior)',
    parseTerminalDescriptor(descriptor())?.agent === 'claude-code');
  check('descriptor sin agent ni kind: pestana de claude-code',
    parseTerminalDescriptor(descriptor({ kind: undefined }))?.agent === 'claude-code');
  check('descriptor sin agent, consola: null',
    (() => { const parsed = parseTerminalDescriptor(descriptor({ kind: 'shell', sessionId: '' })); return parsed !== null && parsed.agent === null; })());
  check('una consola no tiene agente aunque el campo diga uno',
    parseTerminalDescriptor(descriptor({ kind: 'shell', sessionId: '', agent: 'claude-code' }))?.agent === null);
  check('descriptor con agent valido lo conserva',
    parseTerminalDescriptor(descriptor({ agent: 'claude-code' }))?.agent === 'claude-code');
  check('descriptor de agente con una CLI desconocida se descarta',
    parseTerminalDescriptor(descriptor({ agent: 'nope' })) === null);
  check('descriptor de agente con agent null se descarta',
    parseTerminalDescriptor(descriptor({ agent: null })) === null);

  const list = parseServerMessage(JSON.stringify({
    type: 'terminal.list',
    terminals: [descriptor(), descriptor({ terminalId: 't2', agent: 'nope' }), descriptor({ terminalId: 't3', kind: 'shell', sessionId: '' })],
    order: ['t1', 't2', 't3'],
  }));
  check('terminal.list con un descriptor que no se entiende conserva los demas',
    list?.type === 'terminal.list' && list.terminals.map((t) => t.terminalId).join(',') === 't1,t3',
    JSON.stringify(list?.terminals?.map((t) => t.terminalId)));
  check('terminal.list sin lista sigue siendo invalido',
    parseServerMessage(JSON.stringify({ type: 'terminal.list', terminals: 'x', order: [] })) === null);
}

// ---------------------------------------------------------------------------
// 6. Parsers de shared: sesion y proyecto (paso 5)
// ---------------------------------------------------------------------------

{
  const { parseSessionSummary, parseProjectSummary, parseServerMessage } = shared;
  const summary = (overrides = {}) => ({
    sessionId: 's1', title: 't', titleSource: 'ai', updatedAt: 1, sizeBytes: 2, ...overrides,
  });

  const bare = parseSessionSummary(summary());
  check('sesion sin agent ni cwd (servidor anterior): de claude-code, cwd vacio, no archivada',
    bare !== null && bare.agent === 'claude-code' && bare.cwd === '' && bare.archived === false, JSON.stringify(bare));
  const full = parseSessionSummary(summary({ agent: 'claude-code', cwd: 'D:\\p', archived: true }));
  check('sesion con agent y cwd los conserva',
    full?.agent === 'claude-code' && full.cwd === 'D:\\p' && full.archived === true, JSON.stringify(full));
  check('sesion de una CLI desconocida se descarta', parseSessionSummary(summary({ agent: 'nope' })) === null);

  const project = (overrides = {}) => ({
    key: 'd:\\p', fallbackName: '', cwd: 'D:\\p', cwdExists: true, sessions: [summary()], lastActivityAt: 1,
    ...overrides,
  });
  const withKey = parseProjectSummary(project({ fallbackName: 'x' }));
  check('proyecto con key la conserva, y su fallbackName', withKey?.key === 'd:\\p' && withKey.fallbackName === 'x');
  const legacy = parseProjectSummary(project({ key: undefined, fallbackName: undefined, slug: 'D--p' }));
  check('proyecto de un servidor anterior, solo con slug: key = slug y sin nombre de respaldo',
    legacy?.key === 'D--p' && legacy.fallbackName === '', JSON.stringify(legacy));
  const legacyNoCwd = parseProjectSummary(project({ key: undefined, fallbackName: undefined, slug: 'D--p', cwd: '' }));
  check('proyecto anterior sin cwd: el slug es el nombre de respaldo',
    legacyNoCwd?.key === 'D--p' && legacyNoCwd.fallbackName === 'D--p', JSON.stringify(legacyNoCwd));
  check('proyecto sin key ni slug se descarta', parseProjectSummary(project({ key: undefined })) === null);
  const mixed = parseProjectSummary(project({ sessions: [summary(), summary({ sessionId: 's2', agent: 'nope' })] }));
  check('una sesion que no se entiende no se lleva al proyecto',
    mixed !== null && mixed.sessions.map((s) => s.sessionId).join(',') === 's1', JSON.stringify(mixed));

  const projects = parseServerMessage(JSON.stringify({
    type: 'index.projects',
    projects: [project(), project({ key: undefined }), project({ key: 'd:\\q', cwd: 'D:\\q' })],
    replace: true,
  }));
  check('index.projects con un proyecto que no se entiende conserva los demas',
    projects?.type === 'index.projects' && projects.projects.map((p) => p.key).join(',') === 'd:\\p,d:\\q',
    JSON.stringify(projects?.projects?.map((p) => p.key)));
}

// ---------------------------------------------------------------------------
// 6. Parsers de shared: hello, actividad, error y terminal.open (paso 7)
// ---------------------------------------------------------------------------

{
  const { PROTOCOL_VERSION, parseServerMessage, parseClientMessage } = shared;
  check('el protocolo es la version 6', PROTOCOL_VERSION === 6, String(PROTOCOL_VERSION));

  const agentInfo = (overrides = {}) => ({
    id: 'claude-code', label: 'Claude Code', command: 'claude', available: true, version: '2.1.263',
    installUrl: 'https://example.com', missingMessage: null, capabilities: { plans: true },
    environmentNotice: null, ...overrides,
  });
  const helloBase = { type: 'hello', protocolVersion: 6, platform: 'win32', defaultCwd: 'D:\\p', shellName: 'PowerShell' };

  const hello = parseServerMessage(JSON.stringify({
    ...helloBase,
    agents: [agentInfo(), agentInfo({ id: 'nope', label: 'Otra' })],
    defaultAgent: 'claude-code',
  }));
  check('hello v6 con una CLI que no se conoce: queda la otra, y el resto del mensaje',
    hello?.type === 'hello' && hello.agents.length === 1 && hello.agents[0].id === 'claude-code' &&
    hello.defaultAgent === 'claude-code' && hello.platform === 'win32' && hello.defaultCwd === 'D:\\p' && hello.shellName === 'PowerShell',
    JSON.stringify(hello));
  check('hello v6: las capacidades de cada CLI pasan por su parser',
    hello?.agents[0].capabilities.plans === true && hello.agents[0].capabilities.resume === false);
  check('hello v6 ya no trae los campos sueltos de una CLI',
    hello !== null && !('cliAvailable' in hello) && !('transcriptMarkerStripped' in hello));

  const legacy = parseServerMessage(JSON.stringify({
    ...helloBase, protocolVersion: 5, cliAvailable: true, cliVersion: '1', cliMissingMessage: null, transcriptMarkerStripped: false,
  }));
  check('hello de un servidor anterior, sin agents: se lee igual, sin CLIs ni CLI por defecto',
    legacy?.type === 'hello' && legacy.agents.length === 0 && legacy.defaultAgent === null && legacy.platform === 'win32',
    JSON.stringify(legacy));
  const oddDefault = parseServerMessage(JSON.stringify({ ...helloBase, agents: 'x', defaultAgent: 'nope' }));
  check('hello con agents que no es lista y una CLI por defecto desconocida: lista vacia y null',
    oddDefault?.type === 'hello' && oddDefault.agents.length === 0 && oddDefault.defaultAgent === null, JSON.stringify(oddDefault));

  const unknownActivity = parseServerMessage(JSON.stringify({ type: 'terminal.activity', terminalId: 't1', activity: 'unknown' }));
  check('terminal.activity con unknown se parsea', unknownActivity?.type === 'terminal.activity' && unknownActivity.activity === 'unknown',
    JSON.stringify(unknownActivity));
  check('terminal.activity con un estado inventado sigue siendo invalido',
    parseServerMessage(JSON.stringify({ type: 'terminal.activity', terminalId: 't1', activity: 'dormida' })) === null);

  const unsupported = parseServerMessage(JSON.stringify({ type: 'error', code: 'agent-unsupported', message: 'no', requestId: 'r1' }));
  check('error agent-unsupported no cae a internal', unsupported?.type === 'error' && unsupported.code === 'agent-unsupported' && unsupported.requestId === 'r1',
    JSON.stringify(unsupported));
  check('un codigo que no se conoce si cae a internal',
    parseServerMessage(JSON.stringify({ type: 'error', code: 'otro-codigo', message: 'no' }))?.code === 'internal');

  const open = (extra) => parseClientMessage(JSON.stringify({ type: 'terminal.open', requestId: 'r', cwd: 'D:\\p', ...extra }));
  const withAgent = open({ agent: 'claude-code' });
  check('terminal.open con una CLI conocida la conserva',
    withAgent?.type === 'terminal.open' && withAgent.agent === 'claude-code' && withAgent.unsupportedAgent === undefined, JSON.stringify(withAgent));
  const withUnknown = open({ agent: 'nope' });
  check('terminal.open con una CLI desconocida no la ignora: la anota para rechazarla',
    withUnknown?.type === 'terminal.open' && withUnknown.agent === undefined && withUnknown.unsupportedAgent === 'nope', JSON.stringify(withUnknown));
  const withNumber = open({ agent: 5 });
  check('terminal.open con agent que no es texto tambien se rechaza', withNumber?.unsupportedAgent === '5', JSON.stringify(withNumber));
  const bare = open({});
  const withNull = open({ agent: null });
  check('terminal.open sin agent, o con null, deja decidir al servidor',
    bare !== null && bare.agent === undefined && bare.unsupportedAgent === undefined &&
    withNull !== null && withNull.agent === undefined && withNull.unsupportedAgent === undefined);
  check('un cliente que manda unsupportedAgent no lo cuela: lo pone solo el parser',
    open({ unsupportedAgent: 'x' })?.unsupportedAgent === undefined);
}

// ---------------------------------------------------------------------------
// Lo que la cabecera dice de las CLIs, a partir de hello (paso 7)
// ---------------------------------------------------------------------------

{
  const { summarizeAgents } = await import('../../web/src/agent-summary.ts');
  const info = (overrides = {}) => ({
    id: 'claude-code', label: 'Claude Code', command: 'claude', available: true, version: '2.1.263',
    installUrl: 'u', missingMessage: null, capabilities: NO_CAPABILITIES, environmentNotice: null, ...overrides,
  });

  const before = summarizeAgents([], false);
  check('antes de hello: CLI disponible (arranque optimista), sin version, sin cartel, sin aviso',
    before.cliAvailable === true && before.cliVersion === null && before.cliMissingMessage === null && before.environmentNotice === null,
    JSON.stringify(before));

  const one = summarizeAgents([info()], true);
  check('una CLI instalada: su version tal cual, sin cartel',
    one.cliAvailable === true && one.cliVersion === '2.1.263' && one.cliMissingMessage === null, JSON.stringify(one));
  check('una CLI instalada sin version conocida: null, como antes',
    summarizeAgents([info({ version: null })], true).cliVersion === null);

  const absent = summarizeAgents([info({ available: false, version: null, missingMessage: 'No se encontro "claude".' })], true);
  check('una CLI ausente: no disponible y su texto tal cual',
    absent.cliAvailable === false && absent.cliVersion === null && absent.cliMissingMessage === 'No se encontro "claude".',
    JSON.stringify(absent));

  const marker = summarizeAgents([info({ environmentNotice: 'child-session-marker' })], true);
  check('el aviso del marcador llega', marker.environmentNotice === 'child-session-marker');

  const two = summarizeAgents([info(), info({ label: 'Otra', version: null })], true);
  check('dos instaladas: cada version con su nombre', two.cliVersion === 'Claude Code 2.1.263 · Otra ?', String(two.cliVersion));
  const oneOfTwo = summarizeAgents([info({ available: false, missingMessage: 'falta' }), info({ label: 'Otra', version: '1' })], true);
  check('una de dos instalada: sin cartel, y la version sin nombre',
    oneOfTwo.cliAvailable === true && oneOfTwo.cliMissingMessage === null && oneOfTwo.cliVersion === '1', JSON.stringify(oneOfTwo));
  // Hito 25 (A6): con ninguna instalada, el texto de la primera y las demas por
  // nombre. No las instrucciones de instalar cada una.
  const noneOfTwo = summarizeAgents([info({ available: false, missingMessage: 'falta a' }), info({ label: 'Otra', available: false, missingMessage: 'falta b' })], true);
  check('ninguna de dos: el texto de la primera y las demas por nombre', noneOfTwo.cliMissingMessage === 'falta a\nTambien funciona con: Otra', JSON.stringify(noneOfTwo));
  const empty = summarizeAgents([], true);
  check('hello sin CLIs: no disponible y sin texto que mostrar', empty.cliAvailable === false && empty.cliMissingMessage === null);

  // Un servidor de la version anterior que sigue corriendo (`pnpm dev` sin
  // reiniciar tras cambiar de rama) sirve esta pagina: su hello, pasado por el
  // parser de esta version, no trae CLIs. No puede quedar todo apagado y mudo.
  const { parseServerMessage, PROTOCOL_VERSION } = shared;
  const legacyHello = parseServerMessage(JSON.stringify({
    type: 'hello', protocolVersion: 5, platform: 'win32', defaultCwd: 'D:\\p', shellName: 'PowerShell',
    cliAvailable: true, cliVersion: '2.1.263', cliMissingMessage: null, transcriptMarkerStripped: false,
  }));
  const outdated = summarizeAgents(legacyHello.agents, true, legacyHello.protocolVersion);
  check('hello v5 de un servidor sin reiniciar: un cartel que pide reiniciarlo, no la app apagada en silencio',
    outdated.cliAvailable === false && typeof outdated.cliMissingMessage === 'string' &&
    /version anterior/.test(outdated.cliMissingMessage) && /Reinicialo/.test(outdated.cliMissingMessage) &&
    outdated.cliMissingMessage.includes('protocolo 5') && outdated.cliVersion === null && outdated.environmentNotice === null,
    JSON.stringify(outdated));
  const outdatedWithAgents = summarizeAgents([info()], true, PROTOCOL_VERSION - 1);
  check('el cartel de servidor anterior gana aunque el hello traiga CLIs',
    outdatedWithAgents.cliAvailable === false && /version anterior/.test(outdatedWithAgents.cliMissingMessage ?? ''),
    JSON.stringify(outdatedWithAgents));
  check('antes de hello la version no se mira: arranque optimista igual',
    summarizeAgents([], false, 0).cliAvailable === true && summarizeAgents([], false, 0).cliMissingMessage === null);
  const current = summarizeAgents([info()], true, PROTOCOL_VERSION);
  const newer = summarizeAgents([info()], true, PROTOCOL_VERSION + 1);
  check('hello de esta version, o de una mas nueva: lo de siempre, sin cartel',
    sameShape(current, one) && sameShape(newer, one), JSON.stringify({ current, newer }));
}

// ---------------------------------------------------------------------------
// Utilidades para lo que sigue
// ---------------------------------------------------------------------------

const {
  EFFORT_OPTIONS,
  LAUNCH_PERMISSION_MODE,
  MODEL_OPTIONS,
  PERMISSION_MODE_CYCLE,
} = shared;
const { AgentRegistry, resolveAgentForOpen } = await import('../src/agents/registry.ts');
const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
const { claudeCodeEnvironment } = await import('../src/agents/claude-code/environment.ts');
const { sessionFilePath, sessionsRoot } = await import('../src/agents/claude-code/paths.ts');

/** Espera a que `condition()` sea verdad, con plazo. Nunca un sleep fijo. */
async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

const line = (o) => JSON.stringify(o) + '\n';
const userLine = (id, cwd, content) => line({
  type: 'user', uuid: id, timestamp: new Date().toISOString(), cwd,
  message: { role: 'user', content },
});
const assistantLine = (id, model, tokens) => line({
  type: 'assistant', uuid: id, timestamp: new Date().toISOString(),
  message: {
    role: 'assistant', model, content: [{ type: 'text', text: 'listo' }],
    usage: { input_tokens: tokens, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  },
});

// ---------------------------------------------------------------------------
// 3. El registro de adaptadores, con dos falsos
// ---------------------------------------------------------------------------

{
  let running = 0;
  let peak = 0;
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const disposed = [];

  const fakeAdapter = (id, { found, strips, dir }) => ({
    id,
    label: id.toUpperCase(),
    command: id,
    installUrl: `https://example.com/${id}`,
    capabilities: NO_CAPABILITIES,
    async locate() {
      running += 1;
      peak = Math.max(peak, running);
      // Los dos tienen que estar adentro a la vez: si el registro los
      // localizara de a uno, el primero se queda esperando al segundo hasta
      // el plazo y `peak` nunca pasa de 1.
      if (running === 2) releaseGate();
      await Promise.race([gate, new Promise((resolve) => setTimeout(resolve, 1000))]);
      running -= 1;
      return found ? { resolvedPath: `/bin/${id}`, file: `/bin/${id}`, prefixArgs: [], version: `${id} 1.0` } : null;
    },
    missingMessage: () => `falta ${id}`,
    launch: () => { throw new Error('no se lanza en el chequeo'); },
    environment(base) {
      const env = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && key !== strips) env[key] = value;
      }
      return { env, notice: null };
    },
    onSpawned: () => null,
    history: null,
    status: null,
    defaults: async () => null,
    protectedDirs: () => [dir, '/compartida'],
    dispose: () => disposed.push(id),
  });

  const registry = new AgentRegistry([
    fakeAdapter('fake-a', { found: false, strips: 'SOLO_A', dir: '/a' }),
    fakeAdapter('fake-b', { found: true, strips: 'SOLO_B', dir: '/b' }),
  ]);
  check('antes de localizar no hay ninguna disponible', registry.defaultAgent() === null && !registry.anyAvailable());
  await registry.locateAll();
  check('locateAll localiza en paralelo', peak === 2, `pico ${peak}`);
  check('defaultAgent es la primera disponible en orden de registro', registry.defaultAgent() === 'fake-b');
  check('anyAvailable con una instalada', registry.anyAvailable() === true);

  const listed = registry.list();
  check('list sigue el orden de registro', listed.map((a) => a.id).join(',') === 'fake-a,fake-b');
  check('missingMessage solo en la ausente',
    listed[0].missingMessage === 'falta fake-a' && listed[0].available === false &&
    listed[1].missingMessage === null && listed[1].available === true);
  check('version de la ubicacion, o null', listed[0].version === null && listed[1].version === 'fake-b 1.0');

  const env = registry.composedEnvironment({ SOLO_A: '1', SOLO_B: '2', PATH: 'x', VACIA: undefined });
  check('composedEnvironment aplica los filtros de todos', sameShape(env, { PATH: 'x' }), JSON.stringify(env));
  check('protectedDirs une las de todos sin repetir',
    sameShape([...registry.protectedDirs()].sort(), ['/a', '/b', '/compartida']));
  check('get de un id desconocido es null', registry.get('nope') === null);
  let threw = false;
  try { registry.adapter('nope'); } catch { threw = true; }
  check('adapter de un id desconocido lanza', threw);
  registry.disposeAll();
  check('disposeAll suelta a todos', disposed.join(',') === 'fake-a,fake-b');

  const none = new AgentRegistry([fakeAdapter('fake-c', { found: false, strips: 'X', dir: '/c' })]);
  releaseGate();
  await none.locateAll();
  check('ninguna disponible: defaultAgent null y anyAvailable false', none.defaultAgent() === null && none.anyAvailable() === false);

  let duplicated = false;
  try {
    new AgentRegistry([fakeAdapter('fake-d', { found: true, strips: 'X', dir: '/d' }), fakeAdapter('fake-d', { found: true, strips: 'X', dir: '/d' })]);
  } catch { duplicated = true; }
  check('un id registrado dos veces no se acepta', duplicated);
}

// ---------------------------------------------------------------------------
// 4. El adaptador de claude-code
// ---------------------------------------------------------------------------

const adapter = createClaudeCodeAdapter();
{
  // Copia literal: si alguien apaga una capacidad, esto falla aunque la
  // pantalla no tenga tests.
  const expected = {
    sessionIdAtLaunch: true,
    resume: true,
    statusSource: true,
    readySignal: true,
    permissionCycle: { modes: PERMISSION_MODE_CYCLE, launchMode: LAUNCH_PERMISSION_MODE, keyLabel: 'shift+tab' },
    models: MODEL_OPTIONS,
    efforts: EFFORT_OPTIONS,
    questionCards: true,
    imagesByPath: 'at-quoted',
    fileMentions: 'at',
    rewind: true,
    contextWindowSource: 'usage-with-variants',
    plans: true,
  };
  check('capacidades de claude-code iguales al literal', sameShape(adapter.capabilities, expected), JSON.stringify(adapter.capabilities));
  check('el ciclo declarado es el que usa el servidor', sameShape([...adapter.capabilities.permissionCycle.modes], [...PERMISSION_MODE_CYCLE]));
  check('las capacidades sobreviven al viaje por la red',
    sameShape(parseAgentCapabilities(JSON.parse(JSON.stringify(adapter.capabilities))), expected));
  // El envio: una sola pieza con el Enter adentro, como siempre (hito 25, A2).
  check('envio de claude-code igual al literal',
    sameShape(adapter.input, { imageReference: 'at-quoted', pieceGapMs: 0, pasteMarkers: true, enterSeparately: false, interruptPresses: 1 }),
    JSON.stringify(adapter.input));
  check('id, comando y etiqueta', adapter.id === 'claude-code' && adapter.command === 'claude' && adapter.label === 'Claude Code');
  check('AGENT_IDS nombra al adaptador', AGENT_IDS.includes(adapter.id));

  const missingToday =
    'No se encontro el comando "claude" en el PATH. ' +
    'Agent Workbench usa la CLI que ya tengas instalada: no la incluye ni la descarga. ' +
    'Instalala desde https://docs.claude.com/en/docs/claude-code/setup y volve a arrancar.';
  check('missingMessage igual, byte por byte, al de antes', adapter.missingMessage() === missingToday, adapter.missingMessage());

  const location = { resolvedPath: '/bin/claude', file: '/bin/claude', prefixArgs: [], version: '2.1.263' };
  const fresh = adapter.launch({ location, cwd: '/p', resumeSessionId: null, proposedSessionId: 'nuevo' });
  check('sesion nueva: --permission-mode auto y --session-id propuesto',
    fresh.file === '/bin/claude' && sameShape(fresh.args, ['--permission-mode', 'auto', '--session-id', 'nuevo']),
    JSON.stringify(fresh.args));
  check('sesion nueva: el id es conocido y es el propuesto', sameShape(fresh.session, { kind: 'known', sessionId: 'nuevo' }));

  const resumed = adapter.launch({ location, cwd: '/p', resumeSessionId: 'viejo', proposedSessionId: 'nuevo' });
  check('reanudar: --resume con el id existente',
    sameShape(resumed.args, ['--permission-mode', 'auto', '--resume', 'viejo']), JSON.stringify(resumed.args));
  check('reanudar: el id es el reanudado', sameShape(resumed.session, { kind: 'known', sessionId: 'viejo' }));

  const shim = adapter.launch({
    location: { resolvedPath: 'C:\\x.cmd', file: 'cmd.exe', prefixArgs: ['/c', 'x.cmd'], version: null },
    cwd: '/p', resumeSessionId: null, proposedSessionId: 'nuevo',
  });
  check('con un shim, los argumentos del interprete van primero',
    shim.file === 'cmd.exe' && sameShape(shim.args.slice(0, 2), ['/c', 'x.cmd']), JSON.stringify(shim.args));
  const modeIndex = fresh.args.indexOf('--permission-mode');
  check('el modo de arranque y el punto de partida del ciclo son el mismo valor',
    adapter.capabilities.permissionCycle.launchMode === LAUNCH_PERMISSION_MODE &&
    fresh.args[modeIndex + 1] === LAUNCH_PERMISSION_MODE);

  const context = (resumedFlag, onDone = () => undefined) => ({
    terminalId: 't', sessionId: 's', cwd: '/p', resumed: resumedFlag, pid: 1, launchedAt: Date.now(),
    readOutput: () => '', write: () => true, onDone, reportSessionId: () => undefined,
  });
  check('una sesion nueva no arranca el contestador del dialogo', adapter.onSpawned(context(false)) === null);
  let outcome = null;
  const hook = adapter.onSpawned(context(true, (value) => { outcome = value; }));
  // Sin `onInput`: es lo que hace que el registro lo cancele en cuanto alguien escribe.
  check('una reanudacion si lo arranca, como un gancho que solo se cancela',
    typeof hook?.cancel === 'function' && hook.onExit === undefined && hook.onSubmitted === undefined &&
    hook.onInput === undefined);
  hook?.cancel();
  check('y se puede cancelar', outcome === 'cancelled', String(outcome));

  check('protectedDirs es la carpeta de la CLI del home', sameShape(adapter.protectedDirs(), [path.join(home, '.claude')]),
    JSON.stringify(adapter.protectedDirs()));
}

// ---------------------------------------------------------------------------
// 5. El entorno
// ---------------------------------------------------------------------------

{
  const base = { PATH: 'p', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_OTRA: 'x', ANTHROPIC_API_KEY: 'k', VACIA: undefined };
  const withMarker = claudeCodeEnvironment(base);
  check('el marcador se quita y se avisa',
    !('CLAUDE_CODE_CHILD_SESSION' in withMarker.env) && withMarker.notice === 'child-session-marker');
  check('las demas CLAUDE_CODE_* pasan intactas', withMarker.env.CLAUDE_CODE_OTRA === 'x');
  check('una credencial que ya estaba queda igual, no se toca', withMarker.env.ANTHROPIC_API_KEY === 'k');
  check('ninguna clave nueva', Object.keys(withMarker.env).every((key) => key in base), Object.keys(withMarker.env).join(','));
  check('un valor undefined no pasa', !('VACIA' in withMarker.env));

  const clean = claudeCodeEnvironment({ PATH: 'p' });
  check('sin el marcador no hay aviso', clean.notice === null);
  check('una credencial ausente no aparece', sameShape(clean.env, { PATH: 'p' }), JSON.stringify(clean.env));
  check('el adaptador usa ese mismo entorno', sameShape(adapter.environment(base), withMarker));

  // La consola del pie no es de ninguna CLI y aun asi no hereda el marcador:
  // un `claude` lanzado a mano desde ahi tiene que guardar su historial. Desde
  // el hito 25 las pestanas usan el mismo entorno (C22).
  const { createAgentRegistry } = await import('../src/agents/registry.ts');
  const appRegistry = createAgentRegistry();
  const consoleEnv = appRegistry.composedEnvironment(base);
  check('la consola de la app no hereda el marcador y no gana nada',
    !('CLAUDE_CODE_CHILD_SESSION' in consoleEnv) && Object.keys(consoleEnv).every((key) => key in base) &&
    consoleEnv.PATH === 'p', JSON.stringify(consoleEnv));
  check('con las CLIs de la app registradas, el entorno compuesto es el de claude-code: las demas no quitan nada',
    sameShape(consoleEnv, withMarker.env), JSON.stringify(consoleEnv));
  appRegistry.disposeAll();
}

// ---------------------------------------------------------------------------
// 2. Las pestanas guardadas (workspace.json)
// ---------------------------------------------------------------------------

{
  const { WorkspaceStore, persistableTabs } = await import('../src/workspace-store.ts');
  const { workspaceStatePath } = await import('../src/paths.ts');
  const { readFile } = await import('node:fs/promises');
  const statePath = workspaceStatePath();
  check('workspace.json cae dentro de la carpeta temporal', statePath.startsWith(root), statePath);
  await mkdir(path.dirname(statePath), { recursive: true });

  /** Copia literal del parser de la version 1 anterior al hito 24. */
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

  const quietly = async (run) => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    try { return { value: await run(), warnings }; } finally { console.warn = originalWarn; }
  };

  const store = new WorkspaceStore();

  await writeFile(statePath, JSON.stringify({ version: 1, tabs: [{ cwd: 'D:\\p', sessionId: 's1', label: 'uno' }] }));
  const legacy = await store.load();
  check('un workspace.json de antes, sin agent, se lee como claude-code',
    sameShape(legacy.tabs, [{ agent: 'claude-code', cwd: 'D:\\p', sessionId: 's1', label: 'uno' }]), JSON.stringify(legacy.tabs));

  const tabs = [
    { agent: 'claude-code', cwd: 'D:\\p', sessionId: 's1', label: 'uno' },
    { agent: 'claude-code', cwd: '/q', sessionId: 's2', label: '' },
  ];
  store.save({ tabs, foreignTabs: [] });
  await store.flush();
  const written = JSON.parse(await readFile(statePath, 'utf8'));
  check('lo escrito sigue en version 1', written.version === 1, String(written.version));
  check('cada pestana escrita dice su CLI', written.tabs.every((tab) => tab.agent === 'claude-code'), JSON.stringify(written.tabs));
  check('ida y vuelta: save + flush + load', sameShape((await store.load()).tabs, tabs), JSON.stringify((await store.load()).tabs));
  check('el parser de la version anterior lee lo que escribe esta',
    sameShape(legacyParseState(JSON.stringify(written))?.tabs, tabs.map(({ agent, ...rest }) => rest)),
    JSON.stringify(legacyParseState(JSON.stringify(written))));

  await writeFile(statePath, JSON.stringify({
    version: 1,
    tabs: [
      { agent: 'claude-code', cwd: 'D:\\a', sessionId: 'sa', label: '' },
      { agent: 'nope', cwd: 'D:\\b', sessionId: 'sb', label: '' },
      { cwd: 'D:\\c', sessionId: 'sc', label: 'c' },
    ],
  }));
  const mixed = await quietly(() => store.load());
  check('una pestana de una CLI desconocida no se restaura y las demas quedan',
    mixed.value.tabs.map((tab) => `${tab.agent}:${tab.sessionId}`).join(',') === 'claude-code:sa,claude-code:sc',
    JSON.stringify(mixed.value.tabs));
  // Desde el hito 25 se conserva cruda en vez de perderse (D15).
  check('pero se conserva cruda, en su lugar',
    sameShape(mixed.value.foreignTabs, [{ position: 1, raw: { agent: 'nope', cwd: 'D:\\b', sessionId: 'sb', label: '' } }]),
    JSON.stringify(mixed.value.foreignTabs));
  check('y se avisa por consola', mixed.warnings.length === 1 && mixed.warnings[0].includes('D:\\b'), JSON.stringify(mixed.warnings));

  await writeFile(statePath, JSON.stringify({ version: 99, tabs }));
  check('una version desconocida arranca sin pestanas', sameShape(await store.load(), { tabs: [], foreignTabs: [] }));

  const descriptor = (overrides) => ({
    terminalId: 't', kind: 'agent', agent: 'claude-code', cwd: 'D:\\p', sessionId: 's', label: 'l',
    resumed: false, createdAt: 1, alive: true, exitCode: null, sleeping: false, ...overrides,
  });
  const persisted = persistableTabs([
    descriptor({ terminalId: 'a', sessionId: 'sa' }),
    descriptor({ terminalId: 'b', kind: 'shell', agent: null, sessionId: '' }),
    descriptor({ terminalId: 'c', agent: null, sessionId: 'sc' }),
    descriptor({ terminalId: 'd', sessionId: '' }),
    descriptor({ terminalId: 'e', sessionId: 'se', cwd: '/q', label: '' }),
  ]);
  check('persistableTabs guarda solo pestanas de una CLI con id de sesion, en orden',
    sameShape(persisted, [
      { agent: 'claude-code', cwd: 'D:\\p', sessionId: 'sa', label: 'l' },
      { agent: 'claude-code', cwd: '/q', sessionId: 'se', label: '' },
    ]), JSON.stringify(persisted));
}

// ---------------------------------------------------------------------------
// 10. Que CLI usa una pestana nueva
// ---------------------------------------------------------------------------

{
  const base = {
    requested: undefined, cwd: 'D:\\Proyecto', resumeSessionId: undefined, sessionAgent: null,
    tabs: [], defaultAgent: 'fake-default', platform: 'win32',
  };
  const tab = (agent, cwd, kind = 'agent') => ({ kind, agent, cwd });
  const resolve = (overrides) => resolveAgentForOpen({ ...base, ...overrides });

  check('la CLI pedida gana', resolve({
    requested: 'fake-pedida', tabs: [tab('fake-tab', 'D:\\Proyecto')], resumeSessionId: 's', sessionAgent: 'fake-sesion',
  }) === 'fake-pedida');
  check('sin pedido, la de la ultima pestana del mismo proyecto (mayusculas y barras distintas en win32)',
    resolve({ tabs: [tab('fake-primera', 'D:\\Proyecto'), tab('fake-ultima', 'd:/proyecto/'), tab('fake-otro', 'D:\\Otro')] }) === 'fake-ultima',
    String(resolve({ tabs: [tab('fake-primera', 'D:\\Proyecto'), tab('fake-ultima', 'd:/proyecto/'), tab('fake-otro', 'D:\\Otro')] })));
  check('en linux las mayusculas separan proyectos',
    resolve({ platform: 'linux', cwd: '/p', tabs: [tab('fake-tab', '/P')] }) === 'fake-default');
  check('sin pestana del proyecto, la CLI por defecto', resolve({ tabs: [tab('fake-tab', 'D:\\Otro')] }) === 'fake-default');
  check('una consola del mismo proyecto no cuenta',
    resolve({ tabs: [tab(null, 'D:\\Proyecto', 'shell'), tab('fake-raro', 'D:\\Proyecto', 'shell')] }) === 'fake-default');
  check('sin nada, null', resolve({ defaultAgent: null }) === null);
  check('reanudando, la CLI de la sesion y no la de la pestana del proyecto',
    resolve({ resumeSessionId: 's', sessionAgent: 'fake-sesion', tabs: [tab('fake-tab', 'D:\\Proyecto')] }) === 'fake-sesion');
  check('reanudando una sesion que el indice no conoce, la por defecto y nunca la de la pestana',
    resolve({ resumeSessionId: 's', sessionAgent: null, tabs: [tab('fake-tab', 'D:\\Proyecto')] }) === 'fake-default');
  check('reanudando sin nada, null',
    resolve({ resumeSessionId: 's', sessionAgent: null, defaultAgent: null, tabs: [tab('fake-tab', 'D:\\Proyecto')] }) === null);
}

// ---------------------------------------------------------------------------
// 6. hello armado por el registro real, de punta a punta (paso 7)
// ---------------------------------------------------------------------------

{
  const { encodeServerMessage, parseServerMessage } = shared;
  const { summarizeAgents } = await import('../../web/src/agent-summary.ts');
  const real = createClaudeCodeAdapter();
  const agents = new AgentRegistry([real]);
  const helloFrom = () => parseServerMessage(encodeServerMessage({
    type: 'hello', protocolVersion: 6, agents: agents.list(), defaultAgent: agents.defaultAgent(),
    platform: process.platform, defaultCwd: home, shellName: null,
  }));
  const MARKER = 'CLAUDE_CODE_CHILD_SESSION';
  const savedMarker = process.env[MARKER];
  delete process.env[MARKER];

  try {
    const absent = helloFrom();
    const absentSummary = summarizeAgents(absent.agents, true);
    check('sin la CLI: hello la anuncia ausente y sin CLI por defecto',
      absent.agents.length === 1 && absent.agents[0].available === false && absent.defaultAgent === null, JSON.stringify(absent.agents));
    check('sin la CLI: el cartel dice el texto de siempre, byte por byte',
      absentSummary.cliAvailable === false && absentSummary.cliMissingMessage === real.missingMessage(), String(absentSummary.cliMissingMessage));

    agents.get('claude-code').location = { resolvedPath: '/bin/claude', file: '/bin/claude', prefixArgs: [], version: '2.1.263' };
    const present = helloFrom();
    const presentSummary = summarizeAgents(present.agents, true);
    check('con la CLI: disponible, por defecto, y la etiqueta de la cabecera es su version',
      present.defaultAgent === 'claude-code' && presentSummary.cliAvailable && presentSummary.cliVersion === '2.1.263' &&
      presentSummary.cliMissingMessage === null, JSON.stringify(presentSummary));
    check('con la CLI: las capacidades llegan al cliente enteras',
      sameShape(present.agents[0].capabilities, real.capabilities), JSON.stringify(present.agents[0].capabilities));
    check('sin el marcador en el entorno, ningun aviso', presentSummary.environmentNotice === null);

    process.env[MARKER] = '1';
    check('con el marcador heredado, el aviso llega al cliente',
      summarizeAgents(helloFrom().agents, true).environmentNotice === 'child-session-marker');
  } finally {
    if (savedMarker === undefined) delete process.env[MARKER];
    else process.env[MARKER] = savedMarker;
    real.dispose();
  }
}

// ---------------------------------------------------------------------------
// Capacidades en la interfaz (paso 8)
// ---------------------------------------------------------------------------
//
// La web no tiene tests: una capacidad mal traducida esconde un control sin
// que falle nada (R10). Todo lo que la pantalla decide a partir de las
// capacidades pasa por `web/src/agent-ui.ts`, y aca se compara con lo que se
// veia antes, texto por texto.

{
  const { encodeServerMessage, parseServerMessage, PERMISSION_MODE_HINT, PERMISSION_MODE_LABEL } = shared;
  const ui = await import('../../web/src/agent-ui.ts');
  const real = createClaudeCodeAdapter();
  const agents = new AgentRegistry([real]);
  agents.get('claude-code').location = { resolvedPath: '/bin/claude', file: '/bin/claude', prefixArgs: [], version: '2.1.263' };
  // Las capacidades tal como las ve el cliente: despues de viajar en hello.
  const hello = parseServerMessage(encodeServerMessage({
    type: 'hello', protocolVersion: 6, agents: agents.list(), defaultAgent: agents.defaultAgent(),
    platform: process.platform, defaultCwd: home, shellName: null,
  }));
  const claude = hello.agents[0];
  const controls = ui.controlsFor(claude.capabilities);

  // --- Con claude-code, todo encendido y con los valores de siempre ---
  check('claude-code: combo de modo con el ciclo de siempre, desde auto, con shift+tab',
    controls.modeCycle !== null && sameShape([...controls.modeCycle.modes], [...PERMISSION_MODE_CYCLE]) &&
    controls.modeCycle.launchMode === 'auto' && controls.modeCycle.keyLabel === 'shift+tab', JSON.stringify(controls.modeCycle));
  check('claude-code: combo de modelo con las opciones de siempre, en orden',
    controls.models !== null && JSON.stringify(controls.models) === JSON.stringify(MODEL_OPTIONS));
  check('claude-code: combo de esfuerzo con los niveles de siempre, en orden',
    controls.efforts !== null && JSON.stringify(controls.efforts) === JSON.stringify(EFFORT_OPTIONS));
  check('claude-code: imagenes, volver aqui, preguntas, @ruta, planes y nota, todo encendido',
    controls.imagesAllowed && controls.rewind && controls.questionsAnswerable && controls.fileMentions &&
    controls.plansAvailable && controls.noteSendable, JSON.stringify(controls));
  check('claude-code: el medidor mide con variantes', controls.contextWindowSource === 'usage-with-variants');

  // --- Sin capacidades, todo apagado ---
  const none = ui.controlsFor(NO_CAPABILITIES);
  check('sin capacidades: ningun combo',
    none.modeCycle === null && none.models === null && none.efforts === null, JSON.stringify(none));
  check('sin capacidades: sin imagenes, volver aqui, preguntas, @ruta, planes, nota ni medidor',
    !none.imagesAllowed && !none.rewind && !none.questionsAnswerable && !none.fileMentions &&
    !none.plansAvailable && !none.noteSendable && none.contextWindowSource === null, JSON.stringify(none));

  // --- Cada capacidad apaga su control y ninguno mas ---
  const controlOf = {
    permissionCycle: 'modeCycle', models: 'models', efforts: 'efforts', imagesByPath: 'imagesAllowed',
    rewind: 'rewind', questionCards: 'questionsAnswerable', fileMentions: 'fileMentions', plans: 'plansAvailable',
    contextWindowSource: 'contextWindowSource', readySignal: 'noteSendable',
  };
  for (const [capability, control] of Object.entries(controlOf)) {
    const without = ui.controlsFor({ ...claude.capabilities, [capability]: NO_CAPABILITIES[capability] });
    const changed = Object.keys(controls).filter((key) => JSON.stringify(without[key]) !== JSON.stringify(controls[key]));
    check(`sin ${capability} se apaga ${control} y nada mas`, sameShape(changed, [control]), changed.join(','));
  }

  // --- Modelo: se casa como siempre, dentro de lo que ofrece la CLI ---
  check('el modelo observado se casa con su opcion',
    ui.modelOptionIn(controls.models, 'claude-opus-5[1m]')?.value === 'opus[1m]' &&
    ui.modelOptionIn(controls.models, 'claude-haiku-4-5-20251001')?.value === 'haiku');
  check('un modelo desconocido no casa', ui.modelOptionIn(controls.models, 'gpt-5.6-terra') === null);
  check('una opcion que la CLI no ofrece no casa',
    ui.modelOptionIn(MODEL_OPTIONS.filter((option) => option.value !== 'opus[1m]'), 'claude-opus-5[1m]') === null);

  // --- Modo: lo que se muestra y su titulo, iguales a antes ---
  const cycle = controls.modeCycle;
  check('sin observacion se muestra el modo de arranque', ui.shownMode(null, cycle) === 'auto');
  check('el modo de arranque sale de la capacidad, no de una constante',
    ui.shownMode(null, { ...cycle, launchMode: 'plan' }) === 'plan');
  check('con observacion se muestra lo observado', ui.shownMode('plan', cycle) === 'plan');
  check('titulo del combo de modo igual al de antes',
    ui.modeTitle('auto', cycle) ===
      'Modo Automatico: La CLI decide sola que herramientas usar sin preguntar. Cambiarlo manda shift+tab a la pestaña CLI',
    ui.modeTitle('auto', cycle));
  check('titulo de cada modo con la plantilla de antes',
    PERMISSION_MODE_CYCLE.every((mode) => ui.modeTitle(mode, cycle) ===
      `Modo ${PERMISSION_MODE_LABEL[mode]}: ${PERMISSION_MODE_HINT[mode]}. Cambiarlo manda shift+tab a la pestaña CLI`));
  check('la tecla del titulo sale de la capacidad', ui.modeTitle('plan', { ...cycle, keyLabel: 'tab' }).endsWith('manda tab a la pestaña CLI'));

  // --- Solapas (M8: Memoria no se filtra) ---
  const tabs = ['cli', 'git', 'files', 'plans', 'memory'].map((id) => ({ id, label: id }));
  check('con planes: las cinco solapas, en orden',
    sameShape(ui.visiblePanelTabs(tabs, true).map((tab) => tab.id), ['cli', 'git', 'files', 'plans', 'memory']));
  check('sin planes: se va Planes y Memoria queda',
    sameShape(ui.visiblePanelTabs(tabs, false).map((tab) => tab.id), ['cli', 'git', 'files', 'memory']));
  check('la solapa guardada Planes se muestra como CLI si no hay planes', ui.effectivePanelTab('plans', false) === 'cli');
  check('con planes, Planes se muestra', ui.effectivePanelTab('plans', true) === 'plans');
  check('Memoria y las demas no dependen de los planes',
    ['memory', 'git', 'files', 'cli'].every((tab) => ui.effectivePanelTab(tab, false) === tab));

  // --- Dialogo de atajos (A9) ---
  const missing = { ...claude, available: false, version: null, missingMessage: 'falta' };
  const other = { ...claude, id: 'otra', label: 'Otra' };
  check('atajos: la CLI de la pestana activa', ui.shortcutsAgent('claude-code', [other, claude], 'otra') === claude);
  check('atajos sin pestana: la CLI por defecto', ui.shortcutsAgent(null, [other, claude], 'claude-code') === claude);
  check('atajos con una pestana de una CLI que no se conoce: la por defecto', ui.shortcutsAgent('otra-mas', [claude], 'claude-code') === claude);
  check('atajos con la CLI ausente: igual se habla de la registrada', ui.shortcutsAgent(null, [missing], null) === missing);
  check('atajos antes de hello: ninguna', ui.shortcutsAgent(null, [], null) === null);

  const cliShortcutsToday = [
    { keys: 'Esc', description: 'Interrumpir lo que la CLI esté haciendo' },
    { keys: 'Esc Esc', description: 'Abrir el menú de rewind' },
    { keys: 'Ctrl + C', description: 'Cancelar' },
    { keys: 'Ctrl + R', description: 'Buscar en el historial de comandos' },
    { keys: 'Ctrl + O', description: 'Ver la salida completa' },
    { keys: 'Shift + Tab', description: 'Cambiar el modo de permisos (con el foco en la terminal)' },
    { keys: 'Alt + V', description: 'Pegar una imagen del portapapeles' },
    { keys: 'Ctrl + V', description: 'Pegar texto del portapapeles' },
  ];
  check('atajos de la terminal de claude-code iguales a los de antes, en orden',
    JSON.stringify(ui.AGENT_UI['claude-code'].shortcuts) === JSON.stringify(cliShortcutsToday));
  check('cada CLI con adaptador tiene su entrada de pantalla',
    AGENT_IDS.every((id) => ui.AGENT_UI[id] !== undefined && ui.AGENT_UI[id].shortcuts.length > 0));

  const composerToday = [
    { keys: 'Enter', description: 'Enviar el mensaje' },
    { keys: 'Shift + Enter', description: 'Salto de línea sin enviar' },
    { keys: 'Ctrl + V', description: 'Pegar texto o una imagen (queda como miniatura)' },
    { keys: 'Esc', description: 'Interrumpir lo que la CLI esté haciendo' },
  ];
  check('atajos del cuadro con imagenes iguales a los de antes',
    JSON.stringify(ui.composerShortcuts(true)) === JSON.stringify(composerToday));
  const noImages = ui.composerShortcuts(false);
  check('atajos del cuadro sin imagenes: Ctrl+V no promete una imagen, lo demas igual',
    noImages.length === 4 && !noImages[2].description.includes('imagen') &&
    JSON.stringify([noImages[0], noImages[1], noImages[3]]) === JSON.stringify([composerToday[0], composerToday[1], composerToday[3]]),
    JSON.stringify(noImages));

  // --- Medidor (M7) ---
  check('archivo de instrucciones de claude-code', ui.instructionsFileFor('claude-code') === 'CLAUDE.md' && ui.instructionsFileFor(null) === null);
  check('titulo del medidor vacio igual al de antes',
    ui.meterIdleDetail('CLAUDE.md') ===
      'La sesion todavia no midio ninguna respuesta. No arranca en cero: el prompt de sistema, las herramientas y el CLAUDE.md ya ocupan contexto, y el numero real aparece con la primera respuesta.',
    ui.meterIdleDetail('CLAUDE.md'));
  check('titulo del medidor vacio sin archivo conocido: no nombra ninguno',
    !ui.meterIdleDetail(null).includes('CLAUDE.md') && ui.meterIdleDetail(null).includes('instrucciones'));

  // --- Punto de la pestana ---
  check('punto: libre, y abierta sin estado, con los titulos de antes',
    ui.restingDotTitle('idle') === 'Lista, sin nada en curso' && ui.restingDotTitle(undefined) === 'CLI abierta' &&
    ui.restingDotTitle('offline') === 'CLI abierta');
  check('punto: una CLI que no publica su estado lo dice', ui.restingDotTitle('unknown') === 'Esta CLI no publica su estado');

  // --- Reanudar desde la barra ---
  check('reanudar antes de hello: como siempre, habilitado', ui.sessionResumable([], 'claude-code') === true);
  check('reanudar con la CLI instalada', ui.sessionResumable([claude], 'claude-code') === true);
  check('reanudar con la CLI ausente: no', ui.sessionResumable([missing], 'claude-code') === false);
  check('reanudar con una CLI que no sabe reanudar: no',
    ui.sessionResumable([{ ...claude, capabilities: { ...claude.capabilities, resume: false } }], 'claude-code') === false);
  check('reanudar una sesion de una CLI que no esta en la lista: no', ui.sessionResumable([other], 'claude-code') === false);

  // --- Mandar una nota (M6) ---
  check('nota sin pestana: el titulo de antes',
    ui.noteSendTitle(false, null, false) === 'Abri una pestana primero: la conversacion se abre en su proyecto');
  check('nota vacia: el titulo de antes', ui.noteSendTitle(true, 'D:\\p', true) === 'La nota esta vacia');
  check('nota lista: el titulo de antes',
    ui.noteSendTitle(true, 'D:\\p', false) === 'Mandar la nota al agente en una conversacion nueva de D:\\p');
  check('nota con una CLI que no avisa cuando esta lista: lo dice, no pide abrir una pestana',
    ui.noteSendTitle(false, 'D:\\p', false).includes('no avisa') && !ui.noteSendTitle(false, 'D:\\p', false).startsWith('Abri'));

  real.dispose();
}

// ---------------------------------------------------------------------------
// 11. El selector de carpetas no entra en las carpetas de las CLIs
// ---------------------------------------------------------------------------

{
  const { DirectoryPickers, DirectoryPickerError, isInsideProtected } = await import('../src/directory-picker.ts');
  const dir = path.join(root, 'protegida');
  check('la carpeta protegida misma', isInsideProtected(dir, [dir]));
  check('algo adentro de la carpeta protegida', isInsideProtected(path.join(dir, 'sub'), [dir]));
  check('una hermana con el mismo prefijo no', !isInsideProtected(`${dir}-otro`, [dir]));
  check('sin carpetas protegidas, nada lo es', !isInsideProtected(dir, []));
  check('cualquiera de varias', isInsideProtected(path.join(dir, 'x'), [path.join(root, 'otra'), dir]));

  // De punta a punta con lo que declara el registro: el home temporal tiene
  // `.claude` y una carpeta de proyecto.
  const real = createClaudeCodeAdapter();
  const agents = new AgentRegistry([real]);
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(home, 'proyecto-visible'), { recursive: true });
  const pickers = new DirectoryPickers(agents.protectedDirs());
  const listing = await pickers.open();
  check('el selector lista el home sin la carpeta de la CLI',
    listing.entries.includes('proyecto-visible') && !listing.entries.includes('.claude'), JSON.stringify(listing.entries));
  const rejection = async (run) => {
    try { await run(); return null; } catch (error) { return error; }
  };
  const entered = await rejection(() => pickers.enter(listing.pickerId, '.claude'));
  check('no se puede entrar a la carpeta de la CLI: ni siquiera esta en el listado',
    entered instanceof DirectoryPickerError && /no esta en el listado/.test(entered.message), String(entered?.message));

  // La proteccion de `enter` es una segunda defensa: por el listado no se
  // llega nunca, porque lo protegido no se lista. Para probarla hace falta
  // una carpeta que se listo **antes** de quedar protegida, y eso es lo que
  // hace este arreglo, que el selector recibe por referencia.
  const lateProtected = [];
  const latePickers = new DirectoryPickers(lateProtected);
  const lateListing = await latePickers.open();
  check('antes de protegerla, la carpeta se lista', lateListing.entries.includes('proyecto-visible'), JSON.stringify(lateListing.entries));
  lateProtected.push(path.join(home, 'proyecto-visible'));
  const lateEntered = await rejection(() => latePickers.enter(lateListing.pickerId, 'proyecto-visible'));
  check('enter rechaza una carpeta protegida aunque estuviera en el listado: lo frena la proteccion',
    lateEntered instanceof DirectoryPickerError && /es de la CLI/.test(lateEntered.message), String(lateEntered?.message));
  check('y el selector no se movio', latePickers.currentPath(lateListing.pickerId) === home, String(latePickers.currentPath(lateListing.pickerId)));
  latePickers.closeAll();
  const created = await rejection(() => pickers.create(listing.pickerId, '.claude'));
  check('ni crear una carpeta con su ruta: lo frena la proteccion, no el disco',
    created instanceof DirectoryPickerError && /carpeta de la CLI/.test(created.message), String(created?.message));
  pickers.closeAll();
  real.dispose();
}

// ---------------------------------------------------------------------------
// Historial de claude-code
// ---------------------------------------------------------------------------

{
  const history = adapter.history;
  check('sin carpeta de historial, list es null', (await history.list()) === null);
  check('la raiz observada es la del historial',
    history.roots().length === 1 && history.roots()[0].path === sessionsRoot() &&
    history.roots()[0].accepts('x.jsonl') && !history.roots()[0].accepts('x.json'));

  const projectCwd = path.join(root, 'proyecto-historial');
  await mkdir(projectCwd, { recursive: true });
  const sessionId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const file = sessionFilePath(projectCwd, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file,
    line({ type: 'ai-title', aiTitle: 'Titulo generado', sessionId }) +
    userLine('u1', projectCwd, 'hola') +
    line({ type: 'cost-state', modelUsage: { 'claude-opus-5[1m]': {} } }));
  await writeFile(path.join(path.dirname(file), 'notas.txt'), 'no es una sesion');

  const items = await history.list();
  check('list enumera la sesion y nada mas', items?.length === 1, JSON.stringify(items));
  const [item] = items ?? [];
  check('el item trae ref, id y grupo',
    item?.ref === file && item?.sessionId === sessionId && item?.group === path.basename(path.dirname(file)));
  check('item de la misma ref da lo mismo', sameShape(await history.item(file), item));
  check('item de algo que no existe es null', (await history.item(path.join(root, 'no.jsonl'))) === null);

  check('changedRefs de una sesion es esa sesion', sameShape(await history.changedRefs(file), [file]));
  check('changedRefs de otra cosa en la carpeta es null', (await history.changedRefs(path.join(path.dirname(file), 'notas.txt'))) === null);
  check('changedRefs fuera de la raiz es null', (await history.changedRefs(path.join(root, 'otro', 'x.jsonl'))) === null);

  const scanned = await history.scan(item);
  check('scan lee el cwd del archivo', scanned.cwd === projectCwd, String(scanned.cwd));
  check('scan trae el titulo y deja agent y archived para el indice',
    scanned.summary.title === 'Titulo generado' && scanned.summary.titleSource === 'ai' &&
    !('archived' in scanned.summary) && !('agent' in scanned.summary), JSON.stringify(scanned.summary));
  check('scan guarda los ids de modelo en extra', sameShape(scanned.extra, { modelIds: ['claude-opus-5[1m]'] }));

  check('exists con archivo', (await history.exists(projectCwd, sessionId)) === true);
  check('exists sin archivo', (await history.exists(projectCwd, 'bbbbbbbb-2222-4222-8222-222222222222')) === false);

  // Lo que el escaneo aprende alimenta al medidor: una sesion nueva de la
  // misma instalacion, sin cost-state propio ni configuracion, ya sabe que
  // corre en 1M.
  const otherId = 'cccccccc-3333-4333-8333-333333333333';
  const otherFile = sessionFilePath(projectCwd, otherId);
  await writeFile(otherFile, userLine('u2', projectCwd, 'otra') + assistantLine('a2', 'claude-opus-5', 5000));
  const learned = history.follow({ cwd: projectCwd, sessionId: otherId });
  await learned.start();
  await learned.poll();
  check('el escaneo le ensena la variante al seguidor', learned.getUsage().contextWindow === 1000000,
    String(learned.getUsage().contextWindow));

  // Lo mismo desde la cache, con un adaptador recien creado.
  const restoredAdapter = createClaudeCodeAdapter();
  restoredAdapter.history.restored(item, { modelIds: 'no es una lista' });
  const beforeRestore = restoredAdapter.history.follow({ cwd: projectCwd, sessionId: otherId });
  await beforeRestore.poll();
  check('un extra mal formado no ensena nada', beforeRestore.getUsage().contextWindow === 200000,
    String(beforeRestore.getUsage().contextWindow));
  restoredAdapter.history.restored(item, { modelIds: ['claude-opus-5[1m]'] });
  const afterRestore = restoredAdapter.history.follow({ cwd: projectCwd, sessionId: otherId });
  await afterRestore.poll();
  check('restored ensena lo mismo que el escaneo', afterRestore.getUsage().contextWindow === 1000000,
    String(afterRestore.getUsage().contextWindow));
  restoredAdapter.dispose();

  const plans = history.plans;
  check('los planes estan declarados', plans !== null && typeof plans.describe === 'function' && typeof plans.read === 'function');
}

// ---------------------------------------------------------------------------
// 9. El seguidor de sesion
// ---------------------------------------------------------------------------

{
  const follow9 = createClaudeCodeAdapter();
  const projectCwd = path.join(root, 'proyecto-9');
  const settingsFile = path.join(projectCwd, '.claude', 'settings.json');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ model: 'opus[1m]' }));

  const sessionId = 'dddddddd-4444-4444-8444-444444444444';
  const file = sessionFilePath(projectCwd, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, userLine('u1', projectCwd, 'hola') + assistantLine('a1', 'claude-opus-5', 5000));

  const follower = follow9.history.follow({ cwd: projectCwd, sessionId });
  check('label es la ruta del archivo', follower.label === file, follower.label);
  await follower.start();
  await follower.poll();
  check('la configuracion se aplica antes de la primera lectura: 1M',
    follower.getUsage().contextWindow === 1000000, String(follower.getUsage().contextWindow));

  await writeFile(settingsFile, JSON.stringify({ model: 'opus' }));
  await appendFile(file,
    userLine('u2', projectCwd, '<command-name>/model</command-name><command-args>opus</command-args>') +
    assistantLine('a2', 'claude-opus-5', 6000));
  const result = await follower.poll();
  check('el poll trae lo nuevo', result.added.length >= 1, String(result.added.length));
  check('un /model relee la configuracion en el mismo poll: 200k',
    follower.getUsage().contextWindow === 200000, String(follower.getUsage().contextWindow));

  check('noticeChange de su ruta es true', follower.noticeChange(file) === true);
  check('noticeChange de otra ruta es false', follower.noticeChange(path.join(path.dirname(file), 'otra.jsonl')) === false);
  check('una sesion ya leida no se muda por un archivo con su nombre',
    follower.noticeChange(path.join(sessionsRoot(), 'otra-carpeta', `${sessionId}.jsonl`)) === false && follower.label === file);

  // Re-apuntado: solo un seguidor que todavia espera su archivo se muda.
  const waitingId = 'eeeeeeee-5555-4555-8555-555555555555';
  const waiting = follow9.history.follow({ cwd: projectCwd, sessionId: waitingId });
  await waiting.start();
  await waiting.poll();
  check('sin archivo, el seguidor espera', waiting.getState() === 'waiting');
  const elsewhere = path.join(sessionsRoot(), 'D--otra-forma', `${waitingId.toUpperCase()}.jsonl`);
  check('un archivo ajeno no lo mueve', waiting.noticeChange(path.join(sessionsRoot(), 'x', 'ajeno.jsonl')) === false);
  const originalWarn = console.warn;
  console.warn = () => undefined;
  const moved = waiting.noticeChange(elsewhere);
  console.warn = originalWarn;
  check('un <id>.jsonl en otra carpeta lo muda ahi', moved === true && waiting.label === elsewhere, waiting.label);

  // El aviso del watcher trae las mayusculas de la carpeta en disco, y la ruta
  // propia las del `cwd` de la pestana. En Windows son el mismo archivo: una
  // sesion ya leida que no reconoce su aviso se queda congelada, porque el
  // re-apuntado solo entra mientras espera.
  const { isSameFilePath } = await import('../src/agents/claude-code/session-follower.ts');
  check('misma ruta con otras mayusculas: el mismo archivo en win32',
    isSameFilePath('C:\\h\\.claude\\projects\\D--Agent-X\\a.jsonl', 'c:\\H\\.claude\\projects\\d--agent-x\\A.jsonl', 'win32'));
  check('con otras barras y un \\\\?\\ tambien, en win32',
    isSameFilePath('C:\\h\\projects\\D--Agent-X\\a.jsonl', '\\\\?\\C:/h/projects/D--Agent-X/a.jsonl', 'win32'));
  check('otras mayusculas en linux son otro archivo',
    !isSameFilePath('/h/.claude/projects/-home-Agent-X/a.jsonl', '/h/.claude/projects/-home-agent-x/a.jsonl', 'linux'));
  check('otro archivo no es el mismo en ninguna',
    !isSameFilePath('C:\\p\\a.jsonl', 'C:\\p\\b.jsonl', 'win32') && !isSameFilePath('/p/a.jsonl', '/p/b.jsonl', 'linux'));

  const casedCwd = path.join(root, 'Agent Mayus');
  const casedId = 'ffffffff-6666-4666-8666-666666666666';
  const realFile = sessionFilePath(casedCwd, casedId);
  await mkdir(path.dirname(realFile), { recursive: true });
  await writeFile(realFile, userLine('u1', casedCwd, 'hola') + assistantLine('a1', 'claude-opus-5', 5000));
  if (process.platform === 'win32') {
    const lowerCwd = path.join(root, 'agent mayus');
    const cased = follow9.history.follow({ cwd: lowerCwd, sessionId: casedId });
    await cased.start();
    await cased.poll();
    check('un cwd con otras mayusculas lee el archivo de la carpeta real',
      cased.getState() === 'live' && cased.label !== realFile, `${cased.getState()} ${cased.label}`);
    check('y reconoce el aviso del watcher, que trae las mayusculas de la carpeta',
      cased.noticeChange(realFile) === true && cased.label !== realFile, cased.label);
    await appendFile(realFile, assistantLine('a2', 'claude-opus-5', 6000));
    const fresh = await cased.poll();
    check('lo que llega despues se lee', fresh.added.length >= 1, String(fresh.added.length));
  } else {
    console.log('SALTO un cwd con otras mayusculas: solo en Windows el disco no las distingue');
  }

  follow9.dispose();
}

// ---------------------------------------------------------------------------
// Estado del proceso de claude-code
// ---------------------------------------------------------------------------

{
  const statusAdapter = createClaudeCodeAdapter();
  const sessionId = 'ffffffff-6666-4666-8666-666666666666';
  const stateDir = path.join(home, '.claude', 'sessions');
  await mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, '4242.json');
  const writeState = (state) => writeFile(stateFile, JSON.stringify({ sessionId, ...state }));

  const seen = [];
  await writeState({ status: 'shell' });
  const stop = statusAdapter.status.subscribe(sessionId, (status) => seen.push(status));
  check('un estado nativo desconocido se lee como ocupada',
    await waitFor(() => seen.length >= 1) && sameShape(seen[0], { activity: 'busy', waitingFor: null }), JSON.stringify(seen));

  await writeState({ status: 'waiting', waitingFor: 'permission prompt' });
  check('esperando trae su etiqueta cruda',
    await waitFor(() => seen.length >= 2) && sameShape(seen[1], { activity: 'waiting', waitingFor: 'permission prompt' }), JSON.stringify(seen));

  await writeState({ status: 'idle', waitingFor: 'sobra' });
  check('libre no arrastra etiqueta',
    await waitFor(() => seen.length >= 3) && sameShape(seen[2], { activity: 'idle', waitingFor: null }), JSON.stringify(seen));
  check('waitUntilReady con la CLI libre', (await statusAdapter.status.waitUntilReady(sessionId, 2000)) === true);

  await rm(stateFile);
  check('sin archivo, el listener recibe null', await waitFor(() => seen.length >= 4) && seen[3] === null, JSON.stringify(seen));
  stop();
  statusAdapter.dispose();
}

// ---------------------------------------------------------------------------
// El hub de conversaciones sobre el adaptador (paso 6)
// ---------------------------------------------------------------------------

const { ConversationHub } = await import('../src/conversation-hub.ts');

/**
 * Un registro de terminales de mentira: el hub le pide descriptores y escucha
 * los cambios de sesion, que aca no pasan nunca. Sin pty viva: una llamada a
 * herramienta abierta no bloquea nada (eso lo prueba check-codex-adapter).
 */
const fakeTerminals = (descriptors) => ({
  get: (terminalId) => descriptors.find((d) => d.terminalId === terminalId) ?? null,
  on: () => undefined,
  launchedAtOf: () => null,
});
const descriptorOf = (terminalId, { agent = 'claude-code', cwd, sessionId, kind = 'agent' }) => ({
  terminalId, kind, cwd, agent, sessionId, label: terminalId, resumed: false,
  createdAt: 0, alive: true, exitCode: null, sleeping: false,
});
/** Junta lo que emite el hub, por evento. */
const recordHub = (hub) => {
  const events = { append: [], mode: [], waiting: [], state: [], plans: [], reset: [] };
  for (const name of Object.keys(events)) hub.on(name, (...args) => events[name].push(args));
  return events;
};

{
  // Con claude-code de verdad: la configuracion antes de la primera lectura, el
  // modo de arranque desde la capacidad y un /model releido antes de emitir.
  const hubAdapter = createClaudeCodeAdapter();
  const hubAgents = new AgentRegistry([hubAdapter]);
  const projectCwd = path.join(root, 'proyecto-hub');
  const settingsFile = path.join(projectCwd, '.claude', 'settings.json');
  await mkdir(path.dirname(settingsFile), { recursive: true });
  await writeFile(settingsFile, JSON.stringify({ model: 'opus[1m]' }));
  const sessionId = '11111111-7777-4777-8777-777777777777';
  const file = sessionFilePath(projectCwd, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, userLine('u1', projectCwd, 'hola') + assistantLine('a1', 'claude-opus-5', 5000));

  const hub = new ConversationHub(fakeTerminals([
    descriptorOf('t-cc', { cwd: projectCwd, sessionId }),
    descriptorOf('t-consola', { cwd: projectCwd, sessionId: '', agent: null, kind: 'shell' }),
    descriptorOf('t-sin-adaptador', { cwd: projectCwd, sessionId, agent: 'cli-que-no-esta' }),
  ]), hubAgents);
  const seen = recordHub(hub);

  check('sin suscripcion, el hub no inventa un modo', hub.getPermissionMode('t-cc') === null);
  const snapshot = await hub.subscribe('t-cc');
  check('el hub sigue la sesion con el seguidor del adaptador',
    snapshot?.state === 'live' && snapshot.events.length === 2, JSON.stringify(snapshot?.state));
  check('el hub aplica la configuracion antes de la primera lectura: 1M',
    snapshot?.usage.contextWindow === 1000000, String(snapshot?.usage.contextWindow));
  check('el modo de arranque sale de la capacidad de la CLI',
    snapshot?.permissionMode === hubAdapter.capabilities.permissionCycle.launchMode &&
    hub.getPermissionMode('t-cc') === LAUNCH_PERMISSION_MODE, String(snapshot?.permissionMode));

  // Un /model: el append ya sale con la ventana nueva, no un turno despues.
  await writeFile(settingsFile, JSON.stringify({ model: 'opus' }));
  await appendFile(file,
    userLine('u2', projectCwd, '<command-name>/model</command-name><command-args>opus</command-args>') +
    assistantLine('a2', 'claude-opus-5', 6000));
  hub.onHistoryChanged('otra-cli', file);
  hub.onHistoryChanged('claude-code', file);
  check('un aviso del historial de su CLI dispara la lectura', await waitFor(() => seen.append.length >= 1));
  const [, , appendedUsage, appendedMode] = seen.append[0] ?? [];
  check('un /model se relee antes de emitir: el append ya dice 200k',
    appendedUsage?.contextWindow === 200000, String(appendedUsage?.contextWindow));
  check('el append lleva el modo de arranque', appendedMode === LAUNCH_PERMISSION_MODE, String(appendedMode));
  check('y se avisa el modo una vez', seen.mode.length === 1 && seen.mode[0][1] === LAUNCH_PERMISSION_MODE, JSON.stringify(seen.mode));

  // El estado que publica la CLI llega al hub por el adaptador.
  const stateFile = path.join(home, '.claude', 'sessions', '4343.json');
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ sessionId, status: 'waiting', waitingFor: 'permission prompt' }));
  check('la barra de espera sale del estado del adaptador',
    await waitFor(() => seen.waiting.some(([, waitingFor]) => waitingFor === 'permission prompt')), JSON.stringify(seen.waiting));
  await rm(stateFile);
  check('y se apaga cuando la CLI deja de esperar',
    await waitFor(() => seen.waiting.at(-1)?.[1] === null), JSON.stringify(seen.waiting));

  const console9 = await hub.subscribe('t-consola');
  check('una consola no tiene conversacion', console9?.state === 'unavailable' && console9.permissionMode === null);
  const orphan = await hub.subscribe('t-sin-adaptador');
  check('una CLI sin adaptador tampoco, y no lanza', orphan?.state === 'unavailable');

  hub.disposeAll();
  hubAgents.disposeAll();
}

{
  // Una CLI que no declara nada: sin ciclo, sin estado y sin planes.
  let pollCount = 0;
  let noticed = [];
  let followerState = 'waiting';
  const bareFollower = {
    label: 'bare.log',
    start: async () => undefined,
    poll: async () => {
      pollCount += 1;
      const added = pollCount === 1 ? [] : [{ id: `e${pollCount}`, role: 'assistant', parts: [] }];
      if (pollCount > 1) followerState = 'live';
      return { reset: false, added, turns: [], plans: pollCount > 1 ? ['plan.md'] : [], parts: [] };
    },
    getState: () => followerState,
    getUsage: () => ({ inputTokens: 0, outputTokens: 0, contextTokens: 0, contextWindow: null, model: null }),
    getPermissionMode: () => null,
    getTail: () => ({ events: [], hasMore: false }),
    getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => ['plan.md'],
    readImage: async () => null,
    noticeChange: (filePath) => { noticed.push(filePath); return filePath === 'bare.log'; },
  };
  const bareAdapter = {
    id: 'cli-pelada', label: 'Pelada', command: 'pelada', installUrl: 'https://example.com',
    capabilities: NO_CAPABILITIES,
    locate: async () => null, missingMessage: () => 'falta', launch: () => { throw new Error('no'); },
    environment: (base) => ({ env: { ...base }, notice: null }), onSpawned: () => null,
    history: {
      roots: () => [], list: async () => null, changedRefs: async () => null, item: async () => null,
      scan: async () => { throw new Error('no'); }, restored: () => undefined, exists: async () => false,
      follow: () => bareFollower, plans: null,
    },
    status: null, defaults: async () => null, protectedDirs: () => [], dispose: () => undefined,
  };
  const hub = new ConversationHub(
    fakeTerminals([descriptorOf('t-pelada', { agent: 'cli-pelada', cwd: '/p', sessionId: 's-pelada' })]),
    new AgentRegistry([bareAdapter]),
  );
  const seen = recordHub(hub);
  const snapshot = await hub.subscribe('t-pelada');
  check('sin ciclo, el snapshot no inventa un modo', snapshot?.permissionMode === null && hub.getPermissionMode('t-pelada') === null,
    String(snapshot?.permissionMode));
  check('sin planes declarados, la lista queda vacia', sameShape(snapshot?.plans, []));
  check('sin estado publicado, no hay barra de espera', snapshot?.waitingFor === null);

  hub.onHistoryChanged('claude-code', 'bare.log');
  check('un aviso del historial de otra CLI no le llega a su seguidor', noticed.length === 0, JSON.stringify(noticed));
  hub.onHistoryChanged('cli-pelada', 'otro.log');
  hub.onHistoryChanged('cli-pelada', 'bare.log');
  check('los de su CLI si, y decide el seguidor', sameShape(noticed, ['otro.log', 'bare.log']), JSON.stringify(noticed));
  check('lo que el seguidor acepta se lee', await waitFor(() => seen.state.length >= 1), `${pollCount} lecturas`);
  check('solo se leyo por el aviso aceptado', pollCount === 2, `${pollCount} lecturas`);
  check('el append sale con modo null', seen.append.length === 1 && seen.append[0][3] === null, JSON.stringify(seen.append));
  check('sin ciclo no se avisa ningun modo', seen.mode.length === 0, JSON.stringify(seen.mode));
  check('sin planes declarados no se avisan planes aunque el seguidor los nombre', seen.plans.length === 0);
  check('ni se lee un plan', (await hub.readPlan('t-pelada', 'plan.md')) === null);
  hub.disposeAll();
}

// ---------------------------------------------------------------------------
// 7. Proyectos: agrupar sesiones por cwd
// ---------------------------------------------------------------------------

const { buildProjects, migrateIndexCache, SessionIndex } = await import('../src/session-index.ts');

{
  const indexed = ({ id, group, cwd = null, at = 1, agent = 'claude-code' }) => ({
    agent,
    ref: `/historial/${group}/${id}.jsonl`,
    group,
    cwd,
    summary: {
      agent, sessionId: id, cwd: cwd ?? '', title: id, titleSource: 'first-message',
      updatedAt: at, sizeBytes: 1, archived: false,
    },
  });
  const ids = (project) => project.sessions.map((s) => s.sessionId).join(',');

  const same = buildProjects([
    indexed({ id: 'a', group: 'g1', cwd: 'D:\\Agent Explorer', at: 5 }),
    indexed({ id: 'c', group: 'g1', at: 7 }),
    indexed({ id: 'b', group: 'g2', cwd: 'd:\\agent explorer\\', at: 9 }),
  ], 'win32');
  check('win32: mismo cwd con otra mayuscula y barra final es un proyecto',
    same.length === 1 && same[0].key === 'd:\\agent explorer', JSON.stringify(same.map((p) => p.key)));
  check('el cwd que se muestra es el primero visto', same[0]?.cwd === 'D:\\Agent Explorer', same[0]?.cwd);
  check('una sesion sin cwd cae en el proyecto de su grupo', same[0]?.sessions.some((s) => s.sessionId === 'c'));
  check('sesiones de la mas reciente a la mas vieja, y la ultima actividad es la mayor',
    ids(same[0]) === 'b,c,a' && same[0].lastActivityAt === 9 && same[0].fallbackName === '', ids(same[0]));

  const late = buildProjects([
    indexed({ id: 'n', group: 'g' }),
    indexed({ id: 'm', group: 'g', cwd: '/p' }),
  ], 'linux');
  check('el cwd del grupo vale aunque aparezca despues de la sesion que no lo trae',
    late.length === 1 && late[0].key === '/p' && late[0].cwd === '/p', JSON.stringify(late));

  const unknown = buildProjects([indexed({ id: 'x', group: 'D--sin-cwd' })], 'win32');
  check('un grupo sin ningun cwd: key unknown y el grupo como nombre',
    unknown.length === 1 && unknown[0].key === 'unknown:claude-code:D--sin-cwd' &&
    unknown[0].fallbackName === 'D--sin-cwd' && unknown[0].cwd === '', JSON.stringify(unknown));

  const apart = buildProjects([indexed({ id: 'x', group: 'g1' }), indexed({ id: 'y', group: 'g2' })], 'win32');
  check('dos grupos sin cwd no se juntan', apart.length === 2);

  const slugTwins = buildProjects([
    indexed({ id: 'x', group: 'D--Mi-App', cwd: 'D:\\Mi App' }),
    indexed({ id: 'y', group: 'D--Mi-App', cwd: 'D:\\Mi-App' }),
  ], 'win32');
  check('"D:\\Mi App" y "D:\\Mi-App" en la misma carpeta son dos proyectos (cambio aceptado R3)',
    slugTwins.length === 2 && slugTwins.map((p) => p.cwd).join('|') === 'D:\\Mi App|D:\\Mi-App', JSON.stringify(slugTwins.map((p) => p.cwd)));

  const linuxCase = buildProjects([
    indexed({ id: 'x', group: 'g1', cwd: '/P' }),
    indexed({ id: 'y', group: 'g2', cwd: '/p' }),
  ], 'linux');
  check('linux: /P y /p son dos proyectos', linuxCase.length === 2);

  const perAgent = buildProjects([
    indexed({ id: 'x', group: 'g', cwd: '/p' }),
    indexed({ id: 'y', group: 'g', agent: 'fake-otra' }),
  ], 'linux');
  check('el respaldo del grupo es por CLI: otra CLI con el mismo nombre de grupo no lo hereda',
    perAgent.length === 2 && perAgent[1].key === 'unknown:fake-otra:g', JSON.stringify(perAgent.map((p) => p.key)));

  const order = buildProjects([
    indexed({ id: 'x', group: 'g1', cwd: '/b', at: 1 }),
    indexed({ id: 'y', group: 'g2', cwd: '/a', at: 50 }),
  ], 'linux');
  check('los proyectos salen en el orden en que aparecieron', order.map((p) => p.key).join(',') === '/b,/a');
}

// ---------------------------------------------------------------------------
// 8. La cache del indice: v3 -> v4
// ---------------------------------------------------------------------------

{
  const p1 = path.join(root, 'cache', '.claude', 'projects', 'D--p', 's1.jsonl');
  const p2 = path.join(root, 'cache', '.claude', 'projects', 'D--q', 's2.jsonl');
  const summary = (id, extra = {}) => ({ sessionId: id, title: `t-${id}`, titleSource: 'ai', updatedAt: 10, sizeBytes: 20, ...extra });
  const v3 = {
    version: 3,
    entries: {
      [p1]: { mtimeMs: 10, sizeBytes: 20, cwd: 'D:\\p', summary: summary('s1', { archived: true }), modelIds: ['claude-opus-5[1m]'] },
      [p2]: { mtimeMs: 11, sizeBytes: 21, cwd: '', summary: summary('s2', { archived: false }) },
      '/mal-formada.jsonl': { mtimeMs: 'x', sizeBytes: 1, cwd: '', summary: summary('s3') },
    },
  };
  const migrated = migrateIndexCache(v3);
  check('v3 se migra a v4', migrated?.version === 4);
  check('las claves pasan a claude-code:<ruta> y la mal formada se descarta',
    sameShape(Object.keys(migrated?.entries ?? {}).sort(), [`claude-code:${p1}`, `claude-code:${p2}`].sort()),
    JSON.stringify(Object.keys(migrated?.entries ?? {})));
  check('una entrada v3 conserva todo, con el grupo = su carpeta y los modelIds en extra',
    sameShape(migrated?.entries[`claude-code:${p1}`], {
      agent: 'claude-code', ref: p1, group: 'D--p', mtimeMs: 10, sizeBytes: 20, cwd: 'D:\\p',
      summary: summary('s1'), extra: { modelIds: ['claude-opus-5[1m]'] },
    }), JSON.stringify(migrated?.entries[`claude-code:${p1}`]));
  check('sin modelIds, extra trae una lista vacia',
    sameShape(migrated?.entries[`claude-code:${p2}`]?.extra, { modelIds: [] }));

  const roundTrip = migrateIndexCache(JSON.parse(JSON.stringify(migrated)));
  check('v4 se lee tal cual', sameShape(roundTrip, migrated), JSON.stringify(roundTrip));

  const tampered = JSON.parse(JSON.stringify(migrated));
  tampered.entries['nope:/x.jsonl'] = { ...tampered.entries[`claude-code:${p1}`], agent: 'nope', ref: '/x.jsonl' };
  tampered.entries['claude-code:/otra-ref.jsonl'] = tampered.entries[`claude-code:${p1}`];
  const filtered = migrateIndexCache(tampered);
  check('v4: una entrada de una CLI desconocida o con la clave cambiada se descarta',
    Object.keys(filtered?.entries ?? {}).length === 2, JSON.stringify(Object.keys(filtered?.entries ?? {})));

  check('v2 no se migra', migrateIndexCache({ version: 2, entries: {} }) === null);
  check('algo que no es una cache no se migra',
    migrateIndexCache(null) === null && migrateIndexCache({ version: 3 }) === null && migrateIndexCache('x') === null);
}

// ---------------------------------------------------------------------------
// El indice sobre un historial en disco (paso 5)
// ---------------------------------------------------------------------------

{
  const { sessionIndexCachePath } = await import('../src/paths.ts');
  const { readFile, unlink } = await import('node:fs/promises');

  /**
   * La ventana que dibuja el medidor para una sesion, pidiendosela al hub como
   * lo hace la app: con el mismo registro de CLIs que usa el indice.
   */
  const hubWindow = async (agents, cwd, sessionId) => {
    const hub = new ConversationHub(fakeTerminals([descriptorOf('t-medidor', { cwd, sessionId })]), agents);
    const snapshot = await hub.subscribe('t-medidor');
    hub.disposeAll();
    return snapshot?.usage.contextWindow;
  };

  // Un home propio: lo que escribieron las secciones de arriba no entra aca.
  const idxHome = path.join(root, 'idx-home');
  await mkdir(idxHome, { recursive: true });
  process.env['HOME'] = idxHome;
  process.env['USERPROFILE'] = idxHome;
  process.env['APPDATA'] = path.join(root, 'idx-appdata');
  process.env['XDG_CONFIG_HOME'] = path.join(root, 'idx-xdg');

  async function waitForAsync(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await condition())) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return true;
  }
  const readCache = async () => {
    try { return JSON.parse(await readFile(sessionIndexCachePath(), 'utf8')); } catch { return null; }
  };

  /** Un adaptador real con el escaneo contado, y un gancho que corre durante cada lectura. */
  const countingAdapter = () => {
    const real = createClaudeCodeAdapter();
    const counter = { scans: 0, probe: () => undefined };
    const wrapped = {
      ...real,
      history: {
        ...real.history,
        scan: async (item) => {
          counter.scans += 1;
          counter.probe();
          return real.history.scan(item);
        },
      },
    };
    return { real, wrapped, counter };
  };

  const projectA = path.join(root, 'idx', 'Proyecto A');
  const projectB = path.join(root, 'idx', 'Proyecto B');
  await mkdir(projectA, { recursive: true });
  // La misma carpeta escrita de otra forma: otra mayuscula (en Windows) y barra final.
  const otherFormA = process.platform === 'win32' ? `${projectA.toUpperCase()}\\` : `${projectA}/`;

  const ids = {
    a0: '0a0a0a0a-0000-4000-8000-000000000000',
    a1: 'a1a1a1a1-1111-4111-8111-111111111111',
    a2: 'a2a2a2a2-2222-4222-8222-222222222222',
    a4: 'a4a4a4a4-4444-4444-8444-444444444444',
    a5: 'a5a5a5a5-5555-4555-8555-555555555555',
    b1: 'b1b1b1b1-1111-4111-8111-111111111111',
    n1: 'c1c1c1c1-1111-4111-8111-111111111111',
  };
  const folderA = path.dirname(sessionFilePath(projectA, ids.a1));
  const folderB = path.dirname(sessionFilePath(projectB, ids.b1));
  const folderN = path.join(sessionsRoot(), 'carpeta-sin-cwd');
  const folderZ = path.join(sessionsRoot(), 'zz-otra-carpeta');
  const fileOf = (folder, id) => path.join(folder, `${id}.jsonl`);
  for (const folder of [folderA, folderB, folderN, folderZ]) await mkdir(folder, { recursive: true });

  // a0 no trae cwd y su nombre va primero en la carpeta (al menos en NTFS).
  await writeFile(fileOf(folderA, ids.a0), line({ type: 'ai-title', aiTitle: 'Sin cwd', sessionId: ids.a0 }));
  await writeFile(fileOf(folderA, ids.a1), userLine('u1', projectA, 'uno'));
  await writeFile(fileOf(folderA, ids.a2), userLine('u2', otherFormA, 'dos'));
  // b1 trae una respuesta sin cost-state: es la que se mide con el hub.
  await writeFile(fileOf(folderB, ids.b1), userLine('u3', projectB, 'tres') + assistantLine('a3', 'claude-opus-5', 5000));
  await writeFile(fileOf(folderN, ids.n1), line({ type: 'ai-title', aiTitle: 'Nadie sabe donde', sessionId: ids.n1 }));
  // Otra carpeta del historial con una sesion del mismo proyecto, y el unico cost-state.
  await writeFile(fileOf(folderZ, ids.a5),
    userLine('u5', projectA, 'cinco') + line({ type: 'cost-state', modelUsage: { 'claude-opus-5[1m]': {} } }));

  const keyA = normalizeCwdKey(projectA, process.platform);
  const keyB = normalizeCwdKey(projectB, process.platform);
  const keyN = 'unknown:claude-code:carpeta-sin-cwd';
  const keyTransient = `unknown:claude-code:${path.basename(folderA)}`;
  const byKey = (projects, key) => projects.find((p) => p.key === key);

  const first = countingAdapter();
  const firstAgents = new AgentRegistry([first.wrapped]);
  const index = new SessionIndex(firstAgents, { has: (id) => id === ids.a2 });
  const partials = [];
  const replaces = [];
  index.on('projects', (projects, replace) => (replace ? replaces : partials).push(projects));
  const duringScan = [];
  first.counter.probe = () => duringScan.push(index.getProjects());

  await index.scan();
  const projects = index.getProjects();
  const status = index.getStatus();
  check('el escaneo termina con todos los archivos contados',
    status.state === 'ready' && status.scannedFiles === 6 && status.totalFiles === 6, JSON.stringify(status));
  check('tres proyectos: A, B y el de la carpeta sin cwd',
    sameShape(projects.map((p) => p.key).sort(), [keyA, keyB, keyN].sort()), JSON.stringify(projects.map((p) => p.key)));

  const a = byKey(projects, keyA);
  check('A junta las dos formas del cwd, la sesion sin cwd y la de otra carpeta',
    a !== undefined && sameShape(a.sessions.map((s) => s.sessionId).sort(), [ids.a0, ids.a1, ids.a2, ids.a5].sort()),
    JSON.stringify(a?.sessions.map((s) => s.sessionId)));
  check('A existe en disco y muestra una forma de su propio cwd',
    a?.cwdExists === true && normalizeCwdKey(a.cwd, process.platform) === keyA && a.fallbackName === '', JSON.stringify(a?.cwd));
  const sessionOf = (id) => a?.sessions.find((s) => s.sessionId === id);
  check('cada sesion lleva su CLI y el cwd de su propio archivo',
    a?.sessions.every((s) => s.agent === 'claude-code') &&
    sessionOf(ids.a1)?.cwd === projectA && sessionOf(ids.a2)?.cwd === otherFormA && sessionOf(ids.a0)?.cwd === '',
    JSON.stringify(a?.sessions.map((s) => [s.sessionId.slice(0, 2), s.cwd])));
  check('las archivadas salen marcadas', sessionOf(ids.a2)?.archived === true && sessionOf(ids.a1)?.archived === false);
  check('B no existe en disco: se marca', byKey(projects, keyB)?.cwdExists === false);
  const n = byKey(projects, keyN);
  check('la carpeta sin cwd se lista con su nombre', n?.fallbackName === 'carpeta-sin-cwd' && n.cwd === '' && n.cwdExists === false);

  const partialA = partials.flat().filter((p) => p.key === keyA);
  check('se emitio por grupo antes del reemplazo final', partials.length >= 3 && replaces.length === 1, `${partials.length} parciales`);
  check('el ultimo parcial de A ya viene fusionado con las otras carpetas',
    partialA.length >= 1 && partialA[partialA.length - 1].sessions.length === 4, JSON.stringify(partialA.map((p) => p.sessions.length)));
  const snapshots = [...partials, ...duringScan];
  check('A nunca se ve tachada mientras se escanea (cwdExists antes que la sesion)',
    snapshots.flat().filter((p) => p.key === keyA).every((p) => p.cwdExists === true) && duringScan.length === 6,
    `${duringScan.length} lecturas`);
  check('ni aparece un proyecto sin cwd que un instante despues ya no existe',
    snapshots.every((batch) => batch.every((p) => p.key !== keyTransient)));

  check('agentOf de una sesion indexada', index.agentOf(ids.a1) === 'claude-code');
  check('agentOf de una que no conoce es null', index.agentOf('no-existe') === null);

  // A6: el escaneo alimenta el registro de variantes del adaptador, el mismo
  // que usan los seguidores que arma el hub. b1 no tiene cost-state propio ni
  // configuracion: lo unico que puede decir 1M es lo que aprendio el indice.
  const unlearned = createClaudeCodeAdapter();
  const unlearnedWindow = await hubWindow(new AgentRegistry([unlearned]), projectB, ids.b1);
  unlearned.dispose();
  check('sin escanear, el hub no sabe la variante: 200k', unlearnedWindow === 200000, String(unlearnedWindow));
  const learnedWindow = await hubWindow(firstAgents, projectB, ids.b1);
  check('el hub ve la variante que aprendio el indice: 1M', learnedWindow === 1000000, String(learnedWindow));
  const cacheAfterScan = await readCache();
  check('la cache se escribe en v4 con claves por CLI',
    cacheAfterScan?.version === 4 && Object.keys(cacheAfterScan.entries).length === 6 &&
    Object.keys(cacheAfterScan.entries).every((key) => key.startsWith('claude-code:')),
    JSON.stringify(Object.keys(cacheAfterScan?.entries ?? {})));
  check('y guarda lo que la CLI aprende en extra',
    sameShape(cacheAfterScan?.entries[`claude-code:${fileOf(folderZ, ids.a5)}`]?.extra, { modelIds: ['claude-opus-5[1m]'] }));

  // refreshPath: solo lo que cambio.
  first.counter.probe = () => undefined;
  first.counter.scans = 0;
  await writeFile(fileOf(folderA, ids.a4), userLine('u4', projectA, 'cuatro'));
  await index.refreshPath('claude-code', fileOf(folderA, ids.a4));
  check('refreshPath de una sesion nueva la agrega leyendo solo ese archivo',
    byKey(replaces[replaces.length - 1], keyA)?.sessions.length === 5 && first.counter.scans === 1,
    `${first.counter.scans} lecturas`);

  const emitted = replaces.length;
  await index.refreshPath('claude-code', path.join(folderA, 'notas.txt'));
  check('refreshPath de algo que no es una sesion no emite nada', replaces.length === emitted);

  await unlink(fileOf(folderA, ids.a1));
  await index.refreshPath('claude-code', fileOf(folderA, ids.a1));
  check('refreshPath de una sesion borrada la saca',
    byKey(index.getProjects(), keyA)?.sessions.length === 4 && index.agentOf(ids.a1) === null);

  await mkdir(projectB, { recursive: true });
  await index.refreshPath('claude-code', fileOf(folderB, ids.b1));
  check('refreshPath vuelve a mirar si la carpeta existe', byKey(index.getProjects(), keyB)?.cwdExists === true);
  const cacheAfterRefresh = await readCache();
  check('la cache sigue a los cambios',
    cacheAfterRefresh !== null && !(`claude-code:${fileOf(folderA, ids.a1)}` in cacheAfterRefresh.entries) &&
    `claude-code:${fileOf(folderA, ids.a4)}` in cacheAfterRefresh.entries);

  // Arranque en caliente: todo sale de la cache y el adaptador aprende igual.
  const warm = countingAdapter();
  const warmAgents = new AgentRegistry([warm.wrapped]);
  const warmIndex = new SessionIndex(warmAgents);
  await warmIndex.start();
  check('en caliente el escaneo termina', await waitFor(() => warmIndex.getStatus().state === 'ready'));
  check('en caliente no se relee ningun archivo', warm.counter.scans === 0, `${warm.counter.scans} lecturas`);
  check('en caliente tambien se mira si cada carpeta existe',
    byKey(warmIndex.getProjects(), keyA)?.cwdExists === true && byKey(warmIndex.getProjects(), keyB)?.cwdExists === true);
  const warmWindow = await hubWindow(warmAgents, projectB, ids.b1);
  check('en caliente la cache le ensena la variante al hub: 1M', warmWindow === 1000000, String(warmWindow));

  // Una cache v3 de una build anterior: se migra sin reindexar y se reescribe en v4.
  const v3Entries = {};
  for (const entry of Object.values(cacheAfterRefresh.entries)) {
    v3Entries[entry.ref] = {
      mtimeMs: entry.mtimeMs, sizeBytes: entry.sizeBytes, cwd: entry.cwd,
      summary: { ...entry.summary, title: `v3 ${entry.summary.title}`, archived: false },
      modelIds: entry.extra.modelIds ?? [],
    };
  }
  await writeFile(sessionIndexCachePath(), JSON.stringify({ version: 3, entries: v3Entries }));
  const old = countingAdapter();
  const oldAgents = new AgentRegistry([old.wrapped]);
  const oldIndex = new SessionIndex(oldAgents);
  await oldIndex.start();
  check('con cache v3 el escaneo termina', await waitFor(() => oldIndex.getStatus().state === 'ready'));
  check('con cache v3 no se relee ningun archivo, y los titulos salen de ella',
    old.counter.scans === 0 && oldIndex.getProjects().every((p) => p.sessions.every((s) => s.title.startsWith('v3 '))),
    `${old.counter.scans} lecturas`);
  const oldWindow = await hubWindow(oldAgents, projectB, ids.b1);
  check('con cache v3 la variante tambien llega al hub: 1M', oldWindow === 1000000, String(oldWindow));
  check('la cache v3 se reescribe en v4', await waitForAsync(async () => (await readCache())?.version === 4));

  for (const created of [first, warm, old]) created.real.dispose();
}

adapter.dispose();
await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
