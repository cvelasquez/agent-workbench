/**
 * El reloj de los mensajes programados (hito 51, §6.39).
 *
 * Cada vuelta mira los mensajes guardados y, con los que ya son de su hora,
 * hace lo que dice la tabla de §6.39 segun como este su pestana:
 *
 * | La pestana... | Que se hace |
 * |---|---|
 * | tiene la CLI abierta y libre | se manda |
 * | tiene al agente trabajando o esperando una respuesta | se espera: no se mete en la cola, para no cambiarle la tarea a mitad |
 * | esta dormida o terminada | se abre la CLI, que retoma la conversacion, y se manda cuando esta lista |
 * | tiene la conversacion abierta en otro proceso | se espera; pasada la hora de margen, no se manda |
 *
 * **No nombra ninguna CLI** (§3.2): pregunta por las dependencias si la CLI
 * declara `scheduledSend`, si otro proceso tiene la conversacion y como se le
 * manda. Y **nunca manda dos veces**: lo que se corto escribiendo queda como
 * "no se sabe si llego", y solo lo vuelve a mandar el usuario.
 *
 * Desde el hito 52 tambien manda a Codex, Pi, Antigravity y OpenCode, que no
 * avisan cuando estan listas: como se les manda y como se confirma lo hace
 * `delivery.ts`; aca solo cambia como se sabe si la CLI esta libre (`freeNow`:
 * Codex no publica su estado, y lo dice el turno abierto de su historial) y que
 * se hace con dos resultados nuevos: la CLI siguio trabajando (se vuelve a
 * intentar) y lo escrito no aparecio (no se sabe si llego). Y con otra instancia
 * de la app corriendo, una CLI que no dice si otro proceso tiene la conversacion
 * espera un minuto antes de abrir una pestana dormida (`othersRunning`).
 *
 * La hora de margen (`SCHEDULE_LATE_LIMIT_MS`) cuenta desde la primera vez que
 * este proceso vio el mensaje vencido: si fue mucho despues de su hora (la app
 * estaba cerrada, la PC suspendida), no lo manda solo. Un mensaje que vencio
 * mientras el agente trabajaba no se vence nunca: espera lo que haga falta.
 */

import { randomUUID } from 'node:crypto';
import {
  MAX_SCHEDULED_MESSAGES,
  MAX_SCHEDULED_TEXT_CHARS,
  MAX_SCHEDULE_AHEAD_MS,
  SCHEDULE_LATE_LIMIT_MS,
  scheduleTimeProblem,
  serverText,
  type AgentId,
  type ScheduledMessage,
  type ScheduledMessageState,
  type ServerText,
  type TerminalActivity,
  type TerminalId,
} from '@agent-workbench/shared';
import type { DeliverOutcome } from '../deliver-when-ready.js';
import type { ScheduledDeliveryOutcome } from './delivery.js';
import type { ScheduleOwner, ScheduledMessageStore, StoredScheduledMessage } from './store.js';

/** Cada cuanto se revisa, como mucho. Un mensaje se manda a su hora: el reloj tambien apunta a la siguiente. */
export const SCHEDULER_TICK_MS = 30_000;

/** Cuanto se espera despues de un aviso (el agente quedo libre, se programo uno): junta los avisos seguidos. */
export const SCHEDULER_NUDGE_MS = 300;

/** Cuanto se espera, despues de abrir una pestana dormida, a que la CLI diga que esta lista. */
export const SCHEDULED_DELIVERY_TIMEOUT_MS = 60_000;

/**
 * Despues de mandarle uno a una pestana, cuanto espera el siguiente de la misma
 * pestana, ademas de que el agente vuelva a estar libre. Sin esto, dos que vencen
 * juntos salian seguidos: la CLI todavia no habia dicho que trabajaba con el
 * primero, y el segundo caia en el medio de su turno.
 */
export const SCHEDULED_COOLDOWN_MS = 10_000;

/**
 * Hito 52. Con otra instancia de la app corriendo, cuanto espera, desde que lo
 * vio vencido, antes de abrir una pestana dormida de una CLI que no dice si otro
 * proceso tiene la conversacion: la instancia que la tiene abierta lo reserva en
 * cuanto vence (51), y abrirla tambien serian dos procesos en la conversacion.
 */
export const SCHEDULED_OTHER_INSTANCE_GRACE_MS = 60_000;

/** Si la CLI de una pestana esta libre ahora, para el reloj. */
export type SchedulerFreeness = 'idle' | 'busy' | 'waiting' | 'unknown';

