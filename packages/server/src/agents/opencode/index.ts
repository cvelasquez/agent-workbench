/**
 * El adaptador de la CLI de OpenCode.
 *
 * Todo lo que el servidor sabe de esta CLI en un solo objeto, como los de
 * Claude Code y Codex. Cuatro diferencias que ordenan el resto:
 *
 *  - **El historial es una base SQLite compartida**, no un archivo por sesion.
 *    Se abre en solo lectura con `node:sqlite` (`agents/sqlite.ts`), nunca se
 *    escribe, y de ella se leen solo `session`, `message` y `part`
 *    (`sql.ts`). Para **leer** el historial no se corre ningun subcomando de
 *    `opencode`: con la base real, uno cualquiera la modifica (hace un
 *    checkpoint al abrirla).
 *  - **Las pestanas se enganchan a un `opencode serve` propio** (hito 29, D1):
 *    uno solo por arranque, perezoso, en `127.0.0.1` y con una contrasena por
 *    arranque (`serve-process.ts`). Cada pestana es un `opencode attach` a ese
 *    servidor (`serve-launch.ts`).
 *  - **La sesion se crea por API antes de lanzar** (D6): la pestana nace con su
 *    id y no hay nada que descubrir. `discovery.ts`, que casaba la pestana con
 *    la fila que nacia en la base, se borro con esto (D7).
 *  - **El estado y las preguntas salen del `serve`** (D9, D10): un flujo de
 *    eventos para todas las pestanas (`serve-status.ts`) y las respuestas por
 *    su API (`serve-questions.ts`). El hilo sigue saliendo de la base (D8).
 *
 * Su configuracion no se abre: `opencode.json` puede traer claves de
 * proveedores y el entorno de los MCP (regla 2.1). Sin modelo por defecto que
 * mostrar.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AgentCapabilities } from '@agent-workbench/shared';
import type {
  AgentAdapter,
  AgentInput,
  CliLocation,
  LaunchHook,
  LaunchInput,
  LaunchPlan,
  SpawnedContext,
} from '../adapter.js';
import { commandNotFoundMessage, locateCommand } from '../locate.js';
import { loadSqlite, ReadOnlyDatabase, sqliteUnavailableText, type SqliteLoad } from '../sqlite.js';
import { ModelCatalog } from './catalog.js';
import { DbChangeSignal } from './db-signal.js';
import { createOpenCodeHistory } from './history.js';
import { OPENCODE_SESSION_ID_PATTERN } from './ids.js';
import { resolveOpenCodePaths, type OpenCodePaths } from './paths.js';
import { OpenCodeServeClient, type ServeClientOptions } from './serve-client.js';
import { createServeLaunchHook } from './serve-hook.js';
import { launchWithServe } from './serve-launch.js';
import { OpenCodeServeProcess, type ServeEndpoint, type ServeProcessOptions } from './serve-process.js';
import { OpenCodeQuestions, readPartCall } from './serve-questions.js';
import { OpenCodeServeStatus, readSessionParent, type ServeStatusOptions } from './serve-status.js';
import { OPENCODE_REQUIRED_COLUMNS } from './sql.js';

/** Nombre del comando en el PATH. Dato de compatibilidad, no marca (regla 2.3). */
export const OPENCODE_COMMAND = 'opencode';

export const OPENCODE_INSTALL_URL = 'https://opencode.ai/docs/';

/** Nombre para los avisos y el `label` de la base. */
const OPENCODE_LABEL = 'OpenCode';

/**
 * Cuanto sin consultas antes de soltar la base. Con un lector abierto, OpenCode
 * no puede borrar el `-wal` al cerrar, y en Windows no puede reemplazar la base;
 * reabrirla cuesta de 8 a 12 ms (medido).
 */
export const OPENCODE_DB_IDLE_CLOSE_MS = 30_000;

/** La forma de un id de sesion. Vive en `ids.ts` (hito 29): tambien la usa el cliente del `serve`. */
export { OPENCODE_SESSION_ID_PATTERN };

