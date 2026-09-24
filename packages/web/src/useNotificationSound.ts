/**
 * Hace sonar el aviso cuando cambia la actividad de cualquier pestaña (§6.20).
 *
 * Mira el mapa de actividad entero, no la pestaña activa: el caso que lo pide
 * es justamente no estar mirando. La decisión de qué suena es de
 * `planChimes`, pura; acá sólo se ejecuta con temporizadores, y se guarda la
 * preferencia, en `localStorage` como el tema: es de esta pantalla, no del
 * espacio de trabajo.
 *
 * Desde el hito 37 el mismo plan dispara también la notificación del sistema
 * (§6.20.1, `system-notification.ts`): avisa lo mismo y cuando lo mismo, pero
 * sólo con la ventana fuera de la vista, y se enciende aparte del sonido.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TerminalActivity, TerminalId } from '@agent-workbench/shared';
import {
  ChimePlayer,
  DEFAULT_VOLUME,
  DONE_HOLD_MS,
  PHONE_CHIME_STORAGE_KEY,
  SOUND_STORAGE_KEY,
  VOLUME_STORAGE_KEY,
  clampVolume,
  parsePhoneChimeSource,
  parseStoredSound,
  parseStoredVolume,
  phoneChimeUrl,
  planChimes,
  webChimeVolume,
  type Chime,
  type PhoneChimeSource,
} from './notification-sound.js';
import { insidePhoneApp } from './narrow-layout.js';
import {
  NOTIFY_STORAGE_KEY,
  parseStoredNotify,
  readNotifyPermission,
  requestNotifyPermission,
  shouldNotify,
  showSystemNotification,
  windowInView,
  type NotifyPermission,
} from './system-notification.js';
import { readStored, writeStored } from './window-prefs.js';

/** La notificación del sistema: si se puede, si está encendida y con qué permiso. */
export interface SystemNotifyState {
  /** false donde el navegador no la tiene: el botón no se dibuja. */
  supported: boolean;
  enabled: boolean;
  permission: NotifyPermission;
  toggle: () => void;
}

/** Lo que el aviso del sistema necesita saber de las pestañas. */
export interface NotifyTabs {
  nameOf: (terminalId: TerminalId) => string;
  /** El clic en el aviso: activa esa pestaña. */
  activate: (terminalId: TerminalId) => void;
}

export interface NotificationSoundState {
  enabled: boolean;
  toggle: () => void;
  /** El pico de ganancia, entre `MIN_VOLUME` y `MAX_VOLUME`. */
  volume: number;
  /** Mientras se arrastra la barrita: guarda y aplica, sin sonar. */
  setVolume: (volume: number) => void;
  /** Al soltarla: suena una vez, para oír lo que se eligió. */
  previewVolume: () => void;
  notify: SystemNotifyState;
  /**
   * Dentro de la app del teléfono, de dónde sale el sonido: del aviso de
   * Android o de la página (`webChimeVolume`). null en un navegador.
   */
  phoneChime: { source: PhoneChimeSource; setSource: (source: PhoneChimeSource) => void } | null;
}

