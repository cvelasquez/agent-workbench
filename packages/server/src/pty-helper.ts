/**
 * El permiso de ejecucion del `spawn-helper` de node-pty.
 *
 * En macOS node-pty no lanza el proceso por su cuenta: se lo pide a un binario
 * auxiliar, `spawn-helper`, que viaja ya compilado dentro del paquete. El
 * paquete de node-pty 1.1.0 en npm lo trae con modo 644 —sin permiso de
 * ejecucion—, npm respeta ese modo al instalar, y el primer `spawn` falla con
 * `posix_spawnp failed.`: la app arranca, la interfaz carga, y ninguna pestana
 * puede abrir una CLI. En Linux no pasa porque ahi no hay binario precompilado:
 * se compila al instalar y el enlazador lo deja ejecutable. En Windows no hay
 * helper.
 *
 * Lo encontro la prueba de arranque del CI (`.github/scripts/smoke.mjs`) en
 * macOS; nunca se habia probado ahi. Se arregla al arrancar y no con un
 * `postinstall` porque hay gestores que no corren los scripts de instalacion, y
 * porque asi tambien se cura una instalacion que ya estaba hecha.
 *
 * No se carga node-pty para esto: solo se resuelve donde esta.
 */

import { chmodSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Donde node-pty busca su modulo nativo, y al lado el helper (`lib/utils.js`). */
function helperCandidates(packageDir: string, platform: string, arch: string): string[] {
  return [
    path.join(packageDir, 'build', 'Release', 'spawn-helper'),
    path.join(packageDir, 'build', 'Debug', 'spawn-helper'),
    path.join(packageDir, 'prebuilds', `${platform}-${arch}`, 'spawn-helper'),
  ];
}

/** La carpeta del paquete node-pty que va a cargar este proceso, o null. */
function locateNodePty(): string | null {
  try {
    const require = createRequire(import.meta.url);
    // El punto de entrada es `lib/index.js`: la carpeta del paquete esta un nivel arriba.
    return path.resolve(path.dirname(require.resolve('node-pty')), '..');
  } catch {
    return null;
  }
}

export interface PtyHelperOptions {
  platform?: string;
  arch?: string;
  /** La carpeta de node-pty; por defecto, la que resuelve este proceso. */
  packageDir?: string | null;
  warn?: (message: string) => void;
}

/**
 * Deja ejecutable el `spawn-helper` si no lo estaba. Devuelve los archivos que
 * cambio. Nunca lanza: si no puede —una instalacion global hecha con `sudo`—,
 * avisa con el comando que lo arregla y sigue; el error de verdad lo va a dar
 * el primer `spawn`, y este aviso es lo que lo explica.
 */
export function ensurePtyHelperExecutable(options: PtyHelperOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform === 'win32') return [];
  const packageDir = options.packageDir === undefined ? locateNodePty() : options.packageDir;
  if (packageDir === null) return [];
  const warn = options.warn ?? ((message: string) => console.warn(message));

  const fixed: string[] = [];
  for (const file of helperCandidates(packageDir, platform, options.arch ?? process.arch)) {
    let mode: number;
    try {
      const stats = statSync(file);
      if (!stats.isFile()) continue;
      mode = stats.mode;
    } catch {
      // No esta: node-pty usa otra de las rutas, o se compilo sin helper.
      continue;
    }
    if ((mode & 0o111) === 0o111) continue;
    try {
      chmodSync(file, (mode & 0o777) | 0o755);
      fixed.push(file);
    } catch {
      warn(
        `[pty] ${file} is not executable and couldn't be fixed: no tab will be able to start a CLI. ` +
          `Run: chmod +x "${file}"`,
      );
    }
  }
  return fixed;
}
