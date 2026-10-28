/**
 * "Editar" en la burbuja "enviado" (§6.35.2) pide lo mismo que Detener, y la
 * CLI devuelve el mensaje con el motivo de Detener (`stopped-early`, §4.16). Lo
 * que cambia es que lo pidio el usuario para corregirlo: el texto vuelve al
 * cuadro con el foco y sin aviso, como al sacar la cola (§6.35.1).
 *
 * Esto recuerda, por pestana, que el proximo `stopped-early` viene de un
 * "Editar". El texto vuelve solo a la ventana que lo pidio, asi que alcanza con
 * la memoria de esta.
 */

import type { TerminalId } from '@agent-workbench/shared';

/** Cuanto se espera el texto: Esc, que la CLI quede libre y la vuelta al cuadro tardan un par de segundos. */
export const EDIT_STOP_HOLD_MS = 20_000;

const pending = new Map<TerminalId, number>();

/** Se pidio "Editar" en esa pestana. */
export function markEditStop(terminalId: TerminalId, now: number = Date.now()): void {
  pending.set(terminalId, now);
}

/** true si el `stopped-early` que llego viene de un "Editar" reciente. Lo olvida. */
export function takeEditStop(terminalId: TerminalId, now: number = Date.now()): boolean {
  const at = pending.get(terminalId);
  pending.delete(terminalId);
  return at !== undefined && now - at <= EDIT_STOP_HOLD_MS;
}
