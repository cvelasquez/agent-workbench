/**
 * El cliente HTTP del `opencode serve` (hito 29, §1 y §2 de la especificacion).
 *
 * Habla solo con `127.0.0.1`, con basic auth, y solo con las rutas que esta
 * app usa: crear una sesion, el estado de las sesiones, los permisos y las
 * preguntas pendientes, contestar una pregunta, cortar una sesion y el flujo de
 * eventos. Nada de `/config`, `/provider`, `/auth`, `/file` ni `/pty`.
 *
 * Reglas:
 *
 *  - **Toda peticion lleva `directory`** en la query. El `serve` separa los
 *    proyectos por eso; sin el dato responde por **su** carpeta, que es la
 *    vacia de D2, y una pregunta pendiente nunca aparece (A1).
 *  - **De un permiso se guarda el id y la sesion**, nada mas: `metadata` y
 *    `patterns` pueden traer rutas y comandos (§2).
 *  - **Un 401 es `ServeAuthError`, y una respuesta `text/html` es
 *    `ServeRouteError`**: la version de OpenCode no tiene esa ruta y la
 *    respuesta es la pagina de la interfaz web. Es la misma regla que el SDK
 *    del binario.
 *  - **Un id que no tiene la forma de siempre no se devuelve**: una sesion
 *    creada por API termina en la linea de comando de `attach`, detras de
 *    `cmd.exe /c` (§3.1 de CLAUDE.md).
 *
 * Ningun error cita la contrasena ni la cabecera de autorizacion.
 */

import { debugLog } from '../../debug.js';
import { OPENCODE_SESSION_ID_PATTERN } from './ids.js';
import type { ServeEndpoint } from './serve-process.js';
import { parseSseChunk, SSE_INITIAL_STATE } from './sse.js';

/** Plazo de una peticion. El flujo de eventos no lo tiene. */
export const SERVE_REQUEST_TIMEOUT_MS = 5_000;

/** Esperas antes de reconectar el flujo de eventos: 1, 2 y 5 s, y despues 5 s siempre. */
export const SERVE_RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 5_000]);

export type ServeSessionStatus = 'busy' | 'idle' | 'retry';

export interface PendingQuestion {
  id: string;
  sessionID: string;
  questions: { options: { label: string }[]; multiple: boolean; custom: boolean }[];
  tool: { messageID: string; callID: string } | null;
}

export interface PendingPermission {
  id: string;
  sessionID: string;
}

/** Los eventos de `/global/event` que se usan. El resto se descarta al leer. */
export type GlobalEvent =
  | { type: 'session.status'; directory: string; sessionId: string; status: ServeSessionStatus }
  | { type: 'permission.asked'; directory: string; sessionId: string; requestId: string }
  | { type: 'permission.replied'; directory: string; sessionId: string; requestId: string }
  | { type: 'question.asked'; directory: string; sessionId: string; requestId: string }
  | { type: 'question.replied'; directory: string; sessionId: string; requestId: string }
  | { type: 'question.rejected'; directory: string; sessionId: string; requestId: string };

/** El `serve` rechazo la contrasena. */
export class ServeAuthError extends Error {}

/** La respuesta fue la pagina de la interfaz web: esta version de OpenCode no tiene esa ruta. */
export class ServeRouteError extends Error {}

/** Cualquier otra respuesta que no sirve. */
export class ServeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

export interface ServeClientOptions {
  /** Para el chequeo: esperas mas cortas. */
  reconnectDelaysMs?: readonly number[];
  requestTimeoutMs?: number;
}

type FetchImpl = typeof fetch;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Un estado nativo desconocido cuenta como trabajando, como en `AgentStatus`. */
function statusOf(value: unknown): ServeSessionStatus | null {
  const type = asRecord(value)?.['type'];
  if (typeof type !== 'string') return null;
  return type === 'idle' || type === 'retry' ? type : 'busy';
}

