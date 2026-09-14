/**
 * Los modos de permiso de Antigravity CLI con los nombres de la app.
 *
 * `PermissionMode` no se ensancha para esta CLI: sus tres modos ya tienen
 * equivalente con el mismo significado, y se traducen en los dos bordes —el
 * argumento `--mode` al lanzar y el `cycle_mode` que publica la status line—.
 */

import type { PermissionMode } from '@agent-workbench/shared';

/**
 * El valor de `--mode` para un modo, o null si no hay que pasar ninguno.
 *
 * `--help` de la 1.2.2 acepta `accept-edits` y `plan`: `default` es no pasar
 * nada, y `auto` no existe en esta CLI.
 */
export function toCliMode(mode: PermissionMode): string | null {
  if (mode === 'acceptEdits') return 'accept-edits';
  if (mode === 'plan') return 'plan';
  return null;
}

/**
 * El modo observado a partir de la status line, o null si no dice nada.
 *
 * Medido sobre 81 llamadas de la 1.2.2: el modo llega en `cycle_mode` (nunca en
 * el `execution_mode` de la documentacion) con `accept-edits` o `plan`, y
 * **falta** en `default`, porque el campo se omite cuando esta vacio. Pero
 * tambien falta mientras la CLI se autentica, aunque el modo sea otro: ahi, y
 * sin `agent_state`, la ausencia no significa `default` y se devuelve null. Un
 * valor que no se conoce tambien es null: mandar `shift+tab` desde un modo que
 * no esta en el ciclo dejaria al usuario donde no pidio.
 */
export function fromCycleMode(cycleMode: string | null, agentState: string | null): PermissionMode | null {
  if (cycleMode === null || cycleMode === '') {
    if (agentState === null || agentState === '' || agentState === 'authenticating') return null;
    return 'default';
  }
  if (cycleMode === 'accept-edits') return 'acceptEdits';
  if (cycleMode === 'plan') return 'plan';
  return null;
}
