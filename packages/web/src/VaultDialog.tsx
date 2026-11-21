/**
 * El dialogo de la copia propia (hito 28).
 *
 * Es la unica interfaz de la copia, junto con el boton de la cabecera de la
 * barra y el de exportar un proyecto: se abre, se mira y se cierra. Cinco
 * cosas, en el orden en que se deciden:
 *
 *  1. **Que guarda y adonde puede viajar.** Antes de cualquier boton, porque
 *     guarda resultados de comandos y rutas con el usuario del sistema.
 *  2. **Encender o apagar**, con un clic. Hasta el 21-11-2026 habia que medir
 *     antes cuanto ocuparia (D6); lo saco el usuario. Apagarla no borra nada,
 *     y lo dice. Una carpeta que ya tenia un respaldo se enciende sola al
 *     elegirla (`adopted`), y el dialogo lo dice en vez de ofrecer "Activar".
 *  3. **Donde.** La carpeta se muestra; cambiarla abre el selector del
 *     servidor, que es quien la lee (CLAUDE.md 2.4). La vieja queda intacta.
 *  4. **Que fallo**, si algo fallo.
 *
 * Todo lo que muestra sale de `vault.status`: el boton no se da por apretado
 * hasta que el servidor dice que cambio. `Escape` cierra sin llegar a la
 * terminal, como los otros dialogos; con el selector de carpetas encima, es de
 * el.
 */

import { useEffect } from 'react';
import type { VaultStatus } from '@agent-workbench/shared';
import {
  vaultActivateOffer,
  vaultArchivedText,
  vaultChangeDirBlockedReason,
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
  problem: string | null;
  /** Hay otro dialogo encima (el selector de carpetas): `Escape` es suyo. */
  covered: boolean;
  onSetEnabled: (enabled: boolean) => void;
  onChangeDir: () => void;
  /** null en una ventana remota (hito 37): la carpeta se abriria en el escritorio del anfitrion. */
  onReveal: (() => void) | null;
  onDismissProblem: () => void;
  onClose: () => void;
}

export function VaultDialog({
  status,
  problem,
  covered,
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
  onSetEnabled: (enabled: boolean) => void;
  onChangeDir: () => void;
  /** null en una ventana remota (hito 37): la carpeta se abriria en el escritorio del anfitrion. */
  onReveal: (() => void) | null;
}

function VaultDialogBody({
  status,
  onSetEnabled,
  onChangeDir,
  onReveal,
}: VaultDialogBodyProps): JSX.Element {
  const changeDirBlocked = vaultChangeDirBlockedReason(status);
  const offer = vaultActivateOffer(status);
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
          {status.adopted === true && <p className="modal-hint">{t('vault.dialog.adopted')}</p>}
        </>
      )}

      {progress !== null && progress.total > 0 && (
        <progress className="vault-progress" value={progress.done} max={progress.total} />
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
        {offer === 'off' && (
          <>
            <button className="primary-button" onClick={() => onSetEnabled(true)}>
              {t('vault.dialog.activate')}
            </button>
            <span className="modal-hint">{t('vault.dialog.activateHint')}</span>
          </>
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
