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

/*
  Volver a una pestana donde se habia subido a leer (11-10-2026). Pedido del
  usuario: va y viene entre dos pestanas con Shift+Tab, sube en una para leer o
  copiar algo, y cada vuelta lo devolvia al final. Cada pestana abre al final
  (§6.27), y eso sigue: lo que cambia es que **subir a mano se recuerda por
  pestana**. Al volver, el hilo queda donde estaba, y "Ir al final" se enciende
  en dos pulsos, con su texto a la vista (`attention-pulse.ts`), para que se
  note que el final no esta a la vista.

  Cuatro reglas:

   - **Se guarda una tarjeta, no una cantidad de pixeles.** Al volver, el hilo
     se vuelve a pedir: trae el tramo final, con lo que llego mientras tanto, y
     ya no mide lo mismo. Lo que no cambia es la primera tarjeta que se veia y
     cuanto asomaba.
   - **Solo si el usuario habia subido.** Si estaba al final, no hay nada que
     recordar, y lo guardado de antes se olvida: la pestana vuelve a abrir al
     final.
   - **Si la tarjeta ya no esta dibujada, la siguiente que lo este.** Una tanda
     de herramientas que el usuario habia abierto vuelve plegada. Y si ya no
     esta ni cargada —quedo mas atras del tramo que se trae al abrir—, la
     pestana abre al final, como siempre.
   - **Lo que llego mientras se miraba otra pestana se cuenta**, igual que lo
     que llega con el hilo subido: "Ir al final: 2 mensajes nuevos".
*/

/** De que alto de borde se pasa para decir que una tarjeta se ve: una que termina justo ahi no cuenta. */
export const ANCHOR_SLACK_PX = 1;

/** El borde de arriba y el de abajo de una tarjeta, menos el de arriba de la vista, en px. */
export interface CardSpan {
  top: number;
  bottom: number;
}

/** Donde estaba la vista de una pestana al salir de ella. */
export interface ThreadAnchor {
  /** La primera tarjeta que se veia. */
  eventId: string;
  /** Su borde de arriba menos el de la vista: negativo si empezaba mas arriba. */
  offset: number;
  /** La ultima tarjeta que habia: lo que venga despues llego mientras tanto. */
  lastId: string | null;
}

/**
 * La tarjeta que ancla la vista: la primera dibujada cuyo borde de abajo pasa
 * el de arriba de la vista. `spanOf` da null si la tarjeta no esta dibujada
 * —dentro de una tanda plegada, por ejemplo—.
 */
export function threadAnchorOf(
  ids: readonly string[],
  spanOf: (eventId: string) => CardSpan | null,
): ThreadAnchor | null {
  for (const eventId of ids) {
    const span = spanOf(eventId);
    if (span === null || span.bottom <= ANCHOR_SLACK_PX) continue;
    return { eventId, offset: span.top, lastId: ids[ids.length - 1] ?? null };
  }
  return null;
}

/**
 * El `scrollTop` que deja la vista donde estaba, o null si no hay donde
 * volver: la tarjeta guardada ya no esta cargada, o no queda ninguna dibujada
 * de ahi en adelante.
 *
 * Si la tarjeta esta pero no dibujada, se usa la siguiente que lo este, pegada
 * al borde de arriba: es lo mas cerca que se puede quedar.
 */
export function scrollTopForAnchor(
  anchor: ThreadAnchor,
  ids: readonly string[],
  spanOf: (eventId: string) => CardSpan | null,
  scrollTop: number,
): number | null {
  const start = ids.indexOf(anchor.eventId);
  if (start === -1) return null;
  for (let index = start; index < ids.length; index += 1) {
    const id = ids[index];
    const span = id === undefined ? null : spanOf(id);
    if (span === null) continue;
    return Math.max(0, scrollTop + span.top - (index === start ? anchor.offset : 0));
  }
  return null;
}

/** Cuantas tarjetas llegaron despues de la que era la ultima al salir. 0 si esa ya no esta cargada. */
export function arrivedSince(ids: readonly string[], lastId: string | null): number {
  if (lastId === null) return 0;
  const index = ids.lastIndexOf(lastId);
  return index === -1 ? 0 : ids.length - 1 - index;
}
