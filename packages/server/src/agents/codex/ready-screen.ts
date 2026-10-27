/**
 * Si la pantalla de Codex muestra su caja vacia, lista para recibir un mensaje
 * programado (hito 52, §10.18).
 *
 * Medido el 26-10-2026 con la 0.164, por la app y con el proveedor falso de
 * §10.11 (`medir-52.mjs`), abriendo una pestana nueva y reanudando:
 *
 * ```
 * › Ask Codex to do anything                    la caja, vacia
 *   ? for shortcuts                             el pie
 * ```
 * ```
 * ◦ Working (1s • esc to interrupt)             trabajando: la caja y el pie siguen
 * › Ask Codex to do anything
 *   ← for agents · ? for shortcuts
 * ```
 *
 *  - **Trabajando se ve la caja igual**: lo que dice que no esta libre es la
 *    linea `Working (… esc to interrupt)` de encima. Ademas, el reloj mira el
 *    turno abierto en el historial (`hasOpenTurn`): Codex no publica su estado.
 *  - **Con el daemon en frio** (§10.12) la pantalla se ve lista a los 0,4 s,
 *    pero lo que se escribe queda en la caja con "Waiting for startup · esc
 *    cancel" y Codex lo manda al terminar de arrancar: medido, llego a los 40 s.
 *    No se pierde; la confirmacion lo espera (`confirmTimeoutMs`).
 *  - **Un menu** (una aprobacion, "Approaching rate limits", §10.12) reemplaza la
 *    caja y su pie: sin "? for shortcuts" no esta lista.
 *
 * Se mira el final de la pantalla: arriba queda lo que ya se dibujo (el banner,
 * "Resuming session…", turnos anteriores).
 */

/** Lo que dice que Codex esta ocupado, en las ultimas lineas. */
const BUSY = /esc to interrupt|Working \(|Waiting for startup|esc cancel/;
/** El pie de la caja, con la caja vacia o trabajando. */
const FOOTER = /\? for shortcuts/;
/** La caja: el simbolo con que Codex la dibuja. */
const COMPOSER = /^\s*›\s/;

export function codexReadyScreen(lines: readonly string[]): boolean {
  const tail = lines.filter((line) => line.trim() !== '').slice(-8);
  if (tail.some((line) => BUSY.test(line))) return false;
  const footer = tail.findIndex((line) => FOOTER.test(line));
  if (footer <= 0) return false;
  return tail.slice(0, footer).some((line) => COMPOSER.test(line));
}