export function useNotificationSound(
  activity: ReadonlyMap<TerminalId, TerminalActivity>,
  tabs: NotifyTabs,
): NotificationSoundState {
  const [enabled, setEnabled] = useState(() => readStored(SOUND_STORAGE_KEY, true, parseStoredSound));
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [volume, setVolumeState] = useState(() =>
    readStored(VOLUME_STORAGE_KEY, DEFAULT_VOLUME, parseStoredVolume),
  );
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const [insideApp] = useState(() => typeof navigator !== 'undefined' && insidePhoneApp(navigator.userAgent));
  const [chimeSource, setChimeSourceState] = useState<PhoneChimeSource>(() =>
    readStored(PHONE_CHIME_STORAGE_KEY, 'system', parsePhoneChimeSource),
  );
  const chimeSourceRef = useRef(chimeSource);
  chimeSourceRef.current = chimeSource;

  const [permission, setPermission] = useState<NotifyPermission>(() => readNotifyPermission());
  const [notifyEnabled, setNotifyEnabled] = useState(() => readStored(NOTIFY_STORAGE_KEY, false, parseStoredNotify));
  const notifyEnabledRef = useRef(notifyEnabled);
  notifyEnabledRef.current = notifyEnabled;
  // Por ref: el nombre de una pestaña cambia sin que eso tenga que rearmar los plazos.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  /** El aviso del sistema de una pestaña. El permiso se mira en el momento: el usuario lo puede quitar. */
  const notifySystem = useCallback((chime: Chime, terminalId: TerminalId): void => {
    if (!shouldNotify(notifyEnabledRef.current, readNotifyPermission(), windowInView())) return;
    showSystemNotification({
      chime,
      terminalId,
      tabName: tabsRef.current.nameOf(terminalId),
      onClick: () => tabsRef.current.activate(terminalId),
    });
  }, []);

  const playerRef = useRef<ChimePlayer | null>(null);
  const previousRef = useRef<ReadonlyMap<TerminalId, TerminalActivity>>(new Map());
  const timersRef = useRef<Map<TerminalId, number>>(new Map());

  /** Un aviso de la actividad: el volumen, o si suena, lo decide `webChimeVolume`. */
  const playChime = useCallback(
    (chime: Chime): void => {
      const player = playerRef.current;
      const level = webChimeVolume(insideApp, chimeSourceRef.current, enabledRef.current, volumeRef.current);
      if (player === null || level === null) return;
      player.volume = level;
      player.play(chime);
    },
    [insideApp],
  );

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
    if (plan.now.length > 0) playChime('attention');
    // El sonido es uno por latido; el aviso del sistema, uno por pestaña: dice cuál.
    for (const terminalId of plan.now) notifySystem('attention', terminalId);
    for (const terminalId of plan.later) {
      timers.set(
        terminalId,
        window.setTimeout(() => {
          timers.delete(terminalId);
          playChime('done');
          notifySystem('done', terminalId);
        }, DONE_HOLD_MS),
      );
    }
  }, [activity, notifySystem, playChime]);

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

  /*
    Encenderla pide el permiso, y sólo queda encendida si el navegador lo dio.
    Con el permiso negado no se puede volver a pedir desde la página: el botón
    lo dice y el usuario lo cambia en los ajustes del sitio.
  */
  const toggleNotify = useCallback(() => {
    if (notifyEnabledRef.current) {
      setNotifyEnabled(false);
      writeStored(NOTIFY_STORAGE_KEY, 'off');
      return;
    }
    void requestNotifyPermission().then((next) => {
      setPermission(next);
      if (next !== 'granted') return;
      setNotifyEnabled(true);
      writeStored(NOTIFY_STORAGE_KEY, 'on');
    });
  }, []);

  const notify: SystemNotifyState = {
    supported: permission !== 'unsupported',
    // Guardada encendida pero con el permiso quitado después: no está encendida.
    enabled: notifyEnabled && permission === 'granted',
    permission,
    toggle: toggleNotify,
  };

  /*
    Elegir el origen en la app: se guarda, se le cuenta a la app —que desde ahí
    saca sus avisos con o sin sonido— y, si es la página, suena una vez para
    oírlo. El toque es el gesto que desbloquea el audio.
  */
  const setChimeSource = useCallback((source: PhoneChimeSource) => {
    setChimeSourceState(source);
    chimeSourceRef.current = source;
    writeStored(PHONE_CHIME_STORAGE_KEY, source);
    window.location.href = phoneChimeUrl(source);
    if (source === 'page') {
      playerRef.current?.unlock();
      playChime('done');
    }
  }, [playChime]);

  const phoneChime = insideApp ? { source: chimeSource, setSource: setChimeSource } : null;

  return { enabled, toggle, volume, setVolume, previewVolume, notify, phoneChime };
}
