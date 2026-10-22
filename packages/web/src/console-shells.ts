/**
 * Cuando la consola del pie abre una terminal sola, y cuando no (§6.0.1).
 *
 * **Solo al desplegarla** (22-10-2026, pedido del usuario). Hasta entonces, con
 * la consola a la vista, toda pestana de un proyecto sin terminal abria una:
 * abrir una sesion, o pasar a otro proyecto, dejaba andando un proceso que casi
 * nunca se usaba y que ocupaba memoria. Ahora el hueco ofrece abrirla (el `+` y
 * el enlace "Abrir PowerShell en …"), y lo unico que abre una sin ellos es
 * desplegar la barra plegada: su titulo ya dice "Abrir PowerShell en …", y es lo
 * unico que puede querer quien la despliega en un proyecto sin ninguna.
 *
 * Cerrar la ultima de un proyecto la deja cerrada sin que haga falta nada: no
 * hay quien abra otra sola.
 *
 * Sin React ni DOM: lo importa `check-settings.mjs`.
 */

/**
 * El directorio donde abrir una terminal al desplegar la consola, o null: sin
 * pestana, sin consola en el sistema, o con alguna ya abierta ahi.
 */
export function shellToOpenOnUnfold(state: {
  /** El directorio de la pestana activa, o null sin pestana. */
  cwd: string | null;
  /** El directorio de cada consola abierta, de todos los proyectos. */
  shellCwds: readonly string[];
  /** El servidor encontro una consola en el sistema. */
  shellAvailable: boolean;
}): string | null {
  if (state.cwd === null || !state.shellAvailable) return null;
  return state.shellCwds.includes(state.cwd) ? null : state.cwd;
}
