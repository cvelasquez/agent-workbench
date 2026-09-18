/**
 * Donde aterrizan las imagenes que se pegan en el cuadro de escritura.
 *
 * La CLI adjunta imagenes por ruta —`@"C:\...\pegada-1.png"`— asi que lo que
 * llega por el socket como base64 tiene que existir en disco antes de nombrarlo.
 * Este modulo es el unico que escribe archivos a partir de datos del cliente, y
 * por eso es tambien el unico sitio del servidor con reglas sobre que se acepta.
 *
 * Tres decisiones que conviene no deshacer:
 *
 *  - **El nombre lo pone el servidor, siempre.** El cliente manda bytes y un
 *    tipo, nunca una ruta ni un nombre de archivo. Es la misma regla que
 *    `path-guard` aplica en el otro sentido (CLAUDE.md 2.4): si el cliente
 *    pudiera elegir donde escribir, daria igual escuchar solo en loopback.
 *  - **Se comprueba la firma del contenido, no el tipo declarado.** Un
 *    `mediaType` es una promesa del navegador; los primeros bytes son un hecho.
 *    Sin esto, cualquier cosa se guarda en disco con extension de imagen.
 *  - **Se limpia sola.** Por pestana al cerrarla, y lo viejo al arrancar. Una
 *    carpeta de temporales que solo crece termina siendo un problema de otro.
 *  - **Sin permisos para nadie mas** (R29-4): carpetas `0o700` y archivos
 *    `0o600`. En Linux la temporal es compartida, y lo que aterriza aca son
 *    capturas y el transcript de una conversacion. En Windows %TEMP% ya es por
 *    usuario y los bits no hacen nada.
 */

import {
  MAX_SUBMIT_FILES,
  MAX_SUBMIT_FILE_BYTES,
  MAX_SUBMIT_IMAGES,
  MAX_SUBMIT_IMAGE_BYTES,
} from '@agent-workbench/shared';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBlockedExtension, safeFileName } from './attachments.js';
import { HANDOFF_MAX_BYTES } from './handoff/transcript.js';
import { detectImageFormat } from './image-signature.js';

/** Tipos que la CLI sabe leer como imagen. Lista corta y explicita. */
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
]);

/** Por imagen. Una captura de pantalla 4K en PNG ronda los 8 MB. */
export const MAX_IMAGE_BYTES = MAX_SUBMIT_IMAGE_BYTES;

/** Por envio. Mas que esto no es un mensaje, es una carpeta. */
export const MAX_IMAGES_PER_SUBMIT = MAX_SUBMIT_IMAGES;

/** Por archivo adjunto y por envio (hito 33, §6.21). */
export const MAX_FILE_BYTES = MAX_SUBMIT_FILE_BYTES;
export const MAX_FILES_PER_SUBMIT = MAX_SUBMIT_FILES;

/** Los temporales de arranques anteriores se borran pasado este tiempo. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** Solo el usuario: la temporal de Linux es compartida (R29-4). */
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface StoredImage {
  /** Ruta absoluta, la que se le nombra a la CLI. */
  path: string;
  bytes: number;
}

export class PasteImageError extends Error {}

/** Un archivo adjunto guardado: la ruta, el peso y el nombre que le quedo. */
export interface StoredFile extends StoredImage {
  name: string;
}

export class PasteFileError extends Error {}

/**
 * Tope de un texto guardado: el transcript de una continuacion mas un margen
 * (hito 29, §6.4). El documento ya sale recortado a `HANDOFF_MAX_BYTES`; esto
 * es la guarda de que ninguna otra cosa llegue a escribir megas en la temporal.
 */
export const MAX_TEXT_BYTES = HANDOFF_MAX_BYTES + 4 * 1024;

/** Lo que se puede guardar como texto. Un literal: el cliente no nombra nada. */
export type StoredTextKind = 'continuacion';

export class PasteTextError extends Error {}

export class PasteStore {
  private readonly root: string;
  private counter = 0;

  constructor(root?: string) {
    this.root = root ?? path.join(tmpdir(), 'agent-workbench', 'pasted');
  }

  /**
   * Guarda una imagen y devuelve su ruta.
   *
   * `terminalId` solo decide la subcarpeta: es lo que permite borrar de una lo
   * de una pestana al cerrarla, sin tocar lo de las demas.
   */
  async save(terminalId: string, mediaType: string, base64: string): Promise<StoredImage> {
    const declared = EXTENSIONS.get(mediaType);
    if (declared === undefined) {
      throw new PasteImageError(`Tipo de imagen no admitido: ${mediaType}`);
    }

    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new PasteImageError('La imagen llego vacia.');
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new PasteImageError(
        `La imagen pesa ${Math.round(bytes.length / 1024 / 1024)} MB; el maximo son ${
          MAX_IMAGE_BYTES / 1024 / 1024
        } MB.`,
      );
    }

    const signature = detectImageFormat(bytes);
    if (signature === null) {
      throw new PasteImageError('El contenido no es una imagen de un formato conocido.');
    }

