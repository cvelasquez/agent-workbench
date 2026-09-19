/**
 * El seguidor de una sesion de OpenCode, tal como lo usa el hub.
 *
 * No hay archivo que seguir por offset: la sesion son filas de `message` y
 * `part` en una base compartida. Cada lectura pregunta primero algo barato
 * —la fila de la sesion y una firma de conteos y maximos (4 ms en la sesion mas
 * grande, medido)— y solo si cambio lee filas.
 *
 * Tres decisiones, cada una por lo que rompe la contraria:
 *
 *  - **La carga inicial va por tandas de mensajes.** Las partes se piden con
 *    `message_id IN (...)`, agrupando mensajes hasta unas 400 partes, y entre
 *    tanda y tanda se suelta el hilo: `node:sqlite` es sincrono y cada consulta
 *    para el servidor entero. Paginar `part` por `(time_created, id)` no servia:
 *    no hay indice con ese orden, y cada pagina evaluaba y ordenaba todo lo que
 *    quedaba de la sesion (critica M4 de la especificacion del hito 26).
 *  - **Los eventos se rehacen enteros y se comparan con lo entregado.** Un texto
 *    que crece, una herramienta que termina o una pregunta que se contesta
 *    cambian una fila que ya se leyo; rehacer y comparar es mas simple que
 *    parchar, y lo caro —las filas— ya esta en memoria. Lo que cae antes de
 *    algo ya entregado, o lo entregado que desaparece, rehace la vista.
 *  - **El uso puede cambiar sin eventos.** OpenCode escribe los tokens de un
 *    paso al cerrarlo, cuando su texto ya se entrego: el resultado lo dice con
 *    `usageChanged` y el hub manda un `append` vacio (critica M2).
 *
 * Con `sessionId ''` es un seguidor vacio: la pestana todavia no sabe que
 * sesion es, se queda en `waiting`, y el hub lo reemplaza cuando aparece.
 */

import {
  EMPTY_CONTEXT_USAGE,
  MAX_SUBMIT_IMAGE_BYTES,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type ConversationState,
  type PermissionMode,
} from '@agent-workbench/shared';
import { debugLog } from '../../debug.js';
import type { EventPage, LoadedImage, PartsUpdate, PollResult, SessionFollower, TurnUpdate } from '../adapter.js';
import type { ReadOnlyDatabase } from '../sqlite.js';
import { TRANSPORT_LIMITS, type EventLimits } from '../transport-limits.js';
import { applyRevert, buildEvents, buildUsage, lastRequestMessage, parseRevert, sortRows } from './events.js';
import {
  OPENCODE_SQL,
  partCutParams,
  type ImagePartRow,
  type ImageUrlRow,
  type MessageRow,
  type PartCountRow,
  type PartRow,
  type SessionRow,
  type SignatureRow,
} from './sql.js';

/** Lo que el seguidor usa de la base. Una interfaz para que el chequeo pueda espiar las consultas. */
export type OpenCodeDatabase = Pick<ReadOnlyDatabase, 'all' | 'get' | 'status'>;

/** Lo que el seguidor usa del catalogo de modelos. */
export interface ContextWindowLookup {
  contextWindow(providerId: string | null, modelId: string | null): Promise<number | null>;
}

/** Cuantas partes, mas o menos, pide cada tanda de la carga inicial. */
export const PARTS_PER_BATCH = 400;

/** Tope de eventos que se paginan, como el de los seguidores por archivo. */
const MAX_EVENTS = 4_000;

/**
 * Cuanto hacia atras del ultimo `time_updated` visto relee una lectura
 * incremental. Cubre una fila confirmada con una hora anterior a la ultima que
 * ya se habia visto; releer una fila que no cambio no hace nada.
 */
export const CURSOR_OVERLAP_MS = 2_000;

/**
 * Tope de la url de una imagen, en caracteres: el mismo que acepta el cuadro
 * de escritura, pasado a base64 y con lugar para el prefijo `data:`. Por encima,
 * la base devuelve null sin traer los bytes.
 */
