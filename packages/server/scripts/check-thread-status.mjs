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
  const {
    mainThreadStatus, mainStatusText, subagentsText, repliedSince, nextBusyClock, nextBusyClocks,
    receiptsAfterReopen, applySubmitAck, newSubmitRequestId,
  } = status;
  const T = 1_000_000;
  const event = (eventId, role) => ({ eventId, role, at: 0, parts: [], model: null, usage: null, effort: null, durationMs: null, queued: false });
  const events = [event('e1', 'user'), event('e2', 'assistant'), event('e3', 'user')];
  const receipt = (overrides = {}) => ({
    requestId: 'submit-1', terminalId: 't1', afterEventId: 'e3', phase: 'delivered', queued: false, sentAt: T, deliveredAt: T + 500,
    ...overrides,
  });
  const clock = (runStartedAt, busySeenAt = runStartedAt) => ({ runStartedAt, busySeenAt });
  const base = { live: true, activity: 'idle', waitingFor: null, receipt: null, events, clock: null, now: T + 1_000 };
  const kind = (overrides) => mainThreadStatus({ ...base, ...overrides })?.kind ?? null;

  check('5.1 sin CLI, o esperando al usuario, la fila no dice nada del agente',
    kind({ live: false, activity: 'busy' }) === null && kind({ waitingFor: 'permission prompt', activity: 'busy', receipt: receipt() }) === null);
  check('5.2 mandado y sin acuse: "Enviando", aunque la CLI ya trabaje',
    kind({ receipt: receipt({ phase: 'sending', deliveredAt: null }), activity: 'busy' }) === 'sending');
  check('5.3 sin envio: trabajando si trabaja, nada si esta libre',
    kind({ activity: 'busy' }) === 'working' && kind({ activity: 'idle' }) === null);

  const working = mainThreadStatus({ ...base, activity: 'busy', clock: clock(T + 200), receipt: receipt() });
  check('5.4 trabajando, con desde cuando y la marca de recien entregado',
    working?.kind === 'working' && working.since === T + 200 && working.justDelivered === true, json(working));
  const later = mainThreadStatus({ ...base, activity: 'busy', receipt: receipt(), now: T + 500 + status.DELIVERED_FLASH_MS });
  check('5.5 la marca se va a los pocos segundos', later?.kind === 'working' && later.justDelivered === false);

  check('5.6 entregado y la CLI todavia libre: "Entregado", por un rato', kind({ receipt: receipt() }) === 'delivered' &&
    kind({ receipt: receipt(), now: T + 500 + status.DELIVERED_HOLD_MS }) === null);
  check('5.7 libre despues de trabajar desde el envio: ya lo atendio', kind({ receipt: receipt(), clock: clock(null, T + 100) }) === null &&
    kind({ receipt: receipt(), clock: clock(null, T - 100) }) === 'delivered');
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

  check('5.13 el reloj: solo un paso visto de libre a trabajando dice cuando empezo',
    json(nextBusyClock(undefined, 'busy', clock(null), T)) === json(clock(null, T)) &&
      json(nextBusyClock('idle', 'busy', clock(null, 5), T)) === json(clock(T, T)) &&
      json(nextBusyClock('unknown', 'busy', clock(7, 5), T)) === json(clock(null, T)));

  // Arreglo 2 (01-10-2026): aprobar un permiso no reinicia el reloj del turno.
  {
    let c = nextBusyClock('idle', 'busy', clock(null), 100);
    c = nextBusyClock('busy', 'waiting', c, 200);
    c = nextBusyClock('waiting', 'busy', c, 300);
    check('5.13b busy → waiting → busy es la misma corrida: el reloj sigue desde el principio',
      c.runStartedAt === 100 && c.busySeenAt === 300, json(c));
  }

  // Arreglo 3: al terminar, el reloj se apaga; el turno nuevo arranca de cero.
  {
    let c = nextBusyClock('idle', 'busy', clock(null), 100);
    c = nextBusyClock('busy', 'idle', c, 900);
    const ended = c;
    c = nextBusyClock('idle', 'busy', c, 5_000);
    check('5.13c al terminar no queda reloj, y lo que se sabe de cuando trabajo si',
      ended.runStartedAt === null && ended.busySeenAt === 900, json(ended));
    check('5.13d el turno siguiente empieza en su hora, nunca en la del anterior', c.runStartedAt === 5_000, json(c));
    const working = mainThreadStatus({ ...base, activity: 'busy', clock: ended, now: 5_000 });
    check('5.13e en el cuadro en que llega "trabajando", antes de rehacer el reloj, no hay tiempo viejo',
      working?.kind === 'working' && working.since === null, json(working));
  }

  {
    const previous = new Map([['a', 'idle'], ['b', 'busy'], ['gone', 'busy']]);
    const next = new Map([['a', 'busy'], ['b', 'busy'], ['new', 'idle']]);
    const clocks = new Map([['a', clock(null, 1)], ['b', clock(40, 40)], ['gone', clock(2, 2)]]);
    const result = nextBusyClocks(previous, next, clocks, 1_000);
    check('5.13f nextBusyClocks: cambia la que cambio, deja igual la que no, olvida la que se fue',
      json(result.get('a')) === json(clock(1_000, 1_000)) && result.get('b') === clocks.get('b') &&
        !result.has('gone') && json(result.get('new')) === json(clock(null, null)), json([...result]));
  }

  // Arreglo 1: el envio que salio al reconectar no pierde su acuse.
  {
    const sending = (requestId, queued) => receipt({ requestId, phase: 'sending', queued, deliveredAt: null });
    const receipts = new Map([
      ['live', { ...sending('r-live', false), terminalId: 'live' }],
      ['queued', { ...sending('r-queued', true), terminalId: 'queued' }],
      ['done', { ...receipt({ requestId: 'r-done' }), terminalId: 'done' }],
    ]);
    const after = receiptsAfterReopen(receipts, T + 9_000);
    check('5.13g al reconectar: el que estaba en cola sigue esperando su acuse, con el plazo desde ahora',
      after.get('queued')?.queued === false && after.get('queued')?.sentAt === T + 9_000 && after.get('queued')?.phase === 'sending',
      json(after.get('queued')));
    check('5.13h el que salio por el socket caido se olvida; el ya entregado no se toca',
      !after.has('live') && after.get('done') === receipts.get('done'), json([...after.keys()]));
    const acked = applySubmitAck(after, { terminalId: 'queued', requestId: 'r-queued', delivered: true }, T + 9_500);
    check('5.13i y su acuse, que llega por el socket nuevo, cuenta', acked.get('queued')?.phase === 'delivered' &&
      acked.get('queued')?.deliveredAt === T + 9_500, json(acked.get('queued')));
    check('5.13j un acuse de otro envio, o de una pestana sin envio, no cambia nada',
      applySubmitAck(after, { terminalId: 'queued', requestId: 'r-viejo', delivered: true }, T) === after &&
        applySubmitAck(after, { terminalId: 'otra', requestId: 'r-queued', delivered: true }, T) === after);
    check('5.13k no entregado: se olvida el envio',
      !applySubmitAck(after, { terminalId: 'queued', requestId: 'r-queued', delivered: false }, T).has('queued'));

    const live = receipt({ phase: 'sending', deliveredAt: null });
    check('5.13l sin acuse, "Enviando" dura el plazo; despues manda la actividad',
      kind({ receipt: live, now: T + status.SUBMIT_ACK_TIMEOUT_MS - 1 }) === 'sending' &&
        kind({ receipt: live, now: T + status.SUBMIT_ACK_TIMEOUT_MS }) === null &&
        kind({ receipt: live, activity: 'busy', now: T + status.SUBMIT_ACK_TIMEOUT_MS }) === 'working');
    check('5.13m en la cola de la conexion espera lo que haga falta',
      kind({ receipt: receipt({ phase: 'sending', queued: true, deliveredAt: null }), now: T + 10 * status.SUBMIT_ACK_TIMEOUT_MS }) === 'sending');
    const late = applySubmitAck(new Map([['t1', live]]), { terminalId: 't1', requestId: 'submit-1', delivered: true }, T + 70_000);
    check('5.13n un acuse que llega pasado el plazo todavia cuenta',
      kind({ receipt: late.get('t1'), now: T + 70_500 }) === 'delivered');
  }

  // Arreglo 4: "todavia sin respuesta" tiene tope, y una CLI que todavia no publico estado no cae ahi.
  check('5.13o "sin respuesta" se va pasado el tope',
    kind({ activity: 'unknown', receipt: receipt(), now: T + 500 + status.AWAITING_REPLY_HOLD_MS - 1 }) === 'awaiting-reply' &&
      kind({ activity: 'unknown', receipt: receipt(), now: T + 500 + status.AWAITING_REPLY_HOLD_MS }) === null);
  check('5.13p sin actividad todavia (una CLI con estado que no lo publico): "Entregado", no "sin respuesta"',
    kind({ activity: null, receipt: receipt() }) === 'delivered' &&
      kind({ activity: null, receipt: receipt(), now: T + 500 + status.DELIVERED_HOLD_MS }) === null);

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

