/**
 * Rutas del sistema que usa la app.
 *
 * Dos reglas que se aplican aca:
 *  - De `~/.claude/` se leen **dos** carpetas y ninguna se escribe: `projects/`
 *    —el historial— y `sessions/`, que es el estado en vivo de cada proceso de
 *    la CLI (ver `cli-status.ts`). Nada mas se abre; en particular
 *    `.credentials.json` no se toca nunca.
 *  - Lo que la app guarda va a su propio directorio de configuracion, jamas
 *    dentro de `~/.claude/`.
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
 * Directorio de configuracion propio.
 * Windows: %APPDATA%\agent-workbench
 * macOS:   ~/Library/Application Support/agent-workbench
 * Linux:   $XDG_CONFIG_HOME/agent-workbench o ~/.config/agent-workbench
 */
export function appConfigDir(): string {
  return configDirFor('agent-workbench');
}

/**
 * Donde guardaba la configuracion la app cuando se llamaba Agent Explorer.
 * Existe solo para que `config-dir-migration.ts` mueva lo que haya ahi al
 * directorio nuevo; nadie mas lo lee ni lo escribe.
 */
export function legacyAppConfigDir(): string {
  return configDirFor('agent-explorer');
}

function configDirFor(name: string): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (appData !== undefined && appData.length > 0) return path.join(appData, name);
    return path.join(homedir(), 'AppData', 'Roaming', name);
  }

  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', name);
  }

  const xdg = process.env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.length > 0) return path.join(xdg, name);
  return path.join(homedir(), '.config', name);
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

/** Cache del indice de sesiones. Se puede borrar sin consecuencias. */
export function sessionIndexCachePath(): string {
  return path.join(appConfigDir(), 'session-index.json');
}

/** Pestanas abiertas, para restaurarlas al reabrir la app. */
export function workspaceStatePath(): string {
  return path.join(appConfigDir(), 'workspace.json');
}

/**
 * Sesiones archivadas: las que el usuario escondio de la barra lateral.
 *
 * Va en un archivo propio y **no** dentro de `workspace.json`: ese se reescribe
 * entero en cada cambio de pestanas, y dos instancias abiertas se lo pisan
 * (deuda conocida). Archivar no tiene por que heredar ese problema.
 *
 * Y va aca y no en `~/.claude/`, que es de la CLI y solo se lee (CLAUDE.md 2.1).
 */
export function archivedSessionsPath(): string {
  return path.join(appConfigDir(), 'archived-sessions.json');
}

/**
 * Notas sueltas del usuario: el texto en un JSON, las imagenes en una carpeta
 * al lado. Archivo propio por el mismo motivo que las archivadas: que
 * `workspace.json` se reescriba con cada pestana no tiene por que tocar esto.
 */
export function notesStatePath(): string {
  return path.join(appConfigDir(), 'notes.json');
}

export function notesImagesDir(): string {
  return path.join(appConfigDir(), 'notes-images');
}
