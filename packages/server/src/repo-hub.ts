/**
 * Sigue el estado de git de las pestanas que alguien esta mirando.
 *
 * Misma forma que `ConversationHub`, y por la misma razon: un `git status` por
 * pestana abierta, corriendo para un panel que nadie tiene delante, es trabajo
 * puro. Refcount, y cuando el ultimo cliente deja de mirar se apaga el watcher.
 *
 * De donde sale un refresco, en orden de utilidad:
 *
 *  1. **Fin de turno.** Cuando la conversacion de esa pestana recibe eventos
 *     nuevos, el agente acaba de tocar archivos. Es el momento en que el panel
 *     tiene que cambiar, y es el que el brief pedia.
 *  2. **El directorio `.git`.** Un commit, un `git add`, un cambio de rama —
 *     hecho por el usuario en la terminal o por cualquier otra herramienta.
 *  3. **Un sondeo espaciado.** Editar un archivo a mano no toca `.git`, asi que
 *     sin esto el panel se queda viejo hasta el proximo turno. El intervalo se
 *     adapta a lo que tarde `git status`: en un repo lento no se encadenan
 *     lecturas que no terminan.
 *  4. El boton de recargar del panel.
 */

import { EventEmitter } from 'node:events';
import chokidar, { type FSWatcher } from 'chokidar';
import type { GitStatus, TerminalId } from '@agent-workbench/shared';
import { debugLog } from './debug.js';
import { findGitDir, readStatus } from './git-repo.js';
import type { TerminalRegistry } from './terminal-registry.js';

/** Piso del sondeo. Editar a mano no toca `.git`, por eso existe. */
const MIN_POLL_MS = 5_000;
/** Techo, para un repo lento: nunca mas de esto entre lecturas. */
const MAX_POLL_MS = 60_000;
/** Agrupado de los eventos de `.git`: un commit toca varios archivos. */
const WATCH_DEBOUNCE_MS = 300;

interface Entry {
  cwd: string;
  refs: number;
  watcher: FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  status: GitStatus | null;
  /** Evita que dos refrescos se pisen sobre el mismo repo. */
  reading: boolean;
}

export interface RepoHubEvents {
  status: (terminalId: TerminalId, status: GitStatus) => void;
}

export declare interface RepoHub {
  on<E extends keyof RepoHubEvents>(event: E, listener: RepoHubEvents[E]): this;
  emit<E extends keyof RepoHubEvents>(
    event: E,
    ...args: Parameters<RepoHubEvents[E]>
  ): boolean;
}

export class RepoHub extends EventEmitter {
  private readonly entries = new Map<TerminalId, Entry>();

  constructor(private readonly registry: TerminalRegistry) {
    super();
  }

  /** Engancha un cliente y devuelve el estado actual. */
  async subscribe(terminalId: TerminalId): Promise<GitStatus | null> {
    const descriptor = this.registry.get(terminalId);
    if (descriptor === null) return null;

    let entry = this.entries.get(terminalId);
    if (entry === undefined) {
      entry = {
        cwd: descriptor.cwd,
        refs: 0,
        watcher: null,
        debounceTimer: null,
        pollTimer: null,
        status: null,
        reading: false,
      };
      this.entries.set(terminalId, entry);
      void this.startWatching(terminalId, entry);
    }
    entry.refs += 1;

    if (entry.status === null) await this.read(terminalId, entry, { silent: true });
    return entry.status;
  }

  unsubscribe(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return;

    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.dispose(terminalId, entry);
  }

