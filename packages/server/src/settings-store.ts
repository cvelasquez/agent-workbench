/**
 * Ajustes de la app, en `<carpeta de configuracion>/settings.json`.
 *
 * Los de la copia propia (hito 28) y los del acceso remoto (hito 37). Archivo aparte de
 * `workspace.json` por lo de siempre: ese se reescribe entero en cada cambio de
 * pestanas y dos instancias se lo pisan (CLAUDE.md 6.5).
 *
 * Tres reglas:
 *
 *  - **Leer nunca escribe.** Sin archivo, ilegible o de otra version, la app
 *    arranca con los valores por defecto y el archivo queda como estaba hasta
 *    el primer cambio del usuario. Una build anterior que comparte la carpeta no
 *    tiene por que borrarle los ajustes a una mas nueva por el solo hecho de
 *    arrancar.
 *  - **Un valor que no sirve cae a su defecto, campo por campo.** Una carpeta
 *    que no es absoluta no se resuelve contra el directorio desde el que se
 *    lanzo el servidor: vale null (la de por defecto) y se avisa por consola.
 *  - **Cambiar escribe enseguida y de forma atomica.** Encender la copia es algo
 *    que el usuario espera encontrar igual si el servidor se cae un segundo
 *    despues. Los cambios van en fila: dos seguidos no se pisan.
 *
 * No hay `everEnabled` (C18): si la copia ya estuvo encendida lo dice el disco
 * (`vault.json` en su carpeta), y un ajuste que repite el disco es uno mas que
 * se desincroniza.
 */

import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { REMOTE_DEFAULT_PORT, asBoolean, asRecord, isRemotePort } from '@agent-workbench/shared';
import { appSettingsPath } from './paths.js';
import { writeFileAtomic } from './vault/write.js';

export const SETTINGS_VERSION = 1;

/** Tope por defecto de un resultado de herramienta en la copia (D4). */
export const VAULT_TOOL_RESULT_DEFAULT_CHARS = 64_000;
export const VAULT_TOOL_RESULT_MIN_CHARS = 4_000;
export const VAULT_TOOL_RESULT_MAX_CHARS = 1_000_000;

export interface VaultSettings {
  /** false por defecto: la copia arranca apagada (D6). */
  enabled: boolean;
  /** Absoluta, o null = `defaultVaultDir()`. */
  dir: string | null;
  /** Se acota a `VAULT_TOOL_RESULT_MIN_CHARS..VAULT_TOOL_RESULT_MAX_CHARS` al leer y al cambiar. Sin interfaz. */
  toolResultMaxChars: number;
}

/**
 * El acceso remoto (hito 37, CLAUDE.md 14). Los equipos emparejados no van aca:
 * van en su archivo (`remote-devices-store.ts`), porque una build anterior que
 * comparta la carpeta reescribe este sin lo que no conoce.
 */
export interface RemoteSettings {
  /** false por defecto. Apagado, ningun equipo emparejado entra. */
  enabled: boolean;
  /** El puerto fijo, entre `REMOTE_MIN_PORT` y `REMOTE_MAX_PORT`. Se usa al arrancar. */
  port: number;
}

export interface AppSettings {
  version: typeof SETTINGS_VERSION;
  vault: VaultSettings;
  remote: RemoteSettings;
}

export interface SettingsPatch {
  vault?: Partial<VaultSettings>;
  remote?: Partial<RemoteSettings>;
}

export function defaultAppSettings(): AppSettings {
  return {
    version: SETTINGS_VERSION,
    vault: { enabled: false, dir: null, toolResultMaxChars: VAULT_TOOL_RESULT_DEFAULT_CHARS },
    remote: { enabled: false, port: REMOTE_DEFAULT_PORT },
  };
}

/**
 * true si `dir` es una ruta absoluta de verdad en `platform`.
 *
 * En Windows `path.isAbsolute('\\carpeta')` dice true, y esa ruta depende de la
 * unidad actual del proceso: se exige unidad y separador, o una ruta UNC.
 */
export function isAbsoluteDir(dir: string, platform: string): boolean {
  if (dir.length === 0 || dir.includes('\0')) return false;
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(dir) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(dir);
  return path.posix.isAbsolute(dir);
}

/** El tope acotado, o el de por defecto si no es un numero. */
export function clampToolResultMaxChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return VAULT_TOOL_RESULT_DEFAULT_CHARS;
  return Math.min(VAULT_TOOL_RESULT_MAX_CHARS, Math.max(VAULT_TOOL_RESULT_MIN_CHARS, Math.floor(value)));
}

/**
 * Los ajustes leidos de disco. Pura: la prueba el chequeo.
 *
 * null si no es un objeto o si la version no es la 1: una version que no se
 * conoce se ignora entera antes que leerla mal. Dentro de la 1, cada campo que
 * no sirve cae a su defecto; `warn` recibe lo que merece un aviso.
 */
