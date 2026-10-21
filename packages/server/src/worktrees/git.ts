/**
 * git para las ramas aparte (hito 48, §6.38).
 *
 * **Es el único lugar de la app con comandos de git que escriben**, y son
 * cuatro: `worktree add`, `worktree remove` (nunca con `--force`), `branch -d`
 * (nunca `-D`) y, desde el hito 49, `merge --ff-only`, que no crea commits:
 * adelanta la base hasta la punta de la rama. Cada uno corre después de una
 * confirmación que lo muestra (§6.1). La app sigue sin crear commits, sin
 * reescribir historia (ni rebase ni merge con commit) y sin tocar la
 * configuración de git: con `extensions.worktreeConfig` el agente de
 * Antigravity se cuelga, y no hay nada que configurar para lo que se hace acá.
 * `check-worktrees.mjs` busca comandos que escriben en el resto del servidor.
 *
 * El resto son lecturas, con `--no-optional-locks` como en `git-repo.ts`: corren
 * solas mientras el usuario trabaja, y no pueden tomar el `index.lock`. Una
 * lectura escribe algo de todos modos, `merge-tree` (sus objetos), y por eso
 * corre con un directorio de objetos temporal (`mergeTreeCheck`).
 */

import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  serverText,
  type GitChangeKind,
  type GitDiff,
  type WorktreeChangedFile,
  type WorktreeCommit,
} from '@agent-workbench/shared';
import { GitMissingError, diffFromOutput, parsePorcelainV2, parseWorktreeListZ, type WorktreeEntry } from '../git-repo.js';

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

const read = (cwd: string, args: readonly string[], input?: string, env?: NodeJS.ProcessEnv): Promise<GitRun> =>
  run(cwd, args, { write: false, ...(input !== undefined ? { input } : {}), ...(env !== undefined ? { env } : {}) });

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

/**
 * La rama sacada en `cwd`, o null con HEAD desprendido. Sin `--short`, por lo
 * mismo que `branchOfRef`: con una etiqueta del mismo nombre da `heads/<rama>`.
 */
export async function currentBranch(cwd: string): Promise<string | null> {
  const result = await read(cwd, ['symbolic-ref', '--quiet', 'HEAD']);
  return result.code === 0 ? branchOfRef(result.stdout.trim()) : null;
}

/**
 * El nombre de una rama a partir de su ref completa. No `refname:short`: con
 * una etiqueta del mismo nombre, git la abrevia `heads/<rama>` (lo encontró
 * `check-worktrees`, caso F10).
 */
function branchOfRef(ref: string): string | null {
  return ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length ? ref.slice('refs/heads/'.length) : null;
}

