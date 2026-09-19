/**
 * La memoria compartida entre agentes.
 *
 * Vive en `<proyecto>/.agents/memory/`: un `MEMORY.md` de indice y un `.md` por
 * nota. Es la unica carpeta donde las cuatro CLIs escriben sin pedir permiso,
 * porque esta dentro de su frontera de workspace (docs/plan-multi-cli.md 7.2).
 *
 * Cada CLI llega a ella por su archivo de instrucciones —`AGENTS.md` o
 * `CLAUDE.md`— gracias a un bloque marcado que escribe la app. Fuera de esas
 * marcas la app no toca nada, y lo global (`~/.agents/global.md`) no lo escribe
 * nunca: solo muestra el fragmento para copiar.
 *
 * Todo lo que viaja por el socket es plano y serializable, y cada tipo tiene su
 * parser estricto, igual que el resto de `shared/`.
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
import { parseServerText, type ServerText } from './server-text.js';

/** Carpeta de la memoria, relativa al `cwd` del proyecto. */
export const MEMORY_DIR = '.agents/memory';
/** Indice de la memoria, dentro de `MEMORY_DIR`. */
export const MEMORY_INDEX_FILE = 'MEMORY.md';
export const MEMORY_BLOCK_START = '<!-- agent-workbench:memory -->';
export const MEMORY_BLOCK_END = '<!-- /agent-workbench:memory -->';
/** Memoria global, relativa al home. La app no la escribe. */
export const GLOBAL_MEMORY_RELATIVE = '.agents/global.md';
export const MEMORY_INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

export type MemoryInstructionFile = (typeof MEMORY_INSTRUCTION_FILES)[number];

export const MEMORY_AGENT_IDS = ['claude-code', 'codex', 'antigravity', 'opencode'] as const;
export type MemoryAgentId = (typeof MEMORY_AGENT_IDS)[number];

/** Nombre visible de cada CLI. Es un dato de compatibilidad, no una marca. */
export const MEMORY_AGENT_LABELS: Record<MemoryAgentId, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
};

const MEMORY_BLOCK_BODY = [
  '## Memoria del proyecto',
  '',
  'La memoria de este proyecto vive en `.agents/memory/` y es compartida: la leen y',
  'la escriben todos los agentes que trabajan acá, con cualquier herramienta.',
  '',
  '- Al empezar, leé `.agents/memory/MEMORY.md`. Es el índice: una línea por nota.',
  '- Cuando aprendas algo que sirva en otra sesión —una decisión y su motivo, una',
  '  restricción, una trampa ya pisada, una preferencia del usuario—, guardalo en',
  '  un archivo propio dentro de `.agents/memory/` y agregá su línea al índice:',
  '  `- [Título](archivo.md) — de qué trata, en una línea`.',
  '- Cada nota empieza con `name:` y `description:` entre dos líneas `---`, y',
  '  después el hecho. Si ya hay una nota sobre lo mismo, actualizala en vez de',
  '  crear otra.',
  '- No guardes lo que ya cuenta el repositorio ni lo que sólo importa hoy.',
  '- Guardá la memoria acá, no en la carpeta de memoria propia de tu herramienta.',
];

/**
 * El bloque marcado de cada archivo de instrucciones, con LF y sin salto final.
 *
 * `CLAUDE.md` lleva ademas el import del indice. Importa el indice y no
 * `@AGENTS.md` a proposito: un `AGENTS.md` con contenido propio entraria dos
 * veces al contexto.
 */
export function memoryBlock(file: MemoryInstructionFile): string {
  const lines = [MEMORY_BLOCK_START, ...MEMORY_BLOCK_BODY];
  if (file === 'CLAUDE.md') lines.push('', `@${MEMORY_DIR}/${MEMORY_INDEX_FILE}`);
  lines.push(MEMORY_BLOCK_END);
  return lines.join('\n');
}

