/**
 * Mudar la copia propia a otra carpeta (hito 28, D12 y C11).
 *
 * **Mudar es copiar sin pisar y cambiar la configuracion.** La carpeta vieja
 * queda intacta —el dialogo dice donde—, y si la nueva ya es una copia
 * (`vault.json`), se adopta y se completa con lo que le falte. Ningun `rm`:
 * borrar la vieja es destructivo y nadie lo pidio, y un `rename` falla entre
 * unidades (`EXDEV`), que es justo el caso de `%APPDATA%` a `D:\` o a una
 * carpeta sincronizada.
 *
 * No se usa `fs.cp` (C11): no cuenta lo copiado ni lo saltado, y falla con
 * `ERR_FS_CP_EINVAL` si el destino esta dentro del origen. El recorrido es
 * propio: `copyFile` con `COPYFILE_EXCL` —un archivo que ya esta en el destino
 * no se toca, sea igual o distinto— y `mkdir` recursivo.
 *
 * Se mudan `vault.json`, `sessions/` y `memory/`. `export/` no: son archivos
 * derivados que se vuelven a generar desde la copia.
 */

import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeCwdKey, serverText, type ServerText } from '@agent-workbench/shared';
import { isInsideProtected } from '../directory-picker.js';
import { isAbsoluteDir } from '../settings-store.js';
import { temporaryPathFor } from './write.js';

/** Lo que se muda, en este orden. */
export const MOVED_ENTRIES = ['vault.json', 'sessions', 'memory'] as const;

/** Un temporal de la copia (`temporaryPathFor`): quedo de una escritura a medias y no se muda. */
const OWN_TEMP_FILE = /\.\d+\.[0-9a-f]{12}\.tmp$/;

export interface MoveResult {
  /** Archivos copiados al destino. */
  copied: number;
  /** Archivos que ya estaban en el destino y no se tocaron. */
  skipped: number;
}

async function copyTree(source: string, target: string, result: MoveResult): Promise<void> {
  let info;
  try {
    info = await lstat(source);
  } catch {
    // No esta en el origen (una copia sin memoria): no hay nada que mudar.
    return;
  }

  // Ni enlaces ni nada que no sea archivo o carpeta: la copia no los escribe,
  // y seguir un enlace copiaria lo que hay del otro lado.
  if (info.isDirectory()) {
    await mkdir(target, { recursive: true });
    for (const name of await readdir(source)) {
      await copyTree(path.join(source, name), path.join(target, name), result);
    }
    return;
  }
  if (!info.isFile() || OWN_TEMP_FILE.test(source)) return;

  await mkdir(path.dirname(target), { recursive: true });
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      result.skipped += 1;
      return;
    }
    throw error;
  }
  // La fecha del original: la memoria copiada se compara por tamano y fecha, y
  // sin esto la pasada siguiente reescribiria cada nota en la carpeta nueva.
  await utimes(target, info.atime, info.mtime).catch(() => undefined);
  result.copied += 1;
}

/**
 * Copia la copia de `from` a `to` sin pisar nada ni borrar el origen. Lanza si
 * una lectura o una escritura falla; lo copiado hasta ahi queda en el destino.
 */
export async function moveVault(from: string, to: string): Promise<MoveResult> {
  const result: MoveResult = { copied: 0, skipped: 0 };
  await mkdir(to, { recursive: true });
  for (const entry of MOVED_ENTRIES) {
    await copyTree(path.join(from, entry), path.join(to, entry), result);
  }
  return result;
}

/** true si `child` es `parent` o esta adentro, comparando con la forma de `normalizeCwdKey`. */
export function isSameOrInside(child: string, parent: string, platform: string): boolean {
  const childKey = normalizeCwdKey(child, platform);
  const parentKey = normalizeCwdKey(parent, platform);
  if (childKey.length === 0 || parentKey.length === 0) return false;
  if (childKey === parentKey) return true;
  const separator = platform === 'win32' ? '\\' : '/';
  return childKey.startsWith(parentKey.endsWith(separator) ? parentKey : `${parentKey}${separator}`);
}

export type VaultTargetCheck =
  | { kind: 'ok' }
  /** Es la carpeta actual: no hay nada que hacer. */
  | { kind: 'same' }
  | { kind: 'refused'; text: ServerText };

export interface VaultTargetOptions {
  /** Las carpetas de las CLIs (`agents.protectedDirs()`) y las demas que no se tocan. */
  protectedDirs: readonly string[];
  platform: string;
}

/**
 * Si la copia se puede mudar de `current` a `target`. Pura: la prueba el
 * chequeo.
 *
 * Se rechaza una carpeta que no es absoluta, una carpeta protegida o algo
 * adentro (regla 2.1: la copia no escribe en la carpeta de ninguna CLI), el
 * destino dentro del origen —la mudanza se copiaria dentro de si misma— y el
 * origen dentro del destino —la copia vieja quedaria adentro de la nueva, que
 * la volveria a leer como si fuera suya— (C11).
 */
export function checkVaultTarget(current: string, target: string, options: VaultTargetOptions): VaultTargetCheck {
  if (!isAbsoluteDir(target, options.platform)) {
    return { kind: 'refused', text: serverText('vaultTargetNotAbsolute') };
  }
  const isProtected =
    isInsideProtected(target, options.protectedDirs) ||
    options.protectedDirs.some((dir) => isSameOrInside(target, dir, options.platform));
  if (isProtected) {
    return { kind: 'refused', text: serverText('vaultTargetCliFolder') };
  }
  if (normalizeCwdKey(current, options.platform) === normalizeCwdKey(target, options.platform)) {
    return { kind: 'same' };
  }
  if (isSameOrInside(target, current, options.platform)) {
    return { kind: 'refused', text: serverText('vaultTargetInsideCurrent') };
  }
  if (isSameOrInside(current, target, options.platform)) {
    return { kind: 'refused', text: serverText('vaultCurrentInsideTarget') };
  }
  return { kind: 'ok' };
}

/**
 * true si en `dir` se puede crear la carpeta y escribir un temporal. El
 * temporal tiene la forma de `temporaryPathFor` y se borra enseguida; si
 * quedara, la pasada lo barre.
 */
export async function canWriteInto(dir: string): Promise<boolean> {
  const probe = temporaryPathFor(path.join(dir, '.escritura'));
  try {
    await mkdir(dir, { recursive: true });
    if (!(await stat(dir)).isDirectory()) return false;
    await writeFile(probe, '');
    return true;
  } catch {
    return false;
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}
