/**
 * Protocolo WebSocket entre el navegador y el servidor local.
 *
 * Version 5 — consola del sistema en la columna derecha.
 *
 * Cambio de la v1 a la v2: el WebSocket dejo de ser duenio de la pty. Las
 * terminales viven en el servidor y el socket solo se engancha a ellas. Por eso
 * existen `terminal.attach` y `terminal.replay`: un cliente que reconecta
 * recupera la pantalla sin que el proceso se haya enterado de nada.
 *
 * Lo que agrega la v3: la familia `conversation.*`. El servidor sigue el JSONL
 * de la sesion de una pestana y manda eventos ya recortados. El navegador nunca
 * ve una linea cruda del JSONL — pueden pesar 290 KB.
 *
 * Lo que agrega la v4: `git.*` y `files.*`. Las dos familias se dirigen a una
 * pestana por `terminalId` y **nunca** llevan una ruta absoluta: el servidor
 * resuelve todo dentro del `cwd` de esa pestana. Un servidor que lanza procesos
 * no puede aceptar rutas arbitrarias de un cliente, aunque el cliente sea el
 * navegador del propio usuario.
 *
 * Lo que agrega la v5: `terminal.open` lleva `kind`. Con `shell` se abre la
 * consola del sistema en vez de la CLI. Es el mismo transporte —`input`,
 * `resize`, `terminal.attach` no cambian— porque del lado del servidor las dos
 * cosas son una pty y nada mas; lo unico que cambia es que se lanza.
 *
 * Reglas:
 *  - Sin `any`. Lo que entra de la red es `unknown` hasta que un parser lo
 *    estrecha.
 *  - Uniones discriminadas por `type`.
 *  - Un mensaje desconocido no rompe: se ignora y se avisa.
 */

import type { AgentDefaults } from './agent-controls.js';
import { isPermissionMode, type PermissionMode } from './permission-modes.js';
import {
  parseContextUsage,
  parseConversationEvent,
  parseConversationPart,
  parsePlanContent,
  parseSessionPlan,
  CONVERSATION_IMAGE_SOURCES,
  CONVERSATION_STATES,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
  type ConversationPart,
  type ConversationState,
  type PlanContent,
  type SessionPlan,
} from './conversation.js';
import {
  parseDirectoryListing,
  parseDirectoryPickerListing,
  parseFilePreview,
  parseFileSearchResult,
  type DirectoryListing,
  type DirectoryPickerListing,
  type FilePreview,
  type FileSearchResult,
} from './files.js';
import { parseGitDiff, parseGitStatus, type GitDiff, type GitStatus } from './git.js';
import { parseNote, type Note } from './notes.js';
import {
  parseIndexStatus,
  parseProjectSummary,
  parseTerminalDescriptor,
  TERMINAL_ACTIVITIES,
  TERMINAL_KINDS,
  type IndexStatus,
  type ProjectSummary,
  type SessionId,
  type TerminalActivity,
  type TerminalDescriptor,
  type TerminalId,
  type TerminalKind,
} from './models.js';
import {
  asArrayOf,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asPositiveInt,
  asRecord,
  asString,
  asStringArray,
  parseJson,
} from './validation.js';

/** Se incrementa cuando el contrato cambia de forma incompatible. */
export const PROTOCOL_VERSION = 5;

/** Ruta del WebSocket. El resto del servidor sirve la UI. */
export const WS_PATH = '/ws';

/** Nombre del parametro de query que lleva el token de arranque. */
export const TOKEN_QUERY_PARAM = 'token';

// ---------------------------------------------------------------------------
// Cliente -> servidor
// ---------------------------------------------------------------------------

/** Teclas del usuario, tal cual las entrega xterm. Van sin filtrar al pty. */
export interface ClientInputMessage {
  type: 'input';
  terminalId: TerminalId;
  data: string;
}

/**
 * Topes del cuadro de escritura.
 *
 * Viven en `shared` porque los dos lados los necesitan y por motivos distintos:
 * el cliente para avisar antes de mandar 12 MB por el socket, el servidor para
 * hacerlos cumplir. Un limite que solo conoce el cliente no es un limite.
 */
export const MAX_SUBMIT_IMAGE_BYTES = 12 * 1024 * 1024;
export const MAX_SUBMIT_IMAGES = 8;

/** Una imagen pegada en el cuadro de escritura. */
export interface SubmitImage {
  /** Tipo declarado por el navegador. El servidor comprueba la firma real. */
  mediaType: string;
  /** Contenido en base64, sin el prefijo `data:`. */
  data: string;
}

/**
 * Un mensaje escrito en el cuadro de escritura de la conversacion.
 *
 * No es un `input` con mas cosas: es una operacion distinta. `input` son teclas
 * y va crudo al pty; esto es *un mensaje*, que el servidor convierte en un
 * pegado con su Enter, guarda las imagenes en disco y las nombra por ruta.
 * Separarlos es lo que permite que las teclas sigan sin pasar por ningun filtro
 * (CLAUDE.md 5) mientras el cuadro de escritura tiene reglas propias.
 */
export interface ClientSubmitMessage {
  type: 'agent.submit';
  terminalId: TerminalId;
  /** Texto tal como lo escribio el usuario, con sus saltos de linea. */
  text: string;
  /** Imagenes pegadas, en el orden en que se pegaron. */
  images: SubmitImage[];
  /** false para dejarlo escrito en el prompt sin enviarlo. */
  send?: boolean;
}

/**
 * Respuesta a una pregunta de eleccion, elegida desde la conversacion.
 *
 * **Viaja lo elegido, no las teclas.** El cliente manda indices de opciones
 * contra la pregunta que el propio servidor le mando; traducirlos a la
 * secuencia que entiende el menu de la CLI es cosa de `pty-input.ts`, que es el
 * unico lugar del proyecto que sabe de secuencias de escape (§5.3). Si esto
 * viajara como teclas, cualquier bug de la UI —o una pagina que consiga
 * hablarle al servidor— escribiria lo que quisiera en la terminal.
 *
 * `toolUseId` no es decorativo: identifica **que** pregunta se esta
 * respondiendo, y el servidor rechaza el mensaje si no es la que esta abierta.
 * Sin eso, una respuesta que sale tarde —porque el usuario ya contesto en la
 * solapa CLI— entra como teclas sueltas en el prompt.
 */
/**
 * Una respuesta escrita en vez de elegida.
 *
 * La CLI ofrece `Type something` al final de cada pregunta, y hasta el hito 16
 * eso obligaba a irse a la solapa CLI — que es justo lo que la tarjeta viene a
 * evitar. Verificado contra la 2.1.260 en las tres posiciones posibles: unica
 * pregunta, primera de dos y ultima de dos.
 */
export interface FreeTextSelection {
  kind: 'free';
  /** Lo que escribio el usuario. El servidor lo sanea antes de escribirlo. */
  text: string;
}

/** Lo elegido en una pregunta: indices de opciones, o texto propio. */
export type AnswerSelection = number[] | FreeTextSelection;