export const IMAGE_URL_MAX_CHARS = Math.ceil((MAX_SUBMIT_IMAGE_BYTES * 4) / 3) + 128;

const TOOL_OPEN_STATES = new Set(['pending', 'running']);

export interface OpenCodeFollowerOptions {
  db: OpenCodeDatabase;
  catalog: ContextWindowLookup;
  sessionId: string;
  /** Solo para el `label` y para reconocer los avisos. null: base en memoria. */
  dbFile: string | null;
  /** Tope de eventos que se paginan. Ausente: 4 000. `FollowOptions` (hito 28) y el chequeo. */
  maxEvents?: number;
  /** Hito 28, `FollowOptions`: los topes de cada parte, en SQL y al armar. Ausente: `TRANSPORT_LIMITS`. */
  limits?: EventLimits;
  partsPerBatch?: number;
  imageUrlMaxChars?: number;
  /** Lo que se espera entre tanda y tanda de la carga inicial. */
  yieldBetweenBatches?: () => Promise<void>;
}

const emptyResult = (): PollResult => ({ reset: false, added: [], turns: [], plans: [], parts: [] });

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Los ids de mensaje de cada tanda: en orden, cortando cuando la tanda llega a
 * `limit` partes. Un mensaje con mas partes que el tope va solo. Los que no
 * tienen partes no se piden.
 */
