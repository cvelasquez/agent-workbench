/**
 * Entidades que cliente y servidor comparten.
 *
 * Se mantienen planas y serializables: viajan por el WebSocket tal cual, sin
 * clases ni fechas ni nada que JSON no sepa representar. Las marcas de tiempo
 * son milisegundos epoch.
 */

import { AGENT_IDS, SESSION_AGENT_IDS, type AgentId, type SessionAgentId } from './agents.js';
import {
  parseSessionWorktree,
  parseTabWorktree,
  type SessionWorktree,
  type TabWorktree,
} from './worktrees.js';
import {
  asArrayFiltered,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
} from './validation.js';

/** Identifica una pty viva. Lo genera el servidor. */
export type TerminalId = string;

/**
 * Identifica una conversacion de la CLI. Es el UUID que le pasamos con
 * `--session-id`, y tambien el nombre del archivo JSONL que va a escribir.
 */
export type SessionId = string;

/** De donde salio el titulo que mostramos. Sirve para ordenar y para la UI. */
export type SessionTitleSource = 'custom' | 'ai' | 'first-message' | 'none';

export const SESSION_TITLE_SOURCES: readonly SessionTitleSource[] = [
  'custom',
  'ai',
  'first-message',
  'none',
];

/**
 * Hito 28. De donde se lee una sesion de la barra.
 *
 *  - `native`: del historial de su CLI, como siempre.
 *  - `vault`: el historial nativo ya no la tiene (o nunca la tuvo: una
 *    importada) y solo queda en la copia propia.
 */
export type SessionStorage = 'native' | 'vault';

export const SESSION_STORAGES: readonly SessionStorage[] = ['native', 'vault'];

/** Una conversacion del historial, tal como la resume el indexador. */
export interface SessionSummary {
  /**
   * Que CLI la escribio. Decide con que CLI se reanuda.
   *
   * Desde el hito 28 puede ser un id importado (`IMPORTED_AGENT_IDS`), que no
   * se reanuda con nada: quien lanza o reanuda estrecha antes con `isAgentId`.
   */
  agent: SessionAgentId;
  sessionId: SessionId;
  /**
   * El `cwd` que trae el propio archivo, o `''` si no trae ninguno.
   *
   * No siempre es el del proyecto: el proyecto agrupa por clave normalizada, y
   * dos formas de la misma carpeta (`D:\x` y `d:\x\`) caen juntas. Reanudar
   * tiene que usar la forma que la CLI escribio, porque de ella sale donde
   * busca el archivo.
   */
  cwd: string;
  title: string;
  titleSource: SessionTitleSource;
  /** mtime del archivo. Lo usamos para ordenar y para invalidar la cache. */
  updatedAt: number;
  sizeBytes: number;
  /**
   * true si el usuario la escondio de la barra lateral.
   *
   * **Archivada no es borrada**: el `.jsonl` sigue en disco y `--resume` sigue
   * funcionando. Viaja marcada en vez de filtrada en el servidor para que
   * "ver archivadas" sea un interruptor de la vista y no otra peticion.
   */
  archived: boolean;
  /** Hito 28. `vault`: el historial nativo ya no la tiene; se lee de la copia. */
  storage: SessionStorage;
  /** Hito 28. true si la copia es parcial (un rescate). Siempre false en `native`. */
  partial: boolean;
  /**
   * Hito 48. La rama aparte en la que trabajo, o null si fue en la carpeta del
   * proyecto. Con esto la sesion cae dentro de su proyecto, con su rama, y no
   * como un proyecto aparte.
   */
  worktree: SessionWorktree | null;
  /**
   * Hito 56. true si su carpeta (`cwd`) es la anterior de un proyecto que se
   * movio de lugar (`ProjectSummary.relocations`): la fila se lee y se continua
   * en la carpeta nueva, pero no se retoma con un clic, porque su CLI la busca
   * en una carpeta que ya no esta. Ausente es false: un servidor anterior no la
   * manda, y una fila de siempre no la lleva.
   */
  relocated?: boolean;
}

/**
 * Hito 56. A donde se movio la carpeta de un proyecto, vista desde el proyecto
 * (§13.14): la carpeta que traia el historial y la que se asocio.
 */
