/**
 * El transcript de una conversacion para continuarla con otra CLI (hito 29).
 * Puro: no toca el disco ni lanza nada.
 *
 * La CLI que continua no recibe el contexto que tenia la otra: recibe un
 * archivo Markdown con los ultimos turnos y un mensaje corto que lo nombra.
 * Es un **recorte, no un resumen** (D16): la app no llama a ningun modelo, y
 * una sesion de 2 MB no la lee ningun agente de una vez.
 *
 * Cuatro reglas que no se ven hasta que fallan:
 *
 *  - **Todo texto que entra pasa por `sanitizeForPaste`**, la misma funcion del
 *    pegado: partes, entradas y resultados de herramientas, titulo y carpeta.
 *    Un `ESC[201~` guardado en una conversacion no llega ni al archivo ni al
 *    mensaje, que termina escrito en una pty.
 *  - **Dos topes, y los dos cuentan** (A2): 60 KB y 1 500 lineas. La CLI que
 *    lee el archivo con su herramienta lo corta por tokens y por lineas, y lo
 *    que se pierde es la cola, que son justo los turnos mas recientes. Pasado
 *    un tope se sueltan turnos viejos; con uno solo, se cortan textos, y en
 *    ultimo caso las lineas del medio del turno.
 *  - **Cada herramienta en una linea** (entrada 300, resultado 600). Lo que el
 *    agente necesita es saber que se hizo y como salio, no releer la salida.
 *  - **El razonamiento no existe** (CLAUDE.md 4.9) y las imagenes no viajan:
 *    se dice que habia una, no se inventa nada.
 */

import {
  noticeText,
  type ConversationEvent,
  type ConversationPart,
  type ConversationQuestionPart,
  type ConversationState,
  type ConversationToolCallPart,
  type ConversationToolResultPart,
} from '@agent-workbench/shared';
import type { TranscriptReferenceStyle } from '../agents/adapter.js';
import { UNTITLED_SESSION_TITLE } from '../agents/session-title.js';
import { fileReference, sanitizeForPaste } from '../pty-input.js';
import { formatFileDay } from '../vault/markdown.js';

/** Cuantos turnos entran, como mucho. */
export const HANDOFF_MAX_TURNS = 20;
/** Tope del archivo, en bytes UTF-8 (A2). */
export const HANDOFF_MAX_BYTES = 60_000;
/** Tope del archivo, en lineas (A2). */
export const HANDOFF_MAX_LINES = 1_500;
/** Cada parte de texto, en caracteres. */
export const HANDOFF_TEXT_CHARS = 8_000;
/** La entrada de una herramienta, en su linea. */
export const HANDOFF_TOOL_INPUT_CHARS = 300;
/** El resultado de una herramienta, en su linea. */
export const HANDOFF_TOOL_RESULT_CHARS = 600;
/** El ultimo pedido citado en el mensaje. */
export const HANDOFF_QUOTE_CHARS = 1_000;
/**
 * Cuantos eventos se leen de la sesion de origen para llegar a su principio
 * (M5). Pasado el tope no hay pedido inicial y la cuenta de turnos es un minimo.
 * Lo usa quien lee; aca solo llega como `complete`.
 */
export const HANDOFF_MAX_EVENTS = 5_000;

/** El titulo en la cabecera, en caracteres. */
const HEADER_TITLE_CHARS = 200;
/** La carpeta en la cabecera, en caracteres. Una ruta real no llega. */
const HEADER_CWD_CHARS = 1_000;
/** Las etiquetas de una pregunta, cada una. */
const QUESTION_LABEL_CHARS = 200;
/** Los topes de texto que se prueban, en orden, cuando un solo turno no entra. */
const TEXT_CHAR_STEPS = [4_000, 2_000, 1_000, 500, 250] as const;

/** Sin turnos no hay nada que continuar. */
export const HANDOFF_EMPTY_MESSAGE = 'Esa conversación no tiene mensajes que continuar.';
/** Una conversacion cuya CLI no dejo nada legible (hito 27, `no-transcript`). */
export const HANDOFF_NO_TRANSCRIPT_MESSAGE =
  'Esa conversación no tiene mensajes que continuar: esa CLI no dejó transcript legible.';

// ---------------------------------------------------------------------------
// Turnos
// ---------------------------------------------------------------------------