    // Gana la firma, no lo que dijo el navegador. La extension tiene que
    // describir lo que hay adentro para que la CLI lo lea bien.
    const directory = path.join(this.root, safeSegment(terminalId));
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

    this.counter += 1;
    const name = `pegada-${this.counter}-${randomUUID().slice(0, 8)}.${signature.ext}`;
    const file = path.join(directory, name);
    await writeFile(file, bytes, { mode: FILE_MODE });
    return { path: file, bytes: bytes.length };
  }

  /**
   * Guarda un texto que la app arma para una pestana y le nombra a su CLI: el
   * transcript de una continuacion (hito 29, D17).
   *
   * Mismas reglas que una imagen: el nombre y la carpeta los pone el servidor
   * —`<baseName>-<n>-<8 hex>.md` en la subcarpeta de la pestana—, y se borra con
   * `clearTerminal` al cerrarla o con `purgeStale` a las 24 h. UTF-8 sin BOM.
   * Lanza `PasteTextError` si pasa `MAX_TEXT_BYTES`.
   */
  async saveText(terminalId: string, baseName: StoredTextKind, content: string): Promise<StoredImage> {
    const bytes = Buffer.from(content, 'utf8');
    if (bytes.length > MAX_TEXT_BYTES) {
      throw new PasteTextError(`El texto pesa ${bytes.length} bytes; el maximo son ${MAX_TEXT_BYTES}.`);
    }
    const directory = path.join(this.root, safeSegment(terminalId));
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

    this.counter += 1;
    const name = `${baseName}-${this.counter}-${randomUUID().slice(0, 8)}.md`;
    const file = path.join(directory, name);
    await writeFile(file, bytes, { mode: FILE_MODE });
    return { path: file, bytes: bytes.length };
  }

  /**
   * Guarda un archivo adjunto del cuadro de escritura (hito 33, §6.21).
   *
   * Mismas reglas que una imagen, con una diferencia: un documento no tiene una
   * firma que comprobar, asi que lo que se cuida es el nombre. El cliente manda
   * una pista y `safeFileName` la reduce a `[A-Za-z0-9._-]`; va **detras** del
   * prefijo que pone el servidor —`adjunto-<n>-<8 hex>-`—, asi que ni un nombre
   * reservado de Windows ni un `..` llegan a ser el nombre del archivo. Lo que
   * el sistema ejecuta con un doble clic no se guarda.
   */
  async saveAttachment(terminalId: string, nameHint: string, base64: string): Promise<StoredFile> {
    const safe = safeFileName(nameHint);
    if (isBlockedExtension(safe)) {
      throw new PasteFileError(`No se adjuntan ejecutables: "${safe}".`);
    }

    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new PasteFileError(`"${safe}" llego vacio.`);
    if (bytes.length > MAX_FILE_BYTES) {
      throw new PasteFileError(
        `"${safe}" pesa ${Math.round(bytes.length / 1024 / 1024)} MB; el maximo son ${
          MAX_FILE_BYTES / 1024 / 1024
        } MB.`,
      );
    }

    const directory = path.join(this.root, safeSegment(terminalId));
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });

    this.counter += 1;
    const name = `adjunto-${this.counter}-${randomUUID().slice(0, 8)}-${safe}`;
    const file = path.join(directory, name);
    await writeFile(file, bytes, { mode: FILE_MODE });
    return { path: file, bytes: bytes.length, name };
  }

  /** Borra lo de una pestana. Se llama al cerrarla. */
  async clearTerminal(terminalId: string): Promise<void> {
    await rm(path.join(this.root, safeSegment(terminalId)), {
      recursive: true,
      force: true,
    }).catch(() => {
      // Que no se pueda borrar un temporal no es motivo para romper nada.
    });
  }

  /**
   * Borra lo que quedo de arranques anteriores.
   *
   * Hace falta porque un cierre sin gracia —kill -9, apagon— no pasa por
   * `clearTerminal`. Es el mismo limite conocido que deja pty huerfanas
   * (CLAUDE.md 3.0), resuelto igual: se limpia al arrancar.
   */
  async purgeStale(now = Date.now()): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return; // No existe todavia: no hay nada que limpiar.
    }

    await Promise.all(
      entries.map(async (entry) => {
        const full = path.join(this.root, entry);
        try {
          const info = await stat(full);
          if (now - info.mtimeMs > STALE_AFTER_MS) {
            await rm(full, { recursive: true, force: true });
          }
        } catch {
          // Otro proceso pudo borrarlo mientras mirabamos.
        }
      }),
    );
  }
}

/**
 * Un id de terminal convertido en nombre de carpeta seguro.
 *
 * Los ids los genera el servidor y son UUID, asi que en la practica pasan tal
 * cual. Se sanea igual: es lo unico que el cliente nombra en este modulo, y una
 * carpeta llamada `..` seria un problema mucho mas grande que un nombre feo.
 */
function safeSegment(value: string): string {
  const clean = value.replace(/[^a-zA-Z0-9_-]/g, '');
  return clean.length > 0 ? clean : createHash('sha1').update(value).digest('hex').slice(0, 16);
}
