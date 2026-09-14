/**
 * El escritor de la copia propia: pasadas, calma y pasada en seco (hito 28, §7).
 *
 * Una **pasada** recorre las sesiones que la barra lista y no estan archivadas,
 * de todas las CLIs registradas (D5), y deja en la copia las que cambiaron y ya
 * llevan un minuto en calma. Despues copia la memoria de cada proyecto. Una
 * **pasada en seco** hace el mismo camino hasta armar el archivo, sin calma, sin
 * huella, sin reusar imagenes y sin escribir nada: es lo que el usuario mira
 * antes de encender la copia (D6).
 *
 * Lo que decide cada paso, en el orden en que se decide:
 *
 *  0. **Archivada**: no se copia. Se mira al armar la pasada, otra vez al
 *     empezar cada sesion y justo antes de escribirla: una pasada larga dura
 *     minutos y archivar mientras corre no puede dejarla escribirse igual (D5).
 *  1. **Sin cambios en el indice desde la pasada anterior de este proceso**
 *     (mismo `updatedAt` y tamano del resumen, y la cabecera que tiene el
 *     catalogo es la que dejo esa pasada): no se toca el disco. No alcanza con
 *     que haya una cabecera: mudar a una carpeta con una copia vieja de la
 *     sesion la deja ahi con otra huella.
 *  2. La fuente no declara `wholeRead`: no se lee (C7). Cuenta como
 *     `unsupported`.
 *  3. La copia en disco es de un formato que no se conoce: no se pisa (D15).
 *  4. La huella de la cabecera (`mtimeMs`, `sizeBytes` y `writerRevision`) es la
 *     del origen: al dia.
 *  5. El origen cambio hace menos de `CALM_MS`: pendiente, y un temporizador a
 *     la hora en que se calma. Regenerar una sesion de 20 MB en cada turno es
 *     justo lo que no hay que hacer.
 *  6. Se lee entera por el seguidor de su adaptador (`readWholeSession`). Un
 *     origen que no aparece es un fallo con motivo, no una sesion vacia (C6).
 *  7. Las imagenes que ya estaban en la copia anterior, con la misma clave
 *     `eventId|source|index`, el mismo `mediaType` y el asset en disco, **se
 *     reusan sin leerlas** (C5): en Claude Code cada `readImage` recorre el
 *     archivo entero.
 *  8. Se escribe por temporal y se relee la cabecera en el catalogo.
 *
 * Una sesion que falla cuenta, se loguea y **no corta la pasada**. Un disco
 * lleno si la corta: seguir solo dejaria mas temporales.
 *
 * El escritor no conoce el socket ni el dialogo: expone su estado
 * (`snapshot`) y avisa cuando cambia (`onChange`). Quien lo usa decide cuando
 * pedir una pasada y como mostrarla.
 */

import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  SESSION_AGENT_IDS,
  isVaultSessionId,
  type AgentId,
  type ProjectSummary,
  type VaultAgentMeasure,
  type VaultHeader,
  type VaultImageRef,
  type VaultMeasurement,
} from '@agent-workbench/shared';
import type { HistoryItem, HistorySource } from '../agents/adapter.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { EventLimits } from '../agents/transport-limits.js';
import type { IndexedSession } from '../session-index.js';
import type { AppSettings } from '../settings-store.js';
import type { VaultCatalog } from './catalog.js';
import { copyProjectMemory, measureProjectMemory } from './memory-copy.js';
import { assetFile, sessionsRoot } from './paths.js';
import { readWholeSession } from './read-session.js';
import { imageKey, serializeSession, type SerializedSession, type VaultImageInput } from './serialize.js';
import { DEFAULT_WRITE_DEPS, writeSessionFile, type VaultWriteDeps } from './write.js';

/**
 * Sube a mano cuando cambia lo que un adaptador entrega (un mapeo nuevo): la
 * pasada siguiente recopia todo lo nativo, e invalida las imagenes reusables.
 */
