/**
 * El historial de Codex: `sessions/AAAA/MM/DD/rollout-*.jsonl` y
 * `archived_sessions/rollout-*.jsonl`, dentro de `CODEX_HOME`.
 *
 * Solo lectura, y solo esas dos carpetas: `CODEX_HOME` no se lista nunca (ahi
 * viven las credenciales y las bases de estado de Codex).
 *
 * Un archivo por sesion, con el id en el nombre: el `group` de cada item es la
 * propia sesion. La carpeta de dia no sirve para agrupar —no dice nada del
 * proyecto— y el `cwd` lo trae siempre la linea 0.
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
import { findRollout, rolloutFilesIn, walkSessionFiles } from './find-rollout.js';
import { codexArchivedRoot, codexSessionsRoot, parseRolloutFileName, ROLLOUT_FILE_PATTERN } from './paths.js';
import { scanRollout } from './rollout-scan.js';
import { CodexSessionFollower } from './session-follower.js';

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

const accepts = (filePath: string): boolean => ROLLOUT_FILE_PATTERN.test(path.basename(filePath));

/** Ver `followPollMs` abajo. */
export const CODEX_FOLLOW_POLL_MS = 1_000;

/** true si `filePath` cae dentro de `root`, sin salir por `..`. */
function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toItem(ref: string, info: { mtimeMs: number; size: number }): HistoryItem | null {
  const name = parseRolloutFileName(path.basename(ref));
  if (name === null) return null;
  return { ref, sessionId: name.sessionId, group: name.sessionId, mtimeMs: info.mtimeMs, sizeBytes: info.size };
}

async function itemOf(ref: string): Promise<HistoryItem | null> {
  try {
    return toItem(ref, await stat(ref));
  } catch {
    return null;
  }
}

export function createCodexHistory(): HistorySource {
  return {
    /*
      Las dos raices siempre, existan o no. `sessions/` no existe hasta el
      primer mensaje de la primera sesion, que es justo el primer uso de
      cualquiera: dejarla fuera congelaria esa pestana hasta reiniciar. Que
      hacer con una raiz que todavia no esta es del watcher, que la espera sin
      vigilar a su padre.
    */
    roots(): readonly HistoryRoot[] {
      const sessionsRoot = codexSessionsRoot();
      const archivedRoot = codexArchivedRoot();
      if (sessionsRoot === null || archivedRoot === null) return [];
      const awaitWriteFinish = { stabilityThreshold: 300, pollInterval: 100 };
      return [
        { path: sessionsRoot, depth: 3, accepts, awaitWriteFinish },
        { path: archivedRoot, depth: 0, accepts, awaitWriteFinish },
      ];
    },

    async list(): Promise<HistoryItem[] | null> {
      const sessionsRoot = codexSessionsRoot();
      const archivedRoot = codexArchivedRoot();
      if (sessionsRoot === null || archivedRoot === null) return null;
      const hasSessions = await pathExists(sessionsRoot);
      const hasArchived = await pathExists(archivedRoot);
      if (!hasSessions && !hasArchived) return null;

      const refs = [
        ...(hasSessions ? await walkSessionFiles(sessionsRoot) : []),
        ...(hasArchived ? await rolloutFilesIn(archivedRoot) : []),
      ];
      const items: HistoryItem[] = [];
      for (const ref of refs) {
        // Borrado entre el listado y el stat, o ilegible: se salta.
        const item = await itemOf(ref);
        if (item !== null) items.push(item);
      }
      return items;
    },

    async changedRefs(filePath: string): Promise<readonly string[] | null> {
      if (!accepts(filePath)) return null;
      const roots = [codexSessionsRoot(), codexArchivedRoot()];
      return roots.some((root) => root !== null && isInside(root, filePath)) ? [filePath] : null;
    },

    item: (ref) => itemOf(ref),

    scan: (item): Promise<ScannedSession | null> => scanRollout(item),

    // Codex no aprende nada de la instalacion al leer un rollout.
    restored: () => undefined,

    /**
     * true si esa sesion tiene rollout. El `cwd` no importa: la carpeta de
     * Codex es por dia, no por proyecto.
     */
    exists: async (_cwd, sessionId) => (await findRollout(sessionId)) !== null,

    follow(target: { cwd: string; sessionId: string }, options?: FollowOptions): SessionFollower {
      return new CodexSessionFollower(target.cwd, target.sessionId, {
        limits: options?.limits,
        maxEvents: options?.maxEvents,
      });
    },

    // `follow` respeta `FollowOptions`: la copia propia puede leer de aca (hito 28).
    wholeRead: true,

    plans: null,

    /*
      Codex escribe el rollout con el archivo abierto todo el turno, y en
      Windows el watcher no ve lo que le agrega: la conversacion se quedaba en
      el primer mensaje (verificacion de cierre del hito 25). Un segundo es la
      latencia con la que llega cada linea; releer es un `stat` y los bytes
      nuevos. En macOS y Linux los avisos si llegan, y esto no estorba.
    */
    followPollMs: CODEX_FOLLOW_POLL_MS,
  };
}
