/**
 * El menu del reloj del cuadro (hito 51, §6.39): programar el envio de lo
 * escrito. Dos atajos (en una hora, manana a las 9) y un dia y una hora
 * elegidos a mano, con los selectores del navegador.
 *
 * Se arma como el menu de elegir CLI (`AgentMenu`) y por lo mismo: va en
 * `document.body` con un portal, para que nada lo recorte; `Escape` lo cierra
 * sin llegar al cuadro, donde interrumpiria al agente; un clic afuera o el
 * scroll lo cierran. Cambiar el tamano de la ventana no: lo vuelve a ubicar.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacement, scrollClosesMenu } from './agent-ui.js';
import { formatDayTime } from './i18n/format.js';
import { t, type MessageKey } from './i18n/index.js';
import {
  customDefaults,
  customScheduleAt,
  dateInputBounds,
  quickSchedules,
  scheduleTimeHint,
  type QuickSchedule,
} from './scheduled-ui.js';

const QUICK_LABELS: Readonly<Record<QuickSchedule['id'], MessageKey>> = {
  'in-hour': 'scheduled.menu.inHour',
  'tomorrow-morning': 'scheduled.menu.tomorrow',
};

interface ScheduleMenuProps {
  /** El reloj que lo abrio: de ahi sale la posicion, y ahi vuelve el foco al cerrar con `Escape`. */
  anchor: HTMLElement;
  onPick: (sendAt: number) => void;
  onClose: () => void;
}

export function ScheduleMenu({ anchor, onPick, onClose }: ScheduleMenuProps): JSX.Element {
  // La hora de abrirlo: los atajos no se corren mientras se mira el menu.
  const [openedAt] = useState(() => Date.now());
  const quick = useMemo(() => quickSchedules(openedAt), [openedAt]);
  const bounds = useMemo(() => dateInputBounds(openedAt), [openedAt]);
  const [custom, setCustom] = useState(() => customDefaults(openedAt));
  const customAt = customScheduleAt(custom.date, custom.time);
  // Contra la hora de ahora, no la de abrirlo: si el menu quedo abierto, la hora elegida pudo pasar.
  const hint = scheduleTimeHint(customAt, Date.now());

  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const focusedRef = useRef(false);

  const place = useCallback(() => {
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

  // Se mide antes de pintar, como el menu de CLIs: uno que aparece y salta se ve.
  useLayoutEffect(place, [place]);

  // El foco va al primer atajo una sola vez: volver a ubicarlo no se lo saca a un campo.
  useEffect(() => {
    if (position === null || focusedRef.current) return;
    focusedRef.current = true;
    firstRef.current?.focus();
  }, [position]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
      anchor.focus();
    };
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (target instanceof Node && (menuRef.current?.contains(target) || anchor.contains(target))) return;
      onClose();
    };
    const onScroll = (event: Event): void => {
      if (scrollClosesMenu(event.target, anchor, menuRef.current)) onClose();
    };
    /*
      Un cambio de tamano lo vuelve a ubicar en vez de cerrarlo, como hace el de
      CLIs. En el telefono este menu se abre con el teclado en pantalla: tocar el
      reloj le saca el foco al cuadro, el teclado se va, la ventana crece y el
      reloj baja. Medido en el Chrome de un Android 15 (emulador): con el teclado
      la pagina mide 470 px de alto, y al tocar el reloj vuelve a 806 con el menu
      ya abierto. Cerrado con eso, el menu se iba solo apenas se abria.
    */
    const onResize = (): void => {
      if (anchor.isConnected) place();
      else onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [anchor, onClose, place]);

  return createPortal(
    <div
      ref={menuRef}
      className="schedule-menu"
      role="dialog"
      aria-label={t('scheduled.menu.title')}
      style={
        position === null
          ? { left: 0, top: 0, visibility: 'hidden' }
          : { left: `${position.left}px`, top: `${position.top}px` }
      }
    >
      <div className="schedule-menu-title">{t('scheduled.menu.title')}</div>
      {quick.map((option, index) => (
        <button
          key={option.id}
          ref={index === 0 ? firstRef : undefined}
          className="schedule-menu-item"
          onClick={() => onPick(option.at)}
        >
          <span className="schedule-menu-label">{t(QUICK_LABELS[option.id])}</span>
          <span className="schedule-menu-when">{formatDayTime(option.at)}</span>
        </button>
      ))}
      <div className="schedule-menu-custom">
        <label className="schedule-menu-field">
          <span>{t('scheduled.menu.day')}</span>
          <input
            type="date"
            value={custom.date}
            min={bounds.min}
            max={bounds.max}
            onChange={(event) => setCustom((current) => ({ ...current, date: event.target.value }))}
          />
        </label>
        <label className="schedule-menu-field">
          <span>{t('scheduled.menu.time')}</span>
          <input
            type="time"
            value={custom.time}
            onChange={(event) => setCustom((current) => ({ ...current, time: event.target.value }))}
          />
        </label>
        <button
          className="primary-button primary-button-small"
          disabled={hint !== null || customAt === null}
          title={hint ?? undefined}
          onClick={() => {
            if (customAt !== null) onPick(customAt);
          }}
        >
          {t('scheduled.menu.schedule')}
        </button>
      </div>
      {hint !== null && <p className="schedule-menu-hint">{hint}</p>}
    </div>,
    document.body,
  );
}
