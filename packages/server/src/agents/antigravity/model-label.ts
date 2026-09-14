/**
 * Como nombra Antigravity CLI al modelo que corre.
 *
 * No por slug sino por etiqueta, con el esfuerzo entre parentesis:
 * `Gemini 3.8 Flash (High)`. Asi lo escribe en `settings.json`, en la status
 * line y en el aviso que le deja al modelo en el historial cuando cambia:
 *
 *   The user changed setting `Model Selection` from None to Gemini 3.8 Flash (High). No need to comment…
 *
 * Medido en la 1.2.2: el aviso sale en el mensaje **siguiente** al cambio y con
 * el ultimo valor; un `/effort` tambien cambia la etiqueta.
 */

export interface ModelLabelParts {
  /** La etiqueta sin el esfuerzo. */
  model: string;
  /** `low`, `medium` o `high`, o null si la etiqueta no lo trae. */
  effort: string | null;
}

const EFFORT_SUFFIX = /^(.*?)\s*\((low|medium|high)\)\s*$/i;

/**
 * Separa el esfuerzo de la etiqueta. `Claude Sonnet 4.6 (Thinking)` no lo
 * trae: el parentesis es parte del nombre y queda tal cual.
 */
export function splitModelLabel(label: string): ModelLabelParts {
  const match = EFFORT_SUFFIX.exec(label);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return { model: label.trim(), effort: null };
  }
  return { model: match[1].trim(), effort: match[2].toLowerCase() };
}

const SETTINGS_CHANGE = /changed setting `Model Selection` from .+? to (.+?)\. No need to comment/g;

/**
 * La etiqueta nueva de un bloque `USER_SETTINGS_CHANGE`, o null si el bloque
 * no habla del modelo. Si nombra mas de un cambio, gana el ultimo.
 *
 * Es texto en ingles para el modelo, no un dato: si una version lo redacta de
 * otra forma, esto da null y el hilo se queda sin modelo, que es lo mismo que
 * mostraba antes de saberlo.
 */
export function parseSettingsChange(block: string): string | null {
  let label: string | null = null;
  for (const match of block.matchAll(SETTINGS_CHANGE)) {
    const value = match[1]?.trim();
    if (value !== undefined && value.length > 0) label = value;
  }
  return label;
}
