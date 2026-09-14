/**
 * Lo que Antigravity CLI sabe de cada conversacion fuera de su transcript:
 * titulo, carpeta, proyecto y si es un sub-agente.
 *
 * Tres fuentes de la carpeta de la CLI, mas los proyectos que comparte con el
 * IDE. De cada una se toma una lista blanca y **no se escribe nada**:
 *
 *  - `history.jsonl`: una linea por mensaje tecleado, con la carpeta. Medido en
 *    la 1.2.2: el **primer** mensaje de una conversacion no lleva
 *    `conversationId` (se escribe antes de crearla), y los comandos de barra
 *    llevan `type: "slash_command"` —`/clear` con el id de la conversacion
 *    **vieja**—. Las dos clases de linea se ignoran. Sirve para la carpeta,
 *    casi nunca para el titulo.
 *  - `cache/last_conversations.json`: la **ultima** conversacion de cada
 *    carpeta. Respaldo de la carpeta.
 *  - `conversation_summaries.db`: SQLite en modo WAL con el titulo generado,
 *    las carpetas y el proyecto. **Se lee siempre por copia**: abrir la base en
 *    su lugar, aun en solo lectura, crea `-wal` y `-shm` al lado (medido), y eso
 *    es escribir en la carpeta de la CLI. Se copian `.db` y `-wal` a una
 *    subcarpeta propia de la temporal, se consulta la copia con columnas
 *    nombradas y se borra. Solo filas `app_data_dir = 'antigravity-cli'`: la
 *    misma base guarda las del IDE.
 *  - `~/.gemini/config/projects/<id>.json`: solo el del proyecto pedido, y solo
 *    la carpeta de su primer recurso.
 *
 * Una fuente que no se puede leer un instante (la base copiada a mitad de un
 * checkpoint, un archivo tomado) **no borra lo que ya se sabia**: se conserva y
 * se reintenta en la proxima lectura.
 */

import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { asRecord } from '@agent-workbench/shared';
import { parseJsonlLine } from '../../jsonl-reader.js';
import { catalogTempDir } from '../../paths.js';
import { loadSqlite, type SqliteLoad } from '../sqlite.js';
import { fileStamp, stampKey, type FileStamp } from './catalog-signal.js';
import { CONVERSATION_ID_PATTERN } from './constants.js';
import { fileUriToPath } from './file-uri.js';
import {
  historyPath,
  lastConversationsPath,
  projectFilePath,
  summariesDbPath,
} from './paths.js';

/** Topes de lectura de cada fuente. Pasado el tope, la fuente no aporta nada. */
export const CATALOG_LIMITS = {
  /** Si pesa mas, se leen los ultimos 5 MB descartando la primera linea cortada. */
  historyBytes: 5 * 1024 * 1024,
  lastConversationsBytes: 1024 * 1024,
  summariesBytes: 50 * 1024 * 1024,
  projectBytes: 64 * 1024,
} as const;

/**
 * Los proyectos que no son un proyecto: la CLI los usa para toda conversacion
 * lanzada fuera de uno. Agrupar por ellos juntaria conversaciones sin relacion
 * (A2 de la especificacion del hito 27).
 */
export const GENERIC_PROJECT_IDS: ReadonlySet<string> = new Set(['', 'default-cli-project', 'outside-of-project']);

/** La consulta exacta. Nunca `SELECT *`: `raw_summary` es un blob. */
export const SUMMARIES_SQL = `SELECT conversation_id, title, preview, step_count, last_modified_time,
       workspace_uris, project_id, parent_conversation_id, nesting_depth
  FROM conversation_summaries
 WHERE app_data_dir = 'antigravity-cli'`;

export interface CatalogHistory {
  /** El `display` de la linea mas vieja con este id. */
  firstDisplay: string;
  firstTimestamp: number;
  lastTimestamp: number;
  /** La primera carpeta no vacia que nombra. */
  workspace: string | null;
}

