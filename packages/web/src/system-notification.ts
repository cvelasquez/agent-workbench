/**
 * La notificación del sistema (hito 37, §6.20.1).
 *
 * Es la otra mitad del sonido de aviso, por el mismo pedido y un poco más
 * lejos: el usuario no sólo no está mirando la pestaña, está en otra ventana —o
 * jugando en otro equipo, con la app abierta por el túnel—. **Avisa lo mismo y
 * cuando lo mismo que el sonido**: la decisión es de `planChimes` y acá no se
 * repite. Lo único propio es dónde sale y cuándo no hace falta.
 *
 *  - **Sólo si la ventana no está a la vista.** Mirando la app alcanza con el
 *    sonido; un cartel del sistema encima de lo que uno mira estorba.
 *  - **Apagada por defecto**, y pide el permiso del navegador recién cuando el
 *    usuario la enciende: es el gesto que el navegador exige, y nadie quiere el
 *    cartel del permiso al abrir una app por primera vez.
 *  - **Es independiente del sonido**: se puede querer uno sin el otro.
 *  - **No existe fuera de un contexto seguro.** Por `localhost` —también por el
 *    túnel— lo es; si algún día no, el botón no se dibuja.
 *
 * El aviso nombra la pestaña. No sale del equipo: lo muestra el sistema
 * operativo donde corre este navegador.
 *
 * Sin React ni JSX: la decisión es pura y la cubre `check-remote-access.mjs`; lo
 * que toca el navegador está al final.
 */

import { t } from './i18n/index.js';
import type { Chime } from './notification-sound.js';

export const NOTIFY_STORAGE_KEY = 'agent-workbench.notify';

/** `unsupported`: el navegador no tiene la API acá (no es un contexto seguro, o no existe). */
export type NotifyPermission = 'granted' | 'denied' | 'default' | 'unsupported';

/** La preferencia guardada, o null si no es ninguna de las dos. */
export function parseStoredNotify(raw: string): boolean | null {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  return null;
}

/** Sale un aviso del sistema: encendida, con permiso, y sin la ventana a la vista. */
export function shouldNotify(enabled: boolean, permission: NotifyPermission, windowInView: boolean): boolean {
  return enabled && permission === 'granted' && !windowInView;
}

export function notifyButtonTitle(enabled: boolean, permission: NotifyPermission): string {
  if (permission === 'denied') return t('sound.notify.blocked');
  return enabled ? t('sound.notify.on') : t('sound.notify.off');
}

export function notificationBody(chime: Chime, tabName: string): string {
  return chime === 'attention' ? t('notify.attention', { tab: tabName }) : t('notify.done', { tab: tabName });
}

/** El nombre de una pestaña para el aviso: su etiqueta, o la última carpeta de su ruta. */
export function tabNameFor(tab: { label: string; cwd: string } | undefined): string {
  if (tab === undefined) return '';
  if (tab.label.length > 0) return tab.label;
  return tab.cwd.split(/[\\/]/).filter((part) => part.length > 0).pop() ?? tab.cwd;
}

// ---- Lo que toca el navegador --------------------------------------------------

export function readNotifyPermission(): NotifyPermission {
  if (typeof window === 'undefined' || !('Notification' in window) || !window.isSecureContext) return 'unsupported';
  return Notification.permission;
}

/** Pide el permiso. Tiene que llamarse desde un gesto del usuario. */
export async function requestNotifyPermission(): Promise<NotifyPermission> {
  if (readNotifyPermission() === 'unsupported') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return readNotifyPermission();
  }
}

export function windowInView(): boolean {
  return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Muestra el aviso. `tag` es la pestaña: un aviso nuevo de la misma reemplaza al
 * anterior en vez de apilarse. El clic trae la ventana al frente y activa la
 * pestaña.
 */
export function showSystemNotification(options: {
  chime: Chime;
  terminalId: string;
  tabName: string;
  onClick: () => void;
}): void {
  try {
    const notification = new Notification('Agent Workbench', {
      body: notificationBody(options.chime, options.tabName),
      tag: `agent-workbench:${options.terminalId}`,
    });
    notification.onclick = () => {
      window.focus();
      options.onClick();
      notification.close();
    };
  } catch {
    // Algunos navegadores sólo dejan crearlas desde un service worker. Sin aviso
    // del sistema queda el sonido, que no depende de esto.
  }
}
