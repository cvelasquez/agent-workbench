/**
 * El acceso remoto (hito 37, §14), del lado de la interfaz: lo que se arma con
 * el estado que manda el servidor. Sin React ni JSX a propósito, para que lo
 * pruebe `check-remote-access.mjs`.
 *
 * Dos textos de acá los copia el usuario a otro equipo, y por eso se arman en un
 * solo sitio: el comando del túnel y la dirección para emparejar. Los dos usan
 * **el mismo puerto en los dos extremos** y `localhost`: el servidor compara el
 * puerto del `Host` con el suyo, y fuera de `localhost` el navegador apaga lo
 * que la app necesita (`crypto.randomUUID`, el portapapeles, las notificaciones).
 */

import {
  PAIR_QUERY_PARAM,
  REMOTE_MAX_PORT,
  REMOTE_MIN_PORT,
  isRemotePort,
  type PhoneAuthorizeShell,
  type RemoteAccessState,
  type RemoteAccessStatus,
  type RemoteDeviceSummary,
} from '@agent-workbench/shared';
import { t } from './i18n/index.js';
import { formatWhen } from './i18n/format.js';

/** Lo que va en el lugar del usuario si el sistema no lo dijo: se nota que hay que cambiarlo. */
const USER_PLACEHOLDER = 'USER';

/**
 * El comando que se corre en el otro equipo. `-N`: sólo el túnel, sin abrir una
 * terminal allá. `127.0.0.1` del lado de acá, y no `localhost`: es donde escucha
 * la app, y no depende de cómo resuelva `localhost` este equipo.
 */
export function sshTunnelCommand(status: Pick<RemoteAccessStatus, 'port' | 'sshUser'>, host: string): string {
  const user = status.sshUser.length > 0 ? status.sshUser : USER_PLACEHOLDER;
  // Un usuario con espacio ("Ana Perez") rompe el argumento sin comillas.
  const target = /\s/.test(user) ? `"${user}@${host}"` : `${user}@${host}`;
  return `ssh -N -L ${status.port}:127.0.0.1:${status.port} ${target}`;
}

/** La dirección que abre el otro equipo todos los días. */
export function remoteUrl(port: number): string {
  return `http://localhost:${port}`;
}

/** La que abre una vez, con el código. */
export function pairingUrl(port: number, code: string): string {
  return `${remoteUrl(port)}/?${PAIR_QUERY_PARAM}=${code}`;
}

/** El primer nombre de la lista: el del equipo. Las IP son el respaldo. */
export function defaultHostName(hostNames: readonly string[]): string {
  return hostNames[0] ?? 'localhost';
}

export function remoteStateText(state: RemoteAccessState, port: number): string {
  switch (state) {
    case 'off':
      return t('remote.state.off');
    case 'active':
      return t('remote.state.active', { port });
    case 'restart-needed':
      return t('remote.state.restartNeeded');
    case 'port-busy':
      return t('remote.state.portBusy', { port });
  }
}

/** El puerto que tecleó el usuario, o null si no sirve. Sólo dígitos: `24837.5` o `2e4` no. */
export function parsePortInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return isRemotePort(port) ? port : null;
}

export function portRangeText(): string {
  return t('remote.portInvalid', { min: REMOTE_MIN_PORT, max: REMOTE_MAX_PORT });
}

/** Segundos que le quedan al código, nunca negativos. */
export function pairingSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** `4:07`. */
export function formatCountdown(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function deviceSeenText(device: RemoteDeviceSummary, now: number = Date.now()): string {
  if (device.connected) return t('remote.device.connected');
  if (device.lastSeenAt === null) return t('remote.device.never');
  return t('remote.device.lastSeen', { when: formatWhen(device.lastSeenAt, now) });
}

export function devicePairedText(device: RemoteDeviceSummary, now: number = Date.now()): string {
  return t('remote.device.paired', { when: formatWhen(device.createdAt, now) });
}

/** Dónde se pega la línea que autoriza la llave del teléfono (hito 38). */
export function phoneAuthorizeText(shell: PhoneAuthorizeShell): string {
  switch (shell) {
    case 'powershell-admin':
      return t('remote.phone.authorize.admin');
    case 'powershell':
      return t('remote.phone.authorize.powershell');
    case 'terminal':
      return t('remote.phone.authorize.terminal');
  }
}

/** Un sistema en el paso 1: cómo se enciende su servidor SSH. */
export interface SshSetup {
  /** El `process.platform` que le corresponde, para abrir de entrada el de este equipo. */
  platform: 'win32' | 'darwin' | 'linux';
  /** El nombre del sistema: no se traduce. */
  label: string;
  hint: string;
  /** Lo que se pega, o null si se hace con clics. */
  command: string | null;
}

/**
 * El paso 1 del diálogo, sistema por sistema: lo mismo que la guía del README,
 * para no mandar a nadie a leerla. La app no lo corre: pide administrador.
 */
export function sshSetups(): SshSetup[] {
  return [
    {
      platform: 'win32',
      label: 'Windows',
      hint: t('remote.ssh.windows'),
      command: [
        'Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0',
        'Start-Service sshd',
        'Set-Service -Name sshd -StartupType Automatic',
      ].join('\n'),
    },
    { platform: 'darwin', label: 'macOS', hint: t('remote.ssh.macos'), command: null },
    {
      platform: 'linux',
      label: 'Linux',
      hint: t('remote.ssh.linux'),
      command: ['sudo apt install openssh-server', 'sudo systemctl enable --now ssh'].join('\n'),
    },
  ];
}

/** El sistema de este equipo, que el diálogo muestra abierto. Uno que no está en la lista cuenta como Linux. */
export function hostSshPlatform(platform: string): SshSetup['platform'] {
  return platform === 'win32' || platform === 'darwin' ? platform : 'linux';
}

/**
 * Se puede pedir un código: el acceso está encendido **y corriendo en el puerto
 * de los ajustes**. Con un reinicio pendiente no se ofrece: la dirección que se
 * mostraría lleva el puerto nuevo, y el servidor todavía escucha en el otro.
 */
export function canPair(status: RemoteAccessStatus | null): boolean {
  return status !== null && status.state === 'active';
}

/**
 * El `⇄` de la cabecera se ve encendido: el acceso está corriendo **y** hay al
 * menos un equipo emparejado. Encendido y sin ningún equipo no hay nadie que
 * pueda entrar, y verlo igual que con equipos confundía (mejoras de la 0.4.0).
 */
export function remoteButtonOn(status: Pick<RemoteAccessStatus, 'state' | 'devices'> | null): boolean {
  return status !== null && status.state === 'active' && status.devices.length > 0;
}
