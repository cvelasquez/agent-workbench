/**
 * El menu de rewind de Claude Code, manejado por la app (hito 44, §4.16).
 *
 * Medido con la 2.1.301 (`docs/herramientas/claude-rewind/`, c03 a c05 y c09):
 *
 * ```
 *    Rewind
 *    Restore the code and/or conversation to the point before…
 *    ❯ Crea un archivo nota.txt con el texto uno. No hagas nada mas.
 *      nota.txt +1
 *      Responde solo con la palabra dos
 *      No code changes
 *      ↓ 1 more
 *    Enter to continue · Esc to cancel
 * ```
 *
 * `Esc Esc` con la caja vacia lo abre con "(current)" marcado abajo; cada
 * flecha arriba marca el mensaje anterior. Un mensaje largo se ve como su
 * primera linea con `…`. Enter abre la confirmacion:
 *
 * ```
 *    Confirm you want to restore to the point before you sent this message:
 *    │ Crea un archivo nota.txt con el texto uno. No hagas nada mas.
 *    │ (14s ago)
 *    The conversation will be forked.
 *    The code will be restored -1 in nota.txt.
 *    ❯ 1. Restore code and conversation
 *      2. Restore conversation
 *      3. Restore code
 *      4. Summarize from here
 *    ↓ 5. Summarize up to here
 * ```
 *
 * Sin cambios de codigo desde ese mensaje, las opciones son otras (1. Restore
 * conversation, 2 y 3. Summarize, 4. Never mind). Al restaurar, la CLI borra de
 * su pantalla desde ese mensaje y lo deja en su caja; con el codigo, ademas
 * revierte los archivos. No escribe nada en el JSONL hasta el mensaje siguiente.
 *
 * Cada paso se comprueba en la pantalla antes del siguiente: el mensaje
 * marcado por su texto, la confirmacion por el mensaje que cita, y la opcion
 * por su nombre, nunca por su numero. Si algo no coincide se cierra el menu con
 * Esc sin elegir nada. Puro salvo `io`: lo prueba `check-prompt-editing.mjs`
 * con pantallas medidas.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RewindDriver, RewindFailure, RewindIo, RewindOutcome, RewindRequest } from '../adapter.js';
import { parseJsonlLine } from '../../jsonl-reader.js';
import { cleanUserText } from './jsonl-events.js';
import { sessionFilePath } from './paths.js';

const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ENTER = '\r';
/** La tecla que vacia la caja de la CLI (medido: una sola, con texto, la vacia sin cerrar nada). */
const CLEAR = '\x03';

const MARKER = '❯';

export const REWIND_OPTION_CODE_AND_CONVERSATION = 'Restore code and conversation';
export const REWIND_OPTION_CONVERSATION = 'Restore conversation';

/** Lo que se lee de la pantalla. */
export type RewindScreen =
  | { kind: 'none' }
  | {
      kind: 'list';
      /** El texto marcado, o null si es "(current)". */
      selected: string | null;
      /** Todo el bloque del menu: cambia en cuanto se mueve la marca. */
      block: string;
    }
  | {
      kind: 'confirm';
      /** Las lineas citadas del mensaje, sin la de "(hace cuanto)". */
      quoted: string[];
      options: { number: number; label: string; selected: boolean }[];
      block: string;
    };

const ARROWS = /^[↑↓]\s*/;

/** Lee la pantalla de la CLI. */
export function readRewindScreen(lines: readonly string[]): RewindScreen {
  const header = lines.findIndex((line) => line.trim() === 'Rewind');
  if (header === -1) return { kind: 'none' };
  /*
    Con la terminal de la app la CLI deja lineas en blanco entre el titulo, la
    explicacion y la lista (medido: en el banco, de otra altura, no las habia).
    Se saltan, y no cuentan en el bloque.
  */
  const rest = lines.slice(header + 1).filter((line) => line.trim().length > 0);
  const intro = rest[0]?.trim() ?? '';

  if (intro.startsWith('Restore the code and/or conversation')) {
    const block: string[] = [];
    let selected: string | null | undefined;
    for (const raw of rest.slice(1)) {
      const line = raw.trim();
      if (line.startsWith('Enter to continue')) break;
      block.push(line);
      if (selected === undefined && line.startsWith(MARKER)) {
        const text = line.slice(MARKER.length).trim();
        selected = text === '(current)' ? null : text;
      }
    }
    if (selected === undefined) return { kind: 'none' };
    return { kind: 'list', selected, block: block.join('\n') };
  }

  if (intro.startsWith('Confirm you want to restore')) {
    const quoted: string[] = [];
    const options: { number: number; label: string; selected: boolean }[] = [];
    const block: string[] = [];
    for (const raw of rest.slice(1)) {
      const line = raw.trim();
      if (line.length === 0) continue;
      block.push(line);
      if (line.startsWith('│')) {
        const text = line.slice(1).trim();
        if (!/^\(.*\bago\)$/.test(text)) quoted.push(text);
        continue;
      }
      const selected = line.startsWith(MARKER);
      const option = /^(\d+)\.\s+(.+)$/.exec(line.replace(MARKER, '').replace(ARROWS, '').trim());
      if (option !== null) {
        options.push({ number: Number(option[1]), label: (option[2] ?? '').trim(), selected });
      }
    }
    return { kind: 'confirm', quoted, options, block: block.join('\n') };
  }

  return { kind: 'none' };
}

