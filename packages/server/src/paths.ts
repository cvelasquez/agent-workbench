/**
 * Rutas propias de la app.
 *
 * Lo que la app guarda va a su propio directorio de configuracion, jamas
 * dentro de las carpetas de una CLI. Las rutas que se leen de cada CLI viven en
 * su adaptador (`agents/claude-code/paths.ts`).
 */

import { homedir, tmpdir } from 'node:os';
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
 * Ajustes de la app (hito 28: la copia propia). Archivo propio y no dentro de
 * `workspace.json`, por lo mismo que las archivadas: ese se reescribe entero con
 * cada cambio de pestanas.
 */
export function appSettingsPath(): string {
  return path.join(appConfigDir(), 'settings.json');
}

/**
 * Los equipos emparejados para el acceso remoto (hito 37). Aparte de
 * `settings.json` a proposito: ese lo reescribe entero cada build con lo que
 * conoce, y una anterior que comparta la carpeta se los llevaria.
 */
export function remoteDevicesPath(): string {
  return path.join(appConfigDir(), 'remote-devices.json');
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

/**
 * Donde se copia, un instante, el indice de conversaciones de Antigravity CLI
 * para leerlo: una subcarpeta por lectura, que se borra al terminar.
 *
 * En la carpeta temporal y no en la de configuracion porque es efimero, y bajo
 * `agent-workbench/` para no mezclarse con nada ajeno. Nunca en
 * `agent-workbench/log/`: la CLI limpia por su cuenta la carpeta `log` que es
 * hermana de la de su `--log-file` (medido en el hito 27).
 */
export function catalogTempDir(): string {
  return path.join(tmpdir(), 'agent-workbench', 'agy-catalog');
}

/**
 * Donde escribe cada pestana de Antigravity CLI el log de la CLI (`--log-file`),
 * un archivo por lanzamiento. De ahi sale el id de la conversacion.
 *
 * Trae el texto de los prompts y el email de la cuenta (medido): se crea con
 * permisos solo del usuario y se borra a las 24 h, no al cerrar la pestana,
 * para no llevarse el diagnostico de la CLI (M8). El nombre no puede ser `log`:
 * al salir, la CLI limpia la carpeta `log` hermana de la del archivo, que con
 * esta es `agent-workbench/log` y la app no usa.
 */
export function cliLogsTempDir(): string {
  return path.join(tmpdir(), 'agent-workbench', 'cli-logs');
}

/**
 * Lo que la app instala para que una CLI le cuente algo: hoy, el script de la
 * status line de Antigravity CLI. Vive en la carpeta propia porque el usuario lo
 * nombra en la configuracion de la CLI, y tiene que estar ahi en cada arranque.
 */
export function integrationsDir(): string {
  return path.join(appConfigDir(), 'integrations');
}

/**
 * El estado que publica una CLI por un script de la app, un archivo por
 * conversacion. Hermana de `integrationsDir()`: el script la encuentra
 * relativa a si mismo, sin que nadie le pase la ruta.
 */
export function agentStatusDir(agent: string): string {
  return path.join(appConfigDir(), 'agent-status', agent);
}
