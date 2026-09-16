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
  AnswerSelection,
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
  StatusLineSetupInfo,
  TerminalOfflineReason,
} from '@agent-workbench/shared';
import type { CliLocation } from './locate.js';
import type { EventLimits } from './transport-limits.js';

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
  /**
   * Un uuid por lanzamiento, que pone el registro de terminales. El adaptador lo
   * usa para nombrar lo suyo de ese proceso y reconocerlo en `onSpawned`:
   * Antigravity CLI escribe su log en un archivo por lanzamiento (hito 27).
   */
  launchToken: string;
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
  /** El mismo `launchToken` que recibio `launch` para este proceso. */
  launchToken: string;
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
   *
   * `data` es lo que se escribe, tal cual. Nacio con el descubrimiento de la
   * sesion de OpenCode (hito 26), que decidia por un Enter tecleado cual de dos
   * pestanas envio primero; ese descubrimiento se borro en el hito 29, cuando
   * la sesion paso a crearse por API. El miembro se queda porque es generico:
   * a Antigravity CLI (27) le alcanza con que exista.
   */
  onInput?(data: string): void;
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
  /**
   * Filtro del **recorrido**: true si el watcher no tiene que entrar ni mirar
   * esa ruta. Ausente: se recorre todo hasta `depth`, como siempre.
   *
   * `accepts` decide que avisos llegan, pero no por donde camina chokidar para
   * encontrarlos: con profundidad 3 entra en cada subcarpeta, les hace `stat` y
   * deja un `fs.watch` en cada una. Existe por la CLI que guarda, al lado del
   * historial que se lee, carpetas que la app no abre nunca (hito 27, M2).
   *
   * Recibe la ruta tal como la arma chokidar —con `/` tambien en Windows— y a
   * veces sin saber todavia si es carpeta: tiene que decidir por la forma de la
   * ruta sola.
   */
  ignore?: (filePath: string) => boolean;
  awaitWriteFinish: { stabilityThreshold: number; pollInterval: number } | false;
  /**
   * Como enterarse de los cambios de esta raiz sin chokidar. Si esta, el
   * watcher no crea ningun chokidar ni sondea la raiz: se suscribe aca, recibe
   * la ruta que la fuente decida avisar (que igual pasa por `accepts`) y guarda
   * lo que devuelve para desuscribirse al cerrar.
   *
   * Existe por las fuentes que no son un archivo por sesion (hito 26): una base
   * compartida que otro proceso mantiene abierta y escribe, donde un watcher de
   * archivos avisa tarde o nunca y lo que sirve es un sondeo propio.
   */
  watch?: (onChange: (filePath: string) => void) => () => void;
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
export type ScannedSummary = Omit<SessionSummary, 'agent' | 'cwd' | 'archived' | 'storage' | 'partial'>;

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
  /** Sin `agent`, `cwd`, `archived`, `storage` ni `partial`: los pone el indice. */
  summary: ScannedSummary;
  extra: HistoryExtra;
}

/**
 * Los documentos markdown que una conversacion escribio.
 *
 * Lo que va y viene son **refs opacas** que arma el propio adaptador, nunca
 * rutas: la raiz de cada una la pone el, y la vuelve a resolver antes de abrir
 * nada (CLAUDE.md 2.4). Desde el hito 31 recibe ademas la pestana, porque dos
 * de las tres raices salen de ella: el `cwd` del proyecto y la carpeta temporal
 * de esa sesion.
 */
export interface PlanSource {
  describe(target: { cwd: string; sessionId: string }, refs: readonly string[]): Promise<SessionPlan[]>;
  read(target: { cwd: string; sessionId: string }, ref: string): Promise<PlanContent | null>;
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
  /**
   * true si el uso cambio sin que llegara ningun evento nuevo.
   *
   * Existe por la CLI que escribe los tokens de un paso al **cerrarlo**, cuando
   * su texto y sus herramientas ya se entregaron (hito 26): esa lectura no trae
   * eventos, y como el uso viaja pegado a un `append`, la barra se quedaba un
   * paso atras hasta el mensaje siguiente. El hub manda entonces un `append`
   * vacio con el uso nuevo. Ausente es false: Claude Code y Codex no la ponen.
   */
  usageChanged?: boolean;
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
   * Una CLI que si publica su estado devuelve false: ahi manda el estado. La
   * que lo publica solo con algo configurado devuelve false solo si esta
   * pestana ya publico algo (hito 27, R27-1).
   */
  hasOpenToolCall(launchedAt: number): boolean;
}

/**
 * Hito 28. Como se lee una sesion fuera del hilo (la copia propia).
 *
 * Sin opciones —que es como la sigue el hub— todo sale como siempre: los topes
 * de transporte y el tope de eventos del seguidor.
 */
export interface FollowOptions {
  /** Ausente: `TRANSPORT_LIMITS`. */
  limits?: EventLimits;
  /** Tope de eventos en memoria. Ausente: el del seguidor (4 000). `Infinity`: sin tope. */
  maxEvents?: number;
}

