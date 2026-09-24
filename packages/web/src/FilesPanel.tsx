/**
 * Arbol de archivos del `cwd` de la pestana, con previsualizacion de solo
 * lectura.
 *
 * Decisiones que se ven en el codigo:
 *
 *  - **Un nivel por peticion.** Expandir una carpeta pide ese nivel y nada mas.
 *    El arbol completo de un repo real son cientos de miles de entradas.
 *  - **La previsualizacion reemplaza al arbol**, igual que el diff reemplaza a
 *    la lista de cambios: el panel es angosto y partirlo en dos deja las dos
 *    mitades inservibles.
 *  - **El menu contextual es la unica escritura del panel**, y ni siquiera
 *    escribe archivos: copia rutas, o le pasa una ruta a la terminal para que
 *    el usuario la mande cuando quiera. Nada de crear, renombrar ni borrar.
 *  - **Los botones de la fila aparecen al pasar el mouse**, no siempre. En un
 *    arbol de cincuenta filas, cincuenta iconos repetidos son ruido; en la fila
 *    que se esta mirando, son justo lo que se busca. Quedan visibles igual
 *    cuando la fila tiene el foco del teclado, para que no sean inalcanzables
 *    sin mouse.
 *  - **Cada tipo de fila ofrece lo que sirve para el.** Un archivo se nombra:
 *    lo que uno hace con un archivo del arbol es nombrarselo al agente, y para
 *    eso alcanza con la ruta. Un directorio ademas se abre en el explorador,
 *    que es lo unico que se puede hacer con una carpeta desde afuera.
 *  - **La ruta va directo al cuadro de escritura, entre comillas.** Hasta la
 *    0.4.0 el boton la copiaba y habia que pegarla, y lo que el usuario tenia
 *    en el portapapeles se perdia. Entre comillas porque `D:\Agent Workbench\...`
 *    sin ellas se corta en el primer espacio — es la misma razon por la que las
 *    imagenes pegadas se nombran `@"ruta"` (CLAUDE.md 5.3). El menu contextual
 *    sigue copiando las rutas crudas, para cuando el destino no es el chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryEntry } from '@agent-workbench/shared';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { FilePreviewView } from './FilePreviewView.js';
import { formatBytes } from './i18n/format.js';
import { t } from './i18n/index.js';
import { useLocale } from './i18n/useLocale.js';
import type { FilesView } from './useFiles.js';

interface MenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

/**
 * Icono de carpeta.
 *
 * SVG y no un emoji: los emoji de carpeta salen en color y con el tamano que
 * decide la fuente del sistema, que no es el mismo en Windows que en macOS.
 * Esto sigue a `currentColor` y encaja con el resto de los simbolos del panel.
 */
function FolderIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M1.5 3.5h4l1.2 1.6h7.8v7.4a1 1 0 0 1-1 1h-12a1 1 0 0 1-1-1V3.5z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Icono de copiar. Dos hojas superpuestas, el simbolo de siempre.
 */
function CopyIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        x="5.5"
        y="1.5"
        width="9"
        height="10"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M10.5 13.2v.3a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h.3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * El ojo de lo oculto.
 *
 * Abierto o tachado segun el estado, que es como se lee un ojo en cualquier
 * lado: no hace falta explicar cual es cual.
 */
function EyeIcon({ open }: { open: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M1.4 8S3.8 3.9 8 3.9 14.6 8 14.6 8 12.2 12.1 8 12.1 1.4 8 1.4 8z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.2" />
      {!open && (
        <path d="M2.6 13.4L13.4 2.6" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      )}
    </svg>
  );
}

/**
 * Icono de poner la ruta en el mensaje: una flecha que baja a una linea de
 * texto. No es el de copiar, porque ya no copia: deja la ruta en el cuadro.
 */
function InsertIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <rect
        x="1.5"
        y="10"
        width="13"
        height="4.5"
        rx="1.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M8 1.5v6.2M5.4 5.3L8 7.9l2.6-2.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Acuse de copiado. */
function CheckIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M3 8.5l3.2 3.2L13 4.8"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Boton con acuse: un tilde durante un segundo despues del clic.
 *
 * El acuse no es adorno: ni copiar al portapapeles ni poner la ruta en el
 * cuadro cambian nada alrededor del boton, y sin senal la unica forma de saber
 * si el clic hizo algo es ir a mirar a otro lado. Vuelve solo al icono normal,
 * asi que no deja la fila con un estado raro pegado.
 */
function AckButton({
  className,
  title,
  doneTitle,
  icon,
  onAction,
}: {
  className: string;
  title: string;
  doneTitle: string;
  icon: JSX.Element;
  onAction: () => void;
}): JSX.Element {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);

  // Un desmontaje a mitad del acuse —plegar la carpeta, abrir un archivo— no
  // debe dejar un timer buscando un componente que ya no existe.
  useEffect(() => {
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  const click = (event: React.MouseEvent): void => {
    event.stopPropagation();
    onAction();
    setDone(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1_200);
  };

  return (
    <button
      className={done ? `${className} tree-action-done` : className}
      onClick={click}
      title={done ? doneTitle : title}
    >
      {done ? <CheckIcon /> : icon}
    </button>
  );
}

/** Boton de copiar una ruta, con acuse. Lo usa la solapa Memoria. */
export function CopyPathButton({
  className,
  title,
  onCopy,
}: {
  className: string;
  title: string;
  onCopy: () => void;
}): JSX.Element {
  return (
    <AckButton
      className={className}
      title={title}
      doneTitle={t('common.copied')}
      icon={<CopyIcon />}
      onAction={onCopy}
    />
  );
}

/** Boton de poner una ruta en el cuadro de escritura, con acuse. */
function InsertPathButton({
  className,
  title,
  onInsert,
}: {
  className: string;
  title: string;
  onInsert: () => void;
}): JSX.Element {
  return (
    <AckButton
      className={className}
      title={title}
      doneTitle={t('files.pathInserted')}
      icon={<InsertIcon />}
      onAction={onInsert}
    />
  );
}

interface FilesPanelProps {
  view: FilesView;
  /** Directorio de la pestana. Solo para armar la ruta absoluta que se copia. */
  cwd: string;
  /** `process.platform` del servidor: decide el separador de la ruta absoluta. */
  platform: string;
  /**
   * Escribe texto en la terminal de la pestana, sin enviarlo. Sin el no se
   * ofrece "Insertar como @ruta".
   */
  onInsert?: (text: string) => void;
  /** Pone texto en el cuadro de escritura, donde esta el cursor. */
  onInsertPath: (text: string) => void;
  /**
   * Pide al servidor que abra la ruta con la aplicacion del sistema. null en una
   * ventana que entro como equipo remoto (hito 37): se abriria en el escritorio
   * del anfitrion, y no se ofrece.
   */
  onReveal: ((path: string) => void) | null;
}

export function FilesPanel({
  view,
  cwd,
  platform,
  onInsert,
  onInsertPath,
  onReveal,
}: FilesPanelProps): JSX.Element {
  const {
    listings,
    loading,
    preview,
    loadingPreview,
    closePreview,
    refresh,
    query,
    setQuery,
    showHidden,
    toggleHidden,
  } = view;
  const locale = useLocale();
  const [menu, setMenu] = useState<MenuState | null>(null);

  const separator = platform === 'win32' ? '\\' : '/';

  const absolutePathOf = useCallback(
    (relativePath: string): string => {
      const native = relativePath.split('/').join(separator);
      if (cwd.length === 0) return native;
      return cwd.endsWith(separator) ? `${cwd}${native}` : `${cwd}${separator}${native}`;
    },
    [cwd, separator],
  );

  const copy = useCallback((text: string) => {
    void navigator.clipboard.writeText(text).catch(() => undefined);
  }, []);

  /**
   * Lo que el boton de una fila deja en el cuadro de escritura.
   *
   * Lo mismo que copiaba hasta la 0.4.0, para que el agente reciba lo de
   * siempre: absoluta, que no depende de donde este parado, y entre comillas,
   * porque la ruta de este proyecto tiene un espacio y sin ellas se corta por
   * la mitad.
   */
  const insertQuoted = useCallback(
    (relativePath: string) => onInsertPath(`"${absolutePathOf(relativePath)}"`),
    [absolutePathOf, onInsertPath],
  );

  const openMenu = useCallback(
    (event: React.MouseEvent, relativePath: string) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          { label: t('files.menu.copyAbsolute'), onSelect: () => copy(absolutePathOf(relativePath)) },
          { label: t('files.menu.copyRelative'), onSelect: () => copy(relativePath) },
          ...(onInsert === undefined
            ? []
            : [
                {
                  // Se escribe en la terminal pero no se envia: la CLI expande
                  // la referencia y el usuario decide que pedir con ella.
                  label: t('files.menu.insertMention'),
                  onSelect: () => onInsert(`@${relativePath}`),
                },
              ]),
          ...(onReveal === null
            ? []
            : [
                {
                  // "Abrir con la app del sistema" y no "abrir en el editor": lo que
                  // se abre lo decide la asociacion de archivos de Windows, no
                  // nosotros. Verificado — un `.md` puede terminar en el navegador,
                  // y prometer un editor seria mentir sobre lo que hace el boton.
                  label: t('files.menu.openWithSystem'),
                  onSelect: () => onReveal(relativePath),
                },
              ]),
        ],
      });
    },
    [absolutePathOf, copy, onInsert, onReveal, locale],
  );

  if (preview !== null || loadingPreview) {
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closePreview}>
            {t('files.back')}
          </button>
          {preview !== null && (
            <span className="panel-subhead-title" title={preview.path}>
              {preview.path.split('/').pop()}
              <span className="panel-tagline"> {formatBytes(preview.sizeBytes)}</span>
            </span>
          )}
        </div>
        {loadingPreview ? (
          <p className="panel-note">{t('files.readingFile')}</p>
        ) : (
          preview !== null && (
            <FilePreviewView
              preview={preview}
              onOpenWithSystem={onReveal === null ? null : () => onReveal(preview.path)}
              onInsert={onInsert === undefined ? undefined : () => onInsert(`@${preview.path}`)}
            />
          )
        )}
        {menu !== null && (
          <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
        )}
      </div>
    );
  }

  const root = listings.get('');
  const searchingFor = query.trim();

  return (
    <div className="panel-body">
      <div className="panel-subhead">
        <span className="panel-subhead-title" title={cwd}>
          {cwd.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? cwd}
        </span>
        <InsertPathButton
          className="icon-button"
          title={t('files.insertFolderPath')}
          onInsert={() => insertQuoted('')}
        />
        <button
          className={showHidden ? 'icon-button icon-button-on' : 'icon-button'}
          onClick={toggleHidden}
          title={showHidden ? t('files.hidden.hide') : t('files.hidden.show')}
        >
          <EyeIcon open={showHidden} />
        </button>
        {onReveal !== null && (
          <button
            className="icon-button"
            onClick={() => onReveal('')}
            title={t('files.revealFolder')}
          >
            <FolderIcon />
          </button>
        )}
        <button className="icon-button" onClick={refresh} title={t('files.refresh')}>
          ⟳
        </button>
      </div>

      {/*
        La caja va arriba del arbol y no en la cabecera: es del contenido, no
        del panel, y con el texto escrito los resultados **reemplazan** al arbol
        —la misma regla que el diff y la previsualizacion, porque partir 640 px
        en dos deja las dos mitades inservibles.
      */}
      <div className="tree-search">
        <input
          className="tree-search-input"
          value={query}
          placeholder={t('files.search.placeholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query.length > 0) {
              event.stopPropagation();
              setQuery('');
            }
          }}
        />
        {query.length > 0 && (
          <button className="tree-search-clear" onClick={() => setQuery('')} title={t('files.search.clear')}>
            ×
          </button>
        )}
      </div>

      <div className="panel-scroll">
        {searchingFor.length > 0 ? (
          <SearchResults
            view={view}
            onContextMenu={openMenu}
            onReveal={onReveal}
            onInsertPath={insertQuoted}
          />
        ) : root === undefined ? (
          <p className="panel-note">
            {loading.has('') ? t('files.readingDir') : t('files.readDirFailed')}
          </p>
        ) : (
          <TreeLevel
            path=""
            depth={0}
            view={view}
            onContextMenu={openMenu}
            onReveal={onReveal}
            onInsertPath={insertQuoted}
          />
        )}
      </div>

      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

