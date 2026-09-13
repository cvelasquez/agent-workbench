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
import type {
  AgentId,
  TerminalActivity,
  TerminalDescriptor,
  TerminalId,
  TerminalKind,
} from '@agent-workbench/shared';
import type { AgentAdapter, CliLocation } from './agents/adapter.js';
import {
  resolveAgentForOpen,
  type AgentRegistry,
  type RegisteredAgent,
} from './agents/registry.js';
import { debugLog } from './debug.js';
import { OutputBuffer } from './output-buffer.js';
import { PtySession, type LaunchSpec } from './pty-session.js';
import type { ShellLocation } from './shell-locator.js';
import { WorkspaceStore, persistableTabs, type PersistedTab } from './workspace-store.js';

/** Tope defensivo: cada pestana es un proceso real. */
const MAX_TERMINALS = 24;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

export type OutputListener = (terminalId: TerminalId, chunk: string) => void;

/**
 * De que CLI es una sesion del historial, o null si no se sabe.
 *
 * Lo contesta el indice. Es lo que decide con que CLI se reanuda una sesion
 * cuando el cliente no lo dice.
 */
export type SessionAgentLookup = (sessionId: string) => AgentId | null;

interface TerminalEntry {
  descriptor: TerminalDescriptor;
  /**
   * La pty, o null si la pestana esta **dormida**.
   *
   * Dormida es una pestana sin proceso: existe, se lee su conversacion, sus
   * archivos y su git, y no hay ninguna CLI corriendo. Es lo que devuelve una
   * restauracion — arrancar la aplicacion no lanza seis procesos de varios
   * cientos de MB para leer lo que ya esta escrito en el JSONL.
   *
   * Tambien queda en null cuando el proceso termina, pero eso se distingue por
   * el `exitCode` del descriptor: son dos cosas distintas para el usuario.
   */
  session: PtySession | null;
  buffer: OutputBuffer;
  listeners: Set<OutputListener>;
  /**
   * Ultimo tamano que pidio el cliente, aunque no hubiera pty.
   *
   * Es lo que hace que una pestana dormida no despierte en 80x24. El cliente
   * mide el contenedor y manda `resize` igual —la terminal esta montada aunque
   * la pestana no tenga proceso—, asi que cuando aparece la pty ya sabemos de
   * que tamano tiene que nacer. Un pty desincronizado rompe el renderizado de
   * la CLI (§3.1), y "se arregla solo cuando el usuario mueva el divisor" no es
   * un arreglo.
   */
  size: { cols: number; rows: number };
  /** Corta la suscripcion al estado que la CLI publica por proceso. */
  stopWatchingActivity: (() => void) | null;
  /**
   * Corta lo que el adaptador dejo corriendo despues de lanzar, si dejo algo.
   *
   * Con Claude Code es la espera del dialogo de reanudar. Se llama en cuanto el
   * usuario escribe algo el mismo o la pestana se cierra: a partir de ahi el
   * menu ya no esta como lo dejamos y un `2` cae en cualquier lado. Ver
   * `agents/claude-code/resume-dialog.ts`.
   */
  cancelLaunchHook: (() => void) | null;
}

