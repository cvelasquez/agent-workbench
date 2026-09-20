/**
 * Estado global de la app: conexion, pestanas e indice de sesiones.
 *
 * La lista de pestanas es siempre la que manda el servidor. El cliente no
 * mantiene su propia copia editable: si dos ventanas miran la misma app, las
 * dos ven lo mismo.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  NO_CAPABILITIES,
  PROTOCOL_VERSION,
  shouldOfferAgentChoice,
  type AgentCapabilities,
  type AgentId,
  type AgentInfo,
  type ComposerPrefillReason,
  type EnvironmentNoticeId,
  type HandoffDelivery,
  type SessionAgentId,
  type IndexStatus,
  type ProjectSummary,
  type ServerMessage,
  type TerminalActivity,
  type TerminalDescriptor,
  type TerminalId,
  type TerminalOfflineReason,
} from '@agent-workbench/shared';
import { summarizeAgents } from './agent-summary.js';
import {
  PENDING_OPEN_TIMEOUT_MS,
  advanceRelaunches,
  type PendingOpen,
  type RelaunchPhase,
} from './agent-ui.js';
import { AgentConnection, type ConnectionStatus } from './connection.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import { useLocale } from './i18n/useLocale.js';
import { isMemoryPanelRequest } from './useMemory.js';

export interface WorkspaceError {
  message: string;
  at: number;
}

export interface OpenTerminalRequest {
  cwd: string;
  resumeSessionId?: string;
  label?: string;
  /** Que CLI lanzar. Sin el campo decide el servidor. */
  agent?: AgentId;
  /** Se llama cuando el servidor confirma la pestana, con su descriptor. */
  onOpened?: (terminal: TerminalDescriptor) => void;
}

/**
 * Una pestana que continua una conversacion de otra CLI (hito 29): lo que dice
 * el aviso encima de su cuadro, hasta que el usuario mande algo o lo cierre.
 */
export interface HandoffNotice {
  /** La CLI —o la fuente importada— de la conversacion de origen. */
  sourceAgent: SessionAgentId;
  includedTurns: number;
  totalTurns: number;
  totalTurnsIsMinimum: boolean;
  /** `sending`: el servidor la esta mandando sola. `prefilled`: quedo en el cuadro. */
  delivery: HandoffDelivery;
  /** Por que quedo en el cuadro, si quedo; null mientras se manda sola. */
  prefillReason: ComposerPrefillReason | null;
}

/** Un texto que llego para el cuadro de una pestana y todavia no se aplico. */
export interface ComposerPrefill {
  /** Unico por llegada: el cuadro no aplica dos veces el mismo. */
  id: number;
  terminalId: TerminalId;
  text: string;
}

