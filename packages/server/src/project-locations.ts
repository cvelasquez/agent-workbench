/**
 * A donde se movio la carpeta de un proyecto (Hito 56, §13.14).
 *
 * Al migrar de PC el historial llega con las rutas de la anterior
 * (`D:\MiProyecto`) y los proyectos a otra (`D:\AWB\MiProyecto`). Una ubicacion
 * dice "esta carpeta, que ya no existe, ahora esta en esta otra", y la barra
 * junta bajo la nueva el historial de la vieja y las sesiones de ahora.
 *
 * **Es una asociacion, no una reescritura.** Ninguna sesion cambia: la fila
 * conserva la carpeta con la que su CLI la encuentra (`SessionSummary.cwd`), y
 * lo que se resuelve es en que proyecto cae y donde se abre lo nuevo. El archivo
 * es de esta PC, aparte de `settings.json`, y nunca viaja con el respaldo.
 *
 * Lo que cubre una ubicacion, y lo que no:
 *
 *  - la carpeta y sus subcarpetas, **por segmento entero** (`D:\x2` no esta
 *    bajo `D:\x`): es lo que se llevo al copiar el proyecto;
 *  - nunca la de arriba ni las hermanas, y si el origen es la raiz de una
 *    unidad o la carpeta del usuario, solo esa carpeta exacta: lo otro seria el
 *    reemplazo masivo de `D:\` por `D:\AWB\` que queda fuera del hito;
 *  - **de una sola vuelta**: gana la mas especifica y su resultado no se vuelve
 *    a resolver. Sin cadenas ni ciclos que recorrer.
 *
 * Si la carpeta vieja vuelve a existir, la ubicacion no se aplica (la aprende el
 * indice, `SessionIndex.learnRelocation`): una asociacion nunca esconde una
 * carpeta que existe.
 *
 * El almacen sigue el patron de `settings-store.ts`: leer nunca escribe; un
 * archivo ilegible vale como vacio; uno de otra version no se pisa y guardar se
 * rechaza con un aviso; cada cambio va en fila, **relee el archivo antes de
 * escribir** (otra instancia de la app pudo cambiarlo) y escribe por temporal.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ServerTextError, normalizeCwdKey, relativeUnder, serverText } from '@agent-workbench/shared';
import { projectLocationsPath } from './paths.js';
import { isAbsoluteDir } from './settings-store.js';
import { writeFileAtomic } from './vault/write.js';

const STORE_VERSION = 1;

/** Una ubicacion guardada. */
export interface ProjectLocation {
  /** `normalizeCwdKey` de la carpeta anterior: la identidad de la ubicacion. */
  fromKey: string;
  /** La carpeta anterior, tal cual la tenia el historial. Para mostrarla. */
  from: string;
  /** La carpeta de ahora, tal cual la eligio el usuario. */
  to: string;
  /** Epoch ms. Solo informativo. */
  createdAt: number;
}

/** Lo que resuelve una carpeta del historial. */
export interface ResolvedLocation {
  /** La que se uso: la mas especifica que cubre la carpeta. */
  location: ProjectLocation;
  /** La carpeta del historial, ya en la carpeta nueva: `to` mas lo que tenia por debajo de `from`. */
  cwd: string;
  /** Lo que la carpeta tenia por debajo de `from`: `''` si era la carpeta misma. */
  rest: string;
}

/**
 * Lo que la barra necesita de la ubicacion que alcanza a una carpeta del
 * historial (`SessionIndex`): la carpeta de ahora, y de que ubicacion sale.
 */
export interface Relocation {
  /** La carpeta del historial en la carpeta nueva. En pausa, la misma carpeta de siempre. */
  cwd: string;
  /** La carpeta anterior de la ubicacion (no la de la sesion: puede ser una de arriba). */
  from: string;
  /** La carpeta nueva de la ubicacion. */
  to: string;
  /** true si la carpeta anterior existe otra vez: la ubicacion no se aplica. */
  paused: boolean;
}

/** Un pedido de ubicaciones que no se cumple. El texto va como clave (§6.23). */
export class ProjectLocationError extends ServerTextError {}

export function makeLocation(from: string, to: string, platform: string, createdAt: number): ProjectLocation {
  return { fromKey: normalizeCwdKey(from, platform), from, to, createdAt };
}

