/**
 * El cliente HTTP del `opencode serve` (hito 29, §1 y §2 de la especificacion).
 * OpenCode 1 conserva su contrato; OpenCode 2 se traduce a los mismos tipos
 * internos usando las rutas /api y los eventos session.execution.*.
 *
 * Habla solo con `127.0.0.1`, con basic auth, y solo con las rutas que esta
 * app usa: crear una sesion, el estado de las sesiones, los permisos y las
 * preguntas pendientes, contestar una pregunta, cortar una sesion y el flujo de
 * eventos; desde el hito 52, mandar un mensaje programado (`prompt_async`,
 * §11.16); desde el hito 55, pasar una sesion a otra carpeta (`move-session`,
 * con su especificacion `/doc` para saber si esta, §11.17). Nada de
 * `/config`, `/provider`, `/auth`, `/file` ni `/pty`.
 *
 * OpenCode 2.2.7 usa /api, location[directory] y formularios. Se normaliza
 * ese contrato aca, manteniendo los tipos internos y el cliente de OpenCode 1.
 *
 * Reglas:
 *
 *  - **En V1 toda peticion lleva `directory`** en la query. El `serve` separa los
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
import type { OpenCodeProtocol } from './compatibility.js';
import type { ServeEndpoint } from './serve-process.js';
import { parseSseChunk, SSE_INITIAL_STATE } from './sse.js';

/** Plazo de una peticion. El flujo de eventos no lo tiene. */
export const SERVE_REQUEST_TIMEOUT_MS = 5_000;

/** Esperas antes de reconectar el flujo de eventos: 1, 2 y 5 s, y despues 5 s siempre. */
export const SERVE_RECONNECT_DELAYS_MS: readonly number[] = Object.freeze([1_000, 2_000, 5_000]);

/**
 * Hito 55 (§11.17). La ruta experimental que pasa una sesion a otra carpeta, la
 * unica de las que mide la app que OpenCode marca como experimental: por eso se
 * busca en su especificacion antes de cada mudanza.
 */
export const OPENCODE_MOVE_SESSION_ROUTE = '/experimental/control-plane/move-session';

/** Plazo de leer la especificacion (`/doc`), que es grande, y de mover una sesion. */
const SERVE_SLOW_REQUEST_TIMEOUT_MS = 30_000;

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

interface FormQuestionField {
  key: string;
  multiple: boolean;
  custom: boolean;
  required: boolean;
  options: { label: string; value: string }[];
}

interface PendingForm {
  sessionId: string;
  fields: FormQuestionField[];
}

