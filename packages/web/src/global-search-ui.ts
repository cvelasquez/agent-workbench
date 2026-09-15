/**
 * El buscador global de la barra (hito 29, D22), sin JSX: lo que decide si se
 * ve, como se agrupan los aciertos, que dice y que hace un clic. Lo importa
 * `check-global-search.mjs`, por lo mismo que `agent-ui.ts` y `vault-ui.ts`.
 *
 * **Busca en la copia propia y en nada mas**, y eso ordena lo que se muestra:
 *
 *  - Con una sola CLI no hay conmutador (D21): quien usa solo Claude Code no ve
 *    nada nuevo en la barra.
 *  - Sin sesiones en la copia tampoco. Un conmutador que siempre contesta "no hay
 *    nada donde buscar" es ruido, y la copia apagada ya tiene su boton.
 *  - **Apagada y con sesiones, busca igual** en lo que guardo —o en lo
 *    importado— y lo dice: lo de despues de apagarla no esta.
 */

import {
  GLOBAL_SEARCH_MIN_CHARS,
  GLOBAL_SEARCH_SAFETY_MS,
  resumeCwdFor,
  shouldOfferAgentChoice,
  type AgentId,
  type AgentInfo,
  type GlobalSearchHit,
  type GlobalSearchProgress,
  type GlobalSearchResult,
  type ProjectSummary,
  type SessionAgentId,
  type SessionSummary,
  type TerminalDescriptor,
  type TerminalId,
  type VaultStatus,
} from '@agent-workbench/shared';
import { resumableSession } from './agent-ui.js';

export type SidebarSearchMode = 'titles' | 'conversations';

/** El conmutador "En títulos / En conversaciones" y todo lo que cuelga de el. */
export function globalSearchVisible(agents: readonly AgentInfo[], vault: VaultStatus | null): boolean {
  return shouldOfferAgentChoice(agents) && vault !== null && vault.sessions > 0;
}

export const SEARCH_MODE_TITLES_TEXT = 'En títulos';
export const SEARCH_MODE_CONVERSATIONS_TEXT = 'En conversaciones';
export const SEARCH_MODE_CONVERSATIONS_TITLE =
  'Busca en el texto de las conversaciones guardadas en la copia propia, sin distinguir mayúsculas ni tildes';

/** El placeholder del buscador de la barra. El de títulos es el de siempre. */
export function sidebarFilterPlaceholder(mode: SidebarSearchMode): string {
  return mode === 'conversations' ? 'Buscar en las conversaciones (Enter)' : 'Filtrar proyectos y sesiones';
}

export const GLOBAL_SEARCH_TOO_SHORT_TEXT = `Escribí al menos ${GLOBAL_SEARCH_MIN_CHARS} caracteres y Enter.`;

/** true si la consulta no llega al minimo: ni se manda. */
export function globalSearchTooShort(query: string): boolean {
  return [...query.trim()].length < GLOBAL_SEARCH_MIN_CHARS;
}

export const GLOBAL_SEARCH_OFF_TEXT =
  'La copia propia está apagada: se busca en lo que guardó mientras estuvo encendida.';

/** Los aciertos de una sesion, en el orden en que llegaron. */
export interface SearchHitGroup {
  key: string;
  agent: SessionAgentId;
  sessionId: string;
  title: string;
  /** El acierto en el titulo, si lo hubo. */
  titleHit: GlobalSearchHit | null;
  /** Los aciertos en mensajes. */
  hits: GlobalSearchHit[];
  /** La fecha del acierto mas reciente con fecha, o null. */
  lastAt: number | null;
}

/**
 * Agrupa por sesion. El servidor ya las manda de la mas reciente a la mas vieja
 * y, dentro, el titulo primero: el orden de aparicion es el que se muestra.
 */
