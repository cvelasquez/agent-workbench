/**
 * Continuar una conversacion con otra CLI (hito 29).
 *
 * `continueSession` arma todo lo que no es escribir en una pty: busca la sesion
 * en el indice, lee sus eventos, decide el transcript, abre la pestana de la
 * CLI que continua, guarda el archivo y compone el mensaje. **Entregarlo** es
 * del socket (`deliverWhenReady` o `composer.prefill`): el resultado dice como.
 *
 * El orden importa, y es el de la especificacion (§6.3): **nada se abre ni se
 * escribe hasta saber que hay algo que continuar**. Una conversacion sin turnos,
 * sin carpeta o que no se puede leer no deja una pestana vacia abierta. Lo unico
 * que se deshace es el ultimo paso que puede fallar despues de abrir: si el
 * transcript no se guarda, la pestana recien abierta se cierra.
 *
 * Tres decisiones que no se ven en el codigo:
 *
 *  - **Fuente** (D15): primero la copia propia, si la tiene y sirve —la que solo
 *    esta en la copia no tiene otra—; si no, el seguidor de la CLI de origen.
 *    Las dos dan `ConversationEvent[]` y el transcript no distingue. Cuando la
 *    copia sirve lo decide quien la lee (`VaultService.handoffEvents`).
 *  - **Hasta el principio, con tope** (M5): se pagina hacia atras hasta que no
 *    hay mas o hasta `HANDOFF_MAX_EVENTS`. Pasado el tope no hay pedido inicial
 *    y la cuenta de turnos es un minimo.
 *  - **Dos escalones de entrega** (D19 como dice A4): con senal de "lista" se
 *    manda solo por la pty; sin ella, el cuadro de la pestana nueva prellenado,
 *    y lo manda el usuario. Nunca las dos cosas.
 */

import {
  IMPORTED_AGENT_LABELS,
  isAgentId,
  serverText,
  type AgentCapabilities,
  type AgentId,
  type ConversationEvent,
  type ConversationState,
  type ServerErrorCode,
  type ServerSessionContinuedMessage,
  type ServerText,
  type SessionAgentId,
  type SessionSummary,
  type TerminalDescriptor,
  type TerminalId,
} from '@agent-workbench/shared';
import type { AgentAdapter, CliLocation, HistorySource } from '../agents/adapter.js';
import { TerminalOpenError } from '../terminal-open-error.js';
import { drainFollower } from '../vault/read-session.js';
import {
  HANDOFF_MAX_EVENTS,
  buildContinuationMessage,
  planTranscript,
  transcriptReferenceFor,
} from './transcript.js';

/** Cuanto se espera a que la CLI que continua gane sesion y este lista, cada vez. */
export const HANDOFF_DELIVERY_TIMEOUT_MS = 15_000;
/** El titulo de origen en la etiqueta de la pestana nueva, en caracteres. */
export const HANDOFF_LABEL_TITLE_CHARS = 40;
/** De a cuantos eventos se pagina hacia atras. */
const PAGE_EVENTS = 400;

/** Los eventos de una sesion de la copia propia, ya recortados para el transcript. */
export interface ArchivedEvents {
  events: ConversationEvent[];
  /** La cabecera dice "historial parcial" (lo importado sin contenido completo). */
  partial: boolean;
  /** false si la sesion tenia mas eventos que el tope: se quedaron los ultimos. */
  complete: boolean;
}

export interface ArchiveReader {
  /**
   * La sesion de la copia, o null si la copia no la tiene o no conviene leerla
   * de ahi (una nativa cuya copia quedo atras del historial).
   */
  events(agent: SessionAgentId, sessionId: string): Promise<ArchivedEvents | null>;
}

/** Lo que `continueSession` necesita de cada pieza del servidor. Inyectable para el chequeo. */
export interface ContinueDeps {
  registry: {
    open(options: { cwd: string; agent: AgentId; kind: 'agent'; label: string }): Promise<TerminalDescriptor>;
  };
  /**
   * Cierra una pestana que abrio la continuacion y no llego a servir: lo mismo
   * que hace el socket con `terminal.close` (hub, git, memoria, pegados).
   */
  closeTab(terminalId: TerminalId): void;
  agents: {
    get(id: AgentId): {
      adapter: Pick<AgentAdapter, 'label' | 'capabilities' | 'input' | 'history'>;
      location: CliLocation | null;
    } | null;
  };
  index: { find(agent: SessionAgentId, sessionId: string): SessionSummary | null };
  pasteStore: { saveText(terminalId: string, baseName: 'continuacion', content: string): Promise<{ path: string }> };
  /** La copia propia, o null si no hay (el chequeo, o un servidor sin copia). */
  archive: ArchiveReader | null;
  /** Tope de eventos que se leen de la sesion de origen. Por omision, `HANDOFF_MAX_EVENTS`. */
  maxEvents?: number;
}

