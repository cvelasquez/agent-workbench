/**
 * Importador de un solo uso: el rescate de lo legible de Antigravity IDE (hito
 * 28, §9.2 y decision 2 del usuario).
 *
 * Las conversaciones del IDE estan en `~/.gemini/antigravity/conversations/`
 * en un formato cifrado: su contenido no se puede leer, y no se intenta. Lo que
 * si se lee, y lo que este modulo guarda **una vez** en la copia propia como
 * "historial parcial", es:
 *
 *  - de `~/.gemini/antigravity-cli/conversation_summaries.db` —el indice que el
 *    IDE comparte con la CLI—, las filas del IDE (`app_data_dir =
 *    'antigravity'`) cuya carpeta es exactamente la que nombra `--workspace`:
 *    id, `preview`, pasos y fecha;
 *  - de `~/.gemini/antigravity/brain/<id>/`, **solo para esos ids**, los `*.md`
 *    del primer nivel (planes, diagnosticos, guias).
 *
 * **Es la excepcion explicita del usuario** a "nunca `~/.gemini/antigravity/`",
 * y vive solo en este archivo: ningun otro modulo de la app nombra esa carpeta
 * (lo comprueba el chequeo de la copia, caso 15). No se abre nada mas: ni las
 * imagenes ni los `.resolved` ni los `.metadata.json` de `brain/<id>/`, ni sus
 * subcarpetas, ni `conversations/` (ni un `stat`), ni otros proyectos.
 *
 * Tres reglas que no son evidentes:
 *
 *  - **La base se lee por copia**, igual que en el hito 27: abrirla en su sitio,
 *    aun en solo lectura, deja `-wal` y `-shm` al lado, y eso es escribir en la
 *    carpeta de la CLI. Se copian `.db` y `-wal` a
 *    `<temporal>/agent-workbench/rescue-<uuid>/`, se consulta la copia con dos
 *    sentencias de columnas nombradas y la carpeta se borra al terminar, falle
 *    o no.
 *  - **La carpeta se compara, no se busca por nombre.** Cada URI de
 *    `workspace_uris` se convierte a ruta y se compara con `normalizeCwdKey`,
 *    por igualdad: ni un `LIKE` que casaria subcarpetas y nombres parecidos, ni
 *    un nombre de proyecto escrito en el codigo (el repositorio es publico).
 *  - **El `raw_summary` no se lee.** Es un blob, y ninguna sentencia de aca
 *    pide todas las columnas.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { normalizeCwdKey, type SessionTitleSource } from '@agent-workbench/shared';
import { parseSummaryTime, parseWorkspaceUris } from '../../agents/antigravity/catalog.js';
import { CONVERSATION_ID_PATTERN } from '../../agents/antigravity/constants.js';
import { fileUriToPath } from '../../agents/antigravity/file-uri.js';
import { toTitle, UNTITLED_SESSION_TITLE } from '../../agents/session-title.js';
import { loadSqlite, sqliteUnavailableText, type SqliteLoad, type SqliteModule } from '../../agents/sqlite.js';
import { InvalidPathError, resolveInside } from '../../path-guard.js';
import { serializeSession, type SerializedSession } from '../serialize.js';

/** Tope de un documento. Uno mas grande entra con su primer MB y `truncated`. */
export const RESCUE_DOCUMENT_MAX_BYTES = 1024 * 1024;
/** Tope de `.db` + `-wal` para copiarlos. La copia va a la carpeta temporal, que suele estar en el disco del sistema. */
export const RESCUE_DB_MAX_BYTES = 256 * 1024 * 1024;

/** Las filas del IDE y cuales casan con la carpeta. Nunca todas las columnas. */
export const RESCUE_ROWS_SQL =
  "SELECT conversation_id, workspace_uris FROM conversation_summaries WHERE app_data_dir = 'antigravity'";
/** Lo que se guarda de las filas que casaron. */
export const RESCUE_DETAILS_SQL =
  'SELECT conversation_id, preview, step_count, last_modified_time FROM conversation_summaries WHERE conversation_id IN (SELECT value FROM json_each(?))';

