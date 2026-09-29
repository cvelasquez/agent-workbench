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
 * Cuanto se espera el acuse de un envio antes de olvidarlo.
 *
 * El camino normal es de menos de un segundo: el texto y el Enter, a 400 ms uno
 * del otro. Con ocho imagenes y la espera del arranque de Codex (§10.11) son
 * unos seis. Un minuto es para un envio que espero detras de otro en la fila, y
 * para no dejar "Enviando…" colgado si la respuesta se perdio.
 */
export const SUBMIT_ACK_TIMEOUT_MS = 60_000;

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
  /** Epoch ms del navegador. */
  sentAt: number;
  /** Epoch ms del navegador al llegar el acuse, o null si todavia no llego. */
  deliveredAt: number | null;
}

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
  /** Cuando se la vio empezar a trabajar por ultima vez (`nextBusySince`), o null. */
  busySince: number | null;
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
 * Cuando se la vio empezar a trabajar, despues de un aviso de actividad.
 *
 * Solo un paso visto de "no trabaja" a "trabaja" dice cuando empezo. La primera
 * vez que se ve una pestana —al conectar, al lanzarla— ya trabajando, no se
 * sabe desde cuando, y queda null: el reloj no muestra un numero inventado. Al
 * terminar se conserva, porque es lo que dice que un envio ya se atendio.
 */
export function nextBusySince(
  previous: TerminalActivity | undefined,
  next: TerminalActivity | undefined,
  current: number | null,
  now: number,
): number | null {
  if (next === 'busy' && previous !== undefined && previous !== 'busy') return now;
  return current;
}

/** Que dice la fila sobre el agente principal, o null si no hay nada que decir. */
export function mainThreadStatus(input: ThreadStatusInput): MainStatus | null {
  // Sin CLI, o esperando al usuario: de eso hablan sus propias barras.
  if (!input.live || input.waitingFor !== null) return null;

  const { receipt, activity, now } = input;
  if (receipt !== null && receipt.phase === 'sending') return { kind: 'sending' };
  const deliveredAt = receipt?.deliveredAt ?? null;

  if (activity === 'busy') {
    return {
      kind: 'working',
      since: input.busySince,
      justDelivered: deliveredAt !== null && now - deliveredAt < DELIVERED_FLASH_MS,
    };
  }
  if (receipt === null || deliveredAt === null || repliedSince(receipt.afterEventId, input.events)) return null;

  // Sin estado publicado (Codex): lo unico que se sabe es que todavia no contesto.
  if (activity === 'unknown' || activity === null) return { kind: 'awaiting-reply', since: deliveredAt };
  if (activity !== 'idle') return null;

  // Libre: o todavia no lo tomo, o ya lo termino. Si se la vio trabajar desde el envio, lo termino.
  if (input.busySince !== null && input.busySince >= receipt.sentAt) return null;
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