export interface ClientAnswerMessage {
  type: 'agent.answer';
  terminalId: TerminalId;
  /** El `id` del `tool_use` que hizo la pregunta. */
  toolUseId: string;
  /** Lo elegido, una entrada por pregunta y en el mismo orden. */
  selections: AnswerSelection[];
}

/**
 * Cambia el modo de permiso de una pestana.
 *
 * Viaja **el modo destino**, no las teclas: la CLI no tiene comando de barra
 * para esto y la unica forma de cambiarlo en una sesion viva es `shift+tab`,
 * que cicla. Cuantas veces hay que mandarlo lo decide el servidor, que es el
 * que sabe en que modo esta la pestana (§5.4.2). Si el cliente mandara las
 * pulsaciones, cualquier desincronizacion dejaria al usuario en un modo que no
 * eligio.
 */
export interface ClientPermissionModeMessage {
  type: 'agent.mode';
  terminalId: TerminalId;
  /** Uno de `PERMISSION_MODE_CYCLE`. */
  mode: PermissionMode;
}

/**
 * Esconde de la barra lateral, o vuelve a mostrar, un grupo de sesiones.
 *
 * **No borra nada.** El `.jsonl` es de la CLI —es lo que usa `--resume`— y de
 * `~/.claude/` solo leemos (CLAUDE.md 2.1). Lo que se guarda es una lista de
 * ids en el directorio de configuracion propio.
 *
 * Un solo mensaje para las dos direcciones: archivar y restaurar son el mismo
 * cambio con el booleano al reves, y separarlos duplicaria el camino entero
 * para no ganar nada.
 */
export interface ClientArchiveSessionsMessage {
  type: 'session.archive';
  sessionIds: SessionId[];
  archived: boolean;
}

/** Interrumpe lo que la CLI este haciendo. Es un `Esc`, ni mas ni menos. */
export interface ClientInterruptMessage {
  type: 'agent.interrupt';
  terminalId: TerminalId;
}

/**
 * Nuevo tamano del terminal. Reenviarlo al pty no es opcional: un pty con
 * tamano desincronizado rompe el renderizado de la CLI.
 */
export interface ClientResizeMessage {
  type: 'resize';
  terminalId: TerminalId;
  cols: number;
  rows: number;
}

/**
 * Abrir una pestana.
 *
 * Si `resumeSessionId` viene, se lanza con `--resume` sobre esa conversacion.
 * Si no, el servidor genera un UUID nuevo y lo pasa con `--session-id`, para
 * saber de antemano que archivo JSONL va a escribir (ver CLAUDE.md 4.8).
 */
export interface ClientOpenTerminalMessage {
  type: 'terminal.open';
  /** Eco para casar la respuesta con la peticion. */
  requestId: string;
  cwd: string;
  resumeSessionId?: SessionId;
  label?: string;
  /**
   * Que lanzar. Ausente significa `agent`, que es lo que pedian los clientes
   * de la v4. Con `shell` se abre la consola del sistema: sin `--session-id`,
   * sin conversacion y sin persistirse entre arranques.
   */
  kind?: TerminalKind;
}

/** Cierra la pestana y termina el proceso. */
/**
 * Le da proceso a una pestana dormida, o revive una que murio.
 *
 * Es lo unico nuevo que hace falta para que arrancar la aplicacion no lance una
 * CLI por pestana: la conversacion, el medidor y los paneles salen del archivo
 * y del `cwd`, asi que una pestana sin proceso se lee igual. La pty aparece
 * cuando hay algo que escribirle al agente, y eso lo decide el usuario.
 *
 * Reusa el mismo `terminalId` y el mismo `sessionId`: no es una pestana nueva,
 * es la misma que ya estaba en pantalla.
 */
export interface ClientWakeTerminalMessage {
  type: 'terminal.wake';
  terminalId: TerminalId;
}

export interface ClientCloseTerminalMessage {
  type: 'terminal.close';
  terminalId: TerminalId;
}

/**
 * Engancha este socket a una terminal existente y pide el buffer de replay.
 * Es lo que corre despues de recargar el navegador.
 */
export interface ClientAttachTerminalMessage {
  type: 'terminal.attach';
  terminalId: TerminalId;
  /** Tamano actual del contenedor, para sincronizar el pty al reenganchar. */
  cols: number;
  rows: number;
}

/** Deja de recibir salida de esa terminal, sin matarla. */
export interface ClientDetachTerminalMessage {
  type: 'terminal.detach';
  terminalId: TerminalId;
}

export interface ClientRenameTerminalMessage {
  type: 'terminal.rename';
  terminalId: TerminalId;
  label: string;
}

/** Nuevo orden de las pestanas. Se persiste del lado del servidor. */
export interface ClientReorderTabsMessage {
  type: 'tabs.reorder';
  terminalIds: TerminalId[];
}

/** Fuerza un reindexado completo. */
export interface ClientRefreshIndexMessage {
  type: 'index.refresh';
}

/**
 * Empieza a seguir el JSONL de la sesion de esta pestana.
 *
 * La respuesta es un `conversation.reset` con el tramo final de la
 * conversacion; despues llegan `conversation.append` a medida que la CLI
 * escribe.
 */
export interface ClientSubscribeConversationMessage {
  type: 'conversation.subscribe';
  terminalId: TerminalId;
}

/** Deja de seguirla. El seguimiento se apaga cuando no queda nadie mirando. */
export interface ClientUnsubscribeConversationMessage {
  type: 'conversation.unsubscribe';
  terminalId: TerminalId;
}

/**
 * Pide el tramo anterior a un evento ya recibido.
 *
 * Va por id y no por indice a proposito: el cliente puede tener una vista
 * parcial y los indices se corren cuando el servidor descarta eventos viejos.
 */
export interface ClientLoadMoreConversationMessage {
  type: 'conversation.loadMore';
  terminalId: TerminalId;
  beforeEventId: string;
  limit: number;
}

/**
 * Pide el contenido de una imagen del historial.
 *
 * Los eventos llevan la referencia y no los bytes: el JSONL las guarda en
 * base64 y una conversacion con capturas pesaria megas en cada carga. Esto es
 * lo que se manda cuando una miniatura entra en pantalla.
 */
export interface ClientConversationImageMessage {
  type: 'conversation.image';
  terminalId: TerminalId;
  eventId: string;
  /** Posicion dentro de su fuente. */
  index: number;
  /** En cual de las dos formas buscarla. Ver `ConversationImageSource`. */
  source: ConversationImageSource;
}

/**
 * Empieza a mirar el estado de git del `cwd` de esta pestana.
 *
 * Igual que la conversacion: refcount en el servidor, y el watcher del repo se
 * apaga cuando no queda nadie mirando. Un `git status` por pestana abierta,
 * corriendo para nadie, es exactamente lo que no queremos.
 */
export interface ClientSubscribeGitMessage {
  type: 'git.subscribe';
  terminalId: TerminalId;
}

export interface ClientUnsubscribeGitMessage {
  type: 'git.unsubscribe';
  terminalId: TerminalId;
}

