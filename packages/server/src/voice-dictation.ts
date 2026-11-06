/**
 * Recoger el dictado de la caja de la CLI para el cuadro (06-11-2026, §5.3.3).
 *
 * El dictado nativo (Claude Code, Antigravity) termina con el texto escrito en
 * la caja de la CLI, y el cuadro de la app seguia vacio. Aca se espera a que la
 * CLI termine de transcribir, se lee la caja de la pantalla emulada, se vacia
 * con las teclas de la CLI y el texto sale hacia el cuadro. Si queda en las dos
 * partes, al enviar saldria duplicado.
 *
 * Medido contra Claude Code 2.1.318 y Antigravity 1.5.x (sin hablar: el texto
 * es lo mismo que la CLI deja al insertar un dictado):
 *
 *  - **Mientras graba o transcribe, lo dice fuera de la caja.** Claude:
 *    `listening…` y `Voice: processing…` sobre la caja, `keep holding…` al
 *    arrancar, y un medidor de nivel (`▁` a `█`) en la propia caja.
 *    Antigravity: `Connecting...`, `Recording 00:01` y `Finishing up...` debajo.
 *    Esos indicadores se buscan **solo fuera de la caja**: un dictado que
 *    contuviera "listening" no puede dejarla ocupada para siempre.
 *  - **Sin voz**, Claude avisa (`No speech detected.`) y Antigravity no dice
 *    nada: se espera un plazo de gracia y se da por vacio.
 *  - **La ayuda de la caja vacia de Antigravity no es atenuada** (un gris fijo,
 *    una linea por modo que termina en `(shift+tab to cycle)`): el lector sin lo
 *    atenuado la leeria como texto, asi que el adaptador la declara (`hint`).
 *  - **Ctrl+U y Ctrl+K vacian la caja**, de a una linea de pantalla, en las dos
 *    (los mismos de editar la cola, §6.35.1); con la caja vacia no hacen nada.
 *  - Las lineas partidas por el ancho se juntan con un espacio y dan lo escrito.
 *
 * Puro salvo `io`: lo prueba `check-native-voice.mjs` con pantallas medidas.
 * Sin nombrar ninguna CLI: lo que cada una dice lo declara su adaptador.
 */

import type { NativeVoiceDictation } from './agents/adapter.js';
import { waitForStableScreen, type ScreenWaitTiming } from './agents/screen-wait.js';

export interface DictationTiming {
  /** Tope de todo: pasado, se da por vacio y lo que haya queda en la CLI. */
  totalMs: number;
  /** Cada cuanto se mira la pantalla. */
  pollMs: number;
  /** Sin indicadores y con la caja vacia, cuanto se espera antes de decir que no se oyo nada. */
  emptyGraceMs: number;
  /** Un "no oi nada" visto antes de esto, sin haber visto grabar, es de un intento anterior. */
  settleMs: number;
  /** Cuanto se espera ver la caja vacia despues de cada tanda de teclas. */
  clear: ScreenWaitTiming;
}

export const DICTATION_TIMING: DictationTiming = {
  totalMs: 20_000,
  pollMs: 60,
  emptyGraceMs: 1_500,
  settleMs: 800,
  clear: { timeoutMs: 3_000, pollMs: 50 },
};

/** Cuantas tandas de borrar se intentan antes de dejar el texto en la CLI. */
const CLEAR_ROUNDS = 4;

const RULE = /^─{8,}/;
/** El medidor de nivel que Claude Code dibuja en su caja mientras graba. */
const LEVEL_METER = /^[▁▂▃▄▅▆▇█]+$/;

export interface DictationIo {
  /** La pantalla de la CLI, sin lo atenuado, de arriba abajo. */
  screen(): Promise<readonly string[]>;
  wait(ms: number): Promise<void>;
  now(): number;
  /** Escribe las teclas de vaciar por la fila de la pestana; false si no se pudo. */
  clear(keys: string): Promise<boolean>;
}

/**
 * Como termino. `kept`: habia texto y no se pudo sacar de la caja, asi que
 * queda ahi y no se entrega (en las dos partes saldria duplicado).
 */
export type DictationOutcome = { kind: 'text'; text: string } | { kind: 'empty' } | { kind: 'kept' };

