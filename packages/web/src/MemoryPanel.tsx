/**
 * La memoria compartida del proyecto: instalar el puente, leer las notas y ver
 * los fragmentos de la memoria global.
 *
 * Es el unico panel que escribe dentro del proyecto, y eso ordena todo lo que
 * sigue:
 *
 *  - **Nada se escribe sin ver antes que.** "Ver cambios" pide el plan, la lista
 *    de archivos con lo que le pasaria a cada uno; recien ahi aparece
 *    "Instalar". La confirmacion es en el sitio y no un `confirm()`, que
 *    bloquearia la pagina entera.
 *  - **Lo que viaja son opciones.** El servidor rehace el plan al instalar; lo
 *    que se muestra es informativo.
 *  - **Lo global no se escribe.** Solo se muestra el fragmento para copiar: es
 *    configuracion de cada CLI, fuera de cualquier proyecto.
 *
 * Y las mismas reglas de los otros paneles de la columna: la nota abierta
 * **reemplaza** a la lista, con una vuelta atras, y se pide al abrirla.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  MEMORY_INDEX_FILE,
  MEMORY_INSTRUCTION_FILES,
  defaultMemoryInstallOptions,
  type MemoryAgentReach,
  type MemoryChange,
  type MemoryChangeAction,
  type MemoryFileState,
  type MemoryGlobalFragment,
  type MemoryInstallOptions,
  type MemoryInstructionFile,
  type MemoryNote,
  type MemoryStatus,
} from '@agent-workbench/shared';
import { CopyPathButton } from './FilesPanel.js';
import { formatBytes, formatList, formatWhen } from './i18n/format.js';
import { t, type MessageKey } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import { tRich } from './i18n/rich.js';
import { Markdown } from './Markdown.js';
import type { MemoryBusy, MemoryView } from './useMemory.js';

const ACTION_KEYS: Record<MemoryChangeAction, MessageKey> = {
  create: 'memory.action.create',
  'append-block': 'memory.action.appendBlock',
  'replace-block': 'memory.action.replaceBlock',
  'append-lines': 'memory.action.appendLines',
  copy: 'memory.action.copy',
};

/**
 * Que CLIs leen cada archivo de instrucciones. Solo para la etiqueta, que las
 * une con la conjuncion del idioma.
 */
const FILE_READERS: Record<MemoryInstructionFile, readonly string[]> = {
  'AGENTS.md': ['Codex', 'Antigravity', 'OpenCode'],
  'CLAUDE.md': ['Claude Code'],
};

/**
 * true si la app no puede tocar el archivo: marcas mal formadas, un enlace
 * hacia afuera o una codificacion que no es UTF-8.
 */
function untouchable(file: MemoryFileState): boolean {
  return file.brokenBlock || file.problem !== null;
}

/** Por que no se puede elegir un archivo, para el `title` y el aviso. */
function untouchableReason(file: MemoryFileState): string | null {
  if (file.problem === 'outside') return t('memory.problem.outside');
  if (file.problem === 'encoding') return t('memory.problem.encoding');
  if (file.brokenBlock) return t('memory.problem.brokenBlock');
  return null;
}

/**
 * Opciones con las que arranca el formulario.
 *
 * Sin instalar, las de `shared`, menos los archivos que la app no puede tocar:
 * elegir uno haria fallar la instalacion entera por un archivo que el usuario
 * no puede arreglar desde aca.
 *
 * Ya instalada, es una **actualizacion**, y ahi tres valores cambian a
 * proposito. Archivos: no se propone crear uno que no existe. Git: si el repo
 * no ignora la memoria, lo mas probable es que se haya elegido versionarla, y
 * el "ignorar" por defecto le escribiria el `.gitignore` sin que nadie lo
 * pidiera. Importar y copiar: tienen su propio boton, y una actualizacion del
 * bloque no deberia traer notas de paso.
 *
 * Con git en error, en los dos casos, "versionar": es lo unico que el servidor
 * acepta sin saber que ignora el repo, porque no toca `.gitignore`.
 */
