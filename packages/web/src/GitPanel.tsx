/**
 * Panel de cambios: rama, adelanto/atraso, worktrees y archivos tocados.
 *
 * **Solo lectura, y eso se ve en que no hay ni un boton que escriba.** No hay
 * stage, ni commit, ni descartar. La razon no es falta de tiempo: en esta app
 * hay un agente editando archivos, y un boton que hace `git commit` produce
 * historia que despues nadie sabe quien disparo. Lo que cambia el repo se
 * escribe en la terminal, donde el comando se ve antes de ejecutarse.
 *
 * El panel es angosto, asi que la lista y el diff no conviven: se hace clic en
 * un archivo y el diff **reemplaza** la lista, con una vuelta atras. Partir 460
 * px en dos deja las dos mitades inservibles.
 *
 * Desde el hito 48 tiene lo unico que escribe en git, y no son commits: abrir
 * una rama aparte y quitarla (§6.38), cada una tras su dialogo, que muestra el
 * comando antes de correrlo. El hito 49 suma integrar con `merge --ff-only`,
 * que tampoco crea commits, y lo que no escribe: ver lo que trae una rama,
 * pedir una revision y los pedidos que quedan en el cuadro de su agente.
 */

import type { AgentId, GitFileChange, GitStatus, TerminalId, WorktreeKeptBranch, WorktreeRow } from '@agent-workbench/shared';
import { BranchIcon } from './BranchIcon.js';
import { DiffView } from './DiffView.js';
import { KIND_BADGE, KIND_TITLE, splitPath } from './git-kinds.js';
import { actionWaits, type GitPanelAction } from './git-last-state.js';
import { t, type MessageKey } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import { tRich } from './i18n/rich.js';
import type { GitView } from './useGit.js';
import type { ChangesView } from './useWorktrees.js';
import { WorktreeChanges } from './WorktreeChanges.js';
import {
  keptStatusText,
  reviewText,
  rowActions,
  rowIntegrateBlocker,
  rowStatusParts,
  rowTeamLines,
  sortedRows,
} from './worktree-ui.js';

const GROUPS: readonly { stage: GitFileChange['stage']; title: MessageKey; hint: MessageKey }[] = [
  { stage: 'conflict', title: 'git.group.conflict', hint: 'git.group.conflictHint' },
  { stage: 'staged', title: 'git.group.staged', hint: 'git.group.stagedHint' },
  { stage: 'unstaged', title: 'git.group.unstaged', hint: 'git.group.unstagedHint' },
  { stage: 'untracked', title: 'git.group.untracked', hint: 'git.group.untrackedHint' },
];

interface HeadlineProps {
  status: GitStatus;
}

