/**
 * Cola de escrituras por terminal.
 *
 * Lo que la app le escribe a una CLI —un mensaje, una nota, la respuesta a una
 * pregunta, un cambio de modo— ya no es siempre un write: puede ser varias
 * piezas con una espera entre cada una (`AgentInput.pieceGapMs`), y las teclas
 * de una respuesta van espaciadas desde siempre. Sin orden, dos pedidos
 * seguidos se intercalan: el Enter del primero cae detras del pegado del
 * segundo, y lo que se manda no es ninguno de los dos.
 *
 * Por eso cada terminal tiene una fila: un trabajo empieza cuando termino el
 * anterior, en el orden en que llegaron los pedidos. La fila es de la terminal
 * y no del socket: dos ventanas escribiendole a la misma pestana tambien se
 * turnan.
 *
 * **La interrupcion no hace fila.** Esc tiene que llegar ya, no despues de lo
 * que se estaba mandando. `interrupt` descarta los trabajos que todavia no
 * empezaron y corta las piezas que le faltan al que esta en curso; quien la
 * llama escribe el Esc enseguida. Un trabajo puede declararse no
 * interrumpible cuando cortarlo a mitad deja las cosas peor que terminarlo.
 */

import type { TerminalId } from '@agent-workbench/shared';

/** Escribe una pieza. false si la terminal no la acepto. */
export type PieceWriter = (piece: string) => boolean;

/**
 * Se pregunta justo antes de cada pieza. false: esa pieza y las que siguen no
 * se escriben.
 */
export type PieceGuard = () => boolean | Promise<boolean>;

/**
 * Como termino una tanda de piezas.
 *
 *  - `written`: todas.
 *  - `refused`: la terminal no acepto una; las siguientes no se escribieron.
 *  - `interrupted`: llego una interrupcion antes de alguna pieza.
 *  - `blocked`: la guarda dijo que no antes de alguna pieza.
 */
export type WriteOutcome = 'written' | 'refused' | 'interrupted' | 'blocked';

/** Lo que recibe un trabajo mientras le toca el turno. */
export interface WriteLane {
  /** true si llego una interrupcion despues de encolar este trabajo. */
  readonly interrupted: boolean;
  /**
   * Escribe las piezas en orden, con `gapMs` entre una y la siguiente (nunca
   * antes de la primera). Antes de cada pieza mira si llego una interrupcion y,
   * si se da `guard`, le pregunta si todavia se puede escribir.
   *
   * La guarda existe porque una tanda de piezas dura: con 400 ms entre pieza y
   * pieza, ocho imagenes y el texto, el Enter sale casi cuatro segundos despues
   * de que se decidio mandar. Lo que era cierto al encolar puede no serlo antes
   * del Enter (A1 del hito 25).
   */
  writePieces(
    pieces: readonly string[],
    gapMs: number,
    write: PieceWriter,
    guard?: PieceGuard,
  ): Promise<WriteOutcome>;
}

export interface EnqueueOptions {
  /**
   * false: una interrupcion no lo descarta ni lo corta. Por omision, true.
   */
  readonly interruptible?: boolean;
  /** Se llama si una interrupcion lo descarto antes de que empezara. */
  readonly onDropped?: () => void;
}

interface Lane {
  tail: Promise<void>;
  /** Sube con cada interrupcion. Un trabajo guarda el valor al encolarse. */
  generation: number;
  /** Trabajos encolados o en curso. En cero la fila se olvida. */
  pending: number;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TerminalWriteQueue {
  private readonly lanes = new Map<TerminalId, Lane>();
  private readonly wait: (ms: number) => Promise<void>;

  /** `wait` es inyectable para el chequeo; por omision, un temporizador. */
  constructor(options: { wait?: (ms: number) => Promise<void> } = {}) {
    this.wait = options.wait ?? delay;
  }

  /**
   * Encola un trabajo. La promesa se resuelve cuando termino, o cuando se
   * descarto; nunca se rechaza: un trabajo que lanza no puede trabar la fila
   * de su terminal.
   */
  enqueue(
    terminalId: TerminalId,
    job: (lane: WriteLane) => Promise<void>,
    options: EnqueueOptions = {},
  ): Promise<void> {
    let lane = this.lanes.get(terminalId);
    if (lane === undefined) {
      lane = { tail: Promise.resolve(), generation: 0, pending: 0 };
      this.lanes.set(terminalId, lane);
    }
    const current = lane;
    const generation = current.generation;
    const interruptible = options.interruptible ?? true;
    const interrupted = (): boolean => interruptible && current.generation !== generation;

    const handle: WriteLane = {
      get interrupted() {
        return interrupted();
      },
      writePieces: async (pieces, gapMs, write, guard) => {
        for (const [index, piece] of pieces.entries()) {
          if (index > 0 && gapMs > 0) await this.wait(gapMs);
          if (interrupted()) return 'interrupted';
          if (guard !== undefined && !(await guard())) return 'blocked';
          // La guarda puede tardar —lee el archivo—: un Esc mientras tanto gana.
          if (interrupted()) return 'interrupted';
          if (!write(piece)) return 'refused';
        }
        return 'written';
      },
    };

    current.pending += 1;
    const run = current.tail
      .then(async () => {
        if (interrupted()) {
          options.onDropped?.();
          return;
        }
        await job(handle);
      })
      .catch((error: unknown) => {
        console.error(
          `[write] a send to terminal ${terminalId} failed:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        current.pending -= 1;
        if (current.pending === 0 && this.lanes.get(terminalId) === current) {
          this.lanes.delete(terminalId);
        }
      });
    current.tail = run;
    return run;
  }

  /**
   * Descarta lo que falta escribir en una terminal. No escribe nada: el Esc lo
   * escribe quien llama, y enseguida.
   */
  interrupt(terminalId: TerminalId): void {
    const lane = this.lanes.get(terminalId);
    if (lane !== undefined) lane.generation += 1;
  }

  /** Terminales con algo encolado o en curso. Para el chequeo. */
  busyTerminals(): number {
    return this.lanes.size;
  }
}
