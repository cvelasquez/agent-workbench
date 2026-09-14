/**
 * Chequeo del adaptador de Antigravity CLI (hito 27).
 *
 *   npx tsx scripts/check-antigravity-events.mjs
 *
 * Por ahora cubre (los numeros son los de la especificacion, §14.1):
 *
 *  - 15: los parsers de `shared` que agrega el hito: la status line de una CLI,
 *    el ciclo con `approvesPendingOnCycle`, la fuente de ventana `status-line`,
 *    el estado `no-transcript` y los mensajes `agents` / `agents.refresh`. Y que
 *    el registro de hoy anuncia `statusLine: null` para todas.
 *  - 14: `modelOptionFor` y `modelFamilyOf` con la lista de otra CLI, sin
 *    cambiar nada con la de Claude Code. Y `cycleDistance` con otro ciclo.
 *  - 1: el mensaje del usuario, la etiqueta del modelo y su aviso de cambio.
 *  - 2: el transcript convertido en eventos, con el emparejamiento de
 *    resultados por el ultimo paso de planificacion.
 *  - 6: las URI de carpeta de un proyecto.
 *  - 3: el seguidor sobre disco: incremental, cortado a mitad de un caracter,
 *    el archivo que encoge, la reescritura del mismo tamano (huella, A6) y que
 *    sin la opcion `JsonlFollower` sigue igual que antes.
 *  - 4: los estados del seguidor (`waiting`, `live`, `no-transcript`), el
 *    `sessionId` vacio que no toca el disco (M4), el transcript compacto y lo
 *    que toma de la status line.
 *  - 5: catalogo e historial sobre un home falso con una base SQLite creada
 *    aca: que se lista y que no, grupos (A2), cwd y titulo de cada fuente,
 *    `changedRefs` (B4), `exists` (M3), la base leida por copia sin tocar la
 *    original, cerrada y con un escritor abierto (M9), el filtro de recorrido
 *    de `brain/` con chokidar de verdad (M2) y el sondeo del catalogo.
 *  - Datos de la CLI: rutas, nombres de modo y la lista de modelos.
 *  - 10: `settings.json` (solo `model` y `statusLine`) y el fragmento por
 *    plataforma (P0-1).
 *  - 11: el script de la status line de verdad, con node: lista blanca, ids
 *    que no son uuid, y en Windows el comando del fragmento por `cmd /c` desde
 *    una carpeta con espacios.
 *  - 12: el almacen de registros y la fuente de estado (unknown, idle, busy,
 *    waiting, solo de la pty viva, `waitUntilReady`, limpieza).
 *  - 13: el medidor (P0-3) y el modo (P0-2) desde la status line.
 *  - 7: el descubrimiento por el log propio y el respaldo por pid.
 *  - 8, 9, A1, D10: el adaptador registrado: lanzamiento, gancho, capacidades,
 *    `prepareAll` solo con la CLI encontrada y el aviso de cambios.
 *  - Paso 7: `buildModeKeys` con el ciclo de la CLI, `planModeChange` (D16: un
 *    cambio de modo con una confirmacion abierta se rechaza solo si la tecla la
 *    aprueba; Claude Code igual que antes), `getWaitingFor` del hub y la linea
 *    de la status line en el arranque.
 *  - Paso 8: lo que la web deriva (B6 y el medidor con status line, Configurar,
 *    el punto `unknown`, el combo de modo, el dialogo, `no-transcript`, el
 *    aviso de `/model` y el mensaje `agents` con capacidades nuevas).
 *
 * Todo con fixtures inventados, escritos aca: ninguna ruta, prompt ni titulo
 * sale de una instalacion real. Trabaja con `HOME`, `USERPROFILE`, `APPDATA`,
 * `XDG_*`, `CODEX_HOME`, `TEMP` y `TMP` apuntando a una carpeta temporal
 * propia, fijadas **antes** de importar nada: nunca lee el `~/.gemini` de
 * verdad. No importa nada que cargue `node-pty`.
 */

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-agy-'));
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
process.env['TEMP'] = path.join(root, 'tmp');
process.env['TMP'] = path.join(root, 'tmp');
delete process.env['OPENCODE_DB'];
delete process.env['OPENCODE_MODELS_PATH'];
delete process.env['OPENCODE_MODELS_URL'];

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const show = (value) => JSON.stringify(value);

/** Igualdad estructural, con el orden de las claves normalizado. */
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

const shared = await import('@agent-workbench/shared');

// ---------------------------------------------------------------------------
// 15. Parsers de shared
// ---------------------------------------------------------------------------

{
  const {
    CONTEXT_WINDOW_SOURCES,
    CONVERSATION_STATES,
    STATUS_LINE_STATES,
    encodeServerMessage,
    parseAgentCapabilities,
    parseAgentInfo,
    parseClientMessage,
    parsePermissionCycle,
    parseServerMessage,
    parseStatusLineSetupInfo,
  } = shared;

  const statusLine = {
    state: 'missing',
    settingsPath: 'C:\\Users\\u\\.gemini\\antigravity-cli\\settings.json',
    scriptPath: 'C:\\Users\\u\\AppData\\Roaming\\agent-workbench\\integrations\\antigravity-statusline.mjs',
    fragment: '{\n  "statusLine": {}\n}',
  };
  check('15 status line valida se lee tal cual', same(parseStatusLineSetupInfo(statusLine), statusLine));
  check('15 fragment null es valido (carpeta sin fragmento posible)',
    same(parseStatusLineSetupInfo({ ...statusLine, fragment: null }), { ...statusLine, fragment: null }));
  check('15 los cinco estados, en orden',
    same(STATUS_LINE_STATES, ['active', 'missing', 'other-command', 'disabled', 'unreadable']));
  for (const state of STATUS_LINE_STATES) {
    check(`15 estado ${state} pasa`, parseStatusLineSetupInfo({ ...statusLine, state })?.state === state);
  }
  check('15 estado desconocido -> null', parseStatusLineSetupInfo({ ...statusLine, state: 'on' }) === null);
  check('15 sin scriptPath -> null', parseStatusLineSetupInfo({ ...statusLine, scriptPath: undefined }) === null);
  check('15 settingsPath vacio -> null', parseStatusLineSetupInfo({ ...statusLine, settingsPath: '' }) === null);
  check('15 fragment que no es texto -> null', parseStatusLineSetupInfo({ ...statusLine, fragment: 3 }) === null);
  check('15 fragment ausente -> null', parseStatusLineSetupInfo({ ...statusLine, fragment: undefined }) === null);
  check('15 algo que no es objeto -> null', parseStatusLineSetupInfo('active') === null);

  const info = {
    id: 'claude-code', label: 'X', command: 'x', available: true, version: '1', installUrl: 'u',
    missingMessage: null, capabilities: {}, environmentNotice: null,
  };
  check('15 AgentInfo con statusLine valida la conserva', same(parseAgentInfo({ ...info, statusLine })?.statusLine, statusLine));
  check('15 AgentInfo con statusLine invalida -> statusLine null, la CLI queda',
    (() => { const parsed = parseAgentInfo({ ...info, statusLine: { state: 'raro' } }); return parsed !== null && parsed.statusLine === null; })());
  check('15 AgentInfo sin statusLine (servidor anterior) -> null', parseAgentInfo(info)?.statusLine === null);

  const cycle = { modes: ['default', 'acceptEdits', 'plan'], launchMode: 'acceptEdits', keyLabel: 'shift+tab' };
  check('15 ciclo sin approvesPendingOnCycle -> false, y el ciclo vale', parsePermissionCycle(cycle)?.approvesPendingOnCycle === false);
  check('15 ciclo con approvesPendingOnCycle true -> true', parsePermissionCycle({ ...cycle, approvesPendingOnCycle: true })?.approvesPendingOnCycle === true);
  check('15 approvesPendingOnCycle que no es true -> false', parsePermissionCycle({ ...cycle, approvesPendingOnCycle: 'true' })?.approvesPendingOnCycle === false);
  check('15 el ciclo de tres de otra CLI se lee entero', same(parsePermissionCycle(cycle)?.modes, cycle.modes));

  check('15 status-line es una fuente de ventana, al final', CONTEXT_WINDOW_SOURCES.at(-1) === 'status-line', show(CONTEXT_WINDOW_SOURCES));
  check('15 status-line sobrevive al viaje por la red',
    parseAgentCapabilities({ contextWindowSource: 'status-line' }).contextWindowSource === 'status-line');

  check('15 no-transcript es un estado de conversacion', CONVERSATION_STATES.includes('no-transcript'));
  const state = parseServerMessage(JSON.stringify({ type: 'conversation.state', terminalId: 't1', state: 'no-transcript' }));
  check('15 conversation.state no-transcript se lee', state?.type === 'conversation.state' && state.state === 'no-transcript', show(state));

  const agentsRaw = {
    type: 'agents',
    agents: [{ ...info, statusLine }, { ...info, id: 'nope' }, { ...info, id: 'codex', label: 'Codex' }],
    defaultAgent: 'codex',
  };
  const agents = parseServerMessage(JSON.stringify(agentsRaw));
  check('15 agents: una CLI desconocida se descarta y queda el resto',
    agents?.type === 'agents' && agents.agents.map((a) => a.id).join(',') === 'claude-code,codex' && agents.defaultAgent === 'codex', show(agents));
  check('15 agents: la status line viaja', same(agents?.agents[0]?.statusLine, statusLine));
  check('15 agents con defaultAgent desconocido -> null',
    parseServerMessage(JSON.stringify({ ...agentsRaw, defaultAgent: 'nope' }))?.defaultAgent === null);
  check('15 agents sin lista -> mensaje invalido', parseServerMessage(JSON.stringify({ type: 'agents', defaultAgent: null })) === null);
  check('15 agents sale por encodeServerMessage y vuelve igual',
    same(parseServerMessage(encodeServerMessage({ type: 'agents', agents: agents.agents, defaultAgent: null })),
      { type: 'agents', agents: agents.agents, defaultAgent: null }));
  check('15 agents.refresh del cliente se lee', same(parseClientMessage(JSON.stringify({ type: 'agents.refresh' })), { type: 'agents.refresh' }));
  check('15 agents.refresh ignora campos de mas', same(parseClientMessage(JSON.stringify({ type: 'agents.refresh', x: 1 })), { type: 'agents.refresh' }));
}

// A5: con las CLIs de hoy, el registro anuncia la status line vacia, y solo la de la CLI encontrada.
{
  const { createAgentRegistry } = await import('../src/agents/registry.ts');
  const registry = createAgentRegistry();
  check('15 registry.list() sin localizar: statusLine null en todas, tambien antigravity',
    registry.list().every((a) => a.statusLine === null), show(registry.list().map((a) => a.statusLine)));
  for (const entry of registry.all()) entry.location = { resolvedPath: 'C:\\bin\\x.exe', file: 'C:\\bin\\x.exe', prefixArgs: [], version: '1' };
  const listed = registry.list();
  check('15 registry.list(): statusLine null en cada CLI salvo antigravity',
    listed.length === 4 && listed.filter((a) => a.id !== 'antigravity').every((a) => a.statusLine === null) &&
    listed.find((a) => a.id === 'antigravity')?.statusLine !== null, show(listed.map((a) => a.statusLine)));
  check('15 las capacidades de claude-code declaran approvesPendingOnCycle false',
    listed.find((a) => a.id === 'claude-code')?.capabilities.permissionCycle?.approvesPendingOnCycle === false);
  registry.disposeAll();
}

// ---------------------------------------------------------------------------
// 14. modelOptionFor con la lista de otra CLI, y cycleDistance con otro ciclo
// ---------------------------------------------------------------------------

const constants = await import('../src/agents/antigravity/constants.ts');
const {
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_LAUNCH_MODE,
  ANTIGRAVITY_MODE_CYCLE,
  ANTIGRAVITY_MODEL_OPTIONS,
  CONVERSATION_ID_PATTERN,
} = constants;

{
  const { MODEL_OPTIONS, modelFamilyOf, modelOptionFor, cycleDistance } = shared;
  const options = ANTIGRAVITY_MODEL_OPTIONS;

  check('14 Gemini 3.8 Flash (High) -> gemini-3.8-flash-high',
    modelOptionFor('Gemini 3.8 Flash (High)', options)?.value === 'gemini-3.8-flash-high');
  check('14 Gemini 3.7 Flash (Medium) -> gemini-3.7-flash-medium',
    modelOptionFor('Gemini 3.7 Flash (Medium)', options)?.value === 'gemini-3.7-flash-medium');
  check('14 cada etiqueta de la lista casa con su propia opcion',
    options.every((option) => modelOptionFor(option.label, options) === option),
    show(options.map((o) => [o.label, modelOptionFor(o.label, options)?.value])));
  check('14 con la lista de claude-code, una etiqueta de Gemini no casa', modelOptionFor('Gemini 3.8 Flash (High)') === null);
  check('14 una etiqueta que no esta en la lista -> null', modelOptionFor('Gemini 3.5 Flash (Medium)', options) === null);

  const lite = [
    { value: 'flash', label: 'Gemini 3.1 Flash', family: 'Gemini 3.1 Flash', long: false, window: null },
    { value: 'flash-lite', label: 'Gemini 3.1 Flash Lite', family: 'Gemini 3.1 Flash Lite', long: false, window: null },
  ];
  check('14 gana la familia mas larga: Flash Lite (Low) -> la Lite',
    modelOptionFor('Gemini 3.1 Flash Lite (Low)', lite)?.value === 'flash-lite', show(modelOptionFor('Gemini 3.1 Flash Lite (Low)', lite)));
  check('14 y la corta sigue casando con lo suyo', modelOptionFor('Gemini 3.1 Flash (Low)', lite)?.value === 'flash');
  check('14 aunque la larga vaya primero en la lista',
    modelOptionFor('Gemini 3.1 Flash (Low)', [...lite].reverse())?.value === 'flash' &&
    modelFamilyOf('Gemini 3.1 Flash Lite', [...lite].reverse()) === 'Gemini 3.1 Flash Lite');

  // Claude Code: los mismos resultados que el chequeo de siempre.
  const claude = [
    ['claude-opus-5', 'opus'],
    ['claude-opus-5[1m]', 'opus[1m]'],
    ['claude-haiku-4-5', 'haiku'],
    ['claude-haiku-4-5-20251001', 'haiku'],
    ['claude-sonnet-5', 'sonnet'],
    ['claude-fable-5-1[1m]', 'fable[1m]'],
  ];
  for (const [observed, value] of claude) {
    check(`14 sin opciones, ${observed} -> ${value}`, modelOptionFor(observed)?.value === value, String(modelOptionFor(observed)?.value));
    check(`14 con MODEL_OPTIONS explicito, ${observed} -> ${value}`, modelOptionFor(observed, MODEL_OPTIONS)?.value === value);
  }
  check('14 sin opciones, gpt-5.6-terra sigue en null', modelOptionFor('gpt-5.6-terra') === null);
  check('14 modelFamilyOf de un alias de configuracion, igual que antes',
    modelFamilyOf('opus[1m]') === 'opus' && modelFamilyOf('sonnet') === 'sonnet' && modelFamilyOf('') === null && modelFamilyOf(null) === null);

  // El ciclo de la otra CLI; el de Claude Code sin tocar.
  const agyCycle = ANTIGRAVITY_MODE_CYCLE;
  check('9 cycleDistance acceptEdits -> plan en el ciclo de tres = 1', cycleDistance('acceptEdits', 'plan', agyCycle) === 1);
  check('9 cycleDistance plan -> default = 1', cycleDistance('plan', 'default', agyCycle) === 1);
  check('9 cycleDistance default -> acceptEdits = 1', cycleDistance('default', 'acceptEdits', agyCycle) === 1);
  check('9 cycleDistance acceptEdits -> default = 2', cycleDistance('acceptEdits', 'default', agyCycle) === 2);
  check('9 cycleDistance auto -> plan en el ciclo de tres = null', cycleDistance('auto', 'plan', agyCycle) === null);
  check('9 cycleDistance mismo modo = 0', cycleDistance('plan', 'plan', agyCycle) === 0);
  check('9 sin ciclo, el de claude-code: auto -> plan = 3, default -> auto = 3',
    cycleDistance('auto', 'plan') === 3 && cycleDistance('default', 'auto') === 3);
  check('9 un ciclo vacio no lleva a ningun lado', cycleDistance('plan', 'plan', []) === null);
}

// ---------------------------------------------------------------------------
// Datos de la CLI: constantes, rutas y nombres de modo
// ---------------------------------------------------------------------------

{
  check('datos: 14 modelos de `agy models`', ANTIGRAVITY_MODEL_OPTIONS.length === 14, String(ANTIGRAVITY_MODEL_OPTIONS.length));
  check('datos: cada value es un slug sin espacios',
    ANTIGRAVITY_MODEL_OPTIONS.every((o) => /^[a-z0-9.-]+$/.test(o.value)), show(ANTIGRAVITY_MODEL_OPTIONS.map((o) => o.value)));
  check('datos: familia = etiqueta, sin ventana ni variante larga',
    ANTIGRAVITY_MODEL_OPTIONS.every((o) => o.family === o.label && o.long === false && o.window === null));
  check('datos: values y etiquetas sin repetir',
    new Set(ANTIGRAVITY_MODEL_OPTIONS.map((o) => o.value)).size === 14 && new Set(ANTIGRAVITY_MODEL_OPTIONS.map((o) => o.label)).size === 14);
  check('datos: las opciones sobreviven al parser de capacidades',
    same(shared.parseAgentCapabilities({ models: ANTIGRAVITY_MODEL_OPTIONS, efforts: ANTIGRAVITY_EFFORT_OPTIONS }).models, ANTIGRAVITY_MODEL_OPTIONS));
  check('datos: esfuerzos low, medium, high', ANTIGRAVITY_EFFORT_OPTIONS.map((e) => e.value).join(',') === 'low,medium,high');
  check('datos: el modo de arranque esta en el ciclo',
    ANTIGRAVITY_LAUNCH_MODE === 'acceptEdits' && ANTIGRAVITY_MODE_CYCLE.includes(ANTIGRAVITY_LAUNCH_MODE) &&
    shared.parsePermissionCycle({ modes: ANTIGRAVITY_MODE_CYCLE, launchMode: ANTIGRAVITY_LAUNCH_MODE, keyLabel: 'shift+tab' }) !== null);
  check('datos: el patron de id acepta un uuid y rechaza un camino',
    CONVERSATION_ID_PATTERN.test('00000000-0000-4000-8000-000000000004') && !CONVERSATION_ID_PATTERN.test('../00000000-0000-4000-8000-000000000004'));

  const paths = await import('../src/agents/antigravity/paths.ts');
  const ID = '00000000-0000-4000-8000-000000000004';
  const cli = path.join(home, '.gemini', 'antigravity-cli');
  const transcripts = paths.transcriptPaths(ID);
  check('datos: transcript completo y compacto dentro de brain/<id>/.system_generated/logs',
    transcripts?.full === path.join(cli, 'brain', ID, '.system_generated', 'logs', 'transcript_full.jsonl') &&
    transcripts?.compact === path.join(cli, 'brain', ID, '.system_generated', 'logs', 'transcript.jsonl'), show(transcripts));
  check('datos: un id que no es uuid no arma ruta',
    paths.transcriptPaths('..\\..\\x') === null && paths.conversationFiles('../x') === null && paths.transcriptPaths('') === null);
  check('datos: .pb y .db en conversations/',
    same(paths.conversationFiles(ID), { pb: path.join(cli, 'conversations', `${ID}.pb`), db: path.join(cli, 'conversations', `${ID}.db`) }));
  check('datos: rutas fijas de la CLI',
    paths.geminiHome() === path.join(home, '.gemini') &&
    paths.brainRoot() === path.join(cli, 'brain') &&
    paths.historyPath() === path.join(cli, 'history.jsonl') &&
    paths.lastConversationsPath() === path.join(cli, 'cache', 'last_conversations.json') &&
    paths.summariesDbPath() === path.join(cli, 'conversation_summaries.db') &&
    paths.settingsPath() === path.join(cli, 'settings.json') &&
    paths.cliLogRoot() === path.join(cli, 'log') &&
    paths.projectsRoot() === path.join(home, '.gemini', 'config', 'projects'));
  check('datos: proyecto con id valido',
    paths.projectFilePath('default-cli-project') === path.join(home, '.gemini', 'config', 'projects', 'default-cli-project.json'));
  check('datos: proyecto con id que es un camino -> null',
    paths.projectFilePath('../x') === null && paths.projectFilePath('..') === null && paths.projectFilePath('a/b') === null &&
    paths.projectFilePath('') === null && paths.projectFilePath('x'.repeat(101)) === null);

  const { toCliMode, fromCycleMode } = await import('../src/agents/antigravity/mode-names.ts');
  check('modos: toCliMode', toCliMode('acceptEdits') === 'accept-edits' && toCliMode('plan') === 'plan' &&
    toCliMode('default') === null && toCliMode('auto') === null);
  const observed = [
    ['accept-edits', 'idle', 'acceptEdits'],
    ['accept-edits', null, 'acceptEdits'],
    ['plan', 'working', 'plan'],
    [null, 'idle', 'default'],
    [null, 'tool_use', 'default'],
    ['', 'working', 'default'],
    [null, 'authenticating', null],
    [null, null, null],
    ['planning', 'idle', null],
    ['fast', 'idle', null],
  ];
  for (const [cycleMode, agentState, expected] of observed) {
    check(`modos: cycle_mode ${show(cycleMode)} con ${show(agentState)} -> ${show(expected)}`,
      fromCycleMode(cycleMode, agentState) === expected, show(fromCycleMode(cycleMode, agentState)));
  }
}

// ---------------------------------------------------------------------------
// 1. Mensaje del usuario y etiqueta del modelo
// ---------------------------------------------------------------------------

const mapperModule = await import('../src/agents/antigravity/transcript-mapper.ts');
const { TranscriptMapper, unwrapUserInput, stripStepHeader, isFailedResult, decodeCompactStep } = mapperModule;
const { splitModelLabel, parseSettingsChange } = await import('../src/agents/antigravity/model-label.ts');

const settingsBlock = (from, to) =>
  `The user changed setting \`Model Selection\` from ${from} to ${to}. No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.`;
const userContent = (text, change = null) =>
  `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: 2026-09-12T21:15:35-05:00.\n</ADDITIONAL_METADATA>` +
  (change === null ? '' : `\n<USER_SETTINGS_CHANGE>\n${change}\n</USER_SETTINGS_CHANGE>`);

