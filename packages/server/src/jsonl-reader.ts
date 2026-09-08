/**
 * Lectura parcial de archivos JSONL.
 *
 * Por que existe este archivo en vez de un `readFile` y un `split`:
 * medido sobre las 228 sesiones de esta instalacion, **una sola linea puede
 * pesar 290 KB** (adjuntos, snapshots de archivos), y cubrir las primeras 25
 * lineas del peor caso requiere 372 KB. Leer "los primeros 64 KB" deja al
 * indexador sin `cwd` y sin titulo justo en los archivos mas grandes.
 *
 * Asi que se lee en bloques y se cortan lineas de verdad, con dos topes: uno de
 * lineas y otro de bytes, para que un archivo patologico no se lleve la memoria.
 */

import { open } from 'node:fs/promises';

/** Tamano de cada lectura. Ni tan chico que multiplique syscalls, ni tan grande. */
const CHUNK_SIZE = 64 * 1024;

export interface HeadReadOptions {
  /** Cuantas lineas completas devolver como maximo. */
  maxLines: number;
  /** Tope duro de bytes leidos, por si las lineas son enormes. */
  maxBytes: number;
}

export interface TailReadOptions {
  /** Cuantos bytes leer desde el final. */
  maxBytes: number;
}

/**
 * Primeras `maxLines` lineas completas del archivo.
 *
 * Si el tope de bytes se alcanza a mitad de una linea, esa linea incompleta se
 * descarta: media linea no parsea y meterla solo genera ruido.
 */
export async function readHeadLines(
  filePath: string,
  options: HeadReadOptions,
): Promise<string[]> {
  const handle = await open(filePath, 'r');
  try {
    const lines: string[] = [];
    let pending = '';
    let position = 0;
    const buffer = Buffer.allocUnsafe(CHUNK_SIZE);

    while (position < options.maxBytes && lines.length < options.maxLines) {
      const toRead = Math.min(CHUNK_SIZE, options.maxBytes - position);
      const { bytesRead } = await handle.read(buffer, 0, toRead, position);
      if (bytesRead === 0) break;
      position += bytesRead;

      pending += buffer.toString('utf8', 0, bytesRead);

      let newlineIndex = pending.indexOf('\n');
      while (newlineIndex !== -1 && lines.length < options.maxLines) {
        const line = pending.slice(0, newlineIndex).trim();
        if (line.length > 0) lines.push(line);
        pending = pending.slice(newlineIndex + 1);
        newlineIndex = pending.indexOf('\n');
      }
    }

    // `pending` es una linea sin terminar: solo vale si es el final del archivo,
    // y ni asi la necesitamos para el indice.
    return lines;
  } finally {
    await handle.close();
  }
}

/**
 * Ultimas lineas completas del archivo.
 *
 * Se lee un bloque desde el final y se tira la primera linea, que casi siempre
 * quedo cortada por la mitad.
 */
export async function readTailLines(
  filePath: string,
  options: TailReadOptions,
): Promise<string[]> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size === 0) return [];

    const readSize = Math.min(options.maxBytes, size);
    const start = size - readSize;
    const buffer = Buffer.allocUnsafe(readSize);
    await handle.read(buffer, 0, readSize, start);

    const text = buffer.toString('utf8');
    const lines = text.split('\n');

    // Si no empezamos desde el byte 0, la primera linea esta cortada.
    if (start > 0) lines.shift();

    return lines.map((line) => line.trim()).filter((line) => line.length > 0);
  } finally {
    await handle.close();
  }
}

/**
 * Parsea una linea JSONL a objeto plano.
 *
 * Devuelve null en vez de lanzar: el esquema cambia entre versiones de la CLI y
 * el indexador nunca puede caerse por una linea que no entiende.
 */
export function parseJsonlLine(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