function initialOptions(status: MemoryStatus): MemoryInstallOptions {
  const usable = status.files.filter((file) => !untouchable(file));
  if (!status.installed) {
    return {
      ...defaultMemoryInstallOptions(status),
      instructionFiles: usable.map((file) => file.name),
    };
  }
  return {
    // Los que ya tienen bloque y los que existen sin el. Crear uno que no
    // existe se elige a mano, por lo mismo que `updateNeeded` no lo reclama.
    instructionFiles: usable
      .filter((file) => file.hasBlock || file.exists)
      .map((file) => file.name),
    gitMode:
      status.git.kind === 'error' || (status.git.kind === 'repo' && !status.git.ignored)
        ? 'version'
        : 'ignore',
    importNative: false,
    copyFromMainWorktree: false,
  };
}

/**
 * Lo que falta al puente ya instalado, en una frase, o null si esta al dia.
 *
 * "Falta el bloque" cuenta solo para un archivo que **existe**: su CLI lo lee y
 * no se entera de la memoria. Uno que no existe es casi siempre una eleccion
 * —se instalo con un solo archivo— y avisarlo para siempre seria insistir
 * contra lo que el usuario decidio. Para agregarlo igual esta "Ajustar".
 */
function updateNeeded(status: MemoryStatus): string | null {
  const outdated = status.files.filter((file) => file.hasBlock && !file.blockCurrent);
  const missing = status.files.filter(
    (file) => file.exists && !file.hasBlock && !untouchable(file),
  );
  const names = (files: MemoryFileState[]): string => formatList(files.map((file) => file.name));
  if (outdated.length === 0) {
    return missing.length === 0 ? null : t('memory.update.missing', { files: names(missing) });
  }
  if (missing.length === 0) {
    return t('memory.update.outdated', { count: outdated.length, files: names(outdated) });
  }
  return t('memory.update.outdatedAndMissing', {
    count: outdated.length,
    outdated: names(outdated),
    missing: names(missing),
  });
}

/**
 * El frontmatter de una nota no se dibuja: `name:` ya es el titulo del
 * encabezado y `description:` se ve en la lista. Renderizado seria una raya y
 * dos lineas de texto crudo arriba de la nota.
 */
function withoutFrontmatter(text: string): string {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const match = /^---\n[\s\S]*?\n---(?:\n|$)/.exec(normalized);
  return match === null ? normalized : normalized.slice(match[0].length);
}

/**
 * Las notas de los fragmentos nombran archivos entre comillas invertidas. No
 * son markdown entero —una o dos frases—, asi que alcanza con el codigo en linea.
 */
