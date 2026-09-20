/**
 * El acceso remoto andando (hito 37, §14): junta los ajustes, el archivo de
 * equipos, el código para emparejar y quién está conectado.
 *
 * Las decisiones están en `remote-access.ts`, puras; acá se guardan, se avisan y
 * se les pone reloj. Cuatro reglas que salen de este archivo:
 *
 *  - **Encender pide reiniciar; apagar corta en el acto.** El puerto se elige al
 *    arrancar, así que encender no puede tener efecto hasta el próximo arranque.
 *    Apagar sí: los equipos dejan de entrar en ese momento y se avisa para
 *    cerrarles las ventanas abiertas (`onRevoked(null)`).
 *  - **Entra un equipo sólo si el acceso está encendido y el servidor escucha en
 *    el puerto fijo.** Con cualquier otra cosa `verifier()` es null, y la cookie
 *    de un equipo ni se mira (`security.ts`).
 *  - **La credencial pasa por acá una sola vez**, al emparejar, camino a la
 *    cookie. No se guarda, no se registra y no viaja en ningún mensaje.
 *  - **Los archivos mandan, no la memoria** (§14.8). Dos instancias de la app
 *    comparten la carpeta de configuración —el caso de todos los días es
 *    `pnpm dev` al lado de la de uso—, y sólo una tiene el puerto. Un equipo
 *    revocado, o el acceso apagado, desde la otra tiene que valer en esta: con
 *    el acceso encendido se miran los dos archivos cada dos segundos, y antes de
 *    cada cambio se relee, para no escribir una lista vieja que resucite a un
 *    equipo revocado. Apagado no corre nada.
 */

import { randomBytes as cryptoRandomBytes, randomUUID } from 'node:crypto';
import os from 'node:os';
import {
  REMOTE_MAX_PORT,
  REMOTE_MIN_PORT,
  ServerTextError,
  isRemotePort,
  serverText,
  type RemoteAccessStatus,
  type RemotePairingCode,
} from '@agent-workbench/shared';
import {
  DeviceBook,
  PairingDesk,
  REMOTE_MAX_DEVICES,
  deviceLabelFromUserAgent,
  privateIpv4Addresses,
  remoteAccessState,
  type DeviceVerifier,
  type ListeningInfo,
  type RandomBytes,
} from './remote-access.js';
import type { RemoteDevicesStore } from './remote-devices-store.js';
import type { SettingsStore } from './settings-store.js';

/** Cada cuánto, como mucho, se guarda la "última vez visto". */
const TOUCH_SAVE_DELAY_MS = 5_000;
/** Cada cuánto se mira si otra instancia cambió los archivos. Dos `stat`, y sólo con el acceso encendido. */
const FILES_POLL_MS = 2_000;

export interface RemoteHostInfo {
  /** Con qué usuario se entra por SSH, según el sistema. */
  user: string;
  /** El nombre del equipo y sus IPv4 privadas. */
  hostNames: string[];
}

/** Se relee en cada estado: la IP cambia cuando el wifi se reconecta. */
export function detectHostInfo(): RemoteHostInfo {
  let user = '';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env['USERNAME'] ?? process.env['USER'] ?? '';
  }
  return { user, hostNames: [os.hostname(), ...privateIpv4Addresses(os.networkInterfaces())] };
}

export interface RemoteAccessOptions {
  settings: SettingsStore;
  store: RemoteDevicesStore;
  listening: ListeningInfo;
  /** Fijo, para las pruebas. Sin él se detecta en cada estado. */
  host?: RemoteHostInfo;
  now?: () => number;
  randomBytes?: RandomBytes;
  log?: Pick<Console, 'log' | 'warn'>;
}

export interface RedeemedPairing {
  deviceId: string;
  /** Sólo para armar la cookie de la respuesta. */
  credential: string;
}

export class RemoteAccessService {
  private readonly settings: SettingsStore;
  private readonly store: RemoteDevicesStore;
  private readonly listening: ListeningInfo;
  private readonly host: RemoteHostInfo | null;
  private readonly now: () => number;
  private readonly log: Pick<Console, 'log' | 'warn'>;
  private readonly book: DeviceBook;
  private readonly desk: PairingDesk;

  private readonly changeListeners = new Set<() => void>();
  private readonly revokedListeners = new Set<(deviceId: string | null) => void>();
  /** Cuántas ventanas tiene abiertas cada equipo. */
  private readonly connections = new Map<string, number>();
  /** Las "última vez visto" que todavía no se guardaron: releer el archivo no se las lleva. */
  private readonly pendingSeen = new Map<string, number>();
  private pairingTimer: NodeJS.Timeout | null = null;
  private touchTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  /** Cómo estaban los dos archivos la última vez que se leyeron o escribieron desde acá. */
  private stamps = { devices: '', settings: '' };
  /** Las sincronizaciones, en fila: la del sondeo y la de un cambio no se cruzan. */
  private syncing: Promise<void> = Promise.resolve();

