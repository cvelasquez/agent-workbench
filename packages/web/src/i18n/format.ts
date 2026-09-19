/**
 * Números, tamaños, duraciones, fechas y listas en el idioma de la app (§6.23).
 *
 * Las fechas, las horas, los decimales y las listas salen de `Intl` con la
 * región de `getFormatTag()`. Las unidades y el "hace 5 min" salen del
 * diccionario: `Intl` escribe "-5 min" en francés para eso, y su resultado
 * cambia con la versión del navegador.
 *
 * Antes había seis copias del formateador de tamaños y dos de duraciones; esta
 * es la única de cada una. Puro, para `pnpm check`.
 */

import { getFormatTag, t } from './index.js';

const KB = 1_024;
const MB = KB * 1_024;
const GB = MB * 1_024;

/** Un número con `digits` decimales fijos y sin separador de miles: `5.0`, `5,0`. */
export function formatNumber(value: number, digits = 0): string {
  return new Intl.NumberFormat(getFormatTag(), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    useGrouping: false,
  }).format(value);
}

/** Un tamaño: `512 B`, `12 KB`, `5.0 MB`, `3.00 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < KB) {
    return t('format.bytes.b', { value: formatNumber(Math.max(0, Math.round(bytes) || 0)) });
  }
  if (bytes < MB) return t('format.bytes.kb', { value: formatNumber(Math.round(bytes / KB)) });
  if (bytes < GB) return t('format.bytes.mb', { value: formatNumber(bytes / MB, 1) });
  return t('format.bytes.gb', { value: formatNumber(bytes / GB, 2) });
}

function minutesAndSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0
    ? t('format.duration.minutes', { value: minutes })
    : t('format.duration.minutesSeconds', { minutes, seconds: rest });
}

/** La duración de un turno: `850 ms`, `12 s`, `3 min 5 s`. */
export function formatDuration(ms: number): string {
  if (ms < 1_000) return t('format.duration.ms', { value: ms });
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return t('format.duration.seconds', { value: seconds });
  return minutesAndSeconds(seconds);
}

/** Cuánto tardó algo, sin milisegundos: `menos de 1 s`, `12 s`, `3 min 5 s`. */
export function formatRoughDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1_000) return t('format.duration.underSecond');
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return t('format.duration.seconds', { value: seconds });
  return minutesAndSeconds(seconds);
}

/**
 * Hace cuánto: `recién`, `hace 5 min`, `hace 3 h`, `hace 2 d`, y pasado un mes,
 * la fecha. Vacío para una marca que no existe.
 */
export function formatWhen(timestamp: number, now: number = Date.now()): string {
  if (timestamp <= 0) return '';
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return t('time.justNow');
  if (minutes < 60) return t('time.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('time.hoursAgo', { count: hours });
  const days = Math.floor(hours / 24);
  if (days < 30) return t('time.daysAgo', { count: days });
  return formatDate(timestamp);
}

/** La fecha, con la forma de la región: `18/9/2026`, `9/18/2026`, `2026/9/18`. */
export function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(getFormatTag());
}

/** La hora en horas y minutos: `15:04`, `03:04 p. m.`. */
export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(getFormatTag(), { hour: '2-digit', minute: '2-digit' });
}

/** Una lista con la conjunción del idioma: `A y B`, `A, B and C`, `A、B和C`. */
export function formatList(items: readonly string[]): string {
  return new Intl.ListFormat(getFormatTag(), { type: 'conjunction' }).format(items);
}
