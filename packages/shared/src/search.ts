/**
 * Buscar en todo (hito 29, D22): el texto de las conversaciones de la copia
 * propia, no solo los titulos de la barra.
 *
 * Se recorre la copia (hito 28) linea por linea y sin indice: un indice
 * invertido es otro archivo que mantener y que se desincroniza, y los
 * historiales nativos serian un lector por CLI —la base de OpenCode ni siquiera
 * deja recorrer `part`—. Solo texto de mensajes y el titulo; los resultados de
 * herramientas son megas de ruido.
 *
 * **Recorre todas las sesiones**: un buscador de historial que no mira todo el
 * historial no sirve. Medido al cerrar el hito, un tope de 1,5 s —el del
 * buscador de archivos, CLAUDE.md 6.14— cortaba una copia real de 327 sesiones
 * tras leer ~110–120: un texto que no existia no decia "sin resultados", y uno
 * que estaba en una sesion vieja no aparecia. Por eso los aciertos salen a
 * medida que se encuentran (`search.progress`) y el resultado final llega al
 * terminar (`search.results`). Queda el tope de 200 aciertos, y uno de
 * seguridad de 30 s que solo existe para no quedar colgado.
 */

import { SESSION_AGENT_IDS, type SessionAgentId } from './agents.js';
import { CONVERSATION_ROLES, type ConversationRole } from './conversation.js';
import type { SessionId } from './models.js';
import {
  asArrayFiltered,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
} from './validation.js';

/** Menos que esto, tras recortar, no busca nada: "de" aparece en todas. */
export const GLOBAL_SEARCH_MIN_CHARS = 3;
export const GLOBAL_SEARCH_MAX_RESULTS = 200;
/**
 * Tope de seguridad, no de costumbre: una copia real entera se recorre muy por
 * debajo. Si se alcanza, el resultado dice cuantas sesiones quedaron sin mirar.
 */
export const GLOBAL_SEARCH_SAFETY_MS = 30_000;
/** Cada cuanto, como mucho, sale un `search.progress`. */
export const GLOBAL_SEARCH_PROGRESS_MS = 250;
/** El largo del fragmento sin los `…`. */
export const GLOBAL_SEARCH_SNIPPET_CHARS = 160;
/** Lo que el parser deja pasar de la consulta. */
export const GLOBAL_SEARCH_MAX_QUERY_CHARS = 200;

export interface GlobalSearchHit {
  /**
   * La fuente de la sesion. `SessionAgentId` y no `AgentId`: la copia guarda
   * tambien lo importado (Gemini CLI, el rescate del IDE).
   */
  agent: SessionAgentId;
  sessionId: SessionId;
  /** La carpeta de la cabecera de la copia, o null si no se sabe. */
  cwd: string | null;
  title: string;
  /** null si el acierto es el titulo. */
  eventId: string | null;
  role: ConversationRole | null;
  at: number | null;
  /** Fragmento ya recortado, con `…` si se corto. Una sola linea. */
  snippet: string;
  /** Posicion del acierto dentro de `snippet`, en unidades UTF-16. */
  matchStart: number;
  matchLength: number;
}

export type GlobalSearchTruncation = 'results' | 'time';

export const GLOBAL_SEARCH_TRUNCATIONS: readonly GlobalSearchTruncation[] = ['results', 'time'];

export interface GlobalSearchResult {
  /** La consulta ya recortada. */
  query: string;
  hits: GlobalSearchHit[];
  /** Sesiones leidas enteras. */
  sessionsScanned: number;
  /** Sesiones que entraban en la busqueda (sin las archivadas, salvo que se pidan). */
  sessionsTotal: number;
  /**
   * Que tope corto la busqueda, o null si miro todo. `time` es el de seguridad:
   * quedaron `sessionsTotal - sessionsScanned` sesiones sin mirar.
   */
  truncated: GlobalSearchTruncation | null;
}

/**
 * Lo que va saliendo de una busqueda en curso. **`hits` son solo los nuevos**
 * desde el aviso anterior, en orden: el cliente los agrega a lo que tiene. El
 * resultado final (`GlobalSearchResult`) los trae todos y reemplaza lo
 * acumulado, asi que un aviso perdido no deja nada torcido al terminar.
 */
export interface GlobalSearchProgress {
  query: string;
  hits: GlobalSearchHit[];
  /** Sesiones leidas enteras hasta ahora. */
  sessionsScanned: number;
  sessionsTotal: number;
}

const MARKS = /\p{M}+/gu;

/** true si todas las unidades son ASCII. */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/**
 * Minusculas y sin diacriticos: "Migración" -> "migracion".
 *
 * Caracter por caracter (NFD sin `\p{M}`, despues minusculas), para saber de
 * donde salio cada unidad: `map[i]` es la posicion en `text` del caracter que
 * produjo `folded[i]`. Una marca suelta no produce nada, y un caracter puede
 * producir mas de una unidad.
 */
