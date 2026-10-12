/**
 * El gancho de una pestana de Pi: vive mientras viva su proceso.
 *
 * Pi nace con el id de sesion que le pone la app, asi que aca no hay nada que
 * descubrir al lanzar. Lo que hay que mirar pasa despues, y son dos cosas:
 *
 *  1. **El dialogo de confianza** (CLAUDE.md 16.11). En un proyecto con
 *     `.agents/skills` o una carpeta `.pi/`, Pi pregunta "Trust project
 *     folder?" antes de mostrar nada, con "Trust" ya marcado: un Enter de la
 *     app lo aceptaria sin que el usuario lo decida. Mientras este abierto, la
 *     pestana dice que espera y el cuadro no manda. La app no lo contesta.
 *  2. **La sesion cambia dentro del mismo proceso** (16.7): `/new`, `/fork` y
 *     `/resume` dejan a Pi escribiendo en otro archivo. La pestana pasa a esa
 *     sesion cuando se puede decir que es suya —un `/fork` nombra su origen; si
 *     no, el ultimo mensaje del archivo es el que mando esta pestana, o se
 *     escribio justo despues de un Enter tecleado en ella—.
 *
 * El gancho no escribe nunca en la pty. Solo lee la salida, para lo primero, y
 * la carpeta de sesiones del proyecto, para lo segundo, y eso ultimo solo
 * despues de un Enter: un cambio de sesion siempre empieza con uno.
 */

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { normalizeCwdKey } from '@agent-workbench/shared';
import type { LaunchHook, SpawnedContext } from '../adapter.js';
import { parseJsonlLine, readTailLines } from '../../jsonl-reader.js';
import { debugLog } from '../../debug.js';
import { TRANSPORT_LIMITS } from '../transport-limits.js';
import { isPiSessionId } from './constants.js';
import type { PiLiveSessions, PiSubmission } from './live.js';
import { parseSessionFileName, sessionDirFor } from './paths.js';
import { plainMatches, readEntry, type PiSessionHeader } from './session-entries.js';
import { readSessionHeader } from './session-scan.js';

/** El titulo del dialogo, tal como lo escribe Pi (medido con la 1.1.0). */
const TRUST_TITLE = 'Trust project folder?';

/**
 * Pi entra a la pantalla alternativa cuando arranca su interfaz, y eso pasa
 * despues de contestar el dialogo (medido). No depende de como el usuario tenga
 * configuradas las teclas, que es lo que cambiaria el texto de la cabecera.
 */
const INTERFACE_STARTED = '\x1b[?1049h';

/** true si en esa salida el dialogo de confianza esta abierto. */
export function trustDialogOpen(output: string): boolean {
  const title = output.lastIndexOf(TRUST_TITLE);
  return title !== -1 && output.lastIndexOf(INTERFACE_STARTED) < title;
}

/** true si la interfaz de Pi ya arranco: el dialogo, si lo hubo, quedo atras. */
export function interfaceStarted(output: string): boolean {
  return output.includes(INTERFACE_STARTED) && !trustDialogOpen(output);
}

/** Cada cuanto se mira la salida mientras Pi arranca. */
const STARTUP_CHECK_MS = 300;
/** Hasta cuando se espera que arranque sin dialogo. Con el dialogo abierto se sigue mirando. */
const STARTUP_DEADLINE_MS = 60_000;

/** Cuando se mira la carpeta de sesiones despues de un Enter. Pi escribe a los ~50 ms. */
const SCAN_DELAYS_MS: readonly number[] = [400, 1_500, 4_000];

/** Cuanto despues de un Enter tecleado puede aparecer el mensaje en otra sesion. */
const TYPED_WINDOW_MS = 3_000;
const CLOCK_SLACK_MS = 2_000;

/** Lo que la app mando y todavia puede aparecer en otra sesion. */
const SUBMISSIONS_KEPT = 20;
const SUBMISSION_MAX_AGE_MS = 5 * 60_000;