function Headline({ status }: HeadlineProps): JSX.Element {
  return (
    <div className="git-headline">
      <span className="git-branch" title={status.repoRoot}>
        {status.branch ??
          (status.head !== null ? t('git.detachedAt', { head: status.head }) : t('git.detached'))}
      </span>

      {status.upstream !== null && (
        <span className="git-upstream" title={t('git.upstreamTitle', { upstream: status.upstream })}>
          {status.upstream}
        </span>
      )}

      {(status.ahead > 0 || status.behind > 0) && (
        <span className="git-ab" title={t('git.aheadBehindTitle')}>
          {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
        </span>
      )}
    </div>
  );
}

type OwnRow = WorktreeRow & { id: string };

/** Las ramas aparte del repo de la pestana (hito 48, §6.38). */
export interface GitPanelWorktrees {
  rows: readonly WorktreeRow[];
  /** Las filas son las guardadas de la ultima vez (§6.2.1). */
  rowsStale: boolean;
  /** Nueva sesion en una rama aparte, desde esta pestana. */
  onNew: () => void;
  /** Pasa a la pestana de esa carpeta, o abre una ahi. */
  onOpen: (row: WorktreeRow) => void;
  /** Solo las que creo la app (`id`). */
  onRemove: (row: OwnRow) => void;
  /** Hito 49. "Ver cambios" de una rama, o null: Cambios de siempre. */
  changes: ChangesView | null;
  onViewChanges: (row: OwnRow) => void;
  onOpenChangeDiff: (path: string) => void;
  onCloseChangeDiff: () => void;
  onCloseChanges: () => void;
  onRequestReview: (row: OwnRow) => void;
  onSendReview: (row: OwnRow) => void;
  /** Pasa a la pestana del revisor. */
  onShowReviewer: (terminalId: TerminalId) => void;
  onCatchUp: (row: OwnRow) => void;
  onIntegrate: (row: OwnRow) => void;
  /** El nombre de una CLI, para "Revision de Codex". */
  agentLabel: (agent: AgentId) => string;
  /** 20-10-2026. Las ramas que creo la app, sin carpeta y todavia en el repo. */
  kept: readonly WorktreeKeptBranch[];
  onDeleteBranch: (branch: WorktreeKeptBranch) => void;
}

interface GitPanelProps {
  view: GitView;
  worktrees: GitPanelWorktrees;
}

/**
 * Si una accion espera al estado de ahora (§6.2.1), y el titulo de su boton:
 * el de siempre, o por que espera.
 */
interface Waiting {
  waits: (action: GitPanelAction) => boolean;
  title: (action: GitPanelAction, title: string) => string;
}

/** Lo que dijo el revisor, para el color de su linea. */
function reviewTone(row: WorktreeRow): string {
  const review = row.review;
  if (review === null || review.state !== 'done' || review.stale) return '';
  return review.verdict === 'ready' ? ' git-worktree-review-ready' : review.verdict === 'changes' ? ' git-worktree-review-changes' : '';
}

/** Una fila de "Ramas aparte": la rama, su estado contra la base y lo que se puede hacer. */
function WorktreeItem({ row, worktrees, waiting }: { row: WorktreeRow; worktrees: GitPanelWorktrees; waiting: Waiting }): JSX.Element {
  const status = rowStatusParts(row);
  const team = rowTeamLines(row);
  const id = row.id;
  const own: OwnRow | null = id !== null && !row.isMain ? { ...row, id } : null;
  const actions = rowActions(row);
  const integrateBlocker = rowIntegrateBlocker(row);
  const review = row.review;
  return (
    <li>
      <div className="git-worktree" title={row.path}>
        <span className="git-worktree-branch">
          {row.branch ?? t('git.worktrees.detached')}
          {row.isMain && <span className="git-worktree-main">{t('worktree.rows.main')}</span>}
          {row.isCurrent && <span className="git-worktree-main">{t('worktree.rows.current')}</span>}
        </span>
        {status.length > 0 && <span className="git-worktree-state">{status.join(' · ')}</span>}
        {team.map((line) => (
          <span key={line} className="git-worktree-team">
            {line}
          </span>
        ))}
        {review !== null && (
          <span className={`git-worktree-review${reviewTone(row)}`}>
            {reviewText(review, worktrees.agentLabel(review.agent))}
            {review.terminalId !== null && (
              <button
                className="link-button"
                onClick={() => {
                  if (review.terminalId !== null) worktrees.onShowReviewer(review.terminalId);
                }}
                title={t('worktree.actions.showReviewerTitle')}
              >
                {t('worktree.actions.showReviewer')}
              </button>
            )}
          </span>
        )}
        <span className="git-worktree-path">{row.path}</span>
        <span className="git-worktree-actions">
          {!row.isCurrent && (
            <button className="link-button" onClick={() => worktrees.onOpen(row)} title={t('worktree.rows.openTitle')}>
              {t('worktree.rows.open')}
            </button>
          )}
          {own !== null && actions.viewChanges && (
            <button className="link-button" onClick={() => worktrees.onViewChanges(own)} title={t('worktree.actions.viewChangesTitle')}>
              {t('worktree.actions.viewChanges')}
            </button>
          )}
          {own !== null && actions.review && (
            <button
              className="link-button"
              onClick={() => worktrees.onRequestReview(own)}
              disabled={waiting.waits('requestReview')}
              title={waiting.title('requestReview', t('worktree.actions.reviewTitle'))}
            >
              {t('worktree.actions.review')}
            </button>
          )}
          {own !== null && actions.sendReview && (
            <button
              className="link-button"
              onClick={() => worktrees.onSendReview(own)}
              disabled={waiting.waits('sendReview')}
              title={waiting.title('sendReview', t('worktree.actions.sendReviewTitle'))}
            >
              {t('worktree.actions.sendReview')}
            </button>
          )}
          {own !== null && actions.catchUp && row.base !== null && (
            <button
              className="link-button"
              onClick={() => worktrees.onCatchUp(own)}
              disabled={waiting.waits('catchUp')}
              title={waiting.title('catchUp', t('worktree.actions.catchUpTitle', { base: row.base }))}
            >
              {t('worktree.actions.catchUp')}
            </button>
          )}
          {own !== null && actions.integrate && row.base !== null && (
            <button
              className="link-button"
              onClick={() => worktrees.onIntegrate(own)}
              disabled={integrateBlocker !== null || waiting.waits('integrate')}
              title={waiting.title('integrate', integrateBlocker ?? t('worktree.actions.integrateTitle', { base: row.base }))}
            >
              {t('worktree.actions.integrate', { base: row.base })}
            </button>
          )}
          {own !== null && (
            <button
              className="link-button"
              onClick={() => worktrees.onRemove(own)}
              disabled={waiting.waits('remove')}
              title={waiting.title('remove', t('worktree.rows.removeTitle'))}
            >
              {t('worktree.rows.remove')}
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * Una rama guardada (20-10-2026): la creo la app, su carpeta se quito y sigue
 * en el repo. Lo unico que se ofrece es borrarla; volver a abrirla es de sus
 * conversaciones, en la barra.
 */
function KeptBranchItem({ kept, worktrees, waiting }: { kept: WorktreeKeptBranch; worktrees: GitPanelWorktrees; waiting: Waiting }): JSX.Element {
  const status = keptStatusText(kept);
  return (
    <li>
      <div className="git-worktree" title={t('worktree.rows.keptTitle')}>
        <span className="git-worktree-branch">
          {kept.branch}
          <span className="git-worktree-main">{t('worktree.rows.kept')}</span>
        </span>
        {status !== null && <span className="git-worktree-state">{status}</span>}
        <span className="git-worktree-actions">
          <button
            className="link-button"
            onClick={() => worktrees.onDeleteBranch(kept)}
            disabled={waiting.waits('deleteBranch')}
            title={waiting.title('deleteBranch', t('worktree.rows.deleteBranchTitle'))}
          >
            {t('worktree.rows.deleteBranch')}
          </button>
        </span>
      </div>
    </li>
  );
}

export function GitPanel({ view, worktrees }: GitPanelProps): JSX.Element {
  const { status, diff, loadingDiff, openDiff, closeDiff, refresh } = view;

  /*
    Con el estado guardado de la ultima vez (§6.2.1) se mira todo y no se hace
    nada que cambie algo: esos botones quedan apagados, con el porque en el
    titulo, hasta que llega el de ahora.
  */
  const freshness = { statusStale: view.stale, rowsStale: worktrees.rowsStale };
  const waits = (action: GitPanelAction): boolean => actionWaits(action, freshness);
  const waiting: Waiting = {
    waits,
    title: (action, title) => (waits(action) ? t('git.waitingTitle') : title),
  };

  // "Ver cambios" de una rama (hito 49) reemplaza la lista, como el diff de un archivo.
  if (worktrees.changes !== null) {
    const changes = worktrees.changes;
    const row = worktrees.rows.find((candidate) => candidate.id === changes.worktreeId) ?? null;
    return (
      <WorktreeChanges
        view={changes}
        onBack={worktrees.onCloseChanges}
        onOpenDiff={worktrees.onOpenChangeDiff}
        onCloseDiff={worktrees.onCloseChangeDiff}
        onRequestReview={
          row === null || row.id === null || waits('requestReview')
            ? null
            : () => worktrees.onRequestReview({ ...row, id: changes.worktreeId })
        }
      />
    );
  }

  if (diff !== null || loadingDiff) {
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closeDiff}>
            ← {t('git.backToChanges')}
          </button>
          {diff !== null && (
            <span className="panel-subhead-title" title={diff.path}>
              {splitPath(diff.path).name}
              {diff.staged && <span className="panel-tagline"> {t('git.stagedTag')}</span>}
            </span>
          )}
        </div>
        {loadingDiff ? (
          <p className="panel-note">{t('git.readingDiff')}</p>
        ) : (
          diff !== null && <DiffView diff={diff} />
        )}
      </div>
    );
  }

  if (status.state !== 'ready') {
    return (
      <div className="panel-body">
        <p className="panel-note">{status.message === null ? t('git.unknownState') : serverTextMessage(status.message)}</p>
      </div>
    );
  }

  /*
    Las ramas aparte del repo, y la principal si la pestana esta en una: la de
    la pestana tambien, para poder quitarla desde ella misma. La seccion aparece
    solo con alguna rama aparte: sin ellas, Cambios es el de siempre.
  */
  const otherWorktrees = sortedRows(worktrees.rows).filter((row) => !(row.isCurrent && row.isMain));
  // Una rama guardada tambien la muestra: sin otra carpeta, es lo unico que queda de esa rama.
  const anyLinked = otherWorktrees.some((row) => !row.isMain) || worktrees.kept.length > 0;

  return (
    <div className={`panel-body${view.stale ? ' git-stale' : ''}`} aria-busy={view.stale}>
      <div className="panel-subhead">
        <Headline status={status} />
        {view.stale && <span className="git-updating">{t('git.updating')}</span>}
        <button
          className="icon-button"
          onClick={worktrees.onNew}
          disabled={waits('newBranch')}
          title={waiting.title('newBranch', t('worktree.new'))}
          aria-label={t('worktree.new')}
        >
          <BranchIcon />
        </button>
        <button className="icon-button" onClick={refresh} title={t('git.refresh')}>
          ⟳
        </button>
      </div>

      <div className="panel-scroll">
        {status.changes.length === 0 && <p className="panel-note">{t('git.clean')}</p>}

        {GROUPS.map((group) => {
          const changes = status.changes.filter((change) => change.stage === group.stage);
          if (changes.length === 0) return null;

          return (
            <section className="git-group" key={group.stage}>
              <h3 className="git-group-title" title={t(group.hint)}>
                {t(group.title)}
                <span className="git-group-count">{changes.length}</span>
              </h3>
              <ul className="git-list">
                {changes.map((change) => {
                  const { dir, name, isDirectory } = splitPath(change.path);
                  const title =
                    change.oldPath !== null
                      ? `${change.oldPath} → ${change.path}`
                      : isDirectory
                        ? t('git.newFolderTitle', { path: change.path })
                        : change.path;

                  const contenido = (
                    <>
                      <span
                        className={`git-badge git-badge-${change.kind}`}
                        title={t(KIND_TITLE[change.kind])}
                      >
                        {KIND_BADGE[change.kind]}
                      </span>
                      <span className="git-path">
                        <span className="git-path-name">{name}</span>
                        {dir.length > 0 && <span className="git-path-dir">{dir}</span>}
                      </span>
                    </>
                  );

                  return (
                    <li key={`${group.stage}:${change.path}`}>
                      {/*
                        Una carpeta no tiene diff. Se muestra igual —es un cambio
                        real del arbol— pero no como algo que se pueda abrir: un
                        boton que siempre termina en "no se pudo leer" es peor
                        que una fila que no invita a hacer clic.
                      */}
                      {isDirectory ? (
                        <div className="git-item git-item-static" title={title}>
                          {contenido}
                        </div>
                      ) : (
                        <button
                          className="git-item"
                          onClick={() => openDiff(change.path, change.stage === 'staged')}
                          title={title}
                        >
                          {contenido}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}

        {status.truncated && <p className="panel-note">{tRich('git.truncated')}</p>}

        {anyLinked && (
          <section className={`git-group${worktrees.rowsStale ? ' git-stale-rows' : ''}`}>
            {/*
              Se listan porque con varios worktrees del mismo repo es facil
              perder de vista en cual esta parada la pestana, y ahi se le pide
              al agente que edite el arbol equivocado. Desde el hito 48, con su
              estado contra la rama de la que salieron, y abrir y quitar.
            */}
            <h3 className="git-group-title" title={t('worktree.rows.headingTitle')}>
              {t('worktree.rows.heading')}
              <span className="git-group-count">{otherWorktrees.length + worktrees.kept.length}</span>
            </h3>
            <ul className="git-list">
              {otherWorktrees.map((row) => (
                <WorktreeItem key={row.path} row={row} worktrees={worktrees} waiting={waiting} />
              ))}
              {worktrees.kept.map((kept) => (
                <KeptBranchItem key={kept.id} kept={kept} worktrees={worktrees} waiting={waiting} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
