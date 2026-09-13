/**
 * Trae una imagen de un mensaje del usuario de un rollout, cuando alguien la
 * mira.
 *
 * Codex guarda los bytes dentro del propio rollout: el `message` de rol `user`
 * trae un `input_image` con `image_url: "data:<mime>;base64,..."`. Por eso la
 * miniatura no caduca aunque la carpeta de pegados se borre al cerrar la
 * pestana, igual que con Claude Code (§4.9.2 de CLAUDE.md).
 *
 * El seguidor ya sabe en que linea esta —la anota al leer el `user_message`—,
 * asi que aca no se busca: se cuenta hasta esa linea y se lee una.
 */

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { asRecord, MAX_SUBMIT_IMAGE_BYTES } from '@agent-workbench/shared';
import { parseJsonlLine } from '../../jsonl-reader.js';
import type { LoadedImage } from '../adapter.js';

/**
 * El mismo tope que acepta el cuadro de escritura: con uno mas bajo, una imagen
 * que la app dejo mandar no se podria ver en el hilo donde se mando.
 */
const MAX_IMAGE_BYTES = MAX_SUBMIT_IMAGE_BYTES;

const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * La imagen `index` (0-based, contando solo `input_image`) del `message/user`
 * de la linea `contentLine` (1-based, como el `line-<n>` de los eventos).
 *
 * null si la linea ya no es esa, si la imagen no esta en `data:`, o si pasa el
 * tope. Un null se dibuja como "no se pudo cargar", que es mejor que un error.
 */
export async function loadRolloutImage(
  filePath: string,
  contentLine: number,
  index: number,
): Promise<LoadedImage | null> {
  if (!Number.isInteger(contentLine) || contentLine < 1 || !Number.isInteger(index) || index < 0) {
    return null;
  }

  const raw = await readLine(filePath, contentLine);
  if (raw === null) return null;

  const record = parseJsonlLine(raw.trim());
  if (record === null || record['type'] !== 'response_item') return null;
  const payload = asRecord(record['payload']);
  if (payload === null || payload['type'] !== 'message' || payload['role'] !== 'user') return null;
  const content = payload['content'];
  if (!Array.isArray(content)) return null;

  const images = content.filter((item) => asRecord(item)?.['type'] === 'input_image');
  const url = asRecord(images[index])?.['image_url'];
  if (typeof url !== 'string') return null;
  const match = DATA_URL.exec(url);
  if (match === null) return null;
  const [, mediaType, data] = match;
  if (mediaType === undefined || data === undefined) return null;
  if (Math.floor((data.length * 3) / 4) > MAX_IMAGE_BYTES) return null;
  return { mediaType, data };
}

/** La linea `lineNumber` (1-based) del archivo, o null si no llega o no se puede leer. */
async function readLine(filePath: string, lineNumber: number): Promise<string | null> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  // Un archivo que no existe emite 'error' en el stream; sin esto seria una excepcion suelta.
  const failed = new Promise<null>((resolve) => stream.once('error', () => resolve(null)));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  const found = (async (): Promise<string | null> => {
    let current = 0;
    try {
      for await (const line of lines) {
        current += 1;
        if (current === lineNumber) return line;
      }
    } catch {
      return null;
    }
    return null;
  })();

  try {
    return await Promise.race([found, failed]);
  } finally {
    lines.close();
    stream.destroy();
  }
}
