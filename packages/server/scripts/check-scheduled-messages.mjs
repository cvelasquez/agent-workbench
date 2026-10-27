/**
 * Chequeo de los mensajes programados (hito 51, §6.39).
 *
 *   npx tsx scripts/check-scheduled-messages.mjs
 *
 * Lo que se rompe en silencio, y solo se nota a la hora en que no llega nada:
 *
 *  - **Mandarlo dos veces.** Dos instancias comparten la carpeta (§14.8), y una
 *    que se cierra a mitad del envio no sabe si llego: el reclamo exclusivo y
 *    su paso (`reserved`, `writing`) lo impiden. Nunca se reintenta solo.
 *  - **Abrir una pestana cuya conversacion tiene otro proceso**: serian dos
 *    escribiendo el mismo historial.
 *  - **Mandarlo dos dias tarde** porque la app estaba cerrada: pasada la hora de
 *    margen no se manda solo.
 *  - **Escribirle al agente a mitad de un turno**: con el agente trabajando o
 *    esperando una respuesta, espera.
 *  - **Perder lo programado**: el archivo relee antes de cada cambio, y lo de la
 *    otra instancia no se pisa.
 *
 * Y desde el hito 52, con las CLIs que no avisan cuando estan listas
 * (`delivery.ts`): **escribir sin la pantalla lista**, **dar por enviado lo que
 * no aparecio** en la conversacion, **escribirle a Codex con el turno abierto** y
 * **abrir una pestana dormida sin esperar a la otra instancia**.
 *
 * No lanza ninguna CLI, no carga node-pty y no lee la configuracion real: la
 * carpeta es una temporal propia, y el reloj, las pestanas y la entrega son de
 * mentira.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dir = await mkdtemp(path.join(os.tmpdir(), 'aw-check-scheduled-'));
process.env['APPDATA'] = dir;
process.env['XDG_CONFIG_HOME'] = dir;

const shared = await import('@agent-workbench/shared');
const {
  MAX_SCHEDULED_MESSAGES,
  MAX_SCHEDULED_TEXT_CHARS,
  MAX_SCHEDULE_AHEAD_MS,
  SCHEDULE_LATE_LIMIT_MS,
  parseAppSettingsChange,
  parseAppSettingsStatus,
  parseClientMessage,
  parseScheduledMessage,
  parseServerMessage,
  scheduleTimeProblem,
} = shared;
const { ScheduledMessageStore, isScheduledMessageId, parseScheduledState } = await import('../src/scheduled-messages/store.ts');
const { MessageScheduler, scheduleCreateRefusal, scheduledFailureFor } = await import('../src/scheduled-messages/scheduler.ts');
const { MAX_SUBMIT_CHARS } = await import('../src/pty-input.ts');
const { setLocale } = await import('../../web/src/i18n/index.ts');
const ui = await import('../../web/src/scheduled-ui.ts');
await setLocale('es');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' - ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);

/** Espera por condicion, con plazo: nunca un sleep fijo. */
async function waitFor(condition, ms = 3000) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setImmediate(resolve));
  }
}

