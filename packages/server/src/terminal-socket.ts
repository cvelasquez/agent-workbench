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
  type AgentDefaults,
  type ContextUsage,
  type PermissionMode,
  type ConversationEvent,
  type ConversationState,
  type GitStatus,
  type IndexStatus,
  type MemoryStatus,
  type ProjectSummary,
  type ServerErrorCode,
  type ServerMessage,
  type SessionPlan,
  type TerminalActivity,
  type TerminalId,
} from '@agent-workbench/shared';
import { readAgentDefaults } from './agent-defaults.js';
import { cliNotFoundMessage, type CliLocation } from './cli-locator.js';
import type { ArchivedSessions } from './archived-sessions.js';
import type { CliStatusWatcher } from './cli-status.js';
import { DirectoryPickerError, DirectoryPickers } from './directory-picker.js';
import { MemoryBridgeError } from './memory-bridge.js';
import { UnknownTerminalError, type MemoryHub } from './memory-hub.js';
import { NotesError, type NotesStore } from './notes-store.js';
import type { PartsUpdate } from './conversation-follower.js';
import type { ConversationHub } from './conversation-hub.js';
import { debugLog } from './debug.js';
import { listDirectory, readPreview, searchFiles } from './file-browser.js';
import { readDiff } from './git-repo.js';
import { InvalidPathError, resolveInside } from './path-guard.js';
import { PasteImageError, PasteStore, MAX_IMAGES_PER_SUBMIT } from './paste-store.js';
import {
  ANSWER_KEY_INTERVAL_MS,
  INTERRUPT,
  buildAnswerKeys,
  buildModeKeys,
  buildSubmission,
  fileReference,
} from './pty-input.js';
import { inheritedChildSessionMarker } from './pty-session.js';
import type { RepoHub } from './repo-hub.js';
import { revealPath } from './reveal.js';
import type { SessionIndex } from './session-index.js';
import type { ShellLocation } from './shell-locator.js';
import { TerminalOpenError, type OutputListener, type TerminalRegistry } from './terminal-registry.js';
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

export interface TerminalSocketOptions {
  httpServer: HttpServer;
  port: number;
  token: string;
  cli: CliLocation | null;
  shell: ShellLocation | null;
  registry: TerminalRegistry;
  index: SessionIndex;
  archived: ArchivedSessions;
  notes: NotesStore;
  conversations: ConversationHub;
  repos: RepoHub;
  /** Memoria compartida del proyecto de cada pestana (`memory.*`). */
  memory: MemoryHub;
  /** Estado en vivo de la CLI. Lo usa `notes.send` para esperar el arranque. */
  cliStatus: CliStatusWatcher;
  defaultCwd: string;
  /** Donde aterrizan las imagenes pegadas. Inyectable para las pruebas. */
  pasteStore?: PasteStore;
}

