/**
 * Rutas propias de la app.
 *
 * Lo que la app guarda va a su propio directorio de configuracion, jamas
 * dentro de las carpetas de una CLI. Las rutas que se leen de cada CLI viven en
 * su adaptador (`agents/claude-code/paths.ts`).
 */

import { homedir } from 'node:os';
import path from 'node:path';

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
