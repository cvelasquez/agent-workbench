/**
 * Entidades que cliente y servidor comparten.
 *
 * Se mantienen planas y serializables: viajan por el WebSocket tal cual, sin
 * clases ni fechas ni nada que JSON no sepa representar. Las marcas de tiempo
 * son milisegundos epoch.
 */

import {
  asArrayOf,
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

/** Una conversacion del historial, tal como la resume el indexador. */
export interface SessionSummary {
  sessionId: SessionId;
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
}

/**
 * Un directorio de `~/.claude/projects/`.
 *
 * `slug` es el nombre de la carpeta y NO se puede revertir a una ruta: `cwd`
 * viene leido del JSONL. Ver CLAUDE.md 4.1.
 */
export interface ProjectSummary {
  slug: string;
  /** Ruta real, leida del campo `cwd` del JSONL. */
  cwd: string;
  /** false si el directorio ya no esta en disco. Se marca, no se oculta. */
  cwdExists: boolean;
  sessions: SessionSummary[];
  lastActivityAt: number;
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
   * UUID pasado con --session-id, o el que se reanudo con --resume.
   *
   * **Vacio en las consolas**: no hay conversacion que identificar. Es la senal
   * que mira el hub para no seguir un JSONL inexistente.
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
 */
export type TerminalActivity = 'busy' | 'idle' | 'waiting' | 'offline';

export const TERMINAL_ACTIVITIES: readonly TerminalActivity[] = [
  'busy',
  'idle',
  'waiting',
  'offline',
];

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
  // Ausente = no archivada. Un cliente viejo, o una cache escrita antes de que
  // esto existiera, no tiene por que dejar de leerse.
  return { sessionId, title, titleSource, updatedAt, sizeBytes, archived: record['archived'] === true };
}

export function parseProjectSummary(value: unknown): ProjectSummary | null {
  const record = asRecord(value);
  if (record === null) return null;

  const slug = asNonEmptyString(record['slug']);
  const cwd = asString(record['cwd']);
  const cwdExists = asBoolean(record['cwdExists']);
  const sessions = asArrayOf(record['sessions'], parseSessionSummary);
  const lastActivityAt = asFiniteNumber(record['lastActivityAt']);

  if (
    slug === null ||
    cwd === null ||
    cwdExists === null ||
    sessions === null ||
    lastActivityAt === null
  ) {
    return null;
  }
  return { slug, cwd, cwdExists, sessions, lastActivityAt };
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
  };
}
