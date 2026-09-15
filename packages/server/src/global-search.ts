/**
 * Buscar en todo (hito 29, §7): el texto de las conversaciones de la copia
 * propia.
 *
 * Generico y sin disco: que sesiones hay y como se leen sus lineas lo inyecta
 * quien llama (`VaultService.search`, que lo arma con el catalogo). Asi el
 * chequeo prueba los topes, el orden y la cancelacion con lectores de mentira,
 * y el catalogo sigue siendo lo unico que arma rutas de la copia: una sesion se
 * lee por `(agent, sessionId)`, nunca por una ruta.
 *
 * Reglas, cada una por lo que rompe la contraria:
 *
 *  - **Menos de 3 caracteres no lee nada.** "de" esta en todas las sesiones:
 *    serian 200 aciertos inutiles y el disco entero para encontrarlos.
 *  - **Un acierto por evento**, el primero de sus partes `text`. Un mensaje que
 *    repite la palabra diez veces son diez fragmentos casi iguales, y el tope de
 *    200 se lo comeria una sola sesion.
 *  - **Una linea de mas de 1 MB, o que no decodifica, se salta** sin llevarse la
 *    sesion: la copia guarda textos enteros (hito 28, D4), y una linea rota es
 *    una linea, no el archivo.
 *  - **Se recorren todas las sesiones**, sin tope de tiempo de costumbre. Con el
 *    de 1,5 s que tenia al principio, una copia real de 327 sesiones se cortaba
 *    tras leer ~110–120 (medido al cerrar el hito 29): lo que no estaba no decia
 *    "sin resultados" y lo viejo no se encontraba. Queda uno de seguridad, de
 *    30 s, para no quedar colgado; si se alcanza, el resultado dice cuantas
 *    quedaron sin mirar.
 *  - **Cede el hilo al empezar cada sesion**, y a mitad de una larga cada
 *    `GLOBAL_SEARCH_YIELD_MS`: una busqueda de varios segundos no puede frenar
 *    las terminales ni los demas pedidos del servidor, y es lo que deja que una
 *    busqueda nueva o `search.cancel` corten la vieja a tiempo.
 *  - **Los aciertos salen a medida que se encuentran** (`onProgress`, como
 *    mucho cada `GLOBAL_SEARCH_PROGRESS_MS`, con los nuevos y el avance). El
 *    resultado final los trae todos.
 *  - **El reloj se mira al empezar cada sesion y cada 200 lineas**, no en cada
 *    una: `now()` en cada linea cuesta mas que lo que protege. Esa sola lectura
 *    decide el tope de seguridad, el aviso de progreso y la cesion.
 *  - **Una linea solo ASCII que no contiene la consulta no se decodifica**
 *    (`lineMayMatch`). El `JSON.parse` es casi todo el costo, y las lineas mas
 *    pesadas —resultados de comandos, codigo— son ASCII. No pierde aciertos:
 *    JSON no escapa letras, digitos ni signos comunes, asi que el texto de una
 *    parte esta tal cual en la linea. Con tildes, comillas o barras en la
 *    consulta, o una linea con algo fuera de ASCII, se decodifica siempre.
 *  - **Una sesion que no se puede leer se salta**; una lista de sesiones que no
 *    se puede armar es un error de la busqueda entera.
 */

import {
  GLOBAL_SEARCH_MAX_RESULTS,
  GLOBAL_SEARCH_MIN_CHARS,
  GLOBAL_SEARCH_PROGRESS_MS,
  GLOBAL_SEARCH_SAFETY_MS,
  GLOBAL_SEARCH_SNIPPET_CHARS,
  findFolded,
  foldQuery,
  parseVaultBodyLine,
  type ConversationEvent,
  type GlobalSearchHit,
  type GlobalSearchProgress,
  type GlobalSearchResult,
  type GlobalSearchTruncation,
  type SessionAgentId,
} from '@agent-workbench/shared';
import { parseJsonlLine } from './jsonl-reader.js';

