/**
 * Lo ignorado que va a una rama aparte, y lo que vuelve al quitarla (hito 48,
 * §6.38, decisión 2 del plan).
 *
 * Una rama aparte sale de git, y git no trae lo que el repo ignora: en este
 * mismo repo, el agente de la rama arrancaría sin `CLAUDE.md` y sin `docs/`.
 * Se copia, al crearla:
 *
 *  - lo que pide el `.worktreeinclude` de la carpeta principal (la convención
 *    de Claude Code, la app de Codex, Conductor y Worktrunk: sintaxis de
 *    `.gitignore`, y sólo archivos que el repo ignora);
 *  - si el usuario lo deja marcado, las instrucciones y la memoria que el repo
 *    ignora (`NOTE_PATTERNS`).
 *
 * **Nunca la configuración de una CLI** (`CLI_CONFIG_DIRS`, `CLI_CONFIG_FILES`),
 * aunque el archivo la pida: un `settings.local.json` puede traer claves en su
 * `env`, y copiarlas es lo que §2.1 prohíbe. Cada archivo pasa por el guardia
 * de rutas contra la carpeta principal, y un enlace no se sigue ni se copia (la
 * lección de §6.15).
 *
 * Al quitar la rama, `git worktree remove` borra lo ignorado sin avisar
 * (medido), así que antes se mira qué notas cambiaron: las que sólo cambiaron
 * en la rama vuelven a la principal, y desde el 21-10-2026 las que cambiaron en
 * los dos lados se juntan, con la copia de cómo estaban al copiarse
 * (`note-bases.ts`, `merge-notes.ts`). Sólo las que no se pueden juntar no se
 * tocan, y la rama no se quita sin que el usuario lo decida. Lo mismo al
 * integrar: las notas viajan con los commits.
 */

import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  WORKTREE_COPY_MAX_BYTES,
  WORKTREE_COPY_MAX_FILES,
  WORKTREE_COPY_SAMPLE,
  type WorktreeCopySummary,
} from '@agent-workbench/shared';
import { writeAtomically } from '../atomic-write.js';
import { resolveInside } from '../path-guard.js';
import { ignoredAmong, ignoredSelection } from './git.js';
import { mergeNote } from './merge-notes.js';
import type { NoteBases } from './note-bases.js';

/** Las instrucciones y la memoria que se copian si el repo las ignora. Ancladas a la raíz. */
export const NOTE_PATTERNS: readonly string[] = ['/CLAUDE.md', '/AGENTS.md', '/CLAUDE.local.md', '/.agents/memory/'];

/** Los archivos sueltos de `NOTE_PATTERNS`: los que se buscan también al quitar, aunque no se hayan copiado. */
const NOTE_ROOT_FILES: readonly string[] = ['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md'];

/** Las carpetas de configuración de las CLIs dentro de un proyecto. No se copian nunca. */
export const CLI_CONFIG_DIRS: ReadonlySet<string> = new Set(['.claude', '.codex', '.gemini', '.opencode', '.pi']);
/** Y sus archivos sueltos. */
export const CLI_CONFIG_FILES: ReadonlySet<string> = new Set(['.mcp.json', 'opencode.json', 'opencode.jsonc']);

/** El archivo con los patrones de lo que se copia. */
export const INCLUDE_FILE = '.worktreeinclude';
/** Un `.worktreeinclude` de más que esto no es una lista de patrones. */
const INCLUDE_FILE_MAX_BYTES = 64 * 1024;

export interface CopyFile {
  /** Relativa a la raíz, con `/`. */
  path: string;
  bytes: number;
}

export interface CopySelection {
  files: CopyFile[];
  /** Las carpetas que se eligieron enteras (`docs/`): lo nuevo adentro también vuelve. */
  dirs: string[];
  bytes: number;
  overCap: boolean;
}

export interface CopyPlan {
  /** Lo del `.worktreeinclude`; null si la carpeta principal no tiene uno. */
  include: CopySelection | null;
  notes: CopySelection;
}

