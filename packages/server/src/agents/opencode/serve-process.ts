/**
 * El proceso `opencode serve` (hito 29, D1 a D4, M6).
 *
 * Uno solo por arranque de la app, y perezoso: nace con la primera pestana de
 * OpenCode y se apaga a los 5 minutos sin ninguna pty de OpenCode viva, o al
 * apagar la app. Corre en una carpeta vacia propia: una peticion sin
 * `directory` operaria sobre la carpeta del proceso, y ahi no hay nada.
 *
 * Cuatro cosas que no son evidentes:
 *
 *  - **Las banderas de red van explicitas** (`--hostname 127.0.0.1 --port 0
 *    --mdns=false`). Segun el binario de la 1.18.30, `server.hostname`,
 *    `server.port` y `server.mdns` de la configuracion **global** del usuario
 *    pisan los valores por defecto, y `mdns` sin hostname escucha en
 *    `0.0.0.0`; solo una bandera presente gana. La configuracion no se abre
 *    (regla 2.1), asi que se neutraliza asi. Y la linea de escucha se exige con
 *    `127.0.0.1`: si dice otra cosa, se mata el proceso.
 *  - **La contrasena va solo al entorno de este proceso.** Es la excepcion
 *    declarada a "nunca se agrega una variable" (D3): el `serve` no es una
 *    pestana ni una credencial de ninguna cuenta, y `serve` no tiene bandera de
 *    contrasena. Nunca se loguea: todo texto del proceso que se cita en un
 *    error pasa por `redact`.
 *  - **Sin consola compartida** (M6). El hijo compartiria la consola de
 *    `pnpm start`, y un Ctrl+C le llegaria a `cmd.exe` mientras corre el shim
 *    `.cmd`, que puede quedarse en "¿Desea terminar el trabajo por lotes?" sin
 *    morir. Sin ventana, sin stdin y sin stdio heredado —en Windows eso es una
 *    consola propia y oculta; fuera, `detached`—: solo `dispose()` lo termina.
 *    En Windows **no** va `detached`: sin consola, la linea de escucha no
 *    llega al pipe (medido en la prueba en vivo del hito 29).
 *  - **En Windows se mata el arbol** (`taskkill /T /F`): el shim deja
 *    `opencode.exe` como hijo de `cmd.exe`, y matar solo el `cmd` lo dejaria
 *    huerfano, escuchando.
 */

