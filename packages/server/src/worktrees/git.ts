/**
 * git para las ramas aparte (hito 48, §6.38).
 *
 * **Es el único lugar de la app con comandos de git que escriben**, y son tres:
 * `worktree add`, `worktree remove` (nunca con `--force`) y `branch -d` (nunca
 * `-D`). Cada uno corre después de una confirmación que lo muestra (§6.1). La
 * app sigue sin crear commits, sin reescribir historia y sin tocar la
 * configuración de git: con `extensions.worktreeConfig` el agente de
 * Antigravity se cuelga, y no hay nada que configurar para lo que se hace acá.
 * `check-worktrees.mjs` busca comandos que escriben en el resto del servidor.
 *
 * El resto son lecturas, con `--no-optional-locks` como en `git-repo.ts`: corren
 * solas mientras el usuario trabaja, y no pueden tomar el `index.lock`.
 */

import { execFile } from 'node:child_process';
import path from 'node:path';
import { GitMissingError, parsePorcelainV2, parseWorktreeListZ, type WorktreeEntry } from '../git-repo.js';

export type { WorktreeEntry };

/** Un `worktree add` en un repo grande copia miles de archivos: más que una lectura. */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 120_000;
const MAX_BUFFER = 32 * 1024 * 1024;

export interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
}

function isMissingBinary(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT';
}

function run(
  cwd: string,
  args: readonly string[],
  options: { write: boolean; input?: string; env?: NodeJS.ProcessEnv },
): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', ...(options.write ? [] : ['--no-optional-locks']), ...args],
      {
        cwd,
        timeout: options.write ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        ...(options.env !== undefined ? { env: options.env } : {}),
      },
      (error, stdout, stderr) => {
        if (error !== null && isMissingBinary(error)) {
          reject(new GitMissingError());
          return;
        }
        const code =
          error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1;
        resolve({ code, stdout, stderr });
      },
    );
    if (options.input !== undefined) {
      child.stdin?.on('error', () => {
        /* El proceso pudo morir antes de leer. */
      });
      child.stdin?.end(options.input);
    }
  });
}

const read = (cwd: string, args: readonly string[], input?: string): Promise<GitRun> =>
  run(cwd, args, { write: false, ...(input !== undefined ? { input } : {}) });

/** El texto de un fallo de git, recortado, para el usuario. */
export function gitFailureText(result: GitRun): string {
  const text = (result.stderr.trim() || result.stdout.trim()).slice(0, 600);
  return text.length > 0 ? text : `git exited with code ${result.code}`;
}

// ---------------------------------------------------------------------------
// Lecturas
// ---------------------------------------------------------------------------

export interface RepoLayout {
  /** La raíz de la carpeta de trabajo de `cwd`. */
  toplevel: string;
  /** La carpeta principal del repo, o null en un repo desnudo. */
  mainRoot: string | null;
  /** true si `cwd` está en una rama aparte. */
  linked: boolean;
}

/** Dónde está parado `cwd`, según git. null si no es un repositorio. */
export async function repoLayout(cwd: string): Promise<RepoLayout | null> {
  const result = await read(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']);
  if (result.code !== 0) return null;
  const [toplevel, gitDir, commonDir] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!toplevel || !gitDir || !commonDir) return null;
  const absoluteCommon = path.resolve(cwd, commonDir);
  const linked = path.resolve(gitDir).toLowerCase() !== absoluteCommon.toLowerCase();
  const mainRoot = path.basename(absoluteCommon).toLowerCase() === '.git' ? path.dirname(absoluteCommon) : null;
  return { toplevel: path.resolve(toplevel), mainRoot, linked };
}

/** La rama sacada en `cwd`, o null con HEAD desprendido. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await read(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = result.stdout.trim();
  return result.code === 0 && branch.length > 0 ? branch : null;
}

/** Las ramas locales, por nombre. */
export async function localBranches(cwd: string): Promise<string[]> {
  const result = await read(cwd, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
  if (result.code !== 0) return [];
  return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
}

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const result = await read(cwd, ['worktree', 'list', '--porcelain', '-z']);
  return result.code === 0 ? parseWorktreeListZ(result.stdout) : [];
}

