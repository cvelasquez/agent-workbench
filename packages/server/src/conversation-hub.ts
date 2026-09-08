/**
 * Sigue las conversaciones de las pestanas que alguien esta mirando.
 *
 * Que archivo seguir no se adivina: el UUID de la sesion lo generamos nosotros
 * y se lo pasamos a la CLI con `--session-id`, asi que la ruta sale de una
 * cuenta (CLAUDE.md 4.8). El brief proponia observar el directorio y quedarse
 * con el `.jsonl` que apareciera despues del arranque: eso tiene una carrera en
 * cuanto hay dos pestanas del mismo proyecto.
 *
 * Igual queda un respaldo. Si la ruta calculada no aparece nunca y el watcher
 * ve nacer un archivo que se llama `<sessionId>.jsonl` en otra carpeta, el
 * seguimiento se muda ahi. Es barato y cubre que la CLI normalice el `cwd` de
 * una forma que no previmos.
 *
 * El seguimiento se prende y se apaga por demanda: solo la pestana que se esta
 * mirando tiene un follower vivo.
 */

import { EventEmitter } from 'node:events';
import path from 'node:path';
import {
  EMPTY_CONTEXT_USAGE,
  LAUNCH_PERMISSION_MODE,
  type ContextUsage,
  type ConversationEvent,
  type ConversationQuestionPart,
  type ConversationImageSource,
  type ConversationState,
  type PermissionMode,
  type SessionId,
  type TerminalId,
} from '@agent-workbench/shared';
import { readAgentDefaults } from './agent-defaults.js';
import type { CliStatusWatcher } from './cli-status.js';
import {
  ConversationFollower,
  type PartsUpdate,
  type TurnUpdate,
} from './conversation-follower.js';
import { loadConversationImage, type LoadedImage } from './conversation-image.js';
import { debugLog } from './debug.js';
import type { ModelVariantRegistry } from './model-variants.js';
import { sessionFilePath } from './paths.js';
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
}