export interface Workspace {
  connection: AgentConnection;
  status: ConnectionStatus;
  /** Las CLIs que anuncio el servidor, instaladas o no. `[]` hasta el `hello`. */
  agents: AgentInfo[];
  /** La que usa una pestana nueva si nadie elige otra. */
  defaultAgent: AgentId | null;
  /** Lo que puede hacer la CLI de una pestana. Sin CLI conocida, nada. */
  capabilitiesFor: (agent: AgentId | null) => AgentCapabilities;
  /** true con mas de una CLI disponible: ahi tiene sentido elegir. */
  offerAgentChoice: boolean;
  /*
    Los tres que siguen salen de `agents` (ver `agent-summary.ts`). Se
    conservan con estos nombres porque con una sola CLI dicen lo mismo que
    decian cuando el servidor los mandaba sueltos.
  */
  cliAvailable: boolean;
  cliVersion: string | null;
  cliMissingMessage: string | null;
  /** `process.platform` del servidor. Decide el separador de las rutas. */
  platform: string;
  defaultCwd: string;
  /**
   * Aviso de entorno de alguna CLI. `child-session-marker`: el servidor tuvo
   * que quitar CLAUDE_CODE_CHILD_SESSION del entorno de las pestanas.
   */
  environmentNotice: EnvironmentNoticeId | null;
  /** "PowerShell", "bash"... o null si el servidor no encontro ninguna consola. */
  shellName: string | null;
  /**
   * Esta ventana entro como equipo remoto (hito 37): se esconde lo que el
   * servidor igual le negaria —administrar el acceso remoto, y lo que abre una
   * ventana en el escritorio del anfitrion—.
   */
  remoteClient: boolean;
  /** Pestanas de la CLI. Son las unicas que aparecen en la barra de pestanas. */
  terminals: TerminalDescriptor[];
  /** Consolas del sistema. Viven en la columna derecha, no en la barra. */
  shells: TerminalDescriptor[];
  /**
   * Las pestanas pedidas desde **esta** ventana que el servidor todavia no
   * confirmo (hito 31). La barra dibuja una provisional por cada una.
   */
  pendingOpens: readonly PendingOpen[];
  activeTerminalId: TerminalId | null;
  projects: ProjectSummary[];
  indexStatus: IndexStatus;
  error: WorkspaceError | null;
  dismissError: () => void;
  setActiveTerminal: (terminalId: TerminalId) => void;
  openTerminal: (options: OpenTerminalRequest) => void;
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
  /**
   * Por que una pestana con proceso quedo `offline` (hito 29, M2): hoy solo
   * `server-closed`. Ausente = sin motivo.
   */
  offlineReasons: ReadonlyMap<TerminalId, TerminalOfflineReason>;
  /** Pestanas cuyo servidor se cerro y que se estan relanzando. */
  relaunching: ReadonlySet<TerminalId>;
  renameTerminal: (terminalId: TerminalId, label: string) => void;
  reorderTabs: (terminalIds: TerminalId[]) => void;
  refreshIndex: () => void;
  /**
   * Pide que el servidor relea lo que cada CLI anuncia de su configuracion (la
   * status line) y mande la lista de nuevo. El boton "Comprobar".
   */
  refreshAgents: () => void;
  /** Esconde de la barra lateral, o restaura. No borra ningun archivo. */
  archiveSessions: (sessionIds: string[], archived: boolean) => void;
  /**
   * Continua una conversacion con otra CLI (hito 29). La pestana nueva pasa a
   * ser la activa, como una que se abre desde aca.
   */
  continueSession: (source: { agent: SessionAgentId; sessionId: string }, target: AgentId, label: string) => void;
  /** El aviso de continuacion de cada pestana que lo tiene. */
  handoffs: ReadonlyMap<TerminalId, HandoffNotice>;
  /** Cierra el aviso de una pestana: con la ×, o al mandar el primer mensaje. */
  dismissHandoff: (terminalId: TerminalId) => void;
  /** Textos para el cuadro de escritura que llegaron del servidor, en orden. */
  prefills: readonly ComposerPrefill[];
  /** El cuadro ya aplico ese texto. */
  prefillApplied: (id: number) => void;
}

const EMPTY_INDEX_STATUS: IndexStatus = { state: 'idle', scannedFiles: 0, totalFiles: 0 };

