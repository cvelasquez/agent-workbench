/**
 * Las ramas aparte (hito 48, §6.38): una rama de git sacada en su propia
 * carpeta con `git worktree`, para que dos pestañas del mismo proyecto no se
 * pisen. Desde el hito 49, además, lo que hace falta para trabajar como un
 * equipo: el estado de cada rama contra su base, lo que trae, la revisión de
 * otro agente y el plan de integrar.
 *
 * Acá vive lo que necesitan los dos lados sin tocar el disco: las reglas del
 * nombre de la rama, la carpeta que le toca y la forma de lo que viaja. La web
 * valida mientras se escribe con las mismas reglas que el servidor hace
 * cumplir, y el servidor además le pregunta a git (`check-ref-format`).
 *
 * **Ningún pedido lleva una ruta** (§2.4): una rama aparte nueva sale de un
 * proyecto (su `key`) o de una pestaña, y una que ya existe se nombra por el id
 * del registro de la app. Las rutas que viajan del servidor a la web son para
 * mostrar.
 */

import { AGENT_IDS, type AgentId, type ReadOnlyGuard } from './agents.js';
import { GIT_CHANGE_KINDS, type GitChangeKind } from './git.js';
// Sólo tipos: `models.ts` importa los parsers de acá, y un import de valores en
// las dos direcciones es un ciclo.
import type { TerminalId, TerminalKind } from './models.js';
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

// ---------------------------------------------------------------------------
// El nombre de la rama y su carpeta
// ---------------------------------------------------------------------------

/** Tope del nombre: entra en una pestaña y en una ruta de Windows sin problemas. */
export const BRANCH_NAME_MAX_CHARS = 100;

/**
 * Letras sin tilde, números, `-`, `_`, `.` y `/`. Más estricto que git a
 * propósito: el nombre termina siendo una carpeta, y una tilde o un espacio en
 * una ruta es justo lo que rompe una línea de `cmd /c` (§3.1).
 */
const BRANCH_CHARACTERS = /^[A-Za-z0-9._/-]+$/;

/** Nombres que Windows no deja usar como carpeta, con o sin extensión. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

export type BranchNameProblem =
  | 'empty'
  | 'too-long'
  | 'characters'
  | 'starts-with-dash'
  | 'slashes'
  | 'dots'
  | 'lock'
  | 'reserved';

export const BRANCH_NAME_PROBLEMS: readonly BranchNameProblem[] = [
  'empty',
  'too-long',
  'characters',
  'starts-with-dash',
  'slashes',
  'dots',
  'lock',
  'reserved',
];

/**
 * Qué tiene de malo un nombre de rama, o null si sirve.
 *
 * Son las reglas de `git check-ref-format --branch` que el juego de caracteres
 * de arriba deja pasar (sin `..`, sin partes que empiecen con `.` o terminen en
 * `.lock`, sin `/` al principio, al final ni dos seguidas, sin `-` al
 * principio), más las de la carpeta: los nombres reservados de Windows.
 */
export function branchNameProblem(name: string): BranchNameProblem | null {
  if (name.length === 0) return 'empty';
  if (name.length > BRANCH_NAME_MAX_CHARS) return 'too-long';
  if (!BRANCH_CHARACTERS.test(name)) return 'characters';
  if (name.startsWith('-')) return 'starts-with-dash';
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) return 'slashes';
  const parts = name.split('/');
  if (name.includes('..') || name.endsWith('.') || parts.some((part) => part.startsWith('.'))) return 'dots';
  if (parts.some((part) => part.endsWith('.lock'))) return 'lock';
  if (name === 'HEAD') return 'reserved';
  const stem = worktreeFolderName(name).split('.')[0] ?? '';
  if (WINDOWS_RESERVED.test(stem)) return 'reserved';
  return null;
}

/** La carpeta de una rama: la `/` pasa a `-`, porque una carpeta anidada por rama no la busca nadie. */
export function worktreeFolderName(branch: string): string {
  return branch.split('/').join('-');
}

/** La carpeta que junta las ramas aparte de un proyecto, al lado de él: `<proyecto>.worktrees`. */
export function worktreesDirName(projectFolderName: string): string {
  return `${projectFolderName}.worktrees`;
}

// ---------------------------------------------------------------------------
// Lo que viaja
// ---------------------------------------------------------------------------

