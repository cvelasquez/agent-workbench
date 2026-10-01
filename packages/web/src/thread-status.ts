/**
 * La fila de estado al pie del hilo (§6.30): si lo que se mando llego a la CLI,
 * si la CLI esta trabajando, y que subagentes siguen andando.
 *
 * Existe por lo que se hacia a mano: despues de mandar, el hilo mostraba el
 * mensaje propio y nada mas hasta que la CLI corria una herramienta o
 * contestaba, y para saber si habia llegado habia que ir a mirar la solapa CLI.
 * Y un subagente en segundo plano deja al agente principal con el turno
 * cerrado, esperandolo: el hilo parecia terminado.
 *
 * Tres fuentes, y cada una dice una sola cosa:
 *
 *  - **El acuse del envio** (`agent.submitted`): se escribio en la CLI hasta el
 *    Enter. No dice que la CLI lo tomo.
 *  - **La actividad** (`terminal.activity`): la CLI esta trabajando. Solo la de
 *    una CLI que publica su estado; la que no lo publica dice `unknown`, y ahi
 *    lo unico que se sabe es si ya contesto algo desde el envio.
 *  - **Los subagentes** (`conversation.subagents`), que calcula el servidor.
 *
 * Los tiempos del envio son del reloj del navegador y se comparan solo con el:
 * con el acceso remoto (§14) el del servidor puede ser otro.
 *
 * Sin JSX ni navegador: lo importa `check-thread-status.mjs`.
 */

import type {
  ConversationEvent,
  ConversationSubagent,
  TerminalActivity,
  TerminalId,
} from '@agent-workbench/shared';
import { formatList, formatRoughDuration } from './i18n/format.js';
import { t } from './i18n/index.js';

/**
 * Cuanto se dice "Enviando…" de un envio que ya salio, sin acuse.
 *
 * El camino normal es de menos de un segundo: el texto y el Enter, a 400 ms uno
 * del otro. Con ocho imagenes y la espera del arranque de Codex (§10.11) son
 * unos seis. Un minuto es para un envio que espero detras de otro en la fila, y
 * para no dejar "Enviando…" colgado si el acuse se perdio. Un acuse que llega
 * despues todavia cuenta (`applySubmitAck`): es cierto que llego.
 */
export const SUBMIT_ACK_TIMEOUT_MS = 60_000;

/**
 * Cuanto se dice "todavia sin respuesta" en una CLI que no publica su estado.
 * Un mensaje que no abre un turno —un comando de barra— no trae respuesta
 * nunca, y el aviso no puede quedar hasta el envio siguiente. Diez minutos
 * cubren un razonamiento largo antes del primer evento.
 */
export const AWAITING_REPLY_HOLD_MS = 10 * 60_000;

/**
 * Cuanto se dice "Entregado" en una CLI que publica su estado y no se puso a
 * trabajar. Claude Code pasa a trabajar en menos de un segundo; si no lo hizo
 * en quince, el mensaje era algo que no abre un turno, y el aviso ya no dice
 * nada util.
 */
export const DELIVERED_HOLD_MS = 15_000;

/**
 * Cuanto se ve "mensaje entregado" al lado de "Trabajando", con la CLI ya
 * ocupada: un mensaje escrito mientras trabaja lo toma a mitad de camino
 * (§4.4.1), y la marca confirma que llego sin tapar lo demas.
 */
export const DELIVERED_FLASH_MS = 4_000;

/** Cuantos subagentes se nombran en la fila. El resto se cuenta. */
export const NAMED_SUBAGENTS = 3;

/** El ultimo envio del cuadro de una pestana, mientras importa. */
export interface SubmitReceipt {
  requestId: string;
  terminalId: TerminalId;
  /**
   * El ultimo evento del hilo al mandar, o null si estaba vacio. Lo que llegue
   * despues de el es la respuesta: se cuenta por posicion y no por hora.
   */
  afterEventId: string | null;
  phase: 'sending' | 'delivered';
  /**
   * true mientras el envio espera en la cola de la conexion, con el socket
   * caido. Sale al reconectar (`receiptsAfterReopen`); hasta entonces no corre
   * el plazo del acuse.
   */
  queued: boolean;
  /** Epoch ms del navegador en que salio por el socket: al reconectar, si estaba en cola. */
  sentAt: number;
  /** Epoch ms del navegador al llegar el acuse, o null si todavia no llego. */
  deliveredAt: number | null;
}

/** Lo que se sabe de cuando trabajo la CLI de una pestana, visto desde la pagina. */
export interface BusyClock {
  /**
   * Cuando se la vio empezar la corrida de ahora, o null: no esta trabajando, o
   * ya trabajaba cuando se la empezo a mirar y no se sabe desde cuando.
   */
  runStartedAt: number | null;
  /** La ultima vez que se la supo trabajando, o null si nunca. */
  busySeenAt: number | null;
}