export function parseAppSettings(
  value: unknown,
  platform: string,
  warn: (message: string) => void = () => undefined,
): AppSettings | null {
  const record = asRecord(value);
  if (record === null || record['version'] !== SETTINGS_VERSION) return null;

  const settings = defaultAppSettings();
  const remote = asRecord(record['remote']);
  if (remote !== null) {
    settings.remote.enabled = asBoolean(remote['enabled']) ?? false;
    if (isRemotePort(remote['port'])) settings.remote.port = remote['port'];
  }

  const vault = asRecord(record['vault']);
  if (vault === null) return settings;

  settings.vault.enabled = asBoolean(vault['enabled']) ?? false;
  const dir = vault['dir'];
  if (typeof dir === 'string' && isAbsoluteDir(dir, platform)) {
    settings.vault.dir = dir;
  } else if (dir !== null && dir !== undefined) {
    warn(`[settings] the local copy folder ${JSON.stringify(dir)} isn't an absolute path: using the default one`);
  }
  settings.vault.toolResultMaxChars = clampToolResultMaxChars(vault['toolResultMaxChars']);
  return settings;
}

/** Congelados: lo que devuelve `get()` no se puede cambiar sin pasar por `update`. */
function frozen(settings: AppSettings): AppSettings {
  return Object.freeze({
    ...settings,
    vault: Object.freeze({ ...settings.vault }),
    remote: Object.freeze({ ...settings.remote }),
  });
}

export interface SettingsStoreOptions {
  platform?: string;
  log?: Pick<Console, 'warn'>;
}

export class SettingsStore {
  private current: AppSettings = frozen(defaultAppSettings());
  /** Los cambios, en fila: cada uno parte de lo que dejo escrito el anterior. */
  private queue: Promise<void> = Promise.resolve();
  private readonly platform: string;
  private readonly log: Pick<Console, 'warn'>;

  /** La ruta es inyectable para las pruebas; por defecto, la de la carpeta de configuracion. */
  constructor(
    private readonly filePath: string = appSettingsPath(),
    options: SettingsStoreOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.log = options.log ?? console;
  }

  /** Sin archivo, ilegible o de otra version: los valores por defecto. No escribe. */
  async load(): Promise<void> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      this.current = frozen(defaultAppSettings());
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log.warn("[settings] settings.json isn't valid JSON: using the defaults");
      this.current = frozen(defaultAppSettings());
      return;
    }
    const settings = parseAppSettings(parsed, this.platform, (message) => this.log.warn(message));
    if (settings === null) {
      this.log.warn('[settings] settings.json is from another version: using the defaults');
    }
    this.current = frozen(settings ?? defaultAppSettings());
  }

  /**
   * Relee **solo** lo del acceso remoto (hito 37). Otra instancia de la app
   * comparte este archivo, y "apagar" desde una tiene que valer en la que tiene
   * el puerto; lo de la copia propia no se toca, que cada instancia lo lleva en
   * memoria como siempre. Sin archivo o ilegible, queda lo que habia.
   */
  async reloadRemote(): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
    } catch {
      return;
    }
    const settings = parseAppSettings(parsed, this.platform);
    if (settings === null) return;
    this.current = frozen({ ...this.current, remote: settings.remote });
  }

  /** Una marca que cambia cuando el archivo cambia (fecha y tamano), o '' si no esta. */
  async stamp(): Promise<string> {
    try {
      const info = await stat(this.filePath);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return '';
    }
  }

  /** Lo ultimo que quedo escrito. Congelado: nadie de afuera lo cambia sin pasar por `update`. */
  get(): Readonly<AppSettings> {
    return this.current;
  }

  /**
   * Aplica un cambio y lo escribe. Lanza si la carpeta no es absoluta, si el
   * puerto no sirve o si no se pudo escribir; en todos los casos `get()` sigue
   * dando lo anterior.
   */
  update(patch: SettingsPatch): Promise<void> {
    const run = async (): Promise<void> => {
      // Un cambio que no es del acceso remoto no puede reescribirlo con lo que
      // esta instancia recordaba: otra pudo apagarlo, y volveria encendido.
      if (patch.remote === undefined) await this.reloadRemote();
      const next: AppSettings = {
        version: SETTINGS_VERSION,
        vault: { ...this.current.vault },
        remote: { ...this.current.remote },
      };
      const vault = patch.vault ?? {};
      if (vault.enabled !== undefined) next.vault.enabled = vault.enabled;
      if (vault.dir !== undefined) {
        if (vault.dir !== null && !isAbsoluteDir(vault.dir, this.platform)) {
          throw new Error(`The local copy folder has to be an absolute path: ${JSON.stringify(vault.dir)}`);
        }
        next.vault.dir = vault.dir;
      }
      if (vault.toolResultMaxChars !== undefined) {
        next.vault.toolResultMaxChars = clampToolResultMaxChars(vault.toolResultMaxChars);
      }
      const remote = patch.remote ?? {};
      if (remote.enabled !== undefined) next.remote.enabled = remote.enabled;
      if (remote.port !== undefined) {
        if (!isRemotePort(remote.port)) throw new Error(`The remote access port isn't valid: ${JSON.stringify(remote.port)}`);
        next.remote.port = remote.port;
      }

      await mkdir(path.dirname(this.filePath), { recursive: true });
      await writeFileAtomic(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
      this.current = frozen(next);
    };
    const result = this.queue.then(run);
    // Un cambio que fallo no frena a los que vienen detras.
    this.queue = result.catch(() => undefined);
    return result;
  }
}