/** Las rutas con cambios sin commit (sin lo ignorado), sin repetir. null si git falló. */
export async function uncommittedPaths(cwd: string): Promise<string[] | null> {
  const result = await read(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']);
  if (result.code !== 0) return null;
  const seen = new Set<string>();
  for (const change of parsePorcelainV2(result.stdout).changes) seen.add(change.path);
  return [...seen];
}

/** Commits de `branch` que `base` no tiene. null si git no pudo contestar. */
export async function aheadCount(cwd: string, base: string, branch: string): Promise<number | null> {
  const result = await read(cwd, ['rev-list', '--count', `refs/heads/${branch}`, '--not', `refs/heads/${base}`, '--']);
  const count = Number(result.stdout.trim());
  return result.code === 0 && Number.isInteger(count) ? count : null;
}

/** true si `base` ya tiene todos los commits de `branch` (está integrada). null si git no pudo contestar. */
export async function isIntegrated(cwd: string, branch: string, base: string): Promise<boolean | null> {
  const result = await read(cwd, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, `refs/heads/${base}`]);
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return null;
}

/** El commit al que apunta una rama local, o null si no existe. */
export async function branchCommit(cwd: string, branch: string): Promise<string | null> {
  const result = await read(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  const sha = result.stdout.trim();
  return result.code === 0 && /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** La palabra de git sobre un nombre de rama: lo que las reglas de `shared` no cubren. */
export async function refFormatAccepts(cwd: string, branch: string): Promise<boolean> {
  const result = await read(cwd, ['check-ref-format', '--branch', branch]);
  return result.code === 0;
}

/**
 * Lo no versionado de la carpeta principal que nombran los patrones y que,
 * además, git ignora: lo que se copia a una rama aparte (`.worktreeinclude`,
 * con la sintaxis de `.gitignore`, y la lista de la app).
 *
 * `--exclude-from` y `--exclude` sin `--exclude-standard` hacen que "ignorado"
 * signifique "lo nombran los patrones"; `--directory` devuelve una carpeta
 * entera en una línea (`docs/`) en vez de cada archivo. Después, `check-ignore`
 * deja sólo lo que el repo ignora: un archivo versionado ya viene con la rama,
 * y uno sin versionar que no se ignora no es una nota.
 *
 * Medido en el paso 0 sobre este repo, con un `node_modules` de pnpm: 0,3 s y
 * ninguna entrada de adentro.
 */
export async function ignoredSelection(
  root: string,
  includeFile: string | null,
  patterns: readonly string[],
): Promise<string[] | null> {
  if (includeFile === null && patterns.length === 0) return [];
  const listed = await read(root, [
    'ls-files',
    '--others',
    '--ignored',
    '--directory',
    '-z',
    ...(includeFile !== null ? [`--exclude-from=${includeFile}`] : []),
    ...patterns.map((pattern) => `--exclude=${pattern}`),
  ]);
  if (listed.code !== 0) return null;
  const candidates = listed.stdout.split('\0').filter((entry) => entry.length > 0);
  if (candidates.length === 0) return [];
  const checked = await read(root, ['check-ignore', '--stdin', '-z'], candidates.join('\0') + '\0');
  // 0: alguna ignorada; 1: ninguna. Otro código es un fallo.
  if (checked.code !== 0 && checked.code !== 1) return null;
  const ignored = new Set(checked.stdout.split('\0').filter((entry) => entry.length > 0));
  return candidates.filter((entry) => ignored.has(entry));
}

// ---------------------------------------------------------------------------
// Los tres comandos que escriben
// ---------------------------------------------------------------------------

/** El comando de crear, tal como se muestra en el diálogo y como se corre. */
export function addWorktreeArgs(folder: string, branch: string, base: string | null): string[] {
  return base === null ? ['worktree', 'add', folder, branch] : ['worktree', 'add', '-b', branch, folder, base];
}

export function removeWorktreeArgs(folder: string): string[] {
  return ['worktree', 'remove', folder];
}

export function deleteBranchArgs(branch: string): string[] {
  return ['branch', '-d', branch];
}

/**
 * Saca una rama en su carpeta. Con `base`, crea la rama desde ahí
 * (`worktree add -b`); sin `base`, abre una que ya existe.
 */
export function addWorktree(mainRoot: string, folder: string, branch: string, base: string | null): Promise<GitRun> {
  return run(mainRoot, addWorktreeArgs(folder, branch, base), { write: true });
}

/**
 * Quita la carpeta de una rama aparte. **Sin `--force`**: con algo sin commit,
 * git se niega, y eso es lo que tiene que pasar. Ojo: lo ignorado lo borra sin
 * avisar (medido), y por eso las notas vuelven antes (`include.ts`).
 */
export function removeWorktree(mainRoot: string, folder: string): Promise<GitRun> {
  return run(mainRoot, removeWorktreeArgs(folder), { write: true });
}

/** Borra una rama ya integrada. **`-d`, nunca `-D`**: si git dice que no está integrada, se queda. */
export function deleteBranch(mainRoot: string, branch: string): Promise<GitRun> {
  return run(mainRoot, deleteBranchArgs(branch), { write: true });
}