const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 28, 13, 0, 0);
const CLAUDE = { agent: 'claude-code', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' };
const CODEX = { agent: 'codex', sessionId: '0199aaaa-0000-7000-8000-000000000002' };

// --- 1. Lo compartido -------------------------------------------------------
{
  check('1.1 el tope del texto es el de un envio del cuadro', MAX_SCHEDULED_TEXT_CHARS === MAX_SUBMIT_CHARS);
  check('1.2 una hora pasada o la de ahora no se acepta',
    scheduleTimeProblem(T0 - 1, T0) === 'past' && scheduleTimeProblem(T0, T0) === 'past' && scheduleTimeProblem(Number.NaN, T0) === 'past');
  check('1.3 mas lejos que el tope, no; justo en el tope, si',
    scheduleTimeProblem(T0 + MAX_SCHEDULE_AHEAD_MS + 1, T0) === 'too-far' && scheduleTimeProblem(T0 + MAX_SCHEDULE_AHEAD_MS, T0) === null);
  const wire = {
    id: '11111111-1111-4111-8111-111111111111', agent: 'claude-code', sessionId: CLAUDE.sessionId, terminalId: 't1',
    text: 'revisa los PR', sendAt: T0 + HOUR, createdAt: T0, state: 'scheduled', note: null,
  };
  check('1.4 un mensaje programado se lee', json(parseScheduledMessage(wire)) === json(wire));
  check('1.5 sin pestana (null) se lee; con un estado que no se conoce, no',
    parseScheduledMessage({ ...wire, terminalId: null })?.terminalId === null &&
      parseScheduledMessage({ ...wire, state: 'otro' }) === null &&
      parseScheduledMessage({ ...wire, agent: 'otra-cli' }) === null);
  check('1.6 la nota es un texto del servidor; una que no lo es invalida el mensaje',
    parseScheduledMessage({ ...wire, state: 'waiting', note: { key: 'scheduledWaitBusy' } })?.note?.key === 'scheduledWaitBusy' &&
      parseScheduledMessage({ ...wire, note: 'texto suelto' }) === null);

  const create = parseClientMessage(json({ type: 'schedule.create', requestId: 'r1', terminalId: 't1', text: 'hola', sendAt: T0 }));
  check('1.7 schedule.create se lee con su pedido, su pestana, su texto y su hora',
    create?.type === 'schedule.create' && create.requestId === 'r1' && create.terminalId === 't1' && create.sendAt === T0);
  check('1.8 sin hora, sin pedido o con la hora como texto, no',
    parseClientMessage(json({ type: 'schedule.create', requestId: 'r1', terminalId: 't1', text: 'hola' })) === null &&
      parseClientMessage(json({ type: 'schedule.create', terminalId: 't1', text: 'hola', sendAt: T0 })) === null &&
      parseClientMessage(json({ type: 'schedule.create', requestId: 'r1', terminalId: 't1', text: 'hola', sendAt: '13:00' })) === null);
  check('1.9 cancelar y mandar ya nombran el mensaje por su id',
    parseClientMessage(json({ type: 'schedule.cancel', id: 'x' }))?.type === 'schedule.cancel' &&
      parseClientMessage(json({ type: 'schedule.sendNow', id: 'x' }))?.type === 'schedule.sendNow' &&
      parseClientMessage(json({ type: 'schedule.cancel' })) === null);
  const list = parseServerMessage(json({ type: 'schedule.list', messages: [wire, { ...wire, state: 'otro' }] }));
  check('1.10 la lista descarta el mal formado y se queda con los demas', list?.type === 'schedule.list' && list.messages.length === 1);
  check('1.11 schedule.created se lee',
    parseServerMessage(json({ type: 'schedule.created', requestId: 'r1', id: 'x' }))?.type === 'schedule.created');
  check('1.12 schedule-failed es un codigo de error, no cae a internal',
    parseServerMessage(json({ type: 'error', code: 'schedule-failed', text: { key: 'scheduleOff' } }))?.code === 'schedule-failed');
  check('1.13 el texto que vuelve al cuadro trae su motivo `unscheduled`',
    parseServerMessage(json({ type: 'composer.prefill', terminalId: 't1', text: 'hola', reason: 'unscheduled' }))?.reason === 'unscheduled');
  const status = { consoleShell: 'auto', consoleShells: [], shellName: null, disabledAgents: [], disabledAtStart: [] };
  check('1.14 Ajustes de un servidor anterior: apagado; del nuevo, lo que dice',
    parseAppSettingsStatus(status)?.scheduledMessages === false &&
      parseAppSettingsStatus({ ...status, scheduledMessages: true })?.scheduledMessages === true);
  check('1.15 encender o apagar se pide solo; un valor que no es si o no, no',
    json(parseAppSettingsChange({ scheduledMessages: true })) === json({ scheduledMessages: true }) &&
      parseAppSettingsChange({ scheduledMessages: 'si' }) === null &&
      parseAppSettingsChange({}) === null);
}

// --- 2. El archivo ----------------------------------------------------------
const id = (n) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;
const message = (n, owner = CLAUDE, sendAt = T0 + HOUR) => ({
  id: id(n), agent: owner.agent, sessionId: owner.sessionId, text: `mensaje ${n}`, sendAt, createdAt: T0,
});
{
  const statePath = path.join(dir, 's2', 'scheduled-messages.json');
  const claimsDir = path.join(dir, 's2', 'claims');
  const a = new ScheduledMessageStore({ statePath, claimsDir, pid: 1001, isAlive: (pid) => pid === 1001 || pid === 1002 });
  const b = new ScheduledMessageStore({ statePath, claimsDir, pid: 1002, isAlive: (pid) => pid === 1001 || pid === 1002 });
  await a.load();
  await b.load();
  check('2.1 sin archivo, ninguno', a.size === 0);
  await a.add(message(1));
  // B no releyo: igual, agregar relee el archivo y no se lleva el de A.
  await b.add(message(2, CODEX));
  await a.refresh();
  check('2.2 dos instancias agregan sin pisarse', a.size === 2 && b.size === 2, json(a.list().map((m) => m.id)));
  const disk = JSON.parse(await readFile(statePath, 'utf8'));
  check('2.3 en disco, la version y los dos', disk.version === 1 && disk.messages.length === 2);
  await a.update(id(1), { failure: { key: 'scheduledMissed' } });
  check('2.4 la falla se guarda', b.get(id(1)) === null || (await b.refresh(), b.get(id(1))?.failure?.key === 'scheduledMissed'));
  await a.update(id(1), { failure: null, sendAt: T0 + 2 * HOUR });
  check('2.5 y se borra con una hora nueva', a.get(id(1))?.failure === undefined && a.get(id(1))?.sendAt === T0 + 2 * HOUR);
  const moved = await a.move(CLAUDE, { agent: 'claude-code', sessionId: 'b1b2c3d4-0000-4000-8000-000000000009' });
  check('2.6 con /clear se muda con la pestana', moved === 1 && a.get(id(1))?.sessionId === 'b1b2c3d4-0000-4000-8000-000000000009');
  check('2.7 pero no a otra CLI', (await a.move(CODEX, CLAUDE)) === 0);
  const removed = await a.removeOwner(CODEX);
  check('2.8 cerrar la pestana saca los de su conversacion', removed.length === 1 && a.size === 1);
  await a.add(message(3));
  const dropped = await a.retainOnly([{ agent: 'claude-code', sessionId: 'b1b2c3d4-0000-4000-8000-000000000009' }]);
  check('2.9 al arrancar quedan solo los de pestanas del archivo', dropped === 1 && a.size === 1);
  check('2.10 remove devuelve el que saco, y null si ya no estaba',
    (await a.remove(id(1)))?.id === id(1) && (await a.remove(id(1))) === null);

  check('2.11 otra version del archivo se lee vacia', parseScheduledState(json({ version: 2, messages: [message(4)] })).length === 0);
  const tricky = parseScheduledState(json({
    version: 1,
    messages: [
      message(5), message(5), { ...message(6), id: '../../.credentials' }, { ...message(7), text: '' },
      { ...message(8), failure: { raro: true } }, { ...message(9), agent: 'otra' },
    ],
  }));
  check('2.12 se descartan el repetido, el id que no es uuid, el texto vacio y la CLI desconocida',
    json(tricky.map((m) => m.id)) === json([id(5), id(8)]), json(tricky.map((m) => m.id)));
  check('2.13 una falla que no se entiende queda como "no se sabe si llego": no se manda sola',
    tricky[1]?.failure?.key === 'scheduledUncertain');
  check('2.14 la forma del id', isScheduledMessageId(id(1)) && !isScheduledMessageId('x') && !isScheduledMessageId('../a'));

  // Los reclamos.
  check('2.15 A reclama: es suyo', (await a.claim(id(20))) === 'mine');
  check('2.16 B no puede: lo tiene otra instancia viva', (await b.claim(id(20))) === 'other');
  check('2.17 A lo vuelve a pedir: sigue siendo suyo', (await a.claim(id(20))) === 'mine');
  await a.setPhase(id(20), 'writing');
  const seen = await b.claimOf(id(20));
  check('2.18 B lo ve escribiendose, de un proceso vivo', seen?.phase === 'writing' && seen.alive && !seen.mine);
  await b.release(id(20));
  check('2.19 soltar el de otro no hace nada', (await b.claimOf(id(20))) !== null);
  await a.release(id(20));
  check('2.20 soltar el propio lo borra', (await a.claimOf(id(20))) === null);

  // Una instancia que se murio: B la ve muerta.
  const bAfter = new ScheduledMessageStore({ statePath, claimsDir, pid: 1002, isAlive: (pid) => pid === 1002 });
  await a.claim(id(21));
  check('2.21 reservado por un proceso muerto: se toma', (await bAfter.claim(id(21))) === 'mine');
  await a.claim(id(22));
  await a.setPhase(id(22), 'writing');
  check('2.22 escribiendose cuando se murio: no se toma nunca', (await bAfter.claim(id(22))) === 'orphan-writing');
  await bAfter.discardOrphan(id(22));
  check('2.23 y se borra una vez declarado', (await bAfter.claimOf(id(22))) === null);
  await a.claim(id(23));
  await a.claim(id(24));
  await a.setPhase(id(24), 'writing');
  await a.releaseReserved();
  check('2.24 al apagarse suelta lo reservado y deja lo que escribia',
    (await a.claimOf(id(23))) === null && (await a.claimOf(id(24)))?.phase === 'writing');
  check('2.25 la lista de reclamos', json((await a.claimedIds()).sort()) === json([id(21), id(24)].sort()), json(await a.claimedIds()));
  await writeFile(path.join(claimsDir, `${id(25)}.json`), '{a medio');
  const half = await a.claimOf(id(25));
  check('2.26 uno a medio escribir se trata como de otra instancia viva', half !== null && half.alive && !half.mine);
}

// --- 3. Lo que no se acepta ------------------------------------------------
{
  const base = {
    enabled: true, owner: CLAUDE, agentLabel: 'Claude Code', capable: true, text: 'revisa los PR', sendAt: T0 + HOUR, now: T0, count: 0,
  };
  const key = (input) => scheduleCreateRefusal({ ...base, ...input })?.key ?? null;
  check('3.1 todo bien: se acepta', key({}) === null);
  check('3.2 apagado en Ajustes', key({ enabled: false }) === 'scheduleOff');
  check('3.3 sin conversacion o sin CLI', key({ owner: null }) === 'scheduleNoConversation' && key({ agentLabel: null }) === 'scheduleNoConversation');
  check('3.4 una CLI que no lo declara', key({ capable: false }) === 'scheduleUnsupported');
  check('3.5 vacio o solo espacios', key({ text: '  \n ' }) === 'scheduleEmpty');
  check('3.6 mas largo que un envio', key({ text: 'x'.repeat(MAX_SCHEDULED_TEXT_CHARS + 1) }) === 'scheduleTooLong');
  check('3.7 una hora pasada o demasiado lejos',
    key({ sendAt: T0 - 1 }) === 'schedulePast' && key({ sendAt: T0 + MAX_SCHEDULE_AHEAD_MS + 1 }) === 'scheduleTooFar');
  check('3.8 lleno', key({ count: MAX_SCHEDULED_MESSAGES }) === 'scheduleTooMany');
  const outcome = (kind) => scheduledFailureFor(kind === 'image-failed' ? { kind, detail: 'x' } : { kind })?.key ?? null;
  check('3.9 llego: nada que anotar', outcome('sent') === null && outcome('nothing') === null);
  check('3.10 nada escrito: la CLI no quedo lista',
    ['no-session', 'no-ready-signal', 'no-images', 'not-ready', 'image-failed'].every((kind) => outcome(kind) === 'scheduledCliNotReady'));
  check('3.11 cortado a mitad: no se sabe si llego',
    outcome('interrupted') === 'scheduledUncertainWrite' && outcome('refused') === 'scheduledUncertainWrite');
  check('3.12 la pestana ya no esta', outcome('gone') === 'scheduledNoTab' && outcome('no-agent') === 'scheduledNoTab');
}

// --- 4. El reloj -------------------------------------------------------------

/** Un mundo de mentira: el reloj, las pestanas, la CLI y la entrega. */
function world(name, { pid = 2001, alivePids = null } = {}) {
  const statePath = path.join(dir, name, 'scheduled-messages.json');
  const claimsDir = path.join(dir, name, 'claims');
  const isAlive = (p) => (alivePids === null ? true : alivePids.has(p));
  const state = {
    now: T0,
    enabled: true,
    tabs: [],
    activity: new Map(),
    elsewhere: false,
    delivered: [],
    woken: [],
    published: [],
    outcomes: [],
    wakeFails: false,
    holdDelivery: null,
  };
  const make = (storePid = pid) => {
    const store = new ScheduledMessageStore({ statePath, claimsDir, pid: storePid, isAlive });
    const scheduler = new MessageScheduler({
      store,
      now: () => state.now,
      enabled: () => state.enabled,
      tabs: () => state.tabs,
      activityOf: (terminalId) => state.activity.get(terminalId) ?? null,
      agentOf: (agent) => (agent === 'claude-code' ? { label: 'Claude Code', scheduledSend: true } : { label: 'Codex', scheduledSend: false }),
      isOpenElsewhere: async () => state.elsewhere,
      wake: async (terminalId) => {
        state.woken.push(terminalId);
        if (state.wakeFails) throw new Error('no arranco');
        const tab = state.tabs.find((entry) => entry.terminalId === terminalId);
        if (tab === undefined) return false;
        tab.alive = true;
        return true;
      },
      deliver: async (terminalId, text) => {
        state.delivered.push({ terminalId, text, by: storePid });
        if (state.holdDelivery !== null) return state.holdDelivery;
        return state.outcomes.shift() ?? { kind: 'sent' };
      },
      onChange: (list) => state.published.push(list),
      setTimer: () => () => undefined,
    });
    return { store, scheduler };
  };
  return { state, make };
}

/** Una vuelta entera, y la espera a que lo que arranco termine. */
async function pass(scheduler) {
  await waitFor(() => !scheduler.ticking);
  await scheduler.tick();
  await waitFor(() => !scheduler.ticking && scheduler.inFlight.size === 0);
}

const stateOf = (scheduler, messageId) => scheduler.snapshot().find((entry) => entry.id === messageId);

{
  const { state, make } = world('w1');
  const { store, scheduler } = make();
  await store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  state.activity.set('t1', 'idle');
  scheduler.start();
  const created = await scheduler.create(CLAUDE, 'claude-code', 'revisa los PR', T0 + HOUR);
  await pass(scheduler);
  check('4.1 antes de la hora: programado, y no se manda', stateOf(scheduler, created.id)?.state === 'scheduled' && state.delivered.length === 0);
  check('4.2 la lista lleva la pestana de hoy', stateOf(scheduler, created.id)?.terminalId === 't1');

  state.now = T0 + HOUR + 1000;
  state.activity.set('t1', 'busy');
  await pass(scheduler);
  check('4.3 a la hora, con el agente trabajando: espera, y no se mete en la cola',
    stateOf(scheduler, created.id)?.state === 'waiting' && stateOf(scheduler, created.id)?.note?.key === 'scheduledWaitBusy' &&
      state.delivered.length === 0);
  state.activity.set('t1', 'waiting');
  await pass(scheduler);
  check('4.4 esperando una respuesta del usuario: espera', stateOf(scheduler, created.id)?.note?.key === 'scheduledWaitAnswer' && state.delivered.length === 0);
  // Tres horas trabajando: un mensaje que vencio con la app abierta no se vence.
  state.now = T0 + 4 * HOUR;
  state.activity.set('t1', 'idle');
  await pass(scheduler);
  check('4.5 el agente quedo libre: se manda una vez, a su pestana', json(state.delivered.map((d) => [d.terminalId, d.text])) === json([['t1', 'revisa los PR']]));
  check('4.6 mandado, sale del archivo y suelta su reclamo', store.get(created.id) === null && (await store.claimOf(created.id)) === null);
  await pass(scheduler);
  await pass(scheduler);
  check('4.7 nunca dos veces', state.delivered.length === 1);
  await scheduler.stop();
}

{
  const { state, make } = world('w2');
  const { store, scheduler } = make();
  await store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: false }];
  scheduler.start();
  const created = await scheduler.create(CLAUDE, 'claude-code', 'hola', T0 + 60_000);
  state.now = T0 + 61_000;
  await pass(scheduler);
  check('4.8 dormida: se abre la CLI y se manda', json(state.woken) === json(['t1']) && state.delivered.length === 1 && store.get(created.id) === null);
  await scheduler.stop();
}

