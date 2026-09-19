/**
 * Transporte WebSocket.
 *
 * Ojo con el reparto de responsabilidades: este archivo NO es duenio de las
 * terminales. Solo traduce mensajes y engancha oyentes al registro. Si se cae
 * un socket, lo unico que pasa es que se quitan sus oyentes (CLAUDE.md 3.0).
 */

import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  WS_PATH,
  encodeServerMessage,
  parseClientMessage,
  serverText,
  type AgentDefaults,
  type ContextUsage,
  type PermissionMode,
  type ConversationEvent,
  type ConversationState,
  type GitStatus,
  type ImageReferenceStyle,
  type IndexStatus,
  type MemoryStatus,
  type ProjectSummary,
  type ServerErrorCode,
  type ServerErrorMessage,
  type ServerMessage,
  type ServerText,
  type SessionPlan,
  type TerminalActivity,
  type TerminalOfflineReason,
  type TerminalId,
} from '@agent-workbench/shared';
import type { AgentAdapter, AgentInput, PartsUpdate } from './agents/adapter.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ArchivedSessions } from './archived-sessions.js';
import { DirectoryPickerError, DirectoryPickers } from './directory-picker.js';
import { MemoryBridgeError } from './memory-bridge.js';
import { UnknownTerminalError, type MemoryHub } from './memory-hub.js';
import { NotesError, type NotesStore } from './notes-store.js';
import type { ConversationHub } from './conversation-hub.js';
import { debugLog } from './debug.js';
import { listDirectory, readPreview, searchFiles } from './file-browser.js';
import { readDiff } from './git-repo.js';
import { GlobalSearchSlot } from './global-search.js';
import { deliverWhenReady, prefillReasonFor, type DeliverDeps } from './deliver-when-ready.js';
import { HANDOFF_DELIVERY_TIMEOUT_MS, continueSession, type ContinueDeps } from './handoff/handoff.js';
import { InvalidPathError, resolveInside } from './path-guard.js';
import { attachmentLine, attachmentReference, textWithAttachments } from './attachments.js';
import {
  PasteFileError,
  PasteImageError,
  PasteStore,
  MAX_FILES_PER_SUBMIT,
  MAX_IMAGES_PER_SUBMIT,
} from './paste-store.js';
import {
  ANSWER_INVALID_TEXT,
  ANSWER_KEY_INTERVAL_MS,
  ANSWER_NOT_PENDING_TEXT,
  answerFailureText,
  buildAnswerKeys,
  buildInterruptKeys,
  buildSubmissionWrites,
  planModeChange,
  submitRefusal,
  submitStartDelayMs,
} from './pty-input.js';
import type { RepoHub } from './repo-hub.js';
import { revealPath } from './reveal.js';
import type { SessionIndex } from './session-index.js';
import type { ShellLocation } from './shell-locator.js';
import { TerminalOpenError, type OutputListener, type TerminalRegistry } from './terminal-registry.js';
import { TerminalWriteQueue, type PieceWriter } from './terminal-write-queue.js';
import { VaultError, type VaultService } from './vault/service.js';
import { rejectRequest } from './security.js';

/**
 * Cuanto se espera a que arranque la CLI de una pestana recien abierta antes de
 * mandarle una nota.
 *
 * Medido con una pty propia: la CLI se declara `idle` a los 2 o 3 segundos de
 * lanzarse. Quince deja margen para una maquina cargada sin que el usuario se
 * quede mirando un boton que no dice nada.
 */
const NOTE_SEND_TIMEOUT_MS = 15_000;

/** Lo que se anuncia cuando no hay configuracion que leer. */
const NO_DEFAULTS: AgentDefaults = { model: null, effort: null, contextWindow: null };

/**
 * Como se escribe un envio en una pestana sin CLI conocida: el texto en un solo
 * pegado con el Enter al final, sin imagenes. Es lo que se hacia con cualquier
 * pestana antes de que cada CLI declarara su forma.
 */
const PLAIN_INPUT: AgentInput = {
  imageReference: null,
  pieceGapMs: 0,
  pasteMarkers: true,
  enterSeparately: false,
  interruptPresses: 1,
  transcriptReference: 'quoted-path',
};

export interface TerminalSocketOptions {
  httpServer: HttpServer;
  port: number;
  token: string;
  shell: ShellLocation | null;
  registry: TerminalRegistry;
  index: SessionIndex;
  archived: ArchivedSessions;
  notes: NotesStore;
  conversations: ConversationHub;
  repos: RepoHub;
  /** Memoria compartida del proyecto de cada pestana (`memory.*`). */
  memory: MemoryHub;
  /**
   * Las CLIs registradas. Se anuncian en `hello`, y de la de cada pestana sale
   * lo que esa pestana puede hacer: cada accion que la CLI no declara se
   * rechaza con `agent-unsupported` antes de escribir nada en la pty.
   */
  agents: AgentRegistry;
  defaultCwd: string;
  /** Donde aterrizan las imagenes pegadas. Inyectable para las pruebas. */
  pasteStore?: PasteStore;
  /** La copia propia (`vault.*`, hito 28). */
  vault: VaultService;
}

