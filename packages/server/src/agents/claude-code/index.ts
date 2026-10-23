/**
 * El adaptador de la CLI de Claude Code.
 *
 * Junta en un solo objeto todo lo que el servidor sabe de esta CLI: como se
 * lanza, que se le quita al entorno, donde guarda el historial y como publica
 * su estado. Es dueno de **un** vigilante de `~/.claude/sessions/` y de **un**
 * registro de variantes de modelo; nadie fuera de aca los construye, asi que
 * no hay dos sondeos del mismo directorio ni dos registros que se contradigan.
 *
 * Desde el hito 47 escribe una cosa suya, y solo con la CLI encontrada: el
 * script de la status line que publica los limites del plan (`prepare`). La
 * linea en `settings.json` la pega el usuario (§4.17).
 */

import { homedir } from 'node:os';
import path from 'node:path';
import {
  EFFORT_OPTIONS,
  LAUNCH_PERMISSION_MODE,
  MODEL_OPTIONS,
  PERMISSION_MODE_CYCLE,
  type AgentCapabilities,
  type StatusLineSetupInfo,
  type StatusLineState,
} from '@agent-workbench/shared';
import { agentStatusDir, integrationsDir } from '../../paths.js';
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
import { PlanLimitsRecordDir, removeStalePlanRecords } from '../plan-limits.js';
import { readAgentDefaults } from './agent-defaults.js';
import { CliStatusWatcher, isIdleStatus } from './cli-status.js';
import { CLAUDE_CODE_COMMAND, CLAUDE_CODE_INSTALL_URL } from './constants.js';
import { claudeCodeEnvironment } from './environment.js';
import { createClaudeCodeHistory } from './history.js';
import { ModelVariantRegistry } from './model-variants.js';
import { autoAnswerResumeDialog } from './resume-dialog.js';
import { createClaudeCodeHandback } from './handback.js';
import { sessionFilePath } from './paths.js';
import { createClaudeCodeRewind } from './rewind-menu.js';
import { createClaudeCodeScreenQuestions } from './question-screen.js';
import {
  claudeStatusLineFragment,
  claudeStatusLineScriptPath,
  installClaudeStatusLineScript,
} from './statusline-script.js';
import { claudeSettingsStamp, claudeUserSettingsPath, readClaudeStatusLineState } from './statusline-settings.js';

/** Cada cuanto se mira `settings.json` mientras alguien quiere enterarse de cambios. */
export const CLAUDE_SETTINGS_POLL_MS = 2_000;

/** Donde deja el script de la status line un registro por sesion. */
export function claudePlanRecordsDir(): string {
  return agentStatusDir('claude-code');
}

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
  // Su tecla de "enviar ya", Ctrl+X Ctrl+S, medida con la 2.1.301 (hito 45, §4.4.3).
  forceSend: true,
  /*
    Hito 49: `--permission-mode plan`. Medido con la 2.1.304 y el pedido de
    revision: corrio git log, diff y status sin pedir permiso, no ofrecio salir
    del modo plan y termino con la linea del veredicto, sin tocar nada (§4.8.1).
  */
  readOnlyLaunch: { mode: 'plan', guard: 'cli' },
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
 * Los libres (`idle`, y `shell` con un comando en segundo plano) son libre;
 * `busy` y `waiting` salen tal cual, y cualquier otro se trata como trabajando.
 * Es la eleccion conservadora: un estado que no conocemos significa que la CLI
 * esta en algo, y mostrarlo como parado invitaria a escribirle justo cuando no
 * corresponde. Sin archivo no hay proceso: eso lo pinta el registro.
 */
