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

export function threadBarLayout(input: {
  narrow: boolean;
  /** En la PC, sin lugar para el cuadro con los botones a la vista (`nextCompactSearch`). */
  compact: boolean;
  toolsOpen: boolean;
  searchOpen: boolean;
}): ThreadBarLayout {
  const { narrow, compact, toolsOpen, searchOpen } = input;
  /*
    Una columna angosta de la PC (16-11-2026, antes de la 1.1.0): con los
    botones a la vista el cuadro se achicaba hasta quedar en la lupa. Ahi la PC
    hace lo del telefono: la lupa abre el cuadro, que toma el lugar de los
    medidores mientras se busca.
  */
  if (!narrow && compact && toolsOpen) {
    return {
      searchField: searchOpen,
      searchClosable: true,
      toolButtons: true,
      context: !searchOpen,
      plan: searchOpen ? 'hidden' : 'beside-context',
    };
  }
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

/** Por debajo de este ancho el cuadro de búsqueda no sirve: se ve sólo la lupa. */
export const SEARCH_FIELD_MIN_PX = 140;
/** Lo que tiene que sobrar de más para que el cuadro vuelva: sin esto, va y viene en el borde. */
export const SEARCH_FIELD_HYSTERESIS_PX = 24;

/**
 * Si la fila de la PC se queda sin lugar para el cuadro, medido después de
 * dibujarla. Con el cuadro a la vista, mide el cuadro (`fieldWidth`); con la
 * lupa sola, lo que queda libre al lado de la lupa contándola a ella
 * (`freeWidth`), que es lo que el cuadro tendría.
 */
export function nextCompactSearch(current: boolean, measured: { fieldWidth: number | null; freeWidth: number }): boolean {
  if (!current) return measured.fieldWidth !== null && measured.fieldWidth < SEARCH_FIELD_MIN_PX;
  return measured.freeWidth < SEARCH_FIELD_MIN_PX + SEARCH_FIELD_HYSTERESIS_PX;
}