interface Entry {
  sessionId: SessionId;
  follower: ConversationFollower;
  /** Ultimo modo avisado, para no repetir el aviso en cada pasada. */
  announcedMode: PermissionMode | null;
  /**
   * El modo al que nosotros llevamos la pestana, o el de arranque.
   *
   * La aplicacion lanza cada pty con `--permission-mode auto` (§4.8.1), asi
   * que el punto de partida no es una suposicion. A partir de ahi, lo unico
   * que lo mueve es un `shift+tab`: el del combo, que se anota aca, o el que
   * el usuario teclee en la solapa CLI, que llega por el archivo.
   */
  assumedMode: PermissionMode;
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
   * No sale del JSONL —ahi no esta— sino de `~/.claude/sessions/<pid>.json`.
   * Ver `cli-status.ts`.
   */
  waitingFor: string | null;
  /** Corta la suscripcion al vigilante de estado al soltar la pestana. */
  stopWatchingStatus: (() => void) | null;
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
     * Estado que la CLI publica por proceso. Es compartido con el registro de
     * terminales —uno solo para toda la app— porque el costo del sondeo esta en
     * listar el directorio y eso no crece con la cantidad de suscriptores.
     */
    private readonly cliStatus: CliStatusWatcher,
    /** Se le pasa a cada follower para resolver la variante del modelo. */
    private readonly modelVariants?: ModelVariantRegistry,
  ) {
    super();
  }

  /**
   * Engancha un cliente mas a la conversacion de una pestana y devuelve lo que
   * se sabe hasta ahora.
   */
  async subscribe(terminalId: TerminalId): Promise<ConversationSnapshot | null> {
    const descriptor = this.registry.get(terminalId);
    if (descriptor === null) return null;

    // Sin cwd no hay ruta que calcular, y una consola directamente no escribe
    // JSONL. Se dice, y no se crea un seguidor apuntando a una ruta inventada
    // que despues diria "esperando" para siempre.
    if (descriptor.cwd.length === 0 || descriptor.sessionId.length === 0) {
      return {
        sessionId: descriptor.sessionId,
        state: 'unavailable',
        events: [],
        hasMore: false,
        permissionMode: null,
        usage: { ...EMPTY_CONTEXT_USAGE },
        waitingFor: null,
      };
    }

    let entry = this.entries.get(terminalId);
    if (entry === undefined) {
      const filePath = sessionFilePath(descriptor.cwd, descriptor.sessionId);
      entry = {
        sessionId: descriptor.sessionId,
        follower: new ConversationFollower(filePath, this.modelVariants),
        announcedMode: null,
        assumedMode: LAUNCH_PERMISSION_MODE,
        observedMode: null,
        refs: 0,
        timer: null,
        polling: Promise.resolve(),
        waitingFor: null,
        stopWatchingStatus: null,
      };
      this.entries.set(terminalId, entry);
      this.watchStatus(terminalId, entry, descriptor.sessionId);
      // La variante que el archivo nunca dice. Se lee antes del primer poll
      // para que el medidor no muestre 200k un instante y 1M despues.
      await this.refreshConfigured(terminalId, entry);
      debugLog('conversacion', `sigo ${path.basename(filePath)} de ${terminalId.slice(0, 8)}`);
    }

    entry.refs += 1;

    // Primera lectura completa del archivo, si ya existe.
    await this.runPoll(terminalId, entry, { silent: true });

    const tail = entry.follower.getTail(INITIAL_EVENT_LIMIT);
    return {
      sessionId: entry.sessionId,
      state: entry.follower.getState(),
      events: tail.events,
      hasMore: tail.hasMore,
      usage: entry.follower.getUsage(),
      permissionMode: entry.observedMode ?? entry.assumedMode,
      waitingFor: entry.waitingFor,
    };
  }

  /**
   * Mira el estado que la CLI publica por proceso, para esta sesion.
   *
   * `waiting` solo se avisa cuando de verdad esta esperando: `busy` e `idle`
   * son estados normales y la conversacion ya los cuenta con lo que dibuja.
   */
  private watchStatus(terminalId: TerminalId, entry: Entry, sessionId: SessionId): void {
    entry.stopWatchingStatus = this.cliStatus.subscribe(sessionId, (status) => {
      const waitingFor = status !== null && status.status === 'waiting' ? status.waitingFor : null;
      // Sin etiqueta no se puede decir de que clase es, pero que espera si:
      // se avisa igual, con la copia generica.
      const next = status !== null && status.status === 'waiting' ? (waitingFor ?? 'unknown') : null;
      if (next === entry.waitingFor) return;
      entry.waitingFor = next;
      this.emit('waiting', terminalId, next);
    });
  }

  private release(terminalId: TerminalId, entry: Entry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
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
    return loadConversationImage(entry.follower.filePath, eventId, index, source);
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
    };
  }

  /**
   * El modo de permiso en el que esta la pestana, para poder cambiarlo.
   *
   * A diferencia de lo que viaja al cliente, esto **no** devuelve null: es la
   * cuenta desde la que se calculan los `shift+tab`, y sin un punto de partida
   * no hay forma de llegar a ninguna parte. Mientras el archivo no diga otra
   * cosa vale con que se lanzo la pestana, que lo pone la propia aplicacion en
   * la linea de comandos (`--permission-mode auto`).
   *
   * Lo que esto no puede saber: si el usuario ciclo con `shift+tab` en la
   * solapa CLI y la CLI todavia no escribio la linea que lo dice. Ahi el
   * calculo apunta a otro modo — se ve en la CLI, y el combo se corrige solo
   * en cuanto el archivo hable.
   */
  getPermissionMode(terminalId: TerminalId): PermissionMode {
    const entry = this.entries.get(terminalId);
    if (entry === undefined) return LAUNCH_PERMISSION_MODE;
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
   * Aviso del watcher. Solo mira las sesiones que alguien esta siguiendo.
   *
   * El respaldo de re-apuntado vive aca: si todavia esperamos un archivo que no
   * aparece y nace uno con el nombre de nuestra sesion en otra carpeta, ese es.
   */
  onFileChanged(filePath: string): void {
    const fileName = path.basename(filePath);

    for (const [terminalId, entry] of this.entries) {
      if (entry.follower.filePath === filePath) {
        this.schedulePoll(terminalId, entry);
        continue;
      }

      if (
        entry.follower.getState() === 'waiting' &&
        fileName.toLowerCase() === `${entry.sessionId.toLowerCase()}.jsonl`
      ) {
        console.warn(
          `[conversacion] la sesion ${entry.sessionId.slice(0, 8)} escribio en ${filePath}, no en la ruta calculada; me mudo ahi.`,
        );
        entry.follower = new ConversationFollower(filePath);
        this.schedulePoll(terminalId, entry);
      }
    }
  }

  /** Corta todo. Solo para el apagado del servidor. */
  disposeAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
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
  /**
   * Relee el modelo que declara la configuracion de la pestana.
   *
   * Son tres archivos chicos y solo se leen al abrir la conversacion o cuando
   * paso un `/model`, no en cada poll: la configuracion cambia cuando el
   * usuario la cambia, no cada 300 ms.
   */
  private async refreshConfigured(terminalId: TerminalId, entry: Entry): Promise<void> {
    const descriptor = this.registry.get(terminalId);
    if (descriptor === null || descriptor.cwd.length === 0) return;
    try {
      const defaults = await readAgentDefaults(descriptor.cwd);
      entry.follower.setConfiguredAlias(defaults.model);
    } catch {
      // Sin configuracion legible se sigue igual: es un dato de conveniencia.
    }
  }

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
        result = await entry.follower.poll();
      } catch (error) {
        // Un archivo ilegible no puede tumbar el seguimiento del resto.
        console.warn(`[conversacion] no se pudo leer ${entry.follower.filePath}:`, error);
        return;
      }

      // Un `/model` en el archivo significa que la configuracion pudo cambiar.
      // Se relee y se rehace la cuenta antes de emitir, para que el cliente no
      // reciba primero el numero viejo.
      if (entry.follower.takeConfiguredStale()) {
        await this.refreshConfigured(terminalId, entry);
        entry.follower.recomputeModel();
      }

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
      if (result.added.length > 0) {
        this.emit('append', terminalId, result.added, entry.follower.getUsage(), mode);
      }
      if (result.turns.length > 0) this.emit('turns', terminalId, result.turns);
      if (result.parts.length > 0) this.emit('parts', terminalId, result.parts);

      // Y el aviso suelto, para el caso que no trae mensajes: uno cambia el
      // modo y quiere ver que cambio, sin escribirle nada al agente.
      if (mode !== entry.announcedMode) {
        entry.announcedMode = mode;
        this.emit('mode', terminalId, mode);
      }

      const nextState = entry.follower.getState();
      if (nextState !== previousState) this.emit('state', terminalId, nextState);
    });

    return entry.polling;
  }
}