export const VAULT_WRITER_REVISION = 1;
/** Cuanto tiene que llevar quieta una sesion para copiarla. */
export const CALM_MS = 60_000;
/** Los pedidos de pasada se juntan: corre a los 5 s del ultimo. */
export const PASS_DEBOUNCE_MS = 5_000;
/** Un temporal propio mas viejo que esto quedo de un proceso que murio: se borra. */
export const TEMP_MAX_AGE_MS = 60 * 60 * 1000;
/** Motivo de un fallo cuando el origen no se encontro (C6). */
export const ORIGIN_NOT_FOUND = 'no se encontró el origen';
/** Motivo cuando en la copia ya hay una version de la sesion de un formato mas nuevo (D15). */
export const FOREIGN_FORMAT = 'la copia que ya está es de un formato más nuevo';
/** Motivo de un id que no puede ser un nombre de archivo. */
export const UNSAFE_SESSION_ID = 'id de sesión que no se puede copiar';
/** Lo que se contesta a quien quiere encender la copia sin haberla medido nunca (C18). */
export const MEASURE_FIRST_MESSAGE = 'Medí primero cuánto ocuparía.';

const PROGRESS_EVERY = 10;
const MAX_FAILURE_REASONS = 5;
/** `<nombre>.<pid>.<aleatorio de 12 hex>.tmp`: la forma de `temporaryPathFor`. Nada mas se borra. */
const OWN_TEMP_FILE = /\.\d+\.[0-9a-f]{12}\.tmp$/;

export class VaultBusyError extends Error {
  constructor(activity: VaultActivity) {
    super(`La copia está ocupada (${activity}).`);
    this.name = 'VaultBusyError';
  }
}

export type VaultActivity = 'idle' | 'measuring' | 'writing' | 'moving';

/** Lo que el escritor necesita del indice (`session-index.ts`). */
export interface VaultWriterIndex {
  nativeSessions(): readonly IndexedSession[];
  getProjects(): readonly ProjectSummary[];
}

