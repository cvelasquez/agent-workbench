/**
 * El seguidor de una sesion de Codex, tal como lo usa el hub.
 *
 * La diferencia con Claude Code es de donde sale la ruta. Alla se calcula del
 * `cwd` y el id; aca la carpeta es el dia local en que se creo el hilo, y hay
 * que buscarla (`findRollout`). Y puede no existir todavia: una sesion que se
 * acaba de descubrir tiene su archivo, pero una que se reanuda desde una
 * pestana guardada puede estar esperando a que el watcher lo vea.
 *
 * Con `sessionId ''` es un seguidor vacio: la pestana todavia no sabe que
 * sesion es, se queda en `waiting`, y el hub lo reemplaza cuando la sesion
 * aparece.
 *
 * Y la ruta puede cambiar de forma (§10.12): la app de escritorio de Codex
 * comprime el `.jsonl` en un `.jsonl.zst`, y `codex resume` reemplaza el
 * comprimido por el `.jsonl`. Cuando el archivo seguido desaparece, o llega un
 * aviso de la otra forma de la misma sesion, se vuelve a buscar —el `.jsonl`
 * gana— y se relee desde el principio, con un reinicio para el cliente.
 */

import path from 'node:path';
import {
  normalizeCwdKey,
  type ContextUsage,
  type ConversationImageSource,
  type ConversationState,
  type PermissionMode,
} from '@agent-workbench/shared';
import type { EventPage, LoadedImage, PollResult, SessionFollower } from '../adapter.js';
import { JsonlFollower } from '../jsonl-follower.js';
import { createRolloutFiles } from './compressed-rollout.js';
import { findReadableRollout } from './find-rollout.js';
import { parseCompressedRolloutFileName, parseRolloutFileName } from './paths.js';
import { loadRolloutImage } from './rollout-image.js';
import { CodexRolloutSink } from './rollout-sink.js';
import type { EventLimits } from '../transport-limits.js';

/** Cada cuanto se vuelve a buscar un rollout que no aparecio. Son `readdir`, no lecturas. */
const LOOKUP_INTERVAL_MS = 2_000;

export interface CodexFollowerOptions {
  /** Reloj del reintento de busqueda. Solo para el chequeo. */
  now?: () => number;
  /** Hito 28, `FollowOptions`. Ausente: `TRANSPORT_LIMITS`. */
  limits?: EventLimits;
  /** Hito 28, `FollowOptions`. Ausente: el tope de `JsonlFollower`. */
  maxEvents?: number;
}

/** El id de sesion del nombre de un rollout, comprimido o no. */
function sessionIdOf(filePath: string): string | null {
  const name = path.basename(filePath);
  return (parseRolloutFileName(name) ?? parseCompressedRolloutFileName(name))?.sessionId ?? null;
}

function samePath(a: string, b: string): boolean {
  return a === b || normalizeCwdKey(a, process.platform) === normalizeCwdKey(b, process.platform);
}

export class CodexSessionFollower implements SessionFollower {
  private readonly sink: CodexRolloutSink;
  private jsonl: JsonlFollower;
  private readonly maxEvents: number | undefined;
  private readonly now: () => number;
  private lastLookupAt: number | null = null;
  /** Llego un aviso de la otra forma de su sesion: buscar otra vez en el proximo `poll`. */
  private relookupPending = false;

  constructor(
    /** No decide la ruta: la carpeta de Codex es por dia, no por proyecto. */
    readonly cwd: string,
    private readonly sessionId: string,
    options: CodexFollowerOptions = {},
  ) {
    this.sink = new CodexRolloutSink(sessionId, options.limits);
    this.maxEvents = options.maxEvents;
    this.jsonl = this.followerFor(null);
    this.now = options.now ?? Date.now;
  }

  private followerFor(filePath: string | null): JsonlFollower {
    return new JsonlFollower(filePath, this.sink, { maxEvents: this.maxEvents, files: createRolloutFiles() });
  }

  get label(): string {
    const filePath = this.jsonl.filePath;
    if (filePath !== null) return filePath;
    return this.sessionId.length > 0 ? `codex:${this.sessionId.slice(0, 8)}` : 'codex:(no session)';
  }

  async start(): Promise<void> {
    await this.lookup();
  }

