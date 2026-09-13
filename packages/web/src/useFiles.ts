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
 *
 * Dos cosas que no son del arbol y viven aca porque comparten pestana y ojo:
 * la **busqueda por nombre**, que es lo unico que mira mas de un nivel, y el
 * interruptor de **lo oculto**, que cambia lo que devuelve cada nivel y por eso
 * obliga a releerlos todos.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DirectoryListing,
  FilePreview,
  FileSearchResult,
  TerminalId,
} from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { readStored, writeStored } from './window-prefs.js';

/**
 * Espera entre la ultima tecla y la busqueda.
 *
 * La busqueda recorre directorios de verdad: mandarla en cada tecla dispara
 * ocho recorridos para escribir "monitor". Con 200 ms sigue pareciendo
 * instantanea y sale una sola.
 */
const SEARCH_DEBOUNCE_MS = 200;

const HIDDEN_KEY = 'agent-workbench.files.hidden';

export interface FilesView {
  /** Nivel cargado, por ruta relativa. La raiz es ''. */
  listings: ReadonlyMap<string, DirectoryListing>;
  expanded: ReadonlySet<string>;
  loading: ReadonlySet<string>;
  preview: FilePreview | null;
  loadingPreview: boolean;
  /** Lo que se escribio en la caja de busqueda. Vacio = se ve el arbol. */
  query: string;
  setQuery: (query: string) => void;
  /** Resultados de la busqueda vigente, o null si todavia no llegaron. */
  results: FileSearchResult | null;
  searching: boolean;
  /** true si se ven tambien las entradas que se ocultan solas. */
  showHidden: boolean;
  toggleHidden: () => void;
  toggleDirectory: (path: string) => void;
  openFile: (path: string) => void;
  closePreview: () => void;
  refresh: () => void;
}

export function useFiles(connection: AgentConnection, terminalId: TerminalId | null): FilesView {
  const [listings, setListings] = useState<Map<string, DirectoryListing>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileSearchResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [showHidden, setShowHidden] = useState(() =>
    readStored<boolean>(HIDDEN_KEY, false, (raw) => (raw === 'true' ? true : raw === 'false' ? false : null)),
  );

  // Lo que se pidio pero todavia no llego. En un ref porque solo sirve para no
  // pedir dos veces lo mismo; no cambia nada de lo que se dibuja.
  const requested = useRef(new Set<string>());
  // El ojo, para los envios que salen de un callback viejo.
  const hiddenRef = useRef(showHidden);
  hiddenRef.current = showHidden;

  const request = useCallback(
    (path: string) => {
      if (terminalId === null || requested.current.has(path)) return;
      requested.current.add(path);
      setLoading((current) => new Set(current).add(path));
      connection.send({
        type: 'files.list',
        terminalId,
        path,
        includeHidden: hiddenRef.current,
      });
    },
    [connection, terminalId],
  );

  useEffect(() => {
    setListings(new Map());
    setExpanded(new Set());
    setLoading(new Set());
    setPreview(null);
    setLoadingPreview(false);
    setQuery('');
    setResults(null);
    setSearching(false);
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
        case 'files.results':
          if (message.terminalId !== terminalId) break;
          // Una respuesta de una consulta que ya no se esta escribiendo se
          // descarta: con el debounce es raro, pero llega si el disco tarda.
          setResults(message.result);
          setSearching(false);
          break;
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
          setSearching(false);
          break;
        default:
          break;
      }
    });

    connection.send({
      type: 'files.list',
      terminalId,
      path: '',
      includeHidden: hiddenRef.current,
    });
    requested.current.add('');
    setLoading(new Set(['']));

    const offReopen = connection.onReopen(() => {
      requested.current = new Set();
      connection.send({
        type: 'files.list',
        terminalId,
        path: '',
        includeHidden: hiddenRef.current,
      });
    });

    return () => {
      offMessage();
      offReopen();
    };
  }, [connection, terminalId]);

  // La busqueda sale sola al dejar de escribir. El texto vacio no pide nada:
  // limpia los resultados y devuelve el arbol.
  useEffect(() => {
    const needle = query.trim();
    if (terminalId === null || needle.length === 0) {
      setResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    const timer = window.setTimeout(() => {
      connection.send({
        type: 'files.search',
        terminalId,
        query: needle,
        includeHidden: hiddenRef.current,
      });
    }, SEARCH_DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [connection, terminalId, query, showHidden]);

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
      connection.send({
        type: 'files.list',
        terminalId,
        path,
        includeHidden: hiddenRef.current,
      });
    }
    setLoading(new Set(paths));
  }, [connection, terminalId, expanded]);

  /**
   * Prende o apaga el ojo, y relee.
   *
   * Releer no es opcional: lo oculto no viene marcado y descartado del lado del
   * cliente, no viaja. Es lo que evita que abrir un `node_modules` sin querer
   * mande decenas de miles de entradas por el socket cada vez.
   */
  const toggleHidden = useCallback(() => {
    setShowHidden((current) => {
      const next = !current;
      hiddenRef.current = next;
      writeStored(HIDDEN_KEY, String(next));
      if (terminalId !== null) {
        requested.current = new Set();
        const paths = ['', ...expanded];
        for (const path of paths) {
          requested.current.add(path);
          connection.send({ type: 'files.list', terminalId, path, includeHidden: next });
        }
        setLoading(new Set(paths));
      }
      return next;
    });
  }, [connection, terminalId, expanded]);

  return {
    listings,
    expanded,
    loading,
    preview,
    loadingPreview,
    query,
    setQuery,
    results,
    searching,
    showHidden,
    toggleHidden,
    toggleDirectory,
    openFile,
    closePreview,
    refresh,
  };
}
