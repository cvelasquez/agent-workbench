/**
 * La copia propia (hito 28): el formato de su carpeta y el estado del dialogo.
 *
 * En la interfaz se llama "Copia propia"; en el codigo, `vault`. No "archive":
 * en los mismos archivos ya existen `SessionSummary.archived`,
 * `archived-sessions.json` y "Archivar historial…", que esconden sesiones de la
 * barra. Una fila "solo en el archivo" al lado de "Ver 12 archivadas" diria dos
 * cosas opuestas con la misma palabra.
 *
 * La carpeta:
 *
 * ```
 * <copia>/
 *   vault.json                               {"format":1,"createdAt":<ms>}
 *   sessions/<agent>/<sessionId>.jsonl       una sesion
 *   sessions/<agent>/<sessionId>.assets/     <sha256 32 hex>.<ext> por imagen
 *   memory/<nombre de carpeta>-<hash8>/      *.md copiados + source.json
 *   export/<nombre de carpeta>-<hash8>/      Markdown por proyecto
 *   export/sesiones/<agent>-<sessionId>.md   Markdown de una fila "copia"
 * ```
 *
 * Cada `<sessionId>.jsonl`: una cabecera, los eventos en el orden del seguidor
 * y los documentos. Una linea por objeto, sin indentar, UTF-8 sin BOM.
 *
 * Las reglas de siempre para lo que se lee de disco: un formato que no se
 * conoce no se lista ni se pisa (la cabecera da null), y una linea de un tipo
 * desconocido se salta sin llevarse al archivo.
 */

import { SESSION_AGENT_IDS, type SessionAgentId } from './agents.js';
import {
  CONVERSATION_IMAGE_SOURCES,
  parseContextUsage,
  parseConversationEvent,
  type ContextUsage,
  type ConversationEvent,
  type ConversationImageSource,
} from './conversation.js';
import { SESSION_TITLE_SOURCES, type SessionTitleSource } from './models.js';
import {
  asArrayFiltered,
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
  asStringArray,
} from './validation.js';

export const VAULT_FORMAT = 1;

/**
 * La forma de un `sessionId` que se escribe o se lee de la copia: uuid de
 * Claude Code, Codex, Gemini CLI y Antigravity; `ses_…` de OpenCode.
 *
 * Es lo que hace que un id no pueda ser una ruta: sin separadores, sin `:`, y
 * sin empezar por punto. Cualquier otro valor no se escribe ni se lee.
 */
export const VAULT_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isVaultSessionId(value: string): boolean {
  return VAULT_SESSION_ID_PATTERN.test(value);
}

/**
 * El nombre de un asset dentro de `<sessionId>.assets/`: 32 hex del sha256 de
 * los bytes y la extension que diga la firma, o `bin`.
 *
 * Se valida al parsear porque el servidor lo junta con la carpeta de la sesion:
 * un `asset` que viniera como `../../x` desde un archivo editado a mano seria
 * una ruta.
 */
export const VAULT_ASSET_NAME_PATTERN = /^[0-9a-f]{32}\.(png|jpg|gif|webp|bin)$/;

export type VaultImporterId = 'gemini-cli-chats' | 'antigravity-ide-rescue';

export const VAULT_IMPORTER_IDS: readonly VaultImporterId[] = ['gemini-cli-chats', 'antigravity-ide-rescue'];

export type VaultSource =
  /** Copiada de un historial nativo. La huella decide si hay que volver a copiar. */
  | { kind: 'native'; mtimeMs: number; sizeBytes: number; writerRevision: number }
  /** Importada una vez por un script. No se vuelve a copiar sola. */
  | { kind: 'import'; importer: VaultImporterId; importedAt: number };

/** Primera linea de cada `<sessionId>.jsonl`. */
export interface VaultHeader {
  kind: 'header';
  format: typeof VAULT_FORMAT;
  agent: SessionAgentId;
  sessionId: string;
  /** `''` si no se sabe (Gemini CLI sin carpeta casada). */
  cwd: string;
  /** Agrupador para el indice cuando `cwd` es `''`; con `cwd`, `vault:<agent>:<sessionId>`. */
  group: string;
  title: string;
  titleSource: SessionTitleSource;
  createdAt: number | null;
  updatedAt: number;
  /** Version de la CLI instalada **al copiar** (no la que escribio la sesion). */
  cliVersionAtCopy: string | null;
  /** true si la copia no tiene la conversacion entera (rescate). */
  partial: boolean;
  /** Pasos de la conversacion original, cuando se conocen y no hay eventos. */
  stepCount: number | null;
  usage: ContextUsage | null;
  eventCount: number;
  documentCount: number;
  imageCount: number;
  source: VaultSource;
  writtenAt: number;
}

