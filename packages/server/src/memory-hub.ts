/**
 * Sigue la memoria compartida de los proyectos que alguien esta mirando.
 *
 * Misma forma que `RepoHub`: suscripcion por pestana y un watcher que se apaga
 * cuando no queda nadie. Con una diferencia: el watcher es **por directorio**,
 * no por pestana. Dos pestanas del mismo proyecto miran la misma carpeta, y
 * dos watchers sobre el mismo `cwd` son el doble de trabajo para dar el mismo
 * aviso dos veces.
 *
 * Todo lo que toca el disco de un mismo `cwd` —inspeccionar, planear, instalar,
 * importar, leer— pasa por una cola. Instalar mientras un refresco del watcher
 * lee el disco a medias daria un estado que no existio nunca, y dos
 * instalaciones a la vez se pisarian el mismo `AGENTS.md`.
 */

import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  MemoryChange,
  MemoryInstallOptions,
  MemoryNoteContent,
  MemoryStatus,
  TerminalId,
} from '@agent-workbench/shared';
import { debugLog } from './debug.js';
import {
  importNativeMemory,
  inspectMemory,
  installMemory,
  planMemoryInstall,
  readMemoryNote,
} from './memory-bridge.js';
import type { TerminalRegistry } from './terminal-registry.js';

/** Agrupado de eventos: instalar escribe varios archivos seguidos. */
const WATCH_DEBOUNCE_MS = 300;

/** La pestana no existe, o no tiene directorio contra el cual resolver. */
export class UnknownTerminalError extends Error {
  constructor() {
    super('The terminal no longer exists.');
    this.name = 'UnknownTerminalError';
  }
}

interface WatchEntry {
  cwd: string;
  key: string;
  /** Pestanas que miran este `cwd`, con cuantas suscripciones cada una. */
  subscribers: Map<TerminalId, number>;
  watcher: FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  /** El ultimo estado emitido, serializado, para no repetir uno igual. */
  lastJson: string | null;
}

export interface MemoryHubEvents {
  status: (terminalId: TerminalId, status: MemoryStatus) => void;
}

export declare interface MemoryHub {
  on<E extends keyof MemoryHubEvents>(event: E, listener: MemoryHubEvents[E]): this;
  off<E extends keyof MemoryHubEvents>(event: E, listener: MemoryHubEvents[E]): this;
  emit<E extends keyof MemoryHubEvents>(
    event: E,
    ...args: Parameters<MemoryHubEvents[E]>
  ): boolean;
}

export class MemoryHub extends EventEmitter {
  private readonly watches = new Map<string, WatchEntry>();
  private readonly terminalKeys = new Map<TerminalId, string>();
  private readonly queues = new Map<string, Promise<void>>();

  /** `home` es inyectable por lo mismo que en el puente: probar sin tocar el real. */
  constructor(
    private readonly registry: TerminalRegistry,
    private readonly home: string = homedir(),
  ) {
    super();
  }

  /**
   * Engancha una pestana y devuelve el estado actual, o null si no existe.
   *
   * La suscripcion queda hecha aunque la inspeccion falle: si el problema se
   * arregla —un enlace que se corrige—, el watcher lo ve y el panel se entera.
   */
  async subscribe(terminalId: TerminalId): Promise<MemoryStatus | null> {
    const cwd = this.cwdOf(terminalId);
    if (cwd === null) return null;
    const key = keyFor(cwd);

    let entry = this.watches.get(key);
    if (entry === undefined) {
      entry = {
        cwd,
        key,
        subscribers: new Map(),
        watcher: null,
        debounceTimer: null,
        lastJson: null,
      };
      this.watches.set(key, entry);
      this.startWatching(entry);
    }
    entry.subscribers.set(terminalId, (entry.subscribers.get(terminalId) ?? 0) + 1);
    this.terminalKeys.set(terminalId, key);

    const status = await this.enqueue(key, () => inspectMemory(cwd, this.home));
    if (this.watches.get(key) === entry) entry.lastJson = JSON.stringify(status);
    return status;
  }

