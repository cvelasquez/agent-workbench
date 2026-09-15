/**
 * Que esta haciendo cada sesion de OpenCode, segun su `serve` (hito 29, D9).
 *
 * Un solo flujo de eventos, `GET /global/event`, para todas las pestanas, y
 * una **foto** por carpeta —`GET /session/status`, `/permission` y
 * `/question`— al rastrear una sesion y cada vez que el flujo se (re)abre: lo
 * que paso mientras no habia conexion no llega por el flujo.
 *
 * Tres reglas:
 *
 *  - **Solo se conocen las sesiones lanzadas en este arranque** (`track`, que
 *    llama el lanzamiento con el cliente del `serve` que las atiende). De una
 *    que no, o con el `serve` apagado, el estado es null: el registro pinta
 *    `offline`. Cuando el `serve` muere, todas pasan a null (`detach`). Si murio
 *    **sin que la app lo pidiera**, el null de las que atendia lleva el motivo
 *    `server-closed` (M2): su TUI sigue vivo, enganchado a un puerto muerto, y
 *    la vista lo dice hasta que la sesion se vuelve a lanzar (`track`).
 *  - **La espera gana a todo**: un permiso pendiente es `waiting 'permission
 *    prompt'` —la etiqueta de §4.13 de CLAUDE.md, que la barra ya sabe
 *    decir—; una pregunta pendiente, `waiting 'question'`; `busy` o `retry`,
 *    trabajando; si no, libre.
 *  - **La foto no pisa lo que llego mientras se pedia.** Los eventos de esa
 *    carpeta que llegan con la foto en camino se aplican en el acto y se
 *    vuelven a aplicar, en orden, encima de la foto. Una pregunta contestada
 *    en ese intervalo no reaparece.
 *
 * **Lo pendiente de un sub-agente es de su raiz** (R29-1). Cuando el agente usa
 * `task`, OpenCode crea una sesion hija, y un permiso o una pregunta de esa hija
 * llegan con el id **de la hija**. El TUI enganchado a la raiz los muestra en la
 * vista raiz (segun el binario: junta los de la raiz y los de sus hijas), con
 * la raiz en `busy` por su `task`. Sin atribuirlos, la barra no aparecia y el
 * candado del cuadro (D12) dejaba caer el pegado en el menu. El padre sale de
 * la base, de a una fila (`parentOf`), y se recuerda: no cambia nunca. El
 * estado de una hija no se mira —la raiz ya trabaja—, y su pregunta no tiene
 * tarjeta en el hilo de la raiz: se publica como `input needed`, que la barra
 * dice "esperando una respuesta tuya" y manda a la solapa CLI.
 */

import type { TerminalOfflineReason } from '@agent-workbench/shared';
import { debugLog } from '../../debug.js';
import type { ReadOnlyDatabase } from '../sqlite.js';
import type { AgentStatus, StatusSource } from '../adapter.js';
import type { GlobalEvent, OpenCodeServeClient, ServeSessionStatus } from './serve-client.js';
import { REAL_TIMERS, type ServeEndpoint, type ServeTimers } from './serve-process.js';
import { OPENCODE_SQL, type SessionParentRow } from './sql.js';

/** La etiqueta de un permiso pendiente: la misma que publica Claude Code (§4.13). */
export const OPENCODE_WAITING_PERMISSION = 'permission prompt';

/** La etiqueta de una pregunta pendiente. */
export const OPENCODE_WAITING_QUESTION = 'question';

/**
 * La etiqueta de una pregunta de un sub-agente: sin tarjeta en el hilo de la
 * raiz, no puede decir "respondela en el hilo". Una de las de §4.13.
 */
export const OPENCODE_WAITING_SUBAGENT_QUESTION = 'input needed';

/** Cuantos niveles de sub-agentes se suben buscando la raiz. Medido: ninguno anidado. */
const MAX_PARENT_DEPTH = 8;

/** Cuantas raices se recuerdan antes de empezar de nuevo. */
const MAX_REMEMBERED_ROOTS = 2_000;

