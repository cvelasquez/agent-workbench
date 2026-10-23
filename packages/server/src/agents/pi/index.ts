/**
 * El adaptador de Pi (`pi`).
 *
 * Todo lo que el servidor sabe de esta CLI en un solo objeto, como los de las
 * otras cuatro. Lo medido contra la 1.1.0, y comprobado otra vez con la 1.2.0,
 * esta en CLAUDE.md 16. Cinco cosas que ordenan el resto:
 *
 *  - **El id de sesion lo pone la app, y un solo comando sirve para todo.**
 *    `pi --session-id <id>` abre la sesion si existe y la crea con ese id si no.
 *  - **La version se lee sin ejecutar nada** (`locate.ts`): `pi --version` toca
 *    la carpeta de Pi, y la app no escribe en la carpeta de ninguna CLI.
 *  - **El estado sale del archivo de sesion** (`live.ts`). Pi lo avisa por la
 *    terminal, pero en Windows la app no puede contestarle la consulta que lo
 *    enciende.
 *  - **Los modelos del combo son los de la cuenta** (`catalog.ts`), asi que las
 *    capacidades son un getter y la lista de CLIs se reenvia cuando cambian.
 *  - **Pi no pide permiso antes de usar sus herramientas.** No hay modos ni
 *    menus de aprobacion; lo unico que la app no contesta por el usuario es su
 *    dialogo de confianza (`tab-watch.ts`).
 *
 * De la carpeta de Pi se leen las sesiones y `models-store.json`, y no se
 * escribe nada (`paths.ts`). `auth.json`, `models.json`, `settings.json` y lo de
 * MCP no se abren nunca.
 */

import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentCapabilities } from '@agent-workbench/shared';
import type { AgentAdapter, AgentInput, LaunchHook, LaunchInput, LaunchPlan, SpawnedContext } from '../adapter.js';
import { commandNotFoundMessage } from '../locate.js';
import { modelOptions, PiModelCatalog } from './catalog.js';
import {
  isPiSessionId,
  PI_CLEAR_GAP_MS,
  PI_COMMAND,
  PI_EFFORT_OPTIONS,
  PI_INSTALL_URL,
  PI_LABEL,
  PI_READY_AFTER_LAUNCH_MS,
  PI_REVIEW_TOOLS,
} from './constants.js';
import { createPiHistory } from './history.js';
import { PiLiveSessions, PiStatusSource, type PiLiveDeps } from './live.js';
import { locatePi, type LocatePiDeps } from './locate.js';
import { piAgentDir, piModelsStorePath } from './paths.js';
import { createPiQueueEdit } from './queue-edit.js';
import { PiTabWatch } from './tab-watch.js';

/** Cada cuanto se mira `models-store.json` mientras alguien quiere enterarse de cambios. */
export const PI_MODELS_POLL_MS = 2_000;

/**
 * Lo que la interfaz dibuja para esta CLI, sin la lista de modelos, que depende
 * de la cuenta. `check-pi-adapter.mjs` lo compara contra un literal: una
 * capacidad que se prende sin medirla promete algo que la CLI no hace.
 */
