/**
 * El cascarón de la vista angosta (hito 38, §6.25): una sola columna, para un
 * teléfono, una tablet vertical o una ventana de menos de 768 px.
 *
 * Las piezas son las de siempre —la barra de proyectos, el hilo, el cuadro, el
 * panel, las notas, la consola—; lo que cambia es dónde van. `App` las arma y
 * las pasa ya cableadas; acá solo se decide cuál se ve:
 *
 *  - **La cabecera son tres cosas.** `☰` abre la barra de proyectos como un
 *    cajón desde la izquierda; el centro es la pestaña activa, con su punto de
 *    actividad, y abre la hoja de pestañas; `⋮` abre la hoja con lo que en la
 *    PC vive en la cabecera. Sin pestaña, el centro dice el nombre de la app.
 *  - **La tira de vistas** reemplaza a las solapas del panel derecho, con el
 *    chat primero y las notas y la consola al final.
 *  - **Nada se desmonta al cambiar de vista.** El panel y la consola llevan
 *    terminales, y desmontarlas las repintaría con el replay; el hilo guarda su
 *    scroll. Las vistas que no se ven quedan sin tamaño (`narrow-pane-hidden`)
 *    para que la terminal del teléfono no le mande a la pty un tamaño que
 *    nadie está mirando (§14.6); el chat solo se vela, para conservar el scroll.
 *  - **La fila de teclas** aparece con la vista CLI y manda por el mismo
 *    `input` que xterm.
 *
 * `Escape` cierra el cajón o la hoja abierta, en captura, como los diálogos.
 *
 * Dentro de la app de Android (hito 38) el botón Atrás del teléfono llama a
 * `window.agentWorkbenchBack`, que cierra lo de más arriba o vuelve al chat
 * (`narrowBackAction`), y la hoja `⋮` ofrece los ajustes de la app.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  AgentId,
  AgentInfo,
  StatusLineSetupInfo,
  TerminalActivity,
  TerminalDescriptor,
  TerminalId,
} from '@agent-workbench/shared';
import { AgentSplitButton } from './AgentSplitButton.js';
import type { ConnectionStatus } from './connection.js';
import { t } from './i18n/index.js';
import { LocaleMenu } from './LocaleMenu.js';
import {
  NATIVE_BACK_HOOK,
  PHONE_APP_SETTINGS_URL,
  insidePhoneApp,
  narrowBackAction,
  narrowViewLabelKey,
  type NarrowView,
} from './narrow-layout.js';
import { NotifyButton, SoundControl } from './SoundControl.js';
import { TabStatus, defaultTabLabel } from './TabBar.js';
import { TerminalKeys } from './TerminalKeys.js';
import type { NotificationSoundState } from './useNotificationSound.js';

export interface NarrowBadges {
  changes: number;
  plans: number;
  memory: number;
  cliUnseen: boolean;
}

/** Lo que en la PC está en la cabecera y acá va en la hoja `⋮`. */
export interface NarrowMenu {
  cwd: string | null;
  cliVersion: string | null;
  themeIcon: string;
  themeTitle: string;
  onCycleTheme: () => void;
  sound: NotificationSoundState;
  /** null en una ventana remota, o con un servidor anterior al hito 37. */
  remote: { title: string; active: boolean; onOpen: () => void } | null;
  remoteClient: boolean;
  onShortcuts: () => void;
}

interface NarrowShellProps {
  banners: ReactNode;
  status: ConnectionStatus;
  statusLabel: string;
  terminals: readonly TerminalDescriptor[];
  activeTerminalId: TerminalId | null;
  activity: ReadonlyMap<TerminalId, TerminalActivity>;
  agents: readonly AgentInfo[];
  offerAgentChoice: boolean;
  newTabAgent: AgentId | null;
  canOpen: boolean;
  newTabBlockedTitle: string | null;
  onSelectTab: (terminalId: TerminalId) => void;
  onCloseTab: (terminalId: TerminalId) => void;
  onRenameTab: (terminalId: TerminalId, label: string) => void;
  onNewTab: (agent?: AgentId) => void;
  /** La barra de proyectos, ya armada. */
  drawer: ReactNode;
  drawerOpen: boolean;
  onDrawerChange: (open: boolean) => void;
  menu: NarrowMenu;
  view: NarrowView;
  views: readonly NarrowView[];
  onViewChange: (view: NarrowView) => void;
  badges: NarrowBadges;
  /** El hilo (o el estado vacío) y el cuadro de escritura. */
  chat: ReactNode;
  /** El `SidePanel`, con su `hidden` ya decidido por la vista. */
  panel: ReactNode;
  notes: ReactNode;
  console: ReactNode;
  onTerminalKey: (data: string) => void;
}

