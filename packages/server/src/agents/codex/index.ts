/**
 * El adaptador de la CLI de Codex.
 *
 * Todo lo que el servidor sabe de esta CLI en un solo objeto, como el de Claude
 * Code. Tres diferencias que ordenan el resto:
 *
 *  - **El id de sesion lo pone Codex**, no la app: una pestana nueva nace sin
 *    id y el descubrimiento lo encuentra con el primer mensaje
 *    (`discovery.ts`). El adaptador es dueno de **un** descubrimiento, igual
 *    que el de Claude Code es dueno de un solo vigilante de estado.
 *  - **No publica su estado.** No hay barra "esperando", ni punto de actividad,
 *    ni "lista para recibir".
 *  - **No se lee su configuracion.** `config.toml` trae el entorno de los MCP,
 *    que puede llevar secretos (regla 2.1): sin modelo por defecto que mostrar.
 *
 * De `CODEX_HOME` se leen dos carpetas y ninguna se escribe (`paths.ts`).
 */

import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentCapabilities } from '@agent-workbench/shared';
import type {
  AgentAdapter,
  AgentInput,
  LaunchHook,
  LaunchInput,
  LaunchPlan,
  SpawnedContext,
} from '../adapter.js';
import { commandNotFoundMessage, locateCommand } from '../locate.js';
import { CodexSessionDiscovery } from './discovery.js';
import { createCodexHistory } from './history.js';
import { codexHome, isUuid } from './paths.js';

/** Nombre del comando en el PATH. Dato de compatibilidad, no marca (regla 2.3). */
export const CODEX_COMMAND = 'codex';

export const CODEX_INSTALL_URL = 'https://learn.chatgpt.com/docs/codex/cli';

/**
 * Lo que la interfaz dibuja para esta CLI. `check-codex-adapter.mjs` lo compara
 * contra un literal: una capacidad que se prende sin medirla promete algo que
 * la CLI no hace.
 */
export const CODEX_CAPABILITIES: AgentCapabilities = {
  // Codex pone el uuid v7 el mismo y no acepta que se lo den: se descubre.
  sessionIdAtLaunch: false,
  // `codex resume <id>` anexa al mismo archivo.
  resume: true,
  // Nada en disco dice si trabaja, espera o esta libre.
  statusSource: false,
  // Sin estado no hay "lista": una nota no se manda sola.
  readySignal: false,
  // Su `shift+tab` cicla el modo de colaboracion (por defecto y Plan), no permisos.
  permissionCycle: null,
  // `/model` no acepta argumento: abre un selector.
  models: null,
  // El esfuerzo solo cambia con teclas, y el archivo no lo dice hasta el turno siguiente.
  efforts: null,
  // Una pregunta no se escribe al archivo hasta que se contesta: no hay nada que dibujar.
  questionCards: false,
  // Cada imagen en su propio pegado, con la ruta sola: la TUI adjunta si el pegado entero es la ruta.
  imagesByPath: 'bare-path-paste',
  // `@` abre el buscador de archivos de la TUI: teclear `@ruta ` navegaria un menu.
  fileMentions: null,
  // `Esc Esc` edita un mensaje anterior: otro flujo, sin medir.
  rewind: false,
  // La ventana exacta viene en el archivo, junto a los tokens.
  contextWindowSource: 'token-count',
  // `update_plan` es una lista de pasos, no un archivo.
  plans: false,
};

/**
 * Como se le escribe un mensaje: cada imagen en su pegado, despues el texto, y
 * el Enter aparte, con 400 ms entre pieza y pieza.
 *
 * Los 400 ms salen de la TUI de Codex en Windows, que recibe lo pegado como una
 * rafaga de teclas y decide por el tiempo si un Enter es salto de linea (una
 * ventana de 120 ms despues del ultimo caracter) o envio. Con los marcadores de
 * pegado no hay riesgo de interrumpir el turno: medido sobre ConPTY, no llegan
 * como Escape (`AgentInput.pasteMarkers`). En macOS y Linux el pegado entre
 * marcadores es el nativo.
 */
export const CODEX_INPUT: AgentInput = {
  imageReference: 'bare-path-paste',
  pieceGapMs: 400,
  pasteMarkers: true,
};

export function createCodexAdapter(): AgentAdapter {
  const discovery = new CodexSessionDiscovery();

  return {
    id: 'codex',
    label: 'Codex',
    command: CODEX_COMMAND,
    installUrl: CODEX_INSTALL_URL,
    capabilities: CODEX_CAPABILITIES,
    input: CODEX_INPUT,

    locate: () => locateCommand(CODEX_COMMAND),

    missingMessage: () => commandNotFoundMessage(CODEX_COMMAND, CODEX_INSTALL_URL),

    /**
     * Sin argumentos para una sesion nueva, `resume <id>` para una del
     * historial. `proposedSessionId` no se usa: el id lo pone Codex.
     *
     * Sin `-C <cwd>`: el `cwd` ya es el de la pty, y un argumento con espacios
     * detras de `cmd.exe /c` —el shim `codex.cmd` de npm— rompe el lanzamiento
     * entero. Por lo mismo el id se valida antes de tocar la linea de comando:
     * uno con espacios o comillas no llega nunca a `cmd`.
     */
    launch(input: LaunchInput): LaunchPlan {
      const { resumeSessionId } = input;
      if (resumeSessionId === null) {
        return { file: input.location.file, args: [...input.location.prefixArgs], session: { kind: 'discover' } };
      }
      if (!isUuid(resumeSessionId)) throw new Error('Id de sesion de Codex invalido.');
      return {
        file: input.location.file,
        args: [...input.location.prefixArgs, 'resume', resumeSessionId],
        session: { kind: 'known', sessionId: resumeSessionId },
      };
    },

    /** Copia del entorno, sin quitar nada: Codex no hereda ningun marcador que le estorbe. */
    environment(base) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) env[key] = value;
      }
      return { env, notice: null };
    },

    /*
      Una pestana nueva espera su sesion; una que reanuda ya sabe cual es, y
      solo se anota como viva en su proyecto: un `/new` ahi escribe un rollout
      que una pendiente tambien podria tomar, y esa asignacion tiene que avisar
      (M4). Los dos ganchos sobreviven a las escrituras (`onInput`) y el de la
      pendiente mira una vez mas al salir el proceso (`onExit`): se devuelven
      tal cual, porque envolverlos sin esos miembros haria que el registro los
      suelte con el primer mensaje, que es justo cuando aparece la sesion.
    */
    onSpawned(context: SpawnedContext): LaunchHook | null {
      if (context.resumed) return discovery.watchLive({ terminalId: context.terminalId, cwd: context.cwd });
      return discovery.register({
        terminalId: context.terminalId,
        cwd: context.cwd,
        launchedAt: context.launchedAt,
        reportSessionId: (sessionId) => context.reportSessionId(sessionId),
      });
    },

    history: createCodexHistory(),
    status: null,

    defaults: () => Promise.resolve(null),

    /**
     * La carpeta de Codex, y ademas la de siempre del home. No se listan ni se
     * entran (regla 2.1).
     *
     * Las dos porque `CODEX_HOME` puede apuntar a otro lado —o no ser absoluta,
     * y entonces no se sabe cual es— y `~/.codex` sigue teniendo las
     * credenciales de antes de cambiarla.
     */
    protectedDirs: () => {
      const dirs = [path.join(homedir(), '.codex')];
      const home = codexHome();
      if (home !== null && !dirs.includes(home)) dirs.unshift(home);
      return dirs;
    },

    dispose: () => discovery.dispose(),
  };
}
