/**
 * Si la status line de la app esta puesta en `~/.claude/settings.json` (hito 47,
 * §4.17). Nada mas.
 *
 * Es el mismo archivo del que `agent-defaults.ts` lee `model` y
 * `modelSettings`, y con la misma regla: de todo lo que trae se mira una clave,
 * `statusLine`, y su comando solo se compara contra el nombre del script. No se
 * guarda, no se loguea y no viaja al cliente. El archivo puede traer `env` con
 * claves de la cuenta: el objeto parseado no sale de esta funcion.
 *
 * Solo el del usuario: una status line en el `settings.json` de un proyecto
 * gana dentro de ese proyecto, y eso no se mira (§4.17).
 */

import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { StatusLineState } from '@agent-workbench/shared';
import { CLAUDE_STATUS_LINE_SCRIPT_NAME } from './statusline-script.js';

/** Mas que esto no es una configuracion: no se lee. */
export const CLAUDE_SETTINGS_MAX_BYTES = 256 * 1024;

/** `~/.claude/settings.json`, la configuracion del usuario. */
export function claudeUserSettingsPath(): string {
  return path.join(homedir(), '.claude', 'settings.json');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * El estado segun el valor de `statusLine`: `active` si es un comando que
 * nombra el script de la app; `other-command` si es otro (pegar el fragmento lo
 * reemplaza, y el dialogo lo dice); `missing` si no hay ninguno.
 */
export function claudeStatusLineStateOf(value: unknown): StatusLineState {
  const statusLine = asRecord(value);
  if (statusLine === null || statusLine['type'] !== 'command') return 'missing';
  const command = statusLine['command'];
  if (typeof command !== 'string') return 'missing';
  if (!command.toLowerCase().includes(CLAUDE_STATUS_LINE_SCRIPT_NAME.toLowerCase())) return 'other-command';
  return statusLine['enabled'] === false ? 'disabled' : 'active';
}

/** El estado de la status line de la app. Nunca lanza. */
export async function readClaudeStatusLineState(file: string = claudeUserSettingsPath()): Promise<StatusLineState> {
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > CLAUDE_SETTINGS_MAX_BYTES) return 'unreadable';
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable';
  }
  let parsed: Record<string, unknown> | null;
  try {
    // Un BOM al principio lo deja un editor de Windows; JSON.parse no lo acepta.
    parsed = asRecord(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    parsed = null;
  }
  if (parsed === null) return 'unreadable';
  return claudeStatusLineStateOf(parsed['statusLine']);
}

/** Fecha y tamano del archivo, para saber si cambio sin leerlo. `none` si no esta. */
export async function claudeSettingsStamp(file: string = claudeUserSettingsPath()): Promise<string> {
  try {
    const info = await stat(file);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return 'none';
  }
}