/** Lo que se copió de un archivo, con la huella de su contenido en ese momento. */
export interface CopiedFile {
  path: string;
  hash: string;
}

const toPosix = (value: string): string => value.split(path.sep).join('/');

export function hashOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** true si alguna parte de la ruta es configuración de una CLI. */
export function isCliConfigPath(relative: string): boolean {
  const parts = relative.split('/').filter((part) => part.length > 0);
  if (parts.some((part) => CLI_CONFIG_DIRS.has(part.toLowerCase()))) return true;
  const last = parts[parts.length - 1];
  return last !== undefined && CLI_CONFIG_FILES.has(last.toLowerCase());
}

/** El `.worktreeinclude` de la carpeta principal, si es un archivo de verdad dentro de ella. */
async function includeFileOf(mainRoot: string): Promise<string | null> {
  let absolute: string;
  try {
    absolute = await resolveInside(mainRoot, INCLUDE_FILE, { mustExist: true });
  } catch {
    return null;
  }
  try {
    const info = await lstat(absolute);
    if (!info.isFile() || info.size > INCLUDE_FILE_MAX_BYTES) return null;
  } catch {
    return null;
  }
  return absolute;
}

/**
 * Los archivos debajo de una entrada de la selección, con su tamaño. Recorre
 * con `lstat` y no entra a ningún enlace (una junction de pnpm, un enlace hacia
 * afuera), ni a `.git` ni a la configuración de una CLI. Corta al pasar el tope:
 * no hace falta contar un `node_modules` entero para saber que no entra.
 */
async function walkEntry(
  mainRoot: string,
  relative: string,
  out: CopyFile[],
  budget: { files: number; bytes: number },
): Promise<void> {
  if (budget.files > WORKTREE_COPY_MAX_FILES || budget.bytes > WORKTREE_COPY_MAX_BYTES) return;
  const clean = relative.replace(/\/+$/, '');
  if (clean.length === 0 || isCliConfigPath(clean) || clean.split('/').includes('.git')) return;
  let absolute: string;
  try {
    absolute = await resolveInside(mainRoot, clean, { mustExist: true });
  } catch {
    return;
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    out.push({ path: clean, bytes: info.size });
    budget.files += 1;
    budget.bytes += info.size;
    return;
  }
  if (!info.isDirectory()) return;
  let names: string[];
  try {
    names = (await readdir(absolute)).sort();
  } catch {
    return;
  }
  for (const name of names) await walkEntry(mainRoot, `${clean}/${name}`, out, budget);
}

async function selectionFor(mainRoot: string, entries: readonly string[]): Promise<CopySelection> {
  const files: CopyFile[] = [];
  const dirs: string[] = [];
  const budget = { files: 0, bytes: 0 };
  for (const entry of entries) {
    const clean = toPosix(entry);
    if (isCliConfigPath(clean.replace(/\/+$/, ''))) continue;
    if (clean.endsWith('/')) dirs.push(clean.replace(/\/+$/, ''));
    await walkEntry(mainRoot, clean, files, budget);
  }
  const overCap = budget.files > WORKTREE_COPY_MAX_FILES || budget.bytes > WORKTREE_COPY_MAX_BYTES;
  return { files, dirs, bytes: budget.bytes, overCap };
}

/** Lo que se copiaría, sin copiar nada. null si git no pudo contestar. */
export async function planCopy(mainRoot: string): Promise<CopyPlan | null> {
  const includeFile = await includeFileOf(mainRoot);
  const [includeEntries, noteEntries] = await Promise.all([
    includeFile === null ? Promise.resolve([]) : ignoredSelection(mainRoot, includeFile, []),
    ignoredSelection(mainRoot, null, NOTE_PATTERNS),
  ]);
  if (includeEntries === null || noteEntries === null) return null;
  const include = includeFile === null ? null : await selectionFor(mainRoot, includeEntries);
  // Lo que ya entra por el `.worktreeinclude` no se cuenta dos veces.
  const already = new Set(include?.files.map((file) => file.path) ?? []);
  const notesAll = await selectionFor(mainRoot, noteEntries);
  const notesFiles = notesAll.files.filter((file) => !already.has(file.path));
  const notes: CopySelection = {
    files: notesFiles,
    dirs: notesAll.dirs,
    bytes: notesFiles.reduce((total, file) => total + file.bytes, 0),
    overCap: notesAll.overCap,
  };
  return { include, notes };
}

