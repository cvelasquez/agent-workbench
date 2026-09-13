/**
 * Estado global de la app: conexion, pestanas e indice de sesiones.
 *
 * La lista de pestanas es siempre la que manda el servidor. El cliente no
 * mantiene su propia copia editable: si dos ventanas miran la misma app, las
 * dos ven lo mismo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  IndexStatus,
  ProjectSummary,
  ServerMessage,
  TerminalActivity,
  TerminalDescriptor,
  TerminalId,
} from '@agent-workbench/shared';
import { AgentConnection, type ConnectionStatus } from './connection.js';
import { isMemoryPanelRequest } from './useMemory.js';

export interface WorkspaceError {
  message: string;
  at: number;
}

export interface Workspace {
  connection: AgentConnection;
  status: ConnectionStatus;
  cliAvailable: boolean;
  cliVersion: string | null;
  cliMissingMessage: string | null;
  /** `process.platform` del servidor. Decide el separador de las rutas. */
  platform: string;
  defaultCwd: string;
  /** true si el servidor tuvo que quitar CLAUDE_CODE_CHILD_SESSION del entorno. */
  transcriptMarkerStripped: boolean;
  /** "PowerShell", "bash"... o null si el servidor no encontro ninguna consola. */
  shellName: string | null;
  /** Pestanas de la CLI. Son las unicas que aparecen en la barra de pestanas. */
  terminals: TerminalDescriptor[];
  /** Consolas del sistema. Viven en la columna derecha, no en la barra. */
  shells: TerminalDescriptor[];
  activeTerminalId: TerminalId | null;
  projects: ProjectSummary[];
  indexStatus: IndexStatus;
  error: WorkspaceError | null;
  dismissError: () => void;
  setActiveTerminal: (terminalId: TerminalId) => void;
  openTerminal: (options: {
    cwd: string;
    resumeSessionId?: string;
    label?: string;
    /** Se llama cuando el servidor confirma la pestana, con su descriptor. */
    onOpened?: (terminal: TerminalDescriptor) => void;
  }) => void;
  /** Abre una consola del sistema en ese directorio. */
  openShell: (cwd: string) => void;
  closeTerminal: (terminalId: TerminalId) => void;
  /**
   * Le da CLI a una pestana dormida, o revive una que murio.
   *
   * Arrancar la aplicacion ya no lanza un proceso por pestana: se restauran
   * dormidas —legibles y sin gastar nada— y la CLI aparece cuando hace falta
   * escribirle al agente.
   */
  wakeTerminal: (terminalId: TerminalId) => void;
  /** Pestanas para las que se pidio la CLI y todavia no arranco. */
  waking: ReadonlySet<TerminalId>;
  /** Que esta haciendo la CLI de cada pestana. Ausente = sin proceso. */
  activity: ReadonlyMap<TerminalId, TerminalActivity>;
  renameTerminal: (terminalId: TerminalId, label: string) => void;
  reorderTabs: (terminalIds: TerminalId[]) => void;
  refreshIndex: () => void;
  /** Esconde de la barra lateral, o restaura. No borra ningun archivo. */
  archiveSessions: (sessionIds: string[], archived: boolean) => void;
}

const EMPTY_INDEX_STATUS: IndexStatus = { state: 'idle', scannedFiles: 0, totalFiles: 0 };

