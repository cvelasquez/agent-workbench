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
  /**
   * Las mismas, con el texto atenuado (SGR 2) en blanco: lo que la CLI dibuja en
   * gris en su caja es ayuda o una sugerencia, no algo escrito (§5.3.1).
   */
  linesWithoutFaint(): Promise<string[]>;
  /**
   * De la misma lectura, las dos mitades: sin lo atenuado y solo lo atenuado,
   * cada caracter en su columna. Para la sugerencia que la CLI dibuja en gris en
   * su caja vacia (hito 53, §5.3.2): la caja se ubica en una y se lee en la otra.
   */
  splitByFaint(): Promise<FaintSplit>;
  dispose(): void;
}

export interface FaintSplit {
  /** Las lineas sin el texto atenuado. */
  clean: string[];
  /** Solo el texto atenuado; lo demas, en blanco. */
  faint: string[];
}

type HeadlessTerminal = InstanceType<typeof Terminal>;
type BufferLine = NonNullable<ReturnType<HeadlessTerminal['buffer']['active']['getLine']>>;
type BufferCell = ReturnType<HeadlessTerminal['buffer']['active']['getNullCell']>;

type SplitLine = [clean: string, faint: string];

/** Una linea partida en lo que no esta atenuado y lo que si, sin los espacios del final. */
function splitLine(line: BufferLine, cols: number, cell: BufferCell): SplitLine {
  let clean = '';
  let faint = '';
  for (let x = 0; x < cols; x += 1) {
    const current = line.getCell(x, cell);
    if (current === undefined) break;
    // La segunda mitad de un caracter ancho: ya va con la primera.
    if (current.getWidth() === 0) continue;
    const chars = current.getChars() === '' ? ' ' : current.getChars();
    const dim = current.isDim() !== 0;
    clean += dim ? ' ' : chars;
    faint += dim ? chars : ' ';
  }
  return [clean.trimEnd(), faint.trimEnd()];
}

export function createPtyScreen(cols: number, rows: number, replay: string): PtyScreen {
  // `buffer` es API propuesta en la version sin pantalla: sin esto, leer lanza.
  const term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  let disposed = false;
  if (replay.length > 0) term.write(replay);
  const read = <T>(render: (line: BufferLine, cell: BufferCell) => T, empty: T): Promise<T[]> =>
    new Promise((resolve) => {
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
          const cell = buffer.getNullCell();
          const lines: T[] = [];
          for (let y = 0; y < term.rows; y += 1) {
            const line = buffer.getLine(buffer.viewportY + y);
            lines.push(line === undefined ? empty : render(line, cell));
          }
          resolve(lines);
        } catch {
          resolve([]);
        }
      });
    });
  return {
    feed(chunk) {
      if (!disposed) term.write(chunk);
    },
    lines() {
      return read((line) => line.translateToString(true), '');
    },
    async linesWithoutFaint() {
      return (await read<SplitLine>((line, cell) => splitLine(line, term.cols, cell), ['', ''])).map(([clean]) => clean);
    },
    async splitByFaint() {
      const split = await read<SplitLine>((line, cell) => splitLine(line, term.cols, cell), ['', '']);
      return { clean: split.map(([clean]) => clean), faint: split.map(([, faint]) => faint) };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      term.dispose();
    },
  };
}