/** Temporizadores inyectables: el chequeo prueba la calma con un reloj de mentira. */
export interface VaultWriterTimers {
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const REAL_TIMERS: VaultWriterTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    // Un temporizador de la copia no mantiene vivo al proceso: al apagar, lo pendiente se copia en el proximo arranque.
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface VaultWriterOptions {
  index: VaultWriterIndex;
  agents: Pick<AgentRegistry, 'adapter' | 'get'>;
  /** Las archivadas no se copian (D5). */
  archived: { has(sessionId: string): boolean };
  settings: { get(): Readonly<AppSettings> };
  /** Donde se escribe es la carpeta que tiene cargada: lo que se compara y lo que se escribe no pueden ser dos carpetas. */
  catalog: VaultCatalog;
  platform: string;
  now?: () => number;
  timers?: VaultWriterTimers;
  writeDeps?: VaultWriteDeps;
  /** Solo para el chequeo: por defecto, `VAULT_WRITER_REVISION`. */
  writerRevision?: number;
  log?: Pick<Console, 'warn'>;
}

/** Lo que paso en una pasada. Para logs y para el chequeo. */
export interface VaultPassReport {
  startedAt: number;
  durationMs: number;
  written: number;
  upToDate: number;
  /** Sin cambios en el indice desde la pasada anterior: no se miro el disco. */
  unchanged: number;
  pending: number;
  skippedArchived: number;
  skippedEmpty: number;
  unsupported: number;
  failed: number;
  failureReasons: string[];
  memoryFiles: number;
  memoryBytes: number;
  /** El motivo si la pasada se corto (disco lleno). */
  aborted: string | null;
}

export interface VaultWriterSnapshot {
  activity: VaultActivity;
  progress: { done: number; total: number } | null;
  lastPassAt: number | null;
  /** Sesiones cambiadas que esperan su minuto de calma. */
  pending: number;
  /** Vive en memoria hasta que el servidor se apaga. */
  measurement: VaultMeasurement | null;
  lastError: string | null;
  lastPass: VaultPassReport | null;
}

interface Candidate {
  session: IndexedSession;
  history: HistorySource;
}

type ReadOutcome =
  | { kind: 'not-found' }
  | { kind: 'empty' }
  | { kind: 'ok'; serialized: SerializedSession };

type PassOutcome =
  | { kind: 'unchanged' }
  | { kind: 'archived' }
  | { kind: 'unsupported' }
  | { kind: 'not-found' }
  | { kind: 'foreign' }
  | { kind: 'unsafe' }
  | { kind: 'up-to-date' }
  | { kind: 'pending'; due: number }
  | { kind: 'empty' }
  | { kind: 'written' };

interface SeenSession {
  updatedAt: number;
  sizeBytes: number;
  /**
   * La huella del origen con la que quedo la copia despues de esa vuelta, o
   * null si no habia nada que copiar. Se compara con la cabecera que tiene el
   * catalogo, no alcanza con que haya una: despues de mudar a una carpeta que ya
   * tenia una copia vieja de la sesion, o de un ⟳ que relee una version vieja,
   * la cabecera existe y no es la que se escribio.
   */
  copiedFrom: Pick<HistoryItem, 'mtimeMs' | 'sizeBytes'> | null;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNoSpace(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOSPC';
}

function addReason(reasons: string[], reason: string): void {
  if (reasons.length < MAX_FAILURE_REASONS && !reasons.includes(reason)) reasons.push(reason);
}

function emptyMeasure(agent: AgentId): VaultAgentMeasure {
  return {
    agent,
    sessions: 0,
    eventBytes: 0,
    images: 0,
    imageBytes: 0,
    skippedArchived: 0,
    skippedEmpty: 0,
    unsupported: 0,
    failed: 0,
    failureReasons: [],
  };
}

/**
 * null si se puede encender la copia; si no, el motivo para el usuario (C18).
 *
 * Encender pide una medicion en este proceso **salvo** que la carpeta ya tenga
 * sesiones que escribio una pasada (`passSessions`, del catalogo): una pasada
 * solo corre encendida, asi que quien las tiene ya vio cuanto ocupaba, y eso lo
 * dice el disco sin un ajuste mas. **No alcanza con `vault.json`**: un
 * importador con `--write` lo escribe, y quien importo antes de encender nunca
 * midio. La web decide "Activar" con la misma cuenta (`VaultStatus.passSessions`).
 * Apagarla no pasa por aca.
 */
export function enableRefusal(hasMeasurement: boolean, passSessions: number): string | null {
  return hasMeasurement || passSessions > 0 ? null : MEASURE_FIRST_MESSAGE;
}

/** Los topes de la copia (D4): texto y entrada enteros, resultados hasta el ajuste. */
export function vaultEventLimits(toolResultMaxChars: number): EventLimits {
  return {
    textMaxChars: Number.POSITIVE_INFINITY,
    toolInputMaxChars: Number.POSITIVE_INFINITY,
    toolResultMaxChars,
  };
}

/**
 * true si la copia de una sesion esta al dia con su origen: cabecera nativa con
 * la fecha y el tamano del item y la revision del escritor (§7.2, paso 3). Lo
 * usan la pasada y la exportacion, que lee de la copia solo si esto da true.
 */
export function copyMatchesOrigin(
  header: VaultHeader | null,
  item: Pick<HistoryItem, 'mtimeMs' | 'sizeBytes'>,
  revision: number,
): boolean {
  return (
    header !== null &&
    header.source.kind === 'native' &&
    header.source.mtimeMs === item.mtimeMs &&
    header.source.sizeBytes === item.sizeBytes &&
    header.source.writerRevision === revision
  );
}

export class VaultWriter {
  private activity: VaultActivity = 'idle';
  private progress: { done: number; total: number } | null = null;
  private lastPassAt: number | null = null;
  private pending = 0;
  private measurement: VaultMeasurement | null = null;
  private lastError: string | null = null;
  private lastPass: VaultPassReport | null = null;

  private passQueued = false;
  private debounceTimer: unknown = null;
  private calmTimer: unknown = null;
  private lastSweepAt: number | null = null;
  private disposed = false;

  private readonly seen = new Map<string, SeenSession>();
  private readonly warnedForeign = new Set<string>();
  private readonly listeners = new Set<() => void>();

  private readonly now: () => number;
  private readonly timers: VaultWriterTimers;
  private readonly writeDeps: VaultWriteDeps;
  private readonly revision: number;
  private readonly log: Pick<Console, 'warn'>;

