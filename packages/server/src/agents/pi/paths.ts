/**
 * Donde guarda Pi lo que esta app lee, y como se nombra.
 *
 * De la carpeta de Pi se leen dos cosas y ninguna se escribe: las sesiones
 * (`sessions/--<carpeta>--/<fecha>_<id>.jsonl`) y `models-store.json`, el
 * catalogo de modelos. La carpeta entera no se lista nunca: ahi vive
 * `auth.json` (regla 2.1).
 *
 * Todo se calcula en cada llamada, no al importar: el chequeo cambia las
 * variables y el usuario puede arrancar el servidor con otras.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { isPiSessionId } from './constants.js';

/** Variables ya avisadas, para no repetir el aviso en cada llamada. */
const warned = new Set<string>();

/**
 * true si la ruta no depende del `cwd` de nadie. En Windows una ruta que
 * empieza con `\` cuelga de la unidad actual: se exige unidad o UNC.
 */
function isFullyQualified(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  return process.platform !== 'win32' || /^([a-zA-Z]:[\\/]|[\\/]{2})/.test(candidate);
}

/**
 * El valor de una variable de carpeta de Pi, ya resuelto, o null si no se puede
 * saber a donde apunta.
 *
 * Pi expande `~` (segun su codigo, `expandTildePath`), y eso si es de un solo
 * sitio. Una ruta relativa la resuelve Pi contra el `cwd` de su pty y esta app
 * contra el del servidor: serian dos carpetas distintas con el mismo nombre,
 * igual que una `CODEX_HOME` relativa. Ahi no se lee nada y se avisa una vez.
 */
function resolveConfigured(name: string, value: string): string | null {
  if (value === '~') return homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir(), value.slice(2));
  if (isFullyQualified(value)) return path.normalize(value);
  const key = `${name}=${value}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[pi] ${name} isn't an absolute path (${value}): the Pi history isn't read.`);
  }
  return null;
}

/** La carpeta de Pi: `PI_CODING_AGENT_DIR` si esta definida, y `~/.pi/agent` si no. */
export function piAgentDir(): string | null {
  const configured = process.env['PI_CODING_AGENT_DIR'];
  if (configured === undefined || configured.length === 0) return path.join(homedir(), '.pi', 'agent');
  return resolveConfigured('PI_CODING_AGENT_DIR', configured);
}

export interface PiSessionsLayout {
  root: string;
  /**
   * true con `PI_CODING_AGENT_SESSION_DIR`: segun el codigo de Pi, ahi todas las
   * sesiones van sueltas en esa carpeta, sin subcarpeta por proyecto, y el
   * proyecto se sabe solo por la primera linea de cada archivo.
   */
  flat: boolean;
}

/** Donde estan las sesiones, o null si alguna variable no deja saberlo. */
export function piSessionsLayout(): PiSessionsLayout | null {
  const configured = process.env['PI_CODING_AGENT_SESSION_DIR'];
  if (configured !== undefined && configured.length > 0) {
    const root = resolveConfigured('PI_CODING_AGENT_SESSION_DIR', configured);
    return root === null ? null : { root, flat: true };
  }
  const agentDir = piAgentDir();
  return agentDir === null ? null : { root: path.join(agentDir, 'sessions'), flat: false };
}

/** `models-store.json`: el catalogo que Pi baja de pi.dev. Sin secretos (16.9). */
export function piModelsStorePath(): string | null {
  const agentDir = piAgentDir();
  return agentDir === null ? null : path.join(agentDir, 'models-store.json');
}

/**
 * La carpeta de un proyecto dentro de `sessions/`: la ruta sin la barra inicial
 * y con `/`, `\` y `:` cambiados por `-`, entre `--` (medido, 16.2).
 * `D:\Proyectos\demo` es `--D--Proyectos-demo--`.
 *
 * Pierde informacion —`D:\Mi-App` y `D:\Mi\App` dan la misma—, asi que la
 * carpeta real de una sesion se lee de su primera linea y no de aca.
 */
