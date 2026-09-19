/**
 * Chequeo de los idiomas de la interfaz (§6.23).
 *
 *   npx tsx scripts/check-i18n.mjs
 *
 * Lo que se rompe en silencio: una clave que le falta a un idioma (se ve en
 * inglés y nadie lo nota), un `{{valor}}` mal escrito en una traducción (sale
 * literal), un plural ruso con dos formas en vez de cuatro, una clave que ya
 * nadie usa, una armada con `${}` que el tipo no ve, o un `t()` que no pasa un
 * valor que la frase necesita.
 *
 * Lee los JSON como archivos y el código con `typescript`, y carga el motor de
 * la web, que no tiene React ni toca el navegador.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LOCALES,
  LOCALE_BADGES,
  LOCALE_NAMES,
  defaultFormatTag,
  getLocale,
  interpolate,
  resolveTemplate,
  setLocale,
  subscribe,
  t,
} from '../../web/src/i18n/index.ts';
import {
  matchLocale,
  parseLocalePreference,
  resolveFormatTag,
  resolveLocale,
} from '../../web/src/i18n/detect.ts';
import {
  formatBytes,
  formatDuration,
  formatList,
  formatRoughDuration,
  formatWhen,
} from '../../web/src/i18n/format.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WEB_SRC = join(ROOT, 'packages', 'web', 'src');
const LOCALES_DIR = join(WEB_SRC, 'i18n', 'locales');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const list = (items, max = 8) => items.slice(0, max).join(', ') + (items.length > max ? ` (+${items.length - max})` : '');

// --- A. Los archivos -----------------------------------------------------------

const files = readdirSync(LOCALES_DIR).filter((name) => name.endsWith('.json')).sort();
const expected = LOCALES.map((locale) => `${locale}.json`).sort();
check('A1 hay un archivo por idioma, y ninguno de más',
  JSON.stringify(files) === JSON.stringify(expected), `${files.join(' ')} / ${expected.join(' ')}`);

const raw = new Map(LOCALES.map((locale) => [locale, readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf8')]));
const dicts = new Map(LOCALES.map((locale) => [locale, JSON.parse(raw.get(locale))]));

{
  const bad = [];
  for (const [locale, dict] of dicts) {
    for (const [key, value] of Object.entries(dict)) if (typeof value !== 'string') bad.push(`${locale}:${key}`);
  }
  check('A2 cada archivo es un objeto plano de textos', bad.length === 0, list(bad));
}

{
  // Ordenados y con la forma de JSON.stringify: el diff de un texto nuevo es
  // una línea en su lugar, no el archivo entero.
  const messy = [];
  for (const [locale, dict] of dicts) {
    const sorted = Object.fromEntries(Object.entries(dict).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    const canonical = JSON.stringify(sorted, null, 2) + '\n';
    if (raw.get(locale).replace(/\r\n/g, '\n') !== canonical) messy.push(locale);
  }
  check('A3 las claves están ordenadas y el formato es el de siempre', messy.length === 0, list(messy));
}

// --- B. Las mismas claves, los mismos valores, los plurales -------------------

const PLURAL = /_(zero|one|two|few|many|other)$/;

/** base → { plain: texto } o { forms: Map(categoría → texto) } */
function shapeOf(dict) {
  const shape = new Map();
  for (const [key, value] of Object.entries(dict)) {
    const match = PLURAL.exec(key);
    const base = match === null ? key : key.slice(0, match.index);
    const entry = shape.get(base) ?? { plain: undefined, forms: new Map() };
    if (match === null) entry.plain = value;
    else entry.forms.set(match[1], value);
    shape.set(base, entry);
  }
  return shape;
}

/** Las formas que un idioma usa para los enteros del 0 al 1000, más `other`. */
function requiredForms(locale) {
  const rules = new Intl.PluralRules(locale);
  const used = new Set(['other']);
  for (let n = 0; n <= 1000; n++) used.add(rules.select(n));
  return used;
}

