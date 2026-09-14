/**
 * Que conversacion de Antigravity CLI corre en una pestana, leido del log de la
 * CLI.
 *
 * La CLI no acepta un id al lanzar (no hay `--session-id`) y la conversacion no
 * nace al abrir la pestana: nace con el primer mensaje o con `/clear` (medido en
 * la 1.2.2). Lo unico que dice cual es, en el momento, es su log:
 *
 * ```
 * I0914 00:56:30.613588      51 server.go:1560] Starting language server process with pid 38272
 * I0914 00:56:33.274207     674 server.go:1177] Created conversation <uuid>
 * I0914 00:56:33.275871     674 conversation_manager.go:821] Streaming conversation <uuid>
 * ```
 *
 * **Camino principal: un log por lanzamiento.** Cada pestana lanza la CLI con
 * `--log-file` apuntando a un archivo propio (`launchToken`), asi que dos
 * pestanas del mismo proyecto abiertas en el mismo segundo no se confunden.
 * Medido 4 de 4: el archivo aparece en el acto, con `--log-file` la CLI no
 * escribe su log de siempre, `/clear` y `/resume` escriben otra vez la misma
 * linea con el id nuevo, y reanudar escribe solo `Streaming`. Por eso el log se
 * sigue toda la vida de la pestana.
 *
 * **Respaldo: por pid**, si el archivo propio no aparece en 20 s (una version
 * que ignore la opcion). Se buscan en `~/.gemini/antigravity-cli/log/` los
 * `cli-*.log` recientes y de cada uno se lee **solo la primera linea**, hasta
 * dar con la del pid de la pty (medido: coincide 4 de 4). Ese archivo es de la
 * CLI y no se borra nunca.
 *
 * El log trae el texto de los prompts y el email de la cuenta: de cada linea se
 * aplican las dos expresiones de abajo y nada mas. No se guarda, no se loguea y
 * no se reenvia ninguna.
 */

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { cliLogRoot } from './paths.js';

export const CONVERSATION_LINE =
  /\] (?:Created|Streaming) conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*$/i;
export const PID_LINE = /\] Starting language server process with pid (\d+)\s*$/;

/** Cada cuanto se mira el log. La barra de pestanas no necesita menos. */
export const LOG_POLL_INTERVAL_MS = 1_000;
/** Despues de escribir en la pty se mira antes: el id sale a los 60 ms del Enter. */
export const LOG_NUDGE_MS = 200;
/** Cuanto se espera el log propio antes de pasar al respaldo por pid. */
export const OWN_LOG_GRACE_MS = 20_000;
/** Hasta cuando se busca, desde el lanzamiento, el log de la CLI con el pid. */
export const FALLBACK_WINDOW_MS = 60_000;
/** Tope de cada lectura y de todo lo que se lee de un log. */
export const LOG_READ_LIMITS = { perReadBytes: 4 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };
/** Una linea mas larga que esto no es ninguna de las dos que se buscan (un prompt largo). */
const MAX_LINE_BYTES = 64 * 1024;
/** Cuanto se lee para la primera linea de un candidato del respaldo. */
const FIRST_LINE_BYTES = 4 * 1024;

/**
 * Las lineas completas nuevas de un archivo que otro proceso escribe.
 *
 * Mismas reglas que el seguidor del historial: el resto parcial se guarda en
 * bytes (una lectura corta en cualquier byte), y si el archivo encoge se vuelve
 * a empezar.
 */
export class LogLineReader {
  private offset = 0;
  private total = 0;
  private remainder: Buffer = Buffer.alloc(0);
  /** true mientras se descarta una linea demasiado larga, hasta su salto. */
  private skipping = false;

  constructor(
    readonly file: string,
    private readonly limits = LOG_READ_LIMITS,
  ) {}

  /** true si ya se leyo el tope total: no se lee mas. */
  get exhausted(): boolean {
    return this.total >= this.limits.totalBytes;
  }

