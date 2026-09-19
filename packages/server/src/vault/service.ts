/**
 * La copia propia vista desde el socket (hito 28, §10): el dueño de su estado.
 *
 * Junta lo que ya existe —el catalogo, el escritor, los ajustes y el indice— y
 * decide **cuando** pasa cada cosa. Ni lee formatos ni escribe sesiones: eso es
 * de `writer.ts`, `catalog.ts` y `write.ts`. Aca vive lo que el usuario pide
 * desde el dialogo (medir, encender, mudar, exportar, abrir) y el estado que se
 * le muestra.
 *
 * **Con la copia apagada no corre nada solo.** Ni pasadas, ni la huella de las
 * sesiones en cada emision del indice: lo unico que cuesta es cargar las
 * cabeceras de una carpeta que casi siempre esta vacia (regla de oro del hito).
 * Exportar a Markdown y abrir una fila "copia" funcionan igual, porque los pide
 * el usuario.
 *
 * Tres reglas:
 *
 *  - **El cliente no nombra rutas.** La carpeta nueva es donde esta parado un
 *    selector de este socket; una sesion se pide por `(agent, sessionId)` y un
 *    proyecto por su `key` (CLAUDE.md 2.4).
 *  - **Una pasada se pide solo si cambio algo nativo.** El indice reemite la
 *    barra tambien cuando la copia escribe (el catalogo avisa), y pedir una
 *    pasada por eso seria una vuelta de mas por cada pasada que escribe. Se
 *    compara una huella de las sesiones nativas y de lo archivado.
 *  - **El estado sale a lo sumo cada 500 ms.** Una pasada avisa al empezar, cada
 *    diez sesiones y al terminar; el ultimo estado siempre llega.
 */

import { mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  IMPORTED_AGENT_LABELS,
  ServerTextError,
  isImportedAgentId,
  normalizeCwdKey,
  serverText,
  type ServerText,
  type ConversationEvent,
  type GlobalSearchResult,
  type IndexStatus,
  type ProjectSummary,
  type SessionAgentId,
  type SessionSummary,
  type VaultBodyLine,
  type VaultHeader,
  type VaultMeasurement,
  type VaultState,
  type VaultStatus,
} from '@agent-workbench/shared';
import type { AgentRegistry } from '../agents/registry.js';
import { TRANSPORT_LIMITS, limitEvent } from '../agents/transport-limits.js';
import { runGlobalSearch, type GlobalSearchOptions, type SearchableSession } from '../global-search.js';
import type { ArchivedEvents } from '../handoff/handoff.js';
import { HANDOFF_MAX_EVENTS } from '../handoff/transcript.js';
import { revealPath } from '../reveal.js';
import type { SessionIndex } from '../session-index.js';
import type { SettingsStore } from '../settings-store.js';
import type { VaultCatalog } from './catalog.js';
import { renderProjectIndex, renderSessionMarkdown, formatFileDay, type ProjectIndexEntry } from './markdown.js';
import { canWriteInto, checkVaultTarget, moveVault } from './move.js';
import {
  defaultVaultDir,
  projectExportDirFor,
  sanitizeFileName,
  sessionExportFile,
  vaultMarkerFile,
} from './paths.js';
import { readWholeSession } from './read-session.js';
import { buildHeader } from './serialize.js';
import { DEFAULT_WRITE_DEPS, writeFileAtomic, type VaultWriteDeps } from './write.js';
import {
  VaultBusyError,
  VaultWriter,
  copyMatchesOrigin,
  enableRefusal,
  vaultEventLimits,
  type VaultWriterTimers,
} from './writer.js';

/** Minimo entre dos `vault.status`. */
export const STATUS_INTERVAL_MS = 500;

/** Un pedido que no se pudo cumplir. El texto va como clave: la frase la arma la web (§6.23). */
export class VaultError extends ServerTextError {}

