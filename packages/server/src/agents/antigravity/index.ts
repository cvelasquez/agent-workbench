/**
 * El adaptador de Antigravity CLI (`agy`).
 *
 * Todo lo que el servidor sabe de esta CLI en un solo objeto, como los de
 * Claude Code, Codex y OpenCode. Cuatro diferencias que ordenan el resto:
 *
 *  - **El id de la conversacion lo pone la CLI, y nace con el primer mensaje.**
 *    Una pestana nueva queda "descubriendo" hasta entonces, y el id sale del
 *    log de la CLI de ESE lanzamiento (`discovery.ts`), que se sigue toda la
 *    vida de la pestana: `/clear` y `/resume` cambian de conversacion ahi mismo.
 *  - **El estado, el modo observado y el medidor dependen de que el usuario
 *    configure la status line** (`status.ts`). Sin ella la pestana dice que no
 *    se sabe. Por eso las capacidades cambian con la configuracion: son un
 *    getter, no una constante.
 *  - **El historial se lee por su transcript y un indice SQLite por copia**
 *    (`history.ts`, `catalog.ts`). Nada se escribe en las carpetas de la CLI.
 *  - **La app escribe dos cosas suyas**: el script de la status line en su
 *    carpeta de configuracion, y el log de cada pestana en la temporal. Las dos
 *    solo si la CLI esta instalada (`prepare`, que corre despues de la
 *    migracion de la carpeta de configuracion).
 *
 * Se lanza con `--mode accept-edits`, por lo mismo que Claude Code arranca en
 * `auto` (CLAUDE.md 4.8.1): que las pestanas no se frenen a preguntar por cada
 * edicion. Los comandos siguen pidiendo permiso.
 */

import { mkdirSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { AgentCapabilities, StatusLineSetupInfo, StatusLineState } from '@agent-workbench/shared';
import { cliLogsTempDir, integrationsDir } from '../../paths.js';
import type { AgentAdapter, AgentInput, LaunchHook, LaunchInput, LaunchPlan, SpawnedContext } from '../adapter.js';
import { commandNotFoundMessage, locateCommand } from '../locate.js';
import { removeStaleCatalogCopies } from './catalog.js';
import { FileStampSignal } from './catalog-signal.js';
import {
  ANTIGRAVITY_COMMAND,
  ANTIGRAVITY_EFFORT_OPTIONS,
  ANTIGRAVITY_INSTALL_URL,
  ANTIGRAVITY_LABEL,
  ANTIGRAVITY_LAUNCH_MODE,
  ANTIGRAVITY_MODE_CYCLE,
  ANTIGRAVITY_MODEL_OPTIONS,
  CONVERSATION_ID_PATTERN,
} from './constants.js';
import { LogWatcher } from './discovery.js';
import { createAntigravityHistory } from './history.js';
import { toCliMode } from './mode-names.js';
import { splitModelLabel } from './model-label.js';
import { geminiHome, settingsPath } from './paths.js';
import { readAntigravitySettings } from './settings.js';
import { AntigravityStatusSource, AntigravityStatusStore, createFollowerStatusLine } from './status.js';
import { installStatusLineScript, statusLineFragment, statusLineScriptPath } from './statusline-script.js';

/**
 * Si se pasa `--add-dir <cwd>` al lanzar. Medido: sin el, el indice de la CLI
 * ya guarda la carpeta de la pestana (`workspace_uris`), asi que no hace falta.
 */
export const ADD_DIR = false;

/**
 * Si "lista para recibir" se promete con la status line. No: una pestana nueva
 * no tiene conversacion hasta el primer mensaje, asi que no hay registro que
 * diga que esta libre, y "mandar una nota" esperaria a algo que no llega. La
 * alternativa anotada es lanzar con `-i <texto>`; no se decide en este hito.
 */
export const READY_SIGNAL_SAFE = false;

/** A las 24 h se borra el log de una pestana: trae los prompts y el email de la cuenta. */
export const CLI_LOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Cada cuanto se mira `settings.json` mientras alguien quiere enterarse de cambios. */
export const SETTINGS_POLL_INTERVAL_MS = 2_000;

/** El token que pone el registro: un uuid. Otro valor no nombra ningun archivo. */
const LAUNCH_TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Una ruta que `cmd.exe /c` pasa entera sin comillas. */
const SHIM_SAFE_PATH = /^[A-Za-z0-9_.:\\/-]+$/;

/**
 * Lo que la interfaz dibuja para esta CLI sin la status line. El chequeo lo
 * compara contra un literal: una capacidad que se prende sin medirla promete
 * algo que la CLI no hace.
 */
export const ANTIGRAVITY_BASE_CAPABILITIES: AgentCapabilities = {
  // No hay `--session-id`: el id sale del log.
  sessionIdAtLaunch: false,
  // `--conversation <id>`. Medido: sin carpeta nueva y sin dialogo.
  resume: true,
  // Solo con la status line.
  statusSource: false,
  readySignal: false,
  permissionCycle: {
    // Medido dos vueltas: accept-edits -> plan -> default.
    modes: ANTIGRAVITY_MODE_CYCLE,
    launchMode: ANTIGRAVITY_LAUNCH_MODE,
    keyLabel: 'shift+tab',
    // Segun la documentacion de modos, ciclar con ediciones pendientes las aprueba.
    approvesPendingOnCycle: true,
  },
  models: ANTIGRAVITY_MODEL_OPTIONS,
  efforts: ANTIGRAVITY_EFFORT_OPTIONS,
  // Existe una pregunta al usuario, pero su menu no esta medido.
  questionCards: false,
  // Una imagen por ruta no esta medida (M9).
  imagesByPath: null,
  // `@ruta` no esta medido (M10).
  fileMentions: null,
  // `/rewind` existe; `Esc Esc` no esta medido.
  rewind: false,
  // Solo con la status line: el transcript no trae tokens.
  contextWindowSource: null,
  plans: false,
};

/** Las mismas con la status line configurada: estado, "esperando" y medidor. */
export const ANTIGRAVITY_STATUS_LINE_CAPABILITIES: AgentCapabilities = {
  ...ANTIGRAVITY_BASE_CAPABILITIES,
  statusSource: true,
  readySignal: READY_SIGNAL_SAFE,
  contextWindowSource: 'status-line',
};

/**
 * Como se le escribe un mensaje: el texto pegado con marcadores y el Enter
 * aparte, a 400 ms; un solo Esc interrumpe. Medido con la 1.2.2: un pegado de
 * dos lineas queda en el cuadro sin enviar, y el Enter en otro write manda un
 * solo mensaje con el salto adentro. Las imagenes por ruta no se ofrecen.
 */
export const ANTIGRAVITY_INPUT: AgentInput = {
  imageReference: null,
  pieceGapMs: 400,
  pasteMarkers: true,
  enterSeparately: true,
  interruptPresses: 1,
};

/** La ruta del log de un lanzamiento, o null si el token no es un uuid. */
export function cliLogPathFor(launchToken: string): string | null {
  if (!LAUNCH_TOKEN_PATTERN.test(launchToken)) return null;
  return path.join(cliLogsTempDir(), `${launchToken.toLowerCase()}.log`);
}

/** Borra los logs de pestanas de mas de `maxAgeMs`. Solo `<uuid>.log`. Nunca lanza. */
export async function removeStaleCliLogs(dir: string = cliLogsTempDir(), maxAgeMs = CLI_LOG_MAX_AGE_MS, now = Date.now()): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const match = /^(.+)\.log$/i.exec(name);
    if (match === null || !LAUNCH_TOKEN_PATTERN.test(match[1] ?? '')) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (info.isFile() && now - info.mtimeMs > maxAgeMs) await unlink(file);
    } catch {
      // Tomado por una CLI que sigue corriendo, o ya borrado.
    }
  }
}

export interface AntigravityAdapterOptions {
  /** Para el chequeo. Por defecto, la del proceso. */
  platform?: string;
  store?: AntigravityStatusStore;
  statusIntervalMs?: number;
  /** El aviso de cambios de `settings.json`. Por defecto, un sondeo de `stat` cada 2 s. */
  settingsSignal?: { subscribe(listener: (file: string) => void): () => void; dispose(): void };
}

