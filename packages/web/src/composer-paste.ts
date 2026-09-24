/**
 * Los textos pegados del cuadro de escritura: numero, marca y bloque (hito 35,
 * §6.24).
 *
 * Un texto largo pegado queda como ficha arriba del cuadro, y hasta el hito 35
 * se mandaba asi, arriba y sin nada que lo separara de lo escrito: dos textos
 * pegados y una pregunta llegaban a la CLI como un solo texto. Ahora cada uno
 * lleva un numero, deja una marca donde se pego (`[Pasted text #1]`) y viaja
 * entre una linea de inicio y una de fin. El modelo sabe donde empieza y
 * termina cada uno, y a cual se refiere cada parte de lo escrito.
 *
 * **Las marcas van siempre en ingles** (D1 del hito 35): lo que se le manda a
 * la CLI en lenguaje natural no depende del idioma de la interfaz. Por lo
 * mismo, el hilo las reconoce siempre, tambien despues de cambiar de idioma.
 * La etiqueta de la ficha si se traduce: es interfaz. El formato vive en
 * `shared/pasted-text.ts`, porque el servidor lo lee para los titulos.
 *
 * Puro y sin React, para que `pnpm check` lo pueda importar: la web no tiene
 * tests (`check-composer-input.mjs`).
 */

import {
  pasteEndLine,
  pasteReference,
  pasteReferencePattern,
  pasteStartLine,
  pastedBlockPattern,
  pastedBlockStartPattern,
} from '@agent-workbench/shared';
import { t } from './i18n/index.js';

export { pasteEndLine, pasteReference, pasteStartLine };

/**
 * Cuantas lineas tiene un texto pegado, para la ficha y para el hilo. Un salto
 * al final no cuenta como otra linea.
 */
export function pastedLineCount(text: string): number {
  const trimmed = text.replace(/(\r?\n)+$/, '');
  return trimmed.length === 0 ? 0 : trimmed.split('\n').length;
}

/** La etiqueta de la ficha del cuadro: `#1 · Texto pegado · 6 lineas`. */
export function pastedChipLabel(n: number, lines: number): string {
  return lines === 0
    ? t('composer.chip.pastedTextEmpty', { number: n })
    : t('composer.chip.pastedText', { number: n, count: lines });
}

/**
 * El numero del texto pegado siguiente: uno mas que el mayor en uso. Quien
 * llama junta los de las fichas y los de las marcas que siguen en lo escrito
 * (`referencedPasteNumbers`): asi una marca que quedo —escrita a mano, o de una
 * ficha ya quitada— no termina nombrando a otro texto.
 */
export function nextPasteNumber(numbers: readonly number[]): number {
  return numbers.length === 0 ? 1 : Math.max(...numbers) + 1;
}

/** Los numeros de las marcas que hay en lo escrito, sin repetir y en orden. */
export function referencedPasteNumbers(text: string): number[] {
  const found = new Set<number>();
  for (const match of text.matchAll(pasteReferencePattern())) found.add(Number(match[1]));
  return [...found].sort((a, b) => a - b);
}

export interface ReferenceInsertion {
  /** Lo escrito, con la marca (o la ruta). */
  readonly text: string;
  /** Lo que se inserto: la marca, con un espacio a cada lado si hacia falta. */
  readonly inserted: string;
  /** Donde queda el cursor: despues de lo insertado. */
  readonly caret: number;
}

/**
 * Lo que pide un espacio antes de la marca: una letra, un numero o una
 * puntuacion que no abre. No lo piden `( [ {`, las comillas ni los signos de
 * apertura del espanol (`¿`, `¡`, `«`).
 */