/**
 * Las lineas de la pantalla que **no** son la caja y donde la CLI dice que esta
 * haciendo: la de arriba de su regla de arriba y todo lo de debajo de la de
 * abajo. Sin dos reglas, las ultimas ocho.
 */
function outsideBox(lines: readonly string[]): string[] {
  const rules: number[] = [];
  lines.forEach((line, index) => {
    if (RULE.test(line.trim())) rules.push(index);
  });
  const top = rules.at(-2);
  const bottom = rules.at(-1);
  if (top === undefined || bottom === undefined) return lines.slice(-8).map((line) => line.trim());
  return [lines[top - 1] ?? '', ...lines.slice(bottom + 1)].map((line) => line.trim());
}

/**
 * Lo escrito en la caja, en una linea: lo que se ve partido por el ancho se
 * junta con un espacio, y la ayuda propia de la CLI no cuenta. null si la caja
 * no se ve; '' si esta vacia.
 */
export function boxText(spec: NativeVoiceDictation, lines: readonly string[]): string | null {
  const box = spec.readBox(lines);
  if (box === null) return null;
  return box
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !(spec.hint?.test(line) ?? false))
    .join(' ');
}

/** La CLI esta grabando o transcribiendo: lo que haya en la caja todavia no es el dictado. */
export function dictationBusy(spec: NativeVoiceDictation, lines: readonly string[]): boolean {
  if (outsideBox(lines).some((line) => spec.busy.test(line))) return true;
  const text = boxText(spec, lines);
  return text !== null && LEVEL_METER.test(text);
}

function saysNoSpeech(spec: NativeVoiceDictation, lines: readonly string[]): boolean {
  return spec.noSpeech !== undefined && outsideBox(lines).some((line) => spec.noSpeech?.test(line) === true);
}

/** Vacia la caja con las teclas de la CLI, de a tandas y mirando la pantalla. */
async function moveOut(spec: NativeVoiceDictation, io: DictationIo, text: string, timing: DictationTiming): Promise<DictationOutcome> {
  for (let round = 0; round < CLEAR_ROUNDS; round += 1) {
    const rows = spec.readBox(await io.screen())?.length ?? 1;
    // Una pasada por linea de pantalla, y de mas: con la caja vacia no hacen nada.
    if (!(await io.clear(spec.clearKeys.repeat(Math.max(1, rows) * 2 + 2)))) return { kind: 'kept' };
    const gone = await waitForStableScreen(io, (lines) => (boxText(spec, lines) === '' ? 'empty' : null), timing.clear);
    if (gone !== null) return { kind: 'text', text };
  }
  return { kind: 'kept' };
}

/**
 * Espera a que la CLI termine con el dictado y saca el texto de su caja.
 *
 * Se acepta una lectura solo si la siguiente da lo mismo (un redibujo a medias
 * no decide), y nunca mientras se vean los indicadores de la CLI.
 */
export async function takeDictation(
  spec: NativeVoiceDictation,
  io: DictationIo,
  timing: DictationTiming = DICTATION_TIMING,
): Promise<DictationOutcome> {
  const startedAt = io.now();
  const deadline = startedAt + timing.totalMs;
  let sawBusy = false;
  let quietSince: number | null = null;
  let previous: string | null = null;
  for (;;) {
    const lines = await io.screen();
    const now = io.now();
    const busy = dictationBusy(spec, lines);
    const text = boxText(spec, lines);

    if (busy) {
      sawBusy = true;
      quietSince = null;
      previous = null;
    } else if (text === null) {
      // Un dialogo tapa la caja: no se puede decir que este vacia.
      quietSince = null;
      previous = null;
    } else if (text.length > 0) {
      quietSince = null;
      if (text === previous) return moveOut(spec, io, text, timing);
      previous = text;
    } else {
      previous = null;
      quietSince ??= now;
      // El aviso de la CLI solo vale si ya la vimos grabar: el de un intento anterior sigue en pantalla.
      const told = saysNoSpeech(spec, lines) && (sawBusy || now - startedAt >= timing.settleMs);
      if (told || now - quietSince >= timing.emptyGraceMs) return { kind: 'empty' };
    }

    if (now >= deadline) return { kind: 'empty' };
    await io.wait(timing.pollMs);
  }
}
