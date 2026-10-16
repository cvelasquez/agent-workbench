/**
 * Las carpetas de las CLIs, vistas desde Archivos (CLAUDE.md 2.1, Hito 46).
 *
 * El selector de carpetas no entra a ninguna (§6.9), pero un proyecto abierto en
 * la carpeta de usuario las tiene adentro: hasta el Hito 46 el arbol listaba
 * `.claude` y el visor abria `.claude/.credentials.json`, que la app no puede
 * leer. Ahora Archivos no las lista, no las recorre y no lee ni escribe nada
 * adentro.
 *
 * Una ruta cae en una si la ruta tal cual o la real caen adentro: un enlace o
 * una junction del proyecto hacia `~/.claude` no la esconden. En Windows se
 * compara sin distinguir mayusculas, con la misma clave que agrupa proyectos
 * (`normalizeCwdKey`).
 */

import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeCwdKey } from '@agent-workbench/shared';

export interface CliFolders {
  /** Pura: true si esta ruta, ya resuelta, es la carpeta de una CLI o cae adentro. */
  holds(realPath: string): boolean;
  /** true si la ruta, o adonde lleva un enlace, cae en la carpeta de una CLI. */
  contains(absolute: string): Promise<boolean>;
}

/** Sin carpetas que cuidar: lo que usan los chequeos que no miran esto. */
export const NO_CLI_FOLDERS: CliFolders = {
  holds: () => false,
  contains: async () => false,
};

function isSameOrInside(child: string, parent: string, platform: string): boolean {
  const childKey = normalizeCwdKey(child, platform);
  const parentKey = normalizeCwdKey(parent, platform);
  if (childKey.length === 0 || parentKey.length === 0) return false;
  if (childKey === parentKey) return true;
  const separator = platform === 'win32' ? '\\' : '/';
  return childKey.startsWith(parentKey.endsWith(separator) ? parentKey : `${parentKey}${separator}`);
}

/**
 * Las carpetas que declaran los adaptadores (`agents.protectedDirs()`), con su
 * ruta real al lado. La de una CLI que no esta instalada no tiene ruta real, y
 * alcanza con la declarada.
 */
export async function cliFolders(dirs: readonly string[], platform: string = process.platform): Promise<CliFolders> {
  const known: string[] = [];
  for (const dir of dirs) {
    known.push(path.resolve(dir));
    try {
      known.push(await realpath(dir));
    } catch {
      // No existe todavia: la ruta declarada es la unica que puede aparecer.
    }
  }

  const holds = (candidate: string): boolean => known.some((dir) => isSameOrInside(candidate, dir, platform));

  return {
    holds,
    async contains(absolute) {
      if (known.length === 0) return false;
      if (holds(absolute)) return true;
      try {
        return holds(await realpath(absolute));
      } catch {
        // Lo que no existe no lleva a ningun lado.
        return false;
      }
    },
  };
}