  constructor(private readonly options: VaultWriterOptions) {
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? REAL_TIMERS;
    this.writeDeps = options.writeDeps ?? DEFAULT_WRITE_DEPS;
    this.revision = options.writerRevision ?? VAULT_WRITER_REVISION;
    this.log = options.log ?? console;
  }

  snapshot(): VaultWriterSnapshot {
    return {
      activity: this.activity,
      progress: this.progress === null ? null : { ...this.progress },
      lastPassAt: this.lastPassAt,
      pending: this.pending,
      measurement: this.measurement,
      lastError: this.lastError,
      lastPass: this.lastPass,
    };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Pide una pasada. Se juntan: corre a los `PASS_DEBOUNCE_MS` del ultimo
   * pedido. Con algo en curso queda anotada y corre una sola vez al terminar.
   * Con la copia apagada no hace nada.
   */
  requestPass(): void {
    if (this.disposed || !this.options.settings.get().vault.enabled) return;
    if (this.activity !== 'idle') {
      this.passQueued = true;
      return;
    }
    if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
    this.debounceTimer = this.timers.set(() => {
      this.debounceTimer = null;
      void this.pass();
    }, PASS_DEBOUNCE_MS);
  }

  /**
   * Una pasada ya. null si no corrio: la copia esta apagada, no hay carpeta
   * cargada, o hay algo en curso (entonces queda anotada).
   */
  async pass(): Promise<VaultPassReport | null> {
    if (this.disposed || !this.options.settings.get().vault.enabled) return null;
    if (this.activity !== 'idle') {
      this.passQueued = true;
      return null;
    }
    const dir = this.options.catalog.getDir();
    if (dir === null) {
      this.lastError = 'La copia no está cargada.';
      this.emit();
      return null;
    }

    // Esta pasada cubre lo que esperaban los dos temporizadores.
    this.clearTimers();
    this.activity = 'writing';
    this.emit();
    try {
      const report = await this.runPass(dir);
      this.lastPass = report;
      return report;
    } finally {
      this.finishExclusive();
    }
  }

  /**
   * La pasada en seco: cuanto ocuparia la copia, por CLI, sin escribir nada
   * —tampoco `vault.json` ni la carpeta—. Lanza `VaultBusyError` con algo en
   * curso. Funciona con la copia apagada: es lo que se mira antes de encenderla.
   */
  async measure(): Promise<VaultMeasurement> {
    if (this.activity !== 'idle') throw new VaultBusyError(this.activity);
    this.activity = 'measuring';
    this.emit();
    try {
      this.measurement = await this.runMeasure();
      return this.measurement;
    } finally {
      this.finishExclusive();
    }
  }

  /**
   * Algo que no puede correr a la vez que una pasada ni que una medicion (la
   * mudanza de carpeta). Lanza `VaultBusyError` si ya hay algo en curso.
   */
  async exclusive<T>(activity: 'moving', run: () => Promise<T>): Promise<T> {
    if (this.activity !== 'idle') throw new VaultBusyError(this.activity);
    this.activity = activity;
    this.emit();
    try {
      return await run();
    } finally {
      this.finishExclusive();
    }
  }

  /** Cancela los temporizadores. No espera la pasada en curso: lo que quede se copia en el proximo arranque. */
  dispose(): void {
    this.disposed = true;
    this.clearTimers();
    this.listeners.clear();
  }

  // ---- Internos -----------------------------------------------------------

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.log.warn('[copia] un oyente del escritor lanzo:', error);
      }
    }
  }

  private clearTimers(): void {
    if (this.debounceTimer !== null) this.timers.clear(this.debounceTimer);
    if (this.calmTimer !== null) this.timers.clear(this.calmTimer);
    this.debounceTimer = null;
    this.calmTimer = null;
  }

  private finishExclusive(): void {
    this.activity = 'idle';
    this.progress = null;
    this.emit();
    if (this.passQueued && !this.disposed) {
      this.passQueued = false;
      setImmediate(() => {
        void this.pass();
      });
    }
  }

  private setProgress(done: number, total: number, force = false): void {
    this.progress = { done, total };
    if (force || done % PROGRESS_EVERY === 0) this.emit();
  }