/** Las columnas que leen las dos sentencias. Si falta una, el rescate no corre. */
const REQUIRED_COLUMNS = ['conversation_id', 'workspace_uris', 'app_data_dir', 'preview', 'step_count', 'last_modified_time'];
const COLUMNS_SQL = "SELECT name FROM pragma_table_info('conversation_summaries')";
const COPY_ATTEMPTS = 3;
const DOCUMENT_PATTERN = /\.md$/i;

/** Un fallo que se le explica al usuario tal cual. */
export class RescueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RescueError';
  }
}

export interface RescueOptions {
  /** La carpeta del proyecto, absoluta, tal como la dio el usuario. */
  workspace: string;
  /** `~/.gemini`. El chequeo pasa otra. */
  geminiHome: string;
  platform: string;
  now: () => number;
  /** Donde se crea `rescue-<uuid>/`. Ausente: `<temporal>/agent-workbench`. */
  tempRoot?: string;
  /** De donde sale `node:sqlite`. */
  sqlite?: () => SqliteLoad;
  /** Tope de un documento. Ausente: `RESCUE_DOCUMENT_MAX_BYTES`. */
  maxDocumentBytes?: number;
}

export interface RescuedDocument {
  name: string;
  modifiedAt: number | null;
  text: string;
  truncated: boolean;
  /** Tamano del archivo original. */
  bytes: number;
}

export interface RescuedConversation {
  conversationId: string;
  title: string;
  titleSource: SessionTitleSource;
  stepCount: number | null;
  /** Epoch ms de `last_modified_time`, o 0 si la base no trae una fecha que sirva. */
  lastModifiedAt: number;
  updatedAt: number;
  createdAt: number | null;
  documents: RescuedDocument[];
}

export interface RescuePlan {
  workspace: string;
  conversations: RescuedConversation[];
  steps: number;
  documents: number;
  documentBytes: number;
  /** Conversaciones con al menos un documento. */
  conversationsWithDocuments: number;
  /** De la fecha de la base de la mas vieja a la de la mas nueva. */
  range: { from: number; to: number } | null;
  /** Filas del IDE de otras carpetas: no se tocan. */
  otherRows: number;
  /** Filas que casaron pero cuyo id no tiene forma de uuid: no se pueden guardar. */
  invalidIds: number;
}

interface FileStamp {
  size: number;
  mtimeMs: number;
}

async function stampOf(file: string): Promise<FileStamp | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

const sameStamp = (a: FileStamp | null, b: FileStamp | null): boolean =>
  (a === null && b === null) || (a !== null && b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs);

/**
 * Copia `.db` y `-wal` (si esta) a `copyDir`. Si la base cambia mientras se
 * copia —la CLI escribiendo— se intenta otra vez; a la tercera se usa lo que
 * haya, y la consulta dira si no sirve.
 */
async function copyDatabase(source: string, copyDir: string): Promise<string> {
  const copy = path.join(copyDir, path.basename(source));
  for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
    const db = await stampOf(source);
    const wal = await stampOf(`${source}-wal`);
    if (db === null) throw new RescueError(`${source} doesn't exist.`);
    if (db.size + (wal?.size ?? 0) > RESCUE_DB_MAX_BYTES) {
      throw new RescueError(`${source} is over ${RESCUE_DB_MAX_BYTES / 1024 / 1024} MB: it isn't copied.`);
    }
    try {
      await rm(`${copy}-wal`, { force: true });
      await copyFile(source, copy);
      if (wal !== null) await copyFile(`${source}-wal`, `${copy}-wal`);
    } catch (error) {
      // El `-wal` desaparecio entre el `stat` y la copia (un checkpoint): otra vuelta.
      if (attempt === COPY_ATTEMPTS) throw error;
      continue;
    }
    if (sameStamp(db, await stampOf(source)) && sameStamp(wal, await stampOf(`${source}-wal`))) break;
  }
  return copy;
}

interface DetailRow {
  conversationId: string;
  preview: string;
  stepCount: number | null;
  lastModifiedAt: number;
}

