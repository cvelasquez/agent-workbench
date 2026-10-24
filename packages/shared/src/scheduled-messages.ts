/**
 * Los mensajes programados (hito 51, §6.39): un mensaje del cuadro que la app
 * guarda y le manda sola a la conversacion a la hora elegida.
 *
 * El mensaje es de la **conversacion**, `(agent, sessionId)`, como el borrador
 * del cuadro (§6.29): el id de la pestana cambia en cada arranque. Lo guarda el
 * servidor en su carpeta de configuracion, y la web solo lo ve en la lista que
 * le manda (`schedule.list`), con la pestana que hoy tiene esa conversacion.
 *
 * Aca vive lo que comparten los dos lados: la forma que viaja, los topes y la
 * regla de que hora se acepta.
 */

import { AGENT_IDS, type AgentId } from './agents.js';
import type { TerminalId } from './models.js';
import { parseServerText, type ServerText } from './server-text.js';
import { asFiniteNumber, asLiteral, asNonEmptyString, asRecord, asString } from './validation.js';

/** Cuantos puede haber guardados a la vez, entre todas las conversaciones. */
export const MAX_SCHEDULED_MESSAGES = 50;

/**
 * El largo maximo del texto. Es el mismo tope que un envio del cuadro
 * (`MAX_SUBMIT_CHARS` del servidor): lo que se programa termina siendo eso.
 */
export const MAX_SCHEDULED_TEXT_CHARS = 200_000;

/** Hasta cuanto adelante se programa. Lejos de eso es casi siempre un error al elegir el mes. */
export const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * La hora de margen: si la app ve vencido un mensaje recien pasada esta
 * cantidad desde su hora (estaba cerrada o la PC suspendida), no lo manda
 * solo. Un "revisa los PR de hoy" que sale dos dias tarde puede hacer mas dano
 * que no salir.
 */
export const SCHEDULE_LATE_LIMIT_MS = 60 * 60 * 1000;

/**
 * En que esta un mensaje programado, en este servidor:
 *
 *  - `scheduled`: todavia no es la hora.
 *  - `waiting`: ya es la hora y algo lo frena (el agente trabaja, espera una
 *    respuesta, la conversacion esta abierta en otro programa). `note` dice que.
 *  - `sending`: abriendo la CLI o escribiendo.
 *  - `paused`: "Mensajes programados" esta apagado en Ajustes.
 *  - `failed`: no se envio, o no se sabe si llego. `note` dice por que. No se
 *    reintenta solo.
 */
export type ScheduledMessageState = 'scheduled' | 'waiting' | 'sending' | 'paused' | 'failed';

export const SCHEDULED_MESSAGE_STATES: readonly ScheduledMessageState[] = [
  'scheduled',
  'waiting',
  'sending',
  'paused',
  'failed',
];

export interface ScheduledMessage {
  id: string;
  agent: AgentId;
  sessionId: string;
  /** La pestana que hoy tiene esa conversacion en este servidor, o null si no hay. */
  terminalId: TerminalId | null;
  text: string;
  /** Cuando se manda, en milisegundos desde 1970. */
  sendAt: number;
  createdAt: number;
  state: ScheduledMessageState;
  /** Por que espera o por que no se envio. null en `scheduled`, `sending` y `paused`. */
  note: ServerText | null;
}

/** Por que no se acepta una hora: ya paso, o esta mas lejos que `MAX_SCHEDULE_AHEAD_MS`. */
export type ScheduleTimeProblem = 'past' | 'too-far';

/** null si `sendAt` se puede programar ahora. */
export function scheduleTimeProblem(sendAt: number, now: number): ScheduleTimeProblem | null {
  if (!Number.isFinite(sendAt) || sendAt <= now) return 'past';
  if (sendAt - now > MAX_SCHEDULE_AHEAD_MS) return 'too-far';
  return null;
}

/** Un mensaje programado tal como llega por la red, o null si no tiene la forma. */
export function parseScheduledMessage(value: unknown): ScheduledMessage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const agent = asLiteral(record['agent'], AGENT_IDS);
  const sessionId = asNonEmptyString(record['sessionId']);
  const rawTerminal = record['terminalId'];
  const terminalId = rawTerminal === null ? null : asNonEmptyString(rawTerminal);
  const text = asString(record['text']);
  const sendAt = asFiniteNumber(record['sendAt']);
  const createdAt = asFiniteNumber(record['createdAt']);
  const state = asLiteral(record['state'], SCHEDULED_MESSAGE_STATES);
  const rawNote = record['note'];
  const note = rawNote === null || rawNote === undefined ? null : parseServerText(rawNote);
  if (id === null || agent === null || sessionId === null || text === null || sendAt === null || createdAt === null) {
    return null;
  }
  if (state === null || (rawTerminal !== null && terminalId === null)) return null;
  if (rawNote !== null && rawNote !== undefined && note === null) return null;
  return { id, agent, sessionId, terminalId, text, sendAt, createdAt, state, note };
}
