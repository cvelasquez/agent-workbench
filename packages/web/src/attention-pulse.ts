/**
 * El pulso de aviso: dos destellos cortos que dicen "mira aca" sin mover nada.
 *
 * Pedido del usuario (12-10-2026), dos veces con la misma forma:
 *
 *  - "Ir al final", al volver a una pestana donde se habia subido a leer
 *    (§6.27): que se encienda en dos pulsos, con su texto a la vista.
 *  - La pestana de un agente que termino o que espera (§6.20): "cuando estoy
 *    trabajando con varios proyectos y termina alguno suena la notificacion, a
 *    veces me demoro en identificar quien termino". La pestana se pinta como la
 *    seleccionada, con el borde del color de su proyecto, en esos dos pulsos.
 *
 * Los numeros viven aca y la animacion en `styles.css` (`jump-hint`,
 * `tab-attention`): cada vuelta de la animacion es un pulso encendido y su
 * pausa apagada. `check-notification-sound.mjs` comprueba que las dos cosas
 * digan lo mismo, porque un numero cambiado de un solo lado no falla en ningun
 * otro sitio: solo se ve un destello cortado.
 */

/** Cuanto dura encendido cada pulso. */
export const PULSE_MS = 300;

/** La pausa apagada entre un pulso y el siguiente. */
export const PULSE_GAP_MS = 200;

/** Cuantos pulsos. */
export const PULSE_COUNT = 2;

/** Una vuelta de la animacion: un pulso y su pausa. */
export const PULSE_CYCLE_MS = PULSE_MS + PULSE_GAP_MS;

/**
 * Lo que dura la animacion entera, y por eso lo que se deja puesta la clase que
 * la dispara: quitarla antes cortaria el segundo pulso, y dejarla de mas haria
 * que un aviso siguiente no la volviera a arrancar.
 */
export const PULSE_ANIMATION_MS = PULSE_COUNT * PULSE_CYCLE_MS;

/** En que punto de cada vuelta se apaga, como porcentaje: lo que escribe el `@keyframes`. */
export const PULSE_OFF_PERCENT = Math.round((PULSE_MS / PULSE_CYCLE_MS) * 100);
