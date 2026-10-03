/**
 * Cargar los mensajes anteriores al subir, sin clic (0.5.0).
 *
 * Pedido del usuario: al subir en el hilo y chocar con el borde de arriba, que
 * cargue solo, en vez de esperar el clic en "Cargar mensajes anteriores". Lo
 * puro vive aca para que el chequeo lo pruebe sin un navegador.
 *
 * Tres reglas:
 *
 *  - **Se pide al subir, no al estar arriba.** Abrir una conversacion, bajar al
 *    final o saltar a un acierto no son el usuario subiendo: sin esta regla, una
 *    conversacion corta que entra entera en la pantalla pediria todo su
 *    historial al abrirse.
 *  - **Una pantalla antes del borde**, y nunca menos de 200 px. Pedir al tocar el
 *    borde deja un salto visible mientras llega la pagina; pedir antes hace que
 *    casi siempre ya este cuando se llega.
 *  - **Al sumar arriba, la vista no se mueve.** Lo que se agrega va antes de lo
 *    que se estaba leyendo, y la distancia al final del hilo es la que no cambia.
 *    Si el navegador ya ancla la vista solo, reponer esa distancia no hace nada;
 *    si no, la devuelve a su sitio. Sin esto, la vista quedaria arriba de lo
 *    recien cargado y pediria otra pagina, y otra, hasta traer la sesion entera.
 */

/** El minimo de anticipacion, para una ventana muy baja. */
export const EARLIER_MIN_THRESHOLD_PX = 200;

/** Cuantos pixeles antes del borde de arriba se pide la pagina anterior. */
export function earlierThresholdPx(clientHeight: number): number {
  return Math.max(EARLIER_MIN_THRESHOLD_PX, clientHeight);
}

export interface EarlierScrollState {
  scrollTop: number;
  /** El `scrollTop` del aviso anterior: decide si el usuario sube. */
  previousScrollTop: number;
  clientHeight: number;
  hasMore: boolean;
  /** Hay un pedido en camino. */
  loading: boolean;
}

/** true si hay que pedir la pagina anterior: el usuario sube, esta cerca del borde y hay algo que pedir. */
export function shouldLoadEarlier(state: EarlierScrollState): boolean {
  return (
    state.hasMore &&
    !state.loading &&
    state.scrollTop < state.previousScrollTop &&
    state.scrollTop <= earlierThresholdPx(state.clientHeight)
  );
}

/**
 * La rueda hacia arriba con la vista ya pegada al borde: no hay `scroll`, porque
 * el `scrollTop` no puede bajar de 0. Pasa cuando la pagina que llego no sumo
 * nada que dibujar. Cuenta como subir.
 */
export function wheelAsksEarlier(deltaY: number, scrollTop: number, clientHeight: number): boolean {
  return deltaY < 0 && scrollTop <= earlierThresholdPx(clientHeight);
}

/** Donde dejar el scroll despues de sumar arriba: a la misma distancia del final que antes. */
export function scrollTopAfterPrepend(distanceFromEnd: number, scrollHeight: number): number {
  return Math.max(0, scrollHeight - distanceFromEnd);
}

/**
 * true si la lista nueva es la anterior con eventos sumados adelante, y no otra
 * conversacion: el que era el primero sigue estando, pero ya no es el primero.
 */
export function isPrepend(previousFirstId: string | null, nextIds: readonly string[]): boolean {
  if (previousFirstId === null || nextIds.length === 0 || nextIds[0] === previousFirstId) return false;
  return nextIds.includes(previousFirstId);
}
