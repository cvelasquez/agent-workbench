/**
 * "Cambio uno de los archivos del indice de Antigravity CLI": un sondeo de
 * `stat` sobre una lista fija de archivos, no un watcher.
 *
 * Los archivos que dicen titulo, carpeta y proyecto de cada conversacion
 * (`history.jsonl`, `conversation_summaries.db` con su `-wal`,
 * `cache/last_conversations.json`) viven sueltos en la carpeta de la CLI, al lado
 * de lo que la app no abre nunca (`mcp/`, `conversations/`, los logs). Dos
 * motivos para no ponerle un chokidar a esa carpeta:
 *
 *  - **La base la mantiene abierta la CLI mientras corre**, y en Windows un
 *    watcher no ve lo que se le agrega a un archivo abierto (lo mismo que obligo
 *    a Codex a releer con `followPollMs`, y a OpenCode a sondear su base).
 *  - **Un watcher sobre la carpeta la recorre entera**: nombres y `stat` de
 *    todo lo que hay. Aca se mira exactamente la lista y nada mas.
 *
 * Es barato: cuatro `stat`, y el temporizador solo corre mientras alguien
 * escucha. La primera vuelta fija las firmas sin avisar.
 */

import { stat as statFile } from 'node:fs/promises';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

/** `stat` que devuelve null si el archivo no esta, y lanza con cualquier otro error. */
export async function fileStamp(file: string): Promise<FileStamp | null> {
  try {
    const info = await statFile(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Una firma comparable: igual si fecha y tamano son iguales, o si falta en los dos lados. */
export const stampKey = (stamp: FileStamp | null): string =>
  stamp === null ? 'none' : `${stamp.mtimeMs}:${stamp.size}`;

/** Cada cuanto se miran los archivos del indice. La barra lateral no necesita menos. */
export const CATALOG_SIGNAL_INTERVAL_MS = 2_000;

export interface FileStampSignalOptions {
  intervalMs?: number;
  /** Para el chequeo. */
  stat?: (file: string) => Promise<FileStamp | null>;
}

export class FileStampSignal {
  private readonly listeners = new Set<(file: string) => void>();
  private readonly intervalMs: number;
  private readonly stat: (file: string) => Promise<FileStamp | null>;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** La firma de cada archivo desde que arranco el sondeo; vacia hasta la primera vuelta. */
  private signatures = new Map<string, string>();
  private primed = false;
  private ticking = false;
  /** Sube cada vez que el sondeo arranca o se detiene: una vuelta vieja no avisa. */
  private generation = 0;

  /** `files` se calcula en cada vuelta: las rutas dependen del home, que el chequeo cambia. */
  constructor(
    private readonly files: () => readonly string[],
    options: FileStampSignalOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? CATALOG_SIGNAL_INTERVAL_MS;
    this.stat = options.stat ?? fileStamp;
  }

  /** Avisa con la ruta de cada archivo que cambio. El primero arranca el sondeo; el ultimo lo detiene. */
  subscribe(listener: (file: string) => void): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Una vuelta. Publica para el chequeo. No se solapa con la anterior. */
  async tick(): Promise<void> {
    if (this.listeners.size === 0 || this.ticking) return;
    this.ticking = true;
    const generation = this.generation;
    const next = new Map<string, string>();
    try {
      for (const file of this.files()) {
        try {
          next.set(file, stampKey(await this.stat(file)));
        } catch {
          // Un `stat` que falla un instante no es un cambio: se queda la firma anterior.
          const previous = this.signatures.get(file);
          if (previous !== undefined) next.set(file, previous);
        }
      }
    } finally {
      this.ticking = false;
    }
    if (generation !== this.generation) return;

    const changed = this.primed
      ? [...next].filter(([file, signature]) => this.signatures.has(file) && this.signatures.get(file) !== signature).map(([file]) => file)
      : [];
    this.signatures = next;
    this.primed = true;
    for (const file of changed) {
      for (const listener of [...this.listeners]) {
        try {
          listener(file);
        } catch (error) {
          console.warn('[antigravity] un aviso de cambio del indice fallo:', error);
        }
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
    this.stop();
  }

  private start(): void {
    if (this.timer !== null) return;
    this.generation += 1;
    this.signatures = new Map();
    this.primed = false;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Sin esto, un script que olvida desuscribirse no termina.
    this.timer.unref();
    void this.tick();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
  }
}
