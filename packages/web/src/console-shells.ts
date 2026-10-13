/**
 * Cuando la consola del pie abre una terminal sola, y cuando no (§6.0.1).
 *
 * Mostrar la consola y despues tener que apretar "abrir" seria un clic de mas
 * para lo unico que puede querer alguien que la abre: con la consola a la vista
 * y el proyecto activo sin ninguna, se abre una. Lo que frena eso es una lista
 * de directorios **ya pedidos**:
 *
 *  - el que se acaba de pedir, hasta que la terminal aparece: sin esto cada
 *    dibujo pediria otra. Si la apertura falla —no hay consola en el sistema, el
 *    directorio ya no existe— tampoco se reintenta en bucle;
 *  - **el de una consola que el usuario cerro a mano.** Cerrar la ultima de un
 *    proyecto la deja cerrada (pedido del usuario, 13-10-2026): antes se abria
 *    otra en el acto, y la unica forma de quedarse sin terminal en un proyecto
 *    era esconder la consola entera, que cierra las de todos los proyectos.
 *
 * La lista se olvida al plegar o esconder la consola: volver a mostrarla es
 * pedirla de nuevo, y ahi si se abre una sola.
 *
 * Sin React ni DOM: lo importa `check-settings.mjs`.
 */

export interface ShellAutoOpen {
  /** Los directorios ya pedidos, o cerrados a mano: la apertura automatica no los toca. */
  requested: ReadonlySet<string>;
  /** El directorio donde hay que abrir una terminal ahora, o null. */
  open: string | null;
}

export function autoOpenShell(
  requested: ReadonlySet<string>,
  state: {
    /** La consola esta a la vista: ni plegada ni escondida en Ajustes. */
    consoleShown: boolean;
    /** El directorio de la pestana activa, o null sin pestana. */
    cwd: string | null;
    /** El directorio de cada consola abierta, de todos los proyectos. */
    shellCwds: readonly string[];
  },
): ShellAutoOpen {
  if (!state.consoleShown) return { requested: requested.size === 0 ? requested : new Set(), open: null };
  const { cwd } = state;
  if (cwd === null) return { requested, open: null };

  if (state.shellCwds.includes(cwd)) {
    // Ya hay una: el pedido se cumplio. Si despues se cierran todas, decide `withRequestedShell`.
    if (!requested.has(cwd)) return { requested, open: null };
    const next = new Set(requested);
    next.delete(cwd);
    return { requested: next, open: null };
  }
  if (requested.has(cwd)) return { requested, open: null };
  return { requested: new Set(requested).add(cwd), open: cwd };
}

/**
 * Anota un directorio como pedido. Dos momentos lo usan:
 *
 *  - el usuario abre una consola a mano (`+`): mientras llega, no se pide otra;
 *  - **el usuario cierra una con su ×**. Si quedan otras ahi, la proxima vuelta
 *    de `autoOpenShell` lo borra; si era la ultima, es lo que evita que se abra
 *    otra sola.
 */
export function withRequestedShell(requested: ReadonlySet<string>, cwd: string): ReadonlySet<string> {
  return requested.has(cwd) ? requested : new Set(requested).add(cwd);
}
