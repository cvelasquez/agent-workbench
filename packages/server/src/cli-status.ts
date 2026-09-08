/**
 * Que esta haciendo la CLI ahora mismo, leido de un archivo.
 *
 * La CLI mantiene `~/.claude/sessions/<pid>.json` por proceso vivo y lo
 * reescribe cuando cambia de estado. Medido con una pty propia contra la
 * 2.1.261, mirando el archivo cada 400 ms:
 *
 * ```
 * [ 9.0s] 59668.json {"status":"busy"}
 * [12.3s] 59668.json {"status":"waiting","waitingFor":"permission prompt"}   <- Write en modo manual
 * ```
 * ```
 * [ 2.9s] 54900.json {"status":"idle"}
 * [ 3.3s] 54900.json {"status":"waiting","waitingFor":"dialog open"}         <- --resume, dialogo de reanudar
 * ```
 *
 * **Por que importa.** Es lo unico del sistema de archivos que dice que la CLI
 * esta esperando una respuesta. El JSONL no lo dice: mientras un permiso esta
 * pendiente, el archivo de sesion tiene el `tool_use` y nada mas —ni la
 * pregunta, ni las opciones, ni una marca de que hay algo esperando— y el
 * unico rastro que queda es el resultado, y solo si se deniega. La alternativa
 * seria leer la pantalla de la terminal, que es la heuristica sobre texto con
 * secuencias de escape que el proyecto ya descarto dos veces (CLAUDE.md 5.5.1
 * y el punto de aviso de la solapa CLI, §6).
 *
 * **Lo que NO trae, y por eso no hay botones de Allow/Deny en la
 * conversacion:** el contenido. Dice *que* espera y *de que clase*, nunca que
 * herramienta pidio permiso ni con que opciones.
 *
 * **Se busca por `sessionId`, no por pid.** El archivo lo trae, y el pid de la
 * pty no siempre es el de la CLI: cuando el binario resuelve a un shim `.cmd`
 * se lanza via `cmd.exe /c` (CLAUDE.md 3.1) y el pid seria el del `cmd`.
 *
 * Se sondea en vez de mirar el directorio con un watcher: son dos o tres
 * archivos de medio KB, y lo que hace falta es el **contenido**, no el aviso de
 * que algo cambio. El sondeo solo corre mientras alguien esta suscrito.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cliSessionsStateRoot } from './paths.js';

/**
 * Cada cuanto se releen los archivos.
 *
 * 700 ms: el diálogo de reanudar aparece a los ~3 s de lanzar y el usuario
 * espera igual a que la CLI arranque, asi que llegar medio segundo tarde no se
 * nota. Bajarlo no compra nada y lee el disco mas seguido.
 */
const POLL_INTERVAL_MS = 700;

/**
 * Estado de un proceso de la CLI.
 *
 * `status` sale tal cual del archivo. Los valores vistos son `idle`, `busy`,
 * `waiting` y `shell`; se guarda como string y no como union cerrada porque
 * una version futura puede agregar uno y eso no tiene que romper nada — la
 * unica pregunta que se le hace es si vale `waiting`.
 */
export interface CliSessionStatus {
  status: string;
  /**
   * Que espera, cuando `status` es `waiting`.
   *
   * Etiquetas vistas en el binario de la 2.1.261: `permission prompt`,
   * `input needed`, `worker request`, `sandbox request`, `dialog open`.
   * null cuando el archivo no la trae.
   */
  waitingFor: string | null;
  /** Epoch ms de la ultima vez que la CLI toco el estado, si lo dice. */
  statusUpdatedAt: number | null;
}

export type CliStatusListener = (status: CliSessionStatus | null) => void;

interface Subscription {
  sessionId: string;
  listener: CliStatusListener;
  /** Lo ultimo que se le entrego, para no repetir. */
  last: string | null;
}