/** Las ramas locales, por nombre. */
export async function localBranches(cwd: string): Promise<string[]> {
  const result = await read(cwd, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
  if (result.code !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => branchOfRef(line.trim()))
    .filter((branch): branch is string => branch !== null);
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

/** true si el repo todavía tiene ese commit: el de una rama borrada, hasta que git lo limpie. */
export async function commitExists(cwd: string, commit: string): Promise<boolean> {
  if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
  const result = await read(cwd, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`]);
  return result.code === 0;
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
// Lecturas del hito 49: la rama contra su base
// ---------------------------------------------------------------------------

/** La punta de cada rama local, en un solo proceso. Vacio si git no pudo. */
export async function branchTips(cwd: string): Promise<Map<string, string>> {
  const result = await read(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads']);
  const tips = new Map<string, string>();
  if (result.code !== 0) return tips;
  for (const line of result.stdout.split(/\r?\n/)) {
    const [ref, sha] = line.split('\0');
    const name = ref === undefined ? null : branchOfRef(ref);
    if (name !== null && sha !== undefined && /^[0-9a-f]{40,64}$/.test(sha)) tips.set(name, sha);
  }
  return tips;
}

/**
 * Cuanto avanzo cada lado desde que la rama salio: `behind`, los commits de la
 * base que la rama no tiene ("main avanzo 2"), y `ahead`, los de la rama que la
 * base no tiene. Medido: `rev-list --left-right --count main...feat` da "1 1".
 */
export async function aheadBehind(cwd: string, base: string, branch: string): Promise<{ ahead: number; behind: number } | null> {
  const result = await read(cwd, ['rev-list', '--left-right', '--count', `refs/heads/${base}...refs/heads/${branch}`, '--']);
  if (result.code !== 0) return null;
  const [left, right] = result.stdout.trim().split(/\s+/).map(Number);
  return Number.isInteger(left) && Number.isInteger(right) ? { ahead: right as number, behind: left as number } : null;
}

const NAME_STATUS_KINDS: Readonly<Record<string, GitChangeKind>> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

/**
 * La salida de `diff --name-status -z`: la letra (con su porcentaje en un
 * renombre o una copia) y la ruta, o la de antes y la de ahora. Pura: la prueba
 * el chequeo. Una letra que no se conoce se toma como modificado.
 */
export function parseNameStatusZ(stdout: string): WorktreeChangedFile[] {
  const fields = stdout.split('\0');
  const files: WorktreeChangedFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? '';
    index += 1;
    if (status.length === 0) continue;
    const kind = NAME_STATUS_KINDS[status[0] ?? ''] ?? 'modified';
    if (kind === 'renamed' || kind === 'copied') {
      const oldPath = fields[index] ?? '';
      const newPath = fields[index + 1] ?? '';
      index += 2;
      if (newPath.length > 0) files.push({ path: newPath, oldPath: oldPath.length > 0 ? oldPath : null, kind });
      continue;
    }
    const filePath = fields[index] ?? '';
    index += 1;
    if (filePath.length > 0) files.push({ path: filePath, oldPath: null, kind });
  }
  return files;
}

/**
 * Los archivos que la rama cambio desde que salio de la base (`base...rama`:
 * contra el punto donde se separaron, no contra la punta de la base). null si
 * git no pudo.
 */
export async function branchChangedFiles(cwd: string, base: string, branch: string): Promise<WorktreeChangedFile[] | null> {
  const result = await read(cwd, [
    'diff',
    '--name-status',
    '-z',
    '-M',
    '--no-color',
    '--no-ext-diff',
    `refs/heads/${base}...refs/heads/${branch}`,
    '--',
  ]);
  return result.code === 0 ? parseNameStatusZ(result.stdout) : null;
}

/** Los commits de la rama que la base no tiene, los mas nuevos primero, con tope. null si git no pudo. */
export async function branchCommits(cwd: string, base: string, branch: string, max: number): Promise<WorktreeCommit[] | null> {
  const result = await read(cwd, [
    'log',
    '--no-color',
    `--max-count=${Math.max(1, Math.floor(max))}`,
    '--format=%h%x1f%ct%x1f%s%x1e',
    `refs/heads/${branch}`,
    '--not',
    `refs/heads/${base}`,
    '--',
  ]);
  if (result.code !== 0) return null;
  const commits: WorktreeCommit[] = [];
  for (const record of result.stdout.split('\x1e')) {
    const [sha, seconds, subject] = record.replace(/^\r?\n/, '').split('\x1f');
    if (sha === undefined || sha.length === 0 || seconds === undefined) continue;
    commits.push({ sha, subject: subject ?? '', at: Number(seconds) * 1000 });
  }
  return commits;
}

/**
 * El diff de un archivo de la rama contra su base, con los topes del de Cambios
 * (`diffFromOutput`). En un renombre se pasan las dos rutas, para que git lo
 * muestre como tal.
 */
export async function branchFileDiff(
  cwd: string,
  base: string,
  branch: string,
  file: string,
  oldPath: string | null,
): Promise<GitDiff> {
  const result = await read(cwd, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--unified=3',
    '-M',
    `refs/heads/${base}...refs/heads/${branch}`,
    '--',
    ...(oldPath !== null && oldPath !== file ? [oldPath] : []),
    file,
  ]);
  return diffFromOutput(file, false, result, serverText('worktreeDiffEmpty'));
}

/**
 * El directorio de objetos del repo, para leer de el sin escribirle
 * (`mergeTreeCheck`). null si git no contesta.
 */
async function objectsDir(mainRoot: string): Promise<string | null> {
  const result = await read(mainRoot, ['rev-parse', '--git-path', 'objects']);
  const answer = result.stdout.trim();
  return result.code === 0 && answer.length > 0 ? path.resolve(mainRoot, answer) : null;
}

/**
 * Una carpeta para `GIT_ALTERNATE_OBJECT_DIRECTORIES`, que es una lista con el
 * separador de rutas del sistema (`;` en Windows): una ruta que lo trae, o que
 * empieza con comillas, va entre comillas al estilo de C, como pide git.
 */
export function alternatesValue(folder: string, platform: string = process.platform): string {
  const separator = platform === 'win32' ? ';' : ':';
  if (!folder.includes(separator) && !folder.startsWith('"')) return folder;
  return `"${folder.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Si la rama se integraria limpio con la base, y que archivos chocarian, **sin
 * escribir nada en el repo**.
 *
 * `merge-tree --write-tree` no toca el indice ni ninguna carpeta, pero escribe
 * los objetos del resultado (medido en el paso 0: de 15 a 17). Por eso corre con
 * `GIT_OBJECT_DIRECTORY` en una carpeta temporal y los objetos del repo como
 * alternativos: da lo mismo y el repo queda igual (medido: 23 y 23, la
 * temporal con 1). La temporal se borra al terminar.
 *
 * Sale con 0 si integra limpio y con 1 si choca; con 1 tambien sale una rama
 * que no existe, asi que choque es 1 **y** el arbol en la primera linea. Lo
 * demas (historias sin relacion: 128) es null. Unos 180 ms en este repo.
 */
export async function mergeTreeCheck(
  mainRoot: string,
  base: string,
  branch: string,
): Promise<{ clean: boolean; files: string[] } | null> {
  const objects = await objectsDir(mainRoot);
  if (objects === null) return null;
  // Sin dónde poner los objetos (la temporal llena o sin permiso), el choque no se sabe: no tumba las filas.
  const scratch = await mkdtemp(path.join(tmpdir(), 'aw-merge-tree-')).catch(() => null);
  if (scratch === null) return null;
  try {
    const result = await read(
      mainRoot,
      ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', `refs/heads/${base}`, `refs/heads/${branch}`],
      undefined,
      { ...process.env, GIT_OBJECT_DIRECTORY: scratch, GIT_ALTERNATE_OBJECT_DIRECTORIES: alternatesValue(objects) },
    );
    return parseMergeTree(result);
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
  }
}

/** La salida de `merge-tree --name-only -z`: el arbol y, si choca, los archivos. Pura. */
export function parseMergeTree(result: GitRun): { clean: boolean; files: string[] } | null {
  const [tree, ...rest] = result.stdout.split('\0');
  if (tree === undefined || !/^[0-9a-f]{40,64}$/.test(tree.trim())) return null;
  if (result.code === 0) return { clean: true, files: [] };
  if (result.code !== 1) return null;
  return { clean: false, files: [...new Set(rest.filter((entry) => entry.length > 0))] };
}

/**
 * Cómo se nombra la rama en `merge --ff-only`, en la carpeta donde corre: su
 * nombre si git lo resuelve a esa rama, y si no `refs/heads/<rama>`. Antes que
 * `refs/heads/` git prueba `$GIT_DIR/<nombre>`, `refs/<nombre>` y
 * `refs/tags/<nombre>`: con una etiqueta del mismo nombre, o con una rama
 * `stash` y un stash guardado, el nombre solo integraría otra cosa (medido el
 * 20-10-2026: `main` quedó en el commit del stash).
 */
export async function mergeTarget(cwd: string, branch: string): Promise<string> {
  const result = await read(cwd, ['rev-parse', '--symbolic-full-name', branch]);
  return result.code === 0 && result.stdout.trim() === `refs/heads/${branch}` ? branch : `refs/heads/${branch}`;
}

// ---------------------------------------------------------------------------
// Los cuatro comandos que escriben
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

/**
 * Integrar (hito 49): adelantar la base hasta la punta de la rama. **Sólo
 * `--ff-only`**: no crea commits, y si la base avanzó git se niega sin cambiar
 * nada (medido: "Not possible to fast-forward, aborting."). `target` es el
 * nombre de la rama, o `refs/heads/<rama>` si una etiqueta se llama igual.
 */
export function fastForwardArgs(target: string): string[] {
  return ['merge', '--ff-only', target];
}

/**
 * Corre en la carpeta donde está sacada la base. Con cambios sin commit en un
 * archivo que la rama toca, git se niega y el cambio queda intacto; en otros
 * archivos, integra y los deja como estaban (medido en el plan).
 */
export function fastForward(baseFolder: string, target: string): Promise<GitRun> {
  return run(baseFolder, fastForwardArgs(target), { write: true });
}