  /**
   * Las sesiones que se copiarian, una por par `(agent, sessionId)` —la
   * primera que da el indice—, y cuantas archivadas se dejan afuera por CLI.
   */
  private candidates(): { candidates: Candidate[]; archived: Map<AgentId, number>; agents: Set<AgentId> } {
    const pairs = new Set<string>();
    const candidates: Candidate[] = [];
    const archived = new Map<AgentId, number>();
    const agents = new Set<AgentId>();
    for (const session of this.options.index.nativeSessions()) {
      const key = `${session.agent}/${session.summary.sessionId}`;
      if (pairs.has(key)) continue;
      pairs.add(key);
      agents.add(session.agent);
      if (this.options.archived.has(session.summary.sessionId)) {
        archived.set(session.agent, (archived.get(session.agent) ?? 0) + 1);
        continue;
      }
      candidates.push({ session, history: this.options.agents.adapter(session.agent).history });
    }
    return { candidates, archived, agents };
  }

  private limits(): EventLimits {
    return vaultEventLimits(this.options.settings.get().vault.toolResultMaxChars);
  }

  /** La revision con la que escribe este escritor: la que la exportacion compara (`copyMatchesOrigin`). */
  getRevision(): number {
    return this.revision;
  }

  private async runPass(dir: string): Promise<VaultPassReport> {
    const startedAt = this.now();
    const report: VaultPassReport = {
      startedAt,
      durationMs: 0,
      written: 0,
      upToDate: 0,
      unchanged: 0,
      pending: 0,
      skippedArchived: 0,
      skippedEmpty: 0,
      unsupported: 0,
      failed: 0,
      failureReasons: [],
      memoryFiles: 0,
      memoryBytes: 0,
      aborted: null,
    };
    let thrown: string | null = null;
    let calmDue: number | null = null;

    const { candidates, archived } = this.candidates();
    for (const count of archived.values()) report.skippedArchived += count;
    this.setProgress(0, candidates.length, true);

    for (const [position, candidate] of candidates.entries()) {
      if (this.disposed) break;
      const { agent } = candidate.session;
      const { sessionId } = candidate.session.summary;
      try {
        const outcome = await this.passOne(dir, candidate);
        switch (outcome.kind) {
          case 'written':
            report.written += 1;
            break;
          case 'up-to-date':
            report.upToDate += 1;
            break;
          case 'unchanged':
            report.unchanged += 1;
            break;
          case 'archived':
            report.skippedArchived += 1;
            break;
          case 'pending':
            report.pending += 1;
            calmDue = calmDue === null ? outcome.due : Math.min(calmDue, outcome.due);
            break;
          case 'empty':
            report.skippedEmpty += 1;
            break;
          case 'unsupported':
            report.unsupported += 1;
            break;
          case 'not-found':
            report.failed += 1;
            addReason(report.failureReasons, ORIGIN_NOT_FOUND);
            break;
          case 'foreign':
            report.failed += 1;
            addReason(report.failureReasons, FOREIGN_FORMAT);
            break;
          case 'unsafe':
            report.failed += 1;
            addReason(report.failureReasons, UNSAFE_SESSION_ID);
            break;
        }
      } catch (error) {
        const message = messageOf(error);
        if (isNoSpace(error)) {
          report.aborted = message;
          thrown = `Disco lleno: la pasada se corto (${message})`;
          this.log.warn(`[copia] ${thrown}`);
          break;
        }
        report.failed += 1;
        addReason(report.failureReasons, message);
        thrown = `${agent}/${sessionId}: ${message}`;
        this.log.warn(`[copia] no se pudo copiar ${thrown}`);
      }
      this.setProgress(position + 1, candidates.length);
      await nextTurn();
    }

    if (report.aborted === null && !this.disposed) {
      for (const project of this.options.index.getProjects()) {
        if (!project.cwdExists || project.cwd.length === 0) continue;
        try {
          const copied = await copyProjectMemory(dir, project.cwd, this.options.platform, this.writeDeps);
          report.memoryFiles += copied.files;
          report.memoryBytes += copied.bytes;
        } catch (error) {
          const message = messageOf(error);
          thrown = `memoria de ${project.cwd}: ${message}`;
          this.log.warn(`[copia] no se pudo copiar la ${thrown}`);
          if (isNoSpace(error)) {
            report.aborted = message;
            break;
          }
        }
      }
      await this.sweepTemporaries(dir);
    }

    this.lastPassAt = this.now();
    this.pending = report.pending;
    // El ultimo error se queda hasta una pasada limpia: el dialogo lo tiene que poder mostrar.
    if (thrown !== null) this.lastError = thrown;
    else if (report.aborted === null) this.lastError = null;
    report.durationMs = this.lastPassAt - startedAt;

    if (calmDue !== null && !this.disposed) {
      this.calmTimer = this.timers.set(() => {
        this.calmTimer = null;
        void this.pass();
      }, Math.max(0, calmDue - this.now()));
    }
    return report;
  }

