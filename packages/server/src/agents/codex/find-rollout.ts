/**
 * Donde esta el rollout de una sesion de Codex, conociendo solo su id.
 *
 * El nombre del archivo lleva el id, pero la carpeta es el dia **local** en que
 * se creo el hilo, y eso no se deduce del id salvo que sea un uuid v7: sus
 * primeros 48 bits son la hora de creacion. Con eso se miran tres carpetas en
 * vez de recorrer el historial entero.
 *
 * Solo `readdir` y `stat` de `sessions/` y `archived_sessions/`: ningun archivo
 * se abre aca.
 *
 * Desde la 0.162 hay ademas rollouts comprimidos (`.jsonl.zst`, §10.12), que
 * se buscan aparte: un `.jsonl` de la misma sesion gana siempre, porque es el
 * que `codex resume` escribe al descomprimirla.
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  codexArchivedRoot,
  codexSessionsRoot,
  isUuid,
  localDayFolders,
  parseCompressedRolloutFileName,
  parseRolloutFileName,
  uuidV7Millis,
  type RolloutFileName,
} from './paths.js';

const DAY_MS = 86_400_000;

/** Tope del recorrido completo, para un id que no es v7. */
export const FULL_WALK_MAX_FILES = 5_000;

const YEAR = /^\d{4}$/;
const TWO_DIGITS = /^\d{2}$/;

async function entriesOf(folder: string): Promise<Dirent[]> {
  try {
    return await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Subcarpetas con nombre de ese formato, en orden de nombre. */
async function numberedFolders(folder: string, pattern: RegExp): Promise<string[]> {
  return (await entriesOf(folder))
    .filter((entry) => entry.isDirectory() && pattern.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** Que nombres cuentan: los que se leen, o los comprimidos. */
type NameParser = (name: string) => RolloutFileName | null;

async function filesIn(folder: string, parse: NameParser): Promise<string[]> {
  return (await entriesOf(folder))
    .filter((entry) => entry.isFile() && parse(entry.name) !== null)
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(folder, name));
}

/**
 * Los rollouts de una carpeta, en orden de nombre. Solo los nombres que se
 * leen (`ROLLOUT_FILE_PATTERN`); lo demas se salta.
 */
export function rolloutFilesIn(folder: string): Promise<string[]> {
  return filesIn(folder, parseRolloutFileName);
}

async function walk(root: string, limit: number, parse: NameParser): Promise<string[]> {
  const files: string[] = [];
  for (const year of await numberedFolders(root, YEAR)) {
    for (const month of await numberedFolders(path.join(root, year), TWO_DIGITS)) {
      for (const day of await numberedFolders(path.join(root, year, month), TWO_DIGITS)) {
        for (const file of await filesIn(path.join(root, year, month, day), parse)) {
          files.push(file);
          if (files.length >= limit) return files;
        }
      }
    }
  }
  return files;
}

/**
 * Todos los rollouts de `sessions/<AAAA>/<MM>/<DD>/`, en orden de carpeta y de
 * nombre. Una carpeta que no tiene esa forma se salta sin entrar.
 */
export function walkSessionFiles(root: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
  return walk(root, limit, parseRolloutFileName);
}

/** Los rollouts comprimidos de una carpeta, como `rolloutFilesIn`. */
export function compressedRolloutFilesIn(folder: string): Promise<string[]> {
  return filesIn(folder, parseCompressedRolloutFileName);
}

/** Los rollouts comprimidos de `sessions/`, como `walkSessionFiles`. */
export function walkCompressedSessionFiles(root: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
  return walk(root, limit, parseCompressedRolloutFileName);
}

/** El primer rollout de la lista que es de esa sesion. */
function matching(files: readonly string[], sessionId: string, parse: NameParser): string | null {
  for (const file of files) {
    if (parse(path.basename(file))?.sessionId === sessionId) return file;
  }
  return null;
}

export interface FindRolloutRoots {
  sessionsRoot?: string | null;
  archivedRoot?: string | null;
}

/**
 * La ruta del rollout de `sessionId`, o null.
 *
 * 1. Un v7: la carpeta de su dia local y las de al lado (la hora del uuid queda
 *    hasta un segundo antes de la del hilo, y un reloj o una zona horaria
 *    distintos pueden correr el dia).
 * 2. `archived_sessions/`, que es una sola carpeta.
 * 3. Un id que no es v7: el recorrido completo, con tope.
 */
export function findRollout(sessionId: string, roots: FindRolloutRoots = {}): Promise<string | null> {
  return find(sessionId, roots, parseRolloutFileName);
}

/**
 * La ruta del rollout **comprimido** de `sessionId`, o null. Se busca igual que
 * `findRollout`.
 *
 * Una sesion que la app de escritorio de Codex comprimio se puede reanudar
 * (`codex resume` la descomprime): sin contarla, despertar su pestana abria
 * una sesion **nueva** y la pestana perdia la suya (§10.12).
 */
export function findCompressedRollout(sessionId: string, roots: FindRolloutRoots = {}): Promise<string | null> {
  return find(sessionId, roots, parseCompressedRolloutFileName);
}

/** El rollout que se lee de `sessionId`: el `.jsonl` si esta, si no el comprimido, o null. */
export async function findReadableRollout(sessionId: string, roots: FindRolloutRoots = {}): Promise<string | null> {
  return (await findRollout(sessionId, roots)) ?? (await findCompressedRollout(sessionId, roots));
}

async function find(sessionId: string, roots: FindRolloutRoots, parse: NameParser): Promise<string | null> {
  const id = sessionId.toLowerCase();
  if (!isUuid(id)) return null;
  const sessionsRoot = roots.sessionsRoot !== undefined ? roots.sessionsRoot : codexSessionsRoot();
  const archivedRoot = roots.archivedRoot !== undefined ? roots.archivedRoot : codexArchivedRoot();

  const ms = uuidV7Millis(id);
  if (ms !== null && sessionsRoot !== null) {
    for (const folder of localDayFolders(sessionsRoot, ms - DAY_MS, ms + DAY_MS)) {
      const found = matching(await filesIn(folder, parse), id, parse);
      if (found !== null) return found;
    }
  }

  if (archivedRoot !== null) {
    const found = matching(await filesIn(archivedRoot, parse), id, parse);
    if (found !== null) return found;
  }

  if (ms === null && sessionsRoot !== null) {
    return matching(await walk(sessionsRoot, FULL_WALK_MAX_FILES, parse), id, parse);
  }
  return null;
}