function toActivity(status: string): AgentStatus['activity'] {
  if (isIdleStatus(status)) return 'idle';
  if (status === 'busy' || status === 'waiting') return status;
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

export interface ClaudeCodeAdapterOptions {
  /** Para el chequeo. Por defecto, la del proceso. */
  platform?: string;
  /** Cada cuanto se mira `settings.json` (`subscribeChanges`). */
  settingsPollMs?: number;
}

export function createClaudeCodeAdapter(options: ClaudeCodeAdapterOptions = {}): AgentAdapter {
  const platform = options.platform ?? process.platform;
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

  /*
    Los limites del plan de la cuenta (hito 47, §4.17): la CLI los publica solo
    por su status line. Con la de la app puesta, su script deja un registro por
    sesion y de ahi sale el medidor del plan; sin ella no hay nada que leer.
  */
  const planLimits = new PlanLimitsRecordDir(claudePlanRecordsDir);
  let statusLineState: StatusLineState = 'missing';
  /** true despues de `prepare`: recien ahi la app puede escribir en su carpeta por esta CLI. */
  let prepared = false;
  const pollers = new Set<ReturnType<typeof setInterval>>();

  const refreshSetup = async (): Promise<boolean> => {
    const next = await readClaudeStatusLineState();
    if (prepared) {
      // Si alguien edito o borro el script, se reescribe: el estado no cambia por eso.
      try {
        await installClaudeStatusLineScript(integrationsDir());
      } catch (error) {
        console.warn(`[claude-code] couldn't reinstall the status line script: ${String(error)}`);
      }
    }
    const changed = next !== statusLineState;
    statusLineState = next;
    return changed;
  };

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
      // Una pestana de revision (hito 49) arranca en el modo que declara la capacidad, y despierta igual.
      const readOnlyMode = input.readOnly === true ? CLAUDE_CODE_CAPABILITIES.readOnlyLaunch?.mode : null;
      return {
        file: input.location.file,
        args: [
          ...input.location.prefixArgs,
          '--permission-mode',
          readOnlyMode ?? LAUNCH_PERMISSION_MODE,
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

    /*
      Un mensaje detenido antes de que el agente hiciera nada: la CLI lo deshace
      y lo devuelve a su caja, y la app lo trae al cuadro (hito 44, §4.16).
    */
    queuedSubmits: createClaudeCodeHandback({
      sessionFile: sessionFilePath,
      status: (sessionId) => watcher.read(sessionId),
    }),

    // Volver a antes de un mensaje con el menu de rewind de la CLI (hito 44, §4.16).
    rewind: createClaudeCodeRewind(),

    // La pregunta abierta, leida de la pantalla: la CLI no la escribe hasta que se contesta (§5.5.4).
    screenQuestions: createClaudeCodeScreenQuestions(),

    // La cola la dice el JSONL (hito 45, §4.4.3), y "enviar ya" es su tecla.
    promptQueue: { source: 'session', forceSend: 'ctrl-x-ctrl-s' },

    defaults: (cwd, sessionModel) => readAgentDefaults(cwd, sessionModel ?? null),

    /** La carpeta de la CLI. No se lista ni se entra: regla 2.1. */
    protectedDirs: () => [path.join(homedir(), '.claude')],

    planLimits,

    /** El script de la status line y la limpieza de sus registros. Solo con la CLI encontrada. */
    async prepare(): Promise<void> {
      prepared = true;
      try {
        await installClaudeStatusLineScript(integrationsDir());
      } catch (error) {
        console.warn(`[claude-code] couldn't install the status line script: ${String(error)}`);
      }
      await removeStalePlanRecords(claudePlanRecordsDir());
      await refreshSetup();
    },

    planLimitsSetup(): StatusLineSetupInfo {
      const script = claudeStatusLineScriptPath(integrationsDir());
      return {
        state: statusLineState,
        settingsPath: claudeUserSettingsPath(),
        scriptPath: script,
        fragment: claudeStatusLineFragment(script, platform),
      };
    },

    refreshSetup,

    /** Avisa cuando el usuario pega o quita la linea: un `stat` de `settings.json` cada 2 s. */
    subscribeChanges(listener: () => void): () => void {
      let last: string | null = null;
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          const stamp = await claudeSettingsStamp();
          if (last !== null && stamp !== last && (await refreshSetup())) listener();
          last = stamp;
        })()
          .catch(() => undefined)
          .finally(() => {
            busy = false;
          });
      }, options.settingsPollMs ?? CLAUDE_SETTINGS_POLL_MS);
      timer.unref();
      pollers.add(timer);
      return () => {
        clearInterval(timer);
        pollers.delete(timer);
      };
    },

    dispose: () => {
      for (const timer of pollers) clearInterval(timer);
      pollers.clear();
      planLimits.dispose();
      status.dispose();
    },
  };
}
