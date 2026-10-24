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
  WORKTREE_UNTRACKED_MAX_FILES,
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
  type WorktreeUntrackedBlock,
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
 * true si el usuario ya eligió perder los archivos nuevos de este plan
 * (23-10-2026): `accepted` es la huella de los que vio, y tiene que ser la
 * misma. Un plan nuevo con otros archivos vuelve a preguntar.
 */
export function filesAccepted(plan: WorktreeRemovePlan, accepted: string | null): boolean {
  return plan.untracked?.stamp != null && accepted !== null && plan.untracked.stamp === accepted;
}

/**
 * Por qué no se puede quitar todavía, o null. Las notas que no se pueden
 * juntar no bloquean del todo: el usuario puede elegir perder lo de la rama.
 * Los archivos nuevos tampoco (23-10-2026): dejan de frenar cuando eligió
 * perderlos.
 */
export function removeBlocker(plan: WorktreeRemovePlan, accepted: string | null = null): RemoveBlocker | null {
  if (plan.uncommittedCount > 0 && !filesAccepted(plan, accepted)) return 'uncommitted';
  if (plan.inUse === true) return 'in-use';
  if (plan.conflicts.length > 0) return 'conflicts';
  return null;
}

/**
 * Lo que hace el botón principal del diálogo de quitar (21-10-2026). Nunca está
 * desactivado: si algo frena, es lo que lo destraba. Antes era "Quitar",
 * apagado, con las salidas como enlaces al costado, y se leía como dos botones
 * de quitar.
 */
export type RemoveAction = 'remove' | 'ask-commit' | 'retry' | 'ask-notes';

export function removeAction(plan: WorktreeRemovePlan, accepted: string | null = null): RemoveAction {
  switch (removeBlocker(plan, accepted)) {
    case 'uncommitted':
      return 'ask-commit';
    case 'in-use':
      return 'retry';
    case 'conflicts':
      return 'ask-notes';
    case null:
      return 'remove';
  }
}

/**
 * true si el diálogo ofrece "Quitar y perder estos archivos" (23-10-2026): todo
 * lo que no está commiteado es nuevo, nada impide perderlo, y todavía no se
 * eligió. Con un archivo versionado que cambió, no: eso es trabajo, y lo
 * commitea el agente.
 */
export function offersDiscardFiles(plan: WorktreeRemovePlan, accepted: string | null): boolean {
  return plan.uncommittedCount > 0 && plan.untracked?.stamp != null && !filesAccepted(plan, accepted);
}

const UNTRACKED_BLOCK_KEYS: Readonly<Record<WorktreeUntrackedBlock, MessageKey>> = {
  'nested-repo': 'worktree.remove.untrackedNestedRepo',
  'too-many': 'worktree.remove.untrackedTooMany',
  copied: 'worktree.remove.untrackedCopied',
};

/**
 * Lo que dice el diálogo de los archivos nuevos, antes de su lista: cuántos
 * archivos tienen y cuánto pesan (una carpeta nueva no es "1 archivo"), que se
 * pierden, si ya se eligió, o por qué no se pueden perder desde acá. null si no
 * todo lo que falta commitear es nuevo.
 */
export function untrackedText(plan: WorktreeRemovePlan, accepted: string | null): string | null {
  const untracked = plan.untracked;
  if (plan.uncommittedCount === 0 || untracked === null) return null;
  if (untracked.blocked !== null) return t(UNTRACKED_BLOCK_KEYS[untracked.blocked], { max: WORKTREE_UNTRACKED_MAX_FILES });
  if (filesAccepted(plan, accepted)) return t('worktree.remove.untrackedAccepted');
  return t('worktree.remove.untracked', { count: untracked.files, size: formatBytes(untracked.bytes) });
}

/**
 * Lo que dice el diálogo de otro programa con la carpeta abierta: cuál, si el
 * servidor lo supo (23-10-2026), con su ejecutable y sus procesos, y si no, la
 * frase de antes. Los procesos de un mismo programa van juntos.
 */
export function inUseText(plan: WorktreeRemovePlan): string {
  if (plan.holders.length === 0) return t('worktree.remove.inUse');
  const programs: { exe: string; program: string | null; pids: number[] }[] = [];
  for (const holder of plan.holders) {
    // Una descripción que sólo repite el ejecutable no dice nada más.
    const plain = holder.name.toLowerCase().replace(/\.exe$/, '');
    const program = holder.description !== null && holder.description.toLowerCase() !== plain ? holder.description : null;
    const same = programs.find((entry) => entry.exe.toLowerCase() === holder.name.toLowerCase() && entry.program === program);
    if (same !== undefined) same.pids.push(holder.pid);
    else programs.push({ exe: holder.name, program, pids: [holder.pid] });
  }
  const list = formatList(
    programs.map(({ exe, program, pids }) => {
      const values = { exe, pids: formatList(pids.map(String)) };
      return program === null ? t('worktree.remove.holderExe', values) : t('worktree.remove.holder', { ...values, program });
    }),
  );
  return t('worktree.remove.inUseBy', { count: programs.length, list });
}

/** Las rutas sin commit para una línea, con "…" si había más. */
export function uncommittedListText(plan: WorktreeRemovePlan): string {
  return `${formatList(plan.uncommitted)}${plan.uncommittedCount > plan.uncommitted.length ? '…' : ''}`;
}

/** Qué pasa con la carpeta y con la rama al quitarla, en una línea. */
export function removeFateText(plan: WorktreeRemovePlan): string {
  const { branch } = plan;
  if (plan.deletesBranch) {
    return plan.branchUnused ? t('worktree.remove.deletesUnusedBranch', { branch }) : t('worktree.remove.deletesBranch', { branch });
  }
  return plan.createdBranch ? t('worktree.remove.keepsBranch', { branch }) : t('worktree.remove.keepsExistingBranch', { branch });
}
