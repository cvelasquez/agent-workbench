/**
 * Lectura del estado de git. Nada mas que lectura.
 *
 * **No hay commit, stage, push ni checkout en este archivo, y no es un
 * descuido.** El panel muestra en que estado esta el repo; lo que lo cambia se
 * escribe en la terminal, donde el usuario ve el comando y puede cancelarlo.
 * Un boton que hace `git commit` en una app que ademas maneja un agente que
 * edita archivos es exactamente la clase de cosa que despues nadie sabe quien
 * disparo.
 *
 * Se invoca `git` directo con `execFile` en vez de traer un envoltorio. Es una
 * dependencia menos y ninguna libreria evita el trabajo real, que es parsear
 * `--porcelain=v2 -z`: el formato estable y sin ambiguedades, tambien el unico
 * que sobrevive a nombres de archivo con espacios, comillas o acentos.
 */

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  DiffLine,
  GitChangeKind,
  GitDiff,
  GitFileChange,
  GitStatus,
  GitWorktree,
} from '@agent-workbench/shared';

/** Tope de cambios que viajan al navegador. Un repo sin ignorar tiene miles. */
const MAX_CHANGES = 2_000;
/** Tope del diff. Mas que esto no se lee en un panel lateral. */
const MAX_DIFF_LINES = 4_000;
const MAX_DIFF_BYTES = 512 * 1024;
/** Un `git status` que tarda mas que esto es un repo enorme o un disco de red. */
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** true si el fallo fue "git no esta instalado" y no "git dijo que no". */
function isMissingBinary(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

export class GitMissingError extends Error {
  constructor() {
    super('No se encontro git en el PATH.');
    this.name = 'GitMissingError';
  }
}

/**
 * Corre git y devuelve la salida aunque el codigo no sea cero.
 *
 * Un exit distinto de cero es informacion, no una excepcion: `rev-parse` en una
 * carpeta que no es repo falla, y eso es una respuesta valida.
 */
function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [
        // Sin esto git escapa los no-ASCII en octal y un archivo con acento
        // vuelve ilegible.
        '-c',
        'core.quotepath=false',
        // Esta app corre `git status` sola, cada pocos segundos, mientras el
        // usuario trabaja. Sin esta bandera `status` refresca y **escribe** el
        // indice, y eso trae dos problemas: toma `index.lock`, con lo que puede
        // hacer fallar un `git add` que el usuario esta escribiendo en la
        // terminal, y modifica `.git/index`, que es justo lo que observa
        // nuestro watcher — o sea que cada lectura se dispara a si misma.
        '--no-optional-locks',
        ...args,
      ],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error !== null && isMissingBinary(error)) {
          reject(new GitMissingError());
          return;
        }
        const code =
          error !== null && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code)
            : error !== null
              ? 1
              : 0;
        resolve({ stdout, stderr, code });
      },
    );
  });
}

function toPosix(value: string): string {
  return value.split('\\').join('/');
}

export interface RepoLookup {
  state: 'ready' | 'not-a-repo' | 'error';
  root: string;
  message: string | null;
}

/**
 * Ubica la raiz del repo que contiene `cwd`.
 *
 * Con worktrees, `--show-toplevel` devuelve la raiz **del worktree actual**,
 * que es la correcta: los cambios y las rutas del panel son las de ese arbol,
 * no las del repo principal.
 *
 * Distingue "esto no es un repo" de "el comando fallo", y eso importa mas de lo
 * que parece. Un `git` que no arranca —porque la maquina se quedo sin memoria,
 * porque el disco de red no responde— sale por el mismo camino que una carpeta
 * cualquiera, y meterlos en el mismo cajon hace que el panel afirme con toda
 * seguridad que un repo no es un repo. Ya paso: con la maquina al limite de
 * memoria, el panel se declaro "fuera de un repositorio git" sobre un repo que
 * estaba ahi. Un mensaje que dice lo que fallo es peor de leer y mucho mejor
 * que uno que miente.
 */
async function resolveRepo(cwd: string): Promise<RepoLookup> {
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel']);

  if (result.code === 0) {
    const root = result.stdout.trim();
    if (root.length > 0) return { state: 'ready', root: path.resolve(root), message: null };
  }

  const stderr = result.stderr.trim();
  // Es el texto que git usa para esto, en ingles y estable entre versiones.
  if (/not a git repository|no es un repositorio/i.test(stderr)) {
    return { state: 'not-a-repo', root: '', message: null };
  }
  if (stderr.length === 0 && result.code !== 0) {
    // Sin stderr y con codigo distinto de cero: casi siempre es un spawn que no
    // llego a correr. No se puede afirmar nada sobre el directorio.
    return {
      state: 'error',
      root: '',
      message: 'No se pudo ejecutar git para leer el estado del repositorio.',
    };
  }
  return {
    state: 'error',
    root: '',
    message: stderr.slice(0, 400) || 'git rev-parse fallo.',
  };
}