{
  const first = unwrapUserInput(userContent('Contame qué dice la nota de bienvenida.', settingsBlock('None', 'Gemini 3.8 Flash (High)')));
  check('1 USER_INPUT -> el texto del pedido', first.text === 'Contame qué dice la nota de bienvenida.', show(first.text));
  check('1 USER_INPUT -> un aviso de cambio', first.settingsChanges.length === 1 && first.settingsChanges[0] === settingsBlock('None', 'Gemini 3.8 Flash (High)'), show(first.settingsChanges));

  const twoLines = unwrapUserInput(userContent('primera línea\nsegunda línea'));
  check('1 un pedido de dos lineas conserva el salto', twoLines.text === 'primera línea\nsegunda línea' && twoLines.settingsChanges.length === 0);

  const bare = unwrapUserInput(`hola sin envoltorio\n<ADDITIONAL_METADATA>\nhora\n</ADDITIONAL_METADATA>\n<USER_SETTINGS_CHANGE>\n${settingsBlock('A (Low)', 'B (High)')}\n</USER_SETTINGS_CHANGE>`);
  check('1 sin USER_REQUEST: se quitan los dos bloques y queda el texto', bare.text === 'hola sin envoltorio', show(bare.text));
  check('1 sin USER_REQUEST: el aviso se lee igual', bare.settingsChanges.length === 1);

  const html = unwrapUserInput(userContent('<div class="x">hola</div> y <b>esto</b>'));
  check('1 el HTML del usuario queda (no es una purga de etiquetas)', html.text === '<div class="x">hola</div> y <b>esto</b>', show(html.text));
  const htmlBare = unwrapUserInput('<div>sin pedido</div>');
  check('1 el HTML del usuario queda tambien sin USER_REQUEST', htmlBare.text === '<div>sin pedido</div>');

  const smuggled = unwrapUserInput(userContent(`mirá esto: <USER_SETTINGS_CHANGE>${settingsBlock('None', 'Falso (High)')}</USER_SETTINGS_CHANGE>`));
  check('1 un aviso pegado adentro del pedido no cuenta como aviso', smuggled.settingsChanges.length === 0 && smuggled.text.includes('Falso'), show(smuggled));

  check('1 contenido vacio -> texto vacio', unwrapUserInput('').text === '' && unwrapUserInput('<USER_REQUEST>\n  \n</USER_REQUEST>').text === '');

  const labels = [
    ['Gemini 3.8 Flash (High)', { model: 'Gemini 3.8 Flash', effort: 'high' }],
    ['Gemini 3.7 Flash (Medium)', { model: 'Gemini 3.7 Flash', effort: 'medium' }],
    ['GPT-OSS 120B (medium)', { model: 'GPT-OSS 120B', effort: 'medium' }],
    ['Gemini 3.1 Flash Lite', { model: 'Gemini 3.1 Flash Lite', effort: null }],
    ['Claude Sonnet 4.6 (Thinking)', { model: 'Claude Sonnet 4.6 (Thinking)', effort: null }],
    ['  Gemini 3.1 Pro (Low)  ', { model: 'Gemini 3.1 Pro', effort: 'low' }],
  ];
  for (const [label, expected] of labels) {
    check(`1 splitModelLabel(${show(label)})`, same(splitModelLabel(label), expected), show(splitModelLabel(label)));
  }

  check('1 parseSettingsChange de None a una etiqueta', parseSettingsChange(settingsBlock('None', 'Gemini 3.8 Flash (High)')) === 'Gemini 3.8 Flash (High)');
  check('1 parseSettingsChange entre dos etiquetas con puntos',
    parseSettingsChange(settingsBlock('Gemini 3.8 Flash (High)', 'Claude Sonnet 4.6 (Thinking)')) === 'Claude Sonnet 4.6 (Thinking)');
  check('1 parseSettingsChange con dos cambios: gana el ultimo',
    parseSettingsChange(`${settingsBlock('None', 'A (Low)')}\n${settingsBlock('A (Low)', 'B (High)')}`) === 'B (High)');
  check('1 un bloque redactado en otro idioma -> null',
    parseSettingsChange('El usuario cambió `Model Selection` de None a Gemini 3.8 Flash (High).') === null);
  check('1 un cambio de otro ajuste -> null',
    parseSettingsChange('The user changed setting `Theme` from dark to light. No need to comment on this change.') === null);

  check('2 stripStepHeader quita las dos lineas de hora y el blanco',
    stripStepHeader('Created At: 2026-09-12T21:11:59Z\nCompleted At: 2026-09-12T21:12:04Z\n\n\t\t\t\tThe command completed successfully.') === 'The command completed successfully.');
  check('2 stripStepHeader con una sola linea de hora', stripStepHeader('Created At: x\nTool is running') === 'Tool is running');
  check('2 stripStepHeader no toca un texto sin cabecera', stripStepHeader('File Path: a\nCreated At: b') === 'File Path: a\nCreated At: b');
  check('2 stripStepHeader no quita una tercera linea de hora', stripStepHeader('Created At: 1\nCompleted At: 2\nCreated At: 3') === 'Created At: 3');
  check('2 isFailedResult: exit 1 es error aunque el estado sea DONE', isFailedResult('DONE', 'The command exited with code 1.\nStdout:\n') === true);
  check('2 isFailedResult: exit 0 no', isFailedResult('DONE', 'The command exited with code 0.\n') === false);
  check('2 isFailedResult: el texto en el medio no cuenta', isFailedResult('DONE', 'Salida: The command exited with code 1.') === false);
  check('2 isFailedResult: ERROR, CANCELED, INTERRUPTED, HALTED si; RUNNING y DONE no',
    ['ERROR', 'CANCELED', 'INTERRUPTED', 'HALTED'].every((s) => isFailedResult(s, 'x')) && !isFailedResult('RUNNING', 'x') && !isFailedResult('DONE', 'x'));
}

// ---------------------------------------------------------------------------
// 2. El transcript convertido en eventos
// ---------------------------------------------------------------------------

/** Lo que hace `JsonlFollower` con cada linea, sin disco: para probar solo el sink. */
function feeder(mapper) {
  const store = [];
  let lineNumber = 0;
  const lookup = { find: (eventId) => store.find((event) => event.eventId === eventId) };
  return {
    store,
    feed(lines) {
      const added = [];
      for (const raw of lines) {
        lineNumber += 1;
        let record;
        try { record = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)); } catch { continue; }
        if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
        const event = mapper.consume(record, lineNumber, lookup);
        if (event !== null) { store.push(event); added.push(event); }
      }
      return added;
    },
  };
}
const partsOf = (events, kind) => events.flatMap((event) => event.parts.filter((part) => part.kind === kind));
const step = (index, source, type, extra = {}) => ({ step_index: index, source, type, status: 'DONE', created_at: `2026-09-13T02:15:${String(index).padStart(2, '0')}Z`, ...extra });
const call = (name, args) => ({ name, args });
const planner = (index, calls, extra = {}) => step(index, 'MODEL', 'PLANNER_RESPONSE', calls.length > 0 ? { tool_calls: calls, ...extra } : extra);
const result = (index, content, extra = {}) => step(index, 'MODEL', 'GENERIC', { content, ...extra });

// Forma de la 1.2.2: USER_INPUT con aviso, llamada, resultado GENERIC, paso que
// solo razona, comando que falla, mensaje de sistema y la respuesta final.
const viewArgs = { AbsolutePath: 'C:/Users/u/demo-app/notas/bienvenida.md', toolAction: 'Viewing note', toolSummary: 'View note' };
const commandArgs = { CommandLine: 'cmd /c exit 3', Cwd: 'C:\\Users\\u\\demo-app', WaitMsBeforeAsync: 5000, toolAction: 'Running terminal command', toolSummary: 'Run exit command' };
const transcript122 = [
  step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('Contame qué dice la nota de bienvenida.', settingsBlock('None', 'Gemini 3.8 Flash (High)')) }),
  planner(1, [call('view_file', viewArgs)], { thinking: 'Hay que leer la nota.\n\n\n' }),
  result(2, 'Created At: 2026-09-12T21:15:47-05:00\nCompleted At: 2026-09-12T21:15:47-05:00\nFile Path: `file:///C:/Users/u/demo-app/notas/bienvenida.md`\nTotal Lines: 1\n1: # Bienvenida\n'),
  planner(3, [], { thinking: 'Ya la tengo; pruebo un comando.' }),
  planner(5, [call('run_command', commandArgs)]),
  result(6, 'Created At: 2026-09-12T21:15:56-05:00\nCompleted At: 2026-09-12T21:15:57-05:00\n\nThe command exited with code 1.\nStdout:\n\nStderr:\n\n'),
  step(7, 'SYSTEM', 'SYSTEM_MESSAGE', { content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.' }),
  step(8, 'MODEL', 'CHECKPOINT', { content: 'paso de modelo sin llamada pendiente' }),
  step(9, 'USER_IMPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>implicito</USER_REQUEST>' }),
  planner(10, [], { content: '\nLa nota dice "Bienvenida" y está en español.\n' }),
];

{
  const mapper = new TranscriptMapper();
  const { feed } = feeder(mapper);
  const events = feed([...transcript122.map((s) => JSON.stringify(s)), 'esto no es json', '[1,2]', JSON.stringify({ type: 'USER_INPUT' }), JSON.stringify({ step_index: '11', type: 'USER_INPUT', source: 'USER_EXPLICIT', content: 'x' }), JSON.stringify({ step_index: 12 })]);

  check('2 (1.2.2) eventos en orden: s0 s1 s2 s5 s6 s10', events.map((e) => e.eventId).join(' ') === 's0 s1 s2 s5 s6 s10', events.map((e) => e.eventId).join(' '));
  check('2 roles: user assistant user assistant user assistant', events.map((e) => e.role).join(' ') === 'user assistant user assistant user assistant');
  check('2 at sale de created_at', events[0]?.at === Date.parse('2026-09-13T02:15:00Z') && events[5]?.at === Date.parse('2026-09-13T02:15:10Z'));
  check('2 el mensaje del usuario sin envoltorio', same(events[0]?.parts, [{ kind: 'text', text: 'Contame qué dice la nota de bienvenida.', truncated: false }]), show(events[0]?.parts));
  const view = events[1]?.parts[0];
  check('2 la llamada: id s1:0, nombre y argumentos como JSON', view?.kind === 'tool-call' && view.toolUseId === 's1:0' && view.name === 'view_file' &&
    same(JSON.parse(view.input), viewArgs) && view.truncated === false, show(view));
  const viewResult = events[2]?.parts[0];
  check('2 el resultado casado con s1:0, sin la cabecera de horas', viewResult?.kind === 'tool-result' && viewResult.toolUseId === 's1:0' &&
    viewResult.text.startsWith('File Path: `file:///') && viewResult.isError === false && viewResult.imageCount === 0, show(viewResult));
  const failed = events[4]?.parts[0];
  check('2 el comando que sale con codigo 1 es error, casado con s5:0', failed?.toolUseId === 's5:0' && failed.isError === true &&
    failed.text.startsWith('The command exited with code 1.'), show(failed));
  check('2 el paso que solo razona no deja evento, y no hay ninguna parte thinking', !events.some((e) => e.eventId === 's3') && partsOf(events, 'thinking').length === 0);
  check('2 SYSTEM_MESSAGE, un paso MODEL sin llamada pendiente y otra source: sin evento',
    !events.some((e) => ['s7', 's8', 's9'].includes(e.eventId)));
  check('2 la respuesta final, recortada de blancos', same(events[5]?.parts, [{ kind: 'text', text: 'La nota dice "Bienvenida" y está en español.', truncated: false }]), show(events[5]?.parts));
  check('2 las lineas basura, sin step_index numerico o sin type no rompen ni suman', events.length === 6);
  check('2 el modelo y el esfuerzo del aviso van en cada assistant, no en user',
    events.filter((e) => e.role === 'assistant').every((e) => e.model === 'Gemini 3.8 Flash (High)' && e.effort === 'high') &&
    events.filter((e) => e.role === 'user').every((e) => e.model === null && e.effort === null), show(events.map((e) => [e.model, e.effort])));
  check('2 sin uso, sin duracion, sin queued', events.every((e) => e.usage === null && e.durationMs === null && e.queued === false));
  check('2 currentModel y currentEffort', mapper.currentModel === 'Gemini 3.8 Flash (High)' && mapper.currentEffort === 'high');
  check('2 assistantMessages cuenta los eventos assistant', mapper.assistantMessages === 3, String(mapper.assistantMessages));
  check('2 no queda ninguna llamada abierta', mapper.hasOpenToolCall(0) === false);
  check('2 los eventos sobreviven al parser de shared', events.every((e) => same(shared.parseConversationEvent(JSON.parse(JSON.stringify(e))), e)));
}

// La version anterior: resultados RUN_COMMAND, historial de sistema y una tarea
// en segundo plano que se reescribe con el mismo step_index.
{
  const lookupArgs = { CommandLine: 'Get-Command demo -ErrorAction SilentlyContinue', Cwd: 'C:\\Users\\u\\demo', WaitMsBeforeAsync: 5000, toolAction: 'Checking demo command location', toolSummary: 'Checking demo command' };
  const old = [
    step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\n¿Dónde quedó instalado el comando?\n</USER_REQUEST>' }),
    step(1, 'SYSTEM', 'CONVERSATION_HISTORY'),
    planner(5, [call('run_command', lookupArgs)]),
    step(6, 'MODEL', 'RUN_COMMAND', { content: 'Created At: 2026-09-12T21:11:59Z\nCompleted At: 2026-09-12T21:12:04Z\n\n\t\t\t\tThe command completed successfully.\n\t\t\t\tOutput:\n\t\t\t\t\r\nCommandType     Name' }),
    planner(7, [call('run_command', { CommandLine: 'demo update', WaitMsBeforeAsync: 5000 })]),
    step(8, 'MODEL', 'RUN_COMMAND', { status: 'RUNNING', content: 'Created At: 2026-09-12T21:12:06Z\nTool is running as a background task with task id: x/task-8\nTask Description: demo update' }),
    step(10, 'SYSTEM', 'SYSTEM_MESSAGE', { content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.' }),
  ];
  const mapper = new TranscriptMapper();
  const { feed, store } = feeder(mapper);
  const events = feed(old);
  check('2 (anterior) eventos s0 s5 s6 s7 s8', events.map((e) => e.eventId).join(' ') === 's0 s5 s6 s7 s8', events.map((e) => e.eventId).join(' '));
  check('2 (anterior) sin aviso de modelo: model y effort null', events.every((e) => e.model === null && e.effort === null));
  const done = events[2]?.parts[0];
  check('2 (anterior) RUN_COMMAND casado, sin cabecera ni tabuladores al principio',
    done?.toolUseId === 's5:0' && done.text.startsWith('The command completed successfully.') && done.isError === false, show(done));
  const running = events[4]?.parts[0];
  check('2 (anterior) RUNNING no es error', running?.toolUseId === 's7:0' && running.isError === false && running.text.startsWith('Tool is running'), show(running));
  check('2 (anterior) una tarea en segundo plano no deja la llamada abierta', mapper.hasOpenToolCall(0) === false);

  // El mismo paso reescrito en otra lectura: se rehacen las partes del evento que ya salio.
  const rewritten = feed([step(8, 'MODEL', 'RUN_COMMAND', { status: 'ERROR', content: 'Created At: x\nCompleted At: y\nfallo la actualizacion' })]);
  const updates = mapper.takeParts(new Set());
  check('2 mismo step_index en otra lectura: ningun evento nuevo', rewritten.length === 0 && store.length === 5);
  check('2 y una actualizacion de partes para s8 con el resultado nuevo, casado con la misma llamada',
    updates.length === 1 && updates[0].eventId === 's8' && updates[0].parts[0].toolUseId === 's7:0' &&
    updates[0].parts[0].isError === true && updates[0].parts[0].text === 'fallo la actualizacion', show(updates));
  check('2 el evento guardado ya tiene las partes nuevas', store[4].parts[0].isError === true);
  check('2 takeParts vacia la lista', mapper.takeParts(new Set()).length === 0);

  // Reescrito en la misma lectura que el evento: viaja dentro del evento, sin actualizacion aparte.
  feed([planner(11, [call('run_command', { CommandLine: 'demo status' })]), result(12, 'primero'), result(12, 'despues')]);
  const fresh = mapper.takeParts(new Set(['s11', 's12']));
  check('2 reescrito dentro del mismo lote: sin actualizacion aparte', fresh.length === 0 && store.find((e) => e.eventId === 's12')?.parts[0].text === 'despues', show(fresh));

  const quiet = feed([step(8, 'MODEL', 'RUN_COMMAND', { content: '' })]);
  check('2 una reescritura sin contenido rehace el texto vacio, sin eventos nuevos', quiet.length === 0);

  const userAgain = feed([step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\n\n</USER_REQUEST>' })]);
  check('2 un paso reescrito que ya no produce evento deja el anterior',
    userAgain.length === 0 && store[0].parts[0].text === '¿Dónde quedó instalado el comando?' && mapper.takeParts(new Set()).every((u) => u.eventId !== 's0'));
}

// A3: el resultado se casa con el ultimo paso de planificacion anterior.
{
  const mapper = new TranscriptMapper();
  const { feed } = feeder(mapper);
  const events = feed([
    step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('revisá el proyecto') }),
    planner(1, [call('list_dir', { DirectoryPath: 'C:/Users/u/demo' })]),
    result(2, 'uno'),
    planner(3, [call('view_file', { AbsolutePath: 'C:/Users/u/demo/a.md' })]),
    result(4, 'dos'),
    planner(5, [call('view_file', { AbsolutePath: 'C:/Users/u/demo/b.md' })]),
    // El 6 falta: la llamada del 5 no tiene resultado.
    planner(7, [call('view_file', { AbsolutePath: 'C:/Users/u/demo/c.md' })]),
    result(8, 'el de c.md'),
  ]);
  const results = partsOf(events, 'tool-result');
  check('A3 los resultados: s1:0, s3:0 y el ultimo con s7:0 (no con s5:0)',
    results.map((r) => r.toolUseId).join(' ') === 's1:0 s3:0 s7:0', results.map((r) => r.toolUseId).join(' '));
  check('A3 la llamada del paso 5 queda como tarjeta sin resultado',
    partsOf(events, 'tool-call').some((c) => c.toolUseId === 's5:0') && !results.some((r) => r.toolUseId === 's5:0'));
  check('A3 un resultado de mas, sin llamada pendiente, se ignora', feed([result(9, 'huerfano')]).length === 0);

  // Varias llamadas en un mismo paso: por orden, dentro de ese paso.
  const batch = feed([
    planner(10, [call('view_file', { AbsolutePath: 'x' }), call('view_file', { AbsolutePath: 'y' })]),
    step(11, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('mensaje escrito mientras trabajaba') }),
    result(12, 'de x'),
    step(13, 'SYSTEM', 'SYSTEM_MESSAGE'),
    result(14, 'de y'),
  ]);
  const batchResults = partsOf(batch, 'tool-result');
  check('A3 dos llamadas y dos resultados: en orden (FIFO dentro del paso)',
    batchResults.map((r) => `${r.toolUseId}=${r.text}`).join(' ') === 's10:0=de x s10:1=de y', batchResults.map((r) => `${r.toolUseId}=${r.text}`).join(' '));
  check('A3 un mensaje del usuario o de sistema en el medio no cierra las llamadas', batch.some((e) => e.eventId === 's11'));

  // Una llamada que queda abierta, y lo que cuenta como abierta.
  feed([planner(20, [call('run_command', { CommandLine: 'demo test' })], { created_at: '2026-09-13T03:00:00Z' })]);
  const launched = Date.parse('2026-09-13T02:59:00Z');
  check('A3 llamada sin resultado pedida despues del lanzamiento: abierta', mapper.hasOpenToolCall(launched) === true);
  check('A3 pedida antes del lanzamiento: no cuenta', mapper.hasOpenToolCall(Date.parse('2026-09-13T03:01:00Z')) === false);
  feed([planner(21, [], { content: 'sigo sin esperar' })]);
  check('A3 un paso de planificacion nuevo la cierra sin resultado', mapper.hasOpenToolCall(launched) === false);
  check('A3 y un resultado posterior ya no se casa con ella', feed([result(22, 'tarde')]).length === 0);

  // Una llamada sin nombre no se dibuja, pero ocupa su lugar en la fila.
  const unnamed = feed([
    planner(30, [call('', { a: 1 }), { args: {} }, call('view_file', 'no-objeto')]),
    result(31, 'del primero'),
    result(32, 'del segundo'),
    result(33, 'del tercero'),
  ]);
  const unnamedCalls = partsOf(unnamed, 'tool-call');
  check('A3 llamadas sin nombre: no hay tarjeta; argumentos que no son objeto -> {}',
    unnamedCalls.length === 1 && unnamedCalls[0].toolUseId === 's30:2' && unnamedCalls[0].input === '{}', show(unnamedCalls));
  check('A3 y sus resultados tampoco; el de la llamada visible si, con su id',
    partsOf(unnamed, 'tool-result').map((r) => `${r.toolUseId}=${r.text}`).join(' ') === 's30:2=del tercero', show(partsOf(unnamed, 'tool-result')));

  // Otro paso de planificacion con aviso de modelo nuevo.
  const switched = feed([
    step(40, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('cambié de modelo', settingsBlock('Gemini 3.8 Flash (High)', 'Gemini 3.7 Flash (Medium)')) }),
    planner(41, [], { content: 'listo' }),
  ]);
  check('A3 el assistant posterior al cambio lleva el modelo y el esfuerzo nuevos',
    switched[1]?.model === 'Gemini 3.7 Flash (Medium)' && switched[1]?.effort === 'medium', show(switched[1]));
  check('A3 reescribir el USER_INPUT viejo no vuelve al modelo anterior',
    feed([step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('revisá el proyecto', settingsBlock('None', 'Gemini 3.1 Pro (Low)')) })]).length === 0 &&
    mapper.currentModel === 'Gemini 3.7 Flash (Medium)');
  check('A3 y como el texto es el mismo, no anota ninguna actualizacion', mapper.takeParts(new Set()).length === 0);

  // El paso de planificacion reescrito con una llamada mas.
  feed([planner(50, [call('view_file', { AbsolutePath: 'p' })]), result(51, 'de p')]);
  feed([planner(50, [call('view_file', { AbsolutePath: 'p' }), call('view_file', { AbsolutePath: 'q' })])]);
  const grown = mapper.takeParts(new Set());
  check('A3 el paso de planificacion reescrito rehace sus tarjetas',
    grown.length === 1 && grown[0].eventId === 's50' && grown[0].parts.map((p) => p.toolUseId).join(' ') === 's50:0 s50:1', show(grown));
  const late = feed([result(52, 'de q')]);
  check('A3 y la llamada nueva recibe el resultado que sigue, sin repetir la ya contestada',
    partsOf(late, 'tool-result').map((r) => r.toolUseId).join(' ') === 's50:1', show(partsOf(late, 'tool-result')));

  mapper.reset();
  check('A3 reset olvida modelo, cuenta y llamadas', mapper.currentModel === null && mapper.currentEffort === null &&
    mapper.assistantMessages === 0 && mapper.hasOpenToolCall(0) === false && mapper.takeParts(new Set()).length === 0);
}

// D4: `transcript.jsonl` con argumentos doble-codificados da el mismo `input`.
{
  const encode = (args) => Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)]));
  const lookupArgs = { CommandLine: 'Get-Command demo', Cwd: 'C:\\Users\\u\\demo', WaitMsBeforeAsync: 5000, Recursive: true, Missing: null, Filter: ['*.md'], Label: '-c', When: '2026-09-12' };
  const full = planner(5, [call('run_command', lookupArgs)]);
  const compact = planner(5, [call('run_command', encode(lookupArgs))]);
  const fromFull = new TranscriptMapper().consume(full, 1, { find: () => undefined });
  const fromCompact = new TranscriptMapper({ compact: true }).consume(compact, 1, { find: () => undefined });
  check('D4 el compacto decodificado da el mismo input que el completo',
    fromFull?.parts[0]?.input === fromCompact?.parts[0]?.input, `${fromFull?.parts[0]?.input} | ${fromCompact?.parts[0]?.input}`);
  check('D4 sin la marca compact, los argumentos doble-codificados quedan como texto',
    new TranscriptMapper().consume(compact, 1, { find: () => undefined })?.parts[0]?.input !== fromFull?.parts[0]?.input);
  const callsAsString = { ...compact, tool_calls: JSON.stringify(compact.tool_calls) };
  check('D4 tool_calls que llega como string tambien se decodifica',
    new TranscriptMapper({ compact: true }).consume(callsAsString, 1, { find: () => undefined })?.parts[0]?.input === fromFull?.parts[0]?.input);
  check('D4 un string que parece JSON y no lo es queda tal cual',
    same(decodeCompactStep({ tool_calls: [{ name: 'x', args: { A: '{roto', B: '12abc', C: 'texto' } }] }).tool_calls[0].args, { A: '{roto', B: '12abc', C: 'texto' }));
  check('D4 decodeCompactStep no toca el registro original', typeof compact.tool_calls[0].args.WaitMsBeforeAsync === 'string');
}