export interface VaultImageRef {
  index: number;
  source: ConversationImageSource;
  mediaType: string;
  /** Nombre dentro de `<sessionId>.assets/`, o null si no se pudo leer (tope, ausente). */
  asset: string | null;
  bytes: number;
}

/** Un evento del hilo, con los topes de la copia. */
export interface VaultEventLine {
  kind: 'event';
  event: ConversationEvent;
  /** Una por cada parte `image` del evento, en el mismo orden. */
  images: VaultImageRef[];
}

/**
 * Un documento que no es un mensaje: un documento del agente rescatado.
 *
 * Solo `agent-document`: los planes de Claude Code no entran en el hito 28.
 * CLAUDE.md 2.1 abre `plans/*.md` solo si la conversacion que se esta mirando
 * los nombro, y copiarlos en segundo plano cambiaria esa regla (C10).
 */
export interface VaultDocumentLine {
  kind: 'document';
  origin: 'agent-document';
  /** Nombre del archivo original, sin carpeta. */
  name: string;
  modifiedAt: number | null;
  text: string;
  truncated: boolean;
}

export type VaultBodyLine = VaultEventLine | VaultDocumentLine;

// ---------------------------------------------------------------------------
// Estado del dialogo
// ---------------------------------------------------------------------------

export type VaultState = 'off' | 'idle' | 'measuring' | 'writing' | 'moving';

export const VAULT_STATES: readonly VaultState[] = ['off', 'idle', 'measuring', 'writing', 'moving'];

export interface VaultAgentMeasure {
  agent: SessionAgentId;
  sessions: number;
  /** Bytes de los `.jsonl` que se escribirian. */
  eventBytes: number;
  images: number;
  imageBytes: number;
  /** Listadas y archivadas: no se copian. */
  skippedArchived: number;
  /** El seguidor llego a `live` sin nada que copiar (0 eventos y 0 documentos). */
  skippedEmpty: number;
  /**
   * La fuente no declara que su seguidor respeta los topes de la copia
   * (`HistorySource.wholeRead`): leerla recortaria en silencio (C7).
   */
  unsupported: number;
  /** Lectura que lanzo, o un origen que no se encontro (C6). */
  failed: number;
  /**
   * Los motivos distintos de `failed`, para que la medicion diga por que y no
   * solo cuantas. Pocos: es un texto para mostrar, no un registro.
   */
  failureReasons: string[];
}

export interface VaultMeasurement {
  measuredAt: number;
  durationMs: number;
  byAgent: VaultAgentMeasure[];
  memoryProjects: number;
  memoryBytes: number;
}

export interface VaultStatus {
  enabled: boolean;
  /** Para mostrar. El cliente nunca la devuelve (CLAUDE.md 2.4). */
  dir: string;
  isDefaultDir: boolean;
  state: VaultState;
  progress: { done: number; total: number } | null;
  /** Copias en disco, validas, de todas las fuentes. */
  sessions: number;
  /**
   * Las de `sessions` que escribio una pasada (fuente `native`). Una pasada
   * solo corre encendida: con alguna, la copia ya se encendio en esta carpeta y
   * "Activar" no pide medir (C18). Lo importado no cuenta: un importador escribe
   * sin encender nada.
   */
  passSessions: number;
  bytes: number;
  lastPassAt: number | null;
  /** Sesiones cambiadas que esperan su minuto de calma. */
  pending: number;
  measurement: VaultMeasurement | null;
  /** Carpeta anterior despues de mover, para decirle al usuario que quedo intacta. */
  previousDir: string | null;
  lastError: string | null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function asNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Un campo que admite null: ausente o null es null; presente e invalido, `undefined`. */
function nullable<T>(value: unknown, parse: (value: unknown) => T | null): T | null | undefined {
  if (value === null || value === undefined) return null;
  const parsed = parse(value);
  return parsed === null ? undefined : parsed;
}

export function parseVaultSource(value: unknown): VaultSource | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record['kind'] === 'native') {
    const mtimeMs = asFiniteNumber(record['mtimeMs']);
    const sizeBytes = asFiniteNumber(record['sizeBytes']);
    const writerRevision = asFiniteNumber(record['writerRevision']);
    if (mtimeMs === null || sizeBytes === null || writerRevision === null) return null;
    return { kind: 'native', mtimeMs, sizeBytes, writerRevision };
  }
  if (record['kind'] === 'import') {
    const importer = asLiteral(record['importer'], VAULT_IMPORTER_IDS);
    const importedAt = asFiniteNumber(record['importedAt']);
    if (importer === null || importedAt === null) return null;
    return { kind: 'import', importer, importedAt };
  }
  return null;
}