function parsePendingQuestion(value: unknown): PendingQuestion | null {
  const record = asRecord(value);
  const id = asNonEmptyString(record?.['id']);
  const sessionID = asNonEmptyString(record?.['sessionID']);
  const rawQuestions = record?.['questions'];
  if (record === null || id === null || sessionID === null || !Array.isArray(rawQuestions)) return null;

  const questions: PendingQuestion['questions'] = [];
  for (const raw of rawQuestions) {
    const question = asRecord(raw);
    const rawOptions = question?.['options'];
    if (question === null || !Array.isArray(rawOptions)) return null;
    const options: { label: string }[] = [];
    for (const option of rawOptions) {
      const label = asRecord(option)?.['label'];
      if (typeof label !== 'string') return null;
      options.push({ label });
    }
    // Segun el binario: `multiple` es opcional (false) y `custom` "default: true".
    questions.push({ options, multiple: question['multiple'] === true, custom: question['custom'] !== false });
  }

  const tool = asRecord(record['tool']);
  const messageID = asNonEmptyString(tool?.['messageID']);
  const callID = asNonEmptyString(tool?.['callID']);
  return { id, sessionID, questions, tool: messageID !== null && callID !== null ? { messageID, callID } : null };
}

/** Un evento de `/global/event`, o null si no es uno de los que se usan o no tiene la forma esperada. */
export function parseGlobalEvent(data: string): GlobalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  const directory = typeof envelope?.['directory'] === 'string' ? envelope['directory'] : null;
  const payload = asRecord(envelope?.['payload']);
  const type = payload?.['type'];
  const properties = asRecord(payload?.['properties']);
  if (directory === null || typeof type !== 'string' || properties === null) return null;

  const sessionId = asNonEmptyString(properties['sessionID']);
  if (sessionId === null) return null;

  switch (type) {
    case 'session.status': {
      const status = statusOf(properties['status']);
      return status === null ? null : { type, directory, sessionId, status };
    }
    case 'permission.asked':
    case 'question.asked': {
      const requestId = asNonEmptyString(properties['id']);
      return requestId === null ? null : { type, directory, sessionId, requestId };
    }
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected': {
      const requestId = asNonEmptyString(properties['requestID']);
      return requestId === null ? null : { type, directory, sessionId, requestId };
    }
    default:
      return null;
  }
}

/** La URL base, solo si es `http://127.0.0.1:<puerto>` sin nada mas. Si no, lanza. */
function loopbackBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The OpenCode server URL isn't valid.");
  }
  const bare = parsed.pathname === '/' && parsed.search === '' && parsed.hash === '' && parsed.username === '' && parsed.password === '';
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port === '' || !bare) {
    throw new Error('The OpenCode server has to listen on http://127.0.0.1.');
  }
  return `http://127.0.0.1:${parsed.port}`;
}

export class OpenCodeServeClient {
  private readonly base: string;
  private readonly authorization: string;
  private readonly fetchImpl: FetchImpl;
  private readonly reconnectDelaysMs: readonly number[];
  private readonly requestTimeoutMs: number;

