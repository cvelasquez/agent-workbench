/**
 * La preferencia del tamano de letra del hilo (§6.22), y desde el 25-09-2026
 * tambien la de las notas: el mismo boton y los mismos tres pasos, cada una
 * con su clave.
 *
 * Se guarda por `window-prefs.ts`, como el tema y el alto del cuadro: es de
 * esta pantalla.
 * El atributo va en `<html>` y no en el panel porque el cuadro de escritura
 * escala con el hilo y vive en otro componente; la hoja de estilos solo le da
 * valor a `--thread-scale` dentro del hilo y del cuadro, asi que el Markdown
 * de las demas solapas no cambia. El de las notas, `--notes-scale`, solo
 * dentro de las notas.
 */

import { useCallback, useLayoutEffect, useState } from 'react';
import {
  DEFAULT_NOTES_FONT_SIZE,
  DEFAULT_THREAD_FONT_SIZE,
  NOTES_FONT_STORAGE_KEY,
  THREAD_FONT_STORAGE_KEY,
  nextThreadFontSize,
  parseThreadFontSize,
  type ThreadFontSize,
} from './thread-font.js';
import { readStored, writeStored } from './window-prefs.js';

export interface ThreadFontState {
  size: ThreadFontSize;
  /** Pasa al tamano siguiente. */
  cycle: () => void;
}

/** `datasetKey` es el atributo de `<html>`: `threadFont` queda `data-thread-font`. */
function useFontSize(storageKey: string, fallback: ThreadFontSize, datasetKey: string): ThreadFontState {
  const [size, setSize] = useState<ThreadFontSize>(() =>
    readStored(storageKey, fallback, parseThreadFontSize),
  );

  /*
    Antes de que el cuadro de escritura mida su alto: sus efectos corren antes
    que los de `App`, y con un efecto comun el cuadro media con el tamano
    anterior. Los de layout corren todos antes que cualquier efecto comun.
  */
  useLayoutEffect(() => {
    document.documentElement.dataset[datasetKey] = size;
  }, [datasetKey, size]);

  const cycle = useCallback(() => {
    setSize((current) => {
      const next = nextThreadFontSize(current);
      writeStored(storageKey, next);
      return next;
    });
  }, [storageKey]);

  return { size, cycle };
}

export function useThreadFont(): ThreadFontState {
  return useFontSize(THREAD_FONT_STORAGE_KEY, DEFAULT_THREAD_FONT_SIZE, 'threadFont');
}

export function useNotesFont(): ThreadFontState {
  return useFontSize(NOTES_FONT_STORAGE_KEY, DEFAULT_NOTES_FONT_SIZE, 'notesFont');
}
