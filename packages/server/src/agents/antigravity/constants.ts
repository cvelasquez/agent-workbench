/**
 * Datos de compatibilidad de Antigravity CLI: el comando, los modos, los
 * modelos y los nombres que usa esta app para lo suyo.
 *
 * Son configuracion, no marca (regla 2.3). Todo medido el 14-09-2026 contra la
 * 1.2.2, con un home falso (hito 27, paso 0), y vuelto a medir con la 1.3.6 el
 * 15-10-2026 (CLAUDE.md 12.12): donde un valor sale de la documentacion y no de
 * una medicion, se dice.
 */

import type { EffortOption, ModelOption, PermissionMode } from '@agent-workbench/shared';

/** Nombre del comando en el PATH. En Windows resuelve a un `agy.exe` real. */
export const ANTIGRAVITY_COMMAND = 'agy';

/** Nombre para el usuario cuando hay mas de una CLI y para los avisos. */
export const ANTIGRAVITY_LABEL = 'Antigravity CLI';

export const ANTIGRAVITY_INSTALL_URL = 'https://antigravity.google/docs/cli/getting-started';

/**
 * Con que modo se lanza cada pestana (`--mode accept-edits`).
 *
 * Por lo mismo que Claude Code arranca en `auto` (CLAUDE.md 4.8.1): que las
 * pestanas no se frenen a preguntar por cada edicion. Los comandos siguen
 * pidiendo permiso. Medido: se aplica al lanzar y al reanudar.
 */
export const ANTIGRAVITY_LAUNCH_MODE: PermissionMode = 'acceptEdits';

/**
 * El ciclo de `shift+tab`, en el orden de la app.
 *
 * Medido dos vueltas desde `--mode accept-edits`: `accept-edits -> plan ->
 * default -> accept-edits`. Es el mismo ciclo de tres empezando por otro lado.
 * En la CLI `default` no tiene nombre en pantalla y `accept-edits` se escribe
 * con guion; la traduccion vive en `mode-names.ts`.
 */
export const ANTIGRAVITY_MODE_CYCLE: readonly PermissionMode[] = ['default', 'acceptEdits', 'plan'];

const model = (value: string, label: string): ModelOption => ({
  value,
  label,
  family: label,
  long: false,
  window: null,
});

/**
 * Los modelos de `agy models`, tal cual y en su orden.
 *
 * `value` es el slug **con** el esfuerzo: medido, `/model gemini-3.8-flash`
 * falla pidiendo el esfuerzo ("available: low, medium, high") y
 * `/model gemini-3.8-flash-low` funciona. La familia es la etiqueta completa,
 * porque es lo que la CLI escribe de vuelta —en `settings.json`, en el aviso de
 * cambio de modelo del historial y en la status line—: `Gemini 3.8 Flash (Low)`.
 * Dos avisos: `/model` y `/effort` **guardan** el elegido como predeterminado de
 * la CLI, y la lista es la de una cuenta en una fecha. Sin ventana: la da la
 * status line.
 *
 * Re-medida con la 1.3.6 el 15-10-2026: de los 14 del 14-09-2026 quedan 6. Los
 * de Gemini 3.7 Flash, 3.6 Flash y 3.1 Pro ya no estan, y elegirlos da
 * `Invalid model "gemini-3.7-flash-low" (available: …)` sin cambiar nada. El
 * binario conoce otros (Gemini 4 Argon, Claude Opus 5.5) que esta cuenta no
 * ofrece.
 */
export const ANTIGRAVITY_MODEL_OPTIONS: readonly ModelOption[] = [
  model('gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'),
  model('gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)'),
  model('gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)'),
  model('claude-sonnet-4-6', 'Claude Sonnet 4.6 (Thinking)'),
  model('claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)'),
  model('gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)'),
];

/**
 * Lo que acepta `/effort` (medido con `medium` y `high`; `low` segun `--help`).
 *
 * La 1.3.6 anuncia ademas `xhigh` y `max` en `--effort`, pero ningun modelo de
 * la lista los acepta: `/effort xhigh` responde `gemini-3.8-flash has no
 * "xhigh" effort (available: low, medium, high)`, y con Claude Sonnet 4.6
 * "Effort isn't adjustable" (medido el 15-10-2026).
 */
export const ANTIGRAVITY_EFFORT_OPTIONS: readonly EffortOption[] = [
  { value: 'low', label: 'Bajo' },
  { value: 'medium', label: 'Medio' },
  { value: 'high', label: 'Alto' },
];

/** El id de una conversacion: un uuid. Se valida antes de armar cualquier ruta. */
export const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nombre del script de la status line que la app escribe en su carpeta. */
export const STATUS_LINE_SCRIPT_NAME = 'antigravity-statusline.mjs';
