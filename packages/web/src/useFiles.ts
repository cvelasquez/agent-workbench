/**
 * Arbol de archivos del `cwd` de la pestana visible.
 *
 * Carga perezosa por nivel: expandir una carpeta pide ese nivel y nada mas. Lo
 * que ya se pidio queda en memoria mientras la pestana siga siendo la visible;
 * volver a abrir una carpeta no vuelve a golpear el disco.
 *
 * Las rutas son siempre relativas al `cwd` y con `/`. La raiz es la cadena
 * vacia. El cliente no construye rutas absolutas ni las manda: es el servidor
 * el que decide que hay adentro del `cwd`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryListing, FilePreview, TerminalId } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';

export interface FilesView {
  /** Nivel cargado, por ruta relativa. La raiz es ''. */
  listings: ReadonlyMap<string, DirectoryListing>;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  preview: FilePreview | null;
  loadingPreview: boolean;
  toggleDirectory: (path: string) => void;
  openFile: (path: string) => void;
  closePreview: () => void;
  refresh: () => void;
}

export function useFiles(
  connection: AgentConnection,
  terminalId: TerminalId | null,
): FilesView {
  const [listings, setListings] = useState<Map<string, DirectoryListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Lo que se pidio pero todavia no llego. En un ref porque solo sirve para no
  // pedir dos veces lo mismo; no cambia nada de lo que se dibuja.
  const requested = useRef(new Set<string>());

  const request = useCallback(
    (path: string) => {
      if (terminalId === null || requested.current.has(path)) return;
      requested.current.add(path);
      setLoading((current) => new Set(current).add(path));
      connection.send({ type: 'files.list', terminalId, path });
    },
    [connection, terminalId],
  );

  useEffect(() => {
    setListings(new Map());
    setExpanded(new Set());
    setLoading(new Set());
    setPreview(null);
    setLoadingPreview(false);
    requested.current = new Set();

    if (terminalId === null) return;

    const offMessage = connection.onMessage((message) => {
      switch (message.type) {
        case 'files.listing': {
          if (message.terminalId !== terminalId) break;
          const { listing } = message;
          requested.current.delete(listing.path);
          setListings((current) => new Map(current).set(listing.path, listing));
          setLoading((current) => {
            const next = new Set(current);
            next.delete(listing.path);
            return next;
          });
          break;
        }
        case 'files.preview':
          if (message.terminalId !== terminalId) break;
          setPreview(message.preview);
          setLoadingPreview(false);
          break;
        case 'error':
          // Un nivel o un archivo que fallan no pueden dejar indicadores de
          // carga encendidos para siempre.
          requested.current = new Set();
          setLoading(new Set());
          setLoadingPreview(false);
          break;
        default:
          break;
      }
    });

    connection.send({ type: 'files.list', terminalId, path: '' });
    requested.current.add('');
    setLoading(new Set(['']));

    const offReopen = connection.onReopen(() => {
      requested.current = new Set();
      connection.send({ type: 'files.list', terminalId, path: '' });
    });

    return () => {
      offMessage();
      offReopen();
    };
  }, [connection, terminalId]);

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          request(path);
        }
        return next;
      });
    },
    [request],
  );

  const openFile = useCallback(
    (path: string) => {
      if (terminalId === null) return;
      setLoadingPreview(true);
      setPreview(null);
      connection.send({ type: 'files.read', terminalId, path });
    },
    [connection, terminalId],
  );

  const closePreview = useCallback(() => {
    setPreview(null);
    setLoadingPreview(false);
  }, []);

  /** Relee todos los niveles abiertos. El agente pudo crear archivos nuevos. */
  const refresh = useCallback(() => {
    if (terminalId === null) return;
    requested.current = new Set();
    const paths = ['', ...expanded];
    for (const path of paths) {
      requested.current.add(path);
      connection.send({ type: 'files.list', terminalId, path });
    }
    setLoading(new Set(paths));
  }, [connection, terminalId, expanded]);

  return {
    listings,
    expanded,
    loading,
    preview,
    loadingPreview,
    toggleDirectory,
    openFile,
    closePreview,
    refresh,
  };
}
