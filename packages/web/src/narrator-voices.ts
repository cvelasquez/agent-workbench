/**
 * Con qué voz habla el narrador (hito 57, §6.40). Puro, sin navegador: lo
 * cubre `check-narrator.mjs`.
 *
 * **Sólo voces locales** (`localService`): las en línea ("Google español" en
 * Chrome, las "Online (Natural)" de Edge) mandan el texto de la conversación a
 * su proveedor, y eso choca con §2.4. No se ofrecen.
 *
 * **La voz por defecto del navegador no siempre sirve**: medido el 16-11-2026,
 * con las voces de español instaladas en Windows la predeterminada seguía siendo
 * David, en inglés. Por eso la voz se elige por el idioma del usuario (el de la
 * interfaz, con la región que pide su navegador), y nunca se cae callado a una
 * de otro idioma:
 *
 *  1. La que el usuario eligió en Ajustes, si sigue instalada.
 *  2. La predeterminada del sistema, si es de su idioma: respeta la que ya
 *     eligió en su equipo.
 *  3. Una de su idioma y su región.
 *  4. Una de su idioma, de otra región.
 *  5. Ninguna: el aviso con los pasos para instalarla, y "usar la
 *     predeterminada igual".
 */

/** Lo que el narrador mira de una `SpeechSynthesisVoice`. */
export interface VoiceInfo {
  voiceURI: string;
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

/** El sistema donde corre el navegador: decide qué pasos se muestran para instalar una voz. */
export type VoicePlatform = 'windows' | 'mac' | 'linux' | 'other';

/** La voz elegida, o por qué no hay. */
export type VoiceChoice =
  | { kind: 'voice'; voice: VoiceInfo }
  /** No hay voz local del idioma; `fallback` es la que se usaría igual, si hay alguna. */
  | { kind: 'missing'; fallback: VoiceInfo | null };

/** `es_MX` y `ES-mx` son `es-mx`. */
export function normalizeTag(tag: string): string {
  return tag.trim().replace(/_/g, '-').toLowerCase();
}

/** `pt-BR` es `pt`. */
export function baseLanguage(tag: string): string {
  return normalizeTag(tag).split('-')[0] ?? '';
}

/** Sólo las que no mandan el texto afuera. */
export function localVoices(voices: readonly VoiceInfo[]): VoiceInfo[] {
  return voices.filter((voice) => voice.localService);
}

/**
 * La etiqueta que se busca: el idioma de la interfaz, con la región del primer
 * idioma del navegador que sea el mismo (`es` y un navegador en `es-AR` dan
 * `es-ar`). Si el navegador no pide ese idioma, la de la interfaz tal cual.
 */
export function wantedTag(uiLocale: string, browserLanguages: readonly string[]): string {
  const base = baseLanguage(uiLocale);
  const fromBrowser = browserLanguages.find((tag) => baseLanguage(tag) === base && normalizeTag(tag).includes('-'));
  return normalizeTag(fromBrowser ?? uiLocale);
}

/** La voz a usar, según el orden de arriba. */
export function pickVoice(
  voices: readonly VoiceInfo[],
  options: { saved: string | null; uiLocale: string; browserLanguages: readonly string[] },
): VoiceChoice {
  const local = localVoices(voices);
  const saved = options.saved === null ? undefined : local.find((voice) => voice.voiceURI === options.saved);
  if (saved !== undefined) return { kind: 'voice', voice: saved };

  const tag = wantedTag(options.uiLocale, options.browserLanguages);
  const base = baseLanguage(tag);
  const sameLanguage = local.filter((voice) => baseLanguage(voice.lang) === base);
  const systemDefault = sameLanguage.find((voice) => voice.default);
  if (systemDefault !== undefined) return { kind: 'voice', voice: systemDefault };
  const exact = sameLanguage.find((voice) => normalizeTag(voice.lang) === tag);
  if (exact !== undefined) return { kind: 'voice', voice: exact };
  const first = sameLanguage[0];
  if (first !== undefined) return { kind: 'voice', voice: first };

  return { kind: 'missing', fallback: local.find((voice) => voice.default) ?? local[0] ?? null };
}

/**
 * Las voces para el selector de Ajustes: sólo las locales, las del idioma del
 * usuario primero y después las demás, cada grupo por nombre.
 */
export function voiceOptions(voices: readonly VoiceInfo[], uiLocale: string): VoiceInfo[] {
  const base = baseLanguage(uiLocale);
  const byName = (a: VoiceInfo, b: VoiceInfo): number => a.name.localeCompare(b.name);
  const local = localVoices(voices);
  return [
    ...local.filter((voice) => baseLanguage(voice.lang) === base).sort(byName),
    ...local.filter((voice) => baseLanguage(voice.lang) !== base).sort(byName),
  ];
}

/** El sistema del navegador, por su agente de usuario. */
export function voicePlatform(userAgent: string): VoicePlatform {
  if (/Windows/i.test(userAgent)) return 'windows';
  // Un iPad se presenta como Mac; sus voces se instalan igual, desde Ajustes.
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'mac';
  if (/Android/i.test(userAgent)) return 'other';
  if (/Linux|X11|CrOS/i.test(userAgent)) return 'linux';
  return 'other';
}

/** La velocidad de la voz: 1 es la normal. */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;
export const DEFAULT_RATE = 1;
export const RATE_STEP = 0.1;

export const NARRATOR_VOICE_STORAGE_KEY = 'agent-workbench.narrator-voice';
export const NARRATOR_RATE_STORAGE_KEY = 'agent-workbench.narrator-rate';

/** Una velocidad guardada: número dentro del rango, redondeado al paso; si no, nada. */
export function parseStoredRate(raw: string): number | null {
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < MIN_RATE || value > MAX_RATE) return null;
  return clampRate(value);
}

export function clampRate(value: number): number {
  const stepped = Math.round(value / RATE_STEP) * RATE_STEP;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Number(stepped.toFixed(1))));
}

/** Una voz guardada: el `voiceURI`, que no puede ser vacío. */
export function parseStoredVoice(raw: string): string | null {
  const value = raw.trim();
  return value.length === 0 ? null : value;
}

/** El id de esta ventana para el narrador: lo genera la web, y sólo eso viaja. */
export const NARRATOR_WINDOW_STORAGE_KEY = 'agent-workbench.narrator-window';

/** 16 caracteres al azar de `[A-Za-z0-9_-]`, que cumplen `NARRATOR_WINDOW_ID_PATTERN`. */
export function newWindowId(random: (bytes: Uint8Array) => Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
  return Array.from(random(new Uint8Array(16)), (byte) => alphabet[byte % 64]).join('');
}
