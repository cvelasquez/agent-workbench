/**
 * Un divisor arrastrable.
 *
 * Los tres bordes que se pueden mover —la barra de proyectos, la columna
 * derecha y el alto de la consola— hacen exactamente lo mismo y solo se
 * diferencian en de donde sale el numero: `clientX` para el borde izquierdo,
 * `innerWidth - clientX` para el derecho, `innerHeight - clientY` para la
 * consola. Eso es `measure`, y es lo unico que cambia.
 *
 * Dos detalles que no son adorno:
 *
 *  - **`setPointerCapture`.** Sin el, el arrastre se pierde en cuanto el mouse
 *    pasa por encima de la terminal, que es justo lo que hay del otro lado del
 *    divisor.
 *  - **Se guarda al soltar, no en cada movimiento.** Arrastrar dispara decenas
 *    de eventos por segundo y `localStorage` es sincrono.
 */

import { useCallback, useRef } from 'react';

export interface DragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLDivElement>) => void;
}

interface DragSizeOptions {
  min: number;
  max: number;
  /**
   * El tamano actual.
   *
   * Solo se usa para el caso de agarrar el divisor y soltarlo **sin mover**:
   * ahi no hay ningun `pointermove` del que sacar un numero, y sin esto se
   * persistia el minimo — el valor con el que arrancaba el ultimo medido. No
   * se veia hasta la recarga siguiente, porque `onChange` tampoco llegaba a
   * correr. Con esto, un clic sin arrastre vuelve a guardar lo que ya habia.
   */
  value: number;
  /** Tamano que corresponde a la posicion del puntero, sin acotar. */
  measure: (event: React.PointerEvent<HTMLDivElement>) => number;
  /** Se llama en cada movimiento con el valor ya acotado. */
  onChange: (value: number) => void;
  /** Se llama una vez al soltar, con el ultimo valor. Ahi va la persistencia. */
  onCommit: (value: number) => void;
  /**
   * Lo que haya que hacer al tomar el divisor.
   *
   * Recibe el evento porque hay divisores que necesitan saber **desde donde**
   * arranco el arrastre: el del cuadro de escritura mide contra el borde de
   * abajo del cuadro, y entre el divisor y ese borde puede haber fichas de
   * adjuntos. Sin el desfase inicial, el alto pega un salto al primer
   * movimiento. Los tres divisores de la ventana lo ignoran.
   */
  onStart?: (event: React.PointerEvent<HTMLDivElement>) => void;
}

export function useDragSize({
  min,
  max,
  value,
  measure,
  onChange,
  onCommit,
  onStart,
}: DragSizeOptions): DragHandlers {
  const dragging = useRef(false);
  const latest = useRef(value);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      dragging.current = true;
      // Punto de partida por si se suelta sin mover: ver `value`.
      latest.current = value;
      onStart?.(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
    },
    [onStart, value],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const next = Math.min(max, Math.max(min, measure(event)));
      latest.current = next;
      onChange(next);
    },
    [max, min, measure, onChange],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      dragging.current = false;
      event.currentTarget.releasePointerCapture(event.pointerId);
      onCommit(latest.current);
    },
    [onCommit],
  );

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp };
}
