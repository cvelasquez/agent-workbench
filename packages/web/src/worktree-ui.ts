/**
 * Las reglas de las ramas aparte en la web (hito 48, §6.38), sin JSX: cuándo
 * se ve la etiqueta de la rama, qué dice cada fila, qué carpeta y qué comando
 * muestra el diálogo, y qué impide crear o quitar. Desde el hito 49, también
 * lo que dice cada fila de su base, de las otras ramas y de su revisión, cómo
 * arranca cada CLI para revisar y qué impide integrar.
 *
 * Todo es opcional para quien no las usa: sin ninguna rama aparte, ninguna
 * pestaña lleva etiqueta y ninguna fila cambia.
 */

import {
  branchNameProblem,
  normalizeCwdKey,
  projectCwdOf,
  worktreeFolderName,
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type BranchNameProblem,
  type ReadOnlyGuard,
  type TerminalDescriptor,
  type WorktreeCopySummary,
  type WorktreeCreateMode,
  type WorktreeDeleteBranchPlan,
  type WorktreeInspection,
  type WorktreeIntegratePlan,
  type WorktreeKeptBranch,
  type WorktreeRemovePlan,
  type WorktreeReviewSummary,
  type WorktreeRow,
  type WorktreeVerdict,
} from '@agent-workbench/shared';
import { formatBytes, formatList } from './i18n/format.js';
import { t, type MessageKey } from './i18n/index.js';

/**
 * La rama que va en la etiqueta de una pestaña, o null.
 *
 * Una pestaña de una rama aparte la lleva siempre. Una de la carpeta principal,
 * sólo si su proyecto tiene alguna rama aparte abierta: es lo que distingue
 * `main` de `hito-48`. Sin ramas aparte, nada cambia.
 */
export function tabBranch(
  terminal: Pick<TerminalDescriptor, 'terminalId' | 'worktree'>,
  terminals: readonly Pick<TerminalDescriptor, 'terminalId' | 'worktree'>[],
  platform: string,
): string | null {
  const worktree = terminal.worktree;
  if (worktree === null || worktree.branch === null) return null;
  if (worktree.linked) return worktree.branch;
  const key = normalizeCwdKey(worktree.mainCwd, platform);
  const linkedOpen = terminals.some(
    (other) =>
      other.terminalId !== terminal.terminalId &&
      other.worktree?.linked === true &&
      normalizeCwdKey(other.worktree.mainCwd, platform) === key,
  );
  return linkedOpen ? worktree.branch : null;
}

/**
 * La línea del tooltip de una pestaña con etiqueta de rama, o null. Sólo con la
 * etiqueta a la vista: sin ramas aparte, el tooltip es el de siempre.
 */
export function tabBranchTooltip(terminal: Pick<TerminalDescriptor, 'worktree'>, branch: string | null): string | null {
  const worktree = terminal.worktree;
  if (worktree === null || branch === null) return null;
  return worktree.linked
    ? t('worktree.tab.linkedTitle', { branch, main: worktree.mainCwd })
    : t('worktree.tab.mainTitle', { branch });
}

/** La carpeta con la que se pinta una pestaña: la de su proyecto (§6.8). */
export function tabColorCwd(terminal: Pick<TerminalDescriptor, 'kind' | 'cwd' | 'worktree'>): string {
  return projectCwdOf(terminal);
}

const BRANCH_PROBLEM_KEYS: Readonly<Record<BranchNameProblem, MessageKey>> = {
  empty: 'worktree.branch.empty',
  'too-long': 'worktree.branch.tooLong',
  characters: 'worktree.branch.characters',
  'starts-with-dash': 'worktree.branch.startsWithDash',
  slashes: 'worktree.branch.slashes',
  dots: 'worktree.branch.dots',
  lock: 'worktree.branch.lock',
  reserved: 'worktree.branch.reserved',
};

export function branchProblemText(problem: BranchNameProblem): string {
  return t(BRANCH_PROBLEM_KEYS[problem]);
}

/**
 * Qué impide crear con lo que hay en el diálogo, o null si se puede. Con el
 * nombre vacío no dice nada (el botón queda apagado): todavía no hay error.
 */
export function createBlocker(
  inspection: WorktreeInspection,
  branch: string,
  mode: WorktreeCreateMode,
  base: string,
): string | null {
  if (branch.length === 0) return null;
  const problem = branchNameProblem(branch);
  if (problem !== null) return branchProblemText(problem);
  const found = inspection.branches.find((entry) => entry.name === branch);
  if (mode === 'new' && found !== undefined) return t('worktree.create.branchExists');
  if (mode === 'existing' && found?.checkedOut === true) return t('worktree.create.branchInUse');
  if (!inspection.branches.some((entry) => entry.name === base)) return t('worktree.create.baseMissing');
  return null;
}

