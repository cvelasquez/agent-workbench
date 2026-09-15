/**
 * Filas de la base de OpenCode -> eventos de la conversacion, uso y duraciones.
 *
 * Funciones puras: lo que entra son filas ya leidas y cortadas en SQL
 * (`sql.ts`), lo que sale es lo que viaja al navegador. Sin disco, para que el
 * chequeo las pruebe de a una (`check-opencode-db.mjs`, casos 6 a 9).
 *
 * Cuatro decisiones que ordenan el resto (especificacion del hito 26, D6 a D9):
 *
 *  - **Un evento por parte visible, no por mensaje.** Un mensaje de asistente de
 *    OpenCode es un paso del modelo con texto, herramientas y marcas; partirlo
 *    en un evento por texto y uno por herramienta es lo que deja que las tandas
 *    de herramientas se plieguen (§6.0 de CLAUDE.md), igual que con Claude Code,
 *    que ya escribe un bloque por linea.
 *  - **Llamada y resultado en el mismo evento.** Una parte `tool` trae la
 *    entrada y la salida juntas; la vista casa los resultados por `toolUseId` en
 *    todo el hilo, asi que la tarjeta sigue siendo "puramente llamada".
 *  - **Lo que no dijo nadie va como aviso** (`notice`): compactacion, turno
 *    interrumpido y error del proveedor. Del error solo el nombre y 300
 *    caracteres del mensaje: las cabeceras y el cuerpo de la respuesta ni
 *    siquiera se leen.
 *  - **El razonamiento se descarta**, aunque OpenCode lo guarde con texto: la
 *    columna ni se consulta.
 *
 * Orden: mensajes por `(time_created, id)` y partes por `(time_created, id)`.
 * Nunca por id solo: el campo de tiempo del id dio la vuelta el 14-08-2026.
 */

import {
  EMPTY_CONTEXT_USAGE,
  asRecord,
  type ContextUsage,
  type ConversationEvent,
  type ConversationNoticePart,
  type ConversationPart,
  type ConversationQuestionItem,
  type MessageUsage,
} from '@agent-workbench/shared';
import { cut, TRANSPORT_LIMITS, type EventLimits } from '../transport-limits.js';
import type { MessageRow, PartRow } from './sql.js';

/** Hasta cuantos caracteres de entrada se intenta parsear en el hilo. `sql.ts` la corta en 16 001. */
export const TOOL_INPUT_PARSE_MAX_CHARS = 16_000;

/**
 * Hasta cuantos caracteres de entrada se intenta parsear con unos topes: el de
 * siempre, o el de la entrada si es mayor (la copia propia, hito 28). Solo
 * decide si la entrada se indenta; lo que se muestra lo corta
 * `toolInputMaxChars`. `sql.ts` corta la columna en este mismo numero.
 */
export function toolInputParseMaxChars(limits: EventLimits): number {
  return Math.max(TOOL_INPUT_PARSE_MAX_CHARS, limits.toolInputMaxChars);
}

/** Tope de cada texto de una pregunta. El mismo de Claude Code (`QUESTION_MAX_CHARS`). */
const QUESTION_MAX_CHARS = 400;

/** Tope del detalle de un aviso. `sql.ts` ya corta el mensaje del error en 300. */
const NOTICE_DETAIL_MAX_CHARS = 300;

/** El nombre del error con el que OpenCode marca un turno cortado a mano. */
const ABORTED_ERROR = 'MessageAbortedError';

/** Lo que dice `session.revert`: desde donde esta deshecha la conversacion. */
export interface RevertMark {
  messageId: string;
  /** null: se deshizo el mensaje entero. */
  partId: string | null;
}

export interface BuildEventsInput {
  messages: readonly MessageRow[];
  partsByMessage: ReadonlyMap<string, readonly PartRow[]>;
  revert: RevertMark | null;
  /**
   * Hito 28. Los topes de cada parte; ausente, los de transporte. Tienen que ser
   * los mismos con los que se leyeron las filas (`partCutParams`): si no, un
   * texto cortado en SQL se tomaria por entero.
   */
  limits?: EventLimits;
}

