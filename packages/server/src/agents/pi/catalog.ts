/**
 * Los modelos de Pi: la ventana de contexto de cada uno, para el medidor, y la
 * lista de la cuenta, para el combo.
 *
 * Pi no escribe la ventana en la sesion. Sale de dos sitios (CLAUDE.md 16.9):
 *
 *  - **`models-store.json`**, el catalogo que Pi baja de pi.dev para los
 *    proveedores en los que el usuario inicio sesion:
 *    `{ <proveedor>: { models: [{ id, name, contextWindow, … }], … } }`. Sin
 *    secretos (revisado sobre el archivo real). Es tambien la lista del combo:
 *    lo que Pi ofrece en su propio selector.
 *  - **El catalogo que trae el paquete instalado**, un archivo por proveedor,
 *    con otra forma: `{ <api>: { "chat:<id>": { id, contextWindow, … } } }`. Es
 *    el respaldo de la ventana para un modelo que el primero no trae (un
 *    proveedor con API key). Se lee solo el archivo del proveedor pedido.
 *
 * `models.json`, que puede traer claves, no se abre nunca.
 *
 * Lo que no esta da null, nunca un numero inventado: la barra muestra tokens
 * sin limite, como con cualquier modelo desconocido.
 */

import { readFile as readFileFromDisk, stat as statFromDisk } from 'node:fs/promises';
import path from 'node:path';
import { asRecord, type ModelOption } from '@agent-workbench/shared';

/** Cada cuanto, como mucho, se mira si `models-store.json` cambio al pedir una ventana. */
export const PI_CATALOG_RECHECK_MS = 30_000;

/** Tope de la lista del combo: un agregador puede traer cientos de modelos. */
export const PI_MODEL_LIST_MAX = 300;

/** Tope de `models-store.json`. Medido: 9 modelos son 6 KB. */
const STORE_MAX_BYTES = 8 * 1024 * 1024;

/** Un id de proveedor que puede ir dentro de un nombre de archivo. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export interface PiCatalogModel {
  provider: string;
  id: string;
  name: string;
  contextWindow: number | null;
}

/** Los modelos de un `models-store.json` ya parseado, en su orden. */
export function storeModels(parsed: unknown): PiCatalogModel[] {
  const providers = asRecord(parsed);
  if (providers === null) return [];
  const models: PiCatalogModel[] = [];
  for (const [provider, value] of Object.entries(providers)) {
    const list = asRecord(value)?.['models'];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const model = asRecord(item);
      const id = model?.['id'];
      if (model === null || typeof id !== 'string' || id.length === 0) continue;
      const name = model['name'];
      const window = model['contextWindow'];
      models.push({
        provider,
        id,
        name: typeof name === 'string' && name.trim().length > 0 ? name.trim() : id,
        contextWindow: typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : null,
      });
    }
  }
  return models;
}

/** `id` -> ventana, de un archivo de proveedor del paquete ya parseado. */
export function packageWindows(parsed: unknown): Map<string, number> {
  const windows = new Map<string, number>();
  const apis = asRecord(parsed);
  if (apis === null) return windows;
  for (const group of Object.values(apis)) {
    const entries = asRecord(group);
    if (entries === null) continue;
    for (const item of Object.values(entries)) {
      const model = asRecord(item);
      const id = model?.['id'];
      const window = model?.['contextWindow'];
      if (typeof id === 'string' && id.length > 0 && typeof window === 'number' && Number.isFinite(window) && window > 0) {
        windows.set(id, window);
      }
    }
  }
  return windows;
}

/**
 * Las opciones del combo de modelo.
 *
 * `value` es `proveedor/id`, que `/model` aplica directo y sin ambiguedad
 * (medido, 16.10); la familia es ese mismo texto, que es como el seguidor nombra
 * el modelo observado. Con mas de un proveedor la etiqueta lo dice: el mismo
 * modelo puede estar en dos.
 */
export function modelOptions(models: readonly PiCatalogModel[]): ModelOption[] {
  const several = new Set(models.map((model) => model.provider)).size > 1;
  const seen = new Set<string>();
  const options: ModelOption[] = [];
  for (const model of models) {
    const value = `${model.provider}/${model.id}`;
    // Un valor con espacios no llegaria entero al comando; uno repetido, tampoco hace falta.
    if (seen.has(value) || /\s/.test(value)) continue;
    seen.add(value);
    options.push({
      value,
      label: several ? `${model.name} (${model.provider})` : model.name,
      family: value,
      long: false,
      window: model.contextWindow,
    });
    if (options.length >= PI_MODEL_LIST_MAX) break;
  }
  return options;
}

