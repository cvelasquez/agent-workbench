/**
 * Traduce una ruta relativa que mando el cliente a una ruta absoluta segura.
 *
 * Por que existe un archivo entero para esto: el servidor lanza procesos y lee
 * el disco. Si acepta una ruta arbitraria, deja de importar que escuche solo en
 * loopback — cualquier bug de la UI, o una pagina que consiga hablarle, lee
 * `%USERPROFILE%\.claude\.credentials.json` de un mensaje. La regla 2.1 del
 * CLAUDE.md se cumple, entre otras cosas, aca.
 *
 * La unica ruta que el cliente puede nombrar es una **relativa al `cwd` de una
 * pestana que abrio el propio servidor**. Todo lo demas se rechaza.
 *
 * El chequeo es en dos pasos y los dos hacen falta:
 *
 *  1. Sintactico, sobre el texto: sin absolutas, sin `..`, sin unidades de
 *     Windows, sin rutas UNC, sin bytes nulos.
 *  2. Real, contra el disco: se resuelven los enlaces simbolicos y se comprueba
 *     que el resultado siga adentro. Un enlace dentro del proyecto apuntando a
 *     `C:\Users` pasa el paso 1 sin problemas.
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ServerTextError, serverText } from '@agent-workbench/shared';

/** Una ruta rechazada. El texto va como clave: la frase la arma la web (§6.23). */
export class InvalidPathError extends ServerTextError {}

/** Normaliza a `/` para que el protocolo hable un solo dialecto. */
export function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * Rechaza por texto lo que no puede ser una ruta relativa interna.
 *
 * Ojo con `path.isAbsolute` en Windows: dice false para `\servidor\share`, que
 * es una ruta UNC perfectamente valida. Por eso ademas se mira el prefijo a
 * mano.
 */
function assertRelativeShape(relativePath: string): void {
  if (relativePath.includes('\0')) {
    throw new InvalidPathError(serverText('pathNullByte'));
  }
  if (path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new InvalidPathError(serverText('pathNotRelative'));
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    throw new InvalidPathError(serverText('pathNotRelative'));
  }
  const segments = relativePath.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new InvalidPathError(serverText('pathOutside'));
  }
}

/** true si `candidate` esta dentro de `root` (o es `root`). */
function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  if (relative.length === 0) return true;
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resuelve una ruta relativa dentro de `root`.
 *
 * `mustExist` en false permite nombrar algo que todavia no existe (un archivo
 * borrado que aparece en `git status`, por ejemplo): ahi se valida contra el
 * ancestro existente mas cercano, que es lo unico que se puede resolver.
 */
export async function resolveInside(
  root: string,
  relativePath: string,
  options: { mustExist?: boolean } = {},
): Promise<string> {
  assertRelativeShape(relativePath);

  const absolute = path.resolve(root, relativePath);
  if (!isInside(root, absolute)) {
    throw new InvalidPathError(serverText('pathOutside'));
  }

  // La raiz misma puede ser un enlace (en macOS `/tmp` lo es), asi que los dos
  // lados se comparan ya resueltos o la comparacion da falsos negativos.
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    throw new InvalidPathError(serverText('tabDirGone'));
  }

  let realTarget: string;
  try {
    realTarget = await realpath(absolute);
  } catch {
    if (options.mustExist === true) {
      throw new InvalidPathError(serverText('pathMissing'));
    }
    // No existe todavia: se valida el ancestro que si existe. Si ese esta
    // adentro, la ruta completa tambien lo esta.
    realTarget = await realpathOfNearestParent(absolute);
  }

  if (!isInside(realRoot, realTarget)) {
    throw new InvalidPathError(serverText('pathOutside'));
  }
  return absolute;
}

async function realpathOfNearestParent(absolute: string): Promise<string> {
  let current = path.dirname(absolute);
  for (;;) {
    try {
      return await realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new InvalidPathError(serverText('pathMissing'));
      current = parent;
    }
  }
}
