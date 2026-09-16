import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  HANDOFF_SENDING_TEXT,
  continueBlockedReason,
  continueTargets,
  controlsFor,
  discoveringSession,
  handoffNoticeText,
  handoffPrefillText,
  sessionAgentLabel,
  effectivePanelTab,
  instructionsFileFor,
  modelChoiceNote,
  openToolCallNotice,
  pendingApprovalNotice,
  projectAgent,
  serverClosedBarState,
  serverClosedBarText,
  sessionResumable,
  shortcutsAgent,
  openBlockedFor,
  tabBarAgent,
  OPEN_BLOCKED_TITLE,
} from './agent-ui.js';
import { AgentControls } from './AgentControls.js';
import { ModeControl } from './ModeControl.js';
import { Composer } from './Composer.js';
import { ConsolePane } from './ConsolePane.js';
import { ConversationView } from './ConversationView.js';
import { FolderPicker } from './FolderPicker.js';
import { globalSearchVisible, searchHitAction } from './global-search-ui.js';
import { ShortcutsDialog } from './ShortcutsDialog.js';
import { StatusLineDialog } from './StatusLineDialog.js';
import { Sidebar } from './Sidebar.js';
import { SidePanel, type PanelTab } from './SidePanel.js';
import { TabBar } from './TabBar.js';
import { TerminalView } from './TerminalView.js';
import { useCliActivity } from './useCliActivity.js';
import { useDragSize } from './useDragSize.js';
import { readStored, writeStored } from './window-prefs.js';
import { useConversation } from './useConversation.js';
import { useFiles } from './useFiles.js';
import { useGlobalSearch } from './useGlobalSearch.js';
import { usePlans } from './usePlans.js';
import { useGit } from './useGit.js';
import { useMemory } from './useMemory.js';
import { useNotes } from './useNotes.js';
import { THEME_ICON, THEME_LABEL, useTheme } from './useTheme.js';
import { useNotificationSound } from './useNotificationSound.js';
import { soundButtonTitle } from './notification-sound.js';
import { useVault } from './useVault.js';
import { useWorkspace } from './useWorkspace.js';
import { VaultDialog } from './VaultDialog.js';
import type { ConnectionStatus } from './connection.js';
import { blindToApprovals, type GlobalSearchHit, type TerminalId } from '@agent-workbench/shared';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connecting: 'Conectando',
  open: 'Conectada',
  reconnecting: 'Reconectando',
  failed: 'Sin conexion',
};

/**
 * Limites del panel derecho.
 *
 * Los numeros subieron en el hito 7 y no por gusto: ahi vive ahora la interfaz
 * de la CLI, que dibuja diffs, tablas y cajas. A 460 px eran ~55 columnas y
 * todo eso salia partido. El default de 640 px da ~78 columnas, que es lo
 * minimo con lo que un diff se lee, y el maximo sube para que "expandir" sea de
 * verdad expandir.
 *
 * El minimo, en cambio, baja poco: por debajo de 320 px la CLI no se puede usar
 * y el usuario ya tiene el interruptor para esconderla del todo.
 */
const PANEL_MIN_WIDTH = 320;
const PANEL_MAX_WIDTH = 1400;
const PANEL_DEFAULT_WIDTH = 640;

/**
 * Limites de la barra de proyectos.
 *
 * Es una lista de nombres de carpeta y de titulos de sesion, y esos titulos
 * casi nunca son cortos: el default de 270 px corta la mayoria. El maximo deja
 * ver un titulo entero sin que la barra se coma el chat; el minimo es donde
 * todavia se distingue un proyecto de otro — mas angosta que eso, lo que
 * corresponde es esconderla.
 */
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 560;
const SIDEBAR_DEFAULT_WIDTH = 270;

/**
 * Limites de la consola, en alto.
 *
 * El minimo son unas seis lineas: menos que eso y no se ve la salida de un
 * `git status`. El maximo deja siempre algo del panel de arriba visible, que es
 * justamente la razon de que la consola vaya abajo y no en una cuarta solapa.
 */
const CONSOLE_MIN_HEIGHT = 120;
const CONSOLE_MAX_HEIGHT = 720;
const CONSOLE_DEFAULT_HEIGHT = 260;

const PANEL_WIDTH_KEY = 'agent-workbench.panel-width';
const PANEL_VISIBLE_KEY = 'agent-workbench.panel-visible';
const PANEL_TAB_KEY = 'agent-workbench.panel-tab';
const PANEL_EXPANDED_KEY = 'agent-workbench.panel-expanded';
const SIDEBAR_VISIBLE_KEY = 'agent-workbench.sidebar-visible';
const SIDEBAR_WIDTH_KEY = 'agent-workbench.sidebar-width';
const CONSOLE_VISIBLE_KEY = 'agent-workbench.console-visible';
const CONSOLE_HEIGHT_KEY = 'agent-workbench.console-height';
const MARKER_NOTICE_KEY = 'agent-workbench.marker-notice-dismissed';


