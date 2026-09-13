/**
 * El puente de la memoria compartida: `<proyecto>/.agents/memory/`.
 *
 * **Es la unica escritura de la app dentro de un proyecto**, y por eso esta
 * encerrada en reglas que no se negocian:
 *
 *  1. Todo se escribe dentro del `cwd`. Antes de la primera escritura se valida
 *     el plan entero con `resolveInside`: un `.agents` que sea un enlace o una
 *     junction hacia afuera se rechaza y no se escribe nada. Y lo que se va a
 *     escribir tampoco se **lee** si resuelve afuera (CLAUDE.md 2.1).
 *  2. En los archivos de instrucciones solo se toca lo que esta entre las
 *     marcas, y una marca solo cuenta si ocupa su propia linea fuera de un
 *     bloque de codigo. Fuera de ellas el contenido queda byte a byte igual —
 *     por eso se trabaja sobre `Buffer` y no se decodifica y vuelve a codificar
 *     el archivo—, y un archivo que no esta en UTF-8 no se toca.
 *  3. Nunca se pisa una nota ni un `MEMORY.md` que ya existen.
 *  4. Escritura atomica: temporal exclusivo y de nombre aleatorio en la misma
 *     carpeta, y `rename`.
 *  5. Idempotente: instalar dos veces deja lo mismo y la segunda no cambia nada.
 *
 * Lo que **no** hace: escribir lo global. `~/.agents/global.md` y los archivos
 * de cada CLI en el home son del usuario; aca solo se arma el texto para que
 * lo copie. De `~/.claude/` se lee una carpeta mas —la memoria nativa de cada
 * proyecto, dentro de `projects/`— y no se escribe nada (CLAUDE.md 2.1).
 *
 * Las funciones reciben el `home` para que el chequeo pueda usar uno falso.
 */

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  GLOBAL_MEMORY_RELATIVE,
  MEMORY_AGENT_LABELS,
  MEMORY_BLOCK_END,
  MEMORY_BLOCK_START,
  MEMORY_DIR,
  MEMORY_INDEX_FILE,
  MEMORY_INDEX_TEMPLATE,
  MEMORY_INSTRUCTION_FILES,
  memoryBlock,
  type MemoryAgentReach,
  type MemoryChange,
  type MemoryChangeAction,
  type MemoryFileProblem,
  type MemoryFileState,
  type MemoryGitState,
  type MemoryGlobalFragment,
  type MemoryInstallOptions,
  type MemoryInstructionFile,
  type MemoryNote,
  type MemoryNoteContent,
  type MemoryStatus,
} from '@agent-workbench/shared';
import { InvalidPathError, resolveInside } from './path-guard.js';
import { projectSlugFor } from './paths.js';

/** Un fallo que se le explica al usuario tal cual. */
export class MemoryBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryBridgeError';
  }
}

/** Tope de notas que viajan en el estado. Mas que esto no es una memoria. */
const MAX_LISTED_NOTES = 500;
/** Tope de una nota abierta. El mismo que los planes. */
const MAX_NOTE_BYTES = 256 * 1024;
/** Lo que se lee de cada nota para sacar el titulo y la descripcion. */
const NOTE_HEAD_BYTES = 16 * 1024;
const GIT_TIMEOUT_MS = 15_000;
/** Reintentos del `rename` en Windows, donde un antivirus puede tener el temporal abierto. */
const RENAME_ATTEMPTS = 5;
const RENAME_BACKOFF_MS = 40;
/** Intentos de crear un temporal con nombre libre. Chocar dos veces ya no es azar. */
const TEMPORARY_ATTEMPTS = 5;

const INDEX_REL = `${MEMORY_DIR}/${MEMORY_INDEX_FILE}`;
const AGENTS_DIR_REL = MEMORY_DIR.split('/')[0] ?? '.agents';
const GITIGNORE_REL = '.gitignore';
const GITIGNORE_COMMENT = '# Memoria compartida de los agentes (Agent Workbench)';
const GITIGNORE_MEMORY_LINE = `${MEMORY_DIR}/`;

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

type Eol = '\n' | '\r\n';

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** Estado del puente. **No crea nada**: ni carpetas, ni archivos, ni el indice. */
export async function inspectMemory(cwd: string, home: string = homedir()): Promise<MemoryStatus> {
  await assertMemoryDirInside(cwd);

  const folder = path.join(cwd, MEMORY_DIR);
  const folderExists = await isDirectory(folder);
  const indexExists = folderExists && (await isFile(path.join(folder, MEMORY_INDEX_FILE)));
  const noteNames = folderExists ? await listNoteFiles(folder) : [];
  const notes = await describeNotes(folder, noteNames);

  const files = await Promise.all(
    MEMORY_INSTRUCTION_FILES.map((name) => inspectInstructionFile(cwd, name)),
  );
  const { state: git } = await readGit(cwd);
  const native = await countNativeMemory(cwd, home, noteNames);

  return {
    cwd,
    folderExists,
    indexExists,
    installed: folderExists && indexExists && files.some((file) => file.hasBlock),
    notes,
    files,
    git,
    reach: computeReach(folderExists, indexExists, files),
    native,
    globalFragments: buildGlobalFragments(home),
  };
}

/** Lo que haria `installMemory`, sin escribir nada. */
export async function planMemoryInstall(
  cwd: string,
  options: MemoryInstallOptions,
  home: string = homedir(),
): Promise<MemoryChange[]> {
  const plan = await buildInstallPlan(cwd, options, home);
  return plan.changes();
}

/**
 * Aplica la instalacion y devuelve lo que cambio.
 *
 * El plan se rehace aca y no se confia en el que vio el cliente: entre la
 * previsualizacion y la confirmacion el disco pudo cambiar.
 */
export async function installMemory(
  cwd: string,
  options: MemoryInstallOptions,
  home: string = homedir(),
): Promise<MemoryChange[]> {
  const plan = await buildInstallPlan(cwd, options, home);
  await plan.apply();
  return plan.changes();
}