export interface Turn {
  /** 1-based sobre lo que se leyo: la conversacion entera si la lectura llego al principio. */
  number: number;
  events: ConversationEvent[];
}

/** true si el evento es un pedido del usuario: tiene al menos un texto no vacio. */
function opensTurn(event: ConversationEvent): boolean {
  return event.role === 'user' && event.parts.some((part) => part.kind === 'text' && part.text.trim().length > 0);
}

/**
 * Parte la conversacion en turnos. Un turno empieza con un evento `user` que
 * tiene al menos un `text` no vacio; un `user` con solo resultados de
 * herramientas o solo una imagen es parte del turno en curso. Lo anterior al
 * primer pedido no es turno: sin un pedido no hay nada que continuar.
 */
export function splitTurns(events: readonly ConversationEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const event of events) {
    if (opensTurn(event)) {
      turns.push({ number: turns.length + 1, events: [event] });
      continue;
    }
    turns.at(-1)?.events.push(event);
  }
  return turns;
}

export interface TurnSelection {
  turns: Turn[];
  /** El primer turno, si quedo fuera de `turns`. null tambien si la lectura no llego al principio. */
  opening: Turn | null;
  /** Turnos leidos. Con `complete` false, un minimo. */
  totalTurns: number;
  /** true si la lectura llego al principio de la conversacion (M5). */
  complete: boolean;
}

/**
 * Los ultimos `maxTurns`, mas el pedido inicial si quedo afuera. Con
 * `complete` false el primer turno leido no es el primero de la conversacion,
 * y citarlo como "pedido inicial" seria afirmar algo que no se sabe.
 */
export function selectTurns(all: readonly Turn[], maxTurns = HANDOFF_MAX_TURNS, complete = true): TurnSelection {
  const max = Math.max(1, Math.floor(maxTurns));
  const turns = all.slice(-max);
  const first = all[0];
  const opening = complete && first !== undefined && all.length > turns.length ? first : null;
  return { turns, opening, totalTurns: all.length, complete };
}

// ---------------------------------------------------------------------------
// Texto
// ---------------------------------------------------------------------------

/** Corta a `max` unidades UTF-16 sin partir un par sustituto. */
function cutChars(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let end = Math.max(0, max);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), cut: true };
}

/** Corta a `maxBytes` de UTF-8 sin partir un caracter. */
function cutBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/** Saneado y en una sola linea. */
const oneLine = (text: string): string => sanitizeForPaste(text).replace(/\s+/g, ' ').trim();

