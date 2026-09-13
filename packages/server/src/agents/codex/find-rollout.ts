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
 */

import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  codexArchivedRoot,
  codexSessionsRoot,
  isUuid,
  localDayFolders,
  parseRolloutFileName,
  uuidV7Millis,
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

/**
 * Los rollouts de una carpeta, en orden de nombre. Solo los nombres que se
 * leen (`ROLLOUT_FILE_PATTERN`); lo demas se salta.
 */
export async function rolloutFilesIn(folder: string): Promise<string[]> {
  return (await entriesOf(folder))
    .filter((entry) => entry.isFile() && parseRolloutFileName(entry.name) !== null)
    .map((entry) => entry.name)
    .sort()
    .map((name) => path.join(folder, name));
}

/**
 * Todos los rollouts de `sessions/<AAAA>/<MM>/<DD>/`, en orden de carpeta y de
 * nombre. Una carpeta que no tiene esa forma se salta sin entrar.
 */
export async function walkSessionFiles(root: string, limit = Number.POSITIVE_INFINITY): Promise<string[]> {
  const files: string[] = [];
  for (const year of await numberedFolders(root, YEAR)) {
    for (const month of await numberedFolders(path.join(root, year), TWO_DIGITS)) {
      for (const day of await numberedFolders(path.join(root, year, month), TWO_DIGITS)) {
        for (const file of await rolloutFilesIn(path.join(root, year, month, day))) {
          files.push(file);
          if (files.length >= limit) return files;
        }
      }
    }
  }
  return files;
}

/** El primer rollout de la lista que es de esa sesion. */
function matching(files: readonly string[], sessionId: string): string | null {
  for (const file of files) {
    if (parseRolloutFileName(path.basename(file))?.sessionId === sessionId) return file;
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
export async function findRollout(sessionId: string, roots: FindRolloutRoots = {}): Promise<string | null> {
  const id = sessionId.toLowerCase();
  if (!isUuid(id)) return null;
  const sessionsRoot = roots.sessionsRoot !== undefined ? roots.sessionsRoot : codexSessionsRoot();
  const archivedRoot = roots.archivedRoot !== undefined ? roots.archivedRoot : codexArchivedRoot();

  const ms = uuidV7Millis(id);
  if (ms !== null && sessionsRoot !== null) {
    for (const folder of localDayFolders(sessionsRoot, ms - DAY_MS, ms + DAY_MS)) {
      const found = matching(await rolloutFilesIn(folder), id);
      if (found !== null) return found;
    }
  }

  if (archivedRoot !== null) {
    const found = matching(await rolloutFilesIn(archivedRoot), id);
    if (found !== null) return found;
  }

  if (ms === null && sessionsRoot !== null) {
    return matching(await walkSessionFiles(sessionsRoot, FULL_WALK_MAX_FILES), id);
  }
  return null;
}