/** Lo que se lee de la base, ya en la copia. Cierra la conexion antes de devolver. */
function queryRescue(
  sqlite: SqliteModule,
  copy: string,
  workspace: string,
  platform: string,
): { details: DetailRow[]; otherRows: number } {
  const db = new sqlite.DatabaseSync(copy, { readOnly: true });
  try {
    const columns = new Set(db.prepare(COLUMNS_SQL).all().map((row) => String(row['name'])));
    if (columns.size === 0) throw new RescueError("The database doesn't have the conversation_summaries table.");
    const missing = REQUIRED_COLUMNS.find((column) => !columns.has(column));
    if (missing !== undefined) {
      throw new RescueError(`conversation_summaries is missing the column ${missing}: the format changed and the rescue doesn't run.`);
    }

    const wanted = normalizeCwdKey(workspace, platform);
    const matched: string[] = [];
    let otherRows = 0;
    for (const row of db.prepare(RESCUE_ROWS_SQL).all()) {
      const id = row['conversation_id'];
      const sameFolder = parseWorkspaceUris(row['workspace_uris']).some((uri) => {
        const folder = fileUriToPath(uri, platform);
        return folder !== null && normalizeCwdKey(folder, platform) === wanted;
      });
      if (sameFolder && typeof id === 'string' && id.length > 0) matched.push(id);
      else otherRows += 1;
    }
    if (matched.length === 0) return { details: [], otherRows };

    const details = db.prepare(RESCUE_DETAILS_SQL).all(JSON.stringify(matched)).map((row): DetailRow => {
      const steps = row['step_count'];
      const stepCount = typeof steps === 'number' && Number.isInteger(steps) && steps >= 0
        ? steps
        : typeof steps === 'bigint' && steps >= 0n ? Number(steps) : null;
      return {
        conversationId: String(row['conversation_id']),
        preview: typeof row['preview'] === 'string' ? row['preview'] : '',
        stepCount,
        lastModifiedAt: parseSummaryTime(row['last_modified_time']),
      };
    });
    return { details, otherRows };
  } finally {
    db.close();
  }
}

/** Los primeros `maxBytes` de un archivo como texto, sin cortar un caracter a la mitad. */
async function readTextHead(file: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    // `write` sin `end`: lo que quedo a medias al final no se decodifica.
    const text = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
    return { text, truncated: size > maxBytes };
  } finally {
    await handle.close();
  }
}

/** `root/relative` si existe y no se sale de `root`, o null. */
async function inside(root: string, relative: string): Promise<string | null> {
  try {
    return await resolveInside(root, relative, { mustExist: true });
  } catch (error) {
    if (error instanceof InvalidPathError) return null;
    throw error;
  }
}

/**
 * Los `*.md` regulares del primer nivel de `brain/<id>/`, por fecha. Ni
 * subcarpetas, ni enlaces, ni ningun otro archivo: ni siquiera se abren.
 */
