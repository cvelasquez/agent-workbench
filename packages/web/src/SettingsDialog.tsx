/**
 * La ventana de Ajustes (Hito 41, §6.32), que se abre con la tuerca de la
 * cabecera.
 *
 * Pedido del usuario: un solo lugar para quitar lo que no usa —paneles, CLIs— y
 * elegir la consola. Junta tambien lo que estaba suelto en la cabecera: el
 * idioma sale de ahi y vive solo aca; el tema de la app se queda arriba, a un
 * clic, como pidio. El sonido y la campana tambien se quedan arriba, y solo ahi:
 * en este dialogo el control de volumen no entraba y se veia cortado (lo vio el
 * usuario al probar el Hito 41).
 *
 * Dos clases de ajuste, y la ventana no las mezcla:
 *
 *  - **De esta ventana** (el idioma, el tema de la terminal, los paneles): se
 *    guardan con las preferencias de la ventana (§6.26) y valen enseguida.
 *  - **Del servidor** (la consola y las CLIs): van a `settings.json`. Una ventana
 *    remota los ve pero no los cambia, y con un servidor anterior no aparecen.
 *    Las CLIs valen al reiniciar, y la ventana lo dice mientras falte.
 *
 * `Escape` cierra sin llegar a la terminal, como los demas dialogos.
 */

import { useEffect, useState } from 'react';
import type { AgentId, AgentInfo, ConsoleShellId } from '@agent-workbench/shared';
import { t, type MessageKey } from './i18n/index.js';
import { LocaleMenu } from './LocaleMenu.js';
import { HIDEABLE_PANELS, type HideablePanel, type PanelVisibility } from './panel-visibility.js';
import type { AppSettingsApi } from './useAppSettings.js';
import type { TerminalThemePreference, TerminalThemeState } from './useTerminalTheme.js';
import { vaultName } from './vault-ui.js';

/** Como se llama cada panel en la lista: el mismo nombre que tiene en la pantalla. */
const PANEL_NAMES: Readonly<Record<HideablePanel, MessageKey>> = {
  git: 'panel.tab.git',
  files: 'panel.tab.files',
  plans: 'panel.tab.plans',
  memory: 'panel.tab.memory',
  console: 'console.name',
  notes: 'notes.name',
};

const TERMINAL_THEME_NAMES: Readonly<Record<TerminalThemePreference, MessageKey>> = {
  dark: 'settings.terminalTheme.dark',
  follow: 'settings.terminalTheme.follow',
};

/** El conjunto de CLIs apagadas sin una, o con una. */
function toggled(list: readonly AgentId[], agent: AgentId, off: boolean): AgentId[] {
  const rest = list.filter((id) => id !== agent);
  return off ? [...rest, agent] : rest;
}

