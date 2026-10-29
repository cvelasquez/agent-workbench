/**
 * El foco que la app le reporta a la CLI de una pestana: el de la pestana, no el
 * de su terminal (hito 53, §5.3.2).
 *
 * Claude Code decide por el foco de su terminal si pide la sugerencia del
 * mensaje siguiente (§4.4.5): con "foco afuera" (`ESC[O`) no la pide. La
 * terminal de la pagina se lo reporta con verdad, pero en la app se escribe en
 * el cuadro de la conversacion, no en la terminal, y la CLI quedaba sin foco casi
 * siempre: medido, ninguna sugerencia en ocho turnos. Lo decidio el usuario: para
 * quien desarrolla, la pestana activa es como tener la CLI abierta.
 *
 * Cada ventana dice que pestana mira (`terminal.attention`: la activa, si la
 * ventana tiene el foco y se ve; null si no). La pestana tiene el foco si al
 * menos una ventana la mira. Cuando eso cambia, y solo si la CLI pidio los
 * avisos de foco (`ESC[?1004h` en su salida), se le escribe `ESC[I` o `ESC[O`.
 * Los avisos que arma la terminal de la pagina por su cuenta no le llegan.
 *
 * Solo con una CLI que lo declara (`AgentAdapter.focusByTab`). Sin nombrar ninguna.
 */

import type { TerminalId } from '@agent-workbench/shared';

/** Los avisos de foco de una terminal (DECSET 1004). */
export const FOCUS_IN = '\x1b[I';
export const FOCUS_OUT = '\x1b[O';

/** Encender o apagar los avisos de foco: `ESC[?1004h` / `ESC[?1004l`, solo o con otros modos. */
const FOCUS_MODE = /\x1b\[\?([0-9;]*)([hl])/g;
/** Lo que puede quedar de una secuencia cortada al final de un trozo de salida. */
const MAX_TAIL = 16;

export interface TabFocusDeps {
  /** Si la CLI de la pestana recibe el foco de la pestana (`focusByTab`). */
  appliesTo(terminalId: TerminalId): boolean;
  /** Escribe en la pty. false si no la acepto (dormida, cerrada). */
  write(terminalId: TerminalId, data: string): boolean;
}

interface TabState {
  /** Las ventanas que miran esta pestana. */
  watchers: Set<unknown>;
  /** La CLI pidio los avisos de foco. */
  reporting: boolean;
  /** Lo ultimo que se le escribio; null si nada desde que los pidio. */
  reported: boolean | null;
  /** El final de la salida anterior, si cortaba una secuencia. */
  tail: string;
}

export class TabFocus {
  /** Que pestana mira cada ventana (la clave es la del socket). */
  private readonly watching = new Map<unknown, TerminalId>();
  private readonly tabs = new Map<TerminalId, TabState>();

  constructor(private readonly deps: TabFocusDeps) {}

  /** Una ventana mira esa pestana; null, ninguna (sin foco, oculta, o sin pestanas). */
  attend(watcher: unknown, terminalId: TerminalId | null): void {
    const before = this.watching.get(watcher) ?? null;
    if (before === terminalId) return;
    if (before !== null) {
      this.state(before).watchers.delete(watcher);
      this.sync(before);
    }
    if (terminalId === null) {
      this.watching.delete(watcher);
      return;
    }
    this.watching.set(watcher, terminalId);
    this.state(terminalId).watchers.add(watcher);
    this.sync(terminalId);
  }

  /** La ventana se cerro. */
  leave(watcher: unknown): void {
    this.attend(watcher, null);
  }

  /** Salida de la pty: si la CLI pide o deja de pedir los avisos de foco. */
  output(terminalId: TerminalId, chunk: string): void {
    if (!this.deps.appliesTo(terminalId)) return;
    const state = this.tabs.get(terminalId);
    const combined = (state?.tail ?? '') + chunk;
    let reporting: boolean | null = null;
    if (combined.includes('\x1b[?')) {
      for (const match of combined.matchAll(FOCUS_MODE)) {
        if ((match[1] ?? '').split(';').includes('1004')) reporting = match[2] === 'h';
      }
    }
    const tail = combined.includes('\x1b') ? trailingEscape(combined) : '';
    if (state === undefined && reporting === null && tail === '') return;
    const target = state ?? this.state(terminalId);
    target.tail = tail;
    if (reporting === null) return;
    target.reporting = reporting;
    // Una CLI que los vuelve a pedir (o una nueva, al abrirla de nuevo) no sabe nada todavia.
    target.reported = null;
    if (reporting) this.sync(terminalId);
  }

  /**
   * Si lo que manda la pagina como tecleado es un aviso de foco de su terminal,
   * que no tiene que llegarle a esta CLI: el foco se lo dice la pestana.
   */
  isFocusReport(terminalId: TerminalId, data: string): boolean {
    return (data === FOCUS_IN || data === FOCUS_OUT) && this.deps.appliesTo(terminalId);
  }

  /** La pestana se cerro. */
  forget(terminalId: TerminalId): void {
    const state = this.tabs.get(terminalId);
    if (state === undefined) return;
    for (const watcher of state.watchers) this.watching.delete(watcher);
    this.tabs.delete(terminalId);
  }

  /** Si la pestana tiene el foco: alguna ventana la mira. */
  focused(terminalId: TerminalId): boolean {
    return (this.tabs.get(terminalId)?.watchers.size ?? 0) > 0;
  }

  private state(terminalId: TerminalId): TabState {
    let state = this.tabs.get(terminalId);
    if (state === undefined) {
      state = { watchers: new Set(), reporting: false, reported: null, tail: '' };
      this.tabs.set(terminalId, state);
    }
    return state;
  }

  /** Le escribe a la CLI el foco de ahora, si lo pidio y si cambio. */
  private sync(terminalId: TerminalId): void {
    const state = this.tabs.get(terminalId);
    if (state === undefined || !state.reporting || !this.deps.appliesTo(terminalId)) return;
    const focused = state.watchers.size > 0;
    if (state.reported === focused) return;
    if (this.deps.write(terminalId, focused ? FOCUS_IN : FOCUS_OUT)) state.reported = focused;
  }
}

/** Lo que queda despues del ultimo ESC si es una secuencia sin terminar, o nada. */
function trailingEscape(text: string): string {
  const start = text.lastIndexOf('\x1b');
  if (start < 0) return '';
  const tail = text.slice(start);
  if (tail.length > MAX_TAIL) return '';
  // Completa: ESC [ parametros, intermedios y el byte final. Ya se miro entera.
  return /^\x1b\[[0-9;?]*[ -/]*[@-~]/.test(tail) || /^\x1b[^[]/.test(tail) ? '' : tail;
}