/**
 * La rama de la carpeta de una pestaña, en su descriptor.
 *
 * Sólo en un repositorio de git. `mainCwd` es la carpeta principal: con ella
 * la pestaña de una rama aparte toma el color y el lugar de su proyecto
 * (§6.8), en vez de parecer un proyecto aparte.
 */
export interface TabWorktree {
  /** La carpeta principal del repo, con la misma subcarpeta que la pestaña. */
  mainCwd: string;
  /** La rama de la carpeta de la pestaña; null con HEAD desprendido. */
  branch: string | null;
  /** true en una rama aparte; false en la carpeta principal. */
  linked: boolean;
}

/** Una sesión de la barra que trabajó en una rama aparte. */
export interface SessionWorktree {
  /** La rama; si no se sabe, el nombre de su carpeta. */
  branch: string;
  /** false si la carpeta ya no está: la rama se quitó. */
  exists: boolean;
  /** true si la app la puede volver a abrir: la creó ella y la rama sigue. */
  reopenable: boolean;
}

/** De dónde sale una rama aparte nueva: un proyecto de la barra, o una pestaña. */
export type WorktreeSource =
  | { kind: 'project'; projectKey: string }
  | { kind: 'terminal'; terminalId: TerminalId };

/** Lo ignorado que se copiaría a la carpeta nueva. */
export interface WorktreeCopySummary {
  files: number;
  bytes: number;
  /** true si pasa el tope (`WORKTREE_COPY_MAX_FILES`, `WORKTREE_COPY_MAX_BYTES`): no se copia. */
  overCap: boolean;
  /** Algunas de las rutas, relativas y con `/`, para el diálogo. */
  sample: string[];
}

/** Topes de la copia de lo ignorado: un `node_modules` por un error en el archivo no entra. */
export const WORKTREE_COPY_MAX_FILES = 2_000;
export const WORKTREE_COPY_MAX_BYTES = 50 * 1024 * 1024;
/** Cuántas rutas de ejemplo viajan. */
export const WORKTREE_COPY_SAMPLE = 8;

/** Lo que el diálogo de crear muestra antes de crear nada. */
export interface WorktreeInspection {
  /** La carpeta principal del repo, para mostrar. */
  mainRoot: string;
  /** Donde van las carpetas de las ramas: `<principal>.worktrees`, para mostrar. */
  parentDir: string;
  /** El separador de rutas del servidor, para armar la carpeta que se muestra. */
  separator: string;
  /** La rama de la carpeta principal; null con HEAD desprendido. */
  currentBranch: string | null;
  /** Las ramas locales; `checkedOut` si ya están abiertas en alguna carpeta. */
  branches: Array<{ name: string; checkedOut: boolean }>;
  /** Archivos con cambios sin commit en la carpeta principal: la rama nueva no se los lleva. */
  mainChanges: number;
  /** Lo que pide el `.worktreeinclude` de la carpeta principal; null si no tiene. */
  include: WorktreeCopySummary | null;
  /** Las instrucciones y la memoria que el repo ignora (`CLAUDE.md`, `AGENTS.md`, …). */
  notes: WorktreeCopySummary;
}

export type WorktreeCreateMode = 'new' | 'existing';
export const WORKTREE_CREATE_MODES: readonly WorktreeCreateMode[] = ['new', 'existing'];

/** Una fila de "Ramas aparte" en Cambios. */
export interface WorktreeRow {
  /** El id del registro de la app; null si la creó otra herramienta: no se ofrece quitarla. */
  id: string | null;
  /** La carpeta, para mostrar y para abrir una pestaña ahí (`terminal.open`). */
  path: string;
  branch: string | null;
  /** La rama de la que salió, o la de la carpeta principal si no se sabe. */
  base: string | null;
  /** true en la carpeta de la pestaña que pregunta. */
  isCurrent: boolean;
  /** true en la carpeta principal. */
  isMain: boolean;
  /** Archivos con cambios sin commit; null si no se pudo leer. */
  changes: number | null;
  /** Commits que la base no tiene; null si no se pudo leer. */
  ahead: number | null;
  /**
   * true si la base ya tiene todos sus commits; null si no se pudo leer. Desde
   * el 20-10-2026, false en una rama que creó la app y todavía no tiene commits
   * propios: no trajo nada (para git sí está integrada, y quitarla la borra).
   */
  integrated: boolean | null;
  /** Hito 49. Commits que la base ganó desde que salió la rama ("main avanzó 2"); null si no se compara. */
  behind: number | null;
  /**
   * Hito 49. Si la rama se integra limpio con la base, según `git merge-tree`;
   * null si no se miró: la base no avanzó (no hay nada que chocar) o git no pudo.
   */
  merge: WorktreeMerge | null;
  /** Hito 49. Otras ramas aparte que tocan los mismos archivos: el aviso antes de integrar. */
  overlaps: WorktreeOverlap[];
  /** Hito 49. La última revisión pedida para esta rama, o null. Sólo en las que creó la app. */
  review: WorktreeReviewSummary | null;
}