// Topes de transporte.
{
  const long = 'x'.repeat(9_000);
  const mapper = new TranscriptMapper();
  const { feed } = feeder(mapper);
  const events = feed([
    step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent(long) }),
    planner(1, [call('write_to_file', { CodeContent: 'y'.repeat(3_000) })], { content: long }),
    result(2, `Created At: a\n${'z'.repeat(5_000)}`),
  ]);
  check('topes: texto del usuario a 8000 y marcado', events[0].parts[0].text.length === 8_000 && events[0].parts[0].truncated === true);
  check('topes: texto del modelo a 8000', events[1].parts[0].text.length === 8_000 && events[1].parts[0].truncated === true);
  check('topes: entrada de herramienta a 2000', events[1].parts[1].input.length === 2_000 && events[1].parts[1].truncated === true);
  check('topes: resultado a 4000', events[2].parts[0].text.length === 4_000 && events[2].parts[0].truncated === true);
}

// El mapper enchufado al seguidor por offset de verdad, sobre un archivo.
{
  const { JsonlFollower } = await import('../src/agents/jsonl-follower.ts');
  const file = path.join(root, 'transcript_full.jsonl');
  const mapper = new TranscriptMapper();
  const follower = new JsonlFollower(file, mapper);
  const lines = transcript122.map((s) => JSON.stringify(s) + '\n');
  await writeFile(file, lines.slice(0, 2).join(''));
  const first = await follower.poll();
  const cut = Buffer.from(lines.slice(2).join(''), 'utf8');
  const middle = cut.indexOf(Buffer.from('á', 'utf8')) + 1; // a mitad de un caracter de dos bytes
  check('seguidor: el corte cae adentro de un caracter de dos bytes', middle > 0);
  await appendFile(file, cut.subarray(0, middle));
  const second = await follower.poll();
  await appendFile(file, cut.subarray(middle));
  const third = await follower.poll();
  const all = [...first.added, ...second.added, ...third.added];
  check('seguidor: los mismos eventos que sin disco, en orden', all.map((e) => e.eventId).join(' ') === 's0 s1 s2 s5 s6 s10', all.map((e) => e.eventId).join(' '));
  check('seguidor: sin caracteres rotos', !JSON.stringify(all).includes('\uFFFD'));
  await writeFile(file, lines[0]);
  const shrunk = await follower.poll();
  check('seguidor: el archivo encoge -> reset, y el mapper vuelve a empezar',
    shrunk.reset === true && shrunk.added.length === 1 && mapper.assistantMessages === 0 && mapper.currentModel === 'Gemini 3.8 Flash (High)');
}

// ---------------------------------------------------------------------------
// 6. fileUriToPath
// ---------------------------------------------------------------------------

{
  const { fileUriToPath } = await import('../src/agents/antigravity/file-uri.ts');
  const cases = [
    ['file:///d%3A/proy', 'win32', 'd:\\proy'],
    ['file://C:/Users/u/p', 'win32', 'C:\\Users\\u\\p'],
    ['file://D:/Con Espacios/p', 'win32', 'D:\\Con Espacios\\p'],
    ['file:///C:/Users/u/proyecto%20prueba', 'win32', 'C:\\Users\\u\\proyecto prueba'],
    ['file:///home/u/p', 'linux', '/home/u/p'],
    ['file:///Users/u/p%20q', 'darwin', '/Users/u/p q'],
    ['https://x', 'win32', null],
    ['basura', 'win32', null],
    ['', 'linux', null],
    ['file://servidor/share/p', 'linux', null],
  ];
  for (const [uri, platform, expected] of cases) {
    const got = fileUriToPath(uri, platform);
    check(`6 ${show(uri)} en ${platform} -> ${show(expected)}`, got === expected, show(got));
  }
}

// ---------------------------------------------------------------------------
// Utilidades de los casos con disco (3, 4, 5)
// ---------------------------------------------------------------------------

/** Espera por condicion, con plazo. Nunca un sleep fijo. */
async function waitFor(condition, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

const agyPaths = await import('../src/agents/antigravity/paths.ts');
/** Fecha y tamano de un archivo, o null si no esta. */
async function statStampOf(file) {
  try {
    const info = await stat(file);
    return { size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return null;
  }
}
/** Los nombres de una carpeta, ordenados, o null si no esta. */
async function listing(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return null;
  }
}
const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const jsonl = (steps) => steps.map((s) => JSON.stringify(s) + '\n').join('');
/** Escribe un transcript de una conversacion del home falso. `which`: 'full' o 'compact'. */
async function writeTranscript(id, content, which = 'full') {
  const paths = agyPaths.transcriptPaths(id);
  await mkdir(path.dirname(paths.full), { recursive: true });
  await writeFile(which === 'full' ? paths.full : paths.compact, content);
  return which === 'full' ? paths.full : paths.compact;
}
async function writeConversationFile(id, kind, content) {
  const files = agyPaths.conversationFiles(id);
  await mkdir(path.dirname(files.pb), { recursive: true });
  await writeFile(kind === 'pb' ? files.pb : files.db, content);
}
const { loadSqlite } = await import('../src/agents/sqlite.ts');
const sqliteModule = loadSqlite();
check('disco: este Node trae node:sqlite (hace falta para el caso 5)', 'DatabaseSync' in sqliteModule, process.version);

// ---------------------------------------------------------------------------
// 3. El seguidor, incremental y con huella
// ---------------------------------------------------------------------------

const { AntigravitySessionFollower, TRANSCRIPT_FINGERPRINT_BYTES } = await import('../src/agents/antigravity/session-follower.ts');
const { JsonlFollower: PlainJsonlFollower } = await import('../src/agents/jsonl-follower.ts');

{
  const id = U(201);
  const full = await writeTranscript(id, jsonl(transcript122.slice(0, 2)));
  const follower = new AntigravitySessionFollower(id, { platform: 'win32' });
  check('3 antes de leer: waiting y sin eventos', follower.getState() === 'waiting' && follower.getTail(10).events.length === 0);
  const first = await follower.poll();
  check('3 dos pasos: s0 y s1, estado live', first.added.map((e) => e.eventId).join(' ') === 's0 s1' && follower.getState() === 'live' && first.reset === false);
  check('3 el resultado trae las listas vacias del contrato', same(first.turns, []) && same(first.plans, []) && same(first.parts, []));

  const rest = Buffer.from(jsonl(transcript122.slice(2)).replace('Bienvenida', 'Bienvenida en español'), 'utf8');
  const middle = rest.indexOf(Buffer.from('ñ', 'utf8')) + 1;
  check('3 el corte cae adentro de la ñ', middle > 0);
  await appendFile(full, rest.subarray(0, middle));
  const second = await follower.poll();
  await appendFile(full, rest.subarray(middle));
  const third = await follower.poll();
  const all = [...first.added, ...second.added, ...third.added];
  check('3 cortado a mitad de la ñ: los eventos enteros y en orden', all.map((e) => e.eventId).join(' ') === 's0 s1 s2 s5 s6 s10', all.map((e) => e.eventId).join(' '));
  check('3 sin caracteres rotos', !JSON.stringify(all).includes('\uFFFD') && JSON.stringify(all).includes('español'));
  check('3 label: la ruta que sigue', follower.label === full);

  // El mismo paso reescrito en otra lectura: sale como actualizacion de partes.
  await appendFile(full, JSON.stringify(result(6, 'Created At: a\nCompleted At: b\nThe command exited with code 0.\n')) + '\n');
  const rewritten = await follower.poll();
  check('3 un paso reescrito despues: sin eventos nuevos, con parts de s6',
    rewritten.added.length === 0 && rewritten.parts.length === 1 && rewritten.parts[0].eventId === 's6' && rewritten.parts[0].parts[0].isError === false, show(rewritten.parts));

  // Reescritura del mismo tamano con otra primera linea: la huella la ve.
  const before = await readFile(full, 'utf8');
  const sameSize = before.replace('"created_at":"2026-09-13T02:15:00Z"', '"created_at":"2026-09-13T02:15:09Z"');
  check('3 la reescritura tiene el mismo tamano y otra primera linea',
    sameSize !== before && Buffer.byteLength(sameSize) === Buffer.byteLength(before) && Buffer.byteLength(before) >= TRANSCRIPT_FINGERPRINT_BYTES);
  await writeFile(full, sameSize);
  const fingerprinted = await follower.poll();
  check('3 misma medida, otro principio -> reset (huella)', fingerprinted.reset === true && fingerprinted.added[0]?.at === Date.parse('2026-09-13T02:15:09Z'), show({ reset: fingerprinted.reset, n: fingerprinted.added.length }));
  const quiet = await follower.poll();
  check('3 sin cambios despues: ni reset ni eventos', quiet.reset === false && quiet.added.length === 0);

  // Sin la opcion (Claude Code, Codex) una reescritura igual no se nota: la huella es opt-in.
  const plainFile = path.join(root, 'sin-huella.jsonl');
  await writeFile(plainFile, before);
  const plain = new PlainJsonlFollower(plainFile, new TranscriptMapper());
  await plain.poll();
  await writeFile(plainFile, sameSize);
  check('3 JsonlFollower sin fingerprintBytes: misma reescritura, sin reset (sin cambio para las otras CLIs)', (await plain.poll()).reset === false);

  await writeFile(full, jsonl(transcript122.slice(0, 1)));
  const shrunk = await follower.poll();
  check('3 el archivo encoge -> reset con lo que queda', shrunk.reset === true && shrunk.added.map((e) => e.eventId).join(' ') === 's0');

  check('3 noticeChange con la ruta en mayusculas (win32) -> true', follower.noticeChange(full.toUpperCase()) === true);
  check('3 noticeChange del compacto de la misma conversacion -> true', follower.noticeChange(agyPaths.transcriptPaths(id).compact) === true);
  check('3 noticeChange de otra conversacion -> false', follower.noticeChange(agyPaths.transcriptPaths(U(202)).full) === false);
  check('3 en linux las mayusculas cuentan',
    new AntigravitySessionFollower(id, { platform: 'linux' }).noticeChange(full.toUpperCase()) === (full.toUpperCase() === full));
  check('3 sin planes ni imagenes', same(follower.getPlanFiles(), []) && (await follower.readImage('s0', 0, 'content')) === null);

  await rm(path.dirname(path.dirname(path.dirname(full))), { recursive: true, force: true });
  const gone = await follower.poll();
  check('3 el transcript desaparece -> reset y waiting', gone.reset === true && follower.getState() === 'waiting');
  await writeTranscript(id, jsonl(transcript122.slice(0, 2)));
  const back = await follower.poll();
  check('3 y si vuelve a aparecer se sigue de nuevo', back.added.length === 2 && follower.getState() === 'live');
}

// ---------------------------------------------------------------------------
// 4. Estados del seguidor, sessionId vacio y la status line
// ---------------------------------------------------------------------------

{
  // M4: con sessionId '' la ruta seria brain/.system_generated/logs/…: se arma ese archivo para ver que no se lee.
  const collapsed = path.join(agyPaths.brainRoot(), '.system_generated', 'logs', 'transcript_full.jsonl');
  await mkdir(path.dirname(collapsed), { recursive: true });
  await writeFile(collapsed, jsonl(transcript122));
  const empty = new AntigravitySessionFollower('');
  const polled = await empty.poll();
  check('4 (M4) sessionId vacio: waiting, sin eventos, sin reset',
    empty.getState() === 'waiting' && polled.added.length === 0 && polled.reset === false && same(polled.parts, []) && polled.usageChanged === undefined);
  check('4 (M4) no lee brain/.system_generated/logs aunque exista', empty.getTail(50).events.length === 0 && empty.getPageBefore('s1', 5).events.length === 0);
  check('4 (M4) noticeChange de esa ruta -> false', empty.noticeChange(collapsed) === false);
  check('4 (M4) sin llamada abierta, sin modo, uso vacio',
    empty.hasOpenToolCall(0) === false && empty.getPermissionMode() === null && same(empty.getUsage(), shared.EMPTY_CONTEXT_USAGE));
  check('4 (M4) label sin ruta inventada', !empty.label.includes('.system_generated'), empty.label);
  check('4 un id que es un camino tampoco arma ruta', (await new AntigravitySessionFollower('../x').poll()).added.length === 0);

  const nothing = new AntigravitySessionFollower(U(210));
  await nothing.poll();
  check('4 sin carpeta ni .pb -> waiting', nothing.getState() === 'waiting');

  const legacyId = U(211);
  await writeTranscript(legacyId, '');
  await writeConversationFile(legacyId, 'pb', Buffer.from([0x0a, 0x10, 0x01]));
  const legacy = new AntigravitySessionFollower(legacyId);
  await legacy.poll();
  check('4 transcript de 0 B + .pb con contenido -> no-transcript', legacy.getState() === 'no-transcript', legacy.getState());

  const dbOnly = U(212);
  await writeTranscript(dbOnly, '');
  await writeConversationFile(dbOnly, 'db', 'SQLite format 3\0');
  const fresh = new AntigravitySessionFollower(dbOnly);
  await fresh.poll();
  check('4 transcript de 0 B, sin .pb y con .db -> waiting (la 1.2.2 antes del primer paso)', fresh.getState() === 'waiting', fresh.getState());
  await writeTranscript(dbOnly, jsonl(transcript122.slice(0, 2)));
  const grown = await fresh.poll();
  check('4 cuando llega el primer paso -> live', grown.added.length === 2 && fresh.getState() === 'live');

  const pbNoTranscript = U(213);
  await writeConversationFile(pbNoTranscript, 'pb', Buffer.from([1, 2, 3]));
  const noFolder = new AntigravitySessionFollower(pbNoTranscript);
  await noFolder.poll();
  check('4 sin transcript y con .pb -> no-transcript', noFolder.getState() === 'no-transcript');

  // Solo transcript.jsonl: se sigue ese, decodificado.
  const compactId = U(214);
  const encode = (args) => Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)]));
  const compactFile = await writeTranscript(compactId, jsonl([
    step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('mirá la nota') }),
    planner(1, [call('view_file', encode(viewArgs))]),
  ]), 'compact');
  const compact = new AntigravitySessionFollower(compactId);
  const compactRead = await compact.poll();
  const compactCall = compactRead.added[1]?.parts[0];
  check('4 solo transcript.jsonl -> lo sigue, live', compact.getState() === 'live' && compact.label === compactFile && compactRead.added.length === 2);
  check('4 y con los argumentos decodificados', compactCall?.kind === 'tool-call' && same(JSON.parse(compactCall.input), viewArgs), show(compactCall));
  await writeTranscript(compactId, jsonl(transcript122.slice(0, 1)), 'full');
  await compact.poll();
  check('4 elegido el compacto, que aparezca el completo no lo cambia', compact.label === compactFile);

  // Una llamada abierta, y la status line.
  const openId = U(215);
  const launchedAt = Date.parse('2026-09-13T02:59:00Z');
  await writeTranscript(openId, jsonl([
    step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('corré los tests', settingsBlock('None', 'Gemini 3.7 Flash (Medium)')) }),
    planner(1, [call('run_command', { CommandLine: 'demo test' })], { created_at: '2026-09-13T03:00:00Z' }),
  ]));
  const plainOpen = new AntigravitySessionFollower(openId);
  await plainOpen.poll();
  check('4 sin status line: la llamada sin resultado cuenta como abierta', plainOpen.hasOpenToolCall(launchedAt) === true);
  check('4 sin status line: uso vacio con el modelo del transcript y las respuestas',
    same(plainOpen.getUsage(), { ...shared.EMPTY_CONTEXT_USAGE, lastModel: 'Gemini 3.7 Flash (Medium)', assistantMessages: 1 }), show(plainOpen.getUsage()));
  check('4 sin status line: no hay modo observado', plainOpen.getPermissionMode() === null);

  let active = true;
  let live = true;
  let tokens = 1000;
  const refreshed = [];
  const statusLine = {
    active: () => active,
    live: (conversationId) => live && conversationId === openId,
    refresh: async (conversationId) => { refreshed.push(conversationId); },
    usage: (conversationId, base) => (conversationId === openId ? { ...base, lastRequestTokens: tokens, contextWindow: 1048576 } : null),
    permissionMode: () => 'plan',
  };
  const withStatus = new AntigravitySessionFollower(openId, { statusLine });
  const firstStatus = await withStatus.poll();
  check('4 con status line: cada lectura la refresca con el id', refreshed.length === 1 && refreshed[0] === openId);
  check('4 con status line: el uso y el modo son los suyos',
    withStatus.getUsage().lastRequestTokens === 1000 && withStatus.getUsage().lastModel === 'Gemini 3.7 Flash (Medium)' && withStatus.getPermissionMode() === 'plan');
  check('4 con status line publicando para la pty: la llamada abierta la dice ella, no el transcript', withStatus.hasOpenToolCall(launchedAt) === false);
  live = false;
  check('4 (R27-1) status line configurada pero sin registro de la pty: la llamada sin resultado vuelve a contar como abierta',
    withStatus.hasOpenToolCall(launchedAt) === true);
  live = true;
  check('4 la primera lectura trae eventos: usageChanged no hace falta', firstStatus.added.length === 2 && firstStatus.usageChanged === undefined);
  tokens = 2000;
  const onlyUsage = await withStatus.poll();
  check('4 el uso cambia sin pasos nuevos -> usageChanged', onlyUsage.added.length === 0 && onlyUsage.usageChanged === true, show(onlyUsage));
  const still = await withStatus.poll();
  check('4 sin cambios -> sin usageChanged', still.usageChanged === undefined);
  active = false;
  check('4 status line que se desactiva: vuelve al uso del transcript y a la llamada abierta',
    withStatus.getUsage().lastRequestTokens === 0 && withStatus.hasOpenToolCall(launchedAt) === true && withStatus.getPermissionMode() === null);
}

// ---------------------------------------------------------------------------
// 5. Catalogo e historial
// ---------------------------------------------------------------------------

const catalogModule = await import('../src/agents/antigravity/catalog.ts');
const { AntigravityCatalog, parseSummaryTime, parseWorkspaceUris, parseHistoryText, projectFolderOf, removeStaleCatalogCopies, GENERIC_PROJECT_IDS } = catalogModule;
const historyModule = await import('../src/agents/antigravity/history.ts');
const { createAntigravityHistory, ignoreInBrain, transcriptConversationId, segmentsUnder, ANTIGRAVITY_FOLLOW_POLL_MS, catalogFiles } = historyModule;
const { FileStampSignal } = await import('../src/agents/antigravity/catalog-signal.ts');
const { catalogTempDir } = await import('../src/paths.ts');

{
  check('5 fechas: con espacio se lee como T y 0001-01-01 es sin fecha',
    parseSummaryTime('2026-09-13 02:17:41.1234567+00:00') === Date.parse('2026-09-13T02:17:41.123Z') &&
    parseSummaryTime('0001-01-01 00:00:00+00:00') === 0 && parseSummaryTime('') === 0 && parseSummaryTime(null) === 0 && parseSummaryTime('basura') === 0,
    show(parseSummaryTime('2026-09-13 02:17:41.1234567+00:00')));
  check('5 workspace_uris: array JSON, "" o basura',
    same(parseWorkspaceUris('["file:///C:/a", 3, ""]'), ['file:///C:/a']) && same(parseWorkspaceUris(''), []) && same(parseWorkspaceUris('[roto'), []) && same(parseWorkspaceUris(null), []));
  const parsedHistory = parseHistoryText([
    JSON.stringify({ display: 'segundo', timestamp: 20, workspace: 'D:\\a', conversationId: U(1).toUpperCase() }),
    JSON.stringify({ display: 'primero', timestamp: 10, workspace: '', conversationId: U(1) }),
    JSON.stringify({ display: '/model x', timestamp: 30, workspace: 'D:\\a', conversationId: U(2), type: 'slash_command' }),
    JSON.stringify({ display: 'sin id', timestamp: 40, workspace: 'D:\\a' }),
    'no json',
  ].join('\n'));
  check('5 history.jsonl: por id en minusculas, el mas viejo es el primero, la carpeta no vacia',
    same(parsedHistory.get(U(1)), { firstDisplay: 'primero', firstTimestamp: 10, lastTimestamp: 20, workspace: 'D:\\a' }), show([...parsedHistory]));
  check('5 history.jsonl: los comandos de barra y las lineas sin id no cuentan (P0-12)', parsedHistory.size === 1);
  check('5 proyectos: las tres formas de URI',
    projectFolderOf({ projectResources: { resources: [{ gitFolder: { folderUri: 'file:///d%3A/demo-a' } }] } }, 'win32') === 'd:\\demo-a' &&
    projectFolderOf({ projectResources: { resources: [{ gitFolder: { folderUri: 'file://D:/Con Espacios/demo' } }] } }, 'win32') === 'D:\\Con Espacios\\demo' &&
    projectFolderOf({ projectResources: { resources: [{ folderUri: 'https://x' }, { folderUri: 'file:///d%3A/demo-c' }] } }, 'win32') === 'd:\\demo-c' &&
    projectFolderOf({ id: 'default-cli-project', projectResources: {} }, 'win32') === null);
  check('5 proyectos genericos', ['', 'default-cli-project', 'outside-of-project'].every((id) => GENERIC_PROJECT_IDS.has(id)) && !GENERIC_PROJECT_IDS.has(U(900)));
}

// El home falso: brain/, history.jsonl, last_conversations.json, la base y los proyectos.
const ID = {
  may: U(101), mayC: U(102), add: U(104), noCwd: U(105), sub: U(107), clear: U(108),
  last: U(109), compact: U(110), ide: U(111), steps: U(112), fresh: U(113),
};
const PROJ_A = '11111111-1111-4111-8111-111111111111';
const PROJ_B = '22222222-2222-4222-8222-222222222222';
const PROJ_C = '33333333-3333-4333-8333-333333333333';
const cliDir = path.join(home, '.gemini', 'antigravity-cli');
const summariesFile = agyPaths.summariesDbPath();
const CREATE_SUMMARIES = 'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`))';
const summaryRow = (id, fields) => ({
  conversation_id: id, title: '', preview: '', step_count: 0, last_modified_time: '2026-09-13 02:00:00.0000000+00:00',
  workspace_uris: '', project_id: 'default-cli-project', parent_conversation_id: '', nesting_depth: 0,
  last_user_input_time: '2026-09-13 02:00:00+00:00', app_data_dir: 'antigravity-cli', ...fields,
});
function insertSummaries(db, rows) {
  const insert = db.prepare('INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, project_id, parent_conversation_id, nesting_depth, last_user_input_time, app_data_dir, raw_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.conversation_id, row.title, row.preview, row.step_count, row.last_modified_time, row.workspace_uris, row.project_id, row.parent_conversation_id, row.nesting_depth, row.last_user_input_time, row.app_data_dir, Buffer.from([8, 1]));
  }
}

