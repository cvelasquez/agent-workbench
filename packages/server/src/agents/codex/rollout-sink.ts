/**
 * Lo que significa cada linea de un rollout de Codex para la conversacion.
 *
 * Es el `JsonlLineSink` de `JsonlFollower`: la lectura por offset, el numero de
 * linea y el tope son de alla. Aca se decide que linea es una tarjeta, que
 * linea corrige una anterior y que se ignora.
 *
 * Tres decisiones que no son evidentes (especificacion del hito 25, C2 a C7):
 *
 *  - **Los mensajes del usuario salen de `event_msg/user_message`** (o de su
 *    equivalente en modo `paginated`, `item_completed` de un `UserMessage`), no
 *    del `response_item` de rol `user`. Ese rol tambien lleva lo que mete el
 *    arnes (`<environment_context>`, `<turn_aborted>`, instrucciones), y
 *    filtrarlo con una lista de envoltorios es una lista que crece con cada
 *    version. `user_message` solo existe para lo que mando la persona: 26 de 26.
 *    Del `response_item` inmediatamente anterior salen solo las imagenes.
 *  - **El resultado de una herramienta sale de `*_output`.** `exec_command_end`
 *    trae codigo de salida y duracion, pero la 0.154 ya no lo escribe: seria un
 *    dato que desaparece justo en las sesiones nuevas.
 *  - **El medidor es exacto.** Codex escribe la ventana del modelo en cada
 *    `token_count`; no hay tabla que mantener.
 */

import {
  EMPTY_CONTEXT_USAGE,
  asRecord,
  type ContextUsage,
  type ConversationEvent,
  type ConversationPart,
  type ConversationRole,
} from '@agent-workbench/shared';
import type { TurnUpdate } from '../adapter.js';
import type { EventLookup, JsonlLineSink } from '../jsonl-follower.js';
import { cut, TEXT_MAX_CHARS, TOOL_INPUT_MAX_CHARS } from '../transport-limits.js';
import {
  readSessionMeta,
  readTokenInfo,
  readToolOutput,
  readTurnContext,
  readUserContentImages,
  readUserMessageEvent,
  readWindow,
  stripImageLabels,
} from './rollout-lines.js';

/** Los tipos de `event_msg` que cierran un turno. `turn_*` es el alias de la 0.154. */
const TURN_END_TYPES: readonly string[] = ['task_complete', 'turn_complete', 'turn_aborted'];
const TURN_START_TYPES: readonly string[] = ['task_started', 'turn_started'];

export class CodexRolloutSink implements JsonlLineSink {
  private model: string | null = null;
  private effort: string | null = null;
  private window: number | null = null;
  private usage: ContextUsage = { ...EMPTY_CONTEXT_USAGE };
  /**
   * El ultimo `total_tokens` acumulado visto. Codex repite `token_count` sin uso
   * nuevo —medido: 47 de 144 traen el mismo total que el anterior— y contarlos
   * inflaria "N respuestas" del medidor.
   */
  private lastTotalTokens: number | null = null;
  private lastAssistantEventId: string | null = null;
  /**
   * Las imagenes del `message/user` de la linea anterior, esperando al
   * `user_message` que va justo despues (26 de 26 a una linea). Cualquier otra
   * linea en el medio la descarta: una imagen pegada al mensaje equivocado es
   * peor que ninguna.
   */
  private userContent: { lineNumber: number; images: string[] } | null = null;
  /** Evento de usuario con imagenes -> linea del `message/user` que las trae. */
  private readonly contentLines = new Map<string, number>();
  private turns: TurnUpdate[] = [];
  /** Llamadas del turno en curso sin resultado todavia: `call_id` -> epoch ms. */
  private readonly openCalls = new Map<string, number>();
  private warnedForeignMeta = false;

  /** `''` si todavia no se sabe que sesion es. */
  constructor(private readonly sessionId: string) {}

  getUsage(): ContextUsage {
    return this.usage;
  }

  /** La linea del `message/user` con las imagenes de ese evento, o null. */
  contentLineOf(eventId: string): number | null {
    return this.contentLines.get(eventId) ?? null;
  }

  /**
   * Las duraciones de turnos vistas desde la ultima llamada, sin las de eventos
   * de `fresh`: lo que se aplico a un evento de este mismo lote ya viaja dentro
   * de el. Vacia la lista.
   */
  takeTurns(fresh: ReadonlySet<string>): TurnUpdate[] {
    const turns = this.turns.filter((turn) => !fresh.has(turn.eventId));
    this.turns = [];
    return turns;
  }

