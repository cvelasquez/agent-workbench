/**
 * El acceso remoto (hito 37, §14): lo que se decide sin tocar disco ni red.
 *
 * Todo lo que cuida quién entra está acá, puro, para que lo pruebe
 * `check-remote-access.mjs` con un reloj y un azar de mentira:
 *
 *  - **El código para emparejar** (`PairingDesk`). Ocho caracteres de un
 *    alfabeto sin letras confundibles, unos 40 bits. Vale cinco minutos, sirve
 *    una vez y a los cinco intentos fallidos muere. Sin código vigente no se
 *    compara nada: un `?pair=` suelto no es un intento contra nada.
 *  - **El libro de equipos** (`DeviceBook`). De cada equipo se guarda el hash
 *    de su credencial, nunca la credencial: son 32 bytes al azar, así que un
 *    sha256 alcanza —no hay nada que adivinar por diccionario—.
 *  - **Qué corre** (`remoteAccessState`): el puerto se elige al arrancar, así
 *    que lo que dicen los ajustes y lo que está escuchando pueden no coincidir.
 *  - **Qué no puede pedir un equipo remoto** (`remoteRefusal`).
 *
 * El servidor no distingue al remoto por la red: por el túnel SSH todo le llega
 * desde `127.0.0.1`. Lo distingue por **con qué credencial entró**.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { NetworkInterfaceInfo } from 'node:os';
import {
  PAIRING_TTL_MS,
  asArrayFiltered,
  asFiniteNumber,
  asNonEmptyString,
  asRecord,
  asString,
  cleanDeviceLabel,
  serverText,
  type ClientMessageType,
  type RemoteAccessState,
  type RemotePairingCode,
  type ServerText,
} from '@agent-workbench/shared';

// ---- El código para emparejar --------------------------------------------------

/** 32 símbolos, sin `0`/`O` ni `1`/`I`: se lee en una pantalla y se teclea en otra. */
export const PAIRING_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIRING_CODE_CHARS = 8;
/** Con el quinto intento fallido el código muere, aunque no haya vencido. */
export const PAIRING_MAX_FAILURES = 5;

export type RandomBytes = (size: number) => Buffer;

/** `K7QMX2RD` → `K7QM-X2RD`. */
export function formatPairingCode(raw: string): string {
  const half = PAIRING_CODE_CHARS / 2;
  return `${raw.slice(0, half)}-${raw.slice(half)}`;
}

/** Lo que tecleó alguien, sin guiones ni espacios y en mayúsculas; null si no tiene la forma de un código. */
export function normalizePairingCode(input: string): string | null {
  const raw = input.replace(/[\s-]/g, '').toUpperCase();
  if (raw.length !== PAIRING_CODE_CHARS) return null;
  for (const char of raw) {
    if (!PAIRING_ALPHABET.includes(char)) return null;
  }
  return raw;
}