/** Codigo en linea con tantas comillas invertidas como hagan falta. */
function inlineCode(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  const ticks = '`'.repeat(longest + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${ticks}${padded}${ticks}`;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `aaaa-mm-dd hh:mm` en hora local: sin la ambiguedad de dia y mes para quien lo lee. */
function formatStamp(ms: number): string {
  const date = new Date(ms);
  return `${formatFileDay(ms)} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** Un texto de una parte, saneado, sin blancos al final, cortado. */
function renderText(text: string, truncated: boolean, maxChars: number): string | null {
  const clean = sanitizeForPaste(text).replace(/\s+$/u, '');
  if (clean.trim().length === 0) return null;
  const { text: kept, cut } = cutChars(clean, maxChars);
  return cut || truncated ? `${kept}… (recortado)` : kept;
}

const imagesText = (count: number): string =>
  count === 1 ? '[imagen no incluida]' : `[${count} imágenes no incluidas]`;

// ---------------------------------------------------------------------------
// Bloques
// ---------------------------------------------------------------------------

function renderResult(result: ConversationToolResultPart): string {
  const { text, cut } = cutChars(oneLine(result.text), HANDOFF_TOOL_RESULT_CHARS);
  const marks: string[] = [];
  if (result.isError) marks.push('error');
  if (cut || result.truncated) marks.push('recortado');
  let body = cut ? `${text}…` : text;
  if (result.imageCount > 0) body = body.length > 0 ? `${body} ${imagesText(result.imageCount)}` : imagesText(result.imageCount);
  if (body.length === 0) body = 'sin texto';
  return marks.length > 0 ? `${marks.join(', ')}: ${body}` : body;
}

function renderToolLine(part: ConversationToolCallPart, result: ConversationToolResultPart | undefined): string {
  const name = cutChars(oneLine(part.name), 80).text;
  const { text: input, cut } = cutChars(oneLine(part.input), HANDOFF_TOOL_INPUT_CHARS);
  const head = `- ${inlineCode(name.length > 0 ? name : 'herramienta')}`;
  const withInput = input.length > 0 ? `${head}: ${inlineCode(cut || part.truncated ? `${input}…` : input)}` : head;
  return `${withInput} → ${result !== undefined ? renderResult(result) : 'sin resultado'}`;
}

function renderQuestionLine(part: ConversationQuestionPart, result: ConversationToolResultPart | undefined): string {
  const labels = part.questions
    .map((item) => {
      const label = oneLine(item.question).length > 0 ? oneLine(item.question) : oneLine(item.header);
      return `"${cutChars(label, QUESTION_LABEL_CHARS).text}"`;
    })
    .join(', ');
  const title = part.questions.length === 1 ? `- Pregunta ${labels}` : `- Preguntas ${labels}`;
  if (result === undefined) return `${title}: sin responder`;
  const { text, cut } = cutChars(oneLine(result.text), HANDOFF_TOOL_RESULT_CHARS);
  const answer = `"${cut ? `${text}…` : text}"`;
  return `${title}: ${result.isError ? 'no respondida' : 'respondida'} ${answer}`;
}

/** Lo que dijo el usuario al abrir un turno: sus textos y cuantas imagenes. */
function renderRequestBody(event: ConversationEvent, textChars: number): string[] {
  const blocks: string[] = [];
  for (const part of event.parts) {
    if (part.kind === 'text') {
      const text = renderText(part.text, part.truncated, textChars);
      if (text !== null) blocks.push(text);
    } else if (part.kind === 'image') {
      blocks.push(imagesText(1));
    }
  }
  return blocks;
}

function renderTurn(turn: Turn, textChars: number): string {
  const [request, ...rest] = turn.events;
  if (request === undefined) return `## Turno ${turn.number} · usuario`;

  // Llamada y resultado viajan en eventos distintos (Claude Code) o en el
  // mismo (OpenCode): se casan por id dentro del turno.
  const results = new Map<string, ConversationToolResultPart>();
  const calls = new Set<string>();
  for (const event of turn.events) {
    for (const part of event.parts) {
      if (part.kind === 'tool-result' && !results.has(part.toolUseId)) results.set(part.toolUseId, part);
      if (part.kind === 'tool-call' || part.kind === 'question') calls.add(part.toolUseId);
    }
  }

  const heading = `## Turno ${turn.number} · usuario${request.queued ? ' (enviado mientras trabajaba)' : ''}`;
  const userBlocks = [heading, ...renderRequestBody(request, textChars)];

  const answer: string[] = [];
  let listOpen = false;
  const pushLine = (line: string): void => {
    // Las lineas de una lista van pegadas; un texto se separa con un blanco.
    if (listOpen) answer[answer.length - 1] += `\n${line}`;
    else answer.push(line);
    listOpen = true;
  };
  const pushText = (text: string): void => {
    answer.push(text);
    listOpen = false;
  };
  const renderAnswerPart = (event: ConversationEvent, part: ConversationPart): void => {
    switch (part.kind) {
      case 'text': {
        const text = renderText(part.text, part.truncated, textChars);
        if (text !== null) pushText(text);
        return;
      }
      case 'tool-call':
        pushLine(renderToolLine(part, results.get(part.toolUseId)));
        return;
      case 'question':
        pushLine(renderQuestionLine(part, results.get(part.toolUseId)));
        return;
      case 'tool-result':
        if (!calls.has(part.toolUseId)) pushLine(`- Resultado de una herramienta anterior → ${renderResult(part)}`);
        return;
      case 'image':
        pushLine(event.role === 'user' ? `- ${imagesText(1)} (del usuario)` : `- ${imagesText(1)}`);
        return;
      case 'notice':
        pushLine(`- Aviso: ${oneLine(noticeText(part))}`);
        return;
      case 'thinking':
        return;
    }
  };

  // Lo que el pedido trae ademas de texto e imagenes (un resultado suelto).
  for (const part of request.parts) {
    if (part.kind !== 'text' && part.kind !== 'image') renderAnswerPart(request, part);
  }
  for (const event of rest) {
    for (const part of event.parts) renderAnswerPart(event, part);
  }

  const blocks = [userBlocks.join('\n\n')];
  if (answer.length > 0) blocks.push([`## Turno ${turn.number} · asistente`, ...answer].join('\n\n'));
  return blocks.join('\n\n');
}

function renderOpening(turn: Turn, textChars: number): string {
  const request = turn.events[0];
  const body = request === undefined ? [] : renderRequestBody(request, textChars);
  return ['## Pedido inicial', ...body].join('\n\n');
}

export interface TranscriptHeader {
  /** `adapter.label` de la CLI de origen, o el nombre de una fuente importada. */
  sourceLabel: string;
  /** Id de la CLI de origen (`SessionAgentId`). */
  agent: string;
  cwd: string;
  title: string;
  sessionId: string;
  /** Epoch ms de la ultima actividad, o null. */
  lastAt: number | null;
  /** El 28 marca "historial parcial" lo importado sin contenido completo. */
  partial: boolean;
}

function coverageSentence(included: number, total: number, complete: boolean): string {
  let what: string;
  if (!complete) {
    what = `Incluye ${included === 1 ? 'el último' : `los últimos ${included}`} de más de ${total} turnos, numerados desde el más viejo que se leyó.`;
  } else if (included >= total) {
    what = total === 1 ? 'Incluye el único turno.' : `Incluye los ${total} turnos.`;
  } else {
    what = `Incluye ${included === 1 ? 'el último' : `los últimos ${included}`} de ${total} turnos.`;
  }
  return `${what} Los resultados de herramientas están recortados y las imágenes no se incluyen.`;
}

function renderHeader(header: TranscriptHeader, included: number, selection: TurnSelection): string {
  const label = cutChars(oneLine(header.sourceLabel), 80).text;
  const title = cutChars(oneLine(header.title), HEADER_TITLE_CHARS).text;
  // La carpeta no se colapsa: dos espacios seguidos son parte del nombre.
  const cwd = cutChars(sanitizeForPaste(header.cwd).replace(/[\n\t]/g, ' ').trim(), HEADER_CWD_CHARS).text;
  const agent = cutChars(oneLine(header.agent), 80).text;
  const sessionId = cutChars(oneLine(header.sessionId), 200).text;

  const facts = [
    `- Proyecto: ${cwd.trim().length > 0 ? inlineCode(cwd) : 'desconocido'}`,
    `- Conversación: ${title.length > 0 ? title : UNTITLED_SESSION_TITLE} (${agent}, ${sessionId})`,
  ];
  if (header.lastAt !== null && header.lastAt > 0) facts.push(`- Última respuesta: ${formatStamp(header.lastAt)}`);
  facts.push(`- ${coverageSentence(included, selection.totalTurns, selection.complete)}`);
  if (header.partial) facts.push('- Historial parcial: la conversación original no se pudo leer entera.');
  return `# Continuación de una conversación con ${label}\n\n${facts.join('\n')}`;
}

// ---------------------------------------------------------------------------
// El documento, dentro de los topes
// ---------------------------------------------------------------------------

interface Measured {
  text: string;
  bytes: number;
  lines: number;
}

function measured(text: string): Measured {
  let lines = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) lines += 1;
  return { text, bytes: Buffer.byteLength(text, 'utf8'), lines };
}

/** Bloques separados por una linea en blanco, con salto final: cuanto pesa y cuantas lineas tiene. */
function sizeOf(blocks: readonly Measured[]): { bytes: number; lines: number } {
  const joins = Math.max(0, blocks.length - 1) * 2 + 1;
  let bytes = joins;
  let lines = joins;
  for (const block of blocks) {
    bytes += block.bytes;
    lines += block.lines;
  }
  return { bytes, lines };
}

const assemble = (blocks: readonly Measured[]): string => `${blocks.map((block) => block.text).join('\n\n')}\n`;

/**
 * Deja un bloque dentro de `maxBytes` y `maxLines` conservando su encabezado,
 * el principio (el pedido) y el final (lo ultimo que se respondio), con una
 * marca de lo omitido en el medio.
 */
function elide(block: string, maxBytes: number, maxLines: number): string {
  if (Buffer.byteLength(block, 'utf8') <= maxBytes && measured(block).lines <= maxLines) return block;
  const lines = block.split('\n');
  const heading = lines[0] ?? '';
  const body = lines.slice(1);
  const marker = (omitted: number): string => `[… ${omitted} líneas omitidas para que el transcript entre en su tope …]`;

  const markerBytes = Buffer.byteLength(marker(body.length), 'utf8') + 1;
  const available = Math.max(0, maxBytes - Buffer.byteLength(heading, 'utf8') - 1 - markerBytes);
  const availableLines = Math.max(0, maxLines - 3);
  const headBudget = Math.floor(available * 0.4);
  const tailBudget = available - headBudget;
  const headLines = Math.floor(availableLines * 0.4);
  const tailLines = availableLines - headLines;

  const take = (candidates: readonly string[], budget: number, lineBudget: number): string[] => {
    const kept: string[] = [];
    let used = 0;
    for (const line of candidates) {
      if (kept.length >= lineBudget) break;
      const size = Buffer.byteLength(line, 'utf8') + 1;
      if (used + size > budget) {
        // Una sola linea que no entra se corta, para no dejar el turno vacio.
        if (kept.length === 0 && budget - used > 1) kept.push(cutBytes(line, budget - used - 1));
        break;
      }
      kept.push(line);
      used += size;
    }
    return kept;
  };

  const head = take(body, headBudget, headLines);
  const tail = take([...body.slice(head.length)].reverse(), tailBudget, tailLines).reverse();
  const omitted = body.length - head.length - tail.length;
  if (omitted <= 0) return [heading, ...head, ...tail].join('\n');
  return [heading, ...head, marker(omitted), ...tail].join('\n');
}

/**
 * Markdown saneado, dentro de `maxBytes` y `maxLines`. Si no entra, suelta
 * turnos viejos; con uno solo, corta sus textos y, en ultimo caso, las lineas
 * del medio. El turno que queda se conserva siempre.
 */
export function renderTranscript(
  header: TranscriptHeader,
  selection: TurnSelection,
  maxBytes = HANDOFF_MAX_BYTES,
  maxLines = HANDOFF_MAX_LINES,
): { markdown: string; includedTurns: number } {
  const fits = (blocks: readonly Measured[]): boolean => {
    const size = sizeOf(blocks);
    return size.bytes <= maxBytes && size.lines <= maxLines;
  };

  let turnBlocks = selection.turns.map((turn) => measured(renderTurn(turn, HANDOFF_TEXT_CHARS)));
  let opening = selection.opening === null ? null : measured(renderOpening(selection.opening, HANDOFF_TEXT_CHARS));
  const build = (count: number): Measured[] => [
    measured(renderHeader(header, count, selection)),
    ...(opening === null ? [] : [opening]),
    ...turnBlocks.slice(turnBlocks.length - count),
  ];

  let count = turnBlocks.length;
  while (count > 1 && !fits(build(count))) count -= 1;
  if (fits(build(count))) return { markdown: assemble(build(count)), includedTurns: count };

  // Queda un turno (o ninguno) y no entra: textos mas cortos.
  const kept = selection.turns.slice(selection.turns.length - count);
  for (const chars of TEXT_CHAR_STEPS) {
    turnBlocks = kept.map((turn) => measured(renderTurn(turn, chars)));
    opening = selection.opening === null ? null : measured(renderOpening(selection.opening, chars));
    if (fits(build(count))) return { markdown: assemble(build(count)), includedTurns: count };
  }

  // Ultimo recurso: el pedido inicial a un cuarto de los topes y el turno al resto.
  if (opening !== null) opening = measured(elide(opening.text, Math.floor(maxBytes / 4), Math.floor(maxLines / 4)));
  const last = turnBlocks.at(-1);
  if (last !== undefined) {
    // La cabecera con la cuenta final: la de cero turnos dice otra cosa y pesa distinto.
    const others = sizeOf([measured(renderHeader(header, count, selection)), ...(opening === null ? [] : [opening])]);
    // El turno suma su texto mas una separacion de dos saltos.
    turnBlocks = [measured(elide(last.text, maxBytes - others.bytes - 2, maxLines - others.lines - 2))];
  }
  return { markdown: assemble(build(count)), includedTurns: count };
}

// ---------------------------------------------------------------------------
// El mensaje
// ---------------------------------------------------------------------------

/** El texto del ultimo pedido del usuario, o null si no hay ninguno. */
export function lastRequestOf(turns: readonly Turn[]): string | null {
  const request = turns.at(-1)?.events[0];
  if (request === undefined) return null;
  const texts = request.parts.flatMap((part) => (part.kind === 'text' && part.text.trim().length > 0 ? [part.text] : []));
  return texts.length > 0 ? texts.join('\n\n') : null;
}

/** Una cita en Markdown, cortada a `HANDOFF_QUOTE_CHARS`. */
function quote(text: string): string {
  const clean = sanitizeForPaste(text).trim();
  const { text: kept, cut } = cutChars(clean, HANDOFF_QUOTE_CHARS);
  return (cut ? `${kept}…` : kept)
    .split('\n')
    .map((line) => (line.length > 0 ? `> ${line}` : '>'))
    .join('\n');
}

/**
 * El mensaje que recibe la CLI que continua. Corto a proposito: lo que importa
 * esta en el archivo, y el mensaje solo dice donde, que no es su contexto y
 * cual fue el ultimo pedido.
 */
export function buildContinuationMessage(input: {
  sourceLabel: string;
  includedTurns: number;
  /** Ya armada con `transcriptReferenceFor`. */
  reference: string;
  lastRequest: string | null;
}): string {
  const label = oneLine(input.sourceLabel);
  const lines = [
    `Esto continúa una conversación que empezó con otro asistente (${label}).`,
    input.includedTurns === 1
      ? `El transcript del último turno está en ${input.reference}.`
      : `El transcript de los últimos ${input.includedTurns} turnos está en ${input.reference}.`,
  ];
  if (input.lastRequest !== null && sanitizeForPaste(input.lastRequest).trim().length > 0) {
    lines.push('Leelo entero y seguí desde el último pedido, que fue:', '', quote(input.lastRequest));
  } else {
    lines.push('Leelo entero y seguí desde donde quedó.');
  }
  return sanitizeForPaste(lines.join('\n'));
}

/**
 * Como se nombra el archivo en el mensaje (D18). `at-quoted` es la misma forma
 * que una imagen adjunta (`fileReference`, B2); `quoted-path`, la ruta entre
 * comillas para que un espacio no la corte.
 */
export function transcriptReferenceFor(path: string, style: TranscriptReferenceStyle): string {
  return style === 'at-quoted' ? fileReference(path, 'at-quoted') : `"${path}"`;
}

// ---------------------------------------------------------------------------
// Todo junto, antes de abrir nada
// ---------------------------------------------------------------------------

export type TranscriptPlan =
  | {
      ok: true;
      markdown: string;
      includedTurns: number;
      totalTurns: number;
      /** true si la lectura no llego al principio: `totalTurns` es un minimo. */
      totalTurnsIsMinimum: boolean;
      lastRequest: string | null;
    }
  | { ok: false; message: string };

/**
 * Turnos, seleccion y documento, o por que no hay continuacion. Es lo que se
 * decide **antes** de abrir la pestana de la CLI que continua: una conversacion
 * sin turnos no deja una pestana vacia abierta.
 */
export function planTranscript(input: {
  header: TranscriptHeader;
  events: readonly ConversationEvent[];
  /** El estado del seguidor de origen. `no-transcript` cambia el motivo. */
  state?: ConversationState;
  /** false si la lectura no llego al principio (M5). */
  complete?: boolean;
  maxTurns?: number;
  maxBytes?: number;
  maxLines?: number;
}): TranscriptPlan {
  const turns = splitTurns(input.events);
  if (turns.length === 0) {
    return {
      ok: false,
      message: input.state === 'no-transcript' ? HANDOFF_NO_TRANSCRIPT_MESSAGE : HANDOFF_EMPTY_MESSAGE,
    };
  }
  const complete = input.complete ?? true;
  const selection = selectTurns(turns, input.maxTurns ?? HANDOFF_MAX_TURNS, complete);
  const { markdown, includedTurns } = renderTranscript(
    input.header,
    selection,
    input.maxBytes ?? HANDOFF_MAX_BYTES,
    input.maxLines ?? HANDOFF_MAX_LINES,
  );
  return {
    ok: true,
    markdown,
    includedTurns,
    totalTurns: selection.totalTurns,
    totalTurnsIsMinimum: !complete,
    lastRequest: lastRequestOf(turns),
  };
}