export interface PiCatalogOptions {
  /** `models-store.json`, o null si no se sabe donde esta. Se pregunta en cada lectura. */
  storeFile: () => string | null;
  /** La carpeta del paquete instalado, o null si Pi no se encontro. */
  packageDir: () => string | null;
  readFile?: (file: string) => Promise<string>;
  stat?: (file: string) => Promise<{ mtimeMs: number; size: number }>;
  now?: () => number;
  recheckMs?: number;
}

export class PiModelCatalog {
  private readonly readFile: (file: string) => Promise<string>;
  private readonly stat: (file: string) => Promise<{ mtimeMs: number; size: number }>;
  private readonly now: () => number;
  private readonly recheckMs: number;
  private models: PiCatalogModel[] = [];
  private windows = new Map<string, number>();
  /** La firma del archivo que dio `models`; null si nunca se leyo bien. */
  private loadedStamp: string | null = null;
  private checkedAt: number | null = null;
  private refreshing: Promise<void> | null = null;
  /** Proveedor -> ventanas del paquete. Un proveedor sin archivo queda con un mapa vacio. */
  private readonly packageCache = new Map<string, Map<string, number>>();

  constructor(private readonly options: PiCatalogOptions) {
    this.readFile = options.readFile ?? ((file) => readFileFromDisk(file, 'utf8'));
    this.stat = options.stat ?? statFromDisk;
    this.now = options.now ?? Date.now;
    this.recheckMs = options.recheckMs ?? PI_CATALOG_RECHECK_MS;
  }

  /** La lista de la cuenta tal como quedo en la ultima lectura. Sincronica: la usan las capacidades. */
  list(): readonly PiCatalogModel[] {
    return this.models;
  }

  /**
   * Vuelve a leer `models-store.json` si cambio. true si la lista de modelos
   * quedo distinta. Nunca lanza.
   */
  async reload(): Promise<boolean> {
    const before = JSON.stringify(this.models);
    this.checkedAt = this.now();
    await this.load();
    return JSON.stringify(this.models) !== before;
  }

  /** La ventana de ese modelo en ese proveedor, o null. Nunca lanza. */
  async contextWindow(provider: string | null, modelId: string | null): Promise<number | null> {
    if (provider === null || modelId === null || provider.length === 0 || modelId.length === 0) return null;
    await this.refresh();
    const known = this.windows.get(`${provider}/${modelId}`);
    if (known !== undefined) return known;
    return (await this.packageWindowsOf(provider)).get(modelId) ?? null;
  }

  private refresh(): Promise<void> {
    const now = this.now();
    if (this.checkedAt !== null && now - this.checkedAt < this.recheckMs) return this.refreshing ?? Promise.resolve();
    if (this.refreshing === null) {
      this.checkedAt = now;
      this.refreshing = this.load().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async load(): Promise<void> {
    const file = this.options.storeFile();
    const forget = (): void => {
      this.models = [];
      this.windows = new Map();
      this.loadedStamp = null;
    };
    if (file === null) return forget();
    let stamp: string;
    try {
      const info = await this.stat(file);
      if (info.size > STORE_MAX_BYTES) return forget();
      stamp = `${info.mtimeMs}:${info.size}`;
    } catch {
      // Sin archivo no hay catalogo: Pi no inicio sesion en ningun proveedor.
      return forget();
    }
    if (stamp === this.loadedStamp) return;
    try {
      const models = storeModels(JSON.parse(await this.readFile(file)));
      this.models = models;
      this.windows = new Map(
        models.flatMap((model) =>
          model.contextWindow === null ? [] : [[`${model.provider}/${model.id}`, model.contextWindow] as const],
        ),
      );
      this.loadedStamp = stamp;
    } catch {
      // A medio escribir, o no es JSON: sin catalogo hasta la proxima mirada.
      forget();
    }
  }

  private async packageWindowsOf(provider: string): Promise<Map<string, number>> {
    const cached = this.packageCache.get(provider);
    if (cached !== undefined) return cached;
    const packageDir = this.options.packageDir();
    // Sin paquete no se guarda nada: puede aparecer cuando se instale.
    if (packageDir === null || !PROVIDER_ID_PATTERN.test(provider)) return new Map();
    let windows = new Map<string, number>();
    for (const dataDir of packageDataDirs(packageDir)) {
      try {
        windows = packageWindows(JSON.parse(await this.readFile(path.join(dataDir, `${provider}.json`))));
        break;
      } catch {
        // No esta en esa carpeta, o no es JSON: se prueba la siguiente.
      }
    }
    this.packageCache.set(provider, windows);
    return windows;
  }
}

/**
 * Donde puede estar el catalogo del paquete: dentro de sus propias dependencias
 * (medido con npm) o al lado, si el instalador las aplano.
 */
export function packageDataDirs(packageDir: string): string[] {
  const tail = ['pi-ai', 'dist', 'providers', 'data'];
  return [
    path.join(packageDir, 'node_modules', '@earendil-works', ...tail),
    path.join(packageDir, '..', ...tail),
  ];
}
