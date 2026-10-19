/**
 * Los limites del plan de una CLI, del lado del servidor (hito 47, §6.37).
 *
 * Dos formas de enterarse, las dos sin nombrar ninguna CLI:
 *
 *  - `PlanLimitsBook`: alguien le cuenta lo que vio. Es lo que usa la CLI que
 *    escribe los limites en su historial: el seguidor de cada sesion le pasa lo
 *    que lee.
 *  - `PlanLimitsRecordDir`: lee los registros que deja el script de una status
 *    line, uno por sesion, en `<carpeta de la app>/agent-status/<cli>/`. Solo
 *    sondea mientras alguien escucha, y solo relee lo que cambio de fecha o
 *    tamano.
 *
 * En los dos casos, por ventana gana lo observado mas tarde
 * (`mergePlanLimitWindows`): los limites son de la cuenta, y dos sesiones de la
 * misma CLI publican lo mismo visto en momentos distintos.
 */

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  asRecord,
  mergePlanLimitWindows,
  parsePlanLimitWindows,
  samePlanWindows,
  type PlanLimitWindow,
} from '@agent-workbench/shared';
import type { PlanLimitsSource } from './adapter.js';

/** Cada cuanto se mira la carpeta de registros mientras alguien escucha. */
export const PLAN_LIMITS_POLL_INTERVAL_MS = 2_000;

/** Un registro pesa medio KB; mas que esto no es uno. */
export const PLAN_LIMITS_RECORD_MAX_BYTES = 64 * 1024;

/**
 * Un registro sin tocar en este tiempo no se lee: sus ventanas ya se
 * reiniciaron todas (la mas larga que se conoce es la semana). Los borra la
 * limpieza al arrancar (`removeStalePlanRecords`).
 */
export const PLAN_LIMITS_RECORD_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;

/** Como mucho estos registros por vuelta, los mas nuevos: cada sesion deja uno. */
export const PLAN_LIMITS_MAX_RECORDS = 200;

/** El nombre de un registro: `<uuid>.json`, el id de la sesion que lo escribio. */
const RECORD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i;
/** El temporal que deja un rename que fallo: `<uuid>.json.<pid>.tmp`. */
const TEMP_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json\.\d+\.tmp$/i;
/** Un temporal de mas de una hora ya no lo va a renombrar nadie. */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** Lo que se sabe de una CLI, con quien quiera enterarse. */
export class PlanLimitsBook implements PlanLimitsSource {
  private windows: PlanLimitWindow[] = [];
  private readonly listeners = new Set<() => void>();

  current(): readonly PlanLimitWindow[] {
    return this.windows;
  }

  /** Suma lo que alguien vio. Avisa solo si cambio algo. */
  observe(incoming: readonly PlanLimitWindow[]): void {
    if (incoming.length === 0) return;
    this.set(mergePlanLimitWindows(this.windows, incoming));
  }

  /** Reemplaza todo: lo usa quien relee todos los registros en cada vuelta. */
  replace(windows: readonly PlanLimitWindow[]): void {
    this.set(mergePlanLimitWindows([], windows));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    this.listeners.clear();
  }

  private set(next: PlanLimitWindow[]): void {
    if (samePlanWindows(next, this.windows)) return;
    this.windows = next;
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[plan-limits] a listener failed:', error);
      }
    }
  }
}

/** Las ventanas de un registro, o null si no es un objeto. Un registro sin ventanas da []. */
export function planWindowsOfRecord(value: unknown): PlanLimitWindow[] | null {
  const record = asRecord(value);
  if (record === null) return null;
  return parsePlanLimitWindows(record['planLimits']) ?? [];
}

interface RecordSlot {
  stamp: string;
  windows: PlanLimitWindow[];
}

export interface PlanLimitsRecordDirOptions {
  intervalMs?: number;
  maxAgeMs?: number;
  /** Para el chequeo. */
  now?: () => number;
}

