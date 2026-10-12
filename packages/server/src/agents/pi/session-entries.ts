/**
 * Lo que dice cada linea de un archivo de sesion de Pi, sin interpretar todavia
 * a que rama pertenece.
 *
 * Una linea JSON por entrada, todas con `type`, `id`, `parentId` y `timestamp`
 * (CLAUDE.md 16.3). Aca se lee una sola linea y se la deja en una forma chica y
 * tipada; que evento del hilo sale de cada una, y con que modelo, duracion o
 * marca de "en cola", depende del camino hasta ella y lo decide
 * `session-path.ts`.
 *
 * Tres cosas que no se leen nunca, ni para mostrarlas ni para guardarlas:
 *
 *  - `thinkingSignature` y `textSignature`: el razonamiento cifrado del
 *    proveedor, unos 2 KB por respuesta. Del bloque `thinking` solo queda la
 *    marca de que hubo razonamiento.
 *  - El prompt del sistema (`role: system`, unos 6 KB): no es parte de la
 *    conversacion.
 *  - Los bytes de una imagen: viaja la referencia, y se piden aparte.
 *
 * Nunca lanza: el formato cambia entre versiones de Pi, y lo que no se reconoce
 * queda como una entrada sin contenido que igual sostiene el arbol.
 */

import {
  asRecord,
  type ConversationPart,
  type ConversationToolResultPart,
} from '@agent-workbench/shared';
import { pastedImageMediaType } from '../../paste-paths.js';
import { cut, type EventLimits } from '../transport-limits.js';

/** Tope del detalle de un aviso de error, como en las demas CLIs. */
export const NOTICE_DETAIL_MAX_CHARS = 300;

/** El uso de una respuesta, con los nombres de Pi. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** `input + output + cacheRead + cacheWrite`: lo que Pi dibuja en su pie. */
  totalTokens: number;
}

export type PiFact =
  /** Cualquier cosa que no dibuja nada: el prompt del sistema, etiquetas, ediciones de contexto. */
  | { kind: 'other' }
  | { kind: 'model'; provider: string; modelId: string }
  | { kind: 'thinking'; level: string }
  | { kind: 'info'; name: string }
  /** `compaction` y `branch_summary`: el contexto se resumio para seguir. */
  | { kind: 'compaction' }
  | {
      kind: 'user';
      /** Las imagenes primero y despues el texto, ya recortado. */
      parts: ConversationPart[];
      /** El principio del texto en una sola linea de espacios (`plainText`): para casarlo con lo que mando la app. */
      plain: string;
    }
  | {
      kind: 'assistant';
      parts: ConversationPart[];
      provider: string | null;
      model: string | null;
      usage: PiUsage | null;
      /** `stop`, `toolUse`, `error` o `aborted`; null si la linea no lo trae. */
      stopReason: string | null;
      thinkingLevel: string | null;
      errorMessage: string | null;
    }
  | { kind: 'toolResult'; toolCallId: string; part: ConversationToolResultPart }
  /** Un comando `!` del usuario, con su salida. */
  | { kind: 'bash'; command: string; output: string; failed: boolean; truncated: boolean };

export interface PiEntry {
  /** El `id` de la entrada; `line-<n>` si no trae (formatos viejos). */
  id: string;
  /**
   * De que entrada cuelga. null: es la raiz. undefined: la linea no lo dice
   * (formato sin arbol) y cuelga de la anterior del archivo.
   */
  parentId: string | null | undefined;
  /** Epoch ms de cuando se escribio. 0 si no trae hora. */
  at: number;
  fact: PiFact;
}

/** La primera linea del archivo. */
export interface PiSessionHeader {
  sessionId: string;
  /** La carpeta real del proyecto: la del nombre de la carpeta pierde informacion (16.2). */
  cwd: string;
  version: number | null;
  /** La ruta del archivo de origen de una sesion bifurcada (`/fork`), o null. */
  parentSession: string | null;
  startedAt: number;
}

