/**
 * Barra lateral: proyectos e historial de sesiones.
 *
 * Los proyectos cuyo `cwd` ya no existe en disco se muestran marcados, no
 * escondidos: que la carpeta se haya movido no borra la conversacion.
 *
 * **Archivar es esconder, nunca borrar.** Un proyecto donde se trabaja se
 * llena de sesiones de prueba y el historial deja de servir para encontrar
 * nada; lo que estorba es el ruido en esta lista, no los bytes en disco. El
 * `.jsonl` es de la CLI —es lo que usa `--resume`— y de `~/.claude/` solo
 * leemos (CLAUDE.md 2.1), asi que lo unico que se guarda es una lista de ids
 * en nuestro propio directorio de configuracion. Todo se puede restaurar.
 *
 * Por eso tampoco hay un boton de borrar: un icono destructivo que aparece al
 * pasar el mouse esta justo donde el mouse pasa sin querer, y es el mismo
 * razonamiento por el que el panel de git es de solo lectura (CLAUDE.md 6.1).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import {
  resumeCwdFor,
  type AgentId,
  type AgentInfo,
  type GlobalSearchHit,
  type IndexStatus,
  type ProjectSummary,
  type SessionAgentId,
  type SessionSummary,
  type VaultStatus,
} from '@agent-workbench/shared';
import { AgentBadge } from './AgentBadge.js';
import { AgentSplitButton } from './AgentSplitButton.js';
import {
  continueTargets,
  resumableSession,
  sessionAgentLabel,
  sessionAgentView,
  openBlockedTitle,
  sessionTitleText,
} from './agent-ui.js';
import { ContinueButton } from './ContinueButton.js';
import {
  archiveCandidatesByAgent,
  projectArchivePlan,
  projectArchiveText,
  sessionsToArchiveBefore,
  startOfLocalDay,
  type ArchiveCandidates,
} from './archive-history.js';
import { formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import {
  globalSearchOffText,
  globalSearchTooShortText,
  searchModeConversationsText,
  searchModeConversationsTitle,
  searchModeTitlesText,
  globalSearchStatusText,
  globalSearchTooShort,
  groupSearchHits,
  groupThreadQuery,
  searchHitRoleText,
  sidebarFilterPlaceholder,
  snippetPieces,
  threadQueryFor,
  type SidebarSearchMode,
} from './global-search-ui.js';
import { projectColor } from './project-color.js';
import type { GlobalSearchApi } from './useGlobalSearch.js';
import type { VaultExported } from './useVault.js';
import {
  partialMarkText,
  partialMarkTitle,
  vaultMarkText,
  vaultMarkTitle,
  exportButtonTitle,
  sessionVaultView,
  vaultButtonTitle,
  vaultLineText,
  vaultName,
  type ExportButtonState,
} from './vault-ui.js';

/** Cuanto dura el tilde de "exportado". Como el de copiar una ruta. */
const EXPORTED_ACK_MS = 1_000;