/** Una pestana de agente con conversacion, como la ve el reloj. */
export interface SchedulerTab {
  terminalId: TerminalId;
  agent: AgentId;
  sessionId: string;
  /** Con la CLI corriendo. false: dormida o terminada. */
  alive: boolean;
}

export interface SchedulerDeps {
  store: ScheduledMessageStore;
  now: () => number;
  /** "Mensajes programados" encendido en Ajustes, segun lo ultimo leido. */
  enabled: () => boolean;
  /** Relee el ajuste del disco: otra instancia pudo cambiarlo. */
  refreshEnabled?: () => Promise<void>;
  /** Las pestanas de agente que tienen conversacion. */
  tabs: () => SchedulerTab[];
  activityOf: (terminalId: TerminalId) => TerminalActivity | null;
  /**
   * Hito 52. Si la CLI de una pestana viva esta libre. Ausente: lo dice
   * `activityOf`, como en el 51. Con Codex, que no publica su estado, lo dice el
   * turno abierto de su historial.
   */
  freeNow?: (tab: SchedulerTab) => Promise<SchedulerFreeness>;
  /** Hito 52. Si otra instancia de la app esta corriendo sobre la misma carpeta de configuracion. */
  othersRunning?: () => Promise<boolean>;
  /** Hito 52. Si esa CLI dice cuando otro proceso tiene la conversacion (`isOpenElsewhere` sirve). */
  tellsOpenElsewhere?: (agent: AgentId) => boolean;
  /** El nombre de la CLI y si declara `scheduledSend`. null si este servidor no la tiene. */
  agentOf: (agent: AgentId) => { label: string; scheduledSend: boolean } | null;
  /** Si algun otro proceso tiene esa conversacion abierta ahora. */
  isOpenElsewhere: (agent: AgentId, sessionId: string) => Promise<boolean>;
  /** Abre la CLI de una pestana dormida. false si la pestana ya no esta; lanza si no se pudo abrir. */
  wake: (terminalId: TerminalId) => Promise<boolean>;
  /** Le manda el texto cuando la CLI esta lista, y dice si llego (`delivery.ts`). */
  deliver: (terminalId: TerminalId, text: string) => Promise<ScheduledDeliveryOutcome>;
  /** La lista cambio: va a todas las ventanas. */
  onChange: (messages: ScheduledMessage[]) => void;
  /** Inyectable para el chequeo. Devuelve como cancelarlo. */
  setTimer?: (callback: () => void, ms: number) => () => void;
  log?: (message: string) => void;
}

/** Lo que se necesita saber para aceptar un mensaje nuevo. */
export interface ScheduleCreateInput {
  enabled: boolean;
  /** La conversacion de la pestana, o null si no tiene. */
  owner: ScheduleOwner | null;
  /** El nombre de su CLI, o null si no es una pestana de agente. */
  agentLabel: string | null;
  capable: boolean;
  text: string;
  sendAt: number;
  now: number;
  /** Cuantos hay guardados. */
  count: number;
}

/** Por que no se acepta programar, o null si se acepta. Pura: la prueba el chequeo. */
export function scheduleCreateRefusal(input: ScheduleCreateInput): ServerText | null {
  if (!input.enabled) return serverText('scheduleOff');
  if (input.owner === null || input.agentLabel === null) return serverText('scheduleNoConversation');
  if (!input.capable) return serverText('scheduleUnsupported', { label: input.agentLabel });
  if (input.text.trim().length === 0) return serverText('scheduleEmpty');
  if (input.text.length > MAX_SCHEDULED_TEXT_CHARS) return serverText('scheduleTooLong', { max: MAX_SCHEDULED_TEXT_CHARS });
  const problem = scheduleTimeProblem(input.sendAt, input.now);
  if (problem === 'past') return serverText('schedulePast');
  if (problem === 'too-far') return serverText('scheduleTooFar', { days: Math.round(MAX_SCHEDULE_AHEAD_MS / 86_400_000) });
  if (input.count >= MAX_SCHEDULED_MESSAGES) return serverText('scheduleTooMany', { max: MAX_SCHEDULED_MESSAGES });
  return null;
}

/**
 * Que se anota de un envio que no termino bien, o null si llego. `busy` no
 * llega aca: no es una falla, se vuelve a intentar.
 */