export function projectFolderName(cwd: string): string {
  const resolved = path.resolve(cwd);
  return `--${resolved.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** true si ese nombre tiene la forma de una carpeta de proyecto de Pi. */
export function isProjectFolderName(name: string): boolean {
  return name.length > 4 && name.startsWith('--') && name.endsWith('--');
}

/**
 * `<fecha>_<id>.jsonl`. La fecha es la del arranque de la sesion, en ISO con
 * `:` y `.` cambiados por `-`, y tiene siempre 24 caracteres: por ahi se corta,
 * porque el id puede traer `_`.
 */
const SESSION_FILE_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/;
const STAMP_LENGTH = 24;

export interface PiSessionFileName {
  sessionId: string;
  /** Epoch ms del arranque de la sesion, segun el nombre. */
  startedAt: number;
}

/** Lo que dice el nombre de un archivo de sesion, o null si no es uno. */
export function parseSessionFileName(name: string): PiSessionFileName | null {
  if (!name.endsWith('.jsonl') || name.charAt(STAMP_LENGTH) !== '_') return null;
  const stamp = SESSION_FILE_STAMP.exec(name.slice(0, STAMP_LENGTH));
  if (stamp === null) return null;
  const sessionId = name.slice(STAMP_LENGTH + 1, -'.jsonl'.length);
  if (!isPiSessionId(sessionId)) return null;
  const [, year, month, day, hour, minute, second, millis] = stamp;
  const startedAt = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis),
  );
  return Number.isFinite(startedAt) ? { sessionId, startedAt } : null;
}

/** true si `filePath` cae dentro de `root`, sin salir por `..`. */
export function isInside(root: string, filePath: string): boolean {
  const relative = path.relative(root, filePath);
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * La carpeta donde Pi guarda las sesiones de ese `cwd`, o null. No comprueba
 * que exista.
 */
export function sessionDirFor(cwd: string, layout: PiSessionsLayout | null = piSessionsLayout()): string | null {
  if (layout === null) return null;
  return layout.flat ? layout.root : path.join(layout.root, projectFolderName(cwd));
}

async function sessionFilesIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && parseSessionFileName(entry.name) !== null)
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/** Las carpetas de proyecto de `sessions/`. [] con la disposicion plana o sin raiz. */
export async function projectFolders(layout: PiSessionsLayout): Promise<string[]> {
  if (layout.flat) return [];
  try {
    const entries = await readdir(layout.root, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isProjectFolderName(entry.name))
      .map((entry) => path.join(layout.root, entry.name))
      .sort();
  } catch {
    return [];
  }
}

/** Todos los archivos de sesion, en orden estable. */
export async function listSessionFiles(layout: PiSessionsLayout): Promise<string[]> {
  const dirs = layout.flat ? [layout.root] : await projectFolders(layout);
  const files: string[] = [];
  for (const dir of dirs) {
    for (const name of await sessionFilesIn(dir)) files.push(path.join(dir, name));
  }
  return files;
}

/**
 * El archivo de una sesion, o null.
 *
 * Primero en la carpeta de su `cwd`, que es donde la busca Pi. Si no esta, en
 * las demas: la carpeta se arma con la ruta tal como la tenia el proceso de Pi
 * —mayusculas incluidas—, y la que llega aca puede venir escrita distinto. Son
 * `readdir`, no lecturas. Con dos archivos del mismo id gana el mas reciente,
 * que es el que Pi sigue escribiendo.
 */
export async function findSessionFile(sessionId: string, cwd: string | null): Promise<string | null> {
  if (!isPiSessionId(sessionId)) return null;
  const layout = piSessionsLayout();
  if (layout === null) return null;

  const own = cwd === null || cwd.length === 0 ? null : sessionDirFor(cwd, layout);
  const dirs = own === null ? [] : [own];
  if (!layout.flat) {
    for (const dir of await projectFolders(layout)) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }

  for (const dir of dirs) {
    const matches = (await sessionFilesIn(dir)).filter((name) => parseSessionFileName(name)?.sessionId === sessionId);
    if (matches.length === 0) continue;
    if (matches.length === 1) return path.join(dir, matches[0] ?? '');
    let best: { file: string; mtimeMs: number } | null = null;
    for (const name of matches) {
      try {
        const info = await stat(path.join(dir, name));
        if (best === null || info.mtimeMs > best.mtimeMs) best = { file: path.join(dir, name), mtimeMs: info.mtimeMs };
      } catch {
        // Borrado entre el listado y el stat.
      }
    }
    if (best !== null) return best.file;
  }
  return null;
}
