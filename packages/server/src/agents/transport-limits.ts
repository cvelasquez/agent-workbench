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

/** Texto de un mensaje. Alcanza para leer la respuesta sin traer un libro. */
export const TEXT_MAX_CHARS = 8_000;
/** Entrada de una herramienta. Un Write completo no aporta en el panel. */
export const TOOL_INPUT_MAX_CHARS = 2_000;
/** Resultado de una herramienta. Van colapsados por defecto. */
export const TOOL_RESULT_MAX_CHARS = 4_000;

export interface Truncated {
  text: string;
  truncated: boolean;
}

/** Recorta a `limit` caracteres y dice si hubo que recortar. */
export function cut(raw: string, limit: number): Truncated {
  if (raw.length <= limit) return { text: raw, truncated: false };
  return { text: raw.slice(0, limit), truncated: true };
}