  /** Ver `SessionFollower.hasOpenToolCall`. */
  hasOpenToolCall(launchedAt: number): boolean {
    for (const at of this.openCalls.values()) {
      // Sin hora no se puede decir que sea de un proceso anterior: bloquea.
      if (at === 0 || at >= launchedAt) return true;
    }
    return false;
  }

  reset(): void {
    this.model = null;
    this.effort = null;
    this.window = null;
    this.usage = { ...EMPTY_CONTEXT_USAGE };
    this.lastTotalTokens = null;
    this.lastAssistantEventId = null;
    this.userContent = null;
    this.contentLines.clear();
    this.turns = [];
    this.openCalls.clear();
  }

  consume(
    record: Record<string, unknown>,
    lineNumber: number,
    events: EventLookup,
  ): ConversationEvent | null {
    // Solo sobrevive a la linea que va justo despues.
    const pendingContent = this.userContent;
    this.userContent = null;

    const payload = asRecord(record['payload']);
    if (payload === null) return null;
    const type = record['type'];
    const kind = payload['type'];
    const stamp = typeof record['timestamp'] === 'string' ? Date.parse(record['timestamp']) : Number.NaN;
    const at = Number.isFinite(stamp) ? stamp : 0;

    if (type === 'session_meta') {
      this.noteSessionMeta(payload);
      return null;
    }

    if (type === 'turn_context') {
      const context = readTurnContext(payload);
      if (context !== null) {
        if (context.model !== null) this.model = context.model;
        this.effort = context.effort;
      }
      return null;
    }

    if (type === 'event_msg' && typeof kind === 'string') {
      return this.consumeEvent(kind, payload, lineNumber, at, events, pendingContent);
    }

    if (type !== 'response_item') return null;

    if (kind === 'message') {
      const role = payload['role'];
      if (role === 'user') {
        this.userContent = { lineNumber, images: readUserContentImages(payload['content']) };
        return null;
      }
      if (role === 'assistant') return this.assistantMessage(payload, lineNumber, at);
      return null;
    }

    if (kind === 'function_call' || kind === 'custom_tool_call') {
      return this.toolCall(kind, payload, lineNumber, at);
    }

    if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
      const callId = payload['call_id'];
      if (typeof callId !== 'string' || callId.length === 0) return null;
      this.openCalls.delete(callId);
      const output = readToolOutput(payload['output']);
      return this.event('user', lineNumber, at, [
        {
          kind: 'tool-result',
          toolUseId: callId,
          text: output.text,
          isError: output.isError,
          truncated: output.truncated,
          imageCount: output.imageCount,
        },
      ]);
    }

