/**
 * Los archivos nuevos que git no sigue en una rama aparte, y perderlos al
 * quitarla (23-10-2026, §6.38).
 *
 * `git worktree remove` se niega con uno así, y está bien: puede ser trabajo
 * que el agente no agregó. Pero también es lo que deja un agente al probar
 * (capturas, scripts, dos APK de 43 MB), y el pedido de commitearlo terminaba
 * en "eso no va al repo", sin salida: la app no dejaba quitar la rama, y
 * descartar quedaba para la terminal. Ahora el diálogo ofrece perderlos, con
 * cuáles son, cuántos archivos tienen y cuánto pesan, y sólo cuando todo lo
 * que no está commiteado es nuevo: un archivo versionado que cambió sigue
 * frenando, porque eso sí es trabajo.
 *
 * Se borra lo que se mostró. El plan lleva la huella de cada archivo (ruta,
 * tamaño y fecha), quitar la manda de vuelta, y el servidor la compara al
 * confirmar y otra vez justo antes de borrar, con las pestañas de la rama ya
 * cerradas: si cambió algo, no se borra nada. Nunca se sigue un enlace: el de
 * una entrada se borra él, sin su destino (medido: git lista una junction como
 * carpeta nueva, y `fs.rm` la quita sin entrar), y una entrada cuya carpeta
 * sale de la rama no se ofrece. Es `fs.rm` y no `git clean`: la app no suma
 * comandos de git que escriben (§6.1).
 *
 * Y no se ofrece (`blocked`, la revisión del 23-10-2026), aunque todo sea nuevo:
 *
 *  - con un repositorio de git adentro: puede tener commits que no están en
 *    ningún otro lado (git lo lista como una carpeta nueva más, y `git clean`
 *    tampoco lo borra sin `-ff`);
 *  - con más de `WORKTREE_UNTRACKED_MAX_FILES` archivos: pasado el tope, la
 *    huella ya no cubre lo que cambia, ni se sabe si hay un repositorio;
 *  - con algo que la app copió de la carpeta principal y la rama no ignora
 *    (lo decide el servicio): no vuelve como una nota, y se perdería callado.
 */

import { createHash, type Hash } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { WORKTREE_UNTRACKED_MAX_FILES, type WorktreeUntrackedBlock } from '@agent-workbench/shared';
import { resolveInside } from '../path-guard.js';

/** Lo que se muestra y, si se puede perder, lo que se va a borrar: cada entrada de git, absoluta y dentro de la rama. */
export interface UntrackedScan {
  files: number;
  bytes: number;
  /** La huella de lo que se recorrió; null si no se ofrece (`blocked`). */
  stamp: string | null;
  blocked: WorktreeUntrackedBlock | null;
  targets: string[];
}

interface Walk {
  hash: Hash;
  files: number;
  bytes: number;
  max: number;
  blocked: WorktreeUntrackedBlock | null;
}

/** Las mismas en Windows y macOS si sólo cambian mayúsculas. */
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * Una ruta de git que se puede borrar tal cual: relativa, con `/`, sin partes
 * vacías, `.`, `..` ni `.git`. git no lista otra cosa; si alguna vez lo hiciera,
 * `..` sería la carpeta de todas las ramas aparte, y `.` la rama entera.
 */
function cleanEntry(entry: string): string | null {
  const clean = entry.replace(/\/+$/, '');
  if (clean.length === 0 || clean.includes('\\')) return null;
  const parts = clean.split('/');
  return parts.some((part) => part.length === 0 || part === '.' || part === '..' || sameName(part, '.git')) ? null : clean;
}

/**
 * Cada entrada que listó git (`.scratch/`, `notas.txt`), con todo lo que tiene
 * adentro: cuántos archivos, cuánto pesan y la huella. Recorre con `lstat`, no
 * entra a ningún enlace y corta en `maxFiles` (el chequeo lo baja para probar
 * el corte). null si una entrada no se puede borrar sin salir de la rama:
 * entonces no se ofrece, y el diálogo dice lo de siempre.
 */
export async function scanUntracked(
  folder: string,
  entries: readonly string[],
  maxFiles = WORKTREE_UNTRACKED_MAX_FILES,
): Promise<UntrackedScan | null> {
  const walk: Walk = { hash: createHash('sha256'), files: 0, bytes: 0, max: maxFiles, blocked: null };
  const targets: string[] = [];
  for (const entry of [...entries].sort()) {
    const clean = cleanEntry(entry);
    if (clean === null) return null;
    let target: string;
    let real: string;
    try {
      // La carpeta de la entrada, con sus enlaces resueltos, tiene que estar en la rama; la entrada misma no se sigue.
      const parent = await resolveInside(folder, path.posix.dirname(clean), { mustExist: true });
      target = path.join(parent, path.posix.basename(clean));
      real = path.join(await realpath(parent), path.posix.basename(clean));
    } catch {
      return null;
    }
    targets.push(target);
    walk.hash.update(`${clean}\0`);
    await visit(target, real, clean, walk);
    if (walk.blocked !== null) return { files: walk.files, bytes: walk.bytes, stamp: null, blocked: walk.blocked, targets: [] };
  }
  return { files: walk.files, bytes: walk.bytes, stamp: walk.hash.digest('hex'), blocked: null, targets };
}

/** `real` es donde tendría que estar `absolute` si ninguna carpeta del camino fuera un enlace. */
async function visit(absolute: string, real: string, relative: string, walk: Walk): Promise<void> {
  if (walk.files >= walk.max) {
    walk.blocked = 'too-many';
    return;
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    // Lo que desapareció entre git y acá también es parte de lo que se vio.
    walk.hash.update(`${relative}\0?\n`);
    return;
  }
  // Una junction a una letra de unidad, `lstat` la da por enlace; una a un volumen por su GUID, por
  // carpeta (la revisión lo midió con Node 22.14): se la reconoce porque su ruta real es otra.
  const linked = !info.isDirectory() || !sameName(await realpath(absolute).catch(() => ''), real);
  if (linked) {
    // Un enlace cuenta como un archivo: se pierde él, no su destino.
    walk.files += 1;
    walk.bytes += info.size;
    walk.hash.update(`${relative}\0${info.isSymbolicLink() || info.isDirectory() ? 'l' : 'f'}\0${info.size}\0${info.mtimeMs}\n`);
    return;
  }
  walk.hash.update(`${relative}\0d\n`);
  let names: string[];
  try {
    names = (await readdir(absolute)).sort();
  } catch {
    walk.hash.update(`${relative}\0!\n`);
    return;
  }
  // Un repositorio adentro (también otra rama aparte, con su archivo `.git`): eso no se pierde desde la app.
  if (names.some((name) => sameName(name, '.git'))) {
    walk.blocked = 'nested-repo';
    return;
  }
  for (const name of names) {
    await visit(path.join(absolute, name), path.join(real, name), `${relative}/${name}`, walk);
    if (walk.blocked !== null) return;
  }
}

/**
 * Borra las entradas de un `scanUntracked` recién hecho. `fs.rm` no sigue
 * enlaces (medido con Node 22.14: el destino de una junction quedó intacto) y
 * quita los archivos de sólo lectura. Lo que ya no está no es un error.
 */
export async function deleteUntracked(targets: readonly string[]): Promise<void> {
  for (const target of targets) {
    try {
      await rm(target, { recursive: true, maxRetries: 3 });
    } catch (error) {
      if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
    }
  }
}
