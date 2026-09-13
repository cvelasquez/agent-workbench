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

import { useMemo, useState } from 'react';
import {
  resumeCwdFor,
  type AgentId,
  type IndexStatus,
  type ProjectSummary,
  type SessionSummary,
} from '@agent-workbench/shared';
import { formatWhen } from './format-when.js';
import { NotesPanel } from './NotesPanel.js';
import { projectColor } from './project-color.js';
import type { NotesApi } from './useNotes.js';

interface SidebarProps {
  projects: ProjectSummary[];
  indexStatus: IndexStatus;
  disabled: boolean;
  /** Sesiones con una pestana abierta. No se archivan: ver `canArchive`. */
  openSessionIds: Set<string>;
  onOpenProject: (cwd: string) => void;
  /** Retoma una sesion del historial, con su CLI: la sesion sabe de cual es. */
  onOpenSession: (cwd: string, session: SessionSummary) => void;
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
  /** Notas sueltas, al pie. No son de ningun proyecto: ver `NotesPanel`. */
  notes: NotesApi;
  /** Abre el selector de carpetas para empezar un proyecto nuevo. */
  onNewProject: () => void;
  /**
   * Manda una nota al agente en una conversacion nueva. null sin pestana, o si
   * su CLI no avisa cuando esta lista para recibirla.
   */
  onSendNote: ((noteId: string) => void) | null;
  /** El `cwd` donde se abriria esa conversacion. */
  sendNoteCwd: string | null;
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

export function Sidebar({
  projects,
  indexStatus,
  disabled,
  openSessionIds,
  onOpenProject,
  onOpenSession,
  canResume,
  platform,
  onRefresh,
  onArchive,
  onHide,
  width,
  notes,
  onNewProject,
  onSendNote,
  sendNoteCwd,
}: SidebarProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

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
    const needle = filter.trim().toLowerCase();

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
          session.title.toLowerCase().includes(needle),
        );
        return found.length > 0 ? { ...project, sessions: found } : null;
      })
      .filter((project): project is ProjectSummary => project !== null);
  }, [projects, filter, showArchived]);

  /** Una sesion con pestana abierta no se esconde: ver el manejador del socket. */
  const canArchive = (session: SessionSummary): boolean =>
    session.archived || !openSessionIds.has(session.sessionId);

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
          placeholder="Filtrar proyectos y sesiones"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
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
          title="Proyecto nuevo: elegir o crear una carpeta"
          disabled={disabled}
        >
          ＋
        </button>
        <button
          className="icon-button"
          onClick={onRefresh}
          title="Reindexar el historial"
          disabled={scanning}
        >
          ⟳
        </button>
        <button className="icon-button" onClick={onHide} title="Ocultar los proyectos">
          «
        </button>
      </div>

      {scanning && (
        <div className="sidebar-progress">
          Indexando {indexStatus.scannedFiles} / {indexStatus.totalFiles}
        </div>
      )}

      {/*
        El interruptor es global y no por proyecto: un proyecto con todas sus
        sesiones archivadas no se dibuja, asi que un boton adentro seria
        inalcanzable justo cuando hace falta.
      */}
      {archivedCount > 0 && (
        <button
          className={`sidebar-archived-toggle${showArchived ? ' is-on' : ''}`}
          onClick={() => setShowArchived((current) => !current)}
          title="Las archivadas siguen en disco; esto solo las muestra u oculta"
        >
          {showArchived ? 'Ocultar' : 'Ver'} {archivedCount} archivada
          {archivedCount === 1 ? '' : 's'}
        </button>
      )}


      <div className="sidebar-scroll">
        {visibleProjects.length === 0 && !scanning && (
          <p className="sidebar-empty">
            {projects.length === 0
              ? 'No se encontraron proyectos en el historial.'
              : 'Nada coincide con el filtro.'}
          </p>
        )}

        {visibleProjects.map((project) => {
          const isOpen = expanded.has(project.key) || filter.trim().length > 0;
          const canOpen = !disabled && project.cwdExists;

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
                <button
                  className="icon-button"
                  onClick={() => onOpenProject(project.cwd)}
                  disabled={!canOpen}
                  title={
                    project.cwdExists
                      ? 'Nueva sesion en este proyecto'
                      : 'La carpeta ya no existe en disco'
                  }
                >
                  +
                </button>
              </div>

              {!project.cwdExists && (
                <div className="project-missing" title={project.cwd}>
                  carpeta no encontrada
                </div>
              )}

              {isOpen && (
                <ul className="session-list">
                  {project.sessions.map((session) => {
                    const isSelected = selected.has(session.sessionId);
                    const blocked = !canArchive(session);

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
                            // Abrir una archivada la devuelve a la lista:
                            // trabajar en algo escondido y que siga escondido
                            // es peor que no haberla escondido nunca.
                            if (session.archived) onArchive([session.sessionId], false);
                            // Con el `cwd` que escribio la CLI, salvo que solo
                            // cambien las mayusculas (ver `resumeCwdFor`).
                            onOpenSession(resumeCwdFor(session.cwd, project.cwd, platform), session);
                          }}
                          disabled={!canOpen || !canResume(session.agent)}
                          title={session.title}
                        >
                          <span className="session-title">{session.title}</span>
                          <span className="session-meta">{formatWhen(session.updatedAt)}</span>
                        </button>

                        <button
                          className="icon-button session-action"
                          onClick={() => onArchive([session.sessionId], !session.archived)}
                          disabled={blocked}
                          title={
                            session.archived
                              ? 'Restaurar a la lista'
                              : blocked
                                ? 'Tiene una pestaña abierta. Cerrala primero.'
                                : 'Archivar — la esconde de la lista, no borra nada'
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
          <span>
            {selectedSessions.length} seleccionada{selectedSessions.length === 1 ? '' : 's'}
          </span>
          {selectedSessions.some((session) => !session.archived) && (
            <button className="link-button" onClick={() => archiveSelected(true)}>
              Archivar
            </button>
          )}
          {selectedSessions.some((session) => session.archived) && (
            <button className="link-button" onClick={() => archiveSelected(false)}>
              Restaurar
            </button>
          )}
          <button className="link-button" onClick={() => setSelected(new Set())}>
            Cancelar
          </button>
        </div>
      )}

      {/*
        Al pie, debajo de todo: las notas no son de ningun proyecto, y lo que
        no es de la pestana activa no va en el panel derecho.
      */}
      <NotesPanel notes={notes} onSendNote={onSendNote} sendTargetCwd={sendNoteCwd} />
    </aside>
  );
}