export type ContinueOutcome =
  | {
      ok: true;
      descriptor: TerminalDescriptor;
      continued: Omit<ServerSessionContinuedMessage, 'type' | 'requestId'>;
      /** El mensaje para la CLI que continua: se manda solo o va prellenado segun `continued.delivery`. */
      message: string;
    }
  | { ok: false; code: ServerErrorCode; text: ServerText; detail?: string };

/** Como llega el mensaje a la CLI que continua (D19, sin la API que saco A4). */
export type Delivery = 'pty' | 'prefill';

/**
 * `pty` si la CLI avisa cuando esta lista: se pega por la terminal como una
 * nota. Si no, `prefill`: pegar a ciegas en una CLI que puede estar pintando o
 * con un menu abierto es justo lo que la senal evita.
 */
export function chooseDelivery(capabilities: Pick<AgentCapabilities, 'readySignal'>): Delivery {
  return capabilities.readySignal ? 'pty' : 'prefill';
}

/**
 * `Continuación: <titulo>`, con el titulo cortado. Es el respaldo: la web manda
 * la suya en su idioma (hito 34, D12), y esta queda para un cliente que no.
 */
export function continuationLabel(title: string): string {
  const clean = title.replace(/\s+/g, ' ').trim();
  const chars = [...clean];
  const cut = chars.length > HANDOFF_LABEL_TITLE_CHARS ? `${chars.slice(0, HANDOFF_LABEL_TITLE_CHARS).join('').trimEnd()}…` : clean;
  return cut.length > 0 ? `Continuación: ${cut}` : 'Continuación';
}

export interface SourceEvents {
  events: ConversationEvent[];
  /** true si la lectura llego al principio de la conversacion. */
  complete: boolean;
  state: ConversationState;
}

/**
 * Los eventos de una sesion por el seguidor de su CLI, hasta el principio o
 * hasta `maxEvents` (M5). null si el origen no se encontro: el seguidor no
 * llego a `live` ni a `no-transcript`. Lanza si el seguidor lanza.
 *
 * Con `wholeRead` el seguidor guarda en memoria hasta `maxEvents`; sin el, su
 * propio tope, y se pagina igual. Los textos salen con los topes de siempre
 * (8 000 / 2 000 / 4 000): el transcript corta mas abajo.
 */
