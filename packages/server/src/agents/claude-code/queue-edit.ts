/**
 * Sacar la cola de Claude Code para editarla en el cuadro (§6.35.1, §4.4.3).
 *
 * Medido con la 2.1.309 (`c13` a `c15`), con un `ping` corriendo y dos mensajes
 * en cola:
 *
 * ```
 * ❯ Press up to edit queued messages      la caja vacia, con algo en cola
 * ❯ Mensaje B en cola                     tras la flecha arriba: salen todos
 *   [Pasted text #1 +4 lines]             juntos, y un `popAll` por mensaje
 * ```
 *
 *  - **Ctrl+C con el agente trabajando corta el turno** y no vacia la caja
 *    (`[Request interrupted by user for tool use]`). Ctrl+L (`chat:clearInput`)
 *    no hizo nada. Lo que la vacia sin cortar nada es **Ctrl+U y Ctrl+K**:
 *    borrar hasta el principio y hasta el final de la linea, de a una linea de
 *    pantalla. Con la caja vacia no hacen nada, asi que sobrar no cuesta.
 *  - **Sin nada en cola, la flecha trae el mensaje anterior del historial.** La
 *    pantalla no lo distingue de la cola si el mensaje es el mismo: lo dice el
 *    JSONL, que tiene un `popAll` solo si salio de la cola.
 *  - Lo que la CLI se manda a si misma (`<task-notification>`) no sale: la
 *    flecha saca solo lo que se puede editar (leido en su binario).
 *
 * Por eso: se mira que la caja diga lo de la cola y nada mas; flecha arriba; se
 * espera el texto en la caja; se vacia; y lo que vuelve al cuadro son los
 * `popAll` de despues de la flecha. Sin ninguno, la CLI ya lo habia entregado.
 *
 * Puro salvo `io` y la lectura del archivo: lo prueba `check-thread-status.mjs`
 * con pantallas medidas.
 */

import { stat } from 'node:fs/promises';

import { parseJsonlLine, readTailLines } from '../../jsonl-reader.js';
import type { QueueEditContext, QueueEditDriver, QueueEditOutcome, RewindIo } from '../adapter.js';
import { waitForStableScreen, type ScreenWaitTiming } from '../screen-wait.js';
import { readTimestamp } from './jsonl-events.js';
import { sessionFileOf } from './paths.js';
import { queuedUserText } from './prompt-queue.js';

const UP = '\x1b[A';
/** Ctrl+U y Ctrl+K: lo que hay antes y despues del cursor en una linea, y el salto (medido, c15). */
const CLEAR_LINE = '\x15\x0b';
const MARKER = '❯';
const QUEUE_HINT = 'Press up to edit queued messages';

/** Cuantas tandas de borrar se intentan antes de rendirse. */
const CLEAR_ROUNDS = 4;

/**
 * Cuanto antes de la flecha puede estar fechado su `popAll`: es el mismo reloj,
 * pero la hora de la flecha es la de la app al escribirla.
 */
const POP_SLACK_MS = 1_000;

const TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 32 * 1024 * 1024;

export interface ClaudeCodeQueueEditTiming {
  step: ScreenWaitTiming;
  /** Cuanto se espera el `popAll` en el archivo (medido: 130-150 ms tras la tecla). */
  popTimeoutMs: number;
}

const DEFAULT_TIMING: ClaudeCodeQueueEditTiming = {
  step: { timeoutMs: 3_000, pollMs: 50 },
  popTimeoutMs: 3_000,
};

/**
 * La caja de la CLI, linea por linea: desde la ultima linea con la marca hasta
 * la regla de abajo, sin la marca. null si no se ve.
 */
export function readClaudeCodeBox(lines: readonly string[]): string[] | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (!line.startsWith(MARKER)) continue;
    const box = [line.slice(MARKER.length).trim()];
    for (const next of lines.slice(index + 1)) {
      const text = next.trim();
      if (/^─{8,}/.test(text)) break;
      box.push(text);
    }
    while (box.length > 1 && box.at(-1) === '') box.pop();
    return box;
  }
  return null;
}

type BoxState = 'hint' | 'empty' | 'text';

function boxState(box: readonly string[]): BoxState {
  if (box.every((line) => line.length === 0)) return 'empty';
  if (box.length === 1 && box[0]?.startsWith(QUEUE_HINT.slice(0, 24)) === true) return 'hint';
  return 'text';
}

/**
 * Los mensajes que la CLI saco de la cola desde `since` (epoch ms), en orden y
 * como los escribio el usuario, segun las lineas del final del archivo. Puro.
 */