export const NO_BUSY_CLOCK: BusyClock = { runStartedAt: null, busySeenAt: null };

export type MainStatus =
  | { kind: 'sending' }
  | { kind: 'delivered' }
  /** `since`: cuando se vio empezar; null si ya trabajaba al mirar. */
  | { kind: 'working'; since: number | null; justDelivered: boolean }
  /** Una CLI que no publica su estado: entregado, y todavia sin respuesta. */
  | { kind: 'awaiting-reply'; since: number };

export interface ThreadStatusInput {
  /** true si la pestana tiene la CLI corriendo. Sin CLI habla la barra de abrirla. */
  live: boolean;
  activity: TerminalActivity | null;
  /** La CLI espera algo del usuario: de eso ya habla su barra. */
  waitingFor: string | null;
  receipt: SubmitReceipt | null;
  events: readonly ConversationEvent[];
  /** Cuando trabajo la CLI de la pestana (`nextBusyClock`), o null si no se sabe nada. */
  clock: BusyClock | null;
  now: number;
}

/** Un id para un envio. `crypto.randomUUID` existe en 127.0.0.1, que es contexto seguro. */
export function newSubmitRequestId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `submit-${uuid}`;
}

/**
 * true si despues de `afterEventId` ya hay algo del agente: contesto, o corrio
 * una herramienta. Si ese evento ya no esta en la lista —la pestana se releyo y
 * quedo fuera del tramo— se da por contestado: es la falla que no deja un aviso
 * colgado.
 */
export function repliedSince(afterEventId: string | null, events: readonly ConversationEvent[]): boolean {
  let from = 0;
  if (afterEventId !== null) {
    const index = events.findIndex((event) => event.eventId === afterEventId);
    if (index === -1) return true;
    from = index + 1;
  }
  for (let index = from; index < events.length; index += 1) {
    if (events[index]?.role === 'assistant') return true;
  }
  return false;
}

/**
 * El reloj de una pestana despues de un aviso de actividad.
 *
 *  - **Una corrida empieza al verla pasar de libre a trabajando.** La primera
 *    vez que se ve una pestana —al conectar, al lanzarla— ya trabajando, no se
 *    sabe desde cuando, y queda null: el reloj no muestra un numero inventado.
 *  - **Esperar al usuario no la corta**: aprobar un permiso a mitad de turno
 *    (`waiting` → `busy`) sigue la misma corrida, con el mismo reloj.
 *  - **Cualquier otro estado la termina**, y la siguiente arranca de cero: el
 *    tiempo de un turno viejo no aparece al empezar el nuevo.
 *  - `busySeenAt` se anota al entrar y al salir de `busy`: dice que un envio ya
 *    se atendio aunque la CLI estuviera trabajando antes de recibirlo.
 */
export function nextBusyClock(
  previous: TerminalActivity | undefined,
  next: TerminalActivity | undefined,
  clock: BusyClock,
  now: number,
): BusyClock {
  const busySeenAt = next === 'busy' || previous === 'busy' ? now : clock.busySeenAt;
  let runStartedAt: number | null = null;
  if (next === 'busy') {
    if (previous === 'idle') runStartedAt = now;
    else if (previous === 'busy' || previous === 'waiting') runStartedAt = clock.runStartedAt;
  } else if (next === 'waiting') {
    runStartedAt = clock.runStartedAt;
  }
  return { runStartedAt, busySeenAt };
}

/**
 * Los relojes de todas las pestanas despues de un cambio del mapa de actividad.
 * Una pestana que ya no esta en el mapa —su CLI termino— se olvida.
 */
export function nextBusyClocks(
  previous: ReadonlyMap<TerminalId, TerminalActivity>,
  next: ReadonlyMap<TerminalId, TerminalActivity>,
  clocks: ReadonlyMap<TerminalId, BusyClock>,
  now: number,
): Map<TerminalId, BusyClock> {
  const result = new Map<TerminalId, BusyClock>();
  for (const [terminalId, activity] of next) {
    const before = previous.get(terminalId);
    const clock = clocks.get(terminalId);
    result.set(
      terminalId,
      clock !== undefined && before === activity ? clock : nextBusyClock(before, activity, clock ?? NO_BUSY_CLOCK, now),
    );
  }
  return result;
}

/**
 * Los envios despues de una reconexion. La conexion ya mando lo que tenia en
 * cola —lo hace antes de avisar que volvio—, y el servidor contesta cada envio
 * por el socket que lo trajo:
 *
 *  - el que esperaba en la cola acaba de salir por el socket nuevo, y su acuse
 *    va a llegar por ahi: se sigue esperando, ya sin cola y con el plazo desde
 *    ahora;
 *  - el que habia salido por el socket que se cayo no va a tener acuse nunca: se
 *    olvida.
 */
