/**
 * La tecla con la que Claude Code aparta lo escrito en su caja (§5.3.1, §4.4.4).
 *
 * Ctrl+S (`chat:stash` en su binario 2.1.312). Medido en vivo con Haiku
 * (`docs/herramientas/borrador-cli/medir-borrador.mjs`):
 *
 * ```
 *                                    › stashed     lo apartado, mientras dure
 * ────────────────────────────────────────────
 * ❯                                                la caja, vacia
 * ────────────────────────────────────────────
 * ```
 *
 *  - Con texto, lo aparta y vacia la caja en ~90 ms. Al enviar lo devuelve sola
 *    ("Draft restored"): con el agente libre, trabajando (el mensaje va a su
 *    cola) y despues de un `/effort`. Un `[Pasted text #1 +5 lines]` vuelve con
 *    su contenido.
 *  - Con la caja vacia, saca lo apartado: por eso se aprieta solo con texto.
 *  - Aparta uno solo: con texto y algo ya apartado, lo pisa.
 *  - La caja vacia muestra una ayuda atenuada (`Try "…"`); lo escrito no lo es.
 *
 * Puro: lo prueba `check-composer-input.mjs` con las pantallas medidas.
 */

import type { DraftBox, DraftStash } from '../adapter.js';

const CTRL_S = '\x13';
const MARKER = '❯';
const RULE = /^─{8,}/;
const SAVED = /›\s*stashed\b/;
/** Con algo en cola, la caja vacia lo dice (§6.35.1). No es algo escrito, atenuado o no. */
export const QUEUE_HINT = 'Press up to edit queued messages';

/** Donde esta la caja en la pantalla: la linea de la marca y la de la regla que la cierra. */
export interface ClaudeCodeBoxPlace {
  marker: number;
  close: number;
}

/**
 * La caja de Claude Code: la ultima linea con la marca, entre dos reglas (la de
 * justo arriba y la que la cierra abajo). null si no se ve.
 */
export function locateClaudeCodeBox(lines: readonly string[]): ClaudeCodeBoxPlace | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!(lines[index] ?? '').trim().startsWith(MARKER)) continue;
    // Un menu tambien marca su opcion con la flecha, pero no entre reglas.
    if (index === 0 || !RULE.test((lines[index - 1] ?? '').trim())) return null;
    // La ultima opcion de un menu de pregunta tambien queda bajo una regla, pero nada la cierra.
    for (let next = index + 1; next < lines.length; next += 1) {
      if (RULE.test((lines[next] ?? '').trim())) return { marker: index, close: next };
    }
    return null;
  }
  return null;
}

/**
 * Lo escrito en la caja, y si hay algo apartado: eso se anuncia en la linea de
 * los avisos, encima de la regla. Las lineas llegan sin el texto atenuado.
 */
export function readClaudeCodeDraftBox(lines: readonly string[]): DraftBox | null {
  const place = locateClaudeCodeBox(lines);
  if (place === null) return null;
  const written = lines
    .slice(place.marker, place.close)
    .map((line, offset) => (offset === 0 ? line.trim().slice(MARKER.length) : line).trim())
    .join('\n')
    .trim();
  const notices = lines.slice(Math.max(0, place.marker - 3), place.marker - 1);
  return {
    text: written.length > 0 && !written.startsWith(QUEUE_HINT),
    saved: notices.some((notice) => SAVED.test(notice)),
  };
}

export const CLAUDE_CODE_DRAFT_STASH: DraftStash = {
  key: CTRL_S,
  readBox: readClaudeCodeDraftBox,
};