/** Raiz del repo, o null. Version simple para quien solo quiere la ruta. */
export async function findRepoRoot(cwd: string): Promise<string | null> {
  const lookup = await resolveRepo(cwd);
  return lookup.state === 'ready' ? lookup.root : null;
}

/**
 * Directorio `.git` del worktree. Con un worktree secundario **no** es una
 * carpeta sino un archivo que apunta a otra, y `--git-dir` ya resuelve eso.
 * Es lo que hay que observar para enterarse de un commit o un cambio de rama.
 */
export async function findGitDir(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, ['rev-parse', '--absolute-git-dir']);
  if (result.code !== 0) return null;
  const dir = result.stdout.trim();
  return dir.length > 0 ? path.resolve(dir) : null;
}

/** Letra de `git status --porcelain=v2` a un tipo con nombre. */
function letterToKind(letter: string): GitChangeKind {
  switch (letter) {
    case 'A':
      return 'added';
    case 'M':
      return 'modified';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'copied';
    case 'T':
      return 'type-changed';
    default:
      return 'modified';
  }
}

interface ParsedStatus {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  truncated: boolean;
}

/**
 * Parser de `--porcelain=v2 --branch -z`.
 *
 * Los registros van separados por NUL, no por salto de linea, y el registro de
 * rename (`2`) se lleva **un campo extra**: la ruta vieja viaja como el
 * siguiente elemento de la lista. Consumirlo es obligatorio; si no, la ruta
 * vieja se lee como si fuera un registro suelto y el parser se desincroniza
 * para el resto del archivo.
 */
export function parsePorcelainV2(raw: string): ParsedStatus {
  const fields = raw.split('\0');
  const parsed: ParsedStatus = {
    branch: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    truncated: false,
  };

  const push = (change: GitFileChange): void => {
    if (parsed.changes.length >= MAX_CHANGES) {
      parsed.truncated = true;
      return;
    }
    parsed.changes.push(change);
  };

  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (field === undefined || field.length === 0) continue;

    if (field.startsWith('# ')) {
      const [key, ...rest] = field.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.head') parsed.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.oid') parsed.head = value === '(initial)' ? null : value.slice(0, 8);
      else if (key === 'branch.upstream') parsed.upstream = value;
      else if (key === 'branch.ab') {
        const match = /^\+(-?\d+) -(-?\d+)$/.exec(value);
        if (match !== null) {
          parsed.ahead = Number(match[1]);
          parsed.behind = Number(match[2]);
        }
      }
      continue;
    }

    const type = field[0];

    if (type === '?') {
      push({ path: field.slice(2), kind: 'untracked', stage: 'untracked', oldPath: null });
      continue;
    }

    if (type === '!') continue; // ignorados: no se piden, pero por si acaso

    if (type === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const parts = field.split(' ');
      const filePath = parts.slice(10).join(' ');
      if (filePath.length > 0) {
        push({ path: filePath, kind: 'conflict', stage: 'conflict', oldPath: null });
      }
      continue;
    }

    if (type === '1' || type === '2') {
      const parts = field.split(' ');
      const xy = parts[1] ?? '..';
      const staged = xy[0] ?? '.';
      const unstaged = xy[1] ?? '.';

      let filePath: string;
      let oldPath: string | null = null;

      if (type === '1') {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        filePath = parts.slice(8).join(' ');
      } else {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>
        filePath = parts.slice(9).join(' ');
        // La ruta vieja es el campo siguiente. Se consume aca o el parser se
        // desincroniza para todo lo que sigue.
        index += 1;
        oldPath = fields[index] ?? null;
      }

      if (filePath.length === 0) continue;

      if (staged !== '.') {
        push({ path: filePath, kind: letterToKind(staged), stage: 'staged', oldPath });
      }
      if (unstaged !== '.') {
        push({ path: filePath, kind: letterToKind(unstaged), stage: 'unstaged', oldPath: null });
      }
    }
  }

  return parsed;
}

/** Parser de `git worktree list --porcelain`. Bloques separados por linea vacia. */
export function parseWorktrees(raw: string, currentRoot: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: { path: string; branch: string | null } | null = null;

  const flush = (): void => {
    if (current === null) return;
    worktrees.push({
      path: current.path,
      branch: current.branch,
      isCurrent: path.resolve(current.path) === path.resolve(currentRoot),
    });
    current = null;
  };

  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length), branch: null };
    } else if (line.startsWith('branch ') && current !== null) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
  }
  flush();

  return worktrees;
}

