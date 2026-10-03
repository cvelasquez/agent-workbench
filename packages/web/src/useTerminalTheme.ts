/**
 * El tema de la terminal, aparte del de la app (0.5.0).
 *
 * **Por defecto es oscura siempre**, con la app en claro o en oscuro. Pedido del
 * usuario, con dos capturas: en el tema claro el amarillo de PowerShell y el gris
 * tenue de Claude Code no se leian sobre blanco, y los diffs de Claude Code salian
 * con el fondo verde oscuro de su tema oscuro. Las CLIs eligen sus colores
 * pensando en una terminal oscura; la terminal clara las obligaba a verse mal.
 *
 * "Seguir el tema" queda como opcion (se elige en Ajustes). Ahi la terminal clara
 * sube el contraste minimo de xterm (`TerminalView`), que oscurece sola una letra
 * que no se lee sobre el fondo, sin redefinir la paleta de la CLI.
 *
 * Como el tema de la app, es de esta pantalla y no del espacio de trabajo: va por
 * `window-prefs.ts` (§6.26). El resultado se escribe en `<html>` como
 * `data-terminal-theme`, y de ahi cuelga el fondo del marco de cada terminal.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ResolvedTheme } from './useTheme.js';
import { readStored, writeStored } from './window-prefs.js';

export type TerminalThemePreference = 'dark' | 'follow';

export const TERMINAL_THEME_PREFERENCES: readonly TerminalThemePreference[] = ['dark', 'follow'];

const STORAGE_KEY = 'agent-workbench.terminalTheme';

export function parseTerminalThemePreference(raw: string): TerminalThemePreference | null {
  return raw === 'dark' || raw === 'follow' ? raw : null;
}

/** El tema que pinta la terminal: oscuro, salvo que se pida seguir al de la app. */
export function resolveTerminalTheme(preference: TerminalThemePreference, appTheme: ResolvedTheme): ResolvedTheme {
  return preference === 'follow' ? appTheme : 'dark';
}

export interface TerminalThemeState {
  preference: TerminalThemePreference;
  resolved: ResolvedTheme;
  setPreference: (preference: TerminalThemePreference) => void;
}

export function useTerminalTheme(appTheme: ResolvedTheme): TerminalThemeState {
  const [preference, setStoredPreference] = useState<TerminalThemePreference>(() =>
    readStored<TerminalThemePreference>(STORAGE_KEY, 'dark', parseTerminalThemePreference),
  );
  const resolved = resolveTerminalTheme(preference, appTheme);

  useEffect(() => {
    document.documentElement.dataset['terminalTheme'] = resolved;
  }, [resolved]);

  const setPreference = useCallback((next: TerminalThemePreference) => {
    writeStored(STORAGE_KEY, next);
    setStoredPreference(next);
  }, []);

  return { preference, resolved, setPreference };
}
