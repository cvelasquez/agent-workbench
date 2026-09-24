/**
 * Preferencias de la ventana.
 *
 * No van al servidor a proposito: son de esta pantalla, no del espacio de
 * trabajo. Dos ventanas abiertas pueden tener el panel de anchos distintos sin
 * pelearse.
 *
 * Van a una cookie del equipo y, de respaldo, a `localStorage`. Hasta la 0.4.0
 * iban solo a `localStorage`, que el navegador separa por puerto, y el puerto
 * cambia en cada arranque: se perdian todas al reiniciar la app. La cookie no
 * distingue puerto (`prefs-cookie.ts`). Al leer manda la cookie; si no trae la
 * clave, `localStorage`, y lo que se encuentra ahi pasa a la cookie: asi se
 * migra lo que ya estaba guardado en el puerto de hoy.
 *
 * `localStorage` puede lanzar —modo privado, permisos del navegador—, y la
 * cookie puede no escribirse, asi que todo va envuelto. Sin persistencia se
 * sigue trabajando igual: es una preferencia, no un dato.
 *
 * Vive aparte de `App.tsx` porque el cuadro de escritura, el tema, el idioma,
 * el sonido y las notas guardan por el mismo camino. Dos copias de esto es
 * como terminan divergiendo dos cosas que hacen lo mismo (§6.7).
 */

import { encodePrefsCookie, prefsCookieLine, readPrefsCookie } from './prefs-cookie.js';

/**
 * Lo que dice la cookie ahora. Se lee cada vez y no se guarda: otra ventana de
 * la app pudo cambiarla, y escribir sobre una copia vieja le borraria su cambio.
 */
function cookiePrefs(): Map<string, string> {
  try {
    return readPrefsCookie(document.cookie);
  } catch {
    return new Map();
  }
}

/** Cambia una clave de la cookie, sobre lo que dice ahora. */
function writeCookiePref(key: string, value: string): void {
  const prefs = cookiePrefs();
  if (prefs.get(key) === value) return;
  prefs.set(key, value);
  const encoded = encodePrefsCookie(prefs);
  if (encoded === null) return;
  try {
    document.cookie = prefsCookieLine(encoded);
  } catch {
    // Sin cookie queda `localStorage`, como antes.
  }
}

export function readStored<T>(key: string, fallback: T, parse: (raw: string) => T | null): T {
  const fromCookie = cookiePrefs().get(key);
  if (fromCookie !== undefined) {
    const parsed = parse(fromCookie);
    if (parsed !== null) return parsed;
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return fallback;
    const parsed = parse(raw);
    if (parsed === null) return fallback;
    // Guardado en este puerto y todavia no en la cookie: pasa, para el proximo arranque.
    if (fromCookie === undefined) writeCookiePref(key, raw);
    return parsed;
  } catch {
    return fallback;
  }
}

export function writeStored(key: string, value: string): void {
  writeCookiePref(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Sin persistencia se sigue igual: es una preferencia, no un dato.
  }
}

/** Un tamano guardado: entero y dentro de rango, o nada. */
export function parseStoredSize(raw: string, min: number, max: number): number | null {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}
