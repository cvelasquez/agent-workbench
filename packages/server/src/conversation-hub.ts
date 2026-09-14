/**
 * Sigue las conversaciones de las pestanas que alguien esta mirando.
 *
 * Que sesion seguir no se adivina: cada pestana de agente sabe su `sessionId`
 * desde que se lanza, y el adaptador de su CLI sabe donde la escribe (con
 * Claude Code, el UUID de `--session-id` da la ruta del archivo; CLAUDE.md
 * 4.8). El brief proponia observar el directorio y quedarse con el `.jsonl`
 * que apareciera despues del arranque: eso tiene una carrera en cuanto hay dos
 * pestanas del mismo proyecto.
 *
 * Como se lee, que configuracion se aplica antes y el re-apuntado de respaldo
 * son de cada CLI y viven en su seguidor (`history.follow` del adaptador). Aca
 * queda lo comun: la cuenta de suscriptores, el modo de permiso que llevamos
 * nosotros y a quien avisar.
 *
 * El seguimiento se prende y se apaga por demanda: solo la pestana que se esta
 * mirando tiene un follower vivo.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  EMPTY_CONTEXT_USAGE,
  type AgentId,
  type ContextUsage,
  type ConversationEvent,
  type ConversationQuestionPart,
  type ConversationImageSource,
  type ConversationState,
  type PermissionMode,
  type PlanContent,
  type SessionId,
  type SessionPlan,
  type TerminalId,
} from '@agent-workbench/shared';
import type {
  AgentAdapter,
  LoadedImage,
  PartsUpdate,
  SessionFollower,
  TurnUpdate,
} from './agents/adapter.js';
import type { AgentRegistry } from './agents/registry.js';
import { debugLog } from './debug.js';
import type { TerminalRegistry } from './terminal-registry.js';

/** Cuantos eventos manda el primer envio. El resto se pide con loadMore. */
export const INITIAL_EVENT_LIMIT = 300;
/** Tope por pagina, para que un cliente no pida la sesion entera de una. */
const MAX_PAGE_LIMIT = 500;
/**
 * Cuantos eventos se miran hacia atras buscando la pregunta abierta.
 *
 * Una pregunta sin responder es de hace un momento: si hay que retroceder
 * cincuenta eventos para encontrarla, ya no es la que esta en pantalla.
 */
const PENDING_QUESTION_LOOKBACK = 50;

/**
 * Espera antes de leer tras un cambio.
 *
 * Bastante mas corto que el del indice (750 ms): esto es latencia que el
 * usuario ve mientras la respuesta se escribe.
 */
const POLL_DEBOUNCE_MS = 150;

export interface ConversationSnapshot {
  sessionId: SessionId;
  state: ConversationState;
  events: ConversationEvent[];
  hasMore: boolean;
  usage: ContextUsage;
  /** Modo de permiso observado en el archivo, o null si todavia no lo dijo. */
  permissionMode: PermissionMode | null;
  /** Que espera la CLI, o null si no espera nada. No sale del JSONL. */
  waitingFor: string | null;
  /** Ver `Entry.openToolCall`. */
  openToolCall: boolean;
  /** Planes que esta conversacion escribio, los mas nuevos primero. */
  plans: SessionPlan[];
}

