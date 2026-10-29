/**
 * Lo que ya estaba escrito en la caja de la CLI, apartado antes de pegarle un
 * mensaje (28-10-2026, §5.3.1).
 *
 * El cuadro le pega su texto a la CLI y aprieta Enter. Si en la caja de la CLI
 * habia algo (tecleado en la solapa CLI, o una sugerencia de la CLI aceptada
 * con Tab), lo pegado se sumaba a eso y salia todo en un mensaje; y el
 * `/effort` de un combo le llegaba al modelo como texto. Con una CLI que tiene
 * una tecla para apartar lo escrito (`AgentInput.draftStash`), se aprieta
 * antes, y la CLI lo devuelve sola a su caja despues del envio.
 *
 * Tres reglas, de lo medido con Claude Code (§4.4.4):
 *
 *  - **Solo con texto en la caja.** Con la caja vacia la tecla saca lo que ya
 *    estuviera apartado, y lo pegado se sumaria a eso.
 *  - **Con texto y algo ya apartado no se toca nada**: la CLI aparta uno solo y
 *    la tecla pisaria lo anterior. No se manda, y quien llama dice por que.
 *  - **Sin ver la caja vacia despues de la tecla no se pega**: una tecla
 *    cambiada en la configuracion de la CLI no aparta nada.
 *
 * Sin caja a la vista (un dialogo encima, o sin proceso) se manda como siempre:
 * deciden las guardas de siempre. Sin nombrar ninguna CLI.
 */

import type { DraftBox, DraftStash } from './agents/adapter.js';
import { waitForStableScreen, type ScreenWaitTiming } from './agents/screen-wait.js';
import type { WriteOutcome } from './terminal-write-queue.js';

export interface DraftAsideTiming {
  /** Cuanto se espera una lectura quieta de la caja antes de decidir. */
  read: ScreenWaitTiming;
  /** Cuanto se espera la caja vacia despues de la tecla (medido: ~90 ms). */
  clear: ScreenWaitTiming;
}

export const DRAFT_ASIDE_TIMING: DraftAsideTiming = {
  read: { timeoutMs: 1_000, pollMs: 40 },
  clear: { timeoutMs: 3_000, pollMs: 40 },
};

/** La pantalla emulada de la pestana, lo justo (`TerminalRegistry.watchScreen`). */
export interface DraftScreen {
  linesWithoutFaint?(): Promise<readonly string[]>;
  dispose(): void;
}

export interface DraftAsideDeps {
  /** La pantalla de la pestana, o null sin proceso. */
  screen(): DraftScreen | null;
  /** Escribe la tecla en el turno de la fila, con las guardas del envio. */
  press(key: string): Promise<WriteOutcome>;
  wait(ms: number): Promise<void>;
  now(): number;
}

/**
 * Como quedo la caja.
 *
 *  - `clear`: no habia nada escrito, o la caja no se ve. Se manda como siempre.
 *  - `set-aside`: se aparto, y la CLI lo devuelve despues del envio.
 *  - `kept`: texto, y algo ya apartado. No se escribio nada.
 *  - `stuck`: se apreto la tecla y la caja no se vacio. No se pega.
 *  - `not-written`: la tecla no se escribio (una interrupcion, una guarda, la
 *    terminal que ya no esta).
 */
export type DraftAside =
  | { kind: 'clear' }
  | { kind: 'set-aside' }
  | { kind: 'kept' }
  | { kind: 'stuck' }
  | { kind: 'not-written'; outcome: Exclude<WriteOutcome, 'written'> };

type BoxState = 'none' | 'empty' | 'text' | 'text-and-saved';

function boxState(box: DraftBox | null): BoxState {
  if (box === null) return 'none';
  if (!box.text) return 'empty';
  return box.saved ? 'text-and-saved' : 'text';
}

/** Mira la caja y, si tiene algo escrito, lo aparta con la tecla de la CLI. */
export async function setCliDraftAside(
  stash: DraftStash,
  deps: DraftAsideDeps,
  timing: DraftAsideTiming = DRAFT_ASIDE_TIMING,
): Promise<DraftAside> {
  const screen = deps.screen();
  if (screen === null) return { kind: 'clear' };
  try {
    const read = screen.linesWithoutFaint?.bind(screen);
    if (read === undefined) return { kind: 'clear' };
    const io = { screen: read, wait: deps.wait, now: deps.now };
    const state = (lines: readonly string[]): BoxState => boxState(stash.readBox(lines));

    // Una lectura vale si la siguiente da lo mismo: un redibujo a medias no decide.
    const before = await waitForStableScreen(io, state, timing.read);
    if (before === 'text-and-saved') return { kind: 'kept' };
    if (before !== 'text') return { kind: 'clear' };

    const outcome = await deps.press(stash.key);
    if (outcome !== 'written') return { kind: 'not-written', outcome };
    const after = await waitForStableScreen(io, (lines) => (state(lines) === 'empty' ? 'empty' : null), timing.clear);
    return after === null ? { kind: 'stuck' } : { kind: 'set-aside' };
  } finally {
    screen.dispose();
  }
}
