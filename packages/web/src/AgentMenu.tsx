/**
 * Elegir con que CLI se abre una pestana.
 *
 * Solo existe con mas de una CLI instalada, y nunca es el camino por defecto:
 * lo abre la flecha del boton partido (`AgentSplitButton`). El clic en el `+`
 * abre directo con la CLI de siempre para ese proyecto, y `Alt+T` tampoco
 * pregunta. Quien trabaja con una sola no paga un clic mas por tener otra.
 *
 * Tres decisiones, las tres por algo que ya paso en esta app:
 *
 *  - **Se dibuja en `document.body`, con un portal.** La barra de pestanas
 *    recorta lo que se sale (`overflow-x: hidden`) y la barra lateral hace
 *    scroll: un menu adentro saldria cortado. Es la misma razon que el visor de
 *    imagenes (CLAUDE.md 6.10).
 *  - **`Escape` cierra y no le llega a nadie mas.** En el cuadro de escritura
 *    esa tecla interrumpe a la CLI; cerrar un menu no puede cortarle el trabajo
 *    al agente. Va en captura y detiene la propagacion.
 *  - **Un clic afuera cierra**, igual que el menu contextual. La flecha que lo
 *    abrio no cuenta como afuera: si contara, el clic que lo cierra lo volveria
 *    a abrir.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentId, AgentInfo } from '@agent-workbench/shared';
import { menuAgents, menuPlacement, menuStartIndex, menuStep, scrollClosesMenu } from './agent-ui.js';

interface AgentMenuProps {
  /** Todas las anunciadas: el menu muestra solo las instaladas, en su orden. */
  agents: readonly AgentInfo[];
  /** La que arranca resaltada: la que abriria el clic directo. */
  preselected: AgentId | null;
  /**
   * El boton que lo abrio. De ahi sale la posicion, y es a donde vuelve el foco
   * al cerrar con `Escape`.
   */
  anchor: HTMLElement;
  /** Lo que el lector de pantalla dice del menu. "Abrir con" por omision. */
  label?: string;
  onPick: (agent: AgentId) => void;
  onClose: () => void;
}

export function AgentMenu({ agents, preselected, anchor, label = 'Abrir con', onPick, onClose }: AgentMenuProps): JSX.Element {
  const items = useMemo(() => menuAgents(agents), [agents]);
  const [active, setActive] = useState(() => menuStartIndex(items, preselected));
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Se mide antes de pintar: un menu que aparece en un lugar y salta a otro se
  // ve, aunque dure un cuadro.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (element === null) return;
    const rect = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    setPosition(
      menuPlacement(
        { left: rect.left, top: rect.top, bottom: rect.bottom },
        { width: size.width, height: size.height },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [anchor]);

  useEffect(() => {
    itemRefs.current[active]?.focus();
  }, [active, position]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        anchor.focus();
        return;
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        event.stopPropagation();
        setActive((current) => menuStep(current, event.key === 'ArrowDown' ? 1 : -1, items.length));
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        const chosen = items[active];
        if (chosen !== undefined) onPick(chosen.id);
        return;
      }
      // Salir con Tab es irse del menu: se cierra y el foco sigue su camino.
      if (event.key === 'Tab') onClose();
    };

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (menuRef.current?.contains(target) || anchor.contains(target))) return;
      onClose();
    };

    // Un menu que queda flotando sobre algo que ya se movio es peor que no
    // tener menu: el scroll de la barra lateral y el cambio de tamano lo cierran.
    // Solo un scroll que puede mover el boton: el de un campo de texto que
    // pierde el foco no (`scrollClosesMenu`).
    const onScroll = (event: Event): void => {
      if (scrollClosesMenu(event.target, anchor, menuRef.current)) onClose();
    };

    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [active, anchor, items, onClose, onPick]);

  return createPortal(
    <div
      ref={menuRef}
      className="agent-menu"
      role="menu"
      aria-label={label}
      style={
        position === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: `${position.left}px`, top: `${position.top}px` }
      }
    >
      {items.map((agent, index) => (
        <button
          key={agent.id}
          ref={(element) => {
            itemRefs.current[index] = element;
          }}
          className={`agent-menu-item${index === active ? ' agent-menu-item-active' : ''}`}
          role="menuitem"
          tabIndex={index === active ? 0 : -1}
          onMouseEnter={() => setActive(index)}
          onClick={() => onPick(agent.id)}
        >
          <span className="agent-menu-label">{agent.label}</span>
          {agent.version !== null && <span className="agent-menu-version">{agent.version}</span>}
        </button>
      ))}
    </div>,
    document.body,
  );
}
