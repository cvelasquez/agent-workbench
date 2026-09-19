/**
 * El idioma en el navegador (§6.23): detectarlo al abrir, guardar la elección,
 * `<html lang>` y volver a pintar al cambiar.
 *
 * La preferencia va a `localStorage`, como el tema: es de esta pantalla, no del
 * servidor ni del sistema. Dos ventanas pueden tener idiomas distintos.
 *
 * Cambiar de idioma no recarga la página: `App` escucha con `useLocale()` y
 * vuelve a pintar desde la raíz. Así sobreviven los borradores del cuadro de
 * escritura, que viven en memoria. Ningún componente usa `React.memo`; un
 * `useMemo` que arma texto tiene que tener el idioma entre sus dependencias.
 */

import { useSyncExternalStore } from 'react';
import {
  DEFAULT_LOCALE_PREFERENCE,
  LOCALE_STORAGE_KEY,
  parseLocalePreference,
  resolveFormatTag,
  resolveLocale,
  type LocalePreference,
} from './detect.js';
import { getLocale, setLocale, subscribe, type Locale } from './index.js';
import { readStored, writeStored } from '../window-prefs.js';

let preference: LocalePreference = DEFAULT_LOCALE_PREFERENCE;
const preferenceListeners = new Set<() => void>();

function browserLanguages(): readonly string[] {
  if (Array.isArray(navigator.languages) && navigator.languages.length > 0) return navigator.languages;
  return typeof navigator.language === 'string' ? [navigator.language] : [];
}

/** El idioma que daría "Automático" en este navegador. */
export function browserLocale(): Locale {
  return resolveLocale('auto', browserLanguages());
}

async function apply(next: LocalePreference): Promise<void> {
  const languages = browserLanguages();
  const locale = resolveLocale(next, languages);
  await setLocale(locale, resolveFormatTag(locale, languages));
}

/**
 * Antes de pintar nada: lee la preferencia y carga su idioma. Si el archivo no
 * carga, la app abre en inglés, que viene siempre en el paquete.
 */
export async function initLocale(): Promise<void> {
  preference = readStored(LOCALE_STORAGE_KEY, DEFAULT_LOCALE_PREFERENCE, parseLocalePreference);
  try {
    await apply(preference);
  } catch {
    await setLocale('en', resolveFormatTag('en', browserLanguages()));
  }
  // El atributo no es cosmético: con los mismos caracteres, el navegador elige
  // la tipografía china o la japonesa según `lang`.
  document.documentElement.lang = getLocale();
  subscribe(() => {
    document.documentElement.lang = getLocale();
  });
}

/**
 * Lo que elige el menú. Se guarda solo si el idioma cargó: si su archivo no
 * llega, la app sigue como estaba y la elección no queda escrita.
 */
export async function changeLocalePreference(next: LocalePreference): Promise<void> {
  await apply(next);
  preference = next;
  writeStored(LOCALE_STORAGE_KEY, next);
  for (const listener of preferenceListeners) listener();
}

function subscribePreference(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

function getPreference(): LocalePreference {
  return preference;
}

/** El idioma actual; el componente vuelve a pintarse cuando cambia. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale);
}

/** Lo elegido en el menú, `auto` incluido. */
export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribePreference, getPreference);
}
