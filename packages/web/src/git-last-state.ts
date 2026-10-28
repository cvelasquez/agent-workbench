/**
 * El ultimo estado de Cambios de cada pestana, para mostrarlo mientras llega el
 * de ahora (28-10-2026, §6.2.1).
 *
 * Al entrar a una pestana, el servidor lanza git desde cero, y en una maquina
 * donde arrancar un proceso cuesta 200 ms (un antivirus que revisa cada uno)
 * eso es un segundo de "todavia no se conoce el estado". Ahora se ve lo ultimo
 * que se supo de esa misma pestana, marcado como viejo hasta que llega lo de
 * ahora. Nunca lo de otra: mostrar el repo anterior un instante seria peor que
 * un panel vacio.
 *
 * Mientras es viejo, se puede mirar todo y no se puede hacer nada que cambie
 * algo o lo parezca (lo pidio el usuario): `actionWaits`.
 */

import type { GitStatus, TerminalId } from '@agent-workbench/shared';

/** Cuantas pestanas se recuerdan: mas de las que se abren en un dia, y poco en memoria. */
export const LAST_STATE_LIMIT = 32;

export interface Entered<T> {
  value: T;
  /** Es lo guardado: todavia no llego lo de ahora. */
  stale: boolean;
}

/** Lo ultimo que se supo de cada pestana, solo en memoria: un F5 lo pierde. */
export class LastStateCache<T> {
  private readonly byTerminal = new Map<TerminalId, T>();

  constructor(private readonly limit: number = LAST_STATE_LIMIT) {}

  /** Al entrar a una pestana: lo guardado, como viejo, o `empty` si no hay nada. */
  enter(terminalId: TerminalId, empty: T): Entered<T> {
    const saved = this.byTerminal.get(terminalId);
    return saved === undefined ? { value: empty, stale: false } : { value: saved, stale: true };
  }

  /** Llego lo de ahora. La mas reciente va al final: se olvida primero la que hace mas que no se mira. */
  store(terminalId: TerminalId, value: T): void {
    this.byTerminal.delete(terminalId);
    this.byTerminal.set(terminalId, value);
    while (this.byTerminal.size > this.limit) {
      const oldest = this.byTerminal.keys().next();
      if (oldest.done === true) break;
      this.byTerminal.delete(oldest.value);
    }
  }

  forget(terminalId: TerminalId): void {
    this.byTerminal.delete(terminalId);
  }
}

/**
 * Se guarda solo un estado leido: un error de git (la maquina sin memoria, un
 * disco que no responde) visto otra vez al volver diria algo que ya no pasa.
 */
export function rememberGitStatus(cache: LastStateCache<GitStatus>, terminalId: TerminalId, status: GitStatus): void {
  if (status.state === 'ready') cache.store(terminalId, status);
  else cache.forget(terminalId);
}

/** Lo que se puede tocar en Cambios. */
export type GitPanelAction =
  | 'openDiff'
  | 'refresh'
  | 'newBranch'
  | 'openBranch'
  | 'viewChanges'
  | 'showReviewer'
  | 'requestReview'
  | 'sendReview'
  | 'catchUp'
  | 'integrate'
  | 'remove'
  | 'deleteBranch';

/**
 * Lo que cambia algo o lo parece: crea una rama, le escribe a un agente o toca
 * el repo. Mirar un diff, ver lo que trae una rama, pasar a una pestana o
 * releer no cambia nada, y se puede mientras se espera.
 */
const CHANGES_SOMETHING: Record<GitPanelAction, boolean> = {
  openDiff: false,
  refresh: false,
  newBranch: true,
  openBranch: false,
  viewChanges: false,
  showReviewer: false,
  requestReview: true,
  sendReview: true,
  catchUp: true,
  integrate: true,
  remove: true,
  deleteBranch: true,
};

export interface GitFreshness {
  /** Cambios muestra el estado guardado. */
  statusStale: boolean;
  /** "Ramas aparte" muestra las filas guardadas. */
  rowsStale: boolean;
}

/**
 * Si una accion espera a que llegue lo de ahora. Crear una rama sale del
 * estado del repo; lo de una fila, de las filas, que se piden de nuevo con
 * cada estado: esas esperan a los dos.
 */
export function actionWaits(action: GitPanelAction, freshness: GitFreshness): boolean {
  if (!CHANGES_SOMETHING[action]) return false;
  if (action === 'newBranch') return freshness.statusStale;
  return freshness.statusStale || freshness.rowsStale;
}
