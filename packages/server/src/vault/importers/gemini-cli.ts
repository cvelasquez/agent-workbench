/**
 * Importador de un solo uso: los chats de Gemini CLI (hito 28, §9.3).
 *
 * Gemini CLI no tiene adaptador y no lo va a tener: lo que queda en la
 * instalacion son chats huerfanos, `~/.gemini/tmp/<hash>/chats/session-*.json`,
 * que ninguna CLI instalada lista. Este modulo los convierte **una vez** en
 * sesiones de la copia propia, bajo el id importado `gemini-cli`. No vigila, no
 * lanza nada y no vuelve a correr solo: lo corre `pnpm vault:import`.
 *
 * Lo que se lee, y nada mas (CLAUDE.md 2.1):
 *
 *  - de `~/.gemini/tmp/`, los nombres de carpeta;
 *  - de `~/.gemini/tmp/<carpeta>/chats/`, los nombres, y los `session-*.json`
 *    enteros, hasta 16 MB cada uno.
 *
 * Nada mas de `~/.gemini`: ni los `*.jsonl` del demonio, ni `logs.json`, ni
 * `.project_root`, ni las credenciales. Todo pasa por `resolveInside`: una
 * carpeta que es un enlace hacia afuera no se recorre.
 *
 * **La carpeta del chat no se adivina.** El JSON trae `projectHash`, que es el
 * sha256 de la carpeta donde corrio la CLI, y no la carpeta. Medido: 0 de 6
 * casan con las carpetas que la app conoce (C17). Por eso solo se prueban las
 * que nombra el usuario con `--cwd`, tal cual y con la unidad en minuscula y en
 * mayuscula (la misma carpeta llega con las dos segun desde donde se abrio la
 * terminal). Un chat sin carpeta casada va al grupo "carpeta desconocida".
 *
 * El mapeo, mensaje por mensaje:
 *
 *  - `user`: un evento del usuario con su texto, sin recortar (D4).
 *  - `gemini`: un evento del asistente con el texto si no esta vacio, y cada
 *    llamada de herramienta con su resultado **en el mismo evento**, como
 *    OpenCode. El resultado se recorta al tope de la copia.
 *  - `thoughts` e `info`: nada. El razonamiento sigue la regla de CLAUDE.md 4.9
 *    aunque aca venga con texto, y un aviso de la CLI no es conversacion.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  EMPTY_CONTEXT_USAGE,
  IMPORTED_AGENT_LABELS,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asString,
  isVaultSessionId,
  type ContextUsage,
  type ConversationEvent,
  type ConversationPart,
  type MessageUsage,
  type SessionTitleSource,
} from '@agent-workbench/shared';
import { toTitle, UNTITLED_SESSION_TITLE } from '../../agents/session-title.js';
import { cut } from '../../agents/transport-limits.js';
import { InvalidPathError, resolveInside } from '../../path-guard.js';
import { VAULT_TOOL_RESULT_DEFAULT_CHARS } from '../../settings-store.js';
import { serializeSession, type SerializedSession } from '../serialize.js';

/** Tope de un `session-*.json`. Medido: los 6 de la instalacion suman 474 KB; 16 MB es margen de sobra. */
export const GEMINI_CHAT_MAX_BYTES = 16 * 1024 * 1024;

/** El grupo de la barra para los chats cuya carpeta no se sabe. */
export const GEMINI_UNKNOWN_GROUP = `${IMPORTED_AGENT_LABELS['gemini-cli']} · carpeta desconocida`;

const CHAT_FILE_PATTERN = /^session-.+\.json$/;
const PROJECT_HASH_PATTERN = /^[0-9a-f]{64}$/i;

export interface GeminiImportOptions {
  /** `~/.gemini`. El chequeo pasa otra. */
  geminiHome: string;
  /** Las carpetas que nombro el usuario con `--cwd`, absolutas. */
  cwdCandidates: readonly string[];
  /** Tope de un resultado de herramienta. Ausente: el de la copia por defecto. */
  toolResultMaxChars?: number;
  /** Tope de un archivo. Ausente: `GEMINI_CHAT_MAX_BYTES`. */
  maxFileBytes?: number;
}

/** Por que un chat no se importa. */
export type GeminiSkipReason = 'only-notices' | 'too-large' | 'unreadable' | 'invalid-session-id' | 'duplicate';