/** Relee el estado ahora, sin esperar al watcher. */
export interface ClientRefreshGitMessage {
  type: 'git.refresh';
  terminalId: TerminalId;
}

/** Diff de un archivo. `path` es relativo a la raiz del repo. */
export interface ClientGitDiffMessage {
  type: 'git.diff';
  terminalId: TerminalId;
  path: string;
  /** true para el diff del area de staging. */
  staged: boolean;
}

/**
 * Contenido de un directorio. `path` es relativo al `cwd` de la pestana;
 * cadena vacia = raiz. Nunca absoluto.
 */
export interface ClientListFilesMessage {
  type: 'files.list';
  terminalId: TerminalId;
  path: string;
  /**
   * true para que vengan tambien las entradas que se ocultan solas.
   *
   * Es el ojo del panel. Sin esto no hay forma de mirar un archivo que
   * `.gitignore` esconde —un `.env` de ejemplo, un `dist/` recien construido—
   * mas que desde afuera de la aplicacion.
   */
  includeHidden?: boolean;
}

/**
 * Busca archivos por nombre dentro del `cwd` de la pestana.
 *
 * Un nivel por peticion sirve para recorrer y no para buscar, asi que esto es
 * lo unico del panel que mira mas de un nivel de una. Va acotado por tres topes
 * a la vez —resultados, directorios visitados y tiempo— porque en un repo
 * grande cualquiera de los tres solo se queda corto.
 */
export interface ClientSearchFilesMessage {
  type: 'files.search';
  terminalId: TerminalId;
  query: string;
  /** El mismo ojo que `files.list`: con true, tambien busca en lo ignorado. */
  includeHidden?: boolean;
}

/** Previsualizacion de solo lectura de un archivo del `cwd`. */
export interface ClientReadFileMessage {
  type: 'files.read';
  terminalId: TerminalId;
  path: string;
}

/**
 * Pide el contenido de un plan de esta pestana.
 *
 * Viaja el **nombre del archivo** que el servidor mando en la lista de planes,
 * nunca una ruta: la carpeta la pone el servidor, y antes de leer comprueba que
 * ese plan sea uno de los que esta conversacion nombro. Es la regla de §2.4
 * aplicada a la tercera carpeta de `~/.claude/` que la app lee.
 */
export interface ClientReadPlanMessage {
  type: 'plans.read';
  terminalId: TerminalId;
  fileName: string;
}

/**
 * Abre la ruta con la aplicacion que el sistema tenga asociada.
 *
 * No se elige editor ni se configura ninguno: se delega en el sistema
 * operativo, que ya sabe cual es el del usuario.
 */
export interface ClientRevealFileMessage {
  type: 'files.reveal';
  terminalId: TerminalId;
  path: string;
}

/**
 * Notas sueltas (`notes.*`).
 *
 * No van dirigidas a ninguna pestana: son del usuario, no de un proyecto. El
 * `noteId` lo genera el cliente —asi puede activar la solapa nueva sin esperar
 * la respuesta— y el servidor solo lo acepta si tiene forma de id y no existe.
 * Los `imageId`, en cambio, los pone el servidor: son los que nombran archivos
 * en disco, y una ruta nunca la elige el cliente (CLAUDE.md 2.4).
 */
export interface ClientCreateNoteMessage {
  type: 'notes.create';
  noteId: string;
}

export interface ClientUpdateNoteMessage {
  type: 'notes.update';
  noteId: string;
  text: string;
}

/** Cerrar una nota es borrarla, con sus imagenes. El cliente confirma antes. */
export interface ClientDeleteNoteMessage {
  type: 'notes.delete';
  noteId: string;
}

export interface ClientAddNoteImageMessage {
  type: 'notes.addImage';
  noteId: string;
  image: SubmitImage;
}

export interface ClientRemoveNoteImageMessage {
  type: 'notes.removeImage';
  noteId: string;
  imageId: string;
}

/** Pide el contenido de una imagen de una nota, cuando la miniatura se dibuja. */
export interface ClientNoteImageMessage {
  type: 'notes.image';
  imageId: string;
}

/**
 * Manda una nota entera al agente de una pestana.
 *
 * **Solo viajan los dos ids.** El texto y las imagenes ya estan en el servidor
 * —`notes.json` y `notes-images/`—, asi que hacerlos subir al navegador y
 * volver a bajar en base64 solo para reenviarlos seria mover megas por el
 * socket para nada. El servidor arma el mismo pegado que `agent.submit` y usa
 * el mismo `pty-input.ts`: no hay un segundo camino que escriba en la pty.
 *
 * **La nota no se borra.** Mandarla no es cerrarla; cerrar es lo unico que
 * borra, y por eso pide confirmacion.
 */
export interface ClientSendNoteMessage {
  type: 'notes.send';
  noteId: string;
  /** La pestana a la que va. La abre el cliente antes de mandar esto. */
  terminalId: TerminalId;
}

/**
 * Selector de carpetas, para abrir un proyecto en una que la app no conoce.
 *
 * **El cliente nunca compone una ruta.** El servidor guarda donde esta parado
 * el selector; el cliente solo puede nombrar *un segmento de lo que el servidor
 * le acaba de listar* (`picker.enter`), subir con `..`, o saltar a una raiz por
 * su posicion. Es el criterio de la seccion 2.4 aplicado a un caso nuevo, y es
 * lo que permite que este sea el unico sitio de la app que lista fuera del
 * `cwd` de una pestana sin abrir la puerta a leer cualquier ruta.
 */
export interface ClientPickerOpenMessage {
  type: 'picker.open';
}

export interface ClientPickerEnterMessage {
  type: 'picker.enter';
  pickerId: string;
  /** Un nombre del listado actual, o `..` para subir. Nunca una ruta. */
  name: string;
}

export interface ClientPickerRootMessage {
  type: 'picker.root';
  pickerId: string;
  /** Posicion en la lista de raices que mando el servidor. */
  rootIndex: number;
}

export interface ClientPickerCreateMessage {
  type: 'picker.create';
  pickerId: string;
  /** Nombre de la carpeta nueva. Un segmento; el servidor lo valida. */
  name: string;
}

export interface ClientPickerCloseMessage {
  type: 'picker.close';
  pickerId: string;
}

export type ClientMessage =
  | ClientInputMessage
  | ClientSubmitMessage
  | ClientAnswerMessage
  | ClientPermissionModeMessage
  | ClientArchiveSessionsMessage
  | ClientInterruptMessage
  | ClientResizeMessage
  | ClientOpenTerminalMessage
  | ClientWakeTerminalMessage
  | ClientCloseTerminalMessage
  | ClientAttachTerminalMessage
  | ClientDetachTerminalMessage
  | ClientRenameTerminalMessage
  | ClientReorderTabsMessage
  | ClientRefreshIndexMessage
  | ClientSubscribeConversationMessage
  | ClientUnsubscribeConversationMessage
  | ClientLoadMoreConversationMessage
  | ClientConversationImageMessage
  | ClientSubscribeGitMessage
  | ClientUnsubscribeGitMessage
  | ClientRefreshGitMessage
  | ClientGitDiffMessage
  | ClientListFilesMessage
  | ClientSearchFilesMessage
  | ClientReadFileMessage
  | ClientRevealFileMessage
  | ClientReadPlanMessage
  | ClientCreateNoteMessage
  | ClientUpdateNoteMessage
  | ClientDeleteNoteMessage
  | ClientAddNoteImageMessage
  | ClientRemoveNoteImageMessage
  | ClientNoteImageMessage
  | ClientSendNoteMessage
  | ClientPickerOpenMessage
  | ClientPickerEnterMessage
  | ClientPickerRootMessage
  | ClientPickerCreateMessage
  | ClientPickerCloseMessage;

