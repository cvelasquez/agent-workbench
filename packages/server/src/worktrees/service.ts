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
 *     `--force` no se usa;
 *  2. notas que cambiaron en los dos lados: no se quita, salvo "quitar igual";
 *  3. otro programa con la carpeta abierta: no se quita (Windows dejaría a git
 *     a medias, medido);
 *  4. se cierran las pestañas y consolas de ahí, y se espera a que Windows
 *     suelte la carpeta (unos 50 ms, medido en el paso 0);
 *  5. las notas que cambiaron en la rama vuelven a la principal;
 *  6. `git worktree remove`; lo que quede (los enlaces de pnpm, que git no
 *     borra) se borra sin seguir enlaces y sólo dentro de esa carpeta;
 *  7. la rama, con `branch -d`, sólo si la creó la app y ya está integrada.
 *
 * Integrar (hito 49) es un solo comando, `git merge --ff-only`, en la carpeta
 * donde está sacada la base, y sólo cuando no hace falta crear un commit. El
 * rebase de ponerse al día lo hace el agente de la rama en su terminal, nunca
 * la app: reescribe commits (§6.1).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
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
  type WorktreeInspection,
  type WorktreeIntegrateOutcome,
  type WorktreeIntegratePlan,
  type WorktreeMerge,
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
  currentBranch,
  deleteBranch,
  deleteBranchArgs,
  fastForward,
  fastForwardArgs,
  gitFailureText,
  isIntegrated,
  listWorktrees,
  localBranches,
  mergeTarget,
  mergeTreeCheck,
  refFormatAccepts,
  removeWorktree,
  removeWorktreeArgs,
  repoLayout,
  uncommittedPaths,
  type WorktreeEntry,
} from './git.js';
import { copyToWorktree, planCopy, returnNotes, reviewNotes, summarize, type CopyPlan } from './include.js';
import { worktreeFolderFor, worktreesParentFor } from './names.js';
import { overlapsFor, pathsTouching, type BranchFiles } from './overlap.js';
import { catchUpPrompt, lastReplyText, readVerdict, reviewPrompt, sendBackPrompt } from './review.js';
import { withReviewSession, type WorktreeRecord, type WorktreeStore } from './store.js';

/** Un pedido de ramas aparte que no se pudo cumplir. El texto dice por qué (§6.23). */
export class WorktreeError extends ServerTextError {}

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

export class WorktreeService extends EventEmitter {
  private readonly rowsCache = new Map<string, { at: number; tips: string; rows: Omit<WorktreeRow, 'isCurrent'>[] }>();
  /** Sube cada vez que se borra lo guardado (`forgetRows`). */
  private rowsGeneration = 0;
  private readonly pairs = new Map<string, Promise<PairState | null>>();
  private readonly replies = new Map<string, { stamp: string; text: Promise<string | null> }>();
  private activityTimer: NodeJS.Timeout | null = null;
  private readonly now: () => number;

  constructor(private readonly deps: WorktreeServiceDeps) {
    super();
    this.now = deps.now ?? Date.now;
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
      copyNotes: request.copyNotes,
      copied,
      copiedDirs,
      createdAt: this.now(),
      removedAt: null,
      review: null,
      reviewSessions: [],
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
    const copied = await copyToWorktree(mainRoot, folder, parts.flatMap((part) => part?.files ?? []));
    return { copied, copiedDirs: [...new Set(parts.flatMap((part) => part?.dirs ?? []))] };
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
    const entries = (await listWorktrees(mainRoot)).filter((entry) => !entry.bare);
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
        integrated: pair === null ? null : pair.ahead === 0,
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

  private async planFor(record: WorktreeRecord): Promise<WorktreeRemovePlan> {
    const present = await exists(record.path);
    const [uncommitted, notes, integrated] = await Promise.all([
      present ? uncommittedPaths(record.path) : Promise.resolve([]),
      present ? reviewNotes(record.mainRoot, record.path, record) : Promise.resolve({ returning: [], conflicts: [] }),
      record.createdBranch ? isIntegrated(record.mainRoot, record.branch, record.base) : Promise.resolve(false),
    ]);
    if (uncommitted === null) throw new WorktreeError(serverText('worktreeGitFailed', { detail: 'git status' }));
    const tabs = this.tabsIn(record.path);
    const deletesBranch = integrated === true;
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
      tabs,
      returning: notes.returning,
      conflicts: notes.conflicts,
      // Con pestañas de la app adentro, la prueba daría "en uso" por ellas mismas: se mira al confirmar.
      inUse: !present ? false : tabs.length > 0 ? null : await folderInUse(record.path),
      deletesBranch,
    };
  }

  /** El plan de quitar una rama aparte. No cambia nada. */
  planRemove(id: string): Promise<WorktreeRemovePlan> {
    return this.planFor(this.recordOrThrow(id));
  }

