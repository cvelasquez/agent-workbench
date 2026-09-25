/**
 * Deslizar el dedo sobre la terminal (§6.25): la cuenta, sin navegador.
 *
 * xterm trae su propio manejo del dedo, pero mueve el historial 1 a 1 y se
 * para en seco al soltar: con miles de líneas, leer para atrás en un teléfono
 * era casi no moverse. Y con una CLI a pantalla completa (pantalla alterna) o
 * que pidió el mouse, no hace nada. `TerminalView` convierte cada movimiento
 * en una rueda del mouse —xterm decide qué es: su historial, flechas o la
 * rueda de la CLI—, y al soltar sigue un rato, frenándose. Acá está lo que
 * se decide con números, para que `check-narrow-layout` lo pruebe.
 *
 * El signo es el de la rueda: positivo va hacia el final (el dedo sube).
 */

/** Una posición del dedo: cuándo (ms) y dónde (px CSS, de arriba hacia abajo). */
export interface TouchSample {
  t: number;
  y: number;
}

/** Lo que se mueve un toque antes de contar como arrastre. Menos, es un toque: abre el teclado. */
export const DRAG_SLOP_PX = 8;

/** La velocidad al soltar se mide con el final del gesto, no con todo. */
export const VELOCITY_WINDOW_MS = 100;

/** Si el dedo estuvo quieto este rato antes de soltar, no hay inercia. */
export const RELEASE_PAUSE_MS = 80;

/** Tope de la velocidad de salida, en px por ms: un dedo muy rápido no manda miles de líneas. */
export const MOMENTUM_MAX_VELOCITY = 6;

/** Por debajo de esto la inercia termina. */
export const MOMENTUM_MIN_VELOCITY = 0.02;

/** Lo que conserva la velocidad en cada cuadro de 16 ms. */
export const MOMENTUM_FRICTION = 0.95;

/** Un cuadro más largo que esto se cuenta como de esto: la pestaña pudo estar en segundo plano. */
const MAX_FRAME_MS = 50;

export function isDrag(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > DRAG_SLOP_PX;
}

/**
 * La velocidad del final del gesto, en px por ms y con el signo de la rueda.
 * Cero si el dedo se quedó quieto antes de soltar o si no hay con qué medir.
 */
export function releaseVelocity(samples: readonly TouchSample[], now: number): number {
  const last = samples[samples.length - 1];
  if (last === undefined || now - last.t > RELEASE_PAUSE_MS) return 0;
  const recent = samples.filter((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS);
  const first = recent[0];
  if (first === undefined || recent.length < 2 || last.t === first.t) return 0;
  const velocity = (first.y - last.y) / (last.t - first.t);
  return Math.max(-MOMENTUM_MAX_VELOCITY, Math.min(MOMENTUM_MAX_VELOCITY, velocity));
}

/**
 * Un cuadro de inercia: lo que se avanza en `dtMs` y la velocidad que queda.
 * La velocidad cae en proporción, así que el final es suave; bajo el mínimo es 0.
 */
export function momentumStep(velocity: number, dtMs: number): { delta: number; velocity: number } {
  if (Math.abs(velocity) < MOMENTUM_MIN_VELOCITY) return { delta: 0, velocity: 0 };
  const dt = Math.max(0, Math.min(MAX_FRAME_MS, dtMs));
  const next = velocity * MOMENTUM_FRICTION ** (dt / 16);
  return { delta: velocity * dt, velocity: Math.abs(next) < MOMENTUM_MIN_VELOCITY ? 0 : next };
}

/**
 * La parte entera de un desplazamiento y el resto. xterm redondea el scroll:
 * mandarle 0,4 px diez veces es no moverse, así que los restos se juntan.
 */
export function wholePixels(amount: number): { pixels: number; rest: number } {
  const pixels = Math.trunc(amount);
  return { pixels, rest: amount - pixels };
}
