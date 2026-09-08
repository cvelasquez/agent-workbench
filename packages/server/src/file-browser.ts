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
import type { DirectoryEntry, DirectoryListing, FilePreview } from '@agent-workbench/shared';
import { filterIgnored, findRepoRoot } from './git-repo.js';
import { resolveInside, toPosixPath } from './path-guard.js';

/** Tope por directorio. Un `node_modules` sin ignorar tiene decenas de miles. */
const MAX_ENTRIES = 1_000;
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
): Promise<DirectoryListing> {
  const absolute = await resolveInside(cwd, relativePath, { mustExist: true });

  const dirents = await readdir(absolute, { withFileTypes: true });

  let hiddenCount = 0;
  const candidates: { name: string; isDirectory: boolean }[] = [];

  for (const dirent of dirents) {
    if (ALWAYS_SKIP.has(dirent.name.toLowerCase())) {
      hiddenCount += 1;
      continue;
    }
    // Un enlace simbolico se muestra segun a que apunte; si esta roto, se
    // omite en vez de aparecer como una entrada que no se puede abrir.
    if (dirent.isSymbolicLink()) {
      try {
        const target = await stat(path.join(absolute, dirent.name));
        candidates.push({ name: dirent.name, isDirectory: target.isDirectory() });
      } catch {
        hiddenCount += 1;
      }
      continue;
    }
    if (!dirent.isDirectory() && !dirent.isFile()) {
      hiddenCount += 1;
      continue;
    }
    candidates.push({ name: dirent.name, isDirectory: dirent.isDirectory() });
  }

  // `.gitignore` se consulta en una sola llamada para todo el nivel.
  const repoRoot = await findRepoRoot(cwd).catch(() => null);
  let ignored = new Set<string>();
  if (repoRoot !== null && candidates.length > 0) {
    const fromRepoRoot = candidates.map((candidate) =>
      toPosixPath(path.relative(repoRoot, path.join(absolute, candidate.name))),
    );
    ignored = await filterIgnored(repoRoot, fromRepoRoot).catch(() => new Set<string>());
  }

  const entries: DirectoryEntry[] = [];
  let truncated = false;

  for (const candidate of candidates) {
    if (repoRoot !== null) {
      const fromRepoRoot = toPosixPath(
        path.relative(repoRoot, path.join(absolute, candidate.name)),
      );
      if (ignored.has(fromRepoRoot)) {
        hiddenCount += 1;
        continue;
      }
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

    entries.push({
      name: candidate.name,
      path: joinRelative(relativePath, candidate.name),
      kind: candidate.isDirectory ? 'dir' : 'file',
      sizeBytes,
      modifiedAt,
    });
  }

  // Directorios primero y despues alfabetico, que es como se lee un arbol.
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return { path: relativePath, entries, truncated, hiddenCount };
}

/** Previsualizacion recortada de un archivo del `cwd`. */
export async function readPreview(cwd: string, relativePath: string): Promise<FilePreview> {
  const absolute = await resolveInside(cwd, relativePath, { mustExist: true });

  const info = await stat(absolute);
  if (info.isDirectory()) {
    throw new Error('Es un directorio, no un archivo.');
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
