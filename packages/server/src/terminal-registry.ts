/**
 * Registro de terminales vivas.
 *
 * REGLA DE ARQUITECTURA (CLAUDE.md 3.0): las pty viven aca, no en el
 * WebSocket. Un socket que se cae no mata nada; recargar el navegador tampoco.
 * Una terminal muere solo si la cierra el usuario, si el proceso termina, o si
 * se apaga el servidor.
 *
 * De eso salen dos cosas que este archivo implementa:
 *  - cada terminal guarda su salida reciente para repintar al reenganchar
 *  - los oyentes van y vienen; la terminal sigue igual
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import type { TerminalDescriptor, TerminalId, TerminalKind } from '@agent-workbench/shared';
import type { CliLocation } from './cli-locator.js';
import type { CliStatusWatcher } from './cli-status.js';
import { debugLog } from './debug.js';
import { OutputBuffer } from './output-buffer.js';
import { PtySession, type LaunchSpec } from './pty-session.js';
import { autoAnswerResumeDialog } from './resume-dialog.js';
import type { ShellLocation } from './shell-locator.js';
import { WorkspaceStore, type PersistedTab } from './workspace-store.js';

/** Tope defensivo: cada pestana es un proceso real. */
/**
 * Con que modo de permisos arranca cada pestana de agente.
 *
 * `auto` es una opcion de primera clase de la CLI (`--permission-mode`, junto a
 * `acceptEdits`, `manual`, `plan` y las demas) y es la que el usuario quiere en
 * toda conversacion nueva: sin ella, un pedido que ya nombra la herramienta
 * —"buscá esto en Jira"— se corta igual para preguntar si puede usar el MCP de
 * Atlassian.
 *
 * No choca con la regla 2.2: no se parchea ni se restringe nada. Se elige, al
 * lanzar, uno de los modos que la propia CLI expone; el usuario lo sigue
 * cambiando con `shift+tab` dentro de la sesion, y ese cambio manda sobre esto.
 */
const PERMISSION_MODE_ARGS: readonly string[] = ['--permission-mode', 'auto'];

const MAX_TERMINALS = 24;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type OutputListener = (terminalId: TerminalId, chunk: string) => void;

interface TerminalEntry {
  descriptor: TerminalDescriptor;
  session: PtySession;
  buffer: OutputBuffer;
  listeners: Set<OutputListener>;
  /**
   * Corta la espera del dialogo de reanudar, si esta pestana la tenia.
   *
   * Se llama en cuanto el usuario escribe algo el mismo o la pestana se
   * cierra: a partir de ahi el menu ya no esta como lo dejamos y un `2` cae en
   * cualquier lado. Ver `resume-dialog.ts`.
   */
  cancelResumeAnswer: (() => void) | null;
}

export interface OpenTerminalOptions {
  cwd: string;
  /** `agent` (la CLI) por omision. `shell` abre la consola del sistema. */
  kind?: TerminalKind;
  /** Si viene, se reanuda esa conversacion con `--resume`. Solo para `agent`. */
  resumeSessionId?: string;
  label?: string;
  cols?: number;
  rows?: number;
}

export class TerminalOpenError extends Error {
  constructor(
    readonly code:
      | 'cli-not-found'
      | 'shell-not-found'
      | 'invalid-cwd'
      | 'too-many-terminals'
      | 'spawn-failed',
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'TerminalOpenError';
  }
}

export interface TerminalRegistryEvents {
  output: (terminalId: TerminalId, chunk: string) => void;
  exit: (terminalId: TerminalId, exitCode: number, signal: number | null) => void;
  changed: () => void;
}

export declare interface TerminalRegistry {
  on<E extends keyof TerminalRegistryEvents>(
    event: E,
    listener: TerminalRegistryEvents[E],
  ): this;
  emit<E extends keyof TerminalRegistryEvents>(
    event: E,
    ...args: Parameters<TerminalRegistryEvents[E]>
  ): boolean;
}

export class TerminalRegistry extends EventEmitter {
  private readonly terminals = new Map<TerminalId, TerminalEntry>();
  private order: TerminalId[] = [];

