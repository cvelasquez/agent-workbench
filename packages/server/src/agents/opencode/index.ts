/**
 * El adaptador de la CLI de OpenCode.
 *
 * Todo lo que el servidor sabe de esta CLI en un solo objeto, como los de
 * Claude Code y Codex. Cuatro diferencias que ordenan el resto:
 *
 *  - **El historial es una base SQLite compartida**, no un archivo por sesion.
 *    Se abre en solo lectura con `node:sqlite` (`agents/sqlite.ts`), nunca se
 *    escribe, y de ella se leen solo `session`, `message` y `part`
 *    (`sql.ts`). Ningun subcomando de `opencode` se corre salvo `--version`: con
 *    la base real, uno cualquiera la modifica (hace un checkpoint al abrirla).
 *  - **El id de sesion lo pone OpenCode** (`ses_...`): una pestana nueva nace sin
 *    id y la sesion se descubre despues.
 *  - **No publica su estado.** Nada en disco dice si trabaja, espera o esta
 *    libre; eso vive en el servidor HTTP de `opencode serve`, que no se usa.
 *  - **Su configuracion no se abre.** `opencode.json` puede traer claves de
 *    proveedores y el entorno de los MCP (regla 2.1): sin modelo por defecto
 *    que mostrar.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type { AgentCapabilities } from '@agent-workbench/shared';
import type { AgentAdapter, AgentInput, LaunchHook, LaunchInput, LaunchPlan, SpawnedContext } from '../adapter.js';
import { commandNotFoundMessage, locateCommand } from '../locate.js';
import { loadSqlite, ReadOnlyDatabase, sqliteUnavailableText, type SqliteLoad } from '../sqlite.js';
import { ModelCatalog } from './catalog.js';
import { DbChangeSignal } from './db-signal.js';
import { OpenCodeSessionDiscovery } from './discovery.js';
import { createOpenCodeHistory } from './history.js';
import { resolveOpenCodePaths, type OpenCodePaths } from './paths.js';
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

/**
 * Los ids de sesion que acepta `-s`. Medido: los 295 ids de la base de esta
 * maquina son `ses_` y 26 alfanumericos, 0 con otro caracter.
 *
 * No es un adorno: `opencode` resuelve al shim `.cmd` y se lanza detras de
 * `cmd.exe /c`, y node-pty solo pone comillas a los argumentos con espacios. Un
 * id `ses_x&<comando>` —del cliente, o de un `workspace.json` tocado— lo
 * ejecutaria `cmd`.
 */
export const OPENCODE_SESSION_ID_PATTERN = /^ses_[0-9A-Za-z]{20,40}$/;

/**
 * Lo que la interfaz dibuja para esta CLI. `check-opencode-db.mjs` lo compara
 * contra un literal: una capacidad que se prende sin medirla promete algo que
 * la CLI no hace.
 */
export const OPENCODE_CAPABILITIES: AgentCapabilities = {
  // El TUI no acepta un id: fijarlo exige `serve` + `attach`.
  sessionIdAtLaunch: false,
  // `-s <id>`, en `--help`.
  resume: true,
  // Nada en disco dice si trabaja, espera o esta libre.
  statusSource: false,
  // Sin estado no hay "lista": una nota no se manda sola.
  readySignal: false,
  // `Tab` cicla agentes (`build`, `plan`), no permisos.
  permissionCycle: null,
  // `/models` abre un selector y no acepta argumento.
  models: null,
  // La variante se cicla con `ctrl+t`, que el navegador se queda.
  efforts: null,
  // La pregunta esta en la base mientras espera, pero contestarla es escribir a ciegas en un menu sin medir.
  questionCards: false,
  /*
    Medido en vivo con la 1.18.30: una ruta de imagen pegada sola —sin
    comillas, aunque tenga espacios— se adjunta; el TUI muestra `[Image 1]` y
    el mensaje guarda una parte `file` con los bytes. Es la forma de Codex.
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
};

/**
 * Como se le escribe un mensaje: cada imagen en su propio pegado, con la ruta
 * sola; el texto en otro; el Enter aparte, con 400 ms entre pieza y pieza; y dos
 * Esc para interrumpir.
 *
 * Es la forma de Codex, y medida en vivo con la 1.18.30 en Windows: el texto
 * de cuatro lineas y 260 caracteres entra entero y se envia una vez; la ruta
 * pegada sola se adjunta; un solo Esc muestra "esc again to interrupt" y no
 * corta nada, el segundo interrumpe (`MessageAbortedError`).
 */
export const OPENCODE_INPUT: AgentInput = {
  imageReference: 'bare-path-paste',
  pieceGapMs: 400,
  pasteMarkers: true,
  enterSeparately: true,
  interruptPresses: 2,
};

export interface OpenCodeAdapterOptions {
  /** Para el chequeo. Por defecto, el entorno, el home y la plataforma del proceso. */
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  /** Para el chequeo: de donde sale `node:sqlite`. */
  sqlite?: () => SqliteLoad;
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
  // Uno por adaptador: un solo aviso de la base para todas las pestanas que esperan.
  const discovery = new OpenCodeSessionDiscovery({ db, signal, platform });

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
     * Sin argumentos para una sesion nueva, `-s <id>` para una del historial.
     * `proposedSessionId` no se usa: el id lo pone OpenCode. Sin `-m`, `--agent`
     * ni carpeta: el `cwd` de la pty alcanza, y un argumento con espacios detras
     * de `cmd.exe /c` rompe el lanzamiento entero (§3.1 de CLAUDE.md). Por lo
     * mismo el id se valida antes de tocar la linea de comando.
     */
    launch(input: LaunchInput): LaunchPlan {
      const { resumeSessionId } = input;
      if (resumeSessionId === null) {
        return { file: input.location.file, args: [...input.location.prefixArgs], session: { kind: 'discover' } };
      }
      if (!OPENCODE_SESSION_ID_PATTERN.test(resumeSessionId)) throw new Error('Id de sesion de OpenCode invalido.');
      return {
        file: input.location.file,
        args: [...input.location.prefixArgs, '-s', resumeSessionId],
        session: { kind: 'known', sessionId: resumeSessionId },
      };
    },

    /** Copia del entorno, sin quitar nada: OpenCode no hereda ningun marcador que le estorbe. */
    environment(base) {
      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(base)) {
        if (value !== undefined) env[key] = value;
      }
      return { env, notice: null };
    },

    /*
      Una reanudacion ya sabe su sesion. Una pestana nueva la descubre despues,
      cuando nace su fila en la base (`discovery.ts`). El gancho se devuelve tal
      cual: sin `onInput`, el registro lo soltaria con la primera tecla, que es
      justo cuando aparece la sesion.
    */
    onSpawned(context: SpawnedContext): LaunchHook | null {
      if (context.resumed) return null;
      return discovery.track(context);
    },

    history: createOpenCodeHistory({
      dbFile: paths.dbFile,
      db,
      signal,
      catalog,
      platform,
      sqlite,
    }),
    status: null,

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

    dispose: () => {
      discovery.dispose();
      signal.dispose();
      db.close();
    },
  };
}