export function scheduledFailureFor(outcome: DeliverOutcome | { kind: 'unconfirmed' }): ServerText | null {
  switch (outcome.kind) {
    case 'unconfirmed':
      // Se escribio y no aparecio en la conversacion: no se reintenta.
      return serverText('scheduledUnconfirmed');
    case 'sent':
    case 'nothing':
      return null;
    case 'gone':
    case 'no-agent':
      return serverText('scheduledNoTab');
    case 'no-session':
    case 'no-ready-signal':
    case 'no-images':
    case 'not-ready':
    case 'image-failed':
      // Nada escrito.
      return serverText('scheduledCliNotReady');
    case 'interrupted':
    case 'refused':
      // Pudo quedar a medias: no se sabe si llego.
      return serverText('scheduledUncertainWrite');
    case 'cli-draft':
      // La caja de la CLI tenia algo escrito que no se pudo apartar (§5.3.1). Nada escrito.
      return serverText('scheduledCliDraft');
  }
}

export type ScheduleCancelOutcome =
  | { kind: 'removed'; message: StoredScheduledMessage }
  | { kind: 'gone' }
  | { kind: 'sending' };

export type ScheduleSendNowOutcome = 'ok' | 'gone' | 'sending' | 'off';

interface RuntimeState {
  state: ScheduledMessageState;
  note: ServerText | null;
}