const REAL_TIMERS: VaultWriterTimers = {
  set: (run, ms) => {
    const handle = setTimeout(run, ms);
    handle.unref();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Lo que el servicio usa del indice: el de la app es `SessionIndex`. */
export type VaultServiceIndex = Pick<SessionIndex, 'nativeSessions' | 'getProjects' | 'getStatus' | 'on' | 'off'>;

/** Un selector de carpetas del socket que pide la mudanza (`directory-picker.ts`). */
export interface VaultDirPicker {
  currentPath(pickerId: string): string | null;
}

export interface VaultServiceOptions {
  agents: Pick<AgentRegistry, 'adapter' | 'get' | 'protectedDirs'>;
  index: VaultServiceIndex;
  archived: { has(sessionId: string): boolean };
  settings: Pick<SettingsStore, 'get' | 'update'>;
  /** Ya cargado con la carpeta de los ajustes (C4). */
  catalog: VaultCatalog;
  platform: string;
  /** Donde busca `~/.gemini`, que tampoco se elige como carpeta de la copia. */
  homeDir?: string;
  /** Abre una ruta con la app del sistema. Inyectable para las pruebas. */
  reveal?: (absolutePath: string) => void;
  now?: () => number;
  timers?: VaultWriterTimers;
  writeDeps?: VaultWriteDeps;
  writerRevision?: number;
  log?: Pick<Console, 'warn'>;
}

export interface VaultExportResult {
  sessions: number;
  skipped: number;
  folder: string;
}

const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function busyText(error: VaultBusyError): ServerText {
  switch (error.activity) {
    case 'measuring':
      return serverText('vaultBusyMeasuring');
    case 'moving':
      return serverText('vaultBusyMoving');
    default:
      return serverText('vaultBusyWriting');
  }
}

async function collect(lines: AsyncIterable<VaultBodyLine>): Promise<VaultBodyLine[]> {
  const out: VaultBodyLine[] = [];
  for await (const line of lines) out.push(line);
  return out;
}

export class VaultService {
  readonly writer: VaultWriter;

  private readonly options: VaultServiceOptions;
  private readonly now: () => number;
  private readonly timers: VaultWriterTimers;
  private readonly writeDeps: VaultWriteDeps;
  private readonly openWithSystem: (absolutePath: string) => void;
  private readonly log: Pick<Console, 'warn'>;

  private previousDir: string | null = null;
  /** Huella de las sesiones nativas y lo archivado en la ultima emision mirada. null: sin mirar (apagada). */
  private nativeSignature: string | null = null;
  /** true hasta la primera vez que el indice llega a `ready` con la copia encendida. */
  private passOnReady = true;

  private readonly statusListeners = new Set<(status: VaultStatus) => void>();
  private statusTimer: unknown = null;
  private lastStatusAt = Number.NEGATIVE_INFINITY;
  private readonly stops: Array<() => void> = [];
  private started = false;
  private disposed = false;

  constructor(options: VaultServiceOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? REAL_TIMERS;
    this.writeDeps = options.writeDeps ?? DEFAULT_WRITE_DEPS;
    this.openWithSystem = options.reveal ?? revealPath;
    this.log = options.log ?? console;
    this.writer = new VaultWriter({
      index: options.index,
      agents: options.agents,
      archived: options.archived,
      settings: options.settings,
      catalog: options.catalog,
      platform: options.platform,
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.timers !== undefined ? { timers: options.timers } : {}),
      ...(options.writeDeps !== undefined ? { writeDeps: options.writeDeps } : {}),
      ...(options.writerRevision !== undefined ? { writerRevision: options.writerRevision } : {}),
      ...(options.log !== undefined ? { log: options.log } : {}),
    });
  }

  /**
   * Engancha los oyentes. No escribe nada ni carga el catalogo (ya viene
   * cargado): la primera pasada espera a que el indice este listo.
   */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const { index, catalog } = this.options;

    const onStatus = (status: IndexStatus): void => this.onIndexStatus(status);
    const onProjects = (_projects: ProjectSummary[], replace: boolean): void => this.onIndexProjects(replace);
    index.on('status', onStatus);
    index.on('projects', onProjects);
    this.stops.push(() => {
      index.off('status', onStatus);
      index.off('projects', onProjects);
    });
    this.stops.push(this.writer.onChange(() => this.scheduleStatus()));
    this.stops.push(catalog.onChange(() => this.scheduleStatus()));

    // Si el indice ya estaba listo (un servicio que arranca tarde), cuenta como la primera vez.
    if (index.getStatus().state === 'ready') this.onIndexStatus(index.getStatus());
  }

  /** Cancela temporizadores y suelta oyentes. No espera la pasada en curso. */
  dispose(): void {
    this.disposed = true;
    for (const stop of this.stops.splice(0)) stop();
    if (this.statusTimer !== null) this.timers.clear(this.statusTimer);
    this.statusTimer = null;
    this.statusListeners.clear();
    this.writer.dispose();
  }

  /** La carpeta de la copia: la de los ajustes o la de por defecto. */
  dir(): string {
    return this.options.settings.get().vault.dir ?? defaultVaultDir();
  }

  status(): VaultStatus {
    const settings = this.options.settings.get().vault;
    const snapshot = this.writer.snapshot();
    const stats = this.options.catalog.stats();
    const state: VaultState = snapshot.activity !== 'idle' ? snapshot.activity : settings.enabled ? 'idle' : 'off';
    return {
      enabled: settings.enabled,
      dir: this.dir(),
      isDefaultDir: settings.dir === null,
      state,
      progress: snapshot.progress,
      sessions: stats.sessions,
      passSessions: stats.passSessions,
      bytes: stats.bytes,
      lastPassAt: snapshot.lastPassAt,
      pending: snapshot.pending,
      measurement: snapshot.measurement,
      previousDir: this.previousDir,
      lastError: snapshot.lastError,
    };
  }

  /** Avisa cada cambio de estado, con `STATUS_INTERVAL_MS` de minimo entre dos. */
  onStatus(listener: (status: VaultStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  // ---- Pedidos del dialogo ---------------------------------------------------

  /** La pasada en seco (§7.4). Lanza `VaultError` si hay algo en curso o el indice no termino. */
  async measure(): Promise<VaultMeasurement> {
    if (this.options.index.getStatus().state !== 'ready') {
      throw new VaultError(serverText('vaultIndexNotReady'));
    }
    try {
      return await this.writer.measure();
    } catch (error) {
      if (error instanceof VaultBusyError) throw new VaultError(busyText(error));
      throw error;
    }
  }

  /**
   * Enciende o apaga la copia. Encender sin medicion en este proceso se rechaza
   * salvo que la carpeta ya tenga sesiones que escribio una pasada (C18,
   * `enableRefusal`); apagar no se rechaza nunca y no borra nada.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      const refusal = enableRefusal(this.writer.snapshot().measurement !== null, this.options.catalog.stats().passSessions);
      if (refusal !== null) throw new VaultError(refusal);
    }
    await this.options.settings.update({ vault: { enabled } });
    this.nativeSignature = null;
    this.scheduleStatus();
    if (!enabled) return;

    if (this.options.index.getStatus().state === 'ready') {
      this.passOnReady = false;
      this.nativeSignature = this.signature();
      void this.writer.pass();
    } else {
      // La primera pasada, cuando el indice termine: antes veria media barra.
      this.passOnReady = true;
    }
  }

  /** Muda la copia a donde esta parado un selector de carpetas de quien la pide. */
  async setDirFromPicker(pickers: VaultDirPicker, pickerId: string): Promise<void> {
    const target = pickers.currentPath(pickerId);
    if (target === null) throw new VaultError(serverText('pickerClosed'));
    await this.setDir(target);
  }

  /**
   * Muda la copia a `target` (D12): copia sin pisar, cambia el ajuste y carga
   * el catalogo de la carpeta nueva. La vieja queda intacta y `previousDir` lo
   * dice. Si ya es la carpeta actual, no hace nada.
   */
  async setDir(target: string): Promise<void> {
    const { platform, agents, settings, catalog } = this.options;
    const current = this.dir();
    const protectedDirs = [...agents.protectedDirs(), path.join(this.options.homeDir ?? homedir(), '.gemini')];
    const check = checkVaultTarget(current, target, { protectedDirs, platform });
    if (check.kind === 'refused') throw new VaultError(check.text);
    if (check.kind === 'same') return;

    try {
      await this.writer.exclusive('moving', async () => {
        if (!(await canWriteInto(target))) throw new VaultError(serverText('vaultCannotWrite'));
        const hadCopy = await stat(vaultMarkerFile(current)).then(
          () => true,
          () => false,
        );
        if (hadCopy) await moveVault(current, target);
        const isDefault = normalizeCwdKey(target, platform) === normalizeCwdKey(defaultVaultDir(), platform);
        await settings.update({ vault: { dir: isDefault ? null : target } });
        this.previousDir = hadCopy ? current : null;
        await catalog.load(this.dir());
      });
    } catch (error) {
      if (error instanceof VaultBusyError) throw new VaultError(busyText(error));
      if (error instanceof VaultError) throw error;
      throw new VaultError(serverText('vaultMoveFailed', { detail: messageOf(error) }));
    } finally {
      this.scheduleStatus();
    }
    // Lo que la carpeta nueva no tenga lo completa la pasada siguiente.
    this.writer.requestPass();
  }

  /** Relee el catalogo de la carpeta configurada (⟳ Reindexar). */
  async reload(): Promise<void> {
    if (this.writer.snapshot().activity === 'moving') return;
    await this.options.catalog.load(this.dir());
  }

  /**
   * La carpeta con la que se trabaja: la que tiene cargada el catalogo. Es la
   * de los ajustes salvo durante una mudanza, que no deja abrir ni exportar.
   */
  private activeDir(): string {
    return this.options.catalog.getDir() ?? this.dir();
  }

  /** Abre la carpeta de la copia con el explorador del sistema. */
  async reveal(): Promise<void> {
    const dir = this.activeDir();
    const isFolder = await stat(dir).then(
      (info) => info.isDirectory(),
      () => false,
    );
    if (!isFolder) throw new VaultError(serverText('vaultNoCopyYet'));
    this.openWithSystem(dir);
  }

  /**
   * Una fila "copia" en Markdown (§8.2): se busca en el catalogo por id —nunca
   * por ruta—, se escribe en `export/sesiones/` y se abre.
   */
  async openSession(agent: SessionAgentId, sessionId: string): Promise<string> {
    this.refuseWhileMoving();
    const { catalog } = this.options;
    const header = catalog.header(agent, sessionId);
    if (header === null) throw new VaultError(serverText('vaultSessionMissing'));
    const dir = this.activeDir();

    const lines = await collect(catalog.readBody(agent, sessionId));
    const text = renderSessionMarkdown(header, lines, {
      agentLabel: this.labelOf(agent),
      assetLink: (asset) => `../../sessions/${agent}/${sessionId}.assets/${asset}`,
      fromCopy: true,
    });
    const file = sessionExportFile(dir, agent, sessionId);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFileAtomic(file, text, this.writeDeps);
    this.openWithSystem(file);
    return file;
  }

  /**
   * Los eventos de una sesion para continuarla en otra CLI (hito 29, D15), o
   * null si la copia no la tiene o no conviene leerla de ahi.
   *
   * La copia sirve cuando es lo que hay —una fila que solo esta en la copia, o
   * una importada— y cuando esta al dia con su historial nativo (la huella de
   * §13.5, como al exportar). Una nativa cuya copia quedo atras da null: la
   * copia llega despues de 60 s de calma y solo encendida, y lo que se pierde
   * con una copia vieja son justo los ultimos turnos, que es lo que la otra CLI
   * necesita. Ahi lee el seguidor nativo.
   *
   * Se quedan los ultimos `maxEvents`, recortados a los topes de transporte: una
   * sesion de la copia trae los textos enteros y puede pesar decenas de MB, y el
   * transcript corta mas abajo que eso.
   */
  async handoffEvents(agent: SessionAgentId, sessionId: string, maxEvents = HANDOFF_MAX_EVENTS): Promise<ArchivedEvents | null> {
    const { catalog, index, agents } = this.options;
    if (this.writer.snapshot().activity === 'moving') return null;
    const header = catalog.header(agent, sessionId);
    if (header === null) return null;

    const native = index.nativeSessions().find((session) => session.agent === agent && session.summary.sessionId === sessionId);
    if (native !== undefined) {
      const item = await agents
        .adapter(native.agent)
        .history.item(native.ref)
        .catch(() => null);
      // Sin origen en disco, la copia es lo que queda; con origen, solo si esta al dia.
      if (item !== null && !copyMatchesOrigin(header, item, this.writer.getRevision())) return null;
    }

    const cap = Math.max(1, Math.floor(maxEvents));
    let kept: ConversationEvent[] = [];
    let total = 0;
    for await (const line of catalog.readBody(agent, sessionId)) {
      if (line.kind !== 'event') continue;
      total += 1;
      kept.push(limitEvent(line.event, TRANSPORT_LIMITS));
      // De a tandas y no un `shift` por evento: una sesion de cien mil eventos no cuesta cuadratico.
      if (kept.length >= cap * 2) kept = kept.slice(-cap);
    }
    return { events: kept.slice(-cap), partial: header.partial, complete: total <= cap };
  }

  /**
   * Busca en el texto de las conversaciones de la copia (hito 29, D22).
   *
   * **Solo la copia**, con lo que tenga: encendida, lo nuevo llega despues de
   * su minuto de calma; apagada, se busca en lo que guardo mientras estuvo
   * encendida o en lo importado. No escribe nada y no lee ningun historial
   * nativo. Todas las sesiones del catalogo, tambien las que tienen su nativa:
   * la barra las muestra una sola vez y el acierto lleva el par para encontrar
   * la fila. Se rechaza durante una mudanza, como abrir o exportar.
   */
  async search(query: string, options: GlobalSearchOptions): Promise<GlobalSearchResult> {
    this.refuseWhileMoving();
    const { catalog } = this.options;
    return runGlobalSearch(
      {
        sessions: () => this.searchableSessions(),
        readLines: (session) => catalog.bodyLines(session.agent, session.sessionId),
        ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      },
      query,
      options,
    );
  }

  /** Las sesiones de la copia con lo que el buscador necesita, archivadas marcadas como en la barra. */
  private searchableSessions(): SearchableSession[] {
    const { catalog, archived } = this.options;
    return catalog.summaries().map((summary) => ({
      agent: summary.agent,
      sessionId: summary.sessionId,
      cwd: summary.cwd,
      title: summary.title,
      updatedAt: summary.updatedAt,
      archived: archived.has(summary.sessionId),
    }));
  }

  /**
   * Exporta un proyecto de la barra a Markdown (§8.3): nativas y "copia",
   * archivadas incluidas —exportar es explicito—. Cada sesion sale de la copia
   * si la tiene al dia; si no, se lee del historial con los topes de la copia,
   * sin imagenes y **sin escribir la copia**. Funciona con la copia apagada.
   */
  async exportProject(projectKey: string): Promise<VaultExportResult> {
    this.refuseWhileMoving();
    const project = this.options.index.getProjects().find((candidate) => candidate.key === projectKey);
    if (project === undefined) throw new VaultError(serverText('vaultProjectGone'));

    const folder = projectExportDirFor(this.activeDir(), project, this.options.platform);
    await mkdir(folder, { recursive: true });

    const entries: ProjectIndexEntry[] = [];
    const names = new Set<string>();
    let skipped = 0;
    for (const summary of project.sessions) {
      let text: string | null;
      try {
        text = await this.renderForExport(summary);
      } catch (error) {
        this.log.warn(`[vault] couldn't export ${summary.agent}/${summary.sessionId}: ${messageOf(error)}`);
        text = null;
      }
      if (text === null) {
        skipped += 1;
        continue;
      }
      const fileName = this.exportFileName(summary, names);
      await writeFileAtomic(path.join(folder, fileName), text, this.writeDeps);
      entries.push({
        updatedAt: summary.updatedAt,
        agentLabel: this.labelOf(summary.agent),
        title: summary.title,
        fileName,
        onlyInCopy: summary.storage === 'vault',
        partial: summary.partial,
      });
      await nextTurn();
    }

    const name = project.cwd.length > 0 ? path.basename(project.cwd) || project.cwd : project.fallbackName;
    const index = renderProjectIndex({ name, cwd: project.cwd, exportedAt: this.now(), entries, skipped });
    await writeFileAtomic(path.join(folder, 'index.md'), index, this.writeDeps);
    this.openWithSystem(folder);
    return { sessions: entries.length, skipped, folder };
  }

  // ---- Internos ---------------------------------------------------------------

  private refuseWhileMoving(): void {
    if (this.writer.snapshot().activity === 'moving') {
      throw new VaultError(serverText('vaultMoving'));
    }
  }

  private labelOf(agent: SessionAgentId): string {
    if (isImportedAgentId(agent)) return IMPORTED_AGENT_LABELS[agent];
    return this.options.agents.get(agent)?.adapter.label ?? agent;
  }

  /** `<aaaa-mm-dd> <titulo saneado> [<agent>] <id8>.md`, sin repetir dentro de la misma exportacion. */
  private exportFileName(summary: SessionSummary, taken: Set<string>): string {
    const base = `${formatFileDay(summary.updatedAt)} ${sanitizeFileName(summary.title, 60)} [${summary.agent}] ${sanitizeFileName(summary.sessionId.slice(0, 8), 8)}`;
    let name = `${base}.md`;
    for (let copy = 2; taken.has(name.toLowerCase()); copy += 1) name = `${base} ${copy}.md`;
    taken.add(name.toLowerCase());
    return name;
  }

  /** El Markdown de una sesion para exportar, o null si no hay de donde leerla. */
  private async renderForExport(summary: SessionSummary): Promise<string | null> {
    const { agents, catalog } = this.options;
    const { agent, sessionId } = summary;
    const assetLink = (asset: string): string => `../../sessions/${agent}/${sessionId}.assets/${asset}`;
    const fromCopy = async (header: VaultHeader): Promise<string> =>
      renderSessionMarkdown(header, await collect(catalog.readBody(agent, sessionId)), {
        agentLabel: this.labelOf(agent),
        assetLink,
        fromCopy: true,
      });

    if (summary.storage === 'vault' || isImportedAgentId(agent)) {
      const header = catalog.header(agent, sessionId);
      return header === null ? null : fromCopy(header);
    }

    const native = this.options.index
      .nativeSessions()
      .find((session) => session.agent === agent && session.summary.sessionId === sessionId);
    if (native === undefined) return null;
    const history = agents.adapter(native.agent).history;

    const item = await history.item(native.ref);
    const header = catalog.header(agent, sessionId);
    if (item !== null && copyMatchesOrigin(header, item, this.writer.getRevision()) && header !== null) {
      return fromCopy(header);
    }
    if (history.wholeRead !== true) return null;

    const limits = vaultEventLimits(this.options.settings.get().vault.toolResultMaxChars);
    const whole = await readWholeSession(history, { cwd: summary.cwd, sessionId }, limits);
    if (whole === null || whole.events.length === 0) return null;

    const live = buildHeader({
      agent,
      sessionId,
      cwd: native.cwd ?? '',
      group: native.cwd === null ? native.group : null,
      title: summary.title,
      titleSource: summary.titleSource,
      createdAt: null,
      updatedAt: summary.updatedAt,
      cliVersionAtCopy: agents.get(native.agent)?.location?.version ?? null,
      partial: false,
      stepCount: null,
      usage: whole.usage,
      source: {
        kind: 'native',
        mtimeMs: item?.mtimeMs ?? summary.updatedAt,
        sizeBytes: item?.sizeBytes ?? summary.sizeBytes,
        writerRevision: this.writer.getRevision(),
      },
      writtenAt: this.now(),
      eventCount: whole.events.length,
      documentCount: 0,
      imageCount: 0,
    });
    // Sin imagenes: leerlas es lo caro, y exportar no escribe la copia.
    const lines: VaultBodyLine[] = whole.events.map((event) => ({
      kind: 'event',
      event,
      images: event.parts.flatMap((part) =>
        part.kind === 'image' ? [{ index: part.index, source: part.source, mediaType: part.mediaType, asset: null, bytes: 0 }] : [],
      ),
    }));
    return renderSessionMarkdown(live, lines, { agentLabel: this.labelOf(agent), assetLink, fromCopy: false });
  }

  private onIndexStatus(status: IndexStatus): void {
    if (this.disposed || status.state !== 'ready' || !this.passOnReady) return;
    if (!this.options.settings.get().vault.enabled) return;
    this.passOnReady = false;
    this.nativeSignature = this.signature();
    void this.writer.pass();
  }

  private onIndexProjects(replace: boolean): void {
    if (this.disposed || !replace || this.passOnReady) return;
    if (this.options.index.getStatus().state !== 'ready') return;
    if (!this.options.settings.get().vault.enabled) {
      this.nativeSignature = null;
      return;
    }
    const signature = this.signature();
    if (signature === this.nativeSignature) return;
    this.nativeSignature = signature;
    this.writer.requestPass();
  }

  /** Lo que decide si hay algo nativo nuevo que copiar: cada sesion, su fecha, su tamano y si esta archivada. */
  private signature(): string {
    const parts: string[] = [];
    for (const session of this.options.index.nativeSessions()) {
      const { sessionId, updatedAt, sizeBytes } = session.summary;
      parts.push(`${session.agent}/${sessionId}/${updatedAt}/${sizeBytes}/${this.options.archived.has(sessionId) ? 1 : 0}`);
    }
    return parts.join('\n');
  }

  private scheduleStatus(): void {
    if (this.disposed || this.statusTimer !== null) return;
    const wait = this.lastStatusAt + STATUS_INTERVAL_MS - this.now();
    if (wait <= 0) {
      this.emitStatus();
      return;
    }
    this.statusTimer = this.timers.set(() => {
      this.statusTimer = null;
      this.emitStatus();
    }, wait);
  }

  private emitStatus(): void {
    if (this.disposed) return;
    this.lastStatusAt = this.now();
    const status = this.status();
    for (const listener of [...this.statusListeners]) {
      try {
        listener(status);
      } catch (error) {
        this.log.warn('[vault] a status listener threw:', error);
      }
    }
  }
}
