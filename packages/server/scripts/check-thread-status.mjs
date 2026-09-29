/**
 * Chequeo de la fila de estado del hilo y de los subagentes (§4.15, §6.30).
 *
 *   npx tsx scripts/check-thread-status.mjs
 *
 * Lo que se rompe en silencio:
 *
 *  - **Un subagente que termino y sigue "trabajando" para siempre.** El aviso
 *    de fin es una linea que no es un mensaje (`queue-operation`), y llega por
 *    tres caminos segun lo que hacia el agente principal. Y uno de un proceso
 *    anterior no avisa nunca: murio con el.
 *  - **Un envio que queda en "Enviando…", o un "Entregado" que no se va.** La
 *    fila decide con el acuse, la actividad y lo que llego al hilo despues del
 *    envio; cada combinacion tiene su caso.
 *  - **El protocolo.** Un reset de un servidor anterior no trae `subagents` y
 *    no puede tirar la conversacion entera.
 *
 * Las lineas imitan las medidas en el historial de esta instalacion
 * (29-09-2026). El seguidor real de Claude Code corre sobre un JSONL inventado:
 * el home apunta a una carpeta temporal antes de importar nada, y nunca se lee
 * `~/.claude`. No carga node-pty.
 */

import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-workbench-check-thread-'));
process.env.HOME = root;
process.env.USERPROFILE = root;

const shared = await import('@agent-workbench/shared');
const { SubagentTracker, notifiedToolUseIds } = await import('../src/agents/claude-code/subagent-tracker.ts');
const { ConversationFollower } = await import('../src/agents/claude-code/conversation-follower.ts');
const { ClaudeCodeSessionFollower } = await import('../src/agents/claude-code/session-follower.ts');
const { ModelVariantRegistry } = await import('../src/agents/claude-code/model-variants.ts');
const { sessionFilePath } = await import('../src/agents/claude-code/paths.ts');
const { ConversationHub } = await import('../src/conversation-hub.ts');
const { setLocale } = await import('../../web/src/i18n/index.ts');
const status = await import('../../web/src/thread-status.ts');

// Los textos de la interfaz salen de `t()` (§6.23): este chequeo los compara
// con el español, asi que lo fija antes de la primera comparacion.
await setLocale('es');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);
const ids = (list) => list.map((item) => item.toolUseId).join(',');

// --- Lineas del JSONL, con la forma medida -----------------------------------

const LAUNCHED_AT = Date.parse('2026-09-29T10:00:00.000Z');
const BEFORE = '2026-09-29T09:50:00.000Z';
const at = (seconds) => new Date(LAUNCHED_AT + seconds * 1_000).toISOString();