interface Entry {
  sessionId: SessionId;
  /** De que CLI es la pestana. Filtra los avisos del watcher. */
  agent: AgentId;
  adapter: AgentAdapter;
  follower: SessionFollower;
  /** Ultimo modo avisado, para no repetir el aviso en cada pasada. */
  announcedMode: PermissionMode | null;
  /**
   * El modo al que nosotros llevamos la pestana, o el de arranque.
   *
   * La aplicacion lanza cada pty con el modo que declara la capacidad
   * `permissionCycle` de su CLI (con Claude Code, `--permission-mode auto`;
   * §4.8.1), asi que el punto de partida no es una suposicion. A partir de ahi,
   * lo unico que lo mueve es la tecla que cicla: la del combo, que se anota
   * aca, o la que el usuario teclee en la solapa CLI, que llega por el archivo.
   *
   * null si la CLI no declara ciclo: no hay modo que llevar.
   */
  assumedMode: PermissionMode | null;
  /**
   * El modo que dijo el archivo **mientras mirabamos**.
   *
   * Y ese "mientras" es la parte que importa. Las lineas `permission-mode` de
   * una sesion que se retoma con `--resume` describen la corrida anterior, no
   * esta: la pty nueva arranco en `auto` de todos modos. Tomarlas como punto
   * de partida rompio el combo de verdad — con el archivo diciendo `plan` y la
   * pty en `auto`, pedir `acceptEdits` mandaba tres `shift+tab` y dejaba la
   * sesion en `plan`, que es donde ya no estaba.
   *
   * Por eso solo cuentan las lineas leidas en una pasada **no silenciosa**: la
   * silenciosa es la que carga el historial al suscribirse.
   */
  observedMode: PermissionMode | null;
  /** Cuantos clientes la estan mirando. Cero = se apaga. */
  refs: number;
  timer: NodeJS.Timeout | null;
  /** Cadena de lecturas, para que dos cambios seguidos no se pisen. */
  polling: Promise<void>;
  /**
   * Que espera la CLI ahora mismo, o null si no espera nada.
   *
   * No sale del historial —ahi no esta— sino del estado que la CLI publica por
   * proceso (`adapter.status`; con Claude Code, `~/.claude/sessions/<pid>.json`).
   */
  waitingFor: string | null;
  /**
   * true si la CLI no publica su estado y la conversacion tiene una llamada a
   * herramienta del proceso vivo sin resultado (`hasOpenToolCall`).
   *
   * Es la misma pregunta que hace el socket antes de mandar un mensaje, llevada
   * al cliente para que el cuadro de escritura no deje apretar Enviar (A1 del
   * hito 25). Se recalcula despues de cada lectura y cuando la pty cambia —se
   * lanza o termina—, que es lo que mueve el `launchedAt` contra el que se mide.
   */
  openToolCall: boolean;
  /**
   * true desde que la lectura inicial —la silenciosa— esta en la cadena. Antes
   * de eso una lectura con aviso mandaria por evento lo mismo que despues va en
   * el snapshot, y el cliente lo veria dos veces.
   */
  primed: boolean;
  /** Corta la suscripcion al vigilante de estado al soltar la pestana. */
  stopWatchingStatus: (() => void) | null;
  /** La relectura periodica de una CLI que la pide (`history.followPollMs`), o null. */
  followTicker: NodeJS.Timeout | null;
}

export interface ConversationHubEvents {
  reset: (terminalId: TerminalId) => void;
  /**
   * El modo de permiso cambio. Va aparte del `append` a proposito: el caso que
   * lo necesita es justamente el que no trae mensajes nuevos.
   */
  mode: (terminalId: TerminalId, mode: PermissionMode) => void;
  /**
   * La CLI empezo —o dejo— de esperar una respuesta del usuario.
   *
   * Va aparte de todo lo demas porque no sale del archivo de sesion: sale del
   * estado que la CLI publica por proceso. Un permiso pendiente no deja ni una
   * linea en el JSONL mientras espera.
   */
  waiting: (terminalId: TerminalId, waitingFor: string | null) => void;
  /** Cambio `openToolCall` de la pestana. Solo CLIs que no publican su estado. */
  toolCall: (terminalId: TerminalId, open: boolean) => void;
  append: (
    terminalId: TerminalId,
    events: ConversationEvent[],
    usage: ContextUsage,
    permissionMode: PermissionMode | null,
  ) => void;
  state: (terminalId: TerminalId, state: ConversationState) => void;
  /** Duraciones de turnos cuyo mensaje ya se habia entregado. */
  turns: (terminalId: TerminalId, turns: TurnUpdate[]) => void;
  /** Mensajes ya entregados a los que se les agrego una imagen adjunta. */
  parts: (terminalId: TerminalId, updates: PartsUpdate[]) => void;
  /**
   * La lista de planes de la pestana cambio.
   *
   * Va entera y no solo el plan nuevo: son tres o cuatro entradas de un par de
   * campos, y mandar la lista completa deja al cliente sin nada que fusionar.
   */
  plans: (terminalId: TerminalId, plans: SessionPlan[]) => void;
}

export declare interface ConversationHub {
  on<E extends keyof ConversationHubEvents>(event: E, listener: ConversationHubEvents[E]): this;
  emit<E extends keyof ConversationHubEvents>(
    event: E,
    ...args: Parameters<ConversationHubEvents[E]>
  ): boolean;
}

export class ConversationHub extends EventEmitter {
  private readonly entries = new Map<TerminalId, Entry>();

