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
import { findRollout } from './find-rollout.js';
import { parseRolloutFileName } from './paths.js';
import { loadRolloutImage } from './rollout-image.js';
import { CodexRolloutSink } from './rollout-sink.js';

/** Cada cuanto se vuelve a buscar un rollout que no aparecio. Son `readdir`, no lecturas. */
const LOOKUP_INTERVAL_MS = 2_000;

export interface CodexFollowerOptions {
  /** Reloj del reintento de busqueda. Solo para el chequeo. */
  now?: () => number;
}

export class CodexSessionFollower implements SessionFollower {
  private readonly sink: CodexRolloutSink;
  private readonly jsonl: JsonlFollower;
  private readonly now: () => number;
  private lastLookupAt: number | null = null;

  constructor(
    /** No decide la ruta: la carpeta de Codex es por dia, no por proyecto. */
    readonly cwd: string,
    private readonly sessionId: string,
    options: CodexFollowerOptions = {},
  ) {
    this.sink = new CodexRolloutSink(sessionId);
    this.jsonl = new JsonlFollower(null, this.sink);
    this.now = options.now ?? Date.now;
  }

  get label(): string {
    const filePath = this.jsonl.filePath;
    if (filePath !== null) return filePath;
    return this.sessionId.length > 0 ? `codex:${this.sessionId.slice(0, 8)}` : 'codex:(sin sesion)';
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
    const { reset, added } = await this.jsonl.poll();
    const fresh = new Set(added.map((event) => event.eventId));
    return { reset, added, turns: this.sink.takeTurns(fresh), plans: [], parts: [] };
  }

  private async lookup(): Promise<void> {
    if (this.sessionId.length === 0 || this.jsonl.filePath !== null) return;
    this.lastLookupAt = this.now();
    const found = await findRollout(this.sessionId);
    // Entre la busqueda y aca, el watcher pudo haberla fijado.
    if (found !== null && this.jsonl.filePath === null) this.jsonl.setPath(found);
  }

  /**
   * true si el aviso es de su archivo. Si todavia no tiene uno y el aviso es un
   * rollout con su id, se queda con ese: es el watcher llegando antes que el
   * reintento de busqueda.
   */
  noticeChange(filePath: string): boolean {
    const own = this.jsonl.filePath;
    if (own !== null) {
      return own === filePath || normalizeCwdKey(own, process.platform) === normalizeCwdKey(filePath, process.platform);
    }
    if (this.sessionId.length === 0) return false;
    if (parseRolloutFileName(path.basename(filePath))?.sessionId !== this.sessionId.toLowerCase()) return false;
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