export function poppedPromptsIn(lines: readonly string[], since: number): string[] {
  const texts: string[] = [];
  for (const line of lines) {
    const record = parseJsonlLine(line);
    if (record === null || record['type'] !== 'queue-operation' || record['operation'] !== 'popAll') continue;
    if (readTimestamp(record['timestamp']) < since - POP_SLACK_MS) continue;
    const content = record['content'];
    if (typeof content !== 'string') continue;
    const user = queuedUserText(content);
    if (user !== null && user.text.length > 0) texts.push(user.text);
  }
  return texts;
}

/** El final del archivo, desde antes de `since`: la ventana crece hasta tenerlo. */
async function readPoppedPrompts(file: string, since: number): Promise<string[]> {
  try {
    const { size } = await stat(file);
    for (let window = TAIL_BYTES; ; window *= 4) {
      const lines = await readTailLines(file, { maxBytes: window });
      const first = lines.map((line) => parseJsonlLine(line)).find((record) => record !== null && readTimestamp(record['timestamp']) > 0);
      const covers = first !== undefined && first !== null && readTimestamp(first['timestamp']) < since - POP_SLACK_MS;
      if (covers || window >= size || window >= MAX_TAIL_BYTES) return poppedPromptsIn(lines, since);
    }
  } catch {
    return [];
  }
}

export interface ClaudeCodeQueueEditDeps {
  /** Lo que la CLI saco de la cola de esa sesion desde `since`. */
  popped: (target: { cwd: string; sessionId: string }, since: number) => Promise<string[]>;
}

/** Vacia la caja con Ctrl+U Ctrl+K, de a tandas, mirando la pantalla. true si quedo vacia. */
async function clearBox(io: RewindIo, timing: ScreenWaitTiming): Promise<boolean> {
  for (let round = 0; round < CLEAR_ROUNDS; round += 1) {
    const box = readClaudeCodeBox(await io.screen());
    if (box === null) return false;
    if (boxState(box) !== 'text') return true;
    // Una pasada por linea de pantalla, y de mas: con la caja vacia no hacen nada.
    if (!io.write(CLEAR_LINE.repeat(box.length * 2 + 2))) return false;
    const after = await waitForStableScreen(
      io,
      (lines) => {
        const now = readClaudeCodeBox(lines);
        return now !== null && boxState(now) !== 'text' ? 'cleared' : null;
      },
      timing,
    );
    if (after !== null) return true;
  }
  return false;
}

export async function runClaudeCodeQueueEdit(
  io: RewindIo,
  context: QueueEditContext,
  deps: ClaudeCodeQueueEditDeps,
  timing: ClaudeCodeQueueEditTiming = DEFAULT_TIMING,
): Promise<QueueEditOutcome> {
  const target = context.target;
  if (target === null) return { kind: 'failed', reason: 'gone' };

  // 1. La caja tiene que decir lo de la cola, y nada mas.
  const now = await waitForStableScreen(
    io,
    (lines) => {
      const box = readClaudeCodeBox(lines);
      return box === null ? null : boxState(box);
    },
    timing.step,
  );
  if (now === null || now === 'empty') return { kind: 'failed', reason: 'no-queue-on-screen' };
  if (now === 'text') return { kind: 'failed', reason: 'editor-busy' };

  // 2. Flecha arriba: la cola vuelve a la caja.
  const upAt = io.now();
  if (!io.write(UP)) return { kind: 'failed', reason: 'gone' };
  const restored = await waitForStableScreen(
    io,
    (lines) => {
      const box = readClaudeCodeBox(lines);
      return box !== null && boxState(box) === 'text' ? box.join('\n') : null;
    },
    timing.step,
  );
  if (restored === null) return { kind: 'failed', reason: 'not-restored' };

  // 3. Se vacia: lo que haya ahi lo trajo la flecha.
  const cleared = await clearBox(io, timing.step);

  // 4. Lo que salio de la cola, segun el archivo. Sin nada, la flecha trajo el historial.
  const deadline = io.now() + timing.popTimeoutMs;
  let texts = await deps.popped(target, upAt);
  while (texts.length === 0 && io.now() < deadline) {
    await io.wait(timing.step.pollMs * 2);
    texts = await deps.popped(target, upAt);
  }
  if (!cleared) return { kind: 'failed', reason: 'not-cleared' };
  if (texts.length === 0) return { kind: 'failed', reason: 'delivered' };
  return { kind: 'done', texts };
}

export function createClaudeCodeQueueEdit(timing: ClaudeCodeQueueEditTiming = DEFAULT_TIMING): QueueEditDriver {
  return {
    run: (io, context) =>
      runClaudeCodeQueueEdit(
        io,
        context,
        { popped: async (target, since) => readPoppedPrompts(await sessionFileOf(target.cwd, target.sessionId), since) },
        timing,
      ),
  };
}