  constructor(
    private readonly registry: TerminalRegistry,
    /**
     * Las CLIs registradas. De cada adaptador salen el seguidor de la sesion y
     * el estado del proceso, que es el mismo que usa el registro de terminales
     * —uno solo por CLI— porque el costo del sondeo no crece con la cantidad
     * de suscriptores.
     */
    private readonly agents: AgentRegistry,
  ) {
    super();
    /*
      Una pestana que cambio de sesion —la descubrio el adaptador despues de
      lanzar, o se relanzo con otra— tiene que seguir la nueva. Con Claude Code
      no pasa nunca: el id se fija al lanzar.
    */
    registry.on('session', (terminalId) => void this.rebind(terminalId));
    /*
      Lanzar o terminar una pty cambia contra que proceso se mide una llamada
      abierta: la de un proceso anterior quedo huerfana. `changed` llega en los
      dos casos, y recalcular es recorrer un mapa chico por pestana seguida.
    */
    registry.on('changed', () => {
      for (const [terminalId, entry] of this.entries) this.refreshOpenToolCall(terminalId, entry);
    });
  }

  /**
   * Engancha un cliente mas a la conversacion de una pestana y devuelve lo que
   * se sabe hasta ahora.
   */
  async subscribe(terminalId: TerminalId): Promise<ConversationSnapshot | null> {
    const descriptor = this.registry.get(terminalId);
    if (descriptor === null) return null;

    /*
      Sin cwd no hay nada que seguir, y una consola directamente no escribe
      historial. Tampoco una pestana sin sesion de una CLI que fija el id al
      lanzar: ahi no hay sesion que esperar. Se dice, y no se crea un seguidor
      apuntando a una ruta inventada que despues diria "esperando" para siempre.

      Una pestana sin sesion de una CLI que pone el id ella misma, en cambio, si
      se sigue: esta esperando su primer mensaje, que es cuando la sesion
      aparece (`rebind`).
    */
    const adapter =
      descriptor.agent === null ? null : (this.agents.get(descriptor.agent)?.adapter ?? null);
    if (
      descriptor.cwd.length === 0 ||
      descriptor.agent === null ||
      adapter === null ||
      (descriptor.sessionId.length === 0 && adapter.capabilities.sessionIdAtLaunch)
    ) {
      return {
        sessionId: descriptor.sessionId,
        state: 'unavailable',
        events: [],
        hasMore: false,
        permissionMode: null,
        usage: { ...EMPTY_CONTEXT_USAGE },
        waitingFor: null,
        openToolCall: false,
        plans: [],
      };
    }

    let entry = this.entries.get(terminalId);
    if (entry === undefined) {
      entry = this.createEntry(descriptor.agent, descriptor.cwd, descriptor.sessionId, adapter);
      this.entries.set(terminalId, entry);
      this.watchStatus(terminalId, entry, descriptor.sessionId);
      this.startFollowTicker(terminalId, entry);
      // Lo que el seguidor necesita antes de leer. Con Claude Code, la variante
      // que el archivo nunca dice: sin esto el medidor mostraria 200k un
      // instante y 1M despues.
      await entry.follower.start();
      debugLog(
        'conversacion',
        `sigo ${path.basename(entry.follower.label)} de ${terminalId.slice(0, 8)}`,
      );
      // Si mientras arrancaba la pestana cambio de sesion, la cuenta va a la entrada nueva.
      entry = this.entries.get(terminalId) ?? entry;
    }

    entry.refs += 1;

    // Primera lectura completa del archivo, si ya existe.
    entry.primed = true;
    await this.runPoll(terminalId, entry, { silent: true });

    const tail = entry.follower.getTail(INITIAL_EVENT_LIMIT);
    const plans = entry.adapter.history.plans;
    return {
      sessionId: entry.sessionId,
      state: entry.follower.getState(),
      events: tail.events,
      hasMore: tail.hasMore,
      usage: entry.follower.getUsage(),
      permissionMode: entry.observedMode ?? entry.assumedMode,
      waitingFor: entry.waitingFor,
      openToolCall: entry.openToolCall,
      plans: plans === null ? [] : await plans.describe(entry.follower.getPlanFiles()),
    };
  }