export interface ProjectRelocation {
  /** La carpeta anterior, tal cual la tenia el historial. */
  from: string;
  /** La carpeta de ahora, tal cual la eligio el usuario. */
  to: string;
  /** Cuantas conversaciones de este proyecto vienen de ahi. */
  sessions: number;
  /**
   * true si la carpeta anterior existe otra vez: la ubicacion no se aplica y el
   * historial vuelve a su carpeta. Quitarla o cambiarla lo decide el usuario.
   */
  paused: boolean;
}

/**
 * Hito 56. Lo que el servidor muestra antes de asociar la carpeta de un
 * proyecto a otra (`location.preview`). La carpeta elegida queda en el servidor
 * bajo `previewId`: el cliente nunca nombra una ruta (CLAUDE.md 2.4).
 */
export interface ProjectLocationPreview {
  /** Lo que se manda para confirmar. Vale mientras el servidor no reciba otra vista previa. */
  previewId: string;
  projectKey: string;
  /** Las carpetas anteriores que se asocian (las del historial que no existen). */
  from: string[];
  /** La carpeta elegida. */
  to: string;
  /** Conversaciones que pasan a la carpeta nueva, las de subcarpetas y ramas aparte incluidas. */
  moving: number;
  /** De las que se mueven, las que corrieron en una subcarpeta. */
  inSubfolders: number;
  /** Conversaciones que la carpeta nueva ya tiene: quedan juntas con las que llegan. */
  inDestination: number;
  /** Pestanas abiertas en las carpetas anteriores, vivas o no. Hay que cerrarlas antes. */
  tabs: number;
  /** De esas pestanas, las que tienen mensajes en cola o programados. */
  pending: number;
}

/**
 * Un proyecto de la barra lateral: las sesiones de todas las CLIs que
 * trabajaron en la misma carpeta.
 *
 * Se agrupa por el `cwd` que traen los archivos, normalizado, y no por la
 * carpeta donde la CLI los guarda: esa carpeta NO se puede revertir a una ruta
 * (CLAUDE.md 4.1), y cada CLI la nombra a su manera.
 */
export interface ProjectSummary {
  /**
   * Identidad del proyecto. `normalizeCwdKey(cwd)` calculada en el servidor, o
   * `unknown:<agent>:<grupo>` cuando ningun archivo del grupo trae `cwd`.
   * El cliente la usa como clave y nunca la interpreta.
   */
  key: string;
  /**
   * Nombre para mostrar cuando `cwd` esta vacio: el agrupador nativo de la CLI
   * (con Claude Code, el nombre de la carpeta del historial). `''` si hay `cwd`.
   */
  fallbackName: string;
  /** Ruta real, leida del campo `cwd` del historial. La primera vista. */
  cwd: string;
  /** false si el directorio ya no esta en disco. Se marca, no se oculta. */
  cwdExists: boolean;
  /** Hito 48. true si la carpeta esta en un repositorio de git: ahi se ofrece una rama aparte. */
  isGitRepo: boolean;
  sessions: SessionSummary[];
  lastActivityAt: number;
  /**
   * Hito 56. Las carpetas anteriores que se asociaron a este proyecto, con sus
   * conversaciones. Ausente: ninguna (un servidor anterior, o un proyecto que
   * no se movio).
   */
  relocations?: ProjectRelocation[];
}

export type IndexState = 'idle' | 'scanning' | 'ready';

export const INDEX_STATES: readonly IndexState[] = ['idle', 'scanning', 'ready'];

export interface IndexStatus {
  state: IndexState;
  scannedFiles: number;
  totalFiles: number;
}

/**
 * Que proceso hay del otro lado de una pty.
 *
 * `agent` es una pestana de la CLI: tiene conversacion, JSONL y medidor de
 * contexto, y se guarda entre arranques. `shell` es la consola del sistema que
 * vive en la columna derecha: no escribe historial, no se restaura y no aparece
 * en la barra de pestanas. Distinguirlas con un campo y no por convencion es lo
 * que evita que el seguidor de conversacion se ponga a esperar un archivo que
 * nunca va a existir.
 */
export type TerminalKind = 'agent' | 'shell';

export const TERMINAL_KINDS: readonly TerminalKind[] = ['agent', 'shell'];

/**
 * Una pestana: una pty viva en el servidor.
 *
 * Vive independiente del WebSocket. Que el navegador recargue no la toca.
 */
