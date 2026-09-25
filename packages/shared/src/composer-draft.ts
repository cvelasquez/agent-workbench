/**
 * Lo escrito en el cuadro de una pestana y todavia no mandado, tal como se
 * guarda entre arranques (mejoras de la 0.4.0, §6.29).
 *
 * Pedido del usuario: alguien escribe un pedido largo, tiene que apagar la PC
 * antes de mandarlo, y al dia siguiente el cuadro de esa pestana estaba vacio.
 * El borrador ya sobrevivia a cambiar de pestana, pero vivia en la memoria de
 * la pagina.
 *
 * **Se guarda el texto y los textos pegados** (§6.24), que son texto. **Las
 * imagenes y los archivos adjuntos no**: pesan megas, ya viven en la carpeta
 * temporal y reescribirlos en cada pausa del teclado no tiene sentido.
 *
 * El borrador viaja por `terminalId`, pero el servidor lo guarda por la
 * conversacion de la pestana, `(agent, sessionId)`: el id de la pestana cambia
 * en cada arranque y el de la conversacion no.
 */

import { asArrayOf, asRecord, asString } from './validation.js';

/** Un texto pegado del borrador: su numero, el de su marca en lo escrito, y lo pegado. */
export interface ComposerDraftPaste {
  number: number;
  text: string;
}

export interface ComposerDraft {
  /** Lo escrito, con las marcas de los textos pegados donde se pegaron. */
  text: string;
  /** Los textos pegados, en el orden de sus fichas. */
  pasted: ComposerDraftPaste[];
}

/**
 * El tope de un borrador, contando lo escrito y lo pegado. A mano no se llega:
 * es para un log enorme pegado, que reescrito en cada pausa del teclado haria
 * pesar el archivo megas. Pasado el tope no se guarda, y el cuadro lo dice.
 */
export const MAX_COMPOSER_DRAFT_CHARS = 1_000_000;

/** Cuantos textos pegados, como mucho. El numero de una marca tiene hasta seis cifras. */
export const MAX_COMPOSER_DRAFT_PASTES = 100;

const MAX_PASTE_NUMBER = 999_999;

/** Cuanto pesa, en caracteres: lo escrito mas lo pegado. */
export function composerDraftChars(draft: ComposerDraft): number {
  return draft.pasted.reduce((total, paste) => total + paste.text.length, draft.text.length);
}

/**
 * Vacio es no tener nada que guardar: ni texto con algo mas que espacios, ni
 * un texto pegado con algo adentro. Un borrador vacio borra el guardado.
 */
export function isEmptyComposerDraft(draft: ComposerDraft): boolean {
  return draft.text.trim().length === 0 && draft.pasted.every((paste) => paste.text.trim().length === 0);
}

/** Los dos dicen lo mismo, en el mismo orden. */
export function sameComposerDraft(a: ComposerDraft, b: ComposerDraft): boolean {
  if (a.text !== b.text || a.pasted.length !== b.pasted.length) return false;
  return a.pasted.every((paste, index) => {
    const other = b.pasted[index];
    return other !== undefined && other.number === paste.number && other.text === paste.text;
  });
}

function parseComposerDraftPaste(value: unknown): ComposerDraftPaste | null {
  const record = asRecord(value);
  if (record === null) return null;
  const number = record['number'];
  const text = asString(record['text']);
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1 || number > MAX_PASTE_NUMBER) return null;
  return text === null ? null : { number, text };
}

/**
 * Un borrador que llego por la red o de disco. Solo la forma: el tope lo hace
 * cumplir quien guarda (`DraftStore`), que asi puede decir por que no guardo.
 * Dos textos pegados con el mismo numero no son un borrador: sus marcas serian
 * la misma.
 */
export function parseComposerDraft(value: unknown): ComposerDraft | null {
  const record = asRecord(value);
  if (record === null) return null;
  const text = asString(record['text']);
  const pasted = asArrayOf(record['pasted'], parseComposerDraftPaste);
  if (text === null || pasted === null || pasted.length > MAX_COMPOSER_DRAFT_PASTES) return null;
  if (new Set(pasted.map((paste) => paste.number)).size !== pasted.length) return null;
  return { text, pasted };
}