function sameText(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

/**
 * `ok`: era el código y quedó gastado. `wrong`: había uno vigente y no era ese;
 * cuenta como intento. `none`: no había contra qué comparar —ni vigente, ni
 * con forma de código—, y no cuenta.
 */
export type PairingOutcome = 'ok' | 'wrong' | 'none';

export interface PairingDeskDeps {
  now: () => number;
  randomBytes: RandomBytes;
}

export class PairingDesk {
  private current: { raw: string; expiresAt: number; failures: number } | null = null;

  constructor(private readonly deps: PairingDeskDeps) {}

  /** Un código nuevo. Reemplaza al que hubiera: nunca hay dos vigentes. */
  start(): RemotePairingCode {
    const bytes = this.deps.randomBytes(PAIRING_CODE_CHARS);
    let raw = '';
    // 256 es múltiplo de 32: cada símbolo sale con la misma probabilidad.
    for (let i = 0; i < PAIRING_CODE_CHARS; i++) raw += PAIRING_ALPHABET[(bytes[i] ?? 0) % PAIRING_ALPHABET.length];
    const expiresAt = this.deps.now() + PAIRING_TTL_MS;
    this.current = { raw, expiresAt, failures: 0 };
    return { code: formatPairingCode(raw), expiresAt };
  }

  cancel(): void {
    this.current = null;
  }

  isActive(): boolean {
    if (this.current !== null && this.deps.now() >= this.current.expiresAt) this.current = null;
    return this.current !== null;
  }

  /** Cuándo vence el vigente, o null. */
  expiresAt(): number | null {
    return this.isActive() ? (this.current?.expiresAt ?? null) : null;
  }

  redeem(input: string): PairingOutcome {
    if (!this.isActive() || this.current === null) return 'none';
    const raw = normalizePairingCode(input);
    if (raw === null) return 'none';
    if (sameText(raw, this.current.raw)) {
      this.current = null;
      return 'ok';
    }
    this.current.failures += 1;
    if (this.current.failures >= PAIRING_MAX_FAILURES) this.current = null;
    return 'wrong';
  }
}

// ---- El libro de equipos -------------------------------------------------------

export const REMOTE_DEVICES_VERSION = 1;
/** Tope de equipos emparejados: es una casa, no un servicio. */
export const REMOTE_MAX_DEVICES = 20;

/** Un equipo como se guarda. `hash` es el sha256 de su credencial. */
export interface RemoteDevice {
  id: string;
  label: string;
  hash: string;
  createdAt: number;
  lastSeenAt: number | null;
}

export function hashCredential(credential: string): string {
  return createHash('sha256').update(credential, 'utf8').digest('hex');
}

export interface DeviceBookDeps {
  now: () => number;
  randomBytes: RandomBytes;
  randomId: () => string;
}

/** Lo que `security.ts` necesita del libro: a quién pertenece una credencial. */
export interface DeviceVerifier {
  match(credential: string): { id: string } | null;
}

export class DeviceBook implements DeviceVerifier {
  private devices: RemoteDevice[] = [];

  constructor(private readonly deps: DeviceBookDeps) {}

  load(devices: readonly RemoteDevice[]): void {
    this.devices = devices.slice(0, REMOTE_MAX_DEVICES).map((device) => ({ ...device }));
  }

  /** Para guardar: con el hash. */
  snapshot(): RemoteDevice[] {
    return this.devices.map((device) => ({ ...device }));
  }

  /** Para mostrar: sin el hash. */
  list(): Array<Omit<RemoteDevice, 'hash'>> {
    return this.devices.map(({ id, label, createdAt, lastSeenAt }) => ({ id, label, createdAt, lastSeenAt }));
  }

  get size(): number {
    return this.devices.length;
  }

  /** Un equipo nuevo y su credencial, que no queda guardada en ningún lado; null si ya no entran más. */
  enroll(label: string): { device: RemoteDevice; credential: string } | null {
    if (this.devices.length >= REMOTE_MAX_DEVICES) return null;
    const credential = this.deps.randomBytes(32).toString('base64url');
    const device: RemoteDevice = {
      id: this.deps.randomId(),
      label: cleanDeviceLabel(label) || 'Device',
      hash: hashCredential(credential),
      createdAt: this.deps.now(),
      lastSeenAt: null,
    };
    this.devices.push(device);
    return { device: { ...device }, credential };
  }

  match(credential: string): RemoteDevice | null {
    if (credential.length === 0) return null;
    const hash = hashCredential(credential);
    // Se recorren todos: cuánto tarda no dice en qué lugar estaba el que casó.
    let found: RemoteDevice | null = null;
    for (const device of this.devices) {
      if (sameText(device.hash, hash)) found = device;
    }
    return found === null ? null : { ...found };
  }

  /** Anota cuándo se lo vio: ahora, o la marca que se le pase. */
  touch(id: string, at: number = this.deps.now()): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    if (device === undefined) return false;
    device.lastSeenAt = at;
    return true;
  }

  rename(id: string, label: string): boolean {
    const device = this.devices.find((candidate) => candidate.id === id);
    const clean = cleanDeviceLabel(label);
    if (device === undefined || clean.length === 0) return false;
    device.label = clean;
    return true;
  }

  revoke(id: string): boolean {
    const before = this.devices.length;
    this.devices = this.devices.filter((device) => device.id !== id);
    return this.devices.length !== before;
  }
}

function parseRemoteDevice(value: unknown): RemoteDevice | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = asNonEmptyString(record['id']);
  const label = asString(record['label']);
  const hash = asString(record['hash']);
  const createdAt = asFiniteNumber(record['createdAt']);
  if (id === null || label === null || hash === null || createdAt === null) return null;
  if (!/^[0-9a-f]{64}$/.test(hash)) return null;
  const lastSeenAt = record['lastSeenAt'] === null || record['lastSeenAt'] === undefined ? null : asFiniteNumber(record['lastSeenAt']);
  return { id, label: cleanDeviceLabel(label) || 'Device', hash, createdAt, lastSeenAt };
}

/**
 * Los equipos de `remote-devices.json`. null si no es de esta versión; dentro de
 * la versión, una entrada que no se entiende se descarta sola.
 */