export interface CatalogSummary {
  title: string;
  preview: string;
  stepCount: number;
  /** 0 si la fecha no sirve (la CLI escribe `0001-01-01` en una conversacion vacia). */
  lastModifiedMs: number;
  workspaceUris: string[];
  projectId: string;
  parentConversationId: string;
  nestingDepth: number;
}

export interface CatalogEntry {
  history: CatalogHistory | null;
  /** De `last_conversations.json`. */
  lastWorkspace: string | null;
  summary: CatalogSummary | null;
}

const EMPTY_ENTRY: CatalogEntry = { history: null, lastWorkspace: null, summary: null };

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');
const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  return 0;
};

/** El id en minusculas, o null si no es un uuid. */
function conversationKey(value: unknown): string | null {
  return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value) ? value.toLowerCase() : null;
}

/**
 * Epoch ms de un `datetime` de la base, o 0.
 *
 * Dos trampas medidas: `Date.parse('0001-01-01 00:00:00+00:00')` con espacio da
 * el ano **2001** (978307200000), y con `T` un numero negativo. Se cambia el
 * primer espacio por `T` y todo lo que no es positivo es "sin fecha". La
 * fraccion de siete digitos la acepta tal cual.
 */
export function parseSummaryTime(value: unknown): number {
  if (typeof value !== 'string' || value.length === 0) return 0;
  const parsed = Date.parse(value.replace(' ', 'T'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** `workspace_uris`: un array JSON de strings, o `""` cuando no hay ninguna. */
export function parseWorkspaceUris(value: unknown): string[] {
  if (typeof value !== 'string' || !value.trimStart().startsWith('[')) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  } catch {
    return [];
  }
}

/** Las lineas de `history.jsonl` que nombran una conversacion, agrupadas por id. */
export function parseHistoryText(text: string): Map<string, CatalogHistory> {
  const byId = new Map<string, CatalogHistory>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const record = parseJsonlLine(line);
    // Un comando de barra no es un mensaje, y `/clear` lleva el id de la conversacion vieja.
    if (record === null || record['type'] !== undefined) continue;
    const id = conversationKey(record['conversationId']);
    const timestamp = record['timestamp'];
    if (id === null || typeof timestamp !== 'number' || !Number.isFinite(timestamp)) continue;
    const display = asString(record['display']);
    const workspace = typeof record['workspace'] === 'string' && record['workspace'].length > 0 ? record['workspace'] : null;

    const known = byId.get(id);
    if (known === undefined) {
      byId.set(id, { firstDisplay: display, firstTimestamp: timestamp, lastTimestamp: timestamp, workspace });
      continue;
    }
    if (timestamp < known.firstTimestamp) {
      known.firstDisplay = display;
      known.firstTimestamp = timestamp;
    }
    known.lastTimestamp = Math.max(known.lastTimestamp, timestamp);
    known.workspace ??= workspace;
  }
  return byId;
}

/** `last_conversations.json`: `carpeta -> id`, dado vuelta. */
export function parseLastConversationsText(text: string): Map<string, string> {
  const byId = new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return byId;
  }
  const record = asRecord(parsed);
  if (record === null) return byId;
  for (const [workspace, value] of Object.entries(record)) {
    const id = conversationKey(value);
    if (id !== null && workspace.length > 0 && !byId.has(id)) byId.set(id, workspace);
  }
  return byId;
}

/** Una fila de `SUMMARIES_SQL`, validada. null si el id no sirve. */
export function parseSummaryRow(row: Record<string, unknown>): [string, CatalogSummary] | null {
  const id = conversationKey(row['conversation_id']);
  if (id === null) return null;
  return [
    id,
    {
      title: asString(row['title']),
      preview: asString(row['preview']),
      stepCount: asNumber(row['step_count']),
      lastModifiedMs: parseSummaryTime(row['last_modified_time']),
      workspaceUris: parseWorkspaceUris(row['workspace_uris']),
      projectId: asString(row['project_id']),
      parentConversationId: asString(row['parent_conversation_id']),
      nestingDepth: asNumber(row['nesting_depth']),
    },
  ];
}