/**
 * La cabecera de una sesion de la copia, o null.
 *
 * null si no es una cabecera, si el formato no es el 1 —una app mas nueva
 * escribio sobre la misma carpeta: ni se lista ni se pisa—, si la fuente o el
 * id no se conocen, o si falta un campo obligatorio. Los campos que admiten
 * null son tolerantes con la ausencia; `usage` invalido tambien es null.
 */
export function parseVaultHeader(value: unknown): VaultHeader | null {
  const record = asRecord(value);
  if (record === null || record['kind'] !== 'header' || record['format'] !== VAULT_FORMAT) return null;

  const agent = asLiteral(record['agent'], SESSION_AGENT_IDS);
  const sessionId = asNonEmptyString(record['sessionId']);
  const cwd = asString(record['cwd']);
  const group = asString(record['group']);
  const title = asString(record['title']);
  const titleSource = asLiteral(record['titleSource'], SESSION_TITLE_SOURCES);
  const updatedAt = asFiniteNumber(record['updatedAt']);
  const partial = asBoolean(record['partial']);
  const eventCount = asNonNegativeInt(record['eventCount']);
  const documentCount = asNonNegativeInt(record['documentCount']);
  const imageCount = asNonNegativeInt(record['imageCount']);
  const source = parseVaultSource(record['source']);
  const writtenAt = asFiniteNumber(record['writtenAt']);
  const createdAt = nullable(record['createdAt'], asFiniteNumber);
  const cliVersionAtCopy = nullable(record['cliVersionAtCopy'], asString);
  const stepCount = nullable(record['stepCount'], asNonNegativeInt);

  if (
    agent === null ||
    sessionId === null ||
    !isVaultSessionId(sessionId) ||
    cwd === null ||
    group === null ||
    title === null ||
    titleSource === null ||
    updatedAt === null ||
    partial === null ||
    eventCount === null ||
    documentCount === null ||
    imageCount === null ||
    source === null ||
    writtenAt === null ||
    createdAt === undefined ||
    cliVersionAtCopy === undefined ||
    stepCount === undefined
  ) {
    return null;
  }

  return {
    kind: 'header',
    format: VAULT_FORMAT,
    agent,
    sessionId,
    cwd,
    group,
    title,
    titleSource,
    createdAt,
    updatedAt,
    cliVersionAtCopy,
    partial,
    stepCount,
    usage: parseContextUsage(record['usage']),
    eventCount,
    documentCount,
    imageCount,
    source,
    writtenAt,
  };
}

export function parseVaultImageRef(value: unknown): VaultImageRef | null {
  const record = asRecord(value);
  if (record === null) return null;
  const index = asNonNegativeInt(record['index']);
  const source = asLiteral(record['source'], CONVERSATION_IMAGE_SOURCES);
  const mediaType = asString(record['mediaType']);
  const bytes = asNonNegativeInt(record['bytes']);
  const asset = nullable(record['asset'], asString);
  if (
    index === null ||
    source === null ||
    mediaType === null ||
    bytes === null ||
    asset === undefined ||
    (asset !== null && !VAULT_ASSET_NAME_PATTERN.test(asset))
  ) {
    return null;
  }
  return { index, source, mediaType, asset, bytes };
}

/**
 * Una linea del cuerpo, o null para saltarla.
 *
 * Un evento que no parsea descarta **la linea**, no el archivo. Las imagenes
 * son una por cada parte `image` del evento y en su orden: una lista rota o de
 * otro largo tambien descarta la linea, porque emparejaria cada imagen con la
 * parte equivocada.
 */
export function parseVaultBodyLine(value: unknown): VaultBodyLine | null {
  const record = asRecord(value);
  if (record === null) return null;

  if (record['kind'] === 'event') {
    const event = parseConversationEvent(record['event']);
    const images = asArrayOf(record['images'], parseVaultImageRef);
    if (event === null || images === null) return null;
    const imageParts = event.parts.filter((part) => part.kind === 'image').length;
    if (images.length !== imageParts) return null;
    return { kind: 'event', event, images };
  }

  if (record['kind'] === 'document') {
    const name = asNonEmptyString(record['name']);
    const text = asString(record['text']);
    const truncated = asBoolean(record['truncated']);
    const modifiedAt = nullable(record['modifiedAt'], asFiniteNumber);
    if (
      record['origin'] !== 'agent-document' ||
      name === null ||
      /[\\/]/.test(name) ||
      text === null ||
      truncated === null ||
      modifiedAt === undefined
    ) {
      return null;
    }
    return { kind: 'document', origin: 'agent-document', name, modifiedAt, text, truncated };
  }

  return null;
}