  /**
   * Mira el estado que la CLI publica por proceso, para esta sesion.
   *
   * `waiting` solo se avisa cuando de verdad esta esperando: `busy` e `idle`
   * son estados normales y la conversacion ya los cuenta con lo que dibuja.
   * Una CLI que no publica su estado no avisa nunca.
   */
  private watchStatus(terminalId: TerminalId, entry: Entry, sessionId: SessionId): void {
    const status = entry.adapter.status;
    // Sin sesion no hay proceso que buscar por su id.
    if (status === null || sessionId.length === 0) return;
    entry.stopWatchingStatus = status.subscribe(sessionId, (current) => {
      // Sin etiqueta no se puede decir de que clase es, pero que espera si:
      // se avisa igual, con la copia generica.
      const next =
        current !== null && current.activity === 'waiting'
          ? (current.waitingFor ?? 'unknown')
          : null;
      if (next === entry.waitingFor) return;
      entry.waitingFor = next;
      this.emit('waiting', terminalId, next);
    });
  }

  /**
   * Una entrada nueva para seguir una sesion. La usan `subscribe` y `rebind`:
   * dos construcciones a mano son como una de las dos se queda sin algo.
   */
  private createEntry(
    agent: AgentId,
    cwd: string,
    sessionId: SessionId,
    adapter: AgentAdapter,
  ): Entry {
    return {
      sessionId,
      agent,
      adapter,
      follower: adapter.history.follow({ cwd, sessionId }),
      announcedMode: null,
      assumedMode: adapter.capabilities.permissionCycle?.launchMode ?? null,
      observedMode: null,
      refs: 0,
      timer: null,
      polling: Promise.resolve(),
      waitingFor: null,
      openToolCall: false,
      primed: false,
      stopWatchingStatus: null,
      followTicker: null,
    };
  }

  /**
   * Relee cada `followPollMs` la sesion de una CLI que lo pide, mientras la
   * entrada sea la vigente. Una lectura por tick como mucho: si ya hay una
   * programada por el watcher, esa alcanza.
   *
   * Con Claude Code no corre: su `followPollMs` es null.
   */
  private startFollowTicker(terminalId: TerminalId, entry: Entry): void {
    const everyMs = entry.adapter.history.followPollMs ?? null;
    if (everyMs === null || entry.followTicker !== null) return;
    entry.followTicker = setInterval(() => {
      if (this.entries.get(terminalId) !== entry) return;
      if (!entry.primed || entry.timer !== null) return;
      this.schedulePoll(terminalId, entry);
    }, everyMs);
    entry.followTicker.unref();
  }

  private stopFollowTicker(entry: Entry): void {
    if (entry.followTicker !== null) clearInterval(entry.followTicker);
    entry.followTicker = null;
  }

  /**
   * Recalcula `openToolCall` y avisa si cambio.
   *
   * Una CLI que publica su estado no entra nunca: ahi manda el estado, y su
   * seguidor contesta false de todos modos. Sin pty viva tampoco hay a quien
   * mandarle nada, asi que no hay nada que bloquear.
   */
  private refreshOpenToolCall(terminalId: TerminalId, entry: Entry): void {
    if (entry.adapter.capabilities.statusSource) return;
    const launchedAt = this.registry.launchedAtOf(terminalId);
    const open = launchedAt !== null && entry.follower.hasOpenToolCall(launchedAt);
    if (open === entry.openToolCall) return;
    entry.openToolCall = open;
    this.emit('toolCall', terminalId, open);
  }

  /**
   * La pestana cambio de sesion: se suelta el seguidor viejo y se sigue la
   * nueva, sin perder a quien estaba mirando.
   *
   * Pasa con una CLI que pone el id ella misma: la pestana nace esperando con
   * `sessionId ''` y lo gana con el primer mensaje. Y al relanzar una pestana
   * cuya sesion ya no esta, en sentido contrario. Quien miraba recibe un
   * `reset` con la conversacion de la sesion nueva.
   *
   * Solo si alguien la sigue: sin entrada, el proximo `subscribe` ya lee el
   * descriptor nuevo.
   */
  private async rebind(terminalId: TerminalId): Promise<void> {
    const entry = this.entries.get(terminalId);
    const descriptor = this.registry.get(terminalId);
    if (entry === undefined || descriptor === null || descriptor.agent === null) return;
    if (descriptor.sessionId === entry.sessionId) return;
    const adapter = this.agents.get(descriptor.agent)?.adapter ?? null;
    if (adapter === null) return;

    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
    entry.stopWatchingStatus?.();
    entry.stopWatchingStatus = null;
    this.stopFollowTicker(entry);

    const next: Entry = {
      ...this.createEntry(descriptor.agent, descriptor.cwd, descriptor.sessionId, adapter),
      // Los que miraban siguen mirando.
      refs: entry.refs,
    };
    // Desde aca, una lectura de la entrada vieja que estaba en la cadena sale por su guardia.
    this.entries.set(terminalId, next);
    this.watchStatus(terminalId, next, descriptor.sessionId);
    this.startFollowTicker(terminalId, next);
    debugLog(
      'conversacion',
      `${terminalId.slice(0, 8)} cambio de sesion: sigo ${path.basename(next.follower.label)}`,
    );
    await next.follower.start();
    next.primed = true;
    await this.runPoll(terminalId, next, { silent: true });
    // Otro cambio mientras tanto ya aviso por su cuenta.
    if (this.entries.get(terminalId) !== next) return;
    this.emit('reset', terminalId);
  }