// --- 6. Cargar los anteriores al subir (0.5.0) -------------------------------------
//
// Lo que se rompe sin verse: una conversación que pide todo su historial al
// abrirse, o una carga que deja la vista arriba de lo recién llegado y pide
// otra página, y otra, hasta traer la sesión entera.
{
  const { shouldLoadEarlier, wheelAsksEarlier, scrollTopAfterPrepend, isPrepend, earlierThresholdPx } =
    await import('../../web/src/thread-scroll.ts');
  const at = (scrollTop, previousScrollTop, extra = {}) =>
    shouldLoadEarlier({ scrollTop, previousScrollTop, clientHeight: 600, hasMore: true, loading: false, ...extra });

  check('6.1 sin subir no pide: bajar, quedarse quieto o abrir arriba de todo',
    !at(150, 100) && !at(150, 150) && !at(0, 0));
  check('6.2 subiendo a una pantalla del borde, pide', at(550, 700) && at(0, 40));
  check('6.3 subiendo lejos del borde, todavía no', !at(2_000, 2_100));
  check('6.4 con un pedido en camino o sin nada más que pedir, no pide',
    !at(100, 300, { loading: true }) && !at(100, 300, { hasMore: false }));
  check('6.5 la anticipación nunca baja de 200 px, aunque la ventana sea baja',
    earlierThresholdPx(100) === 200 && shouldLoadEarlier({ scrollTop: 180, previousScrollTop: 300, clientHeight: 100, hasMore: true, loading: false }));
  check('6.6 la rueda hacia arriba pegada al borde cuenta como subir; hacia abajo, no',
    wheelAsksEarlier(-40, 0, 600) && !wheelAsksEarlier(40, 0, 600) && !wheelAsksEarlier(-40, 5_000, 600));
  check('6.7 al sumar arriba la vista queda a la misma distancia del final, y nunca por encima de 0',
    scrollTopAfterPrepend(1_000, 5_000) === 4_000 && scrollTopAfterPrepend(1_000, 800) === 0);
  check('6.9 con una búsqueda escrita no pide: saltar a un acierto no es subir, y cada página nueva movía el acierto más arriba',
    !at(100, 300, { searching: true }) && at(100, 300, { searching: false }));
  check('6.8 es una carga de anteriores si el que era primero sigue, más abajo',
    isPrepend('a', ['x', 'y', 'a', 'b']) && !isPrepend('a', ['a', 'b', 'c']) && !isPrepend('a', ['m', 'n']) &&
      !isPrepend(null, ['a']) && !isPrepend('a', []));
}

// --- 7. Ir a tu mensaje anterior (06-10-2026, uno por uno desde el 07-10) ----------
//
// Lo que se rompe sin verse: una flecha hacia arriba que lleva hacia abajo o al
// mismo mensaje otra vez, un resultado de herramienta tomado por un mensaje del
// usuario, o una busqueda en las paginas anteriores que no termina nunca y trae
// la sesion entera.
{
  const { ownMessageIds, nearestOwnAbove, offerJumpToOwn, scrollTopForOwn, ownSeekStep, OWN_MESSAGE_MARGIN_PX, OWN_MESSAGE_MAX_PAGES } =
    await import('../../web/src/thread-scroll.ts');
  const ev = (eventId, role, ...kinds) => ({ eventId, role, parts: kinds.map((kind) => ({ kind })) });
  const nearest = (tops) => nearestOwnAbove(tops.length, (index) => tops[index]);

  check('7.1 los mensajes propios son los `user` con texto o imagen, en orden; no los resultados de herramienta',
    json(ownMessageIds([ev('u1', 'user', 'text'), ev('a1', 'assistant', 'text'), ev('u2', 'user', 'image'),
      ev('a2', 'assistant', 'tool-call'), ev('r1', 'user', 'tool-result'), ev('a3', 'assistant', 'text')])) === json(['u1', 'u2']));
  check('7.2 sin ningun mensaje propio cargado, ninguno',
    ownMessageIds([ev('a1', 'assistant', 'text'), ev('r1', 'user', 'tool-result')]).length === 0 && ownMessageIds([]).length === 0);

  check('7.3 lleva al mas cercano por encima de la vista, no al ultimo de todos', nearest([-3_000, -1_200, 40, 900]) === 1);
  check('7.4 el que quedo arriba de la vista despues de un salto ya no cuenta: el siguiente es el anterior',
    nearest([-1_788, OWN_MESSAGE_MARGIN_PX, 1_252]) === 0 && nearest([OWN_MESSAGE_MARGIN_PX, 1_412]) === null);
  check('7.5 uno que asoma apenas no cuenta, y uno sin dibujar se salta',
    nearest([-4]) === null && nearest([-500, null]) === 0);

  const offer = (awayFromEnd, ownAbove, hasMore = false) => offerJumpToOwn({ awayFromEnd, ownAbove, hasMore });
  check('7.6 aparece con "Ir al final" y un mensaje propio por encima', offer(true, true));
  check('7.7 al final no aparece, aunque haya mensajes arriba', !offer(false, true) && !offer(false, false, true));
  check('7.8 sin ninguno cargado arriba aparece si hay paginas donde buscarlo; en el primero de la sesion, no',
    offer(true, false, true) && !offer(true, false, false));

  check('7.9 el salto deja el mensaje arriba de la vista, con su aire, y nunca por encima de 0',
    scrollTopForOwn(5_000, -1_200) === 3_800 - OWN_MESSAGE_MARGIN_PX && scrollTopForOwn(100, -300) === 0);

  // Un hilo de mentira: cuatro mensajes propios en estas alturas, la vista abajo.
  const offsets = [100, 1_500, 4_000, 7_000];
  let scrollTop = 7_600;
  const visited = [];
  for (let jumps = 0; jumps < 10; jumps += 1) {
    const index = nearest(offsets.map((offset) => offset - scrollTop));
    if (index === null) break;
    visited.push(index);
    scrollTop = scrollTopForOwn(scrollTop, offsets[index] - scrollTop);
  }
  check('7.10 clic tras clic recorre los mensajes de abajo hacia arriba, uno por uno, y en el primero se acaba',
    json(visited) === json([3, 2, 1, 0]) && !offer(true, nearest(offsets.map((offset) => offset - scrollTop)) !== null),
    json({ visited, scrollTop }));

  const step = (extra) => ownSeekStep({ found: false, hasMore: true, loading: false, pagesRequested: 0, ...extra });
  check('7.11 sin ninguno cargado arriba pide una pagina; con una en camino, espera; cuando aparece, salta',
    step({}) === 'load' && step({ loading: true, pagesRequested: 1 }) === 'wait' &&
      step({ found: true, pagesRequested: 3 }) === 'jump' && step({ found: true, loading: true }) === 'jump');
  check('7.12 sin mas paginas, o pasado el tope, se rinde: no trae la sesion entera',
    step({ hasMore: false, pagesRequested: 2 }) === 'give-up' &&
      step({ pagesRequested: OWN_MESSAGE_MAX_PAGES }) === 'give-up' && step({ pagesRequested: OWN_MESSAGE_MAX_PAGES - 1 }) === 'load');
}

