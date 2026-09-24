/**
 * El código QR para emparejar un teléfono (hito 38, §15).
 *
 * Sale como un solo `path` de SVG, fila por fila y con los tramos oscuros
 * juntos: sin `innerHTML`, sin imagen y sin canvas. Siempre negro sobre blanco,
 * también con el tema oscuro: un QR invertido no lo lee cualquier cámara.
 *
 * El texto es ASCII —la dirección que arma el servidor ya viene con todo lo
 * demás escapado—, así que el modo de bytes de la biblioteca lo codifica tal
 * cual. Corrección de errores M: se lee de una pantalla con algo de reflejo.
 *
 * Sin React ni JSX: lo prueba `check-remote-access.mjs`.
 */

import qrcode from 'qrcode-generator';

export interface QrMatrix {
  /** Módulos por lado, sin el margen. */
  size: number;
  /** Los módulos oscuros, en unidades de módulo. */
  path: string;
}

/** Los módulos alrededor que piden los lectores para encontrar el código. */
export const QR_QUIET_ZONE = 4;

export function qrMatrix(text: string): QrMatrix {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  let path = '';
  for (let row = 0; row < size; row++) {
    let col = 0;
    while (col < size) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < size && qr.isDark(row, col)) col++;
      path += `M${start} ${row}h${col - start}v1h-${col - start}z`;
    }
  }
  return { size, path };
}

/** Si el módulo de esa fila y columna está pintado, leído del `path`: para el chequeo. */
export function qrModuleDark(matrix: QrMatrix, row: number, col: number): boolean {
  const pattern = /M(\d+) (\d+)h(\d+)/g;
  for (const match of matrix.path.matchAll(pattern)) {
    const x = Number(match[1]);
    const y = Number(match[2]);
    const width = Number(match[3]);
    if (y === row && col >= x && col < x + width) return true;
  }
  return false;
}