/**
 * Copia la memoria nativa de Claude Code a la carpeta compartida.
 *
 * Solo lo que falta: un nombre que ya existe con otro contenido va a
 * `skipped` y no se pisa. El indice nativo se fusiona al final del compartido,
 * una linea por nota que el compartido todavia no nombra.
 */
export async function importNativeMemory(
  cwd: string,
  home: string = homedir(),
): Promise<{ copied: string[]; skipped: string[] }> {
  await assertMemoryDirInside(cwd);
  if (!(await isDirectory(path.join(cwd, MEMORY_DIR)))) {
    throw new MemoryBridgeError('Instalá el puente primero: falta la carpeta .agents/memory.');
  }

  const plan = new PlanBuilder(cwd);
  if ((await plan.current(INDEX_REL)) === null) {
    plan.put(INDEX_REL, null, Buffer.from(MEMORY_INDEX_TEMPLATE, 'utf8'), 'create', MEMORY_INDEX_TEMPLATE);
  }
  const result = await planNativeImport(plan, cwd, home);
  await plan.validate();
  await plan.apply();
  return result;
}

/**
 * Contenido de un archivo de `.agents/memory/`, incluido el indice.
 *
 * Un nombre que no es un archivo suelto `.md` es un intento de salir de la
 * carpeta y se rechaza con `InvalidPathError`. Una nota que no existe devuelve
 * null.
 */
export async function readMemoryNote(cwd: string, name: string): Promise<MemoryNoteContent | null> {
  if (!isNoteName(name)) {
    throw new InvalidPathError('Ese nombre no es una nota de la memoria.');
  }
  const absolute = await resolveInside(cwd, `${MEMORY_DIR}/${name}`);

  try {
    const info = await stat(absolute);
    if (!info.isFile()) return null;
    const content = await readFile(absolute);
    return {
      name,
      text: content.subarray(0, MAX_NOTE_BYTES).toString('utf8'),
      truncated: content.length > MAX_NOTE_BYTES,
    };
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/**
 * true si `name` es un archivo suelto `.md`.
 *
 * `basename` desarma separadores, `..` y unidades de Windows: si lo que queda
 * no es identico, el nombre llevaba a otro lado. Los dos puntos se rechazan
 * aparte porque en NTFS `nota:x.md` abre un flujo alternativo de `nota`.
 */
export function isNoteName(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name.includes('\0')) return false;
  if (name === '.' || name === '..') return false;
  if (path.basename(name) !== name) return false;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(name)) return false;
  return name.toLowerCase().endsWith('.md');
}

// ---------------------------------------------------------------------------
// El plan
// ---------------------------------------------------------------------------

interface PlannedFile {
  rel: string;
  /** Contenido en disco al planear, o null si el archivo no existe. */
  original: Buffer | null;
  content: Buffer;
  action: MemoryChangeAction;
  preview: string[];
  /** Donde se escribe: el destino real si el archivo existe y es un enlace. */
  target: string | null;
}

/**
 * Un disco virtual: lo que cada archivo va a tener despues de instalar.
 *
 * Varios pasos pueden tocar el mismo archivo —el indice se crea de plantilla y
 * despues recibe las lineas importadas—, y cada paso lee lo que dejo el
 * anterior. Al usuario se le muestra un cambio por archivo.
 */
class PlanBuilder {
  private readonly files = new Map<string, PlannedFile>();

  constructor(private readonly cwd: string) {}

  /**
   * Contenido que tendria `rel` a esta altura del plan.
   *
   * Lo que se lee aca es lo que el plan puede escribir, asi que pasa por el
   * guardia **antes** de leer: un `CLAUDE.md` enlazado a un archivo de afuera
   * se rechaza sin abrirlo (CLAUDE.md 2.1). `validate()` lo rechazaria igual
   * al escribir, pero para entonces ya se habria leido.
   */
  async current(rel: string): Promise<Buffer | null> {
    const planned = this.files.get(rel);
    if (planned !== undefined) return planned.content;
    return readIfFile(await guard(this.cwd, rel), rel);
  }

  put(
    rel: string,
    original: Buffer | null,
    content: Buffer,
    action: MemoryChangeAction,
    preview: string,
  ): void {
    const planned = this.files.get(rel);
    if (planned !== undefined) {
      planned.content = content;
      planned.preview.push(preview);
      return;
    }
    this.files.set(rel, { rel, original, content, action, preview: [preview], target: null });
  }

  /** Nombres de nota que habria en la carpeta, en minusculas. */
  async noteNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    for (const name of await listNoteFiles(path.join(this.cwd, MEMORY_DIR))) {
      names.set(name.toLowerCase(), name);
    }
    for (const rel of this.files.keys()) {
      if (!rel.startsWith(`${MEMORY_DIR}/`)) continue;
      const name = rel.slice(MEMORY_DIR.length + 1);
      if (name.toLowerCase() !== MEMORY_INDEX_FILE.toLowerCase()) names.set(name.toLowerCase(), name);
    }
    return names;
  }

  changes(): MemoryChange[] {
    return [...this.files.values()].map((file) => ({
      file: file.rel,
      action: file.action,
      preview: file.preview.join('\n'),
    }));
  }

  /**
   * Valida el plan entero contra el disco. Corre antes de la primera escritura.
   *
   * Tres cosas hacen que un archivo no se toque:
   *  - que resuelva fuera del `cwd` (enlace o junction);
   *  - que tenga enlaces duros: el `rename` los cortaria, y ademas el otro
   *    nombre puede estar fuera del proyecto, donde la app no escribe;
   *  - que dos archivos del plan sean el mismo (`CLAUDE.md` enlazado a
   *    `AGENTS.md`): cada uno pediria su propio bloque y la instalacion no
   *    terminaria nunca de estar al dia.
   *
   * Solo se miran los archivos del plan, mas la carpeta que se crea con
   * `mkdir`. Un `CLAUDE.md` enlazado a `~/dotfiles` no puede impedir instalar
   * el puente solo en `AGENTS.md`.
   */
  async validate(): Promise<void> {
    await assertMemoryDirInside(this.cwd);
    const seen = new Map<string, string>();

    for (const file of this.files.values()) {
      const absolute = await guard(this.cwd, file.rel);
      if (file.original === null) {
        file.target = absolute;
        continue;
      }

      const target = await realpath(absolute);
      const info = await stat(target);
      if (info.nlink > 1) {
        throw new MemoryBridgeError(
          `${file.rel} tiene enlaces duros: la app no lo modifica, porque escribirlo cortaria el enlace. Agregá el bloque a mano.`,
        );
      }
      const key = process.platform === 'win32' ? target.toLowerCase() : target;
      const other = seen.get(key);
      if (other !== undefined) {
        throw new MemoryBridgeError(
          `${other} y ${file.rel} son el mismo archivo (un enlace). Elegí uno solo.`,
        );
      }
      seen.set(key, file.rel);
      file.target = target;
    }
  }

  async apply(): Promise<void> {
    // `.gitignore` va primero. Si una escritura posterior falla, lo que se crea
    // de cero ya quedo ignorado; al reintentar, ese archivo ya existe y no
    // contaria como creado por la app, asi que su linea no se volveria a
    // proponer y quedaria listo para commitearse.
    const pending = [...this.files.values()].sort(
      (a, b) => Number(b.rel === GITIGNORE_REL) - Number(a.rel === GITIGNORE_REL),
    );
    if (pending.length === 0) return;

    if (pending.some((file) => file.rel.startsWith(`${MEMORY_DIR}/`))) {
      await mkdir(path.join(this.cwd, MEMORY_DIR), { recursive: true });
    }
    for (const file of pending) {
      if (file.target === null) throw new Error(`Plan sin validar: ${file.rel}`);
      await writeAtomic(file.target, file.content, file.original === null);
    }
  }
}

