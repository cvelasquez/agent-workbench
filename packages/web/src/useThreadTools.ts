/**
 * Si la barra del hilo está desplegada (`thread-tools.ts`), guardado por
 * `window-prefs.ts`, en la clave de la vista que se muestra: al pasar de la
 * ancha a la angosta se lee la de la otra.
 */

import { useCallback, useState } from 'react';
import {
  defaultThreadToolsOpen,
  parseStoredThreadTools,
  threadToolsStorageKey,
  threadToolsValue,
} from './thread-tools.js';
import { readStored, writeStored } from './window-prefs.js';

export interface ThreadToolsState {
  open: boolean;
  setOpen: (open: boolean) => void;
}

function readOpen(narrow: boolean): boolean {
  return readStored(threadToolsStorageKey(narrow), defaultThreadToolsOpen(narrow), parseStoredThreadTools);
}

export function useThreadTools(narrow: boolean): ThreadToolsState {
  const [state, setState] = useState(() => ({ narrow, open: readOpen(narrow) }));
  // Cambió la vista: lo de la otra clave, en este mismo render.
  if (state.narrow !== narrow) setState({ narrow, open: readOpen(narrow) });
  const open = state.narrow === narrow ? state.open : readOpen(narrow);

  const setOpen = useCallback(
    (next: boolean) => {
      setState({ narrow, open: next });
      writeStored(threadToolsStorageKey(narrow), threadToolsValue(next));
    },
    [narrow],
  );

  return { open, setOpen };
}