interface SidebarProps {
  projects: ProjectSummary[];
  indexStatus: IndexStatus;
  disabled: boolean;
  /** Sesiones con una pestana abierta. No se archivan: ver `canArchive`. */
  openSessionIds: Set<string>;
  /**
   * Hito 31: las carpetas con una pestana pedida y todavia sin confirmar. Su
   * `+` queda apagado hasta que llegue, para que el segundo clic no abra una
   * segunda pestana.
   */
  openBlocked: (cwd: string) => boolean;
  /** Sin `agent` decide el servidor: con una sola CLI es lo de siempre. */
  onOpenProject: (cwd: string, agent?: AgentId) => void;
  /** Las CLIs anunciadas: el menu del `+` y las insignias de las filas. */
  agents: readonly AgentInfo[];
  /** Mas de una instalada: boton partido en cada proyecto e insignia en cada fila. */
  offerAgentChoice: boolean;
  /** Con que CLI abre el `+` de un proyecto (`projectAgent`). */
  agentForProject: (project: ProjectSummary) => AgentId | null;
  /**
   * Retoma una sesion del historial, con su CLI: la sesion sabe de cual es.
   *
   * Solo recibe filas nativas de una CLI con adaptador (`resumableSession`):
   * una importada o una que solo esta en la copia propia no se reanuda.
   */
  onOpenSession: (cwd: string, session: SessionSummary & { agent: AgentId }) => void;
  /**
   * true si la CLI de esa sesion esta instalada y sabe reanudar. Si no, la
   * fila se ve pero no se abre: reanudarla con otra CLI no encontraria nada.
   */
  canResume: (agent: AgentId) => boolean;
  /** `process.platform` del servidor: decide si las mayusculas de un `cwd` cuentan. */
  platform: string;
  onRefresh: () => void;
  /** Esconde o restaura. Un solo camino para las dos direcciones. */
  onArchive: (sessionIds: string[], archived: boolean) => void;
  /** Colapsa la barra entera. Se vuelve a abrir desde el encabezado. */
  onHide: () => void;
  /**
   * Ancho en pixeles, decidido por el arrastre del divisor.
   *
   * Va como estilo y no como clase porque es un continuo: el CSS define el
   * valor de arranque y este lo pisa en cuanto alguien toca el borde.
   */
  width: number;
  /** Abre el selector de carpetas para empezar un proyecto nuevo. */
  onNewProject: () => void;
  /**
   * La copia propia (hito 28). null hasta el primer `vault.status`. Apagada, lo
   * unico que se ve de ella es el boton de la cabecera (C9).
   */
  vault: VaultStatus | null;
  /** Abre el dialogo de la copia. */
  onOpenVault: () => void;
  /**
   * Abre una fila que solo esta en la copia, en Markdown. No depende de la CLI
   * ni de la carpeta: la sesion ya no es de la CLI, y la lee el servidor.
   */
  onOpenVaultSession: (session: SessionSummary) => void;
  /** Exporta a Markdown las sesiones de un proyecto, por su `key`. */
  onExportProject: (projectKey: string) => void;
  /** Proyectos cuya exportacion esta en viaje. */
  exporting: ReadonlySet<string>;
  /** La ultima exportacion que llego: el boton de ese proyecto acusa recibo. */
  lastExported: VaultExported | null;
  /**
   * Continua una sesion con otra CLI (hito 29). El `↪` de cada fila solo se
   * dibuja con algo que ofrecer (`continueTargets`).
   */
  onContinueSession: (session: SessionSummary, target: AgentId) => void;
  /**
   * El buscador global (hito 29), o null si no se ofrece
   * (`globalSearchVisible`): con null la barra es la de siempre, sin
   * conmutador. `vaultEnabled` es para decir que busca en una copia apagada.
   */
  globalSearch: (GlobalSearchApi & { vaultEnabled: boolean }) | null;
  /** Abre un acierto: su sesion, con el texto encontrado para el buscador del hilo. */
  onOpenSearchHit: (hit: GlobalSearchHit, threadQuery: string) => void;
}

/** El fragmento de un acierto con lo encontrado resaltado. */
function SearchSnippet({ hit }: { hit: GlobalSearchHit }): JSX.Element {
  const { before, match, after } = snippetPieces(hit);
  return (
    <>
      {before}
      <mark>{match}</mark>
      {after}
    </>
  );
}

/**
 * La confirmacion de "Archivar proyecto" (hito 31).
 *
 * En el sitio y no con `confirm()`, por lo mismo que el resto de la barra: un
 * dialogo modal bloquea la pagina entera. El numero sale de la misma funcion
 * que decide que se archiva, asi que lo que dice es exactamente lo que pasa.
 *
 * Con **nada** que archivar —todas sus conversaciones tienen pestana abierta—
 * no se ofrece el boton de confirmar: se explica por que y se deja cerrar.
 */
function ProjectArchiveConfirm({
  project,
  openSessionIds,
  onConfirm,
  onCancel,
}: {
  project: ProjectSummary;
  openSessionIds: ReadonlySet<string>;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const plan = projectArchivePlan(project, openSessionIds);
  return (
    <div className="project-archive-confirm" role="group">
      <span className="archive-history-text">{projectArchiveText(plan)}</span>
      {plan.sessionIds.length > 0 && (
        <button className="link-button" onClick={onConfirm}>
          {t('sidebar.action.archive')}
        </button>
      )}
      <button className="link-button" onClick={onCancel}>
        {plan.sessionIds.length > 0 ? t('common.cancel') : t('common.close')}
      </button>
    </div>
  );
}

/** Nombre corto para el encabezado del proyecto. */
function projectName(project: ProjectSummary): string {
  if (project.cwd.length === 0) return project.fallbackName;
  const parts = project.cwd.split(/[\\/]/).filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? project.cwd;
}

/**
 * La caja de archivo, dibujada a mano.
 *
 * SVG inline y no un paquete de iconos: una fuente de iconos entera son
 * cientos de KB para dos glifos, y traerla de un CDN seria una llamada de red
 * saliente, que esta app no hace (CLAUDE.md 2.4).
 *
 * `currentColor` es lo que hace que herede el color del boton en los dos temas
 * sin tener una variante por tema.
 */
function ArchiveIcon({ out }: { out: boolean }): JSX.Element {
  return (
    <svg
      className="archive-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="19" height="5" rx="1.2" />
      <path d="M4.5 8.5v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-10" />
      {/* Archivar: la ranura de la caja. Restaurar: algo que sale de ella. */}
      {out ? <path d="M12 18.5v-6M9.2 15.3 12 12.5l2.8 2.8" /> : <path d="M10 12.5h4" />}
    </svg>
  );
}

/**
 * La copia propia: dos hojas apiladas, la de atras corrida. Dibujada a mano por
 * lo mismo que la caja de archivo.
 */
function VaultIcon(): JSX.Element {
  return (
    <svg
      className="archive-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 6.5V4.5a1.5 1.5 0 0 1 1.5-1.5h9A1.5 1.5 0 0 1 20 4.5v11a1.5 1.5 0 0 1-1.5 1.5H17" />
      <rect x="4" y="7" width="12" height="14" rx="1.5" />
      <path d="M7.5 12h5M7.5 15.5h5" />
    </svg>
  );
}

/** Exportar a Markdown: una hoja con una flecha que baja; el tilde al acusar recibo. */
function ExportIcon({ done }: { done: boolean }): JSX.Element {
  return (
    <svg
      className="archive-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {done ? (
        <path d="M5 12.5l4.5 4.5L19 7.5" />
      ) : (
        <>
          <path d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5z" />
          <path d="M12 10.5v6.5M9.2 14.2 12 17l2.8-2.8" />
        </>
      )}
    </svg>
  );
}

