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
  ImageReferenceStyle,
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
  /**
   * La CLI pone el id y se descubre despues: la pestana nace con `sessionId ''`
   * y el gancho de `onSpawned` lo avisa con `reportSessionId`. Es lo que
   * devuelve Codex en una sesion nueva.
   */
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
  /** `''` si la sesion se descubre despues (`LaunchSession` de tipo `discover`). */
  sessionId: string;
  /** El `cwd` de la pty. Con el se casa una sesion descubierta con su pestana. */
  cwd: string;
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

/**
 * Lo que devuelve el gancho posterior al lanzamiento.
 *
 * Cuatro momentos distintos, y por eso cuatro miembros: soltarlo sin mas,
 * avisarle que el proceso termino, que alguien escribio en la pty, y que texto
 * le mando la app. Los tres ultimos son opcionales: el contestador del dialogo
 * de reanudar de Claude Code solo necesita el primero. Como el registro
 * reparte cada momento lo explica `launch-hook-slot.ts`.
 */
export interface LaunchHook {
  /**
   * Suelta el gancho ya: cierre de la pestana, apagado del servidor, o un
   * lanzamiento nuevo sobre la misma pestana. Sin pasadas finales: en el
   * apagado los adaptadores se liberan antes que las pestanas, y una pasada
   * que corre despues no encuentra a nadie a quien avisar.
   */
  cancel(): void;
  /**
   * El proceso de la CLI termino y la pestana todavia existe. Es la ultima
   * oportunidad de mirar lo que dejo escrito al salir; despues el gancho se
   * suelta solo. Sin este miembro, el registro llama `cancel`.
   */
  onExit?(): void;
  /**
   * Alguien escribio en la pty: teclas del usuario, o un envio de la app. El
   * gancho sigue vivo. Sin este miembro, el registro llama `cancel`: es la
   * regla del contestador de Claude Code, que en cuanto otro escribe ya no sabe
   * como quedo el menu. Un gancho que tiene que durar mientras se escribe —el
   * que descubre la sesion de una CLI que pone el id ella misma, y que se entera
   * justamente por lo que se escribe— lo declara, aunque no haga nada.
   */
  onInput?(): void;
  /**
   * Texto que la app va a escribir en la pty (cuadro de escritura o nota). Llega
   * **antes** de la primera escritura: quien lo busca en el historial de la CLI
   * no puede encontrar el archivo antes que el texto.
   */
  onSubmitted?(text: string): void;
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
  /**
   * El `cwd` del archivo, o null si no trae. Es la clave del proyecto, y el
   * `cwd` del resumen salvo que `resumeCwd` diga otro.
   */
  cwd: string | null;
  /**
   * Con que `cwd` se reanuda, cuando no es `cwd`. Ausente o null: el mismo.
   *
   * Existe porque no toda CLI reanuda donde empezo. Codex compara la carpeta
   * de la pty con la del **ultimo** turno y, si difieren, abre un dialogo para
   * elegir; el proyecto, en cambio, es donde nacio la sesion. Son dos datos y
   * viajan separados.
   */
  resumeCwd?: string | null;
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
  /**
   * true si la conversacion tiene una llamada a herramienta sin resultado,
   * hecha por el proceso lanzado en `launchedAt` (epoch ms) o despues.
   *
   * Existe por las CLIs que no publican su estado: con una llamada abierta
   * pueden estar mostrando un menu de aprobacion, y un mensaje del cuadro de
   * escritura llegaria como teclas a ese menu —el Enter final aprueba—. Una
   * llamada de un proceso anterior quedo huerfana al relanzar y no bloquea.
   * Una CLI que si publica su estado devuelve false: ahi manda el estado.
   */
  hasOpenToolCall(launchedAt: number): boolean;
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
  /**
   * Resumen de una sesion. null si el archivo existe pero no es una sesion que
   * se liste (con Codex: una lanzada por otra app, o un formato que no se lee).
   * El indice no la agrega ni la guarda en la cache: se vuelve a mirar en cada
   * escaneo, que para un punado de archivos cuesta menos que marcarla.
   * Lanza si el archivo es ilegible.
   */
  scan(item: HistoryItem): Promise<ScannedSession | null>;
  /** Una entrada salio valida de la cache: el adaptador recupera lo que aprendia al escanearla. */
  restored(item: HistoryItem, extra: HistoryExtra): void;
  /** ¿Hay algo que reanudar? Decide entre reanudar y sesion nueva al despertar. */
  exists(cwd: string, sessionId: string): Promise<boolean>;
  follow(target: { cwd: string; sessionId: string }): SessionFollower;
  readonly plans: PlanSource | null;
  /**
   * Cada cuantos ms el hub relee una sesion que alguien sigue, ademas de los
   * avisos del watcher. null: solo los avisos.
   *
   * Existe por las CLIs que escriben su historial con el archivo abierto todo
   * el turno. En Windows eso no genera avisos: NTFS no actualiza la fecha de
   * modificacion hasta cerrar el handle, y el watcher ve nacer el archivo pero
   * no lo que se le agrega (medido con Codex en la verificacion de cierre del
   * hito 25: el hilo se quedaba en el primer mensaje). Releer es un `stat` y
   * los bytes nuevos, si hay.
   */
  readonly followPollMs: number | null;
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

// ---- Envio desde el cuadro de escritura ---------------------------------------

/**
 * Como se le escribe un mensaje a la CLI. Solo servidor: no viaja al cliente.
 *
 * Un envio se arma en **piezas** (`buildSubmissionWrites`, `pty-input.ts`) y
 * cada pieza es un write propio, separado del siguiente por `pieceGapMs`. Una
 * CLI que recibe todo en un solo pegado declara una sola pieza y la separacion
 * no se usa nunca.
 */
export interface AgentInput {
  /**
   * Como nombra las imagenes adjuntas. Igual a `capabilities.imagesByPath`: una
   * es lo que se le promete a la interfaz, la otra lo que se escribe, y el
   * chequeo comprueba que coincidan.
   */
  readonly imageReference: ImageReferenceStyle | null;
  /**
   * Espera entre una pieza y la siguiente.
   *
   * Existe por las CLIs que en Windows reciben lo pegado como una rafaga de
   * teclas y deciden por el tiempo entre teclas si un Enter es un salto de
   * linea o un envio: dos piezas pegadas en el tiempo se funden en una.
   */
  readonly pieceGapMs: number;
  /**
   * Si lo pegado va entre `ESC[200~` y `ESC[201~`.
   *
   * Medido con node-pty 1.1.0 sobre ConPTY, con un lector de `ReadConsoleInput`
   * (como leen las TUI en Windows): los marcadores no llegan como teclas, ni
   * pidiendo `ESC[?2004h` ni sin pedirlo, y un ESC suelto si llega como Escape.
   * O sea que en Windows un pegado con marcadores **no** interrumpe el turno,
   * pero tampoco llega como pegado: llega como rafaga, con los saltos internos
   * como Enter. Por eso lo que decide ahi es `pieceGapMs`.
   */
  readonly pasteMarkers: boolean;
}

// ---- El adaptador ---------------------------------------------------------------

export interface AgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  readonly command: string;
  readonly installUrl: string;
  readonly capabilities: AgentCapabilities;
  readonly input: AgentInput;

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
  /** Gancho posterior al lanzamiento, o null si no hay nada que hacer. */
  onSpawned(context: SpawnedContext): LaunchHook | null;

  readonly history: HistorySource;
  readonly status: StatusSource | null;
  defaults(cwd: string): Promise<AgentDefaults | null>;
  /** Carpetas que el selector de directorios no lista ni deja entrar. */
  protectedDirs(): readonly string[];
  dispose(): void;
}