export interface BuiltEvents {
  events: ConversationEvent[];
  /** `eventId` -> duracion del turno, de los turnos cerrados. Ya puesta en el evento. */
  turns: Map<string, number>;
}

/** `(time_created, id)`: el unico orden que vale en esta base. */
export function compareRows(
  a: { time_created: number; id: string },
  b: { time_created: number; id: string },
): number {
  if (a.time_created !== b.time_created) return a.time_created - b.time_created;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** Copia ordenada. */
export function sortRows<T extends { time_created: number; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(compareRows);
}

/** `session.revert` crudo -> marca, o null si no hay o no se entiende. */
export function parseRevert(raw: string | null): RevertMark | null {
  if (raw === null || raw.length === 0) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const record = asRecord(value);
  const messageId = record?.['messageID'];
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  const partId = record?.['partID'];
  // `partID` sin medir: 0 de 4 sesiones con `revert` lo traian (B5 de la critica).
  return { messageId, partId: typeof partId === 'string' && partId.length > 0 ? partId : null };
}

/**
 * Lo que queda visible despues de un `revert`.
 *
 * Segun el comportamiento del TUI, lo deshecho no se muestra hasta que se
 * rehace o se borra: se descartan el mensaje marcado y todo lo posterior, o, si
 * la marca nombra una parte, esa parte y las siguientes de ese mensaje. Una
 * marca que apunta a un mensaje que no esta no descarta nada.
 */
export function applyRevert(input: BuildEventsInput): BuildEventsInput {
  const { revert } = input;
  const messages = sortRows(input.messages);
  if (revert === null) return { messages, partsByMessage: input.partsByMessage, revert: null };

  const marked = messages.find((message) => message.id === revert.messageId);
  if (marked === undefined) return { messages, partsByMessage: input.partsByMessage, revert: null };

  const markedParts = sortRows(input.partsByMessage.get(marked.id) ?? []);
  const markedPart = revert.partId === null ? undefined : markedParts.find((part) => part.id === revert.partId);

  const visible: MessageRow[] = [];
  const partsByMessage = new Map<string, readonly PartRow[]>();
  for (const message of messages) {
    const order = compareRows(message, marked);
    if (order < 0) {
      visible.push(message);
      const parts = input.partsByMessage.get(message.id);
      if (parts !== undefined) partsByMessage.set(message.id, parts);
      continue;
    }
    if (order === 0 && markedPart !== undefined) {
      visible.push(message);
      partsByMessage.set(message.id, markedParts.filter((part) => compareRows(part, markedPart) < 0));
    }
  }
  return { messages: visible, partsByMessage, revert };
}

const isTrue = (value: number | null): boolean => value !== null && value !== 0;

/** `proveedor/modelo`, el mismo formato que `-m`. */
export function modelOf(message: Pick<MessageRow, 'provider_id' | 'model_id'>): string | null {
  if (message.provider_id !== null && message.provider_id.length > 0 && message.model_id !== null && message.model_id.length > 0) {
    return `${message.provider_id}/${message.model_id}`;
  }
  return message.model_id !== null && message.model_id.length > 0 ? message.model_id : null;
}

/** Tokens de un mensaje de asistente: lo leido, lo escrito y lo que suman. */
function tokensOf(message: MessageRow): { input: number; output: number; read: number; write: number; total: number } {
  const input = message.t_input ?? 0;
  const output = (message.t_output ?? 0) + (message.t_reasoning ?? 0);
  const read = message.t_cache_read ?? 0;
  const write = message.t_cache_write ?? 0;
  return { input, output, read, write, total: input + output + read + write };
}

function messageUsageOf(message: MessageRow): MessageUsage | null {
  const tokens = tokensOf(message);
  if (tokens.total <= 0) return null;
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheCreationInputTokens: tokens.write,
    cacheReadInputTokens: tokens.read,
  };
}