export interface TerminalDescriptor {
  terminalId: TerminalId;
  kind: TerminalKind;
  /** Directorio de trabajo del proceso. */
  cwd: string;
  /**
   * Que CLI corre en la pestana. **null en las consolas**: no tienen agente, y
   * inventarles uno haria que algo las tratara como conversacion.
   */
  agent: AgentId | null;
  /**
   * Id de la conversacion que da el adaptador. Con Claude Code, el UUID pasado
   * con --session-id, o el que se reanudo con --resume.
   *
   * **Vacio en las consolas**: no hay conversacion que identificar. Es la senal
   * que mira el hub para no seguir un JSONL inexistente. En una pestana de
   * agente puede quedar vacio mientras se descubre, con una CLI que pone el id
   * ella misma (hito 25 en adelante); con Claude Code no pasa nunca.
   */
  sessionId: SessionId;
  /** Etiqueta editable de la pestana. */
  label: string;
  /** true si se abrio con --resume sobre una sesion existente. */
  resumed: boolean;
  createdAt: number;
  /** false cuando el proceso termino pero la pestana sigue abierta. */
  alive: boolean;
  /** Codigo de salida, null mientras siga viva. */
  exitCode: number | null;
  /**
   * true si la pestana esta **dormida**: existe, se lee, y no tiene proceso.
   *
   * Es lo que devuelve una restauracion. Arrancar la aplicacion no lanza una
   * CLI por cada pestana guardada —seis pestanas eran seis procesos de varios
   * cientos de MB para leer lo que ya esta escrito en el JSONL— y la conversion
   * a pestana viva la pide el usuario con `terminal.wake`.
   *
   * No se confunde con una que murio: esa tiene `exitCode`, y lo que se le
   * ofrece al usuario dice otra cosa.
   */
  sleeping: boolean;
  /**
   * Epoch ms en que se lanzo el proceso que la pestana tiene **ahora**, o null
   * si no tiene: dormida o terminada.
   *
   * Dice que parte del historial es de este proceso y que parte es de uno
   * anterior. Lo usa el combo de esfuerzo (§5.4): una CLI que se vuelve a abrir
   * arranca con el esfuerzo de su configuracion, no con el ultimo que dejo
   * escrito la corrida anterior. Un servidor que no lo manda equivale a null.
   */
  launchedAt: number | null;
  /**
   * Hito 48. La rama de la carpeta de la pestana y su carpeta principal, o null
   * fuera de un repositorio de git. Decide el color y el lugar de la pestana, y
   * su etiqueta de rama (§6.38). Un servidor anterior no lo manda: null.
   */
  worktree: TabWorktree | null;
  /**
   * Hito 49. true en la pestana que abrio "Pedir revision": la CLI se lanza en
   * su modo de solo lectura, si lo tiene (`readOnlyLaunch`), y despierta igual.
   * Se guarda entre arranques. Siempre false en las consolas.
   */
  review: boolean;
}

/**
 * Que esta haciendo la CLI de una pestana, ahora mismo.
 *
 * No sale del JSONL —ahi no esta— sino del archivo que la CLI mantiene por
 * proceso vivo, `~/.claude/sessions/<pid>.json` (CLAUDE.md 4.13). Es el mismo
 * dato que ya alimentaba la barra del pie de la conversacion; lo que cambia es
 * que ahora viaja para **todas** las pestanas, porque la barra de pestanas las
 * dibuja todas.
 *
 * `offline` es no tener proceso: una pestana dormida, una que murio, o una que
 * la CLI todavia no registro. Son estados distintos para la aplicacion, pero
 * para "que esta haciendo" son el mismo: nada.
 *
 * `unknown` es una CLI que no publica su estado: la pestana tiene proceso, pero
 * no hay de donde saber si trabaja o espera. Se dice asi y no con `idle`, que
 * seria afirmar algo que nadie midio. Con Claude Code no se emite nunca.
 */
export type TerminalActivity = 'busy' | 'idle' | 'waiting' | 'offline' | 'unknown';

export const TERMINAL_ACTIVITIES: readonly TerminalActivity[] = [
  'busy',
  'idle',
  'waiting',
  'offline',
  'unknown',
];