async function buildInstallPlan(
  cwd: string,
  options: MemoryInstallOptions,
  home: string,
): Promise<PlanBuilder> {
  await assertMemoryDirInside(cwd);
  if (options.instructionFiles.length === 0) {
    throw new MemoryBridgeError('Elegí al menos un archivo de instrucciones.');
  }

  const { state: git, main } = await readGit(cwd);
  const plan = new PlanBuilder(cwd);

  // 1. La carpeta y el indice. Del worktree principal si se pidio y lo tiene.
  // La raiz la dio git, y todo lo que se lee de ahi pasa por el guardia contra
  // esa raiz (CLAUDE.md 6.3): un `.agents` que en el principal es una junction
  // hacia afuera no trae nada.
  const source =
    options.copyFromMainWorktree &&
    git.kind === 'repo' &&
    git.worktree !== null &&
    git.worktree.mainHasMemory
      ? main
      : null;
  const mainFolder =
    source === null ? null : await existingInside(source.root, source.memoryRel, 'directory');

  if ((await plan.current(INDEX_REL)) === null) {
    const mainIndexPath =
      source === null || mainFolder === null
        ? null
        : await existingInside(source.root, `${source.memoryRel}/${MEMORY_INDEX_FILE}`, 'file');
    const mainIndex = mainIndexPath === null ? null : await readIfFile(mainIndexPath, INDEX_REL);
    if (mainIndex !== null && mainIndexPath !== null) {
      plan.put(INDEX_REL, null, mainIndex, 'copy', `Copia de ${mainIndexPath}`);
    } else {
      plan.put(
        INDEX_REL,
        null,
        Buffer.from(MEMORY_INDEX_TEMPLATE, 'utf8'),
        'create',
        MEMORY_INDEX_TEMPLATE,
      );
    }
  }

  // 2. Las notas del worktree principal que aca no estan. La ruta la dio git.
  if (source !== null && mainFolder !== null) {
    const local = await plan.noteNames();
    for (const name of await listNoteFiles(mainFolder)) {
      if (local.has(name.toLowerCase())) continue;
      const notePath = await existingInside(source.root, `${source.memoryRel}/${name}`, 'file');
      if (notePath === null) continue;
      const content = await readIfFile(notePath, name);
      if (content === null) continue;
      plan.put(`${MEMORY_DIR}/${name}`, null, content, 'copy', `Copia de ${notePath}`);
    }
  }

  // 3. La memoria nativa.
  if (options.importNative) await planNativeImport(plan, cwd, home);

  // 4. Los archivos de instrucciones, solo entre marcas.
  const createdFromScratch: MemoryInstructionFile[] = [];
  for (const name of options.instructionFiles) {
    const block = memoryBlock(name);
    const current = await plan.current(name);

    if (current === null) {
      plan.put(name, null, Buffer.from(`${block}\n`, 'utf8'), 'create', block);
      createdFromScratch.push(name);
      continue;
    }

    assertUtf8(name, current);
    const scan = scanBlock(current);
    if (scan.brokenBlock) {
      throw new MemoryBridgeError(
        `${name} tiene las marcas del bloque de memoria mal formadas (una sin su pareja, o el bloque repetido). Arreglalo a mano: la app no toca ese archivo mientras tanto.`,
      );
    }
    const eol = dominantEol(current);
    if (!scan.hasBlock) {
      plan.put(name, current, appendSection(current, block, eol, true), 'append-block', block);
    } else if (!isBlockCurrent(current, scan, name)) {
      const replaced = Buffer.concat([
        current.subarray(0, scan.start),
        Buffer.from(withEol(block, eol), 'utf8'),
        current.subarray(scan.end),
      ]);
      plan.put(name, current, replaced, 'replace-block', block);
    }
  }

  // 5. `.gitignore`, solo en un repo y solo si se eligio ignorar.
  if (options.gitMode === 'ignore') {
    if (git.kind === 'error') {
      throw new MemoryBridgeError(
        `No se pudo consultar git (${git.message}). Sin eso no se sabe si hay que tocar .gitignore.`,
      );
    }
    if (git.kind === 'repo') {
      const wanted: string[] = [];
      if (!git.ignored) wanted.push(GITIGNORE_MEMORY_LINE);
      // Convencion del usuario: un archivo de instrucciones que crea un agente
      // va ignorado. Solo los que este mismo install crea de cero.
      for (const name of createdFromScratch) {
        if ((await checkIgnored(cwd, name)) !== true) wanted.push(name);
      }
      await planGitignore(plan, wanted);
    }
  }

  await plan.validate();
  return plan;
}