const names = (text) => new Set([...text.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map((m) => m[1]));
const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const KNOWN_TAGS = /<\/?(code|kbd|b|strong|em)>|<br\s*\/?>/g;
const tagsOf = (text) => [...text.matchAll(KNOWN_TAGS)].map((m) => m[0].replace(/\s/g, '')).sort().join(' ');

const shapes = new Map([...dicts].map(([locale, dict]) => [locale, shapeOf(dict)]));
const english = shapes.get('en');

{
  const mixed = [];
  for (const [locale, shape] of shapes) {
    for (const [base, entry] of shape) if (entry.plain !== undefined && entry.forms.size > 0) mixed.push(`${locale}:${base}`);
  }
  check('B1 ninguna clave es a la vez plural y simple', mixed.length === 0, list(mixed));
}

for (const locale of LOCALES) {
  if (locale === 'en') continue;
  const shape = shapes.get(locale);
  const missing = [...english.keys()].filter((base) => !shape.has(base));
  const extra = [...shape.keys()].filter((base) => !english.has(base));
  check(`B2 ${locale}: tiene todas las claves del inglés`, missing.length === 0, list(missing));
  check(`B3 ${locale}: no tiene claves que el inglés no tenga`, extra.length === 0, list(extra));
}

for (const locale of LOCALES) {
  const shape = shapes.get(locale);
  const required = requiredForms(locale);
  const allowed = new Set(new Intl.PluralRules(locale).resolvedOptions().pluralCategories);
  const wrongKind = [];
  const missingForms = [];
  const foreignForms = [];
  for (const [base, entry] of shape) {
    const englishEntry = english.get(base);
    if (englishEntry === undefined) continue;
    const pluralHere = entry.forms.size > 0;
    const pluralInEnglish = englishEntry.forms.size > 0;
    if (pluralHere !== pluralInEnglish) {
      wrongKind.push(base);
      continue;
    }
    if (!pluralHere) continue;
    for (const form of required) if (!entry.forms.has(form)) missingForms.push(`${base}_${form}`);
    for (const form of entry.forms.keys()) if (!allowed.has(form)) foreignForms.push(`${base}_${form}`);
  }
  check(`B4 ${locale}: cada clave es plural donde el inglés lo es`, wrongKind.length === 0, list(wrongKind));
  check(`B5 ${locale}: cada plural tiene las formas que usa el idioma (${[...required].join(', ')})`,
    missingForms.length === 0, list(missingForms));
  check(`B6 ${locale}: ningún plural tiene formas que el idioma no usa`, foreignForms.length === 0, list(foreignForms));
}

/** Los valores de una entrada: los de la frase simple, o los de todas las formas juntas. */
function entryNames(entry) {
  if (entry.plain !== undefined) return names(entry.plain);
  const all = new Set();
  for (const text of entry.forms.values()) for (const name of names(text)) all.add(name);
  return all;
}

for (const locale of LOCALES) {
  if (locale === 'en') continue;
  const shape = shapes.get(locale);
  const wrongNames = [];
  const wrongTags = [];
  for (const [base, entry] of shape) {
    const englishEntry = english.get(base);
    if (englishEntry === undefined) continue;
    if (entry.plain !== undefined && englishEntry.plain !== undefined) {
      if (!sameSet(names(entry.plain), names(englishEntry.plain))) wrongNames.push(base);
      if (tagsOf(entry.plain) !== tagsOf(englishEntry.plain)) wrongTags.push(base);
      continue;
    }
    // Un plural puede no nombrar {{count}} en una forma ("una sesión"), pero
    // `other` lleva los mismos valores que el inglés, y ninguna forma inventa uno.
    const englishAll = entryNames(englishEntry);
    const other = entry.forms.get('other');
    const englishOther = englishEntry.forms.get('other');
    if (other === undefined || englishOther === undefined) continue;
    if (!sameSet(names(other), names(englishOther))) wrongNames.push(`${base}_other`);
    for (const [form, text] of entry.forms) {
      if (![...names(text)].every((name) => englishAll.has(name))) wrongNames.push(`${base}_${form}`);
      if (tagsOf(text) !== tagsOf(englishOther)) wrongTags.push(`${base}_${form}`);
    }
  }
  check(`B7 ${locale}: cada frase usa los mismos {{valores}} que el inglés`, wrongNames.length === 0, list(wrongNames));
  check(`B8 ${locale}: cada frase usa las mismas etiquetas que el inglés`, wrongTags.length === 0, list(wrongTags));
}

// --- C. El código --------------------------------------------------------------

const typescript = (await import('typescript')).default;

function sources(dir, acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== LOCALES_DIR) sources(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

const codeFiles = sources(WEB_SRC);
const literals = new Set();
const builtKeys = [];
const calls = [];
const TRANSLATORS = new Set(['t', 'tRich', 'template']);

for (const file of codeFiles) {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS;
  const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true, kind);
  const where = (node) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `${relative(WEB_SRC, file)}:${line + 1}`;
  };
  const visit = (node) => {
    if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node)) literals.add(node.text);
    if (typescript.isCallExpression(node) && typescript.isIdentifier(node.expression) && TRANSLATORS.has(node.expression.text)) {
      const [keyArg, paramsArg] = node.arguments;
      if (keyArg !== undefined && typescript.isTemplateExpression(keyArg)) builtKeys.push(where(node));
      if (keyArg !== undefined && (typescript.isStringLiteral(keyArg) || typescript.isNoSubstitutionTemplateLiteral(keyArg))) {
        let passed = null;
        if (paramsArg === undefined) passed = new Set();
        else if (typescript.isObjectLiteralExpression(paramsArg)) {
          const spread = paramsArg.properties.some((p) => typescript.isSpreadAssignment(p));
          if (!spread) {
            passed = new Set(paramsArg.properties.map((p) => (p.name !== undefined ? p.name.getText(source) : '')));
          }
        }
        if (passed !== null) calls.push({ key: keyArg.text, passed, at: where(node) });
      }
    }
    typescript.forEachChild(node, visit);
  };
  visit(source);
}