/**
 * Lo que encontro la busqueda: una lista plana, con la ruta de cada uno.
 *
 * Plana y no un arbol podado, porque lo que se busca esta a cualquier
 * profundidad y reconstruir las ramas intermedias solo agrega filas que nadie
 * pidio. La ruta va debajo del nombre, que es lo que desempata entre tres
 * `index.ts`.
 */
function SearchResults({
  view,
  onContextMenu,
  onReveal,
  onInsertPath,
}: {
  view: FilesView;
  onContextMenu: (event: React.MouseEvent, relativePath: string, kind: 'dir' | 'file') => void;
  onReveal: ((path: string) => void) | null;
  onInsertPath: (path: string) => void;
}): JSX.Element {
  const { results, searching, openFile, toggleDirectory } = view;

  if (results === null) {
    return <p className="panel-note">{searching ? t('files.search.searching') : t('files.search.prompt')}</p>;
  }

  if (results.entries.length === 0) {
    return <p className="panel-note">{t('files.search.none')}</p>;
  }

  return (
    <ul className="tree tree-results">
      {results.entries.map((entry) => (
        <li key={entry.path}>
          <div className="tree-item">
            <button
              className={`tree-row tree-row-${entry.kind}${
                entry.hidden === undefined ? '' : ' tree-row-hidden'
              }`}
              onClick={() =>
                entry.kind === 'dir' ? toggleDirectory(entry.path) : openFile(entry.path)
              }
              onContextMenu={(event) => onContextMenu(event, entry.path, entry.kind)}
              title={entry.path}
            >
              <span className="tree-chevron">{entry.kind === 'dir' ? '›' : ''}</span>
              <span className="tree-result">
                <span className="tree-name">{entry.name}</span>
                <span className="tree-result-path">{entry.path}</span>
              </span>
              {entry.kind === 'file' && (
                <span className="tree-size">{formatBytes(entry.sizeBytes)}</span>
              )}
            </button>

            <InsertPathButton
              className="tree-action"
              title={t('files.insertPath', { name: entry.name })}
              onInsert={() => onInsertPath(entry.path)}
            />

            {entry.kind === 'dir' && onReveal !== null && (
              <button
                className="tree-action"
                onClick={() => onReveal(entry.path)}
                title={t('files.reveal', { name: entry.name })}
              >
                <FolderIcon />
              </button>
            )}
          </div>
        </li>
      ))}

      {results.truncated && (
        <li className="tree-hidden" title={t('files.search.moreTitle')}>
          {t('files.search.more')}
        </li>
      )}
    </ul>
  );
}

