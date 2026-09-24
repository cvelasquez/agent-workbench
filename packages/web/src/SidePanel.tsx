/**
 * Columna derecha: la CLI, los cambios, los archivos, los planes y la memoria.
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
import { visiblePanelTabs } from './agent-ui.js';
import { FilesPanel } from './FilesPanel.js';
import { GitPanel } from './GitPanel.js';
import { t, type MessageKey } from './i18n/index.js';
import { MemoryPanel } from './MemoryPanel.js';
import { PlansPanel } from './PlansPanel.js';
import { projectColor } from './project-color.js';
import type { FilesView } from './useFiles.js';
import type { GitView } from './useGit.js';
import type { MemoryView } from './useMemory.js';
import type { PlansView } from './usePlans.js';

export type PanelTab = 'cli' | 'git' | 'files' | 'plans' | 'memory';

export const PANEL_TABS: readonly { id: PanelTab; labelKey: MessageKey }[] = [
  { id: 'cli', labelKey: 'panel.tab.cli' },
  { id: 'git', labelKey: 'panel.tab.git' },
  { id: 'files', labelKey: 'panel.tab.files' },
  { id: 'plans', labelKey: 'panel.tab.plans' },
  { id: 'memory', labelKey: 'panel.tab.memory' },
];

/** Cuantos archivos tocados mostrar en la pastilla de la pestana "Cambios". */
export function changeCount(status: GitStatus): number {
  if (status.state !== 'ready') return 0;
  // Un archivo modificado y ademas preparado aparece dos veces en la lista,
  // pero como archivo tocado es uno solo.
  return new Set(status.changes.map((change) => change.path)).size;
}

interface SidePanelProps {
  /**
   * La solapa a mostrar, ya resuelta contra lo que ofrece la CLI de la pestana
   * (`effectivePanelTab`): nunca llega `plans` si no hay planes.
   */
  tab: PanelTab;
  /** false si la CLI de la pestana no tiene planes: la solapa no se ofrece. */
  plansAvailable: boolean;
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
  memory: MemoryView;
  /**
   * Escribe texto en la terminal sin enviarlo. Sin el, el arbol no ofrece
   * "Insertar como @ruta": la CLI de la pestana no menciona archivos asi.
   */
  onInsert?: (text: string) => void;
  /** Pone una ruta del arbol en el cuadro de escritura, donde esta el cursor. */
  onInsertPath: (text: string) => void;
  onReveal: ((path: string) => void) | null;
  onHide: () => void;
}

export function SidePanel({
  tab,
  plansAvailable,
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
  memory,
  onInsert,
  onInsertPath,
  onReveal,
  onHide,
}: SidePanelProps): JSX.Element {
  const changes = changeCount(git.status);
  // Solo con el puente instalado: sin el, el panel no lista notas, y una
  // pastilla con un numero que no lleva a ninguna lista confunde.
  const notes = memory.status?.installed === true ? memory.status.notes.length : 0;

  return (
    <section className={`side-panel${hidden ? ' side-panel-hidden' : ''}`} aria-hidden={hidden}>
      <header className="side-panel-header">
        {/*
          Esconder va primero, en el borde que da al chat, y con `»`: el mismo
          gesto que el `«` de la barra de proyectos, del otro lado. Era una `×`
          al final, que se lee como "cerrar" y no esconde nada que no vuelva.
        */}
        <button className="icon-button" onClick={onHide} title={t('panel.hide')}>
          »
        </button>
        {cwd.length > 0 && <span className="project-swatch" style={{ background: projectColor(cwd) }} />}
        <span className="side-panel-title" title={cwd}>
          {title}
        </span>
        <button
          className="icon-button"
          onClick={onToggleExpanded}
          title={expanded ? t('panel.restoreWidth') : t('panel.widen')}
        >
          {expanded ? '⇥' : '⇤'}
        </button>
      </header>

      <nav className="side-panel-tabs">
        {visiblePanelTabs(PANEL_TABS, plansAvailable).map((entry) => (
          <button
            key={entry.id}
            className={`side-panel-tab${entry.id === tab ? ' side-panel-tab-active' : ''}`}
            onClick={() => onTabChange(entry.id)}
            title={t(entry.labelKey)}
          >
            {/*
              La etiqueta va aparte para poder recortarla: con cinco solapas y
              la columna en su minimo, las solapas se encogen en vez de empujar
              la ultima fuera del panel.
            */}
            <span className="side-panel-tab-label">{t(entry.labelKey)}</span>
            {entry.id === 'git' && changes > 0 && (
              <span className="side-panel-badge">{changes}</span>
            )}
            {entry.id === 'plans' && plans.plans.length > 0 && (
              <span className="side-panel-badge">{plans.plans.length}</span>
            )}
            {entry.id === 'memory' && notes > 0 && (
              <span className="side-panel-badge">{notes}</span>
            )}
            {/*
              La CLI escribio algo y nadie lo vio. Es el unico aviso de que hay
              algo esperando del otro lado —un permiso, una pregunta— cuando la
              solapa no esta delante. Sin esto, esconder la CLI significa
              enterarse tarde.
            */}
            {entry.id === 'cli' && cliUnseen && tab !== 'cli' && (
              <span className="side-panel-dot" title={t('panel.cliUnseen')} />
            )}
          </button>
        ))}
      </nav>

      <div className="side-panel-body">
        {/* Siempre montada; solo se esconde. Ver la cabecera del archivo. */}
        <div className={`cli-slot${tab === 'cli' ? '' : ' cli-slot-hidden'}`}>{cli}</div>

        {tab === 'git' && <GitPanel view={git} />}
        {tab === 'plans' && <PlansPanel view={plans} />}
        {tab === 'memory' && <MemoryPanel view={memory} />}
        {tab === 'files' && (
          <FilesPanel
            view={files}
            cwd={cwd}
            platform={platform}
            onInsert={onInsert}
            onInsertPath={onInsertPath}
            onReveal={onReveal}
          />
        )}
      </div>
    </section>
  );
}