export async function readSourceEvents(
  history: Pick<HistorySource, 'follow' | 'wholeRead'>,
  target: { cwd: string; sessionId: string },
  maxEvents = HANDOFF_MAX_EVENTS,
): Promise<SourceEvents | null> {
  const cap = Math.max(1, Math.floor(maxEvents));
  const follower = history.wholeRead === true ? history.follow(target, { maxEvents: cap }) : history.follow(target);
  await drainFollower(follower);

  const state = follower.getState();
  if (state !== 'live' && state !== 'no-transcript') return null;

  let page = follower.getTail(Math.min(PAGE_EVENTS, cap));
  const events = [...page.events];
  let complete = !page.hasMore;
  while (!complete && events.length < cap) {
    const first = events[0];
    if (first === undefined) break;
    page = follower.getPageBefore(first.eventId, Math.min(PAGE_EVENTS, cap - events.length));
    complete = !page.hasMore;
    if (page.events.length === 0) break;
    events.unshift(...page.events);
  }
  return { events, complete, state };
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Arma la continuacion de `request` con `request.target`. Ver el comentario del
 * modulo para el orden y las decisiones.
 */
export async function continueSession(
  deps: ContinueDeps,
  request: { agent: SessionAgentId; sessionId: string; target: AgentId; label?: string },
): Promise<ContinueOutcome> {
  const failed = (text: ServerText, detail?: string): ContinueOutcome => ({
    ok: false,
    code: 'continue-failed',
    text,
    ...(detail !== undefined ? { detail } : {}),
  });

  // 1. La CLI que continua: registrada, instalada y otra que la de origen.
  const target = deps.agents.get(request.target);
  if (target === null) {
    return { ok: false, code: 'agent-unsupported', text: serverText('agentUnknown'), detail: request.target };
  }
  if (target.location === null) {
    return { ok: false, code: 'cli-not-found', text: serverText('cliNotInstalled', { label: target.adapter.label }) };
  }
  if (request.agent === request.target) {
    // Continuar con la misma CLI no entra en el hito (§16): reanudarla es abrir su fila.
    return failed(serverText('continueSameCli'));
  }

  // 2. La sesion, como la lista la barra. Su `cwd` es el de reanudar (M4).
  const summary = deps.index.find(request.agent, request.sessionId);
  // Una sesion recien empezada puede tardar en indexarse (Codex en Windows, §10.10).
  if (summary === null) return failed(serverText('continueNotInHistory'));
  if (summary.cwd.length === 0) return failed(serverText('continueNoFolder'));

  // 3. Los eventos: la copia si sirve, si no el seguidor de la CLI de origen.
  let source: (SourceEvents & { partial: boolean }) | null;
  try {
    source = await readEvents(deps, request.agent, summary);
  } catch (error) {
    return failed(serverText('continueReadFailed'), messageOf(error));
  }
  if (source === null) return failed(serverText('continueHistoryMissing'));

  // 4. El transcript, antes de abrir nada: sin turnos no hay continuacion (H5).
  const sourceLabel = isAgentId(request.agent)
    ? (deps.agents.get(request.agent)?.adapter.label ?? request.agent)
    : IMPORTED_AGENT_LABELS[request.agent];
  const plan = planTranscript({
    header: {
      sourceLabel,
      agent: request.agent,
      cwd: summary.cwd,
      title: summary.title,
      sessionId: summary.sessionId,
      lastAt: summary.updatedAt,
      partial: summary.partial || source.partial,
    },
    events: source.events,
    state: source.state,
    complete: source.complete,
  });
  if (!plan.ok) return failed(plan.text);

  // 5. La pestana de la CLI que continua, en la carpeta de la sesion.
  let descriptor: TerminalDescriptor;
  try {
    descriptor = await deps.registry.open({
      cwd: summary.cwd,
      agent: request.target,
      kind: 'agent',
      label: request.label ?? continuationLabel(summary.title),
    });
  } catch (error) {
    if (error instanceof TerminalOpenError) {
      return { ok: false, code: error.code, text: error.text, ...(error.detail !== undefined ? { detail: error.detail } : {}) };
    }
    return failed(serverText('continueTabFailed'), messageOf(error));
  }

  // 6. El archivo, en la carpeta de pegados de esa pestana (D17).
  let saved: { path: string };
  try {
    saved = await deps.pasteStore.saveText(descriptor.terminalId, 'continuacion', plan.markdown);
  } catch (error) {
    deps.closeTab(descriptor.terminalId);
    return failed(serverText('continueTranscriptFailed'), messageOf(error));
  }

  // 7. El mensaje, nombrando el archivo como lo lee esa CLI (D18).
  const message = buildContinuationMessage({
    sourceLabel,
    includedTurns: plan.includedTurns,
    reference: transcriptReferenceFor(saved.path, target.adapter.input.transcriptReference),
    lastRequest: plan.lastRequest,
  });

  // 8. Como llega. La entrega en si es del socket.
  return {
    ok: true,
    descriptor,
    message,
    continued: {
      terminalId: descriptor.terminalId,
      source: { agent: request.agent, sessionId: summary.sessionId, title: summary.title },
      includedTurns: plan.includedTurns,
      totalTurns: plan.totalTurns,
      totalTurnsIsMinimum: plan.totalTurnsIsMinimum,
      delivery: chooseDelivery(target.adapter.capabilities) === 'pty' ? 'sending' : 'prefilled',
    },
  };
}

/** La copia si la tiene y sirve; si no, el seguidor de la CLI de origen. null si ninguno la encuentra. */
async function readEvents(
  deps: ContinueDeps,
  agent: SessionAgentId,
  summary: SessionSummary,
): Promise<(SourceEvents & { partial: boolean }) | null> {
  const archived = deps.archive === null ? null : await deps.archive.events(agent, summary.sessionId);
  if (archived !== null) {
    return { events: archived.events, complete: archived.complete, state: 'live', partial: archived.partial };
  }
  // Una fuente importada no tiene CLI con que leerla: sin copia no hay nada.
  if (!isAgentId(agent)) return null;
  const registered = deps.agents.get(agent);
  if (registered === null) return null;
  const read = await readSourceEvents(
    registered.adapter.history,
    { cwd: summary.cwd, sessionId: summary.sessionId },
    deps.maxEvents ?? HANDOFF_MAX_EVENTS,
  );
  return read === null ? null : { ...read, partial: false };
}