interface ArchiveHistoryPanelProps {
  candidates: readonly ArchiveCandidates[];
  agents: readonly AgentInfo[];
  onArchiveAgent: (agent: SessionAgentId) => void;
  onClose: () => void;
  /** El boton que lo abre: un clic ahi es suyo, no un clic afuera. */
  anchorRef: RefObject<HTMLElement>;
}

/**
 * "Archivar historial": una fila por CLI con sesiones anteriores a hoy.
 *
 * En el sitio y no en un modal, y sin `confirm()` del navegador, por lo mismo
 * que las notas (CLAUDE.md 6.6): un dialogo que bloquea la pagina entera frena
 * tambien a la CLI que uno esta mirando. La confirmacion va en la misma fila y
 * dice cuantas y de que CLI, porque esto esconde de a cientos.
 */
function ArchiveHistoryPanel({
  candidates,
  agents,
  onArchiveAgent,
  onClose,
  anchorRef,
}: ArchiveHistoryPanelProps): JSX.Element {
  const [confirming, setConfirming] = useState<SessionAgentId | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /*
    Se cierra como los menus, con un clic afuera: si no, queda abierto
    mientras uno vuelve a trabajar.

    Y `Escape` es del panel solo con el foco adentro o en su boton. Con el
    foco en el cuadro de escritura esa tecla interrumpe a la CLI, y en una
    terminal tiene que llegar intacta a la pty (CLAUDE.md 5): quedarsela desde
    cualquier lado le robaba el primer Esc a quien queria cortar al agente.
  */
  useEffect(() => {
    const isOwn = (target: EventTarget | null): boolean =>
      target instanceof Node &&
      (panelRef.current?.contains(target) === true || anchorRef.current?.contains(target) === true);

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || !isOwn(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (!isOwn(event.target)) onClose();
    };

    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [anchorRef, onClose]);

  return (
    <div ref={panelRef} className="archive-history" role="region" aria-label={t('sidebar.history.region')}>
      <div className="archive-history-header">
        <span>{t('sidebar.history.heading')}</span>
        <button className="icon-button" onClick={onClose} title={t('common.closeEsc')}>
          ×
        </button>
      </div>

      {candidates.map(({ agent, count }) => {
        const label = sessionAgentLabel(agent, agents);

        if (confirming === agent) {
          return (
            <div key={agent} className="archive-history-row archive-history-confirm">
              <span className="archive-history-text">
                {t('sidebar.history.confirm', { count, label })}
              </span>
              <button className="link-button" onClick={() => onArchiveAgent(agent)}>
                {t('sidebar.action.archive')}
              </button>
              <button className="link-button" onClick={() => setConfirming(null)}>
                {t('common.cancel')}
              </button>
            </div>
          );
        }

        return (
          <div key={agent} className="archive-history-row">
            <span className="archive-history-text">
              <span className="archive-history-agent">{label}</span>
              <span className="archive-history-count">{t('sidebar.history.count', { count })}</span>
            </span>
            <button className="link-button" onClick={() => setConfirming(agent)}>
              {t('sidebar.action.archive')}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function Sidebar({
  projects,
  indexStatus,
  disabled,
  openSessionIds,
  openBlocked,
  onOpenProject,
  agents,
  offerAgentChoice,
  agentForProject,
  onOpenSession,
  canResume,
  platform,
  onRefresh,
  onArchive,
  onHide,
  width,
  onNewProject,
  vault,
  onOpenVault,
  onOpenVaultSession,
  onExportProject,
  exporting,
  lastExported,
  onContinueSession,
  globalSearch,
  onOpenSearchHit,
}: SidebarProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /*
    El tilde de "exportado", un segundo, en el proyecto de la ultima
    exportacion que llego. Exportar no cambia nada en la barra —abre una
    carpeta en otra ventana—, y sin senal no se sabe si el clic hizo algo.
  */
  const [exportAckKey, setExportAckKey] = useState<string | null>(null);
  useEffect(() => {
    // Con lo que queda del segundo: la barra se desmonta al esconderla, y al
    // volver no tiene que acusar recibo de una exportacion de hace un rato.
    const left = lastExported === null ? 0 : lastExported.at + EXPORTED_ACK_MS - Date.now();
    if (lastExported === null || left <= 0) return;
    setExportAckKey(lastExported.projectKey);
    const timer = window.setTimeout(() => setExportAckKey(null), left);
    return () => window.clearTimeout(timer);
  }, [lastExported]);

  const exportState = (projectKey: string): ExportButtonState =>
    exporting.has(projectKey) ? 'exporting' : exportAckKey === projectKey ? 'done' : 'idle';

  const vaultLine = vaultLineText(vault);
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  /*
    Donde busca el cuadro de arriba (hito 29). Sin buscador global es siempre
    en titulos, que es el filtro de siempre: el conmutador no se dibuja.
  */
  const [searchModeChoice, setSearchModeChoice] = useState<SidebarSearchMode>('titles');
  const searchMode: SidebarSearchMode = globalSearch === null ? 'titles' : searchModeChoice;
  const [searchTooShort, setSearchTooShort] = useState(false);
  const showingSearch =
    globalSearch !== null &&
    searchMode === 'conversations' &&
    filter.trim().length > 0 &&
    (searchTooShort || globalSearch.submitted !== null);
  const searchResult = globalSearch?.result ?? null;
  const searchGroups = useMemo(
    () => (showingSearch && searchResult !== null ? groupSearchHits(searchResult.hits) : []),
    [showingSearch, searchResult],
  );

  const changeSearchMode = (next: SidebarSearchMode): void => {
    setSearchModeChoice(next);
    setSearchTooShort(false);
    globalSearch?.clear();
  };

  const submitGlobalSearch = (): void => {
    if (globalSearch === null) return;
    if (globalSearchTooShort(filter)) {
      setSearchTooShort(true);
      globalSearch.clear();
      return;
    }
    setSearchTooShort(false);
    globalSearch.search(filter.trim(), showArchived);
  };

  // "Ver archivadas" cambia donde se busca: lo encontrado se vuelve a pedir.
  const lastSearch = globalSearch?.submitted ?? null;
  const researchGlobal = globalSearch?.search;
  useEffect(() => {
    if (searchMode !== 'conversations' || lastSearch === null || researchGlobal === undefined) return;
    if (lastSearch.includeArchived !== showArchived) researchGlobal(lastSearch.query, showArchived);
  }, [searchMode, lastSearch, researchGlobal, showArchived]);

  const archivedCount = useMemo(
    () =>
      projects.reduce(
        (total, project) =>
          total + project.sessions.filter((session) => session.archived).length,
        0,
      ),
    [projects],
  );

  /*
    Las archivadas se sacan **antes** del filtro de texto, no despues.
    Al reves, escribir tres letras devolveria a la lista justo lo que se
    archivo, que es lo contrario de lo que se pidio.

    Y un proyecto sin nada visible desaparece: si no, quedan carpetas vacias
    ocupando lugar, que es el desorden que uno vino a resolver.
  */
  const visibleProjects = useMemo(() => {
    // Buscando en las conversaciones, el texto no filtra la lista: la reemplazan los aciertos.
    const needle = searchMode === 'titles' ? filter.trim().toLowerCase() : '';

    return projects
      .map((project) => {
        const sessions = showArchived
          ? project.sessions
          : project.sessions.filter((session) => !session.archived);
        if (sessions.length === 0) return null;
        if (needle.length === 0) return { ...project, sessions };

        const matchesProject =
          projectName(project).toLowerCase().includes(needle) ||
          project.cwd.toLowerCase().includes(needle);
        if (matchesProject) return { ...project, sessions };

        const found = sessions.filter((session) =>
          sessionTitleText(session.title, session.titleSource).toLowerCase().includes(needle),
        );
        return found.length > 0 ? { ...project, sessions: found } : null;
      })
      .filter((project): project is ProjectSummary => project !== null);
  }, [projects, filter, showArchived, searchMode]);
  const filtering = searchMode === 'titles' && filter.trim().length > 0;

  /** Una sesion con pestana abierta no se esconde: ver el manejador del socket. */
  const canArchive = (session: SessionSummary): boolean =>
    session.archived || !openSessionIds.has(session.sessionId);

  /*
    "Archivar historial". El corte se recalcula en cada render y no se fija al
    montar: con la ventana abierta de un dia para otro, "anterior a hoy" tiene
    que seguir siendo el hoy de ahora. Como es la medianoche, el numero cambia
    una vez por dia y la memoria no se invalida de mas.

    Las filas van en el orden de la lista de CLIs del `hello`: ver
    `archiveCandidatesByAgent`.
  */
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const historyCutoff = startOfLocalDay(Date.now());
  const agentOrder = useMemo(() => agents.map((info) => info.id), [agents]);
  const historyCandidates = useMemo(
    () => archiveCandidatesByAgent(projects, historyCutoff, openSessionIds, agentOrder),
    [projects, historyCutoff, openSessionIds, agentOrder],
  );

  /*
    Lo ultimo que se archivo de una vez, para deshacerlo con un clic. Esconde
    de a cientos, y sin esto una fila confirmada por error se devuelve de a
    una: "ver archivadas" solo las muestra. Deshacer manda los mismos ids y
    nada mas, que son exactamente los que se escondieron —las que ya estaban
    archivadas no entraron—. Queda hasta cerrarlo o hasta el siguiente.
  */
  const [lastHistoryArchive, setLastHistoryArchive] = useState<{
    /** De que se archivo, ya resuelto: el nombre de una CLI o el de un proyecto. */
    what: string;
    sessionIds: string[];
  } | null>(null);

  // Sin nada que archivar el panel se cierra, para que no reaparezca abierto
  // solo el dia en que vuelva a haber candidatas.
  useEffect(() => {
    if (historyCandidates.length === 0) setHistoryOpen(false);
  }, [historyCandidates.length]);

  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  /** Con la lista de ahora y no con la del render del panel: es la que se ve. */
  const archiveHistory = (agent: SessionAgentId): void => {
    const ids = sessionsToArchiveBefore(projects, agent, historyCutoff, openSessionIds);
    if (ids.length > 0) {
      onArchive(ids, true);
      setLastHistoryArchive({ what: sessionAgentLabel(agent, agents), sessionIds: ids });
    }
    setHistoryOpen(false);
  };

  /*
    "Archivar proyecto" (hito 31): el mismo archivado, sobre todas las filas
    visibles de un proyecto. Con la lista de ahora, no con la del render que
    dibujo la confirmacion: entre una cosa y otra el indice pudo emitir.
  */
  const [archivingProject, setArchivingProject] = useState<string | null>(null);

  const archiveProject = (project: ProjectSummary): void => {
    const plan = projectArchivePlan(project, openSessionIds);
    if (plan.sessionIds.length > 0) {
      onArchive(plan.sessionIds, true);
      setLastHistoryArchive({ what: projectName(project), sessionIds: plan.sessionIds });
    }
    setArchivingProject(null);
  };

  const undoHistoryArchive = (): void => {
    if (lastHistoryArchive !== null) onArchive(lastHistoryArchive.sessionIds, false);
    setLastHistoryArchive(null);
  };

  const toggleSelected = (sessionId: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  /** Lo seleccionado, en el orden en que se ve, y solo lo que sigue a la vista. */
  const selectedSessions = useMemo(() => {
    const found: SessionSummary[] = [];
    for (const project of visibleProjects) {
      for (const session of project.sessions) {
        if (selected.has(session.sessionId)) found.push(session);
      }
    }
    return found;
  }, [visibleProjects, selected]);

  const archiveSelected = (archived: boolean): void => {
    const ids = selectedSessions
      .filter((session) => (archived ? canArchive(session) : true))
      .map((session) => session.sessionId);
    if (ids.length > 0) onArchive(ids, archived);
    setSelected(new Set());
  };

  const toggle = (projectKey: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(projectKey)) next.delete(projectKey);
      else next.add(projectKey);
      return next;
    });
  };

  const scanning = indexStatus.state === 'scanning';

  return (
    <aside className="sidebar" style={{ width: `${width}px` }}>
      <div className="sidebar-header">
        <input
          className="sidebar-filter"
          type="search"
          placeholder={sidebarFilterPlaceholder(searchMode)}
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            if (searchMode !== 'conversations') return;
            setSearchTooShort(false);
            // Borrado entero, vuelve la lista: los aciertos eran de otro texto.
            if (event.target.value.trim().length === 0) globalSearch?.clear();
          }}
          onKeyDown={(event) => {
            if (searchMode !== 'conversations' || event.key !== 'Enter') return;
            event.preventDefault();
            submitGlobalSearch();
          }}
          spellCheck={false}
        />
        {/*
          Proyecto nuevo: abre el selector de carpetas. Es el unico camino para
          empezar en una carpeta que no este en el historial ni sea el
          directorio desde el que se lanzo el servidor.
        */}
        <button
          className="icon-button"
          onClick={onNewProject}
          title={t('sidebar.newProject')}
          disabled={disabled}
        >
          ＋
        </button>
        <button
          className="icon-button"
          onClick={onRefresh}
          title={t('sidebar.reindex')}
          disabled={scanning}
        >
          ⟳
        </button>
        {/*
          La copia propia (hito 28). Un icono y nada mas: con la copia apagada,
          que es como arranca, es todo lo que cambia en la barra (C9).
          Encendida se tine y aparece su linea de estado abajo.
        */}
        <button
          className={`icon-button${vault?.enabled === true ? ' icon-button-on' : ''}`}
          onClick={onOpenVault}
          title={vaultButtonTitle(vault)}
          aria-label={vaultName()}
        >
          <VaultIcon />
        </button>
        <button className="icon-button" onClick={onHide} title={t('sidebar.hide')}>
          «
        </button>
      </div>

      {/*
        Buscar en las conversaciones (hito 29). Solo con otra CLI y con algo en
        la copia propia (`globalSearchVisible`): si no, ni el hueco.
      */}
      {globalSearch !== null && (
        <div className="sidebar-search-mode" role="group" aria-label={t('sidebar.searchMode.label')}>
          <button
            className={`sidebar-search-mode-option${searchMode === 'titles' ? ' is-on' : ''}`}
            aria-pressed={searchMode === 'titles'}
            onClick={() => changeSearchMode('titles')}
            title={t('sidebar.searchMode.titlesTitle')}
          >
            {searchModeTitlesText()}
          </button>
          <button
            className={`sidebar-search-mode-option${searchMode === 'conversations' ? ' is-on' : ''}`}
            aria-pressed={searchMode === 'conversations'}
            onClick={() => changeSearchMode('conversations')}
            title={searchModeConversationsTitle()}
          >
            {searchModeConversationsText()}
          </button>
        </div>
      )}

      {scanning && (
        <div className="sidebar-progress">
          {t('sidebar.indexing', { scanned: indexStatus.scannedFiles, total: indexStatus.totalFiles })}
        </div>
      )}

      {/*
        El interruptor es global y no por proyecto: un proyecto con todas sus
        sesiones archivadas no se dibuja, asi que un boton adentro seria
        inalcanzable justo cuando hace falta.
      */}
      {(archivedCount > 0 || historyCandidates.length > 0) && (
        <div className="sidebar-archive-bar">
          {archivedCount > 0 && (
            <button
              className={`sidebar-archived-toggle${showArchived ? ' is-on' : ''}`}
              onClick={() => setShowArchived((current) => !current)}
              title={t('sidebar.archived.toggleTitle')}
            >
              {showArchived
                ? t('sidebar.archived.hide', { count: archivedCount })
                : t('sidebar.archived.show', { count: archivedCount })}
            </button>
          )}
          {/*
            Solo con algo que archivar, y tambien con una sola CLI: quien trae
            historial viejo de una sola es justo quien lo necesita.
          */}
          {historyCandidates.length > 0 && (
            <button
              ref={historyButtonRef}
              className={`link-button sidebar-archive-history${historyOpen ? ' is-on' : ''}`}
              onClick={() => setHistoryOpen((current) => !current)}
              aria-expanded={historyOpen}
              title={t('sidebar.history.buttonTitle')}
            >
              {t('sidebar.history.button')}
            </button>
          )}
        </div>
      )}

      {historyOpen && historyCandidates.length > 0 && (
        <ArchiveHistoryPanel
          candidates={historyCandidates}
          agents={agents}
          onArchiveAgent={archiveHistory}
          onClose={closeHistory}
          anchorRef={historyButtonRef}
        />
      )}

      {lastHistoryArchive !== null && !historyOpen && (
        <div className="archive-history archive-history-undo" role="status">
          <span className="archive-history-text">
            {t('sidebar.undo.text', {
              count: lastHistoryArchive.sessionIds.length,
              what: lastHistoryArchive.what,
            })}
          </span>
          <button className="link-button" onClick={undoHistoryArchive}>
            {t('sidebar.action.undo')}
          </button>
          <button
            className="icon-button"
            onClick={() => setLastHistoryArchive(null)}
            title={t('sidebar.undo.dismissTitle')}
          >
            ×
          </button>
        </div>
      )}

      {/* Solo encendida: ver `vaultLineText`. */}
      {vaultLine !== null && (
        <button
          className={`sidebar-vault-line${vault?.lastError != null ? ' is-problem' : ''}`}
          onClick={onOpenVault}
          title={
            vault?.lastError != null
              ? t('sidebar.vaultLine.lastError', { error: serverTextMessage(vault.lastError) })
              : t('sidebar.vaultLine.title')
          }
        >
          {vaultLine}
        </button>
      )}

      <div className="sidebar-scroll">
        {/*
          Los aciertos reemplazan a la lista, como la busqueda de archivos al
          arbol (CLAUDE.md 6.14): dos listas a la vez en 270 px no se leen.
        */}
        {showingSearch && globalSearch !== null && (
          <div className="search-results">
            {!globalSearch.vaultEnabled && <p className="search-note">{globalSearchOffText()}</p>}
            <p className={`search-status${globalSearch.error !== null ? ' is-problem' : ''}`} role="status">
              {searchTooShort
                ? globalSearchTooShortText()
                : globalSearchStatusText(globalSearch)}
            </p>
            {!searchTooShort &&
              searchGroups.map((group) => {
                const lead = group.hits[0] ?? group.titleHit;
                if (lead === null) return null;
                return (
                  <div className="search-group" key={group.key}>
                    <button
                      className="search-group-title"
                      onClick={() => onOpenSearchHit(lead, groupThreadQuery(group))}
                      title={sessionTitleText(group.title)}
                    >
                      <AgentBadge agent={group.agent} agents={agents} />
                      {group.titleHit !== null ? <SearchSnippet hit={group.titleHit} /> : sessionTitleText(group.title)}
                    </button>
                    {group.hits.map((hit) => (
                      <button
                        key={hit.eventId ?? 'titulo'}
                        className="search-hit"
                        onClick={() => onOpenSearchHit(hit, threadQueryFor(hit))}
                      >
                        <span className="search-hit-snippet">
                          <SearchSnippet hit={hit} />
                        </span>
                        <span className="search-hit-meta">
                          {searchHitRoleText(hit)}
                          {hit.at !== null ? ` · ${formatWhen(hit.at)}` : ''}
                        </span>
                      </button>
                    ))}
                  </div>
                );
              })}
          </div>
        )}

        {!showingSearch && visibleProjects.length === 0 && !scanning && (
          <p className="sidebar-empty">
            {projects.length === 0 ? t('sidebar.empty.noProjects') : t('sidebar.empty.noMatch')}
          </p>
        )}

        {!showingSearch && visibleProjects.map((project) => {
          const isOpen = expanded.has(project.key) || filtering;
          const canOpen = !disabled && project.cwdExists;
          // Una pestana pedida en esta carpeta y todavia sin confirmar.
          const opening = openBlocked(project.cwd);

          return (
            <div className="project" key={project.key}>
              <div className="project-row">
                <button
                  className="project-toggle"
                  onClick={() => toggle(project.key)}
                  title={project.cwd.length > 0 ? project.cwd : project.fallbackName}
                >
                  <span className={`chevron${isOpen ? ' chevron-open' : ''}`}>›</span>
                  {/*
                    El mismo color que el subrayado de las pestanas de este
                    proyecto (`project-color.ts`). Que signifique lo mismo en
                    los dos lados es todo el punto: uno mira la pestana, ve el
                    tono, y lo encuentra aca.
                  */}
                  <span
                    className="project-swatch"
                    style={{ background: projectColor(project.cwd) }}
                    aria-hidden="true"
                  />
                  <span className="project-name">{projectName(project)}</span>
                  <span className="project-count">{project.sessions.length}</span>
                </button>
                {/*
                  Exportar a Markdown (hito 28). Al pasar el mouse, como archivar
                  una fila: no es de todos los dias. Funciona con la copia
                  apagada y con la carpeta del proyecto borrada: lee del
                  historial o de la copia, y escribe en la carpeta de la copia.
                */}
                {/*
                  Los dos botones ocultos van en un grupo, y el hueco se
                  descuenta **una vez** en el grupo (hito 31). Con el margen
                  negativo en cada boton, el segundo caia encima del primero.
                */}
                <span className="project-actions">
                <button
                  className={`icon-button project-action${
                    exportState(project.key) !== 'idle' ? ' project-action-busy' : ''
                  }`}
                  onClick={() => onExportProject(project.key)}
                  disabled={exportState(project.key) === 'exporting'}
                  title={exportButtonTitle(exportState(project.key))}
                  aria-label={t('sidebar.project.export')}
                >
                  <ExportIcon done={exportState(project.key) === 'done'} />
                </button>
                {/*
                  Archivar el proyecto entero (hito 31). Al pasar el mouse, como
                  exportar y como archivar una fila: no es de todos los dias.
                  Confirma en el sitio —esconde de una vez todo lo que se ve del
                  proyecto— y sin `confirm()`, que bloquea la pagina entera.
                */}
                <button
                  className={`icon-button project-action${
                    archivingProject === project.key ? ' project-action-busy' : ''
                  }`}
                  onClick={() =>
                    setArchivingProject((current) =>
                      current === project.key ? null : project.key,
                    )
                  }
                  title={t('sidebar.project.archiveTitle')}
                  aria-label={t('sidebar.project.archive')}
                  aria-expanded={archivingProject === project.key}
                >
                  <ArchiveIcon out={false} />
                </button>
                </span>
                <AgentSplitButton
                  className="icon-button"
                  text="+"
                  title={
                    opening
                      ? openBlockedTitle()
                      : project.cwdExists
                        ? t('sidebar.project.newSession')
                        : t('sidebar.project.folderGone')
                  }
                  disabled={!canOpen || opening}
                  offerAgentChoice={offerAgentChoice}
                  agents={agents}
                  agent={offerAgentChoice ? agentForProject(project) : null}
                  onOpen={(agent) => onOpenProject(project.cwd, agent)}
                />
              </div>

              {!project.cwdExists && (
                <div className="project-missing" title={project.cwd}>
                  {t('sidebar.project.missing')}
                </div>
              )}

              {archivingProject === project.key && (
                <ProjectArchiveConfirm
                  project={project}
                  openSessionIds={openSessionIds}
                  onConfirm={() => archiveProject(project)}
                  onCancel={() => setArchivingProject(null)}
                />
              )}

              {isOpen && (
                <ul className="session-list">
                  {project.sessions.map((session) => {
                    const isSelected = selected.has(session.sessionId);
                    const blocked = !canArchive(session);
                    const agentView = sessionAgentView(session.agent, agents, offerAgentChoice);
                    // Una importada, o una que solo queda en la copia propia, no
                    // se reanuda: su CLI no la tiene. Se abre en Markdown, y eso
                    // no depende de la CLI ni de la carpeta (hito 28, D8).
                    const vaultView = sessionVaultView(session);
                    const resumable = resumableSession(session) && canResume(session.agent);
                    const openable = vaultView.copy || (canOpen && resumable);

                    return (
                      <li
                        key={`${session.agent}:${session.sessionId}`}
                        className={`session-row${session.archived ? ' session-archived' : ''}${
                          isSelected ? ' session-selected' : ''
                        }`}
                      >
                        <button
                          className="session-item"
                          onClick={(event) => {
                            // Ctrl/Cmd+clic selecciona en vez de abrir: limpiar
                            // veinte sesiones de prueba de a una son veinte
                            // pestanas abiertas sin querer.
                            if (event.ctrlKey || event.metaKey) {
                              toggleSelected(session.sessionId);
                              return;
                            }
                            // Una fila "copia" se lee, no se retoma: se abre su
                            // Markdown y la fila queda como estaba.
                            if (vaultView.copy) {
                              onOpenVaultSession(session);
                              return;
                            }
                            // Abrir una archivada la devuelve a la lista:
                            // trabajar en algo escondido y que siga escondido
                            // es peor que no haberla escondido nunca.
                            if (!resumableSession(session)) return;
                            if (session.archived) onArchive([session.sessionId], false);
                            // Con el `cwd` que escribio la CLI, salvo que solo
                            // cambien las mayusculas (ver `resumeCwdFor`).
                            onOpenSession(resumeCwdFor(session.cwd, project.cwd, platform), session);
                          }}
                          disabled={!openable}
                          title={
                            vaultView.copy
                              ? `${sessionTitleText(session.title, session.titleSource)}\n${vaultMarkTitle()}`
                              : (agentView.unavailableTitle ?? sessionTitleText(session.title, session.titleSource))
                          }
                        >
                          <span className="session-title">
                            {agentView.badge && <AgentBadge agent={session.agent} agents={agents} />}
                            {vaultView.copy && (
                              <span className="session-vault-mark" title={vaultMarkTitle()}>
                                {vaultMarkText()}
                              </span>
                            )}
                            {vaultView.partial && (
                              <span className="session-partial-mark" title={partialMarkTitle()}>
                                {partialMarkText()}
                              </span>
                            )}
                            {sessionTitleText(session.title, session.titleSource)}
                          </span>
                          <span className="session-meta">{formatWhen(session.updatedAt)}</span>
                        </button>

                        {/*
                          Continuar con otra CLI (hito 29). Solo con otra
                          instalada: con una sola, `continueTargets` es vacio y
                          no se dibuja nada, ni siquiera su hueco. Escondido no
                          ocupa lugar, como exportar un proyecto (§13.10): si
                          no, cada titulo se cortaria antes para quien tiene
                          varias CLIs.
                        */}
                        <ContinueButton
                          targets={continueTargets(agents, session.agent, session.partial)}
                          className="icon-button session-continue"
                          text="↪"
                          onPick={(target) => onContinueSession(session, target)}
                        />

                        <button
                          className="icon-button session-action"
                          onClick={() => onArchive([session.sessionId], !session.archived)}
                          disabled={blocked}
                          title={
                            session.archived
                              ? t('sidebar.session.restore')
                              : blocked
                                ? t('sidebar.session.blocked')
                                : t('sidebar.session.archive')
                          }
                        >
                          <ArchiveIcon out={session.archived} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {/*
        Al pie y flotando, no arriba: una barra que aparece encima de la lista
        la empuja hacia abajo, y el segundo Ctrl+clic termina cayendo una fila
        mas arriba de donde se apunto. Seleccionar de a varias es justo el caso
        en que eso pasa siempre.
      */}
      {selectedSessions.length > 0 && (
        <div className="sidebar-selection">
          <span>{t('sidebar.selection.count', { count: selectedSessions.length })}</span>
          {selectedSessions.some((session) => !session.archived) && (
            <button className="link-button" onClick={() => archiveSelected(true)}>
              {t('sidebar.action.archive')}
            </button>
          )}
          {selectedSessions.some((session) => session.archived) && (
            <button className="link-button" onClick={() => archiveSelected(false)}>
              {t('sidebar.action.restore')}
            </button>
          )}
          <button className="link-button" onClick={() => setSelected(new Set())}>
            {t('common.cancel')}
          </button>
        </div>
      )}
    </aside>
  );
}