function stampOf(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** La cabecera, o null si esa linea no es una. */
export function readHeader(record: Record<string, unknown>): PiSessionHeader | null {
  if (record['type'] !== 'session') return null;
  const sessionId = record['id'];
  const cwd = record['cwd'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  if (typeof cwd !== 'string' || cwd.length === 0) return null;
  const version = record['version'];
  const parentSession = record['parentSession'];
  return {
    sessionId,
    cwd,
    version: typeof version === 'number' && Number.isFinite(version) ? version : null,
    parentSession: typeof parentSession === 'string' && parentSession.length > 0 ? parentSession : null,
    startedAt: stampOf(record['timestamp']),
  };
}

/**
 * Una imagen del cuadro de escritura, nombrada por ruta en una linea propia
 * (`ImageReferenceStyle` `quoted-path-line`). La ruta tiene que tener la forma
 * de las que pone `PasteStore`: cualquier otra linea igual es texto del usuario.
 */
const ATTACHED_IMAGE_LINE = /^Attached image: "([^"\r\n]+)"$/;

/** Las rutas de las imagenes del cuadro que nombra ese texto, en orden. */
export function pastedImagePaths(text: string): string[] {
  const paths: string[] = [];
  for (const line of text.split('\n')) {
    const match = ATTACHED_IMAGE_LINE.exec(line.trim());
    const target = match?.[1];
    if (target !== undefined && pastedImageMediaType(target) !== null) paths.push(target);
  }
  return paths;
}

/** El texto sin las lineas de imagenes del cuadro. */
function withoutPastedImageLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => {
      const target = ATTACHED_IMAGE_LINE.exec(line.trim())?.[1];
      return target === undefined || pastedImageMediaType(target) === null;
    })
    .join('\n');
}

/** El contenido de un mensaje: un string, o una lista de bloques. */
function blocksOf(content: unknown): Record<string, unknown>[] {
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  const blocks: Record<string, unknown>[] = [];
  for (const item of content) {
    const block = asRecord(item);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

function textOf(blocks: readonly Record<string, unknown>[]): string {
  return blocks
    .filter((block) => block['type'] === 'text' && typeof block['text'] === 'string')
    .map((block) => block['text'] as string)
    .join('\n');
}

/** El tipo de cada bloque `image` de un contenido, en orden. */
export function contentImageTypes(content: unknown): string[] {
  return blocksOf(content)
    .filter((block) => block['type'] === 'image')
    .map((block) => (typeof block['mimeType'] === 'string' && block['mimeType'].length > 0 ? block['mimeType'] : 'image/png'));
}

function readUser(message: Record<string, unknown>, limits: EventLimits): PiFact {
  const blocks = blocksOf(message['content']);
  const raw = textOf(blocks);
  const parts: ConversationPart[] = contentImageTypes(message['content']).map((mediaType, index) => ({
    kind: 'image',
    index,
    mediaType,
    source: 'content',
  }));
  for (const [index, target] of pastedImagePaths(raw).entries()) {
    parts.push({ kind: 'image', index, mediaType: pastedImageMediaType(target) ?? 'image/png', source: 'pasted' });
  }
  const text = withoutPastedImageLines(raw).trim();
  if (text.length > 0) parts.push({ kind: 'text', ...cut(text, limits.textMaxChars) });
  return { kind: 'user', parts, plain: plainText(raw) };
}

/** Cuanto de un mensaje se guarda para casarlo con lo que mando la app. */
export const PLAIN_MAX_CHARS = 8_000;
/** Cuanto de lo que mando la app se busca dentro de eso. Deja lugar a las lineas de imagenes de delante. */
export const PLAIN_NEEDLE_CHARS = 2_000;

/** Un texto en una sola linea de espacios simples, con tope: asi se comparan dos. */
export function plainText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, PLAIN_MAX_CHARS);
}

/** true si ese mensaje de la sesion (`plain`) es el texto que mando la app. */
export function plainMatches(plain: string, submitted: string): boolean {
  const needle = plainText(submitted).slice(0, PLAIN_NEEDLE_CHARS);
  return needle.length > 0 && plain.includes(needle);
}

function readUsage(value: unknown): PiUsage | null {
  const usage = asRecord(value);
  if (usage === null) return null;
  const input = numberOf(usage['input']);
  const output = numberOf(usage['output']);
  const cacheRead = numberOf(usage['cacheRead']);
  const cacheWrite = numberOf(usage['cacheWrite']);
  const total = numberOf(usage['totalTokens']);
  return { input, output, cacheRead, cacheWrite, totalTokens: total > 0 ? total : input + output + cacheRead + cacheWrite };
}

function prettyArguments(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return '';
  }
}

