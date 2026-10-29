/**
 * La barra del hilo plegable (29-10-2026), como la cinta de opciones de un
 * procesador de texto: la búsqueda, "CLI", "Rama" y el tamaño de letra se
 * pliegan, y los medidores de contexto y del plan quedan siempre a la vista.
 *
 * Es una preferencia de esta pantalla, como el tamaño de letra
 * (`window-prefs.ts`). La vista angosta guarda la suya en otra clave, como su
 * vista elegida: en el teléfono empieza plegada, para que el hilo gane la
 * línea, y en la PC desplegada, como estaba siempre.
 *
 * Puro y sin DOM, para que `check-narrow-layout.mjs` lo pueda importar.
 */

export const THREAD_TOOLS_STORAGE_KEY = 'agent-workbench.thread-tools';
export const NARROW_THREAD_TOOLS_STORAGE_KEY = 'agent-workbench.narrow-thread-tools';

export function threadToolsStorageKey(narrow: boolean): string {
  return narrow ? NARROW_THREAD_TOOLS_STORAGE_KEY : THREAD_TOOLS_STORAGE_KEY;
}

/** Sin nada guardado: desplegada en la PC, plegada en la vista angosta. */
export function defaultThreadToolsOpen(narrow: boolean): boolean {
  return !narrow;
}

export function threadToolsValue(open: boolean): string {
  return open ? 'open' : 'closed';
}

export function parseStoredThreadTools(raw: string): boolean | null {
  if (raw === 'open') return true;
  if (raw === 'closed') return false;
  return null;
}
