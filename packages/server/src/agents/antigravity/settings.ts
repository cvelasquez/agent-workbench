/**
 * Lo que se lee de `~/.gemini/antigravity-cli/settings.json`: el modelo y si la
 * status line de la app esta configurada. Nada mas.
 *
 * El archivo es del usuario y de la CLI —la CLI lo reescribe al aceptar la
 * confianza en una carpeta, con `/model` y con `/effort` (medido)— y la app no
 * lo escribe nunca. De todo lo que trae se toman dos claves, `model` y
 * `statusLine`; el objeto parseado no sale de esta funcion, y el comando de la
 * status line solo se compara contra el nombre del script: no se guarda, no se
 * loguea y no viaja al cliente.
 */

import { readFile, stat } from 'node:fs/promises';
import type { StatusLineState } from '@agent-workbench/shared';
import { STATUS_LINE_SCRIPT_NAME } from './constants.js';
import { settingsPath } from './paths.js';

/** Mas que esto no es una configuracion: no se lee. */
export const SETTINGS_MAX_BYTES = 256 * 1024;

export interface AntigravitySettings {
  /** La etiqueta tal como la guarda la CLI (`Gemini 3.7 Flash (Low)`), o null. */
  model: string | null;
  statusLine: { state: StatusLineState };
}

const settings = (model: string | null, state: StatusLineState): AntigravitySettings => ({
  model,
  statusLine: { state },
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * El estado de la status line segun el valor de `statusLine`.
 *
 * `active` exige las dos cosas que la hacen correr: que sea un comando y que
 * nombre el script de la app. Otro comando es `other-command` —pegar el
 * fragmento lo reemplazaria, y el dialogo lo dice—; `enabled: false` la
 * suspende sin borrarla.
 */
export function statusLineStateOf(value: unknown): StatusLineState {
  const statusLine = asRecord(value);
  if (statusLine === null || statusLine['type'] !== 'command') return 'missing';
  const command = statusLine['command'];
  if (typeof command !== 'string') return 'missing';
  if (!command.toLowerCase().includes(STATUS_LINE_SCRIPT_NAME.toLowerCase())) return 'other-command';
  return statusLine['enabled'] === false ? 'disabled' : 'active';
}

/** El modelo y el estado de la status line. Nunca lanza. */
export async function readAntigravitySettings(file: string = settingsPath()): Promise<AntigravitySettings> {
  let text: string;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > SETTINGS_MAX_BYTES) return settings(null, 'unreadable');
    text = await readFile(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return settings(null, code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }

  let parsed: Record<string, unknown> | null;
  try {
    // Un BOM al principio lo deja un editor de Windows; JSON.parse no lo acepta.
    parsed = asRecord(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text));
  } catch {
    parsed = null;
  }
  if (parsed === null) return settings(null, 'unreadable');

  const rawModel = parsed['model'];
  const model = typeof rawModel === 'string' && rawModel.trim().length > 0 ? rawModel.trim() : null;
  return settings(model, statusLineStateOf(parsed['statusLine']));
}