// --- 8. Volver a una pestana donde se habia subido a leer (11-10-2026) -------------
//
// El hilo es uno solo para todas las pestanas y cada una abre al final. Subir a
// mano se recuerda por pestana: al volver queda donde estaba. Lo que se rompe
// sin verse: volver unos pixeles mas arriba o mas abajo, o quedar clavado en un
// sitio que ya no existe.
{
  const { ANCHOR_SLACK_PX, arrivedSince, scrollTopForAnchor, threadAnchorOf } =
    await import('../../web/src/thread-scroll.ts');
  const pulse = await import('../../web/src/attention-pulse.ts');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

  // Un hilo de mentira: cada tarjeta mide 300 px y empieza en `tops[id]`.
  const HEIGHT = 300;
  const layout = (tops, scrollTop) => (id) =>
    tops[id] === undefined ? null : { top: tops[id] - scrollTop, bottom: tops[id] + HEIGHT - scrollTop };
  const tops = { a: 0, b: 300, c: 600, d: 900, e: 1_200 };
  const ids = ['a', 'b', 'c', 'd', 'e'];

  const left = threadAnchorOf(ids, layout(tops, 700));
  check('8.1 el ancla es la primera tarjeta que se ve, con lo que asomaba, y la ultima que habia',
    json(left) === json({ eventId: 'c', offset: -100, lastId: 'e' }), json(left));
  check('8.2 una tarjeta que termina justo en el borde no se ve: ancla la siguiente',
    threadAnchorOf(ids, layout(tops, 600))?.eventId === 'c' && threadAnchorOf(ids, layout(tops, 600 - ANCHOR_SLACK_PX - 1))?.eventId === 'b');
  check('8.3 una tarjeta sin dibujar (adentro de una tanda plegada) no ancla',
    threadAnchorOf(ids, (id) => (id === 'c' ? null : layout(tops, 700)(id)))?.eventId === 'd');
  check('8.4 sin ninguna tarjeta a la vista no hay ancla', threadAnchorOf([], layout(tops, 0)) === null && threadAnchorOf(ids, () => null) === null);

  // Al volver el hilo se pide de nuevo: arranca arriba (scrollTop 0) y puede medir otra cosa.
  check('8.5 al volver, la tarjeta queda donde estaba', scrollTopForAnchor(left, ids, layout(tops, 0), 0) === 700);
  const grown = { a: 0, b: 300, c: 900, d: 1_200, e: 1_500 };
  check('8.6 aunque lo de arriba haya cambiado de alto: manda la tarjeta, no los pixeles',
    scrollTopForAnchor(left, ids, layout(grown, 0), 0) === 1_000);
  check('8.7 con lo que llego mientras tanto al final, igual',
    scrollTopForAnchor(left, [...ids, 'f', 'g'], layout({ ...tops, f: 1_500, g: 1_800 }, 0), 0) === 700);
  check('8.8 si la tarjeta volvio plegada, la siguiente dibujada, pegada arriba',
    scrollTopForAnchor(left, ids, (id) => (id === 'c' ? null : layout(tops, 0)(id)), 0) === 900);
  check('8.9 si ya no esta cargada, o no queda ninguna dibujada, no hay donde volver: abre al final',
    scrollTopForAnchor(left, ['x', 'y'], layout({ x: 0, y: 300 }, 0), 0) === null &&
      scrollTopForAnchor(left, ids, () => null, 0) === null);
  check('8.10 nunca por encima del principio',
    scrollTopForAnchor({ eventId: 'a', offset: 50, lastId: 'e' }, ids, layout(tops, 0), 0) === 0);

  check('8.11 lo que llego despues de la que era la ultima se cuenta',
    arrivedSince([...ids, 'f', 'g'], 'e') === 2 && arrivedSince(ids, 'e') === 0);
  check('8.12 si la ultima ya no esta cargada, o no habia ninguna, no se inventa una cuenta',
    arrivedSince(['x', 'y'], 'e') === 0 && arrivedSince(ids, null) === 0);
  // El aviso de "Ir al final" (12-10-2026): dos pulsos de 300 ms, con su texto a la vista.
  check('8.13 el aviso son dos pulsos de 300 ms, y la marca dura lo que la animacion entera',
    pulse.PULSE_MS === 300 && pulse.PULSE_COUNT === 2 && pulse.PULSE_GAP_MS > 0 &&
      pulse.PULSE_ANIMATION_MS === pulse.PULSE_COUNT * (pulse.PULSE_MS + pulse.PULSE_GAP_MS),
    json({ ms: pulse.PULSE_MS, count: pulse.PULSE_COUNT, total: pulse.PULSE_ANIMATION_MS }));
  const hintRule = css.match(/\.conversation-jump\.is-hinting\s*\{([^}]*)\}/)?.[1] ?? '';
  check('8.14 la animacion del boton dice lo mismo: una vuelta por pulso, sin fundido',
    hintRule.includes(`animation: jump-hint ${pulse.PULSE_CYCLE_MS}ms step-end ${pulse.PULSE_COUNT};`), hintRule.trim());
  const hintFrames = css.match(/@keyframes jump-hint\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  check('8.15 y se apaga donde termina el pulso: encendido como con el mouse encima, apagado como siempre',
    /0%\s*\{[^}]*border-color: var\(--accent\);[^}]*color: var\(--accent\);/.test(hintFrames) &&
      new RegExp(`${pulse.PULSE_OFF_PERCENT}%,\\s*100%\\s*\\{[^}]*border-color: var\\(--border\\);[^}]*color: var\\(--text\\);`).test(hintFrames),
    hintFrames.replace(/\s+/g, ' ').trim());
  check('8.16 el texto del boton tiene donde mostrarse mientras dura el aviso',
    /\.conversation-jump-tip\s*\{[^}]*position: absolute;[^}]*white-space: nowrap;/.test(css));
}

// --- 9. Copiar debajo de una flecha flotante (13-10-2026) ---------------------------
//
// Copiar y "volver aqui" van arriba a la derecha de cada mensaje, justo donde
// flota "Ir a tu mensaje anterior". Lo que se rompe sin verse: que se corran los
// de todos los mensajes, que el corrido vuelva a su sitio en el dibujo siguiente
// (y otra vez afuera, parpadeando), o que el CSS y la cuenta dejen de coincidir.
{
  const { turnActionsShift, TURN_ACTIONS_INSET_PX, TURN_ACTIONS_GAP_PX } = await import('../../web/src/thread-scroll.ts');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height });
  // La flecha: 34 x 32, a 16 px del borde derecho de un hilo de 700 y a 12 del de arriba.
  const jump = box(650, 12, 34, 32);
  // Un mensaje de 660 de ancho, y sus dos botones (50 x 22) en su esquina.
  const turnAt = (top) => box(20, top, 660, 120);
  const actionsOf = (turn, shift = 0) => box(turn.right - TURN_ACTIONS_INSET_PX - 50 - shift, turn.top + TURN_ACTIONS_INSET_PX, 50, 22);

  const under = turnAt(8);
  const shift = turnActionsShift(under, actionsOf(under), jump);
  check('9.1 los botones del mensaje que quedo debajo de la flecha se corren lo justo para salir, con su aire',
    shift === under.right - TURN_ACTIONS_INSET_PX - (jump.left - TURN_ACTIONS_GAP_PX) && shift > 0 && shift < 60, String(shift));
  check('9.2 ya corridos, la cuenta da lo mismo: se mide contra su sitio sin correr, no contra donde estan',
    turnActionsShift(under, actionsOf(under, shift), jump) === shift);
  check('9.3 un mensaje mas abajo o mas arriba no se toca',
    turnActionsShift(turnAt(60), actionsOf(turnAt(60)), jump) === 0 && turnActionsShift(turnAt(-40), actionsOf(turnAt(-40)), jump) === 0);
  check('9.4 el que apenas asoma por debajo de la flecha tambien se corre; con el aire de por medio, ya no',
    turnActionsShift(turnAt(40), actionsOf(turnAt(40)), jump) > 0 && turnActionsShift(turnAt(46), actionsOf(turnAt(46)), jump) === 0);
  const narrow = box(20, 8, 500, 120);
  check('9.5 un mensaje que no llega hasta la flecha no se toca', turnActionsShift(narrow, actionsOf(narrow), jump) === 0);
  check('9.6 unos botones sin tamano —escondidos— no se corren', turnActionsShift(under, box(0, 0, 0, 0), jump) === 0);
  // Lo mismo con "Ir al final", abajo: la cuenta no sabe cual de las dos flechas es.
  const jumpEnd = box(650, 556, 34, 32);
  check('9.7 vale igual para la flecha de abajo', turnActionsShift(turnAt(560), actionsOf(turnAt(560)), jumpEnd) > 0);

  const actionsRule = /\.turn-actions\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  check('9.8 el CSS pone los botones donde la cuenta cree, y los corre con la variable que deja la vista',
    new RegExp(`top:\\s*${TURN_ACTIONS_INSET_PX}px;`).test(actionsRule) &&
      actionsRule.includes(`right: calc(${TURN_ACTIONS_INSET_PX}px + var(--turn-actions-shift, 0px));`),
    actionsRule.replace(/\s+/g, ' ').trim().slice(0, 200));
  const view = readFileSync(new URL('../../web/src/ConversationView.tsx', import.meta.url), 'utf8');
  check('9.9 la vista deja esa variable solo en el mensaje que quedo debajo, y la saca cuando deja de estarlo',
    view.includes("turn.style.setProperty('--turn-actions-shift'") && view.includes("turn.style.removeProperty('--turn-actions-shift')"));
}

