/**
 * Cuanto de cada evento viaja al navegador.
 *
 * Es de todos los adaptadores y no de uno: una linea de historial pesa hasta
 * 290 KB con cualquier CLI, y el panel es un resumen navegable, no un visor de
 * adjuntos (§4.11 de CLAUDE.md). Dos CLIs con topes distintos harian que la
 * misma conversacion se leyera distinta segun quien la escribio.
 *
 * Los valores son los que tenia el seguidor de Claude Code antes de que hubiera
 * un segundo formato; moverlos aca no cambia ninguno.
 */

import type { ConversationEvent, ConversationPart } from '@agent-workbench/shared';

/** Texto de un mensaje. Alcanza para leer la respuesta sin traer un libro. */
export const TEXT_MAX_CHARS = 8_000;
/** Entrada de una herramienta. Un Write completo no aporta en el panel. */
export const TOOL_INPUT_MAX_CHARS = 2_000;
/** Resultado de una herramienta. Van colapsados por defecto. */
export const TOOL_RESULT_MAX_CHARS = 4_000;

/**
 * Los tres topes juntos, para quien lee una sesion con otros (hito 28).
 *
 * El hilo usa siempre `TRANSPORT_LIMITS`. La copia propia lee la misma sesion
 * por el mismo seguidor con topes mas altos —o sin tope, `Infinity`—: es lo que
 * deja que un formato nativo se interprete en un solo lugar.
 */
export interface EventLimits {
  textMaxChars: number;
  toolInputMaxChars: number;
  toolResultMaxChars: number;
}

/** Los de siempre: lo que viaja al navegador. */
export const TRANSPORT_LIMITS: EventLimits = Object.freeze({
  textMaxChars: TEXT_MAX_CHARS,
  toolInputMaxChars: TOOL_INPUT_MAX_CHARS,
  toolResultMaxChars: TOOL_RESULT_MAX_CHARS,
});

/** El mayor largo que se le pasa a `substr`: un entero de 32 bits con signo. */
const SQL_CUT_MAX = 2_147_483_647;

/**
 * El tercer argumento de `substr(x, 1, N)` para un tope: uno mas que el tope,
 * para saber si hubo recorte sin traer el resto.
 *
 * Existe porque `Infinity` no se puede ligar a un parametro de SQLite. Un tope
 * no finito, o que ya no entra, da el maximo: en la practica, sin recorte.
 */
export function sqlCutLength(limit: number): number {
  if (!Number.isFinite(limit)) return SQL_CUT_MAX;
  return Math.min(SQL_CUT_MAX, Math.max(0, Math.floor(limit)) + 1);
}

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Recorta a `limit` caracteres y dice si hubo que recortar. */
export function cut(raw: string, limit: number): Truncated {
  if (raw.length <= limit) return { text: raw, truncated: false };
  return { text: raw.slice(0, limit), truncated: true };
}

/**
 * Un evento ya entregado con unos topes, recortado a otros mas bajos.
 *
 * Existe por la copia propia (hito 28): guarda la sesion con topes altos, y lo
 * que se muestre de ella en el hilo tiene que salir igual que si se hubiera
 * leido con `TRANSPORT_LIMITS` desde el principio. Los adaptadores recortan al
 * final, sobre el texto ya armado, asi que recortar de nuevo da lo mismo; el
 * chequeo de la copia lo compara contra el seguidor normal (caso 3).
 *
 * Una parte que ya venia recortada lo sigue diciendo. Devuelve el mismo objeto
 * si no hubo nada que recortar.
 */
export function limitEvent(event: ConversationEvent, limits: EventLimits): ConversationEvent {
  let changed = false;
  const parts = event.parts.map((part): ConversationPart => {
    if (part.kind === 'text' && part.text.length > limits.textMaxChars) {
      changed = true;
      return { ...part, text: part.text.slice(0, limits.textMaxChars), truncated: true };
    }
    if (part.kind === 'tool-call' && part.input.length > limits.toolInputMaxChars) {
      changed = true;
      return { ...part, input: part.input.slice(0, limits.toolInputMaxChars), truncated: true };
    }
    if (part.kind === 'tool-result' && part.text.length > limits.toolResultMaxChars) {
      changed = true;
      return { ...part, text: part.text.slice(0, limits.toolResultMaxChars), truncated: true };
    }
    return part;
  });
  return changed ? { ...event, parts } : event;
}