/** Contenido de un `MEMORY.md` nuevo. Termina en linea en blanco. */
export const MEMORY_INDEX_TEMPLATE = [
  '# Memoria del proyecto',
  '',
  'Índice de la memoria compartida entre agentes. Una línea por nota, con este',
  'formato: `- [Título](archivo.md) — de qué trata, en una línea`.',
  '',
  '',
].join('\n');

export const MEMORY_FILE_PROBLEMS = ['outside', 'encoding'] as const;
/**
 * Por que un archivo de instrucciones que existe no se lee ni se toca:
 * `outside`, un enlace que resuelve fuera del proyecto; `encoding`, no esta en
 * UTF-8 (un UTF-16 de PowerShell, tipicamente).
 */
export type MemoryFileProblem = (typeof MEMORY_FILE_PROBLEMS)[number];

export interface MemoryFileState {
  name: MemoryInstructionFile;
  exists: boolean;
  /**
   * Tiene una marca de inicio y una de cierre, en ese orden, cada una en su
   * propia linea y fuera de un bloque de codigo.
   */
  hasBlock: boolean;
  /** El bloque es identico al texto actual, sin distinguir CRLF de LF. */
  blockCurrent: boolean;
  /**
   * Marcas mal formadas: un inicio sin cierre, un cierre suelto, o el bloque
   * repetido. Un archivo asi no se toca.
   */
  brokenBlock: boolean;
  /** Si no es null, el archivo no se leyo: `hasBlock` y compania no dicen nada. */
  problem: MemoryFileProblem | null;
}

export type MemoryGitState =
  | { kind: 'not-repo' }
  | {
      kind: 'repo';
      ignored: boolean;
      worktree: { mainPath: string; mainHasMemory: boolean } | null;
    }
  | { kind: 'error'; message: ServerText };

export interface MemoryAgentReach {
  agent: MemoryAgentId;
  label: string;
  reaches: boolean;
  /** Texto corto para el `title`: por donde llega, o que le falta. Como clave (§6.23). */
  via: ServerText;
}

