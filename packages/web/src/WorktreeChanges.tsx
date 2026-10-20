/**
 * "Ver cambios" de una rama aparte (hito 49, §6.38): lo que trae contra su
 * base, de sólo lectura. Reemplaza la lista de Cambios, como el diff de un
 * archivo: el panel es angosto y las dos cosas no conviven.
 *
 * Sus commits (hasta 50) y sus archivos, cada uno con su diff en el `DiffView`
 * de siempre y con los mismos topes. Lo que la rama tiene sin commit no entra
 * (está en la Cambios de su pestaña), y la vista lo dice si hay.
 */

import { DiffView } from './DiffView.js';
import { KIND_BADGE, KIND_TITLE, splitPath } from './git-kinds.js';
import { formatDate, formatTime, formatWhen } from './i18n/format.js';
import { t } from './i18n/index.js';
import type { ChangesView } from './useWorktrees.js';

interface WorktreeChangesProps {
  view: ChangesView;
  onBack: () => void;
  onOpenDiff: (path: string) => void;
  onCloseDiff: () => void;
  /** "Pedir revisión" desde acá, o null si la rama no se puede revisar desde la app. */
  onRequestReview: (() => void) | null;
}

export function WorktreeChanges({ view, onBack, onOpenDiff, onCloseDiff, onRequestReview }: WorktreeChangesProps): JSX.Element {
  const { state } = view;

  if (view.diff !== null) {
    const open = view.diff;
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={onCloseDiff}>
            ← {view.branch}
          </button>
          <span className="panel-subhead-title" title={open.path}>
            {splitPath(open.path).name}
          </span>
        </div>
        {open.message !== null ? (
          <p className="panel-note">{open.message}</p>
        ) : open.diff === null ? (
          <p className="panel-note">{t('git.readingDiff')}</p>
        ) : (
          <DiffView diff={open.diff} />
        )}
      </div>
    );
  }

  const changes = state.phase === 'ready' ? state.changes : null;
  return (
    <div className="panel-body">
      <div className="panel-subhead">
        <button className="link-button" onClick={onBack}>
          ← {t('git.backToChanges')}
        </button>
        <span className="panel-subhead-title" title={changes === null ? view.branch : t('worktree.changes.title', { branch: changes.branch, base: changes.base })}>
          {changes === null ? view.branch : t('worktree.changes.title', { branch: changes.branch, base: changes.base })}
        </span>
        {onRequestReview !== null && changes !== null && changes.commitCount > 0 && (
          <button className="link-button" onClick={onRequestReview} title={t('worktree.actions.reviewTitle')}>
            {t('worktree.actions.review')}
          </button>
        )}
      </div>

      <div className="panel-scroll">
        {state.phase === 'loading' && <p className="panel-note">{t('worktree.changes.loading')}</p>}
        {state.phase === 'failed' && <p className="panel-note">{state.message}</p>}

        {changes !== null && (
          <>
            {changes.uncommitted > 0 && (
              <p className="panel-note">{t('worktree.changes.uncommitted', { count: changes.uncommitted })}</p>
            )}
            {changes.commitCount === 0 && changes.files.length === 0 && (
              <p className="panel-note">{t('worktree.changes.empty', { base: changes.base })}</p>
            )}

            {changes.commits.length > 0 && (
              <section className="git-group">
                <h3 className="git-group-title">
                  {t('worktree.changes.commits')}
                  <span className="git-group-count">{changes.commitCount}</span>
                </h3>
                <ul className="git-list worktree-commits">
                  {changes.commits.map((commit) => (
                    <li key={commit.sha} className="worktree-commit" title={`${formatDate(commit.at)} ${formatTime(commit.at)}`}>
                      <span className="worktree-commit-sha">{commit.sha}</span>
                      <span className="worktree-commit-subject">{commit.subject}</span>
                      <span className="worktree-commit-when">{formatWhen(commit.at)}</span>
                    </li>
                  ))}
                </ul>
                {changes.commitCount > changes.commits.length && (
                  <p className="panel-note">{t('worktree.changes.more', { count: changes.commitCount - changes.commits.length })}</p>
                )}
              </section>
            )}

            {changes.files.length > 0 && (
              <section className="git-group">
                <h3 className="git-group-title">
                  {t('worktree.changes.files')}
                  <span className="git-group-count">{changes.fileCount}</span>
                </h3>
                <ul className="git-list">
                  {changes.files.map((file) => {
                    const { dir, name } = splitPath(file.path);
                    return (
                      <li key={file.path}>
                        <button
                          className="git-item"
                          onClick={() => onOpenDiff(file.path)}
                          title={file.oldPath !== null ? `${file.oldPath} → ${file.path}` : file.path}
                        >
                          <span className={`git-badge git-badge-${file.kind}`} title={t(KIND_TITLE[file.kind])}>
                            {KIND_BADGE[file.kind]}
                          </span>
                          <span className="git-path">
                            <span className="git-path-name">{name}</span>
                            {dir.length > 0 && <span className="git-path-dir">{dir}</span>}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {changes.fileCount > changes.files.length && (
                  <p className="panel-note">{t('worktree.changes.more', { count: changes.fileCount - changes.files.length })}</p>
                )}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