interface TreeLevelProps {
  path: string;
  depth: number;
  view: FilesView;
  onContextMenu: (event: React.MouseEvent, relativePath: string, kind: 'dir' | 'file') => void;
  onReveal: ((path: string) => void) | null;
  onInsertPath: (path: string) => void;
}

function TreeLevel({
  path,
  depth,
  view,
  onContextMenu,
  onReveal,
  onInsertPath,
}: TreeLevelProps): JSX.Element | null {
  const { listings, loading } = view;
  const listing = listings.get(path);

  if (listing === undefined) {
    return loading.has(path) ? <div className="tree-loading">{t('files.loading')}</div> : null;
  }

  return (
    <ul className="tree">
      {listing.entries.map((entry) => (
        <TreeRow
          key={entry.path}
          entry={entry}
          depth={depth}
          view={view}
          onContextMenu={onContextMenu}
          onReveal={onReveal}
          onInsertPath={onInsertPath}
        />
      ))}

      {listing.entries.length === 0 && (
        <li className="tree-empty" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
          {listing.hiddenCount > 0 ? t('files.allHidden') : t('files.empty')}
        </li>
      )}

      {(listing.truncated || listing.hiddenCount > 0) && listing.entries.length > 0 && (
        <li
          className="tree-hidden"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          title={t('files.hiddenTitle')}
        >
          {listing.truncated
            ? t('files.moreEntries')
            : t('files.hiddenCount', { count: listing.hiddenCount })}
        </li>
      )}
    </ul>
  );
}