{
  const { state, make } = world('w3');
  const { store, scheduler } = make();
  await store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: false }];
  state.elsewhere = true;
  scheduler.start();
  const created = await scheduler.create(CLAUDE, 'claude-code', 'hola', T0 + 60_000);
  state.now = T0 + 61_000;
  await pass(scheduler);
  check('4.9 la conversacion abierta en otro programa: no la abre, espera',
    state.woken.length === 0 && state.delivered.length === 0 && stateOf(scheduler, created.id)?.note?.key === 'scheduledWaitElsewhere');
  state.now = T0 + 60_000 + SCHEDULE_LATE_LIMIT_MS + 1000;
  await pass(scheduler);
  check('4.10 pasada la hora de margen, no se manda, y dice por que',
    store.get(created.id)?.failure?.key === 'scheduledElsewhereTimeout' && state.delivered.length === 0);
  await scheduler.stop();
}

{
  // La app estaba cerrada: el mensaje se ve vencido recien al arrancar.
  const { state, make } = world('w4');
  const first = make();
  await first.store.load();
  const late = await first.store.add(message(40, CLAUDE, T0));
  const near = message(41, CLAUDE, T0 + SCHEDULE_LATE_LIMIT_MS);
  await first.store.add(near);
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  state.activity.set('t1', 'idle');
  state.now = T0 + SCHEDULE_LATE_LIMIT_MS + 30_000;
  first.scheduler.start();
  await pass(first.scheduler);
  check('4.11 visto vencido mas de una hora despues: no se manda solo',
    first.store.get(id(40))?.failure?.key === 'scheduledMissed' && !state.delivered.some((d) => d.text === 'mensaje 40'));
  check('4.12 el que vencio hace medio minuto, si', state.delivered.some((d) => d.text === 'mensaje 41'));
  void late;
  // Mandarlo ya: borra la falla y sale con las reglas de siempre.
  check('4.13 "Enviar ahora" lo acepta', (await first.scheduler.sendNow(id(40))) === 'ok');
  await pass(first.scheduler);
  check('4.14 recien mandado otro a la misma pestana: espera su turno',
    stateOf(first.scheduler, id(40))?.state === 'waiting' && !state.delivered.some((d) => d.text === 'mensaje 40'));
  state.now += 11_000;
  await pass(first.scheduler);
  check('4.15 pasada la espera, y con el agente libre, lo manda',
    state.delivered.filter((d) => d.text === 'mensaje 40').length === 1 && first.store.get(id(40)) === null);
  await first.scheduler.stop();
}