export interface MemoryNote {
  /** Nombre del archivo, p. ej. `decision-orm.md`. */
  name: string;
  /** `name:` del frontmatter, o el primer encabezado, o el nombre sin `.md`. */
  title: string;
  /** `description:` del frontmatter, o cadena vacia. */
  description: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface MemoryGlobalFragment {
  agent: MemoryAgentId;
  label: string;
  /** Ruta del archivo global, con el home real. Solo se muestra. */
  target: string;
  kind: 'line' | 'command' | 'json';
  /** Lo que el usuario copia. */
  text: string;
  /** Como clave (§6.23). Los `acentos graves` se dibujan como codigo. */
  note: ServerText;
}

export interface MemoryStatus {
  cwd: string;
  folderExists: boolean;
  indexExists: boolean;
  /** Carpeta, indice y al menos un archivo de instrucciones con bloque. */
  installed: boolean;
  /** `.md` de la carpeta sin el indice, del mas nuevo al mas viejo. */
  notes: MemoryNote[];
  /** `AGENTS.md` y `CLAUDE.md`, siempre los dos y en ese orden. */
  files: MemoryFileState[];
  git: MemoryGitState;
  /** Las cuatro CLIs, siempre en el orden de `MEMORY_AGENT_IDS`. */
  reach: MemoryAgentReach[];
  /** Memoria nativa por proyecto de Claude Code: cuantas notas y cuantas faltan. */
  native: { available: number; pending: number };
  globalFragments: MemoryGlobalFragment[];
}

export const MEMORY_CHANGE_ACTIONS = [
  'create',
  'append-block',
  'replace-block',
  'append-lines',
  'copy',
] as const;
export type MemoryChangeAction = (typeof MEMORY_CHANGE_ACTIONS)[number];

export interface MemoryChange {
  /** Relativa al `cwd`, con `/`. */
  file: string;
  action: MemoryChangeAction;
  preview: string;
  /**
   * De donde sale una copia: la ruta del original, que la web muestra como
   * "Copia de <ruta>" en su idioma (§6.23). null si el cambio no copia nada.
   */
  copiedFrom: string | null;
}

export interface MemoryInstallOptions {
  instructionFiles: MemoryInstructionFile[];
  gitMode: 'ignore' | 'version';
  importNative: boolean;
  copyFromMainWorktree: boolean;
}

export interface MemoryNoteContent {
  name: string;
  text: string;
  truncated: boolean;
}

/**
 * Opciones con las que arranca el formulario de instalacion.
 *
 * Viven aca y no en la vista para que el valor por defecto sea uno solo: los
 * dos archivos, ignorar en git, importar si hay pendientes y copiar del
 * worktree principal si tiene memoria.
 *
 * Con git en error, "versionar": sin saber que ignora el repo, el servidor no
 * toca `.gitignore`, y "ignorar" fallaria siempre sin que el panel ofreciera
 * salida.
 */
export function defaultMemoryInstallOptions(status: MemoryStatus | null): MemoryInstallOptions {
  return {
    instructionFiles: [...MEMORY_INSTRUCTION_FILES],
    gitMode: status !== null && status.git.kind === 'error' ? 'version' : 'ignore',
    importNative: status !== null && status.native.pending > 0,
    copyFromMainWorktree:
      status !== null &&
      status.git.kind === 'repo' &&
      status.git.worktree !== null &&
      status.git.worktree.mainHasMemory,
  };
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

export function parseMemoryFileState(value: unknown): MemoryFileState | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asLiteral(record['name'], MEMORY_INSTRUCTION_FILES);
  const exists = asBoolean(record['exists']);
  const hasBlock = asBoolean(record['hasBlock']);
  const blockCurrent = asBoolean(record['blockCurrent']);
  const brokenBlock = asBoolean(record['brokenBlock']);
  const rawProblem = record['problem'];
  const problem = rawProblem === null ? null : asLiteral(rawProblem, MEMORY_FILE_PROBLEMS);
  if (
    name === null ||
    exists === null ||
    hasBlock === null ||
    blockCurrent === null ||
    brokenBlock === null ||
    (rawProblem !== null && problem === null)
  ) {
    return null;
  }
  return { name, exists, hasBlock, blockCurrent, brokenBlock, problem };
}

export function parseMemoryGitState(value: unknown): MemoryGitState | null {
  const record = asRecord(value);
  if (record === null) return null;
  switch (record['kind']) {
    case 'not-repo':
      return { kind: 'not-repo' };
    case 'error': {
      const message = parseServerText(record['message']);
      return message === null ? null : { kind: 'error', message };
    }
    case 'repo': {
      const ignored = asBoolean(record['ignored']);
      if (ignored === null) return null;
      if (record['worktree'] === null) return { kind: 'repo', ignored, worktree: null };
      const worktree = asRecord(record['worktree']);
      if (worktree === null) return null;
      const mainPath = asNonEmptyString(worktree['mainPath']);
      const mainHasMemory = asBoolean(worktree['mainHasMemory']);
      if (mainPath === null || mainHasMemory === null) return null;
      return { kind: 'repo', ignored, worktree: { mainPath, mainHasMemory } };
    }
    default:
      return null;
  }
}

export function parseMemoryAgentReach(value: unknown): MemoryAgentReach | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], MEMORY_AGENT_IDS);
  const label = asNonEmptyString(record['label']);
  const reaches = asBoolean(record['reaches']);
  const via = parseServerText(record['via']);
  if (agent === null || label === null || reaches === null || via === null) return null;
  return { agent, label, reaches, via };
}

export function parseMemoryNote(value: unknown): MemoryNote | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asNonEmptyString(record['name']);
  const title = asString(record['title']);
  const description = asString(record['description']);
  const sizeBytes = asFiniteNumber(record['sizeBytes']);
  const modifiedAt = asFiniteNumber(record['modifiedAt']);
  if (
    name === null ||
    title === null ||
    description === null ||
    sizeBytes === null ||
    modifiedAt === null
  ) {
    return null;
  }
  return { name, title, description, sizeBytes, modifiedAt };
}

const FRAGMENT_KINDS = ['line', 'command', 'json'] as const;