/**
 * Quita del texto de un mensaje del usuario las etiquetas `[Image N]` de las
 * imagenes que si llegaron.
 *
 * Medido en vivo con la 1.18.30: al adjuntar una ruta pegada, el TUI escribe
 * `[Image 1] ` en el cuadro y la parte `text` la guarda tal cual, al lado de la
 * parte `file`. En el hilo la miniatura ya la muestra. Una etiqueta sin su
 * imagen se deja: el adjunto no llego y el texto es lo unico que lo cuenta.
 * Con cada etiqueta se va el espacio que la sigue. Como en Codex (§10.6).
 */
export function stripImageLabels(text: string, imageCount: number): string {
  return text
    .replace(/\[Image (\d+)\] ?/g, (label: string, digits: string) => {
      const n = Number(digits);
      return n >= 1 && n <= imageCount ? '' : label;
    })
    .trim();
}

function textPartOf(part: PartRow, limits: EventLimits, imageCount = 0): ConversationPart | null {
  const raw = part.text ?? '';
  const text = imageCount > 0 ? stripImageLabels(raw, imageCount) : raw;
  if (text.trim().length === 0) return null;
  const limited = cut(text, limits.textMaxChars);
  return { kind: 'text', text: limited.text, truncated: limited.truncated || (part.text_length ?? 0) > limits.textMaxChars };
}

/** La entrada de una herramienta, legible, y lo que se pudo parsear de ella. */
function toolInputOf(part: PartRow, limits: EventLimits): { input: string; truncated: boolean; parsed: unknown } {
  const raw = part.input_json;
  if (raw === null) return { input: '', truncated: false, parsed: undefined };
  const length = part.input_length ?? raw.length;
  if (length <= toolInputParseMaxChars(limits)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      const pretty = JSON.stringify(parsed, null, 2) ?? raw;
      const limited = cut(pretty, limits.toolInputMaxChars);
      return { input: limited.text, truncated: limited.truncated, parsed };
    } catch {
      // Una entrada que no es JSON (un texto suelto) se muestra tal cual.
    }
  }
  return {
    input: raw.slice(0, limits.toolInputMaxChars),
    truncated: length > limits.toolInputMaxChars,
    parsed: undefined,
  };
}

const shortText = (value: string): string => cut(value, QUESTION_MAX_CHARS).text;

/**
 * Las preguntas de `question`, o null si la entrada no tiene exactamente la
 * forma medida. Todo o nada: una pregunta a medias dibujaria opciones que no
 * son las del menu.
 */
export function questionItemsOf(parsed: unknown): ConversationQuestionItem[] | null {
  const questions = asRecord(parsed)?.['questions'];
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const items: ConversationQuestionItem[] = [];
  for (const raw of questions) {
    const record = asRecord(raw);
    const question = record?.['question'];
    const options = record?.['options'];
    if (typeof question !== 'string' || question.length === 0) return null;
    if (!Array.isArray(options) || options.length === 0) return null;

    const parsedOptions = [];
    for (const rawOption of options) {
      const option = asRecord(rawOption);
      const label = option?.['label'];
      if (typeof label !== 'string' || label.length === 0) return null;
      const description = option?.['description'];
      parsedOptions.push({ label: shortText(label), description: typeof description === 'string' ? shortText(description) : '' });
    }
    const header = record?.['header'];
    items.push({
      question: shortText(question),
      header: typeof header === 'string' ? shortText(header) : '',
      multiSelect: record?.['multiple'] === true,
      options: parsedOptions,
    });
  }
  return items;
}

