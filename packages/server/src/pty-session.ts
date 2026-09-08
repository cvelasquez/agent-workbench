/**
 * Una sesion = un proceso vivo dentro de su propia pty.
 *
 * Que proceso sea lo decide quien la construye: la CLI para una pestana, la
 * consola del sistema para el panel derecho. Aca abajo son lo mismo — un
 * ejecutable, unos argumentos y un tamano— y esa indiferencia es a proposito:
 * el manejo de ConPTY, el resize y el cierre no se escriben dos veces.
 *
 * REGLA DURA que se aplica aca abajo, en buildEnvironment():
 * el entorno se hereda del proceso padre y **no se le agrega nada**, mucho
 * menos algo de autenticacion. Nada de ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 * ni CLAUDE_CODE_OAUTH_TOKEN. Si el usuario no esta logueado, corre /login
 * dentro de la terminal y la app ni se entera.
 *
 * Lo unico que se quita es CLAUDE_CODE_CHILD_SESSION, que no es de auth y que
 * apaga el guardado del transcript. Esta explicado y justificado en
 * buildEnvironment().
 */

import { spawn, type IPty } from 'node-pty';

/** Cuanto esperamos a que el proceso ceda ante SIGTERM antes de matarlo. */
const GRACEFUL_KILL_TIMEOUT_MS = 3_000;

/**
 * Que lanzar, ya resuelto.
 *
 * Se pide resuelto y no como "el comando `claude`" porque quien lo resuelve
 * —`cli-locator`, `shell-locator`— es tambien quien sabe si hace falta pasar
 * por `cmd.exe` (el caso del shim `.cmd`). Aca no se adivina nada.
 */
export interface LaunchSpec {
  file: string;
  args: readonly string[];
}

export interface PtySessionOptions {
  launch: LaunchSpec;
  /** Directorio de trabajo del proceso. */
  cwd: string;
  cols: number;
  rows: number;
  onData: (chunk: string) => void;
  onExit: (exitCode: number, signal: number | null) => void;
}

/**
 * Marcador que la CLI deja en el entorno de los procesos que lanza.
 *
 * Si una CLI arranca y lo encuentra heredado, **apaga el guardado del
 * transcript**: `Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION
 * marker`. Sin JSONL no hay historial, ni vista de conversacion, ni medidor de
 * contexto, y `--resume` de esa pestana falla en el arranque siguiente.
 */
const CHILD_SESSION_MARKER = 'CLAUDE_CODE_CHILD_SESSION';

/**
 * true si el servidor arranco con el marcador puesto.
 *
 * Pasa cuando `pnpm dev` se lanza desde adentro de una sesion de la CLI. En uso
 * normal —PowerShell y `pnpm dev`— la variable no existe y esto es false.
 */
export const inheritedChildSessionMarker =
  process.env[CHILD_SESSION_MARKER] !== undefined;

/**
 * Copia del entorno del padre, con una unica excepcion.
 *
 * REGLA DURA que se respeta aca: no se agrega ni una sola variable de
 * autenticacion. Nada de ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ni
 * CLAUDE_CODE_OAUTH_TOKEN. Si el usuario no esta logueado, corre /login dentro
 * de la terminal y la app ni se entera.
 *
 * La excepcion es que se **quita** CLAUDE_CODE_CHILD_SESSION. Decidido con el
 * usuario (CLAUDE.md 4.10). El razonamiento: la regla prohibe agregar variables
 * de auth, y esta no es de auth ni se agrega. Una pestana de Agent Workbench no
 * es una sesion anidada dentro de otra conversacion: es una sesion de primer
 * nivel que abrio el usuario, y el marcador solo esta ahi por el accidente de
 * desde donde se lanzo el servidor. Quitarlo devuelve a la CLI su
 * comportamiento normal en vez de restringirlo.
 *
 * Lo que se paga: hoy el marcador solo controla el transcript, pero si una
 * version futura lo usa para otra cosa, quitarlo cambiaria algo que no
 * previmos. Por eso la UI lo avisa cuando pasa, en vez de hacerlo callado.
 * El resto de las variables CLAUDE_* se heredan intactas.
 */
function buildEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === CHILD_SESSION_MARKER) continue;
    environment[key] = value;
  }
  return environment;
}

export class PtySession {
  private readonly pty: IPty;
  private killTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  readonly cwd: string;

  constructor(private readonly options: PtySessionOptions) {
    this.cwd = options.cwd;

    this.pty = spawn(
      options.launch.file,
      [...options.launch.args],
      {
        // `name` declara las capacidades del terminal (TERM). Es lo que hace que
        // la CLI renderice color y no una configuracion de autenticacion.
        name: 'xterm-256color',
        cols: options.cols,
        rows: options.rows,
        cwd: options.cwd,
        env: buildEnvironment(),
        // En Windows node-pty usa ConPTY por defecto desde Windows 10.
        useConpty: process.platform === 'win32' ? true : undefined,
      },
    );

    this.pty.onData((chunk) => {
      if (!this.disposed) this.options.onData(chunk);
    });

    this.pty.onExit(({ exitCode, signal }) => {
      this.clearKillTimer();
      this.disposed = true;
      this.options.onExit(exitCode, signal ?? null);
    });
  }

  get pid(): number {
    return this.pty.pid;
  }

  /** Teclas del usuario, sin filtrar. */
  write(data: string): void {
    if (this.disposed) return;
    this.pty.write(data);
  }

  /**
   * Reenvia el tamano al pty. Sin esto la CLI redibuja sobre un ancho que no es
   * el real y la pantalla queda rota.
   */
  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.pty.resize(cols, rows);
    } catch {
      // El pty puede haber muerto entre el chequeo y la llamada. No es fatal.
    }
  }

  /**
   * Cierre limpio: SIGTERM y, si no cede, SIGKILL. En Windows, ninguna de las
   * dos cosas.
   *
   * OJO, esto ya rompio una vez y no de forma obvia. En Windows node-pty
   * **lanza** si se le pasa una senal a `kill()`, y ademas difiere la llamada
   * hasta que el pty emite su primer dato. Con lo cual pasaba una de dos:
   *
   *  - pty todavia sin datos: el throw sale diferido, desde adentro de un
   *    callback del socket de node-pty. Ahi no llega ningun try/catch nuestro,
   *    queda como excepcion no capturada y **se cae el servidor entero** —
   *    todas las demas pestanas con el.
   *  - pty ya andando: el throw es sincronico, lo agarra el catch... y el
   *    proceso nunca se mata. La pestana desaparece de la UI y la CLI queda
   *    dando vueltas como proceso huerfano.
   *
   * Sin senal no hay ninguno de los dos casos: ConPTY termina el proceso de una
   * y no hay escalada que hacer.
   */
  dispose(): void {
    if (this.disposed) return;

    if (process.platform === 'win32') {
      try {
        this.pty.kill();
      } catch {
        // Ya se habia ido por su cuenta.
        this.disposed = true;
      }
      return;
    }

    try {
      this.pty.kill('SIGTERM');
    } catch {
      this.disposed = true;
      return;
    }

    this.killTimer = setTimeout(() => {
      if (this.disposed) return;
      try {
        this.pty.kill('SIGKILL');
      } catch {
        // Ya se fue por su cuenta.
      }
    }, GRACEFUL_KILL_TIMEOUT_MS);

    // No mantengas vivo el proceso de Node solo por este temporizador.
    this.killTimer.unref();
  }

  private clearKillTimer(): void {
    if (this.killTimer !== null) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }
}