/**
 * El padre de una sesion: `{ parentId: null }` si es una raiz, null si no se
 * sabe (la base no la tiene todavia, o no se puede leer).
 */
export type SessionParentLookup = (sessionId: string) => { parentId: string | null } | null;

/** `SessionParentLookup` sobre la base de OpenCode: una fila por id, solo lectura. */
export function readSessionParent(db: ReadOnlyDatabase, sessionId: string): { parentId: string | null } | null {
  try {
    const row = db.get<SessionParentRow>(OPENCODE_SQL.sessionParentById, sessionId);
    if (row === undefined) return null;
    return { parentId: typeof row.parent_id === 'string' && row.parent_id.length > 0 ? row.parent_id : null };
  } catch {
    // Una base ocupada o ilegible: no se sabe, y se vuelve a preguntar con el proximo evento.
    return null;
  }
}

/** Esperas antes de repetir una foto que fallo. */
export const SNAPSHOT_RETRY_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 5_000]);

/** Lo que el estado usa del cliente. */
export type ServeStatusClient = Pick<
  OpenCodeServeClient,
  'endpoint' | 'sessionStatus' | 'pendingPermissions' | 'pendingQuestions' | 'events'
>;

export interface ServeStatusOptions {
  timers?: ServeTimers;
  snapshotRetryDelaysMs?: readonly number[];
  /** De donde sale el padre de una sesion (R29-1). Sin esto, lo de un sub-agente se ignora. */
  parentOf?: SessionParentLookup;
}

interface TrackedSession {
  directory: string;
  /** false hasta la primera foto: antes no se avisa nada. */
  known: boolean;
  status: ServeSessionStatus;
  /** Los de la raiz y los de sus sub-agentes: el menu es el mismo. */
  permissions: Set<string>;
  questions: Set<string>;
  /** Preguntas de sus sub-agentes: sin tarjeta en el hilo de la raiz. */
  childQuestions: Set<string>;
}

interface Subscription {
  sessionId: string;
  listener: (status: AgentStatus | null, offlineReason?: TerminalOfflineReason) => void;
  /** Lo ultimo entregado; undefined si todavia nada. */
  last: string | undefined;
}

interface Waiter {
  sessionId: string;
  check(): void;
  finish(ready: boolean): void;
}

/** Un evento ya atribuido a una sesion rastreada. */
interface RoutedEvent {
  event: GlobalEvent;
  rootId: string;
  /** Llego con el id de un sub-agente de `rootId`. */
  fromChild: boolean;
}

interface Snapshot {
  buffered: RoutedEvent[];
  /** Alguien pidio otra foto mientras esta estaba en camino. */
  again: boolean;
}

/**
 * El estado de una sesion rastreada, con la prioridad de la espera: permiso
 * (suyo o de un sub-agente), pregunta propia —tiene tarjeta—, pregunta de un
 * sub-agente, trabajando, libre.
 */
export function activityOfTracked(session: {
  status: ServeSessionStatus;
  permissions: ReadonlySet<string>;
  questions: ReadonlySet<string>;
  childQuestions?: ReadonlySet<string>;
}): AgentStatus {
  if (session.permissions.size > 0) return { activity: 'waiting', waitingFor: OPENCODE_WAITING_PERMISSION };
  if (session.questions.size > 0) return { activity: 'waiting', waitingFor: OPENCODE_WAITING_QUESTION };
  if ((session.childQuestions?.size ?? 0) > 0) return { activity: 'waiting', waitingFor: OPENCODE_WAITING_SUBAGENT_QUESTION };
  if (session.status === 'busy' || session.status === 'retry') return { activity: 'busy', waitingFor: null };
  return { activity: 'idle', waitingFor: null };
}