function sameSet(a: readonly AgentId[], b: readonly AgentId[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

interface SettingsDialogProps {
  onClose: () => void;
  terminalTheme: TerminalThemeState;
  panels: PanelVisibility;
  /** Cuantas consolas hay abiertas: esconder la consola las cierra, y antes se pregunta. */
  consoleCount: number;
  /** Cierra las consolas y esconde la seccion. */
  onHideConsole: () => void;
  appSettings: AppSettingsApi;
  agents: readonly AgentInfo[];
  /** Una ventana que entro como equipo remoto: lo del servidor se ve, no se cambia. */
  remoteClient: boolean;
  /** null si la copia propia no se ofrece aca. */
  onOpenVault: (() => void) | null;
  /** null en una ventana remota, o con un servidor anterior al Hito 37. */
  onOpenRemote: (() => void) | null;
}

export function SettingsDialog({
  onClose,
  terminalTheme,
  panels,
  consoleCount,
  onHideConsole,
  appSettings,
  agents,
  remoteClient,
  onOpenVault,
  onOpenRemote,
}: SettingsDialogProps): JSX.Element {
  const [confirmingConsole, setConfirmingConsole] = useState(false);
  const status = appSettings.status;
  const serverEditable = status !== null && !remoteClient;
  /*
    Lo elegido mientras el servidor contesta. Sin esto la casilla volvia atras
    un instante: dice lo que dice el servidor, y el servidor todavia no se
    entero. Llega el estado nuevo —o un error— y manda otra vez el servidor.
  */
  const [pendingShell, setPendingShell] = useState<ConsoleShellId | null>(null);
  const [pendingDisabled, setPendingDisabled] = useState<AgentId[] | null>(null);
  useEffect(() => {
    setPendingShell(null);
    setPendingDisabled(null);
  }, [status, appSettings.problem]);
  const shownShell = pendingShell ?? status?.consoleShell ?? 'auto';
  const shownDisabled = pendingDisabled ?? status?.disabledAgents ?? [];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const togglePanel = (panel: HideablePanel, visible: boolean): void => {
    if (panel === 'console' && !visible && consoleCount > 0) {
      setConfirmingConsole(true);
      return;
    }
    panels.setVisible(panel, visible);
  };

  const autoShell = status?.consoleShells.find((shell) => shell.id !== 'git-bash' && shell.id !== 'zsh') ?? null;
  const restartPending = status !== null && !sameSet(status.disabledAgents, status.disabledAtStart);

  const shellChoices: { id: ConsoleShellId; label: string }[] =
    status === null
      ? []
      : [
          {
            id: 'auto',
            label: autoShell === null ? t('settings.console.auto') : t('settings.console.autoWith', { shell: autoShell.label }),
          },
          ...status.consoleShells,
        ];

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal settings-dialog"
        role="dialog"
        aria-label={t('settings.title')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">{t('settings.title')}</span>
          <button className="icon-button" onClick={onClose} title={t('common.closeEsc')}>
            ×
          </button>
        </header>

        <div className="modal-body settings-body">
          <h3 className="modal-section">{t('settings.section.appearance')}</h3>
          <div className="settings-row">
            <span className="settings-label">{t('settings.language')}</span>
            <LocaleMenu />
          </div>
          <div className="settings-row settings-row-top">
            <span className="settings-label">{t('settings.terminalTheme')}</span>
            <div className="settings-choices" role="radiogroup" aria-label={t('settings.terminalTheme')}>
              {(['dark', 'follow'] as const).map((preference) => (
                <label key={preference} className="settings-choice">
                  <input
                    type="radio"
                    name="terminal-theme"
                    checked={terminalTheme.preference === preference}
                    onChange={() => terminalTheme.setPreference(preference)}
                  />
                  {t(TERMINAL_THEME_NAMES[preference])}
                </label>
              ))}
              <p className="modal-hint">{t('settings.terminalTheme.hint')}</p>
            </div>
          </div>

          <h3 className="modal-section">{t('settings.section.panels')}</h3>
          <div className="settings-panels">
            {HIDEABLE_PANELS.map((panel) => (
              <label key={panel} className="settings-choice">
                <input
                  type="checkbox"
                  checked={panels.isVisible(panel)}
                  onChange={(event) => togglePanel(panel, event.target.checked)}
                />
                {t(PANEL_NAMES[panel])}
              </label>
            ))}
          </div>
          {confirmingConsole && (
            <div className="settings-confirm" role="alert">
              <span>{t('settings.panels.consoleConfirm', { count: consoleCount })}</span>
              <button
                className="link-button"
                onClick={() => {
                  setConfirmingConsole(false);
                  onHideConsole();
                }}
              >
                {t('settings.panels.consoleConfirmYes')}
              </button>
              <button className="link-button" onClick={() => setConfirmingConsole(false)}>
                {t('common.cancel')}
              </button>
            </div>
          )}
          <p className="modal-hint">{t('settings.panels.cliAlways')}</p>

          {status === null ? (
            <p className="modal-hint">{t('settings.oldServer')}</p>
          ) : (
            <>
              <h3 className="modal-section">{t('settings.section.console')}</h3>
              {status.consoleShells.length === 0 ? (
                <p className="modal-hint">{t('console.noShell')}</p>
              ) : (
                <div className="settings-choices" role="radiogroup" aria-label={t('settings.section.console')}>
                  {shellChoices.map((choice) => (
                    <label key={choice.id} className="settings-choice">
                      <input
                        type="radio"
                        name="console-shell"
                        checked={shownShell === choice.id}
                        disabled={!serverEditable}
                        onChange={() => {
                          setPendingShell(choice.id);
                          appSettings.setConsoleShell(choice.id);
                        }}
                      />
                      {choice.label}
                    </label>
                  ))}
                  <p className="modal-hint">{t('settings.console.hint')}</p>
                </div>
              )}

              <h3 className="modal-section">{t('settings.section.clis')}</h3>
              <ul className="settings-clis">
                {agents.map((agent) => {
                  const off = shownDisabled.includes(agent.id);
                  const offAtStart = status.disabledAtStart.includes(agent.id);
                  const installed = agent.available || offAtStart;
                  return (
                    <li key={agent.id} className="settings-cli">
                      {installed ? (
                        <label className="settings-choice">
                          <input
                            type="checkbox"
                            checked={!off}
                            disabled={!serverEditable}
                            onChange={(event) => {
                              const next = toggled(shownDisabled, agent.id, !event.target.checked);
                              setPendingDisabled(next);
                              appSettings.setDisabledAgents(next);
                            }}
                          />
                          <span className="settings-cli-name">{agent.label}</span>
                        </label>
                      ) : (
                        <span className="settings-cli-name settings-cli-missing">{agent.label}</span>
                      )}
                      <span className="settings-cli-detail">
                        {agent.available
                          ? (agent.version ?? '')
                          : offAtStart
                            ? t('settings.cli.disabled')
                            : t('settings.cli.notInstalled')}
                      </span>
                      {!installed && (
                        <a className="link-button" href={agent.installUrl} target="_blank" rel="noreferrer noopener">
                          {t('settings.cli.install')}
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="modal-hint">{t('settings.cli.hint')}</p>
              {restartPending && <p className="settings-restart">{t('settings.cli.restart')}</p>}
              {remoteClient && <p className="modal-hint">{t('settings.hostOnly')}</p>}
              {appSettings.problem !== null && (
                <p className="settings-problem" role="alert">
                  {appSettings.problem}
                  <button className="link-button" onClick={appSettings.dismissProblem}>
                    {t('common.close')}
                  </button>
                </p>
              )}
            </>
          )}

          {(onOpenVault !== null || onOpenRemote !== null) && (
            <>
              <h3 className="modal-section">{t('settings.section.more')}</h3>
              {/*
                Con el formato de botones del resto de la app —el de "Abrir con la
                app del sistema"—, no como enlaces (pedido del usuario el
                05-10-2026).
              */}
              <div className="settings-row settings-more">
                {onOpenVault !== null && (
                  <button className="primary-button primary-button-small" onClick={onOpenVault}>
                    {t('settings.more.open', { name: vaultName() })}
                  </button>
                )}
                {onOpenRemote !== null && (
                  <button className="primary-button primary-button-small" onClick={onOpenRemote}>
                    {t('settings.more.open', { name: t('app.header.remoteAccess') })}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
