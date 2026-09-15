/**
 * El adaptador de la CLI de Claude Code.
 *
 * Junta en un solo objeto todo lo que el servidor sabe de esta CLI: como se
 * lanza, que se le quita al entorno, donde guarda el historial y como publica
 * su estado. Es dueno de **un** vigilante de `~/.claude/sessions/` y de **un**
 * registro de variantes de modelo; nadie fuera de aca los construye, asi que
 * no hay dos sondeos del mismo directorio ni dos registros que se contradigan.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import {
  EFFORT_OPTIONS,
  LAUNCH_PERMISSION_MODE,
  MODEL_OPTIONS,
  PERMISSION_MODE_CYCLE,
  type AgentCapabilities,
} from '@agent-workbench/shared';
import type {
  AgentAdapter,
  AgentInput,
  AgentStatus,
  LaunchHook,
  LaunchInput,
  LaunchPlan,
  SpawnedContext,
  StatusSource,
} from '../adapter.js';
import { commandNotFoundMessage, locateCommand } from '../locate.js';
import { readAgentDefaults } from './agent-defaults.js';
import { CliStatusWatcher } from './cli-status.js';
import { CLAUDE_CODE_COMMAND, CLAUDE_CODE_INSTALL_URL } from './constants.js';
import { claudeCodeEnvironment } from './environment.js';
import { createClaudeCodeHistory } from './history.js';
import { ModelVariantRegistry } from './model-variants.js';
import { autoAnswerResumeDialog } from './resume-dialog.js';

/**
 * Lo que la interfaz dibuja para esta CLI. Todo medido contra la CLI de verdad
 * (docs/plan-multi-cli.md §5); `check-agent-registry.mjs` lo compara contra un
 * literal, para que una capacidad no se apague sin que nadie lo note.
 */
export const CLAUDE_CODE_CAPABILITIES: AgentCapabilities = {
  sessionIdAtLaunch: true,
  resume: true,
  statusSource: true,
  readySignal: true,
  permissionCycle: {
    modes: PERMISSION_MODE_CYCLE,
    launchMode: LAUNCH_PERMISSION_MODE,
    keyLabel: 'shift+tab',
    // El combo de modo se comporta como siempre: nada lo bloquea por un permiso pendiente.
    approvesPendingOnCycle: false,
  },
  models: MODEL_OPTIONS,
  efforts: EFFORT_OPTIONS,
  questionCards: true,
  imagesByPath: 'at-quoted',
  fileMentions: 'at',
  rewind: true,
  contextWindowSource: 'usage-with-variants',
  plans: true,
  // Hito 29: sin candado nuevo. Con la CLI esperando, el cuadro manda como siempre.
  waitingBlocksSubmit: false,
};

/**
 * Como se le escribe un mensaje: todo en un solo pegado, con las imagenes como
 * `@"ruta"` y el Enter pegado al final (CLAUDE.md 5.3). Una sola pieza, asi que
 * la separacion no se usa: es byte por byte lo que se escribia antes de que
 * existieran las piezas.
 */
export const CLAUDE_CODE_INPUT: AgentInput = {
  imageReference: 'at-quoted',
  pieceGapMs: 0,
  pasteMarkers: true,
  enterSeparately: false,
  interruptPresses: 1,
  // La CLI adjunta el transcript sola y no pide permiso para leerlo fuera del proyecto.
  transcriptReference: 'at-quoted',
};

/**
 * El estado que publica la CLI, traducido a lo que dibuja la barra de pestanas.
 *
 * Los tres conocidos salen tal cual; cualquier otro se trata como trabajando.
 * Es la eleccion conservadora: un estado que no conocemos significa que la CLI
 * esta en algo, y mostrarlo como parado invitaria a escribirle justo cuando no
 * corresponde. Sin archivo no hay proceso: eso lo pinta el registro.
 */
function toActivity(status: string): AgentStatus['activity'] {
  if (status === 'idle' || status === 'busy' || status === 'waiting') return status;
  return 'busy';
}

function createStatusSource(watcher: CliStatusWatcher): StatusSource {
  return {
    subscribe: (sessionId, listener) =>
      watcher.subscribe(sessionId, (status) =>
        listener(
          status === null
            ? null
            : {
                activity: toActivity(status.status),
                waitingFor: status.status === 'waiting' ? status.waitingFor : null,
              },
        ),
      ),
    waitUntilReady: (sessionId, timeoutMs) => watcher.waitUntilIdle(sessionId, timeoutMs),
    dispose: () => watcher.dispose(),
  };
}

export function createClaudeCodeAdapter(): AgentAdapter {
  const watcher = new CliStatusWatcher();
  /*
    Que variante de modelo usa esta instalacion. Lo llena el escaneo del
    historial mientras lee la cola de los archivos —donde vive `cost-state`, la
    unica linea que trae el sufijo `[1m]`— y lo consultan los seguidores que
    salen de `history.follow`, que es lo que dibuja el medidor de contexto.
    Indice y seguidores comparten este mismo registro: si fueran dos, el
    medidor mostraria 200k en sesiones de 1M hasta el primer `cost-state`.
  */
  const variants = new ModelVariantRegistry();
  const status = createStatusSource(watcher);

  return {
    id: 'claude-code',
    label: 'Claude Code',
    command: CLAUDE_CODE_COMMAND,
    installUrl: CLAUDE_CODE_INSTALL_URL,
    capabilities: CLAUDE_CODE_CAPABILITIES,
    input: CLAUDE_CODE_INPUT,

    locate: () => locateCommand(CLAUDE_CODE_COMMAND),

    missingMessage: () => commandNotFoundMessage(CLAUDE_CODE_COMMAND, CLAUDE_CODE_INSTALL_URL),

    /**
     * Sin `--fork-session`: al reanudar se sigue escribiendo el mismo archivo,
     * para que el seguimiento incremental no se corte.
     *
     * El modo de arranque sale de la misma constante que usa el ciclo como punto
     * de partida (CLAUDE.md 4.8.1): si fueran dos literales, un dia dirian cosas
     * distintas y el combo contaria las pulsaciones desde un modo equivocado.
     */
    launch(input: LaunchInput): LaunchPlan {
      const sessionId = input.resumeSessionId ?? input.proposedSessionId;
      return {
        file: input.location.file,
        args: [
          ...input.location.prefixArgs,
          '--permission-mode',
          LAUNCH_PERMISSION_MODE,
          ...(input.resumeSessionId !== null
            ? ['--resume', input.resumeSessionId]
            : ['--session-id', input.proposedSessionId]),
        ],
        session: { kind: 'known', sessionId },
      };
    },

    environment: (base) => claudeCodeEnvironment(base),

    /*
      Reanudar una sesion vieja y grande abre un dialogo que el usuario contesta
      siempre igual. Se contesta solo, con dos condiciones que se comprueban en
      `resume-dialog.ts`; si el dialogo no aparece —que es lo normal— no se
      escribe nada. Una sesion nueva no lo abre nunca.
    */
    onSpawned(context: SpawnedContext): LaunchHook | null {
      if (!context.resumed) return null;
      const cancel = autoAnswerResumeDialog({
        watcher,
        sessionId: context.sessionId,
        readOutput: context.readOutput,
        write: context.write,
        onDone: context.onDone,
      });
      return { cancel };
    },

    history: createClaudeCodeHistory(variants),
    status,

    defaults: (cwd) => readAgentDefaults(cwd),

    /** La carpeta de la CLI. No se lista ni se entra: regla 2.1. */
    protectedDirs: () => [path.join(homedir(), '.claude')],

    dispose: () => status.dispose(),
  };
}