/** Cola que se lee de un archivo candidato para ver su ultimo mensaje. */
const PEEK_TAIL_BYTES = 256 * 1024;

export interface PiSessionFileInfo {
  file: string;
  size: number;
  mtimeMs: number;
}

/** Lo que se mira de un archivo que no es el de la pestana. */
export interface PiSessionPeek {
  header: PiSessionHeader;
  lastUser: { plain: string; at: number } | null;
}

export interface PiTabWatchDeps {
  live: PiLiveSessions;
  /** Las pestanas vivas de Pi, esta incluida: para no quedarse con la sesion de otra. */
  tabs: () => Iterable<PiTabWatch>;
  listSessions?: (dir: string) => Promise<PiSessionFileInfo[]>;
  peek?: (file: string) => Promise<PiSessionPeek | null>;
  sessionDir?: (cwd: string) => string | null;
  now?: () => number;
  platform?: string;
  /** false en el chequeo: las pasadas se piden a mano. */
  timers?: boolean;
}

async function listSessionsIn(dir: string): Promise<PiSessionFileInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const files: PiSessionFileInfo[] = [];
  for (const name of names) {
    if (parseSessionFileName(name) === null) continue;
    try {
      const info = await stat(path.join(dir, name));
      if (info.isFile()) files.push({ file: path.join(dir, name), size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Borrado entre el listado y el stat.
    }
  }
  return files;
}

async function peekSession(file: string): Promise<PiSessionPeek | null> {
  try {
    const header = await readSessionHeader(file);
    if (header === null) return null;
    const tail = await readTailLines(file, { maxBytes: PEEK_TAIL_BYTES });
    for (let index = tail.length - 1; index >= 0; index -= 1) {
      const line = tail[index];
      if (line === undefined || !line.includes('"user"')) continue;
      const record = parseJsonlLine(line);
      const entry = record === null ? null : readEntry(record, index + 1, TRANSPORT_LIMITS);
      if (entry !== null && entry.fact.kind === 'user') return { header, lastUser: { plain: entry.fact.plain, at: entry.at } };
    }
    return { header, lastUser: null };
  } catch {
    return null;
  }
}

export class PiTabWatch {
  private readonly live: PiLiveSessions;
  private readonly tabs: () => Iterable<PiTabWatch>;
  private readonly listSessions: (dir: string) => Promise<PiSessionFileInfo[]>;
  private readonly peek: (file: string) => Promise<PiSessionPeek | null>;
  private readonly sessionDir: (cwd: string) => string | null;
  private readonly now: () => number;
  private readonly platform: string;
  private readonly useTimers: boolean;

  /** La sesion en la que esta la pestana ahora. `''` si el id con que nacio no es de Pi. */
  private sessionId: string;
  /** El archivo de esa sesion, si ya se sabe cual es. */
  private file: string | null = null;
  /** Tamano de cada archivo de la carpeta la ultima vez que se miro. null: todavia no se miro. */
  private sizes: Map<string, number> | null = null;
  private submissions: PiSubmission[] = [];
  private enterAt: number | null = null;
  private closed = false;
  private scanning: Promise<void> = Promise.resolve();
  private startupTimer: NodeJS.Timeout | null = null;
  private readonly scanTimers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly context: Pick<
      SpawnedContext,
      'terminalId' | 'sessionId' | 'cwd' | 'launchedAt' | 'readOutput' | 'reportSessionId'
    >,
    deps: PiTabWatchDeps,
  ) {
    this.live = deps.live;
    this.tabs = deps.tabs;
    this.listSessions = deps.listSessions ?? listSessionsIn;
    this.peek = deps.peek ?? peekSession;
    this.sessionDir = deps.sessionDir ?? ((cwd) => sessionDirFor(cwd));
    this.now = deps.now ?? Date.now;
    this.platform = deps.platform ?? process.platform;
    this.useTimers = deps.timers ?? true;
    this.sessionId = isPiSessionId(context.sessionId) ? context.sessionId : '';
  }

  /** El archivo de la sesion en curso, para que otra pestana no se la quede. */
  get currentFile(): string | null {
    return this.file ?? (this.sessionId.length > 0 ? this.live.fileOf(this.sessionId) : null);
  }

  get cwd(): string {
    return this.context.cwd;
  }

  /** Epoch ms del ultimo Enter escrito en la pty de esta pestana, o null. */
  get lastEnterAt(): number | null {
    return this.enterAt;
  }

  start(): void {
    if (this.sessionId.length > 0) {
      this.live.attach(this.sessionId, { cwd: this.context.cwd, launchedAt: this.context.launchedAt });
    }
    // La foto de la carpeta al lanzar: lo que crezca despues es de este rato.
    void this.scan();
    if (!this.useTimers) return;
    this.startupTimer = setInterval(() => this.checkTrust(), STARTUP_CHECK_MS);
    this.startupTimer.unref();
  }

  hook(): LaunchHook {
    return {
      cancel: () => this.close(),
      onInput: (data) => {
        if (data.includes('\r')) this.noteEnter();
      },
      onSubmitted: (text) => this.noteSubmitted(text),
    };
  }

  /** Mira la salida: el dialogo de confianza abierto frena el cuadro. Publica para el chequeo. */
  checkTrust(): void {
    if (this.closed || this.sessionId.length === 0) return;
    const output = this.context.readOutput();
    const open = trustDialogOpen(output);
    this.live.setBlocked(this.sessionId, open);
    if (open) return;
    // Sin dialogo y con la interfaz arriba no hay mas que mirar; tampoco pasado el plazo.
    if (interfaceStarted(output) || this.now() - this.context.launchedAt > STARTUP_DEADLINE_MS) {
      if (this.startupTimer !== null) clearInterval(this.startupTimer);
      this.startupTimer = null;
    }
  }

  /** Alguien apreto Enter en la pty: puede ser el que cambia de sesion. */
  noteEnter(): void {
    if (this.closed) return;
    this.enterAt = this.now();
    this.scheduleScans();
  }

  /** La app va a mandar este texto. */
  noteSubmitted(text: string): void {
    if (this.closed || text.trim().length === 0) return;
    const now = this.now();
    this.submissions = [
      ...this.submissions.filter((each) => now - each.at < SUBMISSION_MAX_AGE_MS),
      { text, at: now },
    ].slice(-SUBMISSIONS_KEPT);
  }

  private scheduleScans(): void {
    if (!this.useTimers) return;
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers.clear();
    for (const delay of SCAN_DELAYS_MS) {
      const timer = setTimeout(() => {
        this.scanTimers.delete(timer);
        void this.scan();
      }, delay);
      timer.unref();
      this.scanTimers.add(timer);
    }
  }

  /** Una pasada por la carpeta de sesiones del proyecto, en serie con la anterior. Nunca lanza. */
  scan(): Promise<void> {
    this.scanning = this.scanning.then(() => this.scanOnce()).catch(() => undefined);
    return this.scanning;
  }

  private async scanOnce(): Promise<void> {
    if (this.closed) return;
    const dir = this.sessionDir(this.context.cwd);
    if (dir === null) return;
    const files = await this.listSessions(dir);
    if (this.closed) return;

    const previous = this.sizes;
    this.sizes = new Map(files.map((each) => [each.file, each.size]));
    if (this.file === null && this.sessionId.length > 0) {
      this.file = files.find((each) => parseSessionFileName(path.basename(each.file))?.sessionId === this.sessionId)?.file ?? null;
    }
    // La primera pasada solo saca la foto.
    if (previous === null) return;

    const own = this.currentFile;
    const taken = new Set<string>();
    for (const tab of this.tabs()) {
      const file = tab === this ? null : tab.currentFile;
      if (file !== null) taken.add(this.fileKey(file));
    }

    const candidates = files
      .filter((each) => {
        if (own !== null && this.fileKey(each.file) === this.fileKey(own)) return false;
        if (taken.has(this.fileKey(each.file))) return false;
        const before = previous.get(each.file);
        if (before !== undefined && each.size <= before) return false;
        return each.mtimeMs >= this.context.launchedAt - CLOCK_SLACK_MS;
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const candidate of candidates) {
      const info = await this.peek(candidate.file);
      if (this.closed) return;
      if (info === null || !isPiSessionId(info.header.sessionId)) continue;
      // Con todas las sesiones sueltas en una carpeta, las de otro proyecto no cuentan.
      if (normalizeCwdKey(info.header.cwd, this.platform) !== normalizeCwdKey(this.context.cwd, this.platform)) continue;
      const reason = this.claims(info, !previous.has(candidate.file));
      if (reason === null) continue;
      this.switchTo(info.header.sessionId, candidate.file, reason);
      return;
    }
  }

  private fileKey(file: string): string {
    return normalizeCwdKey(file, this.platform);
  }

  /** Por que ese archivo es la sesion nueva de esta pestana, o null si no se puede decir. */
  private claims(info: PiSessionPeek, isNew: boolean): string | null {
    const own = this.currentFile;
    if (isNew && own !== null && info.header.parentSession !== null && this.fileKey(info.header.parentSession) === this.fileKey(own)) {
      return 'fork';
    }
    const last = info.lastUser;
    if (last === null) return null;

    const now = this.now();
    const sent = this.submissions.some(
      (each) =>
        now - each.at < SUBMISSION_MAX_AGE_MS &&
        last.at >= each.at - CLOCK_SLACK_MS &&
        plainMatches(last.plain, each.text) &&
        // Si ya llego a la sesion en curso, no es de la otra.
        (this.sessionId.length === 0 || !this.live.delivered(this.sessionId, each)),
    );
    if (sent) return 'submitted';

    const enterAt = this.enterAt;
    if (enterAt === null || last.at < enterAt - CLOCK_SLACK_MS / 4 || last.at > enterAt + TYPED_WINDOW_MS) return null;
    if (this.sessionId.length > 0 && this.live.userMessageSince(this.sessionId, enterAt - CLOCK_SLACK_MS / 4)) return null;

    // Con otra pestana de Pi en la misma carpeta que tambien tecleo, gana la del Enter mas cercano.
    const key = normalizeCwdKey(this.context.cwd, this.platform);
    let rivals = 0;
    for (const tab of this.tabs()) {
      if (tab === this || normalizeCwdKey(tab.cwd, this.platform) !== key) continue;
      const other = tab.lastEnterAt;
      if (other === null || last.at < other - CLOCK_SLACK_MS / 4 || last.at > other + TYPED_WINDOW_MS) continue;
      if (Math.abs(last.at - other) < Math.abs(last.at - enterAt)) return null;
      rivals += 1;
    }
    if (rivals > 0) {
      console.warn(
        `[pi] ${rivals + 1} Pi tabs in ${this.context.cwd} typed at the same time: session ${info.header.sessionId.slice(0, 8)} was assigned to the closest one without confirmation.`,
      );
    }
    return 'typed';
  }

  private switchTo(sessionId: string, file: string, reason: string): void {
    const previous = this.sessionId;
    if (sessionId === previous) return;
    debugLog('registry', `pi tab ${this.context.terminalId.slice(0, 8)}: session ${sessionId.slice(0, 8)} (${reason})`);
    this.sessionId = sessionId;
    this.file = file;
    this.submissions = [];
    // La nueva antes de soltar la vieja: asi la pestana no pasa por "sin proceso".
    this.live.attach(sessionId, { cwd: this.context.cwd, launchedAt: this.context.launchedAt, file, fromStart: true });
    this.context.reportSessionId(sessionId);
    if (previous.length > 0) this.live.detach(previous);
  }

  private close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.startupTimer !== null) clearInterval(this.startupTimer);
    this.startupTimer = null;
    for (const timer of this.scanTimers) clearTimeout(timer);
    this.scanTimers.clear();
    if (this.sessionId.length > 0) this.live.detach(this.sessionId);
  }
}
