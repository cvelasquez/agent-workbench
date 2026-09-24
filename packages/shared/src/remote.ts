/**
 * El acceso remoto (hito 37, §14): lo que comparten el servidor y la web.
 *
 * La app sigue escuchando sólo en `127.0.0.1`. "Remoto" es otro equipo de la
 * misma red que llega por un túnel SSH (`ssh -L`) y que, por eso, ve la app como
 * `localhost`. Lo que hace falta para que eso funcione es poco: un puerto que no
 * cambie en cada arranque, y una credencial que tampoco cambie, porque el token
 * de cada arranque sólo se ve en la consola de este equipo.
 *
 * Esa credencial se consigue **emparejando**: desde este equipo se pide un
 * código de un solo uso, y el otro lo presenta en la dirección que abre. Nada de
 * esto nombra una ruta ni viaja fuera del propio equipo: el código y la
 * credencial los arma el servidor, y el servidor guarda sólo el hash.
 */

import { asArrayOf, asBoolean, asFiniteNumber, asLiteral, asNonEmptyString, asRecord, asString, asStringArray } from './validation.js';

/** El puerto fijo por defecto: fuera del rango que Windows y Linux reparten solos. */
export const REMOTE_DEFAULT_PORT = 24837;
/** Por debajo de 1024 hacen falta permisos de administrador. */
export const REMOTE_MIN_PORT = 1024;
export const REMOTE_MAX_PORT = 65535;

/** Parámetro de la dirección que lleva el código para emparejar. */
export const PAIR_QUERY_PARAM = 'pair';

/** Cuánto vale un código para emparejar. */
export const PAIRING_TTL_MS = 5 * 60_000;

/** Tope del nombre de un equipo emparejado. */
export const REMOTE_DEVICE_LABEL_MAX_CHARS = 60;

/** Con cuánto se cierra el socket de un equipo revocado: la web deja de reconectar. */
export const REMOTE_REVOKED_CLOSE_CODE = 4001;

export function isRemotePort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= REMOTE_MIN_PORT && value <= REMOTE_MAX_PORT;
}

/** El nombre de un equipo, en una línea y acotado. Vacío si no queda nada. */
export function cleanDeviceLabel(label: string): string {
  return label.replace(/\s+/g, ' ').trim().slice(0, REMOTE_DEVICE_LABEL_MAX_CHARS);
}

/**
 * En qué está el acceso remoto **en este arranque**.
 *
 *  - `off`: apagado. Ningún equipo emparejado entra, aunque exista en disco.
 *  - `active`: encendido y escuchando en el puerto fijo.
 *  - `restart-needed`: encendido en los ajustes, pero el servidor arrancó con
 *    otro puerto (o apagado): el puerto se elige al arrancar.
 *  - `port-busy`: encendido, pero el puerto fijo estaba ocupado y el servidor
 *    cayó a uno efímero. Nadie puede llegar por el túnel hasta reiniciar con el
 *    puerto libre.
 */
export type RemoteAccessState = 'off' | 'active' | 'restart-needed' | 'port-busy';
export const REMOTE_ACCESS_STATES: readonly RemoteAccessState[] = ['off', 'active', 'restart-needed', 'port-busy'];

/** Un equipo emparejado, como lo ve la interfaz: sin nada secreto. */
export interface RemoteDeviceSummary {
  id: string;
  label: string;
  createdAt: number;
  /** La última vez que se conectó, o null si nunca llegó a hacerlo. */
  lastSeenAt: number | null;
  /** Tiene una ventana conectada ahora mismo. */
  connected: boolean;
}

export interface RemoteAccessStatus {
  /** El ajuste, que puede no coincidir con lo que corre: ver `state`. */
  enabled: boolean;
  /** El puerto de los ajustes. */
  port: number;
  state: RemoteAccessState;
  /** El puerto en el que escucha el servidor ahora. */
  listeningPort: number;
  /** Con qué usuario se entra por SSH a este equipo, según el sistema. */
  sshUser: string;
  /** Con qué nombres se llega a este equipo desde la red: el suyo y sus IP privadas. */
  hostNames: string[];
  /** Hay un código para emparejar vigente. El código mismo sólo lo ve quien lo pidió. */
  pairingActive: boolean;
  devices: RemoteDeviceSummary[];
}