export interface OpenTerminalOptions {
  cwd: string;
  /** `agent` (la CLI) por omision. `shell` abre la consola del sistema. */
  kind?: TerminalKind;
  /**
   * Que CLI. Sin el campo decide `resolveAgentForOpen`. Solo para `agent`.
   */
  agent?: AgentId;
  /** Si viene, se reanuda esa conversacion. Solo para `agent`. */
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
      | 'spawn-failed'
      | 'agent-unsupported',
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
  /**
   * Cambio lo que esta haciendo la CLI de esa pestana.
   *
   * Va aparte de `changed` porque late cada 700 ms y `changed` reenvia la lista
   * entera de pestanas: seria repetir todo para cambiar una palabra.
   */
  activity: (terminalId: TerminalId, activity: TerminalActivity) => void;
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
    private readonly agents: AgentRegistry,
    private readonly shell: ShellLocation | null,
    private readonly store: WorkspaceStore,
    /**
     * De que CLI es una sesion que se reanuda. Sin indice que conteste, nadie
     * lo sabe y decide la CLI por defecto (ver `resolveAgentForOpen`).
     */
    private readonly sessionAgentOf: SessionAgentLookup = () => null,
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
    agent: AgentId | null,
  ):
    | { kind: 'agent'; agent: RegisteredAgent & { location: CliLocation } }
    | { kind: 'shell'; shell: ShellLocation } {
    if (kind === 'agent') {
      const registered = agent === null ? null : this.agents.get(agent);
      if (registered === null || registered.location === null) {
        throw new TerminalOpenError(
          'cli-not-found',
          'La CLI no esta instalada o no se encontro en el PATH.',
        );
      }
      return {
        kind: 'agent',
        agent: { adapter: registered.adapter, location: registered.location },
      };
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
   * Sin `resumeSessionId` generamos el UUID nosotros y se lo proponemos al
   * adaptador; con Claude Code va con `--session-id`: asi sabemos de antemano
   * que archivo JSONL va a escribir la CLI, y el Hito 3 no tiene que adivinarlo
   * mirando el directorio.
   *
   * Una consola (`kind: 'shell'`) no lleva nada de eso: no tiene CLI, no
   * escribe historial, su `sessionId` queda vacio y no se guarda entre
   * arranques.
   */
  async open(options: OpenTerminalOptions): Promise<TerminalDescriptor> {
    const kind: TerminalKind = options.kind ?? 'agent';
    /*
      Una CLI pedida que no tiene adaptador aca no cae a la de por defecto:
      abrir otra que la pedida es peor que no abrir nada. Distinto de una CLI
      registrada que no esta instalada, que sigue siendo `cli-not-found`.
    */
    if (kind === 'agent' && options.agent !== undefined && this.agents.get(options.agent) === null) {
      throw new TerminalOpenError(
        'agent-unsupported',
        'Este servidor no sabe lanzar esa CLI.',
        options.agent,
      );
    }
    const agent =
      kind === 'agent'
        ? resolveAgentForOpen({
            requested: options.agent,
            cwd: options.cwd,
            resumeSessionId: options.resumeSessionId,
            sessionAgent:
              options.resumeSessionId === undefined
                ? null
                : this.sessionAgentOf(options.resumeSessionId),
            tabs: this.list(),
            defaultAgent: this.agents.defaultAgent(),
            platform: process.platform,
          })
        : null;
    // Se resuelve que se va a lanzar antes que nada: asi el error que ve el
    // usuario es "falta la CLI" o "falta la consola" y no uno de mas adelante.
    this.launcherFor(kind, agent);

    if (this.terminals.size >= MAX_TERMINALS) {
      throw new TerminalOpenError(
        'too-many-terminals',
        `No se pueden abrir mas de ${MAX_TERMINALS} pestanas a la vez.`,
      );
    }

    await this.assertDirectory(options.cwd);

    const resumed = kind === 'agent' && options.resumeSessionId !== undefined;
    const terminalId = randomUUID();
    const descriptor: TerminalDescriptor = {
      terminalId,
      kind,
      agent,
      cwd: options.cwd,
      // Provisional: `spawn` lo confirma con lo que diga el adaptador.
      sessionId: kind === 'agent' ? (options.resumeSessionId ?? randomUUID()) : '',
      label: options.label ?? '',
      resumed,
      createdAt: Date.now(),
      // Lo pone `spawn`. Una entrada que no llega a tener proceso no queda en
      // el registro: el catch de abajo la saca.
      alive: false,
      exitCode: null,
      sleeping: true,
    };

    const entry: TerminalEntry = {
      descriptor,
      session: null,
      buffer: new OutputBuffer(),
      listeners: new Set(),
      size: { cols: options.cols ?? DEFAULT_COLS, rows: options.rows ?? DEFAULT_ROWS },
      cancelLaunchHook: null,
      stopWatchingActivity: null,
    };
    this.terminals.set(terminalId, entry);

    try {
      this.spawn(entry, { resume: resumed });
    } catch (error) {
      this.terminals.delete(terminalId);
      throw error;
    }

    this.insertInOrder(terminalId, entry.descriptor);
    this.persist();
    this.emit('changed');

    return entry.descriptor;
  }

  /**
   * Le da proceso a una pestana dormida, o revive una que murio.
   *
   * Es la otra mitad de restaurar sin lanzar nada: la pestana ya esta en
   * pantalla con su conversacion, y esto es lo que pasa cuando el usuario
   * quiere escribirle al agente. Reusa el mismo `terminalId` y el mismo
   * `sessionId` — no es una pestana nueva, es la misma.
   */
  async wake(terminalId: TerminalId): Promise<TerminalDescriptor | null> {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return null;
    if (entry.session !== null && entry.descriptor.alive) return entry.descriptor;

    await this.assertDirectory(entry.descriptor.cwd);

    /*
      Se reanuda solo si hay algo que reanudar. Una pestana que se cerro antes
      del primer turno no tiene archivo de sesion, y ahi `--resume` deja a la
      CLI mostrando un error en vez de una conversacion; con `--session-id`
      arranca limpia y sigue escribiendo el archivo que ya esperabamos.
    */
    const { kind, agent, cwd, sessionId } = entry.descriptor;
    const history = agent === null ? null : (this.agents.get(agent)?.adapter.history ?? null);
    const resume =
      kind === 'agent' &&
      history !== null &&
      sessionId.length > 0 &&
      (await history.exists(cwd, sessionId));

    this.spawn(entry, { resume });
    this.persist();
    this.emit('changed');
    return entry.descriptor;
  }

  /** El `cwd` tiene que existir y ser un directorio. Vale para abrir y despertar. */
  private async assertDirectory(cwd: string): Promise<void> {
    let info;
    try {
      info = await stat(cwd);
    } catch {
      throw new TerminalOpenError('invalid-cwd', `El directorio no existe: ${cwd}`);
    }
    if (!info.isDirectory()) {
      throw new TerminalOpenError('invalid-cwd', `No es un directorio: ${cwd}`);
    }
  }

  /**
   * Lanza la pty de una entrada que ya existe.
   *
   * Lo usan `open()` y `wake()`, y por eso esta aca afuera: eran el mismo
   * codigo, y dos copias de esto es como una de las dos termina sin el
   * gancho posterior al lanzamiento (el contestador del dialogo de reanudar).
   */
  private spawn(entry: TerminalEntry, options: { resume: boolean }): void {
    const { terminalId, kind, cwd, sessionId, agent } = entry.descriptor;
    const launcher = this.launcherFor(kind, agent);
    const { buffer } = entry;

    /*
      Que se lanza, con que entorno y con que id de sesion lo decide el
      adaptador de la CLI; aca solo se ejecuta. La consola no es de ninguna CLI
      y recibe el entorno filtrado por todas: desde ella se puede lanzar
      cualquiera a mano, y tiene que arrancar igual que desde una pestana.
    */
    let launch: LaunchSpec;
    let env: Record<string, string>;
    let adapter: AgentAdapter | null = null;
    let launchedSessionId = sessionId;
    if (launcher.kind === 'agent') {
      adapter = launcher.agent.adapter;
      const plan = adapter.launch({
        location: launcher.agent.location,
        cwd,
        resumeSessionId: options.resume ? sessionId : null,
        proposedSessionId: sessionId,
      });
      launch = { file: plan.file, args: plan.args };
      env = adapter.environment(process.env).env;
      // Una CLI que pone el id ella misma deja la pestana sin id hasta que el
      // gancho lo descubra y lo avise (`reportSessionId`). Con Claude Code el
      // id es siempre el que ya tenia la pestana.
      launchedSessionId = plan.session.kind === 'known' ? plan.session.sessionId : '';
    } else {
      launch = { file: launcher.shell.file, args: [...launcher.shell.args] };
      env = this.agents.consoleEnvironment(process.env);
    }

    const launchedAt = Date.now();
    let session: PtySession;
    try {
      session = new PtySession({
        launch,
        cwd,
        env,
        cols: entry.size.cols,
        rows: entry.size.rows,
        onData: (chunk) => {
          buffer.push(chunk);
          const target = this.terminals.get(terminalId);
          const listenerCount = target?.listeners.size ?? 0;
          debugLog(
            'pty',
            `salida ${chunk.length} bytes de ${terminalId.slice(0, 8)}, ${listenerCount} oyentes`,
          );
          if (target !== undefined) {
            for (const listener of target.listeners) listener(terminalId, chunk);
          }
          this.emit('output', terminalId, chunk);
        },
        onExit: (exitCode, signal) => {
          const target = this.terminals.get(terminalId);
          if (target !== undefined) {
            // La pestana no se cierra sola: queda muerta y visible, para que el
            // usuario vea el codigo de salida en vez de que desaparezca. Sin
            // proceso vuelve a ser una pestana que se lee y se puede despertar.
            target.session = null;
            target.descriptor = {
              ...target.descriptor,
              alive: false,
              exitCode,
              sleeping: false,
            };
            target.stopWatchingActivity?.();
            target.stopWatchingActivity = null;
            this.emit('activity', terminalId, 'offline');
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

    entry.session = session;
    entry.descriptor = {
      ...entry.descriptor,
      sessionId: launchedSessionId,
      alive: true,
      exitCode: null,
      sleeping: false,
    };
    this.watchActivity(entry);

    /*
      Lo que el adaptador tenga que hacer con el proceso ya andando. Con Claude
      Code: reanudar una sesion vieja y grande abre un dialogo que el usuario
      contesta siempre igual, y se contesta solo si se cumplen las dos
      condiciones de `resume-dialog.ts`; en una sesion nueva no hay gancho.

      Solo se pisa la referencia cuando hay gancho nuevo, igual que antes: sin
      eso, despertar sin reanudar soltaria la cancelacion de uno anterior que
      todavia estuviera esperando.
    */
    if (adapter !== null) {
      const cancel = adapter.onSpawned({
        terminalId,
        sessionId: launchedSessionId,
        resumed: options.resume,
        pid: session.pid,
        launchedAt,
        readOutput: () => buffer.read(),
        write: (data) => {
          const target = this.terminals.get(terminalId);
          if (target === undefined || target.session === null) return false;
          target.session.write(data);
          return true;
        },
        onDone: (outcome) => {
          const target = this.terminals.get(terminalId);
          if (target !== undefined) target.cancelLaunchHook = null;
          debugLog('registro', `dialogo de reanudar en ${terminalId.slice(0, 8)}: ${outcome}`);
        },
        reportSessionId: (discovered) => this.reportSessionId(terminalId, discovered),
      });
      if (cancel !== null) entry.cancelLaunchHook = cancel;
    }
  }

  /**
   * El id de sesion que descubrio el adaptador despues de lanzar.
   *
   * Es para las CLIs que ponen el id ellas mismas: la pestana nace sin id y lo
   * gana aca. Actualiza el descriptor, lo guarda —recien ahora hay algo que
   * reanudar—, avisa y vuelve a seguir el estado del proceso con el id nuevo.
   * Con Claude Code nadie lo llama: el id se fija al lanzar.
   */
  private reportSessionId(terminalId: TerminalId, sessionId: string): void {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined || entry.descriptor.kind !== 'agent') return;
    if (sessionId.length === 0 || entry.descriptor.sessionId === sessionId) return;

    entry.descriptor = { ...entry.descriptor, sessionId };
    if (entry.session !== null) this.watchActivity(entry);
    this.persist();
    this.emit('changed');
  }

  /**
   * Sigue el estado que la CLI publica por proceso, para esta pestana.
   *
   * Es lo que hace que la barra de pestanas pueda decir si el agente esta
   * trabajando, parado o esperando una respuesta. El sondeo es **uno solo** por
   * CLI y compartido con todo lo que mira ese estado, asi que seguir seis
   * pestanas no cuesta seis lecturas.
   */
  private watchActivity(entry: TerminalEntry): void {
    entry.stopWatchingActivity?.();
    entry.stopWatchingActivity = null;

    const { terminalId, kind, agent, sessionId } = entry.descriptor;
    if (kind !== 'agent' || agent === null || sessionId.length === 0) return;

    // Una CLI que no publica su estado no tiene nada que seguir: se dice una
    // vez que no se sabe, en vez de dejar la pestana como si estuviera libre.
    const status = this.agents.get(agent)?.adapter.status ?? null;
    if (status === null) {
      this.emit('activity', terminalId, 'unknown');
      return;
    }

    entry.stopWatchingActivity = status.subscribe(sessionId, (current) => {
      this.emit('activity', terminalId, current === null ? 'offline' : current.activity);
    });
  }

  /**
   * Reabre las pestanas guardadas del arranque anterior, **dormidas**.
   *
   * Los procesos no sobreviven al cierre, y hasta el hito 21 esto relanzaba un
   * `claude --resume` por cada pestana guardada: seis pestanas eran seis
   * procesos de varios cientos de MB arrancando a la vez para leer algo que ya
   * estaba escrito en el JSONL. La conversacion, el medidor, git y el arbol
   * salen del archivo y del `cwd`; la pty solo hace falta para *escribirle* al
   * agente.
   *
   * Asi que se restaura la lista y nada mas. La CLI la pide el usuario, pestana
   * por pestana, con `terminal.wake`.
   *
   * Se comprueba que el directorio siga existiendo: una pestana dormida
   * apuntando a una carpeta borrada no sirve para nada y se veria como una
   * conversacion vacia sin explicacion. Y que su CLI siga instalada: sin ella
   * no hay con que despertarla.
   */
  async restore(tabs: readonly PersistedTab[]): Promise<void> {
    for (const tab of tabs) {
      if (this.terminals.size >= MAX_TERMINALS) break;
      if ((this.agents.get(tab.agent)?.location ?? null) === null) {
        console.warn(
          `[workspace] no se restauro la pestana de ${tab.cwd}: su CLI no esta disponible.`,
        );
        continue;
      }
      try {
        await this.assertDirectory(tab.cwd);
      } catch (error) {
        // Una carpeta que ya no existe no puede frenar la restauracion del resto.
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`[workspace] no se restauro la pestana de ${tab.cwd}: ${reason}`);
        continue;
      }

      const terminalId = randomUUID();
      const descriptor: TerminalDescriptor = {
        terminalId,
        kind: 'agent',
        agent: tab.agent,
        cwd: tab.cwd,
        sessionId: tab.sessionId,
        label: tab.label,
        // Cuando despierte va a ser un `--resume` de verdad; decirlo desde ya
        // es lo que hace que la pestana se dibuje con su flecha de reanudada.
        resumed: true,
        createdAt: Date.now(),
        alive: false,
        exitCode: null,
        sleeping: true,
      };

      this.terminals.set(terminalId, {
        descriptor,
        session: null,
        buffer: new OutputBuffer(),
        listeners: new Set(),
        size: { cols: DEFAULT_COLS, rows: DEFAULT_ROWS },
        cancelLaunchHook: null,
        stopWatchingActivity: null,
      });
      this.insertInOrder(terminalId, descriptor);
    }

    this.persist();
    this.emit('changed');
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
    entry.cancelLaunchHook?.();
    entry.stopWatchingActivity?.();
    // Una pestana dormida no tiene nada que terminar: se saca y listo.
    entry.session?.dispose();
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

  /**
   * Escribe en la pty, si la hay.
   *
   * Devuelve false con la pestana dormida, y eso no es un error: es el estado
   * normal de una pestana restaurada. Quien llama decide que hacer —el socket
   * lo dice, el cliente ofrece abrir la CLI.
   */
  write(terminalId: TerminalId, data: string): boolean {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined || entry.session === null) return false;
    /*
      Si alguien ya esta escribiendo, el menu del dialogo de reanudar no esta
      como lo dejamos: se abandona la espera antes de que mande un `2` que
      caeria en cualquier lado. Vale tanto si lo escribio el usuario como si
      son las propias teclas del contestador, que ya se marco terminado.
    */
    entry.cancelLaunchHook?.();
    entry.session.write(data);
    return true;
  }

  /**
   * Reenvia el tamano al pty, y lo recuerda.
   *
   * Lo recuerda **aunque no haya pty**: una pestana dormida tiene su terminal
   * montada del lado del cliente y manda su tamano igual. Sin eso, despertarla
   * arrancaba la CLI en 80x24 hasta que alguien moviera un divisor.
   */
  resize(terminalId: TerminalId, cols: number, rows: number): boolean {
    const entry = this.terminals.get(terminalId);
    if (entry === undefined) return false;
    entry.size = { cols, rows };
    if (entry.session === null) return false;
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
      entry.cancelLaunchHook?.();
      entry.stopWatchingActivity?.();
      entry.session?.dispose();
    }
    this.terminals.clear();
    this.order = [];
  }

  /** Guarda las pestanas de una CLI y **solo** esas (ver `persistableTabs`). */
  private persist(): void {
    this.store.save({ tabs: persistableTabs(this.list()) });
  }
}
