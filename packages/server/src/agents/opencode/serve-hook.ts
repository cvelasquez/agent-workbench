/**
 * El gancho de una pestana de OpenCode enganchada al `serve` (hito 29, D13, M7).
 *
 * Hace dos cosas, una sola vez por gancho:
 *
 *  - **Suelta la pestana del `serve`** (`release`, de `retain()`): sin ptys de
 *    OpenCode vivas, el `serve` se apaga solo a los 5 minutos.
 *  - **Corta la sesion si quedo trabajando o esperando.** Con el TUI suelto del
 *    hito 26, cerrar la pestana cortaba al agente; con `attach`, el trabajo
 *    sigue en el `serve` sin ningun TUI que lo muestre. Se pide sin esperar.
 *
 * No se suelta al escribir (`onInput` vacio): el `serve` sigue haciendo falta
 * mientras la pestana viva.
 *
 * **El apagado libera los adaptadores antes que las pestanas** (§3.2 de
 * CLAUDE.md), asi que `cancel` puede llegar con el `serve` ya muerto: el
 * estado ya es null y no se pide nada, y si igual se pidiera, el rechazo se
 * atrapa. Una promesa rechazada sin manejar termina el proceso en Node 22.
 */

import type { AgentStatus, LaunchHook } from '../adapter.js';

export interface ServeHookDeps {
  sessionId: string;
  cwd: string;
  /** Lo que devolvio `OpenCodeServeProcess.retain()`. */
  release: () => void;
  /** `OpenCodeServeStatus.current(sessionId)`. */
  current: () => AgentStatus | null;
  /** Corta la sesion. Puede rechazar o lanzar: se atrapa. */
  abort: (cwd: string, sessionId: string) => Promise<void>;
}

export function createServeLaunchHook(deps: ServeHookDeps): LaunchHook {
  let done = false;
  const finish = (): void => {
    if (done) return;
    done = true;
    deps.release();
    const status = deps.current();
    if (status === null || (status.activity !== 'busy' && status.activity !== 'waiting')) return;
    try {
      deps.abort(deps.cwd, deps.sessionId).catch(() => {});
    } catch {
      // Un cliente que ya no esta: no hay nada que cortar.
    }
  };
  return {
    cancel: finish,
    onExit: finish,
    onInput: () => {},
  };
}