{
  // En pausa: apagado en Ajustes.
  const { state, make } = world('w5');
  const { store, scheduler } = make();
  await store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  state.activity.set('t1', 'idle');
  state.enabled = false;
  scheduler.start();
  await store.add(message(50, CLAUDE, T0 + 60_000));
  state.now = T0 + 120_000;
  await pass(scheduler);
  check('4.16 apagado: en pausa, y no se manda', stateOf(scheduler, id(50))?.state === 'paused' && state.delivered.length === 0);
  check('4.17 "Enviar ahora" con el ajuste apagado no se acepta', (await scheduler.sendNow(id(50))) === 'off');
  state.now = T0 + 60_000 + SCHEDULE_LATE_LIMIT_MS + 1000;
  state.enabled = true;
  await pass(scheduler);
  check('4.17b encendido mas de una hora despues de su hora: no se manda solo',
    store.get(id(50))?.failure?.key === 'scheduledMissed' && state.delivered.length === 0);
  await scheduler.stop();
}

{
  // Dos instancias: la pestana abierta en A, dormida en B.
  const { state, make } = world('w6');
  const tabsA = [{ terminalId: 'a1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  const tabsB = [{ terminalId: 'b1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: false }];
  const a = make(3001);
  const b = make(3002);
  await a.store.load();
  await b.store.load();
  state.tabs = tabsA;
  a.scheduler.start();
  state.tabs = tabsB;
  b.scheduler.start();
  await a.store.add(message(60, CLAUDE, T0 + 60_000));
  state.now = T0 + 61_000;
  // A con el agente trabajando: lo reserva y espera.
  state.tabs = tabsA;
  state.activity.set('a1', 'busy');
  await pass(a.scheduler);
  // B la tiene dormida, y en su mundo nadie mas tiene la conversacion (Claude Code lo diria; aca, el reclamo).
  state.tabs = tabsB;
  await pass(b.scheduler);
  check('4.18 B no la abre: A la reservo', state.woken.length === 0 && stateOf(b.scheduler, id(60))?.note?.key === 'scheduledWaitOtherInstance');
  state.tabs = tabsA;
  state.activity.set('a1', 'idle');
  await pass(a.scheduler);
  state.tabs = tabsB;
  await pass(b.scheduler);
  check('4.19 lo manda A, una sola vez, y B no hace nada',
    json(state.delivered.map((d) => d.by)) === json([3001]) && state.woken.length === 0 && b.store.get(id(60)) === null);
  await a.scheduler.stop();
  await b.scheduler.stop();
}