export const GEMINI_SKIP_TEXT: Readonly<Record<GeminiSkipReason, string>> = {
  'only-notices': 'only notices, no message from the user',
  'too-large': `over ${GEMINI_CHAT_MAX_BYTES / 1024 / 1024} MB`,
  unreadable: 'not a readable chat (invalid JSON or not the expected shape)',
  'invalid-session-id': 'no sessionId that can be saved',
  duplicate: 'the same sessionId in another, newer file',
};

export interface GeminiImportedChat {
  sessionId: string;
  /** `''` si ningun `--cwd` casa con `projectHash`. */
  cwd: string;
  title: string;
  titleSource: SessionTitleSource;
  createdAt: number | null;
  updatedAt: number;
  events: ConversationEvent[];
  usage: ContextUsage | null;
}

export interface GeminiImportPlan {
  /** `session-*.json` encontrados. */
  found: number;
  chats: GeminiImportedChat[];
  /** Cuantos con carpeta casada. */
  matchedCwd: number;
  skipped: Partial<Record<GeminiSkipReason, number>>;
}

/** El chat ya mapeado, o el motivo por el que no se importa. Pura. */
export type GeminiChatMapping = { kind: 'chat'; chat: GeminiImportedChat } | { kind: 'skip'; reason: GeminiSkipReason };

/**
 * Las formas de una carpeta con las que Gemini CLI pudo haber calculado el
 * hash: tal cual, y con la letra de unidad en minuscula y en mayuscula. Nada
 * mas (C17).
 */
export function cwdHashVariants(cwd: string): string[] {
  const variants = [cwd];
  if (/^[A-Za-z]:/.test(cwd)) {
    variants.push(`${cwd.charAt(0).toLowerCase()}${cwd.slice(1)}`, `${cwd.charAt(0).toUpperCase()}${cwd.slice(1)}`);
  }
  return [...new Set(variants)];
}

/** La primera carpeta candidata cuyo sha256 es `projectHash`, tal como la dio el usuario. `''` si ninguna. */
export function matchProjectHash(projectHash: string, candidates: readonly string[]): string {
  if (!PROJECT_HASH_PATTERN.test(projectHash)) return '';
  const wanted = projectHash.toLowerCase();
  for (const candidate of candidates) {
    for (const variant of cwdHashVariants(candidate)) {
      if (createHash('sha256').update(variant).digest('hex') === wanted) return candidate;
    }
  }
  return '';
}

/** Epoch ms de un ISO, o null si no es una fecha. */
function parseIso(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** El texto de un `content`: string (medido, 63 de 63), o un array de `{text}` por si otra version lo cambia. */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map((item) => asString(asRecord(item)?.['text']) ?? '')
    .filter((text) => text.length > 0)
    .join('\n');
}

function nonNegative(value: unknown): number {
  const number = asFiniteNumber(value);
  return number === null || number < 0 ? 0 : number;
}

/** `tokens` de Gemini CLI con los nombres de la app. `input` **incluye** lo cacheado (medido, 41 de 41). */
function messageUsageOf(value: unknown): { usage: MessageUsage; input: number } | null {
  const tokens = asRecord(value);
  if (tokens === null || asFiniteNumber(tokens['input']) === null || asFiniteNumber(tokens['output']) === null) return null;
  const input = nonNegative(tokens['input']);
  const cached = Math.min(nonNegative(tokens['cached']), input);
  return {
    input,
    usage: {
      inputTokens: Math.max(0, input - cached),
      outputTokens: nonNegative(tokens['output']),
      cacheReadInputTokens: cached,
      cacheCreationInputTokens: 0,
    },
  };
}

/** El texto de un resultado: las salidas y los `text` del array, o `resultDisplay` si no hay ninguno. */
function toolResultText(call: Record<string, unknown>): string {
  const texts: string[] = [];
  const result = call['result'];
  if (Array.isArray(result)) {
    for (const item of result) {
      const record = asRecord(item);
      if (record === null) continue;
      const output = asRecord(asRecord(record['functionResponse'])?.['response'])?.['output'];
      if (typeof output === 'string') texts.push(output);
      if (typeof record['text'] === 'string') texts.push(record['text']);
    }
  }
  if (texts.length > 0) return texts.join('\n');
  return asString(call['resultDisplay']) ?? '';
}

function stringifyArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}, null, 2) ?? '{}';
  } catch {
    return '{}';
  }
}

