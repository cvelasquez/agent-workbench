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
 *  - **No publica su estado en disco.** La pantalla permite detectar estados
 *    conocidos, pero se conserva la guarda para aprobaciones no reconocidas.
 *  - **No se lee su configuracion.** `config.toml` trae el entorno de los MCP,
 *    que puede llevar secretos (regla 2.1). El catalogo enumera opciones,
 *    pero no confirma el modelo ni el esfuerzo activos de la TUI.
 *
 * De `CODEX_HOME` se leen dos carpetas y ninguna se escribe (`paths.ts`).
 */

import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentCapabilities, NativeVoiceCapability } from '@agent-workbench/shared';
import type {
  AgentAdapter,
  AgentInput,
  LaunchHook,
  LaunchInput,
  LaunchPlan,
  SpawnedContext,
} from '../adapter.js';
import { commandNotFoundMessage, locateCommand } from '../locate.js';
import { PlanLimitsBook } from '../plan-limits.js';
import { CodexSessionDiscovery } from './discovery.js';
import { createCodexHistory } from './history.js';
import { codexReadyScreen } from './ready-screen.js';
import { codexHome, isUuid } from './paths.js';
import { codexScreenStatus, CodexScreenStatus } from './screen-status.js';
import { createCodexScreenQuestions } from './question-screen.js';
import { CODEX_DRAFT_STASH } from './draft-box.js';
import { loadCodexModels, supportsCodexModelCommand, supportsCodexPermissionCommand } from './catalog.js';
import { codexQueueLauncher, queueCodexText, supportsCodexQueue, type CodexQueueLauncher } from './queue.js';
import { prewarmCodexDaemon, type CodexDaemonPrewarmer } from './daemon.js';
import type { CliLocation } from '../locate.js';
import type { ModelOption } from '@agent-workbench/shared';

/** Nombre del comando en el PATH. Dato de compatibilidad, no marca (regla 2.3). */
export const CODEX_COMMAND = 'codex';

export const CODEX_INSTALL_URL = 'https://learn.chatgpt.com/docs/codex/cli';

export const CODEX_NATIVE_VOICE: NativeVoiceCapability = {
  defaultMode: 'live',
  modes: [{ mode: 'live', control: 'codex-live-f8' }],
};

export function supportsCodexNativeVoiceVersion(version: string | null): boolean {
  const match = /(?:^|[^\d])v?(\d+)\.(\d+)\.(\d+)/i.exec(version?.trim() ?? '');
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || (major === 0 && minor >= 166);
}

export function codexCapabilitiesForVersion(version: string | null): AgentCapabilities {
  return supportsCodexNativeVoiceVersion(version)
    ? { ...CODEX_CAPABILITIES, nativeVoice: CODEX_NATIVE_VOICE }
    : CODEX_CAPABILITIES;
}

export interface CodexAdapterOptions {
  /** Inyectable para comprobar el contrato sin iniciar procesos externos. */
  prewarmDaemon?: CodexDaemonPrewarmer;
}

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
  // La pantalla no reconoce todas las aprobaciones: conserva la guarda ciega.
  // La pantalla no reconoce todas las aprobaciones: se conserva la guarda ciega.
  statusSource: false,
  // La pantalla no garantiza que la CLI este lista para recibir una nota.
  readySignal: false,
  // Su `shift+tab` cicla el modo de colaboracion (por defecto y Plan), no permisos.
  permissionCycle: null,
  codexPermissions: false,
  // El catalogo se consulta de forma asincrona, despues de localizar la CLI.
  models: null,
  // El getter lo llena junto con el catalogo.
  efforts: null,
  // Las preguntas y aprobaciones reconocidas se leen de la pantalla.
  questionCards: true,
  // Cada imagen en su propio pegado, con la ruta sola: la TUI adjunta si el pegado entero es la ruta.
  imagesByPath: 'bare-path-paste',
  // La tecla `@` abre el buscador; el pegado de AWB es texto, sin control de menciones.
  fileMentions: null,
  // `Esc Esc` abre Browsing y ofrece rewind. Sin id fiable del resultado, no ofrecerlo.
  rewind: false,
  // La ventana exacta viene en el archivo, junto a los tokens.
  contextWindowSource: 'token-count',
  // Los pasos de update_plan se muestran en la solapa de planes.
  plans: true,
  // Un envio normal no debe responder una pregunta o aprobacion abierta.
  waitingBlocksSubmit: true,
  // El envio normal conserva el comportamiento de Codex; la cola nativa tiene un control aparte.
  forceSend: false,
  editQueue: false,
  /*
    Hito 52 (§10.18): por su pantalla, cuando muestra la caja vacia y el
    historial no tiene un turno abierto. Codex no publica si trabaja.
  */
  scheduledSend: true,
  // El comando se ofrece desde Codex 0.166, con texto y una sesion viva.
  codexNativeQueue: false,
  /*
    Hito 55 (§10.19): `resume -C .` retoma desde la carpeta de la rama en el
    mismo rollout, sin dialogo, y el agente trabaja ahi. Sin `-C`, Codex pregunta
    con la carpeta de antes marcada.
  */
  moveToWorktree: true,
  /*
    Hito 49: `--sandbox read-only`, al abrir y al reanudar. Medido con la 0.162.1
    y un proveedor falso: con la sandbox de Windows del usuario, escribir fallo
    con "Acceso denegado" sin preguntar nada y `git diff` corrio; sin ella, pide
    permiso para cada comando. Nunca escribe sin el permiso del usuario (§10.15).
  */
  readOnlyLaunch: { mode: null, guard: 'cli' },
};