async function planGitignore(plan: PlanBuilder, wanted: string[]): Promise<void> {
  if (wanted.length === 0) return;

  const current = await plan.current(GITIGNORE_REL);
  if (current !== null) assertUtf8(GITIGNORE_REL, current);
  const existing = new Set(
    (current === null ? '' : current.toString('utf8'))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  const missing = wanted.filter((line) => !existing.has(line));
  if (missing.length === 0) return;

  const lines = existing.has(GITIGNORE_COMMENT) ? missing : [GITIGNORE_COMMENT, ...missing];
  const section = lines.join('\n');
  const base = current ?? Buffer.alloc(0);
  const eol = current === null ? '\n' : dominantEol(current);
  plan.put(GITIGNORE_REL, current, appendSection(base, section, eol, true), 'append-lines', section);
}

/** Planea la importacion de la memoria nativa sobre un plan ya empezado. */
async function planNativeImport(
  plan: PlanBuilder,
  cwd: string,
  home: string,
): Promise<{ copied: string[]; skipped: string[] }> {
  const folders = await nativeMemoryFolders(cwd, home);
  const copied: string[] = [];
  const skipped: string[] = [];
  const chosen = new Map<string, Buffer>();

  for (const folder of folders) {
    const local = await plan.noteNames();
    for (const name of await listNoteFiles(folder)) {
      const key = name.toLowerCase();
      const content = await readIfFile(path.join(folder, name), name);
      if (content === null) continue;

      // Dos carpetas nativas del mismo proyecto (otra capitalizacion del cwd)
      // con el mismo nombre: gana la primera, y si difieren no se pisa.
      const already = chosen.get(key);
      if (already !== undefined) {
        if (!already.equals(content) && !skipped.includes(name)) skipped.push(name);
        continue;
      }
      chosen.set(key, content);

      const existingName = local.get(key);
      if (existingName !== undefined) {
        const existing = await plan.current(`${MEMORY_DIR}/${existingName}`);
        if (existing !== null && !existing.equals(content)) skipped.push(name);
        continue;
      }
      plan.put(`${MEMORY_DIR}/${name}`, null, content, 'copy', `Copia de ${path.join(folder, name)}`);
      copied.push(name);
    }
  }

  // El indice: las lineas nativas cuyo destino el compartido todavia no nombra.
  const index = folders.length === 0 ? null : await plan.current(INDEX_REL);
  if (index !== null) {
    // Un indice en UTF-16 no reconoce ningun enlace, y le pegaria todas las
    // lineas nativas en UTF-8 encima.
    assertUtf8(INDEX_REL, index);
    const known = new Set(linkTargets(index.toString('utf8')));
    const additions: string[] = [];
    for (const folder of folders) {
      const nativeIndex = await readIfFile(path.join(folder, MEMORY_INDEX_FILE), MEMORY_INDEX_FILE);
      if (nativeIndex === null) continue;
      for (const line of nativeIndex.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const target = linkTargets(line)[0];
        if (target === undefined || known.has(target)) continue;
        known.add(target);
        additions.push(line.trimEnd());
      }
    }
    if (additions.length > 0) {
      const section = additions.join('\n');
      plan.put(
        INDEX_REL,
        index,
        appendSection(index, section, dominantEol(index), false),
        'append-lines',
        section,
      );
    }
  }

  return { copied, skipped };
}

/** Destinos `(algo.md)` de los enlaces Markdown de un texto, en minusculas. */
function linkTargets(text: string): string[] {
  const targets: string[] = [];
  for (const match of text.matchAll(/\]\(([^)\s]+\.md)\)/gi)) {
    const target = match[1];
    if (target !== undefined) targets.push(target.toLowerCase());
  }
  return targets;
}

// ---------------------------------------------------------------------------
// Bloques y fines de linea
// ---------------------------------------------------------------------------

interface BlockScan {
  hasBlock: boolean;
  brokenBlock: boolean;
  /** Inicio de la marca de apertura. */
  start: number;
  /** Fin de la marca de cierre, exclusivo. */
  end: number;
}

interface Marker {
  kind: 'start' | 'end';
  /** Offset en bytes del primer caracter de la marca. */
  from: number;
  /** Offset en bytes del fin de la marca, exclusivo. */
  to: number;
}

/**
 * Busca el bloque: una marca de inicio y una de cierre, en ese orden, y nada
 * mas.
 *
 * **Una marca solo cuenta si ocupa su propia linea** (hasta tres espacios
 * antes y blancos despues) **y esta fuera de un bloque de codigo** ``` o ~~~.
 * Un documento que *explica* el puente cita las marcas —entre comillas
 * invertidas, o en un ejemplo—, y tomar esa cita por el bloque meteria el
 * bloque entero en medio de un parrafo del usuario. Es lo que dice el propio
 * CLAUDE.md de este repositorio.
 *
 * Roto es cualquier otra cosa: un inicio sin cierre, un cierre suelto, un
 * cierre antes del inicio, o dos bloques. Un archivo asi no se toca: no hay
 * forma de saber que parte es nuestra, y con dos bloques decir "al dia"
 * mirando solo el primero dejaria al agente leyendo instrucciones
 * contradictorias.
 */
function scanBlock(content: Buffer): BlockScan {
  const lines = splitLines(content);
  // Un bloque de codigo que no se cierra llega hasta el final del archivo, y
  // un bloque agregado despues quedaria adentro: cada instalacion agregaria
  // otro. La apertura sin cierre se toma por texto y se vuelve a buscar.
  const ignoredFences = new Set<number>();
  for (;;) {
    const { markers, unclosedFence } = findMarkers(content, lines, ignoredFences);
    if (unclosedFence === null) return classifyMarkers(markers);
    ignoredFences.add(unclosedFence);
  }
}

function classifyMarkers(markers: Marker[]): BlockScan {
  if (markers.length === 0) return { hasBlock: false, brokenBlock: false, start: -1, end: -1 };
  const [first, second] = markers;
  if (
    markers.length === 2 &&
    first !== undefined &&
    second !== undefined &&
    first.kind === 'start' &&
    second.kind === 'end'
  ) {
    return { hasBlock: true, brokenBlock: false, start: first.from, end: second.to };
  }
  return { hasBlock: false, brokenBlock: true, start: -1, end: -1 };
}