  /**
   * Quita la rama aparte. Rehace el plan y se detiene en el primer "no" (ver
   * el principio del archivo). `closeTab` cierra una pestaña como lo hace el
   * socket, soltando todo lo que la seguía.
   */
  async remove(id: string, discardConflicts: boolean, closeTab: (terminalId: TerminalId) => void): Promise<WorktreeRemoveOutcome> {
    const record = this.recordOrThrow(id);
    const plan = await this.planFor(record);
    if (plan.uncommittedCount > 0) {
      throw new WorktreeError(serverText('worktreeUncommitted', { count: plan.uncommittedCount }));
    }
    if (plan.conflicts.length > 0 && !discardConflicts) {
      throw new WorktreeError(serverText('worktreeNotesConflict', { count: plan.conflicts.length }));
    }
    if (plan.inUse === true) throw new WorktreeError(serverText('worktreeInUse'));

    let returned = 0;
    if (await exists(record.path)) {
      for (const tab of plan.tabs) closeTab(tab.terminalId);
      if (!(await this.waitUntilFree(record.path))) throw new WorktreeError(serverText('worktreeInUse'));

      const bases = new Map(record.copied.map((file) => [file.path, file.hash]));
      try {
        returned = (await returnNotes(record.mainRoot, record.path, plan.returning, bases)).returned.length;
      } catch (error) {
        throw new WorktreeError(serverText('worktreeNotesFailed', { detail: error instanceof Error ? error.message : String(error) }));
      }

      const removed = await removeWorktree(record.mainRoot, record.path);
      if (removed.code !== 0) throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(removed) }));
      await this.removeLeftovers(record);
    }

    const branchDeleted = plan.deletesBranch && (await deleteBranch(record.mainRoot, record.branch)).code === 0;
    await this.deps.store.update(id, { removedAt: this.now() });
    this.changed();
    return { branchDeleted, returned, discarded: discardConflicts ? plan.conflicts.length : 0 };
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

  /** La carpeta `<proyecto>.worktrees`, sólo si quedó vacía. */
  private async removeEmptyParent(folder: string): Promise<void> {
    await rmdir(path.dirname(folder)).catch(() => undefined);
  }

  /**
   * Vuelve a abrir la rama de una sesión cuya carpeta se quitó: la saca otra
   * vez en la misma carpeta, copia de nuevo lo ignorado y reanuda la sesión.
   */
  async reopen(agent: AgentId, sessionId: string): Promise<TerminalDescriptor> {
    const session = this.deps.findSession(agent, sessionId);
    if (session === null || session.cwd.length === 0) throw new WorktreeError(serverText('worktreeUnknown'));
    const record = this.removedRecordAbove(session.cwd);
    if (record === null || (await exists(record.path)) || !(await exists(record.mainRoot))) {
      throw new WorktreeError(serverText('worktreeUnknown'));
    }
    if ((await branchCommit(record.mainRoot, record.branch)) === null) {
      throw new WorktreeError(serverText('worktreeBranchMissing', { branch: record.branch }));
    }
    if ((await listWorktrees(record.mainRoot)).some((entry) => entry.branch === record.branch)) {
      throw new WorktreeError(serverText('worktreeBranchInUse', { branch: record.branch }));
    }

    const copy = await planCopy(record.mainRoot);
    await mkdir(path.dirname(record.path), { recursive: true });
    const added = await addWorktree(record.mainRoot, record.path, record.branch, null);
    if (added.code !== 0) throw new WorktreeError(serverText('worktreeGitFailed', { detail: gitFailureText(added) }));
    const { copied, copiedDirs } = await this.copyInto(record.mainRoot, record.path, copy, record.copyNotes);
    await this.deps.store.update(record.id, { copied, copiedDirs, removedAt: null });
    this.changed();
    return this.deps.registry.open({ cwd: session.cwd, agent, resumeSessionId: sessionId });
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
   */
  async notesRequest(id: string): Promise<{ terminal: TerminalDescriptor; opened: boolean; text: string }> {
    const record = this.recordOrThrow(id);
    const { conflicts } = await reviewNotes(record.mainRoot, record.path, record);
    if (conflicts.length === 0) throw new WorktreeError(serverText('worktreeNoConflicts'));
    const text = notesConflictPrompt(record.mainRoot, conflicts);
    return { ...(await this.authorTarget(record)), text };
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
    };
    return { plan, target };
  }

  /** El plan de integrar la rama en su base. No cambia nada. */
  async planIntegrate(id: string): Promise<WorktreeIntegratePlan> {
    return (await this.integratePlanFor(this.recordOrThrow(id))).plan;
  }

  /**
   * Integra: rehace el plan y, si nada lo impide, corre `git merge --ff-only`
   * en la carpeta de la base. Nada más: quitar la rama aparte es otro paso, con
   * su propio diálogo. `branchCommit` es la punta que mostró el plan: si la
   * rama avanzó desde entonces, entraría algo que el usuario no vio, y no se
   * integra nada.
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
    this.changed();
    return { commits: plan.ahead, base: record.base };
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
