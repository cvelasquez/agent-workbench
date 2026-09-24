/**
 * Tema claro y oscuro.
 *
 * Tres estados y un solo boton que los cicla: **sistema → claro → oscuro**.
 * "Sistema" es el valor por defecto y sigue a `prefers-color-scheme` en vivo,
 * asi que quien tenga el sistema en automatico ve la app cambiar sola al
 * anochecer sin haber tocado nada.
 *
 * La preferencia no va al servidor: es de esta pantalla, no del espacio de
 * trabajo. Dos ventanas pueden tener temas distintos sin pelearse. Se guarda
 * por `window-prefs.ts`, como las demas, y asi sobrevive a que la app arranque
 * en otro puerto.
 */

import { useCallback, useEffect, useState } from 'react';
import { t, type MessageKey } from './i18n/index.js';
import { readStored, writeStored } from './window-prefs.js';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'agent-workbench.theme';

const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];

const THEME_KEYS: Readonly<Record<ThemePreference, MessageKey>> = {
  system: 'theme.system',
  light: 'theme.light',
  dark: 'theme.dark',
};

/** El titulo del boton: que tema hay puesto (§6.23). */
export function themeTitle(preference: ThemePreference): string {
  return t('theme.title', { theme: t(THEME_KEYS[preference]) });
}

export const THEME_ICON: Readonly<Record<ThemePreference, string>> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

/** Sin nada guardado se arranca en automatico, que es el default de todos modos. */
function readPreference(): ThemePreference {
  return readStored<ThemePreference>(STORAGE_KEY, 'system', (raw) =>
    raw === 'light' || raw === 'dark' || raw === 'system' ? raw : null,
  );
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export interface ThemeState {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  /** Pasa al siguiente estado del ciclo. */
  cycle: () => void;
}

export function useTheme(): ThemeState {
  const [preference, setPreference] = useState<ThemePreference>(readPreference);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  // El sistema puede cambiar mientras la app esta abierta.
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (event: MediaQueryListEvent): void => setSystemDark(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme =
    preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;

  // El atributo va en <html> y toda la hoja de estilos cuelga de el. Tambien se
  // fija `color-scheme` para que las barras de desplazamiento y los controles
  // nativos del navegador acompanien.
  useEffect(() => {
    document.documentElement.dataset['theme'] = resolved;
    document.documentElement.style.colorScheme = resolved;
  }, [resolved]);

  const cycle = useCallback(() => {
    setPreference((current) => {
      const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length] ?? 'system';
      writeStored(STORAGE_KEY, next);
      return next;
    });
  }, []);

  return { preference, resolved, cycle };
}