/** "<encabezado o pregunta>: <respuestas>", una linea por pregunta, o null si las respuestas no se entienden. */
function answersText(items: readonly ConversationQuestionItem[], answersJson: string | null): string | null {
  if (answersJson === null) return null;
  let answers: unknown;
  try {
    answers = JSON.parse(answersJson);
  } catch {
    return null;
  }
  if (!Array.isArray(answers)) return null;
  return items
    .map((item, index) => {
      const chosen: unknown = answers[index];
      const labels = Array.isArray(chosen) ? chosen.filter((label): label is string => typeof label === 'string') : [];
      return `${item.header.length > 0 ? item.header : item.question}: ${labels.join(', ')}`;
    })
    .join('\n');
}

/**
 * Las partes de una llamada a herramienta: la llamada (o la pregunta) y, si
 * termino, su resultado, todas con `toolUseId = part.id`.
 *
 * `pending`, `running` o un estado desconocido: sin resultado. Una pregunta
 * `running` es una pregunta abierta; desde el hito 29 la tarjeta la contesta por
 * la API del `serve` (`serve-questions.ts`), casando `toolUseId` con el pedido.
 *
 * `limits`: los mismos con los que se leyo la fila (ver `BuildEventsInput`).
 */
export function toolParts(part: PartRow, limits: EventLimits = TRANSPORT_LIMITS): ConversationPart[] {
  const toolUseId = part.id;
  const { input, truncated, parsed } = toolInputOf(part, limits);
  const questions = part.tool === 'question' ? questionItemsOf(parsed) : null;

  const parts: ConversationPart[] = [
    questions !== null
      ? { kind: 'question', toolUseId, questions }
      : { kind: 'tool-call', toolUseId, name: part.tool ?? 'tool', input, truncated },
  ];

  const imageCount = part.attachment_count ?? 0;
  if (part.status === 'completed') {
    const answered = questions === null ? null : answersText(questions, part.answers_json);
    if (answered !== null) {
      const limited = cut(answered, limits.toolResultMaxChars);
      parts.push({ kind: 'tool-result', toolUseId, text: limited.text, isError: false, truncated: limited.truncated, imageCount });
    } else {
      const limited = cut(part.output ?? '', limits.toolResultMaxChars);
      parts.push({
        kind: 'tool-result',
        toolUseId,
        text: limited.text,
        isError: false,
        truncated: limited.truncated || (part.output_length ?? 0) > limits.toolResultMaxChars,
        imageCount,
      });
    }
  } else if (part.status === 'error') {
    const limited = cut(part.error ?? '', limits.toolResultMaxChars);
    parts.push({
      kind: 'tool-result',
      toolUseId,
      text: limited.text,
      isError: true,
      truncated: limited.truncated || (part.error_length ?? 0) > limits.toolResultMaxChars,
      imageCount,
    });
  }
  return parts;
}

function eventOf(
  eventId: string,
  role: ConversationEvent['role'],
  at: number,
  parts: ConversationPart[],
  extra: Partial<Pick<ConversationEvent, 'model' | 'effort'>> = {},
): ConversationEvent {
  return {
    eventId,
    role,
    at,
    parts,
    model: extra.model ?? null,
    usage: null,
    effort: extra.effort ?? null,
    durationMs: null,
    queued: false,
  };
}

function noticeOf(message: MessageRow): ConversationNoticePart | null {
  if (message.error_name === null || message.error_name.length === 0) return null;
  if (message.error_name === ABORTED_ERROR) return { kind: 'notice', notice: 'interrupted', detail: '' };
  return {
    kind: 'notice',
    notice: 'error',
    detail: `${message.error_name}: ${message.error_message ?? ''}`.slice(0, NOTICE_DETAIL_MAX_CHARS),
  };
}

/**
 * Los eventos de la conversacion, en orden, con la duracion de los turnos
 * cerrados ya puesta.
 *
 * Mensaje `user`: un evento con sus imagenes y sus textos (sin los sinteticos ni
 * los ignorados), en la posicion de su primera parte visible; y un aviso
 * `compacted` por cada parte `compaction`, en la suya.
 *
 * Mensaje `assistant`: un evento por texto no vacio y uno por herramienta; el
 * aviso de error o de interrupcion al final. El paso de compactacion
 * (`summary`) no dibuja nada. `usage` va en el ultimo evento visible del mensaje.
 */