/** Una linea mas larga que esto no se decodifica. */
export const GLOBAL_SEARCH_LINE_MAX_CHARS = 1_000_000;
/** Cada cuantas lineas se mira el reloj. */
export const GLOBAL_SEARCH_CLOCK_EVERY_LINES = 200;
/** A mitad de una sesion, se cede el hilo si paso esto desde la ultima vez. */
export const GLOBAL_SEARCH_YIELD_MS = 20;

/** Cede el hilo: deja correr lo que espera en la cola de eventos (E/S, timers, otros mensajes). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Una sesion donde buscar. La da la copia propia. */
export interface SearchableSession {
  agent: SessionAgentId;
  sessionId: string;
  /** `''` si la copia no sabe la carpeta. */
  cwd: string;
  title: string;
  updatedAt: number;
  archived: boolean;
}

export interface GlobalSearchDeps {
  sessions: () => readonly SearchableSession[] | Promise<readonly SearchableSession[]>;
  /**
   * Las lineas del cuerpo de una sesion, sin la cabecera. Dejar de recorrerlas
   * tiene que cerrar lo que se abrio: la busqueda corta a mitad de archivo.
   */
  readLines: (session: SearchableSession, signal: AbortSignal) => AsyncIterable<string>;
  /** Una linea a evento, o null para saltarla. Por defecto, la de la copia. */
  decode?: (line: string) => ConversationEvent | null;
  now?: () => number;
  /** Como se cede el hilo. Por defecto, `yieldToEventLoop`. */
  yieldToLoop?: () => Promise<void>;
}

export interface GlobalSearchOptions {
  includeArchived: boolean;
  signal: AbortSignal;
  /**
   * Los aciertos nuevos y el avance, a medida que salen: uno enseguida con el
   * total, y despues como mucho cada `GLOBAL_SEARCH_PROGRESS_MS` si hay algo
   * nuevo. No se llama despues de cancelar ni con el resultado final.
   */
  onProgress?: (progress: GlobalSearchProgress) => void;
}

/** La busqueda se cancelo: otra la reemplazo, o se cerro el socket. No es un fallo. */
export class GlobalSearchAbortedError extends Error {
  constructor() {
    super('Búsqueda cancelada.');
    this.name = 'GlobalSearchAbortedError';
  }
}