function withInlineCode(text: string): (JSX.Element | string)[] {
  return text
    .split(/`([^`]+)`/)
    .map((piece, index) => (index % 2 === 1 ? <code key={index}>{piece}</code> : piece));
}

export function MemoryPanel({ view }: { view: MemoryView }): JSX.Element {
  const { status, open, loading, error, closeNote, openNote } = view;

  // Opciones tocadas por el usuario. Mientras sean null valen las de
  // `initialOptions`, que siguen al estado: si llegan notas nativas pendientes
  // despues de abrir el panel, la casilla aparece ya marcada.
  const [options, setOptions] = useState<MemoryInstallOptions | null>(null);
  // Solo cuenta con la memoria instalada: sin instalar, el formulario esta siempre.
  const [updateOpen, setUpdateOpen] = useState(false);

  const cwd = status?.cwd ?? null;
  useEffect(() => {
    setOptions(null);
    setUpdateOpen(false);
  }, [cwd]);

  // Termino una instalacion o una importacion: el formulario ya dijo lo suyo.
  // Una importacion no puede llegar con el formulario abierto —su boton se
  // esconde mientras tanto—, asi que esto no descarta opciones a medio elegir.
  useEffect(() => {
    if (view.lastResult === null) return;
    setOptions(null);
    setUpdateOpen(false);
  }, [view.lastResult]);

  /**
   * Los enlaces del indice abren la nota en el panel.
   *
   * Solo los que nombran una nota que existe: el resto se ve como texto, que es
   * mejor que un clic que termina en "esa nota ya no existe". El nombre lo
   * vuelve a validar el servidor.
   */
  const resolveNote = useCallback(
    (href: string): (() => void) | null => {
      if (status === null) return null;
      let name = href.replace(/^\.\//, '');
      try {
        name = decodeURIComponent(name);
      } catch {
        return null;
      }
      const known =
        name === MEMORY_INDEX_FILE || status.notes.some((note) => note.name === name);
      return known ? () => openNote(name) : null;
    },
    [status, openNote],
  );

  if (status === null) {
    return (
      <div className="panel-body">
        <p className="panel-note">{error ?? t('memory.loading')}</p>
      </div>
    );
  }

  if (open !== null || loading !== null) {
    const name = open?.name ?? loading ?? '';
    const title =
      name === MEMORY_INDEX_FILE
        ? t('memory.index')
        : (status.notes.find((note) => note.name === name)?.title ?? name);
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closeNote}>
            {t('memory.back')}
          </button>
          <span className="panel-subhead-title" title={name}>
            {title}
          </span>
        </div>

        {open === null ? (
          <p className="panel-note">{t('memory.note.loading')}</p>
        ) : (
          <div className="panel-scroll">
            <div className="plan-body">
              <Markdown text={withoutFrontmatter(open.text)} localLink={resolveNote} />
            </div>
            {open.truncated && <p className="panel-note">{t('memory.note.truncated')}</p>}
          </div>
        )}
      </div>
    );
  }

  const current = options ?? initialOptions(status);
  const pendingUpdate = status.installed ? updateNeeded(status) : null;
  const showForm = !status.installed || updateOpen || view.planned !== null;

  return (
    <div className="panel-body">
      <ReachRow
        reach={status.reach}
        onAdjust={
          // Alguna CLI no llega y no hay aviso con su propio boton: sin esto,
          // agregar el archivo que no se eligio al instalar no tendria camino.
          status.installed &&
          !showForm &&
          pendingUpdate === null &&
          status.reach.some((entry) => !entry.reaches)
            ? () => setUpdateOpen(true)
            : null
        }
      />

      <div className="panel-scroll">
        {(error ?? view.lastResult) !== null && (
          <div className={`memory-message${error !== null ? ' memory-message-error' : ''}`}>
            <span>{error ?? view.lastResult}</span>
            <button
              className="link-button"
              onClick={view.dismissMessage}
              title={t('common.dismissNotice')}
            >
              ×
            </button>
          </div>
        )}

        {status.git.kind === 'error' && (
          <div className="memory-warning">
            <p className="memory-warning-line">{tRich('memory.git.errorWarning')}</p>
            <pre className="memory-git-message">{serverTextMessage(status.git.message)}</pre>
          </div>
        )}

        {status.files.filter(untouchable).map((file) => (
          <p key={file.name} className="memory-warning">
            {file.problem === 'outside'
              ? tRich('memory.problem.outsideWarning', { file: file.name })
              : file.problem === 'encoding'
                ? tRich('memory.problem.encodingWarning', { file: file.name })
                : tRich('memory.problem.brokenBlockWarning', { file: file.name })}
          </p>
        ))}

        {!status.installed && (
          <div className="memory-intro">
            <p>{t('memory.intro.what')}</p>
            <p>{tRich('memory.intro.where')}</p>
          </div>
        )}

        {status.installed && pendingUpdate !== null && !showForm && (
          <div className="memory-callout">
            <span>{pendingUpdate}</span>
            <button
              className="primary-button primary-button-small"
              onClick={() => setUpdateOpen(true)}
            >
              {t('memory.update.button')}
            </button>
          </div>
        )}

        {showForm &&
          (view.planned === null ? (
            <InstallForm
              status={status}
              options={current}
              busy={view.busy}
              onChange={setOptions}
              onPlan={() => {
                // Se congelan las opciones con las que se pidio el plan: si el
                // estado cambia antes de confirmar, se instala lo que se vio.
                setOptions(current);
                view.requestPlan(current);
              }}
              onCancel={
                status.installed
                  ? () => {
                      setUpdateOpen(false);
                      setOptions(null);
                    }
                  : null
              }
            />
          ) : (
            <PlanReview
              changes={view.planned}
              busy={view.busy}
              confirmLabel={status.installed ? t('memory.plan.update') : t('memory.plan.install')}
              // Las opciones las guarda el hook con el plan: se instala lo que
              // se previsualizo, aunque el formulario se haya desmontado.
              onConfirm={view.install}
              onCancel={view.cancelPlan}
            />
          ))}

        {/*
          Con el formulario o la previsualizacion abiertos no se ofrece: el
          formulario ya tiene su casilla de importar, y una importacion a mitad
          de una actualizacion cambiaria el disco que se esta por confirmar.
        */}
        {status.installed && status.native.pending > 0 && !showForm && (
          <div className="memory-callout">
            <span>{t('memory.native.pending', { count: status.native.pending })}</span>
            <button
              className="primary-button primary-button-small"
              disabled={view.busy !== null}
              onClick={view.importNative}
            >
              {view.busy === 'import'
                ? t('memory.native.importing')
                : t('memory.native.import', { count: status.native.pending })}
            </button>
          </div>
        )}

        {status.installed && (
          <NoteList notes={status.notes} indexExists={status.indexExists} onOpen={openNote} />
        )}

        {status.globalFragments.length > 0 && (
          <GlobalMemory fragments={status.globalFragments} />
        )}
      </div>
    </div>
  );
}

/**
 * Las cuatro CLIs y si llegan a la memoria.
 *
 * Va arriba y fuera del scroll porque contesta la pregunta que uno trae al
 * abrir el panel —"¿esto ya lo leen todas?"— y el por que va en el `title`:
 * cuando falta algo, dice que.
 */
function ReachRow({
  reach,
  onAdjust,
}: {
  reach: MemoryAgentReach[];
  /** Abre el formulario del puente, o null si no hace falta ofrecerlo. */
  onAdjust: (() => void) | null;
}): JSX.Element {
  return (
    <div className="memory-reach">
      {reach.map((entry) => (
        <span
          key={entry.agent}
          className={`memory-reach-item${entry.reaches ? ' memory-reach-on' : ''}`}
          title={t('memory.reach.title', { label: entry.label, via: serverTextMessage(entry.via) })}
        >
          <span className="memory-reach-mark" aria-hidden="true">
            {entry.reaches ? '✓' : '—'}
          </span>
          {entry.label}
          {/*
            El glifo es decorativo y el `title` no lo anuncia un lector de
            pantalla: sin esto, "Codex" se leia igual llegara o no.
          */}
          <span className="visually-hidden">
            {entry.reaches
              ? t('memory.reach.reaches', { via: serverTextMessage(entry.via) })
              : t('memory.reach.doesNotReach', { via: serverTextMessage(entry.via) })}
          </span>
        </span>
      ))}
      {onAdjust !== null && (
        <button
          className="link-button memory-reach-adjust"
          onClick={onAdjust}
          title={t('memory.reach.adjustTitle')}
        >
          {t('memory.reach.adjust')}
        </button>
      )}
    </div>
  );
}

interface InstallFormProps {
  status: MemoryStatus;
  options: MemoryInstallOptions;
  busy: MemoryBusy;
  onChange: (options: MemoryInstallOptions) => void;
  onPlan: () => void;
  /** null si el formulario no se puede cerrar: sin instalar, es el panel. */
  onCancel: (() => void) | null;
}

function InstallForm({
  status,
  options,
  busy,
  onChange,
  onPlan,
  onCancel,
}: InstallFormProps): JSX.Element {
  const { git } = status;
  const worktree = git.kind === 'repo' ? git.worktree : null;
  const gitBlocked = git.kind === 'error' && options.gitMode === 'ignore';

  const toggleFile = (name: MemoryInstructionFile, checked: boolean): void => {
    const chosen = new Set(options.instructionFiles);
    if (checked) chosen.add(name);
    else chosen.delete(name);
    onChange({
      ...options,
      instructionFiles: MEMORY_INSTRUCTION_FILES.filter((file) => chosen.has(file)),
    });
  };

  return (
    <div className="memory-form">
      <p className="memory-section-label">{t('memory.form.files')}</p>
      {status.files.map((file) => (
        <label
          key={file.name}
          className="memory-option"
          title={untouchableReason(file) ?? undefined}
        >
          <input
            type="checkbox"
            checked={options.instructionFiles.includes(file.name)}
            disabled={untouchable(file)}
            onChange={(event) => toggleFile(file.name, event.target.checked)}
          />
          <code>{file.name}</code>
          <span className="memory-option-hint">{formatList(FILE_READERS[file.name])}</span>
        </label>
      ))}

      {git.kind === 'repo' && (
        <>
          <p className="memory-section-label">Git</p>
          <label className="memory-option">
            <input
              type="radio"
              name="memory-git-mode"
              checked={options.gitMode === 'ignore'}
              onChange={() => onChange({ ...options, gitMode: 'ignore' })}
            />
            {t('memory.git.ignore')}
            <span className="memory-option-hint">{t('memory.git.ignoreHint')}</span>
          </label>
          <label className="memory-option">
            <input
              type="radio"
              name="memory-git-mode"
              checked={options.gitMode === 'version'}
              onChange={() => onChange({ ...options, gitMode: 'version' })}
            />
            {t('memory.git.version')}
            <span className="memory-option-hint">{t('memory.git.versionHint')}</span>
          </label>
          {git.ignored && options.gitMode === 'version' && (
            <p className="memory-warning">{tRich('memory.git.alreadyIgnored')}</p>
          )}
        </>
      )}

      {/*
        Con git en error, "ignorar" no se puede: sin saber que ignora el repo, el
        servidor no toca `.gitignore`. Sin esta opcion a la vista, el formulario
        arrancaba en "ignorar" y "Ver cambios" fallaba siempre, sin salida.
      */}
      {git.kind === 'error' && (
        <>
          <p className="memory-section-label">Git</p>
          <label className="memory-option">
            <input
              type="radio"
              name="memory-git-mode"
              checked={options.gitMode === 'version'}
              onChange={() => onChange({ ...options, gitMode: 'version' })}
            />
            {tRich('memory.git.dontTouch')}
            <span className="memory-option-hint">{t('memory.git.errorHint')}</span>
          </label>
        </>
      )}

      {(status.native.pending > 0 || worktree?.mainHasMemory === true) && (
        <p className="memory-section-label">{t('memory.form.existingNotes')}</p>
      )}
      {status.native.pending > 0 && (
        <label className="memory-option">
          <input
            type="checkbox"
            checked={options.importNative}
            onChange={(event) => onChange({ ...options, importNative: event.target.checked })}
          />
          {t('memory.form.importNative', { count: status.native.pending })}
        </label>
      )}
      {worktree?.mainHasMemory === true && (
        <label className="memory-option" title={worktree.mainPath}>
          <input
            type="checkbox"
            checked={options.copyFromMainWorktree}
            onChange={(event) =>
              onChange({ ...options, copyFromMainWorktree: event.target.checked })
            }
          />
          {t('memory.form.copyFromMain')}
        </label>
      )}

      <div className="memory-actions">
        <button
          className="primary-button primary-button-small"
          disabled={busy !== null || options.instructionFiles.length === 0 || gitBlocked}
          onClick={onPlan}
          title={
            options.instructionFiles.length === 0
              ? t('memory.form.noFiles')
              : gitBlocked
                ? t('memory.git.blocked')
                : undefined
          }
        >
          {busy === 'plan' ? t('memory.form.planning') : t('memory.form.preview')}
        </button>
        {onCancel !== null && (
          <button className="link-button" onClick={onCancel} disabled={busy !== null}>
            {t('common.cancel')}
          </button>
        )}
      </div>
    </div>
  );
}

interface PlanReviewProps {
  changes: MemoryChange[];
  busy: MemoryBusy;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/** Lo que va a pasar, archivo por archivo, y la confirmacion en el sitio. */
function PlanReview({
  changes,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: PlanReviewProps): JSX.Element {
  const installing = busy === 'install';
  return (
    <div className="memory-form">
      <p className="memory-section-label">{t('memory.plan.changes')}</p>
      {changes.length === 0 ? (
        <p className="memory-empty">{t('memory.plan.nothing')}</p>
      ) : (
        <ul className="memory-change-list">
          {changes.map((change, index) => (
            <li key={`${change.file}-${index}`} className="memory-change">
              <div className="memory-change-head">
                <code className="memory-change-file">{change.file}</code>
                <span className="memory-option-hint">{t(ACTION_KEYS[change.action])}</span>
              </div>
              {change.copiedFrom !== null && (
                <p className="memory-option-hint">{t('memory.plan.copiedFrom', { path: change.copiedFrom })}</p>
              )}
              {change.preview.length > 0 && (
                <pre className="memory-preview">{change.preview}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="memory-actions">
        {changes.length > 0 && (
          <button
            className="primary-button primary-button-small"
            disabled={busy !== null}
            onClick={onConfirm}
          >
            {installing ? t('memory.plan.writing') : confirmLabel}
          </button>
        )}
        <button className="link-button" onClick={onCancel} disabled={installing}>
          {changes.length === 0 ? t('memory.plan.back') : t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

function NoteList({
  notes,
  indexExists,
  onOpen,
}: {
  notes: MemoryNote[];
  indexExists: boolean;
  onOpen: (name: string) => void;
}): JSX.Element {
  return (
    <>
      <p className="memory-section-label">{t('memory.list.notes')}</p>
      <ul className="plan-list">
        {indexExists && (
          <li>
            <button className="plan-row" onClick={() => onOpen(MEMORY_INDEX_FILE)}>
              <span className="plan-name">{t('memory.index')}</span>
              <span className="plan-meta">{MEMORY_INDEX_FILE}</span>
            </button>
          </li>
        )}
        {notes.map((note) => (
          <li key={note.name}>
            <button className="plan-row" onClick={() => onOpen(note.name)} title={note.name}>
              <span className="plan-name">{note.title}</span>
              {note.description.length > 0 && (
                <span className="memory-note-description">{note.description}</span>
              )}
              <span className="plan-meta">
                {formatWhen(note.modifiedAt)} · {formatBytes(note.sizeBytes)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {notes.length === 0 && (
        <p className="memory-empty">{t('memory.list.empty')}</p>
      )}
    </>
  );
}

/**
 * La memoria global, plegada.
 *
 * La app no escribe esos archivos —son configuracion de cada CLI, fuera de
 * cualquier proyecto—, asi que lo unico que ofrece es el fragmento y el boton
 * de copiar, con el mismo acuse que el arbol de archivos.
 */
function GlobalMemory({ fragments }: { fragments: MemoryGlobalFragment[] }): JSX.Element {
  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }, []);

  return (
    <details className="memory-global">
      <summary className="memory-global-summary">{t('memory.global.title')}</summary>
      <p className="memory-empty">{tRich('memory.global.intro')}</p>
      {fragments.map((fragment) => (
        <div key={fragment.agent} className="memory-fragment">
          <div className="memory-change-head">
            <span className="memory-fragment-label">{fragment.label}</span>
            <code className="memory-fragment-target" title={fragment.target}>
              {fragment.target}
            </code>
          </div>
          <div className="memory-fragment-body">
            <pre className="memory-preview">{fragment.text}</pre>
            <CopyPathButton
              className="icon-button"
              title={t('memory.global.copy')}
              onCopy={() => copy(fragment.text)}
            />
          </div>
          <p className="memory-fragment-note">{withInlineCode(serverTextMessage(fragment.note))}</p>
        </div>
      ))}
    </details>
  );
}
