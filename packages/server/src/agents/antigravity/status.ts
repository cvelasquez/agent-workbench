/**
 * El estado de Antigravity CLI, leido de lo que escribe el script de su status
 * line (`statusline-script.ts`): un archivo por conversacion en
 * `<carpeta de la app>/agent-status/antigravity/<id>.json`.
 *
 * Solo existe si el usuario configuro la status line. Sin ella la CLI no deja
 * en disco nada que diga si trabaja, espera un permiso o esta libre, ni cuantos
 * tokens lleva: la pestana dice que no se sabe (`unknown`), el medidor queda sin
 * medir y el modo es el supuesto.
 *
 * Tres decisiones, cada una medida contra la 1.2.2 (hito 27, paso 0):
 *
 *  - **"Esperando" es `tool_confirmation_pending`**, que vale true exactamente
 *    mientras el menu de permiso esta abierto. `agent_state` no tiene un valor
 *    de espera: con el menu abierto dice `tool_use`.
 *  - **El medidor es `total_input_tokens`**: es lo que la CLI divide por la
 *    ventana para su porcentaje, y no acumula entre peticiones. El porcentaje
 *    y `current_usage` quedan de respaldo, por si una version deja de mandarlo.
 *  - **Estado y modo solo de ESTE proceso.** Un archivo sobrevive a la pestana
 *    (se conserva al salir la CLI, al cerrar y al apagar, por los tokens: R27-4;
 *    y un cierre abrupto del servidor no borra nada): lo que dice solo cuenta si
 *    la conversacion esta atada a una pty viva (`attach`) y se escribio despues
 *    de lanzarla. Sin eso, una pestana dormida mostraria "esperando" por un
 *    menu que ya no existe. Los tokens si se muestran igual: describen la
 *    conversacion, no el proceso.
 *
 * Se sondea con `stat` y se lee solo lo que cambio, igual que `cli-status.ts` de
 * Claude Code: son archivos de medio KB, y lo que hace falta es el contenido.
 */

import { unlinkSync } from 'node:fs';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  EMPTY_CONTEXT_USAGE,
  type ContextUsage,
  type PermissionMode,
} from '@agent-workbench/shared';
import { agentStatusDir } from '../../paths.js';
import type { AgentStatus, StatusSource } from '../adapter.js';
import { ANTIGRAVITY_EFFORT_OPTIONS, CONVERSATION_ID_PATTERN } from './constants.js';
import { fromCycleMode } from './mode-names.js';
import { splitModelLabel } from './model-label.js';
import type { FollowerStatusLine } from './session-follower.js';
import { STATUS_LINE_SCRIPT_VERSION } from './statusline-script.js';

/** Cada cuanto se miran los archivos de las pestanas suscritas. Como `cli-status.ts`. */
export const STATUS_POLL_INTERVAL_MS = 700;

/** Un registro del script pesa medio KB; mas que esto no es uno. */
export const STATUS_RECORD_MAX_BYTES = 64 * 1024;

/** A los 7 dias un registro de una conversacion que nadie reanudo se borra (al arrancar). */
export const STATUS_RECORD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Un temporal del script que quedo de un rename fallido. */
const STALE_TEMP_MAX_AGE_MS = 60 * 60 * 1000;

/** La etiqueta de espera, la misma que usa Claude Code (`cli-status.ts`). */
export const PERMISSION_PROMPT = 'permission prompt';

export interface StatusRecordUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
}