/**
 * Estado completo del repo del `cwd`.
 *
 * Nunca lanza por culpa de git: un repo roto o una carpeta suelta vuelven como
 * un `GitStatus` con `state` distinto de `ready`. Lo unico que se propaga es
 * que git no este instalado, y eso tambien viaja como estado.
 */
export async function readStatus(cwd: string): Promise<GitStatus> {
  const base: GitStatus = {
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
    updatedAt: Date.now(),
  };

  let lookup: RepoLookup;
  try {
    lookup = await resolveRepo(cwd);
  } catch (error) {
    if (error instanceof GitMissingError) {
      return {
        ...base,
        state: 'git-missing',
        message:
          'No se encontro git en el PATH. El panel de cambios necesita git instalado; el resto de la app funciona igual.',
      };
    }
    throw error;
  }

  if (lookup.state === 'not-a-repo') {
    return { ...base, message: 'Esta carpeta no esta dentro de un repositorio git.' };
  }
  if (lookup.state === 'error') {
    return { ...base, state: 'error', message: lookup.message };
  }
  const repoRoot = lookup.root;

  const [statusResult, worktreeResult] = await Promise.all([
    runGit(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal']),
    runGit(cwd, ['worktree', 'list', '--porcelain']),
  ]);

  if (statusResult.code !== 0) {
    return {
      ...base,
      state: 'error',
      repoRoot,
      message: statusResult.stderr.trim().slice(0, 400) || 'git status fallo.',
    };
  }

  const parsed = parsePorcelainV2(statusResult.stdout);

  return {
    state: 'ready',
    message: null,
    repoRoot,
    branch: parsed.branch,
    head: parsed.head,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    changes: parsed.changes,
    worktrees: worktreeResult.code === 0 ? parseWorktrees(worktreeResult.stdout, repoRoot) : [],
    truncated: parsed.truncated,
    updatedAt: Date.now(),
  };
}

/**
 * Convierte la salida de `git diff` en lineas numeradas.
 *
 * Los numeros salen de la cabecera de cada hunk (`@@ -a,b +c,d @@`) y avanzan
 * segun el tipo de linea. Es la unica forma de saber a que linea del archivo
 * corresponde cada una: el diff no las trae.
 */
export function parseUnifiedDiff(raw: string): { lines: DiffLine[]; truncated: boolean; binary: boolean } {
  const lines: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let binary = false;
  let truncated = false;

  for (const text of raw.split('\n')) {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    // El ultimo split de un texto terminado en \n da una cadena vacia.
    if (text.length === 0) continue;

    if (text.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (match !== null) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      lines.push({ kind: 'hunk', text, oldLine: null, newLine: null });
      continue;
    }

    if (
      text.startsWith('diff ') ||
      text.startsWith('index ') ||
      text.startsWith('--- ') ||
      text.startsWith('+++ ') ||
      text.startsWith('new file') ||
      text.startsWith('deleted file') ||
      text.startsWith('old mode') ||
      text.startsWith('new mode') ||
      text.startsWith('similarity index') ||
      text.startsWith('rename ')
    ) {
      if (text.startsWith('Binary files') || text.includes('GIT binary patch')) binary = true;
      lines.push({ kind: 'meta', text, oldLine: null, newLine: null });
      continue;
    }

    if (text.startsWith('Binary files') || text.startsWith('GIT binary patch')) {
      binary = true;
      lines.push({ kind: 'meta', text, oldLine: null, newLine: null });
      continue;
    }

    // `\ No newline at end of file` no es una linea del archivo.
    if (text.startsWith('\\')) {
      lines.push({ kind: 'meta', text, oldLine: null, newLine: null });
      continue;
    }

    const marker = text[0];
    const body = text.slice(1);

    if (marker === '+') {
      lines.push({ kind: 'added', text: body, oldLine: null, newLine });
      newLine += 1;
    } else if (marker === '-') {
      lines.push({ kind: 'removed', text: body, oldLine, newLine: null });
      oldLine += 1;
    } else {
      lines.push({ kind: 'context', text: body, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }

  return { lines, truncated, binary };
}

/** true si el contenido tiene pinta de binario (un NUL en el primer bloque). */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_000);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

/**
 * Un archivo sin seguimiento no tiene diff: git no conoce ninguna version
 * anterior. En vez de mostrar un panel vacio, se muestra el archivo entero como
 * lineas agregadas, que es lo que efectivamente se va a agregar.
 */
async function readUntrackedAsDiff(absolutePath: string, relativePath: string): Promise<GitDiff> {
  let content: Buffer;
  try {
    content = await readFile(absolutePath);
  } catch {
    return {
      path: relativePath,
      staged: false,
      lines: [],
      truncated: false,
      binary: false,
      message: 'No se pudo leer el archivo.',
    };
  }

  if (looksBinary(content)) {
    return {
      path: relativePath,
      staged: false,
      lines: [],
      truncated: false,
      binary: true,
      message: 'Archivo binario sin seguimiento.',
    };
  }

  const truncatedByBytes = content.length > MAX_DIFF_BYTES;
  const text = content.subarray(0, MAX_DIFF_BYTES).toString('utf8');
  const rawLines = text.split(/\r?\n/);
  const lines: DiffLine[] = [];
  let truncated = truncatedByBytes;

  for (let index = 0; index < rawLines.length; index += 1) {
    if (lines.length >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    const value = rawLines[index];
    if (value === undefined) continue;
    if (index === rawLines.length - 1 && value.length === 0) continue;
    lines.push({ kind: 'added', text: value, oldLine: null, newLine: index + 1 });
  }

  return {
    path: relativePath,
    staged: false,
    lines,
    truncated,
    binary: false,
    message: lines.length === 0 ? 'Archivo nuevo y vacio.' : null,
  };
}

export interface ReadDiffOptions {
  repoRoot: string;
  /** Ruta relativa a la raiz del repo. */
  relativePath: string;
  staged: boolean;
  /** true si el archivo no tiene seguimiento: ahi git no da diff. */
  untracked: boolean;
}

export async function readDiff(options: ReadDiffOptions): Promise<GitDiff> {
  const { repoRoot, relativePath, staged, untracked } = options;

  if (untracked && !staged) {
    return readUntrackedAsDiff(path.join(repoRoot, relativePath), relativePath);
  }

  const args = [
    'diff',
    '--no-color',
    '--no-ext-diff',
    // Sin esto, un repo con `core.pager` o `diff.external` configurado devuelve
    // cualquier cosa menos un diff unificado.
    '--unified=3',
    ...(staged ? ['--cached'] : []),
    '--',
    relativePath,
  ];

  const result = await runGit(repoRoot, args);
  if (result.code !== 0 && result.stdout.length === 0) {
    return {
      path: relativePath,
      staged,
      lines: [],
      truncated: false,
      binary: false,
      message: result.stderr.trim().slice(0, 300) || 'git diff fallo.',
    };
  }

  const capped = result.stdout.length > MAX_DIFF_BYTES;
  const parsed = parseUnifiedDiff(result.stdout.slice(0, MAX_DIFF_BYTES));

  return {
    path: relativePath,
    staged,
    lines: parsed.lines,
    truncated: parsed.truncated || capped,
    binary: parsed.binary,
    message:
      parsed.lines.length === 0
        ? staged
          ? 'No hay cambios preparados para este archivo.'
          : 'No hay cambios sin preparar para este archivo.'
        : null,
  };
}

/**
 * Filtra por `.gitignore` una tanda de rutas.
 *
 * `check-ignore --stdin -z` resuelve de una vez todo un nivel del arbol y
 * respeta la cadena completa de reglas: el `.gitignore` del repo, los de cada
 * subdirectorio, el global del usuario y `.git/info/exclude`. Reimplementar eso
 * con globs a mano sale mal en cuanto aparece una negacion (`!algo`).
 *
 * Devuelve el conjunto de rutas ignoradas. Si git no esta o falla, devuelve un
 * conjunto vacio: el arbol se muestra igual, con la lista fija de exclusiones.
 */
export async function filterIgnored(
  repoRoot: string,
  relativePaths: readonly string[],
): Promise<Set<string>> {
  const ignored = new Set<string>();
  if (relativePaths.length === 0) return ignored;

  const result = await new Promise<GitResult | null>((resolve) => {
    const child = execFile(
      'git',
      ['-c', 'core.quotepath=false', 'check-ignore', '--stdin', '-z'],
      { cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout, stderr) => {
        if (error !== null && isMissingBinary(error)) {
          resolve(null);
          return;
        }
        resolve({ stdout, stderr, code: 0 });
      },
    );
    child.stdin?.on('error', () => {
      /* El proceso pudo morir antes de leer. No es fatal. */
    });
    child.stdin?.end(relativePaths.join('\0') + '\0');
  });

  if (result === null) return ignored;
  for (const line of result.stdout.split('\0')) {
    if (line.length > 0) ignored.add(toPosix(line));
  }
  return ignored;
}
