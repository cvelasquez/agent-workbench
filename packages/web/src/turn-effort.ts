/**
 * El esfuerzo al pie de un mensaje del agente, solo cuando cambia (16-11-2026,
 * pedido del usuario al ordenar la vista del teléfono). Lo dibujaba cada
 * mensaje, y en un hilo largo era la misma etiqueta debajo de cada uno.
 *
 * Lo dice el primero que lo trae y después el que lo cambia. Un mensaje sin
 * esfuerzo (el del usuario, o una CLI que no lo escribe) no cuenta como cambio.
 * El combo de esfuerzo del cuadro sigue diciendo el de ahora.
 *
 * Puro y sin DOM, para que `check-thread-status.mjs` lo pueda importar.
 */
export function effortShownIds(events: readonly { eventId: string; effort: string | null }[]): ReadonlySet<string> {
  const shown = new Set<string>();
  let last: string | null = null;
  for (const event of events) {
    if (event.effort === null) continue;
    if (event.effort !== last) shown.add(event.eventId);
    last = event.effort;
  }
  return shown;
}