  private remember(key: string, session: IndexedSession, copiedFrom: HistoryItem | null): void {
    this.seen.set(key, {
      updatedAt: session.summary.updatedAt,
      sizeBytes: session.summary.sizeBytes,
      copiedFrom: copiedFrom === null ? null : { mtimeMs: copiedFrom.mtimeMs, sizeBytes: copiedFrom.sizeBytes },
    });
  }

  private async passOne(dir: string, candidate: Candidate): Promise<PassOutcome> {
    const { session, history } = candidate;
    const { agent } = session;
    const { sessionId } = session.summary;
    const { catalog, archived } = this.options;
    const key = `${agent}/${sessionId}`;

    /*
      Lo archivado se filtro al armar los candidatos, pero una pasada larga dura
      minutos y el usuario puede archivar mientras corre: se vuelve a mirar aca
      y justo antes de escribir (D5). `archived` es el mismo objeto que cambia
      el socket.
    */
    if (archived.has(sessionId)) return { kind: 'archived' };
    if (history.wholeRead !== true) return { kind: 'unsupported' };
    if (!isVaultSessionId(sessionId)) return { kind: 'unsafe' };

    const seen = this.seen.get(key);
    if (
      seen !== undefined &&
      seen.updatedAt === session.summary.updatedAt &&
      seen.sizeBytes === session.summary.sizeBytes &&
      (seen.copiedFrom === null || copyMatchesOrigin(catalog.header(agent, sessionId), seen.copiedFrom, this.revision))
    ) {
      return { kind: 'unchanged' };
    }

    const item = await history.item(session.ref);
    if (item === null) return { kind: 'not-found' };

    if (catalog.hasForeignFormat(agent, sessionId)) {
      if (!this.warnedForeign.has(key)) {
        this.warnedForeign.add(key);
        this.log.warn(`[copia] ${key}: la copia en disco es de un formato mas nuevo; no se pisa`);
      }
      return { kind: 'foreign' };
    }

    const header = catalog.header(agent, sessionId);
    if (copyMatchesOrigin(header, item, this.revision)) {
      this.remember(key, session, item);
      return { kind: 'up-to-date' };
    }

    if (this.now() - item.mtimeMs < CALM_MS) return { kind: 'pending', due: item.mtimeMs + CALM_MS };

    const read = await this.readSession(candidate, item, { dir, header });
    if (read.kind !== 'ok') {
      // Sin copia que escribir: no se vuelve a leer hasta que el indice diga que cambio.
      this.remember(key, session, null);
      return read;
    }

    // Leerla entera puede tardar: archivada mientras tanto, no se escribe. Tampoco se recuerda, para que restaurarla la copie.
    if (archived.has(sessionId)) return { kind: 'archived' };
    await writeSessionFile(dir, read.serialized, this.writeDeps);
    await catalog.refresh(agent, sessionId);
    this.remember(key, session, item);
    return { kind: 'written' };
  }