  constructor(options: RemoteAccessOptions) {
    this.settings = options.settings;
    this.store = options.store;
    this.listening = options.listening;
    this.host = options.host ?? null;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? console;
    const randomBytes = options.randomBytes ?? ((size: number) => cryptoRandomBytes(size));
    this.book = new DeviceBook({ now: this.now, randomBytes, randomId: () => randomUUID() });
    this.desk = new PairingDesk({ now: this.now, randomBytes });
  }

  async load(): Promise<void> {
    this.book.load(await this.store.load());
    this.stamps = { devices: await this.store.stamp(), settings: await this.settings.stamp() };
    this.updatePolling();
  }

  // ---- Qué corre ---------------------------------------------------------------

  private remote(): { enabled: boolean; port: number } {
    return this.settings.get().remote;
  }

  /** Entran equipos: encendido, y el servidor escucha en el puerto fijo con el que arrancó. */
  private accepting(): boolean {
    return this.remote().enabled && this.listening.fixed;
  }

  /** A quién pertenece una credencial, o null si ahora no entra nadie. */
  verifier(): DeviceVerifier | null {
    return this.accepting() ? this.book : null;
  }

  get pairedDevices(): number {
    return this.book.size;
  }

  status(): RemoteAccessStatus {
    const remote = this.remote();
    const host = this.host ?? detectHostInfo();
    return {
      enabled: remote.enabled,
      port: remote.port,
      state: remoteAccessState(remote, this.listening),
      listeningPort: this.listening.port,
      sshUser: host.user,
      hostNames: [...host.hostNames],
      pairingActive: this.desk.isActive(),
      devices: this.book.list().map((device) => ({
        ...device,
        connected: (this.connections.get(device.id) ?? 0) > 0,
      })),
    };
  }

  // ---- Lo que cambió otra instancia ----------------------------------------------

  /**
   * Trae lo que haya cambiado en los dos archivos desde la última vez. Un equipo
   * que ya no está se avisa como revocado, y el acceso apagado desde otro lado
   * corta igual que apagado desde acá.
   */
  sync(): Promise<void> {
    const result = this.syncing.then(() => this.syncNow());
    this.syncing = result.catch(() => undefined);
    return result;
  }

  private async syncNow(): Promise<void> {
    let changed = false;

    const settingsStamp = await this.settings.stamp();
    if (settingsStamp !== this.stamps.settings) {
      this.stamps.settings = settingsStamp;
      const wasAccepting = this.accepting();
      await this.settings.reloadRemote();
      if (wasAccepting && !this.accepting()) this.cutOff();
      changed = true;
    }

    const devicesStamp = await this.store.stamp();
    if (devicesStamp !== this.stamps.devices) {
      this.stamps.devices = devicesStamp;
      const before = this.book.list().map((device) => device.id);
      this.book.load(await this.store.load());
      for (const [deviceId, at] of this.pendingSeen) this.book.touch(deviceId, at);
      const still = new Set(this.book.list().map((device) => device.id));
      for (const deviceId of before) {
        if (still.has(deviceId)) continue;
        this.connections.delete(deviceId);
        for (const listener of this.revokedListeners) listener(deviceId);
      }
      changed = true;
    }

    if (!changed) return;
    this.updatePolling();
    this.emitChange();
  }