export const PI_BASE_CAPABILITIES: AgentCapabilities = {
  // `--session-id <id>` con un id que pone la app (16.4).
  sessionIdAtLaunch: true,
  // El mismo comando abre la sesion si existe.
  resume: true,
  // Del archivo de sesion: trabajando desde el mensaje hasta la respuesta final (16.6).
  statusSource: true,
  // "Libre" no dice que la interfaz ya acepte un pegado, y antes del primer mensaje no hay archivo.
  readySignal: false,
  // Pi no tiene modos de permiso.
  permissionCycle: null,
  // Los de la cuenta, cuando se leen (`capabilities`).
  models: null,
  // `/thinking <nivel>` se aplica directo y escribe su entrada en el acto (16.10).
  efforts: PI_EFFORT_OPTIONS,
  // No tiene herramienta de preguntas.
  questionCards: false,
  // Pi no adjunta lo pegado: la ruta va en el texto y el modelo la abre (16.5).
  imagesByPath: 'quoted-path-line',
  // `@` abre un buscador de archivos y queda como texto.
  fileMentions: null,
  // Dos Esc abren `/tree`: otro flujo.
  rewind: false,
  // Tokens por respuesta en la sesion, y la ventana en el catalogo (16.9).
  contextWindowSource: 'usage-with-catalog',
  plans: false,
  // Con el dialogo de confianza abierto, el Enter de un mensaje lo aceptaria (16.11).
  waitingBlocksSubmit: true,
  // Sin tecla de "enviar ya": se detiene y se vuelve a mandar lo que tenia en cola (hito 45, §16.18).
  forceSend: true,
  /*
    Alt+Q devuelve la cola a su editor sin cortar el turno, y Ctrl+C lo vacia
    (§6.35.1). Medido en Windows; fuera, la tecla es Alt+Up y no esta medida.
  */
  editQueue: process.platform === 'win32',
  // Hito 49: sin `edit` ni `write` (`PI_REVIEW_TOOLS`), pero su consola puede escribir: a medias (§16.19).
  readOnlyLaunch: { mode: null, guard: 'tools' },
};

/**
 * Como se le escribe un mensaje: el pegado y el Enter en un solo write, como a
 * Claude Code. Medido: a un programa de Node bajo ConPTY le llegan intactos los
 * marcadores de pegado, y Pi envia con el Enter pegado al final (16.5). Un solo
 * Esc interrumpe; dos, con el editor vacio, abririan `/tree`.
 */
export const PI_INPUT: AgentInput = {
  imageReference: 'quoted-path-line',
  pieceGapMs: 0,
  pasteMarkers: true,
  enterSeparately: false,
  interruptPresses: 1,
  // Con la ruta entre comillas el modelo abre el archivo (medido); `@` abre un buscador.
  transcriptReference: 'quoted-path',
  // Antes de que dibuje su interfaz, un Enter no envia: el texto queda en su editor (16.4).
  readyAfterLaunchMs: PI_READY_AFTER_LAUNCH_MS,
};

export interface PiAdapterOptions {
  /** Para el chequeo. */
  locate?: LocatePiDeps;
  live?: PiLiveDeps;
  /** El aviso de cambios del catalogo. Por defecto, un `stat` cada 2 s. */
  modelsPollMs?: number;
}