export function buildEvents(input: BuildEventsInput): BuiltEvents {
  const limits = input.limits ?? TRANSPORT_LIMITS;
  const visible = applyRevert(input);
  const events: ConversationEvent[] = [];
  /** mensaje -> su ultimo evento visible. */
  const lastEventOf = new Map<string, ConversationEvent>();

  for (const message of visible.messages) {
    const parts = sortRows(visible.partsByMessage.get(message.id) ?? []);

    if (message.role === 'user') {
      /*
        Un solo evento para el mensaje, en la posicion de su primera parte
        visible; se crea vacio y se llena al final, imagenes primero, como las
        adjuntas de Claude Code.
      */
      const userEvent = eventOf(message.id, 'user', message.created_at ?? message.time_created, []);
      let placed = false;
      const images: ConversationPart[] = [];
      const texts: ConversationPart[] = [];
      /*
        La posicion cuenta todas las imagenes del mensaje, tambien las que
        quedaron detras de un revert: `readImage` las numera igual, sin mirar la
        marca.
      */
      const allImages = sortRows(input.partsByMessage.get(message.id) ?? []).filter(
        (part) => part.type === 'file' && (part.mime ?? '').startsWith('image/'),
      );

      for (const part of parts) {
        let visiblePart: ConversationPart | null = null;
        if (part.type === 'text') {
          if (isTrue(part.synthetic) || isTrue(part.ignored)) continue;
          visiblePart = textPartOf(part, limits, allImages.length);
          if (visiblePart !== null) texts.push(visiblePart);
        } else if (part.type === 'file' && part.mime !== null && part.mime.startsWith('image/')) {
          visiblePart = {
            kind: 'image',
            index: allImages.findIndex((image) => image.id === part.id),
            mediaType: part.mime,
            source: 'content',
          };
          images.push(visiblePart);
        } else if (part.type === 'compaction') {
          const notice = eventOf(`${message.id}:compaction`, 'assistant', part.time_created, [
            { kind: 'notice', notice: 'compacted', detail: isTrue(part.auto) ? 'auto' : '' },
          ]);
          events.push(notice);
          lastEventOf.set(message.id, notice);
        }
        // `file` que no es imagen, y cualquier otro tipo: nada.
        if (visiblePart !== null && !placed) {
          placed = true;
          events.push(userEvent);
          lastEventOf.set(message.id, userEvent);
        }
      }
      userEvent.parts = [...images, ...texts];
      continue;
    }

    if (message.role !== 'assistant' || isTrue(message.summary)) continue;

    const model = modelOf(message);
    const effort = message.variant !== null && message.variant.length > 0 ? message.variant : null;
    let last: ConversationEvent | null = null;
    for (const part of parts) {
      let eventParts: ConversationPart[] | null = null;
      if (part.type === 'text') {
        const text = textPartOf(part, limits);
        eventParts = text === null ? null : [text];
      } else if (part.type === 'tool') {
        eventParts = toolParts(part, limits);
      }
      // `reasoning`, `step-*`, `patch`, `snapshot`, `agent`, `subtask`, `retry`, `file` y lo desconocido: nada.
      if (eventParts === null) continue;
      last = eventOf(part.id, 'assistant', part.time_created, eventParts, { model, effort });
      events.push(last);
    }
    const usage = messageUsageOf(message);
    if (last !== null) last.usage = usage;

    const notice = noticeOf(message);
    if (notice !== null) {
      last = eventOf(`${message.id}:error`, 'assistant', message.completed_at ?? message.time_created, [notice]);
      events.push(last);
    }
    if (last !== null) lastEventOf.set(message.id, last);
  }

  return { events, turns: applyTurnDurations(visible.messages, lastEventOf) };
}

