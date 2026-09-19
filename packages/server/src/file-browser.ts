/**
 * Arbol de archivos del `cwd` de una pestana, y previsualizacion de solo
 * lectura.
 *
 * Solo lectura de verdad: no hay crear, renombrar, mover ni borrar. Lo que
 * cambia archivos lo hace el agente en la terminal, y ahi queda registrado en
 * la conversacion. Un boton de borrar en el panel produciria cambios que no
 * aparecen en ningun historial.
 *
 * Un nivel por peticion. Un `readdir` recursivo de un repo real con
 * `node_modules` son cientos de miles de entradas para dibujar veinte.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  DirectoryEntry,
  DirectoryListing,
  FilePreview,
  FileSearchResult,
  HiddenReason,
} from '@agent-workbench/shared';
import { filterIgnored, findRepoRoot } from './git-repo.js';
import { resolveInside, toPosixPath } from './path-guard.js';

/** Tope por directorio. Un `node_modules` sin ignorar tiene decenas de miles. */
const MAX_ENTRIES = 1_000;

/**
 * Topes de la busqueda por nombre, los tres a la vez.
 *
 * Cualquiera de los tres solo se queda corto en algun repo: uno con pocas
 * carpetas y archivos enormes agota el tiempo antes que los directorios, y uno
 * con `node_modules` sin ignorar agota los directorios en un parpadeo. Lo que
 * se corta se avisa, sin decir cual de los tres fue: para quien busca los tres
 * significan lo mismo.
 */
const SEARCH_MAX_RESULTS = 200;
const SEARCH_MAX_DIRECTORIES = 4_000;
const SEARCH_TIME_BUDGET_MS = 1_500;
/** Tope de la previsualizacion. El panel es para leer, no para abrir dumps. */
const MAX_PREVIEW_BYTES = 512 * 1024;

/**
 * Se saltan siempre, este o no en `.gitignore`.
 *
 * Son carpetas de artefactos: nadie las abre desde un explorador de proyecto, y
 * `node_modules` por si sola hace inutil el arbol entero. Igual se cuentan en
 * `hiddenCount`, para que quede claro que se oculto algo y no parezca que el
 * directorio esta vacio.
 */
const ALWAYS_SKIP = new Set(['.git', 'node_modules', 'dist', 'bin', 'obj']);

/**
 * Extension -> lenguaje para el resaltado.
 *
 * La lista es corta a proposito: cubre lo que aparece en un proyecto real y
 * cada entrada tiene que estar registrada tambien en el cliente. Lo que no
 * este, se muestra en texto plano, que es un resultado perfectamente aceptable.
 */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'xml',
  '.htm': 'xml',
  '.xml': 'xml',
  '.svg': 'xml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'cpp',
  '.php': 'php',
  '.sql': 'sql',
  '.swift': 'swift',
  '.dockerfile': 'dockerfile',
};

/** Archivos sin extension que igual conviene resaltar. */
const LANGUAGE_BY_NAME: Readonly<Record<string, string>> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  '.gitignore': 'bash',
  '.env': 'bash',
};

export function languageFor(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  const byName = LANGUAGE_BY_NAME[lower];
  if (byName !== undefined) return byName;
  const extension = path.extname(lower);
  return LANGUAGE_BY_EXTENSION[extension] ?? null;
}

/** true si el buffer tiene un NUL en el primer bloque: no es texto. */
function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 8_000);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

function joinRelative(parent: string, name: string): string {
  return parent.length === 0 ? name : `${parent}/${name}`;
}

/**
 * Contenido de un nivel del arbol.
 *
 * `relativePath` viene del cliente y pasa por `resolveInside`: es lo unico que
 * impide que un `..` bien puesto convierta el explorador de proyecto en un
 * explorador del disco entero.
 */
export async function listDirectory(
  cwd: string,
  relativePath: string,
  options: { includeHidden?: boolean } = {},
): Promise<DirectoryListing> {
  const absolute = await resolveInside(cwd, relativePath, { mustExist: true });
  const repoRoot = await findRepoRoot(cwd).catch(() => null);
  const scanned = await scanLevel(absolute, repoRoot);

  const entries: DirectoryEntry[] = [];
  let hiddenCount = scanned.skipped;
  let truncated = false;

  for (const candidate of scanned.entries) {
    if (candidate.hidden !== null && options.includeHidden !== true) {
      hiddenCount += 1;
      continue;
    }

    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }

    let sizeBytes = 0;
    let modifiedAt = 0;
    try {
      const info = await stat(path.join(absolute, candidate.name));
      sizeBytes = candidate.isDirectory ? 0 : info.size;
      modifiedAt = info.mtimeMs;
    } catch {
      // Un archivo que desaparecio entre el readdir y el stat se lista igual,
      // sin metadatos. Es preferible a perder el nivel entero.
    }

    const entry: DirectoryEntry = {
      name: candidate.name,
      path: joinRelative(relativePath, candidate.name),
      kind: candidate.isDirectory ? 'dir' : 'file',
      sizeBytes,
      modifiedAt,
    };
    entries.push(candidate.hidden === null ? entry : { ...entry, hidden: candidate.hidden });
  }

  // Directorios primero y despues alfabetico, que es como se lee un arbol.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { path: relativePath, entries, truncated, hiddenCount };
}

