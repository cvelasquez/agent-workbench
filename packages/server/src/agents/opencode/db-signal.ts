/**
 * "La base de OpenCode cambio": un sondeo de `stat` sobre `opencode.db` y su
 * `-wal`, no un watcher.
 *
 * Tres motivos:
 *
 *  - **Lo que hay que mirar es un archivo que otro proceso mantiene abierto y
 *    escribe.** Es el caso en el que chokidar en Windows avisa tarde, agrupado o
 *    nunca (§10.10, con Codex). Con `usePolling` seria este mismo sondeo con
 *    reglas ajenas sobre un `-wal` que aparece y desaparece.
 *  - **La fecha del `-wal` si se mueve con el escritor abierto.** Medido el
 *    12-09-2026 con un escritor en otro proceso y un commit cada 150 ms: el
 *    `mtime` del `-wal` cambio en 60 de 60 commits, dentro de 300 ms, tambien
 *    con `wal_autocheckpoint` en 8, donde el WAL vuelve a empezar y el tamano
 *    casi no cambia. Por eso la firma lleva fecha **y** tamano de los dos.
 *  - **Es barato.** Dos `stat` cuestan 0,14 ms (medido), y el temporizador solo
 *    corre mientras alguien escucha.
 *
 * El `-shm` no entra en la firma: lo toca nuestra propia lectura, y mirarlo
 * haria que cada consulta avisara un cambio que dispara otra consulta.
 */

import { stat as statFile } from 'node:fs/promises';

export interface FileStamp {
  mtimeMs: number;
  size: number;
}

export interface DbChangeSignalOptions {
  /** Cada cuanto se mira. */
  intervalMs?: number;
  /** null si el archivo no esta. Si lanza, esa vuelta no cuenta. */
  stat?: (file: string) => Promise<FileStamp | null>;
  /** Para el chequeo. */
  timers?: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
}

export const DB_SIGNAL_INTERVAL_MS = 500;

/** `stat` que devuelve null si el archivo no existe, y lanza con cualquier otro error. */
export async function statStamp(file: string): Promise<FileStamp | null> {
  try {
    const info = await statFile(file);
    return { mtimeMs: info.mtimeMs, size: info.size };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

const signatureOf = (db: FileStamp | null, wal: FileStamp | null): string =>
  `${db?.mtimeMs}:${db?.size}:${wal?.mtimeMs}:${wal?.size}`;

export class DbChangeSignal {
  private readonly listeners = new Set<() => void>();
  private readonly intervalMs: number;
  private readonly stat: (file: string) => Promise<FileStamp | null>;
  private readonly timers: { setInterval: typeof setInterval; clearInterval: typeof clearInterval };
  private timer: ReturnType<typeof setInterval> | null = null;
  /** La ultima firma vista desde que arranco el sondeo; null hasta la primera vuelta. */
  private signature: string | null = null;
  private ticking = false;
  /** Sube cada vez que el sondeo arranca o se detiene: una vuelta vieja no avisa. */
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly files: { db: string; wal: string } | null,
    options: DbChangeSignalOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DB_SIGNAL_INTERVAL_MS;
    this.stat = options.stat ?? statStamp;
    this.timers = options.timers ?? { setInterval, clearInterval };
  }

  /**
   * Avisa cada cambio de la base. El primer suscriptor arranca el sondeo y el
   * ultimo lo detiene. Sin base configurada no arranca nada.
   */
  subscribe(listener: () => void): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      if (!this.listeners.delete(listener)) return;
      if (this.listeners.size === 0) this.stop();
    };
  }

  /**
   * Una vuelta del sondeo. Publica para el chequeo.
   *
   * La primera despues de arrancar fija la firma sin avisar. No se solapa: si
   * la anterior sigue esperando un `stat`, esta no hace nada.
   */
  async tick(): Promise<void> {
    if (this.files === null || this.listeners.size === 0 || this.ticking) return;
    this.ticking = true;
    const generation = this.generation;
    let next: string;
    try {
      const [db, wal] = await Promise.all([this.stat(this.files.db), this.stat(this.files.wal)]);
      next = signatureOf(db, wal);
    } catch {
      // Un `stat` que falla (un archivo a medio reemplazar, un permiso) no es un cambio.
      return;
    } finally {
      this.ticking = false;
    }
    if (generation !== this.generation) return;

    const previous = this.signature;
    this.signature = next;
    if (previous === null || previous === next) return;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[opencode] a database change listener failed:', error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.stop();
  }

  private start(): void {
    if (this.files === null || this.timer !== null) return;
    this.generation += 1;
    this.signature = null;
    this.timer = this.timers.setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    // Sin esto, un script que olvida desuscribirse no termina.
    (this.timer as { unref?: () => void }).unref?.();
    void this.tick();
  }

  private stop(): void {
    if (this.timer === null) return;
    this.timers.clearInterval(this.timer);
    this.timer = null;
    this.generation += 1;
    this.signature = null;
  }
}
