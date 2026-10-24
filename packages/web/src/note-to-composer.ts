/**
 * "Al cuadro" (hito 50, §6.6.2): una nota al cuadro de escritura de la pestaña
 * activa, para seguir escribiendo ahí y mandarla con el botón de siempre.
 *
 * "Mandar" (§6.6.1) abre una conversación nueva; esto va a la que ya existe, que
 * es donde está el agente que conoce el trabajo. Las imágenes entran como fichas,
 * en su orden y con los topes de un pegado, y la nota queda como estaba: cerrar
 * sigue siendo lo único que la borra.
 */

import type { NoteImage } from '@agent-workbench/shared';
import type { ComposerImage } from './useComposerAttachments.js';

/** Qué se escribe y desde dónde: lo que hay después de `from` se reemplaza por `inserted`. */
export interface NoteTextInsertion {
  from: number;
  inserted: string;
}

/**
 * El texto de la nota va al final de lo escrito, después de una línea en blanco,
 * y sin los espacios que sobraban al final. null si la nota no tiene texto.
 */
export function noteTextInsertion(current: string, noteText: string): NoteTextInsertion | null {
  const block = noteText.replace(/^\s*\n/, '').trimEnd();
  if (block.trim().length === 0) return null;
  const kept = current.trimEnd();
  return { from: kept.length, inserted: kept.length === 0 ? block : `\n\n${block}` };
}

/**
 * Las imágenes de la nota, listas para ser fichas del cuadro, en su orden. Van
 * las que el navegador ya tiene (las miniaturas se piden al dibujarse); una que
 * la PC ya no encuentra (`null`) no va. `name` arma el nombre de cada una.
 */
export function noteImagesForComposer(
  images: readonly NoteImage[],
  loaded: Readonly<Record<string, string | null>>,
  name: (index: number) => string,
): ComposerImage[] {
  const result: ComposerImage[] = [];
  images.forEach((image, index) => {
    const dataUrl = loaded[image.imageId];
    if (typeof dataUrl !== 'string') return;
    const parsed = parseDataUrl(dataUrl);
    if (parsed === null) return;
    result.push({ ...parsed, dataUrl, name: name(index) });
  });
  return result;
}

/** Si el navegador ya tiene todas las imágenes de la nota: hasta entonces el botón espera. */
export function noteImagesReady(
  images: readonly NoteImage[],
  loaded: Readonly<Record<string, string | null>>,
): boolean {
  return images.every((image) => loaded[image.imageId] !== undefined);
}

/**
 * El tipo, los datos y el peso de un `data:<tipo>;base64,<datos>`, o null si no
 * tiene esa forma. El peso sale del largo del base64, sin decodificarlo.
 */
export function parseDataUrl(dataUrl: string): { mediaType: string; base64: string; bytes: number } | null {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(dataUrl);
  const mediaType = match?.[1];
  const base64 = match?.[2];
  if (mediaType === undefined || base64 === undefined) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return { mediaType, base64, bytes: (base64.length / 4) * 3 - padding };
}
