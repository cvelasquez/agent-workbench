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
 * comando antes de correrlo.
 */

import type { GitChangeKind, GitFileChange, GitStatus, WorktreeRow } from '@agent-workbench/shared';
import { BranchIcon } from './BranchIcon.js';
import { DiffView } from './DiffView.js';
import { t, type MessageKey } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import { tRich } from './i18n/rich.js';
import type { GitView } from './useGit.js';
import { rowStatusParts, sortedRows } from './worktree-ui.js';

/** Letra que se muestra en el cuadradito de cada archivo. */
const KIND_BADGE: Readonly<Record<GitChangeKind, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: '?',
  conflict: '!',
};

const KIND_TITLE: Readonly<Record<GitChangeKind, MessageKey>> = {
  added: 'git.kind.added',
  modified: 'git.kind.modified',
  deleted: 'git.kind.deleted',
  renamed: 'git.kind.renamed',
  copied: 'git.kind.copied',
  'type-changed': 'git.kind.typeChanged',
  untracked: 'git.kind.untracked',
  conflict: 'git.kind.conflict',
};

const GROUPS: readonly { stage: GitFileChange['stage']; title: MessageKey; hint: MessageKey }[] = [
  { stage: 'conflict', title: 'git.group.conflict', hint: 'git.group.conflictHint' },
  { stage: 'staged', title: 'git.group.staged', hint: 'git.group.stagedHint' },
  { stage: 'unstaged', title: 'git.group.unstaged', hint: 'git.group.unstagedHint' },
  { stage: 'untracked', title: 'git.group.untracked', hint: 'git.group.untrackedHint' },
];

/**
 * Separa el nombre de su directorio, para que la ruta larga no tape lo que
 * importa.
 *
 * Ojo con la barra final. `git status` no lista una carpeta nueva archivo por
 * archivo: la resume en una sola entrada terminada en `/` — `docs/`. Sin este
 * caso, el ultimo segmento es la cadena vacia y la fila sale sin nombre.
 */
function splitPath(value: string): { dir: string; name: string; isDirectory: boolean } {
  const isDirectory = value.endsWith('/');
  const clean = isDirectory ? value.slice(0, -1) : value;
  const index = clean.lastIndexOf('/');
  const name = index === -1 ? clean : clean.slice(index + 1);
  return {
    dir: index === -1 ? '' : clean.slice(0, index + 1),
    name: isDirectory ? `${name}/` : name,
    isDirectory,
  };
}

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

/** Las ramas aparte del repo de la pestana (hito 48, §6.38). */
export interface GitPanelWorktrees {
  rows: readonly WorktreeRow[];
  /** Nueva sesion en una rama aparte, desde esta pestana. */
  onNew: () => void;
  /** Pasa a la pestana de esa carpeta, o abre una ahi. */
  onOpen: (row: WorktreeRow) => void;
  /** Solo las que creo la app (`id`). */
  onRemove: (row: WorktreeRow & { id: string }) => void;
}

interface GitPanelProps {
  view: GitView;
  worktrees: GitPanelWorktrees;
}

/** Una fila de "Ramas aparte": la rama, su estado contra la base y lo que se puede hacer. */
function WorktreeItem({ row, worktrees }: { row: WorktreeRow; worktrees: GitPanelWorktrees }): JSX.Element {
  const status = rowStatusParts(row);
  const id = row.id;
  return (
    <li>
      <div className="git-worktree" title={row.path}>
        <span className="git-worktree-branch">
          {row.branch ?? t('git.worktrees.detached')}
          {row.isMain && <span className="git-worktree-main">{t('worktree.rows.main')}</span>}
          {row.isCurrent && <span className="git-worktree-main">{t('worktree.rows.current')}</span>}
        </span>
        {status.length > 0 && <span className="git-worktree-state">{status.join(' · ')}</span>}
        <span className="git-worktree-path">{row.path}</span>
        <span className="git-worktree-actions">
          {!row.isCurrent && (
            <button className="link-button" onClick={() => worktrees.onOpen(row)} title={t('worktree.rows.openTitle')}>
              {t('worktree.rows.open')}
            </button>
          )}
          {id !== null && !row.isMain && (
            <button
              className="link-button"
              onClick={() => worktrees.onRemove({ ...row, id })}
              title={t('worktree.rows.removeTitle')}
            >
              {t('worktree.rows.remove')}
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

export function GitPanel({ view, worktrees }: GitPanelProps): JSX.Element {
  const { status, diff, loadingDiff, openDiff, closeDiff, refresh } = view;

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
  const anyLinked = otherWorktrees.some((row) => !row.isMain);

  return (
    <div className="panel-body">
      <div className="panel-subhead">
        <Headline status={status} />
        <button
          className="icon-button"
          onClick={worktrees.onNew}
          title={t('worktree.new')}
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
          <section className="git-group">
            {/*
              Se listan porque con varios worktrees del mismo repo es facil
              perder de vista en cual esta parada la pestana, y ahi se le pide
              al agente que edite el arbol equivocado. Desde el hito 48, con su
              estado contra la rama de la que salieron, y abrir y quitar.
            */}
            <h3 className="git-group-title" title={t('worktree.rows.headingTitle')}>
              {t('worktree.rows.heading')}
              <span className="git-group-count">{otherWorktrees.length}</span>
            </h3>
            <ul className="git-list">
              {otherWorktrees.map((row) => (
                <WorktreeItem key={row.path} row={row} worktrees={worktrees} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