/** El argumento de la sandbox de solo lectura, que no lleva espacios: pasa entero por `cmd /c` (§3.1). */
const READ_ONLY_SANDBOX = ['--sandbox', 'read-only'] as const;

/** Hito 55 (§10.19): reanudar en la carpeta de la pestana, sin la pregunta de en que carpeta seguir. */
const RESUME_HERE = ['-C', '.'] as const;

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
 *
 * Los 400 ms no alcanzan con un texto largo, y por eso en Windows van dos cosas
 * mas (hito 35, §10.11). Medido con la 0.155: desde unos 850 caracteres Codex
 * todavia procesa la rafaga cuando llega el Enter y lo toma como salto de linea
 * (0 de 3); con la tecla Fin delante envia siempre (26 de 26). Y lo que llega
 * antes de que dibuje su pantalla, a los 1,7–2,2 s, se pierde: a 0,5–1,5 s del
 * lanzamiento no llegaron 7 de 9, y desde 2 s llegaron 12 de 12.
 */
export function codexInput(platform: NodeJS.Platform): AgentInput {
  const windows = platform === 'win32';
  return {
    imageReference: 'bare-path-paste',
    pieceGapMs: 400,
    pasteMarkers: true,
    enterSeparately: true,
    interruptPresses: 1,
    // `@` abre el buscador de la TUI: el transcript se nombra entre comillas y lo lee el agente.
    transcriptReference: 'quoted-path',
    endBeforeSubmit: windows,
    readyAfterLaunchMs: windows ? 3000 : 0,
    // Evita que el primer envio conteste el dialogo de confianza de la CLI.
    startupDialog: /trust this folder|do you trust|allow Codex to work/i,
    // Codex no publica una tecla segura para apartar texto; AWB conserva el borrador y rechaza el envío.
    draftStash: CODEX_DRAFT_STASH,
    requireKnownActivity: true,
    initialScreenActivity: (lines) => codexScreenStatus(lines).activity,
    startupPendingScreen: /Waiting for startup/i,
  };
}

export const CODEX_INPUT: AgentInput = codexInput(process.platform);