/** Lo que se repite del ultimo mensaje del usuario al mandar uno por `prompt_async` (hito 52). */
export interface OpenCodePromptChoice {
  agent: string | null;
  providerID: string | null;
  modelID: string | null;
  variant: string | null;
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

function responseData(value: unknown, route: string): unknown {
  const record = asRecord(value);
  if (record === null || !Object.hasOwn(record, 'data')) {
    throw new ServeRequestError(`The OpenCode server returned an unexpected response on ${route}.`, null);
  }
  return record['data'];
}

/**
 * El motivo de un rechazo de `move-session` (hito 55), y nada mas: `data.message`
 * de un `MoveSessionError` o `message` de un `InvalidRequestError`, cortado.
 */
function moveRejection(text: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(parsed);
  const message = asNonEmptyString(asRecord(record?.['data'])?.['message']) ?? asNonEmptyString(record?.['message']);
  return message === null ? null : message.replace(/\s+/g, ' ').trim().slice(0, 300);
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

/** Solo la herramienta question nativa tiene una tarjeta equivalente a la de V1. */
function parsePendingForm(value: unknown): { question: PendingQuestion; form: PendingForm | null } | null {
  const record = asRecord(value);
  const id = asNonEmptyString(record?.['id']);
  const sessionID = asNonEmptyString(record?.['sessionID']);
  if (record === null || id === null || sessionID === null) return null;
  const fallback = { question: { id, sessionID, questions: [], tool: null }, form: null };
  const metadata = asRecord(record['metadata']);
  const tool = asRecord(metadata?.['tool']);
  const messageID = asNonEmptyString(tool?.['messageID']);
  const callID = asNonEmptyString(tool?.['id']);
  const rawFields = record['fields'];
  if (metadata?.['kind'] !== 'question' || messageID === null || callID === null ||
      !Array.isArray(rawFields) || rawFields.length === 0 || !OPENCODE_SESSION_ID_PATTERN.test(sessionID)) return fallback;
  const fields: FormQuestionField[] = [];
  const keys = new Set<string>();
  for (const raw of rawFields) {
    const field = asRecord(raw);
    const key = asNonEmptyString(field?.['key']);
    const type = field?.['type'];
    if (field === null || key === null || keys.has(key) || (type !== 'string' && type !== 'multiselect') ||
        field['hidden'] === true || (field['when'] !== undefined && (!Array.isArray(field['when']) || field['when'].length > 0)) ||
        ['format', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems'].some((name) => field[name] !== undefined) ||
        !Array.isArray(field['options'])) return fallback;
    const options: FormQuestionField['options'] = [];
    const labels = new Set<string>();
    for (const rawOption of field['options']) {
      const option = asRecord(rawOption);
      const label = option?.['label'];
      const value = option?.['value'];
      if (typeof label !== 'string' || typeof value !== 'string' || labels.has(label)) return fallback;
      labels.add(label);
      options.push({ label, value });
    }
    keys.add(key);
    fields.push({ key, multiple: type === 'multiselect', custom: field['custom'] === true, required: field['required'] === true, options });
  }
  return {
    question: { id, sessionID, tool: { messageID, callID }, questions: fields.map((field) => ({
      options: field.options.map(({ label }) => ({ label })), multiple: field.multiple, custom: field.custom,
    })) },
    form: { sessionId: sessionID, fields },
  };
}

/** Un evento de `/global/event`, o null si no es uno de los que se usan o no tiene la forma esperada. */
export function parseGlobalEvent(data: string, protocol: OpenCodeProtocol = 1): GlobalEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const envelope = asRecord(parsed);
  if (protocol === 2) return parseV2Event(envelope);
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

function parseV2Event(envelope: Record<string, unknown> | null): GlobalEvent | null {
  const location = asRecord(envelope?.['location']);
  const directory = typeof location?.['directory'] === 'string' ? location['directory'] : '';
  const properties = asRecord(envelope?.['data']);
  const type = envelope?.['type'];
  if (properties === null) return null;
  if (type === 'form.created') {
    const form = asRecord(properties['form']);
    const sessionId = asNonEmptyString(form?.['sessionID']);
    const requestId = asNonEmptyString(form?.['id']);
    return sessionId === null || requestId === null ? null : { type: 'question.asked', directory, sessionId, requestId };
  }
  const sessionId = asNonEmptyString(properties['sessionID']);
  if (sessionId === null) return null;
  switch (type) {
    case 'session.execution.started':
      return { type: 'session.status', directory, sessionId, status: 'busy' };
    case 'session.execution.succeeded':
    case 'session.execution.failed':
    case 'session.execution.interrupted':
      return { type: 'session.status', directory, sessionId, status: 'idle' };
    case 'session.status': {
      const status = statusOf(properties['status']);
      return status === null ? null : { type, directory, sessionId, status };
    }
    case 'session.idle':
      return { type: 'session.status', directory, sessionId, status: 'idle' };
    case 'permission.asked':
    case 'permission.replied': {
      const requestId = asNonEmptyString(properties[type === 'permission.asked' ? 'id' : 'requestID']);
      return requestId === null ? null : { type, directory, sessionId, requestId };
    }
    case 'form.replied':
    case 'form.cancelled': {
      const requestId = asNonEmptyString(properties['id']);
      return requestId === null ? null : { type: type === 'form.replied' ? 'question.replied' : 'question.rejected', directory, sessionId, requestId };
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
  /** Solo formularios pendientes y representables; las fotos nuevas invalidan los anteriores. */
  private readonly pendingForms = new Map<string, PendingForm>();

  private get v2(): boolean { return this.endpoint.protocol === 2; }

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
    const response = asRecord(await this.request('POST', this.v2 ? '/api/session' : '/session', directory, this.v2 ? { location: { directory } } : {}));
    const body = this.v2 ? asRecord(responseData(response, '/api/session')) : response;
    const id = body?.['id'];
    if (typeof id !== 'string' || !OPENCODE_SESSION_ID_PATTERN.test(id)) {
      throw new ServeRequestError('The OpenCode server returned a session id with an unexpected shape.', null);
    }
    return id;
  }

  /** Las sesiones con estado en esa carpeta. Una que no esta, esta libre. */
  async sessionStatus(directory: string): Promise<Record<string, ServeSessionStatus>> {
    const response = asRecord(await this.request('GET', this.v2 ? '/api/session/active' : '/session/status', directory));
    const body = this.v2 ? asRecord(responseData(response, '/api/session/active')) : response;
    if (this.v2 && body === null) throw new ServeRequestError('The OpenCode server returned an unexpected active session map.', null);
    const result: Record<string, ServeSessionStatus> = {};
    for (const [sessionId, value] of Object.entries(body ?? {})) {
      const status = this.v2 && asRecord(value)?.['type'] === 'running' ? 'busy' : statusOf(value);
      if (status !== null) result[sessionId] = status;
    }
    return result;
  }

  /** Permisos pendientes: solo id y sesion. */
  async pendingPermissions(directory: string): Promise<PendingPermission[]> {
    const response = await this.request('GET', this.v2 ? '/api/permission/request' : '/permission', directory);
    const body = this.v2 ? responseData(response, '/api/permission/request') : response;
    if (this.v2 && !Array.isArray(body)) throw new ServeRequestError('The OpenCode server returned an unexpected permission list.', null);
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
    const response = await this.request('GET', this.v2 ? '/api/form' : '/question', directory);
    const body = this.v2 ? responseData(response, '/api/form') : response;
    if (this.v2 && !Array.isArray(body)) throw new ServeRequestError('The OpenCode server returned an unexpected form list.', null);
    if (!Array.isArray(body)) return [];
    if (this.v2) {
      const prefix = `${JSON.stringify(directory)}:`;
      for (const key of this.pendingForms.keys()) if (key.startsWith(prefix)) this.pendingForms.delete(key);
      const result: PendingQuestion[] = [];
      for (const value of body) {
        const parsed = parsePendingForm(value);
        if (parsed === null) continue;
        result.push(parsed.question);
        if (parsed.form !== null) {
          if (this.pendingForms.size >= 1024) this.pendingForms.delete(this.pendingForms.keys().next().value!);
          this.pendingForms.set(`${prefix}${parsed.question.id}`, parsed.form);
        }
      }
      return result;
    }
    return body.map(parsePendingQuestion).filter((question): question is PendingQuestion => question !== null);
  }

  /** `answers[i]`: las etiquetas elegidas en la pregunta i, o el texto escrito. */
  async replyQuestion(directory: string, requestId: string, answers: string[][]): Promise<void> {
    if (this.v2) {
      const key = `${JSON.stringify(directory)}:${requestId}`;
      const form = this.pendingForms.get(key);
      if (form === undefined || answers.length !== form.fields.length) {
        throw new ServeRequestError('This OpenCode form must be answered in its terminal.', null);
      }
      const answer: Record<string, string | string[]> = Object.create(null) as Record<string, string | string[]>;
      for (let index = 0; index < form.fields.length; index++) {
        const field = form.fields[index]!;
        const selected = answers[index]!;
        if (!Array.isArray(selected) || (!field.multiple && selected.length > 1) || (field.required && selected.length === 0)) {
          throw new ServeRequestError('The OpenCode form answer is not valid.', null);
        }
        // La herramienta nativa convierte una key ausente en pregunta omitida.
        if (selected.length === 0 && !field.required) continue;
        const values = selected.map((label) => {
          if (typeof label !== 'string') throw new ServeRequestError('The OpenCode form answer is not valid.', null);
          const option = field.options.find((item) => item.label === label);
          if (option === undefined && !field.custom) throw new ServeRequestError('The OpenCode form answer is not valid.', null);
          return option?.value ?? label;
        });
        answer[field.key] = field.multiple ? values : values[0]!;
      }
      await this.request('POST', `/api/session/${form.sessionId}/form/${encodeURIComponent(requestId)}/reply`, directory, { answer });
      this.pendingForms.delete(key);
      return;
    }
    await this.request('POST', `/question/${encodeURIComponent(requestId)}/reply`, directory, { answers });
  }

  /** Corta lo que la sesion este haciendo (D13). */
  async abort(directory: string, sessionId: string): Promise<void> {
    if (!OPENCODE_SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid OpenCode session id.');
    await this.request('POST', this.v2 ? `/api/session/${sessionId}/interrupt` : `/session/${sessionId}/abort`, directory, this.v2 ? { resume: false } : {});
  }

  /**
   * Hito 52 (§11.16). Manda un mensaje a la sesion sin esperar la respuesta:
   * `POST /session/{id}/prompt_async`, que contesta 204 y deja el mensaje en la
   * base en el acto; el TUI enganchado lo muestra como uno mas (medido con la
   * 1.19.4, a los ~2 s). Sin agente, OpenCode usa el predeterminado y no el de
   * la conversacion: por eso se le pasan el agente, el modelo y la variante del
   * ultimo mensaje del usuario, si se conocen. `not-sent` si la sesion no existe
   * (404): no se mando nada. Otro fallo lanza: no se sabe si lo tomo.
   * V2 conserva agente y modelo en la sesion; prompt admite el texto y su
   * entrega en cola, y devuelve 200 con el item admitido sin esperar al modelo.
   */
  async promptAsync(
    directory: string,
    sessionId: string,
    text: string,
    choice: OpenCodePromptChoice | null,
  ): Promise<'sent' | 'not-sent'> {
    if (!OPENCODE_SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid OpenCode session id.');
    const body: Record<string, unknown> = this.v2 ? { text, delivery: 'queue' } : { parts: [{ type: 'text', text }] };
    if (!this.v2) {
      if (choice?.agent) body['agent'] = choice.agent;
      if (choice?.providerID && choice.modelID) body['model'] = { providerID: choice.providerID, modelID: choice.modelID };
      if (choice?.variant) body['variant'] = choice.variant;
    }
    try {
      await this.request('POST', this.v2 ? `/api/session/${sessionId}/prompt` : `/session/${sessionId}/prompt_async`, directory, body);
      return 'sent';
    } catch (error) {
      if (error instanceof ServeRequestError && error.status === 404) return 'not-sent';
      throw error;
    }
  }

  /**
   * El flujo de `/global/event` (V1) o `/api/event` (V2). Reconecta con las esperas de
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
          const route = this.v2 ? '/api/event' : '/global/event';
          const response = await this.fetchImpl(`${this.base}${route}`, {
            method: 'GET',
            headers: { Authorization: this.authorization, Accept: 'text/event-stream' },
            signal: controller.signal,
          });
          this.checkResponse(response, route);
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
              const event = parseGlobalEvent(message.data, this.v2 ? 2 : 1);
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

  /**
   * Hito 55 (§11.17). true si este `serve` tiene la ruta que pasa una sesion a
   * otra carpeta: se busca en su propia especificacion (`/doc`), que no cambia
   * nada. Una version sin `/doc` tampoco la tiene.
   */
  async canMoveSession(directory: string): Promise<boolean> {
    // En 2.2.7 move es parte del contrato publicado y no hay /doc de V1.
    if (this.v2) return true;
    let spec: unknown;
    try {
      spec = await this.request('GET', '/doc', directory, undefined, SERVE_SLOW_REQUEST_TIMEOUT_MS);
    } catch (error) {
      if (error instanceof ServeRouteError) return false;
      throw error;
    }
    const route = asRecord(asRecord(asRecord(spec)?.['paths'])?.[OPENCODE_MOVE_SESSION_ROUTE]);
    return asRecord(route?.['post']) !== null;
  }

  /**
   * Hito 55 (§11.17). Pasa la sesion a la carpeta `to` sin llevarse cambios
   * (`moveChanges: false`): lo sin commit queda donde estaba, como con las demas
   * CLIs. Medido con la 1.19.4 y la 1.19.5: responde 204, el id no cambia,
   * `session.directory` pasa a ser `to`, y el agente trabaja ahi desde el
   * mensaje siguiente. De un rechazo (400) se cita solo su mensaje.
   */
  async moveSession(directory: string, sessionId: string, to: string): Promise<void> {
    if (!OPENCODE_SESSION_ID_PATTERN.test(sessionId)) throw new Error('Invalid OpenCode session id.');
    if (this.v2) {
      await this.request('POST', `/api/session/${sessionId}/move`, directory, { directory: to, delivery: 'queue' }, SERVE_SLOW_REQUEST_TIMEOUT_MS);
      return;
    }
    const route = OPENCODE_MOVE_SESSION_ROUTE;
    const response = await this.fetchImpl(`${this.base}${route}?directory=${encodeURIComponent(directory)}`, {
      method: 'POST',
      headers: { Authorization: this.authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionID: sessionId, destination: { directory: to }, moveChanges: false }),
      signal: AbortSignal.timeout(SERVE_SLOW_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 400 && !(response.headers.get('content-type') ?? '').includes('text/html')) {
      const reason = moveRejection(await response.text().catch(() => ''));
      throw new ServeRequestError(`OpenCode didn't move the session${reason === null ? '' : `: ${reason}`}`, 400);
    }
    try {
      this.checkResponse(response, route);
    } finally {
      await response.body?.cancel().catch(() => {});
    }
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

  private async request(
    method: 'GET' | 'POST',
    route: string,
    directory: string,
    body?: unknown,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<unknown> {
    const headers: Record<string, string> = { Authorization: this.authorization, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const query = this.v2
      ? route === '/api/form' || route === '/api/permission/request' ? `?location%5Bdirectory%5D=${encodeURIComponent(directory)}` : ''
      : `?directory=${encodeURIComponent(directory)}`;
    const response = await this.fetchImpl(`${this.base}${route}${query}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
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