async function readDocuments(brain: string, conversationId: string, maxBytes: number): Promise<RescuedDocument[]> {
  const folder = await inside(brain, conversationId);
  if (folder === null) return [];
  let names: string[];
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && DOCUMENT_PATTERN.test(entry.name)).map((entry) => entry.name);
  } catch {
    return [];
  }

  const documents: RescuedDocument[] = [];
  for (const name of names.sort()) {
    const file = await inside(folder, name);
    if (file === null) continue;
    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile()) continue;
    const { text, truncated } = await readTextHead(file, maxBytes);
    documents.push({ name, modifiedAt: info.mtimeMs > 0 ? Math.floor(info.mtimeMs) : null, text, truncated, bytes: info.size });
  }
  return documents.sort((a, b) => (a.modifiedAt ?? 0) - (b.modifiedAt ?? 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Lee la base (por copia) y los documentos de las conversaciones del IDE de
 * `workspace`. No escribe nada fuera de su carpeta temporal, que borra.
 */
export async function planAntigravityRescue(options: RescueOptions): Promise<RescuePlan> {
  const sqlite = (options.sqlite ?? loadSqlite)();
  if ('unavailable' in sqlite) throw new RescueError(sqliteUnavailableText('Antigravity IDE'));

  const source = path.join(options.geminiHome, 'antigravity-cli', 'conversation_summaries.db');
  if ((await stampOf(source)) === null) throw new RescueError(`${source} doesn't exist.`);

  const tempRoot = options.tempRoot ?? path.join(tmpdir(), 'agent-workbench');
  const copyDir = path.join(tempRoot, `rescue-${randomUUID()}`);
  let details: DetailRow[];
  let otherRows: number;
  try {
    // 0o700: la copia trae los titulos de todas las conversaciones, y en POSIX la temporal es compartida.
    await mkdir(copyDir, { recursive: true, mode: 0o700 });
    const copy = await copyDatabase(source, copyDir);
    ({ details, otherRows } = queryRescue(sqlite, copy, options.workspace, options.platform));
  } finally {
    await rm(copyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }

  const now = options.now();
  const maxBytes = options.maxDocumentBytes ?? RESCUE_DOCUMENT_MAX_BYTES;
  const brain = path.join(options.geminiHome, 'antigravity', 'brain');
  const conversations: RescuedConversation[] = [];
  let invalidIds = 0;
  for (const row of details) {
    if (!CONVERSATION_ID_PATTERN.test(row.conversationId)) {
      invalidIds += 1;
      continue;
    }
    const documents = await readDocuments(brain, row.conversationId, maxBytes);
    const dates = documents.map((document) => document.modifiedAt).filter((value): value is number => value !== null);
    const title = toTitle(row.preview);
    conversations.push({
      conversationId: row.conversationId,
      title: title.length > 0 ? title : UNTITLED_SESSION_TITLE,
      titleSource: title.length > 0 ? 'ai' : 'none',
      stepCount: row.stepCount,
      lastModifiedAt: row.lastModifiedAt,
      updatedAt: row.lastModifiedAt > 0 ? row.lastModifiedAt : dates.length > 0 ? Math.max(...dates) : now,
      createdAt: dates.length > 0 ? Math.min(...dates) : null,
      documents,
    });
  }
  conversations.sort((a, b) => a.updatedAt - b.updatedAt || (a.conversationId < b.conversationId ? -1 : 1));

  const dated = conversations.map((conversation) => conversation.lastModifiedAt).filter((value) => value > 0);
  return {
    workspace: options.workspace,
    conversations,
    steps: conversations.reduce((sum, conversation) => sum + (conversation.stepCount ?? 0), 0),
    documents: conversations.reduce((sum, conversation) => sum + conversation.documents.length, 0),
    documentBytes: conversations.reduce(
      (sum, conversation) => sum + conversation.documents.reduce((bytes, document) => bytes + document.bytes, 0),
      0,
    ),
    conversationsWithDocuments: conversations.filter((conversation) => conversation.documents.length > 0).length,
    range: dated.length > 0 ? { from: Math.min(...dated), to: Math.max(...dated) } : null,
    otherRows,
    invalidIds,
  };
}

/** Las sesiones parciales que escribiria el rescate. Puro. */
export function rescuedSessionFiles(plan: RescuePlan, now: number): SerializedSession[] {
  return plan.conversations.map((conversation) =>
    serializeSession({
      header: {
        agent: 'antigravity-ide',
        sessionId: conversation.conversationId,
        cwd: plan.workspace,
        title: conversation.title,
        titleSource: conversation.titleSource,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        cliVersionAtCopy: null,
        partial: true,
        stepCount: conversation.stepCount,
        usage: null,
        source: { kind: 'import', importer: 'antigravity-ide-rescue', importedAt: now },
        writtenAt: now,
      },
      events: [],
      documents: conversation.documents.map((document) => ({
        kind: 'document',
        origin: 'agent-document',
        name: document.name,
        modifiedAt: document.modifiedAt,
        text: document.text,
        truncated: document.truncated,
      })),
    }),
  );
}
