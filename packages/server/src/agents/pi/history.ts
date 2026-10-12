/**
 * El historial de Pi: `sessions/--<carpeta>--/<fecha>_<id>.jsonl`, dentro de su
 * carpeta (CLAUDE.md 16.2).
 *
 * Solo lectura, y solo esa carpeta: la de Pi no se lista nunca entera (ahi vive
 * `auth.json`). Un archivo por sesion, con el id en el nombre; la carpeta de
 * proyecto sirve de agrupador de respaldo, pero el `cwd` real sale siempre de
 * la primera linea, porque el nombre de la carpeta pierde informacion.
 *
 * Con `PI_CODING_AGENT_SESSION_DIR` las sesiones van sueltas en esa carpeta, sin
 * subcarpetas (segun el codigo de Pi): la raiz se vigila sin profundidad.
 */

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  FollowOptions,
  HistoryItem,
  HistoryRoot,
  HistorySource,
  ScannedSession,
  SessionFollower,
} from '../adapter.js';
import type { PiModelCatalog } from './catalog.js';
import {
  findSessionFile,
  isInside,
  isProjectFolderName,
  listSessionFiles,
  parseSessionFileName,
  piSessionsLayout,
} from './paths.js';
import { PiSessionFollower } from './session-follower.js';
import { scanPiSession } from './session-scan.js';

/** Ver `followPollMs` abajo. */
export const PI_FOLLOW_POLL_MS = 1_000;

const accepts = (filePath: string): boolean => parseSessionFileName(path.basename(filePath)) !== null;

function toItem(ref: string, info: { mtimeMs: number; size: number }): HistoryItem | null {
  const name = parseSessionFileName(path.basename(ref));
  if (name === null) return null;
  return {
    ref,
    sessionId: name.sessionId,
    // La carpeta de proyecto: respaldo del `cwd` si la primera linea no lo trajera.
    group: path.basename(path.dirname(ref)),
    mtimeMs: info.mtimeMs,
    sizeBytes: info.size,
  };
}

async function itemOf(ref: string): Promise<HistoryItem | null> {
  try {
    const info = await stat(ref);
    return info.isFile() ? toItem(ref, info) : null;
  } catch {
    return null;
  }
}

/**
 * El filtro del recorrido del watcher: dentro de `sessions/` solo se entra a
 * las carpetas de proyecto, y de ellas solo se miran los `.jsonl`. La ruta llega
 * con `/` tambien en Windows, y a veces sin saber si es carpeta: se decide por
 * la forma.
 */
export function ignoresPath(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath).split(path.sep).join('/');
  if (relative.length === 0) return false;
  if (relative.startsWith('..')) return true;
  const parts = relative.split('/');
  const [folder, file] = parts;
  if (folder === undefined || !isProjectFolderName(folder)) return true;
  if (parts.length === 1) return false;
  return parts.length > 2 || file === undefined || parseSessionFileName(file) === null;
}

export function createPiHistory(catalog: PiModelCatalog): HistorySource {
  return {
    /*
      La raiz siempre, exista o no: `sessions/` no existe hasta que Pi se abre
      por primera vez. Que hacer con una raiz que todavia no esta es del
      watcher, que la espera sin vigilar a su padre.
    */
    roots(): readonly HistoryRoot[] {
      const layout = piSessionsLayout();
      if (layout === null) return [];
      const awaitWriteFinish = { stabilityThreshold: 300, pollInterval: 100 };
      if (layout.flat) return [{ path: layout.root, depth: 0, accepts, awaitWriteFinish }];
      const root = layout.root;
      return [{ path: root, depth: 1, accepts, ignore: (filePath) => ignoresPath(root, filePath), awaitWriteFinish }];
    },

    async list(): Promise<HistoryItem[] | null> {
      const layout = piSessionsLayout();
      if (layout === null) return null;
      try {
        if (!(await stat(layout.root)).isDirectory()) return null;
      } catch {
        return null;
      }
      const items: HistoryItem[] = [];
      for (const ref of await listSessionFiles(layout)) {
        // Borrado entre el listado y el stat, o ilegible: se salta.
        const item = await itemOf(ref);
        if (item !== null) items.push(item);
      }
      return items;
    },

    async changedRefs(filePath: string): Promise<readonly string[] | null> {
      if (!accepts(filePath)) return null;
      const layout = piSessionsLayout();
      return layout !== null && isInside(layout.root, filePath) ? [filePath] : null;
    },

    item: (ref) => itemOf(ref),

    scan: (item): Promise<ScannedSession | null> => scanPiSession(item),

    // Pi no aprende nada de la instalacion al leer una sesion.
    restored: () => undefined,

    /** true si esa sesion tiene archivo: Pi lo crea con el primer mensaje. */
    exists: async (cwd, sessionId) => (await findSessionFile(sessionId, cwd)) !== null,

    follow(target: { cwd: string; sessionId: string }, options?: FollowOptions): SessionFollower {
      return new PiSessionFollower(target.cwd, target.sessionId, {
        catalog,
        limits: options?.limits,
        maxEvents: options?.maxEvents,
      });
    },

    // `follow` respeta `FollowOptions`: el respaldo puede leer de aca.
    wholeRead: true,

    plans: null,

    /*
      Pi escribe cada entrada cuando termina su mensaje. Releer cada segundo es
      un `stat` y los bytes nuevos, y no depende de que el watcher vea lo que se
      agrega a un archivo que otro proceso tiene abierto (lo que obligo a lo
      mismo con Codex).
    */
    followPollMs: PI_FOLLOW_POLL_MS,
  };
}
