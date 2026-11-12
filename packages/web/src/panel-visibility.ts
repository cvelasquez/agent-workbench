/**
 * Que paneles se ven (Hito 41, §6.32).
 *
 * Pedido del usuario: una ventana de Ajustes para quitar lo que no usa, y un
 * icono en la barra de Notas y de la Consola para esconderlas desde ahi. Se
 * vuelven a mostrar desde Ajustes.
 *
 *  - **La solapa CLI no se esconde.** Es donde se le escribe al agente y donde
 *    aparecen sus permisos: sin ella, una pregunta pasaria sin que nadie la vea.
 *  - **Es de esta ventana**, como el tema: va por `window-prefs.ts` (§6.26). Se
 *    guardan las escondidas, separadas por comas: es lo que menos pesa en la
 *    cookie, y una clave nueva que esta build no conoce se ignora sola.
 *
 * Lo puro lo prueba `check-settings.mjs`.
 */

import { useCallback, useState } from 'react';
import { readStored, writeStored } from './window-prefs.js';

export type HideablePanel = 'git' | 'files' | 'plans' | 'memory' | 'console' | 'notes';

/**
 * En el orden en que los lista Ajustes: las solapas del panel (menos la CLI), en
 * el orden de sus solapas, y despues lo del pie, que es la consola. Las notas
 * son la ultima solapa desde el 12-11-2026.
 */
export const HIDEABLE_PANELS: readonly HideablePanel[] = ['git', 'files', 'plans', 'memory', 'notes', 'console'];

const STORAGE_KEY = 'agent-workbench.hiddenPanels';

function isHideablePanel(value: string): value is HideablePanel {
  return (HIDEABLE_PANELS as readonly string[]).includes(value);
}

/** Sin preferencias, Memoria se esconde solo con cero o una CLI disponible. */
const DEFAULT_HIDDEN_PANELS: ReadonlySet<HideablePanel> = new Set<HideablePanel>(['memory']);
const NO_HIDDEN_PANELS: ReadonlySet<HideablePanel> = new Set<HideablePanel>();

export function resolveHiddenPanels(saved: ReadonlySet<HideablePanel> | null, multipleClis: boolean): ReadonlySet<HideablePanel> {
  return saved ?? (multipleClis ? NO_HIDDEN_PANELS : DEFAULT_HIDDEN_PANELS);
}

/** Lo que se guarda sin ninguna escondida, distinto de usar el valor por defecto. */
const NONE_HIDDEN = 'none';

/** Las escondidas guardadas. Lo que no se conoce se descarta; `none` o nada es "ninguna escondida". */
export function parseHiddenPanels(raw: string): ReadonlySet<HideablePanel> {
  return new Set(
    raw
      .split(',')
      .map((item) => item.trim())
      .filter(isHideablePanel),
  );
}

export function serializeHiddenPanels(hidden: ReadonlySet<HideablePanel>): string {
  const list = HIDEABLE_PANELS.filter((panel) => hidden.has(panel));
  return list.length === 0 ? NONE_HIDDEN : list.join(',');
}

export function withPanelVisible(hidden: ReadonlySet<HideablePanel>, panel: HideablePanel, visible: boolean): ReadonlySet<HideablePanel> {
  const next = new Set(hidden);
  if (visible) next.delete(panel);
  else next.add(panel);
  return next;
}

export interface PanelVisibility {
  hidden: ReadonlySet<HideablePanel>;
  isVisible: (panel: HideablePanel) => boolean;
  setVisible: (panel: HideablePanel, visible: boolean) => void;
}

export function usePanelVisibility(multipleClis: boolean): PanelVisibility {
  const [savedHidden, setHidden] = useState<ReadonlySet<HideablePanel> | null>(() =>
    readStored<ReadonlySet<HideablePanel> | null>(STORAGE_KEY, null, parseHiddenPanels),
  );
  // La lista de CLIs llega despues del primer render. Solo una eleccion del
  // usuario se guarda; el valor por defecto se resuelve con la lista actual.
  const hidden = resolveHiddenPanels(savedHidden, multipleClis);

  const setVisible = useCallback((panel: HideablePanel, visible: boolean) => {
    setHidden((current) => {
      const next = withPanelVisible(resolveHiddenPanels(current, multipleClis), panel, visible);
      writeStored(STORAGE_KEY, serializeHiddenPanels(next));
      return next;
    });
  }, [multipleClis]);

  const isVisible = useCallback((panel: HideablePanel) => !hidden.has(panel), [hidden]);

  return { hidden, isVisible, setVisible };
}
