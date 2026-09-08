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
 *  - **Cada tipo de fila ofrece lo que sirve para el.** Un archivo se copia:
 *    lo que uno hace con un archivo del arbol es nombrarselo al agente, y para
 *    eso alcanza con la ruta. Un directorio ademas se abre en el explorador,
 *    que es lo unico que se puede hacer con una carpeta desde afuera.
 *  - **La ruta se copia entre comillas.** Va a parar al cuadro de conversacion,
 *    y `D:\Agent Workbench\...` sin comillas se corta en el primer espacio —
 *    es la misma razon por la que las imagenes pegadas se nombran `@"ruta"`
 *    (CLAUDE.md 5.3). El menu contextual sigue dando las rutas crudas, para
 *    cuando el destino no es el chat.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryEntry } from '@agent-workbench/shared';
import { ContextMenu, type ContextMenuItem } from './ContextMenu.js';
import { FilePreviewView } from './FilePreviewView.js';
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
 * Boton de copiar con acuse.
 *
 * El acuse no es adorno: copiar al portapapeles no cambia nada en pantalla, y
 * sin senal la unica forma de saber si el clic hizo algo es ir a pegar a otro
 * lado. Vuelve solo al icono normal al segundo, asi que no deja la fila con un
 * estado raro pegado.
 */
