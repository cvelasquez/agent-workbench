/**
 * El registro de las ramas aparte que creó la app: `worktrees.json`, en su
 * carpeta de configuración (hito 48, §6.38).
 *
 * Es lo único que la app le cree a la hora de devolver notas a una carpeta
 * principal o de quitar una rama: la principal sale de acá y no del archivo
 * `.git` de la rama, que es un archivo del proyecto (§2.1). Una rama que la app
 * no creó no está acá, y no se ofrece quitarla: limpiar lo que no es de uno es
 * la lección de Cursor (§6.38).
 *
 * Las quitadas se conservan, para "Volver a abrir la rama". Cambia poco (crear y
 * quitar), así que cada cambio se escribe enseguida, de forma atómica.
 *
 * Desde el hito 49 guarda además la última revisión de cada rama: qué CLI, qué
 * conversación y en qué commits estaban la base y la rama. Nunca su texto. Una
 * build del hito 48 la descarta al guardar: sólo se pierde ese estado.
 */

import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_IDS,
  asArrayFiltered,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
  asStringArray,
  type AgentId,
} from '@agent-workbench/shared';
import { writeAtomically } from '../atomic-write.js';
import { worktreesStatePath } from '../paths.js';
import { samePathShape } from './checkout.js';
import type { CopiedFile } from './include.js';

const STATE_VERSION = 1;
/** Tope de quitadas que se conservan: las más viejas se olvidan. */
const MAX_REMOVED = 300;
/** Cuántas conversaciones de revisión se recuerdan por rama. */
const MAX_REVIEW_SESSIONS = 20;

/**
 * La última revisión pedida para una rama (hito 49). El texto no se guarda:
 * vive en el historial de la CLI que revisó.
 */
export interface WorktreeReviewRecord {
  agent: AgentId;
  /** La conversación del revisor; `''` mientras la CLI no la descubre (Codex, Antigravity). */
  sessionId: string;
  /** La pestaña que la pidió: con ella se encuentra la conversación todavía sin id. */
  terminalId: string;
  /** En qué commit estaban la base y la rama al pedirla: si se movieron, es "de un commit anterior". */
  baseCommit: string;
  branchCommit: string;
  requestedAt: number;
}

export interface WorktreeRecord {
  id: string;
  /** La carpeta principal del repo. */
  mainRoot: string;
  /** La carpeta de la rama. */
  path: string;
  branch: string;
  /** La rama de la que salió: contra ella se mira si está integrada. */
  base: string;
  /** true si la creó la app (`worktree add -b`): sólo esa se borra, y sólo integrada. */
  createdBranch: boolean;
  /** Si se copiaron las instrucciones y la memoria ignoradas. */
  copyNotes: boolean;
  copied: CopiedFile[];
  /** Las carpetas que se copiaron enteras: lo nuevo adentro también vuelve. */
  copiedDirs: string[];
  createdAt: number;
  /** null mientras la carpeta existe. */
  removedAt: number | null;
  /** Hito 49. La última revisión pedida, o null. Ausente en un registro del hito 48. */
  review: WorktreeReviewRecord | null;
  /**
   * Hito 49. Las conversaciones de revisión de esta rama, para no tomarlas por
   * las de su autor al buscar dónde dejarle un pedido. Las más nuevas al final.
   */
  reviewSessions: string[];
}

function parseCopied(value: unknown): CopiedFile | null {
  const record = asRecord(value);
  const file = asNonEmptyString(record?.['path']);
  const hash = asNonEmptyString(record?.['hash']);
  return file === null || hash === null ? null : { path: file, hash };
}

function parseReview(value: unknown): WorktreeReviewRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], AGENT_IDS);
  const sessionId = asString(record['sessionId']);
  const terminalId = asString(record['terminalId']);
  const baseCommit = asNonEmptyString(record['baseCommit']);
  const branchCommit = asNonEmptyString(record['branchCommit']);
  const requestedAt = asFiniteNumber(record['requestedAt']);
  if (agent === null || sessionId === null || terminalId === null || baseCommit === null || branchCommit === null || requestedAt === null) {
    return null;
  }
  return { agent, sessionId, terminalId, baseCommit, branchCommit, requestedAt };
}