export function parseMemoryGlobalFragment(value: unknown): MemoryGlobalFragment | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], MEMORY_AGENT_IDS);
  const label = asNonEmptyString(record['label']);
  const target = asNonEmptyString(record['target']);
  const kind = asLiteral(record['kind'], FRAGMENT_KINDS);
  const text = asNonEmptyString(record['text']);
  const note = parseServerText(record['note']);
  if (
    agent === null ||
    label === null ||
    target === null ||
    kind === null ||
    text === null ||
    note === null
  ) {
    return null;
  }
  return { agent, label, target, kind, text, note };
}

export function parseMemoryStatus(value: unknown): MemoryStatus | null {
  const record = asRecord(value);
  if (record === null) return null;
  const cwd = asNonEmptyString(record['cwd']);
  const folderExists = asBoolean(record['folderExists']);
  const indexExists = asBoolean(record['indexExists']);
  const installed = asBoolean(record['installed']);
  const notes = asArrayOf(record['notes'], parseMemoryNote);
  const files = asArrayOf(record['files'], parseMemoryFileState);
  const git = parseMemoryGitState(record['git']);
  const reach = asArrayOf(record['reach'], parseMemoryAgentReach);
  const nativeRecord = asRecord(record['native']);
  const available = nativeRecord === null ? null : asFiniteNumber(nativeRecord['available']);
  const pending = nativeRecord === null ? null : asFiniteNumber(nativeRecord['pending']);
  const globalFragments = asArrayOf(record['globalFragments'], parseMemoryGlobalFragment);
  if (
    cwd === null ||
    folderExists === null ||
    indexExists === null ||
    installed === null ||
    notes === null ||
    files === null ||
    git === null ||
    reach === null ||
    available === null ||
    pending === null ||
    globalFragments === null
  ) {
    return null;
  }
  return {
    cwd,
    folderExists,
    indexExists,
    installed,
    notes,
    files,
    git,
    reach,
    native: { available, pending },
    globalFragments,
  };
}

export function parseMemoryChange(value: unknown): MemoryChange | null {
  const record = asRecord(value);
  if (record === null) return null;
  const file = asNonEmptyString(record['file']);
  const action = asLiteral(record['action'], MEMORY_CHANGE_ACTIONS);
  const preview = asString(record['preview']);
  // Ausente, como en un servidor anterior al hito 34: sin origen que mostrar.
  const copiedFrom = asString(record['copiedFrom']);
  return file === null || action === null || preview === null ? null : { file, action, preview, copiedFrom };
}

const GIT_MODES = ['ignore', 'version'] as const;

/**
 * Opciones de instalacion que manda el cliente.
 *
 * Estricto: todos los campos presentes y con su tipo. Los archivos elegidos se
 * deduplican, porque dos veces el mismo archivo en la lista no significa nada
 * distinto de una.
 */
export function parseMemoryInstallOptions(value: unknown): MemoryInstallOptions | null {
  const record = asRecord(value);
  if (record === null) return null;
  const instructionFiles = asArrayOf(record['instructionFiles'], (item) =>
    asLiteral(item, MEMORY_INSTRUCTION_FILES),
  );
  const gitMode = asLiteral(record['gitMode'], GIT_MODES);
  const importNative = asBoolean(record['importNative']);
  const copyFromMainWorktree = asBoolean(record['copyFromMainWorktree']);
  if (
    instructionFiles === null ||
    gitMode === null ||
    importNative === null ||
    copyFromMainWorktree === null
  ) {
    return null;
  }
  return {
    instructionFiles: MEMORY_INSTRUCTION_FILES.filter((file) => instructionFiles.includes(file)),
    gitMode,
    importNative,
    copyFromMainWorktree,
  };
}

export function parseMemoryNoteContent(value: unknown): MemoryNoteContent | null {
  const record = asRecord(value);
  if (record === null) return null;
  const name = asNonEmptyString(record['name']);
  const text = asString(record['text']);
  const truncated = asBoolean(record['truncated']);
  if (name === null || text === null || truncated === null) return null;
  return { name, text, truncated };
}