export type ClientMessageType = ClientMessage['type'];

// ---------------------------------------------------------------------------
// Servidor -> cliente
// ---------------------------------------------------------------------------

/** Primer mensaje tras conectar. Describe el entorno, no una terminal. */
export interface ServerHelloMessage {
  type: 'hello';
  protocolVersion: number;
  /** false cuando la CLI no esta en el PATH: la UI lo explica y no abre pestanas. */
  cliAvailable: boolean;
  cliVersion: string | null;
  /** Mensaje listo para mostrar cuando `cliAvailable` es false. */
  cliMissingMessage: string | null;
  platform: string;
  /** Sugerencia de cwd para la primera pestana. */
  defaultCwd: string;
  /**
   * true si el servidor arranco con `CLAUDE_CODE_CHILD_SESSION` heredado y lo
   * quito del entorno de las pestanas.
   *
   * Esa variable apaga el guardado del JSONL, y sin JSONL no hay historial, ni
   * vista de conversacion, ni medidor. Se filtra para que la app funcione igual
   * desde donde sea que se la arranque, pero se avisa: no queremos que la app
   * toque el entorno de la CLI sin que se note.
   */
  transcriptMarkerStripped: boolean;
  /**
   * Nombre de la consola del sistema que se puede abrir en el panel derecho
   * ("PowerShell", "bash"), o null si no se encontro ninguna.
   *
   * Es el nombre y no un booleano porque la UI lo escribe en el boton: decir
   * "PowerShell" cuando eso es lo que se va a abrir vale mas que un rotulo
   * generico, y en macOS o Linux ese rotulo seria directamente falso.
   */
  shellName: string | null;
}

/** Estado completo de las pestanas. Se manda al conectar y tras cada cambio. */
export interface ServerTerminalListMessage {
  type: 'terminal.list';
  terminals: TerminalDescriptor[];
  /** Orden de las pestanas, por id. */
  order: TerminalId[];
}

export interface ServerTerminalOpenedMessage {
  type: 'terminal.opened';
  /** Eco del requestId de `terminal.open`. */
  requestId: string;
  terminal: TerminalDescriptor;
}

/** Salida en vivo del pty. */
export interface ServerTerminalOutputMessage {
  type: 'terminal.output';
  terminalId: TerminalId;
  data: string;
}

/**
 * Contenido del buffer circular, en respuesta a `terminal.attach`.
 *
 * El cliente tiene que limpiar la pantalla antes de escribirlo: es el estado
 * completo que conocemos, no un incremento.
 */
export interface ServerTerminalReplayMessage {
  type: 'terminal.replay';
  terminalId: TerminalId;
  data: string;
  /** true si el buffer se lleno y se perdio salida anterior. */
  truncated: boolean;
}

/** El proceso termino. La pestana sigue abierta hasta que el usuario la cierre. */
export interface ServerTerminalExitMessage {
  type: 'terminal.exit';
  terminalId: TerminalId;
  exitCode: number;
  signal: number | null;
}

/** La pestana se cerro y ya no existe. */
export interface ServerTerminalClosedMessage {
  type: 'terminal.closed';
  terminalId: TerminalId;
}

/** Avance del indexado. La UI muestra progreso en vez de congelarse. */
/**
 * Que esta haciendo la CLI de una pestana.
 *
 * Va aparte de `terminal.list` a proposito: esto cambia cada 700 ms —es un
 * sondeo del estado que la CLI publica por proceso— y la lista de pestanas no.
 * Mandar la lista entera en cada latido seria repetir todo para cambiar una
 * palabra.
 */
export interface ServerTerminalActivityMessage {
  type: 'terminal.activity';
  terminalId: TerminalId;
  activity: TerminalActivity;
}

export interface ServerIndexStatusMessage {
  type: 'index.status';
  status: IndexStatus;
}

/**
 * Proyectos indexados. Puede llegar varias veces: el indexador va emitiendo a
 * medida que termina cada proyecto, y `replace` distingue un lote parcial de un
 * reemplazo completo del arbol.
 */
export interface ServerIndexProjectsMessage {
  type: 'index.projects';
  projects: ProjectSummary[];
  replace: boolean;
}

/**
 * Estado completo conocido de una conversacion, en respuesta a
 * `conversation.subscribe`.
 *
 * Reemplaza lo que el cliente tuviera: no es un incremento. Trae el tramo
 * final, que es lo que se quiere ver al abrir el panel; `hasMore` dice si hay
 * mas atras y se pide con `conversation.loadMore`.
 */
export interface ServerConversationResetMessage {
  type: 'conversation.reset';
  terminalId: TerminalId;
  sessionId: SessionId;
  state: ConversationState;
  events: ConversationEvent[];
  hasMore: boolean;
  usage: ContextUsage;
  /** Modo de permiso observado en el archivo, o null si todavia no lo dijo. */
  permissionMode: PermissionMode | null;
  /**
   * Modelo y esfuerzo que dice la configuracion, para el rato en que el archivo
   * todavia no tiene ninguna respuesta. Provisional: lo pisa lo observado.
   */
  defaults: AgentDefaults;
  /** Que esta esperando la CLI, o null si no espera nada. Ver `waitingFor`. */
  waitingFor: string | null;
}

/**
 * Cuanto duro un turno cuyo mensaje ya se entrego.
 *
 * La CLI escribe la duracion en la linea siguiente al ultimo mensaje del turno,
 * asi que casi siempre viaja dentro del propio evento. Cuando cae del otro lado
 * del corte de una lectura, llega por aca: el cliente le pone la duracion al
 * evento que ya tiene, en vez de recibirlo dos veces.
 */
export interface ServerConversationTurnsMessage {
  type: 'conversation.turns';
  terminalId: TerminalId;
  turns: { eventId: string; durationMs: number }[];
}

/**
 * Las partes de un mensaje que ya se entrego, rehechas.
 *
 * Mismo caso que `conversation.turns`: la imagen que el cuadro de escritura
 * manda por ruta no viaja en la linea del mensaje sino en una `attachment`
 * aparte, que llega despues. Casi siempre en la misma lectura —y entonces el
 * evento ya sale corregido—, pero un poll puede caer entre las dos lineas.
 *
 * El cliente le reemplaza las partes al evento que ya tiene, en vez de
 * recibirlo dos veces y tener que deduplicar.
 */
