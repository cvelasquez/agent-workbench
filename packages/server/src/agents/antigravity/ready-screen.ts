/**
 * Si la pantalla de Antigravity muestra su caja vacia, lista para recibir un
 * mensaje programado (hito 52, §12.17).
 *
 * Medido el 26-10-2026 con la 1.4.6, por la app (`medir-52.mjs`), retomando una
 * conversacion tres veces:
 *
 * ```
 * ──────────────────────────────────────
 * > Accept-edits mode: file edits auto-approved (shift+tab to cycle)    la caja vacia: el texto es de ayuda
 * ──────────────────────────────────────
 * ? for shortcuts                                         accept-edits
 * ```
 * ```
 * ⣷  Generating...                                         trabajando
 * ──────────────────────────────────────
 * >
 * ──────────────────────────────────────
 * esc to cancel  accept-edits · Gemini 3.8 Flash · high
 * ```
 *
 *  - **El texto de ayuda de la caja no se distingue de uno escrito** en una
 *    pantalla sin colores: lo que dice que la caja esta vacia es el pie, que
 *    empieza con "? for shortcuts" solo entonces. Con texto escrito el pie no lo
 *    trae, y trabajando dice "esc to cancel".
 *  - **Lo que de verdad dice que esta libre es su status line** (§12.9): el
 *    reloj escribe con la pestana libre, y al retomar el primer "libre" escrito
 *    despues de lanzarla llego cuando la pantalla ya aceptaba un pegado (3 de 3).
 *    La pantalla es la segunda llave.
 */

import { readAntigravityQueueScreen } from './queue-edit.js';

export function antigravityReadyScreen(lines: readonly string[]): boolean {
  const screen = readAntigravityQueueScreen(lines);
  if (screen === null || screen.queued) return false;
  const tail = lines.filter((line) => line.trim() !== '').slice(-3);
  if (tail.some((line) => /esc to cancel|Generating/.test(line))) return false;
  return tail.some((line) => /^\s*\? for shortcuts/.test(line));
}