/** Una pestaña o consola abierta en la carpeta que se va a quitar. */
export interface WorktreeOpenTab {
  terminalId: TerminalId;
  kind: TerminalKind;
  label: string;
}

/** El plan de quitar una rama aparte: se muestra, se confirma y el servidor lo rehace. */
export interface WorktreeRemovePlan {
  id: string;
  branch: string;
  path: string;
  /** Los comandos de git que se van a correr, para mostrar. */
  commands: string[];
  /** Archivos sin commit (con tope). Con alguno no se quita: nunca `--force`. */
  uncommitted: string[];
  uncommittedCount: number;
  /** Lo que se cierra al confirmar. */
  tabs: WorktreeOpenTab[];
  /** Notas ignoradas que cambiaron en la rama y vuelven a la carpeta principal, tal cual o juntas. */
  returning: string[];
  /**
   * De `returning`, las que cambiaron también en la principal y se juntan
   * (21-10-2026). Un servidor anterior no lo manda: ninguna.
   */
  merging: string[];
  /** Notas que cambiaron en los dos lados y no se pueden juntar: con alguna no se quita, salvo perderlas. */
  conflicts: string[];
  /** true si otro programa tiene la carpeta abierta; null si no se pudo saber (hay pestañas de la app adentro). */
  inUse: boolean | null;
  /** true si la rama ya está integrada en su base: también se borra, con `branch -d`. */
  deletesBranch: boolean;
  /**
   * true si se borra porque no tiene commits propios (sigue en el commit del que
   * salió), y no porque lo suyo ya esté en la base: el diálogo no la llama
   * integrada. Del 20-10-2026; un servidor anterior no lo manda: false.
   */
  branchUnused: boolean;
  /**
   * false si la rama ya existía y la app sólo la sacó en una carpeta: esa rama
   * no se borra nunca. Del 21-10-2026; un servidor anterior no lo manda: true.
   */
  createdBranch: boolean;
}

/**
 * Las notas que viajan a la carpeta principal al integrar (21-10-2026): las
 * que vuelven (tal cual o juntas) y las que se quedan en la rama porque
 * cambiaron en los dos lados y no se pueden juntar.
 */
export interface WorktreeNotesPreview {
  returning: string[];
  merging: string[];
  conflicts: string[];
}

export interface WorktreeRemoveOutcome {
  branchDeleted: boolean;
  /** Notas que volvieron a la carpeta principal. */
  returned: number;
  /** Notas que se perdieron con "quitar igual". */
  discarded: number;
}

/** Cuántas rutas sin commit viajan en el plan. */
export const WORKTREE_PLAN_PATHS_MAX = 20;

// ---------------------------------------------------------------------------
// Hito 49: revisar, ponerse al día e integrar
// ---------------------------------------------------------------------------

/** Cuántos archivos nombra una fila (choque, otra rama que toca lo mismo). */
export const WORKTREE_ROW_FILES_MAX = 8;
/** Cuántos commits y archivos trae "Ver cambios". */
export const WORKTREE_CHANGES_COMMITS_MAX = 50;
export const WORKTREE_CHANGES_FILES_MAX = 2_000;

export type WorktreeMergeState = 'clean' | 'conflicts';
export const WORKTREE_MERGE_STATES: readonly WorktreeMergeState[] = ['clean', 'conflicts'];

/** Lo que dice `git merge-tree` de la rama contra su base, sin tocar el repo. */
export interface WorktreeMerge {
  state: WorktreeMergeState;
  /** Los archivos que chocarían, con tope (`WORKTREE_ROW_FILES_MAX`). */
  files: string[];
  fileCount: number;
}

/** Otra rama aparte del repo que toca algunos de los mismos archivos. */
export interface WorktreeOverlap {
  branch: string;
  files: string[];
  fileCount: number;
}