function readStatus(value: unknown): CliSessionStatus | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const status = record['status'];
  if (typeof status !== 'string' || status.length === 0) return null;

  const waitingFor = record['waitingFor'];
  const updatedAt = record['statusUpdatedAt'];

  return {
    status,
    waitingFor: typeof waitingFor === 'string' && waitingFor.length > 0 ? waitingFor : null,
    statusUpdatedAt:
      typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
  };
}

/**
 * Sondeo compartido de `~/.claude/sessions/`.
 *
 * Uno solo para todas las pestanas: el costo esta en listar el directorio y
 * leer los archivos, y eso no crece con la cantidad de suscriptores.
 */
export class CliStatusWatcher {
  private readonly subscriptions = new Set<Subscription>();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  /**
   * Avisa cuando cambia el estado de esa sesion.
   *
   * El callback recibe null mientras no haya archivo: es lo normal entre que se
   * lanza la pty y la CLI se registra, y tambien despues de que el proceso
   * termina.
   */
  subscribe(sessionId: string, listener: CliStatusListener): () => void {
    const subscription: Subscription = { sessionId, listener, last: null };
    this.subscriptions.add(subscription);
    this.start();
    // Una primera lectura inmediata: sin esto, quien se suscribe a una pestana
    // que ya estaba esperando no se entera hasta el proximo tick.
    void this.poll();
    return () => {
      this.subscriptions.delete(subscription);
      if (this.subscriptions.size === 0) this.stop();
    };
  }

  /** Estado de una sesion ahora mismo, sin suscribirse. */
  async read(sessionId: string): Promise<CliSessionStatus | null> {
    const found = await this.readAll();
    return found.get(sessionId) ?? null;
  }

  /**
   * Espera a que la CLI este lista para recibir un mensaje.
   *
   * "Lista" es `status: "idle"`, y eso cubre dos cosas de una: que la TUI ya
   * arranco, y que **no** esta parada en un dialogo. Lo segundo importa mas de
   * lo que parece — medido, la CLI no se registra en `sessions/` hasta despues
   * de que se acepta el dialogo de confianza en la carpeta, asi que esperar a
   * que aparezca ya descarta el caso en el que un pegado terminaria contestando
   * ese menu.
   *
   * Devuelve false si se acabo el plazo. Quien llama no escribe nada entonces:
   * mandarle un pegado a una pty que no sabemos en que estado esta es
   * exactamente lo que evita todo esto.
   */
  async waitUntilIdle(sessionId: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.read(sessionId);
      if (status !== null && status.status === 'idle') return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  dispose(): void {
    this.subscriptions.clear();
    this.stop();
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
    // Que un sondeo de fondo no mantenga vivo el proceso al apagarse.
    this.timer.unref();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Todos los estados, indexados por `sessionId`.
   *
   * Un archivo ilegible —o a medio escribir, que pasa porque la CLI lo
   * reescribe entero— se saltea sin ruido: el proximo sondeo lo agarra bien.
   */
  private async readAll(): Promise<Map<string, CliSessionStatus>> {
    const found = new Map<string, CliSessionStatus>();
    const root = cliSessionsStateRoot();

    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return found;
    }

    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path.join(root, name), 'utf8'));
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const sessionId = (parsed as Record<string, unknown>)['sessionId'];
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue;
      const status = readStatus(parsed);
      if (status !== null) found.set(sessionId, status);
    }

    return found;
  }

  private async poll(): Promise<void> {
    // Sin reentrada: en un disco lento dos lecturas encimadas entregarian los
    // cambios en desorden.
    if (this.reading || this.subscriptions.size === 0) return;
    this.reading = true;
    try {
      const found = await this.readAll();
      for (const subscription of this.subscriptions) {
        const status = found.get(subscription.sessionId) ?? null;
        const key = status === null ? null : `${status.status}|${status.waitingFor ?? ''}`;
        if (key === subscription.last) continue;
        subscription.last = key;
        subscription.listener(status);
      }
    } finally {
      this.reading = false;
    }
  }
}
