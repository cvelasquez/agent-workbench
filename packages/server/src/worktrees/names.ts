/**
 * Dónde va la carpeta de una rama aparte, y cómo se reconoce una por la forma
 * de su ruta (hito 48, §6.38). Puro: sin disco, para que lo pruebe el chequeo.
 *
 * Las reglas del nombre de la rama viven en `shared/worktrees.ts`, porque la
 * web las usa mientras se escribe; acá está lo que sólo sabe el servidor: las
 * rutas.
 */

import path from 'node:path';
import { worktreeFolderName, worktreesDirName } from '@agent-workbench/shared';

/**
 * La carpeta de una rama nueva: al lado del proyecto, en `<proyecto>.worktrees`
 * (decisión 1 del plan). `D:\Mi App` y `feat/login` dan
 * `D:\Mi App.worktrees\feat-login`.
 *
 * Al lado y no adentro: adentro, las pruebas, el linter y el compilador de la
 * carpeta principal recorrerían el código de todas las ramas, y Claude Code
 * cargaría también el `CLAUDE.md` de la principal, que está arriba.
 */
export function worktreeFolderFor(mainRoot: string, branch: string, pathApi: path.PlatformPath = path): string {
  const parent = pathApi.dirname(mainRoot);
  return pathApi.join(parent, worktreesDirName(pathApi.basename(mainRoot)), worktreeFolderName(branch));
}

/** La carpeta que junta las ramas de un proyecto. Para mostrar. */
export function worktreesParentFor(mainRoot: string, pathApi: path.PlatformPath = path): string {
  return pathApi.join(pathApi.dirname(mainRoot), worktreesDirName(pathApi.basename(mainRoot)));
}

/**
 * La carpeta principal de una rama aparte que ya no existe, por la forma de su
 * ruta, o null si no tiene ninguna conocida.
 *
 *  - `<x>.worktrees\<rama>`, la de esta app (y la de los agentes de VS Code);
 *  - `<x>\.claude\worktrees\<nombre>`, la de `claude --worktree`.
 *
 * Es el último recurso, para una sesión cuya carpeta se borró y que la app no
 * creó: sólo decide en qué proyecto se muestra.
 */
export function mainRootFromShape(folder: string, pathApi: path.PlatformPath = path): string | null {
  const parent = pathApi.dirname(folder);
  const parentName = pathApi.basename(parent);
  if (parentName.length > '.worktrees'.length && parentName.toLowerCase().endsWith('.worktrees')) {
    return pathApi.join(pathApi.dirname(parent), parentName.slice(0, -'.worktrees'.length));
  }
  const grandparent = pathApi.dirname(parent);
  if (parentName.toLowerCase() === 'worktrees' && pathApi.basename(grandparent).toLowerCase() === '.claude') {
    return pathApi.dirname(grandparent);
  }
  return null;
}