/**
 * Lo que contestó el revisor, leyendo la última línea de su última respuesta:
 * `ready` ("Verdict: ready to integrate"), `changes` ("Verdict: needs
 * changes") o `none`, si esa línea no es ninguna de las dos.
 */
export type WorktreeVerdict = 'ready' | 'changes' | 'none';
export const WORKTREE_VERDICTS: readonly WorktreeVerdict[] = ['ready', 'changes', 'none'];

/**
 * En qué está la revisión: `working`, su pestaña está trabajando; `pending`,
 * todavía no contestó nada; `done`, contestó (con o sin veredicto).
 */
export type WorktreeReviewState = 'working' | 'pending' | 'done';
export const WORKTREE_REVIEW_STATES: readonly WorktreeReviewState[] = ['working', 'pending', 'done'];

/** La última revisión de una rama, como la muestra su fila. El texto vive en el historial de esa CLI. */
export interface WorktreeReviewSummary {
  agent: AgentId;
  state: WorktreeReviewState;
  /** Solo con `done`. */
  verdict: WorktreeVerdict | null;
  /** true si la rama o la base avanzaron después del pedido: es "de un commit anterior". */
  stale: boolean;
  requestedAt: number;
  /** La pestaña del revisor, si sigue abierta. */
  terminalId: TerminalId | null;
}

/** Un commit de la rama que la base no tiene. */
export interface WorktreeCommit {
  /** Corto, para mostrar. */
  sha: string;
  subject: string;
  /** Epoch ms del commit. */
  at: number;
}

/** Un archivo que la rama cambió contra su base. */
export interface WorktreeChangedFile {
  path: string;
  /** La ruta de antes, en un renombre o una copia. */
  oldPath: string | null;
  kind: GitChangeKind;
}

/** "Ver cambios": lo que trae una rama contra su base, de sólo lectura. */
export interface WorktreeChanges {
  id: string;
  branch: string;
  base: string;
  commits: WorktreeCommit[];
  commitCount: number;
  files: WorktreeChangedFile[];
  fileCount: number;
  /** Archivos sin commit en la carpeta de la rama: no entran, están en la Cambios de su pestaña. */
  uncommitted: number;
}

/** Lo que muestra el diálogo de "Pedir revisión" antes de abrir nada. */
export interface WorktreeReviewPlan {
  id: string;
  branch: string;
  base: string;
  /** La CLI que trabajó en la rama: la de su pestaña o su última sesión. null si no se sabe. */
  author: AgentId | null;
  /** Lo que se le manda al revisor, en inglés (§6.23). Lo arma el servidor y lo vuelve a armar al pedir. */
  prompt: string;
  /** Commits de la rama que la base no tiene. Con 0 no hay nada que revisar. */
  ahead: number;
  /** Archivos sin commit en la rama: el pedido le dice al revisor que los mire también. */
  uncommitted: number;
  /** true si la pestaña de la rama está trabajando: la revisión puede ver un estado a medias. */
  branchBusy: boolean;
}

/**
 * Por qué no se puede integrar todavía:
 *
 *  - `nothing`: la rama no tiene commits que la base no tenga.
 *  - `behind`: la base avanzó; sin crear un commit no se puede, primero hay que
 *    ponerse al día.
 *  - `no-base-folder`: la base no está sacada en ninguna carpeta.
 *  - `local-changes`: esa carpeta tiene cambios sin commit en archivos que la
 *    rama toca, y git se negaría.
 */
export type WorktreeIntegrateBlocker = 'nothing' | 'behind' | 'no-base-folder' | 'local-changes';
export const WORKTREE_INTEGRATE_BLOCKERS: readonly WorktreeIntegrateBlocker[] = [
  'nothing',
  'behind',
  'no-base-folder',
  'local-changes',
];

