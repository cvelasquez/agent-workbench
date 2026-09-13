/**
 * Lectores de una linea de rollout de Codex ya parseada.
 *
 * Puros y sin estado: reciben el `payload` (o una parte) y devuelven lo que la
 * app usa, o null. Nunca lanzan: el formato cambia entre versiones de Codex y
 * un campo que falta es lo normal, no un error (§4.4 de CLAUDE.md: desconocido
 * se ignora en silencio).
 *
 * Los ejemplos de la forma de cada linea estan en la especificacion del hito
 * 25 (§3), medidos sobre 13 rollouts de la 0.128 y contrastados con el codigo
 * de la 0.154.
 */

import { asRecord } from '@agent-workbench/shared';
import { cut, TOOL_RESULT_MAX_CHARS } from '../transport-limits.js';

/** Un numero finito, o null. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Un string no vacio, o null. */
function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Un numero finito y no negativo, o 0. Es como se leen los contadores de tokens. */
export function tokenNumber(value: unknown): number {
  const n = finite(value);
  return n !== null && n >= 0 ? n : 0;
}

export interface SessionMeta {
  /** Tal como viene. El que compara lo pasa a minusculas. */
  id: string;
  /** Epoch ms de `payload.timestamp` (creacion del hilo), o null si no parsea. */
  createdAt: number | null;
  /** `''` si no trae. */
  cwd: string;
  /** Un string (`cli`, `exec`, ...) o un objeto (subagente). Se decide afuera. */
  source: unknown;
  /** `legacy`, `paginated`, ... o null si la version no lo escribe. */
  historyMode: string | null;
  /** Id del hilo del que salio con `/fork`, o null. */
  forkedFromId: string | null;
}

/** `session_meta.payload`. null si no trae un `id` string. */
export function readSessionMeta(payload: unknown): SessionMeta | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const id = nonEmpty(record['id']);
  if (id === null) return null;
  const stamp = record['timestamp'];
  const parsed = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  return {
    id,
    createdAt: Number.isFinite(parsed) ? parsed : null,
    cwd: typeof record['cwd'] === 'string' ? record['cwd'] : '',
    source: record['source'],
    historyMode: nonEmpty(record['history_mode']),
    forkedFromId: nonEmpty(record['forked_from_id']),
  };
}

export interface TurnContext {
  turnId: string | null;
  cwd: string | null;
  model: string | null;
  /**
   * `effort` si viene; si no, el `reasoning_effort` del modo de colaboracion.
   * Medido: falta en 1 de 26, y ahi el del modo es null.
   */
  effort: string | null;
}

/** `turn_context.payload`. null si no es un objeto. */
export function readTurnContext(payload: unknown): TurnContext | null {
  const record = asRecord(payload);
  if (record === null) return null;
  const settings = asRecord(asRecord(record['collaboration_mode'])?.['settings']);
  return {
    turnId: nonEmpty(record['turn_id']),
    cwd: nonEmpty(record['cwd']),
    model: nonEmpty(record['model']),
    effort: nonEmpty(record['effort']) ?? nonEmpty(settings?.['reasoning_effort']),
  };
}

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  /** null si la linea no lo trae: sin eso no se puede saber si hubo uso nuevo. */
  totalTokens: number | null;
}

export interface TokenInfo {
  last: TokenCounts;
  total: TokenCounts;
  /** `model_context_window` si es un numero positivo. */
  window: number | null;
}

function readCounts(value: unknown): TokenCounts {
  const record = asRecord(value);
  const total = finite(record?.['total_tokens']);
  return {
    inputTokens: tokenNumber(record?.['input_tokens']),
    cachedInputTokens: tokenNumber(record?.['cached_input_tokens']),
    outputTokens: tokenNumber(record?.['output_tokens']),
    totalTokens: total !== null && total >= 0 ? total : null,
  };
}

