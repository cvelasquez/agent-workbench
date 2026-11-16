/**
 * Lo que el narrador dice (hito 57, §6.40): de los eventos de la conversación
 * al texto hablado. Puro, sin navegador: lo cubre `check-narrator.mjs`.
 *
 * Lee lo que el hilo muestra como texto del agente, y sus preguntas. No lee las
 * herramientas ni sus resultados, el razonamiento, las imágenes, los avisos del
 * hilo ni los mensajes del usuario: el pedido es enterarse de lo que el agente
 * dice mientras trabaja, sin mirar la pestaña.
 */

import type { ConversationEvent } from '@agent-workbench/shared';

/** Las frases que reemplazan lo que no se lee tal cual, en el idioma de la interfaz. */
export interface NarratorPhrases {
  /** "Sigue un bloque de código." */
  codeBlock: string;
  /** "Sigue una tabla." */
  table: string;
  /** "un enlace": una URL suelta. */
  link: string;
}

/** Un mensaje para decir: el evento del que salió y sus trozos, en orden. */
export interface NarratorMessage {
  /** El `eventId`, más la posición de la parte: "Saltar" salta el mensaje entero. */
  messageId: string;
  chunks: string[];
}

/** Lo más largo que se le pasa de una vez a la voz: "Saltar" responde al terminar el trozo. */
export const MAX_CHUNK_CHARS = 240;