// --- 10. La cola de la CLI (hito 45, §4.4.3, §6.35) ------------------------------
//
// Las lineas imitan las medidas con la 2.1.301 (c11 y c12): `enqueue` con el
// texto, un `popAll` por mensaje al sacarlos con la flecha arriba, el `enqueue`
// de lo editado con los dos juntos, `remove` al entregarlo a mitad del turno y
// `dequeue` al terminar.

const { PromptQueueTracker } = await import('../src/agents/claude-code/prompt-queue.ts');
const { IDLE_CLEARS_QUEUE_MS } = await import('../src/conversation-hub.ts');

const queueOp = (operation, content, seconds, extra = {}) => ({
  type: 'queue-operation',
  operation,
  timestamp: at(seconds),
  sessionId: 's',
  ...(content === undefined ? {} : { content }),
  ...extra,
});
const wrappedPaste = (id, text) => `<pasted_content id="${id}">\n${text}\n</pasted_content id="${id}">`;
const texts = (list) => list.map((prompt) => prompt.text).join(' | ');
const humanQueued = (uuid, prompt, seconds) => ({
  type: 'attachment',
  uuid,
  parentUuid: null,
  timestamp: at(seconds),
  isSidechain: false,
  attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } },
});

{
  const tracker = new PromptQueueTracker();
  tracker.observe(queueOp('enqueue', 'Mensaje B en cola', 45));
  const first = tracker.pending(LAUNCHED_AT);
  check('10.1 un enqueue del usuario queda en cola, con su hora', texts(first) === 'Mensaje B en cola' && first[0]?.at === Date.parse(at(45)), json(first));
  tracker.observe(queueOp('enqueue', wrappedPaste('dae8', 'Mensaje C en cola\nsegunda linea'), 48));
  check('10.2 lo pegado sale sin el envoltorio de la CLI',
    texts(tracker.pending(LAUNCHED_AT)) === 'Mensaje B en cola | Mensaje C en cola\nsegunda linea', json(tracker.pending(LAUNCHED_AT)));
  check('10.3 cada mensaje con su id, distinto y estable',
    json(tracker.pending(LAUNCHED_AT).map((prompt) => prompt.id)) === json(tracker.pending(LAUNCHED_AT).map((prompt) => prompt.id)) &&
      new Set(tracker.pending(LAUNCHED_AT).map((prompt) => prompt.id)).size === 2);
  tracker.observe(queueOp('popAll', 'Mensaje B en cola', 51));
  tracker.observe(queueOp('popAll', wrappedPaste('dae8', 'Mensaje C en cola\nsegunda linea'), 51));
  check('10.4 la flecha arriba los saca a los dos (un popAll por mensaje)', tracker.pending(LAUNCHED_AT).length === 0);
  const merged = `Mensaje B en cola\n${wrappedPaste('dae8', 'Mensaje C en cola\nsegunda linea')}`;
  tracker.observe(queueOp('enqueue', merged, 58));
  check('10.5 lo editado vuelve como un solo mensaje',
    tracker.pending(LAUNCHED_AT).length === 1 && texts(tracker.pending(LAUNCHED_AT)) === 'Mensaje B en cola\nMensaje C en cola\nsegunda linea',
    json(tracker.pending(LAUNCHED_AT)));
  tracker.observe(queueOp('remove', merged, 65, { reason: 'absorbed_mid_turn', commandUuid: 'c1', deliveryId: 'd1' }));
  check('10.6 entregado a mitad del turno (remove con su texto), sale', tracker.pending(LAUNCHED_AT).length === 0);

  tracker.observe(queueOp('enqueue', notification('a1', 'toolu_X'), 70));
  tracker.observe(queueOp('enqueue', 'el que sigue', 71));
  check('10.7 un aviso del agente no se muestra', texts(tracker.pending(LAUNCHED_AT)) === 'el que sigue');
  tracker.observe(queueOp('dequeue', undefined, 72));
  check('10.8 dequeue saca el primero de la cola: el aviso, no el mensaje', texts(tracker.pending(LAUNCHED_AT)) === 'el que sigue');
  tracker.observe(queueOp('dequeue', undefined, 73));
  check('10.9 el segundo dequeue entrega el mensaje', tracker.pending(LAUNCHED_AT).length === 0);
  tracker.observe(queueOp('enqueue', '<agent-message from="x">informe</agent-message>', 74));
  check('10.10 un <agent-message> tampoco es del usuario', tracker.pending(LAUNCHED_AT).length === 0);
  tracker.observe(queueOp('remove', 'uno que no estaba', 75, { reason: 'absorbed_mid_turn' }));
  tracker.observe(queueOp('operacion-nueva', undefined, 75));
  check('10.11 un remove sin su enqueue, o una operacion sin texto, no tocan nada', tracker.pending(LAUNCHED_AT).length === 0);

  const old = new PromptQueueTracker();
  old.observe({ ...queueOp('enqueue', 'de un proceso que murio', 0), timestamp: BEFORE });
  old.observe(queueOp('enqueue', 'del proceso de ahora', 80));
  check('10.12 lo de un proceso anterior no se muestra', texts(old.pending(LAUNCHED_AT)) === 'del proceso de ahora');
  old.observe(queueOp('dequeue', undefined, 90));
  check('10.13 y se olvida: el dequeue de ahora entrega el de ahora, no el viejo', old.pending(LAUNCHED_AT).length === 0, json(old.pending(LAUNCHED_AT)));

  const pasted = path.join(root, 'temporal', 'agent-workbench', 'pasted', 't1', 'pegada-1-0a1b2c3d.png');
  const withImage = new PromptQueueTracker();
  withImage.observe(queueOp('enqueue', `@"${pasted}" mira esto`, 81));
  const [image] = withImage.pending(LAUNCHED_AT);
  check('10.14 una imagen pegada se cuenta y sale del texto', image?.images === 1 && image.text === 'mira esto', json(image));
  const noTime = new PromptQueueTracker();
  noTime.observe({ type: 'queue-operation', operation: 'enqueue', content: 'sin hora' });
  check('10.15 un enqueue sin hora no se atribuye a ningun proceso', noTime.pending(0).length === 0);
  withImage.reset();
  check('10.16 reset olvida todo', withImage.pending(LAUNCHED_AT).length === 0);
  const long = new PromptQueueTracker();
  long.observe(queueOp('enqueue', 'x'.repeat(shared.MAX_QUEUED_PROMPT_CHARS + 50), 82));
  const [cut] = long.pending(LAUNCHED_AT);
  check('10.17 un texto largo viaja recortado y marcado', cut?.text.length === shared.MAX_QUEUED_PROMPT_CHARS && cut.truncated === true);
}

