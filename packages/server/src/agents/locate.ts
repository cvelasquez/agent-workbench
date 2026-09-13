/**
 * Localiza el binario de una CLI en el PATH.
 *
 * Es lo mismo para todas: que comando buscar y donde se instala lo pone cada
 * adaptador (`agents/claude-code/constants.ts`), no este archivo.
 *
 * Reglas que respeta este archivo:
 *  - El binario NO se incluye en el repo ni se descarga. Solo se busca.
 *  - No se parchea ni se envuelve de forma que altere su comportamiento.
 *    Lo unico que hacemos es resolver su ruta y, en Windows, pasar por el
 *    interprete de comandos cuando lo que encontramos es un shim .cmd/.bat.
 *  - Si no esta, la app lo dice claro y no arranca sesiones.
 */

import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CliLocation {
  /** Ruta absoluta de lo que encontramos en el PATH. */
  resolvedPath: string;
  /** Ejecutable que hay que lanzar. Puede ser cmd.exe si lo anterior es un shim. */
  file: string;
  /** Argumentos que van antes de los del usuario. Vacio salvo en el caso del shim. */
  prefixArgs: readonly string[];
  /** Version reportada por la CLI, o null si no se pudo leer. */
  version: string | null;
}

const isWindows = process.platform === 'win32';

/**
 * Extensiones ejecutables a probar en Windows.
 * Se lee de PATHEXT porque el usuario puede haberlo cambiado.
 */
function windowsExecutableExtensions(): string[] {
  const raw = process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD';
  return raw
    .split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => extension.startsWith('.'));
}

async function isReadableFile(candidate: string): Promise<boolean> {
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    // En POSIX ademas exigimos el bit de ejecucion; en Windows no existe.
    await access(candidate, isWindows ? fsConstants.R_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recorre el PATH a mano en vez de invocar `where`/`which`.
 *
 * Es una llamada menos a un subproceso, funciona igual en las tres plataformas
 * y no depende de que haya un shell disponible.
 *
 * Se exporta porque `shell-locator` busca igual: mismo PATH, mismo PATHEXT,
 * mismas comillas legales en las entradas de Windows.
 */
export async function findInPath(command: string): Promise<string | null> {
  const rawPath = process.env['PATH'] ?? process.env['Path'] ?? '';
  const directories = rawPath.split(path.delimiter).filter((entry) => entry.length > 0);
  const extensions = isWindows ? windowsExecutableExtensions() : [''];

  for (const directory of directories) {
    // Las comillas alrededor de una entrada del PATH son legales en Windows.
    const cleanDirectory = directory.replace(/^"|"$/g, '');
    for (const extension of extensions) {
      const candidate = path.join(cleanDirectory, command + extension);
      if (await isReadableFile(candidate)) return path.resolve(candidate);
    }
  }
  return null;
}

/**
 * Un shim .cmd o .bat no es un ejecutable: lo tiene que interpretar cmd.exe.
 * Lanzarlo directo por el pty falla o se cuelga.
 *
 * Es el caso habitual cuando la CLI se instalo via npm. En una instalacion con
 * el instalador nativo lo que aparece es un .exe y esto no se activa.
 */
function needsCommandInterpreter(resolvedPath: string): boolean {
  if (!isWindows) return false;
  const extension = path.extname(resolvedPath).toLowerCase();
  return extension === '.cmd' || extension === '.bat';
}

async function readVersion(file: string, prefixArgs: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(file, [...prefixArgs, '--version'], {
      timeout: 10_000,
      windowsHide: true,
    });
    const firstLine = stdout.split('\n')[0]?.trim();
    return firstLine !== undefined && firstLine.length > 0 ? firstLine : null;
  } catch {
    // No poder leer la version no es fatal: la UI simplemente no la muestra.
    return null;
  }
}

/** Devuelve null si la CLI no esta instalada o no es accesible. */
export async function locateCommand(command: string): Promise<CliLocation | null> {
  const resolvedPath = await findInPath(command);
  if (resolvedPath === null) return null;

  const useInterpreter = needsCommandInterpreter(resolvedPath);
  const file = useInterpreter
    ? (process.env['ComSpec'] ?? 'cmd.exe')
    : resolvedPath;
  const prefixArgs: readonly string[] = useInterpreter ? ['/c', resolvedPath] : [];

  return {
    resolvedPath,
    file,
    prefixArgs,
    version: await readVersion(file, prefixArgs),
  };
}

/** Mensaje que ve el usuario cuando la CLI no esta. */
export function commandNotFoundMessage(command: string, installUrl: string): string {
  return (
    `No se encontro el comando "${command}" en el PATH. ` +
    `Agent Workbench usa la CLI que ya tengas instalada: no la incluye ni la descarga. ` +
    `Instalala desde ${installUrl} y volve a arrancar.`
  );
}
