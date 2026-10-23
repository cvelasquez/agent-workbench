/**
 * Sacar la cola de Pi para editarla en el cuadro (§6.35.1, §16.18).
 *
 * Medido con la 1.3.0 en Windows (`s15`), con un `ping` corriendo y dos
 * mensajes en cola:
 *
 * ```
 *  Steering: Mensaje B en cola
 *  Steering: Mensaje C en cola
 *  ↳ Alt+Q to edit all queued messages
 * ── ⠸ Working ─────────────────            el borde de arriba del editor
 *                                            el editor, vacio
 * ──────────────────────────────            el de abajo
 * ```
 *
 *  - **Alt+Q** (`app.message.dequeue`; `alt+up` fuera de Windows) devuelve
 *    todo al editor, separado por una linea en blanco y delante de lo que
 *    hubiera ("Restored 2 queued messages to editor"), **sin cortar el turno**.
 *    Sin nada en cola dice "No queued messages to restore" y no toca el editor.
 *  - **Ctrl+C lo vacia** y, con el agente trabajando, no interrumpe (16.5).
 *    Dos a menos de 500 ms la cierran: se separa del anterior (`clearGapMs`).
 *  - Ninguno de los dos llego a la sesion.
 *
 * Pi no escribe su cola en ningun lado: lo que vuelve al cuadro es lo que la app
 * le mando (`QueueEditContext.queued`). Puro salvo `io`: lo prueba
 * `check-thread-status.mjs` con pantallas medidas.
 */

import type { QueueEditContext, QueueEditDriver, QueueEditOutcome, RewindIo } from '../adapter.js';
import { waitForStableScreen, type ScreenWaitTiming } from '../screen-wait.js';
import { PI_CLEAR_GAP_MS } from './constants.js';

/**
 * Alt+Q en Windows: Alt es un Esc delante de la letra, en un solo write (como
 * Alt+M en Antigravity, §12.13). Fuera de Windows la tecla es Alt+Up, sin medir.
 */
export function piDequeueKeys(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? '\x1bq' : '\x1b[1;3A';
}

const CLEAR_EDITOR = '\x03';
const QUEUE_HINT = /to edit all queued messages/;
const NOTHING_QUEUED = 'No queued messages to restore';

/** Un borde del editor: `──` al principio y al final, con o sin el estado en el medio. */
function isBorder(line: string): boolean {
  return /^─{2}.*─{6,}$/.test(line.trim());
}

/**
 * Lo que dice la pantalla de Pi: si muestra algo en cola y que tiene el editor
 * (las lineas entre los dos ultimos bordes, sin las vacias del final). null si
 * no se ve el editor.
 */
export function readPiQueueScreen(lines: readonly string[]): { queued: boolean; editor: string[]; nothingQueued: boolean } | null {
  const borders: number[] = [];
  lines.forEach((line, index) => {
    if (isBorder(line)) borders.push(index);
  });
  const [top, bottom] = borders.slice(-2);
  if (top === undefined || bottom === undefined) return null;
  const editor = lines.slice(top + 1, bottom).map((line) => line.trimEnd());
  while (editor.length > 0 && editor.at(-1)?.trim() === '') editor.pop();
  while (editor.length > 0 && editor[0]?.trim() === '') editor.shift();
  const above = lines.slice(0, top);
  return {
    queued: above.some((line) => QUEUE_HINT.test(line)),
    editor,
    nothingQueued: above.some((line) => line.includes(NOTHING_QUEUED)),
  };
}

export interface PiQueueEditTiming {
  step: ScreenWaitTiming;
  clearGapMs: number;
}

const DEFAULT_TIMING: PiQueueEditTiming = { step: { timeoutMs: 3_000, pollMs: 50 }, clearGapMs: PI_CLEAR_GAP_MS };

export async function runPiQueueEdit(
  io: RewindIo,
  context: QueueEditContext,
  keys: string,
  timing: PiQueueEditTiming = DEFAULT_TIMING,
): Promise<QueueEditOutcome> {
  // 1. Algo en cola a la vista, y el editor vacio: lo que hubiera ahi se iria con el Ctrl+C.
  const now = await waitForStableScreen(
    io,
    (lines) => {
      const screen = readPiQueueScreen(lines);
      if (screen === null) return null;
      return screen.editor.length > 0 ? 'busy' : screen.queued ? 'queued' : 'none';
    },
    timing.step,
  );
  if (now === null || now === 'none') return { kind: 'failed', reason: 'no-queue-on-screen' };
  if (now === 'busy') return { kind: 'failed', reason: 'editor-busy' };

  // 2. La tecla que devuelve la cola al editor.
  if (!io.write(keys)) return { kind: 'failed', reason: 'gone' };
  const restored = await waitForStableScreen(
    io,
    (lines) => {
      const screen = readPiQueueScreen(lines);
      return screen !== null && screen.editor.length > 0 ? screen.editor.join('\n') : null;
    },
    timing.step,
  );
  if (restored === null) {
    const screen = readPiQueueScreen(await io.screen());
    return { kind: 'failed', reason: screen?.nothingQueued === true ? 'delivered' : 'not-restored' };
  }

  // 3. Ctrl+C, lejos del anterior.
  if (context.lastClearKeyAt !== null) {
    const remaining = timing.clearGapMs - (io.now() - context.lastClearKeyAt);
    if (remaining > 0) await io.wait(remaining);
  }
  if (!io.write(CLEAR_EDITOR)) return { kind: 'failed', reason: 'not-cleared' };
  const cleared = await waitForStableScreen(
    io,
    (lines) => {
      const screen = readPiQueueScreen(lines);
      return screen !== null && screen.editor.length === 0 ? 'cleared' : null;
    },
    timing.step,
  );
  if (cleared === null) return { kind: 'failed', reason: 'not-cleared' };
  return { kind: 'done', texts: [] };
}

export function createPiQueueEdit(timing: PiQueueEditTiming = DEFAULT_TIMING): QueueEditDriver {
  return { run: (io, context) => runPiQueueEdit(io, context, piDequeueKeys(), timing) };
}