/** Sin imagenes ni espacios de mas: como se compara lo que muestra la CLI con lo que se escribio. */
function comparable(text: string): string {
  return text
    .replace(/@"[^"]*"/g, ' ')
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * true si lo que muestra la CLI es esa primera linea. La CLI la corta con `…`
 * cuando sigue (otra linea, o no entra): ahi alcanza con que empiece igual.
 */
export function shownMatches(shown: string, firstLine: string): boolean {
  const cut = /…\s*$/.test(shown);
  const visible = comparable(shown.replace(/…\s*$/, ''));
  const wanted = comparable(firstLine);
  if (visible.length === 0 || wanted.length === 0) return false;
  return cut ? wanted.startsWith(visible) : wanted === visible;
}

/** La caja de la CLI: la ultima linea que empieza con la marca. */
function editorLine(lines: readonly string[]): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line.startsWith(MARKER)) return line.slice(MARKER.length).trim();
  }
  return null;
}

/** true si la caja de la CLI tiene ese mensaje (o el pegado largo que lo representa). */
function editorHolds(lines: readonly string[], firstLine: string): boolean {
  const text = editorLine(lines);
  if (text === null || text.length === 0) return false;
  return shownMatches(text.endsWith('…') ? text : `${text}…`, firstLine) || /^\[Pasted text #\d+/.test(text);
}

export interface RewindTiming {
  /** Entre las dos teclas de un `Esc Esc`. */
  keyGapMs: number;
  /** Cuanto se espera a que la pantalla cambie despues de una tecla. */
  stepTimeoutMs: number;
  /** Cada cuanto se mira la pantalla. */
  pollMs: number;
}

const DEFAULT_TIMING: RewindTiming = { keyGapMs: 150, stepTimeoutMs: 3_000, pollMs: 50 };

/**
 * Espera una pantalla que cumpla y que este **quieta**: la misma en dos
 * lecturas seguidas. Un redibujo que llega en dos trozos deja un instante la
 * marca a medio mover, y leer ahi haria saltear el mensaje. La ultima leida si
 * no llego a tiempo.
 */
async function waitForScreen(
  io: RewindIo,
  timing: RewindTiming,
  accept: (screen: RewindScreen, lines: readonly string[]) => boolean,
): Promise<{ screen: RewindScreen; lines: readonly string[]; ok: boolean }> {
  const deadline = io.now() + timing.stepTimeoutMs;
  let candidate: string | null = null;
  for (;;) {
    const lines = await io.screen();
    const screen = readRewindScreen(lines);
    // Solo lo que importa: el menu, o la caja de la CLI. Un indicador que se
    // anima en otra parte de la pantalla no tiene que impedir que se quede quieta.
    const key = screen.kind === 'none' ? (editorLine(lines) ?? '') : screen.block;
    if (accept(screen, lines)) {
      if (candidate === key) return { screen, lines, ok: true };
      candidate = key;
    } else {
      candidate = null;
    }
    if (io.now() >= deadline) return { screen, lines, ok: false };
    await io.wait(timing.pollMs);
  }
}

/** Cierra el menu sin elegir nada. */
async function closeMenu(io: RewindIo, timing: RewindTiming): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (readRewindScreen(await io.screen()).kind === 'none') return;
    if (!io.write(ESC)) return;
    await waitForScreen(io, timing, (screen) => screen.kind === 'none');
  }
}

async function fail(io: RewindIo, timing: RewindTiming, reason: RewindFailure): Promise<RewindOutcome> {
  await closeMenu(io, timing);
  return { kind: 'failed', reason };
}