{
  // Las `server.*` las usa el servidor por su clave corta (`serverText('x')`):
  // se cubren aparte, en la sección S.
  const unused = [...english.keys()].filter((base) => !base.startsWith('server.') && !literals.has(base));
  check('C1 cada clave del inglés se usa en el código', unused.length === 0, list(unused));
  check('C2 ninguna clave se arma con ${} en un t()', builtKeys.length === 0, list(builtKeys));
  const unknown = calls.filter((call) => !english.has(call.key)).map((call) => `${call.key} (${call.at})`);
  check('C3 cada t("clave") nombra una clave que existe', unknown.length === 0, list(unknown));
  const short = [];
  for (const call of calls) {
    const entry = english.get(call.key);
    if (entry === undefined) continue;
    const needed = entryNames(entry);
    const missing = [...needed].filter((name) => !call.passed.has(name));
    if (missing.length > 0) short.push(`${call.key} sin ${missing.join('/')} (${call.at})`);
  }
  check('C4 cada t("clave", {…}) pasa los valores que la frase usa', short.length === 0, list(short));
}

// --- S. Los textos del servidor ------------------------------------------------
// El servidor manda una clave de `SERVER_TEXTS` y la web busca `server.<clave>`.

const { SERVER_TEXTS } = await import('../../shared/src/server-text.ts');
{
  const registry = new Map(Object.entries(SERVER_TEXTS).map(([key, params]) => [key, new Set(params)]));
  const inEnglish = [...english.keys()].filter((base) => base.startsWith('server.')).map((base) => base.slice('server.'.length));
  const missing = [...registry.keys()].filter((key) => !english.has(`server.${key}`));
  const extra = inEnglish.filter((key) => !registry.has(key));
  check('S1 cada clave de SERVER_TEXTS tiene su frase', missing.length === 0, list(missing));
  check('S2 ninguna frase server.* sobra', extra.length === 0, list(extra));
  const wrong = [...registry]
    .filter(([key, params]) => english.has(`server.${key}`) && !sameSet(entryNames(english.get(`server.${key}`)), params))
    .map(([key]) => key);
  check('S3 cada frase del servidor usa exactamente los valores de la lista', wrong.length === 0, list(wrong));
  const used = new Set();
  for (const file of sources(join(ROOT, 'packages', 'server', 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/serverText\(\s*'([A-Za-z0-9]+)'/g)) used.add(match[1]);
  }
  const unusedServer = [...registry.keys()].filter((key) => !used.has(key));
  check('S4 cada clave de SERVER_TEXTS la usa el servidor', unusedServer.length === 0, list(unusedServer));
}

// --- L. Ningún texto escrito a mano en la web --------------------------------
// Lo que impide que el próximo cambio vuelva a meter español en el JSX.

{
  const LETTERS = /\p{L}/u;
  /** Lo que se muestra igual en todos los idiomas. */
  const UNTRANSLATED = new Set(['CLI', 'Agent Workbench', 'Git', 'aA']);
  const DISPLAY_ATTRIBUTES = new Set(['title', 'aria-label', 'placeholder', 'alt', 'label']);
  const loose = [];
  const shows = (text) => {
    const trimmed = text.replace(/\s+/g, ' ').trim();
    return trimmed.length > 0 && LETTERS.test(trimmed) && !UNTRANSLATED.has(trimmed);
  };
  const literalTexts = (node) => {
    if (node === undefined) return [];
    if (typescript.isParenthesizedExpression(node)) return literalTexts(node.expression);
    if (typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node)) return [node.text];
    if (typescript.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)];
    if (typescript.isConditionalExpression(node)) return [...literalTexts(node.whenTrue), ...literalTexts(node.whenFalse)];
    if (typescript.isBinaryExpression(node)) return literalTexts(node.right);
    return [];
  };
  for (const file of codeFiles.filter((name) => name.endsWith('.tsx'))) {
    const text = readFileSync(file, 'utf8');
    const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TSX);
    const where = (node) => `${relative(WEB_SRC, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    // Un icono hecho con letras (`aria-hidden`) no se lee: no es texto.
    const hidden = (node) => {
      for (let current = node.parent; current !== undefined; current = current.parent) {
        if (typescript.isJsxElement(current)) {
          const attributes = current.openingElement.attributes.properties;
          if (attributes.some((attribute) => typescript.isJsxAttribute(attribute) && attribute.name.getText(source) === 'aria-hidden')) return true;
        }
      }
      return false;
    };
    const visit = (node) => {
      if (typescript.isJsxText(node) && shows(node.text) && !hidden(node)) loose.push(where(node));
      if (typescript.isJsxAttribute(node) && DISPLAY_ATTRIBUTES.has(node.name.getText(source)) && node.initializer !== undefined) {
        const init = node.initializer;
        const texts = typescript.isStringLiteral(init) ? [init.text] : typescript.isJsxExpression(init) ? literalTexts(init.expression) : [];
        if (texts.some(shows)) loose.push(where(node));
      }
      if (typescript.isJsxExpression(node) && node.parent !== undefined && !typescript.isJsxAttribute(node.parent)) {
        if (literalTexts(node.expression).some(shows)) loose.push(where(node));
      }
      typescript.forEachChild(node, visit);
    };
    visit(source);
  }
  check('L1 ningún texto escrito a mano en el JSX: todo pasa por t()', loose.length === 0, list(loose, 12));

  // Fuera del JSX no hay forma segura de saber qué se muestra; esto atrapa lo
  // más común, un literal con tildes o eñes, que casi siempre es una frase.
  const SPANISH = /[áéíóúñÁÉÍÓÚÑ¿¡]/;
  const accented = [];
  const I18N_DIR = join(WEB_SRC, 'i18n');
  for (const file of codeFiles.filter((name) => !name.startsWith(I18N_DIR))) {
    const text = readFileSync(file, 'utf8');
    const kind = file.endsWith('.tsx') ? typescript.ScriptKind.TSX : typescript.ScriptKind.TS;
    const source = typescript.createSourceFile(file, text, typescript.ScriptTarget.Latest, true, kind);
    const visit = (node) => {
      if ((typescript.isStringLiteral(node) || typescript.isNoSubstitutionTemplateLiteral(node)) && SPANISH.test(node.text)) {
        accented.push(`${relative(WEB_SRC, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      }
      typescript.forEachChild(node, visit);
    };
    visit(source);
  }
  check('L2 ningún literal con tildes fuera de los archivos de idiomas', accented.length === 0, list(accented, 12));
}

