/**
 * Rutas de la CLI que usa la app.
 *
 * De `~/.claude/` se leen **tres** carpetas y ninguna se escribe: `projects/`
 * —el historial—, `sessions/` —el estado en vivo de cada proceso de la CLI, ver
 * `cli-status.ts`— y `plans/`, donde la CLI deja los planes del modo plan
 * (`plans-store.ts`). Nada mas se abre; en particular `.credentials.json` no se
 * toca nunca.
 *
 * Desde el hito 31 hay una cuarta raiz, y **no** cuelga de `~/.claude/`: la
 * carpeta temporal de cada sesion (`scratchRoot`), de donde se leen los `.md`
 * que la conversacion nombro. Tampoco se escribe.
 */

import { readdir, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

/** Historial de conversaciones de la CLI. Solo lectura. */
export function sessionsRoot(): string {
  return path.join(homedir(), '.claude', 'projects');
}

/**
 * Estado en vivo de los procesos de la CLI. Solo lectura.
 *
 * Un archivo `<pid>.json` por proceso, que la CLI reescribe cuando cambia de
 * estado. Es la unica fuente que dice **que la CLI esta esperando algo del
 * usuario** sin mirar la pantalla de la terminal; ver `cli-status.ts`.
 */
export function cliSessionsStateRoot(): string {
  return path.join(homedir(), '.claude', 'sessions');
}

/**
 * Planes del modo plan. Solo lectura.
 *
 * La CLI escribe ahi un `.md` por plan y lo anuncia en el JSONL — con una linea
 * `plan_mode`, o con un `Write` a esa carpeta (`jsonl-events.ts`). La app no
 * escribe nada aca, y solo abre los archivos que la conversacion nombro.
 */
export function plansRoot(): string {
  return path.join(homedir(), '.claude', 'plans');
}

/**
 * Nombre de la carpeta que la CLI usa para un `cwd`.
 *
 * OJO con la direccion. El slug **no** se puede revertir a una ruta: `D--Mi-App`
 * puede venir tanto de `D:\Mi App` como de `D:\Mi-App`, y por eso el indice
 * lee el `cwd` del contenido del JSONL (CLAUDE.md 4.1).
 *
 * Pero la direccion que necesita el seguimiento de conversacion es la otra:
 * de un `cwd` que ya conocemos al nombre de la carpeta. Esa si es una funcion,
 * y esta verificada contra los 230 archivos de esta instalacion: 230 de 230.
 */
export function projectSlugFor(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Carpeta temporal de **una** sesion de la CLI. Solo lectura.
 *
 * La CLI le da a cada sesion un sitio propio fuera del proyecto
 * —`<temporal>/claude/<slug>/<sessionId>/`, con `scratchpad/` adentro— y el
 * agente deja ahi lo que no va al repositorio: borradores, especificaciones,
 * notas de trabajo. Desde el hito 31 los `.md` que escribe ahi se leen en la
 * solapa Planes, porque hasta ahora no habia forma de abrirlos desde la app.
 *
 * **Es la de esa sesion, no `<temporal>/claude`.** El slug sale de
 * `projectSlugFor`, el mismo con el que la CLI nombra la carpeta del historial,
 * y el `sessionId` es el de la pestana. Un `.md` de la carpeta de otra sesion
 * cae fuera y no se abre: en Linux la temporal es compartida, asi que esto no
 * es una formalidad. Como con los planes, solo se abren los archivos que la
 * conversacion nombro; la carpeta no se recorre.
 */
export function scratchRoot(cwd: string, sessionId: string): string {
  return path.join(tmpdir(), 'claude', projectSlugFor(cwd), sessionId);
}

/**
 * Archivo JSONL que va a escribir una sesion.
 *
 * Se sabe de antemano porque el UUID lo generamos nosotros y se lo pasamos a la
 * CLI con `--session-id` (CLAUDE.md 4.8). Sin heuristica de descubrimiento y
 * sin carreras entre dos pestanas del mismo proyecto.
 */
export function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(sessionsRoot(), projectSlugFor(cwd), `${sessionId}.jsonl`);
}

/** Un id que puede ir en una ruta: el uuid de la CLI, sin separadores ni `..`. */
const SESSION_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

async function fileMtime(candidate: string): Promise<number | null> {
  try {
    const info = await stat(candidate);
    return info.isFile() ? info.mtimeMs : null;
  } catch {
    return null;
  }
}

/**
 * El archivo de una sesion, este donde este (Hito 54, §4.11.2). null si no
 * esta en ningun lado.
 *
 * Primero donde se calcula con el `cwd` de la pestana, que es donde esta casi
 * siempre. Si no, en las demas carpetas de `projects/`: una conversacion que se
 * paso a una rama aparte se retoma desde la carpeta de la rama y la CLI sigue
 * escribiendo el archivo de donde empezo (c19), y `EnterWorktree` lo muda a la
 * carpeta de la rama. Son `stat` por ruta, que el antivirus no frena (§4.11.1):
 * no se abre ni se lee nada. Con dos del mismo id gana el mas reciente, que es
 * el que la CLI sigue escribiendo.
 *
 * Sin carpeta no se busca: la copia propia da por "sin origen" una sesion cuyo
 * resumen no dice donde esta (C6, §13), y eso no cambia con el Hito 54. Una
 * pestana tiene siempre su carpeta.
 */
export async function findSessionFile(cwd: string, sessionId: string): Promise<string | null> {
  if (cwd.length === 0 || !SESSION_FILE_ID.test(sessionId)) return null;
  const own = sessionFilePath(cwd, sessionId);
  if ((await fileMtime(own)) !== null) return own;

  let folders: string[];
  try {
    folders = (await readdir(sessionsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  let best: { file: string; mtimeMs: number } | null = null;
  for (const folder of folders) {
    const candidate = path.join(sessionsRoot(), folder, `${sessionId}.jsonl`);
    const mtimeMs = await fileMtime(candidate);
    if (mtimeMs !== null && (best === null || mtimeMs > best.mtimeMs)) best = { file: candidate, mtimeMs };
  }
  return best?.file ?? null;
}

/** El archivo de una sesion donde este, o donde va a estar si todavia no se escribio. */
export async function sessionFileOf(cwd: string, sessionId: string): Promise<string> {
  return (await findSessionFile(cwd, sessionId)) ?? sessionFilePath(cwd, sessionId);
}