/** Una entrada de un nivel, ya con el motivo por el que estaria escondida. */
interface ScannedEntry {
  name: string;
  isDirectory: boolean;
  hidden: HiddenReason | null;
}

/**
 * Lee un nivel y marca —sin filtrar— lo que estaria escondido.
 *
 * Lo usan el arbol y la busqueda, y por eso no decide: marcar y filtrar son dos
 * cosas distintas, y el ojo del panel necesita justamente ver lo que la otra
 * descartaria.
 *
 * `skipped` son las entradas que no se pueden listar de ninguna forma —un
 * enlace roto, un socket—: no es que esten escondidas, es que no hay nada que
 * mostrar. Se cuentan igual para que un directorio con eso adentro no parezca
 * vacio.
 */
async function scanLevel(
  absolute: string,
  repoRoot: string | null,
): Promise<{ entries: ScannedEntry[]; skipped: number }> {
  const level = await readLevel(absolute);
  await markIgnored(repoRoot, [{ absolute, entries: level.entries }]);
  return level;
}

/** El `readdir` de un nivel, con la lista fija ya aplicada y sin tocar git. */
async function readLevel(absolute: string): Promise<{ entries: ScannedEntry[]; skipped: number }> {
  const dirents = await readdir(absolute, { withFileTypes: true });

  let skipped = 0;
  const candidates: ScannedEntry[] = [];

  for (const dirent of dirents) {
    const always = ALWAYS_SKIP.has(dirent.name.toLowerCase());

    // Un enlace simbolico se muestra segun a que apunte; si esta roto, se
    // omite en vez de aparecer como una entrada que no se puede abrir.
    if (dirent.isSymbolicLink()) {
      try {
        const target = await stat(path.join(absolute, dirent.name));
        candidates.push({
          name: dirent.name,
          isDirectory: target.isDirectory(),
          hidden: always ? 'always' : null,
        });
      } catch {
        skipped += 1;
      }
      continue;
    }
    if (!dirent.isDirectory() && !dirent.isFile()) {
      skipped += 1;
      continue;
    }
    candidates.push({
      name: dirent.name,
      isDirectory: dirent.isDirectory(),
      hidden: always ? 'always' : null,
    });
  }

  return { entries: candidates, skipped };
}

/**
 * Marca lo que dice `.gitignore`, en **una sola** llamada a git.
 *
 * Acepta varios directorios de una porque cada llamada es un proceso: el arbol
 * pide un nivel y gasta uno, pero la busqueda recorre decenas de directorios y
 * con un proceso por cada uno tardaba un segundo entero en este mismo repo. Se
 * le pasan todos los de una oleada juntos.
 *
 * Se consulta a git y no se reimplementa con globs porque la cadena de reglas
 * es larga —el `.gitignore` del repo, los de cada subdirectorio, el global del
 * usuario, `.git/info/exclude`— y una negacion (`!algo`) manda a la basura
 * cualquier version casera.
 */
async function markIgnored(
  repoRoot: string | null,
  levels: readonly { absolute: string; entries: ScannedEntry[] }[],
): Promise<void> {
  if (repoRoot === null) return;

  const keys = new Map<ScannedEntry, string>();
  for (const level of levels) {
    for (const entry of level.entries) {
      if (entry.hidden !== null) continue;
      keys.set(entry, toPosixPath(path.relative(repoRoot, path.join(level.absolute, entry.name))));
    }
  }
  if (keys.size === 0) return;

  const ignored = await filterIgnored(repoRoot, [...keys.values()]).catch(
    () => new Set<string>(),
  );
  for (const [entry, key] of keys) {
    if (ignored.has(key)) entry.hidden = 'ignored';
  }
}