// --- D. El motor --------------------------------------------------------------

check('D1 sin elegir, el idioma es el inglés', getLocale() === 'en');
check('D2 inglés: el texto de siempre', t('time.justNow') === 'just now');

{
  let heard = 0;
  const stop = subscribe(() => heard++);
  await setLocale('es');
  check('D3 setLocale("es") carga el español y avisa', getLocale() === 'es' && heard === 1, `${getLocale()} / ${heard}`);
  await setLocale('es');
  check('D4 elegir el mismo idioma otra vez no avisa', heard === 1, String(heard));
  stop();
}

check('D5 los valores se reemplazan', t('header.locale.title', { name: 'X' }) === 'Idioma: X');
check('D6 un valor que no vino queda escrito, para que se note', interpolate('a {{b}} c', {}) === 'a {{b}} c');

{
  // El respaldo: un español sin la clave cae al inglés, y sin inglés, a la clave.
  check('D7 un texto que le falta a un idioma sale en inglés', resolveTemplate({}, 'es', 'time.justNow') === 'just now');
  check('D8 una clave que no existe en ninguno sale como clave', resolveTemplate({}, 'es', 'no.existe') === 'no.existe');
  const plural = { 'k_one': 'una', 'k_other': '{{count}} varias' };
  check('D9 plural: la forma de 1', resolveTemplate(plural, 'es', 'k', { count: 1 }) === 'una');
  check('D10 plural: la forma de 5', resolveTemplate(plural, 'es', 'k', { count: 5 }) === '{{count}} varias');
  check('D11 plural: un millón pide "many" en español, y sin ella va "other"',
    new Intl.PluralRules('es').select(1_000_000) === 'many' && resolveTemplate(plural, 'es', 'k', { count: 1_000_000 }) === '{{count}} varias');
  check('D12 plural sin formas: la clave sola', resolveTemplate({ k: 'sola' }, 'es', 'k', { count: 3 }) === 'sola');
}