/** El plan de "Integrar en <base>": se muestra, se confirma y el servidor lo rehace. */
export interface WorktreeIntegratePlan {
  id: string;
  branch: string;
  base: string;
  /** La carpeta donde está sacada la base: ahí corre el comando. null si en ninguna. */
  baseFolder: string | null;
  /** `git merge --ff-only <rama>`, para mostrar; null si no se puede. */
  command: string | null;
  /**
   * La punta de la rama con la que se armó el plan. Integrar la manda de vuelta
   * y el servidor no integra si la rama avanzó desde entonces: entraría algo que
   * el diálogo no mostró. null con un servidor anterior.
   */
  branchCommit: string | null;
  ahead: number;
  behind: number;
  /** Los archivos que entran, con tope. */
  files: string[];
  fileCount: number;
  /** La última revisión: informa y no frena. */
  review: WorktreeReviewSummary | null;
  /** Pestañas y consolas en la carpeta de la base: sus archivos van a cambiar. */
  tabs: WorktreeOpenTab[];
  /** Archivos sin commit de esa carpeta que la rama toca: con alguno, git se negaría. */
  localConflicts: string[];
  /** Archivos sin commit en la rama: eso no entra. */
  branchUncommitted: number;
  blocker: WorktreeIntegrateBlocker | null;
  /**
   * Las notas que viajan con los commits (21-10-2026). null si no viaja
   * ninguna: la base no está en la carpeta principal (vuelven al quitar la
   * rama), o un servidor anterior.
   */
  notes: WorktreeNotesPreview | null;
}

export interface WorktreeIntegrateOutcome {
  /** Commits que entraron en la base. */
  commits: number;
  base: string;
  /**
   * Las notas que volvieron a la carpeta principal, y las que se quedaron en la
   * rama (21-10-2026). Ausente si no viajó ninguna.
   */
  notes?: { returned: number; stayed: string[] };
}

/**
 * Una rama que creó la app, cuya carpeta se quitó y que sigue en el repo
 * (20-10-2026): se quitó sin integrar. Cambios la lista en "Ramas aparte" para
 * poder borrarla después.
 */
export interface WorktreeKeptBranch {
  /** El registro de la app: la acción la nombra por él, nunca por una ruta (§2.4). */
  id: string;
  branch: string;
  base: string;
  /** Commits que la base no tiene; null si no se pudo leer (la base ya no está). */
  ahead: number | null;
}

export type WorktreeDeleteBranchBlocker = 'not-integrated' | 'checked-out';
export const WORKTREE_DELETE_BRANCH_BLOCKERS: readonly WorktreeDeleteBranchBlocker[] = ['not-integrated', 'checked-out'];

/**
 * El plan de borrar una rama guardada: se muestra, se confirma y el servidor lo
 * rehace. Sólo `git branch -d`: una rama con commits que la base no tiene no se
 * borra desde la app, para no perderlos.
 */
export interface WorktreeDeleteBranchPlan {
  id: string;
  branch: string;
  base: string;
  /** La carpeta principal del repo: ahí corre el comando. */
  folder: string;
  /** `git branch -d <rama>`, para mostrar. */
  command: string;
  ahead: number | null;
  blocker: WorktreeDeleteBranchBlocker | null;
}

/**
 * Quién revisa por defecto (decisión 4 del plan): otra CLI que la que trabajó
 * en la rama, si hay otra para elegir, y entre ellas la que mejor se protege
 * (`cli` antes que `tools`, y ésa antes que ninguna), en el orden de la lista.
 * Con una sola, esa misma, en una conversación nueva.
 */
export function defaultReviewer(
  author: AgentId | null,
  candidates: readonly { id: AgentId; guard: ReadOnlyGuard | null }[],
): AgentId | null {
  const rank = (guard: ReadOnlyGuard | null): number => (guard === 'cli' ? 0 : guard === 'tools' ? 1 : 2);
  const others = candidates.filter((candidate) => candidate.id !== author);
  const pool = others.length > 0 ? others : candidates;
  let best: { id: AgentId; guard: ReadOnlyGuard | null } | null = null;
  for (const candidate of pool) {
    if (best === null || rank(candidate.guard) < rank(best.guard)) best = candidate;
  }
  return best?.id ?? null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** El id entero de un commit (40 hex con SHA-1, 64 con SHA-256), o null. */
export function asCommitId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(value) ? value : null;
}

export function parseTabWorktree(value: unknown): TabWorktree | null {
  const record = asRecord(value);
  if (record === null) return null;
  const mainCwd = asNonEmptyString(record['mainCwd']);
  const linked = asBoolean(record['linked']);
  if (mainCwd === null || linked === null) return null;
  return { mainCwd, branch: asNonEmptyString(record['branch']), linked };
}

export function parseSessionWorktree(value: unknown): SessionWorktree | null {
  const record = asRecord(value);
  if (record === null) return null;
  const branch = asNonEmptyString(record['branch']);
  const exists = asBoolean(record['exists']);
  if (branch === null || exists === null) return null;
  return { branch, exists, reopenable: record['reopenable'] === true };
}