  /** Sondea sólo con el acceso encendido: apagado, esta instancia no hace nada nuevo. */
  private updatePolling(): void {
    const wanted = this.remote().enabled;
    if (wanted && this.pollTimer === null) {
      this.pollTimer = setInterval(() => void this.sync().catch(() => undefined), FILES_POLL_MS);
      this.pollTimer.unref();
    } else if (!wanted && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** El acceso dejó de estar encendido: el código muere y se avisa cerrar las ventanas de todos. */
  private cutOff(): void {
    this.stopPairing();
    this.log.log('[remote] remote access turned off: paired devices are disconnected');
    for (const listener of this.revokedListeners) listener(null);
  }

  // ---- Cambios desde el anfitrión ----------------------------------------------

  /** Lanza un `ServerTextError` si el puerto no sirve; los ajustes quedan como estaban. */
  async configure(patch: { enabled?: boolean; port?: number }): Promise<void> {
    if (patch.port !== undefined && !isRemotePort(patch.port)) {
      throw new ServerTextError(serverText('remotePortInvalid', { max: REMOTE_MAX_PORT, min: REMOTE_MIN_PORT }));
    }
    await this.sync();
    const wasAccepting = this.accepting();
    await this.settings.update({ remote: patch });
    this.stamps.settings = await this.settings.stamp();
    if (wasAccepting && !this.accepting()) this.cutOff();
    this.updatePolling();
    this.emitChange();
  }

  startPairing(): RemotePairingCode {
    if (!this.accepting()) throw new ServerTextError(serverText('remoteNotActive'));
    if (this.book.size >= REMOTE_MAX_DEVICES) {
      throw new ServerTextError(serverText('remoteTooManyDevices', { max: REMOTE_MAX_DEVICES }));
    }
    this.stopPairing();
    const pairing = this.desk.start();
    // Al vencer, las ventanas tienen que enterarse de que ya no hay código.
    this.pairingTimer = setTimeout(() => {
      this.pairingTimer = null;
      this.emitChange();
    }, Math.max(0, pairing.expiresAt - this.now()) + 50);
    this.pairingTimer.unref();
    this.emitChange();
    return pairing;
  }

  cancelPairing(): void {
    if (!this.desk.isActive()) return;
    this.stopPairing();
    this.emitChange();
  }

  private stopPairing(): void {
    this.desk.cancel();
    if (this.pairingTimer !== null) clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
  }

  async renameDevice(deviceId: string, label: string): Promise<boolean> {
    await this.sync();
    if (!this.book.rename(deviceId, label)) return false;
    await this.persist();
    this.emitChange();
    return true;
  }

  async revokeDevice(deviceId: string): Promise<boolean> {
    await this.sync();
    if (!this.book.revoke(deviceId)) return false;
    this.connections.delete(deviceId);
    this.log.log('[remote] a paired device was revoked');
    // Antes de escribir: dejar de atenderlo no espera al disco.
    for (const listener of this.revokedListeners) listener(deviceId);
    await this.persist();
    this.emitChange();
    return true;
  }

  // ---- Lo que llega de afuera --------------------------------------------------

  /**
   * Canjea un código por un equipo nuevo, o null. El nombre sale del navegador
   * que lo presentó; el usuario lo cambia después.
   */
  async redeemPairing(input: string, userAgent: string | undefined): Promise<RedeemedPairing | null> {
    if (!this.accepting()) return null;
    const outcome = this.desk.redeem(input);
    if (outcome === 'none') return null;
    if (outcome === 'wrong') {
      this.log.warn('[remote] a wrong pairing code was presented');
      if (!this.desk.isActive()) {
        this.stopPairing();
        this.log.warn('[remote] too many wrong codes: the pairing code is no longer valid');
        this.emitChange();
      }
      return null;
    }

    // El código ya quedó gastado. Se relee antes de sumar: la lista que se
    // escribe tiene que ser la de ahora, no la que recordaba esta instancia.
    this.stopPairing();
    await this.sync();
    const enrolled = this.accepting() ? this.book.enroll(deviceLabelFromUserAgent(userAgent)) : null;
    if (enrolled === null) {
      this.emitChange();
      return null;
    }
    await this.persist();
    this.log.log(`[remote] paired a new device: ${enrolled.device.label}`);
    this.emitChange();
    return { deviceId: enrolled.device.id, credential: enrolled.credential };
  }

  noteConnected(deviceId: string): void {
    this.connections.set(deviceId, (this.connections.get(deviceId) ?? 0) + 1);
    this.touch(deviceId);
    this.emitChange();
  }

  noteDisconnected(deviceId: string): void {
    const left = (this.connections.get(deviceId) ?? 0) - 1;
    if (left > 0) this.connections.set(deviceId, left);
    else this.connections.delete(deviceId);
    this.touch(deviceId);
    this.emitChange();
  }

  /** La "última vez visto" no vale una escritura por conexión: se junta. */
  private touch(deviceId: string): void {
    const at = this.now();
    if (!this.book.touch(deviceId, at)) return;
    this.pendingSeen.set(deviceId, at);
    if (this.touchTimer !== null) return;
    this.touchTimer = setTimeout(() => {
      this.touchTimer = null;
      void this.persistTouches();
    }, TOUCH_SAVE_DELAY_MS);
    this.touchTimer.unref();
  }

  /**
   * Guarda las "última vez visto". Relee antes: una fecha no puede devolverle
   * la vida a un equipo que otra instancia revocó mientras tanto —al releer, el
   * que ya no está no recibe la suya—.
   */
  private async persistTouches(): Promise<void> {
    if (this.pendingSeen.size === 0) return;
    await this.sync();
    this.pendingSeen.clear();
    await this.persist();
  }

  // ---- Avisos y disco ----------------------------------------------------------

  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /** Hay que cerrar las ventanas de ese equipo; con null, las de todos. */
  onRevoked(listener: (deviceId: string | null) => void): () => void {
    this.revokedListeners.add(listener);
    return () => this.revokedListeners.delete(listener);
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) listener();
  }

  /** Escribe los equipos y anota cómo quedó el archivo, para no tomarlo por un cambio ajeno. Nunca rechaza. */
  private async persist(): Promise<void> {
    try {
      await this.store.save(this.book.snapshot());
      this.stamps.devices = await this.store.stamp();
    } catch (error) {
      this.log.warn("[remote] couldn't save the paired devices:", error instanceof Error ? error.message : String(error));
    }
  }

  /** Escribe lo pendiente y espera. Nunca rechaza. */
  async flush(): Promise<void> {
    if (this.touchTimer !== null) clearTimeout(this.touchTimer);
    this.touchTimer = null;
    await this.persistTouches().catch(() => undefined);
    await this.store.flush();
  }

  /** Frena los relojes. Lo que quede por guardar lo escribe `flush()`. */
  dispose(): void {
    this.stopPairing();
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }
}