export function attachTerminalSocket(options: TerminalSocketOptions): () => void {
  const {
    httpServer,
    port,
    token,
    shell,
    registry,
    index,
    archived,
    notes,
    conversations,
    repos,
    memory,
    agents,
    defaultCwd,
    vault,
  } = options;

  const pasteStore = options.pasteStore ?? new PasteStore();

  /*
    Una fila de escrituras por terminal, compartida por todos los sockets: lo
    que dos ventanas le mandan a la misma pestana tambien se turna. Ver
    `terminal-write-queue.ts`.
  */
  const writeQueue = new TerminalWriteQueue();

  // noServer: manejamos el upgrade a mano para no pisarnos con el WebSocket de
  // HMR de Vite, que vive en el mismo servidor HTTP.
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  const send = (socket: WebSocket, message: ServerMessage): void => {
    if (socket.readyState === socket.OPEN) socket.send(encodeServerMessage(message));
  };

  const broadcast = (message: ServerMessage): void => {
    const payload = encodeServerMessage(message);
    for (const socket of clients) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  /** A todos menos uno: el que tecleo una nota no necesita el eco. */
  const broadcastExcept = (except: WebSocket, message: ServerMessage): void => {
    const payload = encodeServerMessage(message);
    for (const socket of clients) {
      if (socket !== except && socket.readyState === socket.OPEN) socket.send(payload);
    }
  };

  const sendError = (
    socket: WebSocket,
    code: ServerErrorCode,
    text: ServerText,
    detail?: string,
    requestId?: string,
  ): void => {
    // El texto va como clave y la web arma la frase en su idioma (§6.23).
    const payload: ServerErrorMessage = { type: 'error', code, text };
    if (detail !== undefined) payload.detail = detail;
    if (requestId !== undefined) payload.requestId = requestId;
    send(socket, payload);
  };

  /** Le pone a una respuesta el `requestId` del pedido, si lo trajo. */
  const withRequestId = <T extends ServerMessage & { requestId?: string }>(
    message: T,
    requestId: string | undefined,
  ): T => {
    if (requestId !== undefined) message.requestId = requestId;
    return message;
  };

  /** El adaptador de la CLI de una pestana de agente, o null. */
  const adapterOf = (terminalId: TerminalId): AgentAdapter | null => {
    const descriptor = registry.get(terminalId);
    if (descriptor === null || descriptor.kind !== 'agent' || descriptor.agent === null) return null;
    return agents.get(descriptor.agent)?.adapter ?? null;
  };

  /**
   * Como nombra imagenes la CLI de una pestana, o null despues de avisar por
   * que no se pueden mandar.
   *
   * Se pregunta **antes** de guardar nada en disco: una imagen que la CLI no va
   * a recibir no tiene por que dejar un temporal.
   */
  const imageStyleFor = (
    socket: WebSocket,
    terminalId: TerminalId,
    unsupported: ServerText,
  ): ImageReferenceStyle | null => {
    if (registry.get(terminalId) === null) {
      sendError(socket, 'unknown-terminal', serverText('terminalGone'));
      return null;
    }
    const style = adapterOf(terminalId)?.input.imageReference ?? null;
    if (style === null) sendError(socket, 'agent-unsupported', unsupported);
    return style;
  };

  /** Como se le escribe un envio a la CLI de una pestana. */
  const inputOf = (terminalId: TerminalId): AgentInput => adapterOf(terminalId)?.input ?? PLAIN_INPUT;

  const terminalListMessage = (): ServerMessage => ({
    type: 'terminal.list',
    terminals: registry.list(),
    order: registry.getOrder(),
  });

  /** La lista de CLIs fuera del `hello`: lo que anuncia una puede cambiar con el servidor andando. */
  const agentsMessage = (): ServerMessage => ({
    type: 'agents',
    agents: agents.list(),
    defaultAgent: agents.defaultAgent(),
  });

  /**
   * Escribe en una pty y explica bien cuando no se puede.
   *
   * Desde el hito 21 hay pestanas **sin proceso** —las que devuelve una
   * restauracion, y las que murieron con Ctrl+C— y para esas "la terminal ya no
   * existe" es falso: la pestana esta ahi, se lee, y lo que falta es la CLI.
   * El cliente distingue los dos casos por el codigo y ofrece abrirla.
   */
  const writeToTerminal = (socket: WebSocket, terminalId: TerminalId, data: string): boolean => {
    if (registry.write(terminalId, data)) return true;
    if (registry.get(terminalId) === null) {
      sendError(socket, 'unknown-terminal', serverText('terminalGone'));
    } else {
      sendError(socket, 'terminal-asleep', serverText('terminalAsleep'));
    }
    return false;
  };

  // ---- eventos del registro y del indice, hacia todos los clientes ----

  const onRegistryChanged = (): void => broadcast(terminalListMessage());

  const onRegistryExit = (
    terminalId: TerminalId,
    exitCode: number,
    signal: number | null,
  ): void => broadcast({ type: 'terminal.exit', terminalId, exitCode, signal });

  /*
    Que esta haciendo la CLI de cada pestana. Va a todos los clientes y no solo
    al que mira esa pestana: lo dibuja la barra de pestanas, que las muestra
    todas a la vez.
  */
  const onRegistryActivity = (
    terminalId: TerminalId,
    activity: TerminalActivity,
    offlineReason: TerminalOfflineReason | null,
  ): void =>
    broadcast(
      offlineReason === null
        ? { type: 'terminal.activity', terminalId, activity }
        : { type: 'terminal.activity', terminalId, activity, offlineReason },
    );

  const onIndexStatus = (status: IndexStatus): void =>
    broadcast({ type: 'index.status', status });
  const onIndexProjects = (projects: ProjectSummary[], replace: boolean): void =>
    broadcast({ type: 'index.projects', projects, replace });

  // Los eventos de conversacion se difunden con el terminalId puesto y cada
  // cliente descarta los que no esta mirando. Es el mismo criterio que la
  // salida de las terminales: el filtro vive en el cliente.
  const onConversationAppend = (
    terminalId: TerminalId,
    events: ConversationEvent[],
    usage: ContextUsage,
    permissionMode: PermissionMode | null,
  ): void => {
    broadcast({ type: 'conversation.append', terminalId, events, usage, permissionMode });
    // Si el agente escribio en el JSONL, es probable que acabe de tocar
    // archivos. Es el refresco del panel de cambios "al terminar un turno".
    repos.onConversationActivity(terminalId);
  };

  const onGitStatus = (terminalId: TerminalId, status: GitStatus): void =>
    broadcast({ type: 'git.status', terminalId, status });

  const onMemoryStatus = (terminalId: TerminalId, status: MemoryStatus): void =>
    broadcast({ type: 'memory.status', terminalId, status });

  const onConversationState = (terminalId: TerminalId, state: ConversationState): void =>
    broadcast({ type: 'conversation.state', terminalId, state });

  const onConversationMode = (terminalId: TerminalId, mode: PermissionMode): void =>
    broadcast({ type: 'conversation.mode', terminalId, mode });

  /*
    La CLI empezo —o dejo— de esperar algo del usuario. No sale del JSONL: ahi
    un permiso pendiente no deja ninguna linea mientras espera.
  */
  const onConversationWaiting = (terminalId: TerminalId, waitingFor: string | null): void =>
    broadcast({ type: 'conversation.waiting', terminalId, waitingFor });

  /*
    Una CLI que no publica su estado abrio —o cerro— una llamada a herramienta.
    El cuadro de escritura lo usa para no dejar apretar Enviar mientras puede
    haber un menu de aprobacion esperando (A1 del hito 25).
  */
  const onConversationToolCall = (terminalId: TerminalId, open: boolean): void =>
    broadcast({ type: 'conversation.toolCall', terminalId, open });

  const onConversationPlans = (terminalId: TerminalId, plans: SessionPlan[]): void =>
    broadcast({ type: 'conversation.plans', terminalId, plans });

  const onConversationTurns = (
    terminalId: TerminalId,
    turns: { eventId: string; durationMs: number }[],
  ): void => broadcast({ type: 'conversation.turns', terminalId, turns });

  /*
    Un mensaje al que se le agrego la imagen que la CLI adjunto en la linea
    siguiente. Igual que las duraciones: llega despues del mensaje, y casi
    siempre pegado a el.
  */
  const onConversationParts = (terminalId: TerminalId, updates: PartsUpdate[]): void =>
    broadcast({ type: 'conversation.parts', terminalId, updates });

  /**
   * Modelo y esfuerzo que la configuracion anuncia para una pestana.
   *
   * Se lee en cada reset y no se cachea: son tres archivos chicos y un reset es
   * raro (suscribirse, o que el archivo de sesion se reemplace). Cachearlo
   * dejaria el combo mintiendo hasta reiniciar si el usuario edita su
   * configuracion.
   *
   * La lee el adaptador de la CLI de la pestana. Una consola no tiene CLI y no
   * anuncia nada: el cuadro de escritura solo se dibuja para pestanas de agente.
   */
  const defaultsFor = async (terminalId: TerminalId): Promise<AgentDefaults> => {
    const descriptor = registry.get(terminalId);
    const adapter = adapterOf(terminalId);
    if (descriptor === null || adapter === null) return NO_DEFAULTS;
    return (await adapter.defaults(descriptor.cwd)) ?? NO_DEFAULTS;
  };

  /**
   * Lo que escribe cada pieza de un trabajo de la fila.
   *
   * Si la pestana desaparece a mitad, la fila corta ahi y se avisa una sola
   * vez: seguir escribiendo en una terminal que ya no esta no arregla nada.
   */
  const pieceWriter =
    (socket: WebSocket, terminalId: TerminalId): PieceWriter =>
    (piece) =>
      writeToTerminal(socket, terminalId, piece);

  /**
   * Cierra una pestana y suelta todo lo que la seguia, para todos: el hub, git,
   * la memoria y lo que se pego en ella. Lo usan `terminal.close` y una
   * continuacion que abrio su pestana y no llego a servir. false si ya no estaba.
   */
  const dropTab = (terminalId: TerminalId): boolean => {
    if (!registry.close(terminalId)) return false;
    // Sin pestana no hay nada que seguir, la mire quien la mire.
    conversations.drop(terminalId);
    repos.drop(terminalId);
    memory.drop(terminalId);
    // Las imagenes que se pegaron en esta pestana ya no le sirven a nadie: la
    // conversacion que las nombraba se fue con ella. Y el transcript de una
    // continuacion, tampoco (hito 29, D17).
    void pasteStore.clearTerminal(terminalId);
    broadcast({ type: 'terminal.closed', terminalId });
    return true;
  };

  /**
   * Mandarle un texto a la CLI de una pestana cuando esta lista: una nota, o la
   * continuacion de una conversacion (hito 29, M3). Ver `deliver-when-ready.ts`.
   */
  const deliverDeps: DeliverDeps = {
    describe: (terminalId) => registry.get(terminalId),
    onChanged: (listener) => {
      registry.on('changed', listener);
      return () => {
        registry.off('changed', listener);
      };
    },
    adapterOf,
    saveImage: async (terminalId, mediaType, data) => (await pasteStore.save(terminalId, mediaType, data)).path,
    noteSubmitted: (terminalId, text) => registry.noteSubmitted(terminalId, text),
    enqueue: (terminalId, job, enqueueOptions) => writeQueue.enqueue(terminalId, job, enqueueOptions),
  };

  /** Lo que la continuacion en otra CLI usa del servidor (hito 29). */
  const continueDeps: ContinueDeps = {
    registry,
    closeTab: (terminalId) => {
      dropTab(terminalId);
    },
    agents,
    index,
    pasteStore,
    // La copia propia, si tiene la sesion y sirve (D15). Con la copia apagada y
    // vacia no encuentra nada y lee el seguidor de la CLI.
    archive: { events: (agent, sessionId) => vault.handoffEvents(agent, sessionId) },
  };

  /** El archivo se reemplazo: hay que rehacer la vista, no agregarle nada. */
  const onConversationReset = (terminalId: TerminalId): void => {
    const snapshot = conversations.getSnapshot(terminalId);
    if (snapshot === null) return;
    void defaultsFor(terminalId).then((defaults) => {
      broadcast({
        type: 'conversation.reset',
        terminalId,
        sessionId: snapshot.sessionId,
        state: snapshot.state,
        events: snapshot.events,
        hasMore: snapshot.hasMore,
        usage: snapshot.usage,
        permissionMode: snapshot.permissionMode,
        defaults,
        waitingFor: snapshot.waitingFor,
        // El de ahora y no el del snapshot: leer la configuracion es asincrono,
        // y un aviso que salio mientras tanto no puede quedar pisado por uno viejo.
        openToolCall: conversations.isToolCallOpen(terminalId),
      });
    });
  };

  registry.on('changed', onRegistryChanged);
  registry.on('exit', onRegistryExit);
  registry.on('activity', onRegistryActivity);
  index.on('status', onIndexStatus);
  index.on('projects', onIndexProjects);
  conversations.on('append', onConversationAppend);
  conversations.on('state', onConversationState);
  conversations.on('reset', onConversationReset);
  conversations.on('mode', onConversationMode);
  conversations.on('waiting', onConversationWaiting);
  conversations.on('toolCall', onConversationToolCall);
  conversations.on('turns', onConversationTurns);
  conversations.on('plans', onConversationPlans);
  conversations.on('parts', onConversationParts);
  repos.on('status', onGitStatus);
  memory.on('status', onMemoryStatus);

  /*
    El usuario configuro —o quito— la status line de una CLI con la app abierta:
    cambian sus capacidades, y todas las ventanas tienen que dibujar lo nuevo sin
    recargar. Solo sondea la configuracion de las CLIs encontradas; con Claude
    Code sola no corre nada (hito 27, M6).
  */
  const stopAgentChanges = agents.subscribeChanges(() => broadcast(agentsMessage()));

  // La copia propia avisa a todas las ventanas, y el servicio ya espacia los avisos.
  const stopVaultStatus = vault.onStatus((status) => broadcast({ type: 'vault.status', status }));

  /**
   * Un pedido `vault.*` que fallo. Un `VaultError` trae el texto para el
   * usuario; cualquier otra cosa es un error de disco o de lectura, que va en
   * el detalle.
   */
  const sendVaultError = (socket: WebSocket, error: unknown): void => {
    if (error instanceof VaultError) {
      sendError(socket, 'vault-failed', error.text);
      return;
    }
    const detail = error instanceof Error ? error.message : String(error);
    console.warn('[vault] a request failed:', detail);
    sendError(socket, 'vault-failed', serverText('vaultFailed'), detail);
  };

  // ---- upgrade ----

  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`)
        .pathname;
    } catch {
      return;
    }

    // Cualquier otra ruta es de Vite. Si destruimos el socket aca, rompemos el HMR.
    if (pathname !== WS_PATH) return;

    const rejection = rejectRequest(request, port, token);
    if (rejection !== null) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      console.warn(`[security] upgrade rejected on ${WS_PATH}: ${rejection}`);
      return;
    }

    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit('connection', client, request);
    });
  };

  httpServer.on('upgrade', onUpgrade);

  // ---- conexiones ----

  wss.on('connection', (socket: WebSocket) => {
    clients.add(socket);

    // Un oyente por socket. Se engancha y desengancha de terminales concretas
    // sin que ninguna se entere de que hubo una reconexion.
    const listener: OutputListener = (terminalId, chunk) => {
      send(socket, { type: 'terminal.output', terminalId, data: chunk });
    };

    // Conversaciones y repos que sigue **este** socket. Se sueltan al cerrarse,
    // para que el seguimiento se apague cuando no queda nadie mirando.
    const subscriptions = new Set<TerminalId>();
    const gitSubscriptions = new Set<TerminalId>();
    const memorySubscriptions = new Set<TerminalId>();
    /*
      Los selectores de carpeta son **de este socket** y mueren con el. No hay
      nada que sobreviva a la conexion que los pidio: sin `pickerId` vivo, el
      servidor no lista nada.
    */
    const pickers = new DirectoryPickers(agents.protectedDirs());
    /** La busqueda global en curso de este socket: una nueva o el cierre la cancelan. */
    const globalSearch = new GlobalSearchSlot();

    /**
     * `cwd` de una pestana viva.
     *
     * Toda ruta que llega del cliente se resuelve contra esto. Si la pestana ya
     * no existe, no hay `cwd` contra el cual validar y la peticion se rechaza:
     * nunca se cae a un directorio por defecto.
     */
    const cwdOf = (terminalId: TerminalId): string | null => {
      const descriptor = registry.get(terminalId);
      if (descriptor === null || descriptor.cwd.length === 0) return null;
      return descriptor.cwd;
    };

    const sendPathError = (error: unknown, fallback: ServerText): void => {
      if (error instanceof InvalidPathError) {
        sendError(socket, 'invalid-path', error.text);
        return;
      }
      sendError(
        socket,
        'read-failed',
        fallback,
        error instanceof Error ? error.message : String(error),
      );
    };

    const sendNotesError = (error: unknown): void => {
      if (error instanceof NotesError) {
        sendError(socket, 'notes-failed', error.text);
        return;
      }
      sendError(
        socket,
        'internal',
        serverText('noteSaveFailed'),
        error instanceof Error ? error.message : String(error),
      );
    };

    /**
     * Errores de `memory.*`. Lo que rechaza el guardia de rutas es
     * `invalid-path`; lo demas, `memory-failed` con su mensaje, que el puente
     * escribe para mostrarse tal cual.
     */
    const sendMemoryError = (error: unknown, requestId: string | undefined): void => {
      if (error instanceof UnknownTerminalError) {
        sendError(socket, 'unknown-terminal', serverText('terminalGone'), undefined, requestId);
        return;
      }
      if (error instanceof InvalidPathError) {
        sendError(socket, 'invalid-path', error.text, undefined, requestId);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      sendError(
        socket,
        'memory-failed',
        error instanceof MemoryBridgeError ? error.text : serverText('operationFailed', { detail }),
        detail,
        requestId,
      );
    };

    send(socket, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      agents: agents.list(),
      defaultAgent: agents.defaultAgent(),
      platform: process.platform,
      defaultCwd,
      shellName: shell?.name ?? null,
    });
    send(socket, terminalListMessage());
    /*
      Lo que ya se sabe de cada pestana. La actividad viaja por evento, y sin
      esto una recarga dejaba sin punto a toda pestana que no cambiara de estado
      despues —con una CLI que no publica su estado, para siempre—.
    */
    for (const entry of registry.activitySnapshot()) {
      send(socket, { type: 'terminal.activity', ...entry });
    }
    send(socket, { type: 'index.status', status: index.getStatus() });
    send(socket, { type: 'index.projects', projects: index.getProjects(), replace: true });
    send(socket, { type: 'notes.list', notes: notes.list() });
    send(socket, { type: 'vault.status', status: vault.status() });

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(raw as Buffer).toString('utf8');

      const message = parseClientMessage(text);
      if (message === null) {
        debugLog('socket', `message rejected: ${text.slice(0, 160)}`);
        sendError(socket, 'bad-message', serverText('badMessage'));
        return;
      }
      if (message.type !== 'input') debugLog('socket', `received ${message.type}`);

      switch (message.type) {
        case 'input':
          // Sin filtrar: Ctrl+V, Alt+V, Esc Esc y compania tienen que llegar
          // intactos o la CLI pierde funcionalidad.
          writeToTerminal(socket, message.terminalId, message.data);
          break;

        /*
          Un mensaje del cuadro de escritura.

          Va aparte de `input` porque no son teclas: hay que guardar las
          imagenes en disco antes de poder nombrarlas, y eso es asincrono. El
          orden importa —las rutas se arman en el orden en que se pegaron— asi
          que las escrituras van en serie y no en paralelo.

          Y va por la fila de la terminal, guardado de imagenes incluido: un
          mensaje con una captura que tarda en guardarse no puede quedar detras
          del que se mando despues.
        */
        case 'agent.submit': {
          const { terminalId, text, images } = message;
          const files = message.files ?? [];
          if (files.length > MAX_FILES_PER_SUBMIT) {
            sendError(
              socket,
              'submit-failed',
              serverText('filesPerMessage', { max: MAX_FILES_PER_SUBMIT }),
            );
            break;
          }
          if (images.length > MAX_IMAGES_PER_SUBMIT) {
            sendError(
              socket,
              'submit-failed',
              serverText('imagesPerMessage', { max: MAX_IMAGES_PER_SUBMIT }),
            );
            break;
          }
          // Sin imagenes no hay nada que comprobar: el texto va igual.
          if (
            images.length > 0 &&
            imageStyleFor(socket, terminalId, serverText('imagesUnsupported')) === null
          ) {
            break;
          }

          /*
            Una pestana cuyo estado no se ve puede estar mostrando un menu de
            aprobacion sin que la app lo sepa, y ahi el mensaje llegaria como
            teclas: el Enter final aprueba, y un texto que empieza con la letra
            de "aprobar siempre" aprueba para toda la sesion (A1 del hito 25).
            Lo unico que se ve desde aca es una llamada a herramienta de este
            proceso que todavia no tiene resultado, y con eso no se escribe nada.
            Antes de encolar: un rechazo no tiene por que esperar su turno.

            "No se ve" es por pestana, no por CLI (R27-1 del hito 27): la que
            publica su estado solo con algo configurado, y no publico nada, esta
            igual de ciega que la que no lo publica nunca.
          */
          const submitting = adapterOf(terminalId);
          const isBlind = (): boolean =>
            submitting !== null && conversations.isBlindToApprovals(terminalId, submitting);
          /*
            Y una CLI cuya confirmacion abierta aprueba lo que llegue (hito 27,
            R27-2): con el menu de permiso abierto, el Enter aparte del mensaje
            cae sobre la opcion resaltada. Aca la app si sabe que hay un menu —lo
            publica la CLI— y no escribe, por lo mismo que el combo de modo no
            cicla (D16). Con Claude Code la capacidad es false y no cambia nada.
          */
          const guardsPending = submitting?.capabilities.permissionCycle?.approvesPendingOnCycle === true;
          /*
            Y una CLI que declara que su espera bloquea el cuadro (hito 29, D12:
            OpenCode por `serve`). La actividad es la del registro, que la sigue
            siempre; la del hub solo existe con alguien mirando la conversacion.
          */
          const blocksWhileWaiting = submitting?.capabilities.waitingBlocksSubmit === true;
          if (submitting !== null) {
            const launchedAt = registry.launchedAtOf(terminalId);
            const blind = isBlind();
            const refusal = submitRefusal({
              label: submitting.label,
              approvesPendingOnCycle: guardsPending,
              waitingFor: conversations.getWaitingFor(terminalId),
              waitingBlocksSubmit: blocksWhileWaiting,
              activity: registry.activityOf(terminalId),
              blind,
              openToolCall: blind && launchedAt !== null && conversations.hasOpenToolCall(terminalId, launchedAt),
            });
            if (refusal !== null) {
              sendError(socket, 'submit-failed', refusal);
              break;
            }
          }
          /*
            Y otra vez antes de cada pieza, leyendo el archivo en el momento.
            Entre este chequeo y el Enter pasan el guardado de las imagenes, lo
            que hubiera delante en la fila y 400 ms por pieza: con ocho imagenes,
            casi cuatro segundos en los que la CLI puede abrir un menu. Si abre
            uno, lo que falta —el Enter sobre todo— no se escribe. La ceguera se
            vuelve a preguntar en cada pieza: la status line puede empezar a
            publicar a mitad del envio.
          */
          const approvalGuard =
            submitting !== null && (guardsPending || blocksWhileWaiting || isBlind())
              ? async (): Promise<boolean> => {
                  const current = registry.launchedAtOf(terminalId);
                  // Sin proceso no hay menu: la escritura la rechaza la terminal.
                  if (current === null) return true;
                  // D12: el estado llega por eventos, y el registro ya tiene el ultimo.
                  if (blocksWhileWaiting && registry.activityOf(terminalId) === 'waiting') return false;
                  if (isBlind() && (await conversations.checkOpenToolCall(terminalId, current))) return false;
                  return !guardsPending || (await conversations.checkWaitingFor(terminalId)) === null;
                }
              : undefined;

          const input = inputOf(terminalId);
          const interrupted = (): void =>
            sendError(socket, 'submit-failed', serverText('submitInterrupted'));
          void writeQueue.enqueue(
            terminalId,
            async (lane) => {
              const imagePaths: string[] = [];
              try {
                for (const image of images) {
                  const stored = await pasteStore.save(terminalId, image.mediaType, image.data);
                  imagePaths.push(stored.path);
                }
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                sendError(
                  socket,
                  'submit-failed',
                  error instanceof PasteImageError ? error.text : serverText('pasteImageFailed'),
                  detail,
                );
                return;
              }

              /*
                Los archivos adjuntos (hito 33, §6.21), despues de las imagenes
                y en el mismo turno de la fila. Se nombran por ruta dentro del
                texto, con la forma que esa CLI ya usa para el transcript de una
                continuacion (D18): no hace falta una capacidad, las cuatro la
                declaran.
              */
              const attachmentLines: string[] = [];
              try {
                for (const file of files) {
                  const stored = await pasteStore.saveAttachment(terminalId, file.name, file.data);
                  attachmentLines.push(
                    attachmentLine(file.name, stored.bytes, attachmentReference(stored.path, input.transcriptReference)),
                  );
                }
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                sendError(
                  socket,
                  'submit-failed',
                  error instanceof PasteFileError ? error.text : serverText('attachmentSaveFailed'),
                  detail,
                );
                return;
              }
              const fullText = textWithAttachments(text, attachmentLines);

              const pieces = buildSubmissionWrites(fullText, imagePaths, input, {
                send: message.send !== false,
              });
              // Un cuadro vacio no le manda un Enter a la CLI.
              if (pieces === null) return;
              // Antes de la primera escritura: quien busca la sesion por este
              // texto no puede encontrar el archivo de la CLI antes que el texto.
              // Con adjuntos es el texto entero: es lo que la CLI va a guardar.
              registry.noteSubmitted(terminalId, fullText);
              // Un envio justo despues de lanzar espera a que la CLI dibuje su
              // pantalla: lo que llega antes se pierde (hito 35, §10.11).
              const startAfterMs = submitStartDelayMs(
                registry.launchedAtOf(terminalId),
                Date.now(),
                input.readyAfterLaunchMs ?? 0,
              );
              const outcome = await lane.writePieces(
                pieces,
                input.pieceGapMs,
                pieceWriter(socket, terminalId),
                approvalGuard,
                { startAfterMs },
              );
              if (outcome === 'interrupted') interrupted();
              if (outcome === 'blocked') {
                const waitingNow = blocksWhileWaiting && registry.activityOf(terminalId) === 'waiting';
                sendError(
                  socket,
                  'submit-failed',
                  waitingNow
                    ? submitting === null
                      ? serverText('submitStoppedWaitingNoLabel')
                      : serverText('submitStoppedWaiting', { label: submitting.label })
                    : submitting === null
                      ? serverText('submitStoppedToolNoLabel')
                      : serverText('submitStoppedTool', { label: submitting.label }),
                );
              }
            },
            { onDropped: interrupted },
          );
          break;
        }

        /*
          Una respuesta a la pregunta de eleccion que la CLI tiene abierta.

          Lo que llega son indices contra la pregunta que este mismo servidor
          mando; las teclas las arma `buildAnswerKeys`. Se comprueban las dos
          cosas antes de escribir nada, porque escribir de mas en una pty no se
          deshace: que la pregunta abierta sea **esta** —si no, el usuario ya
          contesto desde la solapa CLI y los numeros entrarian en el prompt— y
          que lo elegido case con su forma.
        */
        case 'agent.answer': {
          // Una CLI cuyas preguntas no se contestan con esta secuencia no
          // recibe ninguna tecla: se contesta en su solapa CLI.
          const answering = adapterOf(message.terminalId);
          if (answering !== null && !answering.capabilities.questionCards) {
            sendError(
              socket,
              'agent-unsupported',
              serverText('answersUnsupported'),
            );
            break;
          }
          /*
            Una CLI que contesta por su API (hito 29, D10: OpenCode por
            `serve`). No escribe en la pty, y por eso va fuera de la fila de
            escritura: una respuesta no tiene que esperar a que termine de
            pegarse un mensaje. La pregunta abierta la confirma la propia CLI en
            el momento, con la carpeta de la pestana (A1); un fallo al mandar
            (una version sin esa ruta, el `serve` caido) tambien es
            `answer-failed`, y la tarjeta se reabre.
          */
          const channel = answering?.questions;
          if (channel !== undefined) {
            const descriptor = registry.get(message.terminalId);
            if (descriptor === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              break;
            }
            const { terminalId, toolUseId, selections } = message;
            void (async () => {
              try {
                const failure = answerFailureText(
                  await channel.answer({ cwd: descriptor.cwd, sessionId: descriptor.sessionId }, toolUseId, selections),
                );
                if (failure !== null) sendError(socket, 'answer-failed', failure);
              } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                debugLog('socket', `API answer in ${terminalId.slice(0, 8)}: ${error instanceof Error ? error.name : 'error'}`);
                sendError(
                  socket,
                  'answer-failed',
                  serverText('answerSendFailed'),
                  detail,
                );
              }
            })();
            break;
          }

          const interruptedAnswer = (): void =>
            sendError(socket, 'answer-failed', serverText('answerInterrupted'));
          /*
            La comprobacion va dentro del turno de la fila, justo antes de
            escribir: si habia algo mandandose delante, la pregunta pudo
            cerrarse mientras tanto.
          */
          void writeQueue.enqueue(
            message.terminalId,
            async (lane) => {
              const pending = conversations.getPendingQuestion(message.terminalId);
              if (pending === null || pending.toolUseId !== message.toolUseId) {
                sendError(socket, 'answer-failed', ANSWER_NOT_PENDING_TEXT);
                return;
              }

              const keys = buildAnswerKeys(
                pending.questions.map((question) => ({
                  multiSelect: question.multiSelect,
                  optionCount: question.options.length,
                })),
                message.selections,
              );
              if (keys === null) {
                sendError(socket, 'answer-failed', ANSWER_INVALID_TEXT);
                return;
              }
              /*
                Las teclas van espaciadas, y no es cortesia: mandadas en un solo
                write el menu de la CLI se queda a mitad y no responde nada
                (medido; ver `ANSWER_KEY_INTERVAL_MS`). Una interrupcion corta
                las que faltan: despues de un Esc el menu ya no esta, y los
                numeros entrarian sueltos en el prompt.
              */
              const outcome = await lane.writePieces(
                keys,
                ANSWER_KEY_INTERVAL_MS,
                pieceWriter(socket, message.terminalId),
              );
              if (outcome === 'interrupted') interruptedAnswer();
            },
            { onDropped: interruptedAnswer },
          );
          break;
        }

        /*
          Cambiar el modo de permiso de la pestana.

          No hay comando de barra que lo haga (medido contra la CLI 2.1.260):
          la unica via en una sesion viva es `shift+tab`, que cicla. Por eso el
          servidor calcula cuantas pulsaciones hacen falta desde el modo en el
          que cree que esta la pestana, y por eso van espaciadas igual que las
          respuestas: son teclas que mueven un estado, no texto.

          Si el destino no esta en el ciclo no se escribe nada. Mandar
          `shift+tab` sin saber a donde lleva deja al usuario en un modo que no
          pidio, que es peor que no hacer nada.
        */
        case 'agent.mode': {
          if (registry.get(message.terminalId) === null) {
            sendError(socket, 'unknown-terminal', serverText('terminalGone'));
            break;
          }
          /*
            El ciclo es de la CLI de la pestana. Una que no lo declara —o una
            consola, que no tiene CLI— no recibe ninguna tecla: contar
            pulsaciones sobre un ciclo que no existe deja a la pestana donde
            nadie pidio.
          */
          const cycle = adapterOf(message.terminalId)?.capabilities.permissionCycle ?? null;
          if (cycle === null) {
            sendError(socket, 'agent-unsupported', serverText('modesUnsupported'));
            break;
          }
          /*
            Sin suscripcion el hub no sabe nada de la pestana, y ahi esta donde
            la lanzo la aplicacion: el modo de arranque de su CLI.
          */
          const current = conversations.getPermissionMode(message.terminalId) ?? cycle.launchMode;
          /*
            Las pulsaciones se cuentan sobre el ciclo de la CLI de la pestana,
            y con una CLI cuya tecla aprueba lo pendiente no se escribe nada
            mientras haya una confirmacion abierta (ver `planModeChange`).
          */
          const plan = planModeChange({
            cycle,
            current,
            target: message.mode,
            waitingFor: conversations.getWaitingFor(message.terminalId),
          });
          if (plan.kind === 'none') break;
          if (plan.kind === 'refused') {
            sendError(socket, 'mode-failed', plan.text);
            break;
          }
          const { keys } = plan;
          /*
            Se anota a donde vamos **antes** de escribir, no despues: el
            archivo no lo va a decir hasta que la CLI procese un turno, y sin
            esto dos cambios seguidos partirian los dos del mismo lugar.
          */
          conversations.setPermissionMode(message.terminalId, message.mode);
          /*
            Por la fila, para no intercalarse con un envio, pero sin dejarse
            cortar por una interrupcion: un Esc no mueve el modo, y cortar las
            pulsaciones a mitad dejaria la pestana en un modo intermedio que
            nadie pidio y que no es el que se acaba de anotar.
          */
          void writeQueue.enqueue(
            message.terminalId,
            async (lane) => {
              await lane.writePieces(keys, ANSWER_KEY_INTERVAL_MS, pieceWriter(socket, message.terminalId));
            },
            { interruptible: false },
          );
          break;
        }

        /*
          Esconder de la barra lateral, o volver a mostrar. No borra nada: el
          `.jsonl` es de la CLI y de `~/.claude/` solo leemos (CLAUDE.md 2.1).

          Una sesion con pestana abierta no se archiva. Esconder de la lista lo
          que se esta usando deja al usuario sin la fila que explica la pestana
          que tiene delante, y no resuelve nada: lo que estorba es el historial
          viejo. Restaurar si se permite siempre — devolver algo a la vista
          nunca esconde nada.
        */
        case 'session.archive': {
          const open = new Set(
            registry.list().map((terminal) => terminal.sessionId).filter((id) => id.length > 0),
          );
          const targets = message.archived
            ? message.sessionIds.filter((id) => !open.has(id))
            : message.sessionIds;

          if (archived.set(targets, message.archived)) index.refresh();
          if (message.archived && targets.length < message.sessionIds.length) {
            sendError(
              socket,
              'archive-failed',
              serverText('archiveOpenTab'),
            );
          }
          break;
        }

        /*
          Esc no hace fila: tiene que llegar ya. Lo que faltaba escribir en esa
          terminal se descarta antes, para que no caiga detras del Esc un
          Enter que mande lo que el usuario acaba de interrumpir.
        */
        case 'agent.interrupt': {
          writeQueue.interrupt(message.terminalId);
          const [first, ...rest] = buildInterruptKeys(inputOf(message.terminalId).interruptPresses);
          if (first === undefined || !writeToTerminal(socket, message.terminalId, first)) break;
          /*
            Una CLI que pide mas de un Esc: el resto va por la fila, espaciado,
            y sin dejarse cortar. Por la fila para que un envio que llegue
            justo despues caiga detras del ultimo Esc y no entre dos; sin
            cortarse porque otro clic en interrumpir no deshace el primero.
            Con un solo Esc no se encola nada: es lo de siempre.
          */
          if (rest.length > 0) {
            const terminalId = message.terminalId;
            void writeQueue.enqueue(
              terminalId,
              async (lane) => {
                await new Promise((resolve) => setTimeout(resolve, ANSWER_KEY_INTERVAL_MS));
                await lane.writePieces(rest, ANSWER_KEY_INTERVAL_MS, pieceWriter(socket, terminalId));
              },
              { interruptible: false },
            );
          }
          break;
        }

        case 'resize':
          registry.resize(message.terminalId, message.cols, message.rows);
          break;

        case 'terminal.open':
          /*
            Una CLI que este lado no conoce no se reemplaza por la de por
            defecto: abrir otra que la pedida es peor que no abrir nada.
          */
          if (message.unsupportedAgent !== undefined && message.kind !== 'shell') {
            sendError(
              socket,
              'agent-unsupported',
              serverText('agentUnknown'),
              message.unsupportedAgent,
              message.requestId,
            );
            break;
          }
          void (async () => {
            try {
              const descriptor = await registry.open({
                cwd: message.cwd,
                ...(message.kind !== undefined ? { kind: message.kind } : {}),
                ...(message.agent !== undefined ? { agent: message.agent } : {}),
                ...(message.resumeSessionId !== undefined
                  ? { resumeSessionId: message.resumeSessionId }
                  : {}),
                ...(message.label !== undefined ? { label: message.label } : {}),
              });
              send(socket, {
                type: 'terminal.opened',
                requestId: message.requestId,
                terminal: descriptor,
              });
            } catch (error) {
              if (error instanceof TerminalOpenError) {
                sendError(socket, error.code, error.text, error.detail, message.requestId);
              } else {
                sendError(
                  socket,
                  'internal',
                  serverText('tabOpenFailed'),
                  error instanceof Error ? error.message : String(error),
                  message.requestId,
                );
              }
            }
          })();
          break;

        /*
          Una pestana dormida no tiene proceso: existe, se lee y no gasta nada.
          Esto es lo que pasa cuando el usuario quiere escribirle al agente.
        */
        case 'terminal.wake': {
          /*
            Se mira antes de esperar. Con un lanzamiento que tarda —el `serve` de
            OpenCode, hito 29— el usuario puede cerrar la pestana mientras se
            despierta, y `wake` da null: la cerro el, y un cartel "La terminal ya
            no existe" sobre algo que acaba de cerrar a proposito es ruido.
            Medido en la prueba en vivo del hito.
          */
          const existed = registry.has(message.terminalId);
          void (async () => {
            try {
              const descriptor = await registry.wake(message.terminalId);
              if (descriptor === null && !existed) {
                sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              }
            } catch (error) {
              if (error instanceof TerminalOpenError) {
                sendError(socket, error.code, error.text, error.detail);
              } else {
                sendError(
                  socket,
                  'internal',
                  serverText('cliOpenFailed'),
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          })();
          break;
        }

        case 'terminal.close':
          if (!dropTab(message.terminalId)) {
            sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          } else {
            subscriptions.delete(message.terminalId);
            gitSubscriptions.delete(message.terminalId);
            memorySubscriptions.delete(message.terminalId);
          }
          break;

        case 'terminal.attach': {
          const attached = registry.attach(message.terminalId, listener);
          if (attached === null) {
            sendError(socket, 'unknown-terminal', serverText('terminalGone'));
            break;
          }
          send(socket, {
            type: 'terminal.replay',
            terminalId: message.terminalId,
            data: attached.replay,
            truncated: attached.truncated,
          });
          // El tamano del cliente manda: el pty puede venir de otra ventana.
          registry.resize(message.terminalId, message.cols, message.rows);
          break;
        }

        case 'terminal.detach':
          registry.detach(message.terminalId, listener);
          break;

        case 'terminal.rename':
          if (!registry.rename(message.terminalId, message.label)) {
            sendError(socket, 'unknown-terminal', serverText('terminalGone'));
          }
          break;

        case 'tabs.reorder':
          registry.reorder(message.terminalIds);
          break;

        case 'index.refresh':
          void index.scan();
          // ⟳ tambien relee la copia: lo que escribio un importador aparece sin reiniciar.
          void vault.reload().catch((error: unknown) => sendVaultError(socket, error));
          break;

        /*
          "Comprobar" del dialogo de la status line: relee la configuracion de
          cada CLI y contesta con la lista. Si algo cambio va a todos, no solo
          a quien pregunto: el aviso automatico ya no lo va a repetir, porque
          esta lectura dejo el estado al dia.
        */
        case 'agents.refresh':
          void agents.refreshSetups().then((changed) => {
            if (changed) broadcast(agentsMessage());
            else send(socket, agentsMessage());
          });
          break;

        case 'conversation.subscribe':
          void (async () => {
            // Una segunda suscripcion del mismo socket contaria dos veces en el
            // refcount y el seguimiento no se apagaria nunca.
            if (subscriptions.has(message.terminalId)) {
              conversations.unsubscribe(message.terminalId);
              subscriptions.delete(message.terminalId);
            }

            const snapshot = await conversations.subscribe(message.terminalId);
            if (snapshot === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            subscriptions.add(message.terminalId);
            send(socket, {
              type: 'conversation.reset',
              terminalId: message.terminalId,
              sessionId: snapshot.sessionId,
              state: snapshot.state,
              events: snapshot.events,
              hasMore: snapshot.hasMore,
              usage: snapshot.usage,
              permissionMode: snapshot.permissionMode,
              defaults: await defaultsFor(message.terminalId),
              waitingFor: snapshot.waitingFor,
              openToolCall: conversations.isToolCallOpen(message.terminalId),
            });
            // Los planes van en su propio mensaje y no dentro del reset: la
            // conversacion se rehace muchas veces —cada `conversation.reset`—
            // y los planes casi nunca cambian.
            if (snapshot.plans.length > 0) {
              send(socket, {
                type: 'conversation.plans',
                terminalId: message.terminalId,
                plans: snapshot.plans,
              });
            }
          })();
          break;

        /*
          El contenido de un plan, al abrirlo en su solapa. El servidor
          comprueba que sea un plan **de esta conversacion** antes de leerlo.
        */
        case 'plans.read':
          void (async () => {
            const plan = await conversations
              .readPlan(message.terminalId, message.fileName)
              .catch(() => null);
            if (plan === null) {
              sendError(socket, 'read-failed', serverText('planReadFailed'));
              return;
            }
            send(socket, { type: 'plans.content', terminalId: message.terminalId, plan });
          })();
          break;

        /*
          Una imagen del historial, pedida al entrar en pantalla. Es una lectura
          completa del archivo de sesion, asi que va por demanda y de a una.
        */
        case 'conversation.image':
          void (async () => {
            const { terminalId, eventId, index, source } = message;
            const image = await conversations
              .readImage(terminalId, eventId, index, source)
              .catch(() => null);
            send(socket, {
              type: 'conversation.imageData',
              terminalId,
              eventId,
              index,
              source,
              mediaType: image?.mediaType ?? 'image/png',
              data: image?.data ?? null,
            });
          })();
          break;

        case 'conversation.unsubscribe':
          if (subscriptions.delete(message.terminalId)) {
            conversations.unsubscribe(message.terminalId);
          }
          break;

        case 'conversation.loadMore': {
          const page = conversations.getPage(
            message.terminalId,
            message.beforeEventId,
            message.limit,
          );
          if (page === null) {
            sendError(socket, 'unknown-terminal', serverText('conversationNotFollowed'));
            break;
          }
          send(socket, {
            type: 'conversation.page',
            terminalId: message.terminalId,
            events: page.events,
            hasMore: page.hasMore,
          });
          break;
        }

        case 'git.subscribe':
          void (async () => {
            // Una segunda suscripcion del mismo socket contaria dos veces en el
            // refcount y el watcher no se apagaria nunca.
            if (gitSubscriptions.has(message.terminalId)) {
              repos.unsubscribe(message.terminalId);
              gitSubscriptions.delete(message.terminalId);
            }
            const status = await repos.subscribe(message.terminalId);
            if (status === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            gitSubscriptions.add(message.terminalId);
            send(socket, { type: 'git.status', terminalId: message.terminalId, status });
          })();
          break;

        case 'git.unsubscribe':
          if (gitSubscriptions.delete(message.terminalId)) {
            repos.unsubscribe(message.terminalId);
          }
          break;

        case 'git.refresh':
          repos.refresh(message.terminalId);
          break;

        /*
          Memoria compartida. El `cwd` sale del registro y todo lo que toca
          disco pasa por la cola de ese directorio en el hub. La suscripcion
          queda anotada aunque la primera lectura falle: el watcher sigue
          mirando y avisa cuando el problema se arregla.

          Cada respuesta y cada error llevan el `requestId` del pedido: es lo
          unico que le dice al panel si un fallo es suyo.
        */
        case 'memory.subscribe':
          void (async () => {
            // Una segunda suscripcion del mismo socket contaria dos veces en el
            // refcount y el watcher no se apagaria nunca.
            if (memorySubscriptions.has(message.terminalId)) {
              memory.unsubscribe(message.terminalId);
              memorySubscriptions.delete(message.terminalId);
            }
            if (cwdOf(message.terminalId) === null) {
              sendMemoryError(new UnknownTerminalError(), message.requestId);
              return;
            }
            memorySubscriptions.add(message.terminalId);
            try {
              const status = await memory.subscribe(message.terminalId);
              if (status === null) {
                memorySubscriptions.delete(message.terminalId);
                sendMemoryError(new UnknownTerminalError(), message.requestId);
                return;
              }
              send(socket, { type: 'memory.status', terminalId: message.terminalId, status });
            } catch (error) {
              sendMemoryError(error, message.requestId);
            }
          })();
          break;

        case 'memory.unsubscribe':
          if (memorySubscriptions.delete(message.terminalId)) {
            memory.unsubscribe(message.terminalId);
          }
          break;

        case 'memory.plan':
          void memory
            .plan(message.terminalId, message.options)
            .then((changes) => {
              send(
                socket,
                withRequestId(
                  { type: 'memory.planned', terminalId: message.terminalId, changes },
                  message.requestId,
                ),
              );
            })
            .catch((error: unknown) => sendMemoryError(error, message.requestId));
          break;

        /*
          La unica escritura de la app dentro de un proyecto. El servidor rehace
          el plan con las opciones: lo que el cliente previsualizo es
          informativo, no una orden de escritura.
        */
        case 'memory.install':
          void memory
            .install(message.terminalId, message.options)
            .then(({ applied, status }) => {
              send(
                socket,
                withRequestId(
                  { type: 'memory.installed', terminalId: message.terminalId, applied },
                  message.requestId,
                ),
              );
              if (status !== null) memory.publish(message.terminalId, status);
            })
            .catch((error: unknown) => sendMemoryError(error, message.requestId));
          break;

        case 'memory.import':
          void memory
            .importNative(message.terminalId)
            .then(({ copied, skipped, status }) => {
              send(
                socket,
                withRequestId(
                  { type: 'memory.imported', terminalId: message.terminalId, copied, skipped },
                  message.requestId,
                ),
              );
              if (status !== null) memory.publish(message.terminalId, status);
            })
            .catch((error: unknown) => sendMemoryError(error, message.requestId));
          break;

        case 'memory.read':
          void memory
            .read(message.terminalId, message.name)
            .then((note) => {
              if (note === null) {
                sendError(socket, 'memory-failed', serverText('memoryNoteGone'), undefined, message.requestId);
                return;
              }
              send(
                socket,
                withRequestId(
                  { type: 'memory.content', terminalId: message.terminalId, note },
                  message.requestId,
                ),
              );
            })
            .catch((error: unknown) => sendMemoryError(error, message.requestId));
          break;

        case 'git.diff':
          void (async () => {
            const status = repos.getStatus(message.terminalId);
            if (status === null || status.state !== 'ready') {
              sendError(socket, 'read-failed', serverText('gitStatusUnknown'));
              return;
            }
            try {
              // Las rutas del panel son relativas a la raiz del repo, que puede
              // estar por encima del cwd de la pestana. El guardia se aplica
              // contra esa raiz, que es la que git nos dio: sigue siendo un
              // limite del servidor y no del cliente.
              await resolveInside(status.repoRoot, message.path, { mustExist: false });
              const change = status.changes.find((item) => item.path === message.path);
              const diff = await readDiff({
                repoRoot: status.repoRoot,
                relativePath: message.path,
                staged: message.staged,
                untracked: change?.stage === 'untracked',
              });
              send(socket, { type: 'git.diff', terminalId: message.terminalId, diff });
            } catch (error) {
              sendPathError(error, serverText('diffReadFailed'));
            }
          })();
          break;

        case 'files.list':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            try {
              const listing = await listDirectory(cwd, message.path, {
                includeHidden: message.includeHidden === true,
              });
              send(socket, { type: 'files.listing', terminalId: message.terminalId, listing });
            } catch (error) {
              sendPathError(error, serverText('dirReadFailed'));
            }
          })();
          break;

        /*
          La busqueda por nombre es lo unico del panel que mira mas de un nivel
          de una, y por eso es lo unico que lleva topes propios. El `cwd` lo
          sigue poniendo el servidor: lo que llega del cliente es el texto que
          se escribio, nunca una ruta.
        */
        case 'files.search':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            try {
              const result = await searchFiles(cwd, message.query, {
                includeHidden: message.includeHidden === true,
              });
              send(socket, { type: 'files.results', terminalId: message.terminalId, result });
            } catch (error) {
              sendPathError(error, serverText('dirSearchFailed'));
            }
          })();
          break;

        case 'files.read':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            try {
              const preview = await readPreview(cwd, message.path);
              send(socket, { type: 'files.preview', terminalId: message.terminalId, preview });
            } catch (error) {
              sendPathError(error, serverText('fileReadFailed'));
            }
          })();
          break;

        case 'files.reveal':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            try {
              revealPath(await resolveInside(cwd, message.path, { mustExist: true }));
            } catch (error) {
              sendPathError(error, serverText('pathOpenFailed'));
            }
          })();
          break;

        /*
          Notas sueltas. No van dirigidas a ninguna pestana.

          Los errores del almacen son de usuario —tope de notas, imagen que no
          es imagen— y viajan como `notes-failed`; lo demas es un fallo interno.
        */
        case 'notes.create':
          try {
            notes.create(message.noteId);
            broadcast({ type: 'notes.list', notes: notes.list() });
          } catch (error) {
            sendNotesError(error);
          }
          break;

        case 'notes.update':
          try {
            // Sin eco al que escribe: pisaria lo tecleado entre envio y respuesta.
            if (notes.update(message.noteId, message.text)) {
              broadcastExcept(socket, { type: 'notes.list', notes: notes.list() });
            }
          } catch (error) {
            sendNotesError(error);
          }
          break;

        case 'notes.delete':
          void notes
            .delete(message.noteId)
            .then((changed) => {
              if (changed) broadcast({ type: 'notes.list', notes: notes.list() });
            })
            .catch(sendNotesError);
          break;

        case 'notes.addImage':
          void notes
            .addImage(message.noteId, message.image.mediaType, message.image.data)
            .then((image) => {
              // El que la pego ya tiene los bytes: se le devuelven con el id
              // para que la miniatura no vuelva a pedirlos.
              send(socket, {
                type: 'notes.imageData',
                imageId: image.imageId,
                mediaType: image.mediaType,
                data: message.image.data,
              });
              broadcast({ type: 'notes.list', notes: notes.list() });
            })
            .catch(sendNotesError);
          break;

        case 'notes.removeImage':
          void notes
            .removeImage(message.noteId, message.imageId)
            .then((changed) => {
              if (changed) broadcast({ type: 'notes.list', notes: notes.list() });
            })
            .catch(sendNotesError);
          break;

        case 'notes.image':
          void notes
            .readImage(message.imageId)
            .catch(() => null)
            .then((image) => {
              send(socket, {
                type: 'notes.imageData',
                imageId: message.imageId,
                mediaType: image?.mediaType ?? 'image/png',
                data: image?.data ?? null,
              });
            });
          break;

        /*
          Una nota entera al agente de una pestana recien abierta.

          El cliente abre la pestana y manda los dos ids; el contenido ya esta
          de este lado. Se arma el mismo pegado que un mensaje del cuadro de
          escritura y se escribe por el mismo camino: `buildSubmissionWrites`
          es el unico sitio que compone lo que entra en la pty, y la fila de la
          terminal el unico que lo escribe.

          **La nota no se borra.** Mandarla no es cerrarla.
        */
        /*
          Selector de carpetas: el unico sitio de la app que lista fuera del
          `cwd` de una pestana. Cuatro operaciones y ninguna acepta una ruta —
          ver `directory-picker.ts`.
        */
        case 'picker.open':
        case 'picker.enter':
        case 'picker.root':
        case 'picker.create':
          void (async () => {
            try {
              const listing =
                message.type === 'picker.open'
                  ? await pickers.open()
                  : message.type === 'picker.enter'
                    ? await pickers.enter(message.pickerId, message.name)
                    : message.type === 'picker.root'
                      ? await pickers.root(message.pickerId, message.rootIndex)
                      : await pickers.create(message.pickerId, message.name);
              send(socket, { type: 'picker.listing', listing });
            } catch (error) {
              sendError(
                socket,
                'picker-failed',
                error instanceof DirectoryPickerError ? error.text : serverText('pickerListFailed'),
                error instanceof Error ? error.message : String(error),
              );
            }
          })();
          break;

        case 'picker.close':
          pickers.close(message.pickerId);
          break;

        /*
          La copia propia (hito 28). Ningun pedido nombra una ruta: medir y
          encender no llevan nada, mudar lleva el selector de **este** socket,
          una sesion va por `(agent, sessionId)` —el parser ya valido la forma
          del id— y un proyecto por su clave. El estado nuevo sale a todos por
          `vault.onStatus`; aca solo se contesta lo que falla.
        */
        case 'vault.measure':
          void vault.measure().catch((error: unknown) => sendVaultError(socket, error));
          break;

        case 'vault.enable':
          void vault.setEnabled(message.enabled).catch((error: unknown) => sendVaultError(socket, error));
          break;

        case 'vault.setDir':
          // El selector se cierra despues, desde el cliente, como con un proyecto nuevo.
          void vault.setDirFromPicker(pickers, message.pickerId).catch((error: unknown) => sendVaultError(socket, error));
          break;

        case 'vault.exportProject':
          void vault
            .exportProject(message.projectKey)
            .then((result) => {
              send(socket, { type: 'vault.exported', projectKey: message.projectKey, sessions: result.sessions });
            })
            .catch((error: unknown) => sendVaultError(socket, error));
          break;

        case 'vault.openSession':
          void vault.openSession(message.agent, message.sessionId).catch((error: unknown) => sendVaultError(socket, error));
          break;

        case 'vault.reveal':
          void vault.reveal().catch((error: unknown) => sendVaultError(socket, error));
          break;

        case 'notes.send':
          void (async () => {
            const descriptor = registry.get(message.terminalId);
            if (descriptor === null) {
              sendError(socket, 'unknown-terminal', serverText('terminalGone'));
              return;
            }
            if (descriptor.kind !== 'agent' || descriptor.sessionId.length === 0) {
              sendError(socket, 'submit-failed', serverText('noteNoAgent'));
              return;
            }

            const note = await notes.readForSubmit(message.noteId);
            if (note === null) {
              sendError(socket, 'submit-failed', serverText('noteGone'));
              return;
            }
            if (note.text.trim().length === 0 && note.images.length === 0) {
              sendError(socket, 'submit-failed', serverText('noteEmpty'));
              return;
            }

            /*
              Una pty recien abierta puede estar todavia arrancando, y ahi el
              pegado se perderia o —peor— contestaria un menu. Se espera a que
              la CLI se declare lista; si no llega, no se escribe nada. Una CLI
              que no avisa cuando esta lista no recibe notas: pegar a ciegas es
              justo lo que esta espera evita.

              Desde el hito 29 la espera y la escritura estan en
              `deliverWhenReady`, que tambien usa la continuacion en otra CLI
              (M3): mismas comprobaciones en el mismo orden, misma fila, mismas
              piezas. Los textos de cada fallo siguen aca.
            */
            const outcome = await deliverWhenReady(deliverDeps, {
              terminalId: message.terminalId,
              text: note.text,
              images: note.images,
              timeoutMs: NOTE_SEND_TIMEOUT_MS,
              write: pieceWriter(socket, message.terminalId),
            });
            switch (outcome.kind) {
              case 'sent':
              case 'nothing':
              // La fila ya lo dijo al no poder escribir (`writeToTerminal`).
              case 'refused':
                return;
              case 'gone':
                sendError(socket, 'unknown-terminal', serverText('terminalGone'));
                return;
              case 'no-agent':
              case 'no-session':
                sendError(socket, 'submit-failed', serverText('noteNoAgent'));
                return;
              case 'no-ready-signal':
                sendError(socket, 'agent-unsupported', serverText('noteNoReadySignal'));
                return;
              case 'no-images':
                sendError(socket, 'agent-unsupported', serverText('noteImagesUnsupported'));
                return;
              case 'not-ready':
                sendError(socket, 'submit-failed', serverText('noteCliNotStarted'));
                return;
              case 'image-failed':
                sendError(socket, 'submit-failed', serverText('noteImageFailed'), outcome.detail);
                return;
              case 'interrupted':
                sendError(socket, 'submit-failed', serverText('noteInterrupted'));
                return;
            }
          })();
          break;

        /*
          Continuar una conversacion con otra CLI (hito 29).

          No viaja ninguna ruta ni ningun texto: la sesion se busca en el indice
          por `(agent, sessionId)`. `continueSession` abre la pestana y guarda el
          transcript; aca se contesta y se entrega. La pestana llega con
          `terminal.opened` y el mismo `requestId`, que es lo que la activa en
          la ventana que la pidio; despues `session.continued`, con lo que dice
          el aviso encima del cuadro.

          La entrega va en segundo plano. Si no se manda sola —la CLI no avisa
          cuando esta lista, o no llego a estarlo—, el mensaje queda en el
          cuadro de esa pestana, y lo manda el usuario. Nunca las dos cosas.
        */
        case 'session.continue': {
          if (message.target === null) {
            sendError(
              socket,
              'agent-unsupported',
              serverText('agentUnknown'),
              message.unsupportedAgent,
              message.requestId,
            );
            break;
          }
          const { requestId, target } = message;
          void (async () => {
            let outcome;
            try {
              outcome = await continueSession(continueDeps, {
                agent: message.agent,
                sessionId: message.sessionId,
                target,
                ...(message.label !== undefined ? { label: message.label } : {}),
              });
            } catch (error) {
              sendError(
                socket,
                'continue-failed',
                serverText('continueFailed'),
                error instanceof Error ? error.message : String(error),
                requestId,
              );
              return;
            }
            if (!outcome.ok) {
              sendError(socket, outcome.code, outcome.text, outcome.detail, requestId);
              return;
            }

            const { terminalId } = outcome.descriptor;
            send(socket, { type: 'terminal.opened', requestId, terminal: outcome.descriptor });
            send(socket, { type: 'session.continued', requestId, ...outcome.continued });
            if (outcome.continued.delivery === 'prefilled') {
              send(socket, { type: 'composer.prefill', terminalId, text: outcome.message, reason: 'no-delivery' });
              return;
            }

            const delivered = await deliverWhenReady(deliverDeps, {
              terminalId,
              text: outcome.message,
              images: [],
              timeoutMs: HANDOFF_DELIVERY_TIMEOUT_MS,
              // Sin avisos por pieza: si no entra, el mensaje vuelve al cuadro y eso ya lo dice.
              write: (piece) => registry.write(terminalId, piece),
            });
            const reason = prefillReasonFor(delivered);
            if (reason !== null) {
              debugLog('continue', `not sent on its own to ${terminalId.slice(0, 8)}: ${delivered.kind}`);
              send(socket, { type: 'composer.prefill', terminalId, text: outcome.message, reason });
            }
          })();
          break;
        }

        /*
          Buscar en las conversaciones de la copia propia (hito 29). Solo viaja
          el texto: donde se busca lo decide el catalogo. La respuesta es solo
          para este socket, y una busqueda que otra reemplazo no contesta.
          Recorre todas las sesiones y va mandando lo que encuentra
          (`search.progress`) hasta el resultado final.
        */
        case 'search.global': {
          const { searchId, query, includeArchived } = message;
          void globalSearch
            .run(
              (signal) =>
                vault.search(query, {
                  includeArchived,
                  signal,
                  onProgress: (progress) => {
                    if (!signal.aborted) send(socket, { type: 'search.progress', searchId, progress });
                  },
                }),
              searchId,
            )
            .then((result) => {
              if (result !== null) send(socket, { type: 'search.results', searchId, result });
            })
            .catch((error: unknown) => {
              const detail = error instanceof Error ? error.message : String(error);
              sendError(
                socket,
                'search-failed',
                error instanceof VaultError ? error.text : serverText('searchFailed'),
                detail,
                searchId,
              );
            });
          break;
        }

        // Se cerro el buscador: solo esa busqueda, si todavia es la que corre.
        case 'search.cancel':
          globalSearch.cancel(message.searchId);
          break;
      }
    });

    const teardown = (): void => {
      // Se quitan los oyentes de este socket. Las terminales siguen vivas.
      globalSearch.cancel();
      pickers.closeAll();
      registry.detachAll(listener);
      for (const terminalId of subscriptions) conversations.unsubscribe(terminalId);
      subscriptions.clear();
      for (const terminalId of gitSubscriptions) repos.unsubscribe(terminalId);
      gitSubscriptions.clear();
      for (const terminalId of memorySubscriptions) memory.unsubscribe(terminalId);
      memorySubscriptions.clear();
      clients.delete(socket);
    };

    socket.on('close', teardown);
    socket.on('error', teardown);
  });

  return () => {
    httpServer.off('upgrade', onUpgrade);
    registry.off('changed', onRegistryChanged);
    registry.off('activity', onRegistryActivity);
    registry.off('exit', onRegistryExit);
    index.off('status', onIndexStatus);
    index.off('projects', onIndexProjects);
    conversations.off('append', onConversationAppend);
    conversations.off('state', onConversationState);
    conversations.off('reset', onConversationReset);
    conversations.off('turns', onConversationTurns);
    conversations.off('plans', onConversationPlans);
    conversations.off('parts', onConversationParts);
    conversations.off('mode', onConversationMode);
    conversations.off('waiting', onConversationWaiting);
    conversations.off('toolCall', onConversationToolCall);
    repos.off('status', onGitStatus);
    memory.off('status', onMemoryStatus);
    stopAgentChanges();
    stopVaultStatus();
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
