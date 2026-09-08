/**
 * Modelo del panel de git.
 *
 * Dos reglas que atraviesan todo el archivo:
 *
 *  1. **Solo lectura.** No hay ningun tipo que represente un commit, un stage
 *     ni un push, y no es un olvido: la app muestra el estado del repo y nada
 *     mas. Lo que cambia historia se hace en la terminal, que es donde el
 *     usuario ve lo que escribe y puede cancelar.
 *  2. **Lo que viaja ya viene recortado.** Un `git status` de un repo con
 *     `node_modules` sin ignorar son decenas de miles de entradas, y un diff
 *     puede pesar megabytes. El servidor corta y marca `truncated`; el
 *     navegador nunca ve la salida cruda.
 */

import {
  asArrayOf,
  asBoolean,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
} from './validation.js';

/** En que area vive el cambio. Un mismo archivo puede aparecer en dos. */
export type GitChangeStage = 'staged' | 'unstaged' | 'untracked' | 'conflict';

export const GIT_CHANGE_STAGES: readonly GitChangeStage[] = [
  'staged',
  'unstaged',
  'untracked',
  'conflict',
];

export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'conflict';

export const GIT_CHANGE_KINDS: readonly GitChangeKind[] = [
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'type-changed',
  'untracked',
  'conflict',
];

export interface GitFileChange {
  /** Ruta relativa a la raiz del repo, siempre con `/`. */
  path: string;
  kind: GitChangeKind;
  stage: GitChangeStage;
  /** Origen de un rename o un copy. null en el resto de los casos. */
  oldPath: string | null;
}

/**
 * Una entrada de `git worktree list`.
 *
 * Vale la pena mostrarlas: quien trabaja con varios worktrees del mismo repo
 * pierde de vista en cual esta parada la pestana, y ahi es facil pedirle a la
 * CLI que edite el arbol equivocado.
 */
export interface GitWorktree {
  path: string;
  branch: string | null;
  /** true en el worktree al que pertenece el `cwd` de la pestana. */
  isCurrent: boolean;
}

/**
 * `error` es para cuando git esta y el directorio es un repo, pero el comando
 * fallo igual. Se distingue de `not-a-repo` porque una carpeta suelta es
 * normal y un repo roto no.
 */
export type GitState = 'ready' | 'not-a-repo' | 'git-missing' | 'error';

export const GIT_STATES: readonly GitState[] = ['ready', 'not-a-repo', 'git-missing', 'error'];

export interface GitStatus {
  state: GitState;
  /** Texto para mostrar cuando `state` no es `ready`. */
  message: string | null;
  /** Raiz del repo. Cadena vacia si no hay. */
  repoRoot: string;
  /** null con HEAD desprendido. */
  branch: string | null;
  /** Sha corto de HEAD. null en un repo sin commits. */
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  worktrees: GitWorktree[];
  /** true si habia mas cambios de los que se transportan. */
  truncated: boolean;
  updatedAt: number;
}

export const EMPTY_GIT_STATUS: GitStatus = {
  state: 'not-a-repo',
  message: null,
  repoRoot: '',
  branch: null,
  head: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  changes: [],
  worktrees: [],
  truncated: false,
  updatedAt: 0,
};

export type DiffLineKind = 'meta' | 'hunk' | 'context' | 'added' | 'removed';

export const DIFF_LINE_KINDS: readonly DiffLineKind[] = [
  'meta',
  'hunk',
  'context',
  'added',
  'removed',
];

/**
 * Una linea del diff, ya numerada.
 *
 * Los numeros se calculan en el servidor: es la misma cuenta, y hacerla una
 * sola vez evita que dos vistas lleguen a resultados distintos.
 */
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

export interface GitDiff {
  path: string;
  /** true si es el diff del area de staging (`--cached`). */
  staged: boolean;
  lines: DiffLine[];
  /** true si se corto por tamano. */
  truncated: boolean;
  binary: boolean;
  /** Explicacion cuando no hay lineas que mostrar. */
  message: string | null;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseGitFileChange(value: unknown): GitFileChange | null {
  const record = asRecord(value);
  if (record === null) return null;

  const filePath = asNonEmptyString(record['path']);
  const kind = asLiteral(record['kind'], GIT_CHANGE_KINDS);
  const stage = asLiteral(record['stage'], GIT_CHANGE_STAGES);
  if (filePath === null || kind === null || stage === null) return null;

  return { path: filePath, kind, stage, oldPath: asString(record['oldPath']) };
}

export function parseGitWorktree(value: unknown): GitWorktree | null {
  const record = asRecord(value);
  if (record === null) return null;

  const worktreePath = asNonEmptyString(record['path']);
  if (worktreePath === null) return null;

  return {
    path: worktreePath,
    branch: asString(record['branch']),
    isCurrent: record['isCurrent'] === true,
  };
}

export function parseGitStatus(value: unknown): GitStatus | null {
  const record = asRecord(value);
  if (record === null) return null;

  const state = asLiteral(record['state'], GIT_STATES);
  const repoRoot = asString(record['repoRoot']);
  const ahead = asFiniteNumber(record['ahead']);
  const behind = asFiniteNumber(record['behind']);
  const changes = asArrayOf(record['changes'], parseGitFileChange);
  const worktrees = asArrayOf(record['worktrees'], parseGitWorktree);
  const updatedAt = asFiniteNumber(record['updatedAt']);

  if (
    state === null ||
    repoRoot === null ||
    ahead === null ||
    behind === null ||
    changes === null ||
    worktrees === null ||
    updatedAt === null
  ) {
    return null;
  }

  return {
    state,
    message: asString(record['message']),
    repoRoot,
    branch: asString(record['branch']),
    head: asString(record['head']),
    upstream: asString(record['upstream']),
    ahead,
    behind,
    changes,
    worktrees,
    truncated: record['truncated'] === true,
    updatedAt,
  };
}

export function parseDiffLine(value: unknown): DiffLine | null {
  const record = asRecord(value);
  if (record === null) return null;

  const kind = asLiteral(record['kind'], DIFF_LINE_KINDS);
  const text = asString(record['text']);
  if (kind === null || text === null) return null;

  return {
    kind,
    text,
    oldLine: asFiniteNumber(record['oldLine']),
    newLine: asFiniteNumber(record['newLine']),
  };
}

export function parseGitDiff(value: unknown): GitDiff | null {
  const record = asRecord(value);
  if (record === null) return null;

  const diffPath = asNonEmptyString(record['path']);
  const staged = asBoolean(record['staged']);
  const lines = asArrayOf(record['lines'], parseDiffLine);
  if (diffPath === null || staged === null || lines === null) return null;

  return {
    path: diffPath,
    staged,
    lines,
    truncated: record['truncated'] === true,
    binary: record['binary'] === true,
    message: asString(record['message']),
  };
}
