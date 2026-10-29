/**
 * La sugerencia que una CLI dibuja en su caja al terminar un turno, para el
 * cuadro de la conversacion (hito 53, §5.3.2).
 *
 * La CLI no la escribe en ningun archivo: solo la dibuja, en gris, en su caja
 * vacia. Mientras una pestana cuya CLI la tiene (`promptSuggestion`) esta libre,
 * se mira su pantalla emulada: se abre al quedar libre, se relee cada vez que
 * la salida se calma (lo que el usuario teclea en la solapa CLI la tapa, y
 * vaciar la caja la trae de vuelta) y se suelta en cuanto la pestana deja de
 * estar libre o se cierra. Cuando cambia lo que se lee, se avisa (`publish`).
 *
 * Lo que cuesta: una pantalla emulada sin historial por pestana libre de esa
 * CLI, y una lectura despues de cada racha de salida. Sin nombrar ninguna CLI.
 */

import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import type { PromptSuggestionReader } from './agents/adapter.js';
import type { FaintSplit } from './pty-screen.js';

/** Cuanto tiene que callarse la salida para releer: un redibujo se lee entero, no a medias. */
export const SUGGESTION_QUIET_MS = 200;

/** Lo justo de la pantalla emulada (`TerminalRegistry.watchScreen`). */
export interface SuggestionScreen {
  splitByFaint?(): Promise<FaintSplit>;
  dispose(): void;
}

export interface CliSuggestionDeps {
  /** El lector de la CLI de la pestana, o null si su CLI no tiene sugerencia. */
  readerOf(terminalId: TerminalId): PromptSuggestionReader | null;
  /** La pantalla emulada de la pestana, o null sin proceso. */
  openScreen(terminalId: TerminalId): SuggestionScreen | null;
  /** Cambio la sugerencia de una pestana; null, ya no hay. */
  publish(terminalId: TerminalId, text: string | null): void;
  /** Inyectable para el chequeo. Devuelve como cancelarlo. */
  setTimer?(callback: () => void, ms: number): () => void;
}

export interface SuggestionEntry {
  terminalId: TerminalId;
  text: string;
}

interface Watch {
  screen: SuggestionScreen;
  reader: PromptSuggestionReader;
  cancelTimer: (() => void) | null;
  reading: boolean;
  /** Llego salida durante una lectura: hay que releer al terminar. */
  again: boolean;
}

const defaultTimer = (callback: () => void, ms: number): (() => void) => {
  const timer = setTimeout(callback, ms);
  timer.unref();
  return () => clearTimeout(timer);
};

export class CliSuggestions {
  private readonly watches = new Map<TerminalId, Watch>();
  private readonly current = new Map<TerminalId, string>();

  constructor(private readonly deps: CliSuggestionDeps) {}

  /** Cambio la actividad de una pestana: libre se mira; cualquier otra cosa, ya no vale. */
  activity(terminalId: TerminalId, activity: TerminalActivity): void {
    if (activity === 'idle') this.watch(terminalId);
    else this.stop(terminalId);
  }

  /** Llego salida de una pestana: si se esta mirando, se relee cuando se calme. */
  output(terminalId: TerminalId): void {
    const watch = this.watches.get(terminalId);
    if (watch !== undefined) this.schedule(terminalId, watch);
  }

  /**
   * Se le mando algo a la pestana desde el cuadro. La sugerencia que habia ya se
   * uso o se descarto: se avisa que no hay, y si la CLI la sigue mostrando (un
   * comando que no abre turno), la proxima lectura la vuelve a avisar.
   */
  submitted(terminalId: TerminalId): void {
    this.set(terminalId, null);
    const watch = this.watches.get(terminalId);
    if (watch !== undefined) this.schedule(terminalId, watch);
  }

  /** La pestana se cerro. */
  forget(terminalId: TerminalId): void {
    this.stop(terminalId);
  }

  /** Las que hay ahora, para la ventana que se conecta. */
  snapshot(): SuggestionEntry[] {
    return [...this.current].map(([terminalId, text]) => ({ terminalId, text }));
  }

  dispose(): void {
    for (const terminalId of [...this.watches.keys()]) this.release(terminalId);
    this.current.clear();
  }

  private watch(terminalId: TerminalId): void {
    const known = this.watches.get(terminalId);
    if (known !== undefined) {
      this.schedule(terminalId, known);
      return;
    }
    const reader = this.deps.readerOf(terminalId);
    if (reader === null) return;
    const screen = this.deps.openScreen(terminalId);
    if (screen === null) return;
    const watch: Watch = { screen, reader, cancelTimer: null, reading: false, again: false };
    this.watches.set(terminalId, watch);
    this.schedule(terminalId, watch);
  }

  private stop(terminalId: TerminalId): void {
    this.release(terminalId);
    this.set(terminalId, null);
  }

  private release(terminalId: TerminalId): void {
    const watch = this.watches.get(terminalId);
    if (watch === undefined) return;
    this.watches.delete(terminalId);
    watch.cancelTimer?.();
    watch.screen.dispose();
  }

  private schedule(terminalId: TerminalId, watch: Watch): void {
    watch.cancelTimer?.();
    watch.cancelTimer = (this.deps.setTimer ?? defaultTimer)(() => {
      watch.cancelTimer = null;
      void this.read(terminalId, watch);
    }, SUGGESTION_QUIET_MS);
  }

  private async read(terminalId: TerminalId, watch: Watch): Promise<void> {
    if (watch.reading) {
      watch.again = true;
      return;
    }
    watch.reading = true;
    try {
      const split = await watch.screen.splitByFaint?.();
      // Se solto mientras se leia: lo leido ya no es de nadie.
      if (this.watches.get(terminalId) !== watch || split === undefined) return;
      let text: string | null = null;
      try {
        text = watch.reader.read(split.clean, split.faint);
      } catch {
        text = null;
      }
      this.set(terminalId, text);
    } finally {
      watch.reading = false;
      if (watch.again && this.watches.get(terminalId) === watch) {
        watch.again = false;
        this.schedule(terminalId, watch);
      }
    }
  }

  private set(terminalId: TerminalId, text: string | null): void {
    if ((this.current.get(terminalId) ?? null) === text) return;
    if (text === null) this.current.delete(terminalId);
    else this.current.set(terminalId, text);
    this.deps.publish(terminalId, text);
  }
}