/**
 * Por que una pestana **con proceso** quedo `offline` (hito 29, M2).
 *
 * `server-closed`: la CLI de la pestana es un cliente de un servidor que lanzo
 * la app —el `opencode serve`— y ese servidor termino sin que la app lo
 * pidiera. Medido con OpenCode 1.18.30: el TUI enganchado no termina, queda
 * apuntando a un puerto muerto y la pestana no dice nada. Con esto la vista lo
 * dice y ofrece relanzar.
 */
export type TerminalOfflineReason = 'server-closed';

export const TERMINAL_OFFLINE_REASONS: readonly TerminalOfflineReason[] = ['server-closed'];

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseSessionSummary(value: unknown): SessionSummary | null {
  const record = asRecord(value);
  if (record === null) return null;

  const sessionId = asNonEmptyString(record['sessionId']);
  const title = asString(record['title']);
  const titleSource = asLiteral(record['titleSource'], SESSION_TITLE_SOURCES);
  const updatedAt = asFiniteNumber(record['updatedAt']);
  const sizeBytes = asFiniteNumber(record['sizeBytes']);

  if (
    sessionId === null ||
    title === null ||
    titleSource === null ||
    updatedAt === null ||
    sizeBytes === null
  ) {
    return null;
  }
  /*
    Sin `agent` es de un servidor anterior, donde la unica CLI era Claude Code.
    Con un id que este lado no conoce, la sesion se descarta —reanudarla con
    otra CLI no la encontraria— y el proyecto sigue con las demas. Un id
    importado (hito 28) si se conoce: se lista y no se reanuda.
  */
  const agent =
    record['agent'] === undefined ? 'claude-code' : asLiteral(record['agent'], SESSION_AGENT_IDS);
  if (agent === null) return null;
  // Ausente = `''`, y al reanudar el cliente cae al `cwd` del proyecto, que es
  // lo que se usaba antes de que el campo existiera.
  const cwd = asString(record['cwd']) ?? '';
  // Ausente = no archivada. Un cliente viejo, o una cache escrita antes de que
  // esto existiera, no tiene por que dejar de leerse.
  return {
    agent,
    sessionId,
    cwd,
    title,
    titleSource,
    updatedAt,
    sizeBytes,
    archived: record['archived'] === true,
    // Ausente o desconocido = nativa: todo servidor anterior al hito 28, y toda
    // cache escrita antes, hablaba solo de historial nativo.
    storage: asLiteral(record['storage'], SESSION_STORAGES) ?? 'native',
    partial: record['partial'] === true,
    // Ausente = un servidor anterior al hito 48, o una sesion de la carpeta del proyecto.
    worktree: parseSessionWorktree(record['worktree']),
    // Hito 56. Solo cuando es true: una fila de siempre sale igual que antes.
    ...(record['relocated'] === true ? { relocated: true } : {}),
  };
}

/** Hito 56. Una carpeta anterior de un proyecto, o null si no tiene la forma. */
export function parseProjectRelocation(value: unknown): ProjectRelocation | null {
  const record = asRecord(value);
  if (record === null) return null;
  const from = asNonEmptyString(record['from']);
  const to = asNonEmptyString(record['to']);
  const sessions = asFiniteNumber(record['sessions']);
  if (from === null || to === null || sessions === null) return null;
  return { from, to, sessions, paused: record['paused'] === true };
}

/** Hito 56. La vista previa de ubicar un proyecto, o null si no tiene la forma. */
export function parseProjectLocationPreview(value: unknown): ProjectLocationPreview | null {
  const record = asRecord(value);
  if (record === null) return null;
  const previewId = asNonEmptyString(record['previewId']);
  const projectKey = asNonEmptyString(record['projectKey']);
  const to = asNonEmptyString(record['to']);
  const from = asArrayFiltered(record['from'], asNonEmptyString);
  const moving = asFiniteNumber(record['moving']);
  const inSubfolders = asFiniteNumber(record['inSubfolders']);
  const inDestination = asFiniteNumber(record['inDestination']);
  const tabs = asFiniteNumber(record['tabs']);
  const pending = asFiniteNumber(record['pending']);
  if (
    previewId === null ||
    projectKey === null ||
    to === null ||
    from === null ||
    from.length === 0 ||
    moving === null ||
    inSubfolders === null ||
    inDestination === null ||
    tabs === null ||
    pending === null
  ) {
    return null;
  }
  return { previewId, projectKey, from, to, moving, inSubfolders, inDestination, tabs, pending };
}