/** Un numero positivo, que es lo unico que vale como ventana. */
export function readWindow(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

/**
 * `event_msg/token_count.payload.info`. null si `info` no es un objeto: el
 * primero de cada archivo trae `info: null` (13 de 13) y no dice nada.
 */
export function readTokenInfo(payload: unknown): TokenInfo | null {
  const info = asRecord(asRecord(payload)?.['info']);
  if (info === null) return null;
  return {
    last: readCounts(info['last_token_usage']),
    total: readCounts(info['total_token_usage']),
    window: readWindow(info['model_context_window']),
  };
}

export interface UserMessage {
  /** `''` si no trae. */
  message: string;
}

/** `event_msg/user_message.payload`. */
export function readUserMessage(payload: unknown): UserMessage {
  const record = asRecord(payload);
  const message = record?.['message'];
  return { message: typeof message === 'string' ? message : '' };
}

/**
 * El mensaje del usuario de un `event_msg`, en los dos modos de historial, o
 * null si la linea no es uno.
 *
 *  - `legacy` (0.128): `user_message`, con el texto en `message`.
 *  - `paginated` (la TUI de la 0.154): `item_completed` con un `item` de tipo
 *    `UserMessage` y el texto en los bloques `text` de `content`. En ese modo
 *    `user_message` ya no se escribe: medido en las sesiones nuevas de la
 *    verificacion de cierre del hito 25, y asi lo dice `rollout/policy.rs`.
 *
 * Los dos existen solo para lo que mando la persona: los envoltorios del arnes
 * (`<environment_context>`, instrucciones) van unicamente como `response_item`.
 * Los demas `item_completed` (`AgentMessage`, que duplica al `response_item`,
 * y los de herramientas) no son un mensaje del usuario.
 */
export function readUserMessageEvent(payload: unknown): UserMessage | null {
  const record = asRecord(payload);
  if (record === null) return null;
  if (record['type'] === 'user_message') return readUserMessage(record);
  if (record['type'] !== 'item_completed') return null;
  const item = asRecord(record['item']);
  if (item === null || item['type'] !== 'UserMessage') return null;
  const texts: string[] = [];
  const content = item['content'];
  if (Array.isArray(content)) {
    for (const entry of content) {
      const block = asRecord(entry);
      if (block?.['type'] === 'text' && typeof block['text'] === 'string') texts.push(block['text']);
    }
  }
  return { message: texts.join('\n') };
}

/**
 * El tipo de cada imagen de un `message` de rol `user`, en orden.
 *
 * Codex guarda la imagen adjunta como `input_image` con `image_url`
 * `data:<mime>;base64,...`. Una que no sea `data:` (una URL) se cuenta igual,
 * como `image/png`: la posicion importa, porque es el `index` con el que se
 * pide despues, y la miniatura dira que no se pudo cargar.
 */
export function readUserContentImages(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  const types: string[] = [];
  for (const item of content) {
    const record = asRecord(item);
    if (record === null || record['type'] !== 'input_image') continue;
    const url = record['image_url'];
    const match = typeof url === 'string' ? /^data:([^;,]+);base64,/.exec(url) : null;
    types.push(match?.[1] ?? 'image/png');
  }
  return types;
}

/**
 * Quita del texto las etiquetas `[Image #N]` de las imagenes que si llegaron.
 *
 * Una etiqueta sin imagen se deja: la imagen no se pudo adjuntar y el texto es
 * lo unico que lo cuenta. Con cada etiqueta se va un espacio que la siga, que
 * es el que Codex inserta al adjuntar.
 */
export function stripImageLabels(message: string, imageCount: number): string {
  return message
    .replace(/\[Image #(\d+)\] ?/g, (label: string, digits: string) => {
      const n = Number(digits);
      return n >= 1 && n <= imageCount ? '' : label;
    })
    .trim();
}

export interface ToolOutput {
  text: string;
  truncated: boolean;
  isError: boolean;
  imageCount: number;
}

/** Texto e imagenes de una lista de items de contenido de una salida. */
function readOutputItems(items: readonly unknown[]): { text: string; imageCount: number } {
  const texts: string[] = [];
  let imageCount = 0;
  for (const item of items) {
    const record = asRecord(item);
    if (record === null) continue;
    const type = record['type'];
    if (type === 'input_image') {
      imageCount += 1;
    } else if (
      (type === 'input_text' || type === 'output_text' || type === 'text') &&
      typeof record['text'] === 'string'
    ) {
      texts.push(record['text']);
    }
  }
  return { text: texts.join('\n'), imageCount };
}

/**
 * El resultado de una herramienta, de `function_call_output` o
 * `custom_tool_call_output`.
 *
 * Medido: `output` es un string en 126 de 126. Un comando de consola empieza
 * con `Exit code: N`; `apply_patch` trae un JSON como texto con `output` y
 * `metadata.exit_code`. Las formas de array y de objeto con `content` son las
 * que la 0.154 declara para salidas con imagenes; no hay ninguna en disco.
 */
export function readToolOutput(output: unknown): ToolOutput {
  let text = '';
  let isError = false;
  let imageCount = 0;

  if (typeof output === 'string') {
    const parsed = output.startsWith('{') ? parseObject(output) : null;
    if (parsed !== null && typeof parsed['output'] === 'string') {
      text = parsed['output'];
      const exitCode = finite(asRecord(parsed['metadata'])?.['exit_code']);
      isError = exitCode !== null && exitCode !== 0;
    } else {
      text = output;
      const match = /^Exit code: (\d+)/.exec(output);
      isError = match !== null && Number(match[1]) !== 0;
    }
  } else if (Array.isArray(output)) {
    ({ text, imageCount } = readOutputItems(output));
  } else {
    const record = asRecord(output);
    const content = record?.['content'];
    if (record !== null && Array.isArray(content)) {
      ({ text, imageCount } = readOutputItems(content));
      isError = record['success'] === false;
    }
  }

  const limited = cut(text, TOOL_RESULT_MAX_CHARS);
  return { text: limited.text, truncated: limited.truncated, isError, imageCount };
}

function parseObject(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Un texto llevado a la forma con la que se compara lo mandado con lo escrito.
 *
 * Sin etiquetas `[Image #N]` —el cuadro no las escribe, las pone Codex—, con
 * los finales de linea unificados y los espacios colapsados: la TUI puede
 * haber tocado cualquiera de las tres cosas en el camino.
 *
 * Y sin `¿` ni `¡`: la TUI de la 0.154 en Windows los pierde, tecleados o
 * pegados, y el resto del texto llega intacto (`í`, `ñ` y `ú` si pasan; medido
 * en la verificacion de cierre del hito 25). Sin esto, toda pregunta en
 * castellano se casaba "sin confirmar".
 */
export function normalizeMessageText(text: string): string {
  return text
    .replace(/\[Image #\d+\]/g, '')
    .replace(/[¿¡]/g, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}