/** Lineas del archivo como offsets en bytes, sin el salto ni el `\r` final. */
function splitLines(content: Buffer): { start: number; end: number }[] {
  const lines: { start: number; end: number }[] = [];
  let start = content.subarray(0, 3).equals(BOM) ? 3 : 0;
  while (start <= content.length) {
    const newline = content.indexOf(0x0a, start);
    const stop = newline === -1 ? content.length : newline;
    const end = stop > start && content[stop - 1] === 0x0d ? stop - 1 : stop;
    lines.push({ start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const MARKER_LINE = /^ {0,3}(\S.*?)[ \t]*$/;

/**
 * Marcas que ocupan su propia linea, fuera de los bloques de codigo.
 *
 * Cada linea se decodifica en `latin1`: un byte es un caracter, asi que los
 * indices del texto son offsets del `Buffer`. Las marcas y las vallas son
 * ASCII, y el resto de los bytes solo tiene que no parecerse a ellas.
 */
function findMarkers(
  content: Buffer,
  lines: { start: number; end: number }[],
  ignoredFences: Set<number>,
): { markers: Marker[]; unclosedFence: number | null } {
  const markers: Marker[] = [];
  let fence: { line: number; char: string; length: number } | null = null;

  for (const [index, line] of lines.entries()) {
    const text = content.toString('latin1', line.start, line.end);

    if (fence !== null) {
      const closing = FENCE_CLOSE.exec(text)?.[1];
      if (closing !== undefined && closing[0] === fence.char && closing.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    const open = FENCE_OPEN.exec(text);
    const opening = open?.[1];
    // Una valla de comillas invertidas no puede llevar comillas en la info.
    if (
      opening !== undefined &&
      !ignoredFences.has(index) &&
      !(opening[0] === '`' && (open?.[2] ?? '').includes('`'))
    ) {
      fence = { line: index, char: opening[0] ?? '`', length: opening.length };
      continue;
    }

    const body = MARKER_LINE.exec(text)?.[1];
    if (body !== MEMORY_BLOCK_START && body !== MEMORY_BLOCK_END) continue;
    const from = line.start + text.indexOf(body);
    markers.push({
      kind: body === MEMORY_BLOCK_START ? 'start' : 'end',
      from,
      to: from + body.length,
    });
  }

  return { markers, unclosedFence: fence === null ? null : fence.line };
}

/**
 * true si el archivo puede estar en UTF-8: sin BOM de UTF-16 y sin bytes nulos,
 * que un texto UTF-8 no tiene nunca.
 */
function isUtf8Compatible(content: Buffer): boolean {
  const first = content[0];
  const second = content[1];
  if ((first === 0xff && second === 0xfe) || (first === 0xfe && second === 0xff)) return false;
  return !content.includes(0);
}

/**
 * Un archivo en UTF-16 no se toca. Es lo que deja `>` en Windows PowerShell
 * 5.1, y pegarle un bloque en UTF-8 lo dejaria con dos codificaciones: basura
 * para quien lo lea, y "al dia" para el estado, que encontraria las marcas.
 */
function assertUtf8(rel: string, content: Buffer): void {
  if (isUtf8Compatible(content)) return;
  throw new MemoryBridgeError(
    `${rel} no está en UTF-8 (parece UTF-16, lo que deja \`>\` en Windows PowerShell 5.1). Guardalo como UTF-8: la app no lo toca mientras tanto.`,
  );
}

function isBlockCurrent(content: Buffer, scan: BlockScan, name: MemoryInstructionFile): boolean {
  if (!scan.hasBlock) return false;
  const block = content.subarray(scan.start, scan.end).toString('utf8').replace(/\r\n/g, '\n');
  return block === memoryBlock(name);
}

/** CRLF si la mayoria de los saltos lo son. */
function dominantEol(content: Buffer): Eol {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] !== 0x0a) continue;
    if (i > 0 && content[i - 1] === 0x0d) crlf += 1;
    else lf += 1;
  }
  return crlf > lf ? '\r\n' : '\n';
}

function withEol(text: string, eol: Eol): string {
  return eol === '\n' ? text : text.replace(/\r?\n/g, '\r\n');
}

function endsWithNewline(content: Buffer): boolean {
  return content.length > 0 && content[content.length - 1] === 0x0a;
}

/** Termina en linea en blanco: dos saltos seguidos, o el archivo es un salto solo. */
function endsWithBlankLine(content: Buffer): boolean {
  if (!endsWithNewline(content)) return false;
  let rest = content.length - 1;
  if (rest > 0 && content[rest - 1] === 0x0d) rest -= 1;
  return rest === 0 || content[rest - 1] === 0x0a;
}

/**
 * Agrega una seccion al final sin tocar un byte de lo que habia.
 *
 * Si el archivo no termina en salto se agrega uno; con `blankLine`, ademas una
 * linea en blanco antes de la seccion, salvo que ya la haya. El BOM, si esta,
 * queda donde estaba porque el original se copia entero.
 */
function appendSection(original: Buffer, section: string, eol: Eol, blankLine: boolean): Buffer {
  const body = original.subarray(original.subarray(0, 3).equals(BOM) ? 3 : 0);
  let prefix = '';
  if (body.length > 0) {
    if (!endsWithNewline(body)) prefix += eol;
    if (blankLine && !endsWithBlankLine(body)) prefix += eol;
  }
  return Buffer.concat([original, Buffer.from(`${prefix}${withEol(section, eol)}${eol}`, 'utf8')]);
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

/**
 * Estado de un archivo de instrucciones.
 *
 * Pasa por el guardia antes de leer: un `CLAUDE.md` versionado como enlace a
 * `~/.claude/.credentials.json` no se abre ni para buscar las marcas
 * (CLAUDE.md 2.1). Se informa como `problem: 'outside'`, sin contenido.
 */
async function inspectInstructionFile(
  cwd: string,
  name: MemoryInstructionFile,
): Promise<MemoryFileState> {
  const withProblem = (problem: MemoryFileProblem): MemoryFileState => ({
    name,
    exists: true,
    hasBlock: false,
    blockCurrent: false,
    brokenBlock: false,
    problem,
  });

  let absolute: string;
  try {
    absolute = await guard(cwd, name);
  } catch (error) {
    if (error instanceof InvalidPathError) return withProblem('outside');
    throw error;
  }

  let content: Buffer | null;
  try {
    content = await readIfFile(absolute, name);
  } catch {
    // Una carpeta con ese nombre, o sin permiso de lectura: para el estado es
    // lo mismo que no tenerlo. Instalar lo va a explicar.
    content = null;
  }
  if (content === null) {
    return {
      name,
      exists: false,
      hasBlock: false,
      blockCurrent: false,
      brokenBlock: false,
      problem: null,
    };
  }
  if (!isUtf8Compatible(content)) return withProblem('encoding');
  const scan = scanBlock(content);
  return {
    name,
    exists: true,
    hasBlock: scan.hasBlock,
    blockCurrent: isBlockCurrent(content, scan, name),
    brokenBlock: scan.brokenBlock,
    problem: null,
  };
}

/** Por que un archivo con problema no cuenta, en pocas palabras. */
function problemText(file: MemoryFileState): string | null {
  if (file.problem === 'outside') return `${file.name} apunta fuera del proyecto`;
  if (file.problem === 'encoding') return `${file.name} no está en UTF-8`;
  return null;
}

/** Que CLI llega a la memoria, segun los archivos que hay. */
function computeReach(
  folderExists: boolean,
  indexExists: boolean,
  files: MemoryFileState[],
): MemoryAgentReach[] {
  const agents = files.find((file) => file.name === 'AGENTS.md');
  const claude = files.find((file) => file.name === 'CLAUDE.md');
  const missing = !folderExists
    ? 'falta la carpeta .agents/memory'
    : !indexExists
      ? 'falta .agents/memory/MEMORY.md'
      : null;

  const entry = (
    agent: MemoryAgentReach['agent'],
    reaches: boolean,
    via: string,
  ): MemoryAgentReach => ({
    agent,
    label: MEMORY_AGENT_LABELS[agent],
    reaches: missing === null && reaches,
    via: missing ?? via,
  });

  const agentsHasBlock = agents?.hasBlock === true;
  const claudeHasBlock = claude?.hasBlock === true;
  const agentsProblem = agents === undefined ? null : problemText(agents);
  const claudeProblem = claude === undefined ? null : problemText(claude);
  const viaAgents = agentsHasBlock
    ? 'AGENTS.md'
    : (agentsProblem ?? 'falta el bloque en AGENTS.md');

  let openCode: { reaches: boolean; via: string };
  if (agentsHasBlock) openCode = { reaches: true, via: 'AGENTS.md' };
  else if (agents?.exists !== true && claudeHasBlock) {
    openCode = { reaches: true, via: 'CLAUDE.md (respaldo)' };
  } else if (agents?.exists === true) {
    openCode = { reaches: false, via: viaAgents };
  } else {
    openCode = { reaches: false, via: 'falta el bloque en AGENTS.md o en CLAUDE.md' };
  }

  return [
    entry(
      'claude-code',
      claudeHasBlock,
      claudeHasBlock ? 'CLAUDE.md' : (claudeProblem ?? 'falta el bloque en CLAUDE.md'),
    ),
    entry('codex', agentsHasBlock, viaAgents),
    entry('antigravity', agentsHasBlock, viaAgents),
    entry('opencode', openCode.reaches, openCode.via),
  ];
}

async function describeNotes(folder: string, names: string[]): Promise<MemoryNote[]> {
  const stated: { name: string; sizeBytes: number; modifiedAt: number }[] = [];
  for (const name of names) {
    try {
      const info = await stat(path.join(folder, name));
      if (info.isFile()) stated.push({ name, sizeBytes: info.size, modifiedAt: info.mtimeMs });
    } catch {
      // Borrada entre el listado y el stat.
    }
  }
  stated.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));

  const notes: MemoryNote[] = [];
  for (const item of stated.slice(0, MAX_LISTED_NOTES)) {
    const head = await readHead(path.join(folder, item.name));
    notes.push({ ...item, ...describeNoteText(head, item.name) });
  }
  return notes;
}

/**
 * Titulo y descripcion de una nota.
 *
 * El formato es el de la memoria nativa: `name:` y `description:` entre dos
 * lineas `---`. Sin eso, el primer encabezado; sin encabezado, el nombre.
 */
function describeNoteText(text: string, fileName: string): { title: string; description: string } {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let title = '';
  let description = '';
  let body = 0;

  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i] ?? '';
      if (line.trim() === '---') {
        body = i + 1;
        break;
      }
      const match = /^(name|description)\s*:\s*(.*)$/.exec(line);
      if (match === null) continue;
      const value = unquote((match[2] ?? '').trim());
      if (match[1] === 'name') title = value;
      else description = value;
    }
  }

  if (title.length === 0) {
    for (let i = body; i < lines.length; i += 1) {
      const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[i] ?? '');
      if (heading !== null && heading[1] !== undefined) {
        title = heading[1];
        break;
      }
    }
  }

  return {
    title: (title.length > 0 ? title : fileName.replace(/\.md$/i, '')).slice(0, 200),
    description: description.slice(0, 400),
  };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    if ((first === '"' || first === "'") && value[value.length - 1] === first) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Memoria nativa: conteo de notas y cuantas faltan en la carpeta compartida.
 *
 * Solo lectura, y solo `projects/<slug>/memory/`. Se busca el slug sin
 * distinguir mayusculas porque la CLI crea una carpeta por cada forma en que se
 * escribio el `cwd`: `D--Mi-App` y `D--mi-app` conviven.
 */