export function createCodexAdapter(options: CodexAdapterOptions = {}): AgentAdapter {
  const discovery = new CodexSessionDiscovery();
  const status = new CodexScreenStatus();
  let location: CliLocation | null = null;
  let queueLauncher: CodexQueueLauncher | null = null;
  let nativeQueueSupported = false;
  let models: ModelOption[] = [];
  let disposed = false;
  let pendingReload: Promise<boolean> | null = null;
  const listeners = new Set<() => void>();
  const reload = (): Promise<boolean> => {
    if (pendingReload !== null) return pendingReload;
    if (location === null || !supportsCodexModelCommand(location.version)) return Promise.resolve(false);
    pendingReload = loadCodexModels(location).then((next) => {
      if (disposed || next.length === 0 || JSON.stringify(next) === JSON.stringify(models)) return false;
      models = next;
      for (const listener of listeners) listener();
      return true;
    }).finally(() => { pendingReload = null; });
    return pendingReload;
  };
  /*
    Los limites del plan de la cuenta (hito 47, §10.14): los escribe Codex en
    cada `token_count`, y se juntan aca a medida que los seguidores leen.
  */
  const planLimits = new PlanLimitsBook();
  const prewarmDaemon = options.prewarmDaemon ?? prewarmCodexDaemon;

  return {
    id: 'codex',
    label: 'Codex',
    command: CODEX_COMMAND,
    installUrl: CODEX_INSTALL_URL,
    get capabilities(): AgentCapabilities {
      const base = {
        ...codexCapabilitiesForVersion(location?.version ?? null),
        codexNativeQueue: nativeQueueSupported,
        codexPermissions: supportsCodexPermissionCommand(location?.version ?? null),
      };
      if (models.length === 0) return base;
      const levels = [...new Set(models.flatMap((model) => model.supportedEfforts ?? []))];
      return { ...base, models, efforts: levels.map((value) => ({ value, label: value })) };
    },
    input: CODEX_INPUT,

    locate: async () => {
      location = await locateCommand(CODEX_COMMAND);
      queueLauncher = location === null ? null : await codexQueueLauncher(location);
      nativeQueueSupported = supportsCodexQueue(location?.version ?? null) && queueLauncher !== null;
      return location;
    },

    queueText: async (target, text) => {
      if (!nativeQueueSupported || queueLauncher === null) throw new Error('codex-queue-unavailable');
      await queueCodexText(queueLauncher, target, text);
    },

    missingMessage: () => commandNotFoundMessage(CODEX_COMMAND, CODEX_INSTALL_URL),

    beforeLaunch: ({ location }, env) => prewarmDaemon(location, env),

    /**
     * Sin argumentos para una sesion nueva, `resume -C . <id>` para una del
     * historial. `proposedSessionId` no se usa: el id lo pone Codex.
     *
     * `-C .` y no `-C <cwd>`: el `cwd` ya es el de la pty, y un argumento con
     * espacios detras de `cmd.exe /c` (el shim `codex.cmd` de npm) rompe el
     * lanzamiento entero. El punto es para la sesion que sigue en otra carpeta
     * (hito 55, §10.19): sin `-C`, Codex pregunta en que carpeta seguir con la
     * de antes marcada, y con el, sigue en la de la pestana sin preguntar. En la
     * carpeta de siempre no cambia nada. Por lo mismo el id se valida antes de
     * tocar la linea de comando: uno con espacios o comillas no llega nunca a
     * `cmd`.
     */
    launch(input: LaunchInput): LaunchPlan {
      const { resumeSessionId } = input;
      // Hito 49: la pestana de revision. `codex resume` acepta la sandbox despues del subcomando (su `--help`).
      const sandbox = input.readOnly === true ? READ_ONLY_SANDBOX : [];
      if (resumeSessionId === null) {
        return { file: input.location.file, args: [...input.location.prefixArgs, ...sandbox], session: { kind: 'discover' } };
      }
      if (!isUuid(resumeSessionId)) throw new Error('Invalid Codex session id.');
      return {
        file: input.location.file,
        args: [...input.location.prefixArgs, 'resume', ...RESUME_HERE, ...sandbox, resumeSessionId],
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
      let sessionId = context.sessionId;
      const screen = context.watchScreen?.() ?? null;
      let reading = false;
      let stopped = false;
      const refresh = async () => {
        if (screen === null || stopped) return;
        const lines = await screen.lines();
        if (!stopped) status.set(sessionId, codexScreenStatus(lines));
      };
      status.attach(sessionId, refresh);
      const timer = screen === null ? null : setInterval(() => {
        if (reading || stopped) return;
        reading = true;
        void refresh().finally(() => { reading = false; });
      }, 500);
      timer?.unref();
      const inner = context.resumed ? discovery.watchLive({ terminalId: context.terminalId, cwd: context.cwd }) : discovery.register({
        terminalId: context.terminalId,
        cwd: context.cwd,
        launchedAt: context.launchedAt,
        reportSessionId: (id) => {
          status.remove(sessionId);
          sessionId = id;
          if (!stopped) status.attach(id, refresh);
          context.reportSessionId(id);
        },
      });
      const dispose = () => { stopped = true; if (timer !== null) clearInterval(timer); screen?.dispose(); status.remove(sessionId); };
      return {
        cancel: () => { dispose(); inner?.cancel(); },
        onExit: () => { dispose(); if (inner?.onExit) inner.onExit(); else inner?.cancel(); },
        onInput: (data) => inner?.onInput?.(data),
        ...(inner?.onSubmitted ? { onSubmitted: (text: string) => inner.onSubmitted?.(text) } : {}),
      };
    },

    history: createCodexHistory({ planLimits }),
    status,
    screenQuestions: createCodexScreenQuestions(),
    /*
      Hito 52 (§10.18): un mensaje programado se escribe cuando la pantalla
      muestra la caja vacia. Con el daemon en frio lo escrito espera en la caja
      ("Waiting for startup") y llego a los 40 s: la confirmacion espera dos
      minutos.
    */
    scheduled: { kind: 'screen', readyScreen: codexReadyScreen, confirmTimeoutMs: 120_000 },
    planLimits,

    defaults: async () => null,
    prepare: async () => { void reload(); },
    refreshSetup: reload,
    subscribeChanges: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },

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

    dispose: () => {
      disposed = true;
      listeners.clear();
      discovery.dispose();
      status.dispose();
      planLimits.dispose();
    },
  };
}
