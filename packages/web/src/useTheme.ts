/**
 * Tema claro y oscuro.
 *
 * Tres estados y un solo boton que los cicla: **sistema → claro → oscuro**.
 * "Sistema" es el valor por defecto y sigue a `prefers-color-scheme` en vivo,
 * asi que quien tenga el sistema en automatico ve la app cambiar sola al
 * anochecer sin haber tocado nada.
 *
 * La preferencia vive en `localStorage` y no en el servidor: es de esta
 * pantalla, no del espacio de trabajo. Dos ventanas pueden tener temas
 * distintos sin pelearse. `localStorage` puede lanzar (modo privado, permisos),
 * asi que toda lectura y escritura va envuelta.
 */

import { useCallback, useEffect, useState } from 'react';

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'agent-workbench.theme';

const ORDER: readonly ThemePreference[] = ['system', 'light', 'dark'];

export const THEME_LABEL: Readonly<Record<ThemePreference, string>> = {
  system: 'Tema del sistema',
  light: 'Tema claro',
  dark: 'Tema oscuro',
};

export const THEME_ICON: Readonly<Record<ThemePreference, string>> = {
  system: '◐',
  light: '☀',
  dark: '☾',
};

function readPreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Sin persistencia se arranca en automatico, que es el default de todos modos.
  }
  return 'system';
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
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Es una preferencia, no un dato: sin persistencia se sigue igual.
      }
      return next;
    });
  }, []);

  return { preference, resolved, cycle };
}
