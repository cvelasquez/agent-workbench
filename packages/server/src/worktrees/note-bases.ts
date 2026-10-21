/**
 * Las copias de origen de las notas de una rama aparte (21-10-2026, §6.38):
 * cómo estaba cada nota cuando se copió a la rama, o cuando volvió por última
 * vez a la carpeta principal. Con ellas, una nota que cambió en los dos lados
 * se junta (`merge-notes.ts`) en vez de preguntar.
 *
 * Viven en la carpeta de configuración de la app, en `worktree-notes/`, una por
 * contenido: el nombre es su huella, la misma que ya guarda `worktrees.json`.
 * El registro no suma nada, y dos ramas con la misma nota comparten la copia.
 *
 * **Sólo notas de texto** (`.md`, `.txt` y parecidos) de hasta 2 MB: nunca un
 * `.env` ni una clave que el `.worktreeinclude` copie a la rama. Lo que no
 * tiene copia se compara como antes: si cambió en los dos lados, se pregunta.
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomically } from '../atomic-write.js';
import { worktreeNotesDir } from '../paths.js';

/** Las extensiones de una nota de texto: las únicas que se guardan. */
const TEXT_NOTE_EXTENSIONS: ReadonlySet<string> = new Set(['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc']);
/** Una nota más grande que esto no se guarda: no es una nota. */
export const NOTE_BASE_MAX_BYTES = 2 * 1024 * 1024;
/**
 * Lo que se acaba de guardar no se borra al limpiar: una rama que se está
 * creando guarda sus copias antes de quedar en el registro.
 */
const PRUNE_GRACE_MS = 10 * 60_000;

const HASH = /^[0-9a-f]{64}$/;

function hashOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** true si la copia de origen de esta nota se guarda: texto, con una extensión de nota y sin pasar el tope. */
export function keepsNoteBase(relative: string, content: Buffer): boolean {
  return (
    TEXT_NOTE_EXTENSIONS.has(path.posix.extname(relative).toLowerCase()) &&
    content.length <= NOTE_BASE_MAX_BYTES &&
    !content.subarray(0, 8_000).includes(0)
  );
}

export interface NoteBasesOptions {
  /** Cuánto se respeta una copia recién guardada al limpiar. Las pruebas usan 0. */
  graceMs?: number;
  now?: () => number;
}

export class NoteBases {
  private readonly graceMs: number;
  private readonly now: () => number;

  constructor(
    private readonly dir: string = worktreeNotesDir(),
    options: NoteBasesOptions = {},
  ) {
    this.graceMs = options.graceMs ?? PRUNE_GRACE_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Guarda la copia de una nota, si es de las que se guardan. Una que ya está
   * con ese contenido no se reescribe, pero se le renueva la fecha: si no, otra
   * rama que se quita en ese momento la borraría antes de que la nueva llegue
   * al registro (revisión del 21-10-2026).
   */
  async save(relative: string, content: Buffer): Promise<void> {
    if (!keepsNoteBase(relative, content)) return;
    const hash = hashOf(content);
    const file = path.join(this.dir, hash);
    const current = await readFile(file).catch(() => null);
    if (current !== null && hashOf(current) === hash) {
      const now = new Date(this.now());
      await utimes(file, now, now).catch(() => undefined);
      return;
    }
    await mkdir(this.dir, { recursive: true });
    await writeAtomically(file, content);
  }

  /** La copia de origen con esa huella, o null si no hay (o lo que hay no es eso). */
  async load(hash: string): Promise<Buffer | null> {
    if (!HASH.test(hash)) return null;
    try {
      const content = await readFile(path.join(this.dir, hash));
      return hashOf(content) === hash ? content : null;
    } catch {
      return null;
    }
  }

  /** Borra las copias que ya no nombra ninguna rama aparte viva. Sólo las suyas: lo demás de la carpeta no se toca. */
  async prune(keep: ReadonlySet<string>): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    const now = this.now();
    for (const name of names) {
      if (!HASH.test(name) || keep.has(name)) continue;
      const file = path.join(this.dir, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || now - info.mtimeMs < this.graceMs) continue;
        await rm(file, { force: true });
      } catch {
        // Otra limpieza la borró antes, o el antivirus la tiene: queda para la próxima.
      }
    }
  }
}