export function parseWorktreeSource(value: unknown): WorktreeSource | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (record['kind'] === 'project') {
    const projectKey = asNonEmptyString(record['projectKey']);
    return projectKey === null ? null : { kind: 'project', projectKey };
  }
  if (record['kind'] === 'terminal') {
    const terminalId = asNonEmptyString(record['terminalId']);
    return terminalId === null ? null : { kind: 'terminal', terminalId };
  }
  return null;
}

function parseCopySummary(value: unknown): WorktreeCopySummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const files = asFiniteNumber(record['files']);
  const bytes = asFiniteNumber(record['bytes']);
  const sample = asStringArray(record['sample']);
  if (files === null || bytes === null || sample === null) return null;
  return { files, bytes, overCap: record['overCap'] === true, sample };
}

function parseBranchEntry(value: unknown): { name: string; checkedOut: boolean } | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asNonEmptyString(record['name']);
  return name === null ? null : { name, checkedOut: record['checkedOut'] === true };
}

export function parseWorktreeInspection(value: unknown): WorktreeInspection | null {
  const record = asRecord(value);
  if (record === null) return null;
  const mainRoot = asNonEmptyString(record['mainRoot']);
  const parentDir = asNonEmptyString(record['parentDir']);
  const separator = asNonEmptyString(record['separator']);
  const branches = asArrayOf(record['branches'], parseBranchEntry);
  const mainChanges = asFiniteNumber(record['mainChanges']);
  const notes = parseCopySummary(record['notes']);
  const include = record['include'] === null ? null : parseCopySummary(record['include']);
  if (
    mainRoot === null ||
    parentDir === null ||
    separator === null ||
    branches === null ||
    mainChanges === null ||
    notes === null ||
    (record['include'] !== null && include === null)
  ) {
    return null;
  }
  return {
    mainRoot,
    parentDir,
    separator,
    currentBranch: asNonEmptyString(record['currentBranch']),
    branches,
    mainChanges,
    include,
    notes,
  };
}

export function parseWorktreeRow(value: unknown): WorktreeRow | null {
  const record = asRecord(value);
  if (record === null) return null;
  const rowPath = asNonEmptyString(record['path']);
  if (rowPath === null) return null;
  const integrated = record['integrated'];
  return {
    id: asNonEmptyString(record['id']),
    path: rowPath,
    branch: asNonEmptyString(record['branch']),
    base: asNonEmptyString(record['base']),
    isCurrent: record['isCurrent'] === true,
    isMain: record['isMain'] === true,
    changes: asFiniteNumber(record['changes']),
    ahead: asFiniteNumber(record['ahead']),
    integrated: typeof integrated === 'boolean' ? integrated : null,
    // Ausentes en un servidor del hito 48: sin estado contra la base, sin avisos y sin revisión.
    behind: asFiniteNumber(record['behind']),
    merge: parseWorktreeMerge(record['merge']),
    overlaps: asArrayFiltered(record['overlaps'], parseWorktreeOverlap) ?? [],
    review: parseWorktreeReviewSummary(record['review']),
  };
}

/** Una lista de rutas con su total, como viajan los archivos de una fila. */
function parseFileList(record: Record<string, unknown>): { files: string[]; fileCount: number } | null {
  const files = asStringArray(record['files']);
  const fileCount = asFiniteNumber(record['fileCount']);
  return files === null || fileCount === null ? null : { files, fileCount };
}

export function parseWorktreeMerge(value: unknown): WorktreeMerge | null {
  const record = asRecord(value);
  if (record === null) return null;
  const state = asLiteral(record['state'], WORKTREE_MERGE_STATES);
  const list = parseFileList(record);
  return state === null || list === null ? null : { state, ...list };
}

export function parseWorktreeOverlap(value: unknown): WorktreeOverlap | null {
  const record = asRecord(value);
  if (record === null) return null;
  const branch = asNonEmptyString(record['branch']);
  const list = parseFileList(record);
  return branch === null || list === null ? null : { branch, ...list };
}

export function parseWorktreeReviewSummary(value: unknown): WorktreeReviewSummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], AGENT_IDS);
  const state = asLiteral(record['state'], WORKTREE_REVIEW_STATES);
  const requestedAt = asFiniteNumber(record['requestedAt']);
  if (agent === null || state === null || requestedAt === null) return null;
  return {
    agent,
    state,
    verdict: state === 'done' ? (asLiteral(record['verdict'], WORKTREE_VERDICTS) ?? 'none') : null,
    stale: record['stale'] === true,
    requestedAt,
    terminalId: asNonEmptyString(record['terminalId']),
  };
}

