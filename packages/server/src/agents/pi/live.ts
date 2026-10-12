/**
 * Lo que se sabe de cada sesion de Pi que tiene un proceso vivo, leyendo lo que
 * su archivo gana desde que se lanzo.
 *
 * Pi avisa su estado por la terminal (OSC 7501), pero solo si la terminal le
 * contesta una consulta, y en Windows la app no puede: ConPTY descarta la
 * respuesta (CLAUDE.md 16.6). **El archivo alcanza**: el mensaje del usuario se
 * escribe al enviar y la respuesta final al terminar, asi que desde una linea
 * `user` hasta una `assistant` que cierra el turno, Pi esta trabajando.
 *
 * De aca salen tres cosas, todas con la misma lectura:
 *
 *  - **El estado de la pestana** (`PiStatusSource`): trabajando, libre, o
 *    esperando al usuario en el dialogo de confianza, que no esta en el archivo
 *    y lo avisa el gancho de la pestana (`tab-watch.ts`).
 *  - **Que mensajes de la app llegaron a la sesion**, para saber cuales
 *    devolvio Pi a su editor al interrumpir (`check`, 16.5).
 *  - **Que escribio el usuario en la sesion en curso**, para no confundirla con
 *    otra al mirar si la pestana cambio de sesion.
 *
 * Solo cuenta lo escrito desde el lanzamiento: una sesion que quedo a medias
 * con un proceso anterior no esta "trabajando" porque se la vuelva a abrir.
 */

import { open, stat } from 'node:fs/promises';
import type { AgentStatus, StatusSource } from '../adapter.js';
import { parseJsonlLine } from '../../jsonl-reader.js';
import { TRANSPORT_LIMITS } from '../transport-limits.js';
import { findSessionFile } from './paths.js';
import { plainMatches, readEntry } from './session-entries.js';

/** Cada cuanto se mira el archivo de cada sesion viva: un `stat`, y los bytes nuevos si hay. */
export const PI_LIVE_POLL_MS = 500;

/**
 * Cuanto se espera despues de un error del proveedor antes de decir "libre".
 * Pi puede reintentar sola, y avisar que termino para volver a trabajar al
 * instante haria sonar un aviso de mas.
 */
export const PI_ERROR_CALM_MS = 2_000;

/** Lo que el dialogo de confianza pone en `waitingFor`. */
export const PI_TRUST_WAITING = 'trust dialog';

/** Cuantos mensajes del usuario se recuerdan por sesion. */
const USER_MESSAGES_KEPT = 30;

/** Margen entre el reloj de la app y la hora que Pi escribe en cada entrada. */
const CLOCK_SLACK_MS = 2_000;

const READ_CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

export interface PiLiveDeps {
  findFile?: (sessionId: string, cwd: string | null) => Promise<string | null>;
  now?: () => number;
  pollMs?: number;
}

/**
 * true si Pi toma ese texto como un comando y no como un mensaje: empieza con
 * `/` (`/model`, `/thinking`, lo que mandan los combos) o con `!` (un comando de
 * shell). Ninguno de los dos se escribe en la sesion como mensaje del usuario,
 * asi que no se puede esperar verlo ahi.
 */
export function isPiCommandText(text: string): boolean {
  return /^\s*[/!]/.test(text);
}

/** Un mensaje que la app mando por el cuadro. */
export interface PiSubmission {
  text: string;
  /** Epoch ms de cuando se escribio en la pty. */
  at: number;
}

interface LiveSession {
  sessionId: string;
  cwd: string;
  launchedAt: number;
  file: string | null;
  offset: number;
  pending: Buffer;
  lineNumber: number;
  /** true si el dialogo de confianza esta abierto. */
  blocked: boolean;
  turn: { state: 'working' | 'idle' | 'errored'; at: number; seenAt: number } | null;
  userMessages: { plain: string; at: number }[];
  /** Epoch ms de la ultima entrada que cerro un turno o un comando `!`. */
  settledAt: number | null;
  reading: Promise<void>;
}

interface Subscription {
  sessionId: string;
  listener: (status: AgentStatus | null) => void;
  last: string | null;
}

export class PiLiveSessions {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly findFile: (sessionId: string, cwd: string | null) => Promise<string | null>;
  private readonly now: () => number;
  private readonly pollMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(deps: PiLiveDeps = {}) {
    this.findFile = deps.findFile ?? findSessionFile;
    this.now = deps.now ?? Date.now;
    this.pollMs = deps.pollMs ?? PI_LIVE_POLL_MS;
  }