  /** Las lineas completas nuevas, o null si el archivo no esta. Lanza con otros errores. */
  async read(): Promise<string[] | null> {
    let handle;
    try {
      handle = await open(this.file, 'r');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
    try {
      const { size } = await handle.stat();
      if (size < this.offset) {
        this.offset = 0;
        this.remainder = Buffer.alloc(0);
        this.skipping = false;
      }
      const length = Math.min(size - this.offset, this.limits.perReadBytes, this.limits.totalBytes - this.total);
      if (length <= 0) return [];
      const chunk = Buffer.alloc(length);
      const { bytesRead } = await handle.read(chunk, 0, length, this.offset);
      this.offset += bytesRead;
      this.total += bytesRead;
      return this.split(chunk.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  private split(fresh: Buffer): string[] {
    let data = this.remainder.length > 0 ? Buffer.concat([this.remainder, fresh]) : fresh;
    if (this.skipping) {
      const newline = data.indexOf(0x0a);
      if (newline === -1) {
        this.remainder = Buffer.alloc(0);
        return [];
      }
      this.skipping = false;
      data = data.subarray(newline + 1);
    }
    const last = data.lastIndexOf(0x0a);
    if (last === -1) {
      if (data.length > MAX_LINE_BYTES) {
        this.remainder = Buffer.alloc(0);
        this.skipping = true;
      } else {
        this.remainder = Buffer.from(data);
      }
      return [];
    }
    this.remainder = Buffer.from(data.subarray(last + 1));
    if (this.remainder.length > MAX_LINE_BYTES) {
      this.remainder = Buffer.alloc(0);
      this.skipping = true;
    }
    return data.subarray(0, last).toString('utf8').split('\n');
  }
}

/** La primera linea completa de un archivo, o null si todavia no hay una (o no esta). */
async function firstLine(file: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(FIRST_LINE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, FIRST_LINE_BYTES, 0);
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a);
    // Sin salto en 4 KB: o se esta escribiendo, o la primera linea no es la del pid.
    if (newline === -1) return bytesRead >= FIRST_LINE_BYTES ? '' : null;
    return buffer.subarray(0, newline).toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface LogWatcherOptions {
  /** El log propio de este lanzamiento, o null si se lanzo sin `--log-file`. */
  logPath: string | null;
  /** Pid de la pty, para el respaldo. */
  pid: number;
  launchedAt: number;
  /** El id que ya se conoce (reanudar): se fija sin avisar. */
  initialId: string | null;
  /** Una conversacion distinta de la anterior. */
  onConversation(conversationId: string): void;
  /** Para los avisos: un pedazo del id de la pestana. */
  label?: string;
  intervalMs?: number;
  ownLogGraceMs?: number;
  fallbackWindowMs?: number;
  logRoot?: () => string;
  now?: () => number;
  warn?: (message: string) => void;
  readLimits?: typeof LOG_READ_LIMITS;
}

/** Desde donde se esta leyendo. Publico para el chequeo. */
export type LogWatcherSource = 'own' | 'searching' | 'fallback' | 'stopped';

export class LogWatcher {
  private readonly options: LogWatcherOptions;
  private readonly now: () => number;
  private readonly warn: (message: string) => void;
  private readonly intervalMs: number;
  private mode: LogWatcherSource;
  private reader: LogLineReader | null;
  /** Candidatos del respaldo ya descartados (su primera linea no era del pid). */
  private readonly checked = new Set<string>();
  private current: string | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dueAt = 0;
  private running: Promise<void> | null = null;
  private disposed = false;

  constructor(options: LogWatcherOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? ((message) => console.warn(message));
    this.intervalMs = options.intervalMs ?? LOG_POLL_INTERVAL_MS;
    this.mode = options.logPath === null ? 'searching' : 'own';
    this.reader = options.logPath === null ? null : new LogLineReader(options.logPath, options.readLimits);
    this.current = options.initialId?.toLowerCase() ?? null;
  }

  /** La conversacion que corre ahora, o null si todavia no hay. */
  get currentId(): string | null {
    return this.current;
  }

  get source(): LogWatcherSource {
    return this.mode;
  }

  start(): void {
    this.schedule(0);
  }

  /** Alguien escribio en la pty: el id puede estar por salir. */
  nudge(): void {
    this.schedule(LOG_NUDGE_MS);
  }

  /** Una pasada ya. No se solapa con otra. Publica para el chequeo y para la salida del proceso. */
  poll(): Promise<void> {
    if (this.running !== null) return this.running;
    const run = this.pass().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  /**
   * La ultima mirada, al salir el proceso: espera la pasada que este en curso
   * —pudo empezar antes de que la CLI escribiera su ultima linea— y hace otra.
   */
  async finalPass(): Promise<void> {
    if (this.running !== null) await this.running;
    await this.poll();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    if (this.disposed || this.mode === 'stopped') return;
    const due = this.now() + delayMs;
    if (this.timer !== null && this.dueAt <= due) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.dueAt = due;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll().finally(() => this.schedule(this.intervalMs));
    }, delayMs);
    this.timer.unref();
  }

  private async pass(): Promise<void> {
    if (this.disposed) return;
    const label = this.options.label ?? '';
    try {
      if (this.mode === 'own' && this.reader !== null) {
        const lines = await this.reader.read();
        if (lines !== null) {
          this.take(lines);
        } else if (this.now() - this.options.launchedAt >= (this.options.ownLogGraceMs ?? OWN_LOG_GRACE_MS)) {
          this.mode = 'searching';
          this.reader = null;
        }
      }
      if (this.mode === 'searching') await this.search(label);
      if (this.mode === 'fallback' && this.reader !== null) {
        const lines = await this.reader.read();
        if (lines !== null) this.take(lines);
      }
      if (this.reader?.exhausted === true && !this.disposed) {
        this.warn(`[antigravity] el log de ${label} paso 256 MB; dejo de seguirlo`);
        this.mode = 'stopped';
      }
    } catch {
      // Un log tomado un instante: la pasada siguiente lo vuelve a intentar.
    }
  }

  private async search(label: string): Promise<void> {
    const { launchedAt, pid } = this.options;
    if (this.now() - launchedAt > (this.options.fallbackWindowMs ?? FALLBACK_WINDOW_MS)) {
      this.warn(`[antigravity] no pude descubrir la conversacion de ${label}`);
      this.mode = 'stopped';
      return;
    }
    const root = (this.options.logRoot ?? cliLogRoot)();
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^cli-.*\.log$/i.test(name) || this.checked.has(name)) continue;
      const file = path.join(root, name);
      try {
        const info = await stat(file);
        if (!info.isFile() || info.mtimeMs < launchedAt - 2_000) continue;
      } catch {
        continue;
      }
      const line = await firstLine(file);
      if (line === null) continue;
      this.checked.add(name);
      const match = PID_LINE.exec(line.replace(/\r$/, ''));
      if (match !== null && Number(match[1]) === pid) {
        this.reader = new LogLineReader(file, this.options.readLimits);
        this.mode = 'fallback';
        return;
      }
    }
  }

  private take(lines: readonly string[]): void {
    // Una pasada que termino despues de soltar la pestana no avisa a nadie.
    if (this.disposed) return;
    for (const line of lines) {
      const match = CONVERSATION_LINE.exec(line);
      const id = match?.[1]?.toLowerCase();
      if (id === undefined || id === this.current) continue;
      this.current = id;
      try {
        this.options.onConversation(id);
      } catch (error) {
        console.warn('[antigravity] el aviso de conversacion nueva fallo:', error);
      }
    }
  }
}