    // `reasoning` (cifrado: 57 de 57 sin texto) y todo lo demas.
    return null;
  }

  private noteSessionMeta(payload: Record<string, unknown>): void {
    const meta = readSessionMeta(payload);
    if (
      meta === null ||
      this.sessionId.length === 0 ||
      meta.id.toLowerCase() === this.sessionId.toLowerCase() ||
      this.warnedForeignMeta
    ) {
      return;
    }
    this.warnedForeignMeta = true;
    console.warn(
      `[codex] el archivo de la sesion ${this.sessionId.slice(0, 8)} dice ser ${meta.id.slice(0, 8)}; se sigue leyendo igual.`,
    );
  }

  private consumeEvent(
    kind: string,
    payload: Record<string, unknown>,
    lineNumber: number,
    at: number,
    events: EventLookup,
    pendingContent: { lineNumber: number; images: string[] } | null,
  ): ConversationEvent | null {
    if (TURN_START_TYPES.includes(kind)) {
      this.lastAssistantEventId = null;
      this.openCalls.clear();
      const window = readWindow(payload['model_context_window']);
      if (window !== null) {
        this.window = window;
        this.usage = { ...this.usage, contextWindow: window };
      }
      return null;
    }

    // `user_message` en `legacy`, `item_completed` de un `UserMessage` en `paginated`.
    if (kind === 'user_message' || kind === 'item_completed') {
      const message = readUserMessageEvent(payload);
      return message === null ? null : this.userMessage(message.message, lineNumber, at, pendingContent);
    }

    if (kind === 'token_count') {
      this.applyTokenCount(payload);
      return null;
    }

    if (TURN_END_TYPES.includes(kind)) {
      this.openCalls.clear();
      const duration = payload['duration_ms'];
      const eventId = this.lastAssistantEventId;
      this.lastAssistantEventId = null;
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null;
      if (eventId === null) return null;
      const target = events.find(eventId);
      if (target === undefined) return null;
      target.durationMs = duration;
      this.turns.push({ eventId, durationMs: duration });
      return null;
    }

    // `agent_message` (duplica al `response_item`), `exec_command_end` y demas.
    return null;
  }

  private userMessage(
    message: string,
    lineNumber: number,
    at: number,
    pendingContent: { lineNumber: number; images: string[] } | null,
  ): ConversationEvent | null {
    const images =
      pendingContent !== null && pendingContent.lineNumber === lineNumber - 1 ? pendingContent.images : [];
    const text = stripImageLabels(message, images.length);

    const parts: ConversationPart[] = images.map((mediaType, index) => ({
      kind: 'image',
      index,
      mediaType,
      source: 'content',
    }));
    if (text.length > 0) parts.push({ kind: 'text', ...cut(text, TEXT_MAX_CHARS) });
    if (parts.length === 0) return null;

    const event = this.event('user', lineNumber, at, parts);
    if (images.length > 0) this.contentLines.set(event.eventId, lineNumber - 1);
    return event;
  }

  private assistantMessage(
    payload: Record<string, unknown>,
    lineNumber: number,
    at: number,
  ): ConversationEvent | null {
    const content = payload['content'];
    if (!Array.isArray(content)) return null;
    const parts: ConversationPart[] = [];
    for (const item of content) {
      const block = asRecord(item);
      if (block === null || block['type'] !== 'output_text') continue;
      const text = block['text'];
      if (typeof text === 'string' && text.length > 0) {
        parts.push({ kind: 'text', ...cut(text, TEXT_MAX_CHARS) });
      }
    }
    if (parts.length === 0) return null;
    return this.event('assistant', lineNumber, at, parts);
  }

  private toolCall(
    kind: 'function_call' | 'custom_tool_call',
    payload: Record<string, unknown>,
    lineNumber: number,
    at: number,
  ): ConversationEvent | null {
    const callId = payload['call_id'];
    const name = payload['name'];
    if (typeof callId !== 'string' || callId.length === 0) return null;
    if (typeof name !== 'string' || name.length === 0) return null;

    let input: string;
    if (kind === 'function_call') {
      const raw = typeof payload['arguments'] === 'string' ? payload['arguments'] : '';
      input = prettyJson(raw);
    } else {
      input = typeof payload['input'] === 'string' ? payload['input'] : '';
    }

    this.openCalls.set(callId, at);
    const limited = cut(input, TOOL_INPUT_MAX_CHARS);
    return this.event('assistant', lineNumber, at, [
      { kind: 'tool-call', toolUseId: callId, name, input: limited.text, truncated: limited.truncated },
    ]);
  }

  private applyTokenCount(payload: Record<string, unknown>): void {
    const info = readTokenInfo(payload);
    if (info === null) return;
    if (info.window !== null) this.window = info.window;

    /*
      Una respuesta mas solo si el acumulado cambio. Si bajo, el proceso se
      relanzo y empezo a contar de nuevo: tambien es uso nuevo. Sin total no hay
      como saberlo, y ahi se cuenta como antes de esta regla.
    */
    const total = info.total.totalTokens;
    const fresh = total === null || total !== this.lastTotalTokens;
    if (total !== null) this.lastTotalTokens = total;

    this.usage = {
      lastRequestTokens: info.last.inputTokens,
      lastOutputTokens: info.last.outputTokens,
      lastModel: this.model,
      contextWindow: this.window,
      contextWindowEstimated: false,
      totalInputTokens: info.total.inputTokens,
      totalOutputTokens: info.total.outputTokens,
      totalCacheReadTokens: info.total.cachedInputTokens,
      assistantMessages: this.usage.assistantMessages + (fresh ? 1 : 0),
    };
  }

  private event(
    role: ConversationRole,
    lineNumber: number,
    at: number,
    parts: ConversationPart[],
  ): ConversationEvent {
    const eventId = `line-${lineNumber}`;
    if (role === 'assistant') this.lastAssistantEventId = eventId;
    return {
      eventId,
      role,
      at,
      parts,
      model: role === 'assistant' ? this.model : null,
      // Codex no da uso por mensaje: el medidor sale de `token_count`.
      usage: null,
      effort: role === 'assistant' ? this.effort : null,
      durationMs: null,
      queued: false,
    };
  }
}

/** Los argumentos de una llamada, indentados si son JSON; tal cual si no. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