/**
 * La carpeta de un `config/projects/<id>.json` ya parseado: la del primer
 * recurso que de una ruta, sea `gitFolder.folderUri` o `folderUri` suelto.
 * Lo demas del archivo (permisos, politicas) no se mira.
 */
export function projectFolderOf(parsed: unknown, platform: string): string | null {
  const resources = asRecord(asRecord(parsed)?.['projectResources'])?.['resources'];
  if (!Array.isArray(resources)) return null;
  for (const item of resources) {
    const resource = asRecord(item);
    const uri = asRecord(resource?.['gitFolder'])?.['folderUri'] ?? resource?.['folderUri'];
    if (typeof uri !== 'string') continue;
    const folder = fileUriToPath(uri, platform);
    if (folder !== null) return folder;
  }
  return null;
}

/**
 * Borra las copias de la base que quedaron de un cierre abrupto (M8). Solo las
 * subcarpetas con nombre de uuid, que son las que crea el catalogo. Nunca lanza.
 * Para el arranque, antes de que nadie lea.
 */
export async function removeStaleCatalogCopies(dir: string = catalogTempDir()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!CONVERSATION_ID_PATTERN.test(name)) continue;
    await rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
  }
}

/** El texto de un archivo, o de sus ultimos `maxBytes` sin la primera linea cortada. */
async function readTextTail(file: string, maxBytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const start = size - length;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    let chunk = buffer.subarray(0, bytesRead);
    if (start > 0) {
      const newline = chunk.indexOf(0x0a);
      chunk = newline === -1 ? Buffer.alloc(0) : chunk.subarray(newline + 1);
    }
    return chunk.toString('utf8');
  } finally {
    await handle.close();
  }
}

export interface AntigravityCatalogOptions {
  /** Donde van las copias de la base. */
  tempDir?: () => string;
  /** De donde sale `node:sqlite`. */
  sqlite?: () => SqliteLoad;
  platform?: string;
  warn?: (message: string) => void;
}

/** Cuantas veces se intenta una copia coherente de la base antes de leer la ultima igual. */
const COPY_ATTEMPTS = 3;

interface DbSignature {
  db: FileStamp | null;
  wal: FileStamp | null;
  key: string;
}

export class AntigravityCatalog {
  private readonly tempDir: () => string;
  private readonly sqlite: () => SqliteLoad;
  private readonly platform: string;
  private readonly warn: (message: string) => void;

  private history = new Map<string, CatalogHistory>();
  private lastWorkspaces = new Map<string, string>();
  private summaries = new Map<string, CatalogSummary>();
  /** Firma de cada fuente ya leida. Una fuente que fallo conserva la anterior y se reintenta. */
  private historyStamp: string | null = null;
  private lastStamp: string | null = null;
  private summariesStamp: string | null = null;
  /** La firma de la base con la que ya se aviso un error, para no repetirlo en cada lectura. */
  private warnedSummaries: string | null = null;

  /** La entrada de cada id tal como estaba en la lectura anterior, para saber cual cambio. */
  private previous = new Map<string, string>();
  private primed = false;
  /** Ids que cambiaron y todavia nadie pidio (`takeChanged`). */
  private readonly unreported = new Set<string>();
  private chain: Promise<unknown> = Promise.resolve();

  private readonly projects = new Map<string, { stamp: string; folder: string | null }>();

  constructor(options: AntigravityCatalogOptions = {}) {
    this.tempDir = options.tempDir ?? catalogTempDir;
    this.sqlite = options.sqlite ?? loadSqlite;
    this.platform = options.platform ?? process.platform;
    this.warn = options.warn ?? ((message) => console.warn(message));
  }