/**
 * Un chat leido de disco, convertido. Pura: la prueba el chequeo.
 *
 * `fileMtimeMs` es el respaldo de `updatedAt` cuando ni `lastUpdated` ni los
 * mensajes traen fecha.
 */
export function mapGeminiChat(
  raw: unknown,
  options: { cwdCandidates: readonly string[]; toolResultMaxChars: number; fileMtimeMs: number },
): GeminiChatMapping {
  const record = asRecord(raw);
  if (record === null || !Array.isArray(record['messages'])) return { kind: 'skip', reason: 'unreadable' };
  const sessionId = asNonEmptyString(record['sessionId']);
  if (sessionId === null || !isVaultSessionId(sessionId)) return { kind: 'skip', reason: 'invalid-session-id' };

  const events: ConversationEvent[] = [];
  let firstUserText: string | null = null;
  let last: { input: number; output: number; model: string | null } | null = null;
  const totals = { input: 0, output: 0, cached: 0, messages: 0 };

  for (const [position, item] of record['messages'].entries()) {
    const message = asRecord(item);
    if (message === null) continue;
    const type = message['type'];
    const eventId = asNonEmptyString(message['id']) ?? `${sessionId}:${position}`;
    const at = parseIso(message['timestamp']) ?? 0;

    if (type === 'user') {
      const text = contentText(message['content']);
      if (text.trim().length === 0) continue;
      firstUserText ??= text;
      events.push({
        eventId, role: 'user', at, parts: [{ kind: 'text', text, truncated: false }],
        model: null, usage: null, effort: null, durationMs: null, queued: false,
      });
      continue;
    }
    if (type !== 'gemini') continue;

    const parts: ConversationPart[] = [];
    const text = contentText(message['content']);
    if (text.trim().length > 0) parts.push({ kind: 'text', text, truncated: false });

    const calls: unknown[] = Array.isArray(message['toolCalls']) ? message['toolCalls'] : [];
    for (const [callPosition, rawCall] of calls.entries()) {
      const call = asRecord(rawCall);
      if (call === null) continue;
      const toolUseId = asNonEmptyString(call['id']) ?? `${eventId}:tool:${callPosition}`;
      const name = asNonEmptyString(call['name']) ?? asNonEmptyString(call['displayName']) ?? '';
      parts.push({ kind: 'tool-call', toolUseId, name, input: stringifyArgs(call['args']), truncated: false });
      const result = cut(toolResultText(call), options.toolResultMaxChars);
      parts.push({
        kind: 'tool-result', toolUseId, text: result.text, isError: call['status'] !== 'success',
        truncated: result.truncated, imageCount: 0,
      });
    }

    const model = asNonEmptyString(message['model']);
    const tokens = messageUsageOf(message['tokens']);
    if (tokens !== null) {
      last = { input: tokens.input, output: tokens.usage.outputTokens, model };
      totals.input += tokens.usage.inputTokens;
      totals.output += tokens.usage.outputTokens;
      totals.cached += tokens.usage.cacheReadInputTokens;
      totals.messages += 1;
    }
    // Un paso sin texto ni herramientas no tiene nada que mostrar; sus tokens igual cuentan.
    if (parts.length === 0) continue;
    events.push({
      eventId, role: 'assistant', at, parts, model, usage: tokens?.usage ?? null,
      effort: null, durationMs: null, queued: false,
    });
  }

  if (firstUserText === null) return { kind: 'skip', reason: 'only-notices' };

  const title = toTitle(firstUserText);
  const eventTimes = events.map((event) => event.at).filter((value) => value > 0);
  const updatedAt = parseIso(record['lastUpdated'])
    ?? (eventTimes.length > 0 ? Math.max(...eventTimes) : Math.max(0, Math.floor(options.fileMtimeMs)));
  const createdAt = parseIso(record['startTime']) ?? (eventTimes.length > 0 ? Math.min(...eventTimes) : null);

  const usage: ContextUsage | null = last === null
    ? null
    : {
      ...EMPTY_CONTEXT_USAGE,
      lastRequestTokens: last.input,
      lastOutputTokens: last.output,
      lastModel: last.model,
      contextWindow: null,
      contextWindowEstimated: false,
      totalInputTokens: totals.input,
      totalOutputTokens: totals.output,
      totalCacheReadTokens: totals.cached,
      assistantMessages: totals.messages,
    };

  return {
    kind: 'chat',
    chat: {
      sessionId,
      cwd: matchProjectHash(asString(record['projectHash']) ?? '', options.cwdCandidates),
      title: title.length > 0 ? title : UNTITLED_SESSION_TITLE,
      titleSource: title.length > 0 ? 'first-message' : 'none',
      createdAt,
      updatedAt,
      events,
      usage,
    },
  };
}