{
  const userStep = (text) => jsonl([step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent(text) }), planner(1, [], { content: 'listo' })]);
  await writeTranscript(ID.may, '');
  await writeConversationFile(ID.may, 'pb', Buffer.from([1, 2, 3, 4]));
  await writeTranscript(ID.mayC, '');
  await writeConversationFile(ID.mayC, 'pb', Buffer.from([5, 6]));
  await writeTranscript(ID.add, userStep('Ordená las notas del proyecto'));
  await writeConversationFile(ID.add, 'db', 'SQLite format 3\0');
  await writeTranscript(ID.noCwd, userStep('Listá las tareas pendientes'));
  await writeTranscript(ID.sub, userStep('tarea de un sub-agente'));
  await mkdir(path.join(agyPaths.brainRoot(), ID.clear, 'scratch'), { recursive: true });
  await writeConversationFile(ID.clear, 'db', 'SQLite format 3\0');
  await writeTranscript(ID.last, jsonl([step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: '<USER_REQUEST>\n\n</USER_REQUEST>' }), step(2, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('Revisá los permisos\ndel instalador') })]));
  await writeTranscript(ID.compact, userStep('Pregunta del compacto'), 'compact');
  await writeTranscript(ID.ide, userStep('Pregunta de la CLI'));
  await mkdir(path.join(agyPaths.brainRoot(), ID.steps), { recursive: true });
  await mkdir(path.join(agyPaths.brainRoot(), 'tempmediaStorage'), { recursive: true });
  await writeFile(path.join(agyPaths.brainRoot(), 'notas.txt'), 'no es una conversacion');
  // Lo que vive al lado del transcript y no se abre nunca (para el recorrido de M2).
  const addLogs = path.dirname(agyPaths.transcriptPaths(ID.add).full);
  await mkdir(path.join(addLogs, 'chunks', 'transcript'), { recursive: true });
  await writeFile(path.join(addLogs, 'chunks', 'transcript', '00000000.jsonl'), userStep('copia'));
  await mkdir(path.join(agyPaths.brainRoot(), ID.add, '.system_generated', 'messages'), { recursive: true });
  await writeFile(path.join(agyPaths.brainRoot(), ID.add, '.system_generated', 'messages', 'm.json'), '{}');
  await mkdir(path.join(agyPaths.brainRoot(), ID.add, '.user_uploaded'), { recursive: true });
  await writeFile(path.join(agyPaths.brainRoot(), ID.add, '.user_uploaded', 'foto.png'), 'png');

  await writeFile(agyPaths.historyPath(), [
    JSON.stringify({ display: 'arranquemos con la prueba', timestamp: 1779470000000, workspace: 'D:\\demo\\entorno', conversationId: ID.may }),
    JSON.stringify({ display: '-c', timestamp: 1779470100000, workspace: 'D:\\demo\\entorno' }),
    JSON.stringify({ display: '/model gemini-3.7-flash-low', timestamp: 1779476200000, workspace: 'C:\\Users\\u\\demo-notas', conversationId: ID.add, type: 'slash_command' }),
    JSON.stringify({ display: 'segundo mensaje', timestamp: 1779476300000, workspace: 'D:\\demo\\entorno', conversationId: ID.may }),
  ].join('\n') + '\n');
  await mkdir(path.dirname(agyPaths.lastConversationsPath()), { recursive: true });
  await writeFile(agyPaths.lastConversationsPath(), JSON.stringify({ 'D:\\demo\\instalador': ID.last, 'C:\\Users\\u\\demo-notas': ID.add, 'D:\\otro': 'no-uuid' }));
  await mkdir(agyPaths.projectsRoot(), { recursive: true });
  await writeFile(path.join(agyPaths.projectsRoot(), `${PROJ_A}.json`), JSON.stringify({ id: PROJ_A, name: 'demo-a', projectResources: { resources: [{ gitFolder: { folderUri: 'file:///d%3A/demo-a', allowWrite: true } }] } }));
  await writeFile(path.join(agyPaths.projectsRoot(), `${PROJ_B}.json`), JSON.stringify({ id: PROJ_B, name: 'demo-b', projectResources: { resources: [{ gitFolder: { folderUri: 'file://D:/Con Espacios/demo', allowWrite: true } }] } }));
  await writeFile(path.join(agyPaths.projectsRoot(), `${PROJ_C}.json`), JSON.stringify({ id: PROJ_C, name: 'demo-c', projectResources: { resources: [{ folderUri: 'file:///d%3A/demo-c' }] } }));
  await writeFile(path.join(agyPaths.projectsRoot(), 'default-cli-project.json'), JSON.stringify({ id: 'default-cli-project', name: 'CLI Project', projectResources: {} }));

  const writer = new sqliteModule.DatabaseSync(summariesFile);
  writer.exec('PRAGMA journal_mode = WAL');
  writer.exec(CREATE_SUMMARIES);
  insertSummaries(writer, [
    summaryRow(ID.add, { title: 'Ordenar Notas Del Proyecto', preview: 'Ordenar Notas Del Proyecto', step_count: 18, last_modified_time: '2026-09-13 02:17:41.1234567+00:00', workspace_uris: '["file:///C:/Users/u/demo-notas"]' }),
    summaryRow(ID.noCwd, { title: 'Revisar Tareas Pendientes', preview: 'Revisar Tareas Pendientes', step_count: 9, last_modified_time: '2026-09-13 02:08:10.7654321+00:00' }),
    summaryRow(ID.may, { preview: 'Armando El Entorno', step_count: 13, last_modified_time: '2026-05-22 18:40:05.1111111+00:00', project_id: PROJ_A }),
    summaryRow(ID.mayC, { preview: '-c', step_count: 6, last_modified_time: '2026-05-22 18:42:07.2222222+00:00', project_id: PROJ_B }),
    summaryRow(ID.sub, { title: 'Sub Agente', step_count: 4, parent_conversation_id: ID.add, nesting_depth: 1 }),
    summaryRow(ID.clear, { step_count: 0, last_modified_time: '0001-01-01 00:00:00+00:00', workspace_uris: '["file:///C:/Users/u/demo-notas"]' }),
    summaryRow(ID.steps, { title: 'Pasos Sin Transcript', step_count: 3, last_modified_time: '2026-09-13 02:30:00+00:00', workspace_uris: '["file:///C:/Users/u/demo-pasos"]' }),
    summaryRow(ID.ide, { title: 'Titulo Del IDE', step_count: 20, workspace_uris: '["file:///C:/ide"]', app_data_dir: 'antigravity' }),
  ]);
  writer.close();
}

{
  const warnings = [];
  const catalog = new AntigravityCatalog({ platform: 'win32', warn: (message) => warnings.push(message) });
  let signalListener = null;
  const signal = { subscribe: (listener) => { signalListener = listener; return () => { signalListener = null; }; } };
  const history = createAntigravityHistory({ catalog, signal, platform: 'win32' });

  // M9 (i): base en WAL cerrada. La lectura no deja nada al lado ni la toca.
  const dbBefore = await statStampOf(summariesFile);
  const beside = await listing(cliDir);
  check('5 (M9 i) la base del fixture quedo en WAL y cerrada: sin -wal ni -shm', beside.includes('conversation_summaries.db') && !beside.some((name) => /-(wal|shm)$/.test(name)), show(beside));

  // Las conversaciones de los casos 3 y 4 viven en el mismo home (ids 2xx): se miran solo las de este caso.
  const items = (await history.list())?.filter((item) => /-0000000001\d\d$/.test(item.sessionId));
  const byId = new Map((items ?? []).map((item) => [item.sessionId, item]));
  const expectedIds = [ID.may, ID.mayC, ID.add, ID.noCwd, ID.last, ID.compact, ID.ide, ID.steps].sort();
  check('5 list(): las conversaciones esperadas', same([...byId.keys()].sort(), expectedIds), show([...byId.keys()].sort()));
  const allListed = new Set((await history.list()).map((item) => item.sessionId));
  check('5 list(): de los casos 3 y 4, la de .pb sin transcript si; sin carpeta en brain/ no',
    allListed.has(U(211)) && allListed.has(U(214)) && !allListed.has(U(210)) && !allListed.has(U(213)), show([...allListed].filter((id) => /-0000000002\d\d$/.test(id))));
  check('5 list(): no el sub-agente, ni la vacia de /clear, ni lo que no es un uuid',
    !byId.has(ID.sub) && !byId.has(ID.clear) && ![...byId.keys()].some((key) => !CONVERSATION_ID_PATTERN.test(key)));
  check('5 (M9 i) tras list(): sin -wal ni -shm al lado, la base con la misma fecha y tamano',
    same(await listing(cliDir), beside) && same(await statStampOf(summariesFile), dbBefore), show(await listing(cliDir)));
  check('5 (M9 i) la copia temporal no quedo', ((await listing(catalogTempDir())) ?? []).length === 0, show(await listing(catalogTempDir())));
  check('5 la base no se leyo sin avisos', warnings.length === 0, show(warnings));

  // A2: grupos.
  check('5 (A2) default-cli-project no agrupa: cada conversacion es su grupo',
    byId.get(ID.add)?.group === `conv:${ID.add}` && byId.get(ID.noCwd)?.group === `conv:${ID.noCwd}`, show([byId.get(ID.add)?.group, byId.get(ID.noCwd)?.group]));
  check('5 (A2) un proyecto de verdad si agrupa', byId.get(ID.may)?.group === PROJ_A && byId.get(ID.mayC)?.group === PROJ_B);
  check('5 sin fila en el indice: grupo propio', byId.get(ID.last)?.group === `conv:${ID.last}` && byId.get(ID.ide)?.group === `conv:${ID.ide}`);
  check('5 mtime: tambien la fecha del indice (sin archivos, la de la fila)', byId.get(ID.steps)?.mtimeMs === Date.parse('2026-09-13T02:30:00Z') && byId.get(ID.steps)?.sizeBytes === 0);
  check('5 mtime: la fecha del historial cuenta', (byId.get(ID.may)?.mtimeMs ?? 0) >= 1779476300000);
  check('5 sizeBytes: el tamano del transcript', byId.get(ID.add)?.sizeBytes === (await statStampOf(agyPaths.transcriptPaths(ID.add).full)).size);
  check('5 la fila del IDE no aparece en el catalogo', catalog.get(ID.ide).summary === null);

  const scans = new Map();
  for (const item of items ?? []) scans.set(item.sessionId, await history.scan(item));
  const expected = [
    [ID.add, 'C:\\Users\\u\\demo-notas', 'Ordenar Notas Del Proyecto', 'ai', 'workspace_uris[0]'],
    [ID.noCwd, null, 'Revisar Tareas Pendientes', 'ai', 'ninguna fuente'],
    [ID.may, 'D:\\demo\\entorno', 'arranquemos con la prueba', 'first-message', 'history.jsonl (transcript en 0 B)'],
    [ID.mayC, 'D:\\Con Espacios\\demo', '-c', 'first-message', 'el proyecto (preview)'],
    [ID.last, 'D:\\demo\\instalador', 'Revisá los permisos del instalador', 'first-message', 'last_conversations.json (cabeza del transcript)'],
    [ID.compact, null, 'Pregunta del compacto', 'first-message', 'transcript.jsonl'],
    [ID.ide, null, 'Pregunta de la CLI', 'first-message', 'sin la fila del IDE'],
    [ID.steps, 'C:\\Users\\u\\demo-pasos', 'Pasos Sin Transcript', 'ai', 'solo el indice'],
  ];
  for (const [id, cwd, title, titleSource, what] of expected) {
    const scanned = scans.get(id);
    check(`5 scan ${id.slice(-3)} (${what}): cwd ${show(cwd)}, titulo ${show(title)} (${titleSource})`,
      scanned?.cwd === cwd && scanned?.summary.title === title && scanned?.summary.titleSource === titleSource &&
      scanned?.summary.sessionId === id && scanned?.summary.updatedAt === byId.get(id)?.mtimeMs && same(scanned?.extra, {}),
      show(scanned));
  }
  const { buildProjects } = await import('../src/session-index.ts');
  const indexed = [...scans.entries()].map(([id, scanned]) => ({
    agent: 'antigravity', ref: id, group: byId.get(id).group, cwd: scanned.cwd,
    summary: { ...scanned.summary, agent: 'antigravity', cwd: scanned.cwd ?? '', archived: false },
  }));
  const projects = buildProjects(indexed, 'win32');
  const keyOf = (id) => projects.find((project) => project.sessions.some((s) => s.sessionId === id))?.key;
  check('5 (A2) la conversacion sin cwd queda en unknown:antigravity:conv:<id>', keyOf(ID.noCwd) === `unknown:antigravity:conv:${ID.noCwd}`, show(keyOf(ID.noCwd)));
  check('5 (A2) y no se junta con otra sin cwd ni con la de workspace_uris',
    keyOf(ID.compact) === `unknown:antigravity:conv:${ID.compact}` && keyOf(ID.add) === 'c:\\users\\u\\demo-notas', show([keyOf(ID.compact), keyOf(ID.add)]));

  // changedRefs.
  const transcriptOfAdd = agyPaths.transcriptPaths(ID.add).full;
  check('5 changedRefs de un transcript -> [id]', same(await history.changedRefs(transcriptOfAdd), [ID.add]));
  check('5 changedRefs del compacto, con / -> [id]', same(await history.changedRefs(agyPaths.transcriptPaths(ID.compact).compact.replace(/\\/g, '/')), [ID.compact]));
  check('5 changedRefs de chunks/transcript/00000000.jsonl -> null', (await history.changedRefs(path.join(path.dirname(transcriptOfAdd), 'chunks', 'transcript', '00000000.jsonl'))) === null);
  check('5 changedRefs de conversations/<id>.db y de otra cosa -> null',
    (await history.changedRefs(agyPaths.conversationFiles(ID.add).db)) === null && (await history.changedRefs(path.join(cliDir, 'settings.json'))) === null);
  check('5 changedRefs del catalogo sin cambios -> []', same(await history.changedRefs(agyPaths.historyPath()), []));
  await appendFile(agyPaths.historyPath(), JSON.stringify({ display: 'otro mensaje', timestamp: 1779490000000, workspace: 'D:\\demo\\instalador', conversationId: ID.last }) + '\n');
  check('5 changedRefs(history.jsonl) tras una linea de una conversacion -> solo ese id', same(await history.changedRefs(agyPaths.historyPath()), [ID.last]));
  await appendFile(agyPaths.historyPath(), JSON.stringify({ display: '/clear', timestamp: 1779490000001, workspace: 'D:\\demo', conversationId: ID.add, type: 'slash_command' }) + '\n');
  check('5 changedRefs(history.jsonl) tras un comando de barra -> []', same(await history.changedRefs(agyPaths.historyPath()), []));
  await writeFile(agyPaths.lastConversationsPath(), JSON.stringify({ 'D:\\demo\\instalador': ID.last, 'D:\\demo\\compacto': ID.compact }));
  check('5 changedRefs(last_conversations.json) -> las dos que cambiaron', same((await history.changedRefs(agyPaths.lastConversationsPath())).sort(), [ID.add, ID.compact].sort()));
  check('5 (B4) changedRefs de config/projects/<id>.json -> las conversaciones de ese proyecto',
    same(await history.changedRefs(path.join(agyPaths.projectsRoot(), `${PROJ_B}.json`)), [ID.mayC]) &&
    same(await history.changedRefs(path.join(agyPaths.projectsRoot(), `${PROJ_C}.json`)), []));
  check('5 (B4) un nombre de proyecto que no es un id -> null', (await history.changedRefs(path.join(agyPaths.projectsRoot(), 'a b.json'))) === null);
  await writeFile(path.join(agyPaths.projectsRoot(), `${PROJ_B}.json`), JSON.stringify({ id: PROJ_B, projectResources: { resources: [{ folderUri: 'file:///d%3A/demo-b-nuevo' }] } }));
  check('5 (B4) y el scan siguiente trae la carpeta nueva', (await history.scan(byId.get(ID.mayC)))?.cwd === 'd:\\demo-b-nuevo');

  // item() de una ref que ya no es.
  check('5 item de un id sin carpeta en brain -> null', (await history.item(U(999))) === null && (await history.item('../x')) === null);

  // exists (M3).
  check('5 (M3) exists: transcript con contenido, .pb con contenido, pasos en el indice',
    (await history.exists('', ID.add)) && (await history.exists('', ID.may)) && (await history.exists('', ID.steps)));
  check('5 (M3) exists: la vacia de /clear (.db y carpeta), un id desconocido, uno invalido -> false',
    !(await history.exists('', ID.clear)) && !(await history.exists('', U(998))) && !(await history.exists('', '')) && !(await history.exists('', '../x')));

  // M9 (ii): un escritor abierto con filas solo en el -wal.
  const liveWriter = new sqliteModule.DatabaseSync(summariesFile);
  liveWriter.exec('PRAGMA wal_autocheckpoint = 0');
  await writeTranscript(ID.fresh, jsonl([step(0, 'USER_EXPLICIT', 'USER_INPUT', { content: userContent('conversacion nueva') })]));
  insertSummaries(liveWriter, [
    summaryRow(ID.fresh, { title: 'Conversacion Recien Creada', step_count: 2, workspace_uris: '["file:///C:/Users/u/demo-nueva"]' }),
    summaryRow(ID.noCwd, { title: 'Titulo Nuevo Del Indice', step_count: 11 }),
  ]);
  const walFile = `${summariesFile}-wal`;
  const walBefore = await statStampOf(walFile);
  const dbWhileOpen = await statStampOf(summariesFile);
  check('5 (M9 ii) las filas nuevas estan solo en el -wal', walBefore !== null && walBefore.size > 0);
  const changedLive = await history.changedRefs(summariesFile);
  check('5 (M9 ii) changedRefs de la base con el escritor abierto -> las dos filas', same([...changedLive].sort(), [ID.noCwd, ID.fresh].sort()), show(changedLive));
  check('5 (M9 ii) el catalogo ve lo que solo esta en el -wal',
    catalog.get(ID.fresh).summary?.title === 'Conversacion Recien Creada' && catalog.get(ID.noCwd).summary?.title === 'Titulo Nuevo Del Indice');
  check('5 (M9 ii) .db y -wal sin cambios de fecha ni tamano', same(await statStampOf(summariesFile), dbWhileOpen) && same(await statStampOf(walFile), walBefore));
  check('5 (M9 ii) la copia temporal tampoco quedo', ((await listing(catalogTempDir())) ?? []).length === 0);
  check('5 (M9 ii) el -wal tambien avisa', same(await history.changedRefs(walFile), []));
  liveWriter.close();
  check('5 una conversacion nueva del indice se lista', (await history.item(ID.fresh))?.group === `conv:${ID.fresh}`);

  // Una base rota: se conserva lo que se sabia y se avisa una sola vez.
  await writeFile(summariesFile, Buffer.alloc(8192, 0x41));
  await rm(walFile, { force: true });
  await rm(`${summariesFile}-shm`, { force: true });
  check('5 base ilegible: changedRefs no lanza y no cambia nada', same(await history.changedRefs(summariesFile), []));
  check('5 base ilegible: se conserva el titulo que se sabia', catalog.get(ID.add).summary?.title === 'Ordenar Notas Del Proyecto');
  await history.changedRefs(summariesFile);
  check('5 base ilegible: un solo aviso aunque se relea', warnings.length === 1 && warnings[0].startsWith('[antigravity] no pude leer el indice'), show(warnings));
  check('5 base ilegible: la copia temporal no quedo', ((await listing(catalogTempDir())) ?? []).length === 0);

  // Sin node:sqlite: el catalogo sigue con las otras fuentes.
  const noSqlite = new AntigravityCatalog({ platform: 'win32', sqlite: () => ({ unavailable: 'node-too-old' }) });
  await noSqlite.refresh();
  check('5 sin node:sqlite: sin filas del indice, con history y last_conversations',
    noSqlite.get(ID.add).summary === null && noSqlite.get(ID.may).history?.workspace === 'D:\\demo\\entorno' && noSqlite.get(ID.last).lastWorkspace === 'D:\\demo\\instalador');
  check('5 un proyecto generico no tiene carpeta; uno de verdad si',
    (await catalog.projectPath('default-cli-project')) === null && (await catalog.projectPath(PROJ_A)) === 'd:\\demo-a' && (await catalog.projectPath('../x')) === null);

  // M8: las copias viejas de un cierre abrupto se borran; lo demas no.
  await mkdir(path.join(catalogTempDir(), U(700)), { recursive: true });
  await writeFile(path.join(catalogTempDir(), U(700), 'conversation_summaries.db'), 'x');
  await mkdir(path.join(catalogTempDir(), 'ajeno'), { recursive: true });
  await removeStaleCatalogCopies();
  check('5 (M8) removeStaleCatalogCopies borra solo las copias', same(await listing(catalogTempDir()), ['ajeno']), show(await listing(catalogTempDir())));

  // Las raices: solo las carpetas permitidas.
  const roots = history.roots();
  const brainRootDef = roots.find((r) => r.path === agyPaths.brainRoot());
  const catalogRoot = roots.find((r) => typeof r.watch === 'function');
  const projectsRootDef = roots.find((r) => r.path === agyPaths.projectsRoot());
  check('5 roots: tres, y la unica sin watch que no es brain/ es config/projects/',
    roots.length === 3 && brainRootDef?.depth === 3 && projectsRootDef?.depth === 0 && catalogRoot !== undefined &&
    roots.filter((r) => r.watch === undefined).every((r) => r === brainRootDef || r === projectsRootDef), show(roots.map((r) => r.path)));
  check('5 roots: ninguna es ~/.gemini, ni la carpeta de la CLI para chokidar',
    !roots.some((r) => r.path === agyPaths.geminiHome()) && !roots.some((r) => r.watch === undefined && r.path === cliDir));
  const brainDir = agyPaths.brainRoot();
  const b = (...parts) => [brainDir, ...parts].join('/').replace(/\\/g, '/');
  const walk = [
    [brainDir, false, 'brain/'],
    [b(ID.add), false, 'brain/<uuid>'],
    // En Windows NTFS no distingue mayusculas; en los demas, otra ruta.
    [b(ID.add).toUpperCase(), process.platform !== 'win32', 'brain/<UUID> y la raiz en mayusculas'],
    [b('tempmediaStorage'), true, 'brain/<no-uuid>'],
    [b(ID.add, 'scratch'), true, 'scratch/'],
    [b(ID.add, '.user_uploaded'), true, '.user_uploaded/'],
    [b(ID.add, '.system_generated'), false, '.system_generated/'],
    [b(ID.add, '.system_generated', 'messages'), true, 'messages/'],
    [b(ID.add, '.system_generated', 'tasks'), true, 'tasks/'],
    [b(ID.add, '.system_generated', 'steps', '4'), true, 'steps/4'],
    [b(ID.add, '.system_generated', 'logs'), false, 'logs/'],
    [b(ID.add, '.system_generated', 'logs', 'transcript_full.jsonl'), false, 'transcript_full.jsonl'],
    [b(ID.add, '.system_generated', 'logs', 'transcript.jsonl'), false, 'transcript.jsonl'],
    [b(ID.add, '.system_generated', 'logs', 'chunks'), true, 'logs/chunks/'],
    [b(ID.add, '.system_generated', 'logs', 'chunks', 'transcript', '00000000.jsonl'), true, 'chunks/…/00000000.jsonl'],
    [b(ID.add, '.system_generated', 'logs', 'otro.log'), true, 'logs/otro.log'],
    [b(ID.add, '.system_generated', 'logs', 'transcript.jsonl', 'x'), true, 'algo debajo de un transcript'],
    [path.join(cliDir, 'mcp'), true, 'fuera de brain/'],
  ];
  for (const [target, ignored, what] of walk) {
    check(`5 (M2) ignore de brain: ${what} -> ${ignored ? 'no se recorre' : 'se recorre'}`, brainRootDef.ignore(target) === ignored);
  }
  check('5 (M2) accepts de brain: solo los dos transcripts',
    brainRootDef.accepts(transcriptOfAdd) && brainRootDef.accepts(agyPaths.transcriptPaths(ID.add).compact) &&
    !brainRootDef.accepts(path.join(path.dirname(transcriptOfAdd), 'chunks', 'transcript', '00000000.jsonl')) && !brainRootDef.accepts(b(ID.add)));
  check('5 transcriptConversationId con \\ y con /', transcriptConversationId(transcriptOfAdd) === ID.add && transcriptConversationId(transcriptOfAdd.replace(/\\/g, '/')) === ID.add);
  check('5 segmentsUnder: sin mayusculas solo en win32, y un prefijo que no es carpeta no cuenta',
    same(segmentsUnder('C:\\a\\B', 'c:/A/b/X/y', 'win32'), ['X', 'y']) && segmentsUnder('/a/B', '/a/b/x', 'linux') === null &&
    segmentsUnder('C:\\a\\b', 'C:\\a\\bc\\x', 'win32') === null && same(segmentsUnder('/a/b', '/a/b', 'linux'), []));
  check('5 config/projects: accepts solo *.json directos; ignore lo demas',
    projectsRootDef.accepts(path.join(agyPaths.projectsRoot(), `${PROJ_A}.json`)) && !projectsRootDef.accepts(path.join(agyPaths.projectsRoot(), 'sub', `${PROJ_A}.json`)) &&
    projectsRootDef.ignore(path.join(agyPaths.projectsRoot(), 'sub')) && !projectsRootDef.ignore(agyPaths.projectsRoot()) &&
    !projectsRootDef.ignore(path.join(agyPaths.projectsRoot(), `${PROJ_A}.json`)));
  check('5 la raiz del catalogo acepta sus cuatro archivos y nada mas',
    catalogFiles().every((file) => catalogRoot.accepts(file)) && !catalogRoot.accepts(path.join(cliDir, 'settings.json')) && !catalogRoot.accepts(path.join(cliDir, 'mcp', 'x.json')));
  const unsubscribe = catalogRoot.watch((file) => file);
  check('5 la raiz del catalogo se suscribe al aviso propio', typeof signalListener === 'function');
  unsubscribe();
  check('5 y se desuscribe', signalListener === null);
  check('5 followPollMs de 1 s y sin planes', history.followPollMs === ANTIGRAVITY_FOLLOW_POLL_MS && ANTIGRAVITY_FOLLOW_POLL_MS === 1000 && history.plans === null);
  const followed = history.follow({ cwd: '', sessionId: ID.add });
  check('5 follow devuelve el seguidor de la conversacion', followed instanceof AntigravitySessionFollower && followed.label === transcriptOfAdd);

  // M2 con chokidar de verdad: lo que recorre con el filtro.
  const chokidar = (await import('chokidar')).default;
  const seen = [];
  const watcher = chokidar.watch(brainDir, { depth: 3, ignoreInitial: false, ignored: brainRootDef.ignore });
  watcher.on('add', (p) => seen.push(p));
  watcher.on('addDir', (p) => seen.push(p));
  let isReady = false;
  watcher.on('ready', () => { isReady = true; });
  const ready = await waitFor(() => isReady, 10000);
  await watcher.close();
  const rel = seen.map((p) => path.relative(brainDir, p).replace(/\\/g, '/')).sort();
  check('5 (M2) chokidar con el filtro llega a los transcripts', ready && rel.includes(`${ID.add}/.system_generated/logs/transcript_full.jsonl`) && rel.includes(`${ID.compact}/.system_generated/logs/transcript.jsonl`), show(rel));
  check('5 (M2) y no entra en scratch, .user_uploaded, messages, chunks ni en lo que no es un uuid',
    !rel.some((p) => /scratch|\.user_uploaded|messages|chunks|tempmediaStorage|notas\.txt/.test(p)), show(rel.filter((p) => /scratch|user_uploaded|messages|chunks|temp|notas/.test(p))));

  // El watcher generico pasa `ignored` solo a la raiz que lo declara.
  const { watchSessions } = await import('../src/session-watcher.ts');
  const optionsSeen = [];
  const fakeWatcher = () => ({ on: () => undefined, close: async () => undefined });
  const plainRoot = { path: brainDir, depth: 0, accepts: () => true, awaitWriteFinish: false };
  const stopWatch = watchSessions(
    { refreshPath: async () => undefined },
    { onHistoryChanged: () => undefined },
    { all: () => [{ adapter: { id: 'antigravity', history: { roots: () => [brainRootDef, plainRoot] } }, location: null }] },
    { rootProbeMs: 40, watch: (target, options) => { optionsSeen.push(options); return fakeWatcher(); } },
  );
  check('5 (M2) watchSessions pasa ignore como ignored de chokidar', await waitFor(() => optionsSeen.length === 2) && optionsSeen.some((o) => o.ignored === brainRootDef.ignore));
  check('5 (M2) y a una raiz sin ignore no le agrega la clave (Claude Code y Codex igual que antes)', optionsSeen.some((o) => !('ignored' in o)), show(optionsSeen.map((o) => Object.keys(o))));
  stopWatch();
}

