/**
 * Elegir una carpeta para abrir un proyecto nuevo.
 *
 * Hasta el hito 18 no habia forma de empezar en una carpeta que la app no
 * conociera: la barra lista lo que esta en el historial de la CLI mas el
 * directorio desde el que se lanzo el servidor. Una carpeta nueva no aparecia
 * en ninguna lista.
 *
 * **El cliente no compone rutas.** Cada clic manda un `picker.enter` con *un
 * nombre del listado que el servidor acaba de mandar*, o un `..`, o el indice
 * de una raiz. La ruta absoluta la lleva el servidor y solo viaja para
 * mostrarla. Ver `directory-picker.ts`.
 *
 * Es un dialogo modal y no un panel: se abre, se elige y se cierra. Un panel
 * mas peleando por el ancho es justo lo que la seccion 6 evita.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryPickerListing, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

interface FolderPickerProps {
  connection: AgentConnection;
  /** Abre una pestana del agente en esa carpeta y cierra el dialogo. */
  onOpen: (cwd: string) => void;
  onClose: () => void;
}

export function FolderPicker({ connection, onOpen, onClose }: FolderPickerProps): JSX.Element {
  const [listing, setListing] = useState<DirectoryPickerListing | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const pickerId = useRef<string | null>(null);
  const createRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const offMessage = connection.onMessage((message: ServerMessage) => {
      if (message.type === 'picker.listing') {
        pickerId.current = message.listing.pickerId;
        setListing(message.listing);
        setProblem(null);
        setCreating(false);
        setDraftName('');
        return;
      }
      // Un error del selector se muestra en el dialogo y no en la barra de
      // arriba: pasa aca adentro y aca es donde se lo mira.
      if (message.type === 'error' && message.code === 'picker-failed') {
        setProblem(message.message);
      }
    });

    connection.send({ type: 'picker.open' });

    return () => {
      offMessage();
      const id = pickerId.current;
      if (id !== null) connection.send({ type: 'picker.close', pickerId: id });
    };
  }, [connection]);

  // Esc cierra, como cualquier dialogo. En captura, para llegar antes que los
  // atajos de la aplicacion.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useEffect(() => {
    if (creating) createRef.current?.focus();
  }, [creating]);

  const enter = useCallback(
    (name: string) => {
      const id = pickerId.current;
      if (id === null) return;
      connection.send({ type: 'picker.enter', pickerId: id, name });
    },
    [connection],
  );

  const goToRoot = useCallback(
    (rootIndex: number) => {
      const id = pickerId.current;
      if (id === null) return;
      connection.send({ type: 'picker.root', pickerId: id, rootIndex });
    },
    [connection],
  );

  const createFolder = useCallback(() => {
    const id = pickerId.current;
    const name = draftName.trim();
    if (id === null || name.length === 0) return;
    connection.send({ type: 'picker.create', pickerId: id, name });
  }, [connection, draftName]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal picker-modal"
        role="dialog"
        aria-label="Elegir la carpeta del proyecto"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <span className="modal-title">Proyecto nuevo</span>
          <button className="icon-button" onClick={onClose} title="Cerrar">
            ×
          </button>
        </header>

        {listing === null ? (
          <p className="panel-note">Leyendo el disco...</p>
        ) : (
          <>
            <div className="picker-roots">
              {listing.roots.map((root, index) => (
                <button
                  key={root}
                  className="picker-root"
                  onClick={() => goToRoot(index)}
                  title={`Ir a ${root}`}
                >
                  {root}
                </button>
              ))}
            </div>

            {/* La ruta se muestra, no se escribe: la lleva el servidor. */}
            <p className="picker-path" title={listing.path}>
              {listing.path}
            </p>

            <div className="picker-list">
              {listing.canGoUp && (
                <button className="picker-entry picker-up" onClick={() => enter('..')}>
                  ‹ carpeta superior
                </button>
              )}

              {listing.entries.length === 0 && !listing.canGoUp && (
                <p className="panel-note">No hay subcarpetas aca.</p>
              )}

              {listing.entries.map((name) => (
                <button key={name} className="picker-entry" onClick={() => enter(name)}>
                  {name}
                </button>
              ))}

              {listing.truncated && (
                <p className="panel-note">
                  Hay mas subcarpetas de las que entran en la lista. Entra a una para acotar.
                </p>
              )}
            </div>

            {problem !== null && <p className="picker-problem">{problem}</p>}

            <footer className="picker-footer">
              {creating ? (
                <div className="picker-create">
                  <input
                    ref={createRef}
                    className="picker-create-input"
                    value={draftName}
                    placeholder="Nombre de la carpeta"
                    onChange={(event) => setDraftName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') createFolder();
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setCreating(false);
                      }
                      // Que los atajos de la app no vean lo que se teclea aca.
                      event.stopPropagation();
                    }}
                    spellCheck={false}
                  />
                  <button className="link-button" onClick={createFolder}>
                    Crear
                  </button>
                  <button className="link-button" onClick={() => setCreating(false)}>
                    Cancelar
                  </button>
                </div>
              ) : (
                <button className="link-button" onClick={() => setCreating(true)}>
                  Crear una carpeta aca
                </button>
              )}

              <span className="composer-spacer" />

              <button
                className="picker-open"
                onClick={() => onOpen(listing.path)}
                title={`Abrir una pestana del agente en ${listing.path}`}
              >
                Abrir aca
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
