/**
 * Columna derecha: la CLI, los cambios, los archivos y los planes.
 *
 * Desde el hito 7 la terminal vive **aca**, no en el centro: el centro es la
 * conversacion. La solapa se llama `CLI` porque es lo que es — el sitio donde
 * se ve lo que se le manda al agente, incluidas las ordenes que el chat no
 * muestra (`/model`, `/effort`).
 *
 * Los tres paneles se turnan en vez de repartirse la pantalla. Lo mismo que
 * antes, por la misma razon: partir 640 px en tres deja los tres inservibles.
 *
 * **La terminal no se desmonta al cambiar de solapa.** Se esconde con
 * `visibility`, igual que las pestanas inactivas: desmontarla soltaria el
 * enganche y la repintaria entera con el replay cada vez que alguien mira
 * `Cambios`. Lo que si pasa —y esta previsto— es que mientras esta escondida el
 * contenedor mide 0x0; `TerminalView` no le avisa ese tamano al pty.
 */

import type { GitStatus } from '@agent-workbench/shared';
import { FilesPanel } from './FilesPanel.js';
import { GitPanel } from './GitPanel.js';
import { PlansPanel } from './PlansPanel.js';
import type { FilesView } from './useFiles.js';
import type { GitView } from './useGit.js';
import type { PlansView } from './usePlans.js';

export type PanelTab = 'cli' | 'git' | 'files' | 'plans';

export const PANEL_TABS: readonly { id: PanelTab; label: string }[] = [
  { id: 'cli', label: 'CLI' },
  { id: 'git', label: 'Cambios' },
  { id: 'files', label: 'Archivos' },
  { id: 'plans', label: 'Planes' },
];

/** Cuantos archivos tocados mostrar en la pastilla de la pestana "Cambios". */
function changeCount(status: GitStatus): number {
  if (status.state !== 'ready') return 0;
  // Un archivo modificado y ademas preparado aparece dos veces en la lista,
  // pero como archivo tocado es uno solo.
  return new Set(status.changes.map((change) => change.path)).size;
}

interface SidePanelProps {
  tab: PanelTab;
  /**
   * true si el panel esta escondido (Alt+P).
   *
   * Se esconde, **no** se desmonta: la terminal vive adentro y desmontarla
   * costaria un replay entero en cada ida y vuelta del interruptor.
   */
  hidden: boolean;
  onTabChange: (tab: PanelTab) => void;
  /** Etiqueta de la pestana activa, para el encabezado. */
  title: string;
  cwd: string;
  platform: string;
  /**
   * Las terminales, ya montadas.
   *
   * Llegan armadas desde arriba y no se construyen aca a proposito: son de la
   * aplicacion, no de este panel, y tienen que sobrevivir a que se cambie de
   * solapa. Este componente solo decide donde se dibujan y cuando se ven.
   */
  cli: JSX.Element;
  /** true si la CLI escribio algo desde la ultima vez que se la miro. */
  cliUnseen: boolean;
  /** true si la columna esta en modo ancho. */
  expanded: boolean;
  onToggleExpanded: () => void;
  git: GitView;
  files: FilesView;
  plans: PlansView;
  /** Escribe texto en la terminal sin enviarlo. */
  onInsert: (text: string) => void;
  onReveal: (path: string) => void;
  onHide: () => void;
}

export function SidePanel({
  tab,
  hidden,
  onTabChange,
  title,
  cwd,
  platform,
  cli,
  cliUnseen,
  expanded,
  onToggleExpanded,
  git,
  files,
  plans,
  onInsert,
  onReveal,
  onHide,
}: SidePanelProps): JSX.Element {
  const changes = changeCount(git.status);

  return (
    <section className={`side-panel${hidden ? ' side-panel-hidden' : ''}`} aria-hidden={hidden}>
      <header className="side-panel-header">
        <span className="side-panel-title" title={cwd}>
          {title}
        </span>
        <button
          className="icon-button"
          onClick={onToggleExpanded}
          title={
            expanded
              ? 'Devolver la columna a su ancho'
              : 'Ensanchar la columna — la interfaz de la CLI necesita ancho para dibujar diffs y tablas'
          }
        >
          {expanded ? '⇥' : '⇤'}
        </button>
        <button className="icon-button" onClick={onHide} title="Ocultar el panel (Alt+P)">
          ×
        </button>
      </header>

      <nav className="side-panel-tabs">
        {PANEL_TABS.map((entry) => (
          <button
            key={entry.id}
            className={`side-panel-tab${entry.id === tab ? ' side-panel-tab-active' : ''}`}
            onClick={() => onTabChange(entry.id)}
          >
            {entry.label}
            {entry.id === 'git' && changes > 0 && (
              <span className="side-panel-badge">{changes}</span>
            )}
            {entry.id === 'plans' && plans.plans.length > 0 && (
              <span className="side-panel-badge">{plans.plans.length}</span>
            )}
            {/*
              La CLI escribio algo y nadie lo vio. Es el unico aviso de que hay
              algo esperando del otro lado —un permiso, una pregunta— cuando la
              solapa no esta delante. Sin esto, esconder la CLI significa
              enterarse tarde.
            */}
            {entry.id === 'cli' && cliUnseen && tab !== 'cli' && (
              <span className="side-panel-dot" title="La CLI escribio algo" />
            )}
          </button>
        ))}
      </nav>

      <div className="side-panel-body">
        {/* Siempre montada; solo se esconde. Ver la cabecera del archivo. */}
        <div className={`cli-slot${tab === 'cli' ? '' : ' cli-slot-hidden'}`}>{cli}</div>

        {tab === 'git' && <GitPanel view={git} />}
        {tab === 'plans' && <PlansPanel view={plans} />}
        {tab === 'files' && (
          <FilesPanel
            view={files}
            cwd={cwd}
            platform={platform}
            onInsert={onInsert}
            onReveal={onReveal}
          />
        )}
      </div>
    </section>
  );
}