export function attachTerminalSocket(options: TerminalSocketOptions): () => void {
  const {
    httpServer,
    port,
    token,
    cli,
    shell,
    registry,
    index,
    archived,
    notes,
    conversations,
    repos,
    memory,
    cliStatus,
    defaultCwd,
  } = options;

  const pasteStore = options.pasteStore ?? new PasteStore();

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
    message: string,
    detail?: string,
    requestId?: string,
  ): void => {
    const payload: ServerMessage = { type: 'error', code, message };
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

  const terminalListMessage = (): ServerMessage => ({
    type: 'terminal.list',
    terminals: registry.list(),
    order: registry.getOrder(),
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
      sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
    } else {
      sendError(
        socket,
        'terminal-asleep',
        'Esta pestaña no tiene la CLI abierta. Abrila para escribirle al agente.',
      );
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
  const onRegistryActivity = (terminalId: TerminalId, activity: TerminalActivity): void =>
    broadcast({ type: 'terminal.activity', terminalId, activity });

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
   */
  const defaultsFor = async (terminalId: TerminalId): Promise<AgentDefaults> => {
    const descriptor = registry.get(terminalId);
    if (descriptor === null) return { model: null, effort: null, contextWindow: null };
    return readAgentDefaults(descriptor.cwd);
  };

  /**
   * Escribe las pulsaciones de una respuesta, una cada tanto.
   *
   * El escalonado no es cortesia: mandadas en un solo write, el menu de la CLI
   * se queda a mitad y no responde nada (medido; ver `ANSWER_KEY_INTERVAL_MS`).
   * Cada tecla tiene que caer sobre el estado que dejo la anterior.
   *
   * Si la pestana desaparece a mitad se corta y se avisa una sola vez: seguir
   * escribiendo en una terminal que ya no esta no arregla nada.
   */
  const writeAnswerKeys = async (
    socket: WebSocket,
    terminalId: TerminalId,
    keys: readonly string[],
  ): Promise<void> => {
    for (const [index, key] of keys.entries()) {
      if (index > 0) {
        await new Promise((resolve) => setTimeout(resolve, ANSWER_KEY_INTERVAL_MS));
      }
      if (!writeToTerminal(socket, terminalId, key)) return;
    }
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
  conversations.on('turns', onConversationTurns);
  conversations.on('plans', onConversationPlans);
  conversations.on('parts', onConversationParts);
  repos.on('status', onGitStatus);
  memory.on('status', onMemoryStatus);

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
      console.warn(`[seguridad] upgrade rechazado en ${WS_PATH}: ${rejection}`);
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
    const pickers = new DirectoryPickers();

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

    const sendPathError = (error: unknown, fallback: string): void => {
      if (error instanceof InvalidPathError) {
        sendError(socket, 'invalid-path', error.message);
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
        sendError(socket, 'notes-failed', error.message);
        return;
      }
      sendError(
        socket,
        'internal',
        'No se pudo guardar la nota.',
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
        sendError(socket, 'unknown-terminal', 'La terminal ya no existe.', undefined, requestId);
        return;
      }
      if (error instanceof InvalidPathError) {
        sendError(socket, 'invalid-path', error.message, undefined, requestId);
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      sendError(
        socket,
        'memory-failed',
        error instanceof MemoryBridgeError ? detail : `No se pudo completar la operación: ${detail}`,
        detail,
        requestId,
      );
    };

    send(socket, {
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      cliAvailable: cli !== null,
      cliVersion: cli?.version ?? null,
      cliMissingMessage: cli === null ? cliNotFoundMessage() : null,
      platform: process.platform,
      defaultCwd,
      transcriptMarkerStripped: inheritedChildSessionMarker,
      shellName: shell?.name ?? null,
    });
    send(socket, terminalListMessage());
    send(socket, { type: 'index.status', status: index.getStatus() });
    send(socket, { type: 'index.projects', projects: index.getProjects(), replace: true });
    send(socket, { type: 'notes.list', notes: notes.list() });

    socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : Buffer.from(raw as Buffer).toString('utf8');

      const message = parseClientMessage(text);
      if (message === null) {
        debugLog('socket', `mensaje rechazado: ${text.slice(0, 160)}`);
        sendError(socket, 'bad-message', 'Mensaje no reconocido por el protocolo.');
        return;
      }
      if (message.type !== 'input') debugLog('socket', `recibido ${message.type}`);

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
        */
        case 'agent.submit':
          void (async () => {
            const { terminalId, text, images } = message;
            if (images.length > MAX_IMAGES_PER_SUBMIT) {
              sendError(
                socket,
                'submit-failed',
                `Se pueden adjuntar hasta ${MAX_IMAGES_PER_SUBMIT} imagenes por mensaje.`,
              );
              return;
            }

            const references: string[] = [];
            try {
              for (const image of images) {
                const stored = await pasteStore.save(terminalId, image.mediaType, image.data);
                references.push(fileReference(stored.path));
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              sendError(
                socket,
                'submit-failed',
                error instanceof PasteImageError
                  ? detail
                  : 'No se pudo guardar la imagen pegada.',
                detail,
              );
              return;
            }

            const payload = buildSubmission(text, references, { send: message.send !== false });
            // Un cuadro vacio no le manda un Enter a la CLI.
            if (payload === null) return;
            writeToTerminal(socket, terminalId, payload);
          })();
          break;

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
          const pending = conversations.getPendingQuestion(message.terminalId);
          if (pending === null || pending.toolUseId !== message.toolUseId) {
            sendError(
              socket,
              'answer-failed',
              'Esa pregunta ya no esta esperando respuesta.',
            );
            break;
          }

          const keys = buildAnswerKeys(
            pending.questions.map((question) => ({
              multiSelect: question.multiSelect,
              optionCount: question.options.length,
            })),
            message.selections,
          );
          if (keys === null) {
            sendError(socket, 'answer-failed', 'La respuesta no corresponde a la pregunta.');
            break;
          }
          void writeAnswerKeys(socket, message.terminalId, keys);
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
          const current = conversations.getPermissionMode(message.terminalId);
          if (current === message.mode) break;

          const keys = buildModeKeys(current, message.mode);
          if (keys === null || keys.length === 0) {
            sendError(
              socket,
              'mode-failed',
              'No se puede llegar a ese modo desde el actual. Cambialo con shift+tab en la solapa CLI.',
            );
            break;
          }
          /*
            Se anota a donde vamos **antes** de escribir, no despues: el
            archivo no lo va a decir hasta que la CLI procese un turno, y sin
            esto dos cambios seguidos partirian los dos del mismo lugar.
          */
          conversations.setPermissionMode(message.terminalId, message.mode);
          void writeAnswerKeys(socket, message.terminalId, keys);
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
              'Las sesiones con una pestaña abierta no se archivan. Cerrala primero.',
            );
          }
          break;
        }

        case 'agent.interrupt':
          writeToTerminal(socket, message.terminalId, INTERRUPT);
          break;

        case 'resize':
          registry.resize(message.terminalId, message.cols, message.rows);
          break;

        case 'terminal.open':
          void (async () => {
            try {
              const descriptor = await registry.open({
                cwd: message.cwd,
                ...(message.kind !== undefined ? { kind: message.kind } : {}),
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
                sendError(socket, error.code, error.message, error.detail, message.requestId);
              } else {
                sendError(
                  socket,
                  'internal',
                  'No se pudo abrir la pestana.',
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
        case 'terminal.wake':
          void (async () => {
            try {
              const descriptor = await registry.wake(message.terminalId);
              if (descriptor === null) {
                sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
              }
            } catch (error) {
              if (error instanceof TerminalOpenError) {
                sendError(socket, error.code, error.message, error.detail);
              } else {
                sendError(
                  socket,
                  'internal',
                  'No se pudo abrir la CLI de la pestaña.',
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          })();
          break;

        case 'terminal.close':
          if (!registry.close(message.terminalId)) {
            sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
          } else {
            // Sin pestana no hay nada que seguir, la mire quien la mire.
            conversations.drop(message.terminalId);
            repos.drop(message.terminalId);
            memory.drop(message.terminalId);
            // Las imagenes que se pegaron en esta pestana ya no le sirven a
            // nadie: la conversacion que las nombraba se fue con ella.
            void pasteStore.clearTerminal(message.terminalId);
            subscriptions.delete(message.terminalId);
            gitSubscriptions.delete(message.terminalId);
            memorySubscriptions.delete(message.terminalId);
            broadcast({ type: 'terminal.closed', terminalId: message.terminalId });
          }
          break;

        case 'terminal.attach': {
          const attached = registry.attach(message.terminalId, listener);
          if (attached === null) {
            sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
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
            sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
          }
          break;

        case 'tabs.reorder':
          registry.reorder(message.terminalIds);
          break;

        case 'index.refresh':
          void index.scan();
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
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
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
              sendError(socket, 'read-failed', 'No se pudo leer el plan.');
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
            sendError(socket, 'unknown-terminal', 'Esa conversacion ya no se esta siguiendo.');
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
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
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
                sendError(socket, 'memory-failed', 'Esa nota ya no existe.', undefined, message.requestId);
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
              sendError(socket, 'read-failed', 'Todavia no se conoce el estado del repositorio.');
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
              sendPathError(error, 'No se pudo leer el diff.');
            }
          })();
          break;

        case 'files.list':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
              return;
            }
            try {
              const listing = await listDirectory(cwd, message.path, {
                includeHidden: message.includeHidden === true,
              });
              send(socket, { type: 'files.listing', terminalId: message.terminalId, listing });
            } catch (error) {
              sendPathError(error, 'No se pudo leer el directorio.');
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
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
              return;
            }
            try {
              const result = await searchFiles(cwd, message.query, {
                includeHidden: message.includeHidden === true,
              });
              send(socket, { type: 'files.results', terminalId: message.terminalId, result });
            } catch (error) {
              sendPathError(error, 'No se pudo buscar en el directorio.');
            }
          })();
          break;

        case 'files.read':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
              return;
            }
            try {
              const preview = await readPreview(cwd, message.path);
              send(socket, { type: 'files.preview', terminalId: message.terminalId, preview });
            } catch (error) {
              sendPathError(error, 'No se pudo leer el archivo.');
            }
          })();
          break;

        case 'files.reveal':
          void (async () => {
            const cwd = cwdOf(message.terminalId);
            if (cwd === null) {
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
              return;
            }
            try {
              revealPath(await resolveInside(cwd, message.path, { mustExist: true }));
            } catch (error) {
              sendPathError(error, 'No se pudo abrir la ruta.');
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
          escritura y se escribe por el mismo camino: `buildSubmission` es el
          unico sitio que compone lo que entra en la pty.

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
                error instanceof DirectoryPickerError
                  ? error.message
                  : 'No se pudo listar esa carpeta.',
                error instanceof Error ? error.message : String(error),
              );
            }
          })();
          break;

        case 'picker.close':
          pickers.close(message.pickerId);
          break;

        case 'notes.send':
          void (async () => {
            const descriptor = registry.get(message.terminalId);
            if (descriptor === null) {
              sendError(socket, 'unknown-terminal', 'La terminal ya no existe.');
              return;
            }
            if (descriptor.kind !== 'agent' || descriptor.sessionId.length === 0) {
              sendError(socket, 'submit-failed', 'Esa pestana no tiene un agente al que mandarle la nota.');
              return;
            }

            const note = await notes.readForSubmit(message.noteId);
            if (note === null) {
              sendError(socket, 'submit-failed', 'La nota ya no existe.');
              return;
            }
            if (note.text.trim().length === 0 && note.images.length === 0) {
              sendError(socket, 'submit-failed', 'La nota esta vacia.');
              return;
            }

            /*
              Una pty recien abierta puede estar todavia arrancando, y ahi el
              pegado se perderia o —peor— contestaria un menu. Se espera a que
              la CLI se declare `idle`; si no llega, no se escribe nada.
            */
            if (!(await cliStatus.waitUntilIdle(descriptor.sessionId, NOTE_SEND_TIMEOUT_MS))) {
              sendError(
                socket,
                'submit-failed',
                'La CLI de esa pestana no llego a arrancar; la nota no se mando.',
              );
              return;
            }

            const references: string[] = [];
            try {
              for (const image of note.images) {
                const stored = await pasteStore.save(
                  message.terminalId,
                  image.mediaType,
                  image.data,
                );
                references.push(fileReference(stored.path));
              }
            } catch (error) {
              const detail = error instanceof Error ? error.message : String(error);
              sendError(socket, 'submit-failed', 'No se pudo adjuntar una imagen de la nota.', detail);
              return;
            }

            const payload = buildSubmission(note.text, references);
            if (payload === null) return;
            writeToTerminal(socket, message.terminalId, payload);
          })();
          break;
      }
    });

    const teardown = (): void => {
      // Se quitan los oyentes de este socket. Las terminales siguen vivas.
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
    repos.off('status', onGitStatus);
    memory.off('status', onMemoryStatus);
    for (const client of wss.clients) client.terminate();
    wss.close();
  };
}