// El seguidor de verdad, sobre un archivo: la cola sale de lineas que no son tarjetas.
{
  const file = path.join(root, 'cola.jsonl');
  await writeFile(file, lines(userText('u1', 'hola'), assistantText('a1', 'trabajando'), queueOp('enqueue', 'Mensaje B', 45)));
  const follower = new ConversationFollower(file);
  await follower.poll();
  check('10.20 el seguidor dice la cola', texts(follower.queuedPrompts(LAUNCHED_AT)) === 'Mensaje B');
  await appendFile(file, lines(queueOp('remove', 'Mensaje B', 60, { reason: 'absorbed_mid_turn' }), humanQueued('q1', 'Mensaje B', 45)));
  const read = await follower.poll();
  check('10.21 entregado: sale de la cola y llega al hilo como "enviado mientras trabajaba"',
    follower.queuedPrompts(LAUNCHED_AT).length === 0 && read.added.length === 1 && read.added[0].queued === true, json(read.added));
}

// El hub: la cola en el snapshot, sola cuando no hay mensajes, y dentro del append que la cambia.
{
  const cwd = path.join(root, 'proyecto-cola');
  await mkdir(cwd, { recursive: true });
  const sessionId = '7a1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4c';
  const file = sessionFilePath(cwd, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, lines(userText('u1', 'hola'), assistantText('a1', 'trabajando')));

  const variants = new ModelVariantRegistry();
  const claudeAdapter = {
    id: 'claude-code',
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: true, forceSend: true },
    status: null,
    promptQueue: { source: 'session', forceSend: 'ctrl-x-ctrl-s' },
    history: { follow: (target) => new ClaudeCodeSessionFollower(target.cwd, target.sessionId, variants), plans: null },
  };
  // Una CLI cuya cola lleva la app: el seguidor dice lo que haya en `appEvents`.
  let appEvents = [];
  const appFollower = {
    label: 'app', start: async () => undefined,
    poll: async () => ({ reset: false, added: appEvents.splice(0), turns: [], plans: [], parts: [] }),
    getState: () => 'live', getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }), getPermissionMode: () => null,
    getTail: () => ({ events: tail, hasMore: false }), getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [], readImage: async () => null, noticeChange: () => true, hasOpenToolCall: () => false,
  };
  let tail = [];
  const appAdapter = {
    id: 'pi',
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: true, forceSend: true },
    status: null,
    promptQueue: { source: 'app', forceSend: 'interrupt-and-resend' },
    history: { follow: () => appFollower, plans: null },
  };
  const adapters = { 'claude-code': claudeAdapter, pi: appAdapter };
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
  descriptors.set('t-cola', describe('t-cola', 'claude-code'));
  descriptors.set('t-app', describe('t-app', 'pi'));

  const hub = new ConversationHub(registry, agents);
  try {
    const snapshot = await hub.subscribe('t-cola');
    check('10.30 sin nada en cola, el reset no trae nada', snapshot !== null && hub.getQueue('t-cola').length === 0);

    const queued = nextEvent(hub, 'queue');
    await appendFile(file, lines(queueOp('enqueue', 'Mensaje B en cola', 45)));
    hub.onHistoryChanged('claude-code', file);
    const queuedArgs = await queued;
    check('10.31 un enqueue sin mensajes nuevos llega como "queue", con el mensaje',
      queuedArgs !== null && queuedArgs[0] === 't-cola' && texts(queuedArgs[1]) === 'Mensaje B en cola', json(queuedArgs));
    check('10.32 y getQueue dice lo mismo (es lo que lleva un reset)', texts(hub.getQueue('t-cola')) === 'Mensaje B en cola');
    check('10.33 hasQueue: hay algo que forzar', hub.hasQueue('t-cola'));

    const appended = nextEvent(hub, 'append');
    const loose = [];
    const looseListener = (terminalId, queue) => loose.push([terminalId, queue.length]);
    hub.on('queue', looseListener);
    await appendFile(file, lines(queueOp('remove', 'Mensaje B en cola', 60, { reason: 'absorbed_mid_turn' }), humanQueued('q-cola', 'Mensaje B en cola', 45)));
    hub.onHistoryChanged('claude-code', file);
    const appendArgs = await appended;
    hub.off('queue', looseListener);
    check('10.34 entregado: el mensaje y la cola vacia llegan en el mismo append, sin aviso suelto',
      appendArgs !== null && appendArgs[1].some((event) => event.eventId === 'q-cola') && json(appendArgs[4]) === '[]' && loose.length === 0,
      json({ cola: appendArgs?.[4], sueltos: loose }));

    const again = nextEvent(hub, 'queue');
    await appendFile(file, lines(queueOp('enqueue', 'Mensaje C', 70)));
    hub.onHistoryChanged('claude-code', file);
    await again;
    const emptied = nextEvent(hub, 'queue', IDLE_CLEARS_QUEUE_MS + 3_000);
    const idleAt = Date.now();
    registry.emit('activity', 't-cola', 'idle', null);
    registry.emit('activity', 't-cola', 'idle', null);
    const emptiedArgs = await emptied;
    check('10.35 libre un rato, la cola se vacia (la red por si la CLI cambia lo que escribe)',
      emptiedArgs !== null && emptiedArgs[1].length === 0 && Date.now() - idleAt >= IDLE_CLEARS_QUEUE_MS - 50, json(emptiedArgs));
    registry.emit('activity', 't-cola', 'busy', null);

    const gone = nextEvent(hub, 'queue');
    launchedAt = null;
    registry.emit('changed');
    const goneArgs = await gone;
    check('10.36 sin pty no hay cola', goneArgs !== null && goneArgs[1].length === 0 && hub.getQueue('t-cola').length === 0, json(goneArgs));
    launchedAt = LAUNCHED_AT;

    // La cola que lleva la app (Pi, Antigravity).
    await hub.subscribe('t-app');
    const noted = nextEvent(hub, 'queue');
    const sentAt = Date.now();
    hub.noteQueued('t-app', { text: 'Mensaje B', images: 0, at: sentAt });
    const notedArgs = await noted;
    check('10.40 lo mandado con el agente trabajando queda en cola', notedArgs !== null && texts(notedArgs[1]) === 'Mensaje B', json(notedArgs));
    const forced = nextEvent(hub, 'queue');
    hub.markQueueForced('t-app');
    const forcedArgs = await forced;
    check('10.41 forzado, sigue en cola marcado', forcedArgs?.[1][0]?.forced === true, json(forcedArgs));

    const delivered = { eventId: 'pi-u2', role: 'user', at: sentAt + 300, parts: [{ kind: 'text', text: 'Mensaje B', truncated: false }],
      model: null, usage: null, effort: null, durationMs: null, queued: true };
    appEvents = [delivered];
    tail = [delivered];
    const settled = nextEvent(hub, 'append');
    hub.onHistoryChanged('pi', 'x');
    const settledArgs = await settled;
    check('10.42 aparece en el hilo: sale de la cola en el mismo append', settledArgs !== null && json(settledArgs[4]) === '[]', json(settledArgs?.[4]));

    hub.noteQueued('t-app', { text: 'otro', images: 1, at: Date.now() });
    const cleared = nextEvent(hub, 'queue');
    hub.clearQueued('t-app');
    check('10.43 Detener lo devuelve al cuadro: sale de la cola', (await cleared)?.[1].length === 0);
    hub.noteQueued('t-app', { text: 'uno mas', images: 0, at: Date.now() });
    const offline = nextEvent(hub, 'queue');
    registry.emit('activity', 't-app', 'offline', null);
    check('10.44 sin proceso tampoco', (await offline)?.[1].length === 0);
  } finally {
    hub.disposeAll();
  }
}

