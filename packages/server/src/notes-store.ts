/**
 * Notas sueltas del usuario.
 *
 * Ideas que se anotan mientras se trabaja, sin proyecto ni pestana. Viven en el
 * directorio de configuracion propio —nunca en `~/.claude/`, que es de la CLI—
 * y duran hasta que el usuario las cierra. **Cerrar borra**, imagenes incluidas;
 * es la unica escritura destructiva de la app y por eso el cliente confirma
 * antes cuando la nota tiene algo.
 *
 * Dos archivos distintos para dos cosas distintas:
 *
 *  - `notes.json`: el texto y la lista de imagenes de cada nota. Se reescribe
 *    entero, con debounce y de forma atomica, como el resto del estado.
 *  - `notes-images/<imageId>.<ext>`: una captura por archivo. Meterlas en el
 *    JSON en base64 haria que cada tecla reescribiera megas.
 *
 * **Las imagenes se aceptan por la firma de los bytes, no por el tipo que
 * declara el navegador**, y **el nombre lo pone el servidor** (un UUID). Es el
 * mismo criterio que el pegado del cuadro de escritura: este es el otro sitio
 * del servidor que escribe archivos con datos del cliente.
 */

import {
  MAX_NOTES,
  MAX_NOTE_IMAGES,
  MAX_NOTE_TEXT_CHARS,
  MAX_SUBMIT_IMAGE_BYTES,
  ServerTextError,
  isValidNoteId,
  parseNote,
  serverText,
  type Note,
  type NoteImage,
} from '@agent-workbench/shared';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { IMAGE_MEDIA_TYPES, detectImageFormat } from './image-signature.js';
import { notesImagesDir, notesStatePath } from './paths.js';

const STATE_VERSION = 1;
/** El texto llega tecla a tecla; a disco va cuando se hace una pausa. */
const WRITE_DEBOUNCE_MS = 500;

/** Un pedido de notas que no se cumple. El texto va como clave (§6.23). */
export class NotesError extends ServerTextError {}

function parseState(raw: string): Note[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    // Una version desconocida se ignora entera antes que leerla mal. Que no se
    // reescriba encima lo garantiza `dirty`: sin cambios no hay escritura.
    if (record['version'] !== STATE_VERSION) return null;
    const notes = record['notes'];
    if (!Array.isArray(notes)) return null;
    return notes.map(parseNote).filter((note): note is Note => note !== null);
  } catch {
    return null;
  }
}

/** Extension del archivo en disco, a partir del tipo guardado en la nota. */
function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'png';
  }
}

export class NotesStore {
  private notes: Note[] = [];
  private writeTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private readonly statePath: string;
  private readonly imagesDir: string;