  /**
   * true si la conversacion de una pestana tiene una llamada a herramienta sin
   * resultado, hecha por el proceso lanzado en `launchedAt` o despues.
   *
   * Lo pregunta el socket antes de mandar un mensaje a una CLI que no publica
   * su estado (A1 del hito 25). false si nadie sigue la pestana: sin seguidor no
   * hay nada leido, y quien escribe desde el cuadro de escritura la esta mirando.
   */
  hasOpenToolCall(terminalId: TerminalId, launchedAt: number): boolean {
    return this.entries.get(terminalId)?.follower.hasOpenToolCall(launchedAt) ?? false;
  }

  /**
   * Lo mismo que `hasOpenToolCall`, pero leyendo antes lo que la CLI haya
   * escrito y el watcher todavia no aviso.
   *
   * Lo usa el socket antes de cada pieza de un envio (A1 del hito 25): entre
   * pieza y pieza pasan 400 ms, y el aviso del watcher tarda mas que eso
   * (`awaitWriteFinish` de 300 ms, su sondeo de 100 y el `POLL_DEBOUNCE_MS`).
   * Esperarlo dejaria salir el Enter sobre una llamada que ya esta en el
   * archivo. Lo que queda es lo que la CLI tarda en escribir la llamada, y eso
   * no se ve desde aca.
   *
   * La lectura es la de siempre, encadenada y con sus avisos: lo que traiga le
   * llega al cliente igual que si lo hubiera disparado el watcher.
   */
  async checkOpenToolCall(terminalId: TerminalId, launchedAt: number): Promise<boolean> {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return false;
    if (entry.primed) {
      // Esta lectura cubre la que el watcher dejo programada.
      if (entry.timer !== null) clearTimeout(entry.timer);
      entry.timer = null;
      await this.runPoll(terminalId, entry, { silent: false });
    }
    return this.hasOpenToolCall(terminalId, launchedAt);
  }

  /**
   * El ultimo `openToolCall` calculado para la pestana: lo que ya se aviso.
   * false si nadie la sigue.
   */
  isToolCallOpen(terminalId: TerminalId): boolean {
    return this.entries.get(terminalId)?.openToolCall ?? false;
  }

  private release(terminalId: TerminalId, entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.stopFollowTicker(entry);
    entry.stopWatchingStatus?.();
    entry.stopWatchingStatus = null;
    this.entries.delete(terminalId);
  }

  /** Un cliente deja de mirar. Con el ultimo, el seguimiento se apaga. */
  unsubscribe(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return;

    entry.refs -= 1;
    if (entry.refs > 0) return;

    this.release(terminalId, entry);
    debugLog('conversacion', `dejo de seguir ${terminalId.slice(0, 8)}`);
  }