type Sheet = 'tabs' | 'menu' | null;

export function NarrowShell({
  banners,
  status,
  statusLabel,
  terminals,
  activeTerminalId,
  activity,
  agents,
  offerAgentChoice,
  newTabAgent,
  canOpen,
  newTabBlockedTitle,
  onSelectTab,
  onCloseTab,
  onRenameTab,
  onNewTab,
  drawer,
  drawerOpen,
  onDrawerChange,
  menu,
  view,
  views,
  onViewChange,
  badges,
  chat,
  panel,
  notes,
  console: consolePane,
  onTerminalKey,
}: NarrowShellProps): JSX.Element {
  const [sheet, setSheet] = useState<Sheet>(null);
  const activeTerminal = terminals.find((terminal) => terminal.terminalId === activeTerminalId) ?? null;
  const statusLineOf = (terminal: TerminalDescriptor) =>
    agents.find((agent) => agent.id === terminal.agent)?.statusLine ?? null;

  // Escape cierra lo que esté abierto encima. En captura, antes que xterm.
  useEffect(() => {
    if (!drawerOpen && sheet === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (sheet !== null) setSheet(null);
      else onDrawerChange(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [drawerOpen, sheet, onDrawerChange]);

  /*
    El botón Atrás de la app de Android (hito 38). La app llama a esta función
    y, si devuelve false, se va al fondo. Lee el estado del momento por una
    referencia: se registra una sola vez.
  */
  const backState = useRef({ sheet, drawerOpen, view, onDrawerChange, onViewChange });
  backState.current = { sheet, drawerOpen, view, onDrawerChange, onViewChange };
  useEffect(() => {
    const hooks = window as unknown as Record<string, unknown>;
    hooks[NATIVE_BACK_HOOK] = (): boolean => {
      const current = backState.current;
      const action = narrowBackAction({
        dialogOpen: document.querySelector('.modal-backdrop') !== null,
        sheetOpen: current.sheet !== null,
        drawerOpen: current.drawerOpen,
        view: current.view,
      });
      switch (action) {
        case 'close-dialog':
          // Los diálogos se cierran con Escape, en captura sobre window.
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
          return true;
        case 'close-sheet':
          setSheet(null);
          return true;
        case 'close-drawer':
          current.onDrawerChange(false);
          return true;
        case 'show-chat':
          current.onViewChange('chat');
          return true;
        case null:
          return false;
      }
    };
    return () => {
      delete hooks[NATIVE_BACK_HOOK];
    };
  }, []);

  // La vista activa se trae a la vista en la tira, que se desliza.
  const activeViewRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    activeViewRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [view]);

  const badgeOf = (entry: NarrowView): ReactNode => {
    const count =
      entry === 'git' ? badges.changes : entry === 'plans' ? badges.plans : entry === 'memory' ? badges.memory : 0;
    if (count > 0) return <span className="side-panel-badge">{count}</span>;
    if (entry === 'cli' && badges.cliUnseen && view !== 'cli') {
      return <span className="narrow-view-dot" title={t('panel.cliUnseen')} />;
    }
    return null;
  };

  return (
    <>
      <header className="app-header narrow-header">
        <button
          className="icon-button narrow-icon"
          onClick={() => onDrawerChange(true)}
          title={t('narrow.projects')}
          aria-label={t('narrow.projects')}
        >
          ☰
        </button>
        <button className="narrow-current" onClick={() => setSheet('tabs')} title={t('narrow.tabs.open')}>
          {activeTerminal === null ? (
            <span className="app-name">Agent Workbench</span>
          ) : (
            <>
              <TabStatus
                terminal={activeTerminal}
                activity={activity.get(activeTerminal.terminalId)}
                statusLine={statusLineOf(activeTerminal)}
              />
              <span className="narrow-current-label">{defaultTabLabel(activeTerminal)}</span>
            </>
          )}
          <span className="narrow-caret" aria-hidden="true">
            ▾
          </span>
        </button>
        {status !== 'open' && <span className={`status status-${status}`}>{statusLabel}</span>}
        <button
          className="icon-button narrow-icon"
          onClick={() => setSheet('menu')}
          title={t('narrow.more')}
          aria-label={t('narrow.more')}
        >
          ⋮
        </button>
      </header>

      {banners}

      <div className="narrow-body">
        <nav className="narrow-views" role="tablist">
          {views.map((entry) => (
            <button
              key={entry}
              ref={entry === view ? activeViewRef : null}
              role="tab"
              aria-selected={entry === view}
              className={`narrow-view-tab${entry === view ? ' narrow-view-active' : ''}`}
              onClick={() => onViewChange(entry)}
            >
              <span>{t(narrowViewLabelKey(entry))}</span>
              {badgeOf(entry)}
            </button>
          ))}
        </nav>
        <div className="narrow-stack">
          <main className={`workspace narrow-pane${view === 'chat' ? '' : ' narrow-pane-veiled'}`}>{chat}</main>
          {panel}
          <div className={`narrow-pane${view === 'notes' ? '' : ' narrow-pane-hidden'}`}>{notes}</div>
          <div className={`narrow-pane${view === 'console' ? '' : ' narrow-pane-hidden'}`}>{consolePane}</div>
        </div>
        {view === 'cli' && <TerminalKeys onKey={onTerminalKey} />}
      </div>

      {drawerOpen && (
        <div className="narrow-backdrop" onClick={() => onDrawerChange(false)}>
          <div className="narrow-drawer" onClick={(event) => event.stopPropagation()}>
            {drawer}
          </div>
        </div>
      )}

      {sheet === 'tabs' && (
        <div className="narrow-backdrop" onClick={() => setSheet(null)}>
          <div className="narrow-sheet" role="dialog" aria-label={t('narrow.tabs.open')} onClick={(event) => event.stopPropagation()}>
            <TabSheet
              terminals={terminals}
              activeTerminalId={activeTerminalId}
              activity={activity}
              statusLineOf={statusLineOf}
              onSelect={(terminalId) => {
                onSelectTab(terminalId);
                setSheet(null);
              }}
              onClose={onCloseTab}
              onRename={onRenameTab}
            />
            <AgentSplitButton
              className="narrow-sheet-new"
              text={t('narrow.tabs.new')}
              title={newTabBlockedTitle ?? t('narrow.tabs.new')}
              disabled={!canOpen || newTabBlockedTitle !== null}
              offerAgentChoice={offerAgentChoice}
              agents={agents}
              agent={newTabAgent}
              onOpen={(agent) => {
                onNewTab(agent);
                setSheet(null);
              }}
            />
          </div>
        </div>
      )}

      {sheet === 'menu' && (
        <div className="narrow-backdrop" onClick={() => setSheet(null)}>
          <div className="narrow-sheet" role="dialog" aria-label={t('narrow.more')} onClick={(event) => event.stopPropagation()}>
            <MenuSheet menu={menu} status={status} statusLabel={statusLabel} onClose={() => setSheet(null)} />
          </div>
        </div>
      )}
    </>
  );
}

function TabSheet({
  terminals,
  activeTerminalId,
  activity,
  statusLineOf,
  onSelect,
  onClose,
  onRename,
}: {
  terminals: readonly TerminalDescriptor[];
  activeTerminalId: TerminalId | null;
  activity: ReadonlyMap<TerminalId, TerminalActivity>;
  statusLineOf: (terminal: TerminalDescriptor) => StatusLineSetupInfo | null;
  onSelect: (terminalId: TerminalId) => void;
  onClose: (terminalId: TerminalId) => void;
  onRename: (terminalId: TerminalId, label: string) => void;
}): JSX.Element {
  const [editingId, setEditingId] = useState<TerminalId | null>(null);
  const [draft, setDraft] = useState('');
  // Android ignora `autoFocus`: el foco —y con el, el teclado— se pide a mano.
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editingId !== null) inputRef.current?.select();
  }, [editingId]);

  const commit = (): void => {
    if (editingId !== null) onRename(editingId, draft.trim());
    setEditingId(null);
  };

  if (terminals.length === 0) return <p className="narrow-sheet-empty">{t('narrow.tabs.none')}</p>;

  return (
    <ul className="narrow-tabs">
      {terminals.map((terminal) => {
        const editing = editingId === terminal.terminalId;
        return (
          <li
            key={terminal.terminalId}
            className={`narrow-tab-row${terminal.terminalId === activeTerminalId ? ' narrow-tab-active' : ''}`}
          >
            {editing ? (
              <input
                ref={inputRef}
                className="narrow-tab-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit();
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    setEditingId(null);
                  }
                }}
              />
            ) : (
              <button className="narrow-tab-select" onClick={() => onSelect(terminal.terminalId)}>
                <TabStatus
                  terminal={terminal}
                  activity={activity.get(terminal.terminalId)}
                  statusLine={statusLineOf(terminal)}
                />
                <span className="narrow-tab-label">{defaultTabLabel(terminal)}</span>
              </button>
            )}
            <button
              className="icon-button"
              onClick={() => {
                setEditingId(terminal.terminalId);
                setDraft(terminal.label.length > 0 ? terminal.label : defaultTabLabel(terminal));
              }}
              title={t('narrow.tabs.rename')}
            >
              ✎
            </button>
            <button className="icon-button" onClick={() => onClose(terminal.terminalId)} title={t('narrow.tabs.close')}>
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MenuSheet({
  menu,
  status,
  statusLabel,
  onClose,
}: {
  menu: NarrowMenu;
  status: ConnectionStatus;
  statusLabel: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="narrow-menu">
      <div className="narrow-menu-row">
        <span className="narrow-menu-label">{t('narrow.menu.connection')}</span>
        <span className={`status status-${status}`}>{statusLabel}</span>
      </div>
      {menu.cwd !== null && (
        <div className="narrow-menu-row">
          <span className="narrow-menu-label">{t('narrow.menu.folder')}</span>
          <span className="narrow-menu-value" title={menu.cwd}>
            {menu.cwd}
          </span>
        </div>
      )}
      {menu.cliVersion !== null && (
        <div className="narrow-menu-row">
          <span className="narrow-menu-label">{t('narrow.menu.cli')}</span>
          <span className="narrow-menu-value" title={menu.cliVersion}>
            {menu.cliVersion}
          </span>
        </div>
      )}
      {menu.remoteClient && (
        <div className="narrow-menu-row">
          <span className="narrow-menu-label">{t('app.header.remoteBadge')}</span>
          <span className="narrow-menu-value narrow-menu-value-wrap">{t('app.header.remoteBadgeTitle')}</span>
        </div>
      )}
      <div className="narrow-menu-row">
        <span className="narrow-menu-label">{t('narrow.menu.theme')}</span>
        <button className="icon-button" onClick={menu.onCycleTheme} title={menu.themeTitle}>
          {menu.themeIcon}
        </button>
      </div>
      <div className="narrow-menu-row">
        <span className="narrow-menu-label">{t('narrow.menu.language')}</span>
        <LocaleMenu />
      </div>
      <div className="narrow-menu-row">
        <span className="narrow-menu-label">{t('narrow.menu.sound')}</span>
        <SoundControl sound={menu.sound} />
      </div>
      {menu.sound.notify.supported && (
        <div className="narrow-menu-row">
          <span className="narrow-menu-label">{t('narrow.menu.notifications')}</span>
          <NotifyButton notify={menu.sound.notify} />
        </div>
      )}
      {menu.remote !== null && (
        <div className="narrow-menu-row">
          <span className="narrow-menu-label">{t('app.header.remoteAccess')}</span>
          <button
            className={`icon-button${menu.remote.active ? ' icon-button-on' : ''}`}
            onClick={() => {
              onClose();
              menu.remote?.onOpen();
            }}
            title={menu.remote.title}
          >
            ⇄
          </button>
        </div>
      )}
      {insidePhoneApp(navigator.userAgent) && (
        <div className="narrow-menu-row">
          <span className="narrow-menu-label">{t('narrow.menu.phoneApp')}</span>
          <a className="link-button" href={PHONE_APP_SETTINGS_URL} onClick={onClose}>
            {t('narrow.menu.phoneAppSettings')}
          </a>
        </div>
      )}
      <div className="narrow-menu-row">
        <span className="narrow-menu-label">{t('narrow.menu.shortcuts')}</span>
        <button
          className="icon-button"
          onClick={() => {
            onClose();
            menu.onShortcuts();
          }}
          title={t('app.header.shortcuts')}
        >
          ?
        </button>
      </div>
    </div>
  );
}