export function parseProjectSummary(value: unknown): ProjectSummary | null {
  const record = asRecord(value);
  if (record === null) return null;

  const cwd = asString(record['cwd']);
  const cwdExists = asBoolean(record['cwdExists']);
  // Una sesion que este lado no entiende no se lleva al proyecto entero.
  const sessions = asArrayFiltered(record['sessions'], parseSessionSummary);
  const lastActivityAt = asFiniteNumber(record['lastActivityAt']);

  if (cwd === null || cwdExists === null || sessions === null || lastActivityAt === null) {
    return null;
  }

  /*
    Un servidor anterior manda `slug` en vez de `key` (con HMR, cliente y
    servidor pueden quedar desfasados). El slug identificaba al proyecto y era
    lo que se mostraba sin `cwd`, asi que cubre las dos cosas.
  */
  const key = asNonEmptyString(record['key']);
  if (key !== null) {
    // Hito 56. Filtrada: una carpeta anterior que este lado no entiende no se lleva al proyecto.
    const relocations = asArrayFiltered(record['relocations'], parseProjectRelocation) ?? [];
    return {
      key,
      fallbackName: asString(record['fallbackName']) ?? '',
      cwd,
      cwdExists,
      isGitRepo: record['isGitRepo'] === true,
      sessions,
      lastActivityAt,
      ...(relocations.length > 0 ? { relocations } : {}),
    };
  }
  const slug = asNonEmptyString(record['slug']);
  if (slug === null) return null;
  return {
    key: slug,
    fallbackName: cwd.length === 0 ? slug : '',
    cwd,
    cwdExists,
    isGitRepo: false,
    sessions,
    lastActivityAt,
  };
}

export function parseIndexStatus(value: unknown): IndexStatus | null {
  const record = asRecord(value);
  if (record === null) return null;

  const state = asLiteral(record['state'], INDEX_STATES);
  const scannedFiles = asFiniteNumber(record['scannedFiles']);
  const totalFiles = asFiniteNumber(record['totalFiles']);
  if (state === null || scannedFiles === null || totalFiles === null) return null;

  return { state, scannedFiles, totalFiles };
}

export function parseTerminalDescriptor(value: unknown): TerminalDescriptor | null {
  const record = asRecord(value);
  if (record === null) return null;

  const terminalId = asNonEmptyString(record['terminalId']);
  // Un descriptor sin `kind` es de una version anterior del protocolo: era una
  // pestana de la CLI y nada mas.
  const kind = asLiteral(record['kind'], TERMINAL_KINDS) ?? 'agent';
  /*
    Una consola no tiene agente, diga lo que diga el campo. Una pestana sin el
    campo es de un servidor anterior, donde la unica CLI era Claude Code; con el
    campo y un id que este lado no conoce, el descriptor se descarta — abrirla
    como si fuera de otra CLI mandaria teclas a la equivocada.
  */
  let agent: AgentId | null = null;
  if (kind === 'agent') {
    agent = record['agent'] === undefined ? 'claude-code' : asLiteral(record['agent'], AGENT_IDS);
    if (agent === null) return null;
  }
  const cwd = asString(record['cwd']);
  // Vacio es valido: las consolas no tienen conversacion.
  const sessionId = asString(record['sessionId']);
  const label = asString(record['label']);
  const resumed = asBoolean(record['resumed']);
  const createdAt = asFiniteNumber(record['createdAt']);
  const alive = asBoolean(record['alive']);

  if (
    terminalId === null ||
    cwd === null ||
    sessionId === null ||
    label === null ||
    resumed === null ||
    createdAt === null ||
    alive === null
  ) {
    return null;
  }

  const rawExitCode = record['exitCode'];
  return {
    terminalId,
    kind,
    agent,
    cwd,
    sessionId,
    label,
    resumed,
    createdAt,
    alive,
    exitCode: typeof rawExitCode === 'number' ? rawExitCode : null,
    // Ausente = de una version anterior del protocolo, donde toda pestana
    // tenia proceso.
    sleeping: record['sleeping'] === true,
    // Ausente = un servidor anterior: no se sabe cuando arranco el proceso.
    launchedAt: asFiniteNumber(record['launchedAt']),
    worktree: parseTabWorktree(record['worktree']),
    // Ausente = un servidor anterior al hito 49: no hay pestanas de revision.
    review: kind === 'agent' && record['review'] === true,
  };
}