  /** Lanza si el host no es `127.0.0.1`. */
  constructor(
    readonly endpoint: ServeEndpoint,
    fetchImpl?: FetchImpl,
    options: ServeClientOptions = {},
  ) {
    this.base = loopbackBase(endpoint.url);
    this.authorization = `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`, 'utf8').toString('base64')}`;
    this.fetchImpl = fetchImpl ?? ((input, init) => fetch(input, init));
    this.reconnectDelaysMs = options.reconnectDelaysMs ?? SERVE_RECONNECT_DELAYS_MS;
    this.requestTimeoutMs = options.requestTimeoutMs ?? SERVE_REQUEST_TIMEOUT_MS;
  }

  /** Crea una sesion vacia en esa carpeta y devuelve su id, validado (D6). */
  async createSession(directory: string): Promise<string> {
    const body = asRecord(await this.request('POST', '/session', directory, {}));
    const id = body?.['id'];
    if (typeof id !== 'string' || !OPENCODE_SESSION_ID_PATTERN.test(id)) {
      throw new ServeRequestError('The OpenCode server returned a session id with an unexpected shape.', null);
    }
    return id;
  }

  /** Las sesiones con estado en esa carpeta. Una que no esta, esta libre. */
  async sessionStatus(directory: string): Promise<Record<string, ServeSessionStatus>> {
    const body = asRecord(await this.request('GET', '/session/status', directory));
    const result: Record<string, ServeSessionStatus> = {};
    for (const [sessionId, value] of Object.entries(body ?? {})) {
      const status = statusOf(value);
      if (status !== null) result[sessionId] = status;
    }
    return result;
  }

  /** Permisos pendientes: solo id y sesion. */
  async pendingPermissions(directory: string): Promise<PendingPermission[]> {
    const body = await this.request('GET', '/permission', directory);
    if (!Array.isArray(body)) return [];
    const result: PendingPermission[] = [];
    for (const raw of body) {
      const record = asRecord(raw);
      const id = asNonEmptyString(record?.['id']);
      const sessionID = asNonEmptyString(record?.['sessionID']);
      if (id !== null && sessionID !== null) result.push({ id, sessionID });
    }
    return result;
  }

  async pendingQuestions(directory: string): Promise<PendingQuestion[]> {
    const body = await this.request('GET', '/question', directory);
    if (!Array.isArray(body)) return [];
    return body.map(parsePendingQuestion).filter((question): question is PendingQuestion => question !== null);
  }

  /** `answers[i]`: las etiquetas elegidas en la pregunta i, o el texto escrito. */
  async replyQuestion(directory: string, requestId: string, answers: string[][]): Promise<void> {
    await this.request('POST', `/question/${encodeURIComponent(requestId)}/reply`, directory, { answers });
  }

  /** Corta lo que la sesion este haciendo (D13). */
  async abort(directory: string, sessionId: string): Promise<void> {
    if (!OPENCODE_SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid OpenCode session id.');
    await this.request('POST', `/session/${sessionId}/abort`, directory, {});
  }

  /**
   * El flujo de `/global/event`. Reconecta con las esperas de
   * `SERVE_RECONNECT_DELAYS_MS` y llama `onReconnect` **cada vez que la conexion
   * queda abierta, tambien la primera**: lo que paso antes de abrirla no llego
   * por aca, y quien lleva el estado tiene que rehacer la foto. Devuelve con
   * que cerrarlo.
   */
  events(onEvent: (event: GlobalEvent) => void, onReconnect: () => void): () => void {
    const controller = new AbortController();
    let closed = false;
    let wake: (() => void) | null = null;
    let waitTimer: NodeJS.Timeout | null = null;

    const pause = (ms: number): Promise<void> =>
      new Promise<void>((resolve) => {
        wake = resolve;
        const timer = setTimeout(resolve, ms);
        timer.unref();
        waitTimer = timer;
      });

    const run = async (): Promise<void> => {
      let failures = 0;
      while (!closed) {
        try {
          const response = await this.fetchImpl(`${this.base}/global/event`, {
            method: 'GET',
            headers: { Authorization: this.authorization, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          this.checkResponse(response, '/global/event');
          const body = response.body;
          if (body === null) throw new ServeRequestError('The event stream arrived without a body.', response.status);
          failures = 0;
          try {
            onReconnect();
          } catch {
            // Quien rehace la foto no corta el flujo.
          }
          const reader = body.getReader();
          let state = SSE_INITIAL_STATE;
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            const parsed = parseSseChunk(state, value);
            state = parsed.state;
            for (const message of parsed.messages) {
              const event = parseGlobalEvent(message.data);
              if (event === null) continue;
              try {
                onEvent(event);
              } catch {
                // Un oyente que falla no corta el flujo.
              }
            }
          }
        } catch (error) {
          if (closed) return;
          debugLog('opencode-serve', `event stream cut: ${error instanceof Error ? error.name : 'error'}`);
        }
        if (closed) return;
        const delays = this.reconnectDelaysMs;
        const delay = delays[Math.min(failures, delays.length - 1)] ?? 5_000;
        failures++;
        await pause(delay);
      }
    };
    void run();

    return () => {
      if (closed) return;
      closed = true;
      controller.abort();
      if (waitTimer !== null) clearTimeout(waitTimer);
      const resolve = wake as (() => void) | null;
      resolve?.();
    };
  }

  private checkResponse(response: Response, route: string): void {
    if (response.status === 401) throw new ServeAuthError('The OpenCode server rejected the password.');
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      throw new ServeRouteError(`This OpenCode version doesn't have the route ${route}.`);
    }
    if (!response.ok) {
      throw new ServeRequestError(`The OpenCode server answered ${response.status} on ${route}.`, response.status);
    }
  }

  private async request(method: 'GET' | 'POST', route: string, directory: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: this.authorization, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await this.fetchImpl(`${this.base}${route}?directory=${encodeURIComponent(directory)}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    try {
      this.checkResponse(response, route);
    } finally {
      if (!response.ok || (response.headers.get('content-type') ?? '').includes('text/html')) {
        await response.body?.cancel().catch(() => {});
      }
    }
    const text = await response.text();
    if (text.length === 0) return null;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ServeRequestError(`The OpenCode server answered something that isn't JSON on ${route}.`, response.status);
    }
  }
}
