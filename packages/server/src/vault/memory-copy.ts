/**
 * La memoria de cada proyecto en la copia propia (hito 28, D13).
 *
 * Se copia `<cwd>/.agents/memory/*.md` —la carpeta de `MEMORY_DIR`, la misma que
 * instala el puente de memoria— a `<copia>/memory/<carpeta>-<hash8>/`, con un
 * `source.json` que dice de donde salio.
 *
 * **Se copia sin borrar.** Un archivo que desaparece del proyecto sigue en la
 * copia: una nota borrada por error se borraria tambien de la copia, que existe
 * justo para eso. Un archivo que ya esta con el mismo tamano y la misma fecha no
 * se vuelve a escribir.
 *
 * Lo que se lee, y nada mas (CLAUDE.md 2.1, y el `cwd` sale del indice, nunca
 * del cliente):
 *
 *  - Solo el primer nivel de la carpeta, solo archivos regulares con nombre de
 *    nota `.md` (`isNoteName`). Ni subcarpetas, ni enlaces, ni otros tipos.
 *  - **Todo pasa por `resolveInside`**, la carpeta y cada archivo: un `.agents`
 *    que es una junction hacia afuera, o una nota que es un enlace a otro lado,
 *    no se lee.
 *  - A lo sumo 1 MB por archivo (uno mas grande no se copia: una nota cortada a
 *    la mitad en la copia diria algo que el proyecto no dice) y 500 archivos por
 *    proyecto, en orden de nombre.
 */

import { mkdir, readdir, readFile, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { MEMORY_DIR } from '@agent-workbench/shared';
import { isNoteName } from '../memory-bridge.js';
import { InvalidPathError, resolveInside } from '../path-guard.js';
import { memoryDir } from './paths.js';
import { DEFAULT_WRITE_DEPS, ensureVaultMarker, writeFileAtomic, type VaultWriteDeps } from './write.js';

export const MEMORY_FILE_MAX_BYTES = 1024 * 1024;
export const MEMORY_MAX_FILES = 500;
/** Nombre del archivo que dice de que proyecto es cada carpeta de la memoria copiada. */
export const MEMORY_SOURCE_FILE = 'source.json';
/**
 * Diferencia de fecha que todavia se considera la misma. Un sistema de archivos
 * redondea: sin margen, una copia al dia se volveria a escribir en cada pasada.
 */
const SAME_MTIME_MS = 2;

export interface MemoryCopyResult {
  files: number;
  bytes: number;
}

interface MemoryNoteFile {
  name: string;
  absolute: string;
  size: number;
  mtimeMs: number;
}

/**
 * Las notas que se copiarian de un proyecto. [] si la carpeta no existe, no es
 * una carpeta o se sale del proyecto.
 */
async function listMemoryNotes(cwd: string): Promise<MemoryNoteFile[]> {
  let folder: string;
  try {
    folder = await resolveInside(cwd, MEMORY_DIR, { mustExist: true });
  } catch (error) {
    if (error instanceof InvalidPathError) return [];
    throw error;
  }

  let entries;
  try {
    entries = await readdir(folder, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries
    .filter((entry) => entry.isFile() && isNoteName(entry.name))
    .map((entry) => entry.name)
    .sort()
    .slice(0, MEMORY_MAX_FILES);

  const notes: MemoryNoteFile[] = [];
  for (const name of names) {
    let absolute: string;
    try {
      absolute = await resolveInside(cwd, `${MEMORY_DIR}/${name}`, { mustExist: true });
      const info = await stat(absolute);
      if (!info.isFile() || info.size > MEMORY_FILE_MAX_BYTES) continue;
      notes.push({ name, absolute, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Borrada mientras se listaba, o se sale del proyecto: no se copia.
    }
  }
  return notes;
}

/** Cuanto se copiaria de la memoria de un proyecto, sin escribir nada: la pasada en seco. */
export async function measureProjectMemory(cwd: string): Promise<MemoryCopyResult> {
  const notes = await listMemoryNotes(cwd);
  return { files: notes.length, bytes: notes.reduce((total, note) => total + note.size, 0) };
}

async function isUpToDate(target: string, note: MemoryNoteFile): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isFile() && info.size === note.size && Math.abs(info.mtimeMs - note.mtimeMs) < SAME_MTIME_MS;
  } catch {
    return false;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copia a `dir` las notas de la memoria de `cwd` que falten o hayan cambiado.
 * Devuelve las que escribio. Un proyecto sin memoria no crea nada.
 *
 * La copia conserva la fecha del original: es lo que la pasada siguiente
 * compara para saber que esta al dia sin leer el contenido.
 */
export async function copyProjectMemory(
  dir: string,
  cwd: string,
  platform: string,
  deps: VaultWriteDeps = DEFAULT_WRITE_DEPS,
): Promise<MemoryCopyResult> {
  const notes = await listMemoryNotes(cwd);
  if (notes.length === 0) return { files: 0, bytes: 0 };

  const target = memoryDir(dir, cwd, platform);
  const result: MemoryCopyResult = { files: 0, bytes: 0 };
  let prepared = false;
  const prepare = async (): Promise<void> => {
    if (prepared) return;
    prepared = true;
    await ensureVaultMarker(dir, deps);
    await mkdir(target, { recursive: true });
  };

  for (const note of notes) {
    const destination = path.join(target, note.name);
    if (await isUpToDate(destination, note)) continue;
    let content: Buffer;
    try {
      content = await readFile(note.absolute);
    } catch {
      continue;
    }
    // Crecio entre el `stat` y la lectura. Si cambio sin crecer, se copia lo leido con
    // la fecha vieja, y la pasada siguiente ve que la del original es otra y lo repasa.
    if (content.length > MEMORY_FILE_MAX_BYTES) continue;
    await prepare();
    await writeFileAtomic(destination, content, deps);
    const mtime = new Date(note.mtimeMs);
    await utimes(destination, mtime, mtime);
    result.files += 1;
    result.bytes += content.length;
  }

  const source = path.join(target, MEMORY_SOURCE_FILE);
  if (result.files > 0 || !(await exists(source))) {
    await prepare();
    await writeFileAtomic(source, `${JSON.stringify({ cwd, copiedAt: deps.now() })}\n`, deps);
  }
  return result;
}