export interface ServerConversationPartsMessage {
  type: 'conversation.parts';
  terminalId: TerminalId;
  updates: { eventId: string; parts: ConversationPart[] }[];
}

/** Contenido de una imagen del historial, pedido con `conversation.image`. */
export interface ServerConversationImageMessage {
  type: 'conversation.imageData';
  terminalId: TerminalId;
  eventId: string;
  index: number;
  /** La forma en la que se pidio. Es parte de la clave con la que se guarda. */
  source: ConversationImageSource;
  mediaType: string;
  /** base64 sin prefijo, o null si no se pudo encontrar. */
  data: string | null;
}

/** Eventos nuevos del JSONL. Se agregan al final de lo que ya hay. */
export interface ServerConversationAppendMessage {
  type: 'conversation.append';
  terminalId: TerminalId;
  events: ConversationEvent[];
  usage: ContextUsage;
  /**
   * Modo de permiso segun la ultima linea `permission-mode` del archivo.
   *
   * Viaja aca y no en `defaults` porque no es configuracion sino observacion:
   * es el modo con el que la CLI acaba de trabajar, y cambia solo si alguien
   * lo cambia — desde el combo o con `shift+tab` en la solapa CLI.
   */
  permissionMode: PermissionMode | null;
}

/** Tramo anterior, en respuesta a `conversation.loadMore`. Va al principio. */
export interface ServerConversationPageMessage {
  type: 'conversation.page';
  terminalId: TerminalId;
  events: ConversationEvent[];
  hasMore: boolean;
}

/**
 * El modo de permiso cambio, sin que haya llegado ningun mensaje nuevo.
 *
 * Hace falta como mensaje propio porque el modo viaja pegado a los eventos, y
 * el caso que importa no tiene ninguno: uno cambia el modo y quiere ver que
 * cambio, sin escribirle nada al agente. La CLI escribe su linea
 * `permission-mode` en ese momento; sin esto, el combo se quedaba mostrando el
 * modo viejo hasta el turno siguiente. Encontrado probando.
 */
export interface ServerConversationModeMessage {
  type: 'conversation.mode';
  terminalId: TerminalId;
  mode: PermissionMode;
}

/**
 * La CLI esta esperando una respuesta del usuario.
 *
 * Sale de `~/.claude/sessions/<pid>.json`, que la CLI reescribe cuando cambia
 * de estado (ver `cli-status.ts` en el servidor). Es el unico dato del sistema
 * de archivos que dice que hay algo esperando: **el JSONL no lo dice**, porque
 * mientras un permiso esta pendiente el archivo de sesion tiene el `tool_use` y
 * nada mas.
 *
 * Por lo mismo, esto **no** trae el contenido del pedido. Dice que espera y de
 * que clase, nunca que herramienta pidio permiso ni con que opciones: eso no
 * esta en ningun archivo, y por eso la conversacion avisa y lleva a la solapa
 * CLI en vez de dibujar botones que no puede llenar.
 */
export interface ServerConversationWaitingMessage {
  type: 'conversation.waiting';
  terminalId: TerminalId;
  /**
   * Etiqueta cruda de la CLI, o null si dejo de esperar.
   *
   * Valores vistos en el binario de la 2.1.261: `permission prompt`,
   * `input needed`, `worker request`, `sandbox request`, `dialog open`. Viaja
   * cruda a proposito: si una version futura agrega una etiqueta, el cliente
   * la trata como "algo espera" en vez de perderla.
   */
  waitingFor: string | null;
}

/** Un paso del selector de carpetas: donde estamos y que hay adentro. */
export interface ServerPickerListingMessage {
  type: 'picker.listing';
  listing: DirectoryPickerListing;
}

/** Cambio de estado sin eventos: por ejemplo, el archivo aparecio. */
export interface ServerConversationStateMessage {
  type: 'conversation.state';
  terminalId: TerminalId;
  state: ConversationState;
}

/** Estado de git de una pestana. Llega al suscribirse y en cada cambio. */
export interface ServerGitStatusMessage {
  type: 'git.status';
  terminalId: TerminalId;
  status: GitStatus;
}

export interface ServerGitDiffMessage {
  type: 'git.diff';
  terminalId: TerminalId;
  diff: GitDiff;
}

export interface ServerFilesListingMessage {
  type: 'files.listing';
  terminalId: TerminalId;
  listing: DirectoryListing;
}

export interface ServerFilePreviewMessage {
  type: 'files.preview';
  terminalId: TerminalId;
  preview: FilePreview;
}

/**
 * Los planes que escribio esta conversacion.
 *
 * Se manda entera al suscribirse y cada vez que aparece uno nuevo. La lista es
 * de tres o cuatro entradas de un par de campos, asi que reenviarla completa
 * sale mas barato que ensenarle al cliente a fusionar.
 */
export interface ServerConversationPlansMessage {
  type: 'conversation.plans';
  terminalId: TerminalId;
  plans: SessionPlan[];
}

/** El contenido de un plan, recortado y listo para renderizar. */
export interface ServerPlanContentMessage {
  type: 'plans.content';
  terminalId: TerminalId;
  plan: PlanContent;
}

export interface ServerFileSearchMessage {
  type: 'files.results';
  terminalId: TerminalId;
  result: FileSearchResult;
}

/**
 * La lista completa de notas. Se manda al conectar y tras cada cambio.
 *
 * Con una excepcion: quien escribe el texto **no** la recibe de vuelta. Un eco
 * de cada tecla pisaria lo que el usuario tecleo entre el envio y la respuesta.
 */
export interface ServerNotesListMessage {
  type: 'notes.list';
  notes: Note[];
}

export interface ServerNoteImageMessage {
  type: 'notes.imageData';
  imageId: string;
  mediaType: string;
  /** base64 sin prefijo, o null si la imagen ya no existe. */
  data: string | null;
}

export type ServerErrorCode =
  | 'cli-not-found'
  | 'shell-not-found'
  | 'spawn-failed'
  | 'bad-message'
  | 'unknown-terminal'
  /** La pestana existe pero no tiene CLI corriendo: dormida o terminada. */
  | 'terminal-asleep'
  | 'invalid-cwd'
  | 'too-many-terminals'
  | 'invalid-path'
  | 'read-failed'
  | 'submit-failed'
  | 'answer-failed'
  | 'mode-failed'
  | 'archive-failed'
  | 'notes-failed'
  | 'picker-failed'
  | 'internal';

export const SERVER_ERROR_CODES: readonly ServerErrorCode[] = [
  'cli-not-found',
  'shell-not-found',
  'spawn-failed',
  'bad-message',
  'unknown-terminal',
  'terminal-asleep',
  'invalid-cwd',
  'too-many-terminals',
  'invalid-path',
  'read-failed',
  'submit-failed',
  'answer-failed',
  'mode-failed',
  'archive-failed',
  'notes-failed',
  'picker-failed',
  'internal',
];