// El sondeo de los archivos del catalogo.
{
  const dir = path.join(root, 'signal');
  await mkdir(dir, { recursive: true });
  const a = path.join(dir, 'history.jsonl');
  const bFile = path.join(dir, 'conversation_summaries.db-wal');
  await writeFile(a, 'uno\n');
  const signal = new FileStampSignal(() => [a, bFile], { intervalMs: 30 });
  const heard = [];
  let ticks = 0;
  const original = signal.tick.bind(signal);
  signal.tick = async () => { ticks += 1; return original(); };
  const stop = signal.subscribe((file) => heard.push(file));
  check('5 sondeo: la primera vuelta no avisa', await waitFor(() => ticks >= 3) && heard.length === 0, show(heard));
  await appendFile(a, 'dos\n');
  check('5 sondeo: un archivo que crece avisa con su ruta', await waitFor(() => heard.includes(a)), show(heard));
  await writeFile(bFile, 'wal');
  check('5 sondeo: un archivo que aparece avisa', await waitFor(() => heard.includes(bFile)), show(heard));
  stop();
  const count = heard.length;
  const ticksAfter = ticks;
  await appendFile(a, 'tres\n');
  check('5 sondeo: sin suscriptores se detiene', !(await waitFor(() => ticks > ticksAfter + 1, 200)) && heard.length === count, `${ticks} vs ${ticksAfter}`);
}

// ---------------------------------------------------------------------------
// Pasos 5 y 6: status line (10-13) y adaptador (7-9, A1)
// ---------------------------------------------------------------------------

const { spawn } = await import('node:child_process');
const { utimes } = await import('node:fs/promises');
const settingsModule = await import('../src/agents/antigravity/settings.ts');
const { readAntigravitySettings, statusLineStateOf, SETTINGS_MAX_BYTES } = settingsModule;
const scriptModule = await import('../src/agents/antigravity/statusline-script.ts');
const { STATUS_LINE_SCRIPT, installStatusLineScript, statusLineCommand, statusLineFragment, statusLineScriptPath } = scriptModule;
const statusModule = await import('../src/agents/antigravity/status.ts');
const { AntigravityStatusStore, AntigravityStatusSource, activityOf, usageFromRecord, parseStatusRecord, createFollowerStatusLine, PERMISSION_PROMPT } = statusModule;
const discoveryModule = await import('../src/agents/antigravity/discovery.ts');
const { LogWatcher, LogLineReader, CONVERSATION_LINE, PID_LINE } = discoveryModule;
const adapterModule = await import('../src/agents/antigravity/index.ts');
const {
  createAntigravityAdapter,
  cliLogPathFor,
  removeStaleCliLogs,
  ANTIGRAVITY_BASE_CAPABILITIES,
  ANTIGRAVITY_STATUS_LINE_CAPABILITIES,
  ANTIGRAVITY_INPUT,
  READY_SIGNAL_SAFE,
  ADD_DIR,
} = adapterModule;
const appPaths = await import('../src/paths.ts');

/** Espera el `close` de un proceso, con plazo. */
function runProcess(file, args, input, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); resolve({ code: 'timeout', stdout, stderr }); }, 10000);
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: 'error', stdout, stderr: String(error) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

/** El JSON de ejemplo de la documentacion, con los campos medidos en la 1.2.2 y datos sensibles inventados. */
const officialStatusJson = (over = {}) => ({
  cwd: 'C:\\Users\\u\\carpeta-secreta',
  session_id: U(500),
  conversation_id: U(500),
  transcript_path: 'C:\\Users\\u\\.gemini\\antigravity\\brain\\x\\transcript.jsonl',
  model: { id: 'Gemini 3.7 Flash (Medium)', display_name: 'Gemini 3.7 Flash (Medium)', effort: 'medium' },
  workspace: { current_dir: 'C:\\Users\\u\\carpeta-secreta', project_dir: 'C:\\Users\\u\\carpeta-secreta' },
  version: '1.2.2',
  context_window: {
    total_input_tokens: 88244, total_output_tokens: 61074, context_window_size: 1048576, used_percentage: 14.24, remaining_percentage: 85.76,
    current_usage: { input_tokens: 63382, output_tokens: 346, cache_creation_input_tokens: 0, cache_read_input_tokens: 20857 },
  },
  exceeds_200k_tokens: false,
  product: 'antigravity',
  quota: { 'gemini-weekly': { remaining_fraction: 0.9378, reset_time: '2026-07-06T07:50:32Z', reset_in_seconds: 560580 } },
  agent_state: 'tool_use',
  cycle_mode: 'plan',
  tool_confirmation_pending: true,
  conversation_title: 'Titulo Inventado Muy Privado',
  sandbox: { enabled: false },
  plan_tier: 'PlanInventado',
  email: 'developer@email.com',
  cost: 1.23,
  terminal_width: 120,
  ...over,
});

/** Un registro como los del script, con `at` y campos a eleccion. */
const statusRecord = (id, over = {}) => ({
  v: 1,
  at: Date.now(),
  conversationId: id,
  agentState: 'idle',
  toolConfirmationPending: false,
  cycleMode: 'accept-edits',
  model: { id: 'Gemini 3.8 Flash (High)', displayName: 'Gemini 3.8 Flash (High)', effort: 'high' },
  contextWindow: { totalInputTokens: 19518, totalOutputTokens: 419, size: 1048576, usedPercentage: 1.86, currentUsage: { inputTokens: 14106, outputTokens: 31, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } },
  cliVersion: '1.2.2',
  keys: ['agent_state'],
  ...over,
});

// ---------------------------------------------------------------------------
// 10. readAntigravitySettings y el fragmento
// ---------------------------------------------------------------------------

{
  const dir = path.join(root, 'settings-10');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  const winScript = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\agent-workbench\\integrations\\antigravity-statusline.mjs';
  const ours = JSON.parse(statusLineFragment(winScript, 'win32')).statusLine;

  check('10 sin archivo -> missing, sin modelo', same(await readAntigravitySettings(file), { model: null, statusLine: { state: 'missing' } }));
  await writeFile(file, '{ roto');
  check('10 JSON roto -> unreadable', same(await readAntigravitySettings(file), { model: null, statusLine: { state: 'unreadable' } }));
  await writeFile(file, '[1, 2]');
  check('10 un array no es una configuracion -> unreadable', (await readAntigravitySettings(file)).statusLine.state === 'unreadable');
  await writeFile(file, JSON.stringify({ model: '  Gemini 3.7 Flash (Low) ', colorScheme: 'dark', trustedWorkspaces: ['C:\\x'], statusLine: ours }));
  const active = await readAntigravitySettings(file);
  check('10 con nuestro script -> active y el modelo recortado', same(active, { model: 'Gemini 3.7 Flash (Low)', statusLine: { state: 'active' } }), show(active));
  check('10 devuelve exactamente model y statusLine, y statusLine solo state',
    same(Object.keys(active).sort(), ['model', 'statusLine']) && same(Object.keys(active.statusLine), ['state']));
  await writeFile(file, '\uFEFF' + JSON.stringify({ statusLine: ours }));
  check('10 un BOM de editor no la vuelve ilegible', (await readAntigravitySettings(file)).statusLine.state === 'active');
  await writeFile(file, JSON.stringify({ statusLine: { ...ours, enabled: false } }));
  check('10 enabled false -> disabled', (await readAntigravitySettings(file)).statusLine.state === 'disabled');
  await writeFile(file, JSON.stringify({ statusLine: { ...ours, enabled: true } }));
  check('10 enabled true -> active', (await readAntigravitySettings(file)).statusLine.state === 'active');
  await writeFile(file, JSON.stringify({ statusLine: { type: 'command', command: '~/.gemini/antigravity-cli/statusline.sh' } }));
  check('10 otro comando -> other-command', (await readAntigravitySettings(file)).statusLine.state === 'other-command');
  await writeFile(file, JSON.stringify({ statusLine: { type: 'shell', command: ours.command } }));
  check('10 type shell -> missing', (await readAntigravitySettings(file)).statusLine.state === 'missing');
  await writeFile(file, JSON.stringify({ model: 3, statusLine: { type: 'command', command: ['x'] } }));
  check('10 comando que no es texto -> missing, y un modelo que no es texto -> null', same(await readAntigravitySettings(file), { model: null, statusLine: { state: 'missing' } }));
  await writeFile(file, JSON.stringify({ statusLine: { type: 'command', command: 'cd /d C:\\x && node ANTIGRAVITY-STATUSLINE.MJS' } }));
  check('10 el nombre del script se busca sin mayusculas', (await readAntigravitySettings(file)).statusLine.state === 'active');
  // Como la guarda la CLI: el && escapado.
  await writeFile(file, '{"statusLine":{"command":"cd /d C:\\\\a b \\u0026\\u0026 node antigravity-statusline.mjs","stack_with_default":true,"type":"command"}}');
  check('10 con el && como lo reescribe la CLI (\\u0026\\u0026) -> active', (await readAntigravitySettings(file)).statusLine.state === 'active');
  await writeFile(file, JSON.stringify({ model: 'x', pad: 'y'.repeat(SETTINGS_MAX_BYTES) }));
  check('10 un archivo de mas de 256 KB no se lee -> unreadable', same(await readAntigravitySettings(file), { model: null, statusLine: { state: 'unreadable' } }));
  check('10 statusLineStateOf de algo que no es objeto -> missing', statusLineStateOf(null) === 'missing' && statusLineStateOf('command') === 'missing');

  // P0-1: el fragmento por plataforma.
  const winCommand = statusLineCommand(winScript, 'win32');
  check('10 (P0-1) Windows: cd /d a la carpeta y node con el nombre, sin comillas aunque haya espacios',
    winCommand === 'cd /d C:\\Users\\Jane Doe\\AppData\\Roaming\\agent-workbench\\integrations && node antigravity-statusline.mjs' && !winCommand.includes('"'), String(winCommand));
  for (const bad of ['&', '%', '(', '!', '^', '|', '"']) {
    check(`10 (P0-1) Windows: una carpeta con ${bad} no tiene fragmento`,
      statusLineFragment(`C:\\Users\\a${bad}b\\agent-workbench\\integrations\\antigravity-statusline.mjs`, 'win32') === null);
  }
  const posix = '/home/u/.config/agent-workbench/integrations/antigravity-statusline.mjs';
  check('10 (P0-1) POSIX: node con la ruta entre comillas', statusLineCommand(posix, 'linux') === `node "${posix}"`);
  check('10 (P0-1) POSIX: una ruta con $ o comillas no tiene fragmento',
    statusLineCommand('/home/u$x/a.mjs', 'linux') === null && statusLineCommand('/home/"u/a.mjs', 'darwin') === null);
  const fragment = JSON.parse(statusLineFragment(winScript, 'win32'));
  check('10 el fragmento: solo statusLine, comando y stack_with_default',
    same(fragment, { statusLine: { type: 'command', command: winCommand, stack_with_default: true } }), show(fragment));
  check('10 el fragmento que se ofrece se detecta como active en las dos plataformas',
    statusLineStateOf(fragment.statusLine) === 'active' && statusLineStateOf(JSON.parse(statusLineFragment(posix, 'linux')).statusLine) === 'active');
}

// ---------------------------------------------------------------------------
// 11. El script
// ---------------------------------------------------------------------------