export function createAntigravityAdapter(options: AntigravityAdapterOptions = {}): AgentAdapter {
  const platform = options.platform ?? process.platform;
  const store = options.store ?? new AntigravityStatusStore();
  let state: StatusLineState = 'missing';
  /** true despues de `prepare`: recien ahi la app puede escribir en su carpeta por esta CLI. */
  let prepared = false;
  const isActive = (): boolean => state === 'active';
  const status = new AntigravityStatusSource(store, isActive, { intervalMs: options.statusIntervalMs });
  const watchers = new Set<LogWatcher>();
  const settingsSignal =
    options.settingsSignal ?? new FileStampSignal(() => [settingsPath()], { intervalMs: SETTINGS_POLL_INTERVAL_MS });

  const scriptPath = (): string => statusLineScriptPath(integrationsDir());

  const refreshSetup = async (): Promise<boolean> => {
    const settings = await readAntigravitySettings();
    if (prepared) {
      // Si alguien edito o borro el script, se reescribe: el estado no cambia por eso.
      try {
        await installStatusLineScript(integrationsDir());
      } catch (error) {
        console.warn(`[antigravity] no pude reinstalar el script de la status line: ${String(error)}`);
      }
    }
    const changed = settings.statusLine.state !== state;
    state = settings.statusLine.state;
    return changed;
  };

  return {
    id: 'antigravity',
    label: ANTIGRAVITY_LABEL,
    command: ANTIGRAVITY_COMMAND,
    installUrl: ANTIGRAVITY_INSTALL_URL,
    get capabilities(): AgentCapabilities {
      return isActive() ? ANTIGRAVITY_STATUS_LINE_CAPABILITIES : ANTIGRAVITY_BASE_CAPABILITIES;
    },
    input: ANTIGRAVITY_INPUT,

    // `--version` no crea nada en el home (medido).
    locate: () => locateCommand(ANTIGRAVITY_COMMAND),

    missingMessage: () => commandNotFoundMessage(ANTIGRAVITY_COMMAND, ANTIGRAVITY_INSTALL_URL),

    /**
     * `--log-file` con el archivo de este lanzamiento, el modo, y
     * `--conversation <id>` para reanudar. `proposedSessionId` no se usa.
     *
     * El id se valida antes de tocar la linea de comando, y el log se omite si
     * no hay donde escribirlo o si la ruta no pasaria entera por un shim `.cmd`
     * (`cmd.exe /c` rompe un argumento con espacios). Sin log propio queda el
     * respaldo por pid, que **no** cubre el shim (R27-7): el pid de la pty es el
     * del `cmd`, y el log de la CLI trae el de `agy.exe`. Con shim y una
     * temporal con espacios la pestana no descubre su conversacion; se avisa en
     * la consola. Hoy `agy` es un `.exe` real (CLAUDE.md 3.1).
     */
    launch(input: LaunchInput): LaunchPlan {
      const { resumeSessionId } = input;
      if (resumeSessionId !== null && !CONVERSATION_ID_PATTERN.test(resumeSessionId)) {
        throw new Error('Id de conversacion de Antigravity CLI invalido.');
      }
      let logPath = cliLogPathFor(input.launchToken);
      if (logPath !== null && input.location.prefixArgs.length > 0 && !SHIM_SAFE_PATH.test(logPath)) {
        console.warn(
          '[antigravity] la CLI llega por un shim y la carpeta temporal tiene caracteres que cmd /c corta: sin log propio, una pestana nueva no descubre su conversacion ni ve un /clear.',
        );
        logPath = null;
      }
      if (logPath !== null) {
        try {
          // Solo del usuario: el log trae los prompts (M8).
          mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
        } catch {
          logPath = null;
        }
      }
      const mode = toCliMode(ANTIGRAVITY_LAUNCH_MODE);
      return {
        file: input.location.file,
        args: [
          ...input.location.prefixArgs,
          ...(logPath !== null ? ['--log-file', logPath] : []),
          ...(mode !== null ? ['--mode', mode] : []),
          ...(ADD_DIR ? ['--add-dir', input.cwd] : []),
          ...(resumeSessionId !== null ? ['--conversation', resumeSessionId] : []),
        ],
        session: resumeSessionId !== null ? { kind: 'known', sessionId: resumeSessionId } : { kind: 'discover' },
      };
    },

    /**
     * Copia del entorno, sin quitar nada. La CLI pone `ANTIGRAVITY_AGENT` y
     * `ANTIGRAVITY_CONVERSATION_ID` en sus procesos hijos (segun el binario):
     * no se filtran hasta medir que cambien algo (R11).
     */
    environment(base) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) env[key] = value;
      }
      return { env, notice: null };
    },

    /*
      El gancho sigue el log toda la vida de la pestana, asi que no puede
      soltarse con la primera tecla (declara `onInput`, y de paso mira antes: el
      id sale a los 60 ms del Enter). Al cambiar de conversacion en la misma pty
      (`/clear`, `/resume`) el registro de la que se deja se borra: si se vuelve
      a ella ahi mismo, su registro viejo pasaria por uno de este proceso.

      Al salir la CLI, al cerrar la pestana o al apagar el servidor solo se
      suelta de la pty, y el registro queda (R27-4): el gancho no distingue un
      cierre de un apagado, y en el apagado la pestana vuelve dormida con el
      medidor en "sin medir" si el archivo ya no esta. Sin pty su estado no
      cuenta (`store.current`), los tokens si; lo borra el proximo reanudar
      (R9) o la limpieza de 7 dias.
    */
    onSpawned(context: SpawnedContext): LaunchHook {
      let current: string | null = null;
      const bind = (conversationId: string): void => {
        if (current !== null && current !== conversationId) {
          store.detach(current);
          store.forget(current);
        }
        current = conversationId;
        store.attach(conversationId, context.launchedAt);
      };
      if (context.resumed && CONVERSATION_ID_PATTERN.test(context.sessionId)) {
        // Lo que dijo la corrida anterior ya no es de este proceso (R9).
        store.forget(context.sessionId);
        bind(context.sessionId.toLowerCase());
      }

      const watcher = new LogWatcher({
        logPath: cliLogPathFor(context.launchToken),
        pid: context.pid,
        launchedAt: context.launchedAt,
        initialId: current,
        label: context.terminalId.slice(0, 8),
        onConversation: (conversationId) => {
          bind(conversationId);
          context.reportSessionId(conversationId);
        },
      });
      watchers.add(watcher);
      watcher.start();

      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        watcher.dispose();
        watchers.delete(watcher);
        if (current !== null) store.detach(current);
      };
      return {
        cancel: close,
        // Una ultima mirada: un mensaje mandado justo antes de salir ya creo su conversacion.
        onExit: () => {
          void watcher.finalPass().finally(close);
        },
        onInput: () => watcher.nudge(),
        onSubmitted: () => watcher.nudge(),
      };
    },

    history: createAntigravityHistory({ statusLine: createFollowerStatusLine(store, isActive) }),
    status,

    /**
     * El modelo de `settings.json`, provisional hasta la primera respuesta. La
     * etiqueta va entera (`Gemini 3.7 Flash (Low)`): es la familia con la que
     * casa el combo. La ventana la da la status line, no el nombre.
     */
    async defaults() {
      const settings = await readAntigravitySettings();
      if (settings.model === null) return { model: null, effort: null, contextWindow: null };
      return { model: settings.model, effort: splitModelLabel(settings.model).effort, contextWindow: null };
    },

    /** Toda `~/.gemini`: la CLI, el IDE, la configuracion compartida y las credenciales. */
    protectedDirs: () => [geminiHome()],

    async prepare(): Promise<void> {
      prepared = true;
      try {
        await installStatusLineScript(integrationsDir());
      } catch (error) {
        console.warn(`[antigravity] no pude instalar el script de la status line: ${String(error)}`);
      }
      await removeStaleCliLogs();
      await store.removeStale();
      await removeStaleCatalogCopies();
      await refreshSetup();
    },

    statusLine(): StatusLineSetupInfo {
      const script = scriptPath();
      return { state, settingsPath: settingsPath(), scriptPath: script, fragment: statusLineFragment(script, platform) };
    },

    refreshSetup,

    subscribeChanges(listener: () => void): () => void {
      return settingsSignal.subscribe(() => {
        void refreshSetup().then((changed) => {
          if (changed) listener();
        });
      });
    },

    dispose: () => {
      for (const watcher of watchers) watcher.dispose();
      watchers.clear();
      settingsSignal.dispose();
      status.dispose();
    },
  };
}