export function parseRemoteDeviceSummary(value: unknown): RemoteDeviceSummary | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const label = asString(record['label']);
  const createdAt = asFiniteNumber(record['createdAt']);
  const connected = asBoolean(record['connected']);
  if (id === null || label === null || createdAt === null || connected === null) return null;
  const rawLastSeen = record['lastSeenAt'];
  const lastSeenAt = rawLastSeen === null || rawLastSeen === undefined ? null : asFiniteNumber(rawLastSeen);
  if (rawLastSeen !== null && rawLastSeen !== undefined && lastSeenAt === null) return null;
  return { id, label, createdAt, lastSeenAt, connected };
}

export function parseRemoteAccessStatus(value: unknown): RemoteAccessStatus | null {
  const record = asRecord(value);
  if (record === null) return null;
  const enabled = asBoolean(record['enabled']);
  const port = asFiniteNumber(record['port']);
  const state = asLiteral(record['state'], REMOTE_ACCESS_STATES);
  const listeningPort = asFiniteNumber(record['listeningPort']);
  const sshUser = asString(record['sshUser']);
  const hostNames = asStringArray(record['hostNames']);
  const pairingActive = asBoolean(record['pairingActive']);
  const devices = asArrayOf(record['devices'], parseRemoteDeviceSummary);
  if (
    enabled === null ||
    port === null ||
    state === null ||
    listeningPort === null ||
    sshUser === null ||
    hostNames === null ||
    pairingActive === null ||
    devices === null
  ) {
    return null;
  }
  return { enabled, port, state, listeningPort, sshUser, hostNames, pairingActive, devices };
}

/** El código que se acaba de pedir, sólo para el socket que lo pidió. */
export interface RemotePairingCode {
  /** Ya con su guion, como se muestra: `K7QM-X2RD`. */
  code: string;
  expiresAt: number;
}

export function parseRemotePairingCode(value: unknown): RemotePairingCode | null {
  const record = asRecord(value);
  if (record === null) return null;
  const code = asNonEmptyString(record['code']);
  const expiresAt = asFiniteNumber(record['expiresAt']);
  return code === null || expiresAt === null ? null : { code, expiresAt };
}

// ---- El teléfono (hito 38, §15) ------------------------------------------------

/**
 * Dónde pega el usuario la línea que autoriza la llave del teléfono. En Windows
 * depende de si su usuario es administrador —el OpenSSH de Windows lee otra
 * lista para ellos, y escribirla pide una consola de administrador—; fuera de
 * Windows es una terminal.
 */
export type PhoneAuthorizeShell = 'powershell-admin' | 'powershell' | 'terminal';
export const PHONE_AUTHORIZE_SHELLS: readonly PhoneAuthorizeShell[] = ['powershell-admin', 'powershell', 'terminal'];

/**
 * Emparejar un teléfono (hito 38): lo que ve **sólo** la ventana que lo pidió.
 *
 * `payload` es el texto del código QR y lleva la llave privada del teléfono,
 * que este equipo arma en memoria y no guarda: por eso no va en el estado que
 * reciben las demás ventanas, y la interfaz no ofrece copiarlo.
 */
export interface RemotePhonePairing {
  payload: string;
  /** La línea que el usuario pega en este equipo para autorizar la llave. */
  authorizeCommand: string;
  shell: PhoneAuthorizeShell;
  /** El código de un solo uso que va dentro del QR, con su guion. */
  code: string;
  expiresAt: number;
}

export function parseRemotePhonePairing(value: unknown): RemotePhonePairing | null {
  const record = asRecord(value);
  if (record === null) return null;
  const payload = asNonEmptyString(record['payload']);
  const authorizeCommand = asNonEmptyString(record['authorizeCommand']);
  const shell = asLiteral(record['shell'], PHONE_AUTHORIZE_SHELLS);
  const code = asNonEmptyString(record['code']);
  const expiresAt = asFiniteNumber(record['expiresAt']);
  if (payload === null || authorizeCommand === null || shell === null || code === null || expiresAt === null) return null;
  return { payload, authorizeCommand, shell, code, expiresAt };
}
