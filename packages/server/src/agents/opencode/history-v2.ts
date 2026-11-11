/** Historial de OpenCode 2.2.7, leído de sus proyecciones SQLite en solo lectura. */
import { stat } from 'node:fs/promises';
import {
  EMPTY_CONTEXT_USAGE,
  MAX_QUEUED_PROMPT_CHARS,
  MAX_QUEUED_PROMPTS,
  MAX_SUBMIT_IMAGE_BYTES,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type ConversationState,
  type QueuedPrompt,
} from '@agent-workbench/shared';
import type { EventPage, FollowOptions, HistoryItem, HistorySource, PollResult, ScannedSession, SessionFollower } from '../adapter.js';
import { toTitle, UNTITLED_SESSION_TITLE } from '../session-title.js';
import { TRANSPORT_LIMITS, type EventLimits } from '../transport-limits.js';
import { buildEvents, buildUsage, lastRequestMessage, parseRevert } from './events.js';
import { DEFAULT_TITLE_PATTERN, nativeCwd, type OpenCodeHistoryDeps } from './history.js';
import { diffEvents, CURSOR_OVERLAP_MS } from './session-follower.js';
import type { OpenCodeDatabase } from './session-follower.js';
import type { OpenCodePromptChoice } from './serve-client.js';
import type { PartCall } from './serve-questions.js';
import { partCutParams, type MessageRow, type PartRow, type RootRow, type RootStampRow, type SessionRow } from './sql.js';
import { OPENCODE_V2_SQL } from './sql-v2.js';

interface V2MessageRow extends Omit<MessageRow, 'role' | 'parent_id' | 'summary'> {
  type: string;
  seq: number;
  compaction_status: string | null;
}
interface V2PartRow extends Omit<PartRow, 'time_created' | 'time_updated' | 'synthetic' | 'ignored'> {
  seq: number;
  ordinal: number;
  at: number;
}
interface V2InboxRow {
  id: string;
  time_created: number;
  delivery: string;
  enqueued_seq: number;
  text: string | null;
  text_length: number | null;
  images: number;
}
interface V2Signature {
  message_count: number;
  message_max: number;
  message_seq: number;
  part_count: number;
  part_max: number;
  inbox_count: number;
  inbox_seq: number;
  inbox_delivery: string | null;
}

const emptyPoll = (): PollResult => ({ reset: false, added: [], turns: [], plans: [], parts: [] });
const itemOf = (row: RootRow): HistoryItem => ({
  ref: row.id,
  sessionId: row.id,
  group: row.directory || row.id,
  mtimeMs: row.time_updated,
  sizeBytes: 0,
});
const ordered = (rows: Iterable<V2MessageRow>): V2MessageRow[] => [...rows].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
const yieldToLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));
// En V2 cada fila guarda el contenido entero del paso, no una parte suelta.
const MESSAGES_PER_BATCH = 32;

function normalMessage(row: V2MessageRow, parentId: string | null): MessageRow {
  const role = row.type === 'compaction' ? row.compaction_status === 'failed' ? 'assistant' : 'user' : row.type;
  return { ...row, role, parent_id: parentId, summary: 0 };
}
function normalPart(row: V2PartRow): PartRow {
  return { ...row, time_created: row.at, time_updated: row.at, synthetic: 0, ignored: 0 };
}

/** El vínculo de la tarjeta con metadata.tool del formulario V2. */
export function readV2PartCall(db: OpenCodeDatabase, partId: string, sessionId: string): PartCall | null {
  const row = db.get<{
    message_id: string;
    call_id: string;
  }>(OPENCODE_V2_SQL.partCallById, { $id: partId, $s: sessionId });
  return row === undefined ? null : { messageId: row.message_id, callId: row.call_id };
}
export function readV2SessionParent(db: OpenCodeDatabase, sessionId: string): string | null {
  return db.get<{
    parent_id: string | null;
  }>(OPENCODE_V2_SQL.sessionParentById, sessionId)?.parent_id ?? null;
}

export function readV2PromptChoice(db: OpenCodeDatabase, sessionId: string): OpenCodePromptChoice | null {
  const row = db.get<{
    agent: string | null;
    provider_id: string | null;
    model_id: string | null;
    variant: string | null;
  }>(OPENCODE_V2_SQL.lastChoice, { $s: sessionId });
  return row === undefined ? null : { agent: row.agent, providerID: row.provider_id, modelID: row.model_id, variant: row.variant };
}