// El protocolo de la cola y de forzar el envio.
{
  const { parseServerMessage, parseClientMessage } = shared;
  const base = {
    type: 'conversation.reset', terminalId: 't1', sessionId: 's', state: 'live', events: [], hasMore: false,
    usage: shared.EMPTY_CONTEXT_USAGE, permissionMode: null, defaults: { model: null, effort: null, contextWindow: null },
    waitingFor: null, openToolCall: false, subagents: [],
  };
  check('10.50 un reset de un servidor anterior, sin cola, se lee con la cola vacia', json(parseServerMessage(JSON.stringify(base))?.queue) === '[]');
  const good = { id: 'queue-1', text: 'hola', truncated: false, images: 0, at: 5 };
  const read = parseServerMessage(JSON.stringify({ ...base, queue: [good, { id: '', text: 'x', images: 0, at: 1 }, 'basura', { ...good, id: 'q2', eventId: 'msg_1', forced: true }] }));
  check('10.51 un mensaje en cola que no se entiende se descarta solo; eventId y forced se leen',
    json(read?.queue) === json([good, { ...good, id: 'q2', eventId: 'msg_1', forced: true }]), json(read?.queue));
  const many = Array.from({ length: 40 }, (_, index) => ({ ...good, id: `q${index}`, text: 'y'.repeat(shared.MAX_QUEUED_PROMPT_CHARS + 10) }));
  const update = parseServerMessage(JSON.stringify({ type: 'conversation.queue', terminalId: 't1', queue: many }));
  check('10.52 conversation.queue: con tope de cantidad y de texto, y el recorte marcado',
    update?.type === 'conversation.queue' && update.queue.length === shared.MAX_QUEUED_PROMPTS &&
      update.queue[0].text.length === shared.MAX_QUEUED_PROMPT_CHARS && update.queue[0].truncated === true);
  check('10.53 conversation.queue sin lista no se lee', parseServerMessage(JSON.stringify({ type: 'conversation.queue', terminalId: 't1' })) === null);
  const append = { type: 'conversation.append', terminalId: 't1', events: [], usage: shared.EMPTY_CONTEXT_USAGE, permissionMode: null };
  const withQueue = parseServerMessage(JSON.stringify({ ...append, queue: [] }));
  const withoutQueue = parseServerMessage(JSON.stringify(append));
  check('10.54 un append con la cola la trae (vacia es vacia); sin ella, no la inventa',
    json(withQueue?.queue) === '[]' && withoutQueue !== null && !('queue' in withoutQueue));
  const ask = parseClientMessage(JSON.stringify({ type: 'agent.forceSend', terminalId: 't1', requestId: 'r1' }));
  check('10.55 agent.forceSend con su requestId; sin el, no se lee',
    ask?.type === 'agent.forceSend' && ask.requestId === 'r1' &&
      parseClientMessage(JSON.stringify({ type: 'agent.forceSend', terminalId: 't1' })) === null);
  const answer = parseServerMessage(JSON.stringify({ type: 'agent.forceSent', terminalId: 't1', requestId: 'r1', sent: false }));
  check('10.56 agent.forceSent, hecho o no; sin sent no se lee',
    answer?.type === 'agent.forceSent' && answer.sent === false &&
      parseServerMessage(JSON.stringify({ type: 'agent.forceSent', terminalId: 't1', requestId: 'r1' })) === null);
  const failed = parseServerMessage(JSON.stringify({ type: 'error', code: 'force-send-failed', text: { key: 'forceSendNothing' }, requestId: 'r1' }));
  check('10.57 force-send-failed es un codigo de error y no cae a internal', failed?.code === 'force-send-failed', json(failed));
}

// Las teclas de forzar el envio: las medidas.
{
  const { buildForceSendKeys } = await import('../src/pty-input.ts');
  check('10.60 Claude Code: Ctrl+X Ctrl+S en un solo write', buildForceSendKeys('ctrl-x-ctrl-s') === '\x18\x13');
  check('10.61 Antigravity: Alt+M, Esc pegado a la letra', buildForceSendKeys('alt-m') === '\x1bm');
}

// --- 11. Sacar la cola para editarla (§6.35.1) ------------------------------------
//
// Las pantallas son las medidas el 23-10-2026 (Claude Code 2.1.309, Pi 1.3.0 y
// Antigravity 1.4.4, `c13` a `c15`, `s15`, `a16` y `a17`). Cada CLI de mentira
// cambia su pantalla con las teclas que se midieron, y nada mas.

const RULE = '─'.repeat(60);
const UP = '\x1b[A';
const CLEAR_LINE = '\x15\x0b';

/** Una CLI de mentira: la pantalla cambia con cada write segun `onWrite`. Reloj propio. */
function fakeCli(lines, onWrite, startAt = Date.parse('2026-10-23T15:36:05.000Z')) {
  const state = { lines, writes: [], clock: startAt, jsonl: [] };
  const io = {
    write: (data) => {
      state.writes.push(data);
      onWrite(data, state);
      return true;
    },
    screen: async () => state.lines,
    wait: async (ms) => {
      state.clock += ms;
    },
    now: () => state.clock,
  };
  return { io, state };
}

/** Cuantas veces dos teclas de borrar (Ctrl+U Ctrl+K) van en un write. */
const clearPairs = (data) => (data.length > 0 && data.replaceAll(CLEAR_LINE, '').length === 0 ? data.length / CLEAR_LINE.length : 0);