export interface HistorySource {
  roots(): readonly HistoryRoot[];
  /** Todo lo que hay, en orden estable. null si la raiz no existe. */
  list(): Promise<HistoryItem[] | null>;
  /**
   * Hito 28. false si la raiz del historial no existe en disco. Ausente: vale lo
   * que dice `list()`, que devuelve null solo cuando la raiz falta.
   *
   * Existe por la fuente cuyo `list()` tambien da null cuando no pudo leer (una
   * base ocupada, una carpeta ilegible): sin esto, todas sus sesiones
   * aparecerian como "copia" mientras dura el problema.
   */
  rootExists?(): Promise<boolean>;
  /**
   * Hito 28. true si `follow` respeta `FollowOptions`: con `limits` y
   * `maxEvents` entrega la sesion con esos topes y sin paginar.
   *
   * Es una declaracion y no se deduce: un seguidor que ignora las opciones
   * entrega textos recortados a los topes de transporte sin que nada lo delate,
   * y la copia guardaria eso como si fuera la sesion entera. La copia solo lee
   * las fuentes que lo declaran.
   */
  readonly wholeRead?: true;
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
  /** `options` ausente: como la sigue el hub. Ver `FollowOptions` y `wholeRead`. */
  follow(target: { cwd: string; sessionId: string }, options?: FollowOptions): SessionFollower;
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
  /**
   * Ya traducido. Un valor nativo desconocido es 'busy'.
   *
   * 'unknown': la fuente existe pero no dice nada de esta sesion (todavia). Pasa
   * con la CLI que publica su estado solo si el usuario configuro algo (hito
   * 27): sin eso no esta parada ni trabajando, simplemente no se sabe.
   */
  activity: 'busy' | 'idle' | 'waiting' | 'unknown';
  /** Etiqueta cruda cuando `activity` es 'waiting'; null si no la trae. */
  waitingFor: string | null;
}

export interface StatusSource {
  /**
   * `listener(null)` = no hay proceso registrado. El registro lo pinta 'offline'.
   *
   * Con `offlineReason` (hito 29, M2), el null tiene un motivo que la vista
   * dice: `server-closed` es el servidor de la CLI que termino sin que la app lo
   * pidiera, con la pestana todavia enganchada a el. Solo lo manda la CLI que
   * atiende sus pestanas por un servidor propio (OpenCode).
   */
  subscribe(
    sessionId: string,
    listener: (status: AgentStatus | null, offlineReason?: TerminalOfflineReason) => void,
  ): () => void;
  /** true si llego a "lista para recibir" dentro del plazo. */
  waitUntilReady(sessionId: string, timeoutMs: number): Promise<boolean>;
  /**
   * Relee ya lo que la CLI publica de esa sesion y avisa a sus suscriptores lo
   * que cambio. Ausente: solo el sondeo (Claude Code). Existe por la guarda de
   * un envio a una CLI cuya confirmacion abierta aprueba un Enter (hito 27,
   * R27-2): tiene que preguntar al archivo, no a la ultima vuelta del sondeo.
   */
  refresh?(sessionId: string): Promise<void>;
  dispose(): void;
}

// ---- Preguntas por API ----------------------------------------------------------

/**
 * Como termino un intento de contestar por API (hito 29, D10):
 *
 *  - `answered`: la CLI acepto la respuesta.
 *  - `not-pending`: esa pregunta no esta abierta (ya se contesto, se rechazo, o
 *    la sesion no es de este arranque). No se mando nada.
 *  - `invalid`: lo elegido no describe una respuesta a esa pregunta. No se mando
 *    nada.
 *  - `no-free-text`: se escribio una respuesta a una pregunta que no la acepta
 *    (B4). La tarjeta ofrece escribir siempre; la CLI dice si se puede. No se
 *    mando nada.
 *
 * Un fallo de la CLI al contestar (una ruta que no existe, un error) lanza.
 */
export type QuestionAnswerOutcome = 'answered' | 'not-pending' | 'invalid' | 'no-free-text';

/**
 * Contestar la pregunta abierta por la API de la CLI, sin teclas (capacidad
 * `questionCards` en una CLI que las contesta asi).
 *
 * Recibe la carpeta ademas de la sesion (A1): la CLI que separa sus proyectos
 * por carpeta no encuentra la pregunta sin ella.
 */
