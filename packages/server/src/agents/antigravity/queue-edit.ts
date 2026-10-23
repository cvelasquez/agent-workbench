/**
 * Sacar la cola de Antigravity para editarla en el cuadro (§6.35.1, §12.13).
 *
 * Medido con la 1.4.4 (`a16` y `a17`), con el agente escribiendo un poema y dos
 * mensajes en cola:
 *
 * ```
 * ▸ Mensaje B en cola (alt+m to send immediately)
 * ───────────────────────────────────
 * >                                     el editor, vacio
 * ───────────────────────────────────
 *   Press up to edit queued messages  accept-edits · …
 * ```
 *
 *  - **La flecha arriba** devuelve todo al editor (`> Mensaje B en cola`, y en
 *    las lineas de abajo el resto), sin cortar el turno.
 *  - **Ctrl+U y Ctrl+K lo vacian**, sin cortar el turno, como en Claude Code.
 *  - Al terminar el turno no le llego nada al agente: el log no dice
 *    `Auto-flush`, y la respuesta no los menciona.
 *  - **Sin nada en cola, la flecha trae el ultimo mensaje mandado.** La CLI no
 *    deja rastro de la flecha en ningun lado (§12.13): se reconoce la cola por
 *    su primera linea, que es la del primer mensaje que la app le mando. Con un
 *    solo mensaje en cola, el historial y la cola dicen lo mismo: si la CLI lo
 *    entrego justo antes de la flecha, vuelve al cuadro igual.
 *
 * Lo que vuelve al cuadro es lo que la app le mando (`QueueEditContext.queued`).
 * Puro salvo `io`: lo prueba `check-thread-status.mjs` con pantallas medidas.
 */

import type { QueueEditContext, QueueEditDriver, QueueEditOutcome, RewindIo } from '../adapter.js';
import { waitForStableScreen, type ScreenWaitTiming } from '../screen-wait.js';

const UP = '\x1b[A';
/** Ctrl+U y Ctrl+K (medido, a16). Con el editor vacio no hacen nada. */
const CLEAR_LINE = '\x15\x0b';
const QUEUE_HINT = 'Press up to edit queued messages';
const CLEAR_ROUNDS = 4;

function isRule(line: string): boolean {
  return /^─{8,}$/.test(line.trim());
}

/**
 * El editor (las lineas entre las dos ultimas reglas, sin el `>` de la
 * primera) y si el pie dice que hay algo en cola. null si no se ve el editor.
 */
export function readAntigravityQueueScreen(lines: readonly string[]): { editor: string[]; queued: boolean } | null {
  const rules: number[] = [];
  lines.forEach((line, index) => {
    if (isRule(line)) rules.push(index);
  });
  const [top, bottom] = rules.slice(-2);
  if (top === undefined || bottom === undefined) return null;
  const raw = lines.slice(top + 1, bottom).map((line) => line.trim());
  const first = raw[0];
  if (first === undefined || !first.startsWith('>')) return null;
  const editor = [first.slice(1).trim(), ...raw.slice(1)];
  while (editor.length > 0 && editor.at(-1) === '') editor.pop();
  const footer = lines.slice(bottom + 1);
  return { editor, queued: footer.some((line) => line.includes(QUEUE_HINT)) };
}

/** Sin espacios: una linea larga se corta donde cae, en medio de una palabra o no. */
function squash(text: string): string {
  return text.replace(/\s+/g, '');
}

/** true si el editor empieza con el primer mensaje de la cola. */
function holdsQueue(editor: readonly string[], firstQueued: string): boolean {
  const shown = squash(editor.join(''));
  const wanted = squash(firstQueued).slice(0, 40);
  return wanted.length > 0 && shown.startsWith(wanted.slice(0, Math.min(wanted.length, shown.length)));
}

export async function runAntigravityQueueEdit(
  io: RewindIo,
  context: QueueEditContext,
  timing: ScreenWaitTiming = { timeoutMs: 3_000, pollMs: 50 },
): Promise<QueueEditOutcome> {
  const firstQueued = context.queued[0];
  if (firstQueued === undefined) return { kind: 'failed', reason: 'no-queue-on-screen' };

  // 1. Algo en cola a la vista, y el editor vacio.
  const now = await waitForStableScreen(
    io,
    (lines) => {
      const screen = readAntigravityQueueScreen(lines);
      if (screen === null) return null;
      return screen.editor.length > 0 ? 'busy' : screen.queued ? 'queued' : 'none';
    },
    timing,
  );
  if (now === null || now === 'none') return { kind: 'failed', reason: 'no-queue-on-screen' };
  if (now === 'busy') return { kind: 'failed', reason: 'editor-busy' };

  // 2. La flecha: la cola vuelve al editor.
  if (!io.write(UP)) return { kind: 'failed', reason: 'gone' };
  const restored = await waitForStableScreen(
    io,
    (lines) => {
      const screen = readAntigravityQueueScreen(lines);
      return screen !== null && screen.editor.length > 0 ? screen.editor.join('\n') : null;
    },
    timing,
  );
  if (restored === null) return { kind: 'failed', reason: 'not-restored' };
  const fromQueue = holdsQueue(restored.split('\n'), firstQueued);

  // 3. Se vacia: lo que haya ahi lo trajo la flecha.
  let cleared = false;
  for (let round = 0; round < CLEAR_ROUNDS && !cleared; round += 1) {
    const screen = readAntigravityQueueScreen(await io.screen());
    if (screen === null) break;
    if (screen.editor.length === 0) {
      cleared = true;
      break;
    }
    if (!io.write(CLEAR_LINE.repeat(screen.editor.length * 2 + 2))) break;
    cleared =
      (await waitForStableScreen(
        io,
        (lines) => {
          const after = readAntigravityQueueScreen(lines);
          return after !== null && after.editor.length === 0 ? 'cleared' : null;
        },
        timing,
      )) !== null;
  }
  if (!cleared) return { kind: 'failed', reason: 'not-cleared' };
  if (!fromQueue) return { kind: 'failed', reason: 'delivered' };
  return { kind: 'done', texts: [] };
}

export function createAntigravityQueueEdit(): QueueEditDriver {
  return { run: (io, context) => runAntigravityQueueEdit(io, context) };
}
