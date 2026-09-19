/**
 * Menu contextual minimo.
 *
 * Se cierra con Escape, con un clic afuera y al desplazar la lista de abajo:
 * un menu que queda flotando sobre un panel que ya se movio es peor que no
 * tener menu. El listener de scroll va en captura porque el desplazamiento
 * ocurre en un contenedor interno y no burbujea hasta `window`.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  /** Un menú de opciones: la elegida lleva la marca. Sin el campo, no hay columna de marca. */
  checked?: boolean;
  /** El idioma del texto del ítem, si no es el de la página: el menú de idiomas (§6.23). */
  lang?: string;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  /**
   * El botón que abrió el menú, si lo abrió un botón. Tocarlo no cierra el menú
   * desde acá: lo cierra su propio clic, y si no, se cerraría y se volvería a
   * abrir en el mismo gesto.
   */
  anchor?: HTMLElement | null;
}

export function ContextMenu({ x, y, items, onClose, anchor = null }: ContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Si el menu se sale por abajo o por la derecha, se corre hacia adentro.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const { width, height } = element.getBoundingClientRect();
    setPosition({
      left: Math.max(4, Math.min(x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - height - 4)),
    });
  }, [x, y]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // En captura sobre `window`, este listener corre antes que los de React:
    // un toque adentro del menú lo cerraría antes de que llegue el clic al ítem.
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (menuRef.current?.contains(target) || anchor?.contains(target))) return;
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: `${position.left}px`, top: `${position.top}px` }}
      // El pointerdown de afuera cierra el menu; adentro no debe hacerlo, o el
      // menu se cerraria antes de que el click llegue al item.
      onPointerDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          className="context-menu-item"
          lang={item.lang}
          role={item.checked === undefined ? undefined : 'menuitemradio'}
          aria-checked={item.checked}
          onClick={() => {
            item.onSelect();
            onClose();
          }}
        >
          {item.checked !== undefined && (
            <span className="context-menu-check" aria-hidden="true">
              {item.checked ? '✓' : ''}
            </span>
          )}
          {item.label}
        </button>
      ))}
    </div>
  );
}
