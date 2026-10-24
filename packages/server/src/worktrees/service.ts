/**
 * Las ramas aparte de punta a punta (hito 48, §6.38): mirar antes de crear,
 * crear, el estado de cada una, el plan de quitar, quitar y volver a abrir. Y
 * desde el hito 49, trabajar como un equipo: el estado de cada rama contra su
 * base (cuánto avanzó, si choca, qué otra rama toca lo mismo), lo que trae, la
 * revisión de otro agente, ponerse al día e integrar.
 *
 * Todo lo que cambia el disco va después de una confirmación del usuario, y el
 * servidor rehace lo que vio antes de hacer nada (como la memoria compartida,
 * §6.15): el cliente manda opciones, nunca rutas ni cambios (§2.4).
 *
 * Quitar es lo delicado, y va en este orden, deteniéndose en el primer "no":
 *
 *  1. trabajo sin commit: no se quita; git se negaría sin `--force`, y
 *     `--force` no se usa. Si todo son archivos nuevos que git no sigue, el
 *     usuario puede elegir perderlos (23-10-2026, `untracked.ts`): se borran
 *     después del paso 5, sólo si siguen siendo los que vio, y nunca si git se
 *     va a negar igual;
 *  2. notas que cambiaron en los dos lados y no se pueden juntar: no se
 *     quita, salvo que el usuario elija perder lo de la rama;
 *  3. otro programa con la carpeta abierta: no se quita (Windows dejaría a git
 *     a medias, medido), y desde el 23-10-2026 el plan dice cuál (`holders.ts`);
 *  4. se cierran las pestañas y consolas de ahí, y se espera a que Windows
 *     suelte la carpeta (unos 50 ms, medido en el paso 0);
 *  5. las notas que cambiaron en la rama vuelven a la principal, juntas con lo
 *     que cambió allá si hace falta (21-10-2026);
 *  6. `git worktree remove`; lo que quede (los enlaces de pnpm, que git no
 *     borra, o lo que no pudo borrar después de soltar la rama, 23-10-2026)
 *     se borra sin seguir enlaces y sólo dentro de esa carpeta;
 *  7. la rama, con `branch -d`, sólo si la creó la app y ya está integrada. El
 *     registro anota en qué commit quedó: volver a abrir una conversación de
 *     ahí la crea otra vez en ese commit (20-10-2026).
 *
 * Integrar (hito 49) es un solo comando, `git merge --ff-only`, en la carpeta
 * donde está sacada la base, y sólo cuando no hace falta crear un commit. Desde
 * el 21-10-2026, si esa carpeta es la principal, las notas de la rama viajan
 * con los commits, como al quitarla. El rebase de ponerse al día lo hace el
 * agente de la rama en su terminal, nunca la app: reescribe commits (§6.1).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ServerTextError,
  WORKTREE_CHANGES_COMMITS_MAX,
  WORKTREE_CHANGES_FILES_MAX,
  WORKTREE_PLAN_PATHS_MAX,
  WORKTREE_ROW_FILES_MAX,
  branchNameProblem,
  isAgentId,
  serverText,
  type AgentId,
  type GitDiff,
  type SessionSummary,
  type TerminalActivity,
  type TerminalDescriptor,
  type TerminalId,
  type WorktreeChangedFile,
  type WorktreeChanges,
  type WorktreeCreateMode,
  type WorktreeDeleteBranchPlan,
  type WorktreeHolder,
  type WorktreeInspection,
  type WorktreeIntegrateOutcome,
  type WorktreeIntegratePlan,
  type WorktreeKeptBranch,
  type WorktreeMerge,
  type WorktreeNotesPreview,
  type WorktreeOpenTab,
  type WorktreeRemoveOutcome,
  type WorktreeRemovePlan,
  type WorktreeReviewPlan,
  type WorktreeReviewSummary,
  type WorktreeRow,
  type WorktreeSource,
} from '@agent-workbench/shared';
import type { HistorySource } from '../agents/adapter.js';
import type { EventLimits } from '../agents/transport-limits.js';
import type { OpenTerminalOptions } from '../terminal-registry.js';
import { drainFollower } from '../vault/read-session.js';
import { samePathShape } from './checkout.js';
import {
  addWorktree,
  aheadBehind,
  branchChangedFiles,
  branchCommit,
  branchCommits,
  branchFileDiff,
  branchTips,
  commitExists,
  currentBranch,
  deleteBranch,
  deleteBranchArgs,
  fastForward,
  fastForwardArgs,
  gitFailureText,
  hasLoadedSubmodule,
  ignoredAmong,
  isIntegrated,
  listWorktrees,
  localBranches,
  mergeTarget,
  mergeTreeCheck,
  readWorktreeList,
  refFormatAccepts,
  removeWorktree,
  removeWorktreeArgs,
  repoLayout,
  uncommittedChanges,
  uncommittedPaths,
  type UncommittedChanges,
  type WorktreeEntry,
} from './git.js';
import { folderHolders } from './holders.js';
import { askedNotesNow, copyToWorktree, hashOf, notesIn, planCopy, returnNotes, reviewNotes, summarize, type CopyPlan } from './include.js';
import { worktreeFolderFor, worktreesParentFor } from './names.js';
import { NoteBases } from './note-bases.js';
import { overlapsFor, pathsTouching, type BranchFiles } from './overlap.js';
import { catchUpPrompt, commitPrompt, lastReplyText, readVerdict, reviewPrompt, sendBackPrompt } from './review.js';
import { withNoteRequests, withReviewSession, type WorktreeRecord, type WorktreeStore } from './store.js';
import { deleteUntracked, scanUntracked, type UntrackedScan } from './untracked.js';

/** Un pedido de ramas aparte que no se pudo cumplir. El texto dice por qué (§6.23). */
export class WorktreeError extends ServerTextError {}

/**
 * Quitar se frenó porque otro programa tiene la carpeta (23-10-2026). Lleva el
 * plan de ese momento, con quién la tiene: el socket lo manda como plan y el
 * diálogo lo nombra, en vez de un error a secas. No se cambió nada.
 */
export class WorktreeInUseError extends WorktreeError {
  constructor(readonly plan: WorktreeRemovePlan) {
    super(serverText('worktreeInUse'));
  }
}

/**
 * Cuánto se reusa el estado de las filas de Cambios: son procesos de git por
 * rama. Lo que cambia sin mover ninguna punta (lo que no está commiteado) se ve
 * con este retraso; un commit en cualquier rama, enseguida.
 */
const ROWS_TTL_MS = 5_000;
/** Cuánto se espera a que Windows suelte una carpeta después de cerrar sus pestañas. */
const RELEASE_TIMEOUT_MS = 5_000;
const RELEASE_POLL_MS = 100;
/** Cuántos pares de commits (punta de la base, punta de la rama) se recuerdan. */
const PAIR_CACHE_MAX = 200;
/** La respuesta del revisor se lee entera: una revisión larga no se corta a los 8 000 del hilo. */
const REPLY_LIMITS: EventLimits = { textMaxChars: 200_000, toolInputMaxChars: 200, toolResultMaxChars: 200 };
/** Cuántos eventos del final de su conversación se miran. */
const REPLY_EVENTS = 300;
/** Cuántas respuestas de revisores se recuerdan: una por conversación, y la que se olvida se vuelve a leer. */
const REPLY_CACHE_MAX = 50;
/** Cuánto se espera antes de avisar que cambió el estado de una revisión: su pestaña late seguido. */
const REVIEW_ACTIVITY_DELAY_MS = 1_000;

export interface WorktreeServiceDeps {
  store: WorktreeStore;
  registry: {
    open(options: OpenTerminalOptions): Promise<TerminalDescriptor>;
    list(): TerminalDescriptor[];
    get(terminalId: TerminalId): TerminalDescriptor | null;
    /** Hito 49. Qué hace la CLI de una pestaña: la del revisor, la de la rama. */
    activityOf?(terminalId: TerminalId): TerminalActivity | null;
  };
  /** La carpeta de un proyecto de la barra, por su `key`; null si la barra no lo tiene. */
  projectCwd(projectKey: string): string | null;
  /** Una sesión de la barra, para volver a abrir su rama. */
  findSession(agent: AgentId, sessionId: string): SessionSummary | null;
  /** Hito 49. Las sesiones de la barra que trabajaron dentro de `folder`, de todas las CLIs. */
  sessionsUnder?(folder: string): SessionSummary[];
  /** Hito 49. El historial de una CLI, para leer la respuesta del revisor. */
  history?(agent: AgentId): Pick<HistorySource, 'follow' | 'wholeRead'> | null;
  /** Las copias de origen de las notas (21-10-2026). Ausente: las de la carpeta de la app. */
  noteBases?: NoteBases;
  /** Quién tiene abierta una carpeta (23-10-2026). Ausente: `folderHolders`. */
  folderHolders?: (folder: string) => Promise<WorktreeHolder[]>;
  now?: () => number;
}

