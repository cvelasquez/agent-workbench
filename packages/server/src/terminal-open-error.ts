/**
 * El error de abrir o despertar una pestana, con un codigo para el cliente.
 *
 * Vive aparte de `terminal-registry.ts` desde el hito 29: ese modulo carga
 * `pty-session.ts` —y con el `node-pty`, que es nativo—, y quien solo necesita
 * reconocer este error (la continuacion en otra CLI, y su chequeo) no tiene por
 * que cargar una pty. El registro lo reexporta: los que ya lo importaban de
 * ahi no cambian.
 */

import { ServerTextError, serverText, type ServerText } from '@agent-workbench/shared';

export type TerminalOpenErrorCode =
  | 'cli-not-found'
  | 'shell-not-found'
  | 'invalid-cwd'
  | 'too-many-terminals'
  | 'spawn-failed'
  | 'agent-unsupported';

/** Con su codigo para el cliente, y el texto como clave: la frase la arma la web (§6.23). */
export class TerminalOpenError extends ServerTextError {
  constructor(
    readonly code: TerminalOpenErrorCode,
    text: ServerText,
    readonly detail?: string,
  ) {
    super(text);
  }
}

/**
 * El plan de lanzamiento de un adaptador, esperado, con sus fallos como
 * `spawn-failed` (hito 29, M1a).
 *
 * `launch()` puede devolver un valor, lanzar en el acto o devolver una promesa
 * que se rechaza: los tres terminan igual para el cliente. Antes, un `Error`
 * de `launch()` quedaba fuera del `try` del registro y llegaba como un error
 * interno sin explicacion. El detalle es **solo el mensaje**: los argumentos
 * de un lanzamiento no van a ningun detalle ni log (A4). Un `TerminalOpenError`
 * pasa tal cual.
 */
export async function resolveLaunchPlan<T>(launch: () => T | Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    if (error instanceof TerminalOpenError) throw error;
    throw new TerminalOpenError(
      'spawn-failed',
      serverText('terminalOpenFailed'),
      error instanceof Error ? error.message : String(error),
    );
  }
}
