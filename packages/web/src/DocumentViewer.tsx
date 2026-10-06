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
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { isMarkdownPath, resolveDocLink } from './doc-search.js';
import type { DocMode, OpenDoc } from './doc-tabs.js';
import { CodePreview, PreviewActions } from './FilePreviewView.js';
import { t } from './i18n/index.js';
import { Markdown } from './Markdown.js';
import type { DocContent } from './useDocuments.js';
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
