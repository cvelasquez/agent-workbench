/**
 * La pregunta que la CLI tiene abierta, leida de su pantalla (23-10-2026,
 * §5.5.4).
 *
 * Claude Code no escribe en su historial la linea de la pregunta hasta que se
 * contesta (medido con la 2.1.309: tres de tres), y la tarjeta del hilo sale de
 * esa linea: mientras tanto el hilo solo podia decir que la CLI esperaba una
 * respuesta. Esto lee el menu de la pantalla emulada mientras la CLI dice que
 * espera esa respuesta, y lo publica como una tarjeta mas.
 *
 * Lo que la hace segura no es leer bien: es que **nada se manda sin releer**.
 * Antes de cada respuesta se mira la pantalla otra vez (`verify`), y si la
 * pregunta no es la misma o el menu esta tocado, no se escribe nada.
 *
 * Generico: no nombra ninguna CLI. Lo que sabe del menu lo pone el lector del
 * adaptador (`ScreenQuestionReader`), y la pantalla, el registro de terminales.
 */

import { randomBytes } from 'node:crypto';
import { sameQuestionItem, type ConversationQuestionItem, type ConversationQuestionPart } from '@agent-workbench/shared';
import type { ScreenQuestion, ScreenQuestionReader } from './agents/adapter.js';
import type { PtyScreen } from './pty-screen.js';

/**
 * Con que empieza el id de una pregunta leida de la pantalla. No es el de la
 * CLI, que no se ve: es de la app, y no puede confundirse con uno de verdad.
 */
export const LIVE_QUESTION_ID_PREFIX = 'screen-';

export interface LiveQuestionTiming {
  /** Cada cuanto se mira la pantalla recien abierta la espera, o mientras cambia. */
  fastPollMs: number;
  /** Cada cuanto despues de un rato quieta: una pregunta puede quedar abierta una hora. */
  slowPollMs: number;
  /** Cuanto tiene que estar quieta para pasar al sondeo lento. */
  settleMs: number;
  /** Cuanto se espera, al contestar, a que la pantalla diga lo mismo dos lecturas seguidas. */
  verifyTimeoutMs: number;
}

const DEFAULT_TIMING: LiveQuestionTiming = {
  fastPollMs: 150,
  slowPollMs: 1_000,
  settleMs: 3_000,
  verifyTimeoutMs: 1_500,
};

/** Lo publicado: la tarjeta, y la clave de lo que se leyo para armarla. */
export interface LiveQuestion {
  part: ConversationQuestionPart;
  key: string;
}

/**
 * Lo que dice la pantalla antes de contestar:
 *
 *  - `ok`: la misma pregunta, con el menu sin tocar.
 *  - `gone`: ya no hay pregunta (se contesto en la solapa CLI, o se cancelo).
 *  - `changed`: hay otra, o la pantalla no se quedo quieta.
 *  - `touched`: la misma, pero con la respuesta escrita abierta o casillas
 *    marcadas en la solapa CLI.
 */
export type LiveQuestionCheck = 'ok' | 'gone' | 'changed' | 'touched';

export interface LiveQuestionWatchOptions {
  /** Abre la pantalla emulada de la pestana. null sin proceso. */
  openScreen: () => PtyScreen | null;
  reader: ScreenQuestionReader;
  /** Lo publicado cambio. Se lee con `current()`. */
  onChange: () => void;
  timing?: Partial<LiveQuestionTiming>;
  /** Para los chequeos: ids previsibles. */
  newId?: () => string;
}

/** Lo que importa de una lectura para decidir si la pantalla se quedo quieta. */
function readingKey(read: ScreenQuestion | null): string {
  return read === null ? '' : `${read.untouched ? 'u' : 't'}\n${read.key}`;
}

/**
 * Mira la pantalla de una pestana mientras su CLI espera la respuesta a una
 * pregunta. Una por pestana y por espera: se crea cuando la CLI dice que
 * espera y se para cuando deja de esperar.
 */
