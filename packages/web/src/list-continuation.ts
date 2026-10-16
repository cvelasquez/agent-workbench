/**
 * La lista que sigue sola con Shift+Enter en el cuadro de escritura (hito 44,
 * pedido del usuario el 15-10-2026).
 *
 * En una linea que empieza con `1. `, `2) `, `a) `, `- ` o `* `, el salto de
 * linea agrega el marcador siguiente (`2. `, `3) `, `b) `, la misma viñeta),
 * con la misma sangria. En un item vacio, en cambio, quita el marcador y
 * termina la lista, como un editor. Si debajo siguen items numerados, se
 * renumeran: insertar entre el 1 y el 2 deja 1, 2, 3.
 *
 * Dos limites a proposito: numeros de hasta tres cifras (un año como `2024. `
 * al principio de una linea no es una lista), y letras solo con parentesis
 * (`A. Perez` o `e. g.` tampoco lo son).
 *
 * Puro: lo prueba `check-prompt-editing.mjs`. Quien lo usa escribe el cambio
 * como si fuera tecleado, para que Ctrl+Z lo saque.
 */

/** Un cambio al texto del cuadro: reemplazar `[from, to)` por `text` y dejar el cursor en `caret`. */
export interface ListEdit {
  from: number;
  to: number;
  text: string;
  caret: number;
}

interface Marker {
  kind: 'number' | 'letter' | 'bullet';
  indent: string;
  /** El numero, o la posicion de la letra (a = 0); 0 en una viñeta. */
  value: number;
  /** Mayuscula, en una letra. */
  upper: boolean;
  /** `.` o `)` en un numero, `)` en una letra, el simbolo en una viñeta. */
  sep: string;
  /** Lo que separa el marcador del texto. */
  space: string;
  /** Cuanto ocupa el marcador con su sangria y su espacio. */
  length: number;
}

const NUMBERED = /^([ \t]*)(\d{1,3})([.)])([ \t]+)/;
const LETTERED = /^([ \t]*)([a-zA-Z])\)([ \t]+)/;
const BULLETED = /^([ \t]*)([-*•])([ \t]+)/;

function parseMarker(line: string): Marker | null {
  const numbered = NUMBERED.exec(line);
  if (numbered !== null) {
    const [whole, indent = '', digits = '', sep = '.', space = ' '] = numbered;
    return { kind: 'number', indent, value: Number(digits), upper: false, sep, space, length: whole.length };
  }
  const lettered = LETTERED.exec(line);
  if (lettered !== null) {
    const [whole, indent = '', letter = 'a', space = ' '] = lettered;
    return {
      kind: 'letter',
      indent,
      value: letter.toLowerCase().charCodeAt(0) - 97,
      upper: letter !== letter.toLowerCase(),
      sep: ')',
      space,
      length: whole.length,
    };
  }
  const bulleted = BULLETED.exec(line);
  if (bulleted !== null) {
    const [whole, indent = '', bullet = '-', space = ' '] = bulleted;
    return { kind: 'bullet', indent, value: 0, upper: false, sep: bullet, space, length: whole.length };
  }
  return null;
}

/** El marcador con otro valor, o null si no hay siguiente (despues de la z). */
function render(marker: Marker, value: number): string | null {
  if (marker.kind === 'bullet') return `${marker.indent}${marker.sep}${marker.space}`;
  if (marker.kind === 'number') return `${marker.indent}${value}${marker.sep}${marker.space}`;
  if (value > 25) return null;
  const letter = String.fromCharCode(97 + value);
  return `${marker.indent}${marker.upper ? letter.toUpperCase() : letter}${marker.sep}${marker.space}`;
}

/** true si las dos lineas son items de la misma lista. */
function sameList(a: Marker, b: Marker): boolean {
  return a.kind === b.kind && a.indent === b.indent && a.sep === b.sep && a.upper === b.upper;
}

/**
 * Lo que hace Shift+Enter en `value` con la seleccion `[start, end)`, o null
 * si no es una lista y el salto de linea es el de siempre.
 */
export function continueList(value: string, start: number, end: number): ListEdit | null {
  if (start !== end) return null;
  const lineStart = value.lastIndexOf('\n', start - 1) + 1;
  const found = value.indexOf('\n', start);
  const lineEnd = found === -1 ? value.length : found;
  const line = value.slice(lineStart, lineEnd);
  const marker = parseMarker(line);
  // Sin marcador, o con el cursor adentro de el: el salto de linea de siempre.
  if (marker === null || start - lineStart < marker.length) return null;

  // Un item vacio termina la lista: se quita su marcador.
  if (line.slice(marker.length).trim().length === 0) {
    return { from: lineStart, to: lineEnd, text: '', caret: lineStart };
  }

  const next = render(marker, marker.value + 1);
  if (next === null) return null;

  // Los items que siguen debajo, si los hay, corren un lugar.
  let renumbered = '';
  let blockEnd = lineEnd;
  if (marker.kind !== 'bullet') {
    let expected = marker.value + 1;
    while (blockEnd < value.length) {
      const followingStart = blockEnd + 1;
      const followingFound = value.indexOf('\n', followingStart);
      const followingEnd = followingFound === -1 ? value.length : followingFound;
      const followingLine = value.slice(followingStart, followingEnd);
      const following = parseMarker(followingLine);
      if (following === null || !sameList(marker, following) || following.value !== expected) break;
      const shifted = render(following, following.value + 1);
      if (shifted === null) break;
      renumbered += `\n${shifted}${followingLine.slice(following.length)}`;
      expected += 1;
      blockEnd = followingEnd;
    }
  }

  return {
    from: start,
    to: blockEnd,
    text: `\n${next}${value.slice(start, lineEnd)}${renumbered}`,
    caret: start + 1 + next.length,
  };
}
