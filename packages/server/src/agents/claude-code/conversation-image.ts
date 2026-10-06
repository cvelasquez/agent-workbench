/**
 * Trae una imagen concreta del archivo de sesion, cuando alguien la mira.
 *
 * Las imagenes viven en el JSONL como base64 dentro de la linea del mensaje.
 * Los eventos que viajan al navegador **no** las llevan: una conversacion con
 * quince capturas pegadas serian varios MB en cada carga. Lo que viaja es la
 * referencia —`eventId` mas la posicion del bloque— y el contenido se busca
 * aca, una vez, cuando la miniatura entra en pantalla.
 *
 * La busqueda recorre el archivo linea a linea porque el `uuid` no esta
 * indexado en ningun lado. Es una lectura completa de un archivo que puede
 * pesar 3 MB, y por eso es una accion puntual y no algo que pase solo.
 *
 * La unica que puede salir de otro lado es la de un mensaje encolado: la CLI no
 * la adjunta, y mientras el agente no la lea esta solo en la carpeta de lo
 * pegado (`findPastedImage`).
 */

import { MAX_SUBMIT_IMAGE_BYTES, type ConversationImageSource } from '@agent-workbench/shared';
import { open, readFile, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { detectImageFormat } from '../../image-signature.js';
import { parseJsonlLine } from '../../jsonl-reader.js';
import { pasteRoot } from '../../paste-paths.js';
import { resolveInside } from '../../path-guard.js';
import type { LoadedImage } from '../adapter.js';
import { queuedPastedImages, recordOf, sameFilePath } from './jsonl-events.js';

const CHUNK_SIZE = 256 * 1024;
const NEWLINE = 0x0a;

/**
 * Tope de lo que se devuelve.
 *
 * Es el mismo que acepta el cuadro de escritura, y tiene que serlo: con un tope
 * mas bajo aca, una imagen que la app dejo mandar despues no se puede ver en el
 * hilo donde se mando.
 */
export const MAX_IMAGE_BYTES = MAX_SUBMIT_IMAGE_BYTES;

/**
 * Busca la imagen `index` del mensaje `eventId`.
 *
 * `source` dice en cual de las tres formas buscarla (ver
 * `ConversationImageSource`): dentro del propio mensaje, en una linea
 * `attachment` que cuelga de el, o pegada en un mensaje encolado. Son
 * numeraciones distintas, asi que sin esto la imagen 0 de una devolveria la 0
 * de otra.
 *
 * Devuelve null si no esta: el archivo pudo cambiar, o el evento pudo quedar
 * fuera del tramo cargado. Un null se muestra como "no se pudo cargar", que es
 * mejor que un error.
 *
 * `pastedDir` es la carpeta de lo pegado; solo la cambian los chequeos.
 */
export async function loadConversationImage(
  filePath: string,
  eventId: string,
  index: number,
  source: ConversationImageSource = 'content',
  pastedDir: string = pasteRoot(),
): Promise<LoadedImage | null> {
  const handle = await open(filePath, 'r').catch(() => null);
  if (handle === null) return null;

  try {
    if (source === 'pasted') return await findPastedImage(linesOf(handle), eventId, index, pastedDir);
    return await findInLines(linesOf(handle), eventId, index, source);
  } finally {
    await handle.close();
  }
}

/** Las formas que la CLI dejo en el archivo: `content` y `attachment`. */
async function findInLines(
  lines: AsyncIterable<string>,
  eventId: string,
  index: number,
  source: ConversationImageSource,
): Promise<LoadedImage | null> {
  /*
    Las adjuntas no se pueden buscar por posicion dentro de una linea: cada una
    es una linea propia, y su indice es el orden en que cuelgan del mensaje. Se
    cuentan al pasar.

    Y no todas cuelgan del mensaje: con dos imagenes, la segunda cuelga de la
    primera (§4.9.2). Por eso se lleva la **cadena** —el mensaje y los adjuntos
    que ya se le reconocieron— en vez de un solo id.
  */
  let seen = 0;
  const chain = new Set([eventId]);
  const consider = (line: string): LoadedImage | null => {
    // Filtro barato antes de parsear: casi ninguna linea es la que se busca y
    // `JSON.parse` sobre 290 KB no es gratis. La cadena tiene un id mas por
    // imagen adjunta, asi que sigue siendo una pasada corta.
    let mentions = false;
    for (const id of chain) {
      if (line.includes(id)) {
        mentions = true;
        break;
      }
    }
    if (!mentions) return null;

    const record = parseJsonlLine(line);
    if (record === null) return null;

    if (source === 'content') return imageFromContent(record, eventId, index);

    const parent = record['parentUuid'];
    if (typeof parent !== 'string' || !chain.has(parent)) return null;

    const found = imageFromAttachment(record);
    if (found === null) return null;

    // Este adjunto pasa a ser padre posible del que siga.
    const ownId = record['uuid'];
    if (typeof ownId === 'string' && ownId.length > 0) chain.add(ownId);

    return seen++ === index ? found : null;
  };

  for await (const line of lines) {
    const found = consider(line);
    if (found !== null) return found;
  }
  return null;
}

/**
 * Las lineas del archivo, de a una y sin cargarlo entero: una linea puede pesar
 * 290 KB (§4.6), y el archivo, varios MB.
 */
async function* linesOf(handle: FileHandle): AsyncGenerator<string> {
  const buffer = Buffer.allocUnsafe(CHUNK_SIZE);
  let pending = Buffer.alloc(0);
  let offset = 0;

  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK_SIZE, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;

    const combined = Buffer.concat([pending, buffer.subarray(0, bytesRead)]);
    let start = 0;
    let newlineIndex = combined.indexOf(NEWLINE, start);

    while (newlineIndex !== -1) {
      yield combined.subarray(start, newlineIndex).toString('utf8');
      start = newlineIndex + 1;
      newlineIndex = combined.indexOf(NEWLINE, start);
    }

    pending = Buffer.from(combined.subarray(start));
  }

  // La ultima linea puede no terminar en salto.
  if (pending.length > 0) yield pending.toString('utf8');
}