  /**
   * Una sesion gana un proceso. `file` es su archivo si ya se conoce; `fromStart`
   * lo lee desde el principio (una sesion a la que la pestana acaba de pasar),
   * y si no, desde donde esta ahora: lo anterior es de otro proceso.
   */
  attach(
    sessionId: string,
    options: { cwd: string; launchedAt: number; file?: string | null; fromStart?: boolean },
  ): void {
    const live: LiveSession = {
      sessionId,
      cwd: options.cwd,
      launchedAt: options.launchedAt,
      file: options.file ?? null,
      offset: 0,
      pending: Buffer.alloc(0),
      lineNumber: 0,
      blocked: false,
      turn: null,
      userMessages: [],
      settledAt: null,
      reading: Promise.resolve(),
    };
    this.sessions.set(sessionId, live);
    live.reading = this.prime(live, options.fromStart === true).then(() => this.publish(sessionId));
    this.start();
  }

  /** El proceso de esa sesion termino, o la pestana paso a otra. */
  detach(sessionId: string): void {
    if (!this.sessions.delete(sessionId)) return;
    this.publish(sessionId);
    if (this.sessions.size === 0) this.stop();
  }

  /** El archivo que se esta leyendo para esa sesion, o null. */
  fileOf(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.file ?? null;
  }

  /** El dialogo de confianza se abrio o se cerro. */
  setBlocked(sessionId: string, blocked: boolean): void {
    const live = this.sessions.get(sessionId);
    if (live === undefined || live.blocked === blocked) return;
    live.blocked = blocked;
    this.publish(sessionId);
  }

  /** true si la sesion ya recibio un mensaje del usuario con ese texto, mandado en `since` o despues. */
  delivered(sessionId: string, submission: PiSubmission): boolean {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return false;
    return live.userMessages.some(
      (message) => message.at >= submission.at - CLOCK_SLACK_MS && plainMatches(message.plain, submission.text),
    );
  }

  /** true si la sesion recibio algun mensaje del usuario en `since` o despues. */
  userMessageSince(sessionId: string, since: number): boolean {
    return this.sessions.get(sessionId)?.userMessages.some((message) => message.at >= since) ?? false;
  }

  /**
   * Despues de interrumpir desde la app: si el turno ya quedo cerrado en el
   * archivo, y cuales de esos mensajes no llegaron nunca a la sesion (los que Pi
   * tenia en cola y devolvio a su editor, 16.5). Lee el archivo en el acto.
   */
  async check(
    sessionId: string,
    submissions: readonly PiSubmission[],
    interruptedAt: number,
  ): Promise<{ settled: boolean; undelivered: string[] }> {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return { settled: false, undelivered: [] };
    await this.advance(live);
    return {
      settled: live.settledAt !== null && live.settledAt >= interruptedAt - CLOCK_SLACK_MS / 4,
      undelivered: submissions
        // Un comando no queda en cola ni se escribe como mensaje: nunca "falto entregar".
        .filter((submission) => !isPiCommandText(submission.text) && !this.delivered(sessionId, submission))
        .map((each) => each.text),
    };
  }

  /** El estado de esa sesion ahora, o null si no tiene proceso. */
  statusOf(sessionId: string): AgentStatus | null {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return null;
    if (live.blocked) return { activity: 'waiting', waitingFor: PI_TRUST_WAITING };
    const turn = live.turn;
    if (turn === null) return { activity: 'idle', waitingFor: null };
    if (turn.state === 'working') return { activity: 'busy', waitingFor: null };
    if (turn.state === 'errored' && this.now() - turn.seenAt < PI_ERROR_CALM_MS) return { activity: 'busy', waitingFor: null };
    return { activity: 'idle', waitingFor: null };
  }

