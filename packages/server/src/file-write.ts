/**
 * Guardar un archivo editado en el visor de Archivos (Hito 46, §6.36).
 *
 * Es la segunda escritura de la app dentro de un proyecto, despues de la
 * memoria compartida (CLAUDE.md 2.1 y 2.4), y esta acotada igual que ella:
 *
 *  - **Solo reemplaza el contenido de un archivo que ya existe**, dentro del
 *    `cwd` de la pestana (`resolveInside`, enlaces incluidos) y fuera de la
 *    carpeta de toda CLI. No crea, no renombra, no borra.
 *  - **La huella decide**: se guarda solo si el disco todavia tiene lo que se
 *    abrio (`FilePreview.hash`). Si el agente u otro programa lo cambio, no se
 *    escribe nada y se devuelve lo que hay ahora. Tampoco se guarda una copia
 *    al lado: la de un `.env` terminaria en un commit con las claves adentro.
 *  - **Los saltos de linea son los del archivo**: el cuadro de texto del
 *    navegador los manda como `\n`, y un `.env` de Windows guardado tal cual
 *    saldria entero como cambiado en git.
 *  - **Escritura atomica** (`atomic-write.ts`): a un temporal y `rename`, con
 *    los permisos del original fuera de Windows. Se escribe la ruta real: un
 *    enlace del proyecto sigue siendo un enlace despues de guardar.
 */

import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { ServerTextError, serverText, type FilePreview, type FileSaveOutcome } from '@agent-workbench/shared';
import { writeAtomically } from './atomic-write.js';
import type { CliFolders } from './cli-folders.js';
import { MAX_PREVIEW_BYTES, contentHash, isEditableText, readPreview } from './file-browser.js';
import { InvalidPathError, resolveInside } from './path-guard.js';

/** Un guardado que no se hizo. El archivo quedo como estaba; el texto va como clave (§6.23). */
export class FileWriteError extends ServerTextError {}

export interface SaveResult {
  outcome: FileSaveOutcome;
  /** El archivo como quedo, o como esta ahora si cambio; null si ya no esta. */
  preview: FilePreview | null;
}

/**
 * El texto con los saltos de linea del original: los que mas aparecen en el,
 * y `\n` si empata o no tiene. Lo que llegue con `\r\n` cuenta como `\n`.
 */
export function withLineEndings(text: string, original: string): string {
  const crlf = original.match(/\r\n/g)?.length ?? 0;
  const lf = original.match(/(?<!\r)\n/g)?.length ?? 0;
  const plain = text.replace(/\r\n/g, '\n');
  return crlf > lf ? plain.replace(/\n/g, '\r\n') : plain;
}

function isMissing(error: unknown): boolean {
  return error instanceof InvalidPathError && error.text.key === 'pathMissing';
}

function errorCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

export async function saveProjectFile(
  cwd: string,
  relativePath: string,
  text: string,
  baseHash: string,
  folders: CliFolders,
): Promise<SaveResult> {
  let absolute: string;
  try {
    absolute = await resolveInside(cwd, relativePath, { mustExist: true });
  } catch (error) {
    // Lo borro o lo movio el agente: es un cambio en el disco, no un error.
    if (isMissing(error)) return { outcome: 'changed', preview: null };
    throw error;
  }
  if (await folders.contains(absolute)) throw new InvalidPathError(serverText('cliFolderClosed'));

  const target = await realpath(absolute);
  const info = await stat(target);
  if (!info.isFile()) throw new FileWriteError(serverText('fileSaveFailed'));

  const current = await readFile(target);
  if (contentHash(current) !== baseHash) {
    return { outcome: 'changed', preview: await readPreview(cwd, relativePath, folders).catch(() => null) };
  }
  // Lo que el visor no ofrece editar tampoco se guarda, aunque llegue con su huella.
  if (current.length > MAX_PREVIEW_BYTES || !isEditableText(current, current.toString('utf8'))) {
    throw new FileWriteError(serverText('fileSaveFailed'));
  }
  /*
    Uno de solo lectura no se reemplaza. En Windows el `rename` ya falla; fuera
    de el, `rename` reemplaza igual (manda la carpeta, no el archivo), y un
    archivo marcado de solo lectura es una decision de alguien.
  */
  try {
    await access(target, constants.W_OK);
  } catch {
    throw new FileWriteError(serverText('fileSaveBlocked'));
  }

  const content = Buffer.from(withLineEndings(text, current.toString('utf8')), 'utf8');
  if (content.length > MAX_PREVIEW_BYTES) {
    throw new FileWriteError(serverText('fileSaveTooLarge', { max: `${MAX_PREVIEW_BYTES / 1024} KB` }));
  }

  try {
    await writeAtomically(target, content, { mode: info.mode });
  } catch (error) {
    // De solo lectura, o abierto por otro programa que no deja reemplazarlo.
    const code = errorCode(error);
    if (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') throw new FileWriteError(serverText('fileSaveBlocked'));
    throw error;
  }
  return { outcome: 'saved', preview: await readPreview(cwd, relativePath, folders) };
}
