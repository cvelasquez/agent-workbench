/**
 * El gancho posterior al lanzamiento de una pestana, y a quien le toca cada
 * momento.
 *
 * El registro de terminales tiene cuatro sitios que tocan el gancho —escribir,
 * mandar un texto, que el proceso salga, cerrar o apagar— y reglas que se
 * rompen en silencio si un sitio las aplica distinto:
 *
 *  - **Escribir** avisa `onInput`; sin el miembro, cancela. El contestador del
 *    dialogo de reanudar de Claude Code se abandona en cuanto otro escribe; el
 *    descubrimiento de sesion de Codex tiene que seguir vivo justamente ahi.
 *  - **Salir el proceso** avisa `onExit` con la pestana todavia viva, y el
 *    gancho queda soltado; sin el miembro, cancela. Es donde vive la pasada
 *    final del descubrimiento (B4 del hito 25): en el apagado los adaptadores
 *    se liberan antes que las pestanas, asi que no puede vivir en `cancel`.
 *  - **Cerrar, apagar o relanzar** cancela, sin pasada final.
 *  - Un gancho que **termino solo** (`onDone`) se olvida sin cancelar, y solo si
 *    sigue siendo el de la pestana: el aviso tardio de uno viejo no puede soltar
 *    al de un lanzamiento nuevo.
 *
 * Todo se suelta **antes** de llamar al gancho: un `cancel` que avisa `onDone`
 * en el acto vuelve a entrar aca y no puede encontrar nada a medio soltar.
 *
 * Puro, para que lo pruebe el chequeo sin cargar `node-pty`.
 */

import type { LaunchHook } from './agents/adapter.js';

export class LaunchHookSlot {
  private hook: LaunchHook | null = null;

  /** true si hay un gancho sin soltar. */
  get active(): boolean {
    return this.hook !== null;
  }

  /** Pone el gancho de un lanzamiento nuevo. El anterior, si quedaba, se cancela. */
  set(hook: LaunchHook | null): void {
    const previous = this.take();
    if (previous !== null && previous !== hook) previous.cancel();
    this.hook = hook;
  }

  /** Alguien escribio en la pty. */
  input(): void {
    const hook = this.hook;
    if (hook === null) return;
    if (hook.onInput !== undefined) {
      hook.onInput();
      return;
    }
    this.take();
    hook.cancel();
  }

  /** La app va a escribir este texto en la pty. */
  submitted(text: string): void {
    this.hook?.onSubmitted?.(text);
  }

  /** El proceso salio. El gancho queda soltado. */
  exit(): void {
    const hook = this.take();
    if (hook === null) return;
    if (hook.onExit !== undefined) hook.onExit();
    else hook.cancel();
  }

  /** Cierre, apagado o relanzamiento. */
  cancel(): void {
    this.take()?.cancel();
  }

  /** El gancho termino por su cuenta: se olvida sin cancelar, si todavia es este. */
  forget(hook: LaunchHook): void {
    if (this.hook === hook) this.hook = null;
  }

  private take(): LaunchHook | null {
    const hook = this.hook;
    this.hook = null;
    return hook;
  }
}