  unsubscribe(terminalId: TerminalId): void {
    const entry = this.entryOf(terminalId);
    if (entry === null) return;
    const count = entry.subscribers.get(terminalId) ?? 0;
    if (count > 1) {
      entry.subscribers.set(terminalId, count - 1);
      return;
    }
    this.release(terminalId, entry);
  }

  /** La pestana se cerro: se suelta sin importar cuantas veces la miraban. */
  drop(terminalId: TerminalId): void {
    const entry = this.entryOf(terminalId);
    if (entry !== null) this.release(terminalId, entry);
  }

  async plan(terminalId: TerminalId, options: MemoryInstallOptions): Promise<MemoryChange[]> {
    const cwd = this.requireCwd(terminalId);
    return this.enqueue(keyFor(cwd), () => planMemoryInstall(cwd, options, this.home));
  }

  /**
   * Instala y devuelve lo aplicado junto con el estado nuevo.
   *
   * El estado se lee en la misma vuelta de la cola, sin esperar al watcher:
   * el panel tiene que cambiar en el mismo clic. Si la relectura falla, la
   * instalacion igual se hizo, y eso es lo que se informa.
   */
  async install(
    terminalId: TerminalId,
    options: MemoryInstallOptions,
  ): Promise<{ applied: MemoryChange[]; status: MemoryStatus | null }> {
    const cwd = this.requireCwd(terminalId);
    return this.enqueue(keyFor(cwd), async () => {
      const applied = await installMemory(cwd, options, this.home);
      return { applied, status: await this.inspectQuietly(cwd) };
    });
  }

  async importNative(
    terminalId: TerminalId,
  ): Promise<{ copied: string[]; skipped: string[]; status: MemoryStatus | null }> {
    const cwd = this.requireCwd(terminalId);
    return this.enqueue(keyFor(cwd), async () => {
      const result = await importNativeMemory(cwd, this.home);
      return { ...result, status: await this.inspectQuietly(cwd) };
    });
  }

  async read(terminalId: TerminalId, name: string): Promise<MemoryNoteContent | null> {
    const cwd = this.requireCwd(terminalId);
    return this.enqueue(keyFor(cwd), () => readMemoryNote(cwd, name));
  }

  /**
   * Manda un estado recien leido a quienes miran ese `cwd`, y a la pestana que
   * lo pidio aunque no este suscrita. Queda como ultimo emitido, asi el watcher
   * no lo repite cuando vea las escrituras.
   */
  publish(terminalId: TerminalId, status: MemoryStatus): void {
    const cwd = this.cwdOf(terminalId);
    const entry = cwd === null ? undefined : this.watches.get(keyFor(cwd));
    const targets = new Set<TerminalId>([terminalId]);
    if (entry !== undefined) {
      entry.lastJson = JSON.stringify(status);
      for (const id of entry.subscribers.keys()) targets.add(id);
    }
    for (const id of targets) this.emit('status', id, status);
  }

  /** Suelta todo. La promesa se cumple cuando los watchers soltaron las carpetas. */
  async disposeAll(): Promise<void> {
    const closing = [...this.watches.values()].map((entry) => this.dispose(entry));
    this.terminalKeys.clear();
    await Promise.all(closing);
  }

  // -------------------------------------------------------------------------

  private cwdOf(terminalId: TerminalId): string | null {
    const descriptor = this.registry.get(terminalId);
    if (descriptor === null || descriptor.cwd.length === 0) return null;
    return descriptor.cwd;
  }

  private requireCwd(terminalId: TerminalId): string {
    const cwd = this.cwdOf(terminalId);
    if (cwd === null) throw new UnknownTerminalError();
    return cwd;
  }

  private entryOf(terminalId: TerminalId): WatchEntry | null {
    const key = this.terminalKeys.get(terminalId);
    if (key === undefined) return null;
    return this.watches.get(key) ?? null;
  }