interface TreeRowProps {
  entry: DirectoryEntry;
  depth: number;
  view: FilesView;
  onContextMenu: (event: React.MouseEvent, relativePath: string, kind: 'dir' | 'file') => void;
  onReveal: ((path: string) => void) | null;
  onInsertPath: (path: string) => void;
}

function TreeRow({
  entry,
  depth,
  view,
  onContextMenu,
  onReveal,
  onInsertPath,
}: TreeRowProps): JSX.Element {
  const { expanded, toggleDirectory, openFile } = view;
  const isOpen = entry.kind === 'dir' && expanded.has(entry.path);

  return (
    <li>
      {/*
        La fila es un contenedor con dos botones y no un boton con otro adentro:
        un <button> anidado es HTML invalido y el navegador lo desarma, con lo
        que el clic de la fila deja de funcionar de formas dificiles de ver.
      */}
      <div className="tree-item">
        <button
          className={`tree-row tree-row-${entry.kind}${
            entry.hidden === undefined ? '' : ' tree-row-hidden'
          }`}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          onClick={() =>
            entry.kind === 'dir' ? toggleDirectory(entry.path) : openFile(entry.path)
          }
          onContextMenu={(event) => onContextMenu(event, entry.path, entry.kind)}
          title={
            entry.hidden === undefined
              ? entry.path
              : `${entry.path}\n${
                  entry.hidden === 'ignored' ? t('files.row.ignored') : t('files.row.alwaysHidden')
                }`
          }
        >
          <span className={`tree-chevron${isOpen ? ' tree-chevron-open' : ''}`}>
            {entry.kind === 'dir' ? '›' : ''}
          </span>
          <span className="tree-name">{entry.name}</span>
          {entry.kind === 'file' && (
            <span className="tree-size">{formatBytes(entry.sizeBytes)}</span>
          )}
        </button>

        {/*
          Poner la ruta en el mensaje va primero y esta en las dos clases de
          fila, asi que el boton mas usado cae siempre en el mismo lugar: no hay
          que mirar cual es cual antes de hacer clic.
        */}
        <InsertPathButton
          className="tree-action"
          title={t('files.insertPath', { name: entry.name })}
          onInsert={() => onInsertPath(entry.path)}
        />

        {entry.kind === 'dir' && onReveal !== null && (
          <button
            className="tree-action"
            onClick={() => onReveal(entry.path)}
            title={t('files.reveal', { name: entry.name })}
          >
            <FolderIcon />
          </button>
        )}
      </div>

      {isOpen && (
        <TreeLevel
          path={entry.path}
          depth={depth + 1}
          view={view}
          onContextMenu={onContextMenu}
          onReveal={onReveal}
          onInsertPath={onInsertPath}
        />
      )}
    </li>
  );
}