const agentCall = (id, description, options = {}) => ({
  type: 'assistant',
  uuid: `call-${id}`,
  timestamp: options.timestamp ?? at(10),
  isSidechain: options.sidechain ?? false,
  message: {
    role: 'assistant',
    model: 'claude-opus-5',
    content: [
      {
        type: 'tool_use',
        id,
        name: options.name ?? 'Agent',
        input: {
          description,
          prompt: 'Analiza el proyecto',
          subagent_type: 'Explore',
          ...(options.background === false ? {} : { run_in_background: true }),
        },
      },
    ],
  },
});
const bashCall = (id) => ({
  type: 'assistant',
  uuid: `call-${id}`,
  timestamp: at(11),
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test', run_in_background: true } }],
  },
});
const launched = (id, agentId) => ({
  type: 'user',
  uuid: `launched-${id}`,
  timestamp: at(12),
  isSidechain: false,
  message: {
    role: 'user',
    content: [
      {
        tool_use_id: id,
        type: 'tool_result',
        content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${agentId}\nThe agent is working in the background.` }],
      },
    ],
  },
  toolUseResult: { isAsync: true, status: 'async_launched', agentId, description: 'x' },
});
const finishedResult = (id, isError = false) => ({
  type: 'user',
  uuid: `result-${id}`,
  timestamp: at(30),
  message: {
    role: 'user',
    content: [{ tool_use_id: id, type: 'tool_result', content: 'El informe final', ...(isError ? { is_error: true } : {}) }],
  },
  toolUseResult: { status: 'completed' },
});
const notification = (taskId, toolUseId, statusText = 'completed') =>
  `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n` +
  `<output-file>C:\\tmp\\tasks\\${taskId}.output</output-file>\n<status>${statusText}</status>\n` +
  `<summary>Agent "x" finished</summary>\n</task-notification>`;
const enqueue = (content) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: at(40), sessionId: 's', content });
const queuedCommand = (content) => ({
  type: 'attachment',
  timestamp: at(41),
  isSidechain: false,
  attachment: { type: 'queued_command', prompt: content, commandMode: 'task-notification', origin: { kind: 'task-notification' } },
});
const notificationTurn = (content, asBlocks = false) => ({
  type: 'user',
  uuid: `notice-${content.length}-${asBlocks}`,
  timestamp: at(42),
  origin: { kind: 'task-notification' },
  promptSource: 'system',
  message: { role: 'user', content: asBlocks ? [{ type: 'text', text: content }] : content },
});
const userText = (uuid, text, timestamp = at(1)) => ({
  type: 'user',
  uuid,
  timestamp,
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const assistantText = (uuid, text) => ({
  type: 'assistant',
  uuid,
  timestamp: at(50),
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }] },
});

// --- 1. El seguimiento, linea a linea -----------------------------------------

{
  const tracker = new SubagentTracker();
  tracker.observe(agentCall('toolu_A', 'Analyze backend'));
  let running = tracker.running(LAUNCHED_AT);
  check('1.1 un Agent en segundo plano queda trabajando desde su llamada',
    running.length === 1 && running[0].toolUseId === 'toolu_A' && running[0].background && running[0].description === 'Analyze backend' &&
      running[0].startedAt === Date.parse(at(10)), json(running));
  tracker.observe(launched('toolu_A', 'a111'));
  check('1.2 el resultado "async_launched" no lo termina', ids(tracker.running(LAUNCHED_AT)) === 'toolu_A');
  tracker.observe(enqueue(notification('a111', 'toolu_A')));
  check('1.3 la queue-operation enqueue con su <tool-use-id> lo termina', tracker.running(LAUNCHED_AT).length === 0);
}

{
  const tracker = new SubagentTracker();
  tracker.observe(agentCall('toolu_B', 'b'));
  tracker.observe(launched('toolu_B', 'b222'));
  tracker.observe(queuedCommand(notification('b222', 'toolu_B')));
  check('1.4 tambien lo termina el queued_command (el agente estaba trabajando)', tracker.running(LAUNCHED_AT).length === 0);

  tracker.observe(agentCall('toolu_C', 'c'));
  tracker.observe(notificationTurn(notification('c333', 'toolu_C')));
  check('1.5 y la linea user con origin task-notification, contenido string (estaba libre)', tracker.running(LAUNCHED_AT).length === 0);

  tracker.observe(agentCall('toolu_D', 'd'));
  tracker.observe(notificationTurn(notification('d444', 'toolu_D', 'failed'), true));
  check('1.6 y la misma linea con bloques de texto, con cualquier <status>', tracker.running(LAUNCHED_AT).length === 0);
}

{
  const tracker = new SubagentTracker();
  tracker.observe(agentCall('toolu_E', 'e', { background: false }));
  let running = tracker.running(LAUNCHED_AT);
  check('1.7 un Agent sin run_in_background trabaja hasta su resultado', running.length === 1 && running[0].background === false, json(running));
  tracker.observe(finishedResult('toolu_E'));
  check('1.8 su tool_result lo termina', tracker.running(LAUNCHED_AT).length === 0);

  tracker.observe(agentCall('toolu_F', 'f'));
  tracker.observe(finishedResult('toolu_F', true));
  check('1.9 un lanzamiento en segundo plano que fallo (is_error) no queda trabajando', tracker.running(LAUNCHED_AT).length === 0);

  tracker.observe(agentCall('toolu_G', 'g'));
  tracker.observe(finishedResult('toolu_G'));
  check('1.10 run_in_background sin "async_launched" (corrio en primer plano) termina con su resultado', tracker.running(LAUNCHED_AT).length === 0);
}

{
  const tracker = new SubagentTracker();
  tracker.observe(agentCall('toolu_OLD', 'viejo', { timestamp: BEFORE }));
  tracker.observe(agentCall('toolu_NEW', 'nuevo'));
  check('1.11 uno de un proceso anterior no cuenta: murio con el y no va a avisar',
    ids(tracker.running(LAUNCHED_AT)) === 'toolu_NEW' && ids(tracker.running(0)) === 'toolu_OLD,toolu_NEW');
  const noTime = agentCall('toolu_NOTIME', 'sin hora');
  delete noTime.timestamp;
  tracker.observe(noTime);
  check('1.12 uno sin hora no se puede atribuir a ningun proceso y no cuenta', !ids(tracker.running(0)).includes('toolu_NOTIME'));
}

{
  const tracker = new SubagentTracker();
  tracker.observe(agentCall('toolu_SIDE', 'rama', { sidechain: true }));
  tracker.observe(bashCall('toolu_BASH'));
  tracker.observe(agentCall('toolu_TASK', 'nombre viejo', { name: 'Task' }));
  const running = tracker.running(LAUNCHED_AT);
  check('1.13 ni la rama de un subagente ni un Bash en segundo plano; Task (el nombre viejo) si',
    ids(running) === 'toolu_TASK', ids(running));
  tracker.observe(enqueue(notification('bxyz', 'toolu_BASH')));
  tracker.observe(enqueue(notification('otro', 'toolu_QUE_NO_ESTA')));
  check('1.14 el aviso de un Bash o de una llamada desconocida no toca a nadie', ids(tracker.running(LAUNCHED_AT)) === 'toolu_TASK');
  tracker.observe({ type: 'queue-operation', operation: 'remove', content: notification('x', 'toolu_TASK'), timestamp: at(60) });
  check('1.15 solo el enqueue da por terminado (remove y dequeue repiten lo que ya se sabia)', ids(tracker.running(LAUNCHED_AT)) === 'toolu_TASK');
  tracker.observe(agentCall('toolu_TASK', 'repetida', { name: 'Task' }));
  check('1.16 la misma llamada leida dos veces cuenta una', tracker.running(LAUNCHED_AT).length === 1);
  tracker.reset();
  check('1.17 reset olvida todo', tracker.running(0).length === 0);
}

{
  const tracker = new SubagentTracker();
  tracker.observe(agentCall('toolu_LABEL', '  Analyze\n   backend  \t'));
  tracker.observe(agentCall('toolu_LONG', 'x'.repeat(500)));
  tracker.observe(agentCall('toolu_EMPTY', undefined));
  const byId = new Map(tracker.running(LAUNCHED_AT).map((item) => [item.toolUseId, item.description]));
  check('1.18 la descripcion en una linea, recortada, y vacia si no hay',
    byId.get('toolu_LABEL') === 'Analyze backend' &&
      byId.get('toolu_LONG')?.length === shared.MAX_SUBAGENT_DESCRIPTION &&
      byId.get('toolu_EMPTY') === '', json([...byId]));

  const many = new SubagentTracker();
  for (let index = 0; index < 55; index += 1) many.observe(agentCall(`toolu_${index}`, `n${index}`));
  const kept = many.running(LAUNCHED_AT);
  check('1.19 con tope: si una version deja de avisar, se olvidan los mas viejos',
    kept.length === 50 && kept[0].toolUseId === 'toolu_5' && kept[49].toolUseId === 'toolu_54', `${kept.length} ${kept[0]?.toolUseId}`);

  const copy = many.running(LAUNCHED_AT)[0];
  copy.description = 'tocado';
  check('1.20 lo que devuelve es una copia', many.running(LAUNCHED_AT)[0].description === 'n5');
}

check('1.21 notifiedToolUseIds: dos avisos en un texto, y nada sin aviso',
  json(notifiedToolUseIds(notification('a', 'toolu_1') + '\n' + notification('b', 'toolu_2'))) === json(['toolu_1', 'toolu_2']) &&
    notifiedToolUseIds('texto comun con <tool-use-id>toolu_x</tool-use-id>').length === 0);

// --- 2. El seguidor del archivo -----------------------------------------------

const lines = (...records) => records.map((record) => JSON.stringify(record) + '\n').join('');

{
  const file = path.join(root, 'follower.jsonl');
  await writeFile(file, lines(userText('u1', 'hola'), agentCall('toolu_A', 'Analyze backend'), launched('toolu_A', 'a111'),
    assistantText('a1', 'Lanze un subagente y espero su informe.')));
  const follower = new ConversationFollower(file);
  await follower.poll();
  check('2.1 el seguidor lee las lineas que no son tarjetas: el subagente sigue', ids(follower.runningSubagents(LAUNCHED_AT)) === 'toolu_A');
  await appendFile(file, lines(enqueue(notification('a111', 'toolu_A'))));
  await follower.poll();
  check('2.2 el aviso agregado despues lo termina', follower.runningSubagents(LAUNCHED_AT).length === 0);
  await appendFile(file, lines(agentCall('toolu_B', 'otro')));
  await follower.poll();
  check('2.3 uno nuevo en una lectura incremental', ids(follower.runningSubagents(LAUNCHED_AT)) === 'toolu_B');
  await writeFile(file, lines(userText('u9', 'reescrito')));
  await follower.poll();
  check('2.4 el archivo que encoge se relee desde cero: nada queda de antes', follower.runningSubagents(LAUNCHED_AT).length === 0);
}

// --- 3. El hub: el snapshot, el aviso y el proceso que muere -------------------

/** Espera un aviso del hub, con plazo: nunca un sleep. null si no llego. */
const nextEvent = (hub, name, ms = 5_000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      hub.off(name, listener);
      resolve(null);
    }, ms);
    const listener = (...args) => {
      clearTimeout(timer);
      hub.off(name, listener);
      resolve(args);
    };
    hub.on(name, listener);
  });

{
  const cwd = path.join(root, 'proyecto');
  await mkdir(cwd, { recursive: true });
  const sessionId = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  const file = sessionFilePath(cwd, sessionId);
  check('3.0 el archivo de la sesion cae en el home temporal', file.startsWith(root), file);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines(userText('u1', 'hola'), agentCall('toolu_H1', 'Research the law'), launched('toolu_H1', 'h111'),
    assistantText('a1', 'Espero al subagente.')));

  const variants = new ModelVariantRegistry();
  const claudeAdapter = {
    id: 'claude-code',
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: true },
    status: null,
    history: { follow: (target) => new ClaudeCodeSessionFollower(target.cwd, target.sessionId, variants), plans: null },
  };
  // Una CLI cuyo seguidor no declara subagentes: no tiene nunca.
  const plainFollower = {
    label: 'otra', start: async () => undefined,
    poll: async () => ({ reset: false, added: [], turns: [], plans: [], parts: [] }),
    getState: () => 'live', getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }), getPermissionMode: () => null,
    getTail: () => ({ events: [], hasMore: false }), getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [], readImage: async () => null, noticeChange: () => false, hasOpenToolCall: () => false,
  };
  const otherAdapter = {
    id: 'codex',
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: true },
    status: null,
    history: { follow: () => plainFollower, plans: null },
  };
  const adapters = { 'claude-code': claudeAdapter, codex: otherAdapter };
  const agents = { get: (id) => (adapters[id] === undefined ? null : { adapter: adapters[id], location: null }) };
  const registry = new EventEmitter();
  const descriptors = new Map();
  let launchedAt = LAUNCHED_AT;
  registry.get = (terminalId) => descriptors.get(terminalId) ?? null;
  registry.launchedAtOf = () => launchedAt;
  const describe = (terminalId, agent) => ({
    terminalId, kind: 'agent', agent, cwd, sessionId, label: '', resumed: false,
    createdAt: 0, alive: true, exitCode: null, sleeping: false,
  });
  descriptors.set('t-claude', describe('t-claude', 'claude-code'));
  descriptors.set('t-otra', describe('t-otra', 'codex'));

  const hub = new ConversationHub(registry, agents);
  try {
    const snapshot = await hub.subscribe('t-claude');
    check('3.1 el snapshot trae el subagente que sigue', ids(snapshot?.subagents ?? []) === 'toolu_H1', json(snapshot?.subagents));
    check('3.2 getSubagents dice lo mismo', ids(hub.getSubagents('t-claude')) === 'toolu_H1');

    const done = nextEvent(hub, 'subagents');
    await appendFile(file, lines(enqueue(notification('h111', 'toolu_H1'))));
    hub.onHistoryChanged('claude-code', file);
    const doneArgs = await done;
    check('3.3 el aviso de fin llega como "subagents" vacio a esa pestana',
      doneArgs !== null && doneArgs[0] === 't-claude' && doneArgs[1].length === 0, json(doneArgs));

    const again = nextEvent(hub, 'subagents');
    await appendFile(file, lines(agentCall('toolu_H2', 'Second pass', { timestamp: at(70) })));
    hub.onHistoryChanged('claude-code', file);
    const againArgs = await again;
    check('3.4 uno nuevo se avisa entero', againArgs !== null && ids(againArgs[1]) === 'toolu_H2', json(againArgs));

    const events = [];
    hub.on('subagents', (terminalId, list) => events.push([terminalId, list.length]));
    registry.emit('changed');
    check('3.5 un cambio del registro que no mueve nada no avisa', events.length === 0, json(events));
    launchedAt = null;
    registry.emit('changed');
    check('3.6 sin pty viva no queda ninguno: murieron con el proceso', json(events) === json([['t-claude', 0]]) && hub.getSubagents('t-claude').length === 0,
      json(events));
    launchedAt = Date.parse(at(100));
    registry.emit('changed');
    check('3.7 relanzada, el de antes no vuelve: es de otro proceso', hub.getSubagents('t-claude').length === 0 && events.length === 1, json(events));

    const other = await hub.subscribe('t-otra');
    check('3.8 una CLI cuyo seguidor no los declara no tiene nunca', json(other?.subagents) === '[]' && hub.getSubagents('t-otra').length === 0);
    const unknown = await hub.subscribe('no-existe');
    check('3.9 una pestana que no existe no tiene snapshot', unknown === null);
  } finally {
    hub.disposeAll();
  }
}

// --- 4. El protocolo ----------------------------------------------------------

{
  const { parseServerMessage, parseClientMessage } = shared;
  const reset = {
    type: 'conversation.reset', terminalId: 't1', sessionId: 's', state: 'live', events: [], hasMore: false,
    usage: shared.EMPTY_CONTEXT_USAGE, permissionMode: null, defaults: { model: null, effort: null, contextWindow: null },
    waitingFor: null, openToolCall: false,
  };
  const old = parseServerMessage(JSON.stringify(reset));
  check('4.1 un reset de un servidor anterior, sin subagents, se lee con la lista vacia', old?.type === 'conversation.reset' && json(old.subagents) === '[]');

  const good = { toolUseId: 'toolu_1', description: 'Analyze', background: true, startedAt: 5 };
  const withList = parseServerMessage(JSON.stringify({ ...reset, subagents: [good, { toolUseId: '', description: 'x', startedAt: 1 }, 'basura'] }));
  check('4.2 un subagente que no se entiende se descarta solo', json(withList?.subagents) === json([good]), json(withList?.subagents));

  const list = Array.from({ length: 30 }, (_, index) => ({ ...good, toolUseId: `t${index}`, description: 'y'.repeat(300) }));
  const update = parseServerMessage(JSON.stringify({ type: 'conversation.subagents', terminalId: 't1', subagents: list }));
  check('4.3 conversation.subagents: con tope de cantidad y de descripcion',
    update?.type === 'conversation.subagents' && update.subagents.length === shared.MAX_REPORTED_SUBAGENTS &&
      update.subagents[0].description.length === shared.MAX_SUBAGENT_DESCRIPTION);
  check('4.4 conversation.subagents sin lista no se lee',
    parseServerMessage(JSON.stringify({ type: 'conversation.subagents', terminalId: 't1' })) === null);

  const ack = parseServerMessage(JSON.stringify({ type: 'agent.submitted', terminalId: 't1', requestId: 'submit-1', delivered: false }));
  check('4.5 agent.submitted, entregado o no', ack?.type === 'agent.submitted' && ack.delivered === false && ack.requestId === 'submit-1');
  check('4.6 agent.submitted sin delivered no se lee',
    parseServerMessage(JSON.stringify({ type: 'agent.submitted', terminalId: 't1', requestId: 'submit-1' })) === null);

  const submit = { type: 'agent.submit', terminalId: 't1', text: 'hola', images: [] };
  const withId = parseClientMessage(JSON.stringify({ ...submit, requestId: 'submit-9' }));
  const without = parseClientMessage(JSON.stringify(submit));
  const empty = parseClientMessage(JSON.stringify({ ...submit, requestId: '' }));
  check('4.7 agent.submit lleva el requestId si viene; sin el, el mensaje es el de siempre',
    withId?.requestId === 'submit-9' && without !== null && !('requestId' in without) && empty !== null && !('requestId' in empty));
}

// --- 5. Que dice la fila ------------------------------------------------------

{
  const { mainThreadStatus, mainStatusText, subagentsText, repliedSince, nextBusySince, newSubmitRequestId } = status;
  const T = 1_000_000;
  const event = (eventId, role) => ({ eventId, role, at: 0, parts: [], model: null, usage: null, effort: null, durationMs: null, queued: false });
  const events = [event('e1', 'user'), event('e2', 'assistant'), event('e3', 'user')];
  const receipt = (overrides = {}) => ({
    requestId: 'submit-1', terminalId: 't1', afterEventId: 'e3', phase: 'delivered', sentAt: T, deliveredAt: T + 500, ...overrides,
  });
  const base = { live: true, activity: 'idle', waitingFor: null, receipt: null, events, busySince: null, now: T + 1_000 };
  const kind = (overrides) => mainThreadStatus({ ...base, ...overrides })?.kind ?? null;

  check('5.1 sin CLI, o esperando al usuario, la fila no dice nada del agente',
    kind({ live: false, activity: 'busy' }) === null && kind({ waitingFor: 'permission prompt', activity: 'busy', receipt: receipt() }) === null);
  check('5.2 mandado y sin acuse: "Enviando", aunque la CLI ya trabaje',
    kind({ receipt: receipt({ phase: 'sending', deliveredAt: null }), activity: 'busy' }) === 'sending');
  check('5.3 sin envio: trabajando si trabaja, nada si esta libre',
    kind({ activity: 'busy' }) === 'working' && kind({ activity: 'idle' }) === null);

  const working = mainThreadStatus({ ...base, activity: 'busy', busySince: T + 200, receipt: receipt() });
  check('5.4 trabajando, con desde cuando y la marca de recien entregado',
    working?.kind === 'working' && working.since === T + 200 && working.justDelivered === true, json(working));
  const later = mainThreadStatus({ ...base, activity: 'busy', receipt: receipt(), now: T + 500 + status.DELIVERED_FLASH_MS });
  check('5.5 la marca se va a los pocos segundos', later?.kind === 'working' && later.justDelivered === false);

  check('5.6 entregado y la CLI todavia libre: "Entregado", por un rato', kind({ receipt: receipt() }) === 'delivered' &&
    kind({ receipt: receipt(), now: T + 500 + status.DELIVERED_HOLD_MS }) === null);
  check('5.7 libre despues de trabajar desde el envio: ya lo atendio', kind({ receipt: receipt(), busySince: T + 100 }) === null &&
    kind({ receipt: receipt(), busySince: T - 100 }) === 'delivered');
  check('5.8 con respuesta en el hilo despues del envio, nada',
    kind({ receipt: receipt(), events: [...events, event('e4', 'assistant')] }) === null &&
      kind({ receipt: receipt(), events: [...events, event('e4', 'user')] }) === 'delivered');

  const codex = mainThreadStatus({ ...base, activity: 'unknown', receipt: receipt() });
  check('5.9 sin estado publicado (Codex): entregado y esperando respuesta, desde el acuse',
    codex?.kind === 'awaiting-reply' && codex.since === T + 500, json(codex));
  check('5.10 ...hasta que contesta', kind({ activity: 'unknown', receipt: receipt(), events: [...events, event('e4', 'assistant')] }) === null);
  check('5.11 una CLI caida (offline) no dice nada', kind({ activity: 'offline', receipt: receipt() }) === null);

  check('5.12 repliedSince: por posicion, y un evento que ya no esta cuenta como contestado',
    repliedSince('e3', events) === false && repliedSince('e1', events) === true && repliedSince('no-esta', events) === true &&
      repliedSince(null, [event('x', 'user')]) === false && repliedSince(null, events) === true);

  check('5.13 nextBusySince: solo un paso visto a busy dice cuando empezo',
    nextBusySince(undefined, 'busy', null, T) === null && nextBusySince('idle', 'busy', null, T) === T &&
      nextBusySince('waiting', 'busy', 5, T) === T && nextBusySince('busy', 'busy', 5, T) === 5 &&
      nextBusySince('busy', 'idle', 5, T) === 5 && nextBusySince('idle', 'idle', null, T) === null);

  const texts = [
    mainStatusText({ kind: 'sending' }, T),
    mainStatusText({ kind: 'delivered' }, T),
    mainStatusText({ kind: 'working', since: null, justDelivered: false }, T),
    mainStatusText({ kind: 'working', since: null, justDelivered: true }, T),
    mainStatusText({ kind: 'working', since: T - 42_000, justDelivered: false }, T),
    mainStatusText({ kind: 'working', since: T - 65_000, justDelivered: true }, T),
    mainStatusText({ kind: 'awaiting-reply', since: T - 5_000 }, T),
  ];
  check('5.14 los textos del agente principal', json(texts) === json([
    'Enviando a la CLI…',
    'Entregado a la CLI',
    'El agente está trabajando…',
    'El agente está trabajando · mensaje entregado',
    'El agente está trabajando · 42 s',
    'El agente está trabajando · 1 min 5 s · mensaje entregado',
    'Entregado a la CLI · todavía sin respuesta · 5 s',
  ]), json(texts));
  const early = [
    mainStatusText({ kind: 'working', since: T - 400, justDelivered: false }, T),
    mainStatusText({ kind: 'working', since: T + 3_000, justDelivered: true }, T),
    mainStatusText({ kind: 'awaiting-reply', since: T - 400 }, T),
  ];
  check('5.15 el reloj aparece desde el primer segundo, nunca "menos de 1 s"', json(early) === json([
    'El agente está trabajando…',
    'El agente está trabajando · mensaje entregado',
    'Entregado a la CLI',
  ]), json(early));

  const sub = (toolUseId, description, startedAt) => ({ toolUseId, description, background: true, startedAt });
  const one = subagentsText([sub('a', 'Analizar backend', T - 180_000)], T);
  const five = subagentsText([
    sub('a', 'A', T - 1_000), sub('b', '', T - 2_000), sub('c', 'C', T + 60_000), sub('d', 'D', T), sub('e', 'E', T),
  ], T);
  check('5.16 los subagentes: cuantos, los primeros por su nombre y el resto contado',
    one === '1 subagente sigue trabajando: Analizar backend (3 min)' &&
      five === '5 subagentes siguen trabajando: A (1 s), sin nombre (2 s), C (menos de 1 s) y 2 más', `${one} | ${five}`);

  const first = newSubmitRequestId();
  check('5.17 cada envio con su id', first.startsWith('submit-') && first !== newSubmitRequestId());
}

await rm(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
