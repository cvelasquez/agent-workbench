/**
 * "Quitar la rama aparte" (hito 48, §6.38).
 *
 * Primero el plan, que arma el servidor sin tocar nada: qué se cierra, qué notas
 * vuelven a la carpeta principal, qué lo impide y qué comandos de git se van a
 * correr. Después la confirmación, y el servidor lo rehace antes de escribir.
 *
 * Tres cosas lo frenan, y el diálogo dice cuál y qué hacer:
 *
 *  - trabajo sin commit: se commitea o se descarta en la terminal de la rama
 *    (nunca `--force`);
 *  - otro programa con la carpeta abierta;
 *  - notas que cambiaron en los dos lados: el usuario elige entre pedirle al
 *    agente de la rama que las pase o quitarla igual, sabiendo qué se pierde.
 */

import { useEffect } from 'react';
import { formatList } from './i18n/format.js';
import { t } from './i18n/index.js';
import type { RemoveDialog } from './useWorktrees.js';
import { removeBlocker } from './worktree-ui.js';

interface WorktreeRemoveDialogProps {
  dialog: RemoveDialog;
  onConfirm: (discardConflicts: boolean) => void;
  onAskNotes: () => void;
  onClose: () => void;
}

export function WorktreeRemoveDialog({ dialog, onConfirm, onAskNotes, onClose }: WorktreeRemoveDialogProps): JSX.Element {
  const { state } = dialog;

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

  const plan = state.phase === 'ready' || state.phase === 'removing' || state.phase === 'failed' ? state.plan : null;
  const blocker = plan === null ? null : removeBlocker(plan);
  const busy = state.phase === 'removing';
  const title = t('worktree.remove.title', { branch: dialog.branch });

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
          {state.phase === 'loading' && <p className="modal-hint">{t('worktree.remove.loading')}</p>}

          {state.phase === 'done' && (
            <>
              <p className="modal-hint">{t('worktree.remove.done')}</p>
              {state.outcome.returned > 0 && (
                <p className="modal-hint">{t('worktree.remove.doneReturned', { count: state.outcome.returned })}</p>
              )}
              {state.outcome.discarded > 0 && (
                <p className="modal-hint">{t('worktree.remove.doneDiscarded', { count: state.outcome.discarded })}</p>
              )}
              {state.outcome.branchDeleted && <p className="modal-hint">{t('worktree.remove.doneBranch')}</p>}
              <div className="worktree-actions">
                <button className="primary-button" onClick={onClose}>
                  {t('common.close')}
                </button>
              </div>
            </>
          )}

          {plan !== null && state.phase !== 'done' && (
            <>
              <p className="worktree-path">{plan.path}</p>

              {plan.uncommittedCount > 0 && (
                <p className="worktree-problem">
                  {t('worktree.remove.uncommitted', { count: plan.uncommittedCount })}{' '}
                  <span className="worktree-files">{formatList(plan.uncommitted)}</span>
                </p>
              )}
              {plan.inUse === true && <p className="worktree-problem">{t('worktree.remove.inUse')}</p>}

              {plan.tabs.length > 0 && (
                <p className="modal-hint">
                  {t('worktree.remove.tabs', { list: formatList(plan.tabs.map((tab) => tab.label)) })}
                </p>
              )}
              {plan.returning.length > 0 && (
                <p className="modal-hint">{t('worktree.remove.returning', { list: formatList(plan.returning) })}</p>
              )}
              {plan.conflicts.length > 0 && (
                <div className="worktree-warning">
                  <p>{t('worktree.remove.conflicts', { list: formatList(plan.conflicts) })}</p>
                  <div className="worktree-actions">
                    <button className="link-button" onClick={onAskNotes} title={t('worktree.remove.askNotesTitle')} disabled={busy}>
                      {t('worktree.remove.askNotes')}
                    </button>
                    <button
                      className="link-button"
                      onClick={() => onConfirm(true)}
                      title={t('worktree.remove.discardTitle')}
                      disabled={busy || plan.uncommittedCount > 0 || plan.inUse === true}
                    >
                      {t('worktree.remove.discard')}
                    </button>
                  </div>
                </div>
              )}

              <p className="modal-hint">
                {plan.deletesBranch
                  ? plan.branchUnused
                    ? t('worktree.remove.deletesUnusedBranch', { branch: plan.branch })
                    : t('worktree.remove.deletesBranch', { branch: plan.branch })
                  : t('worktree.remove.keepsBranch', { branch: plan.branch })}
              </p>

              {plan.commands.length > 0 && (
                <>
                  <h3 className="modal-section">{t('worktree.remove.commands')}</h3>
                  <pre className="tool-pre worktree-command">{plan.commands.join('\n')}</pre>
                </>
              )}

              {state.phase === 'failed' && <p className="worktree-problem">{state.message}</p>}

              <div className="worktree-actions">
                <button className="link-button" onClick={onClose}>
                  {t('common.cancel')}
                </button>
                <button
                  className="primary-button"
                  onClick={() => onConfirm(false)}
                  disabled={busy || blocker !== null || state.phase === 'failed'}
                >
                  {busy ? t('worktree.remove.removing') : t('worktree.remove.submit')}
                </button>
              </div>
            </>
          )}

          {state.phase === 'failed' && plan === null && <p className="worktree-problem">{state.message}</p>}
        </div>
      </div>
    </div>
  );
}