export function groupSearchHits(hits: readonly GlobalSearchHit[]): SearchHitGroup[] {
  const groups = new Map<string, SearchHitGroup>();
  for (const hit of hits) {
    const key = `${hit.agent}:${hit.sessionId}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, agent: hit.agent, sessionId: hit.sessionId, title: hit.title, titleHit: null, hits: [], lastAt: null };
      groups.set(key, group);
    }
    if (hit.eventId === null) group.titleHit = hit;
    else group.hits.push(hit);
    if (hit.at !== null) group.lastAt = Math.max(group.lastAt ?? 0, hit.at);
  }
  return [...groups.values()];
}

/**
 * Cuanto texto se deja antes del acierto en la barra. El fragmento se dibuja
 * recortado a dos lineas (`.search-hit-snippet`), que en el ancho por defecto
 * son unos 80 caracteres.
 */
export const SNIPPET_LEAD_CHARS = 40;

/**
 * El fragmento partido para resaltar el acierto.
 *
 * **Lo de antes del acierto se acorta a `maxBefore`, con `…`.** El servidor
 * centra el acierto en 160 caracteres, pero la barra muestra dos lineas: medido
 * en la prueba en vivo del hito 29, un acierto al final de un mensaje largo
 * quedaba en la parte recortada y la fila no mostraba por que casaba. Sin
 * partir un par sustituto.
 */
export function snippetPieces(
  hit: Pick<GlobalSearchHit, 'snippet' | 'matchStart' | 'matchLength'>,
  maxBefore = SNIPPET_LEAD_CHARS,
): {
  before: string;
  match: string;
  after: string;
} {
  const end = hit.matchStart + hit.matchLength;
  let before = hit.snippet.slice(0, hit.matchStart);
  if (before.length > maxBefore) {
    let cut = before.length - maxBefore;
    const code = before.charCodeAt(cut);
    if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
    before = `…${before.slice(cut)}`;
  }
  return {
    before,
    match: hit.snippet.slice(hit.matchStart, end),
    after: hit.snippet.slice(end),
  };
}

/** "Pedido" o "Respuesta": quien escribio el mensaje del acierto. */
export function searchHitRoleText(hit: Pick<GlobalSearchHit, 'role'>): string {
  return hit.role === 'user' ? 'Pedido' : hit.role === 'assistant' ? 'Respuesta' : 'Título';
}

/**
 * Lo que va al buscador del hilo al abrir un acierto: **el texto encontrado tal
 * como esta escrito**, no la consulta. El buscador del hilo distingue tildes
 * —y cambiarlo seria cambiar lo que ve quien usa una sola CLI—, asi que
 * "migracion" no encontraria "Migración" ahi. Del grupo, el primer acierto en
 * un mensaje: el del titulo puede no aparecer en la conversacion.
 */
export function threadQueryFor(hit: Pick<GlobalSearchHit, 'snippet' | 'matchStart' | 'matchLength'>): string {
  return snippetPieces(hit).match.trim();
}

export function groupThreadQuery(group: SearchHitGroup): string {
  const first = group.hits[0] ?? group.titleHit;
  return first === null ? '' : threadQueryFor(first);
}

const count = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Suma un aviso de progreso a lo que se tiene de esa busqueda (`previous`, o
 * null si es el primero). Los aciertos del aviso son solo los nuevos y van al
 * final; el avance es el del aviso. Sin `truncated`: todavia no termino. El
 * resultado final reemplaza todo esto, no se suma.
 */
export function mergeSearchProgress(previous: GlobalSearchResult | null, progress: GlobalSearchProgress): GlobalSearchResult {
  return {
    query: progress.query,
    hits: previous === null ? [...progress.hits] : [...previous.hits, ...progress.hits],
    sessionsScanned: progress.sessionsScanned,
    sessionsTotal: progress.sessionsTotal,
    truncated: null,
  };
}

/**
 * La linea de estado de la busqueda, o null si no hay nada que decir.
 *
 * **"Sin resultados" solo cuando termino de verdad**: la busqueda recorre todas
 * las sesiones y, mientras tanto, dice cuantas lleva y lo que ya encontro. Al
 * terminar sin nada dice en cuantas miro —"Sin resultados en 324 sesiones."—, y
 * si la corto el tope de seguridad, cuantas quedaron sin mirar: "sin
 * resultados" despues de leer diez de cien sesiones no es "no esta".
 */
export function globalSearchStatusText(state: {
  searching: boolean;
  error: string | null;
  result: GlobalSearchResult | null;
}): string | null {
  const { result } = state;
  if (state.searching && state.error === null) {
    if (result === null) return 'Buscando…';
    const sofar = `Buscando… ${result.sessionsScanned} de ${count(result.sessionsTotal, 'sesión', 'sesiones')}`;
    return result.hits.length === 0 ? `${sofar}.` : `${sofar}, ${foundText(result)} por ahora.`;
  }
  if (state.error !== null) return state.error;
  if (result === null) return null;

  const found = result.hits.length === 0 ? 'Sin resultados' : foundText(result);

  if (result.truncated === null && result.hits.length === 0 && result.sessionsScanned > 0) {
    return `Sin resultados en ${count(result.sessionsScanned, 'sesión', 'sesiones')}.`;
  }
  if (result.truncated === 'results') {
    return `${found}: son los primeros, afiná la búsqueda para ver el resto.`;
  }
  if (result.truncated === 'time') {
    const left = Math.max(0, result.sessionsTotal - result.sessionsScanned);
    return `${found}: la búsqueda se cortó a los ${Math.round(GLOBAL_SEARCH_SAFETY_MS / 1000)} s y quedaron ${count(left, 'sesión', 'sesiones')} sin mirar.`;
  }
  return `${found}.`;
}

/** "3 aciertos en 2 sesiones". */
function foundText(result: GlobalSearchResult): string {
  const sessions = new Set(result.hits.map((hit) => `${hit.agent}:${hit.sessionId}`)).size;
  return `${count(result.hits.length, 'acierto', 'aciertos')} en ${count(sessions, 'sesión', 'sesiones')}`;
}

/** Que hace el clic en un acierto. */
export type SearchHitAction =
  /** La sesion ya tiene pestana: se activa. */
  | { kind: 'activate'; terminalId: TerminalId }
  /** Se retoma como una fila de la barra, con su CLI y su carpeta. */
  | { kind: 'resume'; cwd: string; session: SessionSummary & { agent: AgentId } }
  /**
   * Se abre el Markdown de la copia: la fila solo esta en la copia, su CLI no
   * esta, su carpeta no existe, o la barra no la lista. El acierto salio de la
   * copia, asi que ahi esta.
   */
  | { kind: 'copy' };

export function searchHitAction(
  hit: Pick<GlobalSearchHit, 'agent' | 'sessionId'>,
  context: {
    projects: readonly ProjectSummary[];
    terminals: readonly TerminalDescriptor[];
    platform: string;
    canResume: (agent: AgentId) => boolean;
  },
): SearchHitAction {
  const open = context.terminals.find(
    (terminal) => terminal.kind === 'agent' && terminal.agent === hit.agent && terminal.sessionId === hit.sessionId,
  );
  if (open !== undefined) return { kind: 'activate', terminalId: open.terminalId };

  for (const project of context.projects) {
    const session = project.sessions.find((row) => row.agent === hit.agent && row.sessionId === hit.sessionId);
    if (session === undefined) continue;
    // Las mismas condiciones que habilitan la fila (Sidebar: `openable`).
    if (resumableSession(session) && project.cwdExists && context.canResume(session.agent)) {
      return { kind: 'resume', cwd: resumeCwdFor(session.cwd, project.cwd, context.platform), session };
    }
    return { kind: 'copy' };
  }
  return { kind: 'copy' };
}
