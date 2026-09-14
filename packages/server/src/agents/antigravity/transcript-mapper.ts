/**
 * Lo que significa cada paso del transcript de Antigravity CLI para la
 * conversacion.
 *
 * La CLI escribe `brain/<id>/.system_generated/logs/transcript_full.jsonl`, un
 * paso por linea: `step_index` (numero, con saltos), `source`, `type`,
 * `status`, `created_at`, `content`, `thinking` y `tool_calls`. Es el
 * `JsonlLineSink` de `JsonlFollower`: la lectura por offset es de alla.
 *
 * Tres decisiones que no son evidentes (hito 27, §6 y A3 de la especificacion):
 *
 *  - **El resultado de una herramienta se casa por orden, no por id.** El paso
 *    del resultado no nombra la llamada, y su `type` no sirve: la 1.2.2 escribe
 *    `GENERIC` para cuatro herramientas distintas. Un paso `MODEL` que no es de
 *    planificacion es el resultado de la llamada pendiente mas vieja **del
 *    ultimo paso de planificacion anterior a el**. En cuanto llega otro paso de
 *    planificacion, las llamadas que quedaron sin resultado se cierran asi, sin
 *    resultado: medido, una corrida escribio los pasos `0,1,2,3,4,5,7`, con la
 *    llamada del 5 sin resultado y otra llamada en el 7; con una cola unica, el
 *    resultado del 7 se habria pegado a la llamada del 5.
 *  - **El error de un comando esta en el texto.** Un comando que sale con
 *    codigo 1 queda `DONE`/`GENERIC`; lo unico que lo dice es
 *    `The command exited with code 1.` (medido).
 *  - **El razonamiento se descarta al armar**, aunque la 1.2.2 si lo escriba con
 *    texto: la misma regla que CLAUDE.md 4.9 para Claude Code. Un paso que solo
 *    razono no deja tarjeta.
 *
 * Lo desconocido se ignora en silencio: otra `source`, otro `type` sin llamada
 * pendiente, una linea sin `step_index`.
 */

import {
  asRecord,
  type ConversationEvent,
  type ConversationPart,
  type ConversationRole,
} from '@agent-workbench/shared';
import type { PartsUpdate } from '../adapter.js';
import type { EventLookup, JsonlLineSink } from '../jsonl-follower.js';
import { cut, TRANSPORT_LIMITS, type EventLimits } from '../transport-limits.js';
import { parseSettingsChange, splitModelLabel } from './model-label.js';

// ---------------------------------------------------------------------------
// Funciones puras
// ---------------------------------------------------------------------------

export interface UnwrappedUserInput {
  /** Lo que escribio el usuario, sin los bloques que agrega la CLI. */
  text: string;
  /** El contenido de cada `USER_SETTINGS_CHANGE`, en orden. */
  settingsChanges: string[];
}

const REQUEST_OPEN = '<USER_REQUEST>';
const REQUEST_CLOSE = '</USER_REQUEST>';

function blockPattern(name: string): RegExp {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
}

/**
 * El mensaje del usuario de un paso `USER_INPUT`.
 *
 * La CLI envuelve lo tecleado en `<USER_REQUEST>` y le agrega
 * `<ADDITIONAL_METADATA>` (la hora) y, si cambio el modelo,
 * `<USER_SETTINGS_CHANGE>`. **No es una purga de etiquetas** (misma regla que
 * CLAUDE.md 4.12): se quitan esos tres nombres y ninguno mas, y un usuario que
 * pega HTML ve su HTML.
 *
 * Los avisos de cambio se buscan **despues** del pedido: un usuario que pega
 * un `<USER_SETTINGS_CHANGE>` adentro de su mensaje no cambia el modelo que
 * muestra el hilo.
 */
export function unwrapUserInput(content: string): UnwrappedUserInput {
  const open = content.indexOf(REQUEST_OPEN);
  const close = open === -1 ? -1 : content.indexOf(REQUEST_CLOSE, open + REQUEST_OPEN.length);

  let text: string;
  let rest: string;
  if (open !== -1 && close !== -1) {
    text = content.slice(open + REQUEST_OPEN.length, close).trim();
    rest = content.slice(close + REQUEST_CLOSE.length);
  } else {
    text = content
      .replace(blockPattern('ADDITIONAL_METADATA'), '')
      .replace(blockPattern('USER_SETTINGS_CHANGE'), '')
      .trim();
    rest = content;
  }

  const settingsChanges: string[] = [];
  for (const match of rest.matchAll(blockPattern('USER_SETTINGS_CHANGE'))) {
    settingsChanges.push((match[1] ?? '').trim());
  }
  return { text, settingsChanges };
}