/** Las carpetas de `dir` que son carpetas de verdad (un enlace no cuenta). [] si no se puede leer. */
async function directoriesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** `root/relative` si existe y no se sale de `root`, o null. */
async function inside(root: string, relative: string): Promise<string | null> {
  try {
    return await resolveInside(root, relative, { mustExist: true });
  } catch (error) {
    if (error instanceof InvalidPathError) return null;
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Recorre `~/.gemini/tmp/*\/chats/session-*.json` y arma lo que se importaria.
 * No escribe nada.
 */
export async function planGeminiCliImport(options: GeminiImportOptions): Promise<GeminiImportPlan> {
  const toolResultMaxChars = options.toolResultMaxChars ?? VAULT_TOOL_RESULT_DEFAULT_CHARS;
  const maxFileBytes = options.maxFileBytes ?? GEMINI_CHAT_MAX_BYTES;
  const plan: GeminiImportPlan = { found: 0, chats: [], matchedCwd: 0, skipped: {} };
  const skip = (reason: GeminiSkipReason): void => {
    plan.skipped[reason] = (plan.skipped[reason] ?? 0) + 1;
  };

  const tmp = await inside(options.geminiHome, 'tmp');
  if (tmp === null) return plan;

  const bySession = new Map<string, GeminiImportedChat>();
  for (const folder of await directoriesIn(tmp)) {
    const chats = await inside(tmp, path.join(folder, 'chats'));
    if (chats === null) continue;
    let names: string[];
    try {
      const entries = await readdir(chats, { withFileTypes: true });
      names = entries.filter((entry) => entry.isFile() && CHAT_FILE_PATTERN.test(entry.name)).map((entry) => entry.name).sort();
    } catch {
      continue;
    }

    for (const name of names) {
      plan.found += 1;
      const file = await inside(chats, name);
      if (file === null) {
        skip('unreadable');
        continue;
      }
      let mapping: GeminiChatMapping;
      try {
        const info = await stat(file);
        if (!info.isFile()) {
          skip('unreadable');
          continue;
        }
        if (info.size > maxFileBytes) {
          skip('too-large');
          continue;
        }
        mapping = mapGeminiChat(JSON.parse(await readFile(file, 'utf8')), {
          cwdCandidates: options.cwdCandidates,
          toolResultMaxChars,
          fileMtimeMs: info.mtimeMs,
        });
      } catch {
        skip('unreadable');
        continue;
      }
      if (mapping.kind === 'skip') {
        skip(mapping.reason);
        continue;
      }
      // El mismo id dos veces: gana el mas nuevo. Escribir los dos seria pisar uno con el otro en orden de recorrido.
      const known = bySession.get(mapping.chat.sessionId);
      if (known !== undefined) {
        skip('duplicate');
        if (known.updatedAt >= mapping.chat.updatedAt) continue;
      }
      bySession.set(mapping.chat.sessionId, mapping.chat);
    }
  }

  plan.chats = [...bySession.values()].sort((a, b) => a.updatedAt - b.updatedAt || (a.sessionId < b.sessionId ? -1 : 1));
  plan.matchedCwd = plan.chats.filter((chat) => chat.cwd.length > 0).length;
  return plan;
}

/** Las sesiones de la copia que escribiria la importacion. Puro. */
export function geminiSessionFiles(plan: GeminiImportPlan, now: number): SerializedSession[] {
  return plan.chats.map((chat) =>
    serializeSession({
      header: {
        agent: 'gemini-cli',
        sessionId: chat.sessionId,
        cwd: chat.cwd,
        group: chat.cwd.length > 0 ? null : GEMINI_UNKNOWN_GROUP,
        title: chat.title,
        titleSource: chat.titleSource,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        cliVersionAtCopy: null,
        partial: false,
        stepCount: null,
        usage: chat.usage,
        source: { kind: 'import', importer: 'gemini-cli-chats', importedAt: now },
        writtenAt: now,
      },
      events: chat.events,
    }),
  );
}
