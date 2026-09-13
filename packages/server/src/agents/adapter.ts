/**
 * La interfaz de un adaptador de CLI.
 *
 * Todo lo que el servidor sabe de una CLI concreta —como se lanza, que entorno
 * necesita, donde guarda su historial, como se lee, como avisa su estado— vive
 * detras de esto. El codigo generico (registro de terminales, hub de
 * conversaciones, indice, socket) habla con un `AgentAdapter` y no nombra
 * ninguna CLI.
 *
 * Tres reglas que cada adaptador cumple, y que la interfaz no puede imponer
 * sola:
 *
 *  - **El entorno nunca gana variables.** `environment()` solo puede quitar, y
 *    cada quita que el usuario tenga que conocer se declara como `notice`. Nada
 *    de autenticacion, jamas (regla 2.1).
 *  - **El historial nativo se lee y no se escribe.** Cada fuente declara lo que
 *    lee de la carpeta de su CLI; ninguna escribe ahi.
 *  - **Una capacidad es una medida, no una promesa.** Lo que el adaptador no
 *    declara, la interfaz lo esconde.
 */

import type {
  AgentCapabilities,
  AgentDefaults,
  AgentId,
  ContextUsage,
  ConversationEvent,
  ConversationImageSource,
  ConversationPart,
  ConversationState,
  EnvironmentNoticeId,
  PermissionMode,
  PlanContent,
  SessionPlan,
  SessionSummary,
} from '@agent-workbench/shared';
import type { CliLocation } from './locate.js';

// ---- Localizacion -----------------------------------------------------------

export type { CliLocation } from './locate.js';

// ---- Lanzamiento ------------------------------------------------------------

export interface LaunchInput {
  location: CliLocation;
  cwd: string;
  /** Sesion que YA existe en el historial nativo y se reanuda. */
  resumeSessionId: string | null;
  /**
   * Id que la app propone para una sesion nueva. Lo usa quien declara
   * `sessionIdAtLaunch`; el resto lo ignora. Al despertar una pestana sin
   * archivo es el id que la pestana ya tenia.
   */
  proposedSessionId: string;
}

export type LaunchSession =
  | { kind: 'known'; sessionId: string }
  /** La CLI pone el id y se descubre despues. En este hito nadie lo devuelve. */
  | { kind: 'discover' };

export interface LaunchPlan {
  /** Lo ejecutable, igual que `LaunchSpec` de pty-session. `prefixArgs` ya incluidos. */
  file: string;
  args: readonly string[];
  session: LaunchSession;
}

export interface AgentEnvironment {
  /** Copia del entorno base, con lo que el adaptador quita. Nunca agrega. */
  env: Record<string, string>;
  /** Aviso si quito algo que el usuario tiene que saber. */
  notice: EnvironmentNoticeId | null;
}

/** Lo que recibe el gancho posterior al lanzamiento. */
export interface SpawnedContext {
  terminalId: string;
  sessionId: string;
  /** true si ESTE lanzamiento es una reanudacion, no si la pestana dice `resumed`. */
  resumed: boolean;
  /** Pid del proceso de la pty. Con un shim `.cmd` es el del interprete. */
  pid: number;
  /** Epoch ms del lanzamiento. Punto de partida para descubrir una sesion. */
  launchedAt: number;
  readOutput(): string;
  /** false si la terminal ya no esta. */
  write(data: string): boolean;
  onDone(outcome: string): void;
  /**
   * Avisa el id de sesion descubierto despues de lanzar. Lo implementa el
   * registro de terminales; ninguna CLI con `sessionIdAtLaunch` lo llama.
   */
  reportSessionId(sessionId: string): void;
}

// ---- Historial ----------------------------------------------------------------

export interface HistoryRoot {
  /** Absoluta. */
  path: string;
  /** `depth` de chokidar. */
  depth: number;
  /** Filtro de eventos del watcher. */
  accepts(filePath: string): boolean;
  awaitWriteFinish: { stabilityThreshold: number; pollInterval: number } | false;
}

