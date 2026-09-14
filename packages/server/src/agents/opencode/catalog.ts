/**
 * La ventana de contexto de cada modelo, segun el catalogo que baja la propia
 * CLI (`<cache>/opencode/models.json`, o `OPENCODE_MODELS_PATH`).
 *
 * OpenCode no escribe la ventana en su base, pero su catalogo la trae para
 * todos los modelos: medido el 12-09-2026, 213 proveedores y 7 758 modelos,
 * todos con `limit.context`. Tres cosas que no son evidentes:
 *
 *  - **La clave es proveedor y modelo.** El mismo `gpt-5.6-terra` tiene
 *    1 050 000 en 16 proveedores y 372 000 en otro (medido). Por nombre de
 *    modelo solo, la barra mentiria segun por donde se lo use.
 *  - **Se guarda solo el numero.** El archivo pesa 4,6 MB y parsearlo cuesta
 *    93 ms (medido); lo parseado se suelta y queda un `Map` de
 *    `proveedor/modelo` a tokens.
 *  - **Lo que no esta da null, nunca un numero inventado.** Un proveedor propio
 *    declarado en la configuracion del usuario no esta en el catalogo, y ahi la
 *    barra muestra tokens sin limite, que es lo que ya hace el medidor con un
 *    modelo desconocido.
 *
 * El archivo lo reescribe la CLI cuando lo refresca: se vuelve a mirar su fecha
 * como mucho una vez por minuto, y se relee solo si cambio.
 */

import { readFile as readFileFromDisk, stat as statFromDisk } from 'node:fs/promises';
import { asRecord } from '@agent-workbench/shared';

/** Cada cuanto, como mucho, se mira si el catalogo cambio. */
export const CATALOG_RECHECK_MS = 60_000;

export interface ModelCatalogOptions {
  readFile?: (file: string) => Promise<string>;
  stat?: (file: string) => Promise<{ mtimeMs: number }>;
  /** Reloj de la espera entre miradas. Para el chequeo. */
  now?: () => number;
  recheckMs?: number;
}

/** `proveedor/modelo` -> tokens, de un `models.json` ya parseado. */
export function catalogWindows(parsed: unknown): Map<string, number> {
  const windows = new Map<string, number>();
  const providers = asRecord(parsed);
  if (providers === null) return windows;
  for (const [providerId, provider] of Object.entries(providers)) {
    const models = asRecord(asRecord(provider)?.['models']);
    if (models === null) continue;
    for (const [modelId, model] of Object.entries(models)) {
      const context = asRecord(asRecord(model)?.['limit'])?.['context'];
      if (typeof context === 'number' && Number.isFinite(context) && context > 0) {
        windows.set(`${providerId}/${modelId}`, context);
      }
    }
  }
  return windows;
}

export class ModelCatalog {
  private readonly readFile: (file: string) => Promise<string>;
  private readonly stat: (file: string) => Promise<{ mtimeMs: number }>;
  private readonly now: () => number;
  private readonly recheckMs: number;
  private windows = new Map<string, number>();
  /** La fecha del archivo que dio `windows`; null si nunca se leyo bien. */
  private loadedMtime: number | null = null;
  private checkedAt: number | null = null;
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly file: string | null,
    options: ModelCatalogOptions = {},
  ) {
    this.readFile = options.readFile ?? ((target) => readFileFromDisk(target, 'utf8'));
    this.stat = options.stat ?? statFromDisk;
    this.now = options.now ?? Date.now;
    this.recheckMs = options.recheckMs ?? CATALOG_RECHECK_MS;
  }

  /**
   * `limit.context` de ese modelo en ese proveedor, o null. Nunca lanza.
   * `contextWindow(null, null)` solo precarga.
   */
  async contextWindow(providerId: string | null, modelId: string | null): Promise<number | null> {
    await this.refresh();
    if (providerId === null || modelId === null || providerId.length === 0 || modelId.length === 0) return null;
    return this.windows.get(`${providerId}/${modelId}`) ?? null;
  }

  private refresh(): Promise<void> {
    if (this.file === null) return Promise.resolve();
    const now = this.now();
    if (this.checkedAt !== null && now - this.checkedAt < this.recheckMs) return Promise.resolve();
    if (this.refreshing === null) {
      this.checkedAt = now;
      this.refreshing = this.reload(this.file).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async reload(file: string): Promise<void> {
    let mtimeMs: number;
    try {
      mtimeMs = (await this.stat(file)).mtimeMs;
    } catch {
      // Sin archivo no hay catalogo: lo que se sabia de antes tampoco vale.
      this.windows = new Map();
      this.loadedMtime = null;
      return;
    }
    if (mtimeMs === this.loadedMtime) return;
    try {
      this.windows = catalogWindows(JSON.parse(await this.readFile(file)));
      this.loadedMtime = mtimeMs;
    } catch {
      // A medio escribir, o no es JSON: sin ventana hasta la proxima mirada.
      this.windows = new Map();
      this.loadedMtime = null;
    }
  }
}