/** Una linea de la copia a evento: el mismo parser que abrir o exportar (P2). */
export function decodeVaultEvent(line: string): ConversationEvent | null {
  const body = parseVaultBodyLine(parseJsonlLine(line));
  return body?.kind === 'event' ? body.event : null;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * El fragmento de `text` alrededor de `[start, end)`: `size` unidades
 * centradas en el acierto, con `…` del lado que se corto, sin partir un par
 * sustituto y en una sola linea (los saltos y tabuladores pasan a espacio, que
 * ocupa lo mismo y no mueve el acierto). Un acierto mas largo que `size` sale
 * entero.
 */
export function makeSnippet(
  text: string,
  start: number,
  end: number,
  size = GLOBAL_SEARCH_SNIPPET_CHARS,
): { snippet: string; matchStart: number; matchLength: number } {
  const matchLength = end - start;
  const room = Math.max(0, size - matchLength);
  let from = start - Math.floor(room / 2);
  let to = end + (room - Math.floor(room / 2));
  if (from < 0) {
    to = Math.min(text.length, to - from);
    from = 0;
  }
  if (to > text.length) {
    from = Math.max(0, from - (to - text.length));
    to = text.length;
  }
  // `start` y `end` caen entre caracteres, asi que correr los bordes hacia
  // adentro nunca pisa el acierto.
  if (from > 0 && from < start && isLowSurrogate(text.charCodeAt(from))) from += 1;
  if (to < text.length && to > end && isHighSurrogate(text.charCodeAt(to - 1))) to -= 1;

  const lead = from > 0 ? '…' : '';
  const tail = to < text.length ? '…' : '';
  const body = text.slice(from, to).replace(/[\r\n\t]/g, ' ');
  return { snippet: `${lead}${body}${tail}`, matchStart: lead.length + (start - from), matchLength };
}

/** true si todas las unidades son ASCII. */
function isAscii(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

/**
 * true si la consulta plegada sale tal cual en una linea JSON que la contenga:
 * ASCII imprimible sin `"` ni `\`, que son lo unico que JSON escapa ahi.
 */
export function prefilterable(needle: string): boolean {
  for (let index = 0; index < needle.length; index += 1) {
    const code = needle.charCodeAt(index);
    if (code < 0x20 || code > 0x7e || code === 0x22 || code === 0x5c) return false;
  }
  return needle.length > 0;
}

/**
 * false solo si la linea seguro no tiene la consulta en ningun texto. Una linea
 * con algo fuera de ASCII puede tener "Migración" para "migracion": se decodifica.
 */
export function lineMayMatch(line: string, needle: string, usePrefilter: boolean): boolean {
  // Un `\u` es un caracter escrito como escape (otro escritor de JSON): "Migración" es ASCII y tiene tilde.
  if (!usePrefilter || !isAscii(line) || line.includes('\\u')) return true;
  return line.toLowerCase().includes(needle);
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new GlobalSearchAbortedError();
}

/**
 * Busca `query` en todas las sesiones. Rechaza con `GlobalSearchAbortedError`
 * si la cancelan, y con el error de `sessions()` si no hay lista; nada mas.
 */
export async function runGlobalSearch(
  deps: GlobalSearchDeps,
  rawQuery: string,
  options: GlobalSearchOptions,
): Promise<GlobalSearchResult> {
  const query = rawQuery.trim();
  const needle = foldQuery(query);
  const empty: GlobalSearchResult = { query, hits: [], sessionsScanned: 0, sessionsTotal: 0, truncated: null };
  if ([...query].length < GLOBAL_SEARCH_MIN_CHARS || needle.length === 0) return empty;

  const { signal, onProgress } = options;
  throwIfAborted(signal);
  const now = deps.now ?? Date.now;
  const yieldToLoop = deps.yieldToLoop ?? yieldToEventLoop;
  const decode = deps.decode ?? decodeVaultEvent;
  const usePrefilter = prefilterable(needle);
  const startedAt = now();
  const deadline = startedAt + GLOBAL_SEARCH_SAFETY_MS;

  // Estable: a igual fecha queda el orden de la lista, que el catalogo da fijo.
  const sessions = (await deps.sessions())
    .filter((session) => options.includeArchived || !session.archived)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  throwIfAborted(signal);

  const hits: GlobalSearchHit[] = [];
  let truncated: GlobalSearchTruncation | null = null;
  let scanned = 0;
  let lines = 0;

  let reportedHits = 0;
  let reportedScanned = 0;
  let lastReportAt = startedAt;
  let lastYieldAt = startedAt;
  const report = (): void => {
    if (onProgress === undefined || signal.aborted) return;
    const fresh = hits.slice(reportedHits);
    reportedHits = hits.length;
    reportedScanned = scanned;
    try {
      onProgress({ query, hits: fresh, sessionsScanned: scanned, sessionsTotal: sessions.length });
    } catch {
      // Quien escucha el avance no puede cortar la busqueda.
    }
  };
  // Enseguida, con el total: "0 de 327" ya dice que se esta mirando todo.
  report();

  /**
   * Una parada: el reloj se lee una sola vez y decide las tres cosas. true si se
   * alcanzo el tope de seguridad. Rechaza si la busqueda se cancelo mientras
   * cedia el hilo.
   */
  const checkpoint = async (sessionStart: boolean): Promise<boolean> => {
    const at = now();
    if (at > deadline) return true;
    if (at - lastReportAt >= GLOBAL_SEARCH_PROGRESS_MS && (hits.length > reportedHits || scanned > reportedScanned)) {
      lastReportAt = at;
      report();
    }
    if (sessionStart || at - lastYieldAt >= GLOBAL_SEARCH_YIELD_MS) {
      lastYieldAt = at;
      await yieldToLoop();
      throwIfAborted(signal);
    }
    return false;
  };

  /** false si ya no entra: el acierto numero 201 es el que dice que hay mas. */
  const add = (session: SearchableSession, event: ConversationEvent | null, text: string, found: { start: number; end: number }): boolean => {
    if (hits.length >= GLOBAL_SEARCH_MAX_RESULTS) {
      truncated = 'results';
      return false;
    }
    hits.push({
      agent: session.agent,
      sessionId: session.sessionId,
      cwd: session.cwd.length > 0 ? session.cwd : null,
      title: session.title,
      eventId: event?.eventId ?? null,
      role: event?.role ?? null,
      at: event !== null && event.at > 0 ? event.at : null,
      ...makeSnippet(text, found.start, found.end),
    });
    return true;
  };

  sessionLoop: for (const session of sessions) {
    throwIfAborted(signal);
    if (await checkpoint(true)) {
      truncated = 'time';
      break;
    }

    const inTitle = findFolded(session.title, needle);
    if (inTitle !== null && !add(session, null, session.title, inTitle)) break;

    try {
      for await (const line of deps.readLines(session, signal)) {
        throwIfAborted(signal);
        lines += 1;
        if (lines % GLOBAL_SEARCH_CLOCK_EVERY_LINES === 0 && (await checkpoint(false))) {
          truncated = 'time';
          break sessionLoop;
        }
        if (line.length > GLOBAL_SEARCH_LINE_MAX_CHARS) continue;
        if (!lineMayMatch(line, needle, usePrefilter)) continue;
        const event = decode(line);
        if (event === null) continue;
        for (const part of event.parts) {
          if (part.kind !== 'text') continue;
          const found = findFolded(part.text, needle);
          if (found === null) continue;
          if (!add(session, event, part.text, found)) break sessionLoop;
          break;
        }
      }
    } catch (error) {
      if (error instanceof GlobalSearchAbortedError || signal.aborted) throw new GlobalSearchAbortedError();
      // Un archivo que se borro o no se pudo leer: se salta, y cuenta como mirado.
    }
    scanned += 1;
  }

  return { query, hits, sessionsScanned: scanned, sessionsTotal: sessions.length, truncated };
}

/**
 * La busqueda en curso de un socket: una nueva cancela la anterior, y cerrar el
 * socket o `search.cancel` cancelan la que quede. La cancelada resuelve null y
 * no contesta nada.
 */
export class GlobalSearchSlot {
  private current: { id: string | null; controller: AbortController } | null = null;

  async run(
    search: (signal: AbortSignal) => Promise<GlobalSearchResult>,
    id: string | null = null,
  ): Promise<GlobalSearchResult | null> {
    this.current?.controller.abort();
    const controller = new AbortController();
    const entry = { id, controller };
    this.current = entry;
    try {
      const result = await search(controller.signal);
      return controller.signal.aborted ? null : result;
    } catch (error) {
      if (controller.signal.aborted || error instanceof GlobalSearchAbortedError) return null;
      throw error;
    } finally {
      if (this.current === entry) this.current = null;
    }
  }

  /**
   * Sin id, la que corra (se cerro el socket). Con id, solo si la que corre es
   * esa: el pedido tardio de cortar una vieja no corta la nueva. true si corto
   * algo.
   */
  cancel(id?: string): boolean {
    const current = this.current;
    if (current === null || (id !== undefined && current.id !== id)) return false;
    current.controller.abort();
    this.current = null;
    return true;
  }
}