/** La carpeta que se va a crear, para mostrar. La arma de nuevo el servidor. */
export function folderPreview(inspection: WorktreeInspection, branch: string): string {
  return `${inspection.parentDir}${inspection.separator}${worktreeFolderName(branch)}`;
}

const quoted = (value: string): string => (/[\s"]/.test(value) ? `"${value}"` : value);

/** El comando de git que se va a correr, como lo pide §6.1: que se vea antes. */
export function createCommandPreview(
  inspection: WorktreeInspection,
  branch: string,
  base: string,
  mode: WorktreeCreateMode,
): string {
  const folder = quoted(folderPreview(inspection, branch));
  return mode === 'new'
    ? `git worktree add -b ${branch} ${folder} ${base}`
    : `git worktree add ${folder} ${branch}`;
}

export function copySummaryText(summary: WorktreeCopySummary): string {
  return t('worktree.copy.summary', { count: summary.files, size: formatBytes(summary.bytes) });
}

/** Lo que dice una fila de "Ramas aparte", en partes. */
export function rowStatusParts(row: WorktreeRow): string[] {
  const parts: string[] = [];
  if (row.changes !== null && row.changes > 0) parts.push(t('worktree.rows.changes', { count: row.changes }));
  if (row.ahead !== null && row.ahead > 0) parts.push(t('worktree.rows.ahead', { count: row.ahead }));
  if (row.integrated === true) parts.push(t('worktree.rows.integrated'));
  if (parts.length === 0 && row.changes === 0) parts.push(t('worktree.rows.clean'));
  return parts;
}

/** Las filas en el orden en que se muestran: la principal primero, después por rama. */
export function sortedRows(rows: readonly WorktreeRow[]): WorktreeRow[] {
  return [...rows].sort((a, b) => {
    if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
    return (a.branch ?? a.path).localeCompare(b.branch ?? b.path);
  });
}

/** Unos archivos para una línea, con "…" si había más. */
export function fileListText(files: readonly string[], count: number): string {
  const list = formatList(files.map((file) => file.split('/').pop() ?? file));
  return count > files.length ? `${list}…` : list;
}

/**
 * Hito 49. Lo que una fila dice de su rama contra la base y contra las otras:
 * cuánto avanzó la base, si choca y qué otra rama toca lo mismo. Cada parte en
 * su línea; vacío sin nada que decir.
 */
export function rowTeamLines(row: WorktreeRow): string[] {
  const lines: string[] = [];
  if (row.behind !== null && row.behind > 0 && row.base !== null) {
    const parts = [t('worktree.rows.behind', { base: row.base, count: row.behind })];
    if (row.merge?.state === 'clean') parts.push(t('worktree.rows.mergeClean'));
    if (row.merge?.state === 'conflicts') {
      parts.push(t('worktree.rows.mergeConflicts', { count: row.merge.fileCount, list: fileListText(row.merge.files, row.merge.fileCount) }));
    }
    lines.push(parts.join(' · '));
  }
  for (const overlap of row.overlaps) {
    lines.push(t('worktree.rows.overlap', { branch: overlap.branch, list: fileListText(overlap.files, overlap.fileCount) }));
  }
  return lines;
}

const REVIEW_KEYS: Readonly<Record<'working' | 'pending' | WorktreeVerdict, MessageKey>> = {
  working: 'worktree.review.stateWorking',
  pending: 'worktree.review.statePending',
  ready: 'worktree.review.stateReady',
  changes: 'worktree.review.stateChanges',
  none: 'worktree.review.stateNone',
};

/** "Revisión de Codex: pide cambios (de un commit anterior)". `label` es el nombre de la CLI. */
export function reviewText(review: WorktreeReviewSummary, label: string): string {
  const key = review.state === 'done' ? REVIEW_KEYS[review.verdict ?? 'none'] : REVIEW_KEYS[review.state];
  const text = t(key, { agent: label });
  return review.stale ? t('worktree.review.stale', { text }) : text;
}

/** true si la revisión contestó algo que se le puede pasar a la rama. */
export function reviewHasReply(review: WorktreeReviewSummary | null): boolean {
  return review !== null && review.state === 'done';
}

/** Las acciones del hito 49 que muestra una fila (la de quitar y la de abrir son del 48). */
export interface RowActions {
  viewChanges: boolean;
  review: boolean;
  sendReview: boolean;
  catchUp: boolean;
  integrate: boolean;
}

/**
 * Qué acciones del hito 49 ofrece una fila. Sólo las ramas que creó la app
 * (`id`), y sólo con un servidor que las conoce: el del 48 no manda `behind`, y
 * contestaría "mensaje inválido" sin `requestId`, con el diálogo en "cargando".
 * Integrar se muestra apagado cuando la fila ya sabe por qué no
 * (`rowIntegrateBlocker`).
 */
export function rowActions(row: WorktreeRow): RowActions {
  const team = row.id !== null && !row.isMain && row.behind !== null;
  const ahead = (row.ahead ?? 0) > 0;
  return {
    viewChanges: team && ahead,
    review: team && (ahead || (row.changes ?? 0) > 0),
    sendReview: team && reviewHasReply(row.review),
    catchUp: team && row.base !== null && (row.behind ?? 0) > 0,
    integrate: team && row.base !== null && ahead,
  };
}

/**
 * Por qué "Integrar" queda apagado en una fila, con lo que la fila ya sabe; el
 * resto lo dice el plan. null si se puede pedir el plan.
 */
export function rowIntegrateBlocker(row: WorktreeRow): string | null {
  if (row.base === null) return null;
  if (row.ahead === 0) return t('worktree.integrate.blockerNothing', { base: row.base });
  if (row.behind !== null && row.behind > 0) return t('worktree.integrate.blockerBehind', { base: row.base });
  return null;
}

/** Por qué no se puede integrar todavía, según el plan del servidor, o null. */
export function integrateBlockerText(plan: WorktreeIntegratePlan): string | null {
  switch (plan.blocker) {
    case 'nothing':
      return t('worktree.integrate.blockerNothing', { base: plan.base });
    case 'behind':
      return t('worktree.integrate.blockerBehind', { base: plan.base });
    case 'no-base-folder':
      return t('worktree.integrate.blockerNoBase', { base: plan.base });
    case 'local-changes':
      return t('worktree.integrate.blockerLocal', {
        base: plan.base,
        count: plan.localConflicts.length,
        list: formatList(plan.localConflicts),
      });
    case null:
      return null;
  }
}

/**
 * Cómo arranca una CLI para revisar, para el diálogo: en sólo lectura, sin sus
 * herramientas de editar, o como siempre (y el pedido le dice que no edite).
 */
export function reviewGuardText(capabilities: Pick<AgentCapabilities, 'readOnlyLaunch'>, label: string): string {
  const guard = capabilities.readOnlyLaunch?.guard ?? null;
  if (guard === 'cli') return t('worktree.review.guardCli', { agent: label });
  if (guard === 'tools') return t('worktree.review.guardTools', { agent: label });
  return t('worktree.review.guardNone', { agent: label });
}

/**
 * Las CLIs que se pueden elegir para revisar, en el orden de la lista: las
 * instaladas. Con `defaultReviewer` sale la que viene elegida.
 */
export function reviewCandidates(agents: readonly AgentInfo[]): { id: AgentId; guard: ReadOnlyGuard | null }[] {
  return agents
    .filter((info) => info.available)
    .map((info) => ({ id: info.id, guard: info.capabilities.readOnlyLaunch?.guard ?? null }));
}

/** Lo que dice la fila de una rama guardada de su base, o null si no se pudo leer (20-10-2026). */
export function keptStatusText(kept: WorktreeKeptBranch): string | null {
  if (kept.ahead === null) return null;
  return kept.ahead === 0 ? t('worktree.rows.integrated') : t('worktree.rows.notIntegrated', { count: kept.ahead });
}

/** Por qué no se puede borrar una rama guardada, según el plan del servidor, o null. */
export function deleteBranchBlockerText(plan: WorktreeDeleteBranchPlan): string | null {
  switch (plan.blocker) {
    case 'checked-out':
      return t('worktree.deleteBranch.checkedOut', { branch: plan.branch });
    case 'not-integrated':
      return plan.ahead === null
        ? t('worktree.deleteBranch.noBase', { base: plan.base })
        : t('worktree.deleteBranch.notIntegrated', { count: plan.ahead, base: plan.base });
    case null:
      return null;
  }
}

export type RemoveBlocker = 'uncommitted' | 'in-use' | 'conflicts';

/**
 * Por qué no se puede quitar todavía, o null. Las notas que chocaron no
 * bloquean del todo: el usuario puede elegir "quitar igual".
 */
export function removeBlocker(plan: WorktreeRemovePlan): RemoveBlocker | null {
  if (plan.uncommittedCount > 0) return 'uncommitted';
  if (plan.inUse === true) return 'in-use';
  if (plan.conflicts.length > 0) return 'conflicts';
  return null;
}
