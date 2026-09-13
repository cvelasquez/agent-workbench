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
import { formatWhen } from './format-when.js';
import { Markdown } from './Markdown.js';
import type { MemoryBusy, MemoryView } from './useMemory.js';

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

const ACTION_LABELS: Record<MemoryChangeAction, string> = {
  create: 'se crea',
  'append-block': 'se agrega el bloque al final',
  'replace-block': 'se reemplaza el bloque',
  'append-lines': 'se agregan líneas al final',
  copy: 'se copia',
};

/** Que CLIs leen cada archivo de instrucciones. Solo para la etiqueta. */
const FILE_READERS: Record<MemoryInstructionFile, string> = {
  'AGENTS.md': 'Codex, Antigravity y OpenCode',
  'CLAUDE.md': 'Claude Code',
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
  if (file.problem === 'outside') return 'Es un enlace que apunta fuera del proyecto';
  if (file.problem === 'encoding') return 'No está en UTF-8';
  if (file.brokenBlock) return 'Tiene las marcas del bloque mal formadas';
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
  const parts: string[] = [];
  if (outdated.length > 0) {
    parts.push(
      `${outdated.map((file) => file.name).join(' y ')} ${
        outdated.length === 1 ? 'tiene el bloque desactualizado' : 'tienen el bloque desactualizado'
      }`,
    );
  }
  if (missing.length > 0) {
    parts.push(`falta el bloque en ${missing.map((file) => file.name).join(' y ')}`);
  }
  if (parts.length === 0) return null;
  const text = parts.join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
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
        <p className="panel-note">{error ?? 'Leyendo la memoria…'}</p>
      </div>
    );
  }

  if (open !== null || loading !== null) {
    const name = open?.name ?? loading ?? '';
    const title =
      name === MEMORY_INDEX_FILE
        ? 'Índice'
        : (status.notes.find((note) => note.name === name)?.title ?? name);
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closeNote}>
            ← Memoria
          </button>
          <span className="panel-subhead-title" title={name}>
            {title}
          </span>
        </div>

        {open === null ? (
          <p className="panel-note">Leyendo la nota…</p>
        ) : (
          <div className="panel-scroll">
            <div className="plan-body">
              <Markdown text={withoutFrontmatter(open.text)} localLink={resolveNote} />
            </div>
            {open.truncated && <p className="panel-note">La nota se cortó por tamaño.</p>}
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
            <button className="link-button" onClick={view.dismissMessage} title="Cerrar el aviso">
              ×
            </button>
          </div>
        )}

        {status.git.kind === 'error' && (
          <div className="memory-warning">
            <p className="memory-warning-line">
              git devolvió un error, así que no se sabe si la memoria está ignorada. Se puede
              instalar sin tocar <code>.gitignore</code>.
            </p>
            <pre className="memory-git-message">{status.git.message}</pre>
          </div>
        )}

        {status.files.filter(untouchable).map((file) => (
          <p key={file.name} className="memory-warning">
            <code>{file.name}</code>{' '}
            {file.problem === 'outside' ? (
              'es un enlace que apunta fuera del proyecto: la app no lo lee ni lo escribe.'
            ) : file.problem === 'encoding' ? (
              <>
                no está en UTF-8 (parece UTF-16, lo que deja <code>&gt;</code> en Windows
                PowerShell 5.1). Guardalo como UTF-8: la app no lo toca mientras tanto.
              </>
            ) : (
              'tiene las marcas del bloque de memoria mal formadas: una sin su pareja, o el bloque repetido. La app no lo toca hasta que lo arregles a mano.'
            )}
          </p>
        ))}

        {!status.installed && (
          <div className="memory-intro">
            <p>
              La memoria compartida guarda lo que los agentes aprenden de este proyecto
              —decisiones, restricciones, trampas ya pisadas— para la próxima sesión.
            </p>
            <p>
              Vive en <code>.agents/memory/</code>: una nota por archivo y un índice,{' '}
              <code>MEMORY.md</code>. Las cuatro CLIs la leen por un bloque marcado en su archivo
              de instrucciones. Nada se escribe hasta que confirmes los cambios.
            </p>
          </div>
        )}

        {status.installed && pendingUpdate !== null && !showForm && (
          <div className="memory-callout">
            <span>{pendingUpdate}</span>
            <button
              className="primary-button primary-button-small"
              onClick={() => setUpdateOpen(true)}
            >
              Actualizar el puente
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
              confirmLabel={status.installed ? 'Actualizar' : 'Instalar'}
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
            <span>
              La memoria propia de Claude Code tiene{' '}
              {plural(status.native.pending, 'nota que no está', 'notas que no están')} acá.
            </span>
            <button
              className="primary-button primary-button-small"
              disabled={view.busy !== null}
              onClick={view.importNative}
            >
              {view.busy === 'import'
                ? 'Importando…'
                : `Importar ${plural(status.native.pending, 'nota', 'notas')}`}
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
          title={`${entry.label}: ${entry.via}`}
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
            {entry.reaches ? `: llega por ${entry.via}` : `: no llega, ${entry.via}`}
          </span>
        </span>
      ))}
      {onAdjust !== null && (
        <button
          className="link-button memory-reach-adjust"
          onClick={onAdjust}
          title="Elegir de nuevo los archivos de instrucciones del puente"
        >
          Ajustar
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
      <p className="memory-section-label">Archivos de instrucciones</p>
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
          <span className="memory-option-hint">{FILE_READERS[file.name]}</span>
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
            Ignorar la memoria
            <span className="memory-option-hint">recomendado</span>
          </label>
          <label className="memory-option">
            <input
              type="radio"
              name="memory-git-mode"
              checked={options.gitMode === 'version'}
              onChange={() => onChange({ ...options, gitMode: 'version' })}
            />
            Versionarla
            <span className="memory-option-hint">para repos privados</span>
          </label>
          {git.ignored && options.gitMode === 'version' && (
            <p className="memory-warning">
              Este repo ya ignora <code>.agents/memory/</code>. Para versionarla hay que sacar esa
              regla del <code>.gitignore</code> a mano.
            </p>
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
            No tocar <code>.gitignore</code>
            <span className="memory-option-hint">git devolvió un error</span>
          </label>
        </>
      )}

      {(status.native.pending > 0 || worktree?.mainHasMemory === true) && (
        <p className="memory-section-label">Notas existentes</p>
      )}
      {status.native.pending > 0 && (
        <label className="memory-option">
          <input
            type="checkbox"
            checked={options.importNative}
            onChange={(event) => onChange({ ...options, importNative: event.target.checked })}
          />
          Importar {plural(status.native.pending, 'nota', 'notas')} de la memoria de Claude Code
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
          Copiar las notas del worktree principal
        </label>
      )}

      <div className="memory-actions">
        <button
          className="primary-button primary-button-small"
          disabled={busy !== null || options.instructionFiles.length === 0 || gitBlocked}
          onClick={onPlan}
          title={
            options.instructionFiles.length === 0
              ? 'Elegí al menos un archivo de instrucciones'
              : gitBlocked
                ? 'Con git en error solo se puede instalar sin tocar .gitignore'
                : undefined
          }
        >
          {busy === 'plan' ? 'Calculando…' : 'Ver cambios'}
        </button>
        {onCancel !== null && (
          <button className="link-button" onClick={onCancel} disabled={busy !== null}>
            Cancelar
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
      <p className="memory-section-label">Cambios</p>
      {changes.length === 0 ? (
        <p className="memory-empty">No hay nada que cambiar: el puente ya está al día.</p>
      ) : (
        <ul className="memory-change-list">
          {changes.map((change, index) => (
            <li key={`${change.file}-${index}`} className="memory-change">
              <div className="memory-change-head">
                <code className="memory-change-file">{change.file}</code>
                <span className="memory-option-hint">{ACTION_LABELS[change.action]}</span>
              </div>
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
            {installing ? 'Escribiendo…' : confirmLabel}
          </button>
        )}
        <button className="link-button" onClick={onCancel} disabled={installing}>
          {changes.length === 0 ? 'Volver' : 'Cancelar'}
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
      <p className="memory-section-label">Notas</p>
      <ul className="plan-list">
        {indexExists && (
          <li>
            <button className="plan-row" onClick={() => onOpen(MEMORY_INDEX_FILE)}>
              <span className="plan-name">Índice</span>
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
                {formatWhen(note.modifiedAt)} · {formatSize(note.sizeBytes)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {notes.length === 0 && (
        <p className="memory-empty">
          Todavía no hay notas. Los agentes las guardan acá cuando aprenden algo que sirve en otra
          sesión.
        </p>
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
      <summary className="memory-global-summary">Memoria global</summary>
      <p className="memory-empty">
        Lo que vale para todos tus proyectos va en <code>~/.agents/global.md</code>. La app no lo
        escribe: cada CLI lo lee si le agregás su fragmento.
      </p>
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
              title="Copiar el fragmento"
              onCopy={() => copy(fragment.text)}
            />
          </div>
          {fragment.note.length > 0 && (
            <p className="memory-fragment-note">{withInlineCode(fragment.note)}</p>
          )}
        </div>
      ))}
    </details>
  );
}