/**
 * Una imagen del cuadro en un mensaje que se mando con el agente trabajando
 * (§4.4.1). La CLI no la adjunta —no hay linea `attachment`—, y los bytes salen
 * de uno de dos sitios:
 *
 *  1. **El archivo que dejo `PasteStore`**, mientras exista: hasta que se cierra
 *     la pestana. Es lo unico que hay antes de que el agente la lea.
 *  2. **El resultado del `Read` con que el agente la abrio.** La CLI le pasa el
 *     mensaje como texto, con la ruta, y el agente la lee con su herramienta: los
 *     bytes quedan en el archivo para siempre, como los de un adjunto. Medido:
 *     17 de las 18 imagenes encoladas de esta instalacion tienen el suyo.
 *
 * Sin ninguno de los dos, null: "la imagen ya no esta".
 */
async function findPastedImage(
  lines: AsyncIterable<string>,
  eventId: string,
  index: number,
  pastedDir: string,
): Promise<LoadedImage | null> {
  let target: string | null = null;
  let readId: string | null = null;

  for await (const line of lines) {
    if (target === null) {
      if (!line.includes(eventId)) continue;
      const record = parseJsonlLine(line);
      if (record === null || record['uuid'] !== eventId) continue;
      target = queuedPastedImages(record)[index] ?? null;
      if (target === null) return null;
      const fromDisk = await readPastedFile(target, pastedDir);
      if (fromDisk !== null) return fromDisk;
      continue;
    }

    // Despues del mensaje: el `Read` del agente sobre esa ruta, y su resultado.
    if (readId === null) {
      if (line.includes('"Read"')) readId = readToolUseOf(parseJsonlLine(line), target);
      continue;
    }
    if (!line.includes(readId)) continue;
    const result = toolResultOf(parseJsonlLine(line), readId);
    if (result === null) continue;
    const content = result['content'];
    const image = Array.isArray(content) ? firstImage(content) : null;
    if (image !== null) return image;
    // Ese `Read` no la trajo —un error, un archivo que ya no estaba—: puede haber otro.
    readId = null;
  }
  return null;
}

/**
 * Los bytes que dejo `PasteStore`, si siguen ahi y son de una imagen.
 *
 * La ruta sale del texto del mensaje, que escribio el usuario, asi que pasa por
 * el guardia de rutas contra la carpeta de lo pegado: un `..` o un enlace hacia
 * afuera no se leen (§2.4). Y gana la firma de los bytes, no la extension. El
 * cliente no nombra nada: pide `(eventId, index)`, como con las otras formas.
 */