/**
 * Lo que la interfaz dibuja para esta CLI. `check-opencode-db.mjs` y
 * `check-opencode-serve.mjs` (O11) lo comparan contra un literal: una capacidad
 * que se prende sin medirla promete algo que la CLI no hace.
 */
export const OPENCODE_CAPABILITIES: AgentCapabilities = {
  // D6: la sesion se crea por API antes de lanzar, y `attach --session` la abre.
  sessionIdAtLaunch: true,
  // `attach --session <id>`.
  resume: true,
  // El flujo de eventos del `serve` (D9).
  statusSource: true,
  /*
    El estado es del `serve`, no del TUI: "libre" no dice que el TUI este listo
    para recibir un pegado. Una nota o una continuacion no se mandan solas.
  */
  readySignal: false,
  // `Tab` cicla agentes (`build`, `plan`), no permisos.
  permissionCycle: null,
  // `/models` abre un selector y no acepta argumento.
  models: null,
  // La variante se cicla con `ctrl+t`, que el navegador se queda.
  efforts: null,
  // Por la API del `serve`, sin teclas (D10, `serve-questions.ts`).
  questionCards: true,
  /*
    Medido en vivo con la 1.18.30 sobre el TUI suelto: una ruta de imagen
    pegada sola —sin comillas, aunque tenga espacios— se adjunta; el TUI
    muestra `[Image 1]` y el mensaje guarda una parte `file` con los bytes. Es
    la forma de Codex. Sobre el TUI enganchado se vuelve a medir (F2).
  */
  imagesByPath: 'bare-path-paste',
  // `@` abre un buscador en el TUI; que `@ruta ` adjunte algo esta sin medir.
  fileMentions: null,
  // `Esc Esc` aca interrumpe: no hay menu de rewind.
  rewind: false,
  // Tokens por mensaje y `limit.context` del catalogo de modelos de la CLI.
  contextWindowSource: 'usage-with-catalog',
  // No hay planes en archivo.
  plans: false,
  /*
    D12: con un permiso o una pregunta abiertos, el pegado y su Enter caerian
    en el menu del TUI. El candado de §10.8 (`hasOpenToolCall`) no sirve: se
    apaga con `statusSource`.
  */
  waitingBlocksSubmit: true,
};

/**
 * Como se le escribe un mensaje: cada imagen en su propio pegado, con la ruta
 * sola; el texto en otro; el Enter aparte, con 400 ms entre pieza y pieza; y dos
 * Esc para interrumpir.
 *
 * Es la forma de Codex, y medida en vivo con la 1.18.30 en Windows sobre el TUI
 * suelto: el texto de cuatro lineas y 260 caracteres entra entero y se envia
 * una vez; la ruta pegada sola se adjunta; un solo Esc muestra "esc again to
 * interrupt" y no corta nada, el segundo interrumpe (`MessageAbortedError`).
 * Sobre el TUI enganchado se vuelve a medir (F2).
 */
export const OPENCODE_INPUT: AgentInput = {
  imageReference: 'bare-path-paste',
  pieceGapMs: 400,
  pasteMarkers: true,
  enterSeparately: true,
  interruptPresses: 2,
  // `@` abre un buscador en el TUI (11.11): el transcript va entre comillas.
  transcriptReference: 'quoted-path',
};

export interface OpenCodeAdapterOptions {
  /** Para el chequeo. Por defecto, el entorno, el home y la plataforma del proceso. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Para el chequeo: de donde sale `node:sqlite`. */
  sqlite?: () => SqliteLoad;
  /**
   * El entorno con el que arranca el `serve`, al que solo se le agrega la
   * contrasena. El registro de la app pasa su entorno compuesto, el mismo de
   * las pestanas. Por defecto, una copia del entorno del proceso.
   */
  serveEnv?: () => Record<string, string>;
  /** Para el chequeo: como se lanza el `serve` y en que carpeta. */
  serveProcess?: Partial<Omit<ServeProcessOptions, 'location' | 'baseEnv'>>;
  /** Para el chequeo: esperas del flujo de eventos mas cortas. */
  serveClient?: ServeClientOptions;
  /** Para el chequeo: temporizadores y esperas del estado. */
  serveStatus?: ServeStatusOptions;
}