  subscribe(sessionId: string, listener: (status: AgentStatus | null) => void): () => void {
    const subscription: Subscription = { sessionId, listener, last: null };
    this.subscriptions.add(subscription);
    this.deliver(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /** Lee ya lo nuevo de esa sesion y avisa lo que cambio. */
  async refresh(sessionId: string): Promise<void> {
    const live = this.sessions.get(sessionId);
    if (live === undefined) return;
    await this.advance(live);
    this.publish(sessionId);
  }

  /** Una vuelta del sondeo. Publica para el chequeo. */
  async tick(): Promise<void> {
    for (const live of [...this.sessions.values()]) {
      await this.advance(live);
      this.publish(live.sessionId);
    }
  }

  dispose(): void {
    this.subscriptions.clear();
    this.sessions.clear();
    this.stop();
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    // Que un sondeo de fondo no mantenga vivo el proceso al apagarse.
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private publish(sessionId: string): void {
    for (const subscription of this.subscriptions) {
      if (subscription.sessionId === sessionId) this.deliver(subscription);
    }
  }

  private deliver(subscription: Subscription): void {
    const status = this.statusOf(subscription.sessionId);
    const key = status === null ? 'none' : `${status.activity}|${status.waitingFor ?? ''}`;
    if (key === subscription.last) return;
    subscription.last = key;
    subscription.listener(status);
  }

  /** Fija desde donde se lee: el final de lo que ya habia, salvo `fromStart`. */
  private async prime(live: LiveSession, fromStart: boolean): Promise<void> {
    if (live.file === null) live.file = await this.findFile(live.sessionId, live.cwd).catch(() => null);
    if (live.file === null || fromStart) return;
    try {
      live.offset = (await stat(live.file)).size;
    } catch {
      live.offset = 0;
    }
  }

  /** Lee las lineas nuevas del archivo, en serie con la lectura anterior. Nunca lanza. */
  private advance(live: LiveSession): Promise<void> {
    live.reading = live.reading
      .then(() => this.readNew(live))
      .catch(() => undefined);
    return live.reading;
  }

  private async readNew(live: LiveSession): Promise<void> {
    if (this.sessions.get(live.sessionId) !== live) return;
    if (live.file === null) {
      // Una sesion nueva no tiene archivo hasta su primer mensaje: todo lo que traiga es de este proceso.
      live.file = await this.findFile(live.sessionId, live.cwd).catch(() => null);
      if (live.file === null) return;
    }

    let size: number;
    try {
      size = (await stat(live.file)).size;
    } catch {
      return;
    }
    if (size < live.offset) {
      // Reescrito mas chico: lo que se sabia ya no vale.
      live.offset = 0;
      live.pending = Buffer.alloc(0);
      live.lineNumber = 0;
    }
    if (size === live.offset) return;

    const handle = await open(live.file, 'r');
    try {
      const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
      while (live.offset < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(READ_CHUNK_BYTES, size - live.offset), live.offset);
        if (bytesRead === 0) break;
        live.offset += bytesRead;
        const combined = Buffer.concat([live.pending, buffer.subarray(0, bytesRead)]);
        let start = 0;
        let newline = combined.indexOf(NEWLINE, start);
        while (newline !== -1) {
          this.consume(live, combined.subarray(start, newline).toString('utf8'));
          start = newline + 1;
          newline = combined.indexOf(NEWLINE, start);
        }
        live.pending = Buffer.from(combined.subarray(start));
      }
    } finally {
      await handle.close();
    }
  }

  private consume(live: LiveSession, line: string): void {
    live.lineNumber += 1;
    if (line.trim().length === 0) return;
    const record = parseJsonlLine(line);
    const entry = record === null ? null : readEntry(record, live.lineNumber, TRANSPORT_LIMITS);
    if (entry === null) return;
    // Lo de un proceso anterior no dice nada del de ahora. Sin hora no se puede saber: cuenta.
    if (entry.at !== 0 && entry.at < live.launchedAt - CLOCK_SLACK_MS) return;

    const seenAt = this.now();
    const { fact } = entry;
    if (fact.kind === 'user') {
      live.turn = { state: 'working', at: entry.at, seenAt };
      live.userMessages.push({ plain: fact.plain, at: entry.at });
      if (live.userMessages.length > USER_MESSAGES_KEPT) live.userMessages.shift();
    } else if (fact.kind === 'toolResult') {
      live.turn = { state: 'working', at: entry.at, seenAt };
    } else if (fact.kind === 'assistant') {
      if (fact.stopReason === 'toolUse') {
        live.turn = { state: 'working', at: entry.at, seenAt };
      } else {
        live.turn = { state: fact.stopReason === 'error' ? 'errored' : 'idle', at: entry.at, seenAt };
        live.settledAt = entry.at === 0 ? seenAt : entry.at;
      }
    } else if (fact.kind === 'bash') {
      live.settledAt = entry.at === 0 ? seenAt : entry.at;
      if (live.turn === null || live.turn.state !== 'working') live.turn = { state: 'idle', at: entry.at, seenAt };
    }
  }
}

/** La fuente de estado del adaptador, sobre las sesiones vivas. */
export class PiStatusSource implements StatusSource {
  constructor(private readonly live: PiLiveSessions) {}

  subscribe(sessionId: string, listener: (status: AgentStatus | null) => void): () => void {
    return this.live.subscribe(sessionId, listener);
  }

  /**
   * Siempre false: que el archivo diga "libre" no dice que la interfaz de Pi
   * este lista para un pegado, y antes del primer mensaje ni siquiera hay
   * archivo (`readySignal` es false).
   */
  waitUntilReady(): Promise<boolean> {
    return Promise.resolve(false);
  }

  refresh(sessionId: string): Promise<void> {
    return this.live.refresh(sessionId);
  }

  dispose(): void {
    this.live.dispose();
  }
}