export function App(): JSX.Element {
  const workspace = useWorkspace();
  const {
    connection,
    status,
    agents,
    defaultAgent,
    capabilitiesFor,
    offerAgentChoice,
    cliAvailable,
    cliVersion,
    cliMissingMessage,
    platform,
    defaultCwd,
    environmentNotice,
    shellName,
    terminals,
    archiveSessions,
    shells,
    pendingOpens,
    activeTerminalId,
    projects,
    indexStatus,
    error,
    dismissError,
    setActiveTerminal,
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
    continueSession,
    handoffs,
    dismissHandoff,
    prefills,
    prefillApplied,
  } = workspace;

  const theme = useTheme();
  const sound = useNotificationSound(activity);
  const activeTerminal = terminals.find((t) => t.terminalId === activeTerminalId) ?? null;

  /*
    Lo que puede hacer la CLI de la pestana activa.

    La pantalla no pregunta de que CLI se trata: pregunta si tiene ciclo de
    modos, si recibe imagenes, si tiene planes. Cada control de abajo se
    dibuja o se esconde por esto, y la traduccion vive en `agent-ui.ts`, que es
    donde la prueba el chequeo. Con la CLI de hoy todo esta encendido.
  */
  const activeAgent = activeTerminal?.agent ?? null;
  const activeCapabilities = capabilitiesFor(activeAgent);
  const activeControls = useMemo(() => controlsFor(activeCapabilities), [activeCapabilities]);
  /*
    Lo que anuncia la CLI de la pestana activa ademas de sus capacidades: el
    nombre y, si tiene, su status line opcional (hito 27). Cambia sin recargar
    cuando el usuario la configura: el servidor manda la lista de nuevo.
  */
  const activeAgentInfo = agents.find((info) => info.id === activeAgent) ?? null;
  const activeStatusLine = activeAgentInfo?.statusLine ?? null;

  /*
    Con que CLI abre el `+` de la barra de pestanas cuando hay para elegir: la
    del ultimo trabajo en el proyecto de la pestana activa, o la de por
    defecto. Con una sola CLI no se calcula: el boton abre sin nombrar ninguna,
    como siempre, y decide el servidor.
  */
  const newTabCwd = activeTerminal?.cwd ?? defaultCwd;
  const newTabAgent = useMemo(
    () =>
      offerAgentChoice ? tabBarAgent(terminals, newTabCwd, platform, agents, defaultAgent) : null,
    [offerAgentChoice, terminals, newTabCwd, platform, agents, defaultAgent],
  );
  /*
    Hito 31: mientras esa carpeta tiene una pestana en camino, el `+` se apaga
    y lo dice. Es la otra mitad del pedido —que el segundo clic no abra una
    segunda pestana "por si el primero no entro"— y vale igual para `Alt+T`,
    que usa esta misma regla.
  */
  const newTabBlocked = useMemo(
    () => openBlockedFor(pendingOpens, newTabCwd, platform),
    [pendingOpens, newTabCwd, platform],
  );
  const newTabBlockedTitle = newTabBlocked ? OPEN_BLOCKED_TITLE : null;

  /*
    Las notas viven aca y no en la barra lateral: la barra se desmonta al
    esconderla, y el estado —lista, imagenes ya pedidas— tiene que sobrevivir a
    eso. Es la misma razon por la que el espacio de trabajo no vive en `TabBar`.
  */
  const notes = useNotes(connection);

  /*
    La copia propia (hito 28), aca por lo mismo que las notas: el estado llega
    del servidor en cualquier momento y la barra que lo muestra se desmonta.
  */
  const vault = useVault(connection);
  const [vaultDialogVisible, setVaultDialogVisible] = useState(false);

  /*
    El buscador global (hito 29), sobre la copia. Solo con otra CLI y con algo
    en la copia: si no, la barra es la de siempre. El texto que un acierto deja
    en el buscador del hilo espera aca a que la vista lo tome: si no habia
    ninguna pestana, la vista todavia no existe.
  */
  const globalSearch = useGlobalSearch(connection);
  const globalSearchShown = globalSearchVisible(agents, vault.status);
  const [threadSearch, setThreadSearch] = useState<{ query: string; seq: number } | null>(null);
  const threadSearchSeq = useRef(0);
  const threadSearchApplied = useCallback((seq: number) => {
    setThreadSearch((current) => (current !== null && current.seq === seq ? null : current));
  }, []);

  /**
   * Un acierto: la sesion con pestana se activa, una fila que se retoma se abre
   * como desde la barra, y lo demas —solo en la copia, sin su CLI o sin su
   * carpeta— se abre en Markdown, que no depende de nada de eso.
   */
  const openSearchHit = (hit: GlobalSearchHit, threadQuery: string): void => {
    const action = searchHitAction(hit, {
      projects,
      terminals,
      platform,
      canResume: (agent) => sessionResumable(agents, agent),
    });
    const leaveThreadQuery = (): void => {
      if (threadQuery.length === 0) return;
      threadSearchSeq.current += 1;
      setThreadSearch({ query: threadQuery, seq: threadSearchSeq.current });
    };
    switch (action.kind) {
      case 'activate':
        setActiveTerminal(action.terminalId);
        leaveThreadQuery();
        break;
      case 'resume':
        // Como el clic en la fila: abrir una archivada la devuelve a la lista.
        if (action.session.archived) archiveSessions([action.session.sessionId], false);
        openTerminal({
          cwd: action.cwd,
          resumeSessionId: action.session.sessionId,
          agent: action.session.agent,
          label: action.session.title,
        });
        leaveThreadQuery();
        break;
      case 'copy':
        vault.openSession(hit.agent, hit.sessionId);
        break;
    }
  };

  /*
    Que sesiones tienen una pestana abierta. La barra lateral las necesita para
    no ofrecer archivar lo que se esta usando: esconder de la lista la fila que
    explica la pestana que uno tiene delante no resuelve nada.
  */
  const openSessionIds = useMemo(
    () => new Set(terminals.map((t) => t.sessionId).filter((id) => id.length > 0)),
    [terminals],
  );

  const [panelVisible, setPanelVisible] = useState(() =>
    readStored(PANEL_VISIBLE_KEY, true, (raw) => raw === 'true'),
  );
  const [panelTab, setPanelTab] = useState<PanelTab>(() =>
    // `conversation` es el valor guardado por las versiones anteriores, cuando
    // la conversacion vivia aca. Ahora esta en el centro y la solapa que quedo
    // en su lugar es la CLI: se migra en silencio en vez de caer al default.
    readStored<PanelTab>(PANEL_TAB_KEY, 'cli', (raw) =>
      raw === 'git' ||
      raw === 'files' ||
      raw === 'cli' ||
      raw === 'plans' ||
      raw === 'memory'
        ? raw
        : raw === 'conversation'
          ? 'cli'
          : null,
    ),
  );
  const [panelWidth, setPanelWidth] = useState(() =>
    readStored(PANEL_WIDTH_KEY, PANEL_DEFAULT_WIDTH, (raw) => {
      const parsed = Number.parseInt(raw, 10);
      // El ancho guardado por una version anterior puede ser mas chico que el
      // minimo de hoy; se sube al default en vez de dejar la CLI ilegible.
      if (!Number.isFinite(parsed)) return null;
      return Math.max(parsed, PANEL_MIN_WIDTH);
    }),
  );
  const [panelExpanded, setPanelExpanded] = useState(() =>
    readStored(PANEL_EXPANDED_KEY, false, (raw) => raw === 'true'),
  );
  const [sidebarVisible, setSidebarVisible] = useState(() =>
    readStored(SIDEBAR_VISIBLE_KEY, true, (raw) => raw === 'true'),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStored(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH, (raw) => {
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed)) return null;
      return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
    }),
  );
  const [consoleVisible, setConsoleVisible] = useState(() =>
    readStored(CONSOLE_VISIBLE_KEY, false, (raw) => raw === 'true'),
  );
  const [consoleHeight, setConsoleHeight] = useState(() =>
    readStored(CONSOLE_HEIGHT_KEY, CONSOLE_DEFAULT_HEIGHT, (raw) => {
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) ? parsed : null;
    }),
  );
  const [markerNoticeVisible, setMarkerNoticeVisible] = useState(() =>
    readStored(MARKER_NOTICE_KEY, true, (raw) => raw !== 'true'),
  );
  const [shortcutsVisible, setShortcutsVisible] = useState(false);
  /** El dialogo de la status line de la CLI de la pestana activa (hito 27). */
  const [statusLineDialogVisible, setStatusLineDialogVisible] = useState(false);
  // Una pestana de otra CLI cierra el dialogo: volver no tiene por que reabrirlo.
  useEffect(() => {
    if (activeStatusLine === null) setStatusLineDialogVisible(false);
  }, [activeStatusLine]);
  /**
   * El selector de carpetas: para empezar un proyecto nuevo, o para elegir la
   * carpeta de la copia propia (hito 28). Uno solo a la vez.
   */
  const [pickerFor, setPickerFor] = useState<'project' | 'vault' | null>(null);

  const panelOpen = panelVisible && activeTerminal !== null;

  /*
    La solapa que se ve. La guardada no se pisa: una pestana cuya CLI no tiene
    planes muestra la CLI, y al volver a una que si, se vuelve a Planes.
  */
  const shownPanelTab = effectivePanelTab(panelTab, activeControls.plansAvailable);

  /*
    La columna derecha se dibuja si hay algo que poner en ella: el panel de
    solapas, la consola, o los dos. Son dos interruptores independientes a
    proposito — mirar `git status` en la consola mientras el panel de cambios
    esta escondido es un caso de uso, no un estado invalido.
  */
  const rightColumnOpen = activeTerminal !== null && (panelVisible || consoleVisible);

  /*
    Las consolas del directorio de la pestana activa.

    Se buscan por `cwd` y no por un id de parentesco: dos pestanas del mismo
    proyecto comparten sus consolas, que es lo que uno espera al abrir "una
    terminal en el proyecto", y sale solo sin agregarle un campo al protocolo.

    Desde el hito 17 son varias. La activa se guarda por id y no por indice:
    cerrar la primera no tiene por que mover a cual estabas mirando.
  */
  const consoleShells = useMemo(
    () =>
      activeTerminal === null
        ? []
        : shells.filter((shell) => shell.cwd === activeTerminal.cwd),
    [shells, activeTerminal],
  );

  const [activeShellId, setActiveShellId] = useState<TerminalId | null>(null);

  const activeShell =
    consoleShells.find((shell) => shell.terminalId === activeShellId) ?? consoleShells[0] ?? null;

  /*
    Que se suscribe y cuando.

    La conversacion pasa a estar **siempre** suscrita: desde el hito 7 es la
    vista principal y no una solapa que se turna. El estado de git se pide con
    el panel abierto aunque su solapa no este delante, porque de ahi sale el
    numerito de archivos tocados que se ve en la solapa —la diferencia entre un
    dato que se mira y uno que avisa—, y el arbol de archivos solo con su solapa
    delante, que es un lector de directorios del lado del servidor.
  */
  const conversation = useConversation(connection, activeTerminalId);
  const git = useGit(connection, panelOpen ? activeTerminalId : null);
  const files = useFiles(
    connection,
    panelOpen && shownPanelTab === 'files' ? activeTerminalId : null,
  );
  /*
    Los planes se escuchan siempre, no solo con la solapa delante: la lista
    llega con la conversacion —no se pide— y es lo que alimenta el contador de
    la solapa. Es la misma excepcion que ya tenia git, por el mismo motivo: un
    dato que avisa no puede depender de estar mirandolo.
  */
  const plans = usePlans(connection, activeTerminalId);
  /*
    La memoria, con el panel abierto aunque su solapa no este delante, como
    git: de ahi sale la pastilla con la cantidad de notas, y una pastilla que
    solo aparece mirando la lista no avisa nada —y ademas ensanchaba la solapa
    al entrar—. El watcher del servidor mira un puñado de nombres del proyecto
    y no recorre nada, asi que tenerlo prendido no cuesta lo que un arbol.
  */
  const memory = useMemory(connection, panelOpen ? activeTerminalId : null);

  /*
    La CLI esta a la vista si su solapa esta delante y el panel abierto. Si no,
    lo que escriba se cuenta como no visto y la solapa lo avisa con un punto.
  */
  const cliVisible = panelOpen && shownPanelTab === 'cli';

  /*
    Modelo y esfuerzo en uso, leidos del archivo de sesion.

    No se guarda lo que elegimos en los combos: si lo hicieramos, el combo
    diria una cosa mientras la CLI usa otra en cuanto un comando fuera
    rechazado, o en cuanto el usuario lo cambiara tecleando en la pestana CLI.
    El esfuerzo se busca hacia atras porque no todas las lineas lo traen.
  */
  const observedModel = conversation.usage.lastModel;
  /*
    Si la CLI publica el esfuerzo en el acto (`usage.lastEffort`), manda eso:
    el historial lo dice recien con el mensaje siguiente, y el combo de modelo
    —que sale de `usage`— ya habria cambiado (R27-5 del hito 27). Con Claude
    Code el campo no viene y se busca en los eventos, como siempre.
  */
  const observedEffort =
    conversation.usage.lastEffort ??
    [...conversation.events].reverse().find((event) => event.effort !== null)?.effort ??
    null;

  /*
    Hasta la primera respuesta no hay nada observado, y ahi vale lo que dice la
    configuracion: es de donde la CLI saco el banner que el usuario esta viendo
    en la pestana CLI. En cuanto llega una linea del archivo, manda el archivo.
  */
  const currentModel = observedModel ?? conversation.defaults.model;
  const currentEffort = observedEffort ?? conversation.defaults.effort;
  const modelProvisional = observedModel === null && currentModel !== null;
  const effortProvisional = observedEffort === null && currentEffort !== null;
  const cliUnseen = useCliActivity(connection, activeTerminalId, cliVisible);

  /*
    Por que el cuadro no deja mandar, si no deja. Solo una pestana cuyo estado
    no se ve —su CLI no lo publica, o no publico nada para ella (R27-1)— y con
    una herramienta sin resultado: puede ser un menu de aprobacion, y un
    mensaje llegaria ahi como teclas (A1 del hito 25). Con Claude Code es
    siempre null: ella si dice cuando espera.
  */
  const activeActivity = activeTerminalId === null ? null : (activity.get(activeTerminalId) ?? null);
  const toolCallNotice = openToolCallNotice(
    activeCapabilities,
    conversation.openToolCall,
    activeAgentInfo?.label ?? null,
    activeTerminal?.alive ?? false,
    activeActivity,
  );
  /*
    Y una CLI cuya confirmacion abierta aprueba un Enter (R27-2), o cuya espera
    bloquea el cuadro (hito 29, D12), mientras dice que espera: la barra de
    "esperando" ya esta a la vista, y Enviar se apaga con su mismo texto. Con
    Claude Code es siempre null.
  */
  /*
    Y el servidor de la CLI que se cerro con la pestana enganchada (hito 29,
    M2): el TUI sigue vivo pero no llega a nada, y un mensaje se perderia.
  */
  const activeServerClosed = serverClosedBarState({
    offlineReason: activeTerminalId === null ? null : (offlineReasons.get(activeTerminalId) ?? null),
    alive: activeTerminal?.alive ?? false,
    relaunching: activeTerminalId !== null && relaunching.has(activeTerminalId),
  });
  const serverClosedNotice =
    activeServerClosed === null ? null : serverClosedBarText(activeAgentInfo?.label ?? null);
  const blockedReason =
    serverClosedNotice ??
    toolCallNotice ??
    pendingApprovalNotice(activeCapabilities, conversation.waitingFor, activeTerminal?.alive ?? false);
  // La app ve el estado de esta pestana, no solo de su CLI (R27-1).
  const statusKnown = !blindToApprovals(activeCapabilities, activeActivity);

  /*
    Continuar la conversacion de la pestana activa con otra CLI (hito 29). Con
    una sola CLI instalada la lista es vacia y el medidor queda como siempre.
  */
  const activeContinueTargets = useMemo(
    () => continueTargets(agents, activeAgent),
    [agents, activeAgent],
  );
  const activeDiscovering =
    activeTerminal !== null && discoveringSession(activeAgent, activeTerminal.sessionId, activeCapabilities);

  /*
    El aviso de una pestana que continua otra conversacion: que CLI, cuantos
    turnos, que se pierde. Debajo, si se esta mandando sola o por que quedo en el
    cuadro. "Mandando" dura hasta que aparece el primer mensaje en el hilo, que es
    la confirmacion de que llego.
  */
  const activeHandoff = activeTerminalId === null ? null : (handoffs.get(activeTerminalId) ?? null);
  const handoffNotice =
    activeHandoff === null
      ? null
      : {
          text: handoffNoticeText(
            sessionAgentLabel(activeHandoff.sourceAgent, agents),
            activeHandoff.includedTurns,
            activeHandoff.totalTurns,
            activeHandoff.totalTurnsIsMinimum,
          ),
          status:
            activeHandoff.prefillReason !== null
              ? handoffPrefillText(activeHandoff.prefillReason)
              : activeHandoff.delivery === 'sending' && conversation.events.length === 0
                ? HANDOFF_SENDING_TEXT
                : null,
        };

  const togglePanel = useCallback(() => {
    setPanelVisible((current) => {
      const next = !current;
      writeStored(PANEL_VISIBLE_KEY, String(next));
      return next;
    });
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarVisible((current) => {
      const next = !current;
      writeStored(SIDEBAR_VISIBLE_KEY, String(next));
      return next;
    });
  }, []);

  /**
   * Muestra u oculta la consola.
   *
   * Ocultarla **no** mata el proceso: un comando corriendo no se pierde por
   * apretar el interruptor de mas. Cerrarla de verdad es la × de su cabecera, y
   * lo dice el titulo del boton.
   */
  const toggleConsole = useCallback(() => {
    setConsoleVisible((current) => {
      const next = !current;
      writeStored(CONSOLE_VISIBLE_KEY, String(next));
      return next;
    });
  }, []);

  const changePanelTab = useCallback((tab: PanelTab) => {
    setPanelTab(tab);
    writeStored(PANEL_TAB_KEY, tab);
  }, []);

  /**
   * Ensancha la columna derecha, dejandole a la conversacion un ancho minimo.
   *
   * No es un lujo: la interfaz de la CLI dibuja diffs y tablas, y hay momentos
   * —revisar un cambio grande, leer un arbol— en los que el ancho de lectura lo
   * necesita ella y no el chat. Es un interruptor y no un arrastre porque
   * ir y volver tiene que costar un clic.
   */
  const toggleExpanded = useCallback(() => {
    setPanelExpanded((current) => {
      const next = !current;
      writeStored(PANEL_EXPANDED_KEY, String(next));
      return next;
    });
  }, []);

  /**
   * "Volver aqui": manda `Esc Esc` a la pty.
   *
   * Eso abre el menu de rewind de la CLI, que ademas revierte los archivos. No
   * se reimplementa nada: el panel solo da el punto de referencia visual.
   */
  const rewind = useCallback(() => {
    if (activeTerminalId === null) return;
    connection.send({ type: 'input', terminalId: activeTerminalId, data: '\x1b\x1b' });
  }, [connection, activeTerminalId]);

  /**
   * Escribe texto en la terminal **sin enviarlo**.
   *
   * Lo usa "Insertar como @ruta". Mandarlo con Enter seria decidir por el
   * usuario que quiere pedir sobre ese archivo.
   */
  const insertIntoTerminal = useCallback(
    (text: string) => {
      if (activeTerminalId === null) return;
      connection.send({ type: 'input', terminalId: activeTerminalId, data: `${text} ` });
    },
    [connection, activeTerminalId],
  );

  /**
   * Manda un comando de barra a la CLI.
   *
   * Va por el mismo camino que un mensaje del cuadro de escritura, porque para
   * la CLI **es** un mensaje: uno que empieza con `/`. Lo que cambia es donde
   * se ve — en la pestana CLI y no en el hilo de la conversacion, que es
   * justamente lo que se buscaba al separarlas.
   */
  const sendCommand = useCallback(
    (command: string) => {
      if (activeTerminalId === null) return;
      connection.send({
        type: 'agent.submit',
        terminalId: activeTerminalId,
        text: command,
        images: [],
      });
    },
    [connection, activeTerminalId],
  );

  const revealPath = useCallback(
    (path: string) => {
      if (activeTerminalId === null) return;
      connection.send({ type: 'files.reveal', terminalId: activeTerminalId, path });
    },
    [connection, activeTerminalId],
  );

  /*
    Apertura automatica de la consola.

    Mostrar el panel y despues tener que apretar "abrir" seria un clic de mas
    para lo unico que puede querer alguien que abre una consola. El `Set` de
    pedidos evita el bucle: si la apertura falla —no hay consola en el sistema,
    el directorio ya no existe— no se reintenta hasta que el usuario vuelva a
    prender el interruptor.
  */
  const requestedShells = useRef(new Set<string>());

  useEffect(() => {
    if (!consoleVisible) {
      requestedShells.current.clear();
      return;
    }
    if (activeTerminal === null) return;
    const { cwd } = activeTerminal;
    if (shells.some((shell) => shell.cwd === cwd)) {
      requestedShells.current.delete(cwd);
      return;
    }
    if (requestedShells.current.has(cwd)) return;
    requestedShells.current.add(cwd);
    openShell(cwd);
  }, [consoleVisible, activeTerminal, shells, openShell]);

  /**
   * Cierra una consola: termina su proceso.
   *
   * No esconde el panel ni abre otra. Con varias abiertas, cerrar una es una
   * operacion sobre esa y nada mas; el panel se pliega con su propio boton, que
   * no mata nada. Se saca del registro de pedidos para que la apertura
   * automatica pueda volver a actuar si esta era la ultima.
   */
  const closeShell = useCallback(
    (terminalId: TerminalId) => {
      const shell = consoleShells.find((entry) => entry.terminalId === terminalId);
      if (shell !== undefined) requestedShells.current.delete(shell.cwd);
      closeTerminal(terminalId);
    },
    [consoleShells, closeTerminal],
  );

  /*
    La consola que acaba de nacer pasa a ser la que se mira.

    No se puede hacer en `openConsoleHere`: el servidor asigna el id y la
    respuesta no viene casada con el pedido —una consola no es la pestaña
    activa, asi que no lleva `requestId`—. Se detecta la aparicion, que ademas
    cubre la apertura automatica: la primera consola de un directorio queda
    activa sola.
  */
  const knownShells = useRef(new Set<TerminalId>());

  useEffect(() => {
    const fresh = consoleShells.filter((shell) => !knownShells.current.has(shell.terminalId));
    for (const shell of consoleShells) knownShells.current.add(shell.terminalId);
    const last = fresh[fresh.length - 1];
    if (last !== undefined) setActiveShellId(last.terminalId);
  }, [consoleShells]);

  /** Abre una consola mas en el directorio de la pestana activa. */
  const openConsoleHere = useCallback(() => {
    if (activeTerminal === null) return;
    requestedShells.current.add(activeTerminal.cwd);
    openShell(activeTerminal.cwd);
  }, [activeTerminal, openShell]);

  // ---- divisores arrastrables ----
  //
  // Los tres hacen lo mismo y solo cambia de donde sale el numero; eso vive en
  // `useDragSize`. El del panel apaga ademas el modo expandido al tomarlo: si
  // no, se arrastraria un ancho que el expandido ignora y el divisor pareceria
  // roto.

  const panelDivider = useDragSize({
    min: PANEL_MIN_WIDTH,
    max: PANEL_MAX_WIDTH,
    value: panelWidth,
    measure: useCallback((event) => window.innerWidth - event.clientX, []),
    onChange: setPanelWidth,
    onCommit: useCallback((value: number) => writeStored(PANEL_WIDTH_KEY, String(value)), []),
    onStart: useCallback(() => {
      setPanelExpanded(false);
      writeStored(PANEL_EXPANDED_KEY, 'false');
    }, []),
  });

  // La barra de proyectos mide desde el borde izquierdo de la ventana, que es
  // donde empieza: `app-body` no tiene nada a su izquierda.
  const sidebarDivider = useDragSize({
    min: SIDEBAR_MIN_WIDTH,
    max: SIDEBAR_MAX_WIDTH,
    value: sidebarWidth,
    measure: useCallback((event) => event.clientX, []),
    onChange: setSidebarWidth,
    onCommit: useCallback((value: number) => writeStored(SIDEBAR_WIDTH_KEY, String(value)), []),
  });

  const consoleDivider = useDragSize({
    min: CONSOLE_MIN_HEIGHT,
    max: CONSOLE_MAX_HEIGHT,
    value: consoleHeight,
    measure: useCallback((event) => window.innerHeight - event.clientY, []),
    onChange: setConsoleHeight,
    onCommit: useCallback((value: number) => writeStored(CONSOLE_HEIGHT_KEY, String(value)), []),
  });

  const dismissMarkerNotice = useCallback(() => {
    setMarkerNoticeVisible(false);
    writeStored(MARKER_NOTICE_KEY, 'true');
  }, []);

  const cycleTab = useCallback(
    (offset: number) => {
      if (terminals.length === 0) return;
      const currentIndex = terminals.findIndex((t) => t.terminalId === activeTerminalId);
      const nextIndex = (currentIndex + offset + terminals.length) % terminals.length;
      const next = terminals[nextIndex];
      if (next !== undefined) setActiveTerminal(next.terminalId);
    },
    [terminals, activeTerminalId, setActiveTerminal],
  );

  /*
    La pestana anterior, para volver de un salto.

    Es **en la que se estaba trabajando**, no la mas reciente en el tiempo: es
    lo que hace que apretar el atajo dos veces vuelva a donde uno estaba.
  */
  const previousTerminalId = useRef<TerminalId | null>(null);
  const lastActiveId = useRef<TerminalId | null>(null);
  useEffect(() => {
    if (activeTerminalId === lastActiveId.current) return;
    previousTerminalId.current = lastActiveId.current;
    lastActiveId.current = activeTerminalId;
  }, [activeTerminalId]);

  const goToPreviousTab = useCallback(() => {
    const target = previousTerminalId.current;
    if (target === null || target === activeTerminalId) return;
    // Puede haberse cerrado mientras tanto.
    if (!terminals.some((terminal) => terminal.terminalId === target)) return;
    setActiveTerminal(target);
  }, [activeTerminalId, terminals, setActiveTerminal]);

  /**
   * Atajos propios.
   *
   * El brief pedia Ctrl+T, Ctrl+W y Ctrl+Tab. **No se pueden usar en un
   * navegador**: Chrome se los queda para sus propias pestanas y el evento ni
   * llega a la pagina. Se reemplazan por la familia Alt, que si llega.
   *
   * Se capturan exactamente estas combinaciones y ninguna mas. Todo lo demas
   * —Alt+V incluido, que es el pegado de imagenes de la CLI— pasa intacto.
   *
   * **Aca NO va Alt+<numero>.** Estuvo, y era un error: en Windows, Alt con los
   * digitos del teclado numerico es como se escriben los caracteres que no
   * estan en el teclado (Alt+164 = ñ, Alt+0225 = á). Capturarlo —con su
   * preventDefault— le rompe la escritura en espanol a cualquiera que use un
   * teclado en ingles. Para cambiar de pestana quedan Alt+← y Alt+→, que no le
   * quitan nada a nadie.
   */
  /**
   * `Shift+Tab`: volver a la pestana anterior — **solo fuera de la terminal**.
   *
   * Es la unica combinacion que la app captura de forma condicional, y no es un
   * capricho. `Shift+Tab` es lo que cicla el modo de permiso de la CLI (§5.4.2)
   * y lo que manda el combo de modo contando pulsaciones: robarsela siempre
   * romperia las dos cosas. Con el foco dentro de la terminal pasa intacta;
   * escribiendo en el cuadro de conversacion, cambia de pestana.
   *
   * La frontera es la misma que ya existe para el cuadro de escritura (§5.0.1):
   * quien quiere teclear en la CLI hace clic en ella.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab' || !event.shiftKey) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      // xterm monta su textarea de captura dentro de `.xterm`. Vale para la
      // pestana del agente y para las consolas del pie: las dos son terminales.
      const focused = document.activeElement;
      if (focused instanceof Element && focused.closest('.xterm') !== null) return;

      event.preventDefault();
      event.stopPropagation();
      goToPreviousTab();
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [goToPreviousTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;

      const key = event.key.toLowerCase();

      if (key === 't') {
        // Bloqueado igual que el `+`: con una pestana en camino en esa
        // carpeta, el atajo repetido abriria una segunda sin querer.
        if (cliAvailable && defaultCwd.length > 0 && !newTabBlocked) {
          event.preventDefault();
          event.stopPropagation();
          openTerminal({ cwd: activeTerminal?.cwd ?? defaultCwd });
        }
        return;
      }

      if (key === 'w') {
        if (activeTerminalId !== null) {
          event.preventDefault();
          event.stopPropagation();
          closeTerminal(activeTerminalId);
        }
        return;
      }

      if (key === 'p') {
        event.preventDefault();
        event.stopPropagation();
        togglePanel();
        return;
      }

      if (key === 'arrowright' || key === 'pagedown') {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(1);
        return;
      }

      if (key === 'arrowleft' || key === 'pageup') {
        event.preventDefault();
        event.stopPropagation();
        cycleTab(-1);
      }
    };

    // En captura, para llegar antes que xterm.
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [
    activeTerminal,
    activeTerminalId,
    cliAvailable,
    closeTerminal,
    cycleTab,
    defaultCwd,
    newTabBlocked,
    openTerminal,
    togglePanel,
  ]);

  const panelTitle =
    activeTerminal === null
      ? 'Panel'
      : activeTerminal.label.length > 0
        ? activeTerminal.label
        : (activeTerminal.cwd.split(/[\\/]/).filter((part) => part.length > 0).pop() ??
          activeTerminal.cwd);

  return (
    <div className="app">
      <header className="app-header">
        <span className="app-name">Agent Workbench</span>
        <span className={`status status-${status}`}>{STATUS_LABEL[status]}</span>
        {activeTerminal !== null && (
          <span className="meta" title={activeTerminal.cwd}>
            {activeTerminal.cwd}
          </span>
        )}
        <span className="header-spacer" />
        {cliVersion !== null && <span className="meta meta-dim">CLI {cliVersion}</span>}
        <button
          className="icon-button"
          onClick={theme.cycle}
          title={`${THEME_LABEL[theme.preference]} — clic para cambiar`}
        >
          {THEME_ICON[theme.preference]}
        </button>
        <button
          className={`icon-button${sound.enabled ? '' : ' icon-button-muted'}`}
          onClick={sound.toggle}
          title={soundButtonTitle(sound.enabled)}
          aria-pressed={sound.enabled}
        >
          ♪
        </button>
        <button
          className="icon-button"
          onClick={() => setShortcutsVisible(true)}
          title="Ver los atajos de teclado"
        >
          ?
        </button>
        {/*
          Sin los interruptores de "Proyectos", "Panel" y "Consola".

          Los tres estaban aca arriba y los tres hacian lo mismo que ahora hace
          el borde de lo que esconden: una pestañita en el sitio donde el panel
          acaba de desaparecer. Un interruptor a dos metros del hueco obliga a
          buscar arriba lo que uno esta mirando abajo, y encima el estado
          "encendido" del boton repetia una informacion que la pantalla ya da —
          si el panel esta, se ve.
        */}
      </header>

      {!cliAvailable && cliMissingMessage !== null && (
        // Respeta los saltos de linea: sin ninguna CLI, el texto de la primera
        // va arriba y las demas en una linea aparte.
        <div className="banner banner-error banner-lines">{cliMissingMessage}</div>
      )}

      {/*
        Se quito una variable del entorno de la CLI: eso se avisa, no se hace
        callado. Es descartable porque en uso normal ni aparece.
      */}
      {environmentNotice === 'child-session-marker' && markerNoticeVisible && (
        <div className="banner banner-notice">
          <span>
            Este servidor se lanzo desde dentro de una sesion de la CLI. Se quito la variable{' '}
            <code>CLAUDE_CODE_CHILD_SESSION</code> del entorno de las pestanas, que apaga el
            guardado del historial; sin eso no habria conversacion ni medidor. El resto del
            entorno va intacto.
          </span>
          <button className="banner-close" onClick={dismissMarkerNotice} title="Entendido">
            ×
          </button>
        </div>
      )}

      {error !== null && (
        <div className="banner banner-error">
          <span>{error.message}</span>
          <button className="banner-close" onClick={dismissError} title="Cerrar">
            ×
          </button>
        </div>
      )}

      {/*
        Un pedido de la copia propia que fallo con el dialogo cerrado: abrir una
        fila "copia" o exportar un proyecto, que se piden desde la barra. Con el
        dialogo abierto lo dice el dialogo, y no los dos.
      */}
      {vault.problem !== null && !vaultDialogVisible && (
        <div className="banner banner-error">
          <span>{vault.problem}</span>
          <button className="banner-close" onClick={vault.dismissProblem} title="Cerrar">
            ×
          </button>
        </div>
      )}

      <div className="app-body">
        {/*
          Escondida la barra, queda su pestañita.

          A diferencia de las otras dos, esta se dibuja **siempre** que la barra
          este oculta, aunque no haya ninguna pestaña abierta: es el unico
          camino para abrir un proyecto, y sin ella una ventana recien abierta
          con la barra escondida no tendria como empezar.
        */}
        {!sidebarVisible && (
          <button
            className="panel-peek panel-peek-left"
            onClick={toggleSidebar}
            title="Mostrar la lista de proyectos"
          >
            <span className="panel-peek-arrow">›</span>
            <span className="panel-peek-label">Proyectos</span>
          </button>
        )}

        {sidebarVisible && (
          <Sidebar
            projects={projects}
            indexStatus={indexStatus}
            disabled={!cliAvailable}
            onOpenProject={(cwd, agent) =>
              openTerminal({ cwd, ...(agent !== undefined ? { agent } : {}) })
            }
            agents={agents}
            offerAgentChoice={offerAgentChoice}
            agentForProject={(project) =>
              projectAgent(terminals, project, platform, agents, defaultAgent)
            }
            onOpenSession={(cwd, session) =>
              openTerminal({
                cwd,
                resumeSessionId: session.sessionId,
                // La CLI de la sesion, no la de la ultima pestana del proyecto:
                // reanudar un id con otra CLI no encontraria nada.
                agent: session.agent,
                label: session.title,
              })
            }
            canResume={(agent) => sessionResumable(agents, agent)}
            platform={platform}
            onRefresh={refreshIndex}
            openSessionIds={openSessionIds}
            openBlocked={(cwd) => openBlockedFor(pendingOpens, cwd, platform)}
            onArchive={archiveSessions}
            onHide={toggleSidebar}
            width={sidebarWidth}
            notes={notes}
            onNewProject={() => setPickerFor('project')}
            /*
              Mandar una nota abre una conversacion **nueva** en el proyecto que
              se esta mirando, y le pasa la nota entera. El id de la pestana lo
              asigna el servidor, asi que el envio espera al `terminal.opened`
              en vez de adivinarlo.

              Con la CLI de la pestana activa, dicha explicitamente, y solo si
              esa CLI avisa cuando esta lista: el servidor espera esa senal
              antes de pegar, y sin ella rechaza la nota con la pestana nueva
              ya abierta y sin que nadie la haya pedido.
            */
            onSendNote={
              activeTerminal === null || !activeControls.noteSendable
                ? null
                : (noteId) => {
                    const cwd = activeTerminal.cwd;
                    openTerminal({
                      cwd,
                      ...(activeTerminal.agent !== null ? { agent: activeTerminal.agent } : {}),
                      onOpened: (terminal) =>
                        connection.send({
                          type: 'notes.send',
                          noteId,
                          terminalId: terminal.terminalId,
                        }),
                    });
                  }
            }
            sendNoteCwd={activeTerminal?.cwd ?? null}
            vault={vault.status}
            onOpenVault={() => setVaultDialogVisible(true)}
            onOpenVaultSession={(session) => vault.openSession(session.agent, session.sessionId)}
            onExportProject={vault.exportProject}
            exporting={vault.exporting}
            lastExported={vault.lastExported}
            onContinueSession={(session, target) =>
              continueSession({ agent: session.agent, sessionId: session.sessionId }, target)
            }
            globalSearch={
              globalSearchShown ? { ...globalSearch, vaultEnabled: vault.status?.enabled === true } : null
            }
            onOpenSearchHit={openSearchHit}
          />
        )}

        {sidebarVisible && (
          <div className="divider" {...sidebarDivider} title="Arrastrar para cambiar el ancho" />
        )}

        <main
          className={`workspace${panelExpanded && rightColumnOpen ? ' workspace-narrow' : ''}`}
        >
          <TabBar
            terminals={terminals}
            activeTerminalId={activeTerminalId}
            activity={activity}
            canOpen={cliAvailable && defaultCwd.length > 0}
            onSelect={setActiveTerminal}
            onClose={closeTerminal}
            onRename={renameTerminal}
            onReorder={reorderTabs}
            onNew={(agent) =>
              openTerminal({ cwd: newTabCwd, ...(agent !== undefined ? { agent } : {}) })
            }
            agents={agents}
            offerAgentChoice={offerAgentChoice}
            newTabAgent={newTabAgent}
            pendingOpens={pendingOpens}
            platform={platform}
            newTabBlockedTitle={newTabBlockedTitle}
          />

          <div className="chat-stack">
            {terminals.length === 0 ? (
              <div className="empty-state">
                <p>No hay pestanas abiertas.</p>
                <p className="empty-hint">
                  Elegi un proyecto de la izquierda, o abri una sesion del historial para
                  retomarla.
                </p>
                {cliAvailable && defaultCwd.length > 0 && (
                  <button
                    className="primary-button"
                    onClick={() => openTerminal({ cwd: defaultCwd })}
                    disabled={newTabBlocked}
                    title={newTabBlockedTitle ?? undefined}
                  >
                    {newTabBlocked ? 'Abriendo…' : `Nueva sesion en ${defaultCwd}`}
                  </button>
                )}
              </div>
            ) : (
              <ConversationView
                view={conversation}
                onRewind={activeControls.rewind ? rewind : undefined}
                questionsAnswerable={activeControls.questionsAnswerable}
                contextWindowSource={activeControls.contextWindowSource}
                instructionsFile={instructionsFileFor(activeAgent)}
                onGoToCli={() => {
                  // Escondida, la solapa no alcanza: hay que traer la columna.
                  if (!panelOpen) togglePanel();
                  changePanelTab('cli');
                }}
                /*
                  Una pestana restaurada llega **dormida**: la conversacion se
                  lee entera y no hay ningun proceso detras. El boton de abrir
                  la CLI vive al pie del hilo, que es donde uno se da cuenta de
                  que no puede escribir.
                */
                cliPresence={
                  activeTerminal === null || activeTerminal.alive
                    ? 'live'
                    : activeTerminal.sleeping
                      ? 'sleeping'
                      : 'exited'
                }
                exitCode={activeTerminal?.exitCode ?? null}
                waking={activeTerminalId !== null && waking.has(activeTerminalId)}
                onWakeCli={() => {
                  if (activeTerminalId !== null) wakeTerminal(activeTerminalId);
                }}
                discovering={activeDiscovering}
                continueTargets={activeContinueTargets}
                continueBlockedReason={continueBlockedReason(
                  activeTerminal?.sessionId ?? '',
                  activeDiscovering,
                  conversation.events.length > 0,
                )}
                onContinue={
                  activeTerminal === null || activeAgent === null
                    ? undefined
                    : (target) => continueSession({ agent: activeAgent, sessionId: activeTerminal.sessionId }, target)
                }
                searchRequest={threadSearch}
                onSearchRequestApplied={threadSearchApplied}
                toolCallNotice={toolCallNotice}
                serverClosed={
                  activeServerClosed === null || serverClosedNotice === null
                    ? null
                    : { state: activeServerClosed, text: serverClosedNotice }
                }
                statusLineState={activeStatusLine?.state ?? null}
                onConfigureStatusLine={
                  activeStatusLine === null ? undefined : () => setStatusLineDialogVisible(true)
                }
              />
            )}
          </div>

          {activeTerminal !== null && (
            <Composer
              connection={connection}
              terminalId={activeTerminalId}
              alive={activeTerminal.alive}
              sleeping={activeTerminal.sleeping}
              imagesAllowed={activeControls.imagesAllowed}
              blockedReason={blockedReason}
              prefills={prefills}
              onPrefillApplied={prefillApplied}
              notice={handoffNotice}
              onDismissNotice={activeTerminalId === null ? undefined : () => dismissHandoff(activeTerminalId)}
              /* El aviso de una continuacion dura hasta el primer envio de esa pestana. */
              onSubmitted={dismissHandoff}
              leading={
                activeControls.modeCycle === null ? undefined : (
                  <ModeControl
                    mode={conversation.permissionMode}
                    cycle={activeControls.modeCycle}
                    disabled={!activeTerminal.alive}
                    waitingFor={conversation.waitingFor}
                    statusKnown={statusKnown}
                    onChange={conversation.setPermissionMode}
                  />
                )
              }
              controls={
                activeControls.models === null && activeControls.efforts === null ? undefined : (
                  <AgentControls
                    models={activeControls.models}
                    efforts={activeControls.efforts}
                    model={currentModel}
                    effort={currentEffort}
                    modelProvisional={modelProvisional}
                    effortProvisional={effortProvisional}
                    choiceNote={modelChoiceNote(activeAgent)}
                    disabled={!activeTerminal.alive}
                    onCommand={sendCommand}
                  />
                )
              }
            />
          )}
        </main>

        {/*
          La columna derecha se monta siempre que haya una pestana, aunque este
          escondida, y se colapsa con CSS.

          El motivo es la terminal, que vive adentro: desmontarla soltaria el
          enganche y la repintaria entera con el replay cada vez que alguien
          aprieta Alt+P. Colapsada mide 0 px, y de eso se ocupa `TerminalView`,
          que con el contenedor sin caja no mide ni le avisa nada al pty.
        */}
        {activeTerminal !== null && (
          <>
            {/*
              Escondida la columna, queda una pestanita en el borde para
              devolverla.

              El interruptor de la cabecera ya existia y hacia lo mismo, pero
              esta a dos metros de donde acaba de desaparecer el panel: quien
              lo esconde sin querer con `Alt+P` lo busca donde estaba, no
              arriba. Es un boton y no una zona sensible al mouse porque una
              columna que reaparece sola al pasar por el borde es peor que una
              que no reaparece.
            */}
            {!rightColumnOpen && (
              <button
                className="panel-peek"
                onClick={togglePanel}
                title="Mostrar el panel derecho (Alt+P)"
              >
                <span className="panel-peek-arrow">‹</span>
                <span className="panel-peek-label">Panel</span>
              </button>
            )}

            {rightColumnOpen && (
              <div
                className="divider"
                {...panelDivider}
                title="Arrastrar para cambiar el ancho"
              />
            )}
            <div
              className={`panel-slot${rightColumnOpen ? '' : ' panel-slot-collapsed'}${
                rightColumnOpen && panelExpanded ? ' panel-slot-expanded' : ''
              }`}
              style={rightColumnOpen && !panelExpanded ? { width: `${panelWidth}px` } : undefined}
            >
              <SidePanel
                tab={shownPanelTab}
                plansAvailable={activeControls.plansAvailable}
                hidden={!panelVisible}
                onTabChange={changePanelTab}
                title={panelTitle}
                cwd={activeTerminal.cwd}
                platform={platform}
                cli={
                  <div className="terminal-stack">
                    {terminals.map((terminal) => (
                      <TerminalView
                        key={terminal.terminalId}
                        terminalId={terminal.terminalId}
                        connection={connection}
                        active={terminal.terminalId === activeTerminalId}
                        theme={theme.resolved}
                        /*
                          La terminal no se lleva el foco sola.

                          Lo hacia al activarse una pestana, desde un
                          `setTimeout(0)` que corre **despues** del foco que pide
                          el cuadro de escritura: ganaba siempre la terminal. El
                          resultado era que abrir una pestana y empezar a
                          escribir mandaba el texto a la CLI —interpretado como
                          teclas, no como mensaje— en vez de al cuadro.

                          Desde el hito 7 el centro es la conversacion y el foco
                          arranca en el cuadro (CLAUDE.md 7). Quien quiera
                          teclear en la CLI hace clic en ella, que es lo que uno
                          hace con una terminal.
                        */
                        autoFocus={false}
                      />
                    ))}
                  </div>
                }
                cliUnseen={cliUnseen}
                expanded={panelExpanded}
                onToggleExpanded={toggleExpanded}
                git={git}
                files={files}
                plans={plans}
                memory={memory}
                onInsert={activeControls.fileMentions ? insertIntoTerminal : undefined}
                onReveal={revealPath}
                onHide={togglePanel}
              />

              {consoleVisible ? (
                <>
                  {/*
                    El divisor solo tiene sentido si hay dos cosas que repartir.
                    Con el panel escondido la consola se lleva la columna entera.
                  */}
                  {panelVisible && (
                    <div
                      className="hdivider"
                      {...consoleDivider}
                      title="Arrastrar para cambiar el alto de la consola"
                    />
                  )}
                  <div
                    className="console-slot"
                    style={panelVisible ? { height: `${consoleHeight}px` } : { flex: '1 1 auto' }}
                  >
                    <ConsolePane
                      connection={connection}
                      shells={consoleShells}
                      activeShellId={activeShell?.terminalId ?? null}
                      cwd={activeTerminal.cwd}
                      shellName={shellName}
                      theme={theme.resolved}
                      onSelect={setActiveShellId}
                      onOpen={openConsoleHere}
                      onCloseShell={closeShell}
                      onCollapse={toggleConsole}
                    />
                  </div>
                </>
              ) : (
                /*
                  Plegada, la consola deja su barra al pie de la columna.

                  Es la misma idea que las notas de la barra lateral: una
                  seccion que vive donde se la usa y se despliega de un clic, en
                  vez de un interruptor lejos. Y como esta dentro de la columna
                  derecha, con el panel escondido no estorba: ahi lo que se ve
                  es la pestañita vertical, y esta vuelve con ella.
                */
                <button
                  className="strip-collapsed"
                  onClick={toggleConsole}
                  title={`Abrir ${shellName ?? 'una consola'} en ${activeTerminal.cwd}`}
                >
                  <span className="strip-collapsed-arrow">▸</span>
                  <span>{shellName ?? 'Consola'}</span>
                  {consoleShells.length > 0 && (
                    <span className="strip-collapsed-count">{consoleShells.length}</span>
                  )}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/*
        Se dibuja con la status line de la pestana activa, la de ahora: al
        pegar el fragmento y comprobar, el estado de arriba cambia en el sitio.
        Si la pestana activa pasa a ser de una CLI sin status line, se cierra.
      */}
      {statusLineDialogVisible && activeStatusLine !== null && activeAgentInfo !== null && (
        <StatusLineDialog
          info={activeStatusLine}
          agentLabel={activeAgentInfo.label}
          onRefresh={refreshAgents}
          onClose={() => setStatusLineDialogVisible(false)}
        />
      )}

      {shortcutsVisible && (
        <ShortcutsDialog
          agent={shortcutsAgent(activeAgent, agents, defaultAgent)}
          onClose={() => setShortcutsVisible(false)}
        />
      )}

      {/*
        Proyecto nuevo. Abre una pestana en la carpeta elegida y se cierra: a
        partir de ahi el proyecto aparece solo en la barra, como cualquier otro.
      */}
      {pickerFor === 'project' && (
        <FolderPicker
          connection={connection}
          title="Proyecto nuevo"
          confirmLabel="Abrir aca"
          confirmTitle={(path) => `Abrir una pestana del agente en ${path}`}
          onChoose={(_pickerId, cwd) => {
            setPickerFor(null);
            openTerminal({ cwd });
          }}
          onClose={() => setPickerFor(null)}
        />
      )}

      {/*
        La copia propia (hito 28). El selector se abre encima del dialogo, que
        sigue montado debajo: al elegir, el dialogo muestra la mudanza y dice
        donde quedo la carpeta vieja.
      */}
      {vaultDialogVisible && (
        <VaultDialog
          status={vault.status}
          agents={agents}
          indexReady={indexStatus.state === 'ready'}
          problem={vault.problem}
          covered={pickerFor === 'vault'}
          onMeasure={vault.measure}
          onSetEnabled={vault.setEnabled}
          onChangeDir={() => setPickerFor('vault')}
          onReveal={vault.reveal}
          onDismissProblem={vault.dismissProblem}
          onClose={() => setVaultDialogVisible(false)}
        />
      )}

      {pickerFor === 'vault' && (
        <FolderPicker
          connection={connection}
          title="Carpeta de la copia propia"
          confirmLabel="Usar esta carpeta"
          confirmTitle={(path) =>
            `Mudar la copia propia a ${path}. La carpeta de ahora queda intacta`
          }
          onChoose={(pickerId) => {
            // Antes de cerrar: el servidor lee la carpeta de este selector, que
            // se cierra al desmontarse.
            vault.chooseDir(pickerId);
            setPickerFor(null);
          }}
          onClose={() => setPickerFor(null)}
        />
      )}
    </div>
  );
}