/** Lo que escribe el script, validado. */
export interface StatusRecord {
  at: number;
  conversationId: string;
  agentState: string | null;
  toolConfirmationPending: boolean;
  cycleMode: string | null;
  model: { id: string | null; displayName: string | null; effort: string | null };
  contextWindow: {
    totalInputTokens: number | null;
    totalOutputTokens: number | null;
    size: number | null;
    usedPercentage: number | null;
    currentUsage: StatusRecordUsage | null;
  };
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * Un registro del script, o null si no es uno de esta version o no es de esa
 * conversacion. El nombre del archivo y el id de adentro tienen que coincidir.
 */
export function parseStatusRecord(value: unknown, conversationId: string): StatusRecord | null {
  const record = asRecord(value);
  if (record === null || record['v'] !== STATUS_LINE_SCRIPT_VERSION) return null;
  const at = num(record['at']);
  const id = str(record['conversationId']);
  if (at === null || id === null || id.toLowerCase() !== conversationId.toLowerCase()) return null;

  const model = asRecord(record['model']) ?? {};
  const window = asRecord(record['contextWindow']) ?? {};
  const usage = asRecord(window['currentUsage']);
  return {
    at,
    conversationId: id.toLowerCase(),
    agentState: str(record['agentState']),
    toolConfirmationPending: record['toolConfirmationPending'] === true,
    cycleMode: str(record['cycleMode']),
    model: { id: str(model['id']), displayName: str(model['displayName']), effort: str(model['effort']) },
    contextWindow: {
      totalInputTokens: num(window['totalInputTokens']),
      totalOutputTokens: num(window['totalOutputTokens']),
      size: num(window['size']),
      usedPercentage: num(window['usedPercentage']),
      currentUsage:
        usage === null
          ? null
          : {
              inputTokens: num(usage['inputTokens']),
              outputTokens: num(usage['outputTokens']),
              cacheCreationInputTokens: num(usage['cacheCreationInputTokens']),
              cacheReadInputTokens: num(usage['cacheReadInputTokens']),
            },
    },
  };
}

/**
 * La actividad que dice un registro. Sin registro, `unknown`: la pestana no
 * esta parada, simplemente no se sabe. Un `agent_state` desconocido —o
 * `initializing`, `authenticating`— es trabajando, como en Claude Code: un
 * estado que no conocemos significa que la CLI esta en algo.
 */
export function activityOf(record: StatusRecord | null): AgentStatus {
  if (record === null) return { activity: 'unknown', waitingFor: null };
  if (record.toolConfirmationPending) return { activity: 'waiting', waitingFor: PERMISSION_PROMPT };
  if (record.agentState === 'idle') return { activity: 'idle', waitingFor: null };
  return { activity: 'busy', waitingFor: null };
}

/**
 * El uso del contexto segun la status line.
 *
 * La barra es `total_input_tokens` (medido: `used_percentage` es exactamente
 * eso sobre la ventana, sin la salida, y no acumula). Si falta, el porcentaje
 * por la ventana; si tambien, lo que leyo la ultima peticion. Los acumulados
 * van en 0: la CLI no publica ninguno.
 */
export function usageFromRecord(record: StatusRecord, base: ContextUsage): ContextUsage {
  const window = record.contextWindow;
  const size = window.size !== null && window.size > 0 ? window.size : null;
  const current = window.currentUsage;

  let tokens = 0;
  if (window.totalInputTokens !== null) {
    tokens = window.totalInputTokens;
  } else if (size !== null && window.usedPercentage !== null) {
    tokens = Math.round((size * window.usedPercentage) / 100);
  } else if (current !== null) {
    tokens = (current.inputTokens ?? 0) + (current.cacheReadInputTokens ?? 0) + (current.cacheCreationInputTokens ?? 0);
  }

  const lastModel = record.model.displayName ?? record.model.id ?? base.lastModel;
  const lastEffort = effortOfRecord(record, lastModel);
  return {
    ...EMPTY_CONTEXT_USAGE,
    lastRequestTokens: tokens,
    lastOutputTokens: current?.outputTokens ?? 0,
    // La etiqueta completa, con el esfuerzo: es la familia del combo de modelo.
    lastModel,
    contextWindow: size,
    contextWindowEstimated: false,
    assistantMessages: base.assistantMessages,
    ...(lastEffort !== null ? { lastEffort } : {}),
  };
}

/**
 * El esfuerzo que publica la status line, en el acto (R27-5): el historial lo
 * dice recien con el mensaje siguiente. `model.effort` si es uno de los niveles
 * del combo; si no, el parentesis de la etiqueta, igual que `defaults`. null si
 * ninguno lo dice: un modelo sin niveles no inventa uno.
 */
function effortOfRecord(record: StatusRecord, label: string | null): string | null {
  const declared = record.model.effort?.trim().toLowerCase() ?? '';
  if (ANTIGRAVITY_EFFORT_OPTIONS.some((option) => option.value === declared)) return declared;
  return label === null ? null : splitModelLabel(label).effort;
}

interface Slot {
  /** Fecha y tamano del archivo en la ultima lectura; null si no estaba. */
  stamp: string | null;
  record: StatusRecord | null;
}

export interface AntigravityStatusStoreOptions {
  /** La carpeta de los registros. Se calcula en cada uso: el chequeo cambia `APPDATA`. */
  dir?: () => string;
}

/** Los registros del script, por conversacion. */
export class AntigravityStatusStore {
  private readonly dir: () => string;
  private readonly slots = new Map<string, Slot>();
  private readonly inflight = new Map<string, Promise<StatusRecord | null>>();
  /** Conversaciones atadas a una pty viva, con el momento en que se lanzo. */
  private readonly launches = new Map<string, number>();

  constructor(options: AntigravityStatusStoreOptions = {}) {
    this.dir = options.dir ?? (() => agentStatusDir('antigravity'));
  }