export async function runRewind(
  io: RewindIo,
  request: RewindRequest,
  timing: RewindTiming = DEFAULT_TIMING,
): Promise<RewindOutcome> {
  // 1. Abrir el menu. Si no se abre, las dos teclas no eligieron nada.
  if (!io.write(ESC)) return { kind: 'failed', reason: 'gone' };
  await io.wait(timing.keyGapMs);
  if (!io.write(ESC)) return { kind: 'failed', reason: 'gone' };
  let current = await waitForScreen(io, timing, (screen) => screen.kind === 'list');
  if (!current.ok) return fail(io, timing, 'menu-not-open');

  // 2. Subir hasta el mensaje, mirando cada uno. La CLI puede listar uno mas o
  //    uno menos que el hilo: cuenta el texto, no la posicion.
  let matches = 0;
  for (let step = 0; ; step += 1) {
    if (step >= request.maxSteps) return fail(io, timing, 'message-not-found');
    const before = current.screen.kind === 'list' ? current.screen.block : '';
    if (!io.write(UP)) return { kind: 'failed', reason: 'gone' };
    current = await waitForScreen(io, timing, (screen) => screen.kind === 'list' && screen.block !== before);
    // Nada se movio: se llego arriba sin encontrarlo.
    if (!current.ok || current.screen.kind !== 'list') return fail(io, timing, 'message-not-found');
    const selected = current.screen.selected;
    if (selected !== null && shownMatches(selected, request.firstLine)) {
      matches += 1;
      if (matches >= request.occurrence) break;
    }
  }

  // 3. La confirmacion, y que cite ese mismo mensaje.
  if (!io.write(ENTER)) return { kind: 'failed', reason: 'gone' };
  current = await waitForScreen(io, timing, (screen) => screen.kind === 'confirm');
  if (!current.ok || current.screen.kind !== 'confirm') return fail(io, timing, 'not-confirmed');
  const quotedFirst = current.screen.quoted[0] ?? '';
  if (!shownMatches(quotedFirst, request.firstLine) && !shownMatches(`${quotedFirst}…`, request.firstLine)) {
    return fail(io, timing, 'message-not-found');
  }

  // 4. La opcion, por su nombre. Sin cambios de codigo la CLI no ofrece deshacerlo.
  let codeRestored = request.restoreCode;
  let wanted = current.screen.options.find(
    (option) => option.label === (request.restoreCode ? REWIND_OPTION_CODE_AND_CONVERSATION : REWIND_OPTION_CONVERSATION),
  );
  if (wanted === undefined && request.restoreCode) {
    wanted = current.screen.options.find((option) => option.label === REWIND_OPTION_CONVERSATION);
    codeRestored = false;
  }
  const marked = current.screen.options.find((option) => option.selected);
  if (wanted === undefined || marked === undefined) return fail(io, timing, 'option-missing');
  const key = wanted.number > marked.number ? DOWN : UP;
  for (let moves = Math.abs(wanted.number - marked.number); moves > 0; moves -= 1) {
    const before = current.screen.kind === 'confirm' ? current.screen.block : '';
    if (!io.write(key)) return { kind: 'failed', reason: 'gone' };
    current = await waitForScreen(io, timing, (screen) => screen.kind === 'confirm' && screen.block !== before);
    if (!current.ok || current.screen.kind !== 'confirm') return fail(io, timing, 'option-missing');
  }
  const chosen = current.screen.kind === 'confirm' ? current.screen.options.find((option) => option.selected) : undefined;
  if (chosen === undefined || chosen.label !== wanted.label) return fail(io, timing, 'option-missing');

  // 5. Confirmar. Desde aca la CLI ya lo hizo: lo que sigue no se deshace.
  if (!io.write(ENTER)) return { kind: 'failed', reason: 'gone' };
  current = await waitForScreen(io, timing, (screen) => screen.kind === 'none');

  // 6. La CLI deja el mensaje en su caja: se vacia, solo si esta ahi.
  let editorCleared = false;
  const holding = await waitForScreen(io, timing, (_screen, lines) => editorHolds(lines, request.firstLine));
  if (holding.ok && io.write(CLEAR)) {
    const cleared = await waitForScreen(io, timing, (_screen, lines) => !editorHolds(lines, request.firstLine));
    editorCleared = cleared.ok;
  }
  return { kind: 'done', codeRestored, editorCleared };
}

/**
 * El texto entero de un mensaje del usuario, leido del archivo de la sesion:
 * para el cuadro, cuando el hilo lo tiene recortado por el tope de transporte.
 * Sin las referencias a imagenes pegadas, que el hilo tampoco muestra. null si
 * no esta.
 */
export async function readPromptText(cwd: string, sessionId: string, uuid: string): Promise<string | null> {
  const stream = createReadStream(sessionFilePath(cwd, sessionId), { encoding: 'utf8' });
  const failed = new Promise<null>((resolve) => stream.once('error', () => resolve(null)));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const found = (async (): Promise<string | null> => {
    try {
      for await (const line of lines) {
        if (!line.includes(uuid)) continue;
        const record = parseJsonlLine(line.trim());
        if (record === null || record['uuid'] !== uuid) continue;
        const message = record['message'];
        if (typeof message !== 'object' || message === null) return null;
        const content = (message as Record<string, unknown>)['content'];
        const raw =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .flatMap((block) =>
                    typeof block === 'object' && block !== null && (block as Record<string, unknown>)['type'] === 'text'
                      ? [String((block as Record<string, unknown>)['text'] ?? '')]
                      : [],
                  )
                  .join('\n')
              : null;
        if (raw === null) return null;
        return cleanUserText(raw)
          .replace(/@"[^"]*\.(?:png|jpe?g|gif|webp)"/gi, '')
          .replace(/[ \t]+\n/g, '\n')
          .trim();
      }
    } catch {
      return null;
    }
    return null;
  })();
  try {
    return await Promise.race([found, failed]);
  } finally {
    lines.close();
    stream.destroy();
  }
}

export function createClaudeCodeRewind(timing: RewindTiming = DEFAULT_TIMING): RewindDriver {
  return {
    run: (io, request) => runRewind(io, request, timing),
    fullText: (target, eventId) => readPromptText(target.cwd, target.sessionId, eventId),
  };
}