export class LiveQuestionWatch {
  private readonly timing: LiveQuestionTiming;
  private readonly newId: () => string;
  private screen: PtyScreen | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private published: LiveQuestion | null = null;
  /**
   * El id de cada pregunta vista en esta espera. Una que se pierde un rato (la
   * terminal cambio de tamano y la CLI redibujo a medias) vuelve con el mismo:
   * para la tarjeta sigue siendo la misma pregunta.
   */
  private readonly ids = new Map<string, string>();
  /** La lectura anterior, para publicar solo lo que se repite dos veces seguidas. */
  private previous: string | null = null;
  private changedAt = 0;

  constructor(private readonly options: LiveQuestionWatchOptions) {
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.newId = options.newId ?? (() => `${LIVE_QUESTION_ID_PREFIX}${randomBytes(6).toString('hex')}`);
  }

  start(): void {
    if (this.stopped || this.screen !== null) return;
    this.screen = this.options.openScreen();
    if (this.screen === null) return;
    this.changedAt = Date.now();
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.screen?.dispose();
    this.screen = null;
    this.published = null;
  }

  current(): LiveQuestion | null {
    return this.published;
  }

  /**
   * Relee la pantalla antes de contestar `id`. Espera, como mucho
   * `verifyTimeoutMs`, dos lecturas seguidas que digan lo mismo: un redibujo a
   * medias no puede pasar por la pregunta entera.
   */
  async verify(id: string): Promise<LiveQuestionCheck> {
    const published = this.published;
    if (published === null || published.part.toolUseId !== id || this.screen === null) return 'gone';
    const read = await this.stableRead();
    if (this.stopped) return 'gone';
    if (read === undefined) return 'changed';
    if (read === null) return 'gone';
    if (read.key !== published.key) return 'changed';
    return read.untouched ? 'ok' : 'touched';
  }

  /**
   * Relee la pantalla antes de contestar una pregunta del historial: la que la
   * CLI escribio antes de que se contestara (§5.5.1), y que el hilo muestra en
   * vez de la leida. Sin esto las teclas de esa tarjeta irian a ciegas aunque
   * la pantalla este a la vista. `unknown` si la pantalla no muestra una
   * pregunta que se pueda leer (varias preguntas, por ejemplo): ahi se contesta
   * como siempre, sin mirar.
   */
  async check(item: ConversationQuestionItem): Promise<LiveQuestionCheck | 'unknown'> {
    if (this.screen === null) return 'unknown';
    const read = await this.stableRead();
    if (read === undefined) return 'changed';
    if (read === null) return 'unknown';
    if (!sameQuestionItem(read.item, item)) return 'changed';
    return read.untouched ? 'ok' : 'touched';
  }

  /** Dos lecturas seguidas iguales, o `undefined` si la pantalla no se quedo quieta a tiempo. */
  private async stableRead(): Promise<ScreenQuestion | null | undefined> {
    const deadline = Date.now() + this.timing.verifyTimeoutMs;
    let last: string | null = null;
    for (;;) {
      const read = await this.read();
      const key = readingKey(read);
      if (key === last) return read;
      last = key;
      if (this.stopped || Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, this.timing.fastPollMs));
    }
  }

  private async read(): Promise<ScreenQuestion | null> {
    const screen = this.screen;
    if (screen === null) return null;
    const lines = await screen.lines();
    try {
      return this.options.reader.read(lines);
    } catch {
      // Un lector que falla no puede tirar el servidor: es una pantalla que no se entiende.
      return null;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
    this.timer.unref();
  }

  private async poll(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;
    const read = await this.read();
    if (this.stopped) return;

    const key = readingKey(read);
    if (key === this.previous) {
      this.publish(read);
    } else {
      this.previous = key;
      this.changedAt = Date.now();
    }
    const quiet = Date.now() - this.changedAt >= this.timing.settleMs;
    this.schedule(quiet ? this.timing.slowPollMs : this.timing.fastPollMs);
  }

  /** Publica una lectura que se repitio. La misma pregunta conserva su id. */
  private publish(read: ScreenQuestion | null): void {
    if (read === null) {
      if (this.published === null) return;
      this.published = null;
      this.options.onChange();
      return;
    }
    if (this.published !== null && this.published.key === read.key) return;
    const id = this.ids.get(read.key) ?? this.newId();
    this.ids.set(read.key, id);
    this.published = {
      key: read.key,
      part: { kind: 'question', toolUseId: id, questions: [read.item] },
    };
    this.options.onChange();
  }
}
