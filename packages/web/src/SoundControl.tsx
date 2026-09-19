/**
 * El botón del sonido de aviso, con su volumen (§6.20, hito 36).
 *
 * El clic hace lo de siempre: activa o silencia. El volumen es una barrita
 * vertical que aparece al pasar el mouse, sin clic de por medio: subirlo un día
 * de apuro y bajarlo después tiene que costar un gesto, no un diálogo. Mostrarla
 * u ocultarla es CSS (`:hover` y `:focus-within`), así que no hay estado acá.
 *
 * Silenciado no hay barrita: lo primero es encenderlo, y eso es el clic.
 */

import { MAX_VOLUME, MIN_VOLUME, soundButtonTitle, volumePercent } from './notification-sound.js';
import type { NotificationSoundState } from './useNotificationSound.js';
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
        className={`icon-button${sound.enabled ? '' : ' icon-button-muted'}`}
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