  /** Rutas inyectables para las pruebas; por defecto, el directorio de configuracion. */
  constructor(statePath?: string, imagesDir?: string) {
    this.statePath = statePath ?? notesStatePath();
    this.imagesDir = imagesDir ?? notesImagesDir();
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.statePath, 'utf8');
      this.notes = parseState(raw) ?? [];
    } catch {
      // Primer arranque, o archivo ilegible. Se empieza sin notas.
      this.notes = [];
    }
  }

  /** Copia: nadie de afuera toca la lista viva. */
  list(): Note[] {
    return this.notes.map((note) => ({ ...note, images: [...note.images] }));
  }

  get(noteId: string): Note | null {
    return this.notes.find((note) => note.noteId === noteId) ?? null;
  }

  /**
   * Crea una nota con el id que eligio el cliente.
   *
   * Es un id, no una ruta: solo se usa como clave, y aun asi se valida la forma.
   * Un id repetido no crea nada; el cliente ya tiene esa nota.
   */
  create(noteId: string, now = Date.now()): Note {
    if (!isValidNoteId(noteId)) throw new NotesError(serverText('noteIdInvalid'));
    if (this.get(noteId) !== null) throw new NotesError(serverText('noteExists'));
    if (this.notes.length >= MAX_NOTES) {
      throw new NotesError(serverText('notesMax', { max: MAX_NOTES }));
    }
    const note: Note = { noteId, text: '', images: [], createdAt: now, updatedAt: now };
    this.notes.push(note);
    this.schedule();
    return note;
  }

  /** Devuelve true si el texto cambio de verdad. */
  update(noteId: string, text: string, now = Date.now()): boolean {
    const note = this.get(noteId);
    if (note === null) throw new NotesError(serverText('noteGone'));
    if (text.length > MAX_NOTE_TEXT_CHARS) {
      throw new NotesError(serverText('noteTooLong', { max: MAX_NOTE_TEXT_CHARS }));
    }
    if (note.text === text) return false;
    note.text = text;
    note.updatedAt = now;
    this.schedule();
    return true;
  }

  /** Borra la nota y sus imagenes. Devuelve false si no existia. */
  async delete(noteId: string): Promise<boolean> {
    const index = this.notes.findIndex((note) => note.noteId === noteId);
    if (index === -1) return false;
    const [removed] = this.notes.splice(index, 1);
    this.schedule();
    if (removed !== undefined) {
      await Promise.all(removed.images.map((image) => this.unlinkImage(image)));
    }
    return true;
  }

  /**
   * Guarda una imagen en disco y la cuelga de la nota.
   *
   * Gana la firma, no el tipo declarado: la extension y el `mediaType` que se
   * guardan describen lo que hay adentro del archivo.
   */
  async addImage(
    noteId: string,
    declaredType: string,
    base64: string,
    now = Date.now(),
  ): Promise<NoteImage> {
    const note = this.get(noteId);
    if (note === null) throw new NotesError(serverText('noteGone'));
    if (note.images.length >= MAX_NOTE_IMAGES) {
      throw new NotesError(serverText('noteImagesMax', { max: MAX_NOTE_IMAGES }));
    }
    if (!IMAGE_MEDIA_TYPES.has(declaredType)) {
      throw new NotesError(serverText('imageTypeUnsupported', { type: declaredType }));
    }

    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length === 0) throw new NotesError(serverText('imageEmpty'));
    if (bytes.length > MAX_SUBMIT_IMAGE_BYTES) {
      throw new NotesError(
        serverText('imageTooLarge', {
          size: Math.round(bytes.length / 1024 / 1024),
          max: MAX_SUBMIT_IMAGE_BYTES / 1024 / 1024,
        }),
      );
    }
    const format = detectImageFormat(bytes);
    if (format === null) {
      throw new NotesError(serverText('imageUnknownFormat'));
    }

    const image: NoteImage = {
      imageId: randomUUID(),
      mediaType: format.mediaType,
      bytes: bytes.length,
    };
    await mkdir(this.imagesDir, { recursive: true });
    await writeFile(this.imagePath(image), bytes);

    note.images.push(image);
    note.updatedAt = now;
    this.schedule();
    return image;
  }

  async removeImage(noteId: string, imageId: string, now = Date.now()): Promise<boolean> {
    const note = this.get(noteId);
    if (note === null) return false;
    const index = note.images.findIndex((image) => image.imageId === imageId);
    if (index === -1) return false;
    const [removed] = note.images.splice(index, 1);
    note.updatedAt = now;
    this.schedule();
    if (removed !== undefined) await this.unlinkImage(removed);
    return true;
  }

  /**
   * Lee una imagen por id.
   *
   * El id tiene que estar colgado de alguna nota: es lo que convierte un string
   * del cliente en una ruta que eligio el servidor. Un id que no figura no se
   * busca en disco, aunque el archivo exista.
   */
  async readImage(imageId: string): Promise<{ mediaType: string; data: string } | null> {
    const image = this.findImage(imageId);
    if (image === null) return null;
    try {
      const bytes = await readFile(this.imagePath(image));
      return { mediaType: image.mediaType, data: bytes.toString('base64') };
    } catch {
      return null;
    }
  }

  /**
   * Una nota lista para mandarsela al agente: su texto y sus imagenes en base64.
   *
   * Se arma aca y no en el navegador porque el contenido ya esta de este lado:
   * subirlo y volver a bajarlo solo para reenviarlo serian megas por el socket
   * a cambio de nada. Una imagen que no se puede leer se omite en vez de tirar
   * el envio entero: perder una captura es mejor que perder la nota.
   */
  async readForSubmit(
    noteId: string,
  ): Promise<{ text: string; images: { mediaType: string; data: string }[] } | null> {
    const note = this.get(noteId);
    if (note === null) return null;

    const images: { mediaType: string; data: string }[] = [];
    for (const image of note.images) {
      try {
        const bytes = await readFile(this.imagePath(image));
        images.push({ mediaType: image.mediaType, data: bytes.toString('base64') });
      } catch {
        // Ver arriba: se sigue sin ella.
      }
    }
    return { text: note.text, images };
  }

  /** Escritura inmediata, para el apagado. */
  async flush(): Promise<void> {
    if (this.writeTimer !== null) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.dirty) await this.writeNow();
  }

  private findImage(imageId: string): NoteImage | null {
    for (const note of this.notes) {
      const found = note.images.find((image) => image.imageId === imageId);
      if (found !== undefined) return found;
    }
    return null;
  }

  private imagePath(image: NoteImage): string {
    // El id lo genero `randomUUID`; igual se sanea, porque termina en una ruta.
    const safe = image.imageId.replace(/[^a-zA-Z0-9-]/g, '');
    return path.join(this.imagesDir, `${safe}.${extensionFor(image.mediaType)}`);
  }

  private async unlinkImage(image: NoteImage): Promise<void> {
    await rm(this.imagePath(image), { force: true }).catch(() => {
      // Que no se pueda borrar un archivo no es motivo para dejar la nota.
    });
  }

  private schedule(): void {
    this.dirty = true;
    if (this.writeTimer !== null) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.writeNow();
    }, WRITE_DEBOUNCE_MS);
    this.writeTimer.unref();
  }

  private async writeNow(): Promise<void> {
    this.dirty = false;
    try {
      await mkdir(path.dirname(this.statePath), { recursive: true });
      // Atomica, como el resto del estado: un corte a mitad no deja media lista.
      const temporary = path.join(path.dirname(this.statePath), `notes.${process.pid}.tmp`);
      await writeFile(
        temporary,
        JSON.stringify({ version: STATE_VERSION, notes: this.notes }, null, 2),
        'utf8',
      );
      await rename(temporary, this.statePath);
    } catch (error) {
      console.warn("[notes] couldn't save the notes:", error);
    }
  }
}