/**
 * La duracion de cada turno cerrado, en el ultimo evento visible de sus pasos.
 *
 * OpenCode no escribe la duracion de un turno, pero los dos extremos los pone
 * la CLI al procesar: la hora del mensaje del usuario y la de cierre del ultimo
 * paso. La resta no incluye lo que se tardo en escribir, que es lo que §4.9.1
 * de CLAUDE.md prohibe.
 */
function applyTurnDurations(
  messages: readonly MessageRow[],
  lastEventOf: ReadonlyMap<string, ConversationEvent>,
): Map<string, number> {
  const turns = new Map<string, number>();
  const stepsOf = new Map<string, MessageRow[]>();
  for (const message of messages) {
    if (message.role !== 'assistant' || message.parent_id === null) continue;
    const steps = stepsOf.get(message.parent_id);
    if (steps === undefined) stepsOf.set(message.parent_id, [message]);
    else steps.push(message);
  }

  for (const user of messages) {
    if (user.role !== 'user') continue;
    const steps = stepsOf.get(user.id);
    const latest = steps?.[steps.length - 1];
    if (steps === undefined || latest === undefined) continue;
    // Un paso que pidio herramientas no cierra el turno: viene otro.
    if (latest.completed_at === null || latest.finish === 'tool-calls') continue;

    let target: ConversationEvent | undefined;
    for (let index = steps.length - 1; index >= 0 && target === undefined; index -= 1) {
      const step = steps[index];
      if (step !== undefined) target = lastEventOf.get(step.id);
    }
    const durationMs = latest.completed_at - (user.created_at ?? user.time_created);
    if (target === undefined || durationMs < 0) continue;
    target.durationMs = durationMs;
    turns.set(target.eventId, durationMs);
  }
  return turns;
}

/**
 * El medidor.
 *
 *  - Cuentan los pasos de asistente con algun token: un error trae todo en 0 y
 *    no es una peticion.
 *  - La ultima peticion es la del paso mas reciente que no es la compactacion
 *    (`summary`); si todos lo son, el mas reciente.
 *  - `input` no incluye lo cacheado (medido: `cache.read > input` en 9 374 de
 *    10 292), asi que lo que leyo el modelo es `input + cache.read + cache.write`.
 *  - La ventana es la del catalogo, salvo que la peticion no entre en ella: ahi
 *    el catalogo no describe ese proveedor, y no se inventa otra.
 *
 * `messages` ya sin lo deshecho (`applyRevert`).
 */
export function buildUsage(messages: readonly MessageRow[], window: number | null): ContextUsage {
  const counted = sortRows(messages).filter((message) => message.role === 'assistant' && tokensOf(message).total > 0);
  if (counted.length === 0) return { ...EMPTY_CONTEXT_USAGE };

  const last = lastRequestMessage(counted);
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  for (const message of counted) {
    const tokens = tokensOf(message);
    totalInputTokens += tokens.input;
    totalOutputTokens += tokens.output;
    totalCacheReadTokens += tokens.read;
  }

  const tokens = last === null ? null : tokensOf(last);
  const lastRequestTokens = tokens === null ? 0 : tokens.input + tokens.read + tokens.write;
  return {
    lastRequestTokens,
    lastOutputTokens: tokens?.output ?? 0,
    lastModel: last === null ? null : modelOf(last),
    contextWindow: window !== null && lastRequestTokens <= window ? window : null,
    contextWindowEstimated: false,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    assistantMessages: counted.length,
  };
}

/** El paso que el medidor muestra como "la ultima peticion", o null si no hay ninguno con tokens. */
export function lastRequestMessage(messages: readonly MessageRow[]): MessageRow | null {
  const counted = sortRows(messages).filter((message) => message.role === 'assistant' && tokensOf(message).total > 0);
  for (let index = counted.length - 1; index >= 0; index -= 1) {
    const message = counted[index];
    if (message !== undefined && !isTrue(message.summary)) return message;
  }
  return counted[counted.length - 1] ?? null;
}