  constructor(
    private readonly cli: CliLocation | null,
    private readonly shell: ShellLocation | null,
    private readonly store: WorkspaceStore,
    /**
     * Estado que la CLI publica por proceso. Lo usa el contestador del dialogo
     * de reanudar; sin el, esa espera no arranca y el dialogo queda para el
     * usuario, que es el comportamiento de antes.
     */
    private readonly cliStatus: CliStatusWatcher | null = null,
  ) {
    super();
  }

  list(): TerminalDescriptor[] {
    return this.order
      .map((id) => this.terminals.get(id)?.descriptor)
      .filter((descriptor): descriptor is TerminalDescriptor => descriptor !== undefined);
  }

  getOrder(): TerminalId[] {
    return [...this.order];
  }

  has(terminalId: TerminalId): boolean {
    return this.terminals.has(terminalId);
  }

  /** Descriptor de una pestana, o null si ya no existe. */
  get(terminalId: TerminalId): TerminalDescriptor | null {
    return this.terminals.get(terminalId)?.descriptor ?? null;
  }

  /**
   * Que ejecutable corresponde a cada tipo, ya comprobado.
   *
   * Devuelve una union discriminada y no dos campos opcionales: asi el sitio
   * que arma el `LaunchSpec` no puede olvidarse de comprobar el null, porque el
   * tipo no se lo permite.
   */
  private launcherFor(
    kind: TerminalKind,
  ): { kind: 'agent'; cli: CliLocation } | { kind: 'shell'; shell: ShellLocation } {
    if (kind === 'agent') {
      if (this.cli === null) {
        throw new TerminalOpenError(
          'cli-not-found',
          'La CLI no esta instalada o no se encontro en el PATH.',
        );
      }
      return { kind: 'agent', cli: this.cli };
    }
    if (this.shell === null) {
      throw new TerminalOpenError(
        'shell-not-found',
        'No se encontro ninguna consola del sistema para abrir.',
      );
    }
    return { kind: 'shell', shell: this.shell };
  }

