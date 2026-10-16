/**
 * El visor de un documento abierto de Archivos o de Planes (Hito 40, §6.31).
 *
 * Antes eran dos vistas: la previsualizacion de Archivos, siempre como codigo, y
 * la de Planes, siempre formateada. Ahora es una sola, y lo que cambia es el
 * documento:
 *
 *  - **Un Markdown se ve formateado**, tambien desde Archivos (pedido del
 *    usuario), con un conmutador para ver el fuente. Lo arma el mismo
 *    `<Markdown>` del hilo: elementos de React sin HTML, y sin imagenes, asi que
 *    tampoco hay llamadas de red (§2.4).
 *  - **"Buscar en este documento"**, como en el hilo: Enter y Mayus+Enter saltan
 *    entre coincidencias, Esc limpia. Busca sobre lo que se ve (`useDocSearch`).
 *  - **⟳ relee**: el agente puede haberlo cambiado mientras estaba abierto.
 *  - **Vuelve a la altura donde estaba** cuando se lo muestra de nuevo.
 *  - **Un archivo de texto se edita** (Hito 46, §6.36): Editar, Guardar y
 *    Cancelar. Lo escrito vive en `useDocuments`, no aca: este visor se vuelve
 *    a montar con cada documento. Si el archivo cambio en el disco mientras se
 *    editaba, lo tuyo ya no se guarda: se descarta, o se pasa a mano a la
 *    version nueva con la lista de tus cambios al lado.
 */

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { DiffLines } from './DiffView.js';
import { isMarkdownPath, resolveDocLink } from './doc-search.js';
import type { DocMode, OpenDoc } from './doc-tabs.js';
import { CodePreview, PreviewActions } from './FilePreviewView.js';
import { t } from './i18n/index.js';
import { serverTextMessage } from './i18n/server-text.js';
import { Markdown } from './Markdown.js';
import type { DocContent, DocEditor } from './useDocuments.js';
import { useDocSearch } from './useDocSearch.js';

interface DocumentViewerProps {
  doc: OpenDoc;
  content: DocContent | undefined;
  /** "Leyendo el archivo…" o "Leyendo el plan…". */
  readingText: string;
  /** El aviso de un documento cortado por tamano, de cada tipo. */
  truncatedText: string;
  onReload: () => void;
  onModeChange: (mode: DocMode) => void;
  /** Solo en Archivos, y no en una ventana remota (hito 37). */
  onOpenWithSystem: (() => void) | null;
  /** Solo en Archivos: pone la ruta del archivo en el cuadro de escritura. */
  onInsert?: () => void;
  /** Solo en Archivos: un enlace relativo de un Markdown abre ese documento. */
  onOpenLink?: (path: string) => void;
  /** La altura donde se lo dejo, si se lo miro antes. */
  initialScroll: number | undefined;
  onScrollChange: (top: number) => void;
  /** Solo en Archivos, con un servidor que guarda (Hito 46): editar este archivo. */
  editor?: DocEditor | null;
  /** El boton de poner la ruta en tu mensaje, al lado de ⟳. Lo arma Archivos, que es quien la sabe. */
  insertButton?: ReactNode;
}