{
  // Una instancia que se cierra a mitad del envio.
  const alivePids = new Set([4001, 4002]);
  const { state, make } = world('w7', { alivePids });
  const a = make(4001);
  await a.store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  state.activity.set('t1', 'idle');
  a.scheduler.start();
  await a.store.add(message(70, CLAUDE, T0 + 60_000));
  state.now = T0 + 61_000;
  // La entrega no termina: la instancia "muere" escribiendo.
  let release;
  state.holdDelivery = new Promise((resolve) => {
    release = resolve;
  });
  await waitFor(() => !a.scheduler.ticking);
  await a.scheduler.tick();
  check('4.20 escribiendo, el reclamo dice `writing`', await waitFor(async () => (await a.store.claimOf(id(70)))?.phase === 'writing'));
  alivePids.delete(4001);
  state.holdDelivery = null;
  const c = make(4002);
  await c.store.load();
  c.scheduler.start();
  await pass(c.scheduler);
  check('4.21 la otra instancia no lo reintenta: "no se sabe si llego"',
    c.store.get(id(70))?.failure?.key === 'scheduledUncertain' && state.delivered.length === 1, json(state.delivered));
  release({ kind: 'sent' });
  await a.scheduler.stop();
  await c.scheduler.stop();
}

{
  // Una instancia que se cierra con algo reservado, sin haber escrito nada.
  const alivePids = new Set([5001, 5002]);
  const { state, make } = world('w8', { alivePids });
  const a = make(5001);
  await a.store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  state.activity.set('t1', 'busy');
  a.scheduler.start();
  await a.store.add(message(80, CLAUDE, T0 + 60_000));
  state.now = T0 + 61_000;
  await pass(a.scheduler);
  check('4.22 trabajando: reservado', (await a.store.claimOf(id(80)))?.phase === 'reserved');
  alivePids.delete(5001);
  const c = make(5002);
  await c.store.load();
  c.scheduler.start();
  state.activity.set('t1', 'idle');
  await pass(c.scheduler);
  check('4.23 la otra lo toma y lo manda: el muerto no habia escrito nada',
    json(state.delivered.map((d) => d.by)) === json([5002]) && c.store.get(id(80)) === null);
  await a.scheduler.stop();
  await c.scheduler.stop();
}

{
  // Lo que sale mal al mandarlo, y lo que pasa con la pestana.
  const { state, make } = world('w9');
  const { store, scheduler } = make();
  await store.load();
  state.tabs = [
    { terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true },
    { terminalId: 't2', agent: 'codex', sessionId: CODEX.sessionId, alive: true },
  ];
  state.activity.set('t1', 'idle');
  state.activity.set('t2', 'idle');
  scheduler.start();
  state.outcomes = [{ kind: 'interrupted' }, { kind: 'not-ready' }];
  await store.add(message(90, CLAUDE, T0 + 1000));
  await store.add(message(91, CLAUDE, T0 + 2000));
  await store.add(message(92, CODEX, T0 + 3000));
  state.now = T0 + 10_000;
  await pass(scheduler);
  check('4.24 cortado a mitad: "no se sabe si llego", sin reintentar', store.get(id(90))?.failure?.key === 'scheduledUncertainWrite');
  check('4.25 dos que vencen juntos en la misma pestana: el segundo espera',
    state.delivered.length === 1 && stateOf(scheduler, id(91))?.state === 'waiting', json(state.delivered));
  check('4.26 una CLI que no lo declara: no se manda', store.get(id(92))?.failure?.key === 'scheduleUnsupported' &&
    !state.delivered.some((d) => d.text === 'mensaje 92'));
  state.now = T0 + 25_000;
  await pass(scheduler);
  check('4.27 la CLI no quedo lista: no se envio, y lo dice', store.get(id(91))?.failure?.key === 'scheduledCliNotReady');
  await pass(scheduler);
  check('4.27b los que fallaron no se reintentan solos', state.delivered.length === 2);

  state.tabs[0].alive = false;
  state.wakeFails = true;
  await store.add(message(93, CLAUDE, T0 + 40_000));
  state.now = T0 + 41_000;
  await pass(scheduler);
  check('4.28 la CLI no se pudo abrir', store.get(id(93))?.failure?.key === 'scheduledCliOpenFailed');

  await store.add(message(94, { agent: 'claude-code', sessionId: 'c1b2c3d4-0000-4000-8000-00000000000c' }, T0 + 42_000));
  state.now = T0 + 43_000;
  await pass(scheduler);
  check('4.29 sin pestana con esa conversacion: espera', stateOf(scheduler, id(94))?.note?.key === 'scheduledWaitNoTab');
  state.now = T0 + 42_000 + SCHEDULE_LATE_LIMIT_MS + 1000;
  await pass(scheduler);
  check('4.30 y pasada la hora de margen, no se envio', store.get(id(94))?.failure?.key === 'scheduledNoTab');

  await store.add(message(95, CLAUDE, T0 + 20 * HOUR));
  const cancelled = await scheduler.cancel(id(95));
  check('4.31 cancelar lo saca y devuelve su texto', cancelled.kind === 'removed' && cancelled.message.text === 'mensaje 95' && store.get(id(95)) === null);
  check('4.32 cancelar uno que ya no esta', (await scheduler.cancel(id(95))).kind === 'gone');
  await store.add(message(96, CLAUDE, T0 + 20 * HOUR));
  await scheduler.dropOwner(CLAUDE);
  check('4.33 cerrar la pestana cancela lo de su conversacion', store.list().every((m) => m.sessionId !== CLAUDE.sessionId));
  await scheduler.stop();
}