function applyEvent(session: TrackedSession, { event, fromChild }: RoutedEvent): void {
  switch (event.type) {
    case 'session.status':
      // El de un sub-agente no llega aca (`route`): la raiz ya trabaja por su `task`.
      if (!fromChild) session.status = event.status;
      break;
    case 'permission.asked':
      session.permissions.add(event.requestId);
      break;
    case 'permission.replied':
      session.permissions.delete(event.requestId);
      break;
    case 'question.asked':
      (fromChild ? session.childQuestions : session.questions).add(event.requestId);
      break;
    case 'question.replied':
    case 'question.rejected':
      session.questions.delete(event.requestId);
      session.childQuestions.delete(event.requestId);
      break;
  }
}

export class OpenCodeServeStatus implements StatusSource {
  private readonly timers: ServeTimers;
  private readonly retryDelaysMs: readonly number[];
  private client: ServeStatusClient | null = null;
  private closeEvents: (() => void) | null = null;
  /** Cambia con cada `serve` nuevo o muerto: una foto de antes se descarta. */
  private generation = 0;
  private disposed = false;
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly subscriptions = new Set<Subscription>();
  private readonly waiters = new Set<Waiter>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly retries = new Map<string, { timer: unknown; attempt: number }>();
  private readonly parentOf: SessionParentLookup | null;
  /** Sesion -> su raiz, sea rastreada o no. Solo lo que la base confirmo: no cambia nunca. */
  private readonly roots = new Map<string, string>();
  /**
   * Sesiones cuyo `serve` murio sin que la app lo pidiera, con su motivo (M2).
   * Sobreviven a un `serve` nuevo —otra pestana puede haberlo lanzado, y esta
   * sigue enganchada al muerto— y se olvidan cuando la sesion se vuelve a
   * rastrear, que es relanzarla.
   */
  private readonly lost = new Map<string, TerminalOfflineReason>();

