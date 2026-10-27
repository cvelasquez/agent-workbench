/**
 * Si la pantalla de Pi muestra su editor vacio y su interfaz ya arrancada,
 * lista para recibir un mensaje programado (hito 52, §16.21).
 *
 * Medido el 26-10-2026 con la 1.4.0, por la app (`medir-52.mjs`), reanudando
 * una sesion tres veces:
 *
 * ```
 * ─────────────────────────────            el borde de arriba del editor
 * ─────────────────────────────            el de abajo: el editor vacio en el medio
 * D:\aw-52\pi-proyecto
 * ↑1.2k ↓5 $0.003 (sub) 0.5%/272k (auto)   gpt-5.6-terra • medium
 * ```
 *
 * Ese es el primer cuadro al reanudar, **sin la cabecera**: ~0,1 s despues Pi
 * dibuja arriba su cabecera y la conversacion. Un Enter antes de la cabecera Pi
 * no lo manda ("Startup is still in progress", §16.4), asi que lista es:
 *
 *  - el editor (entre los dos ultimos bordes, `readPiQueueScreen`) vacio y nada
 *    en cola encima;
 *  - el borde de arriba sin estado: trabajando dice `── ⠋ Working ──`;
 *  - y algo dibujado arriba del editor: la cabecera o la conversacion.
 *
 * Pi publica ademas si trabaja (§16.6) y el dialogo de confianza (§16.11): el
 * reloj lo mira por el estado, aparte.
 */

import { readPiQueueScreen } from './queue-edit.js';

/** Un borde del editor, el mismo que mira `queue-edit.ts`. */
function isBorder(line: string): boolean {
  return /^─{2}.*─{6,}$/.test(line.trim());
}

export function piReadyScreen(lines: readonly string[]): boolean {
  const screen = readPiQueueScreen(lines);
  if (screen === null || screen.editor.length > 0 || screen.queued) return false;
  const borders: number[] = [];
  lines.forEach((line, index) => {
    if (isBorder(line)) borders.push(index);
  });
  const top = borders.at(-2);
  if (top === undefined) return false;
  // Trabajando, el borde lleva el estado ("⠋ Working").
  if (/[A-Za-z]/.test(lines[top] ?? '')) return false;
  return lines.slice(0, top).some((line) => line.trim() !== '' && !isBorder(line));
}
