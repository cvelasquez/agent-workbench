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
 */

import { MAX_SUBMIT_IMAGE_BYTES, type ConversationImageSource } from '@agent-workbench/shared';
import { open } from 'node:fs/promises';
import { parseJsonlLine } from './jsonl-reader.js';

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

export interface LoadedImage {
  mediaType: string;
  /** base64, tal como estaba en el archivo. */
  data: string;
}

/**
 * Busca la imagen `index` del mensaje `eventId`.
 *
 * `source` dice en cual de las dos formas buscarla (ver
 * `ConversationImageSource`): dentro del propio mensaje, o en una linea
 * `attachment` que cuelga de el. Son dos numeraciones distintas, asi que sin
 * esto la imagen 0 de una devolveria la 0 de la otra.
 *
 * Devuelve null si no esta: el archivo pudo cambiar, o el evento pudo quedar
 * fuera del tramo cargado. Un null se muestra como "no se pudo cargar", que es
 * mejor que un error.
 */
export async function loadConversationImage(
  filePath: string,
  eventId: string,
  index: number,
  source: ConversationImageSource = 'content',
): Promise<LoadedImage | null> {
  const handle = await open(filePath, 'r').catch(() => null);
  if (handle === null) return null;

  /*
    Las adjuntas no se pueden buscar por posicion dentro de una linea: cada una
    es una linea propia, y su indice es el orden en que cuelgan del mensaje. Se
    cuentan al pasar.
  */
  let seen = 0;
  const consider = (line: string): LoadedImage | null => {
    // Filtro barato antes de parsear: casi ninguna linea es la que se busca y
    // `JSON.parse` sobre 290 KB no es gratis. Sirve para las dos formas — el
    // `parentUuid` de una adjunta tambien es el `eventId` que se busca.
    if (!line.includes(eventId)) return null;
    const record = parseJsonlLine(line);
    if (record === null) return null;

    if (source === 'content') return imageFromContent(record, eventId, index);

    const found = imageFromAttachment(record, eventId);
    if (found === null) return null;
    return seen++ === index ? found : null;
  };

  try {
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
        const line = combined.subarray(start, newlineIndex).toString('utf8');
        start = newlineIndex + 1;
        newlineIndex = combined.indexOf(NEWLINE, start);

        const found = consider(line);
        if (found !== null) return found;
      }

      pending = Buffer.from(combined.subarray(start));
    }

    // La ultima linea puede no terminar en salto.
    if (pending.length > 0) return consider(pending.toString('utf8'));
    return null;
  } finally {
    await handle.close();
  }
}

/** El base64 ocupa ~4/3 de lo que pesa la imagen. */
function tooBig(data: string): boolean {
  return data.length > MAX_IMAGE_BYTES * 1.4;
}

/** Un bloque `image` dentro del propio mensaje: lo que deja `Alt+V` en la CLI. */
function imageFromContent(
  record: Record<string, unknown>,
  eventId: string,
  index: number,
): LoadedImage | null {
  if (record['uuid'] !== eventId) return null;

  const message = record['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  if (!Array.isArray(content)) return null;

  const block = content[index];
  if (typeof block !== 'object' || block === null) return null;
  const blockRecord = block as Record<string, unknown>;
  if (blockRecord['type'] !== 'image') return null;

  const source = blockRecord['source'];
  if (typeof source !== 'object' || source === null) return null;
  const sourceRecord = source as Record<string, unknown>;

  const data = sourceRecord['data'];
  const mediaType = sourceRecord['media_type'];
  if (typeof data !== 'string' || data.length === 0 || tooBig(data)) return null;

  return {
    mediaType: typeof mediaType === 'string' ? mediaType : 'image/png',
    data,
  };
}

/**
 * Una linea `attachment` que cuelga del mensaje: lo que deja el cuadro de
 * escritura, que le nombra la imagen a la CLI por ruta (§5.3).
 *
 * Devuelve la imagen de **esta** linea; quien llama cuenta cual es. Tiene que
 * ser asi porque el indice es el orden entre las adjuntas del mismo mensaje, y
 * eso no se sabe mirando una linea sola.
 */
function imageFromAttachment(
  record: Record<string, unknown>,
  eventId: string,
): LoadedImage | null {
  if (record['type'] !== 'attachment' || record['parentUuid'] !== eventId) return null;

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
