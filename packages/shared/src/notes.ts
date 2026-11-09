/**
 * Notas sueltas: ideas que se anotan mientras se trabaja.
 *
 * No pertenecen a ningun proyecto ni a ninguna pestana. Viven en el directorio
 * de configuracion propio y duran hasta que el usuario las cierra; cerrar una
 * nota **si** la borra, con sus imagenes, y por eso el cliente pide confirmar
 * cuando la nota tiene algo adentro.
 *
 * Las imagenes viajan por referencia (`imageId`) y el contenido se pide aparte
 * cuando la miniatura se dibuja, igual que las del historial: una nota con diez
 * capturas no tiene por que pesar megas en cada lista.
 */

import { asArrayOf, asFiniteNumber, asNonEmptyString, asRecord, asString } from './validation.js';

/** Mas que esto no es una nota, es un documento. */
export const MAX_NOTE_TEXT_CHARS = 100_000;
export const MAX_NOTE_IMAGES = 20;
export const MAX_NOTE_FILES = 20;
export const MAX_NOTES = 100;

/** Forma valida de un id generado en el cliente. Solo se usa como clave. */
const ID_PATTERN = /^[a-zA-Z0-9-]{1,64}$/;

export function isValidNoteId(value: string): boolean {
  return ID_PATTERN.test(value);
}

export interface NoteImage {
  imageId: string;
  mediaType: string;
  bytes: number;
}

export interface NoteFile {
  fileId: string;
  name: string;
  bytes: number;
}

export interface Note {
  noteId: string;
  text: string;
  images: NoteImage[];
  /** Ausente en notas de versiones anteriores. */
  files?: NoteFile[];
  createdAt: number;
  updatedAt: number;
}

/**
 * Titulo para la solapa: la primera linea con algo escrito, recortada.
 *
 * No hay campo de titulo aparte a proposito: una nota rapida no se nombra, se
 * escribe, y el titulo sale solo de lo que dice.
 */
export function noteTitle(note: Note, fallback = 'Nota'): string {
  const line = note.text
    .split('\n')
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return note.files?.[0]?.name ?? (note.images.length > 0 ? 'Imagen' : fallback);
  return line.length > 40 ? `${line.slice(0, 40)}…` : line;
}

export function parseNoteImage(value: unknown): NoteImage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const imageId = asNonEmptyString(record['imageId']);
  const mediaType = asNonEmptyString(record['mediaType']);
  const bytes = asFiniteNumber(record['bytes']);
  return imageId === null || mediaType === null || bytes === null
    ? null
    : { imageId, mediaType, bytes };
}

export function parseNoteFile(value: unknown): NoteFile | null {
  const record = asRecord(value);
  if (record === null) return null;
  const fileId = asNonEmptyString(record['fileId']);
  const name = asNonEmptyString(record['name']);
  const bytes = asFiniteNumber(record['bytes']);
  return fileId === null || name === null || bytes === null || !isValidNoteId(fileId) || bytes < 0 || !Number.isInteger(bytes)
    ? null
    : { fileId, name, bytes };
}

export function parseNote(value: unknown): Note | null {
  const record = asRecord(value);
  if (record === null) return null;
  const noteId = asNonEmptyString(record['noteId']);
  const text = asString(record['text']);
  const images = asArrayOf(record['images'], parseNoteImage);
  const files = record['files'] === undefined ? [] : asArrayOf(record['files'], parseNoteFile);
  const createdAt = asFiniteNumber(record['createdAt']);
  const updatedAt = asFiniteNumber(record['updatedAt']);
  if (noteId === null || text === null || images === null || files === null) return null;
  return {
    noteId,
    text,
    images,
    files,
    createdAt: createdAt ?? 0,
    updatedAt: updatedAt ?? 0,
  };
}
