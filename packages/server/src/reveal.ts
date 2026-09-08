/**
 * Abre una ruta con la aplicacion que el sistema tenga asociada.
 *
 * **No se elige editor y no hay nada que configurar.** El sistema operativo ya
 * sabe con que abre el usuario un `.ts`; una opcion "ruta a mi editor" en la
 * app seria una preferencia mas que mantener para llegar al mismo resultado.
 *
 * La ruta llega siempre resuelta por `path-guard`: aca no se valida nada
 * porque para este punto ya se comprobo que esta dentro del `cwd` de la
 * pestana. Es importante que siga siendo asi — esto lanza un proceso.
 *
 * Se usa `spawn` con la ruta como argumento aparte, nunca una linea de comando
 * armada por concatenacion: un archivo llamado `a & calc.exe` no puede terminar
 * ejecutando nada.
 */

import { spawn } from 'node:child_process';

export function revealPath(absolutePath: string): void {
  const [command, args] = ((): [string, string[]] => {
    switch (process.platform) {
      case 'win32':
        // El "" vacio es el titulo de la ventana. Sin el, `start` toma la ruta
        // entrecomillada como titulo y no abre nada.
        return [process.env['ComSpec'] ?? 'cmd.exe', ['/c', 'start', '', absolutePath]];
      case 'darwin':
        return ['open', [absolutePath]];
      default:
        return ['xdg-open', [absolutePath]];
    }
  })();

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', (error) => {
      console.warn('[archivos] no se pudo abrir la ruta:', error.message);
    });
    child.unref();
  } catch (error) {
    console.warn('[archivos] no se pudo abrir la ruta:', error);
  }
}