  private release(terminalId: TerminalId, entry: WatchEntry): void {
    entry.subscribers.delete(terminalId);
    this.terminalKeys.delete(terminalId);
    if (entry.subscribers.size === 0) void this.dispose(entry);
  }

  private async dispose(entry: WatchEntry): Promise<void> {
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    this.watches.delete(entry.key);
    debugLog('memory', `stopped watching the memory of ${entry.cwd}`);
    await entry.watcher?.close().catch(() => undefined);
  }

  /**
   * Observa el `cwd` con un filtro que deja pasar solo lo que cambia el estado.
   *
   * Se observa el `cwd` y no `.agents/memory` porque la carpeta puede no
   * existir todavia: asi se la ve nacer. El filtro es una funcion y no una
   * lista de globs para que chokidar no llegue a recorrer `node_modules`.
   */
  private startWatching(entry: WatchEntry): void {
    try {
      const watcher = chokidar.watch(entry.cwd, {
        depth: 2,
        ignoreInitial: true,
        ignored: (candidate: string) => !isRelevantPath(entry.cwd, candidate),
      });
      watcher.on('all', () => this.schedule(entry));
      watcher.on('error', () => {
        /* Sin watcher el estado se refresca al instalar o al volver a suscribirse. */
      });
      entry.watcher = watcher;
    } catch {
      // Idem.
    }
  }

  private schedule(entry: WatchEntry): void {
    if (entry.debounceTimer !== null) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      void this.refresh(entry);
    }, WATCH_DEBOUNCE_MS);
    entry.debounceTimer.unref();
  }

  private async refresh(entry: WatchEntry): Promise<void> {
    try {
      const status = await this.enqueue(entry.key, () => inspectMemory(entry.cwd, this.home));
      // Puede haberse soltado mientras se leia.
      if (this.watches.get(entry.key) !== entry) return;
      const json = JSON.stringify(status);
      if (json === entry.lastJson) return;
      entry.lastJson = json;
      for (const terminalId of entry.subscribers.keys()) this.emit('status', terminalId, status);
    } catch (error) {
      console.warn(`[memory] couldn't read the status of ${entry.cwd}:`, error);
    }
  }

  private async inspectQuietly(cwd: string): Promise<MemoryStatus | null> {
    try {
      return await inspectMemory(cwd, this.home);
    } catch (error) {
      console.warn(`[memory] couldn't reread the status of ${cwd}:`, error);
      return null;
    }
  }

  /** Cola por `cwd`: cada tarea arranca cuando termina la anterior, falle o no. */
  private enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, settled);
    void settled.then(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return run;
  }
}

/** Clave de un `cwd`: en Windows `D:\Mi App` y `d:\mi app` son la misma carpeta. */
function keyFor(cwd: string): string {
  const resolved = path.resolve(cwd);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * true si un cambio en `candidate` puede cambiar el estado de la memoria.
 *
 * Pasan: el `cwd`, `.agents`, `.agents/memory`, sus `.md`, `AGENTS.md`,
 * `CLAUDE.md` y `.gitignore`. Todo lo demas se ignora, y como chokidar no entra
 * a una carpeta ignorada, tampoco se recorre.
 */
export function isRelevantPath(cwd: string, candidate: string): boolean {
  const relative = path.relative(cwd, candidate);
  if (relative.length === 0) return true;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return false;

  const same = (a: string, b: string): boolean =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  const parts = relative.split(/[\\/]/);
  const [first = '', second = '', third = ''] = parts;

  switch (parts.length) {
    case 1:
      return ['.agents', 'AGENTS.md', 'CLAUDE.md', '.gitignore'].some((name) => same(first, name));
    case 2:
      return same(first, '.agents') && same(second, 'memory');
    case 3:
      return (
        same(first, '.agents') && same(second, 'memory') && third.toLowerCase().endsWith('.md')
      );
    default:
      return false;
  }
}