const STEP_HEADER_LINE = /^(?:Created At|Completed At): [^\n]*(?:\r?\n|$)/;

/**
 * El texto de un resultado sin la cabecera de horas que le pone la CLI
 * (`Created At: …` y `Completed At: …`, hasta dos lineas) ni el blanco que
 * queda despues. Nada mas.
 */
export function stripStepHeader(content: string): string {
  let text = content;
  for (let i = 0; i < 2; i += 1) {
    const match = STEP_HEADER_LINE.exec(text);
    if (match === null) break;
    text = text.slice(match[0].length);
  }
  return text.trimStart();
}

/** Los estados de un paso que dicen, por si solos, que no termino bien. */
const FAILED_STATUSES: readonly string[] = ['ERROR', 'CANCELED', 'INTERRUPTED', 'HALTED'];

const FAILED_COMMAND = /^The command exited with code (-?\d+)\./;

/**
 * true si un resultado es un error.
 *
 * Por el estado del paso o, para un comando, por el texto: un `exit 3` queda
 * `DONE` y solo el texto dice que fallo. `RUNNING` (una tarea en segundo plano)
 * no es un error. `text` va ya sin cabecera.
 */
export function isFailedResult(status: string, text: string): boolean {
  if (FAILED_STATUSES.includes(status)) return true;
  const match = FAILED_COMMAND.exec(text);
  return match !== null && Number(match[1]) !== 0;
}

