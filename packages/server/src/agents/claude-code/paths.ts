/**
 * Rutas de la CLI que usa la app.
 *
 * De `~/.claude/` se leen **tres** carpetas y ninguna se escribe: `projects/`
 * —el historial—, `sessions/` —el estado en vivo de cada proceso de la CLI, ver
 * `cli-status.ts`— y `plans/`, donde la CLI deja los planes del modo plan
 * (`plans-store.ts`). Nada mas se abre; en particular `.credentials.json` no se
 * toca nunca.
 */

import { homedir } from 'node:os';
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
 * Archivo JSONL que va a escribir una sesion.
 *
 * Se sabe de antemano porque el UUID lo generamos nosotros y se lo pasamos a la
 * CLI con `--session-id` (CLAUDE.md 4.8). Sin heuristica de descubrimiento y
 * sin carreras entre dos pestanas del mismo proyecto.
 */
export function sessionFilePath(cwd: string, sessionId: string): string {
  return path.join(sessionsRoot(), projectSlugFor(cwd), `${sessionId}.jsonl`);
}