export interface QuestionChannel {
  answer(
    target: { cwd: string; sessionId: string },
    toolUseId: string,
    selections: readonly AnswerSelection[],
  ): Promise<QuestionAnswerOutcome>;
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
  /**
   * Si el Enter que envia va como pieza propia, separado del pegado por
   * `pieceGapMs`, aunque no haya imagenes.
   *
   * Existe por la CLI cuyo pegado en Windows todavia no se midio (hito 26): si
   * lo recibe como rafaga, igual que Codex, un Enter pegado al final puede
   * quedar dentro de la rafaga como salto de linea. Con `bare-path-paste` el
   * Enter ya va aparte; Claude Code lo lleva pegado, como siempre.
   */
  readonly enterSeparately: boolean;
  /**
   * Cuantos Esc hacen falta para interrumpir un turno.
   *
   * El primero sale enseguida, como siempre; los demas van espaciados por
   * `ANSWER_KEY_INTERVAL_MS` y por la fila de la terminal, para que un envio
   * que llegue justo despues no se cuele entre dos Esc. Existe por la CLI cuyo
   * primer Esc solo arma la interrupcion y el segundo la hace (hito 26): con uno
   * solo, el boton de interrumpir no haria nada.
   */
  readonly interruptPresses: number;
  /**
   * Como se nombra el transcript en el mensaje que continua una conversacion de
   * otra CLI (hito 29, D18). `transcriptReferenceFor` en `handoff/transcript.ts`
   * arma la forma.
   *
   * Obligatorio a proposito: una CLI nueva que no lo declara no compila, y nada
   * elige por ella una forma que puede frenar a pedir permiso.
   */
  readonly transcriptReference: TranscriptReferenceStyle;
}

/**
 * Como se nombra un archivo para que el agente lo lea (hito 29, D18).
 *
 *  - `at-quoted`: `@"ruta"`. La CLI lo adjunta sola, sin pedir permiso para leer
 *    fuera del proyecto. Es la misma forma que una imagen (`fileReference`).
 *  - `quoted-path`: `"ruta"`. El agente lo lee con su herramienta. Para la CLI
 *    donde `@` abre un buscador, o donde la forma no esta medida.
 */
export type TranscriptReferenceStyle = 'at-quoted' | 'quoted-path';

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
  /**
   * Que se lanza. Puede ser asincrono (hito 29, D23): la CLI que crea la sesion
   * por su API antes de lanzar. El registro lo espera con la entrada marcada
   * "lanzando", y un fallo —sincronico o no— llega al cliente como
   * `spawn-failed` con el mensaje como detalle. Las cuatro CLIs de hoy
   * devuelven un valor.
   */
  launch(input: LaunchInput): LaunchPlan | Promise<LaunchPlan>;
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
  /**
   * Lo que el arranque imprime despues de `Historial` para esta CLI, o null
   * para no imprimir nada. Ausente: nada.
   *
   * Existe por la CLI cuyo historial es una base que se abre de otra forma y
   * puede no leerse por motivos que el usuario tiene que ver (hito 26): la ruta
   * que se abre en solo lectura, o que este Node no trae `node:sqlite`. Quien
   * no usa esa CLI no tiene que ver una linea nueva, y por eso el adaptador
   * decide cuando no hay nada que decir. `cliAvailable`: si su binario se
   * encontro.
   */
  startupHistoryNote?(cliAvailable: boolean): string | null;
  readonly status: StatusSource | null;
  /**
   * Presente si las preguntas de la CLI se contestan por su API (hito 29, D10).
   * Ausente con `questionCards`: se contestan con teclas en la pty (§5.5 de
   * CLAUDE.md). El socket lo llama fuera de la fila de escritura: no escribe en
   * la pty.
   */
  readonly questions?: QuestionChannel;
  defaults(cwd: string): Promise<AgentDefaults | null>;
  /** Carpetas que el selector de directorios no lista ni deja entrar. */
  protectedDirs(): readonly string[];

  /*
    Lo que sigue es opcional y existe por la CLI que publica su estado solo si
    el usuario configura una integracion propia (hito 27, la status line de
    Antigravity CLI). Ninguna de las otras lo declara.
  */

  /**
   * Lo que el adaptador prepara en la carpeta de la app y en la temporal: el
   * script de la integracion, y limpiar lo que dejaron arranques anteriores.
   *
   * Lo llama `AgentRegistry.prepareAll()` **despues** de mover la carpeta de
   * configuracion del nombre viejo (A1: crear `integrations/` antes haria que
   * la migracion se saltara) y **solo** si la CLI se encontro: quien no la usa
   * no tiene por que ver ni un archivo nuevo. Nunca lanza.
   */
  prepare?(): Promise<void>;
  /** Como esta configurada la integracion, para el dialogo. null si no hay. */
  statusLine?(): StatusLineSetupInfo | null;
  /**
   * Vuelve a leer la configuracion de la integracion (y reinstala su script si
   * alguien lo cambio). true si cambio lo que se anuncia: capacidades o
   * `statusLine`. Nunca lanza.
   */
  refreshSetup?(): Promise<boolean>;
  /**
   * Avisa cuando cambia lo que se anuncia sin que nadie lo pida (el usuario
   * edito la configuracion de la CLI). Devuelve la desuscripcion. Solo corre
   * mientras haya alguien suscrito.
   */
  subscribeChanges?(listener: () => void): () => void;
  /**
   * Suelta lo del adaptador. Puede devolver una promesa (hito 29): la CLI que
   * lanza un proceso propio aparte de las pestanas lo mata ahi, y el apagado lo
   * espera para no dejarlo huerfano. Lo sincronico de soltar ocurre antes de
   * devolver, espere quien espere.
   */
  dispose(): void | Promise<void>;
}