/** Los limites que dejan los registros de una status line. */
export class PlanLimitsRecordDir implements PlanLimitsSource {
  private readonly book = new PlanLimitsBook();
  private readonly slots = new Map<string, RecordSlot>();
  private readonly intervalMs: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;
  private subscribers = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** La vuelta en curso: otra que se pida mientras tanto espera esta, no corre al lado. */
  private running: Promise<void> | null = null;

  /** `dir` se calcula en cada vuelta: el chequeo cambia `APPDATA`. */
  constructor(
    private readonly dir: () => string,
    options: PlanLimitsRecordDirOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? PLAN_LIMITS_POLL_INTERVAL_MS;
    this.maxAgeMs = options.maxAgeMs ?? PLAN_LIMITS_RECORD_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  current(): readonly PlanLimitWindow[] {
    return this.book.current();
  }

  subscribe(listener: () => void): () => void {
    const stop = this.book.subscribe(listener);
    this.subscribers += 1;
    if (this.subscribers === 1) this.start();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      stop();
      this.subscribers -= 1;
      if (this.subscribers === 0) this.stop();
    };
  }

  /** Una vuelta: lista la carpeta, relee lo que cambio y avisa si cambio algo. Publica para el chequeo. */
  tick(): Promise<void> {
    if (this.running !== null) return this.running;
    const run = this.scan().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  dispose(): void {
    this.stop();
    this.book.dispose();
    this.slots.clear();
  }

  private async scan(): Promise<void> {
    const dir = this.dir();
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => RECORD_NAME.test(name));
    } catch {
      // Sin carpeta todavia: el script no corrio nunca. No se sabe nada.
      names = [];
    }

    const now = this.now();
    const fresh: { name: string; stamp: string; mtimeMs: number }[] = [];
    for (const name of names) {
      try {
        const info = await stat(path.join(dir, name));
        if (!info.isFile() || now - info.mtimeMs > this.maxAgeMs) continue;
        fresh.push({ name, stamp: `${info.mtimeMs}:${info.size}`, mtimeMs: info.mtimeMs });
      } catch {
        // Borrado entre el listado y el stat.
      }
    }
    fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const kept = fresh.slice(0, PLAN_LIMITS_MAX_RECORDS);

    const next = new Map<string, RecordSlot>();
    for (const file of kept) {
      const previous = this.slots.get(file.name);
      if (previous !== undefined && previous.stamp === file.stamp) {
        next.set(file.name, previous);
        continue;
      }
      const windows = await this.read(path.join(dir, file.name));
      // Un archivo a medio escribir no pisa lo anterior: se relee en la vuelta siguiente.
      if (windows === null) {
        if (previous !== undefined) next.set(file.name, previous);
        continue;
      }
      next.set(file.name, { stamp: file.stamp, windows });
    }

    this.slots.clear();
    for (const [name, slot] of next) this.slots.set(name, slot);
    this.book.replace([...this.slots.values()].flatMap((slot) => slot.windows));
  }

  private async read(file: string): Promise<PlanLimitWindow[] | null> {
    try {
      const info = await stat(file);
      if (info.size === 0 || info.size > PLAN_LIMITS_RECORD_MAX_BYTES) return [];
      return planWindowsOfRecord(JSON.parse(await readFile(file, 'utf8')));
    } catch {
      return null;
    }
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
    void this.tick();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * Borra los registros de mas de `maxAgeMs` y los temporales de un rename que
 * fallo. Solo archivos con los nombres que escribe un script de la app. Nunca
 * lanza.
 */
export async function removeStalePlanRecords(
  dir: string,
  maxAgeMs: number = PLAN_LIMITS_RECORD_MAX_AGE_MS,
  now: number = Date.now(),
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const limit = RECORD_NAME.test(name) ? maxAgeMs : TEMP_NAME.test(name) ? STALE_TEMP_MAX_AGE_MS : null;
    if (limit === null) continue;
    try {
      const info = await stat(path.join(dir, name));
      if (info.isFile() && now - info.mtimeMs > limit) await unlink(path.join(dir, name));
    } catch {
      // Otro proceso lo borro o lo tiene tomado: no importa.
    }
  }
}