function mergeProjects(
  previous: ProjectSummary[],
  incoming: ProjectSummary[],
  replace: boolean,
): ProjectSummary[] {
  const bySlug = new Map(replace ? [] : previous.map((project) => [project.slug, project]));
  for (const project of incoming) bySlug.set(project.slug, project);
  return [...bySlug.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function useWorkspace(): Workspace {
  const connection = useMemo(() => new AgentConnection(), []);

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [cliAvailable, setCliAvailable] = useState(true);
  const [cliVersion, setCliVersion] = useState<string | null>(null);
  const [cliMissingMessage, setCliMissingMessage] = useState<string | null>(null);
  const [platform, setPlatform] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [transcriptMarkerStripped, setTranscriptMarkerStripped] = useState(false);
  const [shellName, setShellName] = useState<string | null>(null);
  const [allTerminals, setAllTerminals] = useState<TerminalDescriptor[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [indexStatus, setIndexStatus] = useState<IndexStatus>(EMPTY_INDEX_STATUS);
  const [activeTerminalId, setActiveTerminalId] = useState<TerminalId | null>(null);
  const [waking, setWaking] = useState<Set<TerminalId>>(new Set());
  /*
    Que esta haciendo la CLI de cada pestana.

    Llega por `terminal.activity`, que late cada 700 ms y no arrastra la lista
    de pestanas. Una pestana sin entrada es una sin proceso: dormida, muerta, o
    recien lanzada y todavia sin registrar.
  */
  const [activity, setActivity] = useState<Map<TerminalId, TerminalActivity>>(new Map());
  const [error, setError] = useState<WorkspaceError | null>(null);

  // Las pestanas que abrimos nosotros pasan a estar activas; las que abrio otra
  // ventana, no. Por eso se registran los requestId propios.
  const ownRequests = useRef(new Set<string>());
  /**
   * Que hacer con una pestana en cuanto el servidor la abre.
   *
   * El id lo asigna el servidor, asi que quien pide una pestana para
   * *despues* hacerle algo —mandarle una nota, por ejemplo— no lo tiene hasta
   * que llega el `terminal.opened`. Se guarda por `requestId`, que es el unico
   * hilo que une el pedido con la respuesta.
   */
  const pendingOpen = useRef(new Map<string, (terminal: TerminalDescriptor) => void>());

  useEffect(() => {
    // Sin token en la URL se intenta igual: tras una recarga autentica la
    // cookie de sesion. Solo si la conexion falla de verdad se avisa.
    const offStatus = connection.onStatus((next) => {
      setStatus(next);
      if (next === 'failed') {
        setError({
          message:
            'No se pudo conectar con el servidor local. Abri de nuevo la URL que imprimio al arrancar.',
          at: Date.now(),
        });
      }
    });
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'hello':
          setCliAvailable(message.cliAvailable);
          setCliVersion(message.cliVersion);
          setCliMissingMessage(message.cliMissingMessage);
          setPlatform(message.platform);
          setDefaultCwd(message.defaultCwd);
          setTranscriptMarkerStripped(message.transcriptMarkerStripped);
          setShellName(message.shellName);
          break;

        case 'terminal.list': {
          setAllTerminals(message.terminals);
          // La CLI ya arranco —o la pestana se fue—: en los dos casos deja de
          // haber algo que esperar.
          setWaking((current) => {
            if (current.size === 0) return current;
            const next = new Set(current);
            for (const id of current) {
              const found = message.terminals.find((t) => t.terminalId === id);
              if (found === undefined || found.alive) next.delete(id);
            }
            return next.size === current.size ? current : next;
          });
          // La pestana activa se elige solo entre las de la CLI: una consola
          // vive en el panel derecho y no tiene por que robar el foco de la
          // barra de pestanas.
          const agents = message.terminals.filter((t) => t.kind === 'agent');
          setActiveTerminalId((current) => {
            if (current !== null && agents.some((t) => t.terminalId === current)) return current;
            return agents[0]?.terminalId ?? null;
          });
          break;
        }

        case 'terminal.opened': {
          if (ownRequests.current.delete(message.requestId)) {
            // Abrir una consola no cambia de pestana: se abre al costado.
            if (message.terminal.kind === 'agent') {
              setActiveTerminalId(message.terminal.terminalId);
            }
          }
          const waiting = pendingOpen.current.get(message.requestId);
          if (waiting !== undefined) {
            pendingOpen.current.delete(message.requestId);
            waiting(message.terminal);
          }
          break;
        }

        case 'terminal.activity':
          setActivity((current) => {
            if (current.get(message.terminalId) === message.activity) return current;
            return new Map(current).set(message.terminalId, message.activity);
          });
          break;

        case 'index.status':
          setIndexStatus(message.status);
          break;

        case 'index.projects':
          setProjects((previous) =>
            mergeProjects(previous, message.projects, message.replace),
          );
          break;

        case 'error':
          // Un pedido del panel de memoria lo explica el panel, junto al
          // formulario que lo provoco: repetirlo arriba eran dos avisos con dos ×.
          if (isMemoryPanelRequest(message.requestId)) {
            if (message.detail !== undefined) console.error('[servidor]', message.detail);
            break;
          }
          setError({ message: message.message, at: Date.now() });
          // Un fallo al abrir la CLI no puede dejar el boton diciendo
          // "Abriendo…" para siempre.
          setWaking((current) => (current.size === 0 ? current : new Set()));
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          if (message.requestId !== undefined) {
            ownRequests.current.delete(message.requestId);
            // La pestana no se abrio: lo que iba a pasar despues, tampoco.
            pendingOpen.current.delete(message.requestId);
          }
          break;

        // La salida de las terminales la consume cada TerminalView; la
        // conversacion, useConversation; git y archivos, useGit y useFiles;
        // las notas, useNotes.
        case 'terminal.output':
        case 'terminal.replay':
        case 'terminal.exit':
        case 'terminal.closed':
        case 'conversation.reset':
        case 'conversation.append':
        case 'conversation.page':
        case 'conversation.state':
        case 'git.status':
        case 'git.diff':
        case 'files.listing':
        case 'files.preview':
        case 'files.results':
        case 'notes.list':
        case 'notes.imageData':
          break;
      }
    });

    connection.connect();

    return () => {
      offStatus();
      offMessage();
      connection.close();
    };
  }, [connection]);

  const openTerminal = useCallback(
    (options: {
      cwd: string;
      resumeSessionId?: string;
      label?: string;
      /** Se llama cuando el servidor confirma la pestana, con su descriptor. */
      onOpened?: (terminal: TerminalDescriptor) => void;
    }) => {
      const requestId = crypto.randomUUID();
      ownRequests.current.add(requestId);
      if (options.onOpened !== undefined) {
        pendingOpen.current.set(requestId, options.onOpened);
      }
      connection.send({
        type: 'terminal.open',
        requestId,
        cwd: options.cwd,
        ...(options.resumeSessionId !== undefined
          ? { resumeSessionId: options.resumeSessionId }
          : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
      });
    },
    [connection],
  );

  const openShell = useCallback(
    (cwd: string) => {
      // Sin requestId propio: una consola no pasa a ser la pestana activa, asi
      // que no hay nada que casar con la respuesta. Igual se manda uno porque
      // el protocolo lo exige y porque un error vuelve con el puesto.
      connection.send({ type: 'terminal.open', requestId: crypto.randomUUID(), cwd, kind: 'shell' });
    },
    [connection],
  );

  const closeTerminal = useCallback(
    (terminalId: TerminalId) => connection.send({ type: 'terminal.close', terminalId }),
    [connection],
  );

  const wakeTerminal = useCallback(
    (terminalId: TerminalId) => {
      setWaking((current) => new Set(current).add(terminalId));
      connection.send({ type: 'terminal.wake', terminalId });
    },
    [connection],
  );

  const renameTerminal = useCallback(
    (terminalId: TerminalId, label: string) =>
      connection.send({ type: 'terminal.rename', terminalId, label }),
    [connection],
  );

  const reorderTabs = useCallback(
    (terminalIds: TerminalId[]) => connection.send({ type: 'tabs.reorder', terminalIds }),
    [connection],
  );

  const archiveSessions = useCallback(
    (sessionIds: string[], archived: boolean) =>
      connection.send({ type: 'session.archive', sessionIds, archived }),
    [connection],
  );

  const refreshIndex = useCallback(
    () => connection.send({ type: 'index.refresh' }),
    [connection],
  );

  const dismissError = useCallback(() => setError(null), []);

  // Una sola lista del servidor, dos vistas. Repartirla aca y no en cada
  // componente es lo que evita que alguien se olvide del filtro y le muestre
  // una consola a la barra de pestanas.
  const terminals = useMemo(
    () => allTerminals.filter((terminal) => terminal.kind === 'agent'),
    [allTerminals],
  );
  const shells = useMemo(
    () => allTerminals.filter((terminal) => terminal.kind === 'shell'),
    [allTerminals],
  );

  return {
    connection,
    status,
    cliAvailable,
    cliVersion,
    cliMissingMessage,
    platform,
    defaultCwd,
    transcriptMarkerStripped,
    shellName,
    terminals,
    shells,
    activeTerminalId,
    projects,
    indexStatus,
    error,
    dismissError,
    setActiveTerminal: setActiveTerminalId,
    openTerminal,
    openShell,
    closeTerminal,
    wakeTerminal,
    waking,
    activity,
    renameTerminal,
    reorderTabs,
    refreshIndex,
    archiveSessions,
  };
}