  /** La pestana se cerro: se suelta sin importar cuantos la miraban. */
  drop(terminalId: TerminalId): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return;
    this.release(terminalId, entry);
  }

  getPage(
    terminalId: TerminalId,
    beforeEventId: string,
    limit: number,
  ): { events: ConversationEvent[]; hasMore: boolean } | null {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return null;
    return entry.follower.getPageBefore(beforeEventId, Math.min(limit, MAX_PAGE_LIMIT));
  }

  /**
   * Contenido de una imagen del historial.
   *
   * Se lee del archivo cada vez, sin cache: mirar una miniatura vieja es raro,
   * y guardar megas de base64 por si acaso es exactamente lo que evita que las
   * imagenes viajen con los eventos.
   */
  async readImage(
    terminalId: TerminalId,
    eventId: string,
    index: number,
    source: ConversationImageSource,
  ): Promise<LoadedImage | null> {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return null;
    return entry.follower.readImage(eventId, index, source);
  }

  getSnapshot(terminalId: TerminalId): ConversationSnapshot | null {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return null;
    const tail = entry.follower.getTail(INITIAL_EVENT_LIMIT);
    return {
      sessionId: entry.sessionId,
      state: entry.follower.getState(),
      events: tail.events,
      hasMore: tail.hasMore,
      usage: entry.follower.getUsage(),
      permissionMode: entry.follower.getPermissionMode(),
      waitingFor: entry.waitingFor,
      openToolCall: entry.openToolCall,
      // Este snapshot es sincronico y describir un plan pide el disco. Quien
      // necesita los planes usa `subscribe`, que si puede esperar.
      plans: [],
    };
  }

  /**
   * Contenido de un plan de esta pestana.
   *
   * Se comprueba que el plan sea **de esta conversacion** antes de leerlo: el
   * nombre llega del cliente, y aunque salio de una lista que mando este mismo
   * servidor, un nombre que nadie nombro no se abre. Es el mismo criterio que
   * el guardia de rutas del panel de archivos (§6.3).
   */
  async readPlan(terminalId: TerminalId, fileName: string): Promise<PlanContent | null> {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return null;
    const plans = entry.adapter.history.plans;
    if (plans === null) return null;
    if (!entry.follower.getPlanFiles().includes(fileName)) return null;
    return plans.read(fileName);
  }

  /**
   * El modo de permiso en el que esta la pestana, para poder cambiarlo.
   *
   * Es la cuenta desde la que se calculan las pulsaciones. Mientras el archivo
   * no diga otra cosa vale con que se lanzo la pestana, que lo pone la propia
   * aplicacion en la linea de comandos (con Claude Code,
   * `--permission-mode auto`).
   *
   * null si nadie sigue la pestana todavia, o si su CLI no declara ciclo.
   * Quien cambia el modo completa con `permissionCycle.launchMode` de la CLI:
   * sin suscripcion, la pestana esta donde se lanzo.
   *
   * Lo que esto no puede saber: si el usuario ciclo con `shift+tab` en la
   * solapa CLI y la CLI todavia no escribio la linea que lo dice. Ahi el
   * calculo apunta a otro modo — se ve en la CLI, y el combo se corrige solo
   * en cuanto el archivo hable.
   */
  getPermissionMode(terminalId: TerminalId): PermissionMode | null {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return null;
    return entry.observedMode ?? entry.assumedMode;
  }

  /**
   * Anota a donde acabamos de llevar la pestana con `shift+tab`.
   *
   * Lo llama el socket despues de escribir las pulsaciones. Sin esto, dos
   * cambios seguidos sin un turno de por medio partirian los dos del mismo
   * lugar: el archivo no dice nada hasta que la CLI procesa un turno.
   */
  setPermissionMode(terminalId: TerminalId, mode: PermissionMode): void {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return;
    entry.assumedMode = mode;
    entry.observedMode = null;
    if (entry.announcedMode !== mode) {
      entry.announcedMode = mode;
      this.emit('mode', terminalId, mode);
    }
  }

  /**
   * La pregunta de eleccion que esta esperando respuesta, si hay alguna.
   *
   * **Se calcula al vuelo desde la cola, no se lleva apuntada.** Un estado
   * incremental habria que mantenerlo vivo a traves de los `reset` del
   * seguidor, y desincronizarlo significa mandarle teclas a un menu que ya no
   * esta abierto. Aca se pregunta una vez, cuando alguien responde.
   *
   * Se recorre desde el final: la ultima pregunta sin su `tool_result` es la
   * abierta. Si ya tiene resultado —porque se contesto desde la solapa CLI—
   * devuelve null, y esa es la unica defensa contra responder dos veces.
   */
  getPendingQuestion(terminalId: TerminalId): ConversationQuestionPart | null {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return null;

    const { events } = entry.follower.getTail(PENDING_QUESTION_LOOKBACK);
    const answered = new Set<string>();
    for (const event of events) {
      for (const part of event.parts) {
        if (part.kind === 'tool-result') answered.add(part.toolUseId);
      }
    }

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const parts = events[index]?.parts ?? [];
      for (let at = parts.length - 1; at >= 0; at -= 1) {
        const part = parts[at];
        if (part?.kind !== 'question') continue;
        return answered.has(part.toolUseId) ? null : part;
      }
    }
    return null;
  }

  /**
   * Aviso del watcher del historial de una CLI. Solo mira las sesiones de esa
   * CLI que alguien esta siguiendo.
   *
   * Que ruta es de que sesion lo decide el seguidor, y ahi vive tambien el
   * respaldo de re-apuntado: si todavia espera un archivo que no aparece y nace
   * uno con el nombre de su sesion en otra carpeta, ese es.
   */
  onHistoryChanged(agent: AgentId, filePath: string): void {
    for (const [terminalId, entry] of this.entries) {
      if (entry.agent === agent && entry.follower.noticeChange(filePath)) {
        this.schedulePoll(terminalId, entry);
      }
    }
  }

  /** Corta todo. Solo para el apagado del servidor. */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.stopFollowTicker(entry);
      entry.stopWatchingStatus?.();
    }
    this.entries.clear();
  }

  private schedulePoll(terminalId: TerminalId, entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      void this.runPoll(terminalId, entry, { silent: false });
    }, POLL_DEBOUNCE_MS);
    entry.timer.unref();
  }

  /**
   * Una lectura, encadenada a la anterior.
   *
   * `silent` es para la lectura inicial: ahi el resultado se devuelve en el
   * snapshot y avisar por evento seria mandar todo dos veces.
   */
  private runPoll(
    terminalId: TerminalId,
    entry: Entry,
    options: { silent: boolean },
  ): Promise<void> {
    const previousState = entry.follower.getState();

    entry.polling = entry.polling.then(async () => {
      // Puede haberse ido mientras esperaba su turno en la cadena.
      if (this.entries.get(terminalId) !== entry) return;

      let result;
      try {
        // Lo que la CLI tenga que rehacer antes de que se emita —con Claude
        // Code, releer la configuracion tras un `/model`— pasa adentro del
        // poll, para que el cliente no reciba primero el numero viejo.
        result = await entry.follower.poll();
      } catch (error) {
        // Un archivo ilegible no puede tumbar el seguimiento del resto.
        console.warn(`[conversacion] no se pudo leer ${entry.follower.label}:`, error);
        return;
      }

      /*
        Tambien en la lectura silenciosa: el snapshot que sale de ella lo lleva
        adentro, y el aviso suelto que puede salir aca antes es inofensivo —dice
        lo mismo que el snapshot que llega detras—.
      */
      this.refreshOpenToolCall(terminalId, entry);

      if (options.silent) return;

      /*
        El modo primero, porque el `append` lo lleva adentro y tiene que ir el
        de ahora: mandarlo despues dejaria al cliente con el viejo hasta el
        mensaje siguiente. Solo cuentan las lineas de una pasada no silenciosa
        (ver `observedMode`), y por eso esto vive debajo del `return` de arriba.
      */
      const observed = entry.follower.getPermissionMode();
      if (observed !== null) entry.observedMode = observed;
      const mode = entry.observedMode ?? entry.assumedMode;

      if (result.reset) {
        this.emit('reset', terminalId);
        return;
      }
      // Un `append` vacio si solo cambio el uso: los tokens de un paso llegan
      // al cerrarlo, despues de sus eventos (`PollResult.usageChanged`).
      if (result.added.length > 0 || result.usageChanged === true) {
        this.emit('append', terminalId, result.added, entry.follower.getUsage(), mode);
      }
      if (result.turns.length > 0) this.emit('turns', terminalId, result.turns);
      // Un plan nuevo: la solapa lo muestra sin que nadie tenga que recargar.
      const plans = entry.adapter.history.plans;
      if (result.plans.length > 0 && plans !== null) {
        this.emit('plans', terminalId, await plans.describe(entry.follower.getPlanFiles()));
      }
      if (result.parts.length > 0) this.emit('parts', terminalId, result.parts);

      // Y el aviso suelto, para el caso que no trae mensajes: uno cambia el
      // modo y quiere ver que cambio, sin escribirle nada al agente. Una CLI
      // sin ciclo no tiene modo que avisar.
      if (mode !== null && mode !== entry.announcedMode) {
        entry.announcedMode = mode;
        this.emit('mode', terminalId, mode);
      }

      const nextState = entry.follower.getState();
      if (nextState !== previousState) this.emit('state', terminalId, nextState);
    });

    return entry.polling;
  }
}