  /** La ruta del registro de un id, o null si el id no es un uuid. */
  fileOf(conversationId: string): string | null {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;
    return path.join(this.dir(), `${conversationId.toLowerCase()}.json`);
  }

  /** La conversacion corre en una pty lanzada en `launchedAt`: su estado cuenta desde ahi. */
  attach(conversationId: string, launchedAt: number): void {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) return;
    this.launches.set(conversationId.toLowerCase(), launchedAt);
  }

  detach(conversationId: string): void {
    this.launches.delete(conversationId.toLowerCase());
  }

  /** El ultimo registro leido, sea de cuando sea. */
  get(conversationId: string): StatusRecord | null {
    return this.slots.get(conversationId.toLowerCase())?.record ?? null;
  }

  /** El registro, solo si lo escribio la pty viva de esa conversacion. */
  current(conversationId: string): StatusRecord | null {
    const key = conversationId.toLowerCase();
    const launchedAt = this.launches.get(key);
    const record = this.slots.get(key)?.record ?? null;
    if (launchedAt === undefined || record === null || record.at < launchedAt) return null;
    return record;
  }

  /**
   * Relee el registro si cambio de fecha o tamano. Nunca lanza. Un archivo que
   * no parsea **no** pisa lo anterior: el script escribe con rename, pero en
   * Windows puede caer a escribir en el lugar, y un sondeo puede ver el medio.
   * Un archivo que desaparecio si: lo borro `forget` o la limpieza.
   */
  refresh(conversationId: string): Promise<StatusRecord | null> {
    const key = conversationId.toLowerCase();
    const running = this.inflight.get(key);
    if (running !== undefined) return running;
    const run = this.read(key).finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  /** Borra el registro, en disco y en memoria. Sincrono: va antes de que la CLI escriba el nuevo. */
  forget(conversationId: string): void {
    const file = this.fileOf(conversationId);
    if (file === null) return;
    this.slots.delete(conversationId.toLowerCase());
    try {
      unlinkSync(file);
    } catch {
      // No estaba, o lo tiene tomado un instante: la limpieza de 7 dias lo agarra.
    }
  }

  /**
   * Borra los registros de mas de `maxAgeMs` y los temporales de un rename que
   * fallo. Solo archivos con los nombres que escribe el script. Nunca lanza.
   */
  async removeStale(maxAgeMs: number = STATUS_RECORD_MAX_AGE_MS, now: number = Date.now()): Promise<void> {
    const dir = this.dir();
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const record = /^([0-9a-f-]{36})\.json$/i.exec(name);
      const temp = /^([0-9a-f-]{36})\.json\.\d+\.tmp$/i.exec(name);
      const id = record?.[1] ?? temp?.[1];
      if (id === undefined || !CONVERSATION_ID_PATTERN.test(id)) continue;
      const limit = record !== null ? maxAgeMs : STALE_TEMP_MAX_AGE_MS;
      try {
        const info = await stat(path.join(dir, name));
        if (info.isFile() && now - info.mtimeMs > limit) await unlink(path.join(dir, name));
      } catch {
        // Otro proceso lo borro o lo tiene tomado: no importa.
      }
    }
  }

  private async read(key: string): Promise<StatusRecord | null> {
    const file = this.fileOf(key);
    if (file === null) return null;
    const slot = this.slots.get(key) ?? { stamp: null, record: null };
    try {
      const info = await stat(file);
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === slot.stamp) return slot.record;
      slot.stamp = stamp;
      if (info.isFile() && info.size > 0 && info.size <= STATUS_RECORD_MAX_BYTES) {
        const parsed = parseStatusRecord(JSON.parse(await readFile(file, 'utf8')), key);
        if (parsed !== null) slot.record = parsed;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        slot.stamp = null;
        slot.record = null;
      }
      // Otro error, o un JSON a medio escribir: se queda lo anterior.
    }
    this.slots.set(key, slot);
    return slot.record;
  }
}

interface Subscription {
  sessionId: string;
  listener: (status: AgentStatus | null) => void;
  last: string | null;
}

interface Waiter {
  sessionId: string;
  check(): void;
  finish(ready: boolean): void;
}

export interface AntigravityStatusSourceOptions {
  intervalMs?: number;
}

/**
 * La fuente de estado del adaptador. Existe siempre, este o no la status line:
 * si se configura con una pestana abierta, la pestana empieza a mostrar su
 * estado en el sondeo siguiente, sin relanzarla.
 *
 * Nunca avisa null: null es "no hay proceso" y la pestana se pintaria
 * desconectada; que la pty termino lo sabe el registro por su cuenta.
 */
