/**
 * Donde esta Pi y que version es, **sin ejecutarla**.
 *
 * Las demas CLIs se localizan corriendo `--version`. Con Pi no: segun su
 * codigo, `pi --version` toca su carpeta antes de imprimir —limpia restos de su
 * autoactualizacion y lee `settings.json` con un candado—, y la app no escribe
 * en la carpeta de ninguna CLI (regla 2.1). La version sale del `package.json`
 * del paquete instalado, y de paso se comprueba el nombre: `pi` es corto, y otro
 * programa del PATH puede llamarse igual (CLAUDE.md 16.1).
 *
 * Dos formas de instalar que se reconocen:
 *
 *  - **npm** (medido en Windows): el shim `pi.cmd` junto al paquete, en
 *    `<carpeta>/node_modules/@earendil-works/pi-coding-agent/`. En macOS y
 *    Linux el comando es un enlace al paquete, o esta en `<prefijo>/bin` con el
 *    paquete en `<prefijo>/lib/node_modules/` (sin medir).
 *  - **El instalador de pi.dev** (leido en su script, sin medir): el shim en
 *    `<carpeta de Pi>/bin/`, la version vigente en
 *    `install/current-version`, y el paquete en
 *    `install/releases/<version>/node_modules/…`.
 *
 * El `pi.exe` suelto compilado con Bun no trae `package.json` y no se
 * reconoce: la app dice que Pi no esta.
 */

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { asRecord } from '@agent-workbench/shared';
import { findInPath, launcherFor, type CliLocation } from '../locate.js';
import { PI_COMMAND, PI_PACKAGE_NAME } from './constants.js';

export interface PiLocation extends CliLocation {
  /** La carpeta del paquete instalado: de ahi sale el catalogo de respaldo. */
  packageDir: string;
}

const PACKAGE_PARTS = PI_PACKAGE_NAME.split('/');

/** Un nombre de version que puede ir dentro de una ruta. El mismo criterio que el instalador. */
const MANAGED_VERSION_PATTERN = /^[0-9A-Za-z._+-]+$/;

/** Cuantas carpetas se sube desde el comando buscando el `package.json` del paquete. */
const WALK_UP_LEVELS = 6;

export interface LocatePiDeps {
  findInPath?: (command: string) => Promise<string | null>;
  readFile?: (file: string) => Promise<string>;
  realpath?: (file: string) => Promise<string>;
}

/** La version del `package.json` de esa carpeta, o null si no es el paquete de Pi. */
async function packageVersion(dir: string, read: (file: string) => Promise<string>): Promise<string | null> {
  try {
    const manifest = asRecord(JSON.parse(await read(path.join(dir, 'package.json'))));
    if (manifest === null || manifest['name'] !== PI_PACKAGE_NAME) return null;
    const version = manifest['version'];
    return typeof version === 'string' && version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** Las carpetas donde puede estar el paquete, segun donde esta el comando. */
async function candidateDirs(resolvedPath: string, deps: Required<LocatePiDeps>): Promise<string[]> {
  const dir = path.dirname(resolvedPath);
  const candidates = [
    path.join(dir, 'node_modules', ...PACKAGE_PARTS),
    path.join(dir, '..', 'lib', 'node_modules', ...PACKAGE_PARTS),
  ];

  // El instalador de pi.dev: `<carpeta de Pi>/bin/pi.cmd` y la version en un archivo.
  try {
    const installRoot = path.join(dir, '..', 'install');
    const version = (await deps.readFile(path.join(installRoot, 'current-version'))).trim();
    if (version !== '.' && version !== '..' && MANAGED_VERSION_PATTERN.test(version)) {
      candidates.push(path.join(installRoot, 'releases', version, 'node_modules', ...PACKAGE_PARTS));
    }
  } catch {
    // No es esa forma de instalar.
  }

  // Un enlace al ejecutable del paquete: se sube desde su destino.
  try {
    let cursor = path.dirname(await deps.realpath(resolvedPath));
    for (let level = 0; level < WALK_UP_LEVELS; level += 1) {
      candidates.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  } catch {
    // Sin destino que seguir.
  }
  return candidates;
}

/** Los `pi` ya avisados como "no es Pi", para no repetirlo en cada busqueda. */
const warnedForeign = new Set<string>();

/** null si Pi no esta en el PATH, o si lo que hay con ese nombre no es el paquete de Pi. */
export async function locatePi(overrides: LocatePiDeps = {}): Promise<PiLocation | null> {
  const deps: Required<LocatePiDeps> = {
    findInPath: overrides.findInPath ?? findInPath,
    readFile: overrides.readFile ?? ((file) => readFile(file, 'utf8')),
    realpath: overrides.realpath ?? realpath,
  };
  const resolvedPath = await deps.findInPath(PI_COMMAND);
  if (resolvedPath === null) return null;

  for (const packageDir of await candidateDirs(resolvedPath, deps)) {
    const version = await packageVersion(packageDir, deps.readFile);
    if (version !== null) return { resolvedPath, ...launcherFor(resolvedPath), version, packageDir };
  }

  if (!warnedForeign.has(resolvedPath)) {
    warnedForeign.add(resolvedPath);
    console.warn(
      `[pi] found a "pi" command at ${resolvedPath}, but not the ${PI_PACKAGE_NAME} package next to it: it isn't used.`,
    );
  }
  return null;
}