async function countNativeMemory(
  cwd: string,
  home: string,
  sharedNames: string[],
): Promise<{ available: number; pending: number }> {
  const shared = new Set(sharedNames.map((name) => name.toLowerCase()));
  const names = new Set<string>();
  for (const folder of await nativeMemoryFolders(cwd, home)) {
    for (const name of await listNoteFiles(folder)) names.add(name.toLowerCase());
  }
  let pending = 0;
  for (const name of names) if (!shared.has(name)) pending += 1;
  return { available: names.size, pending };
}

async function nativeMemoryFolders(cwd: string, home: string): Promise<string[]> {
  const root = path.join(home, '.claude', 'projects');
  const slug = projectSlugFor(cwd).toLowerCase();
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && entry.name.toLowerCase() === slug)
      .map((entry) => entry.name)
      .sort()
      .map((name) => path.join(root, name, 'memory'));
  } catch {
    return [];
  }
}

/**
 * Los fragmentos para lo global. Solo texto: el servidor no lee ni escribe
 * ninguno de esos archivos.
 */
function buildGlobalFragments(home: string): MemoryGlobalFragment[] {
  const windows = process.platform === 'win32';
  const globalFile = path.join(home, ...GLOBAL_MEMORY_RELATIVE.split('/'));
  const hardLink = (link: string): string =>
    windows ? `mklink /H "${link}" "${globalFile}"` : `ln "${globalFile}" "${link}"`;
  // "El destino no tiene que existir" se leia como "no hace falta que exista",
  // y `mklink /H` y `ln` fallan justo si existe. Y `global.md` tiene que
  // existir antes, o fallan por el otro lado.
  const hardLinkNote = `Enlace duro${windows ? ', en cmd' : ''}. \`~/${GLOBAL_MEMORY_RELATIVE}\` tiene que existir antes, y el archivo de la CLI no: si ya existe, pasá lo que tenga a \`global.md\` y borralo. Si tu editor guarda reemplazando el archivo, el enlace se corta: en ese caso copiá el contenido.`;

  const codexTarget = path.join(home, '.codex', 'AGENTS.md');
  const geminiTarget = path.join(home, '.gemini', 'GEMINI.md');
  const homeSlashes = home.replace(/\\/g, '/').replace(/\/+$/, '');

  return [
    {
      agent: 'claude-code',
      label: MEMORY_AGENT_LABELS['claude-code'],
      target: path.join(home, '.claude', 'CLAUDE.md'),
      kind: 'line',
      text: `@~/${GLOBAL_MEMORY_RELATIVE}`,
      note: 'Agregá esta línea al final. Claude Code importa el archivo al arrancar.',
    },
    {
      agent: 'codex',
      label: MEMORY_AGENT_LABELS.codex,
      target: codexTarget,
      kind: 'command',
      text: hardLink(codexTarget),
      note: hardLinkNote,
    },
    {
      agent: 'antigravity',
      label: MEMORY_AGENT_LABELS.antigravity,
      target: geminiTarget,
      kind: 'command',
      text: hardLink(geminiTarget),
      note: hardLinkNote,
    },
    {
      agent: 'opencode',
      label: MEMORY_AGENT_LABELS.opencode,
      target: path.join(home, '.config', 'opencode', 'opencode.json'),
      kind: 'json',
      text: `"instructions": ["${homeSlashes}/${GLOBAL_MEMORY_RELATIVE}"]`,
      note: 'Dentro del objeto raíz. Ruta absoluta: OpenCode no expande `~` en esta clave (sin verificar).',
    },
  ];
}