/** Una sesion enumerada, sin leer su contenido. */
export interface HistoryItem {
  /** Opaca para el indice. Claude Code: ruta absoluta del `.jsonl`. */
  ref: string;
  sessionId: string;
  /** Agrupador nativo. Claude Code: la carpeta-slug. Respaldo del `cwd`. */
  group: string;
  mtimeMs: number;
  sizeBytes: number;
}

/** JSON serializable. Va a la cache del indice tal cual. */
export type HistoryExtra = Record<string, unknown>;

/** Lo que el indice guarda de cada sesion y completa al emitir. */
export type ScannedSummary = Omit<SessionSummary, 'agent' | 'cwd' | 'archived'>;

export interface ScannedSession {
  /** El `cwd` del archivo, o null si no trae. Es tambien el `cwd` del resumen. */
  cwd: string | null;
  /** Sin `agent`, `cwd` ni `archived`: los pone el indice. */
  summary: ScannedSummary;
  extra: HistoryExtra;
}

export interface PlanSource {
  describe(fileNames: readonly string[]): Promise<SessionPlan[]>;
  read(fileName: string): Promise<PlanContent | null>;
}

export interface EventPage {
  events: ConversationEvent[];
  hasMore: boolean;
}

/** Cuanto tardo un turno que ya se habia entregado. */
export interface TurnUpdate {
  eventId: string;
  durationMs: number;
}

/**
 * Las partes de un evento que ya se habia entregado, rehechas.
 *
 * Mismo caso que `TurnUpdate` y por el mismo motivo: la linea `attachment` con
 * la imagen llega **despues** del mensaje que la lleva. Casi siempre en la
 * linea inmediatamente siguiente —medido: 17 de 17— y por lo tanto en la misma
 * lectura, pero un poll puede caer justo en el medio.
 */
export interface PartsUpdate {
  eventId: string;
  parts: ConversationPart[];
}

export interface PollResult {
  /** true si el archivo se reemplazo: el cliente tiene que rehacer su vista. */
  reset: boolean;
  added: ConversationEvent[];
  /**
   * Duraciones de turnos ya entregados.
   *
   * Van aparte de `added` porque llegan **despues** del mensaje al que
   * pertenecen: la CLI escribe la duracion en la linea siguiente, que casi
   * siempre cae en la misma lectura, pero no siempre. Reenviar el evento entero
   * obligaria al cliente a deduplicar; una actualizacion suelta se aplica y
   * ya.
   */
  turns: TurnUpdate[];
  /**
   * Planes que esta conversacion nombro y no estaban antes.
   *
   * Van aparte de los eventos porque no son una tarjeta del hilo: el plan se ve
   * en su propia solapa, y lo que lo anuncia en el JSONL —una linea `plan_mode`
   * o un `Write` a la carpeta de planes— ya se dibuja como lo que es.
   */
  plans: string[];
  /** Eventos ya entregados a los que se les agrego una imagen adjunta. */
  parts: PartsUpdate[];
}

export interface LoadedImage {
  mediaType: string;
  /** base64, tal como estaba en el archivo. */
  data: string;
}

/**
 * Seguimiento de UNA sesion.
 *
 * Es exactamente lo que el hub usa del seguidor, mas lo que el hub hacia por
 * fuera con la configuracion (ahora adentro de `start` y `poll`).
 */