export function messageBatches(
  messageIds: readonly string[],
  partCounts: ReadonlyMap<string, number>,
  limit: number,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const id of messageIds) {
    const count = partCounts.get(id) ?? 0;
    if (count === 0) continue;
    current.push(id);
    size += count;
    if (size >= limit) {
      batches.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

const sameSignature = (a: SignatureRow | null, b: SignatureRow): boolean =>
  a !== null &&
  a.message_count === b.message_count &&
  a.message_max === b.message_max &&
  a.part_count === b.part_count &&
  a.part_max === b.part_max;

export class OpenCodeSessionFollower implements SessionFollower {
  private readonly db: OpenCodeDatabase;
  private readonly catalog: ContextWindowLookup;
  private readonly sessionId: string;
  private readonly dbFile: string | null;
  private readonly maxEvents: number;
  private readonly limits: EventLimits;
  private readonly partsPerBatch: number;
  private readonly imageUrlMaxChars: number;
  private readonly yieldBetweenBatches: () => Promise<void>;

  private messages = new Map<string, MessageRow>();
  private parts = new Map<string, Map<string, PartRow>>();
  private loaded = false;
  private signature: SignatureRow | null = null;
  private revertRaw: string | null = null;
  private cursorMessages = 0;
  private cursorParts = 0;
  private state: ConversationState = 'waiting';
  /** Todo lo que se entrego, en orden. La pagina es la cola de `maxEvents`. */
  private delivered: ConversationEvent[] = [];
  /** Los mensajes y partes que se ven, de la ultima reconstruccion (sin lo deshecho). */
  private visibleMessages: readonly MessageRow[] = [];
  private visibleParts: ReadonlyMap<string, readonly PartRow[]> = new Map();
  private usage: ContextUsage = { ...EMPTY_CONTEXT_USAGE };
  private usageKey = JSON.stringify(EMPTY_CONTEXT_USAGE);

  constructor(options: OpenCodeFollowerOptions) {
    this.db = options.db;
    this.catalog = options.catalog;
    this.sessionId = options.sessionId;
    this.dbFile = options.dbFile;
    this.maxEvents = options.maxEvents ?? MAX_EVENTS;
    this.limits = options.limits ?? TRANSPORT_LIMITS;
    this.partsPerBatch = options.partsPerBatch ?? PARTS_PER_BATCH;
    this.imageUrlMaxChars = options.imageUrlMaxChars ?? IMAGE_URL_MAX_CHARS;
    this.yieldBetweenBatches = options.yieldBetweenBatches ?? yieldToLoop;
  }

  get label(): string {
    const base = this.dbFile ?? 'opencode';
    return `${base}#${this.sessionId.length > 0 ? this.sessionId : '(no session)'}`;
  }

  /** Precarga el catalogo, para que la primera lectura no espere 93 ms de JSON. Nunca lanza. */
  async start(): Promise<void> {
    try {
      await this.catalog.contextWindow(null, null);
    } catch {
      // Sin catalogo, sin ventana: no es motivo para no seguir la sesion.
    }
  }

  /** `no-sqlite` o `schema`: no hay nada que leer hasta reiniciar. */
  private unreadable(): boolean {
    const status = this.db.status();
    return status === 'no-sqlite' || status === 'schema';
  }

  async poll(): Promise<PollResult> {
    if (this.sessionId.length === 0) {
      this.state = 'waiting';
      return emptyResult();
    }
    if (this.unreadable()) {
      this.state = 'unavailable';
      return emptyResult();
    }

    const session = this.db.get<SessionRow>(OPENCODE_SQL.sessionById, this.sessionId);
    // La primera consulta es la que descubre un esquema que no sirve.
    if (this.unreadable()) {
      this.state = 'unavailable';
      return emptyResult();
    }
    if (session === undefined) {
      // Todavia no existe, o la borraron: si se habia mostrado algo, se rehace vacia.
      const hadEvents = this.delivered.length > 0;
      this.clear();
      this.state = 'waiting';
      return { ...emptyResult(), reset: hadEvents };
    }

    this.state = 'live';
    const signature = this.db.get<SignatureRow>(OPENCODE_SQL.sessionSignature, { $s: this.sessionId });
    if (signature === undefined) return emptyResult();
    if (this.loaded && sameSignature(this.signature, signature) && session.revert === this.revertRaw) {
      return emptyResult();
    }

    const previous = this.signature;
    const shrunk =
      previous !== null &&
      (signature.message_count < previous.message_count || signature.part_count < previous.part_count);
    const reload = !this.loaded || shrunk || session.revert !== this.revertRaw;

    if (reload) await this.loadAll();
    else this.loadIncrement();
    /*
      La firma se tomo ANTES de leer, asi que lo que se escriba mientras tanto
      cambia la proxima. Y se guarda DESPUES: una lectura que lanza a mitad no
      puede dejar anotado que esto ya se vio.
    */
    this.signature = signature;
    this.revertRaw = session.revert;
    this.loaded = true;

    return this.rebuild(parseRevert(session.revert));
  }

  /** Todas las filas de la sesion, las partes por tandas de mensajes. */
  private async loadAll(): Promise<void> {
    const messages = this.db.all<MessageRow>(OPENCODE_SQL.messagesSince, this.sessionId, 0);
    const counts = new Map(
      this.db.all<PartCountRow>(OPENCODE_SQL.partCountsByMessage, this.sessionId).map((row) => [row.message_id, row.part_count]),
    );
    const ordered = sortRows(messages);
    const batches = messageBatches(ordered.map((message) => message.id), counts, this.partsPerBatch);

    const cuts = partCutParams(this.limits);
    const nextParts = new Map<string, Map<string, PartRow>>();
    for (const [position, batch] of batches.entries()) {
      if (position > 0) await this.yieldBetweenBatches();
      for (const part of this.db.all<PartRow>(OPENCODE_SQL.partsForMessages, { $ids: JSON.stringify(batch), ...cuts })) {
        addPart(nextParts, part);
      }
    }

    this.messages = new Map(ordered.map((message) => [message.id, message]));
    this.parts = nextParts;
    this.cursorMessages = maxUpdated(ordered);
    this.cursorParts = 0;
    for (const byId of nextParts.values()) this.cursorParts = Math.max(this.cursorParts, maxUpdated([...byId.values()]));
  }

  /** Lo que cambio desde los cursores, reemplazando por id. */
  private loadIncrement(): void {
    const messages = this.db.all<MessageRow>(
      OPENCODE_SQL.messagesSince,
      this.sessionId,
      this.cursorMessages - CURSOR_OVERLAP_MS,
    );
    const parts = this.db.all<PartRow>(OPENCODE_SQL.partsSince, {
      $s: this.sessionId,
      $since: this.cursorParts - CURSOR_OVERLAP_MS,
      ...partCutParams(this.limits),
    });
    for (const message of messages) this.messages.set(message.id, message);
    for (const part of parts) addPart(this.parts, part);
    this.cursorMessages = Math.max(this.cursorMessages, maxUpdated(messages));
    this.cursorParts = Math.max(this.cursorParts, maxUpdated(parts));
  }

  /** Rehace los eventos y el uso, y los compara con lo entregado. */
  private async rebuild(revert: ReturnType<typeof parseRevert>): Promise<PollResult> {
    const messages = sortRows([...this.messages.values()]);
    const partsByMessage = new Map<string, PartRow[]>();
    for (const [messageId, byId] of this.parts) partsByMessage.set(messageId, sortRows([...byId.values()]));

    const visible = applyRevert({ messages, partsByMessage, revert });
    this.visibleMessages = visible.messages;
    this.visibleParts = visible.partsByMessage;
    const next = buildEvents({ messages, partsByMessage, revert, limits: this.limits }).events;

    const last = lastRequestMessage(visible.messages);
    let window: number | null = null;
    if (last !== null) {
      try {
        window = await this.catalog.contextWindow(last.provider_id, last.model_id);
      } catch {
        window = null;
      }
    }
    this.usage = buildUsage(visible.messages, window);
    const usageKey = JSON.stringify(this.usage);
    const usageChanged = usageKey !== this.usageKey;
    this.usageKey = usageKey;

    const previous = this.delivered;
    this.delivered = next;
    const diff = diffEvents(previous, next);
    if (diff === null) {
      debugLog('conversation', `opencode: out-of-order or vanished event in ${this.sessionId}, rebuilding`);
      return { ...emptyResult(), reset: true };
    }
    return { reset: false, added: diff.added, turns: diff.turns, plans: [], parts: diff.parts, usageChanged };
  }

  private clear(): void {
    this.messages = new Map();
    this.parts = new Map();
    this.loaded = false;
    this.signature = null;
    this.revertRaw = null;
    this.cursorMessages = 0;
    this.cursorParts = 0;
    this.delivered = [];
    this.visibleMessages = [];
    this.visibleParts = new Map();
    this.usage = { ...EMPTY_CONTEXT_USAGE };
    this.usageKey = JSON.stringify(EMPTY_CONTEXT_USAGE);
  }

  getState(): ConversationState {
    return this.state;
  }

  getUsage(): ContextUsage {
    return this.usage;
  }

  /** OpenCode no tiene ciclo de permisos que la app maneje. */
  getPermissionMode(): PermissionMode | null {
    return null;
  }

  /** Lo que se pagina: los ultimos `maxEvents`. */
  private window(): { events: ConversationEvent[]; dropped: number } {
    const events = this.delivered.slice(-this.maxEvents);
    return { events, dropped: this.delivered.length - events.length };
  }

  getTail(limit: number): EventPage {
    const { events: all, dropped } = this.window();
    const events = all.slice(-limit);
    return { events, hasMore: all.length > events.length || dropped > 0 };
  }

  getPageBefore(beforeEventId: string, limit: number): EventPage {
    const { events: all, dropped } = this.window();
    const index = all.findIndex((event) => event.eventId === beforeEventId);
    if (index <= 0) return { events: [], hasMore: false };
    const start = Math.max(0, index - limit);
    return { events: all.slice(start, index), hasMore: start > 0 || dropped > 0 };
  }

  getPlanFiles(): readonly string[] {
    return [];
  }

  /**
   * Los bytes de una imagen del usuario, de a una fila y con tope. El `eventId`
   * de un mensaje del usuario es el id del mensaje, y `index` cuenta sus partes
   * `file` de imagen en orden, igual que al armar el evento.
   */
  async readImage(eventId: string, index: number, source: ConversationImageSource): Promise<LoadedImage | null> {
    if (source !== 'content' || !Number.isInteger(index) || index < 0) return null;
    try {
      const images = this.db
        .all<ImagePartRow>(OPENCODE_SQL.imageParts, eventId)
        .filter((row) => row.mime !== null && row.mime.startsWith('image/'));
      const image = images[index];
      if (image === undefined || image.mime === null) return null;
      const found = this.db.get<ImageUrlRow>(OPENCODE_SQL.imageUrlById, { $id: image.id, $max: this.imageUrlMaxChars });
      const url = found?.url;
      const prefix = `data:${image.mime};base64,`;
      if (typeof url !== 'string' || !url.startsWith(prefix)) return null;
      return { mediaType: image.mime, data: url.slice(prefix.length) };
    } catch {
      // Una base ocupada o ilegible: "no se pudo cargar", no un error.
      return null;
    }
  }

  /** Un aviso de la base: toda la sesion vive ahi. */
  noticeChange(filePath: string): boolean {
    return this.dbFile !== null && filePath === this.dbFile;
  }

  /**
   * Una herramienta `pending` o `running` de este proceso: puede ser un pedido
   * de permiso o una pregunta abierta, y un mensaje del cuadro llegaria como
   * teclas a ese menu. Una de un mensaje que termino con error no cuenta: el
   * turno se corto. Una de un proceso anterior tampoco: quedo huerfana.
   */
  hasOpenToolCall(launchedAt: number): boolean {
    for (const message of this.visibleMessages) {
      if (message.role !== 'assistant' || (message.error_name !== null && message.error_name.length > 0)) continue;
      for (const part of this.visibleParts.get(message.id) ?? []) {
        if (part.type !== 'tool' || part.status === null || !TOOL_OPEN_STATES.has(part.status)) continue;
        if (part.time_created === 0 || part.time_created >= launchedAt) return true;
      }
    }
    return false;
  }
}

function addPart(target: Map<string, Map<string, PartRow>>, part: PartRow): void {
  let byId = target.get(part.message_id);
  if (byId === undefined) {
    byId = new Map();
    target.set(part.message_id, byId);
  }
  byId.set(part.id, part);
}

function maxUpdated(rows: readonly { time_updated: number }[]): number {
  let max = 0;
  for (const row of rows) max = Math.max(max, row.time_updated);
  return max;
}

/**
 * Que cambio entre lo entregado y lo rehecho, o null si la vista se tiene que
 * rehacer: un evento entregado que ya no esta, entregados que cambiaron de
 * orden, o uno nuevo que cae antes de alguno ya entregado (una parte vacia que
 * se lleno tarde, un mensaje con el reloj atrasado).
 */
export function diffEvents(
  previous: readonly ConversationEvent[],
  next: readonly ConversationEvent[],
): { added: ConversationEvent[]; parts: PartsUpdate[]; turns: TurnUpdate[] } | null {
  const nextIndex = new Map(next.map((event, index) => [event.eventId, index]));
  const known = new Set<string>();
  const parts: PartsUpdate[] = [];
  const turns: TurnUpdate[] = [];
  let lastIndex = -1;

  for (const event of previous) {
    const index = nextIndex.get(event.eventId);
    if (index === undefined || index < lastIndex) return null;
    lastIndex = index;
    known.add(event.eventId);
    const rebuilt = next[index];
    if (rebuilt === undefined) return null;
    if (JSON.stringify(rebuilt.parts) !== JSON.stringify(event.parts)) {
      parts.push({ eventId: rebuilt.eventId, parts: rebuilt.parts });
    }
    if (rebuilt.durationMs !== null && rebuilt.durationMs !== event.durationMs) {
      turns.push({ eventId: rebuilt.eventId, durationMs: rebuilt.durationMs });
    }
  }

  const added: ConversationEvent[] = [];
  for (const [index, event] of next.entries()) {
    if (known.has(event.eventId)) continue;
    if (index < lastIndex) return null;
    added.push(event);
  }
  return { added, parts, turns };
}