export function DocumentViewer({
  doc,
  content,
  readingText,
  truncatedText,
  onReload,
  onModeChange,
  onOpenWithSystem,
  onInsert,
  onOpenLink,
  initialScroll,
  onScrollChange,
  editor = null,
  insertButton,
}: DocumentViewerProps): JSX.Element {
  const [query, setQuery] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const loaded = content?.loaded ?? null;
  const text = loaded === null ? '' : loaded.kind === 'file' ? loaded.preview.text : loaded.plan.text;
  const binary = loaded !== null && loaded.kind === 'file' && loaded.preview.binary;
  const truncated = loaded !== null && (loaded.kind === 'file' ? loaded.preview.truncated : loaded.plan.truncated);
  const markdown =
    loaded !== null &&
    (loaded.kind === 'plan' || loaded.preview.language === 'markdown' || isMarkdownPath(loaded.preview.path));
  const formatted = markdown && (doc.mode ?? 'formatted') === 'formatted';
  const language = loaded !== null && loaded.kind === 'file' ? loaded.preview.language : 'markdown';

  const needle = query.trim();
  const search = useDocSearch(bodyRef, scrollRef, needle, `${formatted ? 'f' : 's'}:${text.length}:${text.slice(0, 64)}`);

  // Volver a la altura donde se lo dejo, una vez, cuando hay algo que mostrar.
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (restored.current || loaded === null) return;
    restored.current = true;
    if (initialScroll !== undefined && scrollRef.current !== null) scrollRef.current.scrollTop = initialScroll;
  }, [loaded, initialScroll]);

  const localLink =
    onOpenLink === undefined || loaded === null || loaded.kind !== 'file'
      ? undefined
      : (href: string) => {
          const target = resolveDocLink(doc.key, href);
          return target === null ? null : () => onOpenLink(target);
        };

  const searchable = loaded !== null && !binary;
  const edit = editor?.edit ?? null;

  if (editor !== null && edit !== null) {
    return <FileEditor title={doc.title} editor={editor} insertButton={insertButton} />;
  }

  /*
    Editar se ofrece en un archivo de texto. Apagado, dice por que: uno cortado
    no se puede guardar entero, y uno que no esta en UTF-8 se danaria.
  */
  const editable = loaded !== null && loaded.kind === 'file' && loaded.preview.editable === true;
  const editTitle = editable ? t('docs.edit.title') : truncated ? t('docs.edit.tooLarge') : t('docs.edit.unsafe');

  return (
    <div className="panel-body doc-viewer">
      <div className="doc-toolbar">
        <input
          className="conversation-search-input"
          type="search"
          placeholder={t('docs.search.placeholder')}
          value={query}
          disabled={!searchable}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') search.step(event.shiftKey ? -1 : 1);
            if (event.key === 'Escape') setQuery('');
            event.stopPropagation();
          }}
          spellCheck={false}
        />
        {needle.length > 0 && (
          <>
            <span className="conversation-matches">
              {search.count === 0 ? t('thread.search.none') : `${search.index + 1}/${search.count}`}
            </span>
            <button className="icon-button" onClick={() => search.step(-1)} disabled={search.count === 0} title={t('thread.search.previous')}>
              ↑
            </button>
            <button className="icon-button" onClick={() => search.step(1)} disabled={search.count === 0} title={t('thread.search.next')}>
              ↓
            </button>
          </>
        )}
        {markdown && (
          <div className="doc-mode" role="group" aria-label={t('docs.mode.label')}>
            <button className={formatted ? 'is-active' : ''} aria-pressed={formatted} onClick={() => onModeChange('formatted')}>
              {t('docs.mode.formatted')}
            </button>
            <button className={formatted ? '' : 'is-active'} aria-pressed={!formatted} onClick={() => onModeChange('source')}>
              {t('docs.mode.source')}
            </button>
          </div>
        )}
        {editor !== null && loaded !== null && loaded.kind === 'file' && !binary && (
          <button
            className="primary-button primary-button-small doc-edit-button"
            onClick={editor.begin}
            disabled={!editable}
            title={editTitle}
          >
            {editor.justSaved ? t('docs.edit.saved') : t('docs.edit.button')}
          </button>
        )}
        {insertButton}
        <button className="icon-button" onClick={onReload} disabled={content?.loading === true} title={t('docs.reload')}>
          ⟳
        </button>
      </div>

      {content?.failed === true && loaded !== null && <p className="panel-note doc-note">{t('docs.reloadFailed')}</p>}

      {loaded === null ? (
        <p className="panel-note">{content?.failed === true ? t('docs.failed') : readingText}</p>
      ) : binary ? (
        <div className="preview-fallback">
          <p className="panel-note">{t('files.preview.binary')}</p>
          <PreviewActions onInsert={onInsert} onOpenWithSystem={onOpenWithSystem} />
        </div>
      ) : (
        <div className="panel-scroll" ref={scrollRef} onScroll={(event) => onScrollChange(event.currentTarget.scrollTop)}>
          <div ref={bodyRef} className={formatted ? 'plan-body' : 'doc-source'}>
            {formatted ? <Markdown text={text} localLink={localLink} /> : <CodePreview text={text} language={language} />}
          </div>
          {truncated && (
            <div className="preview-fallback">
              <p className="panel-note">{truncatedText}</p>
              {loaded.kind === 'file' && <PreviewActions onInsert={onInsert} onOpenWithSystem={onOpenWithSystem} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Un archivo en edicion (§6.36).
 *
 *  - **Guardar** se apaga sin cambios; Ctrl+S (Cmd+S) guarda. **Cancelar** con
 *    cambios pide confirmar aca mismo, sin ventana del navegador, como las
 *    notas. Esc no descarta nunca.
 *  - **Si el archivo cambio en el disco**, lo tuyo queda de solo lectura con el
 *    aviso: se descarta, o se pasa a la version nueva, que se carga en el
 *    cuadro con la lista de tus cambios arriba. Si ya no esta, o la version
 *    nueva no se puede editar, queda lo tuyo para copiarlo, y nada mas.
 *  - **La × de la tira** con algo sin guardar muestra el documento y pide
 *    confirmar aca.
 */
function FileEditor({
  title,
  editor,
  insertButton,
}: {
  title: string;
  editor: DocEditor;
  insertButton: ReactNode;
}): JSX.Element {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const edit = editor.edit;
  if (edit === null) return <></>;

  const changed = edit.text !== edit.opened;
  const conflict = edit.conflict;
  const canSave = changed && !edit.saving && conflict === null;
  const status = edit.saving ? t('docs.edit.saving') : changed ? t('docs.edit.unsaved') : t('docs.edit.noChanges');

  const cancel = (): void => {
    if (editor.unsaved) setConfirmingCancel(true);
    else editor.discard();
  };

  return (
    <div className="panel-body doc-viewer">
      <div className="doc-toolbar">
        <span className="doc-edit-status" title={title}>
          {t('docs.edit.editing', { name: title })}
          <span className="doc-edit-state"> · {status}</span>
        </span>
        <button className="link-button" onClick={cancel} disabled={edit.saving}>
          {t('docs.edit.cancel')}
        </button>
        <button className="primary-button primary-button-small" onClick={editor.save} disabled={!canSave} title={t('docs.edit.saveTitle')}>
          {t('docs.edit.save')}
        </button>
        {insertButton}
        <button className="icon-button" disabled title={t('docs.reload')}>
          ⟳
        </button>
      </div>

      {edit.closing && (
        <div className="note-closing doc-edit-bar">
          <span>{t('docs.edit.closeConfirm')}</span>
          <button className="link-button link-danger" onClick={editor.confirmClose}>
            {t('docs.edit.discardAndClose')}
          </button>
          <button className="link-button" onClick={editor.keepEditing}>
            {t('docs.edit.keepEditing')}
          </button>
        </div>
      )}

      {confirmingCancel && !edit.closing && (
        <div className="note-closing doc-edit-bar">
          <span>{t('docs.edit.discardConfirm')}</span>
          <button className="link-button link-danger" onClick={editor.discard}>
            {t('docs.edit.discard')}
          </button>
          <button className="link-button" onClick={() => setConfirmingCancel(false)}>
            {t('docs.edit.keepEditing')}
          </button>
        </div>
      )}

      {conflict !== null && (
        <div className="note-closing doc-edit-bar">
          <span>{conflict.next === null ? t('docs.edit.gone') : t('docs.edit.conflict')}</span>
          {conflict.next !== null && (
            <button className="primary-button primary-button-small" onClick={editor.adopt}>
              {t('docs.edit.adopt')}
            </button>
          )}
          <button className="link-button link-danger" onClick={editor.discard}>
            {t('docs.edit.discardMine')}
          </button>
        </div>
      )}

      {edit.failure !== null && (
        <div className="composer-problem doc-edit-bar">
          <span>{edit.failure.kind === 'lost' ? t('docs.edit.lost') : serverTextMessage(edit.failure.text)}</span>
        </div>
      )}

      {edit.pending !== null && (
        <div className="doc-changes">
          <div className="doc-changes-head">
            <span>{t('docs.edit.pending')}</span>
            <button className="link-button" onClick={editor.dismissPending}>
              {t('docs.edit.pendingDone')}
            </button>
          </div>
          <div className="doc-changes-body">
            <DiffLines lines={edit.pending} />
          </div>
        </div>
      )}

      <textarea
        className="doc-editor"
        value={edit.text}
        readOnly={conflict !== null || edit.saving}
        spellCheck={false}
        autoFocus
        aria-label={t('docs.edit.editing', { name: title })}
        onChange={(event) => editor.change(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') {
            event.preventDefault();
            if (canSave) editor.save();
          }
          event.stopPropagation();
        }}
      />
    </div>
  );
}