  /**
   * Abre una pestana o una consola.
   *
   * Sin `resumeSessionId` generamos el UUID nosotros y lo pasamos con
   * `--session-id`: asi sabemos de antemano que archivo JSONL va a escribir la
   * CLI, y el Hito 3 no tiene que adivinarlo mirando el directorio.
   *
   * Una consola (`kind: 'shell'`) no lleva nada de eso: no escribe historial,
   * su `sessionId` queda vacio y no se guarda entre arranques.
   */
  async open(options: OpenTerminalOptions): Promise<TerminalDescriptor> {
    const kind: TerminalKind = options.kind ?? 'agent';
    // Se resuelve que se va a lanzar antes que nada: asi el error que ve el
    // usuario es "falta la CLI" o "falta la consola" y no uno de mas adelante.
    const launcher = this.launcherFor(kind);

    if (this.terminals.size >= MAX_TERMINALS) {
      throw new TerminalOpenError(
        'too-many-terminals',
        `No se pueden abrir mas de ${MAX_TERMINALS} pestanas a la vez.`,
      );
    }

    let info;
    try {
      info = await stat(options.cwd);
    } catch {
      throw new TerminalOpenError('invalid-cwd', `El directorio no existe: ${options.cwd}`);
    }
    if (!info.isDirectory()) {
      throw new TerminalOpenError('invalid-cwd', `No es un directorio: ${options.cwd}`);
    }

    const resumed = launcher.kind === 'agent' && options.resumeSessionId !== undefined;
    const sessionId =
      launcher.kind === 'agent' ? (options.resumeSessionId ?? randomUUID()) : '';
    // Sin --fork-session: al reanudar queremos seguir escribiendo el mismo
    // archivo, para que el seguimiento incremental del Hito 3 no se corte.
    const launch: LaunchSpec =
      launcher.kind === 'agent'
        ? {
            file: launcher.cli.file,
            args: [
              ...launcher.cli.prefixArgs,
              ...PERMISSION_MODE_ARGS,
              ...(resumed ? ['--resume', sessionId] : ['--session-id', sessionId]),
            ],
          }
        : { file: launcher.shell.file, args: [...launcher.shell.args] };

    const terminalId = randomUUID();
    const buffer = new OutputBuffer();

    let session: PtySession;
    try {
      session = new PtySession({
        launch,
        cwd: options.cwd,
        cols: options.cols ?? DEFAULT_COLS,
        rows: options.rows ?? DEFAULT_ROWS,
        onData: (chunk) => {
          buffer.push(chunk);
          const entry = this.terminals.get(terminalId);
          const listenerCount = entry?.listeners.size ?? 0;
          debugLog(
            'pty',
            `salida ${chunk.length} bytes de ${terminalId.slice(0, 8)}, ${listenerCount} oyentes`,
          );
          if (entry !== undefined) {
            for (const listener of entry.listeners) listener(terminalId, chunk);
          }
          this.emit('output', terminalId, chunk);
        },
        onExit: (exitCode, signal) => {
          const entry = this.terminals.get(terminalId);
          if (entry !== undefined) {
            // La pestana no se cierra sola: queda muerta y visible, para que el
            // usuario vea el codigo de salida en vez de que desaparezca.
            entry.descriptor = { ...entry.descriptor, alive: false, exitCode };
          }
          this.emit('exit', terminalId, exitCode, signal);
          this.emit('changed');
        },
      });
    } catch (error) {
      throw new TerminalOpenError(
        'spawn-failed',
        'No se pudo abrir la terminal.',
        error instanceof Error ? error.message : String(error),
      );
    }

    const descriptor: TerminalDescriptor = {
      terminalId,
      kind,
      cwd: options.cwd,
      sessionId,
      label: options.label ?? '',
      resumed,
      createdAt: Date.now(),
      alive: true,
      exitCode: null,
    };

    const entry: TerminalEntry = {
      descriptor,
      session,
      buffer,
      listeners: new Set(),
      cancelResumeAnswer: null,
    };
    this.terminals.set(terminalId, entry);

    /*
      Reanudar una sesion vieja y grande abre un dialogo que el usuario contesta
      siempre igual. Se contesta solo, con dos condiciones que se comprueban en
      `resume-dialog.ts`; si el dialogo no aparece —que es lo normal— no se
      escribe nada.
    */
    if (resumed && this.cliStatus !== null) {
      entry.cancelResumeAnswer = autoAnswerResumeDialog({
        watcher: this.cliStatus,
        sessionId,
        readOutput: () => buffer.read(),
        write: (data) => {
          const target = this.terminals.get(terminalId);
          if (target === undefined) return false;
          target.session.write(data);
          return true;
        },
        onDone: (outcome) => {
          const target = this.terminals.get(terminalId);
          if (target !== undefined) target.cancelResumeAnswer = null;
          debugLog('registro', `dialogo de reanudar en ${terminalId.slice(0, 8)}: ${outcome}`);
        },
      });
    }

    this.insertInOrder(terminalId, descriptor);
    this.persist();
    this.emit('changed');

    return descriptor;
  }

  /**
   * Reabre las pestanas guardadas del arranque anterior.
   *
   * Los procesos no sobreviven al cierre: lo que se restaura es la lista, y
   * cada pestana se relanza con `--resume` sobre su conversacion.
   *
   * Se lanzan de a una y no en paralelo a proposito: cada pestana es un proceso
   * de varios cientos de MB, y arrancar diez de golpe deja la maquina de
   * rodillas justo cuando el usuario esta abriendo la app.
   */
  async restore(tabs: readonly PersistedTab[]): Promise<void> {
    for (const tab of tabs) {
      if (this.terminals.size >= MAX_TERMINALS) break;
      try {
        await this.open({
          cwd: tab.cwd,
          resumeSessionId: tab.sessionId,
          label: tab.label,
        });
      } catch (error) {
        // Una carpeta que ya no existe no puede frenar la restauracion del resto.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[workspace] no se restauro la pestana de ${tab.cwd}: ${reason}`);
      }
    }
  }

