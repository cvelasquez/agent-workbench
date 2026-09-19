/**
 * Qué idioma usar al abrir la app (§6.23).
 *
 * Puro: recibe la preferencia guardada y la lista de idiomas del navegador, y
 * no toca ni `navigator` ni `localStorage`, que en Node no son los del usuario
 * (Node 22 trae un `navigator` con el idioma de la máquina). Quien los lee es
 * `useLocale.ts`.
 */

import { LOCALES, defaultFormatTag, isLocale, type Locale } from './index.js';

export const LOCALE_STORAGE_KEY = 'agent-workbench.locale';

/** `auto` sigue al navegador; un idioma es una elección del usuario. */
export type LocalePreference = 'auto' | Locale;

export const DEFAULT_LOCALE_PREFERENCE: LocalePreference = 'auto';

/** Lo guardado, o null si no es una preferencia que esta versión conozca. */
export function parseLocalePreference(raw: string): LocalePreference | null {
  return raw === 'auto' || isLocale(raw) ? raw : null;
}

/**
 * El idioma de la app para una etiqueta del navegador, o null si no hay uno.
 *
 * Primero exacto (`pt-BR`), después por idioma (`es-PE` → `es`, `pt-PT` →
 * `pt-BR`). El chino tradicional no cae en simplificado: `zh-TW`, `zh-HK`,
 * `zh-MO` y `zh-Hant` dan null, y se prueba el siguiente idioma de la lista.
 */
export function matchLocale(tag: string): Locale | null {
  const normalized = tag.trim().replace(/_/g, '-').toLowerCase();
  if (normalized.length === 0) return null;
  const exact = LOCALES.find((locale) => locale.toLowerCase() === normalized);
  if (exact !== undefined) return exact;

  const [language = '', ...rest] = normalized.split('-');
  if (language === 'zh') {
    const traditional = rest.includes('hant') || rest.some((part) => part === 'tw' || part === 'hk' || part === 'mo');
    return traditional ? null : findLocale('zh-CN');
  }
  if (language === 'pt') return findLocale('pt-BR');
  return findLocale(language);
}

function findLocale(code: string): Locale | null {
  return isLocale(code) ? code : null;
}

/** El idioma a usar: el elegido, o el primero del navegador que haya, o inglés. */
export function resolveLocale(preference: LocalePreference, browserLanguages: readonly string[]): Locale {
  if (preference !== 'auto') return preference;
  for (const tag of browserLanguages) {
    const locale = matchLocale(tag);
    if (locale !== null) return locale;
  }
  return 'en';
}

/**
 * Con qué región se formatean fechas y números: la del navegador si es del
 * mismo idioma (`es-PE`, `en-GB`), y si no, la típica del idioma.
 *
 * Así, quien tiene el navegador en `es-PE` sigue viendo la hora como la veía
 * antes de que la app tuviera idiomas, cuando se formateaba con la del
 * navegador.
 */
export function resolveFormatTag(locale: Locale, browserLanguages: readonly string[]): string {
  for (const tag of browserLanguages) {
    if (matchLocale(tag) !== locale) continue;
    try {
      if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length > 0) return tag;
    } catch {
      // Una etiqueta mal formada: se sigue con la siguiente.
    }
  }
  return defaultFormatTag(locale);
}