// ---------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------

type GitOutcome =
  | { kind: 'ran'; code: number; stdout: string; stderr: string }
  | { kind: 'spawn-failed'; message: string };

/**
 * Corre git para leer. Solo `rev-parse` y `check-ignore`: este archivo no le
 * pide a git nada que escriba.
 *
 * Un git que no arranca sale por `spawn-failed` y no como "no es un repo": es
 * la misma leccion de CLAUDE.md 6.2.
 */
function runGit(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=false', '--no-optional-locks', ...args],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({ kind: 'ran', code: 0, stdout, stderr });
          return;
        }
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'number') {
          resolve({ kind: 'ran', code, stdout, stderr });
          return;
        }
        resolve({
          kind: 'spawn-failed',
          message: code === 'ENOENT' ? 'No se encontró git en el PATH.' : error.message,
        });
      },
    );
  });
}

interface GitReading {
  state: MemoryGitState;
  /**
   * La memoria del worktree principal, si esta pestana es un worktree
   * enlazado: la raiz del principal, que dio git, y la carpeta de la memoria
   * relativa a esa raiz, con `/`. Todo lo que se lee de ahi pasa por el guardia
   * contra `root` (CLAUDE.md 6.3).
   */
  main: { root: string; memoryRel: string } | null;
}

async function readGit(cwd: string): Promise<GitReading> {
  const fail = (message: string): GitReading => ({ state: { kind: 'error', message }, main: null });
  const result = await runGit(cwd, ['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir']);
  if (result.kind === 'spawn-failed') return fail(result.message);

  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    if (/not a git repository|no es un repositorio/i.test(stderr)) {
      return { state: { kind: 'not-repo' }, main: null };
    }
    return fail(stderr.slice(0, 400) || 'git rev-parse falló.');
  }

  const [toplevel, gitDir, commonDir] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (!toplevel || !gitDir || !commonDir) return fail('Respuesta inesperada de git rev-parse.');

  const ignored = await checkIgnored(cwd, INDEX_REL);
  if (typeof ignored === 'string') return fail(ignored);

  const absoluteGitDir = path.resolve(cwd, gitDir);
  const absoluteCommonDir = path.resolve(cwd, commonDir);
  let worktree: { mainPath: string; mainHasMemory: boolean } | null = null;
  let main: GitReading['main'] = null;

  // Worktree enlazado: su git-dir vive dentro del comun del principal.
  if (!(await samePath(absoluteGitDir, absoluteCommonDir))) {
    if (path.basename(absoluteCommonDir).toLowerCase() === '.git') {
      const mainRoot = path.dirname(absoluteCommonDir);
      // Si la pestana esta en una subcarpeta del worktree, lo que le corresponde
      // es la misma subcarpeta del principal.
      const inner = path.relative(path.resolve(toplevel), path.resolve(cwd));
      const sameFolder = inner.length === 0 || inner.startsWith('..') || path.isAbsolute(inner);
      const mainPath = sameFolder ? mainRoot : path.join(mainRoot, inner);
      const memoryRel = sameFolder
        ? MEMORY_DIR
        : [...inner.split(path.sep), MEMORY_DIR].join('/');
      main = { root: mainRoot, memoryRel };
      worktree = {
        mainPath,
        // Con el guardia: un `.agents` que en el principal es una junction
        // hacia afuera, o un `MEMORY.md` enlazado, no es "memoria del principal".
        mainHasMemory:
          (await existingInside(mainRoot, `${memoryRel}/${MEMORY_INDEX_FILE}`, 'file')) !== null,
      };
    }
  }

  return { state: { kind: 'repo', ignored, worktree }, main };
}