export function receiptsAfterReopen(
  receipts: ReadonlyMap<TerminalId, SubmitReceipt>,
  now: number,
): Map<TerminalId, SubmitReceipt> {
  const next = new Map<TerminalId, SubmitReceipt>();
  for (const [terminalId, receipt] of receipts) {
    if (receipt.phase !== 'sending') next.set(terminalId, receipt);
    else if (receipt.queued) next.set(terminalId, { ...receipt, queued: false, sentAt: now });
  }
  return next;
}

/**
 * Un acuse del servidor. Solo cuenta el del ultimo envio de la pestana: uno
 * viejo que contesta tarde no pisa nada. El del ultimo si cuenta aunque llegue
 * pasado el plazo. Devuelve el mismo mapa si no cambia nada.
 */
export function applySubmitAck(
  receipts: Map<TerminalId, SubmitReceipt>,
  ack: { terminalId: TerminalId; requestId: string; delivered: boolean },
  now: number,
): Map<TerminalId, SubmitReceipt> {
  const receipt = receipts.get(ack.terminalId);
  if (receipt === undefined || receipt.requestId !== ack.requestId) return receipts;
  const next = new Map(receipts);
  if (ack.delivered) next.set(ack.terminalId, { ...receipt, phase: 'delivered', queued: false, deliveredAt: now });
  else next.delete(ack.terminalId);
  return next;
}

/** Que dice la fila sobre el agente principal, o null si no hay nada que decir. */
export function mainThreadStatus(input: ThreadStatusInput): MainStatus | null {
  // Sin CLI, o esperando al usuario: de eso hablan sus propias barras.
  if (!input.live || input.waitingFor !== null) return null;

  const { receipt, activity, now } = input;
  const clock = input.clock ?? NO_BUSY_CLOCK;
  // En cola espera lo que tarde la conexion; ya salido, hasta el plazo del acuse.
  if (receipt?.phase === 'sending' && (receipt.queued || now - receipt.sentAt < SUBMIT_ACK_TIMEOUT_MS)) {
    return { kind: 'sending' };
  }
  const deliveredAt = receipt?.phase === 'delivered' ? receipt.deliveredAt : null;

  if (activity === 'busy') {
    return {
      kind: 'working',
      since: clock.runStartedAt,
      justDelivered: deliveredAt !== null && now - deliveredAt < DELIVERED_FLASH_MS,
    };
  }
  if (receipt === null || deliveredAt === null || repliedSince(receipt.afterEventId, input.events)) return null;

  // Sin estado publicado (Codex): lo unico que se sabe es que todavia no contesto, y por un rato.
  if (activity === 'unknown') {
    return now - deliveredAt < AWAITING_REPLY_HOLD_MS ? { kind: 'awaiting-reply', since: deliveredAt } : null;
  }
  // Libre, o una CLI con estado que todavia no lo publico: o no lo tomo, o ya lo termino.
  if (activity !== 'idle' && activity !== null) return null;
  if (clock.busySeenAt !== null && clock.busySeenAt >= receipt.sentAt) return null;
  return now - deliveredAt < DELIVERED_HOLD_MS ? { kind: 'delivered' } : null;
}

/**
 * El texto de la fila del agente principal. El reloj aparece desde el primer
 * segundo: "menos de 1 s" al lado de algo que recien empieza no dice nada.
 */
export function mainStatusText(status: MainStatus, now: number): string {
  switch (status.kind) {
    case 'sending':
      return t('thread.status.sending');
    case 'delivered':
      return t('thread.status.delivered');
    case 'working': {
      const elapsed = status.since === null ? 0 : now - status.since;
      if (elapsed < 1_000) {
        return status.justDelivered ? t('thread.status.workingDelivered') : t('thread.status.working');
      }
      const params = { elapsed: formatRoughDuration(elapsed) };
      return status.justDelivered ? t('thread.status.workingForDelivered', params) : t('thread.status.workingFor', params);
    }
    case 'awaiting-reply': {
      const elapsed = now - status.since;
      if (elapsed < 1_000) return t('thread.status.delivered');
      return t('thread.status.awaitingReply', { elapsed: formatRoughDuration(elapsed) });
    }
  }
}

/**
 * El texto de los subagentes: cuantos, y los primeros por su nombre con cuanto
 * llevan. El tiempo es del reloj del servidor contra el del navegador; con el
 * acceso remoto pueden diferir, y por eso nunca baja de cero.
 */
export function subagentsText(subagents: readonly ConversationSubagent[], now: number): string {
  const named = subagents.slice(0, NAMED_SUBAGENTS).map((subagent) =>
    t('thread.status.subagent', {
      name: subagent.description.length > 0 ? subagent.description : t('thread.status.subagentUnnamed'),
      elapsed: formatRoughDuration(Math.max(0, now - subagent.startedAt)),
    }),
  );
  const rest = subagents.length - named.length;
  if (rest > 0) named.push(t('thread.status.subagentsMore', { count: rest }));
  return t('thread.status.subagents', { count: subagents.length, list: formatList(named) });
}