{
  // Cancelar mientras se manda: no.
  const { state, make } = world('w10');
  const { store, scheduler } = make();
  await store.load();
  state.tabs = [{ terminalId: 't1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: true }];
  state.activity.set('t1', 'idle');
  scheduler.start();
  await store.add(message(100, CLAUDE, T0 + 1000));
  state.now = T0 + 2000;
  let release;
  state.holdDelivery = new Promise((resolve) => {
    release = resolve;
  });
  await waitFor(() => !scheduler.ticking);
  await scheduler.tick();
  await waitFor(() => scheduler.inFlight.size === 1);
  check('4.34 mandandose: el estado lo dice', stateOf(scheduler, id(100))?.state === 'sending');
  check('4.35 y no se puede cancelar ni mandar otra vez',
    (await scheduler.cancel(id(100))).kind === 'sending' && (await scheduler.sendNow(id(100))) === 'sending');
  release({ kind: 'sent' });
  await waitFor(() => scheduler.inFlight.size === 0);
  check('4.36 termino: salio del archivo', store.get(id(100)) === null && state.delivered.length === 1);
  check('4.37 la lista se publico con cada cambio de estado', state.published.some((list) => list.some((m) => m.id === id(100) && m.state === 'sending')));
  await scheduler.stop();
}

// --- 5. Lo puro de la web ----------------------------------------------------
{
  const local = new Date(2026, 9, 24, 15, 40, 25).getTime();
  const [inHour, tomorrow] = ui.quickSchedules(local);
  check('5.1 "en una hora", al minuto', inHour?.at === new Date(2026, 9, 24, 16, 40, 0).getTime());
  check('5.2 "manana a las 9"', tomorrow?.at === new Date(2026, 9, 25, 9, 0, 0).getTime());
  check('5.3 lo que propone el menu a mano es manana a las 9',
    json(ui.customDefaults(local)) === json({ date: '2026-10-25', time: '09:00' }));
  check('5.4 dia y hora a mano, en la hora de la ventana', ui.customScheduleAt('2026-10-28', '10:00') === new Date(2026, 9, 28, 10, 0, 0).getTime());
  check('5.5 un dia que no existe o una hora mal escrita, no',
    ui.customScheduleAt('2026-02-31', '10:00') === null && ui.customScheduleAt('2026-10-28', '25:00') === null &&
      ui.customScheduleAt('28/10/2026', '10:00') === null);
  check('5.6 por que no se puede: invalida, pasada, demasiado lejos',
    ui.scheduleTimeHint(null, local) !== null && ui.scheduleTimeHint(local - 1, local) !== null &&
      ui.scheduleTimeHint(local + MAX_SCHEDULE_AHEAD_MS + 60_000, local) !== null && ui.scheduleTimeHint(local + HOUR, local) === null);
  check('5.7 los topes del selector de dia', json(ui.dateInputBounds(local)) === json({ min: '2026-10-24', max: '2026-11-23' }));
  const wire = (n, extra = {}) => ({
    id: id(n), agent: 'claude-code', sessionId: CLAUDE.sessionId, terminalId: 't1', text: `m${n}`,
    sendAt: local + n * HOUR, createdAt: local, state: 'scheduled', note: null, ...extra,
  });
  check('5.8 programado: la hora y cuanto falta', /3h/.test(ui.scheduledStateText(wire(3), local)), ui.scheduledStateText(wire(3), local));
  check('5.9 esperando y fallado: la nota del servidor',
    ui.scheduledStateText(wire(1, { state: 'waiting', note: { key: 'scheduledWaitBusy' } }), local).includes('agente termine') &&
      ui.scheduledStateText(wire(1, { state: 'failed', note: { key: 'scheduledMissed' } }), local).includes('no estaba abierta'));
  const list = [wire(5), wire(2, { terminalId: 't2' }), wire(1)];
  check('5.10 los de una pestana, en orden de hora', json(ui.scheduledFor(list, 't1').map((m) => m.id)) === json([id(1), id(5)]));
  check('5.11 sin lista (servidor anterior) o sin pestana, ninguno', ui.scheduledFor(null, 't1').length === 0 && ui.scheduledFor(list, null).length === 0);
  check('5.12 la linea de la pestana dice el proximo; uno fallado va primero',
    /^2 mensajes programados/.test(ui.scheduledTabLine([wire(1), wire(5)]) ?? '') &&
      /no se envi/.test(ui.scheduledTabLine([wire(1), wire(5, { state: 'failed' })]) ?? ''), ui.scheduledTabLine([wire(1), wire(5)]));
  check('5.13 cerrar avisa solo si queda algo por mandar',
    /Si la cierras, no se envía/.test(ui.scheduledCloseWarning([wire(1)]) ?? '') &&
      ui.scheduledCloseWarning([wire(1, { state: 'failed' })]) === null && ui.scheduledCloseWarning([]) === null);
  check('5.14 mandandose no se toca', !ui.scheduledActionable(wire(1, { state: 'sending' })) && ui.scheduledActionable(wire(1)));
}

// --- 6. Hito 52: las CLIs sin senal de "lista" --------------------------------
const { deliverScheduled, freenessOf, isUserMessageWith } = await import('../src/scheduled-messages/delivery.ts');
const { RunningInstances } = await import('../src/scheduled-messages/instances.ts');
const { SCHEDULED_OTHER_INSTANCE_GRACE_MS } = await import('../src/scheduled-messages/scheduler.ts');

const userEvent = (text, at = 0) => ({ eventId: `e-${Math.random()}`, role: 'user', at, parts: [{ kind: 'text', text }], model: null, usage: null, effort: null, durationMs: null });

/**
 * Una pestana de mentira para `deliverScheduled`: un reloj que avanza con cada
 * espera, una pantalla que cambia cuando se le dice, un seguidor que devuelve lo
 * que la CLI "escribio" y un envio que anota lo que se escribio.
 */
function deliveryWorld({ hasStatus = true } = {}) {
  const state = {
    now: T0,
    tab: { alive: true, sessionId: CODEX.sessionId, cwd: 'D:\\p', launchedAt: T0 - 10_000 },
    activity: 'idle',
    screens: [],
    screen: ['nada'],
    submitResult: { kind: 'written' },
    written: [],
    // Lo que el seguidor entrega en cada lectura despues de escribir.
    echo: true,
    echoText: null,
    added: [],
    openTurn: false,
    openTool: false,
    activityAfterWrite: null,
    readyAfterWaits: 0,
    waits: 0,
  };
  const follower = {
    label: 'mentira',
    start: async () => undefined,
    poll: async () => {
      const added = state.added;
      state.added = [];
      return { reset: false, added, turns: [], plans: [], parts: [] };
    },
    hasOpenToolCall: () => state.openTool,
    hasOpenTurn: () => state.openTurn,
  };
  const deps = {
    tab: () => state.tab,
    activityOf: () => state.activity,
    screen: () => ({ lines: () => state.screen, dispose: () => undefined }),
    submit: async (_terminalId, text) => {
      state.written.push(text);
      if (state.echo) state.added.push(userEvent(state.echoText ?? text, state.now));
      if (state.activityAfterWrite !== null) state.activity = state.activityAfterWrite;
      return state.submitResult;
    },
    follow: () => follower,
    now: () => state.now,
    wait: async (ms) => {
      state.now += ms;
      state.waits += 1;
      if (state.readyAfterWaits > 0 && state.waits >= state.readyAfterWaits) state.screen = ['listo'];
    },
  };
  const screenSupport = { kind: 'screen', readyScreen: (lines) => lines[0] === 'listo', confirmTimeoutMs: 10_000 };
  const run = (text = 'revisa los PR', extra = {}) =>
    deliverScheduled(deps, { terminalId: 't1', text, support: screenSupport, hasStatus, readyTimeoutMs: 60_000, pollMs: 250, ...extra });
  return { state, deps, run, screenSupport };
}

{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  const outcome = await w.run();
  check('6.1 libre y la pantalla lista dos veces: lo escribe y lo ve en la conversacion', outcome.kind === 'sent' && json(w.state.written) === json(['revisa los PR']), json(outcome));
}
{
  const w = deliveryWorld();
  w.state.screen = ['arrancando'];
  w.state.readyAfterWaits = 4;
  const outcome = await w.run();
  check('6.2 espera a que la pantalla este lista, y recien ahi escribe', outcome.kind === 'sent' && w.state.waits >= 5, `${w.state.waits} esperas`);
}
{
  const w = deliveryWorld();
  w.state.screen = ['arrancando'];
  const outcome = await w.run();
  check('6.3 la pantalla nunca lista: no escribe nada', outcome.kind === 'not-ready' && w.state.written.length === 0, json(outcome));
}
{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  w.state.activity = 'busy';
  const outcome = await w.run();
  check('6.4 el agente trabajando todo el plazo: no escribe, y vuelve a intentarlo (busy)', outcome.kind === 'busy' && w.state.written.length === 0, json(outcome));
}
{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  w.state.echo = false;
  const outcome = await w.run();
  check('6.5 escrito y nunca visto en la conversacion: no se sabe si llego', outcome.kind === 'unconfirmed' && w.state.written.length === 1, json(outcome));
}
{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  w.state.echo = false;
  w.state.activityAfterWrite = 'busy';
  const outcome = await w.run();
  check('6.6 con estado: pasa a trabajando despues de escribirlo, llego', outcome.kind === 'sent', json(outcome));
}
{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  w.state.echoText = 'otro mensaje';
  const outcome = await w.run();
  check('6.7 un mensaje del usuario con otro texto no confirma', outcome.kind === 'unconfirmed', json(outcome));
}
{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  w.state.submitResult = { kind: 'refusal' };
  check('6.8 rechazado por las guardas del cuadro antes de escribir: no lista', (await w.run()).kind === 'not-ready');
  w.state.submitResult = { kind: 'blocked', byDialog: false, waitingNow: true };
  check('6.8 frenado a mitad: pudo quedar en la caja (interrupted)', (await w.run()).kind === 'interrupted');
}
{
  const w = deliveryWorld();
  w.state.screen = ['listo'];
  w.state.tab = { ...w.state.tab, sessionId: 'otra-conversacion' };
  const original = w.deps.tab;
  let calls = 0;
  w.deps.tab = () => {
    calls += 1;
    return calls === 1 ? { ...w.state.tab, sessionId: CODEX.sessionId } : w.state.tab;
  };
  const outcome = await w.run();
  w.deps.tab = original;
  check('6.9 la pestana cambio de conversacion mientras esperaba: no escribe', outcome.kind === 'not-ready' && w.state.written.length === 0, json(outcome));
}
{
  // Codex: sin estado, el turno abierto del historial dice si trabaja.
  const w = deliveryWorld({ hasStatus: false });
  w.state.screen = ['listo'];
  w.state.activity = 'unknown';
  w.state.openTurn = true;
  const busy = await w.run();
  check('6.10 sin estado y con el turno abierto: no escribe (busy)', busy.kind === 'busy' && w.state.written.length === 0, json(busy));
  w.state.openTurn = false;
  w.state.openTool = true;
  check('6.10 una herramienta abierta tambien es ocupado', (await w.run()).kind === 'busy');
  w.state.openTool = false;
  check('6.10 turno cerrado y la caja lista: lo escribe', (await w.run()).kind === 'sent' && w.state.written.length === 1);
  check('6.11 freenessOf: con estado manda la actividad; sin seguidor, no se sabe',
    (await freenessOf(true, 'waiting', null, null)) === 'waiting' && (await freenessOf(true, null, null, null)) === 'unknown' &&
      (await freenessOf(false, null, null, T0)) === 'unknown');
}
{
  // OpenCode: por su API, sin mirar la pantalla.
  const w = deliveryWorld();
  w.state.screen = ['nada'];
  const sent = [];
  let reply = 'sent';
  const api = {
    kind: 'api',
    confirmTimeoutMs: 10_000,
    deliver: async (target, text) => {
      sent.push({ target, text });
      if (reply !== 'not-sent') w.state.added.push(userEvent(text, w.state.now));
      return reply;
    },
  };
  const first = await w.run('por la API', { support: api });
  check('6.12 por la API: no mira la pantalla, manda la conversacion de la pestana y lo ve llegar',
    first.kind === 'sent' && sent.length === 1 && sent[0].target.sessionId === CODEX.sessionId && sent[0].target.cwd === 'D:\\p' && w.state.written.length === 0, json(first));
  reply = 'not-sent';
  check('6.13 la API dice que no lo mando: no lista, sin "no se sabe"', (await w.run('x', { support: api })).kind === 'not-ready');
  reply = 'failed';
  check('6.14 la API fallo pero el mensaje aparecio: llego', (await w.run('y', { support: api })).kind === 'sent');
  const silent = { ...api, deliver: async () => 'failed' };
  check('6.14 la API fallo y no aparecio: no se sabe si llego', (await w.run('z', { support: silent })).kind === 'unconfirmed');
  w.state.activity = 'busy';
  check('6.15 por la API tambien espera a que este libre', (await w.run('w', { support: api })).kind === 'busy');
}
{
  const w = deliveryWorld();
  w.state.tab = null;
  check('6.16 la pestana ya no esta', (await w.run()).kind === 'gone');
  w.state.tab = { alive: false, sessionId: CODEX.sessionId, cwd: 'D:\\p', launchedAt: null };
  check('6.16 sin proceso: no escribe', (await w.run()).kind === 'not-ready' && w.state.written.length === 0);
}
check('6.17 el texto se compara con los espacios juntados, y por su principio si llega recortado',
  isUserMessageWith(userEvent('revisa\n los   PR'), 'revisa los PR') &&
    isUserMessageWith(userEvent(`${'a'.repeat(250)}...`), `${'a'.repeat(300)} fin`) &&
    !isUserMessageWith(userEvent('revisa los PR'), 'otra cosa') &&
    !isUserMessageWith({ ...userEvent('revisa los PR'), role: 'assistant' }, 'revisa los PR'));

// El reloj: el "libre" de freeNow, los resultados nuevos y la otra instancia.
function world52(name) {
  const statePath = path.join(dir, name, 'scheduled-messages.json');
  const claimsDir = path.join(dir, name, 'claims');
  const state = {
    now: T0,
    tabs: [],
    free: 'idle',
    others: false,
    delivered: [],
    woken: [],
    outcomes: [],
  };
  const store = new ScheduledMessageStore({ statePath, claimsDir, pid: 3001, isAlive: () => true });
  const scheduler = new MessageScheduler({
    store,
    now: () => state.now,
    enabled: () => true,
    tabs: () => state.tabs,
    activityOf: () => 'unknown',
    freeNow: async () => state.free,
    othersRunning: async () => state.others,
    tellsOpenElsewhere: (agent) => agent === 'claude-code',
    agentOf: (agent) => ({ label: agent, scheduledSend: true }),
    isOpenElsewhere: async () => false,
    wake: async (terminalId) => {
      state.woken.push(terminalId);
      const tab = state.tabs.find((entry) => entry.terminalId === terminalId);
      if (tab === undefined) return false;
      tab.alive = true;
      return true;
    },
    deliver: async (terminalId, text) => {
      state.delivered.push({ terminalId, text });
      return state.outcomes.shift() ?? { kind: 'sent' };
    },
    onChange: () => undefined,
    setTimer: () => () => undefined,
  });
  return { state, store, scheduler };
}
{
  const { state, store, scheduler } = world52('w52a');
  await store.load();
  state.tabs = [{ terminalId: 'c1', agent: 'codex', sessionId: CODEX.sessionId, alive: true }];
  state.free = 'busy';
  scheduler.start();
  const created = await scheduler.create(CODEX, 'codex', 'sigue con lo tuyo', T0 + 1000);
  state.now = T0 + 2000;
  await pass(scheduler);
  check('6.20 Codex trabajando (freeNow): espera, sin escribir', stateOf(scheduler, created.id)?.state === 'waiting' && state.delivered.length === 0,
    json(stateOf(scheduler, created.id)));
  state.free = 'idle';
  state.outcomes.push({ kind: 'busy' });
  await pass(scheduler);
  check('6.21 la entrega dijo que siguio trabajando: no es una falla, sigue programado y espera', state.delivered.length === 1 &&
    (await store.load(), store.get(created.id)) !== null && store.get(created.id)?.failure === undefined &&
    stateOf(scheduler, created.id)?.state === 'waiting', json(stateOf(scheduler, created.id)));
  state.now += 11_000;
  state.outcomes.push({ kind: 'unconfirmed' });
  await pass(scheduler);
  await store.refresh();
  check('6.22 escrito y no visto: "no se sabe si llego", y no se reintenta', store.get(created.id)?.failure?.key === 'scheduledUnconfirmed' && state.delivered.length === 2,
    json(store.get(created.id)));
  state.now += 60_000;
  await pass(scheduler);
  check('6.22 ... ni a la vuelta siguiente', state.delivered.length === 2);
  await scheduler.stop();
}
{
  const { state, store, scheduler } = world52('w52b');
  await store.load();
  state.tabs = [{ terminalId: 'p1', agent: 'pi', sessionId: CODEX.sessionId, alive: false }];
  state.others = true;
  scheduler.start();
  const created = await scheduler.create(CODEX, 'pi', 'manana a las 9', T0 + 1000);
  state.now = T0 + 2000;
  await pass(scheduler);
  check('6.23 otra instancia corriendo y una CLI que no dice si otro la tiene: espera, sin abrir la pestana',
    state.woken.length === 0 && stateOf(scheduler, created.id)?.note?.key === 'scheduledWaitGrace', json(stateOf(scheduler, created.id)));
  state.now = T0 + 2000 + SCHEDULED_OTHER_INSTANCE_GRACE_MS - 1000;
  await pass(scheduler);
  check('6.23 todavia dentro del minuto: sigue esperando', state.woken.length === 0);
  state.now = T0 + 2000 + SCHEDULED_OTHER_INSTANCE_GRACE_MS + 100;
  await pass(scheduler);
  check('6.24 pasado el minuto: la abre y lo manda', json(state.woken) === json(['p1']) && state.delivered.length === 1);
  await scheduler.stop();
}
{
  const { state, store, scheduler } = world52('w52c');
  await store.load();
  state.tabs = [{ terminalId: 'k1', agent: 'claude-code', sessionId: CLAUDE.sessionId, alive: false }];
  state.others = true;
  scheduler.start();
  await scheduler.create(CLAUDE, 'claude-code', 'sigue', T0 + 1000);
  state.now = T0 + 2000;
  await pass(scheduler);
  check('6.25 Claude Code dice si otro proceso la tiene: no espera el minuto', json(state.woken) === json(['k1']) && state.delivered.length === 1);
  await scheduler.stop();
}
{
  const { state, store, scheduler } = world52('w52d');
  await store.load();
  state.tabs = [{ terminalId: 'p2', agent: 'pi', sessionId: CODEX.sessionId, alive: false }];
  state.others = false;
  scheduler.start();
  await scheduler.create(CODEX, 'pi', 'sola', T0 + 1000);
  state.now = T0 + 2000;
  await pass(scheduler);
  check('6.26 sin otra instancia, no espera', json(state.woken) === json(['p2']) && state.delivered.length === 1);
  await scheduler.stop();
}
{
  const instancesDir = path.join(dir, 'instances');
  const alive = new Set([4001, 4002]);
  const mine = new RunningInstances(instancesDir, 4001, (p) => alive.has(p));
  const other = new RunningInstances(instancesDir, 4002, (p) => alive.has(p));
  await mine.register();
  check('6.27 sola: no hay otra instancia', (await mine.othersRunning()) === false);
  await other.register();
  check('6.27 con otra viva: la hay', (await mine.othersRunning()) === true && (await other.othersRunning()) === true);
  alive.delete(4002);
  check('6.28 la otra se cerro de golpe: ya no cuenta, y su archivo se borra',
    (await mine.othersRunning()) === false && !(await readFile(path.join(instancesDir, '4002.json'), 'utf8').then(() => true, () => false)));
  await mine.unregister();
  check('6.29 al apagarse se saca', !(await readFile(path.join(instancesDir, '4001.json'), 'utf8').then(() => true, () => false)));
}

await rm(dir, { recursive: true, force: true });
console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
