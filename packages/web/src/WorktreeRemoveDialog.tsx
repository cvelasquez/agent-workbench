/**
 * "Quitar la rama aparte" (hito 48, §6.38).
 *
 * Primero el plan, que arma el servidor sin tocar nada: qué pasa con la
 * carpeta y con la rama, qué notas vuelven a la carpeta principal, qué lo
 * impide y qué comandos de git se van a correr. Después la confirmación, y el
 * servidor lo rehace antes de escribir.
 *
 * **Un solo botón principal, y siempre hace algo** (21-10-2026). Antes "Quitar"
 * quedaba apagado con las salidas como enlaces al costado, y el usuario leyó
 * dos botones de quitar. Si algo frena, el botón es lo que lo destraba
 * (`removeAction`):
 *
 *  - trabajo sin commit: pedirle al agente de la rama que lo commitee (nunca
 *    `--force`). Si todo son archivos nuevos, también quitarla perdiéndolos,
 *    con un botón que lo dice y cuántos son (23-10-2026); si después frena
 *    otra cosa, el diálogo pasa a esa;
 *  - otro programa con la carpeta abierta: volver a intentar, después de
 *    cerrarlo. Desde el 23-10-2026 dice cuál, si el servidor lo supo, y
 *    también cuando quitar se frena después de cerrar las pestañas;
 *  - notas que cambiaron en los dos lados y no se pueden juntar solas:
 *    pedirle al agente que las junte, o quitarla perdiendo lo que la rama
 *    cambió en ellas, con un botón que lo dice.
 *
 * Una rama integrada se borra con la carpeta, y sus conversaciones se pueden
 * volver a abrir igual: el servidor la crea otra vez en el commit donde quedó
 * (20-10-2026).
 */

import { useEffect } from 'react';
import { formatList } from './i18n/format.js';
import { t } from './i18n/index.js';
import type { RemoveDialog } from './useWorktrees.js';
import { WorktreeNotesLine } from './WorktreeNotesLine.js';
import {
  filesAccepted,
  inUseText,
  offersDiscardFiles,
  removeAction,
  removeFateText,
  uncommittedListText,
  untrackedText,
} from './worktree-ui.js';

interface WorktreeRemoveDialogProps {
  dialog: RemoveDialog;
  onConfirm: (discardConflicts: boolean) => void;
  onDiscardFiles: () => void;
  onAskNotes: () => void;
  onAskCommit: () => void;
  onRetry: () => void;
  onClose: () => void;
}

export function WorktreeRemoveDialog({
  dialog,
  onConfirm,
  onDiscardFiles,
  onAskNotes,
  onAskCommit,
  onRetry,
  onClose,
}: WorktreeRemoveDialogProps): JSX.Element {
  const { state, acceptedFiles } = dialog;

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
  const busy = state.phase === 'removing';
  const failed = state.phase === 'failed';
  const action = plan === null || failed ? null : removeAction(plan, acceptedFiles);
  const discardFiles = plan !== null && !failed && offersDiscardFiles(plan, acceptedFiles);
  const newFiles = plan === null ? null : untrackedText(plan, acceptedFiles);
  const title = t('worktree.remove.title', { branch: dialog.branch });

  const primary = failed
    ? { label: t('worktree.remove.retry'), hint: undefined, run: onRetry }
    : action === 'ask-commit' && plan !== null
      ? {
          // Una carpeta nueva con 37 archivos es "los", no "lo". Sin huella, el recorrido se cortó y no se sabe cuántos.
          label: t('worktree.remove.askCommit', {
            count: plan.untracked?.stamp != null && plan.untracked.files > 0 ? plan.untracked.files : plan.uncommittedCount,
          }),
          hint: t('worktree.remove.askTitle'),
          run: onAskCommit,
        }
      : action === 'retry'
        ? { label: t('worktree.remove.retry'), hint: undefined, run: onRetry }
        : action === 'ask-notes'
          ? { label: t('worktree.remove.askNotes'), hint: t('worktree.remove.askTitle'), run: onAskNotes }
          : action === 'remove'
            ? { label: t('worktree.remove.submit'), hint: undefined, run: () => onConfirm(false) }
            : null;

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
              {state.outcome.returned > 0 && <p className="modal-hint">{t('worktree.notes.returned', { count: state.outcome.returned })}</p>}
              {state.outcome.discarded > 0 && (
                <p className="modal-hint">{t('worktree.remove.doneDiscarded', { count: state.outcome.discarded })}</p>
              )}
              {state.outcome.discardedFiles > 0 && (
                <p className="modal-hint">{t('worktree.remove.doneDiscardedFiles', { count: state.outcome.discardedFiles })}</p>
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
              {plan.uncommittedCount > 0 && (
                <p className={filesAccepted(plan, acceptedFiles) ? 'worktree-warning' : 'worktree-problem'}>
                  {newFiles ?? t('worktree.remove.uncommitted', { count: plan.uncommittedCount })}{' '}
                  <span className="worktree-files">{uncommittedListText(plan)}</span>
                </p>
              )}
              {plan.inUse === true && <p className="worktree-problem">{inUseText(plan)}</p>}
              {plan.conflicts.length > 0 && (
                <p className="worktree-warning">{t('worktree.remove.conflicts', { list: formatList(plan.conflicts) })}</p>
              )}

              <p className="modal-hint">{removeFateText(plan)}</p>
              <WorktreeNotesLine returning={plan.returning} merging={plan.merging} resolved={plan.resolved} />
              {plan.tabs.length > 0 && (
                <p className="modal-hint">{t('worktree.remove.tabs', { list: formatList(plan.tabs.map((tab) => tab.label)) })}</p>
              )}

              {plan.commands.length > 0 && (
                <>
                  <h3 className="modal-section">{t('worktree.remove.commands')}</h3>
                  <pre className="tool-pre worktree-command">{plan.commands.join('\n')}</pre>
                </>
              )}
            </>
          )}

          {failed && <p className="worktree-problem">{state.message}</p>}

          {state.phase !== 'loading' && state.phase !== 'done' && (
            <div className="worktree-actions">
              <button className="link-button" onClick={onClose}>
                {t('common.cancel')}
              </button>
              {discardFiles && (
                <button className="link-button" onClick={onDiscardFiles} disabled={busy}>
                  {t('worktree.remove.discardFiles')}
                </button>
              )}
              {action === 'ask-notes' && (
                <button className="link-button" onClick={() => onConfirm(true)} disabled={busy}>
                  {t('worktree.remove.discard')}
                </button>
              )}
              {primary !== null && (
                <button className="primary-button" onClick={primary.run} title={primary.hint} disabled={busy}>
                  {busy ? t('worktree.remove.removing') : primary.label}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