function mergeProjects(
  previous: ProjectSummary[],
  incoming: ProjectSummary[],
  replace: boolean,
): ProjectSummary[] {
  // Por `key`, que calcula el servidor: el cliente no sabe si en su plataforma
  // las mayusculas de una ruta importan.
  const byKey = new Map(replace ? [] : previous.map((project) => [project.key, project]));
  for (const project of incoming) byKey.set(project.key, project);
  return [...byKey.values()].sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

export function useWorkspace(): Workspace {
  const connection = useMemo(() => new AgentConnection(), []);

  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [defaultAgent, setDefaultAgent] = useState<AgentId | null>(null);
  const [helloReceived, setHelloReceived] = useState(false);
  /** Del `hello`: uno anterior al de esta pagina es un servidor sin reiniciar. */
  const [serverProtocolVersion, setServerProtocolVersion] = useState(PROTOCOL_VERSION);
  const [platform, setPlatform] = useState('');
  const [defaultCwd, setDefaultCwd] = useState('');
  const [shellName, setShellName] = useState<string | null>(null);
  const [remoteClient, setRemoteClient] = useState(false);
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
  /*
    Hito 29 (M2): el motivo de un `offline` con proceso, y los relanzamientos en
    curso. Los relanzamientos se siguen por la lista de pestanas
    (`advanceRelaunches`): el TUI viejo sale y el nuevo nace, y "Abriendo…" no
    se puede soltar con la primera lista que diga "viva", que es la del viejo.
  */
  const [offlineReasons, setOfflineReasons] = useState<Map<TerminalId, TerminalOfflineReason>>(new Map());
  const offlineReasonsRef = useRef<ReadonlyMap<TerminalId, TerminalOfflineReason>>(new Map());
  const relaunchPhases = useRef<Map<TerminalId, RelaunchPhase>>(new Map());
  const [relaunching, setRelaunching] = useState<ReadonlySet<TerminalId>>(new Set());
  const [error, setError] = useState<WorkspaceError | null>(null);
  /*
    Hito 31: las pestanas pedidas que el servidor todavia no confirmo. La barra
    dibuja una provisional por cada una, en el sitio donde va a caer, y el `+`
    de ese proyecto queda apagado hasta que llegue. Ver `PendingOpen`.
  */
  const [pendingOpens, setPendingOpens] = useState<readonly PendingOpen[]>([]);
  /*
    Hito 29. Los avisos de continuacion y los textos prellenados viven aca y no
    en el cuadro: el cuadro no esta montado si no habia ninguna pestana, y el
    texto de la primera continuacion llega antes de que exista.
  */
  const [handoffs, setHandoffs] = useState<Map<TerminalId, HandoffNotice>>(new Map());
  const [prefills, setPrefills] = useState<ComposerPrefill[]>([]);
  const nextPrefillId = useRef(1);

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
  /*
    Los plazos de las provisionales, uno por pedido. Lo normal es que la suelte
    la respuesta; esto es la red por si no llega ninguna (`PENDING_OPEN_TIMEOUT_MS`).
  */
  const pendingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * Suelta la provisional de un pedido, y su plazo.
   *
   * La llaman los tres caminos que ya sueltan "Abriendo…" y "Relanzando…": la
   * confirmacion, el error de **ese** pedido y la reconexion.
   */
  const dropPending = useCallback((requestId: string) => {
    const timer = pendingTimers.current.get(requestId);
    if (timer !== undefined) {
      clearTimeout(timer);
      pendingTimers.current.delete(requestId);
    }
    setPendingOpens((current) =>
      current.some((pending) => pending.requestId === requestId)
        ? current.filter((pending) => pending.requestId !== requestId)
        : current,
    );
  }, []);

  const dropAllPending = useCallback(() => {
    for (const timer of pendingTimers.current.values()) clearTimeout(timer);
    pendingTimers.current.clear();
    setPendingOpens((current) => (current.length === 0 ? current : []));
  }, []);

  useEffect(() => {
    // Sin token en la URL se intenta igual: tras una recarga autentica la
    // cookie de sesion. Solo si la conexion falla de verdad se avisa.
    const offStatus = connection.onStatus((next) => {
      setStatus(next);
      if (next === 'failed') {
        setError({ message: t('workspace.connectFailed'), at: Date.now() });
      }
    });
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        /*
          La lista de CLIs otra vez: cambio lo que anuncia alguna —el usuario
          configuro su status line (hito 27)—, o es la respuesta a "Comprobar".
          Reemplaza a la del `hello`; el resto de lo que trae el `hello` no cambia.
        */
        case 'agents':
          setAgents(message.agents);
          setDefaultAgent(message.defaultAgent);
          break;

        case 'hello':
          setAgents(message.agents);
          setDefaultAgent(message.defaultAgent);
          setHelloReceived(true);
          setServerProtocolVersion(message.protocolVersion);
          setPlatform(message.platform);
          setDefaultCwd(message.defaultCwd);
          setShellName(message.shellName);
          setRemoteClient(message.remoteClient);
          break;

        case 'terminal.list': {
          setAllTerminals(message.terminals);
          const relaunches = advanceRelaunches(relaunchPhases.current, message.terminals);
          const relaunchChanged =
            relaunches.finished.length > 0 ||
            [...relaunches.phases].some(([id, phase]) => relaunchPhases.current.get(id) !== phase);
          relaunchPhases.current = relaunches.phases;
          if (relaunchChanged) setRelaunching(new Set(relaunches.phases.keys()));
          // La CLI ya arranco —o la pestana se fue—: en los dos casos deja de
          // haber algo que esperar. Salvo un relanzamiento en curso.
          setWaking((current) => {
            if (current.size === 0) return current;
            const next = new Set(current);
            for (const id of current) {
              if (relaunches.phases.has(id)) continue;
              const found = message.terminals.find((t) => t.terminalId === id);
              if (found === undefined || found.alive) next.delete(id);
            }
            return next.size === current.size ? current : next;
          });
          setOfflineReasons((current) => {
            if (current.size === 0) return current;
            const next = new Map([...current].filter(([id]) => message.terminals.some((t) => t.terminalId === id)));
            if (next.size === current.size) return current;
            offlineReasonsRef.current = next;
            return next;
          });
          // La pestana activa se elige solo entre las de la CLI: una consola
          // vive en el panel derecho y no tiene por que robar el foco de la
          // barra de pestanas.
          const agentTabs = message.terminals.filter((t) => t.kind === 'agent');
          setActiveTerminalId((current) => {
            if (current !== null && agentTabs.some((t) => t.terminalId === current)) return current;
            return agentTabs[0]?.terminalId ?? null;
          });
          // El aviso de una continuacion se va con su pestana.
          setHandoffs((current) => {
            if (current.size === 0) return current;
            const next = new Map(current);
            for (const id of current.keys()) {
              if (!message.terminals.some((t) => t.terminalId === id)) next.delete(id);
            }
            return next.size === current.size ? current : next;
          });
          break;
        }

        /*
          Una continuacion quedo armada (hito 29). Llega despues del
          `terminal.opened` que activo la pestana, y anota el aviso que va
          encima de su cuadro.
        */
        case 'session.continued':
          setHandoffs((current) =>
            new Map(current).set(message.terminalId, {
              sourceAgent: message.source.agent,
              includedTurns: message.includedTurns,
              totalTurns: message.totalTurns,
              totalTurnsIsMinimum: message.totalTurnsIsMinimum,
              delivery: message.delivery,
              prefillReason: null,
            }),
          );
          break;

        /*
          Un texto para el cuadro de una pestana: la continuacion que no se
          manda sola, o que no se pudo mandar. Nunca se manda desde aca.
        */
        case 'composer.prefill': {
          const id = nextPrefillId.current;
          nextPrefillId.current += 1;
          setPrefills((current) => [...current, { id, terminalId: message.terminalId, text: message.text }]);
          setHandoffs((current) => {
            const notice = current.get(message.terminalId);
            if (notice === undefined) return current;
            return new Map(current).set(message.terminalId, {
              ...notice,
              delivery: 'prefilled',
              prefillReason: message.reason,
            });
          });
          break;
        }

        case 'terminal.opened': {
          // La de verdad ya esta en la lista: la provisional sobra, y sale
          // antes de activar nada para que no se dibujen las dos.
          dropPending(message.requestId);
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
          setOfflineReasons((current) => {
            const reason = message.offlineReason ?? null;
            if ((current.get(message.terminalId) ?? null) === reason) return current;
            const next = new Map(current);
            if (reason === null) next.delete(message.terminalId);
            else next.set(message.terminalId, reason);
            offlineReasonsRef.current = next;
            return next;
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
          // Lo mismo con la copia propia (hito 28): lo dice su dialogo, o su
          // propio aviso si el dialogo esta cerrado. Ver `useVault`.
          if (message.code === 'vault-failed') break;
          // Y la busqueda global (hito 29): lo dice su linea de estado, en la barra.
          if (message.code === 'search-failed') break;
          // Y el acceso remoto (hito 37): lo dice su dialogo. Ver `useRemoteAccess`.
          if (message.code === 'remote-failed') break;
          setError({ message: serverTextMessage(message.text), at: Date.now() });
          // Un fallo al abrir la CLI no puede dejar el boton diciendo
          // "Abriendo…" para siempre. Ni "Relanzando…".
          setWaking((current) => (current.size === 0 ? current : new Set()));
          if (relaunchPhases.current.size > 0) {
            relaunchPhases.current = new Map();
            setRelaunching(new Set());
          }
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          if (message.requestId !== undefined) {
            ownRequests.current.delete(message.requestId);
            // La pestana no se abrio: lo que iba a pasar despues, tampoco.
            pendingOpen.current.delete(message.requestId);
            dropPending(message.requestId);
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
        case 'conversation.toolCall':
        case 'git.status':
        case 'git.diff':
        case 'files.listing':
        case 'files.preview':
        case 'files.results':
        case 'notes.list':
        case 'notes.imageData':
        case 'search.progress':
        case 'search.results':
          break;
      }
    });

    /*
      Al reconectar se sueltan "Abriendo…" y "Relanzando…" (hito 29, M2). Los
      dos esperan algo que pudo perderse con el socket viejo: el `error` de un
      fallo se mando a quien ya no estaba, y un relanzamiento pudo terminar sin
      que esta pagina viera la lista del medio —el TUI viejo muerto—, que es la
      unica que lo hace avanzar. La lista que manda el servidor al conectar dice
      como quedo cada pestana, y con eso decide la barra: Relanzar si el motivo
      sigue, la de siempre si no. Corre despues de vaciar la cola de salida, asi
      que un clic con el socket caido tampoco queda esperando.
    */
    const offReopen = connection.onReopen(() => {
      // La respuesta a un pedido viaja por el socket que lo recibio: con el
      // socket caido no va a llegar nunca, y la lista que manda el servidor al
      // conectar ya dice que pestanas hay.
      dropAllPending();
      setWaking((current) => (current.size === 0 ? current : new Set()));
      if (relaunchPhases.current.size > 0) {
        relaunchPhases.current = new Map();
        setRelaunching(new Set());
      }
    });

    connection.connect();

    return () => {
      offStatus();
      offMessage();
      offReopen();
      connection.close();
    };
  }, [connection, dropPending, dropAllPending]);

  // Los plazos de las provisionales no sobreviven al desmontaje.
  useEffect(() => dropAllPending, [dropAllPending]);

  const openTerminal = useCallback(
    (options: OpenTerminalRequest) => {
      const requestId = crypto.randomUUID();
      ownRequests.current.add(requestId);
      if (options.onOpened !== undefined) {
        pendingOpen.current.set(requestId, options.onOpened);
      }
      /*
        La provisional se anota **antes** de mandar: es lo que hace que el clic
        conteste en el acto, que es todo el pedido. Sale con `terminal.opened`,
        con el `error` de este mismo pedido, al reconectar, o por plazo.
      */
      setPendingOpens((current) => [
        ...current,
        {
          requestId,
          cwd: options.cwd,
          agent: options.agent ?? null,
          label: options.label ?? '',
          at: Date.now(),
        },
      ]);
      const timer = setTimeout(() => dropPending(requestId), PENDING_OPEN_TIMEOUT_MS);
      pendingTimers.current.set(requestId, timer);
      connection.send({
        type: 'terminal.open',
        requestId,
        cwd: options.cwd,
        ...(options.resumeSessionId !== undefined
          ? { resumeSessionId: options.resumeSessionId }
          : {}),
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}),
      });
    },
    [connection, dropPending],
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
      // Con el servidor cerrado, despertar es relanzar: el TUI viejo sale antes (M2).
      if (offlineReasonsRef.current.get(terminalId) === 'server-closed') {
        relaunchPhases.current = new Map(relaunchPhases.current).set(terminalId, 'waiting-exit');
        setRelaunching(new Set(relaunchPhases.current.keys()));
      }
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

  const continueSession = useCallback(
    (source: { agent: SessionAgentId; sessionId: string }, target: AgentId, label: string) => {
      const requestId = crypto.randomUUID();
      // Como una pestana que se abre desde aca: sin esto, el `terminal.opened`
      // de la continuacion no la activaria (B5).
      ownRequests.current.add(requestId);
      connection.send({
        type: 'session.continue',
        requestId,
        agent: source.agent,
        sessionId: source.sessionId,
        target,
        label,
      });
    },
    [connection],
  );

  const dismissHandoff = useCallback((terminalId: TerminalId) => {
    setHandoffs((current) => {
      if (!current.has(terminalId)) return current;
      const next = new Map(current);
      next.delete(terminalId);
      return next;
    });
  }, []);

  const prefillApplied = useCallback((id: number) => {
    setPrefills((current) => (current.some((item) => item.id === id) ? current.filter((item) => item.id !== id) : current));
  }, []);

  const refreshIndex = useCallback(
    () => connection.send({ type: 'index.refresh' }),
    [connection],
  );

  const refreshAgents = useCallback(
    () => connection.send({ type: 'agents.refresh' }),
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

  // `summarizeAgents` arma textos: el idioma entra en las dependencias.
  const locale = useLocale();
  const summary = useMemo(
    () => summarizeAgents(agents, helloReceived, serverProtocolVersion),
    [agents, helloReceived, serverProtocolVersion, locale],
  );
  const capabilitiesFor = useCallback(
    (agent: AgentId | null): AgentCapabilities =>
      (agent === null ? undefined : agents.find((info) => info.id === agent)?.capabilities) ??
      NO_CAPABILITIES,
    [agents],
  );
  const offerAgentChoice = useMemo(() => shouldOfferAgentChoice(agents), [agents]);

  return {
    connection,
    status,
    agents,
    defaultAgent,
    capabilitiesFor,
    offerAgentChoice,
    cliAvailable: summary.cliAvailable,
    cliVersion: summary.cliVersion,
    cliMissingMessage: summary.cliMissingMessage,
    platform,
    defaultCwd,
    environmentNotice: summary.environmentNotice,
    shellName,
    remoteClient,
    terminals,
    shells,
    /** Hito 31: las pedidas que el servidor todavia no confirmo. */
    pendingOpens,
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
    offlineReasons,
    relaunching,
    renameTerminal,
    reorderTabs,
    refreshIndex,
    refreshAgents,
    archiveSessions,
    continueSession,
    handoffs,
    dismissHandoff,
    prefills,
    prefillApplied,
  };
}