import { execFile, spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { debugLog } from '../../debug.js';
import type { CliLocation } from '../locate.js';

/** El unico host aceptado, en las banderas y en la linea de escucha. */
export const OPENCODE_SERVE_HOST = '127.0.0.1';

/** Cuanto se espera la linea de escucha antes de dar el arranque por fallido. */
export const OPENCODE_SERVE_START_TIMEOUT_MS = 20_000;

/** Sin ninguna pty de OpenCode viva durante este tiempo, el `serve` se apaga (D2). */
export const OPENCODE_SERVE_IDLE_STOP_MS = 300_000;

/** Usuario del basic auth si el entorno no trae `OPENCODE_SERVER_USERNAME`. */
export const OPENCODE_SERVE_DEFAULT_USERNAME = 'opencode';

/** Cuanto del final de la salida del proceso se guarda para explicar un arranque fallido. */
const OUTPUT_TAIL_CHARS = 2_000;

/** Cuanto se espera a que el proceso muera despues de matarlo. */
const EXIT_WAIT_MS = 5_000;

/** Como termino un `serve` que ya escuchaba. */
export interface ServeExit {
  /**
   * true si lo mato la app: el apagado por inactividad, `dispose()`. false si
   * murio solo o lo mato otro —un `taskkill`, un fallo—: sus pestanas quedan
   * enganchadas a un puerto muerto (M2).
   */
  requested: boolean;
}

export interface ServeEndpoint {
  /** `http://127.0.0.1:<puerto>`, verificado. */
  url: string;
  username: string;
  password: string;
}

/** Temporizadores, inyectables para el chequeo. */
export interface ServeTimers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const REAL_TIMERS: ServeTimers = {
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // Un temporizador de fondo no mantiene vivo el proceso al apagarse.
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface ServeProcessOptions {
  location: CliLocation;
  /** El entorno compuesto del registro; aca se le agrega solo la contrasena. */
  baseEnv: () => Record<string, string>;
  /** Para el chequeo. */
  spawn?: typeof nodeSpawn;
  startTimeoutMs?: number;
  idleStopMs?: number;
  platform?: NodeJS.Platform;
  /** La carpeta vacia donde corre. Por defecto `<tmp>/agent-workbench/opencode-serve`. */
  cwd?: string;
  timers?: ServeTimers;
}

/**
 * Los argumentos del `serve`, con el prefijo del shim delante. Sin la
 * contrasena: esa va por el entorno.
 */
export function serveArgs(location: CliLocation): string[] {
  return [...location.prefixArgs, 'serve', '--hostname', OPENCODE_SERVE_HOST, '--port', '0', '--mdns=false'];
}

const LISTENING_LINE = /opencode server listening on (https?):\/\/([^\s/:]+|\[[^\]\s]+\]):(\d{1,5})\b/;

/** Esquema, host y puerto de la linea de escucha, sea el host que sea; null si la linea no es esa. */
function matchListeningLine(line: string): { scheme: string; host: string; port: number } | null {
  // `match` y no el metodo `exec` de la expresion: el caso 2 de check-opencode-db lo toma por SQL fuera de `sql.ts`.
  const match = line.match(LISTENING_LINE);
  if (match === null) return null;
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return { scheme: match[1] ?? '', host: match[2] ?? '', port };
}

/**
 * La URL de la linea `opencode server listening on http://127.0.0.1:<puerto>`.
 * null si el host es otro (`0.0.0.0`, `localhost`), o si la linea no es esa.
 */
export function parseListeningLine(line: string): string | null {
  const found = matchListeningLine(line);
  if (found === null || found.scheme !== 'http' || found.host !== OPENCODE_SERVE_HOST) return null;
  return `http://${OPENCODE_SERVE_HOST}:${found.port}`;
}

/** Donde corre por defecto: una carpeta propia, vacia. */
export function defaultServeCwd(): string {
  return path.join(tmpdir(), 'agent-workbench', 'opencode-serve');
}

/** Un arranque que fallo, con un texto que ya no trae la contrasena. */
export class ServeStartError extends Error {}

interface Running {
  child: ChildProcess;
  /** null hasta la linea de escucha. */
  endpoint: ServeEndpoint | null;
  /** Resuelve cuando el proceso sale y sus pipes se cierran. */
  exited: Promise<void>;
  /** El final de su salida, para explicar un arranque fallido. Sin redactar. */
  tail: string;
  /** true desde que la app pidio matarlo: su salida no es una sorpresa. */
  stopRequested: boolean;
}

export class OpenCodeServeProcess {
  private readonly password = randomBytes(24).toString('hex');
  private readonly spawn: typeof nodeSpawn;
  private readonly timers: ServeTimers;
  private readonly platform: NodeJS.Platform;
  private readonly startTimeoutMs: number;
  private readonly idleStopMs: number;
  private readonly cwd: string;
  /** El proceso vigente: el que se esta arrancando o el que escucha. */
  private running: Running | null = null;
  private starting: Promise<ServeEndpoint> | null = null;
  private retained = 0;
  private idleTimer: unknown = null;
  private disposed = false;
  /** Muertes en curso: `dispose()` las espera para no dejar huerfanos. */
  private readonly kills = new Set<Promise<void>>();
  private readonly exitListeners = new Set<(endpoint: ServeEndpoint, exit: ServeExit) => void>();

  constructor(private readonly options: ServeProcessOptions) {
    this.spawn = options.spawn ?? nodeSpawn;
    this.timers = options.timers ?? REAL_TIMERS;
    this.platform = options.platform ?? process.platform;
    this.startTimeoutMs = options.startTimeoutMs ?? OPENCODE_SERVE_START_TIMEOUT_MS;
    this.idleStopMs = options.idleStopMs ?? OPENCODE_SERVE_IDLE_STOP_MS;
    this.cwd = options.cwd ?? defaultServeCwd();
  }

  /**
   * Arranca si no esta; una sola vez aunque lo pidan varias pestanas a la vez.
   *
   * **Con el `serve` ya andando y sin ptys, vuelve a contar el apagado desde
   * cero** (R29-2). Quien pide el endpoint va a lanzar una pestana, y la retiene
   * recien en `onSpawned`, despues de crear la sesion por HTTP y la pty: con el
   * plazo a punto de vencer, el `serve` moria en el medio y la pestana nacia
   * contra un puerto muerto. Con el plazo entero por delante no hay carrera —la
   * sesion tiene 5 s de tope—, y si el lanzamiento nunca retiene, el `serve` se
   * apaga igual al cumplirse.
   */
  ensure(): Promise<ServeEndpoint> {
    if (this.disposed) return Promise.reject(new ServeStartError('the app is shutting down'));
    const endpoint = this.running?.endpoint ?? null;
    if (endpoint !== null) {
      this.scheduleIdleStop();
      return Promise.resolve(endpoint);
    }
    if (this.starting !== null) return this.starting;
    const starting = this.start().finally(() => {
      if (this.starting === starting) this.starting = null;
    });
    this.starting = starting;
    return starting;
  }

  /**
   * Una pty de OpenCode empezo: mientras haya alguna, el `serve` no se apaga
   * solo. Devuelve con que soltarla, que vale una sola vez y no hace nada
   * despues de `dispose()` (M7).
   */
  retain(): () => void {
    if (this.disposed) return () => {};
    this.retained++;
    this.cancelIdleStop();
    let released = false;
    return () => {
      if (released || this.disposed) return;
      released = true;
      this.retained = Math.max(0, this.retained - 1);
      this.scheduleIdleStop();
    };
  }

  /**
   * Un proceso que ya escuchaba termino: lo mato la app (inactividad,
   * `dispose`) o murio solo, y `exit.requested` dice cual. Recibe el endpoint
   * que dejo de valer: si ya hay otro proceso, quien lo usa sabe que el aviso no
   * es del suyo.
   */
  onExit(listener: (endpoint: ServeEndpoint, exit: ServeExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Termina el proceso y espera a que salga. En Windows, el arbol entero. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelIdleStop();
    this.stop();
    await Promise.all([...this.kills]);
  }

  private async start(): Promise<ServeEndpoint> {
    await mkdir(this.cwd, { recursive: true });
    if (this.disposed) throw new ServeStartError('the app is shutting down');

    const env = this.environment();
    const username = env['OPENCODE_SERVER_USERNAME'] || OPENCODE_SERVE_DEFAULT_USERNAME;
    const args = serveArgs(this.options.location);
    // Sin argumentos en el log (A4): la regla es la misma para todo log nuevo, aunque estos no traigan la contrasena.
    debugLog('opencode-serve', 'launching serve');

    let child: ChildProcess;
    try {
      child = this.spawn(this.options.location.file, args, {
        cwd: this.cwd,
        env,
        /*
          `detached` solo fuera de Windows, donde lo hace lider de su grupo para
          matarlo entero. En Windows es `DETACHED_PROCESS`: el hijo nace sin
          consola y, medido con la 1.18.30, el `serve` escucha pero su linea
          de escucha no llega nunca al pipe —la pestana no se abria—. Sin
          `detached`, `windowsHide` con ningun stdio heredado ya lo lanza con
          `CREATE_NO_WINDOW`: una consola propia y oculta, asi que el Ctrl+C
          de la consola de `pnpm start` tampoco le llega (M6).
        */
        detached: this.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw new ServeStartError(this.redact(error instanceof Error ? error.message : String(error)));
    }

    const running: Running = {
      child,
      endpoint: null,
      exited: new Promise<void>((resolve) => {
        /*
          `close` y no `exit`: llega cuando ademas se cerraron sus pipes, o sea
          cuando lo que escribio al salir ya se leyo, y cuando ningun hijo del
          shim sigue con ellos abiertos —el que escucha es `opencode.exe`, no
          el `cmd.exe` que lo lanzo—.
        */
        child.once('close', () => resolve());
        // Un proceso que ni arranco (`ENOENT`) no emite `exit`.
        child.once('error', () => {
          if (child.pid === undefined) resolve();
        });
      }),
      tail: '',
      stopRequested: false,
    };
    this.running = running;

    return new Promise<ServeEndpoint>((resolve, reject) => {
      let settled = false;
      const fail = (reason: string): void => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        this.killRunning(running);
        reject(new ServeStartError(this.redact(reason)));
      };
      const timer = this.timers.setTimeout(
        () => {
          const ms = this.startTimeoutMs;
          fail(`didn't say which port it listens on within ${ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`}`);
        },
        this.startTimeoutMs,
      );

      const onLine = (line: string): void => {
        if (settled) return;
        const url = parseListeningLine(line);
        if (url !== null) {
          settled = true;
          this.timers.clearTimeout(timer);
          running.endpoint = { url, username, password: this.password };
          debugLog('opencode-serve', `listening on ${url}`);
          this.scheduleIdleStop();
          resolve(running.endpoint);
          return;
        }
        const other = matchListeningLine(line);
        if (other !== null) fail(`listens on ${other.scheme}://${other.host} and not on http://${OPENCODE_SERVE_HOST}`);
      };

      const read = (stream: NodeJS.ReadableStream | null): void => {
        if (stream === null) return;
        stream.setEncoding('utf8');
        let partial = '';
        // Se lee siempre, tambien despues de arrancar: un pipe que nadie vacia frena al proceso cuando se llena.
        stream.on('data', (chunk: string) => {
          running.tail = (running.tail + chunk).slice(-OUTPUT_TAIL_CHARS);
          const lines = (partial + chunk).split(/\r?\n/);
          partial = (lines.pop() ?? '').slice(-OUTPUT_TAIL_CHARS);
          for (const line of lines) onLine(line);
        });
      };
      read(child.stdout);
      read(child.stderr);

      child.once('error', (error) => fail(error.message));
      child.once('close', (code, signal) => {
        if (this.running === running) this.running = null;
        const how = signal ?? `code ${code ?? '?'}`;
        if (!settled) {
          const tail = running.tail.trim();
          fail(`exited before listening (${how})${tail.length > 0 ? `: ${tail}` : ''}`);
          return;
        }
        const endpoint = running.endpoint;
        if (endpoint === null) return;
        const exit: ServeExit = { requested: running.stopRequested };
        debugLog('opencode-serve', `exited (${how}${exit.requested ? '' : ', without the app asking'})`);
        if (this.running === null) this.cancelIdleStop();
        for (const listener of [...this.exitListeners]) {
          try {
            listener(endpoint, exit);
          } catch {
            // Un oyente que falla no deja sin aviso a los demas.
          }
        }
      });
    });
  }

  /** El entorno del hijo: el del registro, y la contrasena. En Windows las claves no distinguen mayusculas. */
  private environment(): Record<string, string> {
    const env = { ...this.options.baseEnv() };
    if (this.platform === 'win32') {
      for (const key of Object.keys(env)) {
        if (key !== 'OPENCODE_SERVER_PASSWORD' && key.toUpperCase() === 'OPENCODE_SERVER_PASSWORD') delete env[key];
      }
    }
    env['OPENCODE_SERVER_PASSWORD'] = this.password;
    return env;
  }

  private redact(text: string): string {
    return text.split(this.password).join('***');
  }

  private scheduleIdleStop(): void {
    this.cancelIdleStop();
    if (this.disposed || this.retained > 0 || this.running?.endpoint == null) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = null;
      if (this.retained > 0 || this.disposed) return;
      debugLog('opencode-serve', 'no OpenCode tabs: shutting down');
      this.stop();
    }, this.idleStopMs);
  }

  private cancelIdleStop(): void {
    if (this.idleTimer === null) return;
    this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  /** Suelta el proceso vigente y lo mata. Un `ensure` posterior arranca otro. */
  private stop(): void {
    const running = this.running;
    if (running === null) return;
    this.killRunning(running);
  }

  private killRunning(running: Running): void {
    running.stopRequested = true;
    if (this.running === running) this.running = null;
    const kill = this.kill(running).finally(() => this.kills.delete(kill));
    this.kills.add(kill);
  }

  private async kill(running: Running): Promise<void> {
    const { child } = running;
    if (child.exitCode === null && child.signalCode === null && child.pid !== undefined) {
      const pid = child.pid;
      if (this.platform === 'win32') {
        await new Promise<void>((resolve) => {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
        });
      } else {
        try {
          // `detached` lo hace lider de su grupo: se termina el grupo entero.
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    }
    let waited: unknown = null;
    await Promise.race([
      running.exited,
      new Promise<void>((resolve) => {
        waited = REAL_TIMERS.setTimeout(resolve, EXIT_WAIT_MS);
      }),
    ]);
    if (waited !== null) REAL_TIMERS.clearTimeout(waited);
  }
}
