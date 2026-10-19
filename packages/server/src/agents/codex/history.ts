/**
 * El historial de Codex: `sessions/AAAA/MM/DD/rollout-*.jsonl` y
 * `archived_sessions/rollout-*.jsonl`, dentro de `CODEX_HOME`, y desde la
 * 0.162 su forma comprimida, `rollout-*.jsonl.zst` (§10.12).
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
import type { PlanLimitWindow } from '@agent-workbench/shared';
import type {
  FollowOptions,
  HistoryItem,
  HistoryRoot,
  HistorySource,
  ScannedSession,
  SessionFollower,
} from '../adapter.js';
import { compressedRolloutPathOf, isCompressedRollout, plainRolloutPathOf } from './compressed-rollout.js';
import {
  compressedRolloutFilesIn,
  findReadableRollout,
  rolloutFilesIn,
  walkCompressedSessionFiles,
  walkSessionFiles,
} from './find-rollout.js';
import { codexArchivedRoot, codexSessionsRoot, parseCompressedRolloutFileName, parseRolloutFileName } from './paths.js';
import type { PlanLimitsBook } from '../plan-limits.js';
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

/** Lo que dice el nombre de un rollout, comprimido o no. */
function rolloutNameOf(filePath: string) {
  const name = path.basename(filePath);
  return parseRolloutFileName(name) ?? parseCompressedRolloutFileName(name);
}

const accepts = (filePath: string): boolean => rolloutNameOf(filePath) !== null;

/** Ver `followPollMs` abajo. */
export const CODEX_FOLLOW_POLL_MS = 1_000;

/** true si `filePath` cae dentro de `root`, sin salir por `..`. */
function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function toItem(ref: string, info: { mtimeMs: number; size: number }): HistoryItem | null {
  const name = rolloutNameOf(ref);
  if (name === null) return null;
  return { ref, sessionId: name.sessionId, group: name.sessionId, mtimeMs: info.mtimeMs, sizeBytes: info.size };
}

/**
 * El item de un rollout, o null si ya no esta. Un comprimido con su `.jsonl` al
 * lado no es un item: es la misma sesion, y la que se sigue escribiendo es la
 * otra. Sin esto la barra la mostraria dos veces.
 */
async function itemOf(ref: string): Promise<HistoryItem | null> {
  if (isCompressedRollout(ref) && (await pathExists(plainRolloutPathOf(ref)))) return null;
  try {
    return toItem(ref, await stat(ref));
  } catch {
    return null;
  }
}

/** Los comprimidos de la lista sin los que tienen su `.jsonl` en `plain`. */
function withoutPlainTwin(compressed: readonly string[], plain: readonly string[]): string[] {
  const plainSet = new Set(plain);
  return compressed.filter((ref) => !plainSet.has(plainRolloutPathOf(ref)));
}

export interface CodexHistoryOptions {
  /**
   * Donde se juntan los limites del plan que traen los `token_count` (hito 47,
   * §10.14). Todo seguidor cuenta lo que lee: entre dos sesiones gana lo visto
   * mas tarde, asi que leer un rollout viejo no pisa nada.
   */
  planLimits?: PlanLimitsBook;
}

export function createCodexHistory(options: CodexHistoryOptions = {}): HistorySource {
  const book = options.planLimits;
  const onPlanLimits = book === undefined ? undefined : (windows: PlanLimitWindow[]) => book.observe(windows);
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

      const plain = [
        ...(hasSessions ? await walkSessionFiles(sessionsRoot) : []),
        ...(hasArchived ? await rolloutFilesIn(archivedRoot) : []),
      ];
      const compressed = [
        ...(hasSessions ? await walkCompressedSessionFiles(sessionsRoot) : []),
        ...(hasArchived ? await compressedRolloutFilesIn(archivedRoot) : []),
      ];
      const refs = [...plain, ...withoutPlainTwin(compressed, plain)];
      const items: HistoryItem[] = [];
      for (const ref of refs) {
        // Borrado entre el listado y el stat, o ilegible: se salta.
        const item = await itemOf(ref);
        if (item !== null) items.push(item);
      }
      return items;
    },

    /*
      Las dos formas de la sesion, siempre juntas: cuando `codex resume`
      reemplaza el comprimido por el `.jsonl`, o la app de escritorio comprime
      uno, cual de las dos se lista depende de la otra (`itemOf`).
    */
    async changedRefs(filePath: string): Promise<readonly string[] | null> {
      if (!accepts(filePath)) return null;
      const roots = [codexSessionsRoot(), codexArchivedRoot()];
      if (!roots.some((root) => root !== null && isInside(root, filePath))) return null;
      const plain = isCompressedRollout(filePath) ? plainRolloutPathOf(filePath) : filePath;
      return [plain, compressedRolloutPathOf(plain)];
    },

    item: (ref) => itemOf(ref),

    scan: (item): Promise<ScannedSession | null> => scanRollout(item),

    // Codex no aprende nada de la instalacion al leer un rollout.
    restored: () => undefined,

    /**
     * true si esa sesion tiene rollout. El `cwd` no importa: la carpeta de
     * Codex es por dia, no por proyecto.
     *
     * Un rollout comprimido tambien cuenta: `codex resume` lo reemplaza por el
     * `.jsonl` y sigue escribiendo ahi (§10.12). Sin eso, despertar la pestana
     * de una sesion comprimida abria una sesion nueva.
     */
    exists: async (_cwd, sessionId) => (await findReadableRollout(sessionId)) !== null,

    follow(target: { cwd: string; sessionId: string }, options?: FollowOptions): SessionFollower {
      return new CodexSessionFollower(target.cwd, target.sessionId, {
        limits: options?.limits,
        maxEvents: options?.maxEvents,
        onPlanLimits,
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
