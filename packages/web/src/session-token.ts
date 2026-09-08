/**
 * Token de arranque.
 *
 * Llega en la URL que abre el servidor. Lo leemos una vez, lo guardamos en
 * memoria y limpiamos la barra de direcciones.
 *
 * Ojo con lo que sigue, porque ya rompio una vez: al limpiar la URL, **una
 * recarga se queda sin token**. Eso no es un problema porque para ese momento
 * el servidor ya emitio la cookie de sesion, y la cookie autentica igual el
 * WebSocket. Por eso `sessionToken` puede ser null sin que eso signifique que
 * no hay forma de conectarse: conectamos igual y que decida el servidor.
 */

import { TOKEN_QUERY_PARAM } from '@agent-workbench/shared';

function readAndScrubToken(): string | null {
  const params = new URLSearchParams(window.location.search);
  const token = params.get(TOKEN_QUERY_PARAM);
  if (token === null || token.length === 0) return null;

  params.delete(TOKEN_QUERY_PARAM);
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${query.length > 0 ? `?${query}` : ''}`,
  );
  return token;
}

/** null tras una recarga: en ese caso autentica la cookie. */
export const sessionToken: string | null = readAndScrubToken();