function parseWorktreeCommit(value: unknown): WorktreeCommit | null {
  const record = asRecord(value);
  if (record === null) return null;
  const sha = asNonEmptyString(record['sha']);
  const subject = asString(record['subject']);
  const at = asFiniteNumber(record['at']);
  return sha === null || subject === null || at === null ? null : { sha, subject, at };
}

function parseWorktreeChangedFile(value: unknown): WorktreeChangedFile | null {
  const record = asRecord(value);
  if (record === null) return null;
  const filePath = asNonEmptyString(record['path']);
  const kind = asLiteral(record['kind'], GIT_CHANGE_KINDS);
  if (filePath === null || kind === null) return null;
  return { path: filePath, oldPath: asNonEmptyString(record['oldPath']), kind };
}

export function parseWorktreeChanges(value: unknown): WorktreeChanges | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const branch = asNonEmptyString(record['branch']);
  const base = asNonEmptyString(record['base']);
  const commits = asArrayOf(record['commits'], parseWorktreeCommit);
  const commitCount = asFiniteNumber(record['commitCount']);
  const files = asArrayOf(record['files'], parseWorktreeChangedFile);
  const fileCount = asFiniteNumber(record['fileCount']);
  const uncommitted = asFiniteNumber(record['uncommitted']);
  if (
    id === null ||
    branch === null ||
    base === null ||
    commits === null ||
    commitCount === null ||
    files === null ||
    fileCount === null ||
    uncommitted === null
  ) {
    return null;
  }
  return { id, branch, base, commits, commitCount, files, fileCount, uncommitted };
}

export function parseWorktreeReviewPlan(value: unknown): WorktreeReviewPlan | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const branch = asNonEmptyString(record['branch']);
  const base = asNonEmptyString(record['base']);
  const prompt = asNonEmptyString(record['prompt']);
  const ahead = asFiniteNumber(record['ahead']);
  const uncommitted = asFiniteNumber(record['uncommitted']);
  const branchBusy = asBoolean(record['branchBusy']);
  if (id === null || branch === null || base === null || prompt === null || ahead === null || uncommitted === null || branchBusy === null) {
    return null;
  }
  return { id, branch, base, author: asLiteral(record['author'], AGENT_IDS), prompt, ahead, uncommitted, branchBusy };
}

export function parseWorktreeIntegratePlan(value: unknown): WorktreeIntegratePlan | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const branch = asNonEmptyString(record['branch']);
  const base = asNonEmptyString(record['base']);
  const ahead = asFiniteNumber(record['ahead']);
  const behind = asFiniteNumber(record['behind']);
  const list = parseFileList(record);
  const tabs = asArrayOf(record['tabs'], parseOpenTab);
  const localConflicts = asStringArray(record['localConflicts']);
  const branchUncommitted = asFiniteNumber(record['branchUncommitted']);
  const rawBlocker = record['blocker'];
  const blocker = rawBlocker === null ? null : asLiteral(rawBlocker, WORKTREE_INTEGRATE_BLOCKERS);
  if (
    id === null ||
    branch === null ||
    base === null ||
    ahead === null ||
    behind === null ||
    list === null ||
    tabs === null ||
    localConflicts === null ||
    branchUncommitted === null ||
    (rawBlocker !== null && blocker === null)
  ) {
    return null;
  }
  return {
    id,
    branch,
    base,
    baseFolder: asNonEmptyString(record['baseFolder']),
    command: asNonEmptyString(record['command']),
    branchCommit: asCommitId(record['branchCommit']),
    ahead,
    behind,
    ...list,
    review: parseWorktreeReviewSummary(record['review']),
    tabs,
    localConflicts,
    branchUncommitted,
    blocker,
    // Ausente en un servidor anterior: no viaja ninguna nota.
    notes: parseWorktreeNotesPreview(record['notes']),
  };
}

export function parseWorktreeNotesPreview(value: unknown): WorktreeNotesPreview | null {
  const record = asRecord(value);
  if (record === null) return null;
  const returning = asStringArray(record['returning']);
  const conflicts = asStringArray(record['conflicts']);
  if (returning === null || conflicts === null) return null;
  return { returning, merging: asStringArray(record['merging']) ?? [], conflicts };
}

