/**
 * Abre una URL en el navegador por defecto.
 *
 * Son quince lineas y evita una dependencia. Si falla, no es fatal: el usuario
 * siempre puede copiar la URL que imprimimos en consola.
 */

import { spawn } from 'node:child_process';

export function openBrowser(url: string): void {
  const [command, args] = ((): [string, string[]] => {
    switch (process.platform) {
      case 'win32':
        // El "" vacio es el titulo de la ventana: sin el, `start` interpreta
        // una URL entrecomillada como titulo y no abre nada.
        return [process.env['ComSpec'] ?? 'cmd.exe', ['/c', 'start', '', url]];
      case 'darwin':
        return ['open', [url]];
      default:
        return ['xdg-open', [url]];
    }
  })();

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {
      /* El usuario abre la URL a mano. */
    });
    child.unref();
  } catch {
    /* Idem. */
  }
}
