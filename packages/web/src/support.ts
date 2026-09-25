/**
 * La sugerencia de apoyar el proyecto (§6.28).
 *
 * Se muestra una vez por versión, no en cada arranque: lo que la volvería una
 * molestia es repetirse. Qué versión ya la mostró se guarda con las
 * preferencias de la ventana (`window-prefs.ts`), que sobreviven al puerto y a
 * `F5`; con la versión siguiente vuelve a aparecer, una sola vez.
 *
 * Puro y sin DOM, para que `pnpm check` lo importe (`check-composer-input.mjs`).
 */

import { SUPPORT_URL } from '@agent-workbench/shared';

export { SUPPORT_URL };

/**
 * La versión de la app, que Vite pone al compilar desde el `package.json` de
 * la raíz (`define`, `vite.config.ts`). En los chequeos, que cargan esto en
 * Node, no existe: `typeof` no lanza con un nombre sin declarar.
 */
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

export const SUPPORT_NOTICE_STORAGE_KEY = 'agent-workbench.support-notice';

/** Cuánto queda a la vista si nadie la toca: un momento, no una pestaña más. */
export const SUPPORT_NOTICE_HIDE_MS = 30_000;

/** Lo guardado tiene forma de versión; otra cosa no cuenta y el cartel se muestra. */
export function parseStoredSupportNotice(raw: string): string | null {
  return /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/.test(raw) ? raw : null;
}

/** Se muestra si esta versión todavía no la mostró. */
export function shouldShowSupportNotice(shownFor: string | null, version: string): boolean {
  return shownFor !== version;
}