// Claude Code: la caja va entre dos reglas, con la marca y un espacio duro.
{
  const { readClaudeCodeBox, poppedPromptsIn, runClaudeCodeQueueEdit } = await import('../src/agents/claude-code/queue-edit.ts');
  const NB = '\u00a0';
  const screen = (box, top = RULE) => [
    '✻ Moonwalking… (8s · ↓ 122 tokens)',
    '',
    top,
    ...box.map((line, index) => (index === 0 ? `❯${NB}${line}`.trimEnd() : `  ${line}`)),
    RULE,
    '  5h 12% (3h 23m) · week 23% (3d 0h)',
    '  paste again to expand',
  ];
  const HINT = ['Press up to edit queued messages'];
  const POPPED = ['Mensaje B en cola', '[Pasted text #1 +4 lines]'];
  const B = 'Mensaje B en cola';
  const C = 'Mensaje C en cola\nsegunda linea\ntercera linea\ncuarta linea\nquinta linea';
  const popAll = (content, clock) => JSON.stringify({ type: 'queue-operation', operation: 'popAll', timestamp: new Date(clock).toISOString(), sessionId: 's', content });
  const target = { cwd: 'D:\\p', sessionId: 's' };
  const context = { target, queued: [], lastClearKeyAt: null };
  const deps = (state) => ({ popped: async (_target, since) => poppedPromptsIn(state.jsonl, since) });
  const timing = { step: { timeoutMs: 500, pollMs: 50 }, popTimeoutMs: 500 };

  check('11.1 la caja medida: lo de la cola, el texto que volvio, vacia, y el historial',
    json(readClaudeCodeBox(screen(HINT))) === json(HINT) &&
      json(readClaudeCodeBox(screen(POPPED))) === json(POPPED) &&
      json(readClaudeCodeBox(screen(['']))) === json(['']) &&
      json(readClaudeCodeBox(screen(['Usa una herramienta…', 'solo con la palabra LISTO.'], `─── History 94/94 ${RULE}`))) ===
        json(['Usa una herramienta…', 'solo con la palabra LISTO.']));

  /*
    La de mentira: la flecha saca la cola a la caja y escribe un popAll por
    mensaje; Ctrl+U Ctrl+K borran de a una linea; Ctrl+C con el agente
    trabajando cortaria el turno, y aca deja marca.
  */
  const cli = ({ queue = [B, `<pasted_content id="ae90">\n${C}\n</pasted_content id="ae90">`], box = HINT, history = null, upWorks = true, clearWorks = true } = {}) =>
    fakeCli(screen(box), (data, state) => {
      if (data === UP && upWorks) {
        if (queue.length > 0) {
          for (const content of queue) state.jsonl.push(popAll(content, state.clock + 140));
          state.lines = screen(POPPED);
          queue = [];
        } else if (history !== null) {
          state.lines = screen(history, `─── History 94/94 ${RULE}`);
        }
        return;
      }
      if (data.includes('\x03')) state.interrupted = true;
      const pairs = clearPairs(data);
      if (pairs > 0 && clearWorks) {
        const current = readClaudeCodeBox(state.lines) ?? [''];
        const left = current.slice(0, Math.max(0, current.length - pairs));
        state.lines = screen(left.length === 0 ? [''] : left);
      }
    });

  {
    const { io, state } = cli();
    const outcome = await runClaudeCodeQueueEdit(io, context, deps(state), timing);
    check('11.2 la cola sale con la flecha y vuelve entera, sin el envoltorio de lo pegado',
      outcome.kind === 'done' && json(outcome.texts) === json([B, C]), json(outcome));
    check('11.3 la primera tecla es la flecha, despues solo Ctrl+U Ctrl+K, y nunca un Ctrl+C (corta el turno, c13)',
      state.writes[0] === UP && state.writes.slice(1).every((data) => clearPairs(data) > 0) && state.interrupted !== true,
      json(state.writes));
    check('11.4 la caja queda vacia', json(readClaudeCodeBox(state.lines)) === json(['']));
  }
  {
    const { io, state } = cli({ box: ['algo que tecleo en la solapa CLI'] });
    const outcome = await runClaudeCodeQueueEdit(io, context, deps(state), timing);
    check('11.5 con texto en la caja no se escribe nada', outcome.kind === 'failed' && outcome.reason === 'editor-busy' && state.writes.length === 0, json(outcome));
  }
  {
    const { io, state } = cli({ box: [''] });
    const outcome = await runClaudeCodeQueueEdit(io, context, deps(state), timing);
    check('11.6 sin lo de la cola en la caja no se escribe nada', outcome.kind === 'failed' && outcome.reason === 'no-queue-on-screen' && state.writes.length === 0, json(outcome));
  }
  {
    // La CLI lo entrego justo antes: la flecha trae el historial, sin popAll.
    const { io, state } = cli({ queue: [], history: ['Mensaje B en cola'] });
    const outcome = await runClaudeCodeQueueEdit(io, context, deps(state), timing);
    check('11.7 sin popAll, lo que trajo la flecha es el historial: se vacia y no vuelve nada',
      outcome.kind === 'failed' && outcome.reason === 'delivered' && json(readClaudeCodeBox(state.lines)) === json(['']), json(outcome));
  }
  {
    const { io, state } = cli({ upWorks: false });
    const outcome = await runClaudeCodeQueueEdit(io, context, deps(state), timing);
    check('11.8 si la flecha no saca nada, no se borra nada', outcome.kind === 'failed' && outcome.reason === 'not-restored' && state.writes.length === 1, json(state.writes));
  }
  {
    const { io, state } = cli({ clearWorks: false });
    const outcome = await runClaudeCodeQueueEdit(io, context, deps(state), timing);
    check('11.9 si la caja no se vacia, no vuelve nada al cuadro: el texto sigue en la CLI',
      outcome.kind === 'failed' && outcome.reason === 'not-cleared', json(outcome));
  }
  {
    const since = Date.parse('2026-10-23T15:36:05.000Z');
    const lines = [
      popAll('de antes, sacado a mano en la solapa CLI', since - 60_000),
      popAll('<task-notification>\n<status>completed</status>\n</task-notification>', since + 100),
      popAll(`mira esto @"${path.join(root, 'temporal', 'agent-workbench', 'pasted', 't1', 'pegada-1-0a1b2c3d.png')}"`, since + 100),
      '{"type":"queue-operation","operation":"enqueue","timestamp":"2026-10-23T15:36:05.200Z","content":"otro"}',
      'no es json',
    ];
    check('11.10 poppedPromptsIn: solo los de despues de la flecha, del usuario, y sin las imagenes',
      json(poppedPromptsIn(lines, since)) === json(['mira esto']), json(poppedPromptsIn(lines, since)));
  }
}

// Pi: Alt+Q devuelve la cola al editor, Ctrl+C lo vacia.
{
  const { readPiQueueScreen, runPiQueueEdit, piDequeueKeys } = await import('../src/agents/pi/queue-edit.ts');
  const screen = ({ above = [' Steering: Mensaje B en cola', ' ↳ Alt+Q to edit all queued messages'], editor = [''] } = {}) => [
    ' Elapsed 4.2s',
    ...above,
    '',
    `── ⠸ Working ${'─'.repeat(50)}`,
    ...editor,
    RULE,
    'D:\\pi-fase0\\proyecto',
    '↑1.2k ↓50 $0.003 (sub) 0.4%/272k (auto)        gpt-5.6-terra • low',
  ];
  const timing = { step: { timeoutMs: 500, pollMs: 50 }, clearGapMs: 750 };
  const ALT_Q = piDequeueKeys('win32');
  const restored = ['Mensaje B en cola', '', 'Mensaje C en cola', 'segunda linea'];
  const cli = ({ lines = screen(), dequeue = 'restore' } = {}) =>
    fakeCli(lines, (data, state) => {
      if (data === ALT_Q) {
        if (dequeue === 'restore') state.lines = screen({ above: [' Restored 2 queued messages to editor'], editor: restored });
        if (dequeue === 'nothing') state.lines = screen({ above: [' No queued messages to restore'] });
        return;
      }
      if (data === '\x03') {
        state.clearedAt = state.clock;
        state.lines = screen({ above: [' Restored 2 queued messages to editor'] });
      }
    });

  check('11.20 Alt+Q en Windows, un solo write; fuera, Alt+Up (sin medir)', ALT_Q === '\x1bq' && piDequeueKeys('linux') === '\x1b[1;3A');
  const measured = readPiQueueScreen(screen());
  const after = readPiQueueScreen(screen({ above: [' Restored 2 queued messages to editor'], editor: restored }));
  check('11.21 la pantalla medida: algo en cola con el editor vacio, y despues el editor con la cola',
    measured?.queued === true && json(measured.editor) === '[]' && after?.queued === false && json(after.editor) === json(restored), json([measured, after]));
  {
    const { io, state } = cli();
    const outcome = await runPiQueueEdit(io, { target: null, queued: ['Mensaje B en cola'], lastClearKeyAt: state.clock - 100 }, ALT_Q, timing);
    check('11.22 Alt+Q y Ctrl+C: vuelve lo que la app llevaba (texts vacio) y el editor queda vacio',
      outcome.kind === 'done' && outcome.texts.length === 0 && json(state.writes) === json([ALT_Q, '\x03']), json([outcome, state.writes]));
    check('11.23 el Ctrl+C espera lo que falta desde el anterior: dos seguidos cierran Pi',
      state.clearedAt !== undefined && state.clearedAt - (Date.parse('2026-10-23T15:36:05.000Z') - 100) >= 750);
  }
  {
    const { io, state } = cli({ dequeue: 'nothing' });
    const outcome = await runPiQueueEdit(io, { target: null, queued: ['x'], lastClearKeyAt: null }, ALT_Q, timing);
    check('11.24 "No queued messages": ya lo entrego, y no se manda ningun Ctrl+C',
      outcome.kind === 'failed' && outcome.reason === 'delivered' && json(state.writes) === json([ALT_Q]), json([outcome, state.writes]));
  }
  {
    const { io, state } = cli({ lines: screen({ editor: ['algo a medio escribir'] }) });
    const outcome = await runPiQueueEdit(io, { target: null, queued: ['x'], lastClearKeyAt: null }, ALT_Q, timing);
    check('11.25 con texto en el editor no se escribe nada: el Ctrl+C se lo llevaria',
      outcome.kind === 'failed' && outcome.reason === 'editor-busy' && state.writes.length === 0, json(outcome));
  }
}