async function readPastedFile(target: string, pastedDir: string): Promise<LoadedImage | null> {
  try {
    const inside = await resolveInside(pastedDir, path.relative(pastedDir, target), { mustExist: true });
    const info = await stat(inside);
    if (!info.isFile() || info.size === 0 || info.size > MAX_IMAGE_BYTES) return null;
    const bytes = await readFile(inside);
    const format = detectImageFormat(bytes);
    return format === null ? null : { mediaType: format.mediaType, data: bytes.toString('base64') };
  } catch {
    // Ya no esta —la pestana se cerro—, o la ruta no es de la carpeta.
    return null;
  }
}

/** El id del `Read` de esta linea que abrio `target`, o null. */
function readToolUseOf(record: Record<string, unknown> | null, target: string): string | null {
  if (record === null || record['type'] !== 'assistant') return null;
  const content = recordOf(record['message'])?.['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const tool = recordOf(block);
    if (tool === null || tool['type'] !== 'tool_use' || tool['name'] !== 'Read') continue;
    const id = tool['id'];
    const filePath = recordOf(tool['input'])?.['file_path'];
    if (typeof id === 'string' && id.length > 0 && typeof filePath === 'string' && sameFilePath(filePath, target)) {
      return id;
    }
  }
  return null;
}

/** El bloque `tool_result` de `toolUseId` en esta linea, o null. */
function toolResultOf(record: Record<string, unknown> | null, toolUseId: string): Record<string, unknown> | null {
  if (record === null || record['type'] !== 'user') return null;
  const content = recordOf(record['message'])?.['content'];
  if (!Array.isArray(content)) return null;
  for (const block of content) {
    const result = recordOf(block);
    if (result !== null && result['type'] === 'tool_result' && result['tool_use_id'] === toolUseId) return result;
  }
  return null;
}

/** El base64 ocupa ~4/3 de lo que pesa la imagen. */
function tooBig(data: string): boolean {
  return data.length > MAX_IMAGE_BYTES * 1.4;
}

/** Un bloque `{"type":"image","source":{…}}`, el de `message.content` y el de un resultado. */
function imageFromBlock(value: unknown): LoadedImage | null {
  const block = recordOf(value);
  if (block === null || block['type'] !== 'image') return null;
  const source = recordOf(block['source']);
  if (source === null) return null;

  const data = source['data'];
  const mediaType = source['media_type'];
  if (typeof data !== 'string' || data.length === 0 || tooBig(data)) return null;

  return {
    mediaType: typeof mediaType === 'string' ? mediaType : 'image/png',
    data,
  };
}

/** La primera imagen de una lista de bloques. */
function firstImage(blocks: unknown[]): LoadedImage | null {
  for (const block of blocks) {
    const image = imageFromBlock(block);
    if (image !== null) return image;
  }
  return null;
}

/** Un bloque `image` dentro del propio mensaje: lo que deja `Alt+V` en la CLI. */
function imageFromContent(
  record: Record<string, unknown>,
  eventId: string,
  index: number,
): LoadedImage | null {
  if (record['uuid'] !== eventId) return null;

  const content = recordOf(record['message'])?.['content'];
  if (!Array.isArray(content)) return null;
  return imageFromBlock(content[index]);
}

/**
 * Una linea `attachment` de imagen: lo que deja el cuadro de escritura, que le
 * nombra la imagen a la CLI por ruta (§5.3).
 *
 * Devuelve la imagen de **esta** linea; quien llama decide si le corresponde —
 * de que mensaje cuelga y que numero es. Tiene que ser asi porque el indice es
 * el orden entre las adjuntas del mismo mensaje, y eso no se sabe mirando una
 * linea sola.
 */
function imageFromAttachment(record: Record<string, unknown>): LoadedImage | null {
  if (record['type'] !== 'attachment') return null;

  const attachment = record['attachment'];
  if (typeof attachment !== 'object' || attachment === null) return null;
  const content = (attachment as Record<string, unknown>)['content'];
  if (typeof content !== 'object' || content === null) return null;
  const contentRecord = content as Record<string, unknown>;
  if (contentRecord['type'] !== 'image') return null;

  const file = contentRecord['file'];
  if (typeof file !== 'object' || file === null) return null;
  const fileRecord = file as Record<string, unknown>;

  const data = fileRecord['base64'];
  const mediaType = fileRecord['type'];
  if (typeof data !== 'string' || data.length === 0 || tooBig(data)) return null;

  return {
    mediaType: typeof mediaType === 'string' && mediaType.length > 0 ? mediaType : 'image/png',
    data,
  };
}
