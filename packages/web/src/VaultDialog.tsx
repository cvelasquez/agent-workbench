/**
 * El dialogo de la copia propia (hito 28).
 *
 * Es la unica interfaz de la copia, junto con el boton de la cabecera de la
 * barra y el de exportar un proyecto: se abre, se mira y se cierra. Cinco
 * cosas, en el orden en que se deciden:
 *
 *  1. **Que guarda y adonde puede viajar.** Antes de cualquier boton, porque
 *     guarda resultados de comandos y rutas con el usuario del sistema.
 *  2. **Cuanto ocuparia**, por CLI. Es la pasada en seco: no escribe nada, ni
 *     la carpeta. "Activar" no aparece hasta que hay una medicion en este
 *     arranque del servidor (D6), salvo que la carpeta ya tenga sesiones que
 *     copio una pasada (C18): lo importado no cuenta.
 *  3. **Encender o apagar.** Apagarla no borra nada, y lo dice.
 *  4. **Donde.** La carpeta se muestra; cambiarla abre el selector del
 *     servidor, que es quien la lee (CLAUDE.md 2.4). La vieja queda intacta.
 *  5. **Que fallo**, si algo fallo.
 *
 * Todo lo que muestra sale de `vault.status`: el boton no se da por apretado
 * hasta que el servidor dice que cambio. `Escape` cierra sin llegar a la
 * terminal, como los otros dialogos; con el selector de carpetas encima, es de
 * el.
 */