  /**
   * Lee una sesion entera y la arma. `reuse` presente: las imagenes de la copia
   * anterior en esa carpeta se reusan sin leer (la pasada); ausente, se leen
   * todas (la pasada en seco).
   */
  private async readSession(
    candidate: Candidate,
    item: HistoryItem,
    reuse: { dir: string; header: VaultHeader | null } | null,
  ): Promise<ReadOutcome> {
    const { session, history } = candidate;
    const { agent, summary } = session;
    const whole = await readWholeSession(history, { cwd: summary.cwd, sessionId: summary.sessionId }, this.limits());
    if (whole === null) return { kind: 'not-found' };
    if (whole.state !== 'live' || whole.events.length === 0) return { kind: 'empty' };

    const previous = reuse === null ? new Map<string, VaultImageRef>() : await this.previousImages(reuse, agent, summary.sessionId, whole.events);
    const images = new Map<string, VaultImageInput>();
    for (const event of whole.events) {
      for (const part of event.parts) {
        if (part.kind !== 'image') continue;
        const keyOfImage = imageKey(event.eventId, part.source, part.index);
        if (images.has(keyOfImage)) continue;

        const old = previous.get(keyOfImage);
        if (
          reuse !== null &&
          old !== undefined &&
          old.asset !== null &&
          old.mediaType === part.mediaType &&
          (await this.assetOnDisk(reuse.dir, agent, summary.sessionId, old.asset, old.bytes))
        ) {
          images.set(keyOfImage, { kind: 'reused', asset: old.asset, bytes: old.bytes });
          continue;
        }

        try {
          const loaded = await whole.readImage(event.eventId, part.index, part.source);
          if (loaded !== null) images.set(keyOfImage, { kind: 'loaded', data: Buffer.from(loaded.data, 'base64') });
        } catch (error) {
          // Una imagen ilegible queda sin asset; no se lleva la sesion.
          this.log.warn(`[copia] ${whole.label}: no se pudo leer una imagen: ${messageOf(error)}`);
        }
      }
    }

    const serialized = serializeSession({
      header: {
        agent,
        sessionId: summary.sessionId,
        cwd: session.cwd ?? '',
        // Sin `cwd`, el agrupador nativo: la fila de la copia cae en el mismo proyecto que la nativa.
        group: session.cwd === null ? session.group : null,
        title: summary.title,
        titleSource: summary.titleSource,
        createdAt: null,
        updatedAt: summary.updatedAt,
        cliVersionAtCopy: this.options.agents.get(agent)?.location?.version ?? null,
        partial: false,
        stepCount: null,
        usage: whole.usage,
        source: { kind: 'native', mtimeMs: item.mtimeMs, sizeBytes: item.sizeBytes, writerRevision: this.revision },
        writtenAt: this.now(),
      },
      events: whole.events,
      images,
    });
    return { kind: 'ok', serialized };
  }

  /**
   * Las referencias de imagen de la copia anterior, por clave. Solo si hay algo
   * que reusar: una copia nativa de esta misma revision con imagenes, y una
   * sesion nueva que tiene alguna. Leer el cuerpo anterior cuesta lo que pesa.
   */
  private async previousImages(
    reuse: { dir: string; header: VaultHeader | null },
    agent: AgentId,
    sessionId: string,
    events: readonly { parts: readonly { kind: string }[] }[],
  ): Promise<Map<string, VaultImageRef>> {
    const refs = new Map<string, VaultImageRef>();
    const { header } = reuse;
    if (
      header === null ||
      header.source.kind !== 'native' ||
      header.source.writerRevision !== this.revision ||
      header.imageCount === 0 ||
      !events.some((event) => event.parts.some((part) => part.kind === 'image'))
    ) {
      return refs;
    }
    for await (const line of this.options.catalog.readBody(agent, sessionId)) {
      if (line.kind !== 'event') continue;
      for (const ref of line.images) refs.set(imageKey(line.event.eventId, ref.source, ref.index), ref);
    }
    return refs;
  }

  private async assetOnDisk(dir: string, agent: AgentId, sessionId: string, asset: string, bytes: number): Promise<boolean> {
    try {
      const info = await stat(assetFile(dir, agent, sessionId, asset));
      return info.isFile() && info.size === bytes;
    } catch {
      return false;
    }
  }

