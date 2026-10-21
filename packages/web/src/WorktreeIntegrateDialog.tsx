/**
 * "Integrar en <base>" (hito 49, §6.38).
 *
 * Primero el plan, que arma el servidor sin tocar nada: el comando
 * (`git merge --ff-only`, que no crea commits) y en qué carpeta corre, cuántos
 * commits y qué archivos entran, la última revisión (informa y no frena), las
 * pestañas cuyos archivos van a cambiar, lo que la rama tiene sin commit (eso
 * no entra) y, si algo lo impide, qué. Después la confirmación, y el servidor
 * lo rehace antes de correr el comando.
 *
 * Desde el 21-10-2026 las notas de la rama viajan con los commits a la carpeta
 * principal, juntas con lo que cambió allá si hace falta, y el plan dice
 * cuáles; las que no se pueden juntar se quedan en la rama hasta quitarla.
 *
 * Al terminar ofrece quitar la rama aparte: es el diálogo del hito 48, con su
 * propio plan, y ahí `branch -d` ya funciona.
 */

import { useEffect } from 'react';
import type { AgentId } from '@agent-workbench/shared';
import { formatList } from './i18n/format.js';
import { t } from './i18n/index.js';
import type { IntegrateDialog } from './useWorktrees.js';
import { WorktreeNotesLine } from './WorktreeNotesLine.js';
import { integrateBlockerText, reviewText } from './worktree-ui.js';

interface WorktreeIntegrateDialogProps {
  dialog: IntegrateDialog;
  agentLabel: (agent: AgentId) => string;
  onConfirm: () => void;
  /** Quitar la rama aparte, después de integrar. */
  onRemove: () => void;
  onClose: () => void;
}

export function WorktreeIntegrateDialog({ dialog, agentLabel, onConfirm, onRemove, onClose }: WorktreeIntegrateDialogProps): JSX.Element {
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

  const plan = state.phase === 'loading' ? null : state.plan;
  const blocker = plan === null ? null : integrateBlockerText(plan);
  const busy = state.phase === 'integrating';
  const title = plan === null ? t('worktree.integrate.titleLoading', { branch: dialog.branch }) : t('worktree.integrate.title', { branch: plan.branch, base: plan.base });

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
          {state.phase === 'loading' && <p className="modal-hint">{t('worktree.integrate.loading')}</p>}

          {state.phase === 'done' && (
            <>
              <p className="modal-hint">{t('worktree.integrate.done', { base: state.outcome.base, count: state.outcome.commits })}</p>
              {state.outcome.notes !== undefined && state.outcome.notes.returned > 0 && (
                <p className="modal-hint">{t('worktree.notes.returned', { count: state.outcome.notes.returned })}</p>
              )}
              {state.outcome.notes !== undefined && state.outcome.notes.stayed.length > 0 && (
                <p className="worktree-warning">{t('worktree.integrate.notesStayed', { list: formatList(state.outcome.notes.stayed) })}</p>
              )}
              <p className="modal-hint">{t('worktree.integrate.doneOthers', { base: state.outcome.base })}</p>
              <div className="worktree-actions">
                <button className="link-button" onClick={onClose}>
                  {t('common.close')}
                </button>
                <button className="primary-button" onClick={onRemove} title={t('worktree.integrate.removeTitle')}>
                  {t('worktree.integrate.remove')}
                </button>
              </div>
            </>
          )}

          {plan !== null && state.phase !== 'done' && (
            <>
              {blocker !== null ? (
                <p className="worktree-problem">{blocker}</p>
              ) : (
                <p className="modal-hint">{t('worktree.integrate.intro', { base: plan.base, count: plan.ahead })}</p>
              )}

              {plan.fileCount > 0 && (
                <p className="modal-hint">
                  {t('worktree.integrate.files', {
                    count: plan.fileCount,
                    list: `${formatList(plan.files)}${plan.fileCount > plan.files.length ? '…' : ''}`,
                  })}
                </p>
              )}

              {plan.notes !== null && (
                <WorktreeNotesLine returning={plan.notes.returning} merging={plan.notes.merging} resolved={plan.notes.resolved} />
              )}
              {plan.notes !== null && plan.notes.conflicts.length > 0 && (
                <p className="worktree-warning">{t('worktree.integrate.notesStay', { list: formatList(plan.notes.conflicts) })}</p>
              )}

              <p className={plan.review === null ? 'modal-hint' : plan.review.state === 'done' && plan.review.verdict === 'ready' && !plan.review.stale ? 'modal-hint' : 'worktree-warning'}>
                {plan.review === null ? t('worktree.integrate.noReview') : reviewText(plan.review, agentLabel(plan.review.agent))}
              </p>

              {plan.tabs.length > 0 && (
                <p className="modal-hint">{t('worktree.integrate.tabs', { list: formatList(plan.tabs.map((tab) => tab.label)) })}</p>
              )}
              {plan.branchUncommitted > 0 && (
                <p className="worktree-warning">{t('worktree.integrate.branchUncommitted', { count: plan.branchUncommitted })}</p>
              )}

              {plan.command !== null && plan.baseFolder !== null && (
                <>
                  <h3 className="modal-section">{t('worktree.integrate.folder')}</h3>
                  <p className="worktree-path">{plan.baseFolder}</p>
                  <h3 className="modal-section">{t('worktree.integrate.command')}</h3>
                  <pre className="tool-pre worktree-command">{plan.command}</pre>
                </>
              )}

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
                  {busy ? t('worktree.integrate.integrating') : t('worktree.integrate.submit')}
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
