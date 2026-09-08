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
 */

import type { GitChangeKind, GitFileChange, GitStatus } from '@agent-workbench/shared';
import { DiffView } from './DiffView.js';
import type { GitView } from './useGit.js';

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

const KIND_TITLE: Readonly<Record<GitChangeKind, string>> = {
  added: 'agregado',
  modified: 'modificado',
  deleted: 'borrado',
  renamed: 'renombrado',
  copied: 'copiado',
  'type-changed': 'cambio de tipo',
  untracked: 'sin seguimiento',
  conflict: 'en conflicto',
};

const GROUPS: readonly { stage: GitFileChange['stage']; title: string; hint: string }[] = [
  { stage: 'conflict', title: 'En conflicto', hint: 'Hay que resolverlos antes de seguir' },
  { stage: 'staged', title: 'Preparado', hint: 'Ya pasó por git add' },
  { stage: 'unstaged', title: 'Sin preparar', hint: 'Modificado en el árbol de trabajo' },
  { stage: 'untracked', title: 'Sin seguimiento', hint: 'Archivos nuevos que git no conoce' },
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
        {status.branch ?? `HEAD desprendido${status.head !== null ? ` @ ${status.head}` : ''}`}
      </span>

      {status.upstream !== null && (
        <span className="git-upstream" title={`Rama de seguimiento: ${status.upstream}`}>
          {status.upstream}
        </span>
      )}

      {(status.ahead > 0 || status.behind > 0) && (
        <span className="git-ab" title="Commits de diferencia con la rama de seguimiento">
          {status.ahead > 0 && <span className="git-ahead">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="git-behind">↓{status.behind}</span>}
        </span>
      )}
    </div>
  );
}

interface GitPanelProps {
  view: GitView;
}

export function GitPanel({ view }: GitPanelProps): JSX.Element {
  const { status, diff, loadingDiff, openDiff, closeDiff, refresh } = view;

  if (diff !== null || loadingDiff) {
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closeDiff}>
            ← Cambios
          </button>
          {diff !== null && (
            <span className="panel-subhead-title" title={diff.path}>
              {splitPath(diff.path).name}
              {diff.staged && <span className="panel-tagline"> preparado</span>}
            </span>
          )}
        </div>
        {loadingDiff ? (
          <p className="panel-note">Leyendo el diff…</p>
        ) : (
          diff !== null && <DiffView diff={diff} />
        )}
      </div>
    );
  }

  if (status.state !== 'ready') {
    return (
      <div className="panel-body">
        <p className="panel-note">
          {status.message ?? 'Todavía no se conoce el estado del repositorio.'}
        </p>
      </div>
    );
  }

  const otherWorktrees = status.worktrees.filter((worktree) => !worktree.isCurrent);

  return (
    <div className="panel-body">
      <div className="panel-subhead">
        <Headline status={status} />
        <button className="icon-button" onClick={refresh} title="Releer el estado ahora">
          ⟳
        </button>
      </div>

      <div className="panel-scroll">
        {status.changes.length === 0 && (
          <p className="panel-note">El árbol de trabajo está limpio.</p>
        )}

        {GROUPS.map((group) => {
          const changes = status.changes.filter((change) => change.stage === group.stage);
          if (changes.length === 0) return null;

          return (
            <section className="git-group" key={group.stage}>
              <h3 className="git-group-title" title={group.hint}>
                {group.title}
                <span className="git-group-count">{changes.length}</span>
              </h3>
              <ul className="git-list">
                {changes.map((change) => {
                  const { dir, name, isDirectory } = splitPath(change.path);
                  const title =
                    change.oldPath !== null
                      ? `${change.oldPath} → ${change.path}`
                      : isDirectory
                        ? `${change.path} — carpeta nueva; su contenido se ve en Archivos`
                        : change.path;

                  const contenido = (
                    <>
                      <span
                        className={`git-badge git-badge-${change.kind}`}
                        title={KIND_TITLE[change.kind]}
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

        {status.truncated && (
          <p className="panel-note">
            Hay más cambios de los que se muestran. Suele significar que falta una regla en{' '}
            <code>.gitignore</code>.
          </p>
        )}

        {otherWorktrees.length > 0 && (
          <section className="git-group">
            {/*
              Se listan porque con varios worktrees del mismo repo es facil
              perder de vista en cual esta parada la pestana, y ahi se le pide
              al agente que edite el arbol equivocado.
            */}
            <h3 className="git-group-title" title="Otros árboles de trabajo de este repositorio">
              Otros worktrees
              <span className="git-group-count">{otherWorktrees.length}</span>
            </h3>
            <ul className="git-list">
              {otherWorktrees.map((worktree) => (
                <li key={worktree.path}>
                  <div className="git-worktree" title={worktree.path}>
                    <span className="git-worktree-branch">{worktree.branch ?? 'detached'}</span>
                    <span className="git-worktree-path">{worktree.path}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
