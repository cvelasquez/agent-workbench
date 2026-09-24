/**
 * Las preferencias de la ventana, en una cookie del equipo.
 *
 * Iban solo a `localStorage`, que el navegador separa por origen, y el origen
 * lleva el puerto. El puerto cambia en cada arranque (§2.4; con el acceso
 * remoto es fijo, pero cae a uno efimero si esta ocupado al arrancar), asi que
 * cada arranque empezaba de cero: idioma, volumen, tema, letra, anchos. Las
 * cookies no distinguen puerto, y la misma vale de un arranque al siguiente.
 *
 * No lleva nada sensible —valores como `es`, `0.35` o `640`— y el servidor no
 * la lee. Cada navegador, y el telefono, tiene la suya.
 *
 * Puro y sin DOM, para que `pnpm check` lo pueda importar
 * (`check-composer-input.mjs`). Lo que toca el navegador vive en
 * `window-prefs.ts`.
 */

export const PREFS_COOKIE = 'agent_workbench_prefs';

/** El prefijo de las claves de `localStorage`. En la cookie van sin el: pesa menos. */
const KEY_PREFIX = 'agent-workbench.';

/** Una clave como las de la app, sin el prefijo. Lo demas no se lee. */
const SHORT_KEY = /^[a-z0-9][a-z0-9.-]{0,59}$/;

/** El valor mas largo que se acepta: el mas largo de hoy es el id de una nota. */
const MAX_VALUE_LENGTH = 200;

/** 400 dias: el tope que aceptan los navegadores. Se renueva en cada cambio. */
export const PREFS_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/**
 * El tope del valor. Un navegador acepta 4096 bytes por cookie con el nombre, y
 * esta viaja en cada peticion a este equipo: pasado el tope no se escribe, y
 * las preferencias quedan solo en `localStorage`, como antes.
 */
export const PREFS_COOKIE_MAX_BYTES = 3500;

/**
 * Las preferencias de la cookie, por clave de `localStorage`, a partir de
 * `document.cookie`. Sin cookie, ilegible o con otra forma, ninguna: cada una
 * vuelve a su valor por defecto, que es lo que pasaba antes en cada arranque.
 * Otra pagina de `127.0.0.1` puede escribirla, asi que se lee con desconfianza:
 * solo claves con forma de clave y textos cortos, y cada preferencia valida el
 * suyo al leerlo.
 */
export function readPrefsCookie(cookieHeader: string): Map<string, string> {
  const prefs = new Map<string, string>();
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1 || pair.slice(0, separator).trim() !== PREFS_COOKIE) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeURIComponent(pair.slice(separator + 1).trim()));
    } catch {
      return prefs;
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return prefs;
    for (const [key, value] of Object.entries(parsed)) {
      if (!SHORT_KEY.test(key) || typeof value !== 'string' || value.length > MAX_VALUE_LENGTH) continue;
      prefs.set(`${KEY_PREFIX}${key}`, value);
    }
    return prefs;
  }
  return prefs;
}

/**
 * El valor de la cookie con estas preferencias, o null si pasaria el tope. Solo
 * entran las claves de la app (`agent-workbench.*`).
 */
export function encodePrefsCookie(prefs: ReadonlyMap<string, string>): string | null {
  const compact: Record<string, string> = {};
  for (const [key, value] of prefs) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const short = key.slice(KEY_PREFIX.length);
    if (!SHORT_KEY.test(short) || value.length > MAX_VALUE_LENGTH) continue;
    compact[short] = value;
  }
  const encoded = encodeURIComponent(JSON.stringify(compact));
  return encoded.length > PREFS_COOKIE_MAX_BYTES ? null : encoded;
}

/**
 * Lo que se asigna a `document.cookie`. Sin `Domain`, vale solo para este
 * equipo —`127.0.0.1` o `localhost`, el que haya abierto la app— y para
 * cualquier puerto. `SameSite=Strict`, como la cookie de sesion.
 */
export function prefsCookieLine(encoded: string): string {
  return `${PREFS_COOKIE}=${encoded}; Path=/; Max-Age=${PREFS_COOKIE_MAX_AGE_S}; SameSite=Strict`;
}