  /**
   * Relee las fuentes que cambiaron de fecha o tamano. Nunca lanza. Las lecturas
   * van en fila: dos a la vez copiarian la base dos veces.
   *
   * La primera no anota cambios: todo es nuevo, y quien la pide (el escaneo del
   * indice) va a leer todas las conversaciones de todos modos.
   */
  refresh(): Promise<void> {
    const run = this.chain.then(() => this.load());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Los ids cuya entrada cambio desde la ultima vez que alguien pregunto. Vacia la lista. */
  takeChanged(): string[] {
    const ids = [...this.unreported];
    this.unreported.clear();
    return ids;
  }

  /** Nunca null: sin datos, una entrada con todo en null. */
  get(id: string): CatalogEntry {
    const key = id.toLowerCase();
    const history = this.history.get(key) ?? null;
    const lastWorkspace = this.lastWorkspaces.get(key) ?? null;
    const summary = this.summaries.get(key) ?? null;
    if (history === null && lastWorkspace === null && summary === null) return EMPTY_ENTRY;
    return { history, lastWorkspace, summary };
  }

  /** Los ids de las conversaciones de un proyecto (B4): las que pueden sacar su carpeta de el. */
  idsWithProject(projectId: string): string[] {
    return [...this.summaries].filter(([, summary]) => summary.projectId === projectId).map(([id]) => id);
  }

  /**
   * La carpeta de un proyecto, o null. Solo lee el archivo de ese id, con cache
   * por fecha y tamano. Los proyectos genericos no tienen carpeta.
   */
  async projectPath(projectId: string): Promise<string | null> {
    if (GENERIC_PROJECT_IDS.has(projectId)) return null;
    const file = projectFilePath(projectId);
    if (file === null) return null;

    let stamp: FileStamp | null;
    try {
      stamp = await fileStamp(file);
    } catch {
      return this.projects.get(projectId)?.folder ?? null;
    }
    if (stamp === null || stamp.size > CATALOG_LIMITS.projectBytes) {
      this.projects.delete(projectId);
      return null;
    }
    const key = stampKey(stamp);
    const cached = this.projects.get(projectId);
    if (cached !== undefined && cached.stamp === key) return cached.folder;

    try {
      const folder = projectFolderOf(JSON.parse(await readFile(file, 'utf8')), this.platform);
      this.projects.set(projectId, { stamp: key, folder });
      return folder;
    } catch {
      // A medio escribir: lo que se sabia, sin cachear el fallo.
      return cached?.folder ?? null;
    }
  }

  private async load(): Promise<void> {
    await this.loadHistory();
    await this.loadLastConversations();
    await this.loadSummaries();
    this.collectChanges();
  }

  private async loadHistory(): Promise<void> {
    const file = historyPath();
    try {
      const stamp = await fileStamp(file);
      const key = stampKey(stamp);
      if (key === this.historyStamp) return;
      this.history = stamp === null ? new Map() : parseHistoryText(await readTextTail(file, CATALOG_LIMITS.historyBytes));
      this.historyStamp = key;
    } catch {
      // Tomado o a medio reemplazar: queda lo anterior y se reintenta.
    }
  }

  private async loadLastConversations(): Promise<void> {
    const file = lastConversationsPath();
    try {
      const stamp = await fileStamp(file);
      const key = stampKey(stamp);
      if (key === this.lastStamp) return;
      if (stamp === null || stamp.size > CATALOG_LIMITS.lastConversationsBytes) {
        this.lastWorkspaces = new Map();
      } else {
        this.lastWorkspaces = parseLastConversationsText(await readFile(file, 'utf8'));
      }
      this.lastStamp = key;
    } catch {
      // Igual que arriba.
    }
  }

  private async summariesSignature(file: string): Promise<DbSignature> {
    const db = await fileStamp(file);
    const wal = await fileStamp(`${file}-wal`);
    return { db, wal, key: `${stampKey(db)}|${stampKey(wal)}` };
  }

  /**
   * Copia `.db` y `-wal` a `copy` y devuelve la firma que tenia la base al
   * empezar esa copia, o null si no se pudo copiar. Si la CLI escribe justo en
   * ese momento se reintenta; si nunca se queda quieta, se usa la ultima copia
   * igual —la consulta dira si esta rota— y la firma de antes hace que la
   * proxima lectura copie otra vez.
   */
  private async copySummaries(file: string, copy: string, first: DbSignature): Promise<DbSignature | null> {
    let copied: DbSignature | null = null;
    for (let attempt = 1; attempt <= COPY_ATTEMPTS; attempt += 1) {
      const before = attempt === 1 ? first : await this.summariesSignature(file);
      if (before.db === null) return null;
      try {
        await rm(`${copy}-wal`, { force: true });
        await copyFile(file, copy);
        if (before.wal !== null) await copyFile(`${file}-wal`, `${copy}-wal`);
      } catch {
        // El `-wal` desaparecio entre el `stat` y la copia (un checkpoint): otra vuelta.
        continue;
      }
      copied = before;
      const after = await this.summariesSignature(file);
      if (after.key === before.key) break;
    }
    return copied;
  }

  private async loadSummaries(): Promise<void> {
    const file = summariesDbPath();
    let signature: DbSignature;
    try {
      signature = await this.summariesSignature(file);
    } catch {
      return;
    }
    if (signature.key === this.summariesStamp) return;

    if (signature.db === null) {
      this.summaries = new Map();
      this.summariesStamp = signature.key;
      return;
    }
    if (signature.db.size > CATALOG_LIMITS.summariesBytes) {
      this.summaries = new Map();
      this.summariesStamp = signature.key;
      this.warnOnce(signature.key, `el indice de conversaciones pesa mas de ${CATALOG_LIMITS.summariesBytes / 1024 / 1024} MB; no se lee.`);
      return;
    }
    const sqlite = this.sqlite();
    if ('unavailable' in sqlite) {
      // Sin `node:sqlite` los titulos y carpetas salen de las otras fuentes.
      this.summaries = new Map();
      this.summariesStamp = signature.key;
      return;
    }

    const dir = path.join(this.tempDir(), randomUUID());
    try {
      // 0o700: la copia trae los titulos de todas las conversaciones, y en POSIX la temporal es compartida.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const copy = path.join(dir, path.basename(file));
      const copied = await this.copySummaries(file, copy, signature);
      // Se fue mientras se copiaba, o no se dejo copiar: lo anterior, y otra vez en la proxima.
      if (copied === null) return;

      const db = new sqlite.DatabaseSync(copy, { readOnly: true });
      let rows: Record<string, unknown>[];
      try {
        rows = db.prepare(SUMMARIES_SQL).all();
      } finally {
        db.close();
      }
      const next = new Map<string, CatalogSummary>();
      for (const row of rows) {
        const parsed = parseSummaryRow(row);
        if (parsed !== null) next.set(parsed[0], parsed[1]);
      }
      this.summaries = next;
      /*
        La firma de ANTES de copiar: si la CLI escribio durante la copia, la
        proxima lectura ve otra firma y vuelve a copiar.
      */
      this.summariesStamp = copied.key;
    } catch (error) {
      // Base a mitad de escritura, esquema que cambio: se conserva lo anterior.
      this.warnOnce(signature.key, `no pude leer el indice de conversaciones: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => undefined);
    }
  }

  private warnOnce(signature: string, message: string): void {
    if (this.warnedSummaries === signature) return;
    this.warnedSummaries = signature;
    this.warn(`[antigravity] ${message}`);
  }

  /** Compara cada entrada con la de la lectura anterior y anota los ids que cambiaron. */
  private collectChanges(): void {
    const ids = new Set<string>([...this.previous.keys(), ...this.history.keys(), ...this.lastWorkspaces.keys(), ...this.summaries.keys()]);
    const next = new Map<string, string>();
    for (const id of ids) {
      const entry = this.get(id);
      const serialized = entry === EMPTY_ENTRY ? null : JSON.stringify(entry);
      if (serialized !== null) next.set(id, serialized);
      if (this.primed && (this.previous.get(id) ?? null) !== serialized) this.unreported.add(id);
    }
    this.previous = next;
    this.primed = true;
  }
}
