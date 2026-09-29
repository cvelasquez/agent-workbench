/**
 * Ctrl+V pega en las consolas del pie (§5.2).
 *
 * xterm convierte Ctrl+V en `^V` (el byte 0x16), se lo manda a la pty y cancela
 * el evento, asi que el navegador nunca llega a pegar. En la terminal del agente
 * es justo lo que tiene que pasar: Claude Code lee el portapapeles por su cuenta
 * cuando le llega la tecla, y asi pega imagenes (§5). Pero PowerShell no hace
 * nada con ese byte, y en la consola pegar quedaba solo en el clic derecho.
 *
 * En una consola, con el navegador en Windows, xterm deja pasar la tecla y el
 * navegador hace el pegado de siempre, el mismo del clic derecho. Es lo que
 * hacen Windows Terminal y la terminal de VS Code en Windows. En macOS se pega
 * con Cmd+V y en Linux con Ctrl+Shift+V, y las dos ya funcionaban: ahi Ctrl+V
 * sigue llegando a la consola, donde bash y vim lo usan.
 *
 * Decide el equipo del navegador y no el del servidor: la costumbre de teclado
 * es la de quien teclea, tambien entrando por el acceso remoto (§14).
 */

/** Lo que se mira de una tecla. `KeyboardEvent` lo cumple. */
export interface PasteKeyLike {
  keyCode: number;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** true si el navegador corre en Windows (`navigator.platform`: `Win32`). */
export function isWindowsClient(platform: string): boolean {
  return platform.toLowerCase().startsWith('win');
}

/**
 * true si la tecla es el Ctrl+V que xterm convertiria en `^V`.
 *
 * Es la misma condicion con la que xterm lo arma (`Keyboard.ts`): la tecla 86
 * con Ctrl y ningun otro modificador. Con AltGr, que en Windows llega como
 * Ctrl+Alt, no es un pegado; y Ctrl+Shift+V ya lo pega el navegador.
 */
export function isConsolePasteKey(event: PasteKeyLike): boolean {
  return event.keyCode === 86 && event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey;
}