// Antigravity: la flecha devuelve la cola al editor, Ctrl+U Ctrl+K lo vacian.
{
  const { readAntigravityQueueScreen, runAntigravityQueueEdit } = await import('../src/agents/antigravity/queue-edit.ts');
  const screen = ({ editor = [''], footer = '  Press up to edit queued messages                 accept-edits · Gemini 3.8 Flash · high' } = {}) => [
    '⣯  Generating...',
    '└ Tip: Use /cs to search in your codebase.',
    '▸ Mensaje B en cola',
    '▸ Mensaje C en cola... (alt+m to send immediately)',
    RULE,
    ...editor.map((line, index) => (index === 0 ? `> ${line}`.trimEnd() : `  ${line}`)),
    RULE,
    footer,
  ];
  const BUSY = 'esc to cancel                                      accept-edits · Gemini 3.8 Flash · high';
  const queued = ['Mensaje B en cola', 'Mensaje C en cola\nsegunda linea\ntercera linea'];
  const cli = ({ lines = screen(), shows = ['Mensaje B en cola', 'Mensaje C en cola', 'segunda linea', 'tercera linea'] } = {}) =>
    fakeCli(lines, (data, state) => {
      if (data === UP) {
        state.lines = screen({ editor: shows, footer: BUSY });
        return;
      }
      if (data.includes('\x03')) state.interrupted = true;
      const pairs = clearPairs(data);
      if (pairs > 0) {
        const current = readAntigravityQueueScreen(state.lines)?.editor ?? [];
        const left = current.slice(0, Math.max(0, current.length - pairs));
        state.lines = screen({ editor: left.length === 0 ? [''] : left, footer: BUSY });
      }
    });
  const timing = { timeoutMs: 500, pollMs: 50 };

  const measured = readAntigravityQueueScreen(screen());
  check('11.30 la pantalla medida: el editor vacio y lo de la cola en el pie',
    measured?.queued === true && json(measured.editor) === '[]', json(measured));
  {
    const { io, state } = cli();
    const outcome = await runAntigravityQueueEdit(io, { target: null, queued, lastClearKeyAt: null }, timing);
    check('11.31 la flecha y Ctrl+U Ctrl+K: vuelve lo que la app llevaba, sin Ctrl+C',
      outcome.kind === 'done' && state.writes[0] === UP && state.interrupted !== true &&
        json(readAntigravityQueueScreen(state.lines)?.editor) === '[]', json([outcome, state.writes]));
  }
  {
    // La entrego al terminar el turno: la flecha trae el ultimo mandado, que no es el primero de la cola.
    const { io, state } = cli({ shows: ['Mensaje C en cola', 'segunda linea', 'tercera linea'] });
    const outcome = await runAntigravityQueueEdit(io, { target: null, queued, lastClearKeyAt: null }, timing);
    check('11.32 si el editor no empieza con el primero de la cola, era el historial: se vacia y no vuelve',
      outcome.kind === 'failed' && outcome.reason === 'delivered' && json(readAntigravityQueueScreen(state.lines)?.editor) === '[]', json(outcome));
  }
  {
    const { io, state } = cli({ lines: screen({ footer: BUSY }) });
    const outcome = await runAntigravityQueueEdit(io, { target: null, queued, lastClearKeyAt: null }, timing);
    check('11.33 sin "Press up to edit queued messages" no se escribe nada',
      outcome.kind === 'failed' && outcome.reason === 'no-queue-on-screen' && state.writes.length === 0, json(outcome));
  }
  {
    const long = `${'palabra '.repeat(30)}fin`;
    // La pantalla corta donde cae: en un espacio (que se pierde al recortar) o en medio de una palabra.
    const { io } = cli({ shows: ['palabra palabra', 'palabra palabra pal', 'abra palabra palabra'] });
    const outcome = await runAntigravityQueueEdit(io, { target: null, queued: [long], lastClearKeyAt: null }, timing);
    check('11.34 un mensaje largo cortado en un espacio o en medio de una palabra se reconoce igual', outcome.kind === 'done', json(outcome));
  }
}

// La cola de la app da los textos enteros, y el protocolo.
{
  const { AppPromptQueue } = await import('../src/app-prompt-queue.ts');
  const queue = new AppPromptQueue();
  const long = 'x'.repeat(shared.MAX_QUEUED_PROMPT_CHARS + 50);
  queue.note('t1', { text: '  uno  ', images: 0, at: 1 });
  queue.note('t1', { text: long, images: 0, at: 2 });
  queue.note('t1', { text: '', images: 1, at: 3 });
  check('11.40 los textos de la cola de la app van enteros, en orden y sin los vacios',
    json(queue.texts('t1')) === json(['uno', long]) && queue.list('t1')[1].truncated === true);

  const { parseClientMessage, parseServerMessage } = shared;
  const ask = parseClientMessage(JSON.stringify({ type: 'agent.editQueue', terminalId: 't1', requestId: 'r1' }));
  check('11.41 agent.editQueue con su requestId; sin el, no se lee',
    ask?.type === 'agent.editQueue' && ask.requestId === 'r1' &&
      parseClientMessage(JSON.stringify({ type: 'agent.editQueue', terminalId: 't1' })) === null);
  const answer = parseServerMessage(JSON.stringify({ type: 'agent.queueEdited', terminalId: 't1', requestId: 'r1', edited: true }));
  check('11.42 agent.queueEdited, hecho o no; sin edited no se lee',
    answer?.type === 'agent.queueEdited' && answer.edited === true &&
      parseServerMessage(JSON.stringify({ type: 'agent.queueEdited', terminalId: 't1', requestId: 'r1' })) === null);
  const failed = parseServerMessage(JSON.stringify({ type: 'error', code: 'queue-edit-failed', text: { key: 'queueEditDelivered' }, requestId: 'r1' }));
  check('11.43 queue-edit-failed es un codigo de error y no cae a internal', failed?.code === 'queue-edit-failed', json(failed));
  const prefill = parseServerMessage(JSON.stringify({ type: 'composer.prefill', terminalId: 't1', text: 'B', reason: 'queue-edit' }));
  check('11.44 composer.prefill con queue-edit se lee', prefill?.type === 'composer.prefill' && prefill.reason === 'queue-edit', json(prefill));
}

// --- 12. El hilo sigue pegado al final (23-10-2026) -----------------------------------
//
// Una pestana cuyos ultimos mensajes traian una captura abria 286 px arriba del
// final: la miniatura cargaba despues de bajar, y el siguiente aviso de scroll
// (el navegador corriendo la vista por otra imagen de arriba) se tomaba como
// "el usuario subio a leer". Solo subir suelta el final.
{
  const { STICK_TO_BOTTOM_PX, staysAtEnd } = await import('../../web/src/thread-scroll.ts');
  const at = (state) => staysAtEnd({ wasAtEnd: true, distanceFromEnd: 300, scrollTop: 1_000, previousScrollTop: 1_000, ...state });

  check('12.1 cerca del final se esta al final, se venga de donde se venga',
    at({ wasAtEnd: false, distanceFromEnd: STICK_TO_BOTTOM_PX, scrollTop: 900 }) &&
      at({ wasAtEnd: false, distanceFromEnd: 0, scrollTop: 1_200 }));
  check('12.2 lejos del final porque algo crecio y el navegador corrio la vista hacia abajo: sigue al final',
    at({ scrollTop: 1_143 }));
  check('12.3 lejos del final sin que la vista se moviera: sigue al final', at({}));
  check('12.4 el usuario subio: suelta el final', !at({ scrollTop: 999 }) && !at({ scrollTop: 0 }));
  check('12.5 si ya se habia soltado, bajar sin llegar al final no lo vuelve a pegar',
    !at({ wasAtEnd: false, scrollTop: 1_100 }) && !at({ wasAtEnd: false, distanceFromEnd: STICK_TO_BOTTOM_PX + 1, scrollTop: 1_000 }));
}

await rm(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