export function summarize(selection: CopySelection): WorktreeCopySummary {
  return {
    files: selection.files.length,
    bytes: selection.bytes,
    overCap: selection.overCap,
    sample: selection.files.slice(0, WORKTREE_COPY_SAMPLE).map((file) => file.path),
  };
}

/**
 * Copia los archivos de la principal a la rama recién creada, y devuelve la
 * huella de cada uno. Lee con el guardia contra la principal y escribe con el
 * guardia contra la rama; un archivo que ya existe en la rama (porque la rama
 * lo versiona) no se pisa. Con `bases`, guarda además la copia de origen de
 * cada nota de texto, para juntarla después si cambia en los dos lados.
 */
export async function copyToWorktree(
  mainRoot: string,
  folder: string,
  files: readonly CopyFile[],
  bases?: NoteBases,
): Promise<CopiedFile[]> {
  const copied: CopiedFile[] = [];
  for (const file of files) {
    let content: Buffer;
    try {
      const source = await resolveInside(mainRoot, file.path, { mustExist: true });
      const info = await lstat(source);
      if (!info.isFile()) continue;
      content = await readFile(source);
      const target = await resolveInside(folder, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      // `wx`: si la rama ya lo tiene, es suyo.
      await writeFile(target, content, { flag: 'wx' });
      copied.push({ path: file.path, hash: hashOf(content) });
    } catch (error) {
      console.warn(`[worktrees] ${file.path} wasn't copied to the branch folder:`, error);
      continue;
    }
    // Sin la copia de origen, esa nota se pregunta como antes: no frena la rama.
    await bases?.save(file.path, content).catch((error: unknown) => {
      console.warn(`[worktrees] the original of ${file.path} wasn't kept:`, error);
    });
  }
  return copied;
}

/** El contenido de un archivo de verdad dentro de `root`, o null si no está (o no es un archivo). */
async function readInside(root: string, relative: string): Promise<Buffer | null> {
  try {
    const absolute = await resolveInside(root, relative, { mustExist: true });
    const info = await lstat(absolute);
    if (!info.isFile()) return null;
    return await readFile(absolute);
  } catch {
    return null;
  }
}

/**
 * true si la principal ya tiene cada línea de la versión de la rama. Es el
 * caso de una nota que se actualizó en los dos lados con lo mismo (o que la
 * principal ya trajo): no hay nada que salvar.
 */
export function containsAllLines(main: string, branch: string): boolean {
  const have = new Set(main.split(/\r?\n/));
  return branch.split(/\r?\n/).every((line) => line.length === 0 || have.has(line));
}

/**
 * `return`: vuelve la versión de la rama tal cual. `merge`: vuelven las dos
 * juntas. `conflict`: cambió en los dos lados y no se pudo juntar.
 */
export type NoteVerdict = 'unchanged' | 'return' | 'merge' | 'conflict';

export interface NoteOutcome {
  verdict: NoteVerdict;
  /** Lo que se escribe en la principal: la versión de la rama (`return`) o las dos juntas (`merge`). */
  content: Buffer | null;
}

const UNCHANGED: NoteOutcome = { verdict: 'unchanged', content: null };

/**
 * Qué hacer con una nota de la rama al quitarla o integrarla. Pura: la prueba
 * el chequeo.
 *
 * `base` es la huella de cuando se copió (o de cuando volvió por última vez a
 * la principal), o null si la nota nació en la rama. `baseContent` es la copia
 * de origen con esa huella (`note-bases.ts`): con ella, una nota que cambió en
 * los dos lados se junta; sin ella, choca.
 */
export function noteOutcome(base: string | null, branch: Buffer, main: Buffer | null, baseContent: Buffer | null = null): NoteOutcome {
  const branchHash = hashOf(branch);
  if (base !== null && branchHash === base) return UNCHANGED;
  if (main === null) return { verdict: 'return', content: branch };
  const mainHash = hashOf(main);
  if (mainHash === branchHash) return UNCHANGED;
  if (base !== null && mainHash === base) return { verdict: 'return', content: branch };
  if (base !== null && baseContent !== null && hashOf(baseContent) === base) {
    const merged = mergeNote(baseContent, main, branch);
    // Juntas dan la principal: lo de la rama ya estaba.
    if (merged !== null) return merged.equals(main) ? UNCHANGED : { verdict: 'merge', content: merged };
  }
  if (containsAllLines(main.toString('utf8'), branch.toString('utf8'))) return UNCHANGED;
  return { verdict: 'conflict', content: null };
}

export function noteVerdict(base: string | null, branch: Buffer, main: Buffer | null, baseContent: Buffer | null = null): NoteVerdict {
  return noteOutcome(base, branch, main, baseContent).verdict;
}

/** La copia de origen de una huella, si la hay. */
export type LoadNoteBase = (hash: string) => Promise<Buffer | null>;

/** Como `noteOutcome`, pero busca la copia de origen sólo cuando hace falta: si la nota cambió en los dos lados. */
async function outcomeOf(base: string | null, branch: Buffer, main: Buffer | null, loadBase?: LoadNoteBase): Promise<NoteOutcome> {
  const bothChanged = base !== null && main !== null && hashOf(branch) !== base && hashOf(main) !== base && !main.equals(branch);
  const baseContent = bothChanged && loadBase !== undefined ? await loadBase(base) : null;
  return noteOutcome(base, branch, main, baseContent);
}

export interface NoteReview {
  /** Las que se escriben en la principal: vuelven tal cual o se juntan. */
  returning: string[];
  /** De `returning`, las que se juntan con lo que cambió en la principal. */
  merging: string[];
  conflicts: string[];
}

/** Los archivos debajo de una carpeta de la rama, relativos a la rama. Sin seguir enlaces. */
async function filesUnder(folder: string, relative: string, out: string[]): Promise<void> {
  if (out.length > WORKTREE_COPY_MAX_FILES) return;
  let absolute: string;
  try {
    absolute = await resolveInside(folder, relative, { mustExist: true });
  } catch {
    return;
  }
  let info;
  try {
    info = await lstat(absolute);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (info.isFile()) {
    out.push(relative);
    return;
  }
  if (!info.isDirectory()) return;
  for (const name of (await readdir(absolute).catch(() => [] as string[])).sort()) {
    await filesUnder(folder, `${relative}/${name}`, out);
  }
}

/**
 * Las notas de una rama que cambiaron: las que vuelven (tal cual o juntas) y
 * las que chocan.
 *
 * Se miran las que se copiaron, lo nuevo debajo de las carpetas copiadas
 * enteras y, si se copiaron las instrucciones, las de la raíz aunque no
 * estuvieran (el agente de la rama pudo crear un `CLAUDE.md`). **Sólo lo que
 * git ignora en la rama**: un `CLAUDE.md` versionado no es una nota, lo lleva
 * git, y contarlo hacía que integrar avisara en falso que se quedaba en la
 * rama (revisión del 21-10-2026).
 */
export async function reviewNotes(
  mainRoot: string,
  folder: string,
  record: { copied: readonly CopiedFile[]; copiedDirs: readonly string[]; copyNotes: boolean },
  loadBase?: LoadNoteBase,
): Promise<NoteReview> {
  const bases = new Map(record.copied.map((file) => [file.path, file.hash]));
  const candidates = new Set(bases.keys());
  for (const dir of record.copiedDirs) {
    const found: string[] = [];
    await filesUnder(folder, dir, found);
    for (const file of found) if (!isCliConfigPath(file)) candidates.add(file);
  }
  if (record.copyNotes) for (const file of NOTE_ROOT_FILES) candidates.add(file);
  // Si git no contesta, como antes: se miran todas.
  const ignored = await ignoredAmong(folder, [...candidates]);
  const notes = [...candidates].filter((file) => ignored === null || ignored.has(file)).sort();

  const returning: string[] = [];
  const merging: string[] = [];
  const conflicts: string[] = [];
  for (const file of notes) {
    const branch = await readInside(folder, file);
    // Borrada en la rama: no se borra en la principal.
    if (branch === null) continue;
    const { verdict } = await outcomeOf(bases.get(file) ?? null, branch, await readInside(mainRoot, file), loadBase);
    if (verdict === 'return' || verdict === 'merge') returning.push(file);
    if (verdict === 'merge') merging.push(file);
    else if (verdict === 'conflict') conflicts.push(file);
  }
  return { returning, merging, conflicts };
}

export interface ReturnedNotes {
  /** Las que se escribieron en la principal, tal cual o juntas. */
  returned: string[];
  /** De `returned`, las que se juntaron. */
  merged: string[];
  skipped: string[];
  /** Las que no se pudieron traer y se dejaron en la rama (sólo con `onConflict: 'skip'`). */
  conflicts: string[];
}

export interface ReturnNotesOptions {
  loadBase?: LoadNoteBase;
  /**
   * Una nota que choca desde el plan, o que no se pudo escribir. Al quitar la
   * rama, `throw`: no se quita, o se perdería lo suyo. Al integrar, `skip`: los
   * commits ya entraron, y la nota se queda en la rama hasta que se quite.
   */
  onConflict?: 'throw' | 'skip';
  /**
   * Se llama apenas se escribe cada nota, con la versión de la rama: la
   * principal ya la tiene, y pasa a ser su origen. Si se anotara al final, un
   * fallo con otra nota dejaba ésta con el origen viejo, y el reintento la
   * juntaba otra vez (revisión del 21-10-2026). Un fallo acá no deshace nada.
   */
  onWritten?: (file: string, branch: Buffer) => Promise<void>;
}

/**
 * Devuelve a la principal las notas que cambiaron en la rama, tal cual o
 * juntas con lo que cambió allá, con escritura atómica. Justo antes de cada
 * reemplazo se vuelve a mirar la principal: si cambió desde que se leyó, esa
 * nota no se pisa.
 */
export async function returnNotes(
  mainRoot: string,
  folder: string,
  files: readonly string[],
  bases: ReadonlyMap<string, string>,
  options: ReturnNotesOptions = {},
): Promise<ReturnedNotes> {
  const result: ReturnedNotes = { returned: [], merged: [], skipped: [], conflicts: [] };
  for (const file of files) {
    try {
      const branch = await readInside(folder, file);
      if (branch === null) {
        result.skipped.push(file);
        continue;
      }
      const target = await resolveInside(mainRoot, file);
      const mainBefore = await readInside(mainRoot, file);
      const outcome = await outcomeOf(bases.get(file) ?? null, branch, mainBefore, options.loadBase);
      if (outcome.verdict === 'conflict') throw new Error(`${file} changed in the main folder since the plan`);
      if (outcome.content === null) {
        result.skipped.push(file);
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeAtomically(target, outcome.content, {
        beforeRename: async () => {
          const now = await readInside(mainRoot, file);
          const same = now === null ? mainBefore === null : mainBefore !== null && hashOf(now) === hashOf(mainBefore);
          if (!same) throw new Error(`${file} changed in the main folder while it was being returned`);
        },
      });
      result.returned.push(file);
      if (outcome.verdict === 'merge') result.merged.push(file);
      await options.onWritten?.(file, branch).catch((error: unknown) => {
        console.warn(`[worktrees] ${file} went back, but its new original wasn't noted:`, error);
      });
    } catch (error) {
      if (options.onConflict !== 'skip') throw error;
      result.conflicts.push(file);
    }
  }
  return result;
}