/** true/false si git contesto; el mensaje si fallo. */
async function checkIgnored(cwd: string, rel: string): Promise<boolean | string> {
  const result = await runGit(cwd, ['check-ignore', '-q', '--', rel]);
  if (result.kind === 'spawn-failed') return result.message;
  if (result.code === 0) return true;
  if (result.code === 1) return false;
  return result.stderr.trim().slice(0, 400) || 'git check-ignore falló.';
}

async function samePath(a: string, b: string): Promise<boolean> {
  const resolve = async (value: string): Promise<string> => {
    try {
      return await realpath(value);
    } catch {
      return path.resolve(value);
    }
  };
  const [left, right] = await Promise.all([resolve(a), resolve(b)]);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// ---------------------------------------------------------------------------
// Disco
// ---------------------------------------------------------------------------

async function guard(cwd: string, rel: string): Promise<string> {
  try {
    return await resolveInside(cwd, rel);
  } catch (error) {
    if (error instanceof InvalidPathError && !/ya no existe/.test(error.message)) {
      throw new InvalidPathError(
        `${rel} apunta fuera del proyecto (un enlace o una junction): la app no escribe ahí.`,
      );
    }
    throw error;
  }
}

/**
 * La carpeta de la memoria no puede resolver fuera del `cwd`: se lista, se
 * abre y se crea con `mkdir`, y una carpeta enlazada llevaria las tres cosas a
 * cualquier lado.
 *
 * Es lo unico que se valida para todo el puente. Cada archivo pasa por `guard`
 * cuando se lee o se escribe, y ahi solo los que se usan: un `CLAUDE.md`
 * enlazado hacia afuera no bloquea instalar en `AGENTS.md`.
 */
async function assertMemoryDirInside(cwd: string): Promise<void> {
  for (const rel of [AGENTS_DIR_REL, MEMORY_DIR]) await guard(cwd, rel);
}

/**
 * Ruta absoluta de `rel` dentro de `root` si existe, es de la clase pedida y
 * no resuelve afuera; si no, null.
 *
 * Es para leer de una raiz que dio git y no el cliente —el worktree
 * principal—, con el mismo guardia que el `cwd` (CLAUDE.md 6.3).
 */
async function existingInside(
  root: string,
  rel: string,
  kind: 'file' | 'directory',
): Promise<string | null> {
  let absolute: string;
  try {
    absolute = await resolveInside(root, rel, { mustExist: true });
  } catch (error) {
    if (error instanceof InvalidPathError) return null;
    throw error;
  }
  const matches = kind === 'file' ? await isFile(absolute) : await isDirectory(absolute);
  return matches ? absolute : null;
}

/** `.md` sueltos de una carpeta, sin el indice. Los enlaces no cuentan. */
async function listNoteFiles(folder: string): Promise<string[]> {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries
      .filter(
        (entry) =>
          entry.isFile() &&
          isNoteName(entry.name) &&
          entry.name.toLowerCase() !== MEMORY_INDEX_FILE.toLowerCase(),
      )
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Contenido de un archivo, null si no existe. Error claro si no es un archivo. */
async function readIfFile(absolute: string, label: string): Promise<Buffer | null> {
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new MemoryBridgeError(`${label} existe pero no es un archivo.`);
    return await readFile(absolute);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readHead(absolute: string): Promise<string> {
  try {
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(NOTE_HEAD_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, NOTE_HEAD_BYTES, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

async function isFile(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(absolute: string): Promise<boolean> {
  try {
    return (await stat(absolute)).isDirectory();
  } catch {
    return false;
  }
}

function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Temporal en la misma carpeta y `rename`: un corte a mitad no deja un
 * `AGENTS.md` por la mitad. Si algo falla, el temporal se borra.
 *
 * `mustNotExist` es para lo que se crea o se copia: si aparecio entre el plan y
 * la escritura, no se pisa.
 */
async function writeAtomic(target: string, content: Buffer, mustNotExist: boolean): Promise<void> {
  const { temporary, handle } = await createTemporary(target);
  try {
    try {
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    if (mustNotExist && (await exists(target))) {
      throw new MemoryBridgeError(
        `${path.basename(target)} apareció mientras se instalaba. Volvé a mirar los cambios.`,
      );
    }
    await renameWithRetry(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

/**
 * Crea el temporal **en exclusiva** (`wx`: falla si ya hay algo con ese nombre,
 * enlace incluido) y con un sufijo aleatorio.
 *
 * Con un nombre predecible y `writeFile`, un enlace duro o simbolico puesto de
 * antemano en `.AGENTS.md.<pid>.tmp` hacia un archivo de afuera recibia la
 * escritura, y el `rename` dejaba despues el `AGENTS.md` enlazado a ese
 * archivo. Un choque de nombres se reintenta con otro sufijo; lo que ya existe
 * no se abre nunca, y tampoco se borra: no es nuestro.
 */
async function createTemporary(target: string): Promise<{ temporary: string; handle: FileHandle }> {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = randomBytes(6).toString('hex');
    const temporary = path.join(
      path.dirname(target),
      `.${path.basename(target)}.${process.pid}.${suffix}.tmp`,
    );
    try {
      return { temporary, handle: await open(temporary, 'wx') };
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== 'EEXIST' || attempt >= TEMPORARY_ATTEMPTS) throw error;
    }
  }
}

async function exists(absolute: string): Promise<boolean> {
  try {
    await stat(absolute);
    return true;
  } catch {
    return false;
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
      if (!transient || attempt >= RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS * attempt));
    }
  }
}