{
  // Dos cambios seguidos: el primero termina de cargar tarde y no pisa al segundo.
  // Con un idioma que todavía no se cargó, para que la carga sea de verdad asíncrona.
  await setLocale('en');
  const first = setLocale('ja');
  const second = setLocale('en');
  await Promise.all([first, second]);
  check('D13 el último cambio gana aunque el anterior cargue después', getLocale() === 'en', getLocale());
}

{
  // Cada idioma de la lista carga su archivo y tiene lo que el menú muestra.
  const broken = [];
  for (const locale of LOCALES) {
    await setLocale(locale);
    const tag = defaultFormatTag(locale);
    if (getLocale() !== locale) broken.push(`${locale}: no carga`);
    if (!(LOCALE_NAMES[locale]?.length > 0)) broken.push(`${locale}: sin nombre`);
    if (!/^[A-Z]{2}$/.test(LOCALE_BADGES[locale] ?? '')) broken.push(`${locale}: sigla`);
    if (Intl.DateTimeFormat.supportedLocalesOf([tag]).length === 0) broken.push(`${locale}: ${tag} no la conoce Intl`);
    if (t('time.justNow') === 'time.justNow') broken.push(`${locale}: sin textos`);
  }
  await setLocale('en');
  check(`D14 los ${LOCALES.length} idiomas cargan, con nombre, sigla y región de formato`, broken.length === 0, list(broken));
}

// --- E. La detección ----------------------------------------------------------

check('E1 es-PE es español', matchLocale('es-PE') === 'es');
check('E2 mayúsculas y guion bajo: EN_gb es inglés', matchLocale('EN_gb') === 'en');
check('E3 un idioma que no hay da null', matchLocale('xx-YY') === null && matchLocale('') === null);
check('E4 el chino tradicional no cae en simplificado',
  matchLocale('zh-TW') === null && matchLocale('zh-HK') === null && matchLocale('zh-Hant-CN') === null);
check('E5 Automático: el primero del navegador que haya', resolveLocale('auto', ['xx-YY', 'es-419', 'en-US']) === 'es');
check('E6 Automático sin ninguno que haya: inglés', resolveLocale('auto', ['xx-YY']) === 'en' && resolveLocale('auto', []) === 'en');
check('E7 la preferencia guardada gana al navegador', resolveLocale('es', ['en-US']) === 'es');
check('E8 una preferencia desconocida no se acepta',
  parseLocalePreference('xx') === null && parseLocalePreference('auto') === 'auto' && parseLocalePreference('es') === 'es');
