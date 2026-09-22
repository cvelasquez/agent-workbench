/**
 * Lo que la direccion trae al cargar, leido una sola vez y quitado de la barra.
 *
 * El token de arranque viaja en la URL que abre el servidor. Se lee al cargar y
 * se limpia con `replaceState` para que no quede en el historial ni en un
 * marcador. **Una recarga llega sin token**, y eso esta bien: para entonces
 * existe la cookie de sesion, que autentica igual (CLAUDE.md 3.0).
 *
 * Desde el hito 38 viaja tambien `tab`, la pestaña que hay que activar: es lo
 * que abre el aviso del telefono, y sirve igual en la PC. Se quita por lo
 * mismo: una recarga no tiene por que volver a esa pestaña.
 */

import { TOKEN_QUERY_PARAM } from '@agent-workbench/shared';
import { TAB_QUERY_PARAM, readTabParam, withoutParams } from './narrow-layout.js';

function readAndScrub(): { token: string | null; tab: string | null } {
  const search = window.location.search;
  const rawToken = new URLSearchParams(search).get(TOKEN_QUERY_PARAM);
  const token = rawToken !== null && rawToken.length > 0 ? rawToken : null;
  const tab = readTabParam(search);
  if (token === null && tab === null) return { token, tab };

  window.history.replaceState(
    null,
    '',
    `${window.location.pathname}${withoutParams(search, [TOKEN_QUERY_PARAM, TAB_QUERY_PARAM])}`,
  );
  return { token, tab };
}

const loaded = readAndScrub();

export const sessionToken: string | null = loaded.token;

/** La pestaña que pidio la direccion, o null. Se aplica cuando llega la lista. */
export const requestedTab: string | null = loaded.tab;