export interface ServerErrorMessage {
  type: 'error';
  code: ServerErrorCode;
  /** Texto para mostrar al usuario. */
  message: string;
  /** Para la consola del navegador. */
  detail?: string;
  /** Presente si el error responde a una peticion concreta. */
  requestId?: string;
}

export type ServerMessage =
  | ServerHelloMessage
  | ServerTerminalListMessage
  | ServerTerminalOpenedMessage
  | ServerTerminalOutputMessage
  | ServerTerminalReplayMessage
  | ServerTerminalExitMessage
  | ServerTerminalClosedMessage
  | ServerTerminalActivityMessage
  | ServerIndexStatusMessage
  | ServerIndexProjectsMessage
  | ServerConversationResetMessage
  | ServerConversationAppendMessage
  | ServerConversationModeMessage
  | ServerConversationWaitingMessage
  | ServerConversationPageMessage
  | ServerConversationStateMessage
  | ServerConversationTurnsMessage
  | ServerConversationPartsMessage
  | ServerConversationImageMessage
  | ServerGitStatusMessage
  | ServerGitDiffMessage
  | ServerPickerListingMessage
  | ServerFilesListingMessage
  | ServerFilePreviewMessage
  | ServerFileSearchMessage
  | ServerConversationPlansMessage
  | ServerPlanContentMessage
  | ServerNotesListMessage
  | ServerNoteImageMessage
  | ServerErrorMessage;

export type ServerMessageType = ServerMessage['type'];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/**
 * Una imagen del cuadro de escritura.
 *
 * Solo se comprueba la forma. Que el contenido **sea** una imagen lo decide el
 * servidor mirando la firma de los bytes, no este parser ni el navegador.
 */
/**
 * Modelo y esfuerzo anunciados por la configuracion.
 *
 * A diferencia del resto, un valor ausente o mal formado no invalida el
 * mensaje: es un dato de conveniencia. Sin el, el combo vuelve a "sin datos",
 * que es exactamente lo que mostraba antes de que existiera.
 */
function parseAgentDefaults(value: unknown): AgentDefaults {
  const empty: AgentDefaults = { model: null, effort: null, contextWindow: null };
  if (typeof value !== 'object' || value === null) return empty;
  const record = value as Record<string, unknown>;
  return {
    model: asNonEmptyString(record['model']),
    effort: asNonEmptyString(record['effort']),
    contextWindow: asFiniteNumber(record['contextWindow']),
  };
}

function parseSubmitImage(value: unknown): SubmitImage | null {
  const record = asRecord(value);
  if (record === null) return null;
  const mediaType = asNonEmptyString(record['mediaType']);
  const data = asNonEmptyString(record['data']);
  return mediaType === null || data === null ? null : { mediaType, data };
}

/**
 * Lo elegido en una pregunta: indices de opciones, o texto propio.
 *
 * El texto propio es la opcion `Type something` que la CLI agrega al final de
 * cada pregunta. Viaja como una forma distinta y no como un indice magico
 * —`-1`, o `optionCount`— para que nada pueda confundirlo con una opcion real:
 * lo que se elige aca termina en teclas escritas en un TUI.
 */
function parseSelection(value: unknown): AnswerSelection | null {
  if (Array.isArray(value)) {
    const chosen: number[] = [];
    for (const entry of value) {
      const index = asFiniteNumber(entry);
      if (index === null || !Number.isInteger(index) || index < 0) return null;
      chosen.push(index);
    }
    return chosen;
  }

  const record = asRecord(value);
  if (record === null || record['kind'] !== 'free') return null;
  const text = asString(record['text']);
  return text === null ? null : { kind: 'free', text };
}