  private async runMeasure(): Promise<VaultMeasurement> {
    const startedAt = this.now();
    const rows = new Map<AgentId, VaultAgentMeasure>();
    const row = (agent: AgentId): VaultAgentMeasure => {
      let found = rows.get(agent);
      if (found === undefined) {
        found = emptyMeasure(agent);
        rows.set(agent, found);
      }
      return found;
    };

    const { candidates, archived, agents } = this.candidates();
    for (const agent of agents) row(agent);
    for (const [agent, count] of archived) row(agent).skippedArchived += count;
    this.setProgress(0, candidates.length, true);

    for (const [position, candidate] of candidates.entries()) {
      if (this.disposed) break;
      await this.measureOne(candidate, row(candidate.session.agent));
      this.setProgress(position + 1, candidates.length);
      await nextTurn();
    }

    let memoryProjects = 0;
    let memoryBytes = 0;
    for (const project of this.options.index.getProjects()) {
      if (!project.cwdExists || project.cwd.length === 0) continue;
      try {
        const memory = await measureProjectMemory(project.cwd);
        if (memory.files > 0) memoryProjects += 1;
        memoryBytes += memory.bytes;
      } catch {
        // Ilegible: no suma.
      }
    }

    const order = (agent: string): number => (SESSION_AGENT_IDS as readonly string[]).indexOf(agent);
    return {
      measuredAt: this.now(),
      durationMs: this.now() - startedAt,
      byAgent: [...rows.values()].sort((a, b) => order(a.agent) - order(b.agent)),
      memoryProjects,
      memoryBytes,
    };
  }

  private async measureOne(candidate: Candidate, row: VaultAgentMeasure): Promise<void> {
    const { session, history } = candidate;
    const failed = (reason: string): void => {
      row.failed += 1;
      addReason(row.failureReasons, reason);
    };
    if (history.wholeRead !== true) {
      row.unsupported += 1;
      return;
    }
    if (!isVaultSessionId(session.summary.sessionId)) {
      failed(UNSAFE_SESSION_ID);
      return;
    }
    try {
      const item = await history.item(session.ref);
      if (item === null) {
        failed(ORIGIN_NOT_FOUND);
        return;
      }
      if (this.options.catalog.hasForeignFormat(session.agent, session.summary.sessionId)) {
        failed(FOREIGN_FORMAT);
        return;
      }
      const read = await this.readSession(candidate, item, null);
      if (read.kind === 'not-found') {
        failed(ORIGIN_NOT_FOUND);
        return;
      }
      if (read.kind === 'empty') {
        row.skippedEmpty += 1;
        return;
      }
      row.sessions += 1;
      row.eventBytes += Buffer.byteLength(read.serialized.text, 'utf8');
      row.images += read.serialized.assets.size;
      for (const bytes of read.serialized.assets.values()) row.imageBytes += bytes.length;
    } catch (error) {
      failed(messageOf(error));
    }
  }

  /**
   * Borra los temporales propios de mas de una hora: los de un proceso que
   * murio entre escribir y renombrar. Solo con la forma de `temporaryPathFor`,
   * solo en las carpetas que escribe la copia, y a lo sumo una vez por hora.
   */
  private async sweepTemporaries(dir: string): Promise<void> {
    const now = this.now();
    if (this.lastSweepAt !== null && now - this.lastSweepAt < TEMP_MAX_AGE_MS) return;
    this.lastSweepAt = now;

    const folders = [dir];
    const subfolders = async (parent: string): Promise<string[]> => {
      try {
        return (await readdir(parent, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(parent, entry.name));
      } catch {
        return [];
      }
    };
    for (const agentDir of await subfolders(sessionsRoot(dir))) {
      if (!(SESSION_AGENT_IDS as readonly string[]).includes(path.basename(agentDir))) continue;
      folders.push(agentDir);
      folders.push(...(await subfolders(agentDir)).filter((folder) => folder.endsWith('.assets')));
    }
    folders.push(...(await subfolders(path.join(dir, 'memory'))));

    for (const folder of folders) {
      let names: string[];
      try {
        names = await readdir(folder);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!OWN_TEMP_FILE.test(name)) continue;
        const file = path.join(folder, name);
        try {
          const info = await stat(file);
          if (info.isFile() && now - info.mtimeMs > TEMP_MAX_AGE_MS) await rm(file, { force: true });
        } catch {
          // Ya no esta: lo borro quien lo creo.
        }
      }
    }
  }
}
