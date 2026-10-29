/**
 * La sugerencia de Claude Code: el mensaje siguiente que propone, en gris en su
 * caja vacia (hito 53, §5.3.2, §4.4.5).
 *
 * Medido con la 2.1.312 (`docs/herramientas/borrador-cli/medir-sugerencia.mjs`):
 *
 * ```
 * ──────────────────────────────────────────────
 * ❯ Respuesta de prueba: ahora agrega una seccion de uso      atenuada (SGR 2)
 * ──────────────────────────────────────────────
 * ```
 *
 *  - No esta en ningun archivo: ni en el JSONL ni en `sessions/<pid>.json`.
 *  - Aparece segundos despues de terminar el turno y dura hasta el siguiente.
 *    Teclear o pegar la tapa; al vaciar la caja vuelve. Tab la pasa a la caja.
 *  - La caja vacia de una sesion nueva muestra otra cosa atenuada, la ayuda
 *    `Try "…"`: no es una sugerencia.
 *
 * Puro: lo prueba `check-composer-input.mjs` con las pantallas medidas.
 */

import type { PromptSuggestionReader } from '../adapter.js';
import { QUEUE_HINT, locateClaudeCodeBox, readClaudeCodeDraftBox } from './draft-stash.js';

/** La ayuda de la caja vacia de una sesion nueva: `Try "how do I log an error?"`. */
const PLACEHOLDER = /^Try "/;
/** Un texto asi de largo en gris no es una sugerencia. */
const MAX_SUGGESTION_CHARS = 2_000;

/**
 * Lo que esta en gris en la caja vacia, en una linea: si no entra en una, la CLI
 * la parte por palabras y aca se vuelve a juntar. null si la caja no se ve,
 * tiene algo escrito, o lo gris es la ayuda o el aviso de la cola. Una que
 * termina en `…` llego cortada: no se sabe como sigue, y no se ofrece.
 */
export function readClaudeCodeSuggestion(clean: readonly string[], faint: readonly string[]): string | null {
  const box = readClaudeCodeDraftBox(clean);
  const place = locateClaudeCodeBox(clean);
  if (box === null || place === null || box.text) return null;
  const text = faint
    .slice(place.marker, place.close)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .trim();
  if (text.length === 0 || text.length > MAX_SUGGESTION_CHARS) return null;
  if (PLACEHOLDER.test(text) || text.startsWith(QUEUE_HINT) || text.endsWith('…')) return null;
  return text;
}

export const CLAUDE_CODE_PROMPT_SUGGESTION: PromptSuggestionReader = {
  read: readClaudeCodeSuggestion,
};