import { useEffect } from 'react';
import type { AgentInfo, VaultStatus } from '@agent-workbench/shared';
import {
  vaultActivateOffer,
  vaultArchivedText,
  vaultChangeDirBlockedReason,
  vaultMeasureBlockedReason,
  vaultMeasureView,
  vaultName,
  vaultPreviousDirText,
  vaultPrivacyText,
  vaultSessionsText,
  vaultStateText,
} from './vault-ui.js';
import { formatBytes, formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';

interface VaultDialogProps {
  status: VaultStatus | null;
  /** Para los nombres de las CLIs en la tabla. */
  agents: readonly AgentInfo[];
  /** El indice termino de leer el historial: antes, medir daria de menos. */
  indexReady: boolean;
  problem: string | null;
  /** Hay otro dialogo encima (el selector de carpetas): `Escape` es suyo. */
  covered: boolean;
  onMeasure: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onChangeDir: () => void;
  /** null en una ventana remota (hito 37): la carpeta se abriria en el escritorio del anfitrion. */
  onReveal: (() => void) | null;
  onDismissProblem: () => void;
  onClose: () => void;
}

export function VaultDialog({
  status,
  agents,
  indexReady,
  problem,
  covered,
  onMeasure,
  onSetEnabled,
  onChangeDir,
  onReveal,
  onDismissProblem,
  onClose,
}: VaultDialogProps): JSX.Element {
  useEffect(() => {
    if (covered) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [covered, onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal vault-modal"
        role="dialog"
        aria-label={vaultName()}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">{vaultName()}</span>
          {status !== null && (
            <span className={`vault-state${status.enabled ? ' vault-state-on' : ''}`}>
              {vaultStateText(status)}
            </span>
          )}
          <button className="icon-button" onClick={onClose} title={t('common.closeEsc')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          <p className="vault-lead">{vaultPrivacyText()}</p>
          <p className="modal-hint">{vaultArchivedText()}</p>

          {status === null ? (
            <p className="modal-hint">{t('vault.dialog.waiting')}</p>
          ) : (
            <VaultDialogBody
              status={status}
              agents={agents}
              indexReady={indexReady}
              onMeasure={onMeasure}
              onSetEnabled={onSetEnabled}
              onChangeDir={onChangeDir}
              onReveal={onReveal}
            />
          )}

          {problem !== null && (
            <div className="vault-problem" role="alert">
              <span>{problem}</span>
              <button className="icon-button" onClick={onDismissProblem} title={t('common.dismissNotice')}>
                ×
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface VaultDialogBodyProps {
  status: VaultStatus;
  agents: readonly AgentInfo[];
  indexReady: boolean;
  onMeasure: () => void;
  onSetEnabled: (enabled: boolean) => void;
  onChangeDir: () => void;
  /** null en una ventana remota (hito 37): la carpeta se abriria en el escritorio del anfitrion. */
  onReveal: (() => void) | null;
}

function VaultDialogBody({
  status,
  agents,
  indexReady,
  onMeasure,
  onSetEnabled,
  onChangeDir,
  onReveal,
}: VaultDialogBodyProps): JSX.Element {
  const measureBlocked = vaultMeasureBlockedReason(status, indexReady);
  const changeDirBlocked = vaultChangeDirBlockedReason(status);
  const offer = vaultActivateOffer(status);
  const view = status.measurement === null ? null : vaultMeasureView(status.measurement, agents);
  const progress = status.progress;

  return (
    <>
      {status.enabled && (
        <>
          <h3 className="modal-section">{t('vault.dialog.inFolder')}</h3>
          <p className="vault-summary">
            {vaultSessionsText(status.sessions)} · {formatBytes(status.bytes)}
            {status.lastPassAt !== null && <> · {t('vault.dialog.lastPass', { when: formatWhen(status.lastPassAt) })}</>}
            {status.pending > 0 && <> · {t('vault.dialog.pendingCalm', { count: status.pending })}</>}
          </p>
        </>
      )}

      {progress !== null && progress.total > 0 && (
        <progress className="vault-progress" value={progress.done} max={progress.total} />
      )}

      <h3 className="modal-section">{t('vault.dialog.sizeSection')}</h3>
      <div className="vault-actions">
        <button
          className="link-button vault-measure"
          onClick={onMeasure}
          disabled={measureBlocked !== null}
          title={measureBlocked ?? t('vault.dialog.measureTitle')}
        >
          {status.state === 'measuring'
            ? t('vault.state.measuring')
            : view === null
              ? t('vault.dialog.measure')
              : t('vault.dialog.measureAgain')}
        </button>
        {view !== null && <span className="modal-hint">{view.summary}</span>}
      </div>

      {view !== null && (
        <div className="vault-table-wrap">
          <table className="vault-table">
            <thead>
              <tr>
                <th>CLI</th>
                <th>{t('vault.dialog.table.sessions')}</th>
                <th>{t('vault.dialog.table.size')}</th>
                <th>{t('vault.dialog.table.images')}</th>
                <th title={t('vault.dialog.table.archivedTitle')}>{t('vault.dialog.table.archived')}</th>
              </tr>
            </thead>
            <tbody>
              {view.rows.map((row) => (
                <tr key={row.agent}>
                  <td>
                    {row.label}
                    {row.note !== null && <span className="vault-table-note">{row.note}</span>}
                  </td>
                  <td>{row.sessions}</td>
                  <td>{formatBytes(row.bytes)}</td>
                  <td title={row.images > 0 ? formatBytes(row.imageBytes) : undefined}>{row.images}</td>
                  <td>{row.skippedArchived}</td>
                </tr>
              ))}
              <tr>
                <td>{t('vault.dialog.table.memory', { count: view.memoryProjects })}</td>
                <td />
                <td>{formatBytes(view.memoryBytes)}</td>
                <td />
                <td />
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td>{t('vault.dialog.table.total')}</td>
                <td>{view.total.sessions}</td>
                <td>{formatBytes(view.total.bytes)}</td>
                <td>{view.total.images}</td>
                <td>{view.total.skippedArchived}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="vault-actions vault-switch">
        {offer === 'enabled' && (
          <>
            <button className="link-button" onClick={() => onSetEnabled(false)}>
              {t('vault.dialog.turnOff')}
            </button>
            <span className="modal-hint">{t('vault.dialog.turnOffHint')}</span>
          </>
        )}
        {(offer === 'measured' || offer === 'existing') && (
          <>
            <button
              className="primary-button"
              onClick={() => onSetEnabled(true)}
              title={
                offer === 'existing'
                  ? t('vault.dialog.activateExistingTitle')
                  : t('vault.dialog.activateMeasuredTitle')
              }
            >
              {t('vault.dialog.activate')}
            </button>
            <span className="modal-hint">
              {offer === 'existing'
                ? t('vault.dialog.activateExistingHint')
                : t('vault.dialog.activateMeasuredHint')}
            </span>
          </>
        )}
        {offer === 'needs-measure' && (
          <span className="modal-hint">
            {t('vault.dialog.needsMeasure', { activate: t('vault.dialog.activate') })}
          </span>
        )}
      </div>

      <h3 className="modal-section">{t('vault.dialog.folderSection')}</h3>
      <p className="vault-dir" title={status.dir}>
        {status.dir}
      </p>
      {status.isDefaultDir && <p className="modal-hint">{t('vault.dialog.defaultDir')}</p>}
      <div className="vault-actions">
        <button
          className="link-button"
          onClick={onChangeDir}
          disabled={changeDirBlocked !== null}
          title={changeDirBlocked ?? t('vault.dialog.changeDirTitle')}
        >
          {t('vault.dialog.changeDir')}
        </button>
        {onReveal !== null && (
          <button className="link-button" onClick={onReveal} title={t('vault.dialog.openFolderTitle')}>
            {t('vault.dialog.openFolder')}
          </button>
        )}
      </div>
      {status.previousDir !== null && <p className="modal-hint">{vaultPreviousDirText(status.previousDir)}</p>}

      {status.lastError !== null && (
        <>
          <h3 className="modal-section">{t('vault.dialog.lastError')}</h3>
          <p className="vault-error">{serverTextMessage(status.lastError)}</p>
        </>
      )}
    </>
  );
}