export function createOpenCodeV2History(deps: OpenCodeHistoryDeps): HistorySource {
  const { dbFile, db } = deps;
  let stamps: Map<string, number> | null = null;
  const retry = new Set<string>();
  const readable = (): boolean => db.status() === 'ok' || db.status() === 'error';
  const session = (ref: string): SessionRow | undefined => {
    const row = db.get<SessionRow>(OPENCODE_V2_SQL.sessionById, ref);
    if (db.status() !== 'ok')
      throw new Error(`the OpenCode 2 database couldn't be read (${db.status()})`);
    return row;
  };
  const scan = (item: HistoryItem): ScannedSession | null => {
    const row = session(item.ref);
    if (row === undefined || row.parent_id !== null)
      return null;
    const fallback = row.title.length === 0 || DEFAULT_TITLE_PATTERN.test(row.title);
    const hasMessages = db.get<{
      found: number;
    }>(OPENCODE_V2_SQL.sessionHasMessages, row.id) !== undefined;
    if (db.status() !== 'ok')
      throw new Error('the OpenCode 2 messages could not be read');
    if (!hasMessages && fallback)
      return null;
    const first = fallback ? db.get<{
      text: string | null;
    }>(OPENCODE_V2_SQL.firstUserText, row.id)?.text : null;
    const title = toTitle(fallback ? first ?? '' : row.title);
    return {
      cwd: nativeCwd(row.directory, deps.platform),
      summary: {
        sessionId: row.id,
        title: title || UNTITLED_SESSION_TITLE,
        titleSource: title.length === 0 ? 'none' : fallback ? 'first-message' : 'ai',
        updatedAt: row.time_updated,
        sizeBytes: 0,
      },
      extra: {},
    };
  };
  return {
    roots: () => dbFile === null || 'unavailable' in deps.sqlite() ? [] : [{
      path: dbFile,
      depth: 0,
      accepts: file => file === dbFile,
      awaitWriteFinish: false,
      watch: onChange => deps.signal.subscribe(() => onChange(dbFile)),
    }],
    async list() {
      if (dbFile === null || !readable())
        return null;
      try {
        const rows = db.all<RootRow>(OPENCODE_V2_SQL.listRoots);
        if (db.status() !== 'ok')
          return null;
        stamps = new Map(rows.map(row => [row.id, row.time_updated]));
        return rows.map(itemOf);
      }
      catch (error) {
        (deps.warn ?? console.warn)(`[opencode] couldn't list the OpenCode 2 history: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },
    async changedRefs(file) {
      if (dbFile === null || file !== dbFile)
        return null;
      if (!readable())
        return [];
      let rows: RootStampRow[];
      try {
        rows = db.all<RootStampRow>(OPENCODE_V2_SQL.rootStamps);
      }
      catch {
        return [];
      }
      if (db.status() !== 'ok')
        return [];
      const previous = stamps ?? new Map<string, number>();
      const current = new Map(rows.map(row => [row.id, row.time_updated]));
      const changed = rows.filter(row => previous.get(row.id) !== row.time_updated).map(row => row.id);
      const removed = [...previous.keys()].filter(id => !current.has(id));
      stamps = current;
      const refs = new Set([...changed, ...removed, ...retry]);
      retry.clear();
      return [...refs];
    },
    async item(ref) {
      if (dbFile === null)
        return null;
      try {
        const row = session(ref);
        return row === undefined || row.parent_id !== null ? null : itemOf(row);
      }
      catch (error) {
        retry.add(ref);
        throw error;
      }
    },
    async scan(item) {
      try {
        return scan(item);
      }
      catch (error) {
        retry.add(item.ref);
        throw error;
      }
    },
    restored: () => undefined,
    async exists(_cwd, id) {
      if (dbFile === null || db.status() === 'missing')
        return false;
      if (!readable())
        return true;
      try {
        const found = db.get(OPENCODE_V2_SQL.sessionExists, id);
        return db.status() !== 'ok' || found !== undefined;
      }
      catch {
        return true;
      }
    },
    async rootExists() {
      if (dbFile === null) return false;
      try {
        await stat(dbFile);
        return true;
      } catch {
        return false;
      }
    },
    follow: (target, options) => new OpenCodeV2SessionFollower(deps, target.sessionId, options),
    wholeRead: true,
    plans: null,
    followPollMs: null,
  };
}
export class OpenCodeV2SessionFollower implements SessionFollower {
  private messages = new Map<string, V2MessageRow>();
  private parts = new Map<string, V2PartRow[]>();
  private inbox: V2InboxRow[] = [];
  private delivered: ConversationEvent[] = [];
  private signature: V2Signature | null = null;
  private revertRaw: string | null = null;
  private cursor = 0;
  private state: ConversationState = 'waiting';
  private usage: ContextUsage = { ...EMPTY_CONTEXT_USAGE };
  private readonly limits: EventLimits;
  private readonly maxEvents: number;
  constructor(private readonly deps: OpenCodeHistoryDeps, private readonly sessionId: string, options: FollowOptions = {}) {
    this.limits = options.limits ?? TRANSPORT_LIMITS;
    this.maxEvents = options.maxEvents ?? 4000;
  }
  get label(): string {
    return `${this.deps.dbFile ?? 'opencode'}#${this.sessionId || '(no session)'}`;
  }

  async start(): Promise<void> {
    try {
      await this.deps.catalog.contextWindow(null, null);
    } catch {
      // Un catálogo ausente no impide leer la conversación.
    }
  }

  async poll(): Promise<PollResult> {
    if (this.sessionId.length === 0)
      return emptyPoll();
    const { db } = this.deps;
    if (db.status() === 'no-sqlite' || db.status() === 'schema') {
      this.state = 'unavailable';
      return emptyPoll();
    }
    const session = db.get<SessionRow>(OPENCODE_V2_SQL.sessionById, this.sessionId);
    if (db.status() === 'missing') {
      this.state = 'waiting';
      return emptyPoll();
    }
    if (db.status() !== 'ok') {
      this.state = 'unavailable';
      return emptyPoll();
    }
    if (session === undefined) {
      const reset = this.delivered.length > 0;
      this.messages.clear();
      this.parts.clear();
      this.inbox = [];
      this.delivered = [];
      this.signature = null;
      this.cursor = 0;
      this.usage = { ...EMPTY_CONTEXT_USAGE };
      this.state = 'waiting';
      return { ...emptyPoll(), reset };
    }
    this.state = 'live';
    const signature = db.get<V2Signature>(OPENCODE_V2_SQL.signature, { $s: this.sessionId });
    if (signature === undefined)
      return emptyPoll();
    if (JSON.stringify(signature) === JSON.stringify(this.signature) && session.revert === this.revertRaw)
      return emptyPoll();
    const reload = this.signature === null || signature.message_count < this.signature.message_count ||
      signature.part_count < this.signature.part_count || session.revert !== this.revertRaw;
    let changed = db.all<V2MessageRow>(OPENCODE_V2_SQL.messages, {
      $s: this.sessionId, $since: reload ? 0 : this.cursor - CURSOR_OVERLAP_MS, $seq: reload ? 0 : this.signature?.message_seq ?? 0,
    });
    let nextMessages = reload ? new Map<string, V2MessageRow>() : new Map(this.messages);
    let nextParts = reload ? new Map<string, V2PartRow[]>() : new Map(this.parts);
    for (const row of changed)
      nextMessages.set(row.id, row);
    // Una importación puede insertar mensajes antiguos por debajo del cursor.
    if (nextMessages.size !== signature.message_count) {
      changed = db.all<V2MessageRow>(OPENCODE_V2_SQL.messages, { $s: this.sessionId, $since: 0, $seq: 0 });
      nextMessages = new Map();
      nextParts = new Map();
    }
    for (const message of changed) {
      nextMessages.set(message.id, message);
      nextParts.set(message.id, []);
    }
    for (let offset = 0; offset < changed.length; offset += MESSAGES_PER_BATCH) {
      if (offset > 0)
        await yieldToLoop();
      const rows = db.all<V2PartRow>(OPENCODE_V2_SQL.parts, {
        $s: this.sessionId,
        $ids: JSON.stringify(changed.slice(offset, offset + MESSAGES_PER_BATCH).map(row => row.id)),
        ...partCutParams(this.limits),
      });
      for (const row of rows)
        nextParts.get(row.message_id)?.push(row);
    }
    const inbox = db.all<V2InboxRow>(OPENCODE_V2_SQL.inbox, { $s: this.sessionId, $textCut: MAX_QUEUED_PROMPT_CHARS + 1 });
    if (db.status() !== 'ok')
      throw new Error('the OpenCode 2 conversation could not be read');
    this.messages = nextMessages;
    this.parts = nextParts;
    this.inbox = inbox;
    this.cursor = changed.reduce((latest, row) => Math.max(latest, row.time_updated), Math.max(this.cursor, signature.part_max));
    this.signature = signature;
    this.revertRaw = session.revert;
    return this.rebuild();
  }
  private async rebuild(): Promise<PollResult> {
    const mark = parseRevert(this.revertRaw);
    const rows = ordered(this.messages.values());
    const markRow = mark === null ? undefined : rows.find(row => row.id === mark.messageId);
    const next: ConversationEvent[] = [];
    const usageRows: MessageRow[] = [];
    const turns = new Map<string, {
      user: V2MessageRow;
      last: V2MessageRow;
      event: ConversationEvent | null;
    }>();
    let user: V2MessageRow | null = null;
    for (const row of rows) {
      if (markRow !== undefined && row.seq > markRow.seq)
        break;
      let parts = this.parts.get(row.id) ?? [];
      if (markRow?.id === row.id) {
        const position = mark?.partId === null ? -1 : parts.findIndex(part => part.id === mark?.partId);
        if (position < 0)
          break;
        parts = parts.slice(0, position);
      }
      if (row.type === 'user')
        user = row;
      const message = normalMessage(row, user?.id ?? null);
      const normalizedParts = parts.map(normalPart);
      const built = buildEvents({ messages: [message], partsByMessage: new Map([[row.id, normalizedParts]]), revert: null, limits: this.limits }).events;
      const partOrder = new Map(parts.map((part, index) => [part.id, index]));
      built.sort((a, b) => (partOrder.get(a.eventId) ?? Number.MAX_SAFE_INTEGER) - (partOrder.get(b.eventId) ?? Number.MAX_SAFE_INTEGER));
      next.push(...built);
      if (row.type === 'assistant' && user !== null)
        turns.set(user.id, { user, last: row, event: built.at(-1) ?? turns.get(user.id)?.event ?? null });
      // El uso se ordena por secuencia de proyección, no por un id descendente.
      if (row.type !== 'compaction' || row.compaction_status === 'completed') {
        usageRows.push({ ...message, time_created: row.seq, role: row.type === 'compaction' ? 'assistant' : message.role, summary: row.type === 'compaction' ? 1 : 0 });
      }
    }
    for (const { user: lastUser, last, event } of turns.values()) {
      if (event === null || last.completed_at === null || last.finish === 'tool-calls')
        continue;
      const duration = last.completed_at - (lastUser.created_at ?? lastUser.time_created);
      if (duration >= 0)
        event.durationMs = duration;
    }
    const last = lastRequestMessage(usageRows);
    let contextWindow: number | null = null;
    if (last !== null) {
      try {
        contextWindow = await this.deps.catalog.contextWindow(last.provider_id, last.model_id);
      }
      catch {
        // Un modelo propio puede no estar en el catálogo local.
      }
    }
    const usage = buildUsage(usageRows, contextWindow);
    const usageChanged = JSON.stringify(this.usage) !== JSON.stringify(usage);
    this.usage = usage;
    const diff = diffEvents(this.delivered, next);
    this.delivered = next;
    return diff === null ? { ...emptyPoll(), reset: true, usageChanged } : { ...diff, reset: false, plans: [], usageChanged };
  }
  getState(): ConversationState { return this.state; }
  getUsage(): ContextUsage { return this.usage; }
  getPermissionMode(): null { return null; }
  getPlanFiles(): readonly string[] { return []; }
  hasOpenToolCall(_launchedAt: number): boolean { return false; }
  noticeChange(file: string): boolean { return this.deps.dbFile !== null && file === this.deps.dbFile; }
  private window(): {
    events: ConversationEvent[];
    dropped: number;
  } {
    const events = this.delivered.slice(-this.maxEvents);
    return { events, dropped: this.delivered.length - events.length };
  }
  getTail(limit: number): EventPage {
    const { events: all, dropped } = this.window();
    const events = all.slice(-limit);
    return { events, hasMore: all.length > events.length || dropped > 0 };
  }
  getPageBefore(id: string, limit: number): EventPage {
    const { events: all, dropped } = this.window();
    const index = all.findIndex(event => event.eventId === id);
    if (index <= 0)
      return { events: [], hasMore: false };
    const start = Math.max(0, index - limit);
    return { events: all.slice(start, index), hasMore: start > 0 || dropped > 0 };
  }
  queuedPrompts(_launchedAt: number): QueuedPrompt[] {
    // La bandeja V2 es durable y también conserva lo encolado antes de reanudar.
    return this.inbox
      .filter(row => row.delivery === 'queue' && ((row.text ?? '').trim().length > 0 || row.images > 0))
      .slice(0, MAX_QUEUED_PROMPTS)
      .map(row => ({
        id: row.id,
        text: (row.text ?? '').slice(0, MAX_QUEUED_PROMPT_CHARS),
        truncated: (row.text_length ?? 0) > MAX_QUEUED_PROMPT_CHARS,
        images: row.images,
        at: row.time_created,
      }));
  }
  async readImage(eventId: string, index: number, source: ConversationImageSource) {
    if (source !== 'content' || !Number.isInteger(index) || index < 0)
      return null;
    try {
      const row = this.deps.db.get<{
        mime: string;
        data: unknown;
      }>(OPENCODE_V2_SQL.image, { $s: this.sessionId, $id: eventId, $index: index, $max: Math.ceil(MAX_SUBMIT_IMAGE_BYTES * 4 / 3) + 128 });
      if (row === undefined || typeof row.mime !== 'string' || !row.mime.startsWith('image/') || typeof row.data !== 'string')
        return null;
      const prefix = `data:${row.mime};base64,`;
      return { mediaType: row.mime, data: row.data.startsWith(prefix) ? row.data.slice(prefix.length) : row.data };
    }
    catch {
      return null;
    }
  }
}