/** Una conversación más en la lista de las de revisión, sin repetir y con tope. */
export function withReviewSession(sessions: readonly string[], sessionId: string): string[] {
  if (sessionId.length === 0) return [...sessions];
  return [...sessions.filter((existing) => existing !== sessionId), sessionId].slice(-MAX_REVIEW_SESSIONS);
}

export function parseWorktreeRecord(value: unknown): WorktreeRecord | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const mainRoot = asNonEmptyString(record['mainRoot']);
  const folder = asNonEmptyString(record['path']);
  const branch = asNonEmptyString(record['branch']);
  const base = asNonEmptyString(record['base']);
  const createdBranch = asBoolean(record['createdBranch']);
  const copyNotes = asBoolean(record['copyNotes']);
  const copied = asArrayFiltered(record['copied'], parseCopied);
  const copiedDirs = asStringArray(record['copiedDirs']);
  const createdAt = asFiniteNumber(record['createdAt']);
  const removedAt = record['removedAt'] === null ? null : asFiniteNumber(record['removedAt']);
  if (
    id === null ||
    mainRoot === null ||
    folder === null ||
    branch === null ||
    base === null ||
    createdBranch === null ||
    copyNotes === null ||
    copied === null ||
    copiedDirs === null ||
    createdAt === null ||
    (record['removedAt'] !== null && removedAt === null)
  ) {
    return null;
  }
  return {
    id,
    mainRoot,
    path: folder,
    branch,
    base,
    createdBranch,
    copyNotes,
    copied,
    copiedDirs,
    createdAt,
    removedAt,
    // Ausentes en un registro del hito 48: sin revisión.
    review: parseReview(record['review']),
    reviewSessions: asStringArray(record['reviewSessions'])?.filter((id) => id.length > 0) ?? [],
  };
}

/** Una versión que no se conoce se ignora entera, como en las demás tiendas de la app. */
export function parseWorktreesState(raw: string): WorktreeRecord[] {
  try {
    const parsed = asRecord(JSON.parse(raw));
    if (parsed === null || parsed['version'] !== STATE_VERSION) return [];
    return asArrayFiltered(parsed['worktrees'], parseWorktreeRecord) ?? [];
  } catch {
    return [];
  }
}

export class WorktreeStore {
  private records: WorktreeRecord[] = [];
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string = worktreesStatePath()) {}

  async load(): Promise<void> {
    try {
      this.records = parseWorktreesState(await readFile(this.file, 'utf8'));
    } catch {
      // Primer arranque: ninguna.
      this.records = [];
    }
  }

  list(): readonly WorktreeRecord[] {
    return this.records;
  }

  get(id: string): WorktreeRecord | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  /** El registro de una carpeta, viva o quitada; la viva primero. */
  byPath(folder: string): WorktreeRecord | null {
    const matches = this.records.filter((record) => samePathShape(record.path, folder));
    return matches.find((record) => record.removedAt === null) ?? matches[matches.length - 1] ?? null;
  }

  async add(record: WorktreeRecord): Promise<void> {
    this.records = [...this.records.filter((existing) => existing.id !== record.id), record];
    await this.save();
  }

  async update(id: string, patch: Partial<Omit<WorktreeRecord, 'id'>>): Promise<WorktreeRecord | null> {
    const current = this.get(id);
    if (current === null) return null;
    const next = { ...current, ...patch };
    this.records = this.records.map((record) => (record.id === id ? next : record));
    await this.save();
    return next;
  }

  /** Espera la escritura en curso. Para el apagado y las pruebas. */
  flush(): Promise<void> {
    return this.writing;
  }

  private save(): Promise<void> {
    const removed = this.records.filter((record) => record.removedAt !== null);
    if (removed.length > MAX_REMOVED) {
      const forget = new Set(
        removed
          .sort((a, b) => (a.removedAt ?? 0) - (b.removedAt ?? 0))
          .slice(0, removed.length - MAX_REMOVED)
          .map((record) => record.id),
      );
      this.records = this.records.filter((record) => !forget.has(record.id));
    }
    const content = Buffer.from(JSON.stringify({ version: STATE_VERSION, worktrees: this.records }, null, 2), 'utf8');
    // En fila: dos cambios seguidos no pueden escribir en desorden.
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeAtomically(this.file, content);
      });
    return this.writing;
  }
}
