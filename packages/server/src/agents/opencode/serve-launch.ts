/**
 * Lanzar una pestana de OpenCode enganchada al `serve` (hito 29, D5, D6, M1b).
 *
 * `opencode attach <url> --dir . --session <id> --password <hex>`:
 *
 *  - **La sesion nueva se crea por API antes de lanzar** (D6): la pestana nace
 *    con su id y no hay que descubrirlo.
 *  - **`--dir .` y no la ruta**: una ruta con espacios detras de `cmd.exe /c`
 *    rompe el lanzamiento (§3.1 de CLAUDE.md). `attach` hace `chdir` a eso, y
 *    `.` es el `cwd` de la pty. Sin `--dir`, el TUI usaria la carpeta del
 *    `serve`.
 *  - **La contrasena va en la linea de comando del TUI** (D3): es de este
 *    arranque, vale solo para `127.0.0.1` y muere con la app. La pty no gana
 *    ninguna variable.
 *
 * **El id de una reanudacion se valida antes de devolver la promesa** (M1b):
 * un id hostil es un `throw` sincronico, sin ninguna peticion al `serve`, igual
 * que en el hito 26. Lo que falla despues —el `serve` que no arranca, la sesion
 * que no se crea— rechaza, y el registro lo muestra como `spawn-failed` con el
 * mensaje. Ningun mensaje trae argumentos.
 */

import type { LaunchInput, LaunchPlan } from '../adapter.js';
import type { CliLocation } from '../locate.js';
import { OPENCODE_SESSION_ID_PATTERN } from './ids.js';
import type { ServeEndpoint } from './serve-process.js';

export interface ServeLaunchDeps {
  /** `OpenCodeServeProcess.ensure`. */
  ensure(): Promise<ServeEndpoint>;
  /** Crea una sesion vacia en esa carpeta, con el cliente de ese endpoint. */
  createSession(endpoint: ServeEndpoint, directory: string): Promise<string>;
  /** Empieza a seguir el estado de esa sesion con el cliente de ese endpoint. */
  track(endpoint: ServeEndpoint, sessionId: string, directory: string): void;
}

/** Los argumentos de `attach`, con el prefijo del shim delante. */
export function attachArgs(location: CliLocation, endpoint: ServeEndpoint, sessionId: string): string[] {
  return [...location.prefixArgs, 'attach', endpoint.url, '--dir', '.', '--session', sessionId, '--password', endpoint.password];
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * El plan de lanzamiento. No es `async` a proposito: el id invalido lanza aca
 * mismo, antes de tocar el `serve`.
 */
export function launchWithServe(deps: ServeLaunchDeps, input: LaunchInput): Promise<LaunchPlan> {
  const { resumeSessionId } = input;
  if (resumeSessionId !== null && !OPENCODE_SESSION_ID_PATTERN.test(resumeSessionId)) {
    throw new Error('Id de sesion de OpenCode invalido.');
  }

  return (async (): Promise<LaunchPlan> => {
    let endpoint: ServeEndpoint;
    try {
      endpoint = await deps.ensure();
    } catch (error) {
      throw new Error(`No se pudo arrancar el servidor de OpenCode: ${reason(error)}`);
    }

    let sessionId = resumeSessionId;
    if (sessionId === null) {
      try {
        sessionId = await deps.createSession(endpoint, input.cwd);
      } catch (error) {
        throw new Error(`El servidor de OpenCode no creo la sesion: ${reason(error)}`);
      }
    }

    deps.track(endpoint, sessionId, input.cwd);
    return {
      file: input.location.file,
      args: attachArgs(input.location, endpoint, sessionId),
      session: { kind: 'known', sessionId },
    };
  })();
}
