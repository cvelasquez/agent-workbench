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
  /**
   * Hay una busqueda escrita. No se pide nada: saltar a un acierto no es subir,
   * y cada pagina nueva traia un acierto mas viejo al que saltar —y otra pagina,
   * hasta la sesion entera—. Encontro esa cascada la revision de la 0.5.0. El
   * boton de "cargar anteriores" sigue a mano.
   */
  searching?: boolean;
}

/** true si hay que pedir la pagina anterior: el usuario sube, esta cerca del borde y hay algo que pedir. */
export function shouldLoadEarlier(state: EarlierScrollState): boolean {
  return (
    state.hasMore &&
    !state.loading &&
    state.searching !== true &&
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

/*
  "Ir a tu mensaje anterior" (06-10-2026, ampliado el 07-10-2026). Pedido del
  usuario: al subir en el hilo, un boton como "Ir al final" pero hacia arriba,
  que lleve al ultimo mensaje que escribio; y si sigue subiendo, al anterior a
  ese, uno por uno hasta el primero de la sesion. Es para releer desde el
  principio la respuesta de un turno, o recorrer lo que pidio.

  Cuatro reglas:

   - **Lleva al mensaje propio mas cercano por encima de la vista.** Con la
     vista cerca del final es el ultimo; despues de un salto, el anterior a
     ese, porque el que quedo arriba de la vista ya no esta por encima.
   - **Aparece con "Ir al final"**, al subir, y solo si hay un mensaje propio
     por encima de lo que se ve, o paginas anteriores donde buscarlo. En el
     primero de la sesion no hay a donde ir, y se va.
   - **El mensaje puede no estar cargado.** El hilo abre con los ultimos 300
     eventos, y en una sesion real hubo mas de 400 entre dos mensajes del
     usuario. Ahi el clic pide paginas anteriores hasta dar con uno, con un
     tope.
   - **Un mensaje del usuario es un evento `user` con texto o imagen.** Los
     resultados de herramienta de Claude Code tambien llegan como `user`, y no
     los escribio el.
*/

/** Cuanto tiene que quedar el mensaje por encima de la vista para ofrecer el boton. */
export const OWN_MESSAGE_SLACK_PX = 8;

/**
 * El aire que queda arriba del mensaje despues del salto: lo que ocupa la
 * flecha en la esquina de arriba (12 + 32 px, `.conversation-jump-own`) y 8 mas,
 * para que no le tape copiar y "volver aqui".
 */
export const OWN_MESSAGE_MARGIN_PX = 52;

/** Cuantas paginas anteriores se piden, como mucho, buscando el mensaje: 2 000 eventos. */
export const OWN_MESSAGE_MAX_PAGES = 10;

/** Lo que hace falta de un evento para saber si es un mensaje del usuario. */
export interface OwnMessageCandidate {
  eventId: string;
  role: string;
  parts: readonly { kind: string }[];
}

/** Los ids de los mensajes que escribio el usuario entre los cargados, en orden. */
export function ownMessageIds(events: readonly OwnMessageCandidate[]): string[] {
  return events
    .filter((event) => event.role === 'user' && event.parts.some((part) => part.kind === 'text' || part.kind === 'image'))
    .map((event) => event.eventId);
}

/**
 * El indice del mensaje propio mas cercano por encima de la vista, o null si no
 * hay ninguno cargado. `topAt(i)`: el borde de arriba del mensaje `i` menos el
 * de la vista, en px —negativo si quedo por encima—, o null si no esta dibujado.
 *
 * Recorre desde el ultimo y se queda con el primero que esta por encima: los
 * mensajes van en orden, asi que es el mas cercano. Con la vista cerca del
 * final casi no recorre nada.
 */
export function nearestOwnAbove(count: number, topAt: (index: number) => number | null): number | null {
  for (let index = count - 1; index >= 0; index -= 1) {
    const top = topAt(index);
    if (top !== null && top < -OWN_MESSAGE_SLACK_PX) return index;
  }
  return null;
}

export interface OwnJumpOffer {
  /** El final no esta a la vista: el mismo criterio que muestra "Ir al final". */
  awayFromEnd: boolean;
  /** Hay un mensaje propio cargado por encima de la vista (`nearestOwnAbove`). */
  ownAbove: boolean;
  hasMore: boolean;
}

/** true si se ofrece el boton: al subir, con un mensaje propio arriba o paginas donde buscarlo. */
export function offerJumpToOwn(state: OwnJumpOffer): boolean {
  return state.awayFromEnd && (state.ownAbove || state.hasMore);
}

/** El `scrollTop` que deja el mensaje arriba de la vista, con su aire, y nunca por encima de 0. */
export function scrollTopForOwn(scrollTop: number, ownTop: number): number {
  return Math.max(0, scrollTop + ownTop - OWN_MESSAGE_MARGIN_PX);
}

export interface OwnSeekState {
  /** Ya hay un mensaje propio cargado por encima de la vista. */
  found: boolean;
  hasMore: boolean;
  /** Hay una pagina en camino. */
  loading: boolean;
  /** Cuantas paginas pidio esta busqueda. */
  pagesRequested: number;
}

/**
 * Que hace un clic que no encontro el mensaje cargado, cada vez que cambia el
 * hilo: saltar, esperar la pagina en camino, pedir otra, o rendirse —sin mas
 * paginas, o pasado el tope—.
 */
export function ownSeekStep(state: OwnSeekState): 'jump' | 'wait' | 'load' | 'give-up' {
  if (state.found) return 'jump';
  if (state.loading) return 'wait';
  if (!state.hasMore || state.pagesRequested >= OWN_MESSAGE_MAX_PAGES) return 'give-up';
  return 'load';
}