/**
 * true si `folder` es la raiz de una unidad, la raiz de un recurso de red, `/` o
 * la carpeta del usuario: una ubicacion con ese origen vale solo para esa
 * carpeta, no para todo lo que hay debajo. Pura: la prueba el chequeo.
 */
export function isBroadFolder(folder: string, platform: string, homeDir: string): boolean {
  const key = normalizeCwdKey(folder, platform);
  if (key.length === 0) return false;
  if (platform === 'win32') {
    if (/^[a-z]:\\?$/.test(key)) return true;
    if (/^\\\\[^\\]+(\\[^\\]+)?$/.test(key)) return true;
  } else if (key === '/') {
    return true;
  }
  const home = normalizeCwdKey(homeDir, platform);
  return home.length > 0 && key === home;
}

/**
 * La carpeta de `cwd` en la carpeta nueva, o null si ninguna ubicacion la
 * cubre. Pura y de una sola vuelta (ver el comentario del modulo).
 */
export function resolveLocation(
  cwd: string,
  locations: readonly ProjectLocation[],
  platform: string,
  homeDir: string = homedir(),
): ResolvedLocation | null {
  if (cwd.length === 0) return null;
  let best: { location: ProjectLocation; rest: string } | null = null;
  for (const location of locations) {
    const rest = relativeUnder(cwd, location.from, platform);
    if (rest === null) continue;
    if (rest.length > 0 && isBroadFolder(location.from, platform, homeDir)) continue;
    // La mas especifica es la de la clave mas larga: la carpeta mas honda.
    if (best === null || location.fromKey.length > best.location.fromKey.length) best = { location, rest };
  }
  if (best === null) return null;
  const api = platform === 'win32' ? path.win32 : path.posix;
  return {
    location: best.location,
    rest: best.rest,
    cwd: best.rest.length === 0 ? best.location.to : api.join(best.location.to, best.rest),
  };
}

/** La carpeta sin separador al final, salvo que sea una raiz. */
function tidyFolder(folder: string, platform: string): string {
  const isRoot = (value: string): boolean => (platform === 'win32' ? /^[A-Za-z]:[\\/]$/.test(value) : value === '/');
  let tidy = folder;
  while (tidy.length > 1 && /[\\/]$/.test(tidy) && !isRoot(tidy)) tidy = tidy.slice(0, -1);
  return tidy;
}

type StoredLocations =
  | { kind: 'ok'; locations: ProjectLocation[] }
  /** Sin archivo, ilegible o roto: vale como vacio y se puede escribir encima. */
  | { kind: 'empty' }
  /** De una version que esta no conoce: no se lee ni se pisa. */
  | { kind: 'other-version' };

/** El archivo leido de disco. Pura: la prueba el chequeo. */
export function parseStoredLocations(raw: string, platform: string): StoredLocations {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'empty' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'empty' };
  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  if (typeof version !== 'number') return { kind: 'empty' };
  if (version !== STORE_VERSION) return { kind: 'other-version' };
  const entries = record['locations'];
  if (!Array.isArray(entries)) return { kind: 'empty' };

  const byKey = new Map<string, ProjectLocation>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null) continue;
    const item = entry as Record<string, unknown>;
    const from = item['from'];
    const to = item['to'];
    if (typeof from !== 'string' || from.length === 0 || typeof to !== 'string' || !isAbsoluteDir(to, platform)) continue;
    const createdAt = typeof item['createdAt'] === 'number' && Number.isFinite(item['createdAt']) ? item['createdAt'] : 0;
    // La clave se rehace: la del archivo pudo escribirla otra plataforma.
    const location = makeLocation(from, to, platform, createdAt);
    byKey.set(location.fromKey, location);
  }
  return { kind: 'ok', locations: [...byKey.values()] };
}

export interface ProjectLocationStoreOptions {
  platform?: string;
  /** La carpeta del usuario: una ubicacion que parte de ella vale solo para ella. */
  homeDir?: string;
  log?: Pick<Console, 'warn'>;
  now?: () => number;
}

export class ProjectLocationStore {
  private current: readonly ProjectLocation[] = [];
  /** Los cambios, en fila: cada uno parte de lo que dejo escrito el anterior. */
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private readonly platform: string;
  private readonly homeDir: string;
  private readonly log: Pick<Console, 'warn'>;
  private readonly now: () => number;

