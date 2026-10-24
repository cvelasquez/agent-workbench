/**
 * Cerrar una pestana que tiene algo programado (hito 51, §6.39).
 *
 * Cerrar la pestana cancela lo programado de su conversacion, como tira su
 * borrador (§6.29), y eso no se ve hasta la hora en que no llega nada: por eso
 * la × pregunta antes, solo en este caso. Sin `confirm()` del navegador, que
 * bloquea la pagina entera (§6.6). `Escape` no cierra la pestana: cierra el
 * dialogo.
 */

import { useEffect } from 'react';
import { t } from './i18n/index.js';

interface CloseTabDialogProps {
  /** Lo que se cancela, ya armado (`scheduledCloseWarning`). */
  warning: string;
  onConfirm: () => void;
  onClose: () => void;
}

export function CloseTabDialog({ warning, onConfirm, onClose }: CloseTabDialogProps): JSX.Element {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const title = t('scheduled.close.title');
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal worktree-dialog" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </header>
        <div className="modal-body">
          <p className="modal-hint">{warning}</p>
          <div className="worktree-actions">
            <button className="link-button" onClick={onClose} autoFocus>
              {t('scheduled.close.keep')}
            </button>
            <button className="primary-button" onClick={onConfirm}>
              {t('scheduled.close.confirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