export function parseClientMessage(raw: string): ClientMessage | null {
  const record = asRecord(parseJson(raw));
  if (record === null) return null;

  switch (record['type']) {
    case 'input': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const data = asString(record['data']);
      return terminalId === null || data === null
        ? null
        : { type: 'input', terminalId, data };
    }
    case 'agent.submit': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const text = asString(record['text']);
      const images = asArrayOf(record['images'], parseSubmitImage);
      if (terminalId === null || text === null || images === null) return null;
      const message: ClientSubmitMessage = { type: 'agent.submit', terminalId, text, images };
      // Ausente significa enviar: dejarlo escrito es el caso raro.
      if (record['send'] === false) message.send = false;
      return message;
    }
    case 'agent.mode': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const mode = record['mode'];
      return terminalId === null || !isPermissionMode(mode)
        ? null
        : { type: 'agent.mode', terminalId, mode };
    }
    case 'agent.answer': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const toolUseId = asNonEmptyString(record['toolUseId']);
      const selections = asArrayOf(record['selections'], parseSelection);
      return terminalId === null || toolUseId === null || selections === null
        ? null
        : { type: 'agent.answer', terminalId, toolUseId, selections };
    }
    case 'session.archive': {
      const sessionIds = asStringArray(record['sessionIds']);
      const archived = record['archived'];
      return sessionIds === null || typeof archived !== 'boolean'
        ? null
        : { type: 'session.archive', sessionIds, archived };
    }
    case 'agent.interrupt': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'agent.interrupt', terminalId };
    }
    case 'resize': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const cols = asPositiveInt(record['cols']);
      const rows = asPositiveInt(record['rows']);
      return terminalId === null || cols === null || rows === null
        ? null
        : { type: 'resize', terminalId, cols, rows };
    }
    case 'terminal.open': {
      const requestId = asNonEmptyString(record['requestId']);
      const cwd = asNonEmptyString(record['cwd']);
      if (requestId === null || cwd === null) return null;

      const message: ClientOpenTerminalMessage = { type: 'terminal.open', requestId, cwd };
      const resumeSessionId = asNonEmptyString(record['resumeSessionId']);
      if (resumeSessionId !== null) message.resumeSessionId = resumeSessionId;
      const label = asString(record['label']);
      if (label !== null) message.label = label;
      const kind = asLiteral(record['kind'], TERMINAL_KINDS);
      if (kind !== null) message.kind = kind;
      return message;
    }
    case 'terminal.close': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.close', terminalId };
    }
    case 'terminal.wake': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.wake', terminalId };
    }
    case 'terminal.attach': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const cols = asPositiveInt(record['cols']);
      const rows = asPositiveInt(record['rows']);
      return terminalId === null || cols === null || rows === null
        ? null
        : { type: 'terminal.attach', terminalId, cols, rows };
    }
    case 'terminal.detach': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.detach', terminalId };
    }
    case 'terminal.rename': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const label = asString(record['label']);
      return terminalId === null || label === null
        ? null
        : { type: 'terminal.rename', terminalId, label };
    }
    case 'tabs.reorder': {
      const terminalIds = asStringArray(record['terminalIds']);
      return terminalIds === null ? null : { type: 'tabs.reorder', terminalIds };
    }
    case 'index.refresh':
      return { type: 'index.refresh' };
    case 'conversation.subscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'conversation.subscribe', terminalId };
    }
    case 'conversation.unsubscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'conversation.unsubscribe', terminalId };
    }
    case 'conversation.loadMore': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const beforeEventId = asNonEmptyString(record['beforeEventId']);
      const limit = asPositiveInt(record['limit']);
      return terminalId === null || beforeEventId === null || limit === null
        ? null
        : { type: 'conversation.loadMore', terminalId, beforeEventId, limit };
    }
    case 'conversation.image': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const eventId = asNonEmptyString(record['eventId']);
      const index = asFiniteNumber(record['index']);
      // Sin `source` es una imagen del propio mensaje, que es lo unico que
      // habia antes de que existieran las dos formas.
      const source = asLiteral(record['source'], CONVERSATION_IMAGE_SOURCES) ?? 'content';
      return terminalId === null || eventId === null || index === null || index < 0
        ? null
        : { type: 'conversation.image', terminalId, eventId, index, source };
    }
    case 'git.subscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'git.subscribe', terminalId };
    }
    case 'git.unsubscribe': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'git.unsubscribe', terminalId };
    }
    case 'git.refresh': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'git.refresh', terminalId };
    }
    case 'git.diff': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const diffPath = asNonEmptyString(record['path']);
      return terminalId === null || diffPath === null
        ? null
        : { type: 'git.diff', terminalId, path: diffPath, staged: record['staged'] === true };
    }
    case 'files.list': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // La raiz es la cadena vacia, asi que aca no vale asNonEmptyString.
      const listPath = asString(record['path']);
      return terminalId === null || listPath === null
        ? null
        : {
            type: 'files.list',
            terminalId,
            path: listPath,
            includeHidden: record['includeHidden'] === true,
          };
    }
    case 'files.search': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const query = asString(record['query']);
      return terminalId === null || query === null
        ? null
        : {
            type: 'files.search',
            terminalId,
            query,
            includeHidden: record['includeHidden'] === true,
          };
    }
    case 'files.read': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const readPath = asNonEmptyString(record['path']);
      return terminalId === null || readPath === null
        ? null
        : { type: 'files.read', terminalId, path: readPath };
    }
    case 'plans.read': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const fileName = asNonEmptyString(record['fileName']);
      return terminalId === null || fileName === null
        ? null
        : { type: 'plans.read', terminalId, fileName };
    }
    case 'files.reveal': {
      const terminalId = asNonEmptyString(record['terminalId']);
      // Cadena vacia = el propio cwd, y abrirlo es legitimo.
      const revealPath = asString(record['path']);
      return terminalId === null || revealPath === null
        ? null
        : { type: 'files.reveal', terminalId, path: revealPath };
    }
    case 'notes.create': {
      const noteId = asNonEmptyString(record['noteId']);
      return noteId === null ? null : { type: 'notes.create', noteId };
    }
    case 'notes.update': {
      const noteId = asNonEmptyString(record['noteId']);
      const text = asString(record['text']);
      return noteId === null || text === null ? null : { type: 'notes.update', noteId, text };
    }
    case 'notes.delete': {
      const noteId = asNonEmptyString(record['noteId']);
      return noteId === null ? null : { type: 'notes.delete', noteId };
    }
    case 'notes.addImage': {
      const noteId = asNonEmptyString(record['noteId']);
      const image = parseSubmitImage(record['image']);
      return noteId === null || image === null ? null : { type: 'notes.addImage', noteId, image };
    }
    case 'notes.removeImage': {
      const noteId = asNonEmptyString(record['noteId']);
      const imageId = asNonEmptyString(record['imageId']);
      return noteId === null || imageId === null
        ? null
        : { type: 'notes.removeImage', noteId, imageId };
    }
    case 'notes.image': {
      const imageId = asNonEmptyString(record['imageId']);
      return imageId === null ? null : { type: 'notes.image', imageId };
    }
    case 'notes.send': {
      const noteId = asNonEmptyString(record['noteId']);
      const terminalId = asNonEmptyString(record['terminalId']);
      return noteId === null || terminalId === null
        ? null
        : { type: 'notes.send', noteId, terminalId };
    }
    case 'picker.open':
      return { type: 'picker.open' };
    case 'picker.enter': {
      const pickerId = asNonEmptyString(record['pickerId']);
      const name = asNonEmptyString(record['name']);
      return pickerId === null || name === null
        ? null
        : { type: 'picker.enter', pickerId, name };
    }
    case 'picker.root': {
      const pickerId = asNonEmptyString(record['pickerId']);
      const rootIndex = asFiniteNumber(record['rootIndex']);
      return pickerId === null || rootIndex === null || rootIndex < 0
        ? null
        : { type: 'picker.root', pickerId, rootIndex };
    }
    case 'picker.create': {
      const pickerId = asNonEmptyString(record['pickerId']);
      const name = asNonEmptyString(record['name']);
      return pickerId === null || name === null
        ? null
        : { type: 'picker.create', pickerId, name };
    }
    case 'picker.close': {
      const pickerId = asNonEmptyString(record['pickerId']);
      return pickerId === null ? null : { type: 'picker.close', pickerId };
    }
    default:
      return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  const record = asRecord(parseJson(raw));
  if (record === null) return null;

  switch (record['type']) {
    case 'hello': {
      const protocolVersion = asFiniteNumber(record['protocolVersion']);
      const platform = asString(record['platform']);
      const defaultCwd = asString(record['defaultCwd']);
      if (protocolVersion === null || platform === null || defaultCwd === null) return null;
      return {
        type: 'hello',
        protocolVersion,
        cliAvailable: record['cliAvailable'] === true,
        cliVersion: asString(record['cliVersion']),
        cliMissingMessage: asString(record['cliMissingMessage']),
        platform,
        defaultCwd,
        transcriptMarkerStripped: record['transcriptMarkerStripped'] === true,
        shellName: asNonEmptyString(record['shellName']),
      };
    }
    case 'terminal.list': {
      const terminals = asArrayOf(record['terminals'], parseTerminalDescriptor);
      const order = asStringArray(record['order']);
      return terminals === null || order === null
        ? null
        : { type: 'terminal.list', terminals, order };
    }
    case 'terminal.opened': {
      const requestId = asNonEmptyString(record['requestId']);
      const terminal = parseTerminalDescriptor(record['terminal']);
      return requestId === null || terminal === null
        ? null
        : { type: 'terminal.opened', requestId, terminal };
    }
    case 'terminal.output': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const data = asString(record['data']);
      return terminalId === null || data === null
        ? null
        : { type: 'terminal.output', terminalId, data };
    }
    case 'terminal.replay': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const data = asString(record['data']);
      return terminalId === null || data === null
        ? null
        : { type: 'terminal.replay', terminalId, data, truncated: record['truncated'] === true };
    }
    case 'terminal.exit': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const exitCode = asFiniteNumber(record['exitCode']);
      if (terminalId === null || exitCode === null) return null;
      const rawSignal = record['signal'];
      return {
        type: 'terminal.exit',
        terminalId,
        exitCode,
        signal: typeof rawSignal === 'number' ? rawSignal : null,
      };
    }
    case 'terminal.closed': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null ? null : { type: 'terminal.closed', terminalId };
    }
    case 'terminal.activity': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const activity = asLiteral(record['activity'], TERMINAL_ACTIVITIES);
      return terminalId === null || activity === null
        ? null
        : { type: 'terminal.activity', terminalId, activity };
    }
    case 'index.status': {
      const status = parseIndexStatus(record['status']);
      return status === null ? null : { type: 'index.status', status };
    }
    case 'index.projects': {
      const projects = asArrayOf(record['projects'], parseProjectSummary);
      return projects === null
        ? null
        : { type: 'index.projects', projects, replace: record['replace'] === true };
    }
    case 'conversation.reset': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const sessionId = asNonEmptyString(record['sessionId']);
      const state = asLiteral(record['state'], CONVERSATION_STATES);
      const events = asArrayOf(record['events'], parseConversationEvent);
      const usage = parseContextUsage(record['usage']);
      return terminalId === null ||
        sessionId === null ||
        state === null ||
        events === null ||
        usage === null
        ? null
        : {
            type: 'conversation.reset',
            terminalId,
            sessionId,
            state,
            events,
            hasMore: record['hasMore'] === true,
            usage,
            permissionMode: isPermissionMode(record['permissionMode'])
              ? record['permissionMode']
              : null,
            defaults: parseAgentDefaults(record['defaults']),
            waitingFor: asNonEmptyString(record['waitingFor']),
          };
    }
    case 'conversation.append': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const events = asArrayOf(record['events'], parseConversationEvent);
      const usage = parseContextUsage(record['usage']);
      return terminalId === null || events === null || usage === null
        ? null
        : {
            type: 'conversation.append',
            terminalId,
            events,
            usage,
            permissionMode: isPermissionMode(record['permissionMode'])
              ? record['permissionMode']
              : null,
          };
    }
    case 'conversation.mode': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const mode = record['mode'];
      return terminalId === null || !isPermissionMode(mode)
        ? null
        : { type: 'conversation.mode', terminalId, mode };
    }
    case 'conversation.waiting': {
      const terminalId = asNonEmptyString(record['terminalId']);
      return terminalId === null
        ? null
        : {
            type: 'conversation.waiting',
            terminalId,
            // Cruda: una etiqueta nueva de una version futura tiene que llegar
            // igual, y el cliente ya sabe que no la conoce.
            waitingFor: asNonEmptyString(record['waitingFor']),
          };
    }
    case 'conversation.page': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const events = asArrayOf(record['events'], parseConversationEvent);
      return terminalId === null || events === null
        ? null
        : {
            type: 'conversation.page',
            terminalId,
            events,
            hasMore: record['hasMore'] === true,
          };
    }
    case 'conversation.turns': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const turns = asArrayOf(record['turns'], (value) => {
        const entry = asRecord(value);
        if (entry === null) return null;
        const eventId = asNonEmptyString(entry['eventId']);
        const durationMs = asFiniteNumber(entry['durationMs']);
        return eventId === null || durationMs === null ? null : { eventId, durationMs };
      });
      return terminalId === null || turns === null
        ? null
        : { type: 'conversation.turns', terminalId, turns };
    }
    case 'conversation.parts': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const updates = asArrayOf(record['updates'], (value) => {
        const entry = asRecord(value);
        if (entry === null) return null;
        const eventId = asNonEmptyString(entry['eventId']);
        const parts = asArrayOf(entry['parts'], parseConversationPart);
        return eventId === null || parts === null ? null : { eventId, parts };
      });
      return terminalId === null || updates === null
        ? null
        : { type: 'conversation.parts', terminalId, updates };
    }
    case 'conversation.imageData': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const eventId = asNonEmptyString(record['eventId']);
      const index = asFiniteNumber(record['index']);
      const mediaType = asString(record['mediaType']);
      if (terminalId === null || eventId === null || index === null || mediaType === null) {
        return null;
      }
      const data = record['data'];
      return {
        type: 'conversation.imageData',
        terminalId,
        eventId,
        index,
        source: asLiteral(record['source'], CONVERSATION_IMAGE_SOURCES) ?? 'content',
        mediaType,
        data: typeof data === 'string' ? data : null,
      };
    }
    case 'conversation.state': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const state = asLiteral(record['state'], CONVERSATION_STATES);
      return terminalId === null || state === null
        ? null
        : { type: 'conversation.state', terminalId, state };
    }
    case 'git.status': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const status = parseGitStatus(record['status']);
      return terminalId === null || status === null
        ? null
        : { type: 'git.status', terminalId, status };
    }
    case 'git.diff': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const diff = parseGitDiff(record['diff']);
      return terminalId === null || diff === null
        ? null
        : { type: 'git.diff', terminalId, diff };
    }
    case 'files.listing': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const listing = parseDirectoryListing(record['listing']);
      return terminalId === null || listing === null
        ? null
        : { type: 'files.listing', terminalId, listing };
    }
    case 'picker.listing': {
      const listing = parseDirectoryPickerListing(record['listing']);
      return listing === null ? null : { type: 'picker.listing', listing };
    }
    case 'files.preview': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const preview = parseFilePreview(record['preview']);
      return terminalId === null || preview === null
        ? null
        : { type: 'files.preview', terminalId, preview };
    }
    case 'conversation.plans': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const plans = asArrayOf(record['plans'], parseSessionPlan);
      return terminalId === null || plans === null
        ? null
        : { type: 'conversation.plans', terminalId, plans };
    }
    case 'plans.content': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const plan = parsePlanContent(record['plan']);
      return terminalId === null || plan === null
        ? null
        : { type: 'plans.content', terminalId, plan };
    }
    case 'files.results': {
      const terminalId = asNonEmptyString(record['terminalId']);
      const result = parseFileSearchResult(record['result']);
      return terminalId === null || result === null
        ? null
        : { type: 'files.results', terminalId, result };
    }
    case 'notes.list': {
      const notes = asArrayOf(record['notes'], parseNote);
      return notes === null ? null : { type: 'notes.list', notes };
    }
    case 'notes.imageData': {
      const imageId = asNonEmptyString(record['imageId']);
      const mediaType = asString(record['mediaType']);
      if (imageId === null || mediaType === null) return null;
      const data = record['data'];
      return {
        type: 'notes.imageData',
        imageId,
        mediaType,
        data: typeof data === 'string' ? data : null,
      };
    }
    case 'error': {
      const message = asString(record['message']);
      if (message === null) return null;
      const code = asLiteral(record['code'], SERVER_ERROR_CODES) ?? 'internal';
      const parsed: ServerErrorMessage = { type: 'error', code, message };
      const detail = asString(record['detail']);
      if (detail !== null) parsed.detail = detail;
      const requestId = asNonEmptyString(record['requestId']);
      if (requestId !== null) parsed.requestId = requestId;
      return parsed;
    }
    default:
      return null;
  }
}

/** Serializa con el tipo puesto, para que nadie mande un objeto suelto. */
export function encodeClientMessage(message: ClientMessage): string {
  return JSON.stringify(message);
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}
