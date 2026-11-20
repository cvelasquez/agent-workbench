/**
 * Lo que llega a la copia propia desde otra PC (§13.15).
 *
 * Con la copia en una carpeta sincronizada (OneDrive, Syncthing, Dropbox), la
 * app de otra PC escribe ahi sus sesiones. El catalogo se carga al arrancar,
 * despues de cada escritura propia y con ⟳: sin esto, lo que trae el
 * sincronizador no aparece en la barra hasta reiniciar, y desde esta PC no se
 * puede continuar (§6.18). Mientras la copia esta encendida se vigila
 * `<copia>/sessions/` y se releen solo las cabeceras que cambiaron.
 *
 * Lo que no es evidente:
 *
 *  - **Solo `sessions/<fuente>/<id>.jsonl`.** Ni assets, ni temporales, ni
 *    `memory/` ni `export/`, ni la carpeta de una fuente que esta app no conoce
 *    (`ignoredInVault`). Que la cabecera sea de esa sesion lo sigue mirando el
 *    catalogo: una copia de conflicto del sincronizador no se lista.
 *  - **Un archivo que todavia crece no se lee** (`awaitWriteFinish`): el
 *    sincronizador lo esta bajando. Medido el 20-11-2026 en Windows: un alta
 *    por temporal y `rename`, como escribe `write.ts`, avisa a los 2,1 s.
 *  - **Los avisos se juntan** (`FOLDER_BATCH_MS`). La primera vez llegan
 *    cientos, y cada uno solo seria la barra entera a cada ventana: se relee la
 *    tanda (`refreshMany`) y el catalogo avisa una vez.
 *  - **Al empezar a vigilar se compara la carpeta con el catalogo**
 *    (`staleKeys`, con un `stat` por archivo): lo que llego entre la carga del
 *    arranque y el primer aviso no lo avisa nadie.
 *  - **Una carpeta que no existe no se le pasa a chokidar**, que vigilaria su
 *    padre: se mira esa ruta exacta con `stat` hasta que aparece, como el
 *    historial de una CLI (`session-watcher.ts`). Si se borra mientras se
 *    vigila, el watcher se suelta, se compara (sus filas se van) y se vuelve a
 *    mirar.
 *  - **chokidar con `persistent`, como en todo el servidor.** Medido el mismo
 *    dia: con `persistent: false` chokidar no escucha los errores de
 *    `fs.watch`, y borrar la carpeta vigilada en Windows tira un `EPERM` que
 *    tumba el proceso entero.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type ChokidarOptions, type FSWatcher } from 'chokidar';
import type { VaultCatalog, VaultSessionKey } from './catalog.js';
import { isSafeSessionId, isSessionAgentId, sessionsRoot } from './paths.js';
import type { VaultWriterTimers } from './writer.js';

/** Cuanto se espera desde el primer aviso para releer la tanda entera. */
export const FOLDER_BATCH_MS = 1_000;
/** Cuanto tiene que quedarse quieto el tamano de un archivo antes de leerlo. */
export const FOLDER_STABLE_MS = 2_000;
/** Cada cuanto se mira si aparecio `sessions/`. */
export const FOLDER_PROBE_MS = 5_000;

/** Lo que se usa de un watcher de chokidar. El chequeo pasa uno de mentira. */
export type VaultFolderWatcher = Pick<FSWatcher, 'on' | 'close'>;

export interface VaultFolderWatchOptions {
  catalog: Pick<VaultCatalog, 'refreshMany' | 'staleKeys'>;
  /**
   * true mientras la copia se muda: lo avisado espera. Si la mudanza sale bien,
   * este vigilante se suelta y el catalogo ya se cargo entero; si falla, se relee.
   */
  paused?: () => boolean;
  /** Con que se crea el watcher. Sin esto, chokidar. */
  watch?: (target: string, options: ChokidarOptions) => VaultFolderWatcher;
  isDirectory?: (target: string) => Promise<boolean>;
  timers?: VaultWriterTimers;
  batchMs?: number;
  stableMs?: number;
  probeMs?: number;
  log?: Pick<Console, 'warn'>;
}

const REAL_TIMERS: VaultWriterTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

