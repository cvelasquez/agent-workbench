/**
 * Las ramas aparte de punta a punta (hito 48, §6.38): mirar antes de crear,
 * crear, el estado de cada una, el plan de quitar, quitar y volver a abrir.
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
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  ServerTextError,
  WORKTREE_PLAN_PATHS_MAX,
  branchNameProblem,
  serverText,
  type AgentId,
  type SessionSummary,
  type TerminalDescriptor,
  type TerminalId,
  type WorktreeCreateMode,
  type WorktreeInspection,
  type WorktreeRemoveOutcome,
  type WorktreeRemovePlan,
  type WorktreeRow,
  type WorktreeSource,
} from '@agent-workbench/shared';
import type { OpenTerminalOptions } from '../terminal-registry.js';
import { samePathShape } from './checkout.js';
import {
  addWorktree,
  aheadCount,
  branchCommit,
  currentBranch,
  deleteBranch,
  deleteBranchArgs,
  gitFailureText,
  isIntegrated,
  listWorktrees,
  localBranches,
  refFormatAccepts,
  removeWorktree,
  removeWorktreeArgs,
  repoLayout,
  uncommittedPaths,
} from './git.js';
import { copyToWorktree, planCopy, returnNotes, reviewNotes, summarize, type CopyPlan } from './include.js';
import { worktreeFolderFor, worktreesParentFor } from './names.js';
import type { WorktreeRecord, WorktreeStore } from './store.js';

/** Un pedido de ramas aparte que no se pudo cumplir. El texto dice por qué (§6.23). */
export class WorktreeError extends ServerTextError {}

/** Cuánto se reusa el estado de las filas de Cambios: son procesos de git por rama. */
const ROWS_TTL_MS = 5_000;
/** Cuánto se espera a que Windows suelte una carpeta después de cerrar sus pestañas. */
const RELEASE_TIMEOUT_MS = 5_000;
const RELEASE_POLL_MS = 100;

export interface WorktreeServiceDeps {
  store: WorktreeStore;
  registry: {
    open(options: OpenTerminalOptions): Promise<TerminalDescriptor>;
    list(): TerminalDescriptor[];
    get(terminalId: TerminalId): TerminalDescriptor | null;
  };
  /** La carpeta de un proyecto de la barra, por su `key`; null si la barra no lo tiene. */
  projectCwd(projectKey: string): string | null;
  /** Una sesión de la barra, para volver a abrir su rama. */
  findSession(agent: AgentId, sessionId: string): SessionSummary | null;
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

export declare interface WorktreeService {
  on(event: 'changed', listener: () => void): this;
  emit(event: 'changed'): boolean;
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

export class WorktreeService extends EventEmitter {
  private readonly rowsCache = new Map<string, { at: number; rows: Omit<WorktreeRow, 'isCurrent'>[] }>();
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

    const cacheKey = path.resolve(mainRoot).toLowerCase();
    const cached = this.rowsCache.get(cacheKey);
    const rows =
      cached !== undefined && this.now() - cached.at < ROWS_TTL_MS ? cached.rows : await this.readRows(mainRoot);
    if (cached === undefined || cached.rows !== rows) this.rowsCache.set(cacheKey, { at: this.now(), rows });
    return rows.map((row) => ({ ...row, isCurrent: samePathShape(row.path, layout.toplevel) }));
  }

  private async readRows(mainRoot: string): Promise<Omit<WorktreeRow, 'isCurrent'>[]> {
    const entries = (await listWorktrees(mainRoot)).filter((entry) => !entry.bare);
    const mainBranch = entries.find((entry) => entry.isMain)?.branch ?? null;
    return Promise.all(
      entries.map(async (entry) => {
        const record = this.liveRecord(entry.path);
        const base = record?.base ?? mainBranch;
        const comparable = entry.branch !== null && base !== null && entry.branch !== base && !entry.isMain;
        const [changes, ahead, integrated] = await Promise.all([
          entry.prunable ? Promise.resolve(null) : uncommittedPaths(entry.path),
          comparable ? aheadCount(mainRoot, base, entry.branch ?? '') : Promise.resolve(null),
          comparable ? isIntegrated(mainRoot, entry.branch ?? '', base) : Promise.resolve(null),
        ]);
        return {
          id: record?.id ?? null,
          path: entry.path,
          branch: entry.branch,
          base,
          isMain: entry.isMain,
          changes: changes === null ? null : changes.length,
          ahead,
          integrated,
        };
      }),
    );
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

  /** Las pestañas y consolas abiertas dentro de la carpeta de la rama. */
  private tabsIn(folder: string): WorktreeRemovePlan['tabs'] {
    return this.deps.registry
      .list()
      .filter((tab) => isInside(folder, tab.cwd))
      // Una pestaña sin nombre propio se reconoce por su carpeta.
      .map((tab) => ({ terminalId: tab.terminalId, kind: tab.kind, label: tab.label || path.basename(tab.cwd) }));
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
   * qué pestaña va: una abierta en la rama o, si no hay, una nueva ahí. El
   * texto queda en su cuadro, sin mandar.
   */
  async notesRequest(id: string): Promise<{ terminal: TerminalDescriptor; opened: boolean; text: string }> {
    const record = this.recordOrThrow(id);
    const { conflicts } = await reviewNotes(record.mainRoot, record.path, record);
    if (conflicts.length === 0) throw new WorktreeError(serverText('worktreeNoConflicts'));
    const text = notesConflictPrompt(record.mainRoot, conflicts);
    const open = this.deps.registry
      .list()
      .find((tab) => tab.kind === 'agent' && isInside(record.path, tab.cwd));
    if (open !== undefined) return { terminal: open, opened: false, text };
    return { terminal: await this.deps.registry.open({ cwd: record.path }), opened: true, text };
  }

  private changed(): void {
    this.rowsCache.clear();
    this.emit('changed');
  }
}
