/**
 * El seguidor de una sesion de Pi, tal como lo usa el hub.
 *
 * Lee el archivo por offset con `JsonlFollower` —el resto parcial, el reinicio
 * si encoge y la huella son de alla—, pero **no guarda los eventos ahi**: una
 * sesion de Pi es un arbol, y una linea nueva que cuelga de otro punto obliga a
 * rehacer el hilo (`session-path.ts`). El `JsonlFollower` solo corta lineas; el
 * arbol y la rama activa viven aca.
 *
 * Tres cosas de Pi que ordenan el resto (CLAUDE.md 16):
 *
 *  - **El archivo nace con el primer mensaje.** Hasta entonces no hay nada que
 *    seguir, y se lo vuelve a buscar cada tanto y con cada aviso del watcher.
 *  - **Lleva huella.** El archivo solo crece, pero Pi lo reescribe entero al
 *    migrar una sesion de formato viejo, y eso puede dejarlo mas grande.
 *  - **La ventana de contexto no esta en la sesion**: la da el catalogo, por
 *    proveedor y modelo.
 */

import path from 'node:path';
import {
  EMPTY_CONTEXT_USAGE,
  normalizeCwdKey,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type ConversationState,
  type PermissionMode,
} from '@agent-workbench/shared';
import type { EventPage, LoadedImage, PollResult, SessionFollower } from '../adapter.js';
import { JsonlFollower, type JsonlLineSink } from '../jsonl-follower.js';
import { TRANSPORT_LIMITS, type EventLimits } from '../transport-limits.js';
import type { PiModelCatalog } from './catalog.js';
import { isPiSessionId } from './constants.js';
import { findSessionFile, parseSessionFileName } from './paths.js';
import { readEntry, type PiEntry } from './session-entries.js';
import { loadPiImage } from './session-image.js';
import { modelKey, PiSessionTree } from './session-path.js';

/** Cada cuanto se vuelve a buscar un archivo que no aparecio. Son `readdir`, no lecturas. */
const LOOKUP_INTERVAL_MS = 2_000;

/** Tope de eventos en memoria de la rama activa, el mismo de las demas CLIs. */
export const PI_MAX_EVENTS = 4_000;

/**
 * Los bytes del principio que forman la huella. La primera linea empieza con
 * `{"type":"session","version":3,"id":"…`: una migracion de formato cambia la
 * version, y otro archivo, el id.
 */
export const PI_FINGERPRINT_BYTES = 64;

export interface PiFollowerOptions {
  catalog: PiModelCatalog;
  /** Reloj del reintento de busqueda. Solo para el chequeo. */
  now?: () => number;
  /** `FollowOptions`. Ausente: `TRANSPORT_LIMITS`. */
  limits?: EventLimits;
  /** `FollowOptions`. Ausente: `PI_MAX_EVENTS`. */
  maxEvents?: number;
  /** Como se busca el archivo de la sesion. Solo para el chequeo. */
  findFile?: (sessionId: string, cwd: string | null) => Promise<string | null>;
}

export class PiSessionFollower implements SessionFollower {
  private readonly tree: PiSessionTree;
  private readonly jsonl: JsonlFollower;
  private readonly catalog: PiModelCatalog;
  private readonly now: () => number;
  private readonly findFile: (sessionId: string, cwd: string | null) => Promise<string | null>;
  /** Las entradas leidas en esta vuelta, en orden de archivo, todavia sin aplicar. */
  private incoming: PiEntry[] = [];
  private usage: ContextUsage = { ...EMPTY_CONTEXT_USAGE };
  /** El modelo para el que vale `window`. */
  private windowKey: string | null = null;
  private window: number | null = null;
  private lastLookupAt: number | null = null;

  constructor(
    private readonly cwd: string,
    private readonly sessionId: string,
    options: PiFollowerOptions,
  ) {
    const limits = options.limits ?? TRANSPORT_LIMITS;
    this.catalog = options.catalog;
    this.now = options.now ?? Date.now;
    this.findFile = options.findFile ?? findSessionFile;
    this.tree = new PiSessionTree({ maxEvents: options.maxEvents ?? PI_MAX_EVENTS });
    const sink: JsonlLineSink = {
      // Nunca devuelve un evento: los guarda el arbol, que sabe de que rama son.
      consume: (record, lineNumber) => {
        const entry = readEntry(record, lineNumber, limits);
        if (entry !== null) this.incoming.push(entry);
        return null;
      },
      reset: () => {
        this.tree.reset();
        this.incoming = [];
      },
    };
    this.jsonl = new JsonlFollower(null, sink, { fingerprintBytes: PI_FINGERPRINT_BYTES });
  }

  get label(): string {
    const filePath = this.jsonl.filePath;
    if (filePath !== null) return filePath;
    return this.sessionId.length > 0 ? `pi:${this.sessionId.slice(0, 8)}` : 'pi:(no session)';
  }

