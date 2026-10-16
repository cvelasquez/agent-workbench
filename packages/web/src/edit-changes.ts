/**
 * Lo que cambiaste en un archivo que estabas editando (Hito 46, §6.36).
 *
 * Sale cuando el agente cambio el archivo mientras lo editabas: lo tuyo ya no se
 * guarda, y esta lista es lo que hay que pasar a mano a la version nueva. Son
 * las lineas de lo que abriste a lo que escribiste, como `DiffLine`, para
 * dibujarlas con el `DiffView` del panel de git: el `+` y el `-` van aparte, y
 * seleccionar y copiar no los arrastra.
 *
 * Sin dependencias: se recorta el principio y el final que son iguales (un
 * `.env` cambia en dos lineas) y se compara lo del medio linea por linea. Un
 * medio enorme va como un bloque reemplazado entero, que sigue siendo correcto,
 * sin colgar la pagina.
 *
 * Puro, sin React ni DOM: lo prueba `check-doc-viewer.mjs`.
 */

import type { DiffLine } from '@agent-workbench/shared';

/** Lineas de contexto alrededor de cada cambio: para encontrar el lugar en la version nueva. */
const CONTEXT_LINES = 1;
/** Celdas de la tabla que compara el medio. Pasado esto, el medio va como un bloque. */
const MAX_CELLS = 250_000;
/** Lo que separa dos tramos de cambios. */
export const CHANGES_GAP: DiffLine = { kind: 'hunk', text: '…', oldLine: null, newLine: null };

/**
 * Los saltos de linea como los deja el cuadro de texto del navegador: `\r\n` y
 * `\r` pasan a `\n`. Asi se compara lo que se abrio con lo que se escribio.
 */
export function plainLineBreaks(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** Las lineas, sin la vacia que deja el salto del final. */
function linesOf(text: string): string[] {
  const lines = plainLineBreaks(text).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Las lineas que cambiaron de `opened` a `written`, con una de contexto. Vacia si no cambio nada. */
export function editChanges(opened: string, written: string): DiffLine[] {
  const a = linesOf(opened);
  const b = linesOf(written);

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  if (start === endA && start === endB) return [];

  const all: DiffLine[] = [];
  for (let index = 0; index < start; index += 1) all.push(same(a, index, index));
  compareMiddle(a, b, start, endA, start, endB, all);
  for (let index = endA, other = endB; index < a.length; index += 1, other += 1) all.push(same(a, index, other));
  return withContext(all);
}

function same(a: readonly string[], index: number, other: number): DiffLine {
  return { kind: 'context', text: a[index] ?? '', oldLine: index + 1, newLine: other + 1 };
}

function removed(a: readonly string[], index: number): DiffLine {
  return { kind: 'removed', text: a[index] ?? '', oldLine: index + 1, newLine: null };
}

function added(b: readonly string[], index: number): DiffLine {
  return { kind: 'added', text: b[index] ?? '', oldLine: null, newLine: index + 1 };
}

/**
 * El medio, por la subsecuencia comun mas larga. Lo quitado va antes que lo
 * agregado en cada tramo, que es como se lee "esta linea por esta otra".
 */
function compareMiddle(
  a: readonly string[],
  b: readonly string[],
  a0: number,
  a1: number,
  b0: number,
  b1: number,
  out: DiffLine[],
): void {
  const n = a1 - a0;
  const m = b1 - b0;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) {
    for (let index = a0; index < a1; index += 1) out.push(removed(a, index));
    for (let index = b0; index < b1; index += 1) out.push(added(b, index));
    return;
  }

  // common[i * width + j]: cuantas lineas comparten lo que queda desde a0+i y b0+j.
  const width = m + 1;
  const common = new Uint32Array((n + 1) * width);
  const at = (i: number, j: number): number => common[i * width + j] ?? 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      common[i * width + j] = a[a0 + i] === b[b0 + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out.push(same(a, a0 + i, b0 + j));
      i += 1;
      j += 1;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      out.push(removed(a, a0 + i));
      i += 1;
    } else {
      out.push(added(b, b0 + j));
      j += 1;
    }
  }
  for (; i < n; i += 1) out.push(removed(a, a0 + i));
  for (; j < m; j += 1) out.push(added(b, b0 + j));
}

/** Solo los cambios y su contexto, con una marca donde se salta algo. */
function withContext(all: readonly DiffLine[]): DiffLine[] {
  const changed = all.map((line) => line.kind !== 'context');
  const kept: DiffLine[] = [];
  let last = -1;
  all.forEach((line, index) => {
    let near = false;
    for (let offset = -CONTEXT_LINES; offset <= CONTEXT_LINES && !near; offset += 1) near = changed[index + offset] === true;
    if (!near) return;
    if (last !== -1 && index > last + 1) kept.push(CHANGES_GAP);
    kept.push(line);
    last = index;
  });
  return kept;
}
