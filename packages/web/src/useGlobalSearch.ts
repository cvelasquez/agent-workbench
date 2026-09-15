/**
 * El buscador global (hito 29), del lado del navegador.
 *
 * Vive en `App` y no en la barra por lo mismo que la copia propia: la barra se
 * desmonta al esconderla, y lo encontrado tiene que seguir ahi al volver.
 *
 * Una busqueda por vez. Cada pedido lleva su `searchId` y lo que llega con otro
 * se descarta: el servidor ya cancela la anterior, pero una respuesta en viaje
 * puede cruzarse con el pedido nuevo.
 *
 * **Lo encontrado se ve mientras se busca.** El servidor recorre todas las
 * sesiones y manda los aciertos a medida que salen (`search.progress`); aca se
 * suman (`mergeSearchProgress`) y el resultado final los reemplaza. Volver a la
 * lista de la barra con una busqueda en camino la corta en el servidor
 * (`search.cancel`): seguir leyendo megas para nadie no tiene sentido.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { GlobalSearchResult, ServerMessage } from '@agent-workbench/shared';
import type { AgentConnection } from './connection.js';
import { mergeSearchProgress } from './global-search-ui.js';

export interface GlobalSearchApi {
  /** true hasta el resultado final, aunque ya haya aciertos a la vista. */
  searching: boolean;
  /** Lo que se tiene: parcial mientras `searching`, final despues. */
  result: GlobalSearchResult | null;
  error: string | null;
  /** Lo ultimo que se pidio, para volver a pedirlo si cambia "ver archivadas". */
  submitted: { query: string; includeArchived: boolean } | null;
  search: (query: string, includeArchived: boolean) => void;
  /** Vuelve a la lista de la barra, y corta en el servidor la busqueda en camino. */
  clear: () => void;
}

export function useGlobalSearch(connection: AgentConnection): GlobalSearchApi {
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<GlobalSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<GlobalSearchApi['submitted']>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    const offMessage = connection.onMessage((message: ServerMessage) => {
      switch (message.type) {
        case 'search.progress':
          if (current.current === null || message.searchId !== current.current) break;
          setResult((previous) => mergeSearchProgress(previous, message.progress));
          break;
        case 'search.results':
          if (current.current === null || message.searchId !== current.current) break;
          current.current = null;
          setResult(message.result);
          setError(null);
          setSearching(false);
          break;
        case 'error':
          if (message.code !== 'search-failed' || current.current === null || message.requestId !== current.current) break;
          current.current = null;
          if (message.detail !== undefined) console.error('[servidor]', message.detail);
          setResult(null);
          setError(message.message);
          setSearching(false);
          break;
        default:
          break;
      }
    });
    // `current` queda puesto solo mientras una busqueda esta en viaje. El
    // servidor cancela la de un socket que se cerro: esa no va a llegar.
    const offReopen = connection.onReopen(() => {
      if (current.current === null) return;
      current.current = null;
      setSearching(false);
      setError('Se cortó la conexión con el servidor: volvé a buscar.');
    });
    return () => {
      offMessage();
      offReopen();
    };
  }, [connection]);

  const search = useCallback(
    (query: string, includeArchived: boolean) => {
      const searchId = crypto.randomUUID();
      current.current = searchId;
      setSubmitted({ query, includeArchived });
      setSearching(true);
      setError(null);
      // Lo de la busqueda anterior no se mezcla con los avisos de esta.
      setResult(null);
      connection.send({ type: 'search.global', searchId, query, includeArchived });
    },
    [connection],
  );

  const clear = useCallback(() => {
    const inFlight = current.current;
    current.current = null;
    if (inFlight !== null) connection.send({ type: 'search.cancel', searchId: inFlight });
    setSubmitted(null);
    setSearching(false);
    setResult(null);
    setError(null);
  }, [connection]);

  return { searching, result, error, submitted, search, clear };
}
