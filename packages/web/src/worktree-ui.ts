/**
 * Las reglas de las ramas aparte en la web (hito 48, §6.38), sin JSX: cuándo
 * se ve la etiqueta de la rama, qué dice cada fila, qué carpeta y qué comando
 * muestra el diálogo, y qué impide crear o quitar.
 *
 * Todo es opcional para quien no las usa: sin ninguna rama aparte, ninguna
 * pestaña lleva etiqueta y ninguna fila cambia.
 */

import {
  branchNameProblem,
  normalizeCwdKey,
  projectCwdOf,
  worktreeFolderName,
  type BranchNameProblem,
  type TerminalDescriptor,
  type WorktreeCopySummary,
  type WorktreeCreateMode,
  type WorktreeInspection,
  type WorktreeRemovePlan,
  type WorktreeRow,
} from '@agent-workbench/shared';
import { formatBytes } from './i18n/format.js';
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