async function isDirectoryOnDisk(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/** Los segmentos de `target` dentro de `root` ([] si es `root`), o null si esta afuera. */
function segmentsUnder(root: string, target: string): string[] | null {
  const relative = path.relative(root, target);
  if (relative.length === 0) return [];
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(/[\\/]/);
}

/**
 * Lo que chokidar no recorre ni avisa: todo lo que no sea la carpeta de una
 * fuente conocida o un `.jsonl` adentro de ella. Medido: assets, un `.txt` y
 * una fuente desconocida no dan ningun aviso, y borrar la raiz si.
 */
export function ignoredInVault(root: string, target: string): boolean {
  const parts = segmentsUnder(root, target);
  if (parts === null) return true;
  if (parts.length === 0) return false;
  if (parts.length === 1) return !isSessionAgentId(parts[0] ?? '');
  if (parts.length === 2) return !(parts[1] ?? '').endsWith('.jsonl');
  return true;
}

/** El par de la sesion de un aviso, o null si el archivo no es una sesion de la copia. */
export function sessionKeyOf(root: string, filePath: string): VaultSessionKey | null {
  const parts = segmentsUnder(root, filePath);
  if (parts === null || parts.length !== 2) return null;
  const [agent = '', name = ''] = parts;
  if (!isSessionAgentId(agent) || !name.endsWith('.jsonl')) return null;
  const sessionId = name.slice(0, -'.jsonl'.length);
  return isSafeSessionId(sessionId) ? { agent, sessionId } : null;
}

/**
 * Vigila `<dir>/sessions/` y relee en el catalogo lo que cambia. Devuelve con
 * que dejar de vigilar. Nunca lanza: lo que falla se loguea, y ⟳ sigue
 * releyendo la carpeta entera.
 */
export function watchVaultFolder(dir: string, options: VaultFolderWatchOptions): () => void {
  const root = sessionsRoot(dir);
  const { catalog } = options;
  const timers = options.timers ?? REAL_TIMERS;
  const createWatcher = options.watch ?? ((target, watchOptions) => chokidar.watch(target, watchOptions));
  const isDirectory = options.isDirectory ?? isDirectoryOnDisk;
  const batchMs = options.batchMs ?? FOLDER_BATCH_MS;
  const stableMs = options.stableMs ?? FOLDER_STABLE_MS;
  const probeMs = options.probeMs ?? FOLDER_PROBE_MS;
  const paused = options.paused ?? (() => false);
  const log = options.log ?? console;

  let stopped = false;
  let watcher: VaultFolderWatcher | null = null;
  let probe: unknown = null;
  let batch: unknown = null;
  let flushing = false;
  /** La proxima tanda compara la carpeta entera con el catalogo (`staleKeys`). */
  let compare = false;
  const pending = new Map<string, VaultSessionKey>();

  const schedule = (): void => {
    if (stopped || flushing || batch !== null) return;
    batch = timers.set(() => {
      batch = null;
      void flush();
    }, batchMs);
  };

  const flush = async (): Promise<void> => {
    if (stopped) return;
    if (paused()) {
      schedule();
      return;
    }
    flushing = true;
    const keys = [...pending.values()];
    pending.clear();
    const withCompare = compare;
    compare = false;
    try {
      if (withCompare) keys.push(...(await catalog.staleKeys()));
      if (keys.length > 0) await catalog.refreshMany(keys);
    } catch (error) {
      log.warn("[vault] couldn't reread what arrived in the copy:", error);
    } finally {
      flushing = false;
      if (pending.size > 0 || compare) schedule();
    }
  };

  const requestCompare = (): void => {
    compare = true;
    schedule();
  };

  const onFile = (filePath: string): void => {
    if (stopped) return;
    const key = sessionKeyOf(root, filePath);
    if (key === null) return;
    pending.set(`${key.agent}/${key.sessionId}`, key);
    schedule();
  };

  const startWatching = (): void => {
    if (stopped || watcher !== null) return;
    let created: VaultFolderWatcher;
    try {
      created = createWatcher(root, {
        depth: 1,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: stableMs, pollInterval: Math.min(250, stableMs) },
        ignored: (target: string) => ignoredInVault(root, target),
      });
    } catch (error) {
      log.warn("[vault] couldn't watch the copy's folder:", error);
      return;
    }
    watcher = created;
    // Un aviso tarde de un watcher ya soltado no cuenta.
    const forward = (filePath: string): void => {
      if (watcher === created) onFile(filePath);
    };
    created.on('add', forward);
    created.on('change', forward);
    created.on('unlink', forward);
    created.on('unlinkDir', (dirPath: string) => {
      if (stopped || watcher !== created || segmentsUnder(root, dirPath)?.length !== 0) return;
      // Se borro la carpeta vigilada y este watcher ya no sirve: se compara (sus filas se van) y se vuelve a mirar.
      watcher = null;
      void created.close().catch(() => undefined);
      requestCompare();
      startProbe();
    });
    // Lo que llego entre la carga del catalogo y este momento no lo avisa nadie.
    created.on('ready', () => {
      if (watcher === created) requestCompare();
    });
    created.on('error', (error: unknown) => log.warn('[vault] error watching the copy:', error));
  };

  /** Mira `sessions/` hasta que exista. Nunca su padre. */
  const startProbe = (): void => {
    if (stopped || probe !== null || watcher !== null) return;
    probe = timers.set(() => {
      probe = null;
      void isDirectory(root).then((exists) => {
        if (stopped || watcher !== null) return;
        if (exists) startWatching();
        else startProbe();
      });
    }, probeMs);
  };

  void isDirectory(root).then((exists) => {
    if (stopped) return;
    if (exists) startWatching();
    else startProbe();
  });

  return () => {
    stopped = true;
    if (batch !== null) timers.clear(batch);
    if (probe !== null) timers.clear(probe);
    batch = null;
    probe = null;
    pending.clear();
    const current = watcher;
    watcher = null;
    if (current !== null) void current.close().catch(() => undefined);
  };
}
