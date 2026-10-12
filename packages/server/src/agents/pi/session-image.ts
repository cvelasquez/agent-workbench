/**
 * Trae una imagen concreta de una sesion de Pi, cuando alguien la mira.
 *
 * Los eventos que viajan al navegador no llevan bytes: llevan la referencia
 * —`eventId`, posicion y de donde sale—, y el contenido se busca aca. Dos
 * formas (CLAUDE.md 16.3):
 *
 *  - `content`: un bloque `{type:"image", data, mimeType}` dentro del mensaje.
 *  - `pasted`: una imagen del cuadro de escritura. Pi no adjunta lo pegado: el
 *    mensaje la nombra por ruta en una linea propia y el modelo la abre con su
 *    herramienta de lectura. Los bytes salen del archivo que dejo `PasteStore`,
 *    mientras exista, o del resultado de esa lectura, que queda en la sesion.
 *
 * La busqueda recorre el archivo linea a linea: es una accion puntual, no algo
 * que pase solo.
 */

import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { MAX_SUBMIT_IMAGE_BYTES, asRecord, type ConversationImageSource } from '@agent-workbench/shared';
import { detectImageFormat } from '../../image-signature.js';
import { parseJsonlLine } from '../../jsonl-reader.js';
import { pasteRoot } from '../../paste-paths.js';
import { resolveInside } from '../../path-guard.js';
import type { LoadedImage } from '../adapter.js';
import { pastedImagePaths } from './session-entries.js';

/** El base64 ocupa ~4/3 de lo que pesa la imagen. */
function tooBig(data: string): boolean {
  return data.length > MAX_SUBMIT_IMAGE_BYTES * 1.4;
}

function imageOf(block: Record<string, unknown> | null): LoadedImage | null {
  if (block === null || block['type'] !== 'image') return null;
  const data = block['data'];
  const mediaType = block['mimeType'];
  if (typeof data !== 'string' || data.length === 0 || tooBig(data)) return null;
  return { mediaType: typeof mediaType === 'string' && mediaType.length > 0 ? mediaType : 'image/png', data };
}

function blocksOf(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.['content'];
  if (!Array.isArray(content)) return [];
  return content.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => item !== null);
}

function textOf(message: Record<string, unknown> | null): string {
  const content = message?.['content'];
  if (typeof content === 'string') return content;
  return blocksOf(message)
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n');
}

function sameFile(a: string, b: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.normalize(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };
  return normalize(a) === normalize(b);
}

/**
 * Los bytes que dejo `PasteStore`, si siguen ahi y son de una imagen.
 *
 * La ruta sale del texto del mensaje, asi que pasa por el guardia de rutas
 * contra la carpeta de lo pegado: un `..` o un enlace hacia afuera no se leen
 * (regla 2.4). Gana la firma de los bytes, no la extension.
 */
async function readPastedFile(target: string, pastedDir: string): Promise<LoadedImage | null> {
  try {
    const inside = await resolveInside(pastedDir, path.relative(pastedDir, target), { mustExist: true });
    const info = await stat(inside);
    if (!info.isFile() || info.size === 0 || info.size > MAX_SUBMIT_IMAGE_BYTES) return null;
    const bytes = await readFile(inside);
    const format = detectImageFormat(bytes);
    return format === null ? null : { mediaType: format.mediaType, data: bytes.toString('base64') };
  } catch {
    // Ya no esta —la pestana se cerro—, o la ruta no es de la carpeta.
    return null;
  }
}

/** El id de la llamada de lectura de esa linea que abrio `target`, o null. */
function readCallOf(record: Record<string, unknown>, target: string): string | null {
  const message = asRecord(record['message']);
  if (record['type'] !== 'message' || message?.['role'] !== 'assistant') return null;
  for (const block of blocksOf(message)) {
    if (block['type'] !== 'toolCall') continue;
    const id = block['id'];
    const filePath = asRecord(block['arguments'])?.['path'];
    if (typeof id === 'string' && id.length > 0 && typeof filePath === 'string' && sameFile(filePath, target)) return id;
  }
  return null;
}

/**
 * La imagen `index` del mensaje `eventId`, o null si no esta: el archivo pudo
 * cambiar, o la imagen del cuadro ya no existe y el modelo nunca la abrio.
 *
 * `pastedDir` es la carpeta de lo pegado; solo la cambian los chequeos.
 */
export async function loadPiImage(
  file: string,
  eventId: string,
  index: number,
  source: ConversationImageSource,
  pastedDir: string = pasteRoot(),
): Promise<LoadedImage | null> {
  if (source === 'attachment' || !Number.isInteger(index) || index < 0) return null;

  try {
    if (!(await stat(file)).isFile()) return null;
  } catch {
    return null;
  }
  const stream = createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  // Un error de lectura a mitad (el archivo se borro) corta la busqueda, no el servidor.
  stream.on('error', () => lines.close());

  /** La ruta de la imagen del cuadro, desde que se encontro el mensaje. */
  let target: string | null = null;
  /** La llamada de lectura que la abrio, mientras se espera su resultado. */
  let readId: string | null = null;

  try {
    for await (const line of lines) {
      if (target === null) {
        // Filtro barato antes de parsear: casi ninguna linea es la que se busca.
        if (!line.includes(eventId)) continue;
        const record = parseJsonlLine(line);
        if (record === null || record['id'] !== eventId || record['type'] !== 'message') continue;
        const message = asRecord(record['message']);
        if (message?.['role'] !== 'user') return null;

        if (source === 'content') {
          const images = blocksOf(message).filter((block) => block['type'] === 'image');
          return imageOf(images[index] ?? null);
        }
        target = pastedImagePaths(textOf(message))[index] ?? null;
        if (target === null) return null;
        const fromDisk = await readPastedFile(target, pastedDir);
        if (fromDisk !== null) return fromDisk;
        continue;
      }

      // Despues del mensaje: la lectura del modelo sobre esa ruta, y su resultado.
      if (readId === null) {
        if (!line.includes('"toolCall"')) continue;
        const record = parseJsonlLine(line);
        readId = record === null ? null : readCallOf(record, target);
        continue;
      }
      if (!line.includes('"toolResult"')) continue;
      const record = parseJsonlLine(line);
      const message = record === null ? null : asRecord(record['message']);
      if (message === null || message['role'] !== 'toolResult' || message['toolCallId'] !== readId) continue;
      for (const block of blocksOf(message)) {
        const image = imageOf(block);
        if (image !== null) return image;
      }
      // Esa lectura no la trajo —un error, un archivo que ya no estaba—: puede haber otra.
      readId = null;
    }
  } catch {
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
  return null;
}
