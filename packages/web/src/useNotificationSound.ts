/**
 * Hace sonar el aviso cuando cambia la actividad de cualquier pestaña (§6.20).
 *
 * Mira el mapa de actividad entero, no la pestaña activa: el caso que lo pide
 * es justamente no estar mirando. La decisión de qué suena es de
 * `planChimes`, pura; acá sólo se ejecuta con temporizadores, y se guarda la
 * preferencia, en `localStorage` como el tema: es de esta pantalla, no del
 * espacio de trabajo.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import {
  ChimePlayer,
  DEFAULT_VOLUME,
  DONE_HOLD_MS,
  SOUND_STORAGE_KEY,
  VOLUME_STORAGE_KEY,
  clampVolume,
  parseStoredSound,
  parseStoredVolume,
  planChimes,
} from './notification-sound.js';
import { readStored, writeStored } from './window-prefs.js';

export interface NotificationSoundState {
  enabled: boolean;
  toggle: () => void;
  /** El pico de ganancia, entre `MIN_VOLUME` y `MAX_VOLUME`. */
  volume: number;
  /** Mientras se arrastra la barrita: guarda y aplica, sin sonar. */
  setVolume: (volume: number) => void;
  /** Al soltarla: suena una vez, para oír lo que se eligió. */
  previewVolume: () => void;
}

export function useNotificationSound(
  activity: ReadonlyMap<TerminalId, TerminalActivity>,
): NotificationSoundState {
  const [enabled, setEnabled] = useState(() => readStored(SOUND_STORAGE_KEY, true, parseStoredSound));
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [volume, setVolumeState] = useState(() =>
    readStored(VOLUME_STORAGE_KEY, DEFAULT_VOLUME, parseStoredVolume),
  );
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const playerRef = useRef<ChimePlayer | null>(null);
  const previousRef = useRef<ReadonlyMap<TerminalId, TerminalActivity>>(new Map());
  const timersRef = useRef<Map<TerminalId, number>>(new Map());

  // El navegador sólo deja sonar después de un gesto: el primer clic o tecla
  // despierta el contexto, y se deja de escuchar en cuanto quedó listo.
  useEffect(() => {
    const player = new ChimePlayer();
    player.volume = volumeRef.current;
    playerRef.current = player;
    const unlock = (): void => {
      player.unlock();
      if (player.ready) {
        window.removeEventListener('pointerdown', unlock);
        window.removeEventListener('keydown', unlock);
      }
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const plan = planChimes(previousRef.current, activity);
    previousRef.current = new Map(activity);
    const timers = timersRef.current;

    for (const terminalId of plan.cancel) {
      const timer = timers.get(terminalId);
      if (timer !== undefined) {
        window.clearTimeout(timer);
        timers.delete(terminalId);
      }
    }
    // La preferencia se mira al sonar, no al planificar: apagarla con un
    // "terminó" en espera lo silencia también. Dos pestañas que se frenan en
    // el mismo latido suenan una vez.
    if (plan.now.length > 0 && enabledRef.current) playerRef.current?.play('attention');
    for (const terminalId of plan.later) {
      timers.set(
        terminalId,
        window.setTimeout(() => {
          timers.delete(terminalId);
          if (enabledRef.current) playerRef.current?.play('done');
        }, DONE_HOLD_MS),
      );
    }
  }, [activity]);

  // Al desmontar no queda ningún plazo vivo.
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  const toggle = useCallback(() => {
    setEnabled((current) => {
      const next = !current;
      writeStored(SOUND_STORAGE_KEY, next ? 'on' : 'off');
      return next;
    });
    // Encenderlo lo hace sonar una vez: así se sabe cómo suena sin esperar a
    // que el agente termine algo. El clic es el gesto que lo desbloquea.
    if (!enabledRef.current) {
      playerRef.current?.unlock();
      playerRef.current?.play('done');
    }
  }, []);

  const setVolume = useCallback((next: number) => {
    const clamped = clampVolume(next);
    setVolumeState(clamped);
    writeStored(VOLUME_STORAGE_KEY, String(clamped));
    if (playerRef.current !== null) playerRef.current.volume = clamped;
  }, []);

  // Suena al soltar y no en cada paso del arrastre: veinte notas encimadas no
  // dicen cómo quedó. Silenciado no suena: la barrita no enciende el aviso.
  const previewVolume = useCallback(() => {
    if (!enabledRef.current) return;
    playerRef.current?.unlock();
    playerRef.current?.play('done');
  }, []);

  return { enabled, toggle, volume, setVolume, previewVolume };
}
