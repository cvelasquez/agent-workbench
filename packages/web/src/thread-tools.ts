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

/**
 * Qué dibuja la barra del hilo (16-11-2026, pedido del usuario para el
 * teléfono). La lupa ya no va con la flecha: la flecha muestra los botones
 * ("CLI", "Rama", la letra, el narrador) y la lupa abre el cuadro de búsqueda.
 *
 * - **PC**: desplegada, como siempre, con el cuadro a la vista (la lupa va
 *   adentro) y los dos medidores juntos. Plegada queda la lupa sola; tocarla
 *   abre el cuadro, con una × que lo cierra.
 * - **Teléfono**: una línea con la flecha, la lupa y el medidor de contexto.
 *   Buscando, el cuadro ocupa esa línea y el medidor se esconde. Desplegada,
 *   los botones van en la línea de abajo y el medidor de la semana en otra: el
 *   de contexto cambia en cada turno, el de la semana despacio.
 */
export interface ThreadBarLayout {
  /** El cuadro de búsqueda se ve; si no, sólo la lupa. */
  searchField: boolean;
  /** El cuadro lleva una × que lo cierra y borra lo buscado. */
  searchClosable: boolean;
  /** "CLI", "Rama", la letra y el narrador. */
  toolButtons: boolean;
  /** El medidor de contexto. */
  context: boolean;
  /** El medidor del plan: junto al de contexto, en su propia línea o escondido. */
  plan: 'beside-context' | 'own-line' | 'hidden';
}

export function threadBarLayout(input: { narrow: boolean; toolsOpen: boolean; searchOpen: boolean }): ThreadBarLayout {
  const { narrow, toolsOpen, searchOpen } = input;
  if (!narrow) {
    return {
      searchField: toolsOpen || searchOpen,
      searchClosable: !toolsOpen && searchOpen,
      toolButtons: toolsOpen,
      context: true,
      plan: 'beside-context',
    };
  }
  return {
    searchField: searchOpen,
    searchClosable: true,
    toolButtons: toolsOpen,
    context: !searchOpen,
    plan: toolsOpen ? 'own-line' : 'hidden',
  };
}
