/**
 * Mandarle un mensaje programado a OpenCode por su `serve` (hito 52, §11.16),
 * sin tocar la pantalla del TUI.
 *
 * Medido con la 1.19.4, con un `serve` propio, una base de prueba y un
 * proveedor falso (`docs/herramientas/programar/medir-opencode.mjs`):
 *
 *  - `POST /session/{id}/prompt_async` contesta 204 en ~40 ms, la sesion pasa
 *    a trabajando en ~0,1 s y el mensaje esta en la base en el acto. Con el TUI
 *    enganchado (`attach`), el TUI lo muestra a los ~2 s, con su respuesta.
 *  - **Sin `agent`, usa el agente predeterminado** (`build`), no el de la
 *    conversacion: un mensaje mandado despues de uno en `plan` salio en
 *    `build`. Sin `model`, si usa el ultimo de la conversacion. Por eso se le
 *    pasan los tres del ultimo mensaje del usuario (`lastUserPrompt`).
 *  - Una sesion que no existe contesta 404.
 *
 * Lo que no se sabe: el agente que el usuario eligio en el TUI y todavia no uso
 * (vive en la memoria del TUI). Manda el del ultimo mensaje.
 */

import { OPENCODE_SQL, type LastUserPromptRow } from './sql.js';
import type { OpenCodePromptChoice } from './serve-client.js';
import type { ReadOnlyDatabase } from '../sqlite.js';

/** Cuanto se espera a ver el mensaje en la base despues de que el `serve` lo acepto. */
export const OPENCODE_SCHEDULED_CONFIRM_MS = 30_000;

/** Un texto corto de la base, o null. */
function shortText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : null;
}

/** El agente, el modelo y la variante del ultimo mensaje del usuario, o null si no hay ninguno. */
export function readLastUserPrompt(db: ReadOnlyDatabase, sessionId: string): OpenCodePromptChoice | null {
  const row = db.all<LastUserPromptRow>(OPENCODE_SQL.lastUserPrompt, { $s: sessionId }).at(-1);
  if (row === undefined) return null;
  return {
    agent: shortText(row.agent),
    providerID: shortText(row.provider_id),
    modelID: shortText(row.model_id),
    variant: shortText(row.variant),
  };
}