  /** La ruta es inyectable para las pruebas; por defecto, la de la carpeta de configuracion. */
  constructor(
    private readonly filePath: string = projectLocationsPath(),
    options: ProjectLocationStoreOptions = {},
  ) {
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? homedir();
    this.log = options.log ?? console;
    this.now = options.now ?? Date.now;
  }

  /** Sin archivo, ilegible o de otra version: ninguna. No escribe. */
  async load(): Promise<void> {
    const stored = await this.read();
    if (stored.kind === 'other-version') {
      this.log.warn('[locations] project-locations.json is from another version: ignoring it');
    }
    this.current = stored.kind === 'ok' ? stored.locations : [];
  }

  /** Lo ultimo que quedo escrito. */
  list(): readonly ProjectLocation[] {
    return this.current;
  }

  /** La carpeta nueva de una del historial (`resolveLocation`), o null. */
  resolve(cwd: string): ResolvedLocation | null {
    return resolveLocation(cwd, this.current, this.platform, this.homeDir);
  }

  /** Avisa cada vez que cambia lo guardado. Devuelve como soltarse. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Guarda estas ubicaciones: la que ya existe para la misma carpeta se
   * reemplaza, las demas se suman. Lanza si una carpeta no sirve, si el archivo
   * es de otra version o si no se pudo escribir; en todos los casos lo anterior
   * sigue como estaba.
   */
  set(entries: ReadonlyArray<{ from: string; to: string }>): Promise<void> {
    for (const entry of entries) {
      if (entry.from.length === 0 || !isAbsoluteDir(entry.to, this.platform)) {
        return Promise.reject(new ProjectLocationError(serverText('locationFolderInvalid')));
      }
    }
    if (entries.length === 0) return Promise.resolve();
    return this.change((locations) => {
      const next = new Map(locations.map((location) => [location.fromKey, location]));
      let changed = false;
      for (const entry of entries) {
        const location = makeLocation(entry.from, tidyFolder(entry.to, this.platform), this.platform, this.now());
        const before = next.get(location.fromKey);
        // Lo mismo de nuevo no es un cambio: ni se escribe ni se avisa.
        if (before !== undefined && normalizeCwdKey(before.to, this.platform) === normalizeCwdKey(location.to, this.platform)) continue;
        next.set(location.fromKey, location);
        changed = true;
      }
      return changed ? [...next.values()] : null;
    }).then(() => undefined);
  }

  /** Quita las ubicaciones de esas carpetas anteriores (por clave). true si quito alguna. */
  remove(fromKeys: readonly string[]): Promise<boolean> {
    return this.change((locations) => {
      const keys = new Set(fromKeys);
      const next = locations.filter((location) => !keys.has(location.fromKey));
      return next.length === locations.length ? null : next;
    });
  }

  /**
   * Un cambio, en fila. `build` recibe lo que hay **ahora en el disco** y
   * devuelve la lista nueva, o null si no hay nada que cambiar. true si cambio.
   */
  private change(build: (locations: ProjectLocation[]) => ProjectLocation[] | null): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const stored = await this.read();
      if (stored.kind === 'other-version') throw new ProjectLocationError(serverText('locationsOtherVersion'));
      const base = stored.kind === 'ok' ? stored.locations : [];
      const next = build(base);
      if (next === null) {
        // Sin cambios, pero al dia con el disco: otra instancia pudo escribir.
        this.current = base;
        return false;
      }
      try {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await writeFileAtomic(this.filePath, `${JSON.stringify({ version: STORE_VERSION, locations: next }, null, 2)}\n`);
      } catch (error) {
        throw new ProjectLocationError(
          serverText('locationSaveFailed', { detail: error instanceof Error ? error.message : String(error) }),
          { cause: error },
        );
      }
      this.current = next;
      for (const listener of [...this.listeners]) listener();
      return true;
    };
    const result = this.queue.then(run);
    // Un cambio que fallo no frena a los que vienen detras.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async read(): Promise<StoredLocations> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      return { kind: 'empty' };
    }
    return parseStoredLocations(raw, this.platform);
  }
}
