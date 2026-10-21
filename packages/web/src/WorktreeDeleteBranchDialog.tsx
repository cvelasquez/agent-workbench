/**
 * "Borrar la rama" de una rama guardada (20-10-2026, §6.38): una que creó la
 * app, cuya carpeta se quitó y que sigue en el repo, porque quedó con "Borrar
 * también la rama" desmarcado o sin integrar.
 *
 * Primero el plan, que arma el servidor sin tocar nada: el comando
 * (`git branch -d`) y en qué carpeta corre, y si algo lo impide. Una rama con
 * commits que la base no tiene no se borra desde acá: se perderían. Después la
 * confirmación, y el servidor lo rehace antes de correr el comando.
 */

import { useEffect } from 'react';
import { t } from './i18n/index.js';
import type { DeleteBranchDialog } from './useWorktrees.js';
import { deleteBranchBlockerText } from './worktree-ui.js';

interface WorktreeDeleteBranchDialogProps {
  dialog: DeleteBranchDialog;
  onConfirm: () => void;
  onClose: () => void;
}

export function WorktreeDeleteBranchDialog({ dialog, onConfirm, onClose }: WorktreeDeleteBranchDialogProps): JSX.Element {
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

  const plan = state.phase === 'ready' || state.phase === 'deleting' || state.phase === 'failed' ? state.plan : null;
  const blocker = plan === null ? null : deleteBranchBlockerText(plan);
  const busy = state.phase === 'deleting';
  const title = t('worktree.deleteBranch.title', { branch: dialog.branch });

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
          {state.phase === 'loading' && <p className="modal-hint">{t('worktree.deleteBranch.loading')}</p>}

          {state.phase === 'done' && (
            <>
              <p className="modal-hint">{t('worktree.deleteBranch.done', { branch: dialog.branch })}</p>
              <div className="worktree-actions">
                <button className="primary-button" onClick={onClose}>
                  {t('common.close')}
                </button>
              </div>
            </>
          )}

          {plan !== null && (
            <>
              {blocker !== null ? (
                <p className="worktree-problem">{blocker}</p>
              ) : (
                <>
                  <p className="modal-hint">{t('worktree.deleteBranch.intro', { base: plan.base })}</p>
                  <p className="worktree-warning">{t('worktree.remove.deleteBranchWarning')}</p>
                </>
              )}

              <h3 className="modal-section">{t('worktree.integrate.folder')}</h3>
              <p className="worktree-path">{plan.folder}</p>
              <h3 className="modal-section">{t('worktree.integrate.command')}</h3>
              <pre className="tool-pre worktree-command">{plan.command}</pre>

              {state.phase === 'failed' && <p className="worktree-problem">{state.message}</p>}

              <div className="worktree-actions">
                <button className="link-button" onClick={onClose}>
                  {t('common.cancel')}
                </button>
                <button
                  className="primary-button"
                  onClick={onConfirm}
                  disabled={busy || blocker !== null || state.phase === 'failed'}
                >
                  {busy ? t('worktree.deleteBranch.deleting') : t('worktree.deleteBranch.submit')}
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