function CopyPathButton({
  className,
  title,
  onCopy,
}: {
  className: string;
  title: string;
  onCopy: () => void;
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
    onCopy();
    setDone(true);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setDone(false), 1_200);
  };

  return (
    <button
      className={done ? `${className} tree-action-done` : className}
      onClick={click}
      title={done ? 'Copiado' : title}
    >
      {done ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.round(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

interface FilesPanelProps {
  view: FilesView;
  /** Directorio de la pestana. Solo para armar la ruta absoluta que se copia. */
  cwd: string;
  /** `process.platform` del servidor: decide el separador de la ruta absoluta. */
  platform: string;
  /** Escribe texto en la terminal de la pestana, sin enviarlo. */
  onInsert: (text: string) => void;
  /** Pide al servidor que abra la ruta con la aplicacion del sistema. */
  onReveal: (path: string) => void;
}

export function FilesPanel({
  view,
  cwd,
  platform,
  onInsert,
  onReveal,
}: FilesPanelProps): JSX.Element {
  const { listings, loading, preview, loadingPreview, closePreview, refresh } = view;
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
   * Lo que deja el boton de copiar de una fila.
   *
   * Absoluta y entre comillas: absoluta porque sirve igual pegada en el chat,
   * en otra terminal o en el explorador, y entre comillas porque la ruta de
   * este proyecto tiene un espacio y sin ellas el destino la corta por la
   * mitad.
   */
  const copyQuoted = useCallback(
    (relativePath: string) => copy(`"${absolutePathOf(relativePath)}"`),
    [absolutePathOf, copy],
  );

  const openMenu = useCallback(
    (event: React.MouseEvent, relativePath: string) => {
      event.preventDefault();
      event.stopPropagation();
      setMenu({
        x: event.clientX,
        y: event.clientY,
        items: [
          { label: 'Copiar ruta absoluta', onSelect: () => copy(absolutePathOf(relativePath)) },
          { label: 'Copiar ruta relativa', onSelect: () => copy(relativePath) },
          {
            // Se escribe en la terminal pero no se envia: la CLI expande la
            // referencia y el usuario decide que pedir con ella.
            label: 'Insertar como @ruta',
            onSelect: () => onInsert(`@${relativePath}`),
          },
          {
            // "Abrir con la app del sistema" y no "abrir en el editor": lo que
            // se abre lo decide la asociacion de archivos de Windows, no
            // nosotros. Verificado — un `.md` puede terminar en el navegador,
            // y prometer un editor seria mentir sobre lo que hace el boton.
            label: 'Abrir con la app del sistema',
            onSelect: () => onReveal(relativePath),
          },
        ],
      });
    },
    [absolutePathOf, copy, onInsert, onReveal],
  );

  if (preview !== null || loadingPreview) {
    return (
      <div className="panel-body">
        <div className="panel-subhead">
          <button className="link-button" onClick={closePreview}>
            ← Archivos
          </button>
          {preview !== null && (
            <span className="panel-subhead-title" title={preview.path}>
              {preview.path.split('/').pop()}
              <span className="panel-tagline"> {formatSize(preview.sizeBytes)}</span>
            </span>
          )}
        </div>
        {loadingPreview ? (
          <p className="panel-note">Leyendo el archivo…</p>
        ) : (
          preview !== null && <FilePreviewView preview={preview} />
        )}
        {menu !== null && (
          <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
        )}
      </div>
    );
  }

  const root = listings.get('');

  return (
    <div className="panel-body">
      <div className="panel-subhead">
        <span className="panel-subhead-title" title={cwd}>
          {cwd.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? cwd}
        </span>
        <CopyPathButton
          className="icon-button"
          title="Copiar la ruta de esta carpeta entre comillas"
          onCopy={() => copyQuoted('')}
        />
        <button
          className="icon-button"
          onClick={() => onReveal('')}
          title="Abrir esta carpeta en el explorador del sistema"
        >
          <FolderIcon />
        </button>
        <button className="icon-button" onClick={refresh} title="Releer el árbol">
          ⟳
        </button>
      </div>

      <div className="panel-scroll">
        {root === undefined ? (
          <p className="panel-note">
            {loading.has('') ? 'Leyendo el directorio…' : 'No se pudo leer el directorio.'}
          </p>
        ) : (
          <TreeLevel
            path=""
            depth={0}
            view={view}
            onContextMenu={openMenu}
            onReveal={onReveal}
            onCopyPath={copyQuoted}
          />
        )}
      </div>

      {menu !== null && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}

interface TreeLevelProps {
  path: string;
  depth: number;
  view: FilesView;
  onContextMenu: (event: React.MouseEvent, relativePath: string, kind: 'dir' | 'file') => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
}

function TreeLevel({
  path,
  depth,
  view,
  onContextMenu,
  onReveal,
  onCopyPath,
}: TreeLevelProps): JSX.Element | null {
  const { listings, loading } = view;
  const listing = listings.get(path);

  if (listing === undefined) {
    return loading.has(path) ? <div className="tree-loading">cargando…</div> : null;
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
          onCopyPath={onCopyPath}
        />
      ))}

      {listing.entries.length === 0 && (
        <li className="tree-empty" style={{ paddingLeft: `${depth * 12 + 8}px` }}>
          {listing.hiddenCount > 0 ? 'todo el contenido está oculto' : 'vacío'}
        </li>
      )}

      {(listing.truncated || listing.hiddenCount > 0) && listing.entries.length > 0 && (
        <li
          className="tree-hidden"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          title="Se ocultan .git, node_modules, dist, bin, obj y lo que diga .gitignore"
        >
          {listing.truncated
            ? 'hay más entradas de las que se muestran'
            : `${listing.hiddenCount} oculto(s)`}
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
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
}

function TreeRow({
  entry,
  depth,
  view,
  onContextMenu,
  onReveal,
  onCopyPath,
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
          className={`tree-row tree-row-${entry.kind}`}
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
          onClick={() =>
            entry.kind === 'dir' ? toggleDirectory(entry.path) : openFile(entry.path)
          }
          onContextMenu={(event) => onContextMenu(event, entry.path, entry.kind)}
          title={entry.path}
        >
          <span className={`tree-chevron${isOpen ? ' tree-chevron-open' : ''}`}>
            {entry.kind === 'dir' ? '›' : ''}
          </span>
          <span className="tree-name">{entry.name}</span>
          {entry.kind === 'file' && (
            <span className="tree-size">{formatSize(entry.sizeBytes)}</span>
          )}
        </button>

        {/*
          Copiar va primero y esta en las dos clases de fila, asi que el boton
          mas usado cae siempre en el mismo lugar: no hay que mirar cual es
          cual antes de hacer clic.
        */}
        <CopyPathButton
          className="tree-action"
          title={`Copiar la ruta de ${entry.name} entre comillas`}
          onCopy={() => onCopyPath(entry.path)}
        />

        {entry.kind === 'dir' && (
          <button
            className="tree-action"
            onClick={() => onReveal(entry.path)}
            title={`Abrir ${entry.name} en el explorador del sistema`}
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
          onCopyPath={onCopyPath}
        />
      )}
    </li>
  );
}