/** Copia del entorno, sin quitar ni agregar: OpenCode no hereda ningun marcador que le estorbe. */
function copyEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createOpenCodeAdapter(options: OpenCodeAdapterOptions = {}): AgentAdapter {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const sqlite = options.sqlite ?? loadSqlite;
  const paths: OpenCodePaths = resolveOpenCodePaths(env, options.home ?? homedir(), platform);
  const db = new ReadOnlyDatabase(paths.dbFile ?? '', {
    idleCloseMs: OPENCODE_DB_IDLE_CLOSE_MS,
    required: OPENCODE_REQUIRED_COLUMNS,
    label: OPENCODE_LABEL,
    sqlite,
  });
  const signal = new DbChangeSignal(
    paths.dbFile === null || paths.walFile === null ? null : { db: paths.dbFile, wal: paths.walFile },
  );
  const catalog = new ModelCatalog(paths.modelsFile);
  const serveEnv = options.serveEnv ?? (() => copyEnvironment(process.env));

  /*
    El `serve` nace con el primer lanzamiento, con la ubicacion de la CLI que
    trae ese lanzamiento: el registro la localiza una sola vez al arrancar. Uno
    por adaptador, y por lo tanto uno por arranque de la app (D2).
  */
  let serve: OpenCodeServeProcess | null = null;
  // El padre de un sub-agente sale de la base, de a una fila (R29-1).
  const status = new OpenCodeServeStatus({ ...options.serveStatus, parentOf: (id) => readSessionParent(db, id) });
  /**
   * El cliente del `serve` que escucha ahora, casado por identidad con el
   * endpoint que devolvio `ensure()`: `status.detach` compara asi, y un aviso
   * tardio de un `serve` viejo no suelta al nuevo. null sin `serve`.
   */
  let current: { endpoint: ServeEndpoint; client: OpenCodeServeClient } | null = null;

  const serveFor = (location: CliLocation): OpenCodeServeProcess => {
    if (serve !== null) return serve;
    // La plataforma del proceso, no la de `options`: decide como se mata un proceso de verdad.
    const created = new OpenCodeServeProcess({ ...options.serveProcess, location, baseEnv: serveEnv });
    /*
      Un `serve` que muere sin que la app lo pidiera deja cada TUI enganchado a
      un puerto muerto, sin terminar (M2, medido): sus pestanas pasan a offline
      con el motivo, y la vista ofrece relanzarlas. Apagado por inactividad no
      queda ninguna pty, y en `dispose` el estado ya se solto.
    */
    created.onExit((endpoint, exit) => {
      status.detach(endpoint, exit.requested ? null : 'server-closed');
      if (current?.endpoint === endpoint) current = null;
    });
    serve = created;
    return created;
  };

  const clientFor = (endpoint: ServeEndpoint): OpenCodeServeClient => {
    if (current?.endpoint === endpoint) return current.client;
    current = { endpoint, client: new OpenCodeServeClient(endpoint, undefined, options.serveClient) };
    return current.client;
  };

  const questions = new OpenCodeQuestions({
    lookupCall: (partId, sessionId) => readPartCall(db, partId, sessionId),
    client: () => current?.client ?? null,
  });

  return {
    id: 'opencode',
    label: OPENCODE_LABEL,
    command: OPENCODE_COMMAND,
    installUrl: OPENCODE_INSTALL_URL,
    capabilities: OPENCODE_CAPABILITIES,
    input: OPENCODE_INPUT,

    // `--version` es seguro: medido, no toca la base ni escribe log.
    locate: () => locateCommand(OPENCODE_COMMAND),

    missingMessage: () => commandNotFoundMessage(OPENCODE_COMMAND, OPENCODE_INSTALL_URL),

    /**
     * `attach <url> --dir . --session <id> --password <hex>` (D5), con la
     * sesion nueva creada por API (D6). No es `async` (M1b): un id de
     * reanudacion invalido lanza aca mismo, sin tocar el `serve`, porque detras
     * de `cmd.exe /c` un `&` se ejecuta. Lo que falla despues —el `serve` que no
     * arranca, la sesion que no se crea— rechaza, y el registro lo muestra como
     * `spawn-failed` con el motivo (D1). `proposedSessionId` no se usa: el id lo
     * pone OpenCode.
     */
    launch(input: LaunchInput): Promise<LaunchPlan> {
      return launchWithServe(
        {
          ensure: () => serveFor(input.location).ensure(),
          createSession: (endpoint, directory) => clientFor(endpoint).createSession(directory),
          track: (endpoint, sessionId, directory) => status.track(sessionId, directory, clientFor(endpoint)),
        },
        input,
      );
    },

    /** Copia del entorno, sin quitar nada: OpenCode no hereda ningun marcador que le estorbe. */
    environment(base) {
      return { env: copyEnvironment(base), notice: null };
    },

    /*
      Toda pestana lanzada, nueva o reanudada, retiene el `serve` mientras viva
      su pty, y al cerrarse corta la sesion si quedo trabajando o esperando
      (D13): con `attach`, el trabajo seguiria en el `serve` sin ningun TUI que
      lo muestre. El corte va al cliente vigente: el de un `serve` que ya murio
      no esta, y su estado ya es null.
    */
    onSpawned(context: SpawnedContext): LaunchHook | null {
      if (context.sessionId.length === 0) return null;
      const { sessionId, cwd } = context;
      return createServeLaunchHook({
        sessionId,
        cwd,
        release: serve?.retain() ?? (() => {}),
        current: () => status.current(sessionId),
        abort: (directory, id) => current?.client.abort(directory, id) ?? Promise.resolve(),
      });
    },

    history: createOpenCodeHistory({
      dbFile: paths.dbFile,
      db,
      signal,
      catalog,
      platform,
      sqlite,
    }),
    status,
    questions,

    /**
     * La base que se lee, para el arranque. Solo si hay algo que decir, para que
     * quien no usa OpenCode no vea una linea nueva:
     *
     *  - con la base en memoria (`OPENCODE_DB=:memory:`, que alguien puso a
     *    proposito), que no hay nada que leer;
     *  - sin `node:sqlite`, el aviso de la version de Node, si hay una base que
     *    no se va a ver o la CLI esta instalada;
     *  - con la base en disco, su ruta.
     *
     * Con la base ausente no dice nada: `status()` es perezoso y no sabe si
     * existe hasta la primera consulta, asi que se mira el archivo.
     */
    startupHistoryNote(cliAvailable: boolean): string | null {
      if (env['OPENCODE_DB'] === ':memory:') return 'en memoria (no hay nada que leer)';
      if (paths.dbFile === null) return null;
      const present = existsSync(paths.dbFile);
      if ('unavailable' in sqlite()) return present || cliAvailable ? `no se lee: ${sqliteUnavailableText(OPENCODE_LABEL)}` : null;
      return present ? `${paths.dbFile} (solo lectura)` : null;
    },

    // `opencode.json` no se abre (regla 2.1).
    defaults: () => Promise.resolve(null),

    /**
     * Las cuatro carpetas de OpenCode: datos (la base, `auth.json`),
     * configuracion, cache y estado. No se listan ni se entran (regla 2.1). La
     * carpeta de un `OPENCODE_DB` propio no: puede ser la de un proyecto.
     */
    protectedDirs: () => [paths.dataDir, paths.configDir, paths.cacheDir, paths.stateDir],

    /**
     * Suelta el estado (sus oyentes reciben null y el flujo se cierra) antes de
     * matar el `serve`: los ganchos de las pestanas, que se cancelan despues en
     * el apagado, ya no piden ningun corte (M7). La promesa espera a que el
     * proceso salga; la orden de matarlo sale antes de devolver.
     */
    dispose: (): Promise<void> => {
      status.dispose();
      current = null;
      signal.dispose();
      db.close();
      return serve?.dispose() ?? Promise.resolve();
    },
  };
}