function parseVaultAgentMeasure(value: unknown): VaultAgentMeasure | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], SESSION_AGENT_IDS);
  const sessions = asNonNegativeInt(record['sessions']);
  const eventBytes = asNonNegativeInt(record['eventBytes']);
  const images = asNonNegativeInt(record['images']);
  const imageBytes = asNonNegativeInt(record['imageBytes']);
  const skippedArchived = asNonNegativeInt(record['skippedArchived']);
  const skippedEmpty = asNonNegativeInt(record['skippedEmpty']);
  const unsupported = asNonNegativeInt(record['unsupported']);
  const failed = asNonNegativeInt(record['failed']);
  const failureReasons = asStringArray(record['failureReasons']);
  if (
    agent === null ||
    sessions === null ||
    eventBytes === null ||
    images === null ||
    imageBytes === null ||
    skippedArchived === null ||
    skippedEmpty === null ||
    unsupported === null ||
    failed === null ||
    failureReasons === null
  ) {
    return null;
  }
  return {
    agent,
    sessions,
    eventBytes,
    images,
    imageBytes,
    skippedArchived,
    skippedEmpty,
    unsupported,
    failed,
    failureReasons,
  };
}

export function parseVaultMeasurement(value: unknown): VaultMeasurement | null {
  const record = asRecord(value);
  if (record === null) return null;
  const measuredAt = asFiniteNumber(record['measuredAt']);
  const durationMs = asFiniteNumber(record['durationMs']);
  // Una fila de una fuente que este cliente no conoce no se lleva a las demas.
  const byAgent = asArrayFiltered(record['byAgent'], parseVaultAgentMeasure);
  const memoryProjects = asNonNegativeInt(record['memoryProjects']);
  const memoryBytes = asNonNegativeInt(record['memoryBytes']);
  if (
    measuredAt === null ||
    durationMs === null ||
    byAgent === null ||
    memoryProjects === null ||
    memoryBytes === null
  ) {
    return null;
  }
  return { measuredAt, durationMs, byAgent, memoryProjects, memoryBytes };
}

function parseProgress(value: unknown): { done: number; total: number } | null {
  const record = asRecord(value);
  if (record === null) return null;
  const done = asNonNegativeInt(record['done']);
  const total = asNonNegativeInt(record['total']);
  return done === null || total === null ? null : { done, total };
}

/**
 * El estado del dialogo, o null.
 *
 * Todo o nada, salvo las filas de la medicion: un estado a medias haria que el
 * dialogo ofreciera "Activar" o dijera una carpeta que no es.
 */
export function parseVaultStatus(value: unknown): VaultStatus | null {
  const record = asRecord(value);
  if (record === null) return null;

  const enabled = asBoolean(record['enabled']);
  const dir = asString(record['dir']);
  const isDefaultDir = asBoolean(record['isDefaultDir']);
  const state = asLiteral(record['state'], VAULT_STATES);
  const sessions = asNonNegativeInt(record['sessions']);
  const passSessions = asNonNegativeInt(record['passSessions']);
  const bytes = asNonNegativeInt(record['bytes']);
  const pending = asNonNegativeInt(record['pending']);
  const progress = nullable(record['progress'], parseProgress);
  const lastPassAt = nullable(record['lastPassAt'], asFiniteNumber);
  const measurement = nullable(record['measurement'], parseVaultMeasurement);
  const previousDir = nullable(record['previousDir'], asString);
  const lastError = nullable(record['lastError'], asString);

  if (
    enabled === null ||
    dir === null ||
    isDefaultDir === null ||
    state === null ||
    sessions === null ||
    passSessions === null ||
    bytes === null ||
    pending === null ||
    progress === undefined ||
    lastPassAt === undefined ||
    measurement === undefined ||
    previousDir === undefined ||
    lastError === undefined
  ) {
    return null;
  }

  return {
    enabled,
    dir,
    isDefaultDir,
    state,
    progress,
    sessions,
    passSessions,
    bytes,
    lastPassAt,
    pending,
    measurement,
    previousDir,
    lastError,
  };
}
