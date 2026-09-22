/**
 * Toque largo (hito 38, §6.25): lo que en la PC es Ctrl+clic.
 *
 * Solo con el dedo o el lápiz: un clic largo con el mouse no es un gesto que
 * nadie espere. Al disparar, el clic que sigue al soltar se traga —si no, la
 * fila se seleccionaría y se abriría a la vez— y el menú contextual que el
 * navegador ofrece tras el toque largo se cancela, porque el gesto ya es de la
 * fila.
 */

import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from 'react';

export const LONG_PRESS_MS = 500;
/** Moverse más que esto antes del plazo es un desplazamiento, no un toque largo. */
const LONG_PRESS_SLOP_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
}

export function useLongPress(onLongPress: () => void): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.pointerType === 'mouse' || event.button !== 0) return;
      clear();
      fired.current = false;
      origin.current = { x: event.clientX, y: event.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        callback.current();
      }, LONG_PRESS_MS);
    },
    [clear],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (start === null) return;
      if (Math.abs(event.clientX - start.x) > LONG_PRESS_SLOP_PX || Math.abs(event.clientY - start.y) > LONG_PRESS_SLOP_PX) {
        clear();
      }
    },
    [clear],
  );

  const onContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    // Con el dedo, el menú del navegador llega junto con el toque largo.
    if (fired.current || timer.current !== null) event.preventDefault();
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (!fired.current) return;
    fired.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp: clear, onPointerCancel: clear, onContextMenu, onClickCapture };
}