export function parseRemoteDevicesFile(value: unknown): RemoteDevice[] | null {
  const record = asRecord(value);
  if (record === null || record['version'] !== REMOTE_DEVICES_VERSION) return null;
  return asArrayFiltered(record['devices'], parseRemoteDevice) ?? [];
}

export function serializeRemoteDevices(devices: readonly RemoteDevice[]): string {
  return `${JSON.stringify({ version: REMOTE_DEVICES_VERSION, devices }, null, 2)}\n`;
}

// ---- Qué corre -----------------------------------------------------------------

/** Cómo quedó escuchando el servidor **en este arranque**. */
export interface ListeningInfo {
  port: number;
  /** Escucha en el puerto fijo de los ajustes (el acceso estaba encendido al arrancar y el puerto, libre). */
  fixed: boolean;
  /** Se pidió el puerto fijo y estaba ocupado: el servidor cayó a uno efímero. */
  fixedPortBusy: boolean;
}

export function remoteAccessState(
  remote: { enabled: boolean; port: number },
  listening: ListeningInfo,
): RemoteAccessState {
  if (!remote.enabled) return 'off';
  if (listening.fixedPortBusy) return 'port-busy';
  if (!listening.fixed || listening.port !== remote.port) return 'restart-needed';
  return 'active';
}

// ---- Lo que se arma del sistema ------------------------------------------------

function isPrivateIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Las IPv4 privadas de este equipo: por ellas se llega desde la misma red. */
export function privateIpv4Addresses(
  interfaces: NodeJS.Dict<Array<Pick<NetworkInterfaceInfo, 'address' | 'family' | 'internal'>>>,
): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal || info.family !== 'IPv4' || !isPrivateIpv4(info.address)) continue;
      if (!addresses.includes(info.address)) addresses.push(info.address);
    }
  }
  return addresses;
}

/**
 * Cómo se presenta la app de Android (hito 38) al emparejarse: su nombre, su
 * versión y, entre paréntesis, la versión de Android y el nombre del teléfono.
 */
export const PHONE_APP_USER_AGENT = /AgentWorkbenchAndroid\/\S+ \(Android [^;)]*; ([^)]{1,80})\)/;

/**
 * Un nombre para el equipo recién emparejado, `Chrome · Windows`. Es un punto
 * de partida —el usuario lo cambia— y no lleva palabras que traducir.
 */
export function deviceLabelFromUserAgent(userAgent: string | undefined): string {
  if (userAgent === undefined) return 'Device';
  // La app del teléfono (hito 38) dice el nombre del teléfono, que es lo que el usuario reconoce.
  const phone = PHONE_APP_USER_AGENT.exec(userAgent);
  if (phone !== null) {
    const name = cleanDeviceLabel(phone[1] ?? '');
    return name.length > 0 ? cleanDeviceLabel(`${name} · Android`) : 'Android';
  }
  // El orden importa: Edge y Opera también dicen "Chrome", y Chrome dice "Safari".
  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /OPR\//.test(userAgent)
      ? 'Opera'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : null;
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad/.test(userAgent)
        ? 'iOS'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;
  if (browser === null || system === null) return 'Device';
  return `${browser} · ${system}`;
}

// ---- Qué no puede pedir un equipo remoto ---------------------------------------

/** Administrar el acceso remoto: sólo quien entró con el token del arranque. */
const HOST_ONLY: ReadonlySet<ClientMessageType> = new Set<ClientMessageType>([
  'remote.configure',
  'remote.pairing.start',
  'remote.pairing.cancel',
  'remote.device.rename',
  'remote.device.revoke',
  'remote.phone.start',
  'remote.phone.cancel',
]);

/**
 * Lo que termina abriendo una ventana **en el escritorio del anfitrión**: desde
 * otro equipo lanzaría un programa en una pantalla que nadie mira.
 */
const OPENS_ON_HOST: ReadonlySet<ClientMessageType> = new Set<ClientMessageType>([
  'files.reveal',
  'vault.reveal',
  'vault.openSession',
  'vault.exportProject',
]);

/**
 * Por qué se le niega un pedido a una ventana, o null si se le atiende.
 *
 * La interfaz esconde estos controles a un equipo remoto, pero el que decide es
 * el servidor: una credencial de equipo robada no sirve para emparejar más
 * equipos ni para lanzar nada en el anfitrión.
 */
export function remoteRefusal(type: string, remoteClient: boolean): ServerText | null {
  if (!remoteClient) return null;
  if (HOST_ONLY.has(type as ClientMessageType)) return serverText('remoteHostOnly');
  if (OPENS_ON_HOST.has(type as ClientMessageType)) return serverText('remoteOpensOnHost');
  return null;
}
