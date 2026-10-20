/**
 * De qué repositorio y qué rama es una carpeta, leyendo `.git` sin lanzar git
 * (hito 48, §6.38).
 *
 * Lo usan la barra lateral y la barra de pestañas para poner una rama aparte
 * dentro de su proyecto: cientos de sesiones, cada una con su carpeta, y un
 * proceso de git por cada una sería caro para algo que es leer tres archivos.
 *
 * **El archivo `.git` de una rama aparte es un archivo del proyecto**, y
 * cualquiera lo puede escribir. Por eso no se le cree: la carpeta a la que
 * apunta tiene que tener `commondir`, y su `gitdir` tiene que apuntar de vuelta
 * a este mismo `.git`. Aun así, lo que sale de acá sólo agrupa y rotula; la
 * carpeta principal a la que vuelven las notas sale del registro de la app,
 * nunca de este archivo (§2.1).
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Hasta dónde se sube buscando `.git`: una carpeta tan honda no es la raíz de un repo. */
const MAX_DEPTH = 24;
/** Un `.git`, un `HEAD` o un `gitdir` de verdad tienen una línea. */
const MAX_POINTER_BYTES = 4_096;

export interface Checkout {
  /** La raíz de la carpeta de trabajo: donde está el `.git`. */
  root: string;
  /** La raíz de la carpeta principal del repo. Igual a `root` en la principal. */
  mainRoot: string;
  /** true en una rama aparte (`.git` es un archivo que apunta a la principal). */
  linked: boolean;
  /** La rama sacada; null con HEAD desprendido o si no se pudo leer. */
  branch: string | null;
}

async function readSmall(file: string): Promise<string | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_POINTER_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function kindOf(file: string): Promise<'file' | 'directory' | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : null;
  } catch {
    return null;
  }
}

/** `ref: refs/heads/<rama>` a `<rama>`; cualquier otra cosa, null. */
export function branchFromHead(head: string): string | null {
  const match = /^ref: refs\/heads\/(\S.*?)\s*$/.exec(head.split(/\r?\n/)[0] ?? '');
  return match === null ? null : (match[1] ?? null);
}

/** Dos rutas que nombran la misma carpeta, sin tocar el disco. En Windows, sin distinguir mayúsculas. */
export function samePathShape(a: string, b: string, platform: string = process.platform): boolean {
  const clean = (value: string): string => {
    const resolved = path.resolve(value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return clean(a) === clean(b);
}

/**
 * La rama aparte que describe un archivo `.git`, o null si no se sostiene.
 *
 * `gitdir: <carpeta>` tiene que llevar a una carpeta con `commondir` (lo que
 * escribe `git worktree add`) cuyo `gitdir` apunte de vuelta a este `.git`. La
 * principal es la carpeta de arriba del directorio común, si este se llama
 * `.git`: un repo desnudo no tiene carpeta principal donde trabajar.
 */
async function linkedFromPointer(root: string): Promise<Checkout | null> {
  const pointer = await readSmall(path.join(root, '.git'));
  const match = pointer === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(pointer);
  if (match === null || match[1] === undefined) return null;
  const gitDir = path.resolve(root, match[1]);

  const common = await readSmall(path.join(gitDir, 'commondir'));
  const back = await readSmall(path.join(gitDir, 'gitdir'));
  if (common === null || back === null) return null;
  const commonDir = path.resolve(gitDir, common.trim());
  if (!samePathShape(path.resolve(gitDir, back.trim()), path.join(root, '.git'))) return null;
  if (path.basename(commonDir).toLowerCase() !== '.git') return null;

  const head = await readSmall(path.join(gitDir, 'HEAD'));
  return {
    root,
    mainRoot: path.dirname(commonDir),
    linked: true,
    branch: head === null ? null : branchFromHead(head),
  };
}

/**
 * El checkout que contiene `cwd`, o null si no está en un repositorio de git (o
 * la carpeta ya no existe).
 *
 * Sube desde `cwd` hasta encontrar `.git`: una carpeta es la principal, un
 * archivo es una rama aparte (o un submódulo, que no tiene `commondir` y se
 * toma como un repo propio).
 */
export async function readCheckout(cwd: string): Promise<Checkout | null> {
  let current = path.resolve(cwd);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const marker = await kindOf(path.join(current, '.git'));
    if (marker === 'directory') {
      const head = await readSmall(path.join(current, '.git', 'HEAD'));
      return {
        root: current,
        mainRoot: current,
        linked: false,
        branch: head === null ? null : branchFromHead(head),
      };
    }
    if (marker === 'file') {
      const linked = await linkedFromPointer(current);
      if (linked !== null) return linked;
      // Un submódulo, o un `.git` que no se sostiene: un repo propio, sin rama aparte.
      return { root: current, mainRoot: current, linked: false, branch: null };
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

/**
 * La carpeta principal que le corresponde a `cwd` dentro de su checkout: la
 * misma subcarpeta, del lado de la principal. En la principal, `cwd` mismo.
 */
export function mainCwdFor(cwd: string, checkout: Checkout): string {
  if (!checkout.linked) return cwd;
  const inner = path.relative(checkout.root, path.resolve(cwd));
  if (inner.length === 0 || inner.startsWith('..') || path.isAbsolute(inner)) return checkout.mainRoot;
  return path.join(checkout.mainRoot, inner);
}