/**
 * Busca archivos y carpetas por nombre, recorriendo en anchura.
 *
 * **En anchura y no en profundidad**: lo que uno busca casi siempre esta cerca
 * de la raiz del proyecto, y con un tope de directorios visitados, la anchura
 * gasta ese presupuesto en los niveles que importan en vez de hundirse en la
 * primera rama que encuentre.
 *
 * Se busca en el nombre, no en el contenido. Es lo que uno le pide a un arbol —
 * y buscar dentro de los archivos es otra herramienta, con otros topes y otra
 * forma de mostrar los resultados.
 */
export async function searchFiles(
  cwd: string,
  query: string,
  options: { includeHidden?: boolean } = {},
): Promise<FileSearchResult> {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return { query, entries: [], truncated: false };

  const repoRoot = await findRepoRoot(cwd).catch(() => null);
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;

  const found: { entry: DirectoryEntry; score: number }[] = [];
  /*
    Se avanza por **oleadas**: todos los directorios de una misma profundidad a
    la vez. No es una sutileza de estilo — `.gitignore` se consulta con un
    proceso de git por llamada, y preguntando de a un directorio la busqueda
    tardaba 1,1 s en este mismo repo. Por oleadas son cinco o seis procesos en
    total y baja a decenas de milisegundos.
  */
  let frontier: string[] = [''];
  let visited = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (found.length >= SEARCH_MAX_RESULTS || visited >= SEARCH_MAX_DIRECTORIES) {
      truncated = true;
      break;
    }
    if (Date.now() > deadline) {
      truncated = true;
      break;
    }

    const wave: { relative: string; absolute: string; entries: ScannedEntry[] }[] = [];

    for (const relative of frontier) {
      if (visited >= SEARCH_MAX_DIRECTORIES || Date.now() > deadline) {
        truncated = true;
        break;
      }
      visited += 1;

      let absolute: string;
      try {
        absolute = await resolveInside(cwd, relative, { mustExist: true });
      } catch {
        continue;
      }

      try {
        const level = await readLevel(absolute);
        wave.push({ relative, absolute, entries: level.entries });
      } catch {
        // Un directorio sin permiso no puede cortar la busqueda entera.
      }
    }

    await markIgnored(repoRoot, wave);

    const next: string[] = [];
    for (const level of wave) {
      for (const candidate of level.entries) {
        if (candidate.hidden !== null && options.includeHidden !== true) continue;

        const childPath = joinRelative(level.relative, candidate.name);
        if (candidate.isDirectory) next.push(childPath);

        const lower = candidate.name.toLowerCase();
        const at = lower.indexOf(needle);
        if (at === -1) continue;

        let sizeBytes = 0;
        let modifiedAt = 0;
        try {
          const info = await stat(path.join(level.absolute, candidate.name));
          sizeBytes = candidate.isDirectory ? 0 : info.size;
          modifiedAt = info.mtimeMs;
        } catch {
          // Igual que en el arbol: se lista sin metadatos antes que perderlo.
        }

        const entry: DirectoryEntry = {
          name: candidate.name,
          path: childPath,
          kind: candidate.isDirectory ? 'dir' : 'file',
          sizeBytes,
          modifiedAt,
        };

        found.push({
          entry: candidate.hidden === null ? entry : { ...entry, hidden: candidate.hidden },
          // Un nombre que *empieza* con lo que se escribio es casi siempre el
          // que se buscaba; despues, lo que este mas arriba en el arbol.
          score: (at === 0 ? 0 : 1_000) + at + childPath.split('/').length,
        });
      }
    }

    frontier = next;
  }

  found.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return a.entry.path.localeCompare(b.entry.path, undefined, { sensitivity: 'base' });
  });

  return {
    query,
    entries: found.slice(0, SEARCH_MAX_RESULTS).map((hit) => hit.entry),
    truncated: truncated || found.length > SEARCH_MAX_RESULTS,
  };
}

/** Previsualizacion recortada de un archivo del `cwd`. */
export async function readPreview(cwd: string, relativePath: string): Promise<FilePreview> {
  const absolute = await resolveInside(cwd, relativePath, { mustExist: true });

  const info = await stat(absolute);
  if (info.isDirectory()) {
    throw new Error("It's a directory, not a file.");
  }

  const content = await readFile(absolute);
  const fileName = path.basename(absolute);

  if (looksBinary(content)) {
    return {
      path: relativePath,
      language: null,
      text: '',
      sizeBytes: info.size,
      truncated: false,
      binary: true,
    };
  }

  const truncated = content.length > MAX_PREVIEW_BYTES;
  return {
    path: relativePath,
    language: languageFor(fileName),
    text: content.subarray(0, MAX_PREVIEW_BYTES).toString('utf8'),
    sizeBytes: info.size,
    truncated,
    binary: false,
  };
}