check('E9 la región del navegador, si es del mismo idioma', resolveFormatTag('es', ['en-US', 'es-PE']) === 'es-PE');
check('E10 sin región del idioma, la típica: español latinoamericano', resolveFormatTag('es', ['en-US']) === 'es-419');
check('E11 cada idioma por su región',
  matchLocale('de-AT') === 'de' && matchLocale('fr-CA') === 'fr' && matchLocale('ru-RU') === 'ru' &&
    matchLocale('ja-JP') === 'ja' && matchLocale('ko-KR') === 'ko' && matchLocale('en-GB') === 'en');
check('E12 el portugués, de cualquier región, es el de Brasil',
  matchLocale('pt-PT') === 'pt-BR' && matchLocale('pt') === 'pt-BR' && matchLocale('PT_br') === 'pt-BR');
check('E13 el chino simplificado, con región o sin ella',
  matchLocale('zh') === 'zh-CN' && matchLocale('zh-Hans') === 'zh-CN' && matchLocale('zh-SG') === 'zh-CN' &&
    matchLocale('zh-Hans-SG') === 'zh-CN');
check('E14 con el chino tradicional primero, el idioma siguiente de la lista',
  resolveLocale('auto', ['zh-TW', 'ja-JP']) === 'ja' && resolveLocale('auto', ['zh-HK']) === 'en');
check('E15 un idioma que no está, el italiano, abre en inglés', resolveLocale('auto', ['it-IT', 'it']) === 'en');
check('E16 la región de formato: la del navegador, pero nunca la del chino tradicional para el simplificado',
  resolveFormatTag('de', ['de-AT']) === 'de-AT' && resolveFormatTag('zh-CN', ['zh-TW']) === 'zh-CN' &&
    resolveFormatTag('pt-BR', ['en-US']) === 'pt-BR');

// --- F. Formatos -------------------------------------------------------------

{
  const MB = 1_024 * 1_024;
  await setLocale('es');
  check('F1 tamaños en español, con punto como siempre',
    formatBytes(512) === '512 B' && formatBytes(12 * 1_024) === '12 KB' && formatBytes(5 * MB) === '5.0 MB' &&
      formatBytes(3 * 1_024 * MB) === '3.00 GB',
    [formatBytes(512), formatBytes(12 * 1_024), formatBytes(5 * MB), formatBytes(3 * 1_024 * MB)].join(' | '));
  check('F2 un tamaño que no es número: 0 B', formatBytes(Number.NaN) === '0 B');
  check('F3 duraciones',
    formatDuration(850) === '850 ms' && formatDuration(12_000) === '12 s' && formatDuration(185_000) === '3 min 5 s' &&
      formatDuration(180_000) === '3 min' && formatRoughDuration(500) === 'menos de 1 s',
    [formatDuration(850), formatDuration(12_000), formatDuration(185_000), formatRoughDuration(500)].join(' | '));
  const now = Date.UTC(2026, 8, 18, 12);
  check('F4 hace cuánto, en español',
    formatWhen(now - 30_000, now) === 'recién' && formatWhen(now - 5 * 60_000, now) === 'hace 5 min' &&
      formatWhen(now - 3 * 3_600_000, now) === 'hace 3 h' && formatWhen(now - 2 * 86_400_000, now) === 'hace 2 d' &&
      formatWhen(0, now) === '',
    formatWhen(now - 5 * 60_000, now));
  check('F5 listas con la conjunción del idioma', formatList(['A', 'B']) === 'A y B' && formatList(['A', 'B', 'C']) === 'A, B y C');
  await setLocale('es', 'es-ES');
  check('F6 con la región de España, coma decimal', formatBytes(5 * MB) === '5,0 MB', formatBytes(5 * MB));
  await setLocale('en');
  check('F7 en inglés', formatBytes(5 * MB) === '5.0 MB' && formatWhen(now - 5 * 60_000, now) === '5 min ago' &&
    formatList(['A', 'B', 'C']) === 'A, B, and C');
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