export class AntigravityStatusSource implements StatusSource {
  private readonly subscriptions = new Set<Subscription>();
  private readonly waiters = new Set<Waiter>();
  private readonly intervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(
    private readonly store: AntigravityStatusStore,
    private readonly isActive: () => boolean,
    options: AntigravityStatusSourceOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? STATUS_POLL_INTERVAL_MS;
  }

  /** Lo que se sabe ahora, sin leer el disco. */
  statusOf(sessionId: string): AgentStatus {
    if (!this.isActive()) return { activity: 'unknown', waitingFor: null };
    return activityOf(this.store.current(sessionId));
  }

  subscribe(sessionId: string, listener: (status: AgentStatus | null) => void): () => void {
    const subscription: Subscription = { sessionId, listener, last: null };
    this.subscriptions.add(subscription);
    // En el acto, con lo que ya haya en memoria: una pestana no espera un sondeo para decir que no se sabe.
    this.deliver(subscription);
    this.start();
    void this.tick();
    return () => {
      this.subscriptions.delete(subscription);
      this.stopIfIdle();
    };
  }

  /**
   * true cuando la conversacion esta libre y sin permiso pendiente, segun un
   * registro de la pty viva (M5: alcanza con el ultimo, aunque el `idle` se
   * haya escrito antes de llamar). false enseguida sin status line, o al
   * vencer el plazo. Espera por condicion, en el sondeo.
   */
  waitUntilReady(sessionId: string, timeoutMs: number): Promise<boolean> {
    if (!this.isActive()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let done = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const waiter: Waiter = {
        sessionId,
        check: () => {
          if (this.isReady(sessionId)) waiter.finish(true);
        },
        finish: (ready) => {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          this.waiters.delete(waiter);
          this.stopIfIdle();
          resolve(ready);
        },
      };
      deadline = setTimeout(() => waiter.finish(false), timeoutMs);
      this.waiters.add(waiter);
      this.start();
      void this.tick();
    });
  }

  /**
   * Relee en el acto el registro de una conversacion y avisa a quien la mira
   * lo que cambio, sin esperar el sondeo. Lo usa la guarda de un envio antes
   * de cada pieza (R27-2): 700 ms de atraso alcanzan para que el Enter caiga
   * sobre un menu que ya se abrio. Nunca lanza.
   */
  async refresh(sessionId: string): Promise<void> {
    if (!this.isActive()) return;
    await this.store.refresh(sessionId);
    const key = sessionId.toLowerCase();
    for (const subscription of [...this.subscriptions]) {
      if (subscription.sessionId.toLowerCase() === key) this.deliver(subscription);
    }
  }

  /** Una vuelta: relee los registros de quien mira y avisa lo que cambio. Publica para el chequeo. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.isActive()) {
        const ids = new Set<string>();
        for (const subscription of this.subscriptions) ids.add(subscription.sessionId);
        for (const waiter of this.waiters) ids.add(waiter.sessionId);
        for (const id of ids) await this.store.refresh(id);
      }
      for (const subscription of [...this.subscriptions]) this.deliver(subscription);
      for (const waiter of [...this.waiters]) waiter.check();
    } finally {
      this.ticking = false;
    }
  }

  dispose(): void {
    this.subscriptions.clear();
    for (const waiter of [...this.waiters]) waiter.finish(false);
    this.stop();
  }

  private isReady(sessionId: string): boolean {
    if (!this.isActive()) return false;
    const record = this.store.current(sessionId);
    return record !== null && record.agentState === 'idle' && !record.toolConfirmationPending;
  }

  private deliver(subscription: Subscription): void {
    const status = this.statusOf(subscription.sessionId);
    const key = `${status.activity}|${status.waitingFor ?? ''}`;
    if (key === subscription.last) return;
    subscription.last = key;
    subscription.listener(status);
  }

  private start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  private stopIfIdle(): void {
    if (this.subscriptions.size === 0 && this.waiters.size === 0) this.stop();
  }

  private stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}

/** Lo que el seguidor de una conversacion usa de la status line. */
export function createFollowerStatusLine(store: AntigravityStatusStore, isActive: () => boolean): FollowerStatusLine {
  return {
    active: isActive,
    live: (conversationId) => store.current(conversationId) !== null,
    refresh: async (conversationId) => {
      await store.refresh(conversationId);
    },
    usage: (conversationId, base) => {
      const record = store.get(conversationId);
      return record === null ? null : usageFromRecord(record, base);
    },
    permissionMode: (conversationId): PermissionMode | null => {
      const record = store.current(conversationId);
      return record === null ? null : fromCycleMode(record.cycleMode, record.agentState);
    },
  };
}