export interface WorktreeCreateRequest {
  source: WorktreeSource;
  branch: string;
  base: string;
  mode: WorktreeCreateMode;
  agent?: AgentId;
  copyNotes: boolean;
}

/** Dónde queda un pedido para el agente de la rama: su pestaña, o una que se abrió para eso. */
export interface AuthorRequest {
  terminal: TerminalDescriptor;
  opened: boolean;
  text: string;
  /** Lo que va como ficha de texto pegado: la respuesta del revisor. */
  pasted: string[];
}

/**
 * `changed`: se creó, se quitó, se volvió a abrir o se integró una rama: cambia
 * a qué proyecto cae cada carpeta y lo que dice cada fila. `rows`: cambió sólo
 * lo que dice alguna fila (un revisor empezó o terminó), y la barra no tiene
 * nada que releer.
 */
export declare interface WorktreeService {
  on(event: 'changed' | 'rows', listener: () => void): this;
  off(event: 'changed' | 'rows', listener: () => void): this;
  emit(event: 'changed' | 'rows'): boolean;
}

/** La carpeta está, sin nada que se llame `.git` adentro (ni un enlace roto). */
async function leftWithoutGit(folder: string): Promise<boolean> {
  return (await exists(folder)) && (await lstat(path.join(folder, '.git')).catch(() => null)) === null;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/** true si `inner` está dentro de `outer` (o es `outer`). */
function isInside(outer: string, inner: string): boolean {
  const relative = path.relative(path.resolve(outer), path.resolve(inner));
  return relative.length === 0 || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** Un comando para mostrar, con comillas donde hacen falta. */
export function displayCommand(args: readonly string[]): string {
  return ['git', ...args].map((arg) => (/[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg)).join(' ');
}

/**
 * true si otro proceso tiene la carpeta abierta. En Windows, una carpeta que es
 * el directorio de trabajo de un proceso no se puede renombrar (`EBUSY`, medido
 * en el paso 0): se renombra y se le devuelve el nombre. No cambia nada.
 */
export async function folderInUse(folder: string): Promise<boolean> {
  const probe = `${folder}.aw-probe-${randomBytes(4).toString('hex')}`;
  try {
    await rename(folder, probe);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code !== 'ENOENT';
  }
  // Devolverle el nombre tiene que salir: con otro nombre, git ya no la encuentra.
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(probe, folder);
      return false;
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** El pedido en inglés para el agente de la rama, con las notas que chocaron (§6.23). */
export function notesConflictPrompt(mainRoot: string, files: readonly string[]): string {
  return (
    `Some ignored notes changed both in this branch folder and in the main folder (${mainRoot}): ` +
    `${files.join(', ')}. Bring your changes from this folder into those files in the main folder, ` +
    `keeping what is already there, and tell me when it's done. Don't change anything else.`
  );
}

/**
 * Lo que se sabe de una rama contra su base en un par de commits dado. No
 * cambia mientras ninguna de las dos puntas se mueva, y por eso se recuerda por
 * ese par (`pairState`).
 */
interface PairState {
  ahead: number;
  behind: number;
  /** Lo que la rama cambió desde que salió; null si git no pudo. */
  files: WorktreeChangedFile[] | null;
  /** Sólo con la base adelante y la rama con commits: si no, no hay nada que chocar. */
  merge: { clean: boolean; files: string[] } | null;
}

function toMerge(merge: { clean: boolean; files: string[] }): WorktreeMerge {
  return {
    state: merge.clean ? 'clean' : 'conflicts',
    files: merge.files.slice(0, WORKTREE_ROW_FILES_MAX),
    fileCount: merge.files.length,
  };
}

/**
 * true si una rama que creó la app sigue en el commit del que salió: no tiene
 * commits propios. Para git está integrada (`branch -d` la borra), pero no
 * trajo nada a su base, y llamarla "integrada" se lee como que lo hecho ya
 * entró. Sin el commit de salida (una rama que ya existía, un registro
 * anterior) no se sabe, y queda como antes.
 */
function stillAtStart(record: WorktreeRecord | null, tip: string | undefined): boolean {
  return record !== null && record.startCommit !== null && tip !== undefined && tip === record.startCommit;
}

export class WorktreeService extends EventEmitter {
  private readonly rowsCache = new Map<string, { at: number; tips: string; rows: Omit<WorktreeRow, 'isCurrent'>[] }>();
  /** Sube cada vez que se borra lo guardado (`forgetRows`). */
  private rowsGeneration = 0;
  private readonly pairs = new Map<string, Promise<PairState | null>>();
  private readonly replies = new Map<string, { stamp: string; text: Promise<string | null> }>();
  private activityTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  private readonly noteBases: NoteBases;
  private readonly loadNoteBase = (hash: string): Promise<Buffer | null> => this.noteBases.load(hash);

  constructor(private readonly deps: WorktreeServiceDeps) {
    super();
    this.now = deps.now ?? Date.now;
    this.noteBases = deps.noteBases ?? new NoteBases();
  }

  /** La carpeta principal del repo de un proyecto o de una pestaña. */
  private async mainRootOf(source: WorktreeSource): Promise<string> {
    const cwd =
      source.kind === 'terminal'
        ? (this.deps.registry.get(source.terminalId)?.cwd ?? null)
        : this.deps.projectCwd(source.projectKey);
    if (cwd === null || !(await exists(cwd))) throw new WorktreeError(serverText('worktreeProjectUnknown'));
    const layout = await repoLayout(cwd);
    if (layout === null || layout.mainRoot === null) throw new WorktreeError(serverText('worktreeNotRepo'));
    return layout.mainRoot;
  }

  /** Lo que el diálogo de crear muestra. No escribe nada. */
  async inspect(source: WorktreeSource): Promise<WorktreeInspection> {
    const mainRoot = await this.mainRootOf(source);
    const [current, branches, entries, changes, copy] = await Promise.all([
      currentBranch(mainRoot),
      localBranches(mainRoot),
      listWorktrees(mainRoot),
      uncommittedPaths(mainRoot),
      planCopy(mainRoot),
    ]);
    const checkedOut = new Set(entries.map((entry) => entry.branch).filter((branch) => branch !== null));
    return {
      mainRoot,
      parentDir: worktreesParentFor(mainRoot),
      separator: path.sep,
      currentBranch: current,
      branches: branches.map((name) => ({ name, checkedOut: checkedOut.has(name) })),
      mainChanges: changes?.length ?? 0,
      include: copy?.include ? summarize(copy.include) : null,
      notes: copy === null ? { files: 0, bytes: 0, overCap: false, sample: [] } : summarize(copy.notes),
    };
  }

  /** Crea la rama aparte, copia lo ignorado, la anota y abre la pestaña ahí. */
  async create(request: WorktreeCreateRequest): Promise<TerminalDescriptor> {
    const { branch, base, mode } = request;
    if (branchNameProblem(branch) !== null) throw new WorktreeError(serverText('worktreeBranchInvalid', { branch }));
    const mainRoot = await this.mainRootOf(request.source);
    if (!(await refFormatAccepts(mainRoot, branch))) throw new WorktreeError(serverText('worktreeBranchInvalid', { branch }));

    const existing = await branchCommit(mainRoot, branch);
    if (mode === 'new' && existing !== null) throw new WorktreeError(serverText('worktreeBranchExists', { branch }));
    if (mode === 'existing' && existing === null) throw new WorktreeError(serverText('worktreeBranchMissing', { branch }));
    if ((await branchCommit(mainRoot, base)) === null) throw new WorktreeError(serverText('worktreeBaseMissing', { base }));
    if (mode === 'existing' && (await listWorktrees(mainRoot)).some((entry) => entry.branch === branch)) {
      throw new WorktreeError(serverText('worktreeBranchInUse', { branch }));
    }

    const folder = worktreeFolderFor(mainRoot, branch);
    if (await exists(folder)) throw new WorktreeError(serverText('worktreeFolderExists', { folder }));

    const copy = await planCopy(mainRoot);
    await mkdir(path.dirname(folder), { recursive: true });
    const added = await addWorktree(mainRoot, folder, branch, mode === 'new' ? base : null);
    if (added.code !== 0) throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(added) }));

    const { copied, copiedDirs } = await this.copyInto(mainRoot, folder, copy, request.copyNotes);
    await this.deps.store.add({
      id: randomUUID(),
      mainRoot,
      path: folder,
      branch,
      base,
      createdBranch: mode === 'new',
      startCommit: mode === 'new' ? await branchCommit(mainRoot, branch) : null,
      copyNotes: request.copyNotes,
      copied,
      copiedDirs,
      createdAt: this.now(),
      removedAt: null,
      endCommit: null,
      review: null,
      reviewSessions: [],
      notesAsked: [],
    });
    this.changed();
    return this.deps.registry.open({ cwd: folder, ...(request.agent !== undefined ? { agent: request.agent } : {}) });
  }

  private async copyInto(
    mainRoot: string,
    folder: string,
    copy: CopyPlan | null,
    copyNotes: boolean,
  ): Promise<{ copied: WorktreeRecord['copied']; copiedDirs: string[] }> {
    const parts = [copy?.include ?? null, copyNotes ? (copy?.notes ?? null) : null].filter(
      (part) => part !== null && !part.overCap,
    );
    const copied = await copyToWorktree(mainRoot, folder, parts.flatMap((part) => part?.files ?? []), this.noteBases);
    return { copied, copiedDirs: [...new Set(parts.flatMap((part) => part?.dirs ?? []))] };
  }

  /**
   * Borra las copias de origen que ya no nombra ninguna rama viva. Un fallo no
   * frena nada: lo que quede se borra la próxima vez.
   */
  private async pruneNoteBases(): Promise<void> {
    const keep = new Set(
      this.deps.store
        .list()
        .filter((record) => record.removedAt === null)
        .flatMap((record) => record.copied.map((file) => file.hash)),
    );
    await this.noteBases.prune(keep).catch(() => undefined);
  }

  /** Las filas de "Ramas aparte" para la pestaña que pregunta. Vacío fuera de git. */
  async rows(terminalId: TerminalId): Promise<WorktreeRow[]> {
    const descriptor = this.deps.registry.get(terminalId);
    if (descriptor === null || !(await exists(descriptor.cwd))) return [];
    const layout = await repoLayout(descriptor.cwd);
    if (layout === null || layout.mainRoot === null) return [];
    const mainRoot = layout.mainRoot;

    // Las puntas son un solo `for-each-ref`: con una que se movió, lo guardado ya no vale.
    const tips = await branchTips(mainRoot);
    const tipsStamp = [...tips].map(([branch, commit]) => `${branch}\0${commit}`).join('\n');
    const cacheKey = path.resolve(mainRoot).toLowerCase();
    const cached = this.rowsCache.get(cacheKey);
    const fresh = cached !== undefined && cached.tips === tipsStamp && this.now() - cached.at < ROWS_TTL_MS;
    // Una lectura que empezó antes de que se borrara lo guardado (una revisión cambió) no lo vuelve a llenar con lo viejo.
    const generation = this.rowsGeneration;
    const rows = fresh ? cached.rows : await this.readRows(mainRoot, tips);
    if (!fresh && generation === this.rowsGeneration) this.rowsCache.set(cacheKey, { at: this.now(), tips: tipsStamp, rows });
    return rows.map((row) => ({ ...row, isCurrent: samePathShape(row.path, layout.toplevel) }));
  }

  private async readRows(mainRoot: string, tips: ReadonlyMap<string, string>): Promise<Omit<WorktreeRow, 'isCurrent'>[]> {
    const listed = await readWorktreeList(mainRoot);
    const entries = [
      ...(listed ?? []).filter((entry) => !entry.bare),
      // Las que git soltó a medias: sin su fila, no había cómo terminar de quitarlas.
      ...(listed === null ? [] : await this.releasedEntries(mainRoot, listed)),
    ];
    const mainBranch = entries.find((entry) => entry.isMain)?.branch ?? null;
    const read = await Promise.all(
      entries.map(async (entry) => {
        const record = this.liveRecord(entry.path);
        const base = record?.base ?? mainBranch;
        const branch = entry.branch;
        const comparable = branch !== null && base !== null && branch !== base && !entry.isMain;
        const [changes, pair] = await Promise.all([
          entry.prunable ? Promise.resolve(null) : uncommittedPaths(entry.path),
          comparable ? this.pairState(mainRoot, base, branch, tips) : Promise.resolve(null),
        ]);
        return { entry, record, base, changes, pair };
      }),
    );
    // Lo que toca cada rama aparte, para avisar cuando dos tocan lo mismo (decisión 3).
    const touched: BranchFiles[] = read.flatMap(({ entry, pair }) =>
      entry.branch !== null && !entry.isMain && pair?.files ? [{ branch: entry.branch, files: pair.files }] : [],
    );
    return Promise.all(
      read.map(async ({ entry, record, base, changes, pair }) => ({
        id: record?.id ?? null,
        path: entry.path,
        branch: entry.branch,
        base,
        isMain: entry.isMain,
        changes: changes === null ? null : changes.length,
        ahead: pair?.ahead ?? null,
        integrated: pair === null ? null : pair.ahead === 0 && !stillAtStart(record, entry.branch === null ? undefined : tips.get(entry.branch)),
        behind: pair?.behind ?? null,
        merge: pair?.merge ? toMerge(pair.merge) : null,
        overlaps: entry.branch !== null && !entry.isMain ? overlapsFor(entry.branch, touched, WORKTREE_ROW_FILES_MAX) : [],
        review: record?.review ? await this.reviewSummary(record, tips) : null,
      })),
    );
  }

  /**
   * Lo que se sabe de `branch` contra `base` en sus puntas de ahora: cuánto
   * avanzó cada una, qué archivos tocó la rama y, si la base avanzó, si choca.
   * Se recuerda por el par de commits: sólo se recalcula cuando una de las dos
   * se movió. Un fallo no se recuerda, tampoco a medias (los archivos o el
   * choque sin saber): el pedido siguiente lo vuelve a intentar. null si alguna
   * rama no existe.
   */
  private pairState(mainRoot: string, base: string, branch: string, tips: ReadonlyMap<string, string>): Promise<PairState | null> {
    const baseTip = tips.get(base);
    const branchTip = tips.get(branch);
    if (baseTip === undefined || branchTip === undefined) return Promise.resolve(null);
    const key = [path.resolve(mainRoot).toLowerCase(), base, branch, baseTip, branchTip].join('\0');
    const cached = this.pairs.get(key);
    if (cached !== undefined) {
      // El más usado queda al final: el que se olvida es el más viejo.
      this.pairs.delete(key);
      this.pairs.set(key, cached);
      return cached;
    }
    const pending = (async (): Promise<PairState | null> => {
      const counts = await aheadBehind(mainRoot, base, branch);
      if (counts === null) return null;
      const [files, merge] = await Promise.all([
        branchChangedFiles(mainRoot, base, branch),
        counts.behind > 0 && counts.ahead > 0 ? mergeTreeCheck(mainRoot, base, branch) : Promise.resolve(null),
      ]);
      return { ...counts, files, merge };
    })();
    this.pairs.set(key, pending);
    while (this.pairs.size > PAIR_CACHE_MAX) {
      const oldest = this.pairs.keys().next().value;
      if (oldest === undefined) break;
      this.pairs.delete(oldest);
    }
    pending.then(
      (value) => {
        const partial = value === null || value.files === null || (value.behind > 0 && value.ahead > 0 && value.merge === null);
        if (partial && this.pairs.get(key) === pending) this.pairs.delete(key);
      },
      () => {
        if (this.pairs.get(key) === pending) this.pairs.delete(key);
      },
    );
    return pending;
  }

  private liveRecord(folder: string): WorktreeRecord | null {
    const record = this.deps.store.byPath(folder);
    return record !== null && record.removedAt === null ? record : null;
  }

  private recordOrThrow(id: string): WorktreeRecord {
    const record = this.deps.store.get(id);
    if (record === null || record.removedAt !== null) throw new WorktreeError(serverText('worktreeUnknown'));
    return record;
  }

  /** Una rama aparte que existe en disco, para lo que la lee o le deja un pedido. */
  private async presentRecordOrThrow(id: string): Promise<WorktreeRecord> {
    const record = this.recordOrThrow(id);
    if (!(await exists(record.path))) throw new WorktreeError(serverText('worktreeUnknown'));
    return record;
  }

  /** Las pestañas y consolas abiertas dentro de la carpeta de la rama. */
  private tabsIn(folder: string): WorktreeRemovePlan['tabs'] {
    return this.deps.registry
      .list()
      .filter((tab) => isInside(folder, tab.cwd))
      // Una pestaña sin nombre propio se reconoce por su carpeta.
      .map((tab) => ({ terminalId: tab.terminalId, kind: tab.kind, label: tab.label || path.basename(tab.cwd) }));
  }

  /**
   * Las pestañas de una carpeta de trabajo, sin las de otra que viva adentro
   * (las ramas aparte de Claude Code van en `.claude/worktrees` de la principal).
   */
  private tabsInWorktree(folder: string, entries: readonly WorktreeEntry[]): WorktreeOpenTab[] {
    const nested = entries
      .filter((entry) => !samePathShape(entry.path, folder) && isInside(folder, entry.path))
      .map((entry) => entry.path);
    return this.tabsIn(folder).filter((tab) => {
      const cwd = this.deps.registry.get(tab.terminalId)?.cwd ?? '';
      return !nested.some((inner) => isInside(inner, cwd));
    });
  }

  /**
   * Los archivos nuevos que se pueden perder al quitar la rama (23-10-2026):
   * sólo si todo lo que no está commiteado es nuevo y git lo listó entero. null
   * si no; si git se va a negar a quitarla igual, bloqueada o con un submódulo
   * cargado (no se borra nada antes de saberlo); o si una entrada no se puede
   * borrar sin salir de la carpeta. Con algo adentro que la app copió de la
   * principal y la rama no ignora, no se ofrece (`copied`): no vuelve como una
   * nota, y se perdería lo que la rama le cambió.
   */
  private async untrackedIn(record: WorktreeRecord, changes: UncommittedChanges): Promise<UntrackedScan | null> {
    const onlyNew = changes.complete && changes.paths.length > 0 && changes.untracked.length === changes.paths.length;
    if (!onlyNew) return null;
    const [entries, submodule] = await Promise.all([listWorktrees(record.mainRoot), hasLoadedSubmodule(record.path)]);
    if (submodule !== false || entries.some((entry) => entry.locked && samePathShape(entry.path, record.path))) return null;
    const entryOf = (file: string): boolean =>
      changes.untracked.some((entry) => {
        const clean = entry.replace(/\/+$/, '').toLowerCase();
        return file.toLowerCase() === clean || file.toLowerCase().startsWith(`${clean}/`);
      });
    const copied: string[] = [];
    for (const file of record.copied) {
      if (entryOf(file.path) && (await exists(path.join(record.path, file.path)))) copied.push(file.path);
    }
    if (copied.length > 0) {
      const ignored = await ignoredAmong(record.path, copied);
      if (ignored === null || copied.some((file) => !ignored.has(file))) return { files: 0, bytes: 0, stamp: null, blocked: 'copied', targets: [] };
    }
    return scanUntracked(record.path, changes.untracked);
  }

  /**
   * Borra los archivos nuevos que el usuario eligió perder, si siguen siendo
   * los que vio: se mira justo antes, con las pestañas de la rama cerradas y
   * las notas ya de vuelta. Si desaparecieron solos, no hay nada que borrar.
   * Devuelve cuántos archivos se perdieron.
   */
  private async discardNew(record: WorktreeRecord, stamp: string | null): Promise<number> {
    const changes = await uncommittedChanges(record.path);
    if (changes === null) throw new WorktreeError(serverText('worktreeGitFailed', { detail: 'git status' }));
    if (changes.paths.length === 0) return 0;
    const scan = await this.untrackedIn(record, changes);
    if (scan === null || scan.stamp === null || scan.stamp !== stamp) throw new WorktreeError(serverText('worktreeUntrackedChanged'));
    try {
      await deleteUntracked(scan.targets);
    } catch (error) {
      throw new WorktreeError(serverText('worktreeDiscardFailed', { detail: error instanceof Error ? error.message : String(error) }));
    }
    return scan.files;
  }

  private async planFor(record: WorktreeRecord): Promise<WorktreeRemovePlan> {
    const onDisk = await exists(record.path);
    // Lo que quedó de una que git ya soltó no se le pregunta a git: la app lo termina de borrar.
    const present = onDisk && !(await this.releasedByGit(record));
    const [changes, notes, integrated] = await Promise.all([
      present ? uncommittedChanges(record.path) : Promise.resolve({ paths: [], untracked: [], complete: true }),
      present
        ? reviewNotes(record.mainRoot, record.path, record, this.loadNoteBase)
        : Promise.resolve({ returning: [], merging: [], resolved: [], conflicts: [] }),
      record.createdBranch ? isIntegrated(record.mainRoot, record.branch, record.base) : Promise.resolve(false),
    ]);
    if (changes === null) throw new WorktreeError(serverText('worktreeGitFailed', { detail: 'git status' }));
    const uncommitted = changes.paths;
    const untracked = await this.untrackedIn(record, changes);
    const tabs = this.tabsIn(record.path);
    const deletesBranch = integrated === true;
    // Se borra igual (no tiene nada que perder), pero el diálogo no la llama integrada.
    const branchUnused = deletesBranch && stillAtStart(record, (await branchCommit(record.mainRoot, record.branch)) ?? undefined);
    // Con pestañas de la app adentro, la prueba daría "en uso" por ellas mismas: se mira al confirmar.
    let inUse = !onDisk ? false : tabs.length > 0 ? null : await folderInUse(record.path);
    const holders = inUse === true ? await this.holdersOf(record.path) : [];
    // Nadie a la vista: algo de paso, que para ahora ya pudo soltarla (visto el 23-10-2026). Se mira otra vez.
    if (inUse === true && holders.length === 0) inUse = await folderInUse(record.path);
    return {
      id: record.id,
      branch: record.branch,
      path: record.path,
      commands: [
        ...(present ? [displayCommand(removeWorktreeArgs(record.path))] : []),
        ...(deletesBranch ? [displayCommand(deleteBranchArgs(record.branch))] : []),
      ],
      uncommitted: uncommitted.slice(0, WORKTREE_PLAN_PATHS_MAX),
      uncommittedCount: uncommitted.length,
      // Sin las rutas absolutas de `targets`: al cliente le basta con lo que muestra y la huella.
      untracked:
        untracked === null
          ? null
          : { files: untracked.files, bytes: untracked.bytes, stamp: untracked.stamp, blocked: untracked.blocked },
      tabs,
      returning: notes.returning,
      merging: notes.merging,
      resolved: notes.resolved,
      conflicts: notes.conflicts,
      inUse,
      holders,
      deletesBranch,
      branchUnused,
      createdBranch: record.createdBranch,
    };
  }

  /** El plan de quitar una rama aparte. No cambia nada. */
  planRemove(id: string): Promise<WorktreeRemovePlan> {
    return this.planFor(this.recordOrThrow(id));
  }

  /**
   * Quita la rama aparte. Rehace el plan y se detiene en el primer "no" (ver
   * el principio del archivo). `closeTab` cierra una pestaña como lo hace el
   * socket, soltando todo lo que la seguía. `discardUntracked` es la huella de
   * los archivos nuevos que el usuario eligió perder (23-10-2026).
   */
  async remove(
    id: string,
    discardConflicts: boolean,
    closeTab: (terminalId: TerminalId) => void,
    discardUntracked: string | null = null,
  ): Promise<WorktreeRemoveOutcome> {
    const record = this.recordOrThrow(id);
    const plan = await this.planFor(record);
    if (plan.uncommittedCount > 0) {
      if (plan.untracked === null || plan.untracked.stamp === null || discardUntracked === null) {
        throw new WorktreeError(serverText('worktreeUncommitted', { count: plan.uncommittedCount }));
      }
      // Antes de cerrar nada: con otra huella, las pestañas de la rama siguen abiertas.
      if (plan.untracked.stamp !== discardUntracked) throw new WorktreeError(serverText('worktreeUntrackedChanged'));
    }
    if (plan.conflicts.length > 0 && !discardConflicts) {
      throw new WorktreeError(serverText('worktreeNotesConflict', { count: plan.conflicts.length }));
    }
    if (plan.inUse === true) throw new WorktreeInUseError(plan);

    let returned = 0;
    let discardedFiles = 0;
    if (await exists(record.path)) {
      for (const tab of plan.tabs) closeTab(tab.terminalId);
      if (!(await this.waitUntilFree(record.path))) {
        // Las pestañas ya se cerraron: lo que queda es de otro programa.
        throw new WorktreeInUseError({ ...plan, tabs: [], inUse: true, holders: await this.holdersOf(record.path) });
      }

      // Una que git ya soltó no tiene notas que leer ni nada que preguntarle: queda borrar lo que dejó.
      if (!(await this.releasedByGit(record))) {
        const bases = new Map(record.copied.map((file) => [file.path, file.hash]));
        try {
          returned = (
            await returnNotes(record.mainRoot, record.path, plan.returning, bases, {
              loadBase: this.loadNoteBase,
              onWritten: (file, branch) => this.noteReturned(record.id, file, branch),
              notesAsked: record.notesAsked,
            })
          ).returned.length;
        } catch (error) {
          throw new WorktreeError(serverText('worktreeNotesFailed', { detail: error instanceof Error ? error.message : String(error) }));
        }

        // Después de las notas: una carpeta nueva puede tener adentro una nota que vuelve.
        if (plan.uncommittedCount > 0) discardedFiles = await this.discardNew(record, discardUntracked);

        const removed = await removeWorktree(record.mainRoot, record.path);
        // Si git la soltó sin terminar de borrarla, lo que quedó ya pasó sus controles: se borra abajo.
        if (removed.code !== 0 && !(await this.releasedByGit(record))) {
          throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(removed) }));
        }
      }
      await this.removeLeftovers(record);
    }

    // Dónde quedó, antes de borrarla: volver a abrir sus conversaciones la crea ahí (20-10-2026).
    const endCommit = await branchCommit(record.mainRoot, record.branch);
    const branchDeleted = plan.deletesBranch && (await deleteBranch(record.mainRoot, record.branch)).code === 0;
    await this.deps.store.update(id, { removedAt: this.now(), endCommit: endCommit ?? record.endCommit });
    // Sus copias de origen ya no hacen falta: volver a abrirla copia las notas otra vez.
    await this.pruneNoteBases();
    this.changed();
    return { branchDeleted, returned, discarded: discardConflicts ? plan.conflicts.length : 0, discardedFiles };
  }

  /** Los programas que tienen la carpeta, para el diálogo. Sin saberlo, ninguno: el diálogo dice lo de antes. */
  private async holdersOf(folder: string): Promise<WorktreeHolder[]> {
    try {
      return await (this.deps.folderHolders ?? folderHolders)(folder);
    } catch {
      return [];
    }
  }

  /** Espera, con tope, a que ningún proceso tenga la carpeta. */
  private async waitUntilFree(folder: string): Promise<boolean> {
    const deadline = this.now() + RELEASE_TIMEOUT_MS;
    for (;;) {
      if (!(await folderInUse(folder))) return true;
      if (this.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, RELEASE_POLL_MS));
    }
  }

  /**
   * Lo que `git worktree remove` dejó: los enlaces de `node_modules` de pnpm
   * (medido: git no los borra). `fs.rm` no sigue enlaces (medido con Node
   * 22.14: el destino quedó intacto). Nunca la principal, ni algo que la
   * contenga, ni una carpeta que git todavía tenga registrada.
   */
  private async removeLeftovers(record: WorktreeRecord): Promise<void> {
    const folder = path.resolve(record.path);
    if (!(await exists(folder))) return this.removeEmptyParent(folder);
    if (isInside(folder, record.mainRoot) || path.dirname(folder) === folder) return;
    if ((await listWorktrees(record.mainRoot)).some((entry) => samePathShape(entry.path, folder))) return;
    await rm(folder, { recursive: true, maxRetries: 3 });
    await this.removeEmptyParent(folder);
  }

  /**
   * true si git ya soltó la rama sin terminar de borrar su carpeta
   * (23-10-2026). `worktree remove` borra después de sus controles y, si algo
   * no se deja borrar a mitad de camino, quita su registro igual (medido con git
   * 2.56: una ruta de más de 260 caracteres sin `core.longpaths`, o un nombre
   * terminado en punto). Lo que quedó ya pasó esos controles, y lo termina de
   * borrar la app. Sólo sin `.git` adentro, y si git contesta que no la tiene:
   * una carpeta con su `.git` puede tener trabajo aunque git ya no la conozca.
   */
  private async releasedByGit(record: WorktreeRecord): Promise<boolean> {
    if (!(await leftWithoutGit(record.path))) return false;
    const entries = await readWorktreeList(record.mainRoot);
    return entries !== null && !entries.some((entry) => samePathShape(entry.path, record.path));
  }

  /** Las ramas de la app que git soltó a medias (`releasedByGit`), como si git las listara. */
  private async releasedEntries(mainRoot: string, listed: readonly WorktreeEntry[]): Promise<WorktreeEntry[]> {
    const released: WorktreeEntry[] = [];
    for (const record of this.deps.store.list()) {
      if (record.removedAt !== null || !samePathShape(record.mainRoot, mainRoot)) continue;
      if (listed.some((entry) => samePathShape(entry.path, record.path)) || !(await leftWithoutGit(record.path))) continue;
      // `prunable`: no se le pregunta a git qué tiene sin commit.
      released.push({ path: path.resolve(record.path), branch: record.branch, isMain: false, bare: false, locked: false, prunable: true });
    }
    return released;
  }

  /** La carpeta `<proyecto>.worktrees`, sólo si quedó vacía. */
  private async removeEmptyParent(folder: string): Promise<void> {
    await rmdir(path.dirname(folder)).catch(() => undefined);
  }

  /**
   * Vuelve a abrir la rama de una sesión cuya carpeta se quitó: la saca otra
   * vez en la misma carpeta, copia de nuevo lo ignorado y reanuda la sesión. Si
   * la rama se borró, la crea otra vez en el commit donde quedó (20-10-2026):
   * quitar una rama integrada ya no deja sus conversaciones sin salida.
   */
  async reopen(agent: AgentId, sessionId: string): Promise<TerminalDescriptor> {
    const session = this.deps.findSession(agent, sessionId);
    if (session === null || session.cwd.length === 0) throw new WorktreeError(serverText('worktreeUnknown'));
    const record = this.removedRecordAbove(session.cwd);
    if (record === null || (await exists(record.path)) || !(await exists(record.mainRoot))) {
      throw new WorktreeError(serverText('worktreeUnknown'));
    }
    const branchExists = (await branchCommit(record.mainRoot, record.branch)) !== null;
    const recreateAt = branchExists ? null : record.endCommit;
    if (!branchExists && (recreateAt === null || !(await commitExists(record.mainRoot, recreateAt)))) {
      throw new WorktreeError(serverText('worktreeBranchMissing', { branch: record.branch }));
    }
    if ((await listWorktrees(record.mainRoot)).some((entry) => entry.branch === record.branch)) {
      throw new WorktreeError(serverText('worktreeBranchInUse', { branch: record.branch }));
    }

    const copy = await planCopy(record.mainRoot);
    await mkdir(path.dirname(record.path), { recursive: true });
    const added = await addWorktree(record.mainRoot, record.path, record.branch, recreateAt);
    if (added.code !== 0) throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(added) }));
    const { copied, copiedDirs } = await this.copyInto(record.mainRoot, record.path, copy, record.copyNotes);
    // Las notas se copiaron de nuevo: un pedido al agente de antes ya no vale.
    await this.deps.store.update(record.id, { copied, copiedDirs, removedAt: null, notesAsked: [] });
    this.changed();
    return this.deps.registry.open({ cwd: session.cwd, agent, resumeSessionId: sessionId });
  }

  /**
   * Las ramas que creó la app, cuya carpeta se quitó y que siguen en el repo
   * (20-10-2026): las que se quitaron sin integrar, aunque se integraran
   * después. Una por rama, la del registro quitado más nuevo, y ninguna que
   * esté sacada en alguna carpeta (se volvió a abrir, o la abrió otro).
   */
  async keptBranches(terminalId: TerminalId): Promise<WorktreeKeptBranch[]> {
    const descriptor = this.deps.registry.get(terminalId);
    if (descriptor === null || !(await exists(descriptor.cwd))) return [];
    const layout = await repoLayout(descriptor.cwd);
    if (layout === null || layout.mainRoot === null) return [];
    const mainRoot = layout.mainRoot;
    const candidates = this.keptRecords(mainRoot);
    if (candidates.length === 0) return [];
    const [tips, entries] = await Promise.all([branchTips(mainRoot), listWorktrees(mainRoot)]);
    const checkedOut = new Set(entries.map((entry) => entry.branch));
    const kept = candidates.filter((record) => tips.has(record.branch) && !checkedOut.has(record.branch));
    return Promise.all(
      kept.map(async (record) => ({
        id: record.id,
        branch: record.branch,
        base: record.base,
        ahead: tips.has(record.base) ? ((await aheadBehind(mainRoot, record.base, record.branch))?.ahead ?? null) : null,
      })),
    );
  }

  /** Los registros quitados de ramas que creó la app en ese repo: el más nuevo de cada rama. */
  private keptRecords(mainRoot: string): WorktreeRecord[] {
    const newest = new Map<string, WorktreeRecord>();
    for (const record of this.deps.store.list()) {
      if (record.removedAt === null || !record.createdBranch || !samePathShape(record.mainRoot, mainRoot)) continue;
      const seen = newest.get(record.branch);
      if (seen === undefined || (seen.removedAt ?? 0) < record.removedAt) newest.set(record.branch, record);
    }
    return [...newest.values()].sort((a, b) => a.branch.localeCompare(b.branch));
  }

  private keptRecordOrThrow(id: string): WorktreeRecord {
    const record = this.deps.store.get(id);
    if (record === null || record.removedAt === null || !record.createdBranch) throw new WorktreeError(serverText('worktreeUnknown'));
    return record;
  }

  /**
   * El plan de borrar una rama guardada. No cambia nada. Sólo `branch -d`: con
   * commits que la base no tiene, o sin base contra la cual mirarlo, no se
   * borra desde la app (se perderían), y tampoco una que está sacada.
   */
  async planDeleteBranch(id: string): Promise<WorktreeDeleteBranchPlan> {
    const record = this.keptRecordOrThrow(id);
    const [tips, entries] = await Promise.all([branchTips(record.mainRoot), listWorktrees(record.mainRoot)]);
    if (!tips.has(record.branch)) throw new WorktreeError(serverText('worktreeBranchMissing', { branch: record.branch }));
    const ahead = tips.has(record.base) ? ((await aheadBehind(record.mainRoot, record.base, record.branch))?.ahead ?? null) : null;
    const checkedOut = entries.some((entry) => entry.branch === record.branch);
    return {
      id: record.id,
      branch: record.branch,
      base: record.base,
      folder: record.mainRoot,
      command: displayCommand(deleteBranchArgs(record.branch)),
      ahead,
      blocker: checkedOut ? 'checked-out' : ahead !== 0 ? 'not-integrated' : null,
    };
  }

  /**
   * Borra una rama guardada: rehace el plan y corre `git branch -d`, nada más.
   * Anota dónde quedaba, como al quitar: sus conversaciones se siguen pudiendo
   * volver a abrir.
   */
  async deleteKeptBranch(id: string): Promise<{ branch: string }> {
    const plan = await this.planDeleteBranch(id);
    if (plan.blocker === 'checked-out') throw new WorktreeError(serverText('worktreeBranchInUse', { branch: plan.branch }));
    if (plan.blocker === 'not-integrated') throw new WorktreeError(serverText('worktreeBranchNotIntegrated', { branch: plan.branch }));
    const endCommit = await branchCommit(plan.folder, plan.branch);
    const result = await deleteBranch(plan.folder, plan.branch);
    if (result.code !== 0) throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(result) }));
    if (endCommit !== null) await this.deps.store.update(id, { endCommit });
    this.changed();
    return { branch: plan.branch };
  }

  private removedRecordAbove(cwd: string): WorktreeRecord | null {
    let current = path.resolve(cwd);
    for (let depth = 0; depth < 24; depth += 1) {
      const record = this.deps.store.byPath(current);
      if (record !== null) return record.removedAt === null ? null : record;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
    return null;
  }

  /**
   * El pedido para que el agente de la rama pase las notas que chocaron, y en
   * qué pestaña va: la de su autor (nunca la de un revisor, que no puede
   * editar), o la que se abre para eso (`authorTarget`). El texto queda en su
   * cuadro, sin mandar.
   *
   * Se anota cómo estaban esas notas en los dos lados (21-10-2026): cuando la
   * principal cambie y la rama no, el agente las juntó, y quitar la rama ya no
   * pregunta por ellas.
   */
  async notesRequest(id: string): Promise<{ terminal: TerminalDescriptor; opened: boolean; text: string }> {
    const record = this.recordOrThrow(id);
    const { conflicts } = await reviewNotes(record.mainRoot, record.path, record, this.loadNoteBase);
    if (conflicts.length === 0) throw new WorktreeError(serverText('worktreeNoConflicts'));
    const asked = await askedNotesNow(record.mainRoot, record.path, conflicts);
    const current = this.deps.store.get(record.id) ?? record;
    await this.deps.store.update(record.id, { notesAsked: withNoteRequests(current.notesAsked, asked) });
    const text = notesConflictPrompt(record.mainRoot, conflicts);
    return { ...(await this.authorTarget(record)), text };
  }

  /**
   * El pedido de commitear lo que la rama tiene sin commit, que no deja
   * quitarla (21-10-2026). Va al cuadro de su autor, sin mandar: puede haber
   * algo que el usuario prefiera descartar.
   */
  async commitRequest(id: string): Promise<AuthorRequest> {
    const record = await this.presentRecordOrThrow(id);
    const uncommitted = await uncommittedPaths(record.path);
    if (uncommitted === null) throw new WorktreeError(serverText('worktreeGitFailed', { detail: 'git status' }));
    if (uncommitted.length === 0) throw new WorktreeError(serverText('worktreeNothingToCommit'));
    const text = commitPrompt(uncommitted.slice(0, WORKTREE_PLAN_PATHS_MAX), uncommitted.length);
    const { terminal, opened } = await this.authorTarget(record);
    return { terminal, opened, text, pasted: [] };
  }

  // -------------------------------------------------------------------------
  // Hito 49: ver cambios
  // -------------------------------------------------------------------------

  /** "Ver cambios": los commits y los archivos de la rama contra su base. De sólo lectura. */
  async changes(id: string): Promise<WorktreeChanges> {
    const record = await this.presentRecordOrThrow(id);
    const tips = await branchTips(record.mainRoot);
    const [pair, commits, uncommitted] = await Promise.all([
      this.pairState(record.mainRoot, record.base, record.branch, tips),
      branchCommits(record.mainRoot, record.base, record.branch, WORKTREE_CHANGES_COMMITS_MAX),
      uncommittedPaths(record.path),
    ]);
    if (pair === null || pair.files === null || commits === null) {
      throw new WorktreeError(serverText('worktreeGitFailed', { detail: 'git diff' }));
    }
    return {
      id: record.id,
      branch: record.branch,
      base: record.base,
      commits,
      commitCount: pair.ahead,
      files: pair.files.slice(0, WORKTREE_CHANGES_FILES_MAX),
      fileCount: pair.files.length,
      uncommitted: uncommitted?.length ?? 0,
    };
  }

  /**
   * El diff de un archivo de la rama contra su base. El archivo tiene que ser
   * uno de los que cambió la rama: el cliente no nombra cualquier ruta (§2.4).
   */
  async changesDiff(id: string, file: string): Promise<GitDiff> {
    const record = await this.presentRecordOrThrow(id);
    const tips = await branchTips(record.mainRoot);
    const pair = await this.pairState(record.mainRoot, record.base, record.branch, tips);
    const entry = pair?.files?.find((candidate) => candidate.path === file) ?? null;
    if (entry === null) throw new WorktreeError(serverText('worktreeFileNotInBranch'));
    return branchFileDiff(record.mainRoot, record.base, record.branch, entry.path, entry.oldPath);
  }

  // -------------------------------------------------------------------------
  // Hito 49: la revisión de otro agente
  // -------------------------------------------------------------------------

  /** La pestaña de agente de la rama que no es de revisión: la más nueva. */
  private authorTab(record: WorktreeRecord): TerminalDescriptor | null {
    return (
      this.deps.registry
        .list()
        .filter((tab) => tab.kind === 'agent' && !tab.review && tab.agent !== null && isInside(record.path, tab.cwd))
        .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
    );
  }

  /** La sesión más reciente de la rama que no es de revisión, de cualquier CLI. */
  private authorSession(record: WorktreeRecord): SessionSummary | null {
    const reviews = new Set(record.reviewSessions);
    if (record.review !== null && record.review.sessionId.length > 0) reviews.add(record.review.sessionId);
    for (const tab of this.deps.registry.list()) if (tab.review && tab.sessionId.length > 0) reviews.add(tab.sessionId);
    return (
      (this.deps.sessionsUnder?.(record.path) ?? [])
        .filter((session) => isAgentId(session.agent) && !reviews.has(session.sessionId))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
    );
  }

  /** La CLI que trabajó en la rama: la de su pestaña o la de su última sesión. */
  private authorOf(record: WorktreeRecord): AgentId | null {
    const tab = this.authorTab(record);
    if (tab?.agent) return tab.agent;
    const session = this.authorSession(record);
    return session !== null && isAgentId(session.agent) ? session.agent : null;
  }

  private busy(terminalId: TerminalId): boolean {
    const activity = this.deps.registry.activityOf?.(terminalId) ?? null;
    return activity === 'busy' || activity === 'waiting';
  }

  /**
   * La pestaña que recibe un pedido para el autor de la rama: la que está
   * abierta ahí; si no hay, su sesión más reciente (que no sea de revisión),
   * reanudada; y si tampoco hay, una nueva en la carpeta de la rama.
   */
  private async authorTarget(record: WorktreeRecord): Promise<{ terminal: TerminalDescriptor; opened: boolean }> {
    const open = this.authorTab(record);
    if (open !== null) return { terminal: open, opened: false };
    const session = this.authorSession(record);
    if (session !== null && isAgentId(session.agent) && session.cwd.length > 0 && (await exists(session.cwd))) {
      const terminal = await this.deps.registry.open({ cwd: session.cwd, agent: session.agent, resumeSessionId: session.sessionId });
      return { terminal, opened: true };
    }
    return { terminal: await this.deps.registry.open({ cwd: record.path }), opened: true };
  }

  /** Lo que muestra el diálogo de pedir revisión. No abre nada. */
  async planReview(id: string): Promise<WorktreeReviewPlan> {
    const record = await this.presentRecordOrThrow(id);
    const [counts, uncommitted] = await Promise.all([
      aheadBehind(record.mainRoot, record.base, record.branch),
      uncommittedPaths(record.path),
    ]);
    const tab = this.authorTab(record);
    return {
      id: record.id,
      branch: record.branch,
      base: record.base,
      author: this.authorOf(record),
      prompt: reviewPrompt(record.branch, record.base),
      ahead: counts?.ahead ?? 0,
      uncommitted: uncommitted?.length ?? 0,
      branchBusy: tab !== null && this.busy(tab.terminalId),
    };
  }

  /**
   * Abre la pestaña del revisor en la carpeta de la rama, con esa CLI y en su
   * modo de sólo lectura si lo tiene, y anota la revisión: qué CLI, en qué
   * commits estaban la base y la rama, y su pestaña, que dice su conversación
   * cuando la CLI la descubre. Mandarle el pedido es del socket, como una
   * continuación (§6.18).
   */
  async requestReview(id: string, agent: AgentId): Promise<{ terminal: TerminalDescriptor; prompt: string }> {
    const record = await this.presentRecordOrThrow(id);
    const tips = await branchTips(record.mainRoot);
    const baseCommit = tips.get(record.base);
    const branchCommitNow = tips.get(record.branch);
    if (baseCommit === undefined) throw new WorktreeError(serverText('worktreeBaseMissing', { base: record.base }));
    if (branchCommitNow === undefined) throw new WorktreeError(serverText('worktreeBranchMissing', { branch: record.branch }));
    const [counts, uncommitted] = await Promise.all([
      aheadBehind(record.mainRoot, record.base, record.branch),
      uncommittedPaths(record.path),
    ]);
    if ((counts?.ahead ?? 0) === 0 && (uncommitted?.length ?? 0) === 0) {
      throw new WorktreeError(serverText('worktreeNothingToReview'));
    }

    // Sin etiqueta propia: la marca de revisión y la de la rama ya dicen qué es (§6.38).
    const terminal = await this.deps.registry.open({ cwd: record.path, agent, review: true });
    // Las conversaciones de revisión del registro de ahora: mientras se abría la pestaña pudo anotarse otra.
    const current = this.deps.store.get(record.id) ?? record;
    await this.deps.store.update(record.id, {
      review: {
        agent,
        sessionId: terminal.sessionId,
        terminalId: terminal.terminalId,
        baseCommit,
        branchCommit: branchCommitNow,
        requestedAt: this.now(),
      },
      reviewSessions: withReviewSession(current.reviewSessions, terminal.sessionId),
    });
    this.changed();
    return { terminal, prompt: reviewPrompt(record.branch, record.base) };
  }

  /**
   * La conversación del revisor. Una CLI que pone el id ella misma lo tiene
   * recién con el primer mensaje: se busca en su pestaña y se anota. Lo normal
   * es que ya esté anotada desde que la CLI la descubrió (`noteReviewSession`).
   */
  private async reviewSessionOf(record: WorktreeRecord): Promise<string> {
    const review = record.review;
    if (review === null) return '';
    if (review.sessionId.length > 0) return review.sessionId;
    const tab = this.deps.registry.get(review.terminalId);
    if (tab === null || tab.sessionId.length === 0 || tab.agent !== review.agent) return '';
    await this.noteSession(record.id, tab.terminalId, tab.agent, tab.sessionId);
    return tab.sessionId;
  }

  /**
   * Una pestaña descubrió su conversación (el `session` del registro). Si es
   * de revisión, se anota ya, y no cuando alguien mire Cambios: una pestaña que
   * se cierra antes dejaría la revisión sin respuesta para siempre, y su
   * conversación podría reanudarse como si fuera la del autor.
   */
  async noteReviewSession(terminalId: TerminalId): Promise<void> {
    const tab = this.deps.registry.get(terminalId);
    if (tab === null || !tab.review || tab.sessionId.length === 0) return;
    const record = this.deps.store.list().find((candidate) => candidate.removedAt === null && isInside(candidate.path, tab.cwd)) ?? null;
    if (record === null) return;
    await this.noteSession(record.id, terminalId, tab.agent, tab.sessionId);
    this.reviewActivity();
  }

  /**
   * Anota la conversación de una pestaña de revisión entre las de revisión
   * (nunca se reanudan como la del autor) y, si es la de la revisión de ahora,
   * en la revisión. Con el registro de este momento, no con uno leído antes de
   * un `await`: entre tanto pudo llegar otra revisión, que no se pisa.
   */
  private async noteSession(id: string, terminalId: TerminalId, agent: AgentId | null, sessionId: string): Promise<void> {
    const current = this.deps.store.get(id);
    if (current === null || sessionId.length === 0) return;
    const review = current.review;
    const pending = review !== null && review.terminalId === terminalId && review.agent === agent && review.sessionId.length === 0;
    if (!pending && current.reviewSessions.includes(sessionId)) return;
    await this.deps.store.update(id, {
      ...(pending && review !== null ? { review: { ...review, sessionId } } : {}),
      reviewSessions: withReviewSession(current.reviewSessions, sessionId),
    });
  }

  /** La pestaña del revisor, si sigue abierta: la que lo pidió, o una que reanudó su conversación. */
  private reviewTab(record: WorktreeRecord, sessionId: string): TerminalDescriptor | null {
    const review = record.review;
    if (review === null) return null;
    const tabs = this.deps.registry.list();
    return (
      tabs.find((tab) => tab.terminalId === review.terminalId) ??
      (sessionId.length > 0 ? tabs.find((tab) => tab.agent === review.agent && tab.sessionId === sessionId) : undefined) ??
      null
    );
  }

  /**
   * La última respuesta del revisor, entera, por el seguidor de su CLI. Se
   * recuerda mientras el índice diga que la conversación no cambió; con su
   * pestaña viva se vuelve a leer cada `ROWS_TTL_MS`, porque una CLI que
   * escribe con el archivo abierto no avisa en Windows (§10).
   */
  private readReply(record: WorktreeRecord, sessionId: string, force = false): Promise<string | null> {
    const review = record.review;
    const history = review === null ? null : (this.deps.history?.(review.agent) ?? null);
    if (review === null || history === null || history.wholeRead !== true || sessionId.length === 0) {
      return Promise.resolve(null);
    }
    const summary = this.deps.findSession(review.agent, sessionId);
    const tab = this.reviewTab(record, sessionId);
    const stamp = [
      summary === null ? '?' : `${summary.updatedAt}:${summary.sizeBytes}`,
      summary === null || (tab !== null && tab.alive) ? Math.floor(this.now() / ROWS_TTL_MS) : '',
    ].join('|');
    const key = `${review.agent}\0${sessionId}`;
    const cached = this.replies.get(key);
    if (!force && cached !== undefined && cached.stamp === stamp) return cached.text;
    const target = { cwd: summary !== null && summary.cwd.length > 0 ? summary.cwd : record.path, sessionId };
    const text = (async (): Promise<string | null> => {
      const follower = history.follow(target, { limits: REPLY_LIMITS, maxEvents: REPLY_EVENTS });
      await drainFollower(follower);
      if (follower.getState() !== 'live') return null;
      return lastReplyText(follower.getTail(REPLY_EVENTS).events);
    })().catch(() => null);
    // La más nueva al final: con el tope, se olvida la que hace más que no se lee.
    this.replies.delete(key);
    this.replies.set(key, { stamp, text });
    while (this.replies.size > REPLY_CACHE_MAX) {
      const oldest = this.replies.keys().next().value;
      if (oldest === undefined) break;
      this.replies.delete(oldest);
    }
    return text;
  }

  /**
   * Cómo está la última revisión: trabajando, sin respuesta todavía o
   * contestada, con su veredicto, y si la rama o la base se movieron después.
   */
  private async reviewSummary(record: WorktreeRecord, tips: ReadonlyMap<string, string>): Promise<WorktreeReviewSummary | null> {
    const review = record.review;
    if (review === null) return null;
    const sessionId = await this.reviewSessionOf(record);
    const tab = this.reviewTab(record, sessionId);
    const activity = tab === null ? null : (this.deps.registry.activityOf?.(tab.terminalId) ?? null);
    const reply = await this.readReply(record, sessionId);
    const verdict = reply === null ? null : readVerdict(reply);
    const state =
      activity === 'busy' || activity === 'waiting'
        ? 'working'
        : reply === null ||
            // Una CLI que no dice si trabaja (Codex): sin veredicto y con la pestaña viva, no se sabe si terminó.
            (verdict === 'none' && tab !== null && tab.alive && activity === 'unknown')
          ? 'pending'
          : 'done';
    return {
      agent: review.agent,
      state,
      verdict: state === 'done' ? (verdict ?? 'none') : null,
      stale: tips.get(record.base) !== review.baseCommit || tips.get(record.branch) !== review.branchCommit,
      requestedAt: review.requestedAt,
      terminalId: tab?.terminalId ?? null,
    };
  }

  /**
   * "Mandar a la rama": la respuesta del revisor, como ficha de texto pegado,
   * con el pedido de arreglar lo que comparta, en el cuadro de la pestaña de la
   * rama. Nunca se manda sola (decisión 5): ahí se edita código.
   */
  async sendReview(id: string): Promise<AuthorRequest> {
    const record = await this.presentRecordOrThrow(id);
    if (record.review === null) throw new WorktreeError(serverText('worktreeNoReview'));
    const sessionId = await this.reviewSessionOf(record);
    const reply = sessionId.length === 0 ? null : await this.readReply(this.recordOrThrow(id), sessionId, true);
    if (reply === null || reply.trim().length === 0) throw new WorktreeError(serverText('worktreeReviewUnread'));
    const { terminal, opened } = await this.authorTarget(record);
    return { terminal, opened, text: sendBackPrompt(), pasted: [reply] };
  }

  /**
   * "Ponerse al día": el pedido de traer la base, para el cuadro de la pestaña
   * de la rama. El rebase lo hace su agente (decisión 2).
   */
  async catchUp(id: string): Promise<AuthorRequest> {
    const record = await this.presentRecordOrThrow(id);
    const tips = await branchTips(record.mainRoot);
    const [pair, uncommitted] = await Promise.all([
      this.pairState(record.mainRoot, record.base, record.branch, tips),
      uncommittedPaths(record.path),
    ]);
    if (pair === null || pair.behind === 0) throw new WorktreeError(serverText('worktreeUpToDate', { base: record.base }));
    const conflicts = pair.merge !== null && !pair.merge.clean ? pair.merge.files.slice(0, WORKTREE_ROW_FILES_MAX) : [];
    const text = catchUpPrompt(record.base, conflicts, uncommitted?.length ?? 0);
    const { terminal, opened } = await this.authorTarget(record);
    return { terminal, opened, text, pasted: [] };
  }

  // -------------------------------------------------------------------------
  // Hito 49: integrar
  // -------------------------------------------------------------------------

  private async integratePlanFor(record: WorktreeRecord): Promise<{ plan: WorktreeIntegratePlan; target: string }> {
    const mainRoot = record.mainRoot;
    const [entries, tips] = await Promise.all([listWorktrees(mainRoot), branchTips(mainRoot)]);
    const pair = await this.pairState(mainRoot, record.base, record.branch, tips);
    if (pair === null || pair.files === null) throw new WorktreeError(serverText('worktreeGitFailed', { detail: 'git rev-list' }));
    const files = pair.files;
    const baseEntry = entries.find((entry) => !entry.bare && !entry.prunable && entry.branch === record.base) ?? null;
    // El nombre de la rama, como lo resuelve git donde va a correr: con una etiqueta o un stash del mismo nombre, la ref entera.
    const [baseChanges, branchChanges, target] = await Promise.all([
      baseEntry === null ? Promise.resolve([]) : uncommittedPaths(baseEntry.path),
      (await exists(record.path)) ? uncommittedPaths(record.path) : Promise.resolve([]),
      baseEntry === null ? Promise.resolve(`refs/heads/${record.branch}`) : mergeTarget(baseEntry.path, record.branch),
    ]);
    const localConflicts = pathsTouching(baseChanges ?? [], files);
    // Las notas viajan con los commits sólo a la carpeta principal: es adonde vuelven siempre (21-10-2026).
    const notes: WorktreeNotesPreview | null =
      baseEntry?.isMain === true && (await exists(record.path))
        ? await reviewNotes(mainRoot, record.path, record, this.loadNoteBase)
        : null;
    const blocker =
      pair.ahead === 0
        ? 'nothing'
        : pair.behind > 0
          ? 'behind'
          : baseEntry === null
            ? 'no-base-folder'
            : localConflicts.length > 0
              ? 'local-changes'
              : null;
    const plan: WorktreeIntegratePlan = {
      id: record.id,
      branch: record.branch,
      base: record.base,
      baseFolder: baseEntry?.path ?? null,
      command: blocker === null ? displayCommand(fastForwardArgs(target)) : null,
      branchCommit: tips.get(record.branch) ?? null,
      ahead: pair.ahead,
      behind: pair.behind,
      files: files.map((file) => file.path).slice(0, WORKTREE_PLAN_PATHS_MAX),
      fileCount: files.length,
      review: record.review === null ? null : await this.reviewSummary(record, tips),
      tabs: baseEntry === null ? [] : this.tabsInWorktree(baseEntry.path, entries),
      localConflicts: localConflicts.slice(0, WORKTREE_PLAN_PATHS_MAX),
      branchUncommitted: branchChanges?.length ?? 0,
      blocker,
      notes: notes !== null && (notes.returning.length > 0 || notes.conflicts.length > 0 || notes.resolved.length > 0) ? notes : null,
    };
    return { plan, target };
  }

  /** El plan de integrar la rama en su base. No cambia nada. */
  async planIntegrate(id: string): Promise<WorktreeIntegratePlan> {
    return (await this.integratePlanFor(this.recordOrThrow(id))).plan;
  }

  /**
   * Integra: rehace el plan y, si nada lo impide, corre `git merge --ff-only`
   * en la carpeta de la base, y si esa carpeta es la principal, le pasa las
   * notas de la rama (21-10-2026). Nada más: quitar la rama aparte es otro
   * paso, con su propio diálogo. `branchCommit` es la punta que mostró el
   * plan: si la rama avanzó desde entonces, entraría algo que el usuario no
   * vio, y no se integra nada.
   */
  async integrate(id: string, branchCommit?: string): Promise<WorktreeIntegrateOutcome> {
    const record = this.recordOrThrow(id);
    const { plan, target } = await this.integratePlanFor(record);
    if (branchCommit !== undefined && plan.branchCommit !== branchCommit) {
      throw new WorktreeError(serverText('worktreeBranchMoved', { branch: record.branch }));
    }
    switch (plan.blocker) {
      case 'nothing':
        throw new WorktreeError(serverText('worktreeNothingToIntegrate'));
      case 'behind':
        throw new WorktreeError(serverText('worktreeBaseAdvanced', { base: record.base }));
      case 'no-base-folder':
        throw new WorktreeError(serverText('worktreeBaseNotOpen', { base: record.base }));
      case 'local-changes':
        throw new WorktreeError(serverText('worktreeLocalChanges', { count: plan.localConflicts.length }));
      case null:
        break;
    }
    if (plan.baseFolder === null) throw new WorktreeError(serverText('worktreeBaseNotOpen', { base: record.base }));
    const merged = await fastForward(plan.baseFolder, target);
    if (merged.code !== 0) throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(merged) }));
    const notes = plan.notes === null ? null : await this.syncNotes(record, plan.notes);
    this.changed();
    return { commits: plan.ahead, base: record.base, ...(notes !== null ? { notes } : {}) };
  }

  /**
   * Pasa a la carpeta principal las notas de la rama, después de integrar. Las
   * que no se pueden juntar se quedan en la rama: los commits ya entraron, y al
   * quitarla se pregunta qué hacer con ellas. Las que juntó el agente de la
   * rama no se tocan, pero su versión de la rama pasa a ser el origen: lo que
   * cambie después se junta sobre lo que el agente ya pasó.
   */
  private async syncNotes(record: WorktreeRecord, preview: WorktreeNotesPreview): Promise<{ returned: number; stayed: string[] }> {
    const bases = new Map(record.copied.map((file) => [file.path, file.hash]));
    const result = await returnNotes(record.mainRoot, record.path, preview.returning, bases, {
      loadBase: this.loadNoteBase,
      onConflict: 'skip',
      onWritten: (file, branch) => this.noteReturned(record.id, file, branch),
      notesAsked: record.notesAsked,
    });
    for (const [file, branch] of await notesIn(record.path, preview.resolved)) await this.noteReturned(record.id, file, branch);
    if (result.returned.length > 0 || preview.resolved.length > 0) await this.pruneNoteBases();
    return { returned: result.returned.length, stayed: [...preview.conflicts, ...result.conflicts].sort() };
  }

  /**
   * Una nota que acaba de volver a la principal: la versión de la rama pasa a
   * ser su origen (la huella en el registro y su copia), y la próxima vez se
   * compara contra eso. Así no vuelve dos veces, y lo que la rama cambie
   * después se junta sobre lo que ya viajó.
   */
  private async noteReturned(id: string, file: string, branch: Buffer): Promise<void> {
    await this.noteBases.save(file, branch).catch(() => undefined);
    const current = this.deps.store.get(id);
    if (current === null) return;
    const hash = hashOf(branch);
    const copied = current.copied.some((entry) => entry.path === file)
      ? current.copied.map((entry) => (entry.path === file ? { path: file, hash } : entry))
      : [...current.copied, { path: file, hash }];
    await this.deps.store.update(id, { copied });
  }

  /**
   * Una pestaña de revisión cambió de estado o escribió algo: las filas de
   * Cambios vuelven a preguntar, como mucho una vez por segundo. Sólo las
   * filas (`rows`): la barra y las pestañas no cambian por eso.
   */
  reviewActivity(): void {
    if (this.activityTimer !== null) return;
    this.activityTimer = setTimeout(() => {
      this.activityTimer = null;
      this.forgetRows();
      this.emit('rows');
    }, REVIEW_ACTIVITY_DELAY_MS);
    this.activityTimer.unref?.();
  }

  private changed(): void {
    this.forgetRows();
    this.emit('changed');
  }

  private forgetRows(): void {
    this.rowsGeneration += 1;
    this.rowsCache.clear();
  }
}
