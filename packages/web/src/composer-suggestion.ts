/**
 * La sugerencia de la CLI en el cuadro de la conversacion (hito 53, §5.3.2).
 *
 * La CLI propone el mensaje siguiente en gris en su caja; el servidor la lee de
 * la pantalla y la manda con `composer.suggestion`. El cuadro la pinta en gris
 * mientras esta vacio, **sin que cuente como texto**: Enter no la manda y Enviar
 * sigue apagado. Tab, o la flechita en una pantalla tactil, la escribe en el
 * cuadro; recien ahi es un mensaje, y se manda como cualquiera. Lo pidio asi el
 * usuario.
 *
 * Puro: lo prueba `check-composer-input.mjs`.
 */

import type { TerminalId } from '@agent-workbench/shared';

export interface SuggestionView {
  /** La sugerencia de la pestana, o null si no hay. */
  suggestion: string | null | undefined;
  /** Lo escrito en el cuadro. */
  text: string;
  /** Las fichas del cuadro: texto pegado, imagenes y archivos. */
  attachments: number;
  /** El cuadro no recibe nada: sin pestana o sin CLI. */
  disabled: boolean;
}

/**
 * La sugerencia que se pinta, o null. Solo con el cuadro vacio del todo, como
 * en la CLI: un espacio escrito ya es texto, y la tapa.
 */
export function visibleSuggestion(view: SuggestionView): string | null {
  if (view.disabled || view.text.length > 0 || view.attachments > 0) return null;
  const suggestion = view.suggestion ?? null;
  return suggestion !== null && suggestion.trim().length > 0 ? suggestion : null;
}

/** Lo justo de un evento de teclado. */
export interface SuggestionKey {
  key: string;
  shiftKey: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * Si la tecla escribe la sugerencia: Tab sola, sin el IME a mitad de una
 * palabra. Con Shift o con otra tecla, Tab hace lo de siempre (pasar el foco).
 */
export function takesSuggestion(key: SuggestionKey): boolean {
  return key.key === 'Tab' && !key.shiftKey && !key.altKey && !key.ctrlKey && !key.metaKey && !key.isComposing;
}

/** Las sugerencias de cada pestana despues de un `composer.suggestion`: la misma si no cambio nada. */
export function withSuggestion(
  current: ReadonlyMap<TerminalId, string>,
  terminalId: TerminalId,
  text: string | null,
): ReadonlyMap<TerminalId, string> {
  if ((current.get(terminalId) ?? null) === text) return current;
  const next = new Map(current);
  if (text === null) next.delete(terminalId);
  else next.set(terminalId, text);
  return next;
}