function readAssistant(message: Record<string, unknown>, limits: EventLimits): PiFact {
  const parts: ConversationPart[] = [];
  let thought = false;
  for (const block of blocksOf(message['content'])) {
    const type = block['type'];
    if (type === 'text') {
      const text = block['text'];
      if (typeof text === 'string' && text.length > 0) parts.push({ kind: 'text', ...cut(text, limits.textMaxChars) });
    } else if (type === 'thinking') {
      // Solo la marca: el texto viene vacio y la firma no se lee (ver arriba).
      if (!thought) parts.push({ kind: 'thinking' });
      thought = true;
    } else if (type === 'toolCall') {
      const id = block['id'];
      const name = block['name'];
      if (typeof id !== 'string' || id.length === 0 || typeof name !== 'string' || name.length === 0) continue;
      const input = cut(prettyArguments(block['arguments']), limits.toolInputMaxChars);
      parts.push({ kind: 'tool-call', toolUseId: id, name, input: input.text, truncated: input.truncated });
    }
  }
  const text = (key: string): string | null => {
    const value = message[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };
  return {
    kind: 'assistant',
    parts,
    provider: text('provider'),
    model: text('model'),
    usage: readUsage(message['usage']),
    stopReason: text('stopReason'),
    thinkingLevel: text('thinkingLevel'),
    errorMessage: text('errorMessage'),
  };
}

function readToolResult(message: Record<string, unknown>, limits: EventLimits): PiFact {
  const toolCallId = message['toolCallId'];
  if (typeof toolCallId !== 'string' || toolCallId.length === 0) return { kind: 'other' };
  const blocks = blocksOf(message['content']);
  const output = cut(textOf(blocks), limits.toolResultMaxChars);
  return {
    kind: 'toolResult',
    toolCallId,
    part: {
      kind: 'tool-result',
      toolUseId: toolCallId,
      text: output.text,
      isError: message['isError'] === true,
      truncated: output.truncated,
      imageCount: blocks.filter((block) => block['type'] === 'image').length,
    },
  };
}

function readBash(message: Record<string, unknown>, limits: EventLimits): PiFact {
  const command = message['command'];
  if (typeof command !== 'string' || command.length === 0) return { kind: 'other' };
  const output = cut(typeof message['output'] === 'string' ? message['output'] : '', limits.toolResultMaxChars);
  const exitCode = message['exitCode'];
  return {
    kind: 'bash',
    command: cut(command, limits.toolInputMaxChars).text,
    output: output.text,
    failed: message['cancelled'] === true || (typeof exitCode === 'number' && exitCode !== 0),
    truncated: output.truncated || message['truncated'] === true,
  };
}

function readFact(record: Record<string, unknown>, limits: EventLimits): PiFact {
  switch (record['type']) {
    case 'model_change': {
      const provider = record['provider'];
      const modelId = record['modelId'];
      return typeof provider === 'string' && provider.length > 0 && typeof modelId === 'string' && modelId.length > 0
        ? { kind: 'model', provider, modelId }
        : { kind: 'other' };
    }
    case 'thinking_level_change': {
      const level = record['thinkingLevel'];
      return typeof level === 'string' && level.length > 0 ? { kind: 'thinking', level } : { kind: 'other' };
    }
    case 'session_info': {
      const name = record['name'];
      return typeof name === 'string' && name.trim().length > 0 ? { kind: 'info', name: name.trim() } : { kind: 'other' };
    }
    case 'compaction':
    case 'branch_summary':
      return { kind: 'compaction' };
    case 'message': {
      const message = asRecord(record['message']);
      if (message === null) return { kind: 'other' };
      switch (message['role']) {
        case 'user':
          return readUser(message, limits);
        case 'assistant':
          return readAssistant(message, limits);
        case 'toolResult':
          return readToolResult(message, limits);
        case 'bashExecution':
          return readBash(message, limits);
        default:
          return { kind: 'other' };
      }
    }
    default:
      return { kind: 'other' };
  }
}

/**
 * Una entrada del arbol, o null si la linea es la cabecera o no es una entrada.
 * `lineNumber` es 1-based y da el id de respaldo.
 */
export function readEntry(record: Record<string, unknown>, lineNumber: number, limits: EventLimits): PiEntry | null {
  const type = record['type'];
  if (typeof type !== 'string' || type === 'session') return null;
  const id = record['id'];
  const parentId = record['parentId'];
  return {
    id: typeof id === 'string' && id.length > 0 ? id : `line-${lineNumber}`,
    parentId: typeof parentId === 'string' && parentId.length > 0 ? parentId : parentId === null ? null : undefined,
    at: stampOf(record['timestamp']),
    fact: readFact(record, limits),
  };
}
