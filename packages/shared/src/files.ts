/**
 * Modelo del arbol de archivos y la previsualizacion.
 *
 * Tres decisiones que se ven en los tipos:
 *
 *  1. **Las rutas son relativas al `cwd` de la pestana y siempre con `/`.**
 *     El cliente nunca manda una ruta absoluta, asi que el servidor no tiene
 *     que decidir si una ruta arbitraria es aceptable: la resuelve dentro del
 *     `cwd` o la rechaza. En un servidor que lanza procesos eso no es
 *     cosmetica.
 *  2. **Un nivel por peticion.** `DirectoryListing` no tiene hijos anidados.
 *     Un arbol completo de un repo real son cientos de miles de entradas y no
 *     hay ninguna razon para leerlas antes de que alguien las mire.
 *  3. **La previsualizacion viene recortada y marcada.** Un archivo de 40 MB
 *     no se transporta; se manda el principio y `truncated`.
 */

import {
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
} from './validation.js';

export type DirectoryEntryKind = 'dir' | 'file';

export const DIRECTORY_ENTRY_KINDS: readonly DirectoryEntryKind[] = ['dir', 'file'];

export interface DirectoryEntry {
  name: string;
  /** Ruta relativa al `cwd` de la pestana, con `/`. */
  path: string;
  kind: DirectoryEntryKind;
  /** 0 en los directorios. */
  sizeBytes: number;
  modifiedAt: number;
}

export interface DirectoryListing {
  /** Cadena vacia = raiz del `cwd`. */
  path: string;
  entries: DirectoryEntry[];
  /** true si el directorio tenia mas entradas de las que se transportan. */
  truncated: boolean;
  /** Cuantas entradas se ocultaron por `.gitignore` o por la lista fija. */
  hiddenCount: number;
}

export interface FilePreview {
  path: string;
  /** Pista para el resaltado, deducida de la extension. null si no se sabe. */
  language: string | null;
  text: string;
  sizeBytes: number;
  truncated: boolean;
  /** true si el archivo no es texto: no se manda contenido. */
  binary: boolean;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseDirectoryEntry(value: unknown): DirectoryEntry | null {
  const record = asRecord(value);
  if (record === null) return null;

  const name = asNonEmptyString(record['name']);
  const entryPath = asNonEmptyString(record['path']);
  const kind = asLiteral(record['kind'], DIRECTORY_ENTRY_KINDS);
  const sizeBytes = asFiniteNumber(record['sizeBytes']);
  const modifiedAt = asFiniteNumber(record['modifiedAt']);

  if (
    name === null ||
    entryPath === null ||
    kind === null ||
    sizeBytes === null ||
    modifiedAt === null
  ) {
    return null;
  }
  return { name, path: entryPath, kind, sizeBytes, modifiedAt };
}

export function parseDirectoryListing(value: unknown): DirectoryListing | null {
  const record = asRecord(value);
  if (record === null) return null;

  const listingPath = asString(record['path']);
  const entries = asArrayOf(record['entries'], parseDirectoryEntry);
  const hiddenCount = asFiniteNumber(record['hiddenCount']);
  if (listingPath === null || entries === null || hiddenCount === null) return null;

  return {
    path: listingPath,
    entries,
    truncated: record['truncated'] === true,
    hiddenCount,
  };
}

export function parseFilePreview(value: unknown): FilePreview | null {
  const record = asRecord(value);
  if (record === null) return null;

  const previewPath = asNonEmptyString(record['path']);
  const text = asString(record['text']);
  const sizeBytes = asFiniteNumber(record['sizeBytes']);
  const binary = asBoolean(record['binary']);
  if (previewPath === null || text === null || sizeBytes === null || binary === null) {
    return null;
  }

  return {
    path: previewPath,
    language: asString(record['language']),
    text,
    sizeBytes,
    truncated: record['truncated'] === true,
    binary,
  };
}

// ---------------------------------------------------------------------------
// Selector de carpetas
// ---------------------------------------------------------------------------

/**
 * Un paso del selector de carpetas: donde estamos y que hay adentro.
 *
 * Sirve para abrir un proyecto en una carpeta que la app todavia no conoce: la
 * barra lista lo que esta en el historial de la CLI mas el directorio desde el
 * que se lanzo el servidor, y una carpeta nueva no aparece en ninguno de los
 * dos.
 *
 * **El cliente nunca compone una ruta.** El servidor se queda con la ruta
 * actual del selector y el cliente solo puede nombrar *un segmento de lo que el
 * servidor le acaba de listar*, subir un nivel, o saltar a una de las raices.
 * Es el criterio de CLAUDE.md 2.4 aplicado a un caso nuevo: la ruta la elige el
 * servidor a partir de algo que el mismo mostro.
 *
 * Y se lista **solo el nombre de cada directorio**. Ni archivos, ni tamanios,
 * ni contenido: para elegir una carpeta no hace falta nada mas, y cada campo de
 * mas es superficie de lectura que la app no necesitaba.
 */
export interface DirectoryPickerListing {
  pickerId: string;
  /** Ruta absoluta actual. Se muestra; no se acepta de vuelta. */
  path: string;
  /** Nombres de los subdirectorios, ordenados. */
  entries: string[];
  /** Raices donde se puede saltar: unidades en Windows, `/` y `~` fuera. */
  roots: string[];
  /** false en una raiz: no hay a donde subir. */
  canGoUp: boolean;
  /** true si habia mas subdirectorios de los que se transportan. */
  truncated: boolean;
}

export function parseDirectoryPickerListing(value: unknown): DirectoryPickerListing | null {
  const record = asRecord(value);
  if (record === null) return null;

  const pickerId = asNonEmptyString(record['pickerId']);
  const listingPath = asNonEmptyString(record['path']);
  const entries = asArrayOf(record['entries'], (entry) => asNonEmptyString(entry));
  const roots = asArrayOf(record['roots'], (entry) => asNonEmptyString(entry));
  if (pickerId === null || listingPath === null || entries === null || roots === null) {
    return null;
  }

  return {
    pickerId,
    path: listingPath,
    entries,
    roots,
    canGoUp: record['canGoUp'] === true,
    truncated: record['truncated'] === true,
  };
}