const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const URL = /\bhttps?:\/\/[^\s<>()[\]`'"]+[^\s<>()[\]`'".,;:!?]/g;
const MD_LINK = /!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s`'"<>|*?]+/g;
/** `docs\ref-interfaz.md`: una relativa con barras de Windows. */
const BACKSLASH_PATH = /(?:[\w.@-]+\\)+[\w.@-]+/g;
/** `/a/b/c`, `~/a/b`, `./a/b`, o `a/b/c.ext`: al menos dos tramos, o una extensión al final. */
const SLASH_PATH = /(?:~|\.{1,2})?\/?(?:[\w.@-]+\/)+[\w@-]+(?:\.[A-Za-z0-9]{1,8})?/g;

/** El último tramo de una ruta: lo que dice algo al oído. */
function baseName(path: string): string {
  const parts = path.split(/[\\/]+/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** Una ruta con barras merece acortarse: `y/o` y `1/2` no lo son. */
function isSlashPath(match: string): boolean {
  const segments = match.split('/').filter((part) => part.length > 0);
  if (segments.length < 2) return false;
  // Una fecha (16/11/2026) o una fracción no es una ruta.
  if (segments.every((segment) => /^\d+$/.test(segment))) return false;
  const last = segments[segments.length - 1] ?? '';
  const rooted = match.startsWith('/') || match.startsWith('~/') || match.startsWith('./') || match.startsWith('../');
  const hasExtension = /\.[A-Za-z0-9]{1,8}$/.test(last);
  return rooted ? true : hasExtension || segments.length >= 3;
}

/** Las rutas, por su nombre de archivo; las URL, por "un enlace". */
function shortenPaths(text: string, phrases: NarratorPhrases): string {
  return text
    .replace(URL, phrases.link)
    .replace(WINDOWS_PATH, (match) => baseName(match))
    .replace(BACKSLASH_PATH, (match) => baseName(match))
    .replace(SLASH_PATH, (match) => (isSlashPath(match) ? baseName(match) : match));
}

/** Las marcas de una línea: énfasis, código en línea, enlaces y rutas. */
function inlineSpeech(line: string, phrases: NarratorPhrases): string {
  let text = line.replace(MD_LINK, (_whole, label: string, href: string) => {
    const shown = label.trim();
    if (shown.length > 0) return shown;
    return /^https?:/i.test(href) ? phrases.link : baseName(href);
  });
  // El código en línea se lee tal cual, salvo que sea una ruta o una URL.
  text = text.replace(/`+([^`]+)`+/g, (_whole, code: string) => shortenPaths(code, phrases));
  text = shortenPaths(text, phrases);
  text = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1$2')
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

/** Una línea que no cierra con un signo se cierra con un punto: la voz hace la pausa. */
function closeSentence(line: string): string {
  return /[.!?…:;,)]$/.test(line) || /[.!?…]["»”)]$/.test(line) ? line : `${line}.`;
}

/**
 * El Markdown de un mensaje, como se dice: sin marcas, los bloques de código y
 * las tablas anunciados y saltados, los enlaces por su texto, las URL por "un
 * enlace" y las rutas por su nombre de archivo. Una oración por línea.
 */
export function speechText(markdown: string, phrases: NarratorPhrases): string {
  const out: string[] = [];
  let fence: string | null = null;
  let inTable = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const fenceMatch = FENCE.exec(raw);
    if (fence !== null) {
      if (fenceMatch !== null && fenceMatch[1] === fence) fence = null;
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] ?? '```';
      out.push(phrases.codeBlock);
      inTable = false;
      continue;
    }
    if (TABLE_ROW.test(raw)) {
      if (!inTable) out.push(phrases.table);
      inTable = true;
      continue;
    }
    inTable = false;
    if (RULE.test(raw)) continue;
    const line = raw
      .replace(/^\s{0,3}#{1,6}\s+/, '')
      .replace(/^\s*(>\s*)+/, '')
      .replace(/^\s*([-*+]|\d{1,3}[.)])\s+(\[[ xX]\]\s+)?/, '');
    const spoken = inlineSpeech(line, phrases);
    if (spoken.length > 0) out.push(closeSentence(spoken));
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

/** Corta un texto largo por donde menos se nota: oración, coma, espacio. */
function splitLong(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    if (cut < max / 3) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    else cut += 1;
    pieces.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * El texto hablado en trozos: por oraciones, y las muy largas por comas.
 * Chrome corta con algunas voces los enunciados largos, y partir deja que
 * "Saltar" responda al terminar el trozo y no el mensaje entero.
 */
export function speechChunks(text: string, max: number = MAX_CHUNK_CHARS): string[] {
  const sentences = text.split(/(?<=[.!?…])\s+(?=\S)/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences.flatMap((one) => splitLong(one.trim(), max))) {
    if (sentence.length === 0) continue;
    // Las oraciones cortas van juntas: cada trozo es una pausa de la voz.
    if (current.length > 0 && current.length + 1 + sentence.length <= max) {
      current = `${current} ${sentence}`;
    } else {
      if (current.length > 0) chunks.push(current);
      current = sentence;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Lo que se dice de unos eventos, en orden: el texto del agente y sus
 * preguntas. Lo demás no se dice.
 */
export function narratorMessages(events: readonly ConversationEvent[], phrases: NarratorPhrases): NarratorMessage[] {
  const messages: NarratorMessage[] = [];
  for (const event of events) {
    if (event.role !== 'assistant') continue;
    event.parts.forEach((part, index) => {
      let text = '';
      if (part.kind === 'text') {
        text = speechText(part.text, phrases);
      } else if (part.kind === 'question') {
        // La pregunta y sus opciones, como se ven en la tarjeta.
        text = part.questions
          .map((item) => {
            const question = closeSentence(inlineSpeech(item.question, phrases));
            const options = item.options.map((option) => inlineSpeech(option.label, phrases)).filter((label) => label.length > 0);
            return options.length === 0 ? question : `${question} ${closeSentence(options.join(', '))}`;
          })
          .join(' ');
      }
      const chunks = speechChunks(text);
      if (chunks.length > 0) messages.push({ messageId: `${event.eventId}#${index}`, chunks });
    });
  }
  return messages;
}

/** Qué hacer con un `conversation.reset` de la pestaña narrada. */
export interface ResetPlan {
  /** Los eventos que faltaba leer, en orden. */
  fresh: ConversationEvent[];
  /** El último leído ya no está en el tramo: se perdieron mensajes. */
  gap: boolean;
}

/**
 * Un `reset` trae el tramo final de la conversación, no lo que faltó: llega al
 * reconectar, y cuando el hilo se suscribe a la pestaña narrada. Se lee lo que
 * vino después del último evento visto.
 *
 *  - Sin ninguno visto todavía, el tramo es el historial: no se lee nada.
 *  - Con el último visto en el tramo, lo que sigue y no se vio.
 *  - Con el último visto fuera del tramo, faltaron más de los que caben: se
 *    avisa el hueco y se lee sólo el último mensaje del agente, que es el que
 *    más probablemente pide algo.
 */
export function planReset(
  events: readonly ConversationEvent[],
  lastSeenId: string | null,
  seen: ReadonlySet<string>,
): ResetPlan {
  if (lastSeenId === null) return { fresh: [], gap: false };
  const at = events.findIndex((event) => event.eventId === lastSeenId);
  if (at !== -1) {
    return { fresh: events.slice(at + 1).filter((event) => !seen.has(event.eventId)), gap: false };
  }
  // Todo el tramo ya visto (una página vieja, o el mismo de antes): nada nuevo.
  if (events.every((event) => seen.has(event.eventId))) return { fresh: [], gap: false };
  const lastAssistant = [...events].reverse().find((event) => event.role === 'assistant' && !seen.has(event.eventId));
  return { fresh: lastAssistant === undefined ? [] : [lastAssistant], gap: true };
}

/**
 * La fila de lo que falta decir. Pura: el hook la vacía de a un trozo con la
 * voz del navegador.
 */
export class NarratorQueue {
  private readonly items: { messageId: string; text: string }[] = [];

  push(message: NarratorMessage): void {
    for (const text of message.chunks) this.items.push({ messageId: message.messageId, text });
  }

  /** Lo próximo, sacándolo de la fila. */
  next(): { messageId: string; text: string } | null {
    return this.items.shift() ?? null;
  }

  /** Devuelve al frente un trozo que la voz no llegó a decir (el navegador pidió un gesto). */
  requeue(item: { messageId: string; text: string }): void {
    this.items.unshift(item);
  }

  /** "Saltar": lo que queda del mensaje que se está diciendo. */
  dropMessage(messageId: string): void {
    for (let index = this.items.length - 1; index >= 0; index -= 1) {
      if (this.items[index]?.messageId === messageId) this.items.splice(index, 1);
    }
  }

  /** "Callar": todo lo pendiente. */
  clear(): void {
    this.items.length = 0;
  }

  /** Cuántos mensajes distintos esperan. */
  pendingMessages(): number {
    return new Set(this.items.map((item) => item.messageId)).size;
  }

  get size(): number {
    return this.items.length;
  }
}