export function foldForSearch(text: string): { folded: string; map: number[] } {
  const map: number[] = [];
  let folded = '';
  let index = 0;
  for (const char of text) {
    const out = char.normalize('NFD').replace(MARKS, '').toLowerCase();
    for (let unit = 0; unit < out.length; unit += 1) map.push(index);
    folded += out;
    index += char.length;
  }
  return { folded, map };
}

/** La consulta como se compara: recortada y plegada. */
export function foldQuery(query: string): string {
  return foldForSearch(query.trim()).folded;
}

/**
 * La primera aparicion de `needle` (ya plegada) en `text`, en posiciones de
 * `text`, o null.
 *
 * El final se extiende sobre las marcas que siguen: en un texto escrito en NFD
 * ("o" + tilde suelta), el acierto se lleva su tilde. Un texto solo ASCII no se
 * pliega caracter por caracter: es casi todo lo que hay, y alcanza con
 * minusculas.
 */
export function findFolded(text: string, needle: string): { start: number; end: number } | null {
  if (needle.length === 0) return null;
  if (isAscii(text)) {
    const at = text.toLowerCase().indexOf(needle);
    return at === -1 ? null : { start: at, end: at + needle.length };
  }
  const { folded, map } = foldForSearch(text);
  const at = folded.indexOf(needle);
  if (at === -1) return null;
  const start = map[at] ?? 0;
  const lastSource = map[at + needle.length - 1] ?? start;
  const lastCode = text.codePointAt(lastSource) ?? 0;
  let end = lastSource + (lastCode > 0xffff ? 2 : 1);
  while (end < text.length) {
    const char = String.fromCodePoint(text.codePointAt(end) ?? 0);
    if (char.replace(MARKS, '').length > 0) break;
    end += char.length;
  }
  return { start, end };
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Un campo que admite null: ausente o null es null; presente e invalido, `undefined`. */
function nullable<T>(value: unknown, parse: (value: unknown) => T | null): T | null | undefined {
  if (value === null || value === undefined) return null;
  const parsed = parse(value);
  return parsed === null ? undefined : parsed;
}

function parseGlobalSearchHit(value: unknown): GlobalSearchHit | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], SESSION_AGENT_IDS);
  const sessionId = asNonEmptyString(record['sessionId']);
  const cwd = nullable(record['cwd'], asString);
  const title = asString(record['title']);
  const eventId = nullable(record['eventId'], asNonEmptyString);
  const role = nullable(record['role'], (raw) => asLiteral(raw, CONVERSATION_ROLES));
  const at = nullable(record['at'], asFiniteNumber);
  const snippet = asString(record['snippet']);
  const matchStart = asCount(record['matchStart']);
  const matchLength = asCount(record['matchLength']);
  if (
    agent === null ||
    sessionId === null ||
    cwd === undefined ||
    title === null ||
    eventId === undefined ||
    role === undefined ||
    at === undefined ||
    snippet === null ||
    matchStart === null ||
    matchLength === null ||
    // Un acierto que se sale del fragmento resaltaria otra cosa.
    matchStart + matchLength > snippet.length
  ) {
    return null;
  }
  return { agent, sessionId, cwd, title, eventId, role, at, snippet, matchStart, matchLength };
}

/**
 * El resultado, o null.
 *
 * Un acierto que no parsea —una fuente que este cliente no conoce— se descarta
 * solo, sin llevarse a los demas. Lo demas es todo o nada.
 */
export function parseGlobalSearchResult(value: unknown): GlobalSearchResult | null {
  const record = asRecord(value);
  if (record === null) return null;
  const query = asString(record['query']);
  const hits = asArrayFiltered(record['hits'], parseGlobalSearchHit);
  const sessionsScanned = asCount(record['sessionsScanned']);
  const sessionsTotal = asCount(record['sessionsTotal']);
  const truncated = nullable(record['truncated'], (raw) => asLiteral(raw, GLOBAL_SEARCH_TRUNCATIONS));
  if (
    query === null ||
    hits === null ||
    sessionsScanned === null ||
    sessionsTotal === null ||
    sessionsScanned > sessionsTotal ||
    truncated === undefined
  ) {
    return null;
  }
  return { query, hits, sessionsScanned, sessionsTotal, truncated };
}

/** Un aviso de progreso, o null. Mismas reglas que el resultado, sin `truncated`. */
export function parseGlobalSearchProgress(value: unknown): GlobalSearchProgress | null {
  const record = asRecord(value);
  if (record === null) return null;
  const query = asString(record['query']);
  const hits = asArrayFiltered(record['hits'], parseGlobalSearchHit);
  const sessionsScanned = asCount(record['sessionsScanned']);
  const sessionsTotal = asCount(record['sessionsTotal']);
  if (query === null || hits === null || sessionsScanned === null || sessionsTotal === null || sessionsScanned > sessionsTotal) {
    return null;
  }
  return { query, hits, sessionsScanned, sessionsTotal };
}
