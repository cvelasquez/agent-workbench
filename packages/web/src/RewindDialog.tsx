/**
 * Volver a antes de un mensaje propio (hito 44, §4.16).
 *
 * Dos opciones si el agente cambio archivos desde ese mensaje, como pidio el
 * usuario: deshacer la conversacion y el codigo, o solo la conversacion. Sin
 * cambios, un solo boton. La app maneja el menu de rewind de la CLI por detras
 * y el mensaje vuelve al cuadro para editarlo; si algo no coincide, la CLI no
 * elige nada y el dialogo dice que hacerlo en la solapa CLI.
 *
 * `Escape` cierra sin llegar a la terminal, como los demas dialogos: si no,
 * interrumpiria a la CLI.
 */

import { useEffect } from 'react';
import type { RewindRestore } from '@agent-workbench/shared';
import { t } from './i18n/index.js';

interface RewindDialogProps {
  /** Las primeras lineas del mensaje. */
  preview: string;
  /** Los archivos que el agente cambio desde ese mensaje. */
  files: readonly string[];
  running: boolean;
  error: string | null;
  onConfirm: (restore: RewindRestore) => void;
  onClose: () => void;
}

export function RewindDialog({ preview, files, running, error, onConfirm, onClose }: RewindDialogProps): JSX.Element {
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

  const title = t('rewind.title');

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rewind-dialog" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <header className="modal-header">
          <span className="modal-title">{title}</span>
          <button className="icon-button" onClick={onClose} title={t('common.close')}>
            ×
          </button>
        </header>

        <div className="modal-body">
          {preview.length > 0 && <blockquote className="rewind-quote">{preview}</blockquote>}
          <p className="modal-hint">{t('rewind.intro')}</p>

          {files.length > 0 && (
            <>
              <h3 className="modal-section">{t('rewind.filesSection')}</h3>
              <ul className="rewind-files">
                {files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
              <p className="modal-hint">{t('rewind.filesHint')}</p>
            </>
          )}

          {error !== null && <p className="rewind-error">{error}</p>}

          <div className="rewind-actions">
            {files.length > 0 ? (
              <>
                <button className="primary-button" disabled={running} onClick={() => onConfirm('conversation-and-code')}>
                  {t('rewind.undoAll')}
                </button>
                <button className="primary-button" disabled={running} onClick={() => onConfirm('conversation')}>
                  {t('rewind.undoConversation')}
                </button>
              </>
            ) : (
              <button className="primary-button" disabled={running} onClick={() => onConfirm('conversation')}>
                {t('rewind.undo')}
              </button>
            )}
            <button className="link-button" onClick={onClose}>
              {t('common.cancel')}
            </button>
            {running && <span className="modal-hint">{t('rewind.running')}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}
