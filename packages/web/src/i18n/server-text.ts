/**
 * Los textos que manda el servidor, en el idioma de la app (§6.23).
 *
 * El servidor manda una clave de `SERVER_TEXTS` (`shared/src/server-text.ts`)
 * con sus valores, y la frase vive en `server.<clave>` de cada idioma. Es el
 * unico sitio donde una clave se arma con `${}`: `check-i18n.mjs` cubre las del
 * servidor aparte, comparando la lista con los archivos.
 *
 * Puro, para `pnpm check`: los chequeos del servidor arman con esto la frase en
 * español y la comparan con la de siempre.
 */

import { isServerTextKey, type ServerText } from '@agent-workbench/shared';
import { t, type MessageKey, type MessageParams } from './index.js';

/**
 * La frase de un texto del servidor. Una clave que esta pagina no conoce —un
 * servidor mas nuevo— se muestra como viene: mejor eso que perder el aviso.
 *
 * Un valor que es otro texto del servidor ("no se pudo consultar git: <el
 * motivo>") se arma primero, en el mismo idioma.
 */
export function serverTextMessage(text: ServerText): string {
  if (!isServerTextKey(text.key)) return text.key;
  let params: MessageParams | undefined;
  if (text.params !== undefined) {
    const values: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(text.params)) {
      values[name] = typeof value === 'object' ? serverTextMessage(value) : value;
    }
    params = values;
  }
  return t(`server.${text.key}` as MessageKey, params);
}