  constructor(options: ServeStatusOptions = {}) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.retryDelaysMs = options.snapshotRetryDelaysMs ?? SNAPSHOT_RETRY_DELAYS_MS;
    this.parentOf = options.parentOf ?? null;
  }

  /**
   * Una sesion lanzada en este arranque, en esa carpeta, atendida por ese
   * cliente. Un cliente distinto del anterior es otro `serve`: lo rastreado con
   * el anterior se olvida.
   */
  track(sessionId: string, directory: string, client: ServeStatusClient): void {
    if (this.disposed) return;
    this.lost.delete(sessionId);
    this.attach(client);
    const existing = this.tracked.get(sessionId);
    if (existing === undefined || existing.directory !== directory) {
      this.tracked.set(sessionId, {
        directory,
        known: false,
        status: 'idle',
        permissions: new Set(),
        questions: new Set(),
        childQuestions: new Set(),
      });
    }
    void this.snapshot(directory);
  }

  /**
   * El `serve` que atendia murio. Con `endpoint`, solo si es el del cliente
   * actual: el aviso tardio de un proceso viejo no suelta al nuevo. Con
   * `offlineReason`, las sesiones que atendia lo llevan en su null (M2).
   */
  detach(endpoint?: ServeEndpoint, offlineReason: TerminalOfflineReason | null = null): void {
    if (this.client === null) return;
    if (endpoint !== undefined && this.client.endpoint !== endpoint) return;
    if (offlineReason !== null) {
      for (const sessionId of this.tracked.keys()) this.lost.set(sessionId, offlineReason);
    }
    this.closeEvents?.();
    this.closeEvents = null;
    this.client = null;
    this.forget();
    for (const subscription of [...this.subscriptions]) this.deliver(subscription);
    for (const waiter of [...this.waiters]) waiter.finish(false);
  }

  /** Lo que se sabe ahora de una sesion. null si no se rastrea, si el `serve` no esta o antes de la primera foto. */
  current(sessionId: string): AgentStatus | null {
    if (this.client === null) return null;
    const session = this.tracked.get(sessionId);
    return session === undefined || !session.known ? null : activityOfTracked(session);
  }

  subscribe(
    sessionId: string,
    listener: (status: AgentStatus | null, offlineReason?: TerminalOfflineReason) => void,
  ): () => void {
    const subscription: Subscription = { sessionId, listener, last: undefined };
    this.subscriptions.add(subscription);
    this.deliver(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  /**
   * true cuando la sesion esta libre y sin nada pendiente. false enseguida si
   * no se rastrea o el `serve` no esta, o al vencer el plazo, o si el `serve`
   * muere mientras tanto. Espera por condicion: los eventos y las fotos.
   */
  waitUntilReady(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (this.client === null || !this.tracked.has(sessionId)) return Promise.resolve(false);
    if (this.isReady(sessionId)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let done = false;
      const waiter: Waiter = {
        sessionId,
        check: () => {
          if (this.isReady(sessionId)) waiter.finish(true);
        },
        finish: (ready) => {
          if (done) return;
          done = true;
          this.timers.clearTimeout(deadline);
          this.waiters.delete(waiter);
          resolve(ready);
        },
      };
      const deadline = this.timers.setTimeout(() => waiter.finish(false), timeoutMs);
      this.waiters.add(waiter);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.closeEvents?.();
    this.closeEvents = null;
    this.client = null;
    this.forget();
    this.lost.clear();
    this.subscriptions.clear();
    for (const waiter of [...this.waiters]) waiter.finish(false);
  }

  private attach(client: ServeStatusClient): void {
    if (this.client === client) return;
    this.closeEvents?.();
    this.forget();
    this.client = client;
    this.closeEvents = client.events(
      (event) => this.onEvent(event),
      () => this.onConnected(),
    );
  }

  /** Suelta todo lo del `serve` anterior: sesiones, fotos en camino y reintentos. */
  private forget(): void {
    this.generation++;
    this.tracked.clear();
    this.snapshots.clear();
    for (const retry of this.retries.values()) this.timers.clearTimeout(retry.timer);
    this.retries.clear();
  }

  private onConnected(): void {
    const directories = new Set([...this.tracked.values()].map((session) => session.directory));
    for (const directory of directories) void this.snapshot(directory);
  }

  private onEvent(event: GlobalEvent): void {
    const routed = this.route(event);
    if (routed === null) return;
    const session = this.tracked.get(routed.rootId);
    if (session === undefined) return;
    this.snapshots.get(session.directory)?.buffered.push(routed);
    applyEvent(session, routed);
    this.notify(routed.rootId);
  }

  /**
   * A que sesion rastreada le toca un evento: la suya, o la raiz de un
   * sub-agente. El estado de otra sesion no se atribuye a nadie, y no hace
   * buscar ningun padre.
   */
  private route(event: GlobalEvent): RoutedEvent | null {
    if (this.tracked.has(event.sessionId)) return { event, rootId: event.sessionId, fromChild: false };
    if (event.type === 'session.status') return null;
    const rootId = this.rootOf(event.sessionId);
    if (rootId === null || rootId === event.sessionId || !this.tracked.has(rootId)) return null;
    return { event, rootId, fromChild: true };
  }

  /**
   * La raiz de una sesion subiendo por `parent_id`, o null si la base no la
   * conoce (todavia) o no hay de donde leer. Se para en la primera sesion
   * rastreada: las pestanas son raices, y asi no se lee su fila. Se recuerda
   * solo lo confirmado.
   */
  private rootOf(sessionId: string): string | null {
    let current = sessionId;
    for (let depth = 0; depth <= MAX_PARENT_DEPTH; depth++) {
      let rootId = this.roots.get(current) ?? (current !== sessionId && this.tracked.has(current) ? current : null);
      if (rootId === null) {
        if (this.parentOf === null) return null;
        const parent = this.parentOf(current);
        if (parent === null) return null;
        if (parent.parentId !== null) {
          current = parent.parentId;
          continue;
        }
        rootId = current;
      }
      if (this.roots.size >= MAX_REMEMBERED_ROOTS) this.roots.clear();
      this.roots.set(sessionId, rootId);
      return rootId;
    }
    return null;
  }

  private async snapshot(directory: string): Promise<void> {
    const client = this.client;
    if (client === null) return;
    const pending = this.snapshots.get(directory);
    if (pending !== undefined) {
      pending.again = true;
      return;
    }
    const retry = this.retries.get(directory);
    if (retry !== undefined) this.timers.clearTimeout(retry.timer);

    const generation = this.generation;
    const current: Snapshot = { buffered: [], again: false };
    this.snapshots.set(directory, current);

    let ok = false;
    try {
      const [statuses, permissions, questions] = await Promise.all([
        client.sessionStatus(directory),
        client.pendingPermissions(directory),
        client.pendingQuestions(directory),
      ]);
      if (generation !== this.generation) return;
      // Un pendiente de una sesion que no se rastrea puede ser de un sub-agente: se le busca la raiz una vez por foto.
      const rootIds = new Map<string, string | null>();
      const rootFor = (id: string): string | null => {
        if (this.tracked.has(id)) return id;
        if (!rootIds.has(id)) rootIds.set(id, this.rootOf(id));
        return rootIds.get(id) ?? null;
      };
      for (const [sessionId, session] of this.tracked) {
        if (session.directory !== directory) continue;
        session.status = statuses[sessionId] ?? 'idle';
        session.permissions = new Set(permissions.filter((item) => rootFor(item.sessionID) === sessionId).map((item) => item.id));
        session.questions = new Set(questions.filter((item) => item.sessionID === sessionId).map((item) => item.id));
        session.childQuestions = new Set(
          questions.filter((item) => item.sessionID !== sessionId && rootFor(item.sessionID) === sessionId).map((item) => item.id),
        );
        session.known = true;
        for (const routed of current.buffered) {
          if (routed.rootId === sessionId) applyEvent(session, routed);
        }
      }
      ok = true;
    } catch (error) {
      debugLog('opencode-serve', `la foto del estado fallo: ${error instanceof Error ? error.name : 'error'}`);
    } finally {
      if (this.snapshots.get(directory) === current) this.snapshots.delete(directory);
    }
    if (generation !== this.generation) return;

    if (ok) {
      this.retries.delete(directory);
      for (const [sessionId, session] of this.tracked) {
        if (session.directory === directory) this.notify(sessionId);
      }
      if (current.again) void this.snapshot(directory);
      return;
    }
    this.scheduleRetry(directory, generation);
  }

  private scheduleRetry(directory: string, generation: number): void {
    const attempt = this.retries.get(directory)?.attempt ?? 0;
    const delay = this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 5_000;
    const timer = this.timers.setTimeout(() => {
      if (generation !== this.generation) return;
      if (![...this.tracked.values()].some((session) => session.directory === directory)) return;
      void this.snapshot(directory);
    }, delay);
    this.retries.set(directory, { timer, attempt: attempt + 1 });
  }

  private isReady(sessionId: string): boolean {
    const status = this.current(sessionId);
    return status !== null && status.activity === 'idle';
  }

  private notify(sessionId: string): void {
    for (const subscription of [...this.subscriptions]) {
      if (subscription.sessionId === sessionId) this.deliver(subscription);
    }
    for (const waiter of [...this.waiters]) {
      if (waiter.sessionId === sessionId) waiter.check();
    }
  }

  private deliver(subscription: Subscription): void {
    let value: AgentStatus | null;
    if (this.client === null || !this.tracked.has(subscription.sessionId)) {
      value = null;
    } else {
      value = this.current(subscription.sessionId);
      // Rastreada pero sin foto todavia: no se dice nada hasta saber.
      if (value === null) return;
    }
    const offlineReason = value === null ? this.lost.get(subscription.sessionId) : undefined;
    const key = value === null ? `null|${offlineReason ?? ''}` : `${value.activity}|${value.waitingFor ?? ''}`;
    if (key === subscription.last) return;
    subscription.last = key;
    try {
      if (offlineReason === undefined) subscription.listener(value);
      else subscription.listener(value, offlineReason);
    } catch {
      // Un oyente que falla no deja sin aviso a los demas.
    }
  }
}
