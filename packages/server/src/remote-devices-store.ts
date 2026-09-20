/**
 * Los equipos emparejados, en `<carpeta de configuración>/remote-devices.json`
 * (hito 37, §14).
 *
 * Archivo propio y no dentro de `settings.json`, por una razón concreta: ese se
 * reescribe entero con los campos que **esa build** conoce, así que una build
 * anterior que comparta la carpeta lo guardaría sin los equipos y los borraría.
 * Un archivo que una build anterior no conoce, no lo toca.
 *
 * Guarda el hash de cada credencial, nunca la credencial. Aun así va con
 * permisos sólo del usuario, como lo demás que la app no quiere compartir en una
 * carpeta de un equipo con varias cuentas.
 *
 * Leer nunca escribe: sin archivo, ilegible o de otra versión, no hay equipos y
 * el archivo queda como estaba hasta el primer cambio.
 */

import { chmod, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { remoteDevicesPath } from './paths.js';
import { parseRemoteDevicesFile, serializeRemoteDevices, type RemoteDevice } from './remote-access.js';
import { writeFileAtomic } from './vault/write.js';

export class RemoteDevicesStore {
  /** Las escrituras, en fila: dos seguidas no se pisan. */
  private queue: Promise<void> = Promise.resolve();

  /** La ruta y el aviso son inyectables para las pruebas. */
  constructor(
    private readonly filePath: string = remoteDevicesPath(),
    private readonly log: Pick<Console, 'warn'> = console,
  ) {}

  async load(): Promise<RemoteDevice[]> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn("[remote] remote-devices.json isn't valid JSON: no paired devices are loaded");
      return [];
    }
    const devices = parseRemoteDevicesFile(parsed);
    if (devices === null) {
      this.log.warn('[remote] remote-devices.json is from another version: no paired devices are loaded');
      return [];
    }
    return devices;
  }

  save(devices: readonly RemoteDevice[]): Promise<void> {
    const text = serializeRemoteDevices(devices);
    const run = async (): Promise<void> => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFileAtomic(this.filePath, text);
      // En Windows no cambia nada, y ahí la carpeta del usuario ya es sólo suya.
      await chmod(this.filePath, 0o600).catch(() => undefined);
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  /** Espera lo que quede por escribir. Nunca rechaza. */
  flush(): Promise<void> {
    return this.queue;
  }

  /**
   * Una marca que cambia cuando el archivo cambia (fecha y tamaño), o '' si no
   * está. Es lo que mira otra instancia de la app para enterarse de que acá se
   * revocó un equipo: comparten la carpeta de configuración.
   */
  async stamp(): Promise<string> {
    try {
      const info = await stat(this.filePath);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return '';
    }
  }
}