export function createPiAdapter(options: PiAdapterOptions = {}): AgentAdapter {
  /** La carpeta del paquete instalado, desde que se localizo. */
  let packageDir: string | null = null;
  const catalog = new PiModelCatalog({ storeFile: piModelsStorePath, packageDir: () => packageDir });
  const live = new PiLiveSessions(options.live);
  const status = new PiStatusSource(live);
  const tabs = new Set<PiTabWatch>();
  const pollers = new Set<NodeJS.Timeout>();

  /** La firma de `models-store.json`, para no parsearlo si no cambio. */
  const storeStamp = async (): Promise<string> => {
    const file = piModelsStorePath();
    if (file === null) return 'none';
    try {
      const info = await stat(file);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return 'none';
    }
  };

  return {
    id: 'pi',
    label: PI_LABEL,
    command: PI_COMMAND,
    installUrl: PI_INSTALL_URL,
    get capabilities(): AgentCapabilities {
      const models = modelOptions(catalog.list());
      return models.length === 0 ? PI_BASE_CAPABILITIES : { ...PI_BASE_CAPABILITIES, models };
    },
    input: PI_INPUT,

    async locate() {
      const found = await locatePi(options.locate);
      packageDir = found?.packageDir ?? null;
      if (found === null) return null;
      return { resolvedPath: found.resolvedPath, file: found.file, prefixArgs: found.prefixArgs, version: found.version };
    },

    missingMessage: () => commandNotFoundMessage(PI_COMMAND, PI_INSTALL_URL),

    /**
     * `--session-id <id>` para una sesion nueva y para una que se reanuda: Pi
     * decide sola cual es. El id se valida antes de tocar la linea de comando,
     * porque va detras de `cmd /c` (CLAUDE.md 3.1): con la forma que exige Pi es
     * un token sin espacios ni comillas, y no puede leerse como una opcion.
     */
    launch(input: LaunchInput): LaunchPlan {
      const sessionId = input.resumeSessionId ?? input.proposedSessionId;
      if (!isPiSessionId(sessionId)) throw new Error('Invalid Pi session id.');
      // Hito 49: la pestana de revision, sin las herramientas de editar, al abrir y al reanudar.
      const tools = input.readOnly === true ? ['--tools', PI_REVIEW_TOOLS] : [];
      return {
        file: input.location.file,
        args: [...input.location.prefixArgs, ...tools, '--session-id', sessionId],
        session: { kind: 'known', sessionId },
      };
    },

    /**
     * Copia del entorno, sin quitar nada y sin agregar nada: ni
     * `PI_PROGRAM_STATUS`, que encenderia los avisos de estado, ni
     * `PI_TELEMETRY`, que apagaria el aviso de instalacion a pi.dev. Las dos son
     * del usuario (regla 2.1).
     */
    environment(base) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) env[key] = value;
      }
      return { env, notice: null };
    },

    /*
      El gancho vive toda la vida de la pestana: mira el dialogo de confianza al
      arrancar y, despues de cada Enter, si Pi paso a escribir en otra sesion
      (`/new`, `/fork`, `/resume`). Declara `onInput` para que el primer write no
      lo suelte.
    */
    onSpawned(context: SpawnedContext): LaunchHook {
      const watch = new PiTabWatch(context, { live, tabs: () => tabs });
      tabs.add(watch);
      watch.start();
      const hook = watch.hook();
      return {
        ...hook,
        cancel: () => {
          tabs.delete(watch);
          hook.cancel();
        },
      };
    },

    history: createPiHistory(catalog),
    status,

    queuedSubmits: {
      clearGapMs: PI_CLEAR_GAP_MS,
      returnReason: 'returned-by-cli',
      check: (target, submissions, interruptedAt) => live.check(target.sessionId, submissions, interruptedAt),
    },

    /*
      Pi no escribe su cola hasta entregarla (16.5): es lo que la app le mando
      con el agente trabajando. Sin tecla de "enviar ya", se detiene y se vuelve
      a mandar lo que devolvio a su editor (hito 45, §16.18).
    */
    promptQueue: { source: 'app', forceSend: 'interrupt-and-resend' },

    // Sacar la cola para editarla en el cuadro (§6.35.1): vuelve lo que la app le mando.
    queueEdit: createPiQueueEdit(),

    // `settings.json` no se abre: sin modelo por defecto que anunciar. Al reanudar,
    // el modelo y el nivel salen de la propia sesion.
    defaults: () => Promise.resolve(null),

    /**
     * `~/.pi` entera y, si `PI_CODING_AGENT_DIR` apunta a otro lado, esa
     * tambien: las credenciales de antes de cambiarla siguen en la primera. La
     * carpeta de sesiones de `PI_CODING_AGENT_SESSION_DIR` no: puede ser la de
     * un proyecto.
     */
    protectedDirs: () => {
      const dirs = [path.join(homedir(), '.pi')];
      const agentDir = piAgentDir();
      if (agentDir !== null && !dirs.some((dir) => agentDir === dir || agentDir.startsWith(`${dir}${path.sep}`))) {
        dirs.unshift(agentDir);
      }
      return dirs;
    },

    /** Lee el catalogo de la cuenta. Solo corre con Pi encontrada. */
    async prepare(): Promise<void> {
      await catalog.reload();
    },

    refreshSetup: () => catalog.reload(),

    /** Avisa cuando la lista de modelos de la cuenta cambia: un `/login` nuevo, o Pi que la refresca. */
    subscribeChanges(listener: () => void): () => void {
      let last: string | null = null;
      let busy = false;
      const timer = setInterval(() => {
        if (busy) return;
        busy = true;
        void (async () => {
          const stamp = await storeStamp();
          if (last !== null && stamp !== last && (await catalog.reload())) listener();
          last = stamp;
        })()
          .catch(() => undefined)
          .finally(() => {
            busy = false;
          });
      }, options.modelsPollMs ?? PI_MODELS_POLL_MS);
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
      tabs.clear();
      status.dispose();
    },
  };
}