export interface SessionFollower {
  /** Para logs. Claude Code: la ruta del archivo. */
  readonly label: string;
  /**
   * Antes de la primera lectura. Claude Code: lee la configuracion y fija el
   * alias, para que el medidor no muestre 200k y despues 1M. No lanza.
   */
  start(): Promise<void>;
  /**
   * Lee lo nuevo. Claude Code: si paso un `/model`, relee la configuracion y
   * rehace modelo y ventana ANTES de devolver. Lanza si el origen es ilegible.
   */
  poll(): Promise<PollResult>;
  getState(): ConversationState;
  getUsage(): ContextUsage;
  getPermissionMode(): PermissionMode | null;
  getTail(limit: number): EventPage;
  getPageBefore(beforeEventId: string, limit: number): EventPage;
  /** Planes nombrados por la conversacion, en orden. [] si no hay capacidad. */
  getPlanFiles(): readonly string[];
  readImage(
    eventId: string,
    index: number,
    source: ConversationImageSource,
  ): Promise<LoadedImage | null>;
  /**
   * Aviso del watcher de SU adaptador. true si hay que releer.
   * Claude Code: la ruta es la suya, o es el re-apuntado de respaldo.
   */
  noticeChange(filePath: string): boolean;
}

export interface HistorySource {
  roots(): readonly HistoryRoot[];
  /** Todo lo que hay, en orden estable. null si la raiz no existe. */
  list(): Promise<HistoryItem[] | null>;
  /**
   * Que sesiones pudo cambiar un aviso del watcher. null si la ruta no es de
   * esta fuente.
   *
   * Es una lista, y asincrona, porque no toda CLI escribe un archivo por sesion:
   * con una base compartida, un cambio no dice cual cambio y hay que
   * preguntarle. Claude Code devuelve la propia ruta.
   */
  changedRefs(filePath: string): Promise<readonly string[] | null>;
  /** Estado actual de una ref. null si ya no existe. */
  item(ref: string): Promise<HistoryItem | null>;
  scan(item: HistoryItem): Promise<ScannedSession>;
  /** Una entrada salio valida de la cache: el adaptador recupera lo que aprendia al escanearla. */
  restored(item: HistoryItem, extra: HistoryExtra): void;
  /** ¿Hay algo que reanudar? Decide entre reanudar y sesion nueva al despertar. */
  exists(cwd: string, sessionId: string): Promise<boolean>;
  follow(target: { cwd: string; sessionId: string }): SessionFollower;
  readonly plans: PlanSource | null;
}

// ---- Estado del proceso -------------------------------------------------------

export interface AgentStatus {
  /** Ya traducido. Un valor nativo desconocido es 'busy'. */
  activity: 'busy' | 'idle' | 'waiting';
  /** Etiqueta cruda cuando `activity` es 'waiting'; null si no la trae. */
  waitingFor: string | null;
}

export interface StatusSource {
  /** `listener(null)` = no hay proceso registrado. El registro lo pinta 'offline'. */
  subscribe(sessionId: string, listener: (status: AgentStatus | null) => void): () => void;
  /** true si llego a "lista para recibir" dentro del plazo. */
  waitUntilReady(sessionId: string, timeoutMs: number): Promise<boolean>;
  dispose(): void;
}

// ---- El adaptador ---------------------------------------------------------------

export interface AgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  readonly command: string;
  readonly installUrl: string;
  readonly capabilities: AgentCapabilities;

  locate(): Promise<CliLocation | null>;
  /** Texto cuando no esta. */
  missingMessage(): string;
  launch(input: LaunchInput): LaunchPlan;
  /**
   * El entorno del proceso de la CLI.
   *
   * REGLA DURA: un adaptador **nunca** agrega variables; solo puede quitar, y
   * cada quita que el usuario tenga que conocer se declara como `notice`. Nada
   * de ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ni CLAUDE_CODE_OAUTH_TOKEN, ni
   * de ninguna credencial de ninguna CLI: si el usuario no esta logueado, lo
   * resuelve dentro de la terminal y la app ni se entera.
   */
  environment(base: NodeJS.ProcessEnv): AgentEnvironment;
  /** Gancho posterior al lanzamiento. Devuelve como cancelarlo, o null. */
  onSpawned(context: SpawnedContext): (() => void) | null;

  readonly history: HistorySource;
  readonly status: StatusSource | null;
  defaults(cwd: string): Promise<AgentDefaults | null>;
  /** Carpetas que el selector de directorios no lista ni deja entrar. */
  protectedDirs(): readonly string[];
  dispose(): void;
}
