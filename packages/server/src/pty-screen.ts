/**
 * La pantalla de una pty, emulada para leerla (hito 44).
 *
 * Existe para manejar un menu de la CLI sin equivocarse de opcion: el de
 * rewind de Claude Code (§4.16). Buscar texto en la salida cruda no alcanza,
 * porque la CLI no escribe espacios, mueve el cursor (lo mismo que encontro el
 * contestador del dialogo de reanudar, §4.14); y una opcion marcada solo se
 * sabe por donde quedo el `❯` en la pantalla.
 *
 * Se emula con `@xterm/headless`, la misma version que dibuja la terminal en la
 * web, alimentado como ella: la salida reciente de la pestana y despues lo que
 * llegue. Vive mientras se maneja el menu; despues se suelta.
 */

import headless from '@xterm/headless';

const { Terminal } = headless;

export interface PtyScreen {
  /** Un trozo de salida de la pty. */
  feed(chunk: string): void;
  /** Las lineas visibles, de arriba abajo, con lo recibido hasta ahora ya aplicado. */
  lines(): Promise<string[]>;
  dispose(): void;
}

export function createPtyScreen(cols: number, rows: number, replay: string): PtyScreen {
  // `buffer` es API propuesta en la version sin pantalla: sin esto, leer lanza.
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  let disposed = false;
  if (replay.length > 0) term.write(replay);
  return {
    feed(chunk) {
      if (!disposed) term.write(chunk);
    },
    lines() {
      return new Promise((resolve) => {
        if (disposed) {
          resolve([]);
          return;
        }
        // Una escritura vacia se resuelve cuando todo lo anterior ya se aplico.
        // Corre dentro de un temporizador del emulador: un error aca no lo
        // atrapa nadie y tiraria el servidor entero, asi que no sale.
        term.write('', () => {
          try {
            const buffer = term.buffer.active;
            const lines: string[] = [];
            for (let y = 0; y < term.rows; y += 1) {
              lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '');
            }
            resolve(lines);
          } catch {
            resolve([]);
          }
        });
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