const JSON_LIKE = /^(?:["{[\d-]|true\b|false\b|null\b)/;

/** El valor de un string doble-codificado, o el string tal cual si no parsea. */
function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string' || !JSON_LIKE.test(value)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Un paso de `transcript.jsonl` con la forma del de `transcript_full.jsonl`.
 *
 * El compacto escribe cada argumento de herramienta como JSON dentro de un
 * string (`"CommandLine":"\"dir\""`, `"WaitMsBeforeAsync":"5000"`); el completo
 * los trae como JSON de verdad. Solo se usa si el completo no existe. Devuelve
 * un objeto nuevo: el registro original no se toca.
 */
export function decodeCompactStep(record: Record<string, unknown>): Record<string, unknown> {
  const rawCalls = decodeMaybeJson(record['tool_calls']);
  if (!Array.isArray(rawCalls)) return record;

  const calls = rawCalls.map((item: unknown) => {
    const call = asRecord(decodeMaybeJson(item));
    if (call === null) return item;
    const args = asRecord(decodeMaybeJson(call['args']));
    if (args === null) return call;
    const decoded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) decoded[key] = decodeMaybeJson(value);
    return { ...call, args: decoded };
  });
  return { ...record, tool_calls: calls };
}

// ---------------------------------------------------------------------------
// El sink
// ---------------------------------------------------------------------------

/** Lo que dejo un paso la primera vez, para cuando la CLI lo reescribe. */
type StepMemo =
  | { kind: 'user' }
  | { kind: 'planner' }
  /**
   * `toolUseId` null: un paso de resultado que no tenia llamada con la que
   * casarse. `visible` false: la llamada no se dibujo, y su resultado tampoco.
   */
  | { kind: 'result'; toolUseId: string | null; visible: boolean };

interface PendingCall {
  toolUseId: string;
  /** Epoch ms del paso que la pidio; 0 si no traia hora. */
  at: number;
  /** false si la llamada no tenia nombre y no se dibujo: su resultado tampoco. */
  visible: boolean;
}

export interface TranscriptMapperOptions {
  /** true si se lee `transcript.jsonl` (argumentos doble-codificados). */
  compact?: boolean;
  /** Hito 28, `FollowOptions`: los topes de cada parte. Ausente: `TRANSPORT_LIMITS`. */
  limits?: EventLimits;
}

export class TranscriptMapper implements JsonlLineSink {
  private readonly compact: boolean;
  private readonly limits: EventLimits;
  private readonly steps = new Map<number, StepMemo>();
  /** El ultimo paso de planificacion visto, y sus llamadas sin resultado. */
  private plannerStep: number | null = null;
  private pending: PendingCall[] = [];
  /** Llamadas del ultimo paso de planificacion, visibles o no, por id. */
  private plannerCalls = new Map<string, PendingCall>();
  /** Ids de llamada que ya tienen resultado. */
  private readonly answered = new Set<string>();
  private model: string | null = null;
  private effort: string | null = null;
  private assistantCount = 0;
  private partUpdates = new Map<string, ConversationPart[]>();

  constructor(options: TranscriptMapperOptions = {}) {
    this.compact = options.compact === true;
    this.limits = options.limits ?? TRANSPORT_LIMITS;
  }

  /**
   * La etiqueta del modelo vigente (`Gemini 3.8 Flash (High)`), la ultima que
   * la CLI le anuncio al modelo. null hasta el primer aviso.
   */
  get currentModel(): string | null {
    return this.model;
  }

  get currentEffort(): string | null {
    return this.effort;
  }

  /** Cuantos eventos `assistant` salieron. Es lo que cuenta el medidor. */
  get assistantMessages(): number {
    return this.assistantCount;
  }

  /**
   * Las partes rehechas de eventos ya entregados desde la ultima llamada, sin
   * las de eventos de `fresh`: lo que cambio en un evento de este mismo lote ya
   * viaja dentro de el. Vacia la lista.
   */
  takeParts(fresh: ReadonlySet<string>): PartsUpdate[] {
    const updates: PartsUpdate[] = [];
    for (const [eventId, parts] of this.partUpdates) {
      if (!fresh.has(eventId)) updates.push({ eventId, parts });
    }
    this.partUpdates = new Map();
    return updates;
  }

  /**
   * true si hay una llamada del ultimo paso de planificacion sin resultado,
   * pedida desde `launchedAt`. Ver `SessionFollower.hasOpenToolCall`: la
   * llamada se escribe al transcript **antes** de que se conteste su permiso.
   */
  hasOpenToolCall(launchedAt: number): boolean {
    return this.pending.some((call) => call.at === 0 || call.at >= launchedAt);
  }

  reset(): void {
    this.steps.clear();
    this.plannerStep = null;
    this.pending = [];
    this.plannerCalls = new Map();
    this.answered.clear();
    this.model = null;
    this.effort = null;
    this.assistantCount = 0;
    this.partUpdates = new Map();
  }

  consume(
    rawRecord: Record<string, unknown>,
    _lineNumber: number,
    events: EventLookup,
  ): ConversationEvent | null {
    const stepIndex = rawRecord['step_index'];
    const type = rawRecord['type'];
    if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex) || stepIndex < 0) return null;
    if (typeof type !== 'string') return null;

    const record = this.compact ? decodeCompactStep(rawRecord) : rawRecord;
    const source = record['source'];
    const stamp = typeof record['created_at'] === 'string' ? Date.parse(record['created_at']) : Number.NaN;
    const at = Number.isFinite(stamp) ? stamp : 0;
    const memo = this.steps.get(stepIndex);

    if (type === 'USER_INPUT' && source === 'USER_EXPLICIT') {
      return this.userInput(stepIndex, record, at, memo, events);
    }
    if (source !== 'MODEL') return null;
    if (type === 'PLANNER_RESPONSE') {
      return this.plannerResponse(stepIndex, record, at, memo, events);
    }
    return this.toolResult(stepIndex, record, at, memo, events);
  }

  private userInput(
    stepIndex: number,
    record: Record<string, unknown>,
    at: number,
    memo: StepMemo | undefined,
    events: EventLookup,
  ): ConversationEvent | null {
    const content = typeof record['content'] === 'string' ? record['content'] : '';
    const { text, settingsChanges } = unwrapUserInput(content);

    // Un aviso de modelo cuenta una sola vez: releerlo despues de otros lo
    // volveria a poner como vigente.
    if (memo === undefined) {
      for (const change of settingsChanges) {
        const label = parseSettingsChange(change);
        if (label === null) continue;
        this.model = label;
        this.effort = splitModelLabel(label).effort;
      }
      this.steps.set(stepIndex, { kind: 'user' });
    }

    if (text.length === 0) return null;
    return this.emit(stepIndex, 'user', at, [{ kind: 'text', ...cut(text, this.limits.textMaxChars) }], events);
  }

  private plannerResponse(
    stepIndex: number,
    record: Record<string, unknown>,
    at: number,
    memo: StepMemo | undefined,
    events: EventLookup,
  ): ConversationEvent | null {
    const parts: ConversationPart[] = [];
    const content = typeof record['content'] === 'string' ? record['content'].trim() : '';
    if (content.length > 0) parts.push({ kind: 'text', ...cut(content, this.limits.textMaxChars) });

    const calls: PendingCall[] = [];
    const rawCalls = record['tool_calls'];
    if (Array.isArray(rawCalls)) {
      rawCalls.forEach((item: unknown, index) => {
        const toolUseId = `s${stepIndex}:${index}`;
        const call = asRecord(item);
        const name = call?.['name'];
        const visible = typeof name === 'string' && name.length > 0;
        calls.push({ toolUseId, at, visible });
        if (!visible) return;
        const args = asRecord(call?.['args']);
        const input = cut(args === null ? '{}' : JSON.stringify(args, null, 2), this.limits.toolInputMaxChars);
        parts.push({ kind: 'tool-call', toolUseId, name, input: input.text, truncated: input.truncated });
      });
    }

    if (memo === undefined) {
      // Un paso de planificacion nuevo cierra las llamadas de los anteriores.
      this.steps.set(stepIndex, { kind: 'planner' });
      this.plannerStep = stepIndex;
      this.plannerCalls = new Map(calls.map((call) => [call.toolUseId, call]));
      this.pending = [...calls];
    } else if (this.plannerStep === stepIndex) {
      // El mismo paso reescrito: sus llamadas, menos las que ya tienen resultado.
      for (const call of calls) {
        if (!this.plannerCalls.has(call.toolUseId)) this.plannerCalls.set(call.toolUseId, call);
      }
      this.pending = [...this.plannerCalls.values()].filter((call) => !this.answered.has(call.toolUseId));
    }

    if (parts.length === 0) return null;
    return this.emit(stepIndex, 'assistant', at, parts, events);
  }

  private toolResult(
    stepIndex: number,
    record: Record<string, unknown>,
    at: number,
    memo: StepMemo | undefined,
    events: EventLookup,
  ): ConversationEvent | null {
    let toolUseId: string | null;
    let visible: boolean;
    if (memo !== undefined && memo.kind === 'result' && memo.toolUseId !== null) {
      // Reescrito (un `RUNNING` que paso a `DONE`): la misma llamada de antes.
      toolUseId = memo.toolUseId;
      visible = memo.visible;
    } else {
      const next = this.pending.shift();
      toolUseId = next?.toolUseId ?? null;
      visible = next?.visible ?? false;
      if (next !== undefined) this.answered.add(next.toolUseId);
      if (memo === undefined || next !== undefined) {
        this.steps.set(stepIndex, { kind: 'result', toolUseId, visible });
      }
    }
    if (toolUseId === null || !visible) return null;

    const status = typeof record['status'] === 'string' ? record['status'] : '';
    const text = stripStepHeader(typeof record['content'] === 'string' ? record['content'] : '');
    const limited = cut(text, this.limits.toolResultMaxChars);
    return this.emit(
      stepIndex,
      'user',
      at,
      [
        {
          kind: 'tool-result',
          toolUseId,
          text: limited.text,
          isError: isFailedResult(status, text),
          truncated: limited.truncated,
          imageCount: 0,
        },
      ],
      events,
    );
  }

  /**
   * El evento de un paso. Si el paso ya habia salido, se le rehacen las partes
   * en el lugar y se anota la actualizacion: dos eventos con el mismo id
   * romperian la vista. Una reescritura que no cambia nada no se anota.
   */
  private emit(
    stepIndex: number,
    role: ConversationRole,
    at: number,
    parts: ConversationPart[],
    events: EventLookup,
  ): ConversationEvent | null {
    const eventId = `s${stepIndex}`;
    const existing = events.find(eventId);
    if (existing !== undefined) {
      if (existing.role === role && JSON.stringify(existing.parts) !== JSON.stringify(parts)) {
        existing.parts = parts;
        this.partUpdates.set(eventId, parts);
      }
      return null;
    }

    if (role === 'assistant') this.assistantCount += 1;
    return {
      eventId,
      role,
      at,
      parts,
      model: role === 'assistant' ? this.model : null,
      // El transcript no trae tokens: el medidor sale de la status line.
      usage: null,
      effort: role === 'assistant' ? this.effort : null,
      // No hay duracion escrita, y restar marcas esta prohibido (CLAUDE.md 4.9.1).
      durationMs: null,
      queued: false,
    };
  }
}
