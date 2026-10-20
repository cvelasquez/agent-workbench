/**
 * "Pedir revisión" de una rama aparte (hito 49, §6.38).
 *
 * Otra CLI revisa lo que trae la rama, en la carpeta de la rama, y contesta con
 * un veredicto. Antes de abrir nada el diálogo dice quién revisa (por defecto
 * otra CLI que la que trabajó en la rama, decisión 4), cómo arranca (en sólo
 * lectura si su CLI tiene cómo; si no, lo dice), si el pedido se manda solo o
 * queda en su cuadro, y el pedido entero, en inglés (§6.23), como lo arma el
 * servidor.
 *
 * `Escape` cierra sin llegar a la terminal, como los demás diálogos.
 */

import { useEffect, useMemo, useState } from 'react';
import { defaultReviewer, type AgentId, type AgentInfo } from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import type { ReviewDialog } from './useWorktrees.js';
import { reviewCandidates, reviewGuardText } from './worktree-ui.js';

interface WorktreeReviewDialogProps {
  dialog: ReviewDialog;
  /** Las CLIs del servidor, instaladas o no: las instaladas se pueden elegir. */
  agents: readonly AgentInfo[];
  onSubmit: (agent: AgentId) => void;
  onClose: () => void;
}

export function WorktreeReviewDialog({ dialog, agents, onSubmit, onClose }: WorktreeReviewDialogProps): JSX.Element {
  const { state } = dialog;
  const plan = state.phase === 'loading' ? null : state.plan;
  const candidates = useMemo(() => reviewCandidates(agents), [agents]);
  const suggested = plan === null ? null : defaultReviewer(plan.author, candidates);
  const [chosen, setChosen] = useState<AgentId | null>(null);
  const reviewer = chosen ?? suggested;
  const info = agents.find((entry) => entry.id === reviewer) ?? null;
  const labelOf = (agent: AgentId): string => agents.find((entry) => entry.id === agent)?.label ?? agent;

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

  const busy = state.phase === 'requesting';
  const nothing = plan !== null && plan.ahead === 0 && plan.uncommitted === 0;
  const canSubmit = plan !== null && info !== null && !busy && !nothing;
  const title = t('worktree.review.title', { branch: dialog.branch });

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
          {state.phase === 'loading' && <p className="modal-hint">{t('worktree.review.loading')}</p>}

          {plan !== null && (
            <>
              <p className="modal-hint">{t('worktree.review.intro', { base: plan.base })}</p>

              {nothing ? (
                <p className="worktree-problem">{t('worktree.review.nothing', { base: plan.base })}</p>
              ) : (
                <>
                  {candidates.length > 1 ? (
                    <label className="worktree-field">
                      <span className="worktree-label">{t('worktree.review.reviewer')}</span>
                      <select
                        className="worktree-input"
                        value={reviewer ?? ''}
                        onChange={(event) => setChosen(candidates.find((entry) => entry.id === event.target.value)?.id ?? null)}
                        disabled={busy}
                      >
                        {candidates.map((entry) => (
                          <option key={entry.id} value={entry.id}>
                            {labelOf(entry.id)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    info !== null && <p className="modal-hint">{t('worktree.review.sameCli', { agent: info.label })}</p>
                  )}
                  {plan.author !== null && candidates.length > 1 && (
                    <p className="modal-hint">{t('worktree.review.author', { agent: labelOf(plan.author) })}</p>
                  )}

                  {info !== null && (
                    <>
                      <p className={info.capabilities.readOnlyLaunch?.guard === 'cli' ? 'modal-hint' : 'worktree-warning'}>
                        {reviewGuardText(info.capabilities, info.label)}
                      </p>
                      <p className="modal-hint">
                        {info.capabilities.readySignal ? t('worktree.review.deliverySent') : t('worktree.review.deliveryPrefill')}
                      </p>
                    </>
                  )}
                  {plan.branchBusy && <p className="worktree-warning">{t('worktree.review.branchBusy')}</p>}
                  {plan.uncommitted > 0 && (
                    <p className="modal-hint">{t('worktree.review.uncommitted', { count: plan.uncommitted })}</p>
                  )}
                  <p className="modal-hint">{t('worktree.review.quota')}</p>

                  <h3 className="modal-section">{t('worktree.review.prompt')}</h3>
                  <pre className="tool-pre worktree-command worktree-prompt">{plan.prompt}</pre>
                </>
              )}

              {state.phase === 'failed' && <p className="worktree-problem">{state.message}</p>}

              <div className="worktree-actions">
                <button className="link-button" onClick={onClose}>
                  {t('common.cancel')}
                </button>
                <button
                  className="primary-button"
                  disabled={!canSubmit}
                  onClick={() => {
                    if (canSubmit && reviewer !== null) onSubmit(reviewer);
                  }}
                >
                  {busy ? t('worktree.review.requesting') : t('worktree.review.submit')}
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
