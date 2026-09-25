/**
 * El botón del sonido de aviso, con su volumen (§6.20, hito 36).
 *
 * El clic hace lo de siempre: activa o silencia. El volumen es una barrita
 * vertical que aparece al pasar el mouse, sin clic de por medio: subirlo un día
 * de apuro y bajarlo después tiene que costar un gesto, no un diálogo. Mostrarla
 * u ocultarla es CSS (`:hover` y `:focus-within`), así que no hay estado acá.
 *
 * Silenciado no hay barrita: lo primero es encenderlo, y eso es el clic.
 *
 * Al lado va, desde el hito 37, `NotifyButton`: la notificación del sistema
 * (§6.20.1). Es otro botón y no una casilla dentro de la barrita: se quiere con
 * el sonido silenciado también, y ahí la barrita no existe. Donde el navegador
 * no tiene notificaciones, no se dibuja.
 *
 * Encendidos, los dos se ven como el `⇄` con equipos: borde y dibujo del color
 * de acento (`icon-button-on`). Apagados, como cualquier botón. Antes se
 * marcaba lo apagado, tachado y gris, y el tachado no se dibuja sobre el SVG de
 * la campana: encendida o apagada se veía casi igual (mejoras de la 0.4.0).
 */

import { MAX_VOLUME, MIN_VOLUME, soundButtonOn, soundButtonTitle, volumePercent } from './notification-sound.js';
import { notifyButtonTitle } from './system-notification.js';
import type { NotificationSoundState, SystemNotifyState } from './useNotificationSound.js';
import { t } from './i18n/index.js';

/** Las teclas que mueven la barrita. Un Tab que pasa por ella no la hace sonar. */
const VOLUME_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

interface SoundControlProps {
  sound: NotificationSoundState;
}

export function SoundControl({ sound }: SoundControlProps): JSX.Element {
  return (
    <span className="sound-control">
      <button
        className={`icon-button${soundButtonOn(sound.enabled, sound.volume) ? ' icon-button-on' : ''}`}
        onClick={sound.toggle}
        title={soundButtonTitle(sound.enabled)}
        aria-pressed={sound.enabled}
      >
        ♪
      </button>
      {sound.enabled && (
        <div className="sound-volume">
          <div className="sound-volume-box">
            <input
              className="sound-volume-slider"
              type="range"
              min={MIN_VOLUME}
              max={MAX_VOLUME}
              step={0.01}
              value={sound.volume}
              onChange={(event) => sound.setVolume(Number(event.target.value))}
              // Suena al soltar, con el mouse o con las flechas: en cada paso
              // del arrastre serían veinte notas encimadas.
              onPointerUp={sound.previewVolume}
              onKeyUp={(event) => {
                if (VOLUME_KEYS.has(event.key)) sound.previewVolume();
              }}
              title={t('sound.volume')}
              aria-label={t('sound.volume')}
            />
            <span className="sound-volume-value">{volumePercent(sound.volume)}%</span>
          </div>
        </div>
      )}
    </span>
  );
}

/** Enciende o apaga la notificación del sistema. null donde el navegador no la tiene. */
export function NotifyButton({ notify }: { notify: SystemNotifyState }): JSX.Element | null {
  if (!notify.supported) return null;
  return (
    <button
      className={`icon-button${notify.enabled ? ' icon-button-on' : ''}`}
      onClick={notify.toggle}
      title={notifyButtonTitle(notify.enabled, notify.permission)}
      aria-pressed={notify.enabled}
    >
      <BellIcon />
    </button>
  );
}

/** Una campana de trazo, como el resto de los iconos: un emoji cambia de color y de forma según el sistema. */
function BellIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false">
      <path
        d="M4 11V7a4 4 0 0 1 8 0v4l1.2 1.5H2.8L4 11zM6.6 14a1.5 1.5 0 0 0 2.8 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