  /**
   * Deja la pestana nueva **junto a las de su mismo proyecto**, no al final.
   *
   * Con las pestanas encogidas y los nombres recortados, tenerlas desparramadas
   * obliga a leerlas una por una. Agrupar por `cwd` es lo que hace que el color
   * del subrayado sirva de algo: los del mismo tono quedan pegados.
   *
   * El orden manual sigue mandando — esto solo decide donde cae la nueva, y un
   * arrastre posterior la mueve a donde el usuario quiera.
   */
  private insertInOrder(terminalId: TerminalId, descriptor: TerminalDescriptor): void {
    // Una consola no esta en la barra de pestanas: va al final y no agrupa.
    if (descriptor.kind !== 'agent') {
      this.order.push(terminalId);
      return;
    }

    let last = -1;
    for (const [index, id] of this.order.entries()) {
      const other = this.terminals.get(id)?.descriptor;
      if (other === undefined) continue;
      if (other.kind === 'agent' && other.cwd === descriptor.cwd) last = index;
    }

    if (last === -1) this.order.push(terminalId);
    else this.order.splice(last + 1, 0, terminalId);
  }

  /** Cierra la pestana y termina el proceso. */
  close(terminalId: TerminalId): boolean {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return false;

    entry.listeners.clear();
    entry.cancelResumeAnswer?.();
    entry.session.dispose();
    this.terminals.delete(terminalId);
    this.order = this.order.filter((id) => id !== terminalId);
    this.persist();
    this.emit('changed');
    return true;
  }

  /**
   * Engancha un oyente y devuelve el buffer para repintar.
   * Es lo que corre cuando el navegador vuelve despues de una recarga.
   */
  attach(
    terminalId: TerminalId,
    listener: OutputListener,
  ): { replay: string; truncated: boolean } | null {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return null;

    entry.listeners.add(listener);
    const replay = entry.buffer.read();
    debugLog(
      'registro',
      `attach ${terminalId.slice(0, 8)}: replay de ${replay.length} bytes, ${entry.listeners.size} oyentes`,
    );
    return { replay, truncated: entry.buffer.isTruncated() };
  }

  detach(terminalId: TerminalId, listener: OutputListener): void {
    this.terminals.get(terminalId)?.listeners.delete(listener);
  }

  /** Quita un oyente de todas las terminales. Para cuando se cae un socket. */
  detachAll(listener: OutputListener): void {
    for (const entry of this.terminals.values()) entry.listeners.delete(listener);
  }

  write(terminalId: TerminalId, data: string): boolean {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return false;
    /*
      Si alguien ya esta escribiendo, el menu del dialogo de reanudar no esta
      como lo dejamos: se abandona la espera antes de que mande un `2` que
      caeria en cualquier lado. Vale tanto si lo escribio el usuario como si
      son las propias teclas del contestador, que ya se marco terminado.
    */
    entry.cancelResumeAnswer?.();
    entry.session.write(data);
    return true;
  }

  resize(terminalId: TerminalId, cols: number, rows: number): boolean {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return false;
    entry.session.resize(cols, rows);
    return true;
  }

  rename(terminalId: TerminalId, label: string): boolean {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return false;
    entry.descriptor = { ...entry.descriptor, label };
    this.persist();
    this.emit('changed');
    return true;
  }

  /** Reordena las pestanas. Ignora ids desconocidos y no pierde los omitidos. */
  reorder(terminalIds: TerminalId[]): void {
    const known = terminalIds.filter((id) => this.terminals.has(id));
    const missing = this.order.filter((id) => !known.includes(id));
    this.order = [...known, ...missing];
    this.persist();
    this.emit('changed');
  }

  /** Termina todo. Solo para el apagado del servidor. */
  disposeAll(): void {
    for (const entry of this.terminals.values()) {
      entry.listeners.clear();
      entry.cancelResumeAnswer?.();
      entry.session.dispose();
    }
    this.terminals.clear();
    this.order = [];
  }

  /**
   * Guarda las pestanas de la CLI y **solo** esas.
   *
   * Una consola no se restaura: no tiene conversacion que reanudar, y volver a
   * abrirla al arrancar seria dejar un proceso corriendo que el usuario no
   * pidio. Reabrirla cuesta un clic.
   */
  private persist(): void {
    const tabs: PersistedTab[] = this.list()
      .filter((descriptor) => descriptor.kind === 'agent')
      .map((descriptor) => ({
        cwd: descriptor.cwd,
        sessionId: descriptor.sessionId,
        label: descriptor.label,
      }));
    this.store.save({ tabs });
  }
}