{
  const app = path.join(root, 'sl-app');
  const integrations = path.join(app, 'integrations');
  const records = path.join(app, 'agent-status', 'antigravity');
  const script = await installStatusLineScript(integrations);
  check('11 installStatusLineScript escribe el script en la carpeta y devuelve la ruta',
    script === statusLineScriptPath(integrations) && (await readFile(script, 'utf8')) === STATUS_LINE_SCRIPT);
  const past = new Date(Date.now() - 60_000);
  await utimes(script, past, past);
  const before = await statStampOf(script);
  await installStatusLineScript(integrations);
  check('11 si el contenido es el mismo no lo reescribe', same(await statStampOf(script), before));
  await writeFile(script, '// tocado a mano\n');
  await installStatusLineScript(integrations);
  check('11 si alguien lo cambio, lo reescribe', (await readFile(script, 'utf8')) === STATUS_LINE_SCRIPT);
  check('11 el script es LF, sin dependencias y dice su version',
    !STATUS_LINE_SCRIPT.includes('\r') && STATUS_LINE_SCRIPT.includes('// version: 1') && !/from '(?!node:)/.test(STATUS_LINE_SCRIPT));

  const input = officialStatusJson();
  const run = await runProcess(process.execPath, [script], JSON.stringify(input));
  const recordFile = path.join(records, `${U(500)}.json`);
  const text = await readFile(recordFile, 'utf8').catch(() => '');
  const written = text === '' ? null : JSON.parse(text);
  check('11 el JSON de la CLI: exit 0, sin stdout ni stderr', run.code === 0 && run.stdout === '' && run.stderr === '', show(run));
  check('11 escribe <id>.json con v 1, el permiso pendiente, el modo y la ventana',
    written?.v === 1 && written.conversationId === U(500) && written.toolConfirmationPending === true && written.cycleMode === 'plan' &&
    written.agentState === 'tool_use' && written.contextWindow?.size === 1048576 && written.model?.effort === 'medium', text);
  for (const secret of ['developer@email.com', 'gemini-weekly', '0.9378', 'PlanInventado', '1.23', 'carpeta-secreta', 'Titulo Inventado', '.gemini', 'antigravity\\\\brain']) {
    check(`11 el archivo no guarda ${secret}`, !text.includes(secret));
  }
  check('11 de las claves recibidas guarda solo los nombres',
    Array.isArray(written?.keys) && written.keys.includes('email') && written.keys.includes('cycle_mode') && same(Object.keys(written ?? {}).sort(),
      ['agentState', 'at', 'cliVersion', 'contextWindow', 'conversationId', 'cycleMode', 'keys', 'model', 'toolConfirmationPending', 'v'].sort()), show(written && Object.keys(written)));
  check('11 lo que escribe el script lo lee el servidor', parseStatusRecord(written, U(500))?.cycleMode === 'plan');

  const before11 = await listing(records);
  const traversal = await runProcess(process.execPath, [script], JSON.stringify(officialStatusJson({ conversation_id: '../../x', session_id: '../../x' })));
  check('11 conversation_id ../../x: exit 0 y ningun archivo', traversal.code === 0 && same(await listing(records), before11) && (await listing(app)).length === 2, show(await listing(app)));
  const empty = await runProcess(process.execPath, [script], JSON.stringify(officialStatusJson({ conversation_id: '', session_id: '' })));
  check('11 conversation_id vacio (antes del primer mensaje): exit 0 y ningun archivo', empty.code === 0 && same(await listing(records), before11));
  const junk = await runProcess(process.execPath, [script], 'no-json');
  check('11 stdin que no es JSON: exit 0, sin salida y ningun archivo', junk.code === 0 && junk.stdout === '' && junk.stderr === '' && same(await listing(records), before11));
  const upper = await runProcess(process.execPath, [script], JSON.stringify(officialStatusJson({ conversation_id: U(501).toUpperCase() })));
  check('11 un id en mayusculas se guarda en minusculas', upper.code === 0 && (await listing(records)).includes(`${U(501)}.json`), show(await listing(records)));
  check('11 no quedan temporales del rename', !(await listing(records)).some((name) => name.endsWith('.tmp')));

  // P0-1 de punta a punta: la CLI corre la linea con `cmd /c` y el escapado de su lenguaje.
  const spaced = path.join(root, 'con espacio', 'app');
  const spacedScript = await installStatusLineScript(path.join(spaced, 'integrations'));
  const spacedRecords = path.join(spaced, 'agent-status', 'antigravity');
  if (process.platform === 'win32') {
    const viaCmd = await runProcess('cmd.exe', ['/c', statusLineCommand(spacedScript, 'win32')], JSON.stringify(officialStatusJson({ conversation_id: U(502) })));
    check('11 (P0-1) el comando del fragmento, por cmd /c, desde una carpeta con espacios, escribe el registro',
      viaCmd.code === 0 && ((await listing(spacedRecords)) ?? []).includes(`${U(502)}.json`), show([viaCmd, await listing(spacedRecords)]));
    const quoted = await runProcess('cmd.exe', ['/c', `node "${spacedScript}"`], JSON.stringify(officialStatusJson({ conversation_id: U(503) })));
    check('11 (P0-1) y la forma con comillas de la especificacion no escribe nada (lo medido en la CLI)',
      !((await listing(spacedRecords)) ?? []).includes(`${U(503)}.json`), show(quoted));
  } else {
    const viaSh = await runProcess('/bin/sh', ['-c', statusLineCommand(spacedScript, process.platform)], JSON.stringify(officialStatusJson({ conversation_id: U(502) })));
    check('11 (P0-1) el comando del fragmento, por sh -c, desde una carpeta con espacios, escribe el registro',
      viaSh.code === 0 && ((await listing(spacedRecords)) ?? []).includes(`${U(502)}.json`), show(viaSh));
  }
}

// ---------------------------------------------------------------------------
// 12. El almacen de registros y la fuente de estado
// ---------------------------------------------------------------------------

{
  const dir = path.join(root, 'status-12');
  await mkdir(dir, { recursive: true });
  const store = new AntigravityStatusStore({ dir: () => dir });
  const id = U(600);
  const file = path.join(dir, `${id}.json`);
  const write = (over) => writeFile(file, JSON.stringify(statusRecord(id, over)));
  let active = false;
  const source = new AntigravityStatusSource(store, () => active, { intervalMs: 25 });
  const heard = [];
  const stop = source.subscribe(id, (status) => heard.push(status));
  check('12 sin status line: unknown en el acto', same(heard, [{ activity: 'unknown', waitingFor: null }]), show(heard));
  check('12 sin status line: waitUntilReady da false enseguida', (await source.waitUntilReady(id, 5000)) === false);

  active = true;
  const launchedAt = Date.now();
  store.attach(id, launchedAt);
  await source.tick();
  check('12 con status line y sin archivo: sigue unknown, sin repetir', heard.length === 1);

  await write({ agentState: 'idle', at: launchedAt + 5 });
  check('12 un registro idle de la pty viva -> idle', await waitFor(() => heard.at(-1)?.activity === 'idle'), show(heard));
  await write({ agentState: 'tool_use', at: launchedAt + 10 });
  check('12 tool_use -> busy', await waitFor(() => heard.at(-1)?.activity === 'busy'), show(heard));
  await write({ agentState: 'tool_use', toolConfirmationPending: true, at: launchedAt + 20 });
  check('12 tool_confirmation_pending -> waiting con permission prompt',
    await waitFor(() => heard.at(-1)?.activity === 'waiting' && heard.at(-1)?.waitingFor === PERMISSION_PROMPT), show(heard));
  await write({ agentState: 'algo-nuevo', at: launchedAt + 30 });
  check('12 un agent_state desconocido -> busy', await waitFor(() => heard.at(-1)?.activity === 'busy' && heard.at(-1)?.waitingFor === null), show(heard));
  await writeFile(file, '{"v":1,"at":');
  await source.tick();
  check('12 un archivo que no parsea no pisa el anterior', store.get(id)?.agentState === 'algo-nuevo' && heard.at(-1)?.activity === 'busy');
  await write({ agentState: 'idle', at: launchedAt - 1 });
  check('12 un registro anterior al lanzamiento no cuenta -> unknown', await waitFor(() => heard.at(-1)?.activity === 'unknown'), show(heard));
  await write({ agentState: 'idle', at: launchedAt + 40 });
  await waitFor(() => heard.at(-1)?.activity === 'idle');
  store.detach(id);
  check('12 sin pty viva (una pestana dormida) -> unknown aunque diga idle', await waitFor(() => heard.at(-1)?.activity === 'unknown'), show(heard));
  store.attach(id, launchedAt);
  await waitFor(() => heard.at(-1)?.activity === 'idle');
  check('12 nunca avisa null', heard.every((status) => status !== null));
  await writeFile(file, JSON.stringify({ ...statusRecord(U(601)), at: launchedAt + 50 }));
  await source.tick();
  check('12 un registro con el id de otra conversacion no se toma', store.get(id)?.conversationId === id && heard.at(-1)?.activity === 'idle');
  await writeFile(file, JSON.stringify({ ...statusRecord(id), v: 2, agentState: 'working', at: launchedAt + 60 }));
  await source.tick();
  check('12 un registro de otra version del script no se toma', store.get(id)?.agentState === 'idle');

  await write({ agentState: 'working', at: launchedAt + 70 });
  await waitFor(() => heard.at(-1)?.activity === 'busy');
  const ready = source.waitUntilReady(id, 5000);
  await write({ agentState: 'idle', at: launchedAt + 80 });
  check('12 waitUntilReady resuelve true cuando llega un idle sin permiso pendiente', (await ready) === true);
  await write({ agentState: 'idle', toolConfirmationPending: true, at: launchedAt + 90 });
  const started = Date.now();
  check('12 waitUntilReady con permiso pendiente vence a los 300 ms con false', (await source.waitUntilReady(id, 300)) === false && Date.now() - started >= 290);
  await write({ agentState: 'idle', at: launchedAt + 100 });
  check('12 (M5) un idle que ya estaba escrito antes de llamar alcanza', (await source.waitUntilReady(id, 2000)) === true);

  // R27-2: refresh relee y avisa en el acto, sin esperar el sondeo (aca, de un minuto).
  const slow = new AntigravityStatusSource(store, () => true, { intervalMs: 60_000 });
  const slowHeard = [];
  const stopSlow = slow.subscribe(id, (status) => slowHeard.push(status));
  await slow.tick();
  await write({ agentState: 'tool_use', toolConfirmationPending: true, at: launchedAt + 110 });
  const beforeRefresh = slowHeard.at(-1)?.activity;
  await slow.refresh(id);
  check('12 (R27-2) refresh relee el registro y avisa el permiso abierto sin esperar el sondeo',
    beforeRefresh === 'idle' && slowHeard.at(-1)?.activity === 'waiting' && slowHeard.at(-1)?.waitingFor === PERMISSION_PROMPT, show(slowHeard));
  stopSlow();
  slow.dispose();

  stop();
  store.forget(id);
  check('12 forget borra el archivo y lo que habia en memoria', (await statStampOf(file)) === null && store.get(id) === null);
  store.forget('../x');
  check('12 forget con un id que no es uuid no hace nada', store.fileOf('../x') === null);

  // Limpieza al arrancar: solo lo del script, y solo lo viejo.
  const oldRecord = path.join(dir, `${U(610)}.json`);
  const newRecord = path.join(dir, `${U(611)}.json`);
  const oldTemp = path.join(dir, `${U(612)}.json.4242.tmp`);
  const foreign = path.join(dir, 'notas.json');
  for (const target of [oldRecord, newRecord, oldTemp, foreign]) await writeFile(target, '{}');
  const eightDays = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  const twoHours = new Date(Date.now() - 2 * 3600 * 1000);
  await utimes(oldRecord, eightDays, eightDays);
  await utimes(oldTemp, twoHours, twoHours);
  await utimes(foreign, eightDays, eightDays);
  await store.removeStale();
  check('12 removeStale borra registros de mas de 7 dias y temporales viejos, y nada mas',
    same(await listing(dir), [`${U(611)}.json`, 'notas.json'].sort()), show(await listing(dir)));
  source.dispose();
}

// ---------------------------------------------------------------------------
// 13. ContextUsage y modo desde la status line
// ---------------------------------------------------------------------------

{
  const base = { ...shared.EMPTY_CONTEXT_USAGE, lastModel: 'Gemini 3.8 Flash (High)', assistantMessages: 3 };
  const official = parseStatusRecord({
    v: 1, at: 1, conversationId: U(700), agentState: 'idle', toolConfirmationPending: false, cycleMode: null,
    model: { id: 'Gemini 3.5 Flash (High)', displayName: 'Gemini 3.5 Flash (High)', effort: 'high' },
    contextWindow: { totalInputTokens: 88244, totalOutputTokens: 61074, size: 1048576, usedPercentage: 14.24,
      currentUsage: { inputTokens: 63382, outputTokens: 346, cacheCreationInputTokens: 0, cacheReadInputTokens: 20857 } },
  }, U(700));
  const usage = usageFromRecord(official, base);
  check('13 (P0-3) la barra es total_input_tokens, con la ventana exacta',
    usage.lastRequestTokens === 88244 && usage.contextWindow === 1048576 && usage.contextWindowEstimated === false, show(usage));
  check('13 salida de la ultima peticion, sin acumulados, y las respuestas del transcript',
    usage.lastOutputTokens === 346 && usage.totalInputTokens === 0 && usage.totalOutputTokens === 0 && usage.totalCacheReadTokens === 0 && usage.assistantMessages === 3);
  check('13 el modelo es la etiqueta completa de la status line', usage.lastModel === 'Gemini 3.5 Flash (High)');
  check('13 (R27-5) el esfuerzo sale en el acto de la status line: model.effort', usage.lastEffort === 'high', show(usage));
  const labelOnly = { ...official, model: { id: null, displayName: 'Gemini 3.7 Flash (Medium)', effort: 'turbo' } };
  check('13 (R27-5) un effort que no es un nivel del combo cae al parentesis de la etiqueta', usageFromRecord(labelOnly, base).lastEffort === 'medium');
  const noLevels = { ...official, model: { id: null, displayName: 'Otro Modelo (Thinking)', effort: null } };
  check('13 (R27-5) un modelo sin niveles no inventa esfuerzo: el campo no viaja', !('lastEffort' in usageFromRecord(noLevels, base)));
  const wire = shared.parseContextUsage(JSON.parse(JSON.stringify(usage)));
  check('13 (R27-5) el esfuerzo llega al cliente, y sin el campo no aparece',
    wire?.lastEffort === 'high' && !('lastEffort' in (shared.parseContextUsage(JSON.parse(JSON.stringify(shared.EMPTY_CONTEXT_USAGE))) ?? {})), show(wire));
  const noTotal = { ...official, contextWindow: { ...official.contextWindow, totalInputTokens: null } };
  check('13 sin total: round(1048576 x 14.24 / 100) = 149317', usageFromRecord(noTotal, base).lastRequestTokens === 149317, String(usageFromRecord(noTotal, base).lastRequestTokens));
  const noPercent = { ...noTotal, contextWindow: { ...noTotal.contextWindow, usedPercentage: null } };
  check('13 sin total ni porcentaje: 63382 + 20857 + 0', usageFromRecord(noPercent, base).lastRequestTokens === 84239);
  const nothing = { ...official, model: { id: null, displayName: null, effort: null }, contextWindow: { totalInputTokens: null, totalOutputTokens: null, size: 0, usedPercentage: null, currentUsage: null } };
  const bare = usageFromRecord(nothing, base);
  check('13 sin nada: 0 tokens, ventana 0 es sin ventana, y el modelo del transcript',
    bare.lastRequestTokens === 0 && bare.contextWindow === null && bare.lastModel === 'Gemini 3.8 Flash (High)' && bare.lastOutputTokens === 0, show(bare));
  check('13 activityOf sin registro -> unknown', same(activityOf(null), { activity: 'unknown', waitingFor: null }));
  check('13 parseStatusRecord rechaza otro id, otra version y at que no es numero',
    parseStatusRecord({ ...statusRecord(U(701)) }, U(702)) === null && parseStatusRecord({ ...statusRecord(U(701)), v: 9 }, U(701)) === null &&
    parseStatusRecord({ ...statusRecord(U(701)), at: 'x' }, U(701)) === null && parseStatusRecord('x', U(701)) === null);

  // El seguidor con el almacen de verdad.
  const dir = path.join(root, 'status-13');
  await mkdir(dir, { recursive: true });
  const store = new AntigravityStatusStore({ dir: () => dir });
  let active = true;
  const line = createFollowerStatusLine(store, () => active);
  const id = U(703);
  const launchedAt = Date.now();
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(statusRecord(id, { at: launchedAt + 1 })));
  await line.refresh(id);
  check('13 el modo sin pty viva no se observa (una pestana dormida arranca en accept-edits igual)', line.permissionMode(id) === null);
  check('13 los tokens si: describen la conversacion', line.usage(id, base)?.lastRequestTokens === 19518);
  check('13 (R27-1) sin pty viva no esta publicando para ella: live false', line.live(id) === false);
  store.attach(id, launchedAt);
  check('13 (R27-1) con la pty viva y un registro suyo: live true; sin registro, false',
    line.live(id) === true && (store.attach(U(705), launchedAt), line.live(U(705)) === false));
  const modes = [['accept-edits', 'idle', 'acceptEdits'], ['plan', 'idle', 'plan'], [null, 'idle', 'default'], [null, 'authenticating', null], ['planning', 'idle', null]];
  for (const [cycleMode, agentState, expected] of modes) {
    await writeFile(path.join(dir, `${id}.json`), JSON.stringify(statusRecord(id, { at: Date.now(), cycleMode, agentState })));
    await line.refresh(id);
    check(`13 (P0-2) cycle_mode ${cycleMode} con ${agentState} -> ${expected}`, line.permissionMode(id) === expected, String(line.permissionMode(id)));
  }
  check('13 usage de una conversacion sin registro -> null', line.usage(U(704), base) === null);
  check('13 active es el de la configuracion', line.active() === true && ((active = false), line.active() === false));
}

// ---------------------------------------------------------------------------
// 7. Descubrimiento por el log
// ---------------------------------------------------------------------------

{
  const dir = path.join(root, 'logs-7');
  await mkdir(dir, { recursive: true });
  const own = path.join(dir, 'propio.log');
  const A = U(800);
  const B = U(801);
  const heard = [];
  let now = 1_000_000;
  const warnings = [];
  const watcher = new LogWatcher({ logPath: own, pid: 4242, launchedAt: now, initialId: null, onConversation: (id) => heard.push(id), now: () => now, warn: (m) => warnings.push(m), label: 'tab12345' });
  await watcher.poll();
  check('7 sin el log todavia: nada, y sigue esperando el propio', heard.length === 0 && watcher.source === 'own');
  await writeFile(own, `I0914 00:56:30.613588      51 server.go:1560] Starting language server process with pid 4242\n`);
  await appendFile(own, `I0914 00:56:31.000000       1 server.go:1177] Created conversation group ${A} ("grupo")\n`);
  await appendFile(own, `I0914 00:56:33.274207     674 server.go:1177] Created conver`);
  await watcher.poll();
  check('7 Created conversation group no es una conversacion, y una linea a medias no se lee', heard.length === 0);
  await appendFile(own, `sation ${A.toUpperCase()}\r\nI0914 00:56:33.275871     674 conversation_manager.go:821] Streaming conversation ${A}\n`);
  await watcher.poll();
  check('7 la linea cortada entre dos lecturas se reconoce entera (en minusculas y con CRLF), y Streaming del mismo id no repite',
    same(heard, [A]) && watcher.currentId === A, show(heard));
  await appendFile(own, `I0912 16:10:52.472836 30936 server.go:747] Created conversation ${B}\nI0912 16:10:52.473380 30936 conversation_manager.go:378] Streaming conversation ${B}\n`);
  await watcher.poll();
  check('7 el formato anterior a la 1.2.2 (pid en cada linea) y un segundo Created con otro id (/clear) -> segundo aviso', same(heard, [A, B]), show(heard));
  await appendFile(own, `I0914 01:00:00.000000       9 x.go:1] The user said: Created conversation ${A} no es un log\n`);
  await watcher.poll();
  check('7 el id tiene que estar al final despues de "] ": un prompt que lo nombra en el medio no cuenta', same(heard, [A, B]));
  await appendFile(own, `I0914 01:00:01.000000       9 conversation_manager.go:821] Streaming conversation ${A}\n`);
  await watcher.poll();
  check('7 /resume a otra conversacion (Streaming de un id distinto) avisa', same(heard, [A, B, A]));
  now += 60 * 60 * 1000;
  await watcher.poll();
  check('7 con el log propio no pasa nunca al respaldo', watcher.source === 'own' && warnings.length === 0);
  watcher.dispose();
  await appendFile(own, `I0914 01:00:02.000000       9 server.go:1177] Created conversation ${U(802)}\n`);
  await watcher.poll();
  check('7 despues de dispose no avisa, y el log NO se borra (M8)', heard.length === 3 && (await statStampOf(own)) !== null);

  check('7 las expresiones: las dos lineas de las dos versiones',
    CONVERSATION_LINE.test(`I0914 00:56:33.274207     674 server.go:1177] Created conversation ${A}`) &&
    !CONVERSATION_LINE.test(`I0912 21:15:35.518207       1 server.go:1177] Created conversation group ${A} ("x")`) &&
    PID_LINE.exec('I0912 16:10:45.694274 30936 server.go:1301] Starting language server process with pid 30936')?.[1] === '30936');

  const resumed = [];
  const initial = new LogWatcher({ logPath: own, pid: 1, launchedAt: Date.now(), initialId: A.toUpperCase(), onConversation: (id) => resumed.push(id) });
  await writeFile(own, `x] Streaming conversation ${A}\n`);
  await initial.poll();
  check('7 initialId (reanudar) no avisa, ni con Streaming del mismo id', resumed.length === 0 && initial.currentId === A);
  initial.dispose();

  // El respaldo por pid.
  const logRoot = path.join(dir, 'cli-log');
  await mkdir(logRoot, { recursive: true });
  const launched = Date.now();
  const other = path.join(logRoot, 'cli-20260914_005630.log');
  const mine = path.join(logRoot, 'cli-20260914_005631.log');
  const stale = path.join(logRoot, 'cli-20260101_000000.log');
  await writeFile(other, `I0914 00:56:30.1 51 server.go:1560] Starting language server process with pid 999\nI0914 x] Created conversation ${U(810)}\n`);
  await writeFile(mine, `I0914 00:56:30.2 51 server.go:1560] Starting language server process with pid 4242\n`);
  await writeFile(stale, `I0101 00:00:00.0 51 server.go:1560] Starting language server process with pid 4242\n`);
  const old = new Date(launched - 3600 * 1000);
  await utimes(stale, old, old);
  const fallbackHeard = [];
  let fbNow = launched;
  const fallback = new LogWatcher({ logPath: null, pid: 4242, launchedAt: launched, initialId: null, onConversation: (id) => fallbackHeard.push(id), logRoot: () => logRoot, now: () => fbNow });
  await fallback.poll();
  check('7 respaldo: de dos cli-*.log elige el del pid (y no uno viejo con el mismo pid)', fallback.source === 'fallback' && fallbackHeard.length === 0, fallback.source);
  await appendFile(mine, `I0914 00:56:33.3 674 server.go:1177] Created conversation ${U(811)}\n`);
  await fallback.poll();
  check('7 respaldo: sigue ese archivo', same(fallbackHeard, [U(811)]), show(fallbackHeard));
  fallback.dispose();
  check('7 respaldo: el log de la CLI no se borra', (await statStampOf(mine)) !== null);

  const graceHeard = [];
  let graceNow = 0;
  const graceWarnings = [];
  const grace = new LogWatcher({ logPath: path.join(dir, 'nunca.log'), pid: 4242, launchedAt: 0, initialId: null, onConversation: (id) => graceHeard.push(id), logRoot: () => logRoot, now: () => graceNow, warn: (m) => graceWarnings.push(m), label: 'tabgrace' });
  graceNow = 19_000;
  await grace.poll();
  check('7 el log propio ausente a los 19 s: todavia lo espera', grace.source === 'own');
  graceNow = 20_000;
  await grace.poll();
  check('7 a los 20 s pasa al respaldo por pid', grace.source === 'fallback', grace.source);
  grace.dispose();
  const lost = new LogWatcher({ logPath: null, pid: 1, launchedAt: 0, initialId: null, onConversation: () => undefined, logRoot: () => logRoot, now: () => 61_000, warn: (m) => graceWarnings.push(m), label: 'tabperdida' });
  await lost.poll();
  check('7 sin candidato a los 60 s: avisa una vez y deja de buscar', lost.source === 'stopped' && graceWarnings.some((m) => m.includes('no pude descubrir la conversacion de tabperdida')), show(graceWarnings));
  lost.dispose();

  // Topes.
  const capped = path.join(dir, 'tope.log');
  await writeFile(capped, 'x'.repeat(100) + '\n');
  const capWarnings = [];
  const cap = new LogWatcher({ logPath: capped, pid: 1, launchedAt: Date.now(), initialId: null, onConversation: () => undefined, readLimits: { perReadBytes: 64, totalBytes: 90 }, warn: (m) => capWarnings.push(m), label: 'tabtope' });
  await cap.poll();
  await cap.poll();
  check('7 pasado el tope total deja de seguirlo y lo dice', cap.source === 'stopped' && capWarnings.some((m) => m.includes('256 MB')), show([cap.source, capWarnings]));
  cap.dispose();
  const longLine = path.join(dir, 'larga.log');
  await writeFile(longLine, 'y'.repeat(70 * 1024));
  const longReader = new LogLineReader(longLine);
  await longReader.read();
  await appendFile(longLine, `z] Created conversation ${U(820)}\nw] Created conversation ${U(821)}\n`);
  const afterLong = await longReader.read();
  check('7 una linea de mas de 64 KB se descarta entera, sin comerse la siguiente', afterLong.length === 1 && afterLong[0].endsWith(U(821)), show(afterLong?.map((l) => l.slice(-40))));
  const utf = path.join(dir, 'utf.log');
  const bytes = Buffer.from('ñandú\n', 'utf8');
  await writeFile(utf, bytes.subarray(0, 1));
  const utfReader = new LogLineReader(utf);
  const partial = await utfReader.read();
  await appendFile(utf, bytes.subarray(1));
  const whole = await utfReader.read();
  check('7 un caracter cortado entre dos lecturas no se rompe', same(partial, []) && same(whole, ['ñandú']), show(whole));

  // Con temporizador de verdad: start y nudge.
  const timed = path.join(dir, 'timed.log');
  const timedHeard = [];
  const live = new LogWatcher({ logPath: timed, pid: 1, launchedAt: Date.now(), initialId: null, onConversation: (id) => timedHeard.push(id), intervalMs: 5000 });
  live.start();
  await writeFile(timed, `x] Created conversation ${U(830)}\n`);
  live.nudge();
  check('7 nudge mira antes del intervalo', await waitFor(() => timedHeard.length === 1, 3000), show(timedHeard));
  live.dispose();
}

// ---------------------------------------------------------------------------
// 8 y 9. El adaptador: lanzamiento, gancho, capacidades y registro
// ---------------------------------------------------------------------------

