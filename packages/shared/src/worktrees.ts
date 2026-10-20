/**
 * Las ramas aparte (hito 48, §6.38): una rama de git sacada en su propia
 * carpeta con `git worktree`, para que dos pestañas del mismo proyecto no se
 * pisen.
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

import { AGENT_IDS, type AgentId } from './agents.js';
// Sólo tipos: `models.ts` importa los parsers de acá, y un import de valores en
// las dos direcciones es un ciclo.
import type { TerminalId, TerminalKind } from './models.js';
import {
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
  /** true si la base ya tiene todos sus commits; null si no se pudo leer. */
  integrated: boolean | null;
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
  /** Notas ignoradas que cambiaron en la rama y vuelven a la carpeta principal. */
  returning: string[];
  /** Notas que cambiaron en los dos lados: con alguna no se quita, salvo "quitar igual". */
  conflicts: string[];
  /** true si otro programa tiene la carpeta abierta; null si no se pudo saber (hay pestañas de la app adentro). */
  inUse: boolean | null;
  /** true si la rama ya está integrada en su base: también se borra, con `branch -d`. */
  deletesBranch: boolean;
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
// Parsers
// ---------------------------------------------------------------------------

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
  };
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
    conflicts,
    inUse: typeof inUse === 'boolean' ? inUse : null,
    deletesBranch,
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