  async start(): Promise<void> {
    await this.lookup();
  }

  async poll(): Promise<PollResult> {
    if (
      this.jsonl.filePath === null &&
      (this.lastLookupAt === null || this.now() - this.lastLookupAt >= LOOKUP_INTERVAL_MS)
    ) {
      await this.lookup();
    }

    const before = JSON.stringify(this.usage);
    const { reset } = await this.jsonl.poll();
    let rebuilt = reset;
    const added: ConversationEvent[] = [];
    for (const entry of this.incoming.splice(0)) {
      const result = this.tree.add(entry);
      if (result.rebuilt) rebuilt = true;
      else if (!rebuilt) added.push(...result.added);
    }
    await this.refreshUsage();

    if (rebuilt) return { reset: true, added: [], turns: [], plans: [], parts: [] };
    return {
      reset: false,
      added,
      turns: [],
      plans: [],
      parts: [],
      // `/model` y `/thinking` escriben su entrada en el acto (16.10): cambian el uso sin eventos.
      usageChanged: added.length === 0 && JSON.stringify(this.usage) !== before,
    };
  }

  private async lookup(): Promise<void> {
    if (!isPiSessionId(this.sessionId) || this.jsonl.filePath !== null) return;
    this.lastLookupAt = this.now();
    const found = await this.findFile(this.sessionId, this.cwd);
    // Entre la busqueda y aca, el watcher pudo haberlo fijado.
    if (found !== null && this.jsonl.filePath === null) this.jsonl.setPath(found);
  }

  /** El medidor de la rama activa, con la ventana que el catalogo le da a su modelo. */
  private async refreshUsage(): Promise<void> {
    const meter = this.tree.meter;
    const key = modelKey(meter.provider, meter.modelId);
    if (key !== this.windowKey) {
      this.window = await this.catalog.contextWindow(meter.provider, meter.modelId);
      this.windowKey = key;
    } else if (this.window === null && key !== null) {
      // El catalogo pudo llegar despues: Pi lo baja al iniciar sesion.
      this.window = await this.catalog.contextWindow(meter.provider, meter.modelId);
    }
    this.usage = {
      lastRequestTokens: meter.lastRequestTokens,
      lastOutputTokens: meter.lastOutputTokens,
      lastModel: key,
      contextWindow: this.window,
      contextWindowEstimated: false,
      totalInputTokens: meter.totalInputTokens,
      totalOutputTokens: meter.totalOutputTokens,
      totalCacheReadTokens: meter.totalCacheReadTokens,
      assistantMessages: meter.assistantMessages,
      ...(meter.effort !== null ? { lastEffort: meter.effort } : {}),
    };
  }

  /**
   * true si el aviso es de su archivo. Si todavia no tiene uno y el aviso es un
   * archivo con su id, se queda con ese: es el watcher llegando antes que el
   * reintento de busqueda.
   */
  noticeChange(filePath: string): boolean {
    const own = this.jsonl.filePath;
    if (own !== null) {
      return own === filePath || normalizeCwdKey(own, process.platform) === normalizeCwdKey(filePath, process.platform);
    }
    if (!isPiSessionId(this.sessionId)) return false;
    if (parseSessionFileName(path.basename(filePath))?.sessionId !== this.sessionId) return false;
    this.jsonl.setPath(filePath);
    return true;
  }

  async readImage(eventId: string, index: number, source: ConversationImageSource): Promise<LoadedImage | null> {
    const filePath = this.jsonl.filePath;
    if (filePath === null) return null;
    return loadPiImage(filePath, eventId, index, source);
  }

  /**
   * Siempre false: Pi no pide permiso antes de usar sus herramientas, asi que
   * una llamada sin resultado nunca es un menu de aprobacion abierto. Lo unico
   * que frena el cuadro es su dialogo de confianza, y eso lo dice el estado
   * (`status.ts`).
   */
  hasOpenToolCall(): boolean {
    return false;
  }

  getState(): ConversationState {
    return this.jsonl.getState();
  }

  getUsage(): ContextUsage {
    return this.usage;
  }

  /** Pi no tiene modos de permiso. */
  getPermissionMode(): PermissionMode | null {
    return null;
  }

  getTail(limit: number): EventPage {
    const all = this.tree.events;
    const events = all.slice(-limit);
    return { events, hasMore: all.length > events.length || this.tree.dropped > 0 };
  }

  getPageBefore(beforeEventId: string, limit: number): EventPage {
    const all = this.tree.events;
    const index = all.findIndex((event) => event.eventId === beforeEventId);
    if (index <= 0) return { events: [], hasMore: false };
    const start = Math.max(0, index - limit);
    return { events: all.slice(start, index), hasMore: start > 0 || this.tree.dropped > 0 };
  }

  getPlanFiles(): readonly string[] {
    return [];
  }
}