{
  const { AgentRegistry } = await import('../src/agents/registry.ts');
  const { LaunchHookSlot } = await import('../src/launch-hook-slot.ts');
  const adapter = createAntigravityAdapter({ platform: 'win32', statusIntervalMs: 25 });
  const token = '12345678-1234-4234-8234-123456789abc';
  const location = { resolvedPath: 'C:\\agy\\agy.exe', file: 'C:\\agy\\agy.exe', prefixArgs: [], version: '1.2.2' };
  const logDir = appPaths.cliLogsTempDir();

  check('8 id, etiqueta, comando y guia de instalacion',
    adapter.id === 'antigravity' && adapter.label === 'Antigravity CLI' && adapter.command === 'agy' &&
    adapter.installUrl === 'https://antigravity.google/docs/cli/getting-started');
  check('8 AGENT_IDS lo nombra, al final, y la memoria lo conoce',
    shared.AGENT_IDS.at(-1) === 'antigravity' && shared.MEMORY_AGENT_IDS.includes('antigravity'));
  check('8 el texto de ausencia nombra agy y la guia', adapter.missingMessage().includes('"agy"') && adapter.missingMessage().includes(adapter.installUrl));
  check('8 el log de las pestanas va a la temporal, bajo cli-logs y nunca bajo log (P0-10)',
    logDir === path.join(os.tmpdir(), 'agent-workbench', 'cli-logs') && path.basename(logDir) !== 'log');

  const fresh = adapter.launch({ location, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: 'x', launchToken: token });
  check('8 nueva: --log-file con el token y --mode accept-edits, sesion por descubrir',
    fresh.file === location.file && same(fresh.args, ['--log-file', path.join(logDir, `${token}.log`), '--mode', 'accept-edits']) && same(fresh.session, { kind: 'discover' }), show(fresh));
  check('8 nueva: la carpeta del log queda creada', (await statStampOf(logDir)) !== null && ADD_DIR === false);
  const resume = adapter.launch({ location, cwd: 'C:\\p', resumeSessionId: U(900), proposedSessionId: 'x', launchToken: token });
  check('8 reanudar: + --conversation <id> y la sesion es conocida',
    same(resume.args, ['--log-file', path.join(logDir, `${token}.log`), '--mode', 'accept-edits', '--conversation', U(900)]) && same(resume.session, { kind: 'known', sessionId: U(900) }), show(resume));
  const noToken = adapter.launch({ location, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: 'x', launchToken: '../x' });
  check('8 un launchToken invalido: sin --log-file', same(noToken.args, ['--mode', 'accept-edits']), show(noToken.args));
  let threw = false;
  try { adapter.launch({ location, cwd: 'C:\\p', resumeSessionId: 'x & calc', proposedSessionId: 'x', launchToken: token }); } catch { threw = true; }
  check('8 un id de reanudacion que no es uuid no llega a la linea de comando', threw);
  const shim = { resolvedPath: 'C:\\agy\\agy.cmd', file: 'cmd.exe', prefixArgs: ['/c', 'C:\\agy\\agy.cmd'], version: null };
  const shimSafe = adapter.launch({ location: shim, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: 'x', launchToken: token });
  const savedTemp = [process.env['TEMP'], process.env['TMP'], process.env['TMPDIR']];
  process.env['TEMP'] = process.env['TMP'] = process.env['TMPDIR'] = path.join(root, 'tmp con espacio');
  const shimWarnings = [];
  const warnBeforeShim = console.warn;
  console.warn = (...args) => shimWarnings.push(args.join(' '));
  let shimSpaced;
  try {
    shimSpaced = adapter.launch({ location: shim, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: 'x', launchToken: token });
  } finally {
    console.warn = warnBeforeShim;
  }
  [process.env['TEMP'], process.env['TMP']] = savedTemp;
  if (savedTemp[2] === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = savedTemp[2];
  const safeLog = !/[^A-Za-z0-9_.:\\/-]/.test(path.join(logDir, `${token}.log`));
  check('8 con un shim .cmd, el log va solo si su ruta pasa entera por cmd /c',
    same(shimSafe.args.slice(0, 2), ['/c', 'C:\\agy\\agy.cmd']) && shimSafe.args.includes('--log-file') === safeLog &&
    !shimSpaced.args.includes('--log-file') && shimSpaced.args.includes('accept-edits'), show([shimSafe.args, shimSpaced.args]));
  check('8 (R27-7) sin log por el shim se avisa: el respaldo por pid no casa con el pid del cmd',
    shimWarnings.length === 1 && shimWarnings[0].includes('shim') && shimWarnings[0].includes('/clear'), show(shimWarnings));
  check('8 cliLogPathFor: uuid -> ruta en minusculas; otra cosa -> null',
    cliLogPathFor(token.toUpperCase()) === path.join(logDir, `${token}.log`) && cliLogPathFor('') === null && cliLogPathFor('../../x') === null);

  const base = { PATH: 'p', ANTIGRAVITY_AGENT: '1', VACIA: undefined };
  const env = adapter.environment(base);
  check('8 environment: mismas claves y valores que la base, sin undefined, sin aviso',
    same(env, { env: { PATH: 'p', ANTIGRAVITY_AGENT: '1' }, notice: null }), show(env));
  check('8 protectedDirs = [<home>/.gemini]', same(adapter.protectedDirs(), [path.join(home, '.gemini')]), show(adapter.protectedDirs()));

  // 9. Capacidades: el literal, sin y con status line.
  const expectedBase = {
    sessionIdAtLaunch: false,
    resume: true,
    statusSource: false,
    readySignal: false,
    permissionCycle: { modes: ['default', 'acceptEdits', 'plan'], launchMode: 'acceptEdits', keyLabel: 'shift+tab', approvesPendingOnCycle: true },
    models: ANTIGRAVITY_MODEL_OPTIONS,
    efforts: ANTIGRAVITY_EFFORT_OPTIONS,
    questionCards: false,
    imagesByPath: null,
    fileMentions: null,
    rewind: false,
    contextWindowSource: null,
    plans: false,
  };
  check('9 sin status line: capacidades iguales al literal', same(adapter.capabilities, expectedBase) && adapter.capabilities === ANTIGRAVITY_BASE_CAPABILITIES, show(adapter.capabilities));
  check('9 con status line: estado y medidor, y lista para recibir sigue apagada (P0-4)',
    same(ANTIGRAVITY_STATUS_LINE_CAPABILITIES, { ...expectedBase, statusSource: true, readySignal: false, contextWindowSource: 'status-line' }) && READY_SIGNAL_SAFE === false);
  check('9 las dos sobreviven al viaje por la red',
    same(shared.parseAgentCapabilities(JSON.parse(JSON.stringify(ANTIGRAVITY_BASE_CAPABILITIES))), expectedBase) &&
    same(shared.parseAgentCapabilities(JSON.parse(JSON.stringify(ANTIGRAVITY_STATUS_LINE_CAPABILITIES))), ANTIGRAVITY_STATUS_LINE_CAPABILITIES));
  check('9 el modo de arranque de la linea de comando es el punto de partida del ciclo',
    fresh.args[fresh.args.indexOf('--mode') + 1] === 'accept-edits' && adapter.capabilities.permissionCycle.launchMode === 'acceptEdits');
  check('9 envio (P0-16): sin imagenes, marcadores, Enter aparte a 400 ms, un Esc',
    same(adapter.input, { imageReference: null, pieceGapMs: 400, pasteMarkers: true, enterSeparately: true, interruptPresses: 1 }) && adapter.input === ANTIGRAVITY_INPUT &&
    adapter.input.imageReference === adapter.capabilities.imagesByPath);

  // defaults (M11): la etiqueta entera y el esfuerzo.
  const settingsFile = agyPaths.settingsPath();
  await rm(settingsFile, { force: true });
  check('8 defaults sin settings.json: todo null', same(await adapter.defaults('C:\\p'), { model: null, effort: null, contextWindow: null }));
  await writeFile(settingsFile, JSON.stringify({ model: 'Gemini 3.7 Flash (Low)' }));
  const defaults = await adapter.defaults('C:\\p');
  check('8 defaults: la etiqueta entera como modelo, el esfuerzo aparte, sin ventana',
    same(defaults, { model: 'Gemini 3.7 Flash (Low)', effort: 'low', contextWindow: null }) &&
    shared.modelOptionFor(defaults.model, adapter.capabilities.models)?.value === 'gemini-3.7-flash-low', show(defaults));
  await writeFile(settingsFile, JSON.stringify({ model: 'Claude Sonnet 4.6 (Thinking)' }));
  check('8 defaults: un modelo sin esfuerzo en la etiqueta -> effort null', (await adapter.defaults('C:\\p')).effort === null);

  // A1: prepareAll con la CLI ausente no crea nada; con la CLI, instala y limpia.
  const configDir = appPaths.appConfigDir();
  await rm(configDir, { recursive: true, force: true });
  await rm(logDir, { recursive: true, force: true });
  const missingRegistry = new AgentRegistry([createAntigravityAdapter()]);
  await missingRegistry.prepareAll();
  check('A1 prepareAll con el adaptador ausente no crea nada en APPDATA ni en la temporal',
    (await statStampOf(configDir)) === null && (await statStampOf(logDir)) === null);
  const stopMissing = missingRegistry.subscribeChanges(() => undefined);
  check('A1 ni se suscribe a cambios de configuracion', typeof stopMissing === 'function' && (await missingRegistry.refreshSetups()) === false);
  // Sin la CLI no hay script instalado ni configuracion vigilada: el hello no ofrece una status
  // line (medido en la pasada B del cierre: viajaba `missing` con la ruta de un script inexistente).
  check('A1 con la CLI ausente, el hello no trae status line',
    missingRegistry.list().find((info) => info.id === 'antigravity')?.statusLine === null, show(missingRegistry.list()[0]?.statusLine));
  stopMissing();
  missingRegistry.disposeAll();

  const statusDir = appPaths.agentStatusDir('antigravity');
  await mkdir(statusDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  await mkdir(path.join(appPaths.catalogTempDir(), U(950)), { recursive: true });
  const oldLog = path.join(logDir, `${U(951)}.log`);
  const newLog = path.join(logDir, `${U(952)}.log`);
  const foreignLog = path.join(logDir, 'ajeno.log');
  const oldStatus = path.join(statusDir, `${U(953)}.json`);
  for (const target of [oldLog, newLog, foreignLog, oldStatus]) await writeFile(target, 'x');
  const days = (n) => new Date(Date.now() - n * 24 * 3600 * 1000);
  await utimes(oldLog, days(2), days(2));
  await utimes(foreignLog, days(2), days(2));
  await utimes(oldStatus, days(8), days(8));
  await writeFile(settingsFile, JSON.stringify({ statusLine: { type: 'command', command: 'otra-cosa.sh' } }));
  const failing = { ...createCodexLikeAdapter(), prepare: async () => { throw new Error('rota'); } };
  // Un sondeo rapido que cuenta sus `stat` terminados: la espera es por condicion, no un sleep.
  let settingsStats = 0;
  const { fileStamp } = await import('../src/agents/antigravity/catalog-signal.ts');
  const settingsSignal = new FileStampSignal(() => [agyPaths.settingsPath()], {
    intervalMs: 30,
    stat: async (file) => { const stamp = await fileStamp(file); settingsStats += 1; return stamp; },
  });
  const prepared = createAntigravityAdapter({ platform: 'win32', settingsSignal });
  const registry = new AgentRegistry([failing, prepared]);
  registry.get('antigravity').location = location;
  registry.get(failing.id).location = location;
  const prepareWarnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => prepareWarnings.push(args.join(' '));
  try {
    await registry.prepareAll();
  } finally {
    console.warn = originalWarn;
  }
  const scriptFile = path.join(appPaths.integrationsDir(), 'antigravity-statusline.mjs');
  check('A1 con la CLI: prepareAll instala el script en la carpeta de la app', (await readFile(scriptFile, 'utf8').catch(() => '')) === STATUS_LINE_SCRIPT);
  check('A1 con la CLI, el hello si trae la status line, con la ruta del script instalado',
    registry.list().find((info) => info.id === 'antigravity')?.statusLine?.scriptPath === scriptFile, show(registry.list().find((info) => info.id === 'antigravity')?.statusLine?.scriptPath));
  check('A1 un adaptador cuya preparacion falla no frena a los demas y se avisa', prepareWarnings.some((m) => m.includes('rota')), show(prepareWarnings));
  check('(M8) prepare borra los logs de pestanas de mas de 24 h, y solo esos',
    same(await listing(logDir), ['ajeno.log', `${U(952)}.log`].sort()), show(await listing(logDir)));
  check('(M8) prepare borra los registros de estado de mas de 7 dias y las copias del catalogo',
    !(await listing(statusDir)).includes(`${U(953)}.json`) && !((await listing(appPaths.catalogTempDir())) ?? []).includes(U(950)));
  check('prepare lee la configuracion: otra status line -> other-command', prepared.statusLine().state === 'other-command');

  const info = prepared.statusLine();
  check('9 statusLine(): rutas para mostrar y el fragmento del script instalado',
    info.settingsPath === settingsFile && info.scriptPath === scriptFile && info.fragment === statusLineFragment(scriptFile, 'win32'), show(info));
  const listed = registry.list().find((entry) => entry.id === 'antigravity');
  check('9 registry.list() lleva la status line y el cliente la lee', same(shared.parseAgentInfo(JSON.parse(JSON.stringify(listed)))?.statusLine, info));

  // D10: capacidades dinamicas y aviso de cambios.
  let changes = 0;
  const stopChanges = registry.subscribeChanges(() => { changes += 1; });
  // Que la primera vuelta del sondeo (la que fija la firma sin avisar) ya haya pasado.
  await waitFor(() => settingsStats >= 1);
  await writeFile(settingsFile, JSON.stringify({ model: 'Gemini 3.8 Flash (High)', statusLine: JSON.parse(info.fragment).statusLine }));
  check('D10 editar settings.json con el fragmento avisa solo, sin tocar nada', await waitFor(() => changes === 1, 5000), String(changes));
  check('D10 y las capacidades pasan a las de la status line', prepared.capabilities === ANTIGRAVITY_STATUS_LINE_CAPABILITIES && prepared.statusLine().state === 'active');
  check('D10 refreshSetups sin cambios -> false', (await registry.refreshSetups()) === false);
  await writeFile(scriptFile, '// tocado\n');
  await registry.refreshSetups();
  check('D10 refreshSetup reinstala el script si alguien lo toco', (await readFile(scriptFile, 'utf8')) === STATUS_LINE_SCRIPT);
  await writeFile(settingsFile, JSON.stringify({ statusLine: { ...JSON.parse(info.fragment).statusLine, enabled: false } }));
  check('D10 desactivarla tambien avisa y apaga las capacidades',
    await waitFor(() => changes === 2, 5000) && prepared.capabilities === ANTIGRAVITY_BASE_CAPABILITIES && prepared.statusLine().state === 'disabled', String(changes));
  registry.disposeAll();
  await writeFile(settingsFile, JSON.stringify({ statusLine: JSON.parse(info.fragment).statusLine }));
  check('D10 disposeAll suelta la suscripcion', !(await waitFor(() => changes > 2, 300)));
  stopChanges();

  // El gancho: descubre por el log, cambia con /clear, no se suelta al escribir, y al cerrar olvida.
  const hookStore = new AntigravityStatusStore();
  const hookAdapter = createAntigravityAdapter({ platform: 'win32', statusIntervalMs: 25, store: hookStore });
  const hookToken = 'abcdef12-1234-4234-8234-123456789abc';
  hookAdapter.launch({ location, cwd: 'C:\\p', resumeSessionId: null, proposedSessionId: 'x', launchToken: hookToken });
  const hookLog = cliLogPathFor(hookToken);
  const reported = [];
  const launchedAt = Date.now();
  const context = (over = {}) => ({
    terminalId: 'term-0001-antigravity', sessionId: '', cwd: 'C:\\p', resumed: false, pid: 4242, launchedAt, launchToken: hookToken,
    readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: (id) => reported.push(id), ...over,
  });
  const slot = new LaunchHookSlot();
  const hook = hookAdapter.onSpawned(context());
  slot.set(hook);
  check('8 el gancho declara onInput, onSubmitted y onExit (no se suelta con la primera tecla)',
    typeof hook.cancel === 'function' && typeof hook.onInput === 'function' && typeof hook.onSubmitted === 'function' && typeof hook.onExit === 'function');
  slot.input('hola');
  check('8 escribir en la pty no lo suelta', slot.active === true);
  const first = U(960);
  const second = U(961);
  await writeFile(hookLog, `I0914 x 51 server.go:1560] Starting language server process with pid 4242\n`);
  slot.submitted('hola');
  await appendFile(hookLog, `I0914 x 674 server.go:1177] Created conversation ${first}\n`);
  check('8 la conversacion del log propio llega por reportSessionId', await waitFor(() => same(reported, [first]), 5000), show(reported));
  await writeFile(path.join(statusDir, `${first}.json`), JSON.stringify(statusRecord(first, { at: Date.now() })));
  await hookStore.refresh(first);
  check('8 y queda atada a la pty: su registro cuenta como de este proceso', hookStore.current(first)?.conversationId === first);
  await appendFile(hookLog, `I0914 x 674 server.go:1177] Created conversation ${second}\n`);
  check('8 /clear: la conversacion nueva llega y el registro de la vieja se borra',
    await waitFor(() => same(reported, [first, second]), 5000) && (await statStampOf(path.join(statusDir, `${first}.json`))) === null, show(reported));
  await writeFile(path.join(statusDir, `${second}.json`), JSON.stringify(statusRecord(second, { at: Date.now(), agentState: 'idle' })));
  await hookStore.refresh(second);
  slot.cancel();
  await appendFile(hookLog, `I0914 x 674 server.go:1177] Created conversation ${U(962)}\n`);
  check('8 al cerrar: no avisa mas y deja el log (M8)',
    !(await waitFor(() => reported.length > 2, 1500)) && (await statStampOf(hookLog)) !== null);
  await hookStore.refresh(second);
  check('8 (R27-4) al cerrar o apagar: el registro queda (los tokens de la pestana dormida), pero ya no es de ninguna pty',
    (await statStampOf(path.join(statusDir, `${second}.json`))) !== null && hookStore.get(second)?.conversationId === second && hookStore.current(second) === null);

  // Reanudar: el registro viejo se borra al lanzar y el Streaming del mismo id no avisa.
  const resumedId = U(963);
  await writeFile(path.join(statusDir, `${resumedId}.json`), JSON.stringify(statusRecord(resumedId, { at: 1 })));
  const resumeToken = 'abcdef12-1234-4234-8234-123456789abd';
  const resumeLog = cliLogPathFor(resumeToken);
  await writeFile(resumeLog, `I0914 x 1 conversation_manager.go:821] Streaming conversation ${resumedId}\n`);
  const resumeReported = [];
  const resumeHook = hookAdapter.onSpawned(context({ sessionId: resumedId, resumed: true, launchToken: resumeToken, reportSessionId: (id) => resumeReported.push(id) }));
  check('8 reanudar: el registro de la corrida anterior se borra en el acto', (await statStampOf(path.join(statusDir, `${resumedId}.json`))) === null);
  await appendFile(resumeLog, `I0914 x 1 server.go:1177] Created conversation ${U(964)}\n`);
  check('8 reanudar: el Streaming del mismo id no avisa, un /clear si', await waitFor(() => same(resumeReported, [U(964)]), 5000), show(resumeReported));
  resumeHook.cancel();

  // onExit: una ultima mirada al log antes de soltar.
  const exitToken = 'abcdef12-1234-4234-8234-123456789abe';
  const exitReported = [];
  const exitHook = hookAdapter.onSpawned(context({ launchToken: exitToken, reportSessionId: (id) => exitReported.push(id) }));
  const exitSlot = new LaunchHookSlot();
  exitSlot.set(exitHook);
  await writeFile(cliLogPathFor(exitToken), `I0914 x 674 server.go:1177] Created conversation ${U(965)}\n`);
  exitSlot.exit();
  check('8 al salir el proceso mira el log una vez mas y avisa lo que encontro', await waitFor(() => same(exitReported, [U(965)]), 3000), show(exitReported));
  check('8 y queda soltado', exitSlot.active === false);
  // R27-4: una pestana cuya CLI salio conserva el registro de su conversacion, y deja de atarlo a la pty.
  const exitedId = U(967);
  const exitedFile = path.join(statusDir, `${exitedId}.json`);
  const exitedHook = hookAdapter.onSpawned(context({ sessionId: exitedId, resumed: true, launchToken: 'abcdef12-1234-4234-8234-123456789abf', reportSessionId: () => undefined }));
  await writeFile(exitedFile, JSON.stringify(statusRecord(exitedId, { at: Date.now() })));
  await hookStore.refresh(exitedId);
  const liveBeforeExit = hookStore.current(exitedId) !== null;
  exitedHook.onExit();
  const releasedAfterExit = await waitFor(() => hookStore.current(exitedId) === null, 3000);
  check('8 (R27-4) al salir la CLI el registro queda y ya no cuenta como de esta pty',
    liveBeforeExit && releasedAfterExit && (await statStampOf(exitedFile)) !== null && hookStore.get(exitedId) !== null);

  // El estado con el adaptador: sin status line, unknown; la pestana descubriendo no pregunta nada.
  const heardStatus = [];
  const stopStatus = hookAdapter.status.subscribe(U(966), (status) => heardStatus.push(status));
  check('12 adaptador sin status line: unknown en el acto', same(heardStatus, [{ activity: 'unknown', waitingFor: null }]));
  check('12 adaptador sin status line: waitUntilReady false', (await hookAdapter.status.waitUntilReady(U(966), 1000)) === false);
  stopStatus();
  hookAdapter.dispose();
  adapter.dispose();

  // removeStaleCliLogs directo: nunca lanza con la carpeta ausente.
  await removeStaleCliLogs(path.join(root, 'no-existe'));
  check('(M8) removeStaleCliLogs sin carpeta no lanza', true);
}

/** Un adaptador minimo que no es de ninguna CLI real, para probar el registro. */
function createCodexLikeAdapter() {
  return {
    id: 'codex', label: 'Otra', command: 'otra', installUrl: 'u', capabilities: ANTIGRAVITY_BASE_CAPABILITIES, input: ANTIGRAVITY_INPUT,
    locate: async () => null, missingMessage: () => '', launch: () => ({ file: 'x', args: [], session: { kind: 'discover' } }),
    environment: (base) => ({ env: { ...base }, notice: null }), onSpawned: () => null,
    history: { roots: () => [] }, status: null, defaults: async () => null, protectedDirs: () => [], dispose: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Paso 7: servidor generico (9 con ciclo, D16, arranque)
// ---------------------------------------------------------------------------

const ptyInput = await import('../src/pty-input.ts');
const { buildModeKeys, planModeChange, MODE_PENDING_CONFIRMATION_MESSAGE } = ptyInput;
const SHIFT_TAB = '\x1b[Z';
const agyCycle = ANTIGRAVITY_BASE_CAPABILITIES.permissionCycle;
const claudeCycle = { modes: shared.PERMISSION_MODE_CYCLE, launchMode: 'auto', keyLabel: 'shift+tab', approvesPendingOnCycle: false };

{
  check('9 buildModeKeys acceptEdits -> default en el ciclo de Antigravity: dos shift+tab',
    same(buildModeKeys('acceptEdits', 'default', agyCycle.modes), [SHIFT_TAB, SHIFT_TAB]));
  check('9 buildModeKeys acceptEdits -> plan: uno', same(buildModeKeys('acceptEdits', 'plan', agyCycle.modes), [SHIFT_TAB]));
  check('9 buildModeKeys hacia auto, que no esta en ese ciclo: null', buildModeKeys('plan', 'auto', agyCycle.modes) === null);
  check('9 buildModeKeys sin ciclo cuenta como antes (Claude Code): auto -> plan tres',
    same(buildModeKeys('auto', 'plan'), [SHIFT_TAB, SHIFT_TAB, SHIFT_TAB]) && same(buildModeKeys('plan', 'auto'), [SHIFT_TAB]));
  check('9 la misma cuenta que el ciclo de tres de Claude Code no sirve para Antigravity',
    !same(buildModeKeys('acceptEdits', 'default', agyCycle.modes), buildModeKeys('acceptEdits', 'default')), show(buildModeKeys('acceptEdits', 'default')));

  const plan = (cycle, current, target, waitingFor) => planModeChange({ cycle, current, target, waitingFor });
  check('D16 Antigravity sin nada pendiente: las pulsaciones de su ciclo',
    same(plan(agyCycle, 'acceptEdits', 'default', null), { kind: 'keys', keys: [SHIFT_TAB, SHIFT_TAB] }));
  check('D16 Antigravity con un permiso pendiente: rechazado sin teclas',
    same(plan(agyCycle, 'acceptEdits', 'plan', 'permission prompt'), { kind: 'refused', reason: 'pending-confirmation', message: MODE_PENDING_CONFIRMATION_MESSAGE }));
  check('D16 cualquier espera cuenta, no solo el permiso', plan(agyCycle, 'plan', 'default', 'dialog open').kind === 'refused');
  check('D16 pedir el modo en el que ya esta no escribe ni se rechaza', same(plan(agyCycle, 'plan', 'plan', 'permission prompt'), { kind: 'none' }));
  const unreachable = plan(agyCycle, 'acceptEdits', 'auto', null);
  check('D16 un destino fuera del ciclo: rechazado con la tecla de la CLI',
    unreachable.kind === 'refused' && unreachable.reason === 'unreachable' && unreachable.message.includes('shift+tab'), show(unreachable));
  check('D16 Claude Code con un permiso pendiente cambia igual que siempre (su tecla no aprueba)',
    same(plan(claudeCycle, 'auto', 'plan', 'permission prompt'), { kind: 'keys', keys: [SHIFT_TAB, SHIFT_TAB, SHIFT_TAB] }));
  const claudeUnreachable = plan(claudeCycle, 'auto', 'bypassPermissions', null);
  check('D16 Claude Code: el mensaje de destino imposible es el de antes',
    claudeUnreachable.kind === 'refused' &&
    claudeUnreachable.message === 'No se puede llegar a ese modo desde el actual. Cambialo con shift+tab en la solapa CLI.', show(claudeUnreachable));

  // El rechazo de un envio del cuadro, antes de encolar.
  const { submitRefusal } = ptyInput;
  const refuse = (over) => submitRefusal({ label: 'Antigravity CLI', approvesPendingOnCycle: true, waitingFor: null, blind: false, openToolCall: false, ...over });
  check('R27-1 envio: status line activa sin registro (ciega) y una llamada abierta -> rechazado',
    refuse({ blind: true, openToolCall: true }) === 'Antigravity CLI tiene una herramienta sin resultado: puede estar pidiendo una aprobacion. Contestala en la solapa CLI.');
  check('R27-2 envio: la CLI dice que espera un permiso -> rechazado aunque vea su estado',
    refuse({ waitingFor: 'permission prompt' })?.includes('esperando que autorices una herramienta') === true &&
    refuse({ waitingFor: 'dialog open' })?.includes('esperando una respuesta') === true);
  check('R27-2 envio: sin espera ni llamada abierta a ciegas -> pasa',
    refuse({}) === null && refuse({ openToolCall: true }) === null && refuse({ blind: true }) === null);
  const claudeRefuse = (over) => submitRefusal({ label: 'Claude Code', approvesPendingOnCycle: false, waitingFor: null, blind: false, openToolCall: false, ...over });
  check('R27-2 envio: Claude Code esperando un permiso pasa igual que siempre (su hueco es anterior y aceptado)',
    claudeRefuse({ waitingFor: 'permission prompt' }) === null);
  const codexRefuse = (over) => submitRefusal({ label: 'Codex', approvesPendingOnCycle: false, waitingFor: null, blind: true, openToolCall: false, ...over });
  check('A1 envio: una CLI sin fuente con la llamada abierta, el mismo texto del hito 25',
    codexRefuse({ openToolCall: true }) === 'Codex tiene una herramienta sin resultado: puede estar pidiendo una aprobacion. Contestala en la solapa CLI.' &&
    codexRefuse({}) === null);
}

// El hub dice que espera la CLI: es lo que el socket le pasa a `planModeChange`.
{
  const { EventEmitter } = await import('node:events');
  const { ConversationHub } = await import('../src/conversation-hub.ts');
  const sessionId = U(970);
  const statusListeners = new Map();
  // Lo que la CLI "publica" cuando se la relee en el acto (StatusSource.refresh).
  let published = null;
  const fakeStatus = {
    subscribe: (id, listener) => {
      statusListeners.set(id, listener);
      listener({ activity: 'unknown', waitingFor: null });
      return () => statusListeners.delete(id);
    },
    waitUntilReady: async () => false,
    refresh: async (id) => {
      if (published !== null) statusListeners.get(id)?.(published);
    },
    dispose: () => undefined,
  };
  let followerOpen = false;
  const follower = {
    label: 'transcript', start: async () => undefined,
    poll: async () => ({ reset: false, added: [], turns: [], plans: [], parts: [] }),
    getState: () => 'live', getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }), getPermissionMode: () => null,
    getTail: () => ({ events: [], hasMore: false }), getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [], readImage: async () => null, noticeChange: () => false, hasOpenToolCall: () => followerOpen,
  };
  const fakeAdapter = {
    id: 'antigravity', capabilities: ANTIGRAVITY_STATUS_LINE_CAPABILITIES, status: fakeStatus,
    history: { follow: () => follower, plans: null, followPollMs: null },
  };
  const descriptor = { terminalId: 't-ag', kind: 'agent', agent: 'antigravity', cwd: path.join(root, 'proyecto'), sessionId, label: '', resumed: false, createdAt: 0, alive: true, exitCode: null, sleeping: false };
  const registry = new EventEmitter();
  registry.get = (terminalId) => (terminalId === 't-ag' ? descriptor : null);
  registry.launchedAtOf = () => 1;
  const hub = new ConversationHub(registry, { get: (id) => (id === 'antigravity' ? { adapter: fakeAdapter, location: null } : null) });
  const waitingEvents = [];
  hub.on('waiting', (terminalId, waitingFor) => waitingEvents.push([terminalId, waitingFor]));

  check('7 getWaitingFor de una pestana que nadie sigue: null', hub.getWaitingFor('t-ag') === null);
  await hub.subscribe('t-ag');
  check('7 getWaitingFor sin nada pendiente: null', hub.getWaitingFor('t-ag') === null);
  statusListeners.get(sessionId)?.({ activity: 'waiting', waitingFor: PERMISSION_PROMPT });
  check('7 getWaitingFor con el permiso pendiente: la etiqueta, la misma que ve la barra',
    hub.getWaitingFor('t-ag') === 'permission prompt' && same(waitingEvents, [['t-ag', 'permission prompt']]), show(waitingEvents));
  const current = hub.getPermissionMode('t-ag') ?? agyCycle.launchMode;
  check('7 el cambio de modo que arma el socket con eso: rechazado',
    planModeChange({ cycle: fakeAdapter.capabilities.permissionCycle, current, target: 'plan', waitingFor: hub.getWaitingFor('t-ag') }).kind === 'refused');
  statusListeners.get(sessionId)?.({ activity: 'busy', waitingFor: null });
  check('7 contestado el permiso: null otra vez y el cambio pasa',
    hub.getWaitingFor('t-ag') === null &&
    planModeChange({ cycle: agyCycle, current, target: 'plan', waitingFor: hub.getWaitingFor('t-ag') }).kind === 'keys');
  check('7 getWaitingFor de una pestana que no existe: null', hub.getWaitingFor('nadie') === null);

  // R27-2: la guarda de cada pieza relee lo que publica la CLI, no la ultima vuelta del sondeo.
  published = { activity: 'waiting', waitingFor: PERMISSION_PROMPT };
  check('R27-2 checkWaitingFor relee en el acto: el menu que se abrio entre dos sondeos se ve',
    hub.getWaitingFor('t-ag') === null && (await hub.checkWaitingFor('t-ag')) === 'permission prompt');
  published = { activity: 'busy', waitingFor: null };
  check('R27-2 checkWaitingFor contestado: null; de una pestana que nadie sigue: null',
    (await hub.checkWaitingFor('t-ag')) === null && (await hub.checkWaitingFor('nadie')) === null);

  // R27-1: status line activa, la pestana sin registro (unknown) y una llamada abierta.
  const toolCalls = [];
  hub.on('toolCall', (terminalId, open) => toolCalls.push([terminalId, open]));
  followerOpen = true;
  statusListeners.get(sessionId)?.({ activity: 'unknown', waitingFor: null });
  check('R27-1 hub: status line activa sin registro de la pty -> ciega, y la llamada abierta se avisa',
    hub.isBlindToApprovals('t-ag', fakeAdapter) === true && hub.isToolCallOpen('t-ag') === true && same(toolCalls, [['t-ag', true]]), show(toolCalls));
  statusListeners.get(sessionId)?.({ activity: 'busy', waitingFor: null });
  check('R27-1 hub: en cuanto la status line publica, deja de ser ciega y la llamada ya no bloquea',
    hub.isBlindToApprovals('t-ag', fakeAdapter) === false && hub.isToolCallOpen('t-ag') === false && same(toolCalls, [['t-ag', true], ['t-ag', false]]), show(toolCalls));
  check('R27-1 hub: sin suscripcion cuenta solo la capacidad',
    hub.isBlindToApprovals('nadie', fakeAdapter) === false && hub.isBlindToApprovals('nadie', { capabilities: ANTIGRAVITY_BASE_CAPABILITIES }) === true);
  followerOpen = false;
  hub.disposeAll();
}

// El modo que se eligio antes de que la pestana se case con su conversacion no se pierde al
// cambiar de sesion en la misma pty (descubrimiento, /clear). Medido en la verificacion de
// cierre: el combo volvia a "Aceptar ediciones" con la CLI en manual.
{
  const { EventEmitter } = await import('node:events');
  const { ConversationHub } = await import('../src/conversation-hub.ts');
  const follower = {
    label: 'transcript', start: async () => undefined,
    poll: async () => ({ reset: false, added: [], turns: [], plans: [], parts: [] }),
    getState: () => 'waiting', getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }), getPermissionMode: () => null,
    getTail: () => ({ events: [], hasMore: false }), getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [], readImage: async () => null, noticeChange: () => false, hasOpenToolCall: () => false,
  };
  const fakeAdapter = {
    id: 'antigravity', capabilities: ANTIGRAVITY_BASE_CAPABILITIES, status: null,
    history: { follow: () => follower, plans: null, followPollMs: null },
  };
  const descriptor = { terminalId: 't-modo', kind: 'agent', agent: 'antigravity', cwd: path.join(root, 'proyecto'), sessionId: '', label: '', resumed: false, createdAt: 0, alive: true, exitCode: null, sleeping: false };
  let launched = 100;
  const registry = new EventEmitter();
  registry.get = (terminalId) => (terminalId === 't-modo' ? descriptor : null);
  registry.launchedAtOf = () => launched;
  const hub = new ConversationHub(registry, { get: (id) => (id === 'antigravity' ? { adapter: fakeAdapter, location: null } : null) });
  let resets = 0;
  hub.on('reset', () => { resets += 1; });
  await hub.subscribe('t-modo');
  check('modo: la pestana que descubre arranca en el modo de lanzamiento', hub.getPermissionMode('t-modo') === 'acceptEdits');
  hub.setPermissionMode('t-modo', 'default');
  descriptor.sessionId = U(971);
  registry.emit('session', 't-modo');
  await waitFor(() => resets === 1);
  check('modo: descubrir la conversacion en la misma pty conserva el modo elegido antes',
    hub.getPermissionMode('t-modo') === 'default', String(hub.getPermissionMode('t-modo')));
  // Lo que viaja en el `conversation.reset` de ese cambio es lo que dibuja el combo.
  check('modo: el reset del cambio de sesion lleva ese modo, no null',
    hub.getSnapshot('t-modo')?.permissionMode === 'default', String(hub.getSnapshot('t-modo')?.permissionMode));
  descriptor.sessionId = U(972);
  registry.emit('session', 't-modo');
  await waitFor(() => resets === 2);
  check('modo: /clear en la misma pty tambien lo conserva',
    hub.getPermissionMode('t-modo') === 'default' && hub.getSnapshot('t-modo')?.permissionMode === 'default', String(hub.getPermissionMode('t-modo')));
  launched = 200;
  descriptor.sessionId = U(973);
  registry.emit('session', 't-modo');
  await waitFor(() => resets === 3);
  check('modo: una pty relanzada con otra sesion vuelve al modo de lanzamiento',
    hub.getPermissionMode('t-modo') === 'acceptEdits' && hub.getSnapshot('t-modo')?.permissionMode === 'acceptEdits', String(hub.getPermissionMode('t-modo')));
  hub.disposeAll();
}