  async poll(): Promise<PollResult> {
    if (
      this.jsonl.filePath === null &&
      this.sessionId.length > 0 &&
      (this.lastLookupAt === null || this.now() - this.lastLookupAt >= LOOKUP_INTERVAL_MS)
    ) {
      await this.lookup();
    }
    // Lo que haya quedado de una lectura que lanzo a mitad ya no es de nadie.
    this.sink.takeTurns(new Set());
    let { reset, added } = await this.jsonl.poll();
    if (await this.relookup()) {
      // Otro archivo: todo lo de antes era del que ya no esta.
      ({ added } = await this.jsonl.poll());
      reset = true;
    }
    const fresh = new Set(added.map((event) => event.eventId));
    return { reset, added, turns: this.sink.takeTurns(fresh), plans: [], parts: [] };
  }

  /**
   * Cambia de archivo si la sesion cambio de forma. true si cambio.
   *
   * Se busca con un aviso de la otra forma, o si el archivo seguido ya no esta
   * (con el mismo intervalo que la busqueda inicial: son `readdir`). El orden de
   * los avisos no importa: si el comprimido aparece antes de que se borre el
   * `.jsonl`, la busqueda devuelve el `.jsonl` y no se cambia nada, y cuando se
   * borra, el archivo seguido ya no esta.
   */
  private async relookup(): Promise<boolean> {
    const own = this.jsonl.filePath;
    if (own === null || this.sessionId.length === 0) return false;
    const vanished = this.jsonl.getState() === 'waiting';
    const due = this.lastLookupAt === null || this.now() - this.lastLookupAt >= LOOKUP_INTERVAL_MS;
    if (!this.relookupPending && !(vanished && due)) return false;
    this.relookupPending = false;
    this.lastLookupAt = this.now();
    const found = await findReadableRollout(this.sessionId);
    if (found === null || samePath(found, own) || this.jsonl.filePath !== own) return false;
    this.sink.reset();
    this.jsonl = this.followerFor(found);
    return true;
  }

  private async lookup(): Promise<void> {
    if (this.sessionId.length === 0 || this.jsonl.filePath !== null) return;
    this.lastLookupAt = this.now();
    const found = await findReadableRollout(this.sessionId);
    // Entre la busqueda y aca, el watcher pudo haberla fijado.
    if (found !== null && this.jsonl.filePath === null) this.jsonl.setPath(found);
  }

  /**
   * true si el aviso es de su archivo. Si todavia no tiene uno y el aviso es un
   * rollout con su id, se queda con ese: es el watcher llegando antes que el
   * reintento de busqueda. Si tiene uno y el aviso es la otra forma de su
   * sesion, la busca otra vez en el proximo `poll` (§10.12).
   */
  noticeChange(filePath: string): boolean {
    const own = this.jsonl.filePath;
    if (own !== null && samePath(own, filePath)) return true;
    if (this.sessionId.length === 0) return false;
    if (sessionIdOf(filePath) !== this.sessionId.toLowerCase()) return false;
    if (own !== null) {
      this.relookupPending = true;
      return true;
    }
    this.jsonl.setPath(filePath);
    return true;
  }

  async readImage(eventId: string, index: number, source: ConversationImageSource): Promise<LoadedImage | null> {
    // Codex no tiene adjuntos en lineas aparte: todas estan en el mensaje.
    if (source !== 'content') return null;
    const line = this.sink.contentLineOf(eventId);
    const filePath = this.jsonl.filePath;
    if (line === null || filePath === null) return null;
    return loadRolloutImage(filePath, line, index);
  }

  hasOpenToolCall(launchedAt: number): boolean {
    return this.sink.hasOpenToolCall(launchedAt);
  }

  getState(): ConversationState {
    return this.jsonl.getState();
  }

  getUsage(): ContextUsage {
    return this.sink.getUsage();
  }

  /** Codex no tiene ciclo de permisos que la app maneje (C8). */
  getPermissionMode(): PermissionMode | null {
    return null;
  }

  getTail(limit: number): EventPage {
    return this.jsonl.getTail(limit);
  }

  getPageBefore(beforeEventId: string, limit: number): EventPage {
    return this.jsonl.getPageBefore(beforeEventId, limit);
  }

  getPlanFiles(): readonly string[] {
    return [];
  }
}
