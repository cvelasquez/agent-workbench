/**
 * Los textos de la interfaz en varios idiomas (§6.23).
 *
 * Cada idioma es un JSON plano en `locales/`, con el formato de i18next: claves
 * con puntos, `{{valor}}` para lo que cambia y los sufijos `_one`, `_few`,
 * `_many` y `_other` para el plural. Este archivo es el motor: busca la clave,
 * elige el plural con `Intl.PluralRules` y reemplaza los valores.
 *
 * Puro, sin React ni `window`, para que `pnpm check` lo cargue en Node: los
 * chequeos fijan el español con `setLocale('es')` y comparan los textos de
 * siempre. Lo que depende del navegador —detectar el idioma, guardar la
 * preferencia, `<html lang>`— vive en `useLocale.ts`, y las reglas de la
 * detección, en `detect.ts`.
 *
 * `en.json` es la referencia: de ahí salen los tipos de las claves, y es el
 * respaldo de cualquier texto que le falte a otro idioma. Va siempre en el
 * paquete; los demás se descargan la primera vez que se eligen.
 */

import en from './locales/en.json';

/**
 * En el orden del menú (D7 del hito 34): inglés y español, los de siempre, y
 * después los demás por su nombre en su lengua, primero los de alfabeto
 * latino, luego el ruso y al final los de Asia.
 */
export const LOCALES = ['en', 'es', 'de', 'fr', 'pt-BR', 'ru', 'ja', 'ko', 'zh-CN'] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'en';

/** El nombre de cada idioma en su propia lengua: así se lo busca en un menú. */
export const LOCALE_NAMES: Readonly<Record<Locale, string>> = {
  en: 'English',
  es: 'Español',
  de: 'Deutsch',
  fr: 'Français',
  'pt-BR': 'Português (Brasil)',
  ru: 'Русский',
  ja: '日本語',
  ko: '한국어',
  'zh-CN': '简体中文',
};

/** Lo que muestra el botón de la cabecera. */
export const LOCALE_BADGES: Readonly<Record<Locale, string>> = {
  en: 'EN',
  es: 'ES',
  de: 'DE',
  fr: 'FR',
  'pt-BR': 'PT',
  ru: 'RU',
  ja: 'JA',
  ko: 'KO',
  'zh-CN': 'ZH',
};

/**
 * Con qué región se formatean fechas y números cuando el navegador no dice una
 * del mismo idioma. El español es el latinoamericano: escribe `5.0` con punto,
 * como la app escribió siempre; el de España escribiría `5,0`.
 */
const DEFAULT_FORMAT_TAGS: Readonly<Record<Locale, string>> = {
  en: 'en-US',
  es: 'es-419',
  de: 'de-DE',
  fr: 'fr-FR',
  'pt-BR': 'pt-BR',
  ru: 'ru-RU',
  ja: 'ja-JP',
  ko: 'ko-KR',
  'zh-CN': 'zh-CN',
};

type Dictionary = Readonly<Record<string, string>>;

type RawKey = keyof typeof en;

type StripPlural<K> = K extends `${infer Base}_${Intl.LDMLPluralRule}` ? Base : K;

/** Una clave de `en.json`, sin el sufijo del plural: `t('sidebar.sessions', { count })`. */
export type MessageKey = StripPlural<RawKey>;

export type MessageParams = Readonly<Record<string, string | number>>;

const LOADERS: Readonly<Record<Exclude<Locale, 'en'>, () => Promise<{ default: Dictionary }>>> = {
  es: () => import('./locales/es.json'),
  de: () => import('./locales/de.json'),
  fr: () => import('./locales/fr.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  ru: () => import('./locales/ru.json'),
  ja: () => import('./locales/ja.json'),
  ko: () => import('./locales/ko.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
};

const ENGLISH: Dictionary = en;

const dictionaries = new Map<Locale, Dictionary>([['en', ENGLISH]]);
const pluralRules = new Map<Locale, Intl.PluralRules>();
const listeners = new Set<() => void>();

let current: Locale = DEFAULT_LOCALE;
let formatTag: string = DEFAULT_FORMAT_TAGS[DEFAULT_LOCALE];
/** El último pedido de cambio: uno viejo que termina de cargar tarde no pisa al nuevo. */
let pending = 0;

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}

export function getLocale(): Locale {
  return current;
}

/** La etiqueta con la que se formatean fechas y números: `es-PE`, `en-GB`… */
export function getFormatTag(): string {
  return formatTag;
}

export function defaultFormatTag(locale: Locale): string {
  return DEFAULT_FORMAT_TAGS[locale];
}

/** Avisa cada vez que cambia el idioma o su región. Devuelve cómo dejar de escuchar. */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Cambia el idioma, cargando su archivo si hace falta.
 *
 * Rechaza si el archivo no carga, y el idioma queda como estaba. El inglés está
 * siempre, así que pasarle `'en'` no falla nunca.
 */
export async function setLocale(locale: Locale, tag: string = DEFAULT_FORMAT_TAGS[locale]): Promise<void> {
  const request = ++pending;
  if (!dictionaries.has(locale) && locale !== 'en') {
    const loaded = await LOADERS[locale]();
    dictionaries.set(locale, loaded.default);
  }
  if (request !== pending) return;
  if (current === locale && formatTag === tag) return;
  current = locale;
  formatTag = tag;
  for (const listener of listeners) listener();
}

function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/**
 * La frase de `key` en un diccionario, con el plural ya elegido, o undefined si
 * ese diccionario no la tiene.
 *
 * Con `count`, busca la forma que pide el idioma y, si no está, `_other`: en
 * español `Intl` pide `many` para un millón y nadie la escribe. Sin formas de
 * plural, la clave sola.
 */
function pick(dictionary: Dictionary, locale: Locale, key: string, count: number | undefined): string | undefined {
  if (count !== undefined) {
    const form = dictionary[`${key}_${pluralCategory(locale, count)}`] ?? dictionary[`${key}_other`];
    if (form !== undefined) return form;
  }
  return dictionary[key];
}

/**
 * La frase sin reemplazar los valores: en el idioma de `locale`, si no en
 * inglés, y si tampoco, la clave misma, que no debería verse porque el chequeo
 * lo impide (§6.23).
 *
 * Exportada con el diccionario como parámetro para que el chequeo pruebe el
 * respaldo con un idioma incompleto.
 */
export function resolveTemplate(
  dictionary: Dictionary | undefined,
  locale: Locale,
  key: string,
  params?: MessageParams,
): string {
  const raw = params?.['count'];
  const count = typeof raw === 'number' ? raw : undefined;
  return (
    (dictionary === undefined ? undefined : pick(dictionary, locale, key, count)) ??
    pick(ENGLISH, 'en', key, count) ??
    key
  );
}

/** Reemplaza cada `{{valor}}`. Uno que no vino queda escrito, para que se note. */
export function interpolate(text: string, params?: MessageParams): string {
  if (params === undefined) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** La frase cruda de `key` en el idioma actual, con el plural elegido. */
export function template(key: MessageKey, params?: MessageParams): string {
  return resolveTemplate(dictionaries.get(current), current, key, params);
}

/** El texto de `key` en el idioma actual. */
export function t(key: MessageKey, params?: MessageParams): string {
  return interpolate(template(key, params), params);
}