  /** La pestana se cerro: se suelta sin importar cuantos la miraban. */
  drop(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry !== undefined) this.dispose(terminalId, entry);
  }

  getStatus(terminalId: TerminalId): GitStatus | null {
    return this.entries.get(terminalId)?.status ?? null;
  }

  /** Relectura inmediata, para el boton del panel. */
  refresh(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return;
    void this.read(terminalId, entry, { silent: false });
  }

  /**
   * El agente escribio en el JSONL de esta pestana: probablemente acaba de
   * tocar archivos. Se agrupa igual que un evento del watcher, porque un turno
   * genera muchas escrituras seguidas.
   */
  onConversationActivity(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return;
    this.scheduleRead(terminalId, entry);
  }

  disposeAll(): void {
    for (const [terminalId, entry] of this.entries) this.dispose(terminalId, entry);
  }

  // -------------------------------------------------------------------------

  private dispose(terminalId: TerminalId, entry: Entry): void {
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    if (entry.pollTimer !== null) clearTimeout(entry.pollTimer);
    void entry.watcher?.close();
    this.entries.delete(terminalId);
    debugLog('git', `dejo de mirar el repo de ${terminalId.slice(0, 8)}`);
  }

  /**
   * Observa el `.git` del worktree.
   *
   * Se excluyen dos cosas:
   *
   *  - `objects/`, `lfs/` y `modules/`: miles de archivos que cambian en cada
   *    operacion y no dicen nada que `status` no diga mejor. Lo que interesa es
   *    `HEAD`, `index` y `refs/`.
   *  - Los `.lock`. `index.lock` aparece y desaparece en cada comando de git, y
   *    reaccionar a el es leer el estado justo cuando el repo esta a medio
   *    cambiar. El evento util es el del archivo definitivo, que llega enseguida.
   */
  private async startWatching(terminalId: TerminalId, entry: Entry): Promise<void> {
    let gitDir: string | null;
    try {
      gitDir = await findGitDir(entry.cwd);
    } catch {
      gitDir = null;
    }
    // Puede haberse soltado mientras se resolvia el directorio.
    if (this.entries.get(terminalId) !== entry) return;
    if (gitDir === null) {
      this.schedulePoll(terminalId, entry);
      return;
    }

    try {
      const watcher = chokidar.watch(gitDir, {
        depth: 2,
        ignoreInitial: true,
        ignored: (candidate: string) =>
          /[\\/](objects|lfs|modules)([\\/]|$)/.test(candidate) || candidate.endsWith('.lock'),
      });
      watcher.on('all', () => this.scheduleRead(terminalId, entry));
      watcher.on('error', () => {
        /* Sin watcher queda el sondeo, que alcanza. */
      });
      entry.watcher = watcher;
    } catch {
      // Sin watcher se sigue con el sondeo.
    }

    this.schedulePoll(terminalId, entry);
  }

  private scheduleRead(terminalId: TerminalId, entry: Entry): void {
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.read(terminalId, entry, { silent: false });
    }, WATCH_DEBOUNCE_MS);
    entry.debounceTimer.unref();
  }

  private schedulePoll(terminalId: TerminalId, entry: Entry, afterMs = MIN_POLL_MS): void {
    if (entry.pollTimer !== null) clearTimeout(entry.pollTimer);
    entry.pollTimer = setTimeout(() => {
      entry.pollTimer = null;
      void this.read(terminalId, entry, { silent: false });
    }, afterMs);
    entry.pollTimer.unref();
  }

  /**
   * Una lectura. `silent` es para la primera, cuyo resultado ya viaja en la
   * respuesta a `git.subscribe`: emitirlo ademas seria mandarlo dos veces.
   */
  private async read(
    terminalId: TerminalId,
    entry: Entry,
    options: { silent: boolean },
  ): Promise<void> {
    if (entry.reading) return;
    entry.reading = true;

    const startedAt = Date.now();
    try {
      const status = await readStatus(entry.cwd);
      // Puede haberse soltado mientras corria git.
      if (this.entries.get(terminalId) !== entry) return;
      entry.status = status;
      if (!options.silent) this.emit('status', terminalId, status);
    } catch (error) {
      console.warn(`[git] no se pudo leer el estado de ${entry.cwd}:`, error);
    } finally {
      entry.reading = false;
      if (this.entries.get(terminalId) === entry) {
        // El intervalo se adapta: en un repo donde `status` tarda 3 s no se
        // vuelve a leer a los 5, se espera cuatro veces lo que tardo.
        const elapsed = Date.now() - startedAt;
        const next = Math.min(Math.max(MIN_POLL_MS, elapsed * 4), MAX_POLL_MS);
        this.schedulePoll(terminalId, entry, next);
      }
    }
  }
}