const defaultTimer = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class MessageScheduler {
  /** Lo que esta pasando con cada mensaje en este proceso: esperando, mandandose. No se guarda. */
  private readonly runtime = new Map<string, RuntimeState>();
  /** La primera vez que este proceso vio vencido cada mensaje: de ahi cuenta la hora de margen. */
  private readonly firstDue = new Map<string, number>();
  /** Los que se estan mandando ahora, desde este proceso. */
  private readonly inFlight = new Set<string>();
  /** La pestana de cada uno que se esta mandando: de a uno por pestana. */
  private readonly inFlightTabs = new Map<string, TerminalId>();
  /** Hasta cuando no se le manda otro a cada pestana (`SCHEDULED_COOLDOWN_MS`). */
  private readonly cooldownUntil = new Map<TerminalId, number>();
  /** Hito 52. Hasta cuando espera cada mensaje a la otra instancia (`SCHEDULED_OTHER_INSTANCE_GRACE_MS`). */
  private readonly graceUntil = new Map<string, number>();
  private ticking = false;
  private again = false;
  private stopped = true;
  private cancelTimer: (() => void) | null = null;
  private timerAt = Number.POSITIVE_INFINITY;
  private lastPublished = '';
  private readonly setTimer: (callback: () => void, ms: number) => () => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.setTimer = deps.setTimer ?? defaultTimer;
  }

  /** Arranca: despues de restaurar las pestanas, o no sabria cual es la de cada mensaje. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick();
  }

  /** Para el reloj y suelta lo reservado: una instancia que se apaga no se queda con nada. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.timerAt = Number.POSITIVE_INFINITY;
    await this.deps.store.releaseReserved();
  }

  /** Algo cambio (el agente quedo libre, se toco un ajuste): una vuelta pronto. */
  nudge(): void {
    if (this.stopped) return;
    this.schedule(SCHEDULER_NUDGE_MS);
  }

  /** La lista tal como va a las ventanas, con la pestana de hoy de cada conversacion. */
  snapshot(): ScheduledMessage[] {
    const tabs = this.deps.tabs();
    const now = this.deps.now();
    const enabled = this.deps.enabled();
    return this.deps.store
      .list()
      .sort((a, b) => a.sendAt - b.sendAt || a.createdAt - b.createdAt)
      .map((message) => {
        const tab = tabs.find((entry) => entry.agent === message.agent && entry.sessionId === message.sessionId);
        const running = this.runtime.get(message.id);
        let state: ScheduledMessageState;
        let note: ServerText | null = null;
        if (message.failure !== undefined) {
          state = 'failed';
          note = message.failure;
        } else if (this.inFlight.has(message.id)) {
          state = 'sending';
        } else if (!enabled) {
          state = 'paused';
        } else if (running !== undefined) {
          state = running.state;
          note = running.note;
        } else {
          state = now < message.sendAt ? 'scheduled' : 'waiting';
        }
        return {
          id: message.id,
          agent: message.agent,
          sessionId: message.sessionId,
          terminalId: tab?.terminalId ?? null,
          text: message.text,
          sendAt: message.sendAt,
          createdAt: message.createdAt,
          state,
          note,
        };
      });
  }

  /** Avisa la lista si cambio desde la ultima vez. Tambien cuando cambian las pestanas: cambia la de cada uno. */
  publish(): void {
    const list = this.snapshot();
    const key = JSON.stringify(list);
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.deps.onChange(list);
  }

  async create(owner: ScheduleOwner, agent: AgentId, text: string, sendAt: number): Promise<StoredScheduledMessage> {
    const message: StoredScheduledMessage = {
      id: randomUUID(),
      agent,
      sessionId: owner.sessionId,
      text,
      sendAt,
      createdAt: this.deps.now(),
    };
    await this.deps.store.add(message);
    this.publish();
    this.nudge();
    return message;
  }

  /** Lo saca, si no se esta mandando. Su texto vuelve al cuadro: lo hace quien llama. */
  async cancel(id: string): Promise<ScheduleCancelOutcome> {
    await this.deps.store.refresh();
    if (this.deps.store.get(id) === null) return { kind: 'gone' };
    if (this.inFlight.has(id)) return { kind: 'sending' };
    const claim = await this.deps.store.claimOf(id);
    // Otra instancia ya empezo a escribirlo: no se puede sacar a mitad.
    if (claim !== null && !claim.mine && claim.alive && claim.phase === 'writing') return { kind: 'sending' };
    const removed = await this.deps.store.remove(id);
    if (removed === null) return { kind: 'gone' };
    await this.deps.store.release(id);
    this.forget(id);
    this.publish();
    return { kind: 'removed', message: removed };
  }

  /** Lo pone a la hora de ahora y le borra la falla: se manda con las reglas de siempre. */
  async sendNow(id: string): Promise<ScheduleSendNowOutcome> {
    if (!this.deps.enabled()) return 'off';
    await this.deps.store.refresh();
    if (this.deps.store.get(id) === null) return 'gone';
    if (this.inFlight.has(id)) return 'sending';
    const claim = await this.deps.store.claimOf(id);
    if (claim !== null && !claim.mine && claim.alive && claim.phase === 'writing') return 'sending';
    const updated = await this.deps.store.update(id, { sendAt: this.deps.now(), failure: null });
    if (updated === null) return 'gone';
    this.forget(id);
    this.publish();
    this.nudge();
    return 'ok';
  }

  /** Se cerro la pestana: lo de su conversacion se cancela (la web lo pregunto antes). */
  async dropOwner(owner: ScheduleOwner): Promise<void> {
    const removed = await this.deps.store.removeOwner(owner);
    for (const message of removed) {
      if (!this.inFlight.has(message.id)) await this.deps.store.release(message.id);
      this.forget(message.id);
    }
    if (removed.length > 0) this.publish();
  }

  /** La pestana cambio de conversacion: lo programado va con ella, como el borrador. */
  async moveOwner(from: ScheduleOwner, to: ScheduleOwner): Promise<void> {
    if ((await this.deps.store.move(from, to)) > 0) {
      this.publish();
      this.nudge();
    }
  }

  /** Una vuelta. Nunca dos a la vez: la que llega mientras corre otra se hace despues. */
  async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      await this.pass();
    } catch (error) {
      this.deps.log?.(`[scheduled] a pass failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ticking = false;
      this.publish();
      if (this.again) {
        this.again = false;
        this.schedule(0);
      } else {
        this.scheduleNext();
      }
    }
  }

  // ---- por dentro ----

  private forget(id: string): void {
    this.runtime.delete(id);
    this.firstDue.delete(id);
    this.graceUntil.delete(id);
  }

  private set(id: string, state: ScheduledMessageState, note: ServerText | null): void {
    this.runtime.set(id, { state, note });
  }

  /** true si a esa pestana ya se le esta mandando uno, o se le mando hace muy poco. */
  private tabCooling(terminalId: TerminalId, now: number): boolean {
    if ((this.cooldownUntil.get(terminalId) ?? 0) > now) return true;
    for (const tab of this.inFlightTabs.values()) {
      if (tab === terminalId) return true;
    }
    return false;
  }

  private async fail(id: string, note: ServerText): Promise<void> {
    await this.deps.store.update(id, { failure: note });
    await this.deps.store.release(id);
    this.set(id, 'failed', note);
    this.firstDue.delete(id);
  }

  /** Una vuelta dentro de `ms`, salvo que ya haya una antes. */
  private schedule(ms: number): void {
    if (this.stopped) return;
    const at = this.deps.now() + ms;
    if (this.cancelTimer !== null && this.timerAt <= at) return;
    this.cancelTimer?.();
    this.timerAt = at;
    this.cancelTimer = this.setTimer(() => {
      this.cancelTimer = null;
      this.timerAt = Number.POSITIVE_INFINITY;
      void this.tick();
    }, ms);
  }

  /** La proxima vuelta: a la hora del proximo mensaje, o a los 30 s, lo que llegue antes. */
  private scheduleNext(): void {
    const now = this.deps.now();
    let wait = SCHEDULER_TICK_MS;
    if (this.deps.enabled()) {
      for (const message of this.deps.store.list()) {
        if (message.failure !== undefined || message.sendAt <= now) continue;
        wait = Math.min(wait, message.sendAt - now + 20);
      }
      // Y apenas termina la espera de una pestana: el siguiente de ella sale ahi.
      for (const until of this.cooldownUntil.values()) {
        if (until > now) wait = Math.min(wait, until - now + 20);
      }
      // Y apenas termina el minuto de espera a la otra instancia.
      for (const until of this.graceUntil.values()) {
        if (until > now) wait = Math.min(wait, until - now + 20);
      }
    }
    this.schedule(Math.max(0, wait));
  }

  private async pass(): Promise<void> {
    const { store } = this.deps;
    await store.refresh();
    await this.deps.refreshEnabled?.();
    const messages = store.list().sort((a, b) => a.sendAt - b.sendAt || a.createdAt - b.createdAt);
    const present = new Set(messages.map((message) => message.id));
    for (const id of [...this.runtime.keys()]) {
      if (!present.has(id)) this.forget(id);
    }
    // El reclamo de uno que ya no esta (se mando o se cancelo desde otra instancia): el propio se suelta.
    for (const id of await store.claimedIds()) {
      if (present.has(id) || this.inFlight.has(id)) continue;
      await store.release(id);
      await store.discardOrphan(id);
    }
    const tabs = this.deps.tabs();
    for (const message of messages) {
      if (this.stopped) return;
      if (this.inFlight.has(message.id)) continue;
      await this.consider(message, tabs);
    }
  }

  private async consider(message: StoredScheduledMessage, tabs: SchedulerTab[]): Promise<void> {
    const { store } = this.deps;
    const { id } = message;
    const now = this.deps.now();

    if (message.failure !== undefined) {
      this.set(id, 'failed', message.failure);
      return;
    }
    if (!this.deps.enabled()) {
      // En pausa no se reserva nada: la hora de margen vuelve a contar al encenderlo.
      this.firstDue.delete(id);
      await store.release(id);
      this.set(id, 'paused', null);
      return;
    }
    if (now < message.sendAt) {
      this.firstDue.delete(id);
      this.set(id, 'scheduled', null);
      return;
    }
    const firstDue = this.firstDue.get(id) ?? now;
    this.firstDue.set(id, firstDue);

    const claim = await store.claimOf(id);
    if (claim !== null && !claim.mine) {
      if (claim.alive) {
        this.set(id, 'waiting', serverText('scheduledWaitOtherInstance'));
        return;
      }
      if (claim.phase === 'writing') {
        // Una instancia murio escribiendolo: no se sabe si llego, y no se reintenta.
        await this.fail(id, serverText('scheduledUncertain'));
        await store.discardOrphan(id);
        return;
      }
    }
    const mine = claim?.mine === true;
    if (!mine && firstDue - message.sendAt > SCHEDULE_LATE_LIMIT_MS) {
      await this.fail(id, serverText('scheduledMissed'));
      return;
    }
    const overdue = now - message.sendAt > SCHEDULE_LATE_LIMIT_MS;

    const tab = tabs.find((entry) => entry.agent === message.agent && entry.sessionId === message.sessionId) ?? null;
    if (tab === null) {
      if (mine) await store.release(id);
      if (overdue) await this.fail(id, serverText('scheduledNoTab'));
      else this.set(id, 'waiting', serverText('scheduledWaitNoTab'));
      return;
    }
    const agent = this.deps.agentOf(tab.agent);
    if (agent === null || !agent.scheduledSend) {
      await this.fail(id, serverText('scheduleUnsupported', { label: agent?.label ?? tab.agent }));
      return;
    }

    if (tab.alive) {
      // Se reserva ya, aunque haya que esperar: otra instancia con la pestana dormida no la abre.
      if ((await store.claim(id)) !== 'mine') {
        this.set(id, 'waiting', serverText('scheduledWaitOtherInstance'));
        return;
      }
      const free = await this.freeNow(tab);
      if (free === 'idle' && !this.tabCooling(tab.terminalId, now)) {
        this.startDelivery(message, tab, false);
        return;
      }
      this.set(id, 'waiting', free === 'waiting' ? serverText('scheduledWaitAnswer') : serverText('scheduledWaitBusy'));
      return;
    }

    // Otro de la misma pestana la esta abriendo: este espera su turno.
    if (this.tabCooling(tab.terminalId, now)) {
      this.set(id, 'waiting', serverText('scheduledWaitBusy'));
      return;
    }

    /*
      Hito 52. Una CLI que no dice si otro proceso tiene la conversacion, con
      otra instancia de la app corriendo: un minuto de espera, por si la tiene
      abierta la otra, que lo reserva en cuanto vence.
    */
    if (!mine && this.deps.tellsOpenElsewhere?.(tab.agent) === false && (await this.deps.othersRunning?.()) === true) {
      const graceEnd = firstDue + SCHEDULED_OTHER_INSTANCE_GRACE_MS;
      if (now < graceEnd) {
        this.graceUntil.set(id, graceEnd);
        this.set(id, 'waiting', serverText('scheduledWaitGrace'));
        return;
      }
    }
    this.graceUntil.delete(id);

    // Dormida o terminada. Si otro proceso tiene la conversacion, abrirla serian dos.
    if (await this.deps.isOpenElsewhere(tab.agent, tab.sessionId)) {
      if (mine) await store.release(id);
      if (overdue) await this.fail(id, serverText('scheduledElsewhereTimeout'));
      else this.set(id, 'waiting', serverText('scheduledWaitElsewhere'));
      return;
    }
    const claimed = await store.claim(id);
    if (claimed === 'orphan-writing') {
      await this.fail(id, serverText('scheduledUncertain'));
      await store.discardOrphan(id);
      return;
    }
    if (claimed !== 'mine') {
      this.set(id, 'waiting', serverText('scheduledWaitOtherInstance'));
      return;
    }
    this.startDelivery(message, tab, true);
  }

  /** Si la CLI de la pestana esta libre: `freeNow`, o la actividad del registro. */
  private async freeNow(tab: SchedulerTab): Promise<SchedulerFreeness> {
    if (this.deps.freeNow !== undefined) return this.deps.freeNow(tab);
    const activity = this.deps.activityOf(tab.terminalId);
    return activity === 'idle' || activity === 'busy' || activity === 'waiting' ? activity : 'unknown';
  }

  private startDelivery(message: StoredScheduledMessage, tab: SchedulerTab, wake: boolean): void {
    const { store } = this.deps;
    const { id } = message;
    this.inFlight.add(id);
    this.inFlightTabs.set(id, tab.terminalId);
    this.runtime.delete(id);
    this.publish();
    void (async () => {
      let failure: ServerText | null = null;
      let delivered = false;
      let cancelled = false;
      // Hito 52: la CLI siguio trabajando todo el plazo; no se escribio nada y se vuelve a intentar.
      let stillBusy = false;
      try {
        // Lo pudieron cancelar desde otra ventana o desde la otra instancia en el medio.
        await store.refresh();
        if (store.get(id) === null) {
          cancelled = true;
        } else {
          // Desde aca, si este proceso se muere, no se sabe si llego: no se reintenta.
          await store.setPhase(id, 'writing');
          if (wake && !(await this.deps.wake(tab.terminalId))) failure = serverText('scheduledNoTab');
          if (failure === null) {
            const outcome = await this.deps.deliver(tab.terminalId, message.text);
            if (outcome.kind === 'busy') {
              stillBusy = true;
            } else {
              failure = scheduledFailureFor(outcome);
              delivered = failure === null;
            }
          }
        }
      } catch (error) {
        this.deps.log?.(`[scheduled] couldn't open the CLI for ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
        failure = serverText('scheduledCliOpenFailed');
      }
      try {
        if (delivered) await store.remove(id);
        else if (!cancelled && failure !== null) await store.update(id, { failure });
      } catch (error) {
        this.deps.log?.(`[scheduled] couldn't save what happened to ${id.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await store.release(id).catch(() => undefined);
        this.inFlight.delete(id);
        this.inFlightTabs.delete(id);
        if (!cancelled) this.cooldownUntil.set(tab.terminalId, this.deps.now() + SCHEDULED_COOLDOWN_MS);
        this.forget(id);
        if (stillBusy) this.set(id, 'waiting', serverText('scheduledWaitBusy'));
        this.publish();
        this.nudge();
      }
    })();
  }
}