// La linea del arranque: solo debajo de una CLI instalada con status line.
{
  const { startupAgentLines, STATUS_LINE_LABEL, statusLineStartupText } = await import('../src/startup-summary.ts');
  const claude = { id: 'claude-code', label: 'Claude Code', version: '2.1.263', resolvedPath: 'C:\\bin\\claude.exe', missingMessage: null };
  const agy = { id: 'antigravity', label: 'Antigravity CLI', version: '1.2.2', resolvedPath: 'C:\\bin\\agy.exe', missingMessage: null, statusLine: 'missing' };
  const statusLines = (lines) => lines.filter((line) => line.includes(STATUS_LINE_LABEL));

  check('7 arranque con Claude Code sola: las mismas lineas con y sin el campo',
    same(startupAgentLines([claude]), startupAgentLines([{ ...claude, statusLine: null }])) && statusLines(startupAgentLines([claude])).length === 0);
  const both = startupAgentLines([claude, agy]);
  check('7 arranque con Antigravity instalada: una linea con su estado, debajo de ella',
    same(statusLines(both), [`  ${STATUS_LINE_LABEL}  ${statusLineStartupText('missing')}`]) &&
    both.indexOf(statusLines(both)[0]) > both.findIndex((line) => line.includes('CLI (Antigravity CLI)')), show(both));
  check('7 arranque con Antigravity sin instalar: sin linea de status line',
    statusLines(startupAgentLines([claude, { ...agy, resolvedPath: null, version: null }])).length === 0);
  const texts = shared.STATUS_LINE_STATES.map((state) => statusLineStartupText(state));
  check('7 cada estado se imprime distinto', new Set(texts).size === texts.length && texts.every((text) => text.length > 0), show(texts));
}

// ---------------------------------------------------------------------------
// Paso 8: web (B6, dialogo, modo, punto, modelos)
// ---------------------------------------------------------------------------

{
  const ui = await import('../../web/src/agent-ui.ts');
  const { ANTIGRAVITY_MODEL_OPTIONS } = await import('../src/agents/antigravity/constants.ts');
  const { MODEL_OPTIONS } = shared;

  check('8 modelOptionIn casa la etiqueta completa con la lista de Antigravity',
    ui.modelOptionIn(ANTIGRAVITY_MODEL_OPTIONS, 'Gemini 3.7 Flash (Medium)')?.value === 'gemini-3.7-flash-medium',
    show(ui.modelOptionIn(ANTIGRAVITY_MODEL_OPTIONS, 'Gemini 3.7 Flash (Medium)')));
  check('8 modelOptionIn con la lista de Claude Code sigue igual',
    ui.modelOptionIn(MODEL_OPTIONS, 'claude-opus-5[1m]')?.value === 'opus[1m]' &&
    ui.modelOptionIn(MODEL_OPTIONS, 'Gemini 3.7 Flash (Medium)') === null);

  const window = 1048576;
  check('B6 antes de medir, la status line ya dice la ventana', ui.meterIdleWindow('status-line', { contextWindow: window }, null) === window);
  check('B6 las otras fuentes no cambian', ui.meterIdleWindow('usage-with-variants', { contextWindow: window }, null) === null &&
    ui.meterIdleWindow('usage-with-catalog', { contextWindow: window }, null) === null && ui.meterIdleWindow('token-count', { contextWindow: window }, null) === window &&
    ui.meterIdleWindow('status-line', { contextWindow: window }, 5) === 5);

  const usage = (assistantMessages, lastRequestTokens) => ({ assistantMessages, lastRequestTokens });
  check('8 status line: con respuestas pero sin tokens publicados, sin medir (nunca un 0)', ui.meterMeasured('status-line', usage(4, 0)) === false);
  check('8 status line: con tokens publicados mide aunque no haya respuesta', ui.meterMeasured('status-line', usage(0, 18897)) === true);
  check('8 las demas fuentes miden desde la primera respuesta, como siempre',
    ui.meterMeasured('usage-with-variants', usage(0, 500)) === false && ui.meterMeasured('usage-with-variants', usage(1, 0)) === true &&
    ui.meterMeasured('token-count', usage(0, 500)) === false && ui.meterMeasured(null, usage(2, 0)) === true);

  check('8 Configurar: CLI sin fuente con status line sin activar', ui.meterOffersSetup(null, { state: 'missing' }) && ui.meterOffersSetup(null, { state: 'other-command' }));
  check('8 Configurar: no con la status line activa, ni con una CLI sin status line',
    !ui.meterOffersSetup('status-line', { state: 'active' }) && !ui.meterOffersSetup(null, { state: 'active' }) && !ui.meterOffersSetup(null, null) &&
    !ui.meterOffersSetup('usage-with-variants', null));
  const setupTitles = shared.STATUS_LINE_STATES.filter((state) => state !== 'active').map((state) => ui.meterSetupTitle(state));
  check('8 el titulo de Configurar dice por que falta en cada estado', new Set(setupTitles).size === setupTitles.length && setupTitles.every((title) => title.includes('status line')), show(setupTitles));

  check('8 titulo del medidor vacio con status line: habla de la status line, no de la primera respuesta',
    ui.meterIdleDetail('AGENTS.md', 'status-line').includes('status line') && !ui.meterIdleDetail('AGENTS.md', 'status-line').includes('AGENTS.md'));
  check('8 titulo del medidor vacio de las demas: el de siempre', ui.meterIdleDetail('CLAUDE.md', 'usage-with-variants') === ui.meterIdleDetail('CLAUDE.md'));

  check('8 punto unknown sin status line opcional: el titulo de siempre', ui.restingDotTitle('unknown') === 'Esta CLI no publica su estado' && ui.restingDotTitle('unknown', null) === 'Esta CLI no publica su estado');
  check('8 punto unknown con la status line sin configurar lo dice',
    ui.restingDotTitle('unknown', { state: 'missing' }) === 'Esta CLI publica su estado sólo con la status line configurada');
  check('8 punto unknown con la status line activa: todavia no publico nada',
    ui.restingDotTitle('unknown', { state: 'active' }).startsWith('La status line todavía no publicó'));
  check('8 punto idle con status line: el de siempre', ui.restingDotTitle('idle', { state: 'active' }) === 'Lista, sin nada en curso');

  check('D16 combo: con Antigravity esperando un permiso, apagado', ui.modeChangeBlocked(agyCycle, 'permission prompt') === true);
  check('D16 combo: sin nada pendiente, o con Claude Code esperando, prendido',
    ui.modeChangeBlocked(agyCycle, null) === false && ui.modeChangeBlocked(claudeCycle, 'permission prompt') === false);
  check('D16 titulo con Claude Code: exactamente el de antes, sepa o no su estado',
    ui.modeControlTitle('plan', claudeCycle, true, null) === ui.modeTitle('plan', claudeCycle) &&
    ui.modeControlTitle('plan', claudeCycle, false, 'permission prompt') === ui.modeTitle('plan', claudeCycle));
  check('D16 titulo con Antigravity sin status line: avisa que cambiar aprueba lo pendiente',
    ui.modeControlTitle('acceptEdits', agyCycle, false, null).startsWith(ui.modeTitle('acceptEdits', agyCycle)) &&
    ui.modeControlTitle('acceptEdits', agyCycle, false, null).includes('Sin datos de la status line'));

  // R27-1: la ceguera es por pestana. Configurada y sin publicar (`unknown`) vale lo mismo que sin fuente.
  const agyActive = ANTIGRAVITY_STATUS_LINE_CAPABILITIES;
  const claudeCaps = { ...agyActive, statusSource: true, permissionCycle: claudeCycle };
  check('R27-1 blindToApprovals: sin fuente siempre; con fuente, solo la pestana unknown',
    shared.blindToApprovals(ANTIGRAVITY_BASE_CAPABILITIES, 'idle') === true && shared.blindToApprovals(agyActive, 'unknown') === true &&
    shared.blindToApprovals(agyActive, 'busy') === false && shared.blindToApprovals(agyActive, null) === false &&
    shared.blindToApprovals(agyActive) === false && shared.blindToApprovals(agyActive, 'offline') === false);
  check('R27-1 web: status line activa, pestana unknown y llamada abierta -> Enviar apagado con el motivo',
    ui.openToolCallNotice(agyActive, true, 'Antigravity CLI', true, 'unknown')?.includes('herramienta sin resultado') === true);
  check('R27-1 web: la misma pestana cuando la status line publica -> sin aviso por la llamada',
    ui.openToolCallNotice(agyActive, true, 'Antigravity CLI', true, 'busy') === null &&
    ui.openToolCallNotice(claudeCaps, true, 'Claude Code', true, 'waiting') === null);

  // R27-2: con la CLI diciendo que espera, un Enter aprobaria. Claude Code igual que antes.
  check('R27-2 web: Antigravity esperando un permiso -> Enviar apagado con el texto de la barra',
    ui.pendingApprovalNotice(agyActive, 'permission prompt', true) === ui.waitingBarText('permission prompt') &&
    ui.waitingBarText('permission prompt') === 'La CLI esta esperando que autorices una herramienta.' &&
    ui.pendingApprovalNotice(agyActive, 'dialog open', true) === 'La CLI esta esperando una respuesta tuya.');
  check('R27-2 web: sin espera, sin CLI viva o con Claude Code esperando -> null',
    ui.pendingApprovalNotice(agyActive, null, true) === null && ui.pendingApprovalNotice(agyActive, 'permission prompt', false) === null &&
    ui.pendingApprovalNotice(claudeCaps, 'permission prompt', true) === null);
  check('D16 titulo con Antigravity y status line: el de siempre, y el motivo mientras espera',
    ui.modeControlTitle('acceptEdits', agyCycle, true, null) === ui.modeTitle('acceptEdits', agyCycle) &&
    ui.modeControlTitle('acceptEdits', agyCycle, true, 'permission prompt').startsWith('Hay una confirmación pendiente'));

  const stateTexts = shared.STATUS_LINE_STATES.map((state) => ui.statusLineStateText(state));
  check('8 el dialogo nombra cada estado distinto', new Set(stateTexts).size === stateTexts.length && ui.statusLineStateText('active') === 'Configurada' &&
    ui.statusLineStateText('other-command').includes('reemplaza'), show(stateTexts));
  check('8 el dialogo explica por que no hay fragmento', ui.STATUS_LINE_NO_FRAGMENT.includes('cmd /c'));
  check('D15 el hilo de una conversacion sin transcript lo dice', ui.NO_TRANSCRIPT_TEXT.includes('transcript') && ui.NO_TRANSCRIPT_TEXT.includes('reanudar'));

  check('R10 solo Antigravity avisa que /model queda como predeterminado',
    ui.modelChoiceNote('antigravity').includes('predeterminado') && ui.modelChoiceNote('claude-code') === '' &&
    ui.modelChoiceNote('codex') === '' && ui.modelChoiceNote('opencode') === '' && ui.modelChoiceNote(null) === '');

  // Lo que el cliente recibe cuando cambia la configuracion: la lista con la status line nueva.
  const agyInfo = (state) => ({
    id: 'antigravity', label: 'Antigravity CLI', command: 'agy', available: true, version: '1.2.2', installUrl: 'u', missingMessage: null,
    capabilities: state === 'active' ? ANTIGRAVITY_STATUS_LINE_CAPABILITIES : ANTIGRAVITY_BASE_CAPABILITIES, environmentNotice: null,
    statusLine: { state, settingsPath: 'C:\\h\\.gemini\\antigravity-cli\\settings.json', scriptPath: 'C:\\a\\integrations\\antigravity-statusline.mjs', fragment: null },
  });
  const decoded = shared.parseServerMessage(shared.encodeServerMessage({ type: 'agents', agents: [agyInfo('active')], defaultAgent: 'antigravity' }));
  const decodedInfo = decoded?.agents?.[0];
  check('D10 el mensaje agents lleva las capacidades y la status line nuevas, y el medidor mide con ellas',
    decoded?.type === 'agents' && decodedInfo?.statusLine?.state === 'active' && decodedInfo?.statusLine?.fragment === null &&
    ui.controlsFor(decodedInfo.capabilities).contextWindowSource === 'status-line' && !ui.meterOffersSetup(decodedInfo.capabilities.contextWindowSource, decodedInfo.statusLine),
    show(decoded));
  const decodedMissing = shared.parseServerMessage(shared.encodeServerMessage({ type: 'agents', agents: [agyInfo('missing')], defaultAgent: null }))?.agents?.[0];
  check('D10 y sin configurar, el medidor ofrece Configurar', decodedMissing !== undefined &&
    ui.meterOffersSetup(ui.controlsFor(decodedMissing.capabilities).contextWindowSource, decodedMissing.statusLine));
}

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