const NEEDS_SPACE_BEFORE = /[^\s([{"'¿¡«]/u;
/** Lo que pide un espacio despues: una letra o un numero pegados. */
const NEEDS_SPACE_AFTER = /[\p{L}\p{N}]/u;

/**
 * Pone la marca donde esta el cursor, reemplazando lo seleccionado, como un
 * pegado cualquiera. Agrega un espacio antes si la marca quedaria pegada a una
 * palabra, y uno despues si quedaria pegada a la siguiente.
 */
export function insertPasteReference(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  n: number,
): ReferenceInsertion {
  const { start, end, before, after } = aroundSelection(text, selectionStart, selectionEnd);
  const inserted = `${before !== '' && NEEDS_SPACE_BEFORE.test(before) ? ' ' : ''}${pasteReference(n)}${
    after !== '' && NEEDS_SPACE_AFTER.test(after) ? ' ' : ''
  }`;
  return spliceInsertion(text, start, end, inserted);
}

/**
 * Lo que pide un espacio antes de una ruta: como con la marca, pero tambien una
 * comilla, porque una ruta termina en comillas y dos seguidas no pueden quedar
 * pegadas (`"a""b"`).
 */
const PATH_NEEDS_SPACE_BEFORE = /[^\s([{¿¡«]/u;
/** Lo que pide un espacio despues: una letra, un numero o una comilla pegados. */
const PATH_NEEDS_SPACE_AFTER = /[\p{L}\p{N}"'«]/u;

/**
 * Pone una ruta del arbol de archivos donde esta el cursor (§6.4), reemplazando
 * lo seleccionado, con los espacios que hagan falta a cada lado. Al final de lo
 * escrito deja uno mas, para seguir escribiendo o poner otra ruta.
 */
export function insertPathAtCursor(
  text: string,
  selectionStart: number,
  selectionEnd: number,
  path: string,
): ReferenceInsertion {
  const { start, end, before, after } = aroundSelection(text, selectionStart, selectionEnd);
  const spaceBefore = before !== '' && PATH_NEEDS_SPACE_BEFORE.test(before);
  const spaceAfter = after === '' || PATH_NEEDS_SPACE_AFTER.test(after);
  const inserted = `${spaceBefore ? ' ' : ''}${path}${spaceAfter ? ' ' : ''}`;
  return spliceInsertion(text, start, end, inserted);
}

/** La seleccion dentro del texto, y lo que queda justo antes y justo despues. */
function aroundSelection(
  text: string,
  selectionStart: number,
  selectionEnd: number,
): { start: number; end: number; before: string; after: string } {
  const start = Math.max(0, Math.min(selectionStart, text.length));
  const end = Math.max(start, Math.min(selectionEnd, text.length));
  return {
    start,
    end,
    before: start > 0 ? text.charAt(start - 1) : '',
    after: end < text.length ? text.charAt(end) : '',
  };
}

function spliceInsertion(text: string, start: number, end: number, inserted: string): ReferenceInsertion {
  return {
    text: `${text.slice(0, start)}${inserted}${text.slice(end)}`,
    inserted,
    caret: start + inserted.length,
  };
}

/**
 * Quita todas las marcas de un texto pegado, y el espacio que la separaba: al
 * quitar la ficha con ×, su marca no queda nombrando a nada. La de otro numero
 * no se toca: `#1` no es el comienzo de `#10`.
 */
export function removePasteReferences(text: string, n: number): string {
  const pattern = new RegExp(`( ?)${escapeRegExp(pasteReference(n))}( ?)`, 'g');
  return text.replace(pattern, (_match, before: string, after: string) => (before !== '' && after !== '' ? ' ' : ''));
}

export interface PastedBlock {
  readonly number: number;
  readonly text: string;
}

/**
 * El mensaje que se manda: cada texto pegado entre su linea de inicio y la de
 * fin, en el orden de las fichas, y lo escrito debajo (D2). Es el orden de la
 * pantalla, que es lo unico que lo hace predecible.
 *
 * Un texto pegado que se vacio al editarlo no se manda, y su marca sale de lo
 * escrito: no puede nombrar un bloque que no esta.
 */
export function assembleMessage(blocks: readonly PastedBlock[], typed: string): string {
  let body = typed;
  const pieces: string[] = [];
  for (const block of blocks) {
    const content = block.text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (content.trim().length === 0) {
      body = removePasteReferences(body, block.number);
      continue;
    }
    pieces.push(`${pasteStartLine(block.number)}\n${content}\n${pasteEndLine(block.number)}`);
  }
  if (body.trim().length > 0) pieces.push(body);
  return pieces.join('\n\n');
}

export type MessageSegment =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'pasted';
      readonly number: number;
      readonly text: string;
      /** false si el mensaje llego recortado antes de la linea de fin. */
      readonly complete: boolean;
    };

/**
 * Parte un mensaje propio en lo escrito y los textos pegados, en su orden, para
 * que el hilo muestre cada bloque plegado (D3).
 *
 * Solo cuenta un bloque con su inicio al principio de una linea y el fin del
 * mismo numero. Sin ninguno, devuelve el mensaje tal cual, sin tocarlo: un
 * mensaje sin textos pegados se ve como siempre. `truncated` es el recorte del
 * transporte: ahi un inicio sin su fin es el ultimo bloque, cortado.
 */
export function splitPastedBlocks(text: string, truncated = false): MessageSegment[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  const segments: MessageSegment[] = [];
  const pushText = (piece: string): void => {
    const clean = piece.replace(/^\n+|\n+$/g, '');
    if (clean.trim().length > 0) segments.push({ kind: 'text', text: clean });
  };

  let cursor = 0;
  for (const match of normalized.matchAll(pastedBlockPattern())) {
    const lead = match[1] ?? '';
    const start = (match.index ?? 0) + lead.length;
    pushText(normalized.slice(cursor, start));
    segments.push({ kind: 'pasted', number: Number(match[2]), text: match[3] ?? '', complete: true });
    cursor = (match.index ?? 0) + match[0].length;
  }

  const rest = normalized.slice(cursor);
  const open = truncated ? pastedBlockStartPattern().exec(rest) : null;
  if (open !== null) {
    const start = open.index + (open[1] ?? '').length;
    pushText(rest.slice(0, start));
    segments.push({ kind: 'pasted', number: Number(open[2]), text: rest.slice(open.index + open[0].length), complete: false });
  } else {
    pushText(rest);
  }

  if (!segments.some((segment) => segment.kind === 'pasted')) return [{ kind: 'text', text }];
  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