export function parseWorktreeIntegrateOutcome(value: unknown): WorktreeIntegrateOutcome | null {
  const record = asRecord(value);
  if (record === null) return null;
  const commits = asFiniteNumber(record['commits']);
  const base = asNonEmptyString(record['base']);
  if (commits === null || base === null) return null;
  const notes = asRecord(record['notes']);
  const returned = asFiniteNumber(notes?.['returned']);
  const stayed = asStringArray(notes?.['stayed']);
  return returned === null || stayed === null ? { commits, base } : { commits, base, notes: { returned, stayed } };
}

export function parseWorktreeKeptBranch(value: unknown): WorktreeKeptBranch | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const branch = asNonEmptyString(record['branch']);
  const base = asNonEmptyString(record['base']);
  if (id === null || branch === null || base === null) return null;
  return { id, branch, base, ahead: asFiniteNumber(record['ahead']) };
}

export function parseWorktreeDeleteBranchPlan(value: unknown): WorktreeDeleteBranchPlan | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const branch = asNonEmptyString(record['branch']);
  const base = asNonEmptyString(record['base']);
  const folder = asNonEmptyString(record['folder']);
  const command = asNonEmptyString(record['command']);
  const rawBlocker = record['blocker'];
  const blocker = rawBlocker === null ? null : asLiteral(rawBlocker, WORKTREE_DELETE_BRANCH_BLOCKERS);
  if (id === null || branch === null || base === null || folder === null || command === null || (rawBlocker !== null && blocker === null)) {
    return null;
  }
  return { id, branch, base, folder, command, ahead: asFiniteNumber(record['ahead']), blocker };
}

const OPEN_TAB_KINDS: readonly TerminalKind[] = ['agent', 'shell'];

function parseOpenTab(value: unknown): WorktreeOpenTab | null {
  const record = asRecord(value);
  if (record === null) return null;
  const terminalId = asNonEmptyString(record['terminalId']);
  const kind = asLiteral(record['kind'], OPEN_TAB_KINDS);
  const label = asString(record['label']);
  if (terminalId === null || kind === null || label === null) return null;
  return { terminalId, kind, label };
}

export function parseWorktreeRemovePlan(value: unknown): WorktreeRemovePlan | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const branch = asNonEmptyString(record['branch']);
  const planPath = asNonEmptyString(record['path']);
  const commands = asStringArray(record['commands']);
  const uncommitted = asStringArray(record['uncommitted']);
  const uncommittedCount = asFiniteNumber(record['uncommittedCount']);
  const tabs = asArrayOf(record['tabs'], parseOpenTab);
  const returning = asStringArray(record['returning']);
  const conflicts = asStringArray(record['conflicts']);
  const deletesBranch = asBoolean(record['deletesBranch']);
  if (
    id === null ||
    branch === null ||
    planPath === null ||
    commands === null ||
    uncommitted === null ||
    uncommittedCount === null ||
    tabs === null ||
    returning === null ||
    conflicts === null ||
    deletesBranch === null
  ) {
    return null;
  }
  const inUse = record['inUse'];
  return {
    id,
    branch,
    path: planPath,
    commands,
    uncommitted,
    uncommittedCount,
    tabs,
    returning,
    // Ausentes en un servidor anterior: ninguna se junta, y la rama la creó la app.
    merging: (asStringArray(record['merging']) ?? []).filter((file) => returning.includes(file)),
    conflicts,
    inUse: typeof inUse === 'boolean' ? inUse : null,
    deletesBranch,
    branchUnused: deletesBranch && record['branchUnused'] === true,
    createdBranch: record['createdBranch'] !== false,
  };
}

export function parseWorktreeRemoveOutcome(value: unknown): WorktreeRemoveOutcome | null {
  const record = asRecord(value);
  if (record === null) return null;
  const branchDeleted = asBoolean(record['branchDeleted']);
  const returned = asFiniteNumber(record['returned']);
  const discarded = asFiniteNumber(record['discarded']);
  if (branchDeleted === null || returned === null || discarded === null) return null;
  return { branchDeleted, returned, discarded };
}

/** El `agent` de un pedido: ausente, o una CLI que este lado conoce. `false` si vino otra cosa. */
export function parseOptionalAgent(value: unknown): AgentId | undefined | false {
  if (value === undefined) return undefined;
  const agent = asLiteral(value, AGENT_IDS);
  return agent === null ? false : agent;
}
