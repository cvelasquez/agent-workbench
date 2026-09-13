/**
 * Indice de proyectos y sesiones del historial de todas las CLIs registradas.
 *
 * Generico: que archivos hay, como se leen y que se aprende al leerlos lo dice
 * la fuente de historial de cada adaptador (`HistorySource`). Aca se decide lo
 * que es de la barra lateral: agrupar en proyectos, cachear y emitir.
 *
 * Tres cosas que aprendimos midiendo la instalacion real y que explican el
 * diseno de este archivo (detalle en CLAUDE.md 4.6 y 4.7):
 *
 *  1. Indexar 228 archivos en frio cuesta 3,2 s. No puede bloquear el arranque:
 *     corre en segundo plano y emite a medida que termina cada grupo.
 *  2. Hay lineas de 290 KB, asi que la lectura es por lineas y no por bloques
 *     de bytes fijos (ver jsonl-reader.ts).
 *  3. 222 de 228 sesiones no tienen titulo propio. El fallback al primer
 *     mensaje del usuario es el caso normal, no la excepcion, y por eso se
 *     limpia con cuidado.
 *
 * **Un proyecto es un `cwd`, no una carpeta del historial.** La carpeta donde
 * una CLI guarda sus archivos NO se puede revertir a una ruta (CLAUDE.md 4.1), y
 * cada CLI la nombra a su manera: lo que junta sesiones de CLIs distintas en la
 * misma fila es el `cwd` que traen, normalizado con `normalizeCwdKey`. La
 * carpeta nativa (`group`) queda solo como respaldo para una sesion que no trae
 * `cwd`.
 */

import { EventEmitter } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AGENT_IDS,
  asFiniteNumber,
  asLiteral,
  asNonEmptyString,
  asRecord,
  asString,
  asStringArray,
  normalizeCwdKey,
  parseSessionSummary,
  type AgentId,
  type IndexStatus,
  type ProjectSummary,
  type SessionSummary,
} from '@agent-workbench/shared';
import type {
  HistoryExtra,
  HistoryItem,
  HistorySource,
  ScannedSummary,
} from './agents/adapter.js';
import type { AgentRegistry } from './agents/registry.js';
import type { ArchivedSessions } from './archived-sessions.js';
import { appConfigDir, sessionIndexCachePath } from './paths.js';

/**
 * Sube cuando cambia la forma de la cache. La v3 agrego `modelIds`; la v4 la
 * hace de todas las CLIs: cada entrada dice de cual es, y lo que la CLI aprende
 * al leer un archivo viaja en `extra`, sin que el indice sepa que es.
 */
const CACHE_VERSION = 4;

export interface CacheEntryV4 {
  agent: AgentId;
  /** Opaca: la da la fuente de historial. Con Claude Code, la ruta del `.jsonl`. */
  ref: string;
  group: string;
  mtimeMs: number;
  sizeBytes: number;
  /** `''` si el archivo no trae. */
  cwd: string;
  /**
   * Con que `cwd` se reanuda, si no es `cwd` (ver `ScannedSession.resumeCwd`).
   * Opcional sin subir la version: una entrada que no lo trae es una en la que
   * los dos coinciden, que es lo que decian todas las de antes.
   */
  resumeCwd?: string;
  summary: ScannedSummary;
  /**
   * Lo que la CLI aprendio al leer el archivo y tiene que recuperar al salir de
   * la cache. Con Claude Code, los ids de modelo de `cost-state` —la unica
   * parte del archivo que trae el sufijo `[1m]`—: sin ellos, un arranque en
   * caliente dejaria al medidor suponiendo 200k en una sesion de 1M.
   */
  extra: HistoryExtra;
}

export interface CacheFileV4 {
  version: typeof CACHE_VERSION;
  /** Clave `${agent}:${ref}`. */
  entries: Record<string, CacheEntryV4>;
}

/** Una sesion ya leida, tal como la guarda el indice entre emisiones. */
export interface IndexedSession {
  agent: AgentId;
  ref: string;
  group: string;
  /** El `cwd` del archivo, o null si no trae. Es la clave del proyecto. */
  cwd: string | null;
  /**
   * Completo: con `agent`, `cwd` y `archived` en false (lo marca `withArchived`).
   * Su `cwd` es el de reanudar, que puede no ser el de arriba.
   */
  summary: SessionSummary;
}

export interface SessionIndexEvents {
  status: (status: IndexStatus) => void;
  projects: (projects: ProjectSummary[], replace: boolean) => void;
}

function cacheKey(agent: AgentId, ref: string): string {
  return `${agent}:${ref}`;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * El resumen guardado, validado. La cache es JSON de disco: una entrada que no
 * tiene la forma esperada se descarta y ese archivo se vuelve a leer.
 */
function parseScannedSummary(value: unknown): ScannedSummary | null {
  const parsed = parseSessionSummary(value);
  if (parsed === null) return null;
  const { sessionId, title, titleSource, updatedAt, sizeBytes } = parsed;
  return { sessionId, title, titleSource, updatedAt, sizeBytes };
}

function parseEntryV4(value: unknown): CacheEntryV4 | null {
  const record = asRecord(value);
  if (record === null) return null;
  const agent = asLiteral(record['agent'], AGENT_IDS);
  const ref = asNonEmptyString(record['ref']);
  const group = asString(record['group']);
  const mtimeMs = asFiniteNumber(record['mtimeMs']);
  const sizeBytes = asFiniteNumber(record['sizeBytes']);
  const cwd = asString(record['cwd']);
  const resumeCwd = record['resumeCwd'] === undefined ? undefined : asNonEmptyString(record['resumeCwd']);
  const summary = parseScannedSummary(record['summary']);
  const extra = asRecord(record['extra']);
  if (
    agent === null ||
    ref === null ||
    group === null ||
    mtimeMs === null ||
    sizeBytes === null ||
    cwd === null ||
    resumeCwd === null ||
    summary === null ||
    extra === null
  ) {
    return null;
  }
  return {
    agent,
    ref,
    group,
    mtimeMs,
    sizeBytes,
    cwd,
    ...(resumeCwd !== undefined ? { resumeCwd } : {}),
    summary,
    extra,
  };
}

/**
 * Una entrada de la v3: clave = ruta del `.jsonl`, y todo era de Claude Code.
 * La carpeta del archivo es el grupo, igual que la que da hoy su fuente.
 */
function migrateEntryV3(filePath: string, value: unknown): CacheEntryV4 | null {
  const record = asRecord(value);
  if (record === null || filePath.length === 0) return null;
  const mtimeMs = asFiniteNumber(record['mtimeMs']);
  const sizeBytes = asFiniteNumber(record['sizeBytes']);
  const cwd = asString(record['cwd']);
  const summary = parseScannedSummary(record['summary']);
  if (mtimeMs === null || sizeBytes === null || cwd === null || summary === null) return null;
  return {
    agent: 'claude-code',
    ref: filePath,
    group: path.basename(path.dirname(filePath)),
    mtimeMs,
    sizeBytes,
    cwd,
    summary,
    extra: { modelIds: asStringArray(record['modelIds']) ?? [] },
  };
}

/**
 * La cache leida de disco, llevada a la version actual. Pura: la prueba el
 * chequeo.
 *
 * La v3 se **migra** en vez de tirarse: reindexar en frio son 3,2 s, y mientras
 * duran el medidor no sabe que la instalacion corre en 1M. Cualquier otra
 * version da null y se reindexa, que es lo que hacia siempre.
 */
export function migrateIndexCache(parsed: unknown): CacheFileV4 | null {
  const record = asRecord(parsed);
  if (record === null) return null;
  const entries = asRecord(record['entries']);
  if (entries === null) return null;

  const result: Record<string, CacheEntryV4> = {};
  if (record['version'] === CACHE_VERSION) {
    for (const [key, value] of Object.entries(entries)) {
      const entry = parseEntryV4(value);
      if (entry !== null && key === cacheKey(entry.agent, entry.ref)) result[key] = entry;
    }
    return { version: CACHE_VERSION, entries: result };
  }
  if (record['version'] === 3) {
    for (const [filePath, value] of Object.entries(entries)) {
      const entry = migrateEntryV3(filePath, value);
      if (entry !== null) result[cacheKey(entry.agent, entry.ref)] = entry;
    }
    return { version: CACHE_VERSION, entries: result };
  }
  return null;
}

/**
 * Agrupa las sesiones en proyectos. Pura, sin disco: la prueba el chequeo.
 *
 *  1. Cada grupo nativo (`agent` + `group`) aporta el **primer** `cwd` no vacio
 *     de sus sesiones: es el respaldo de las que no traen.
 *  2. La clave del proyecto es el `cwd` efectivo normalizado. Sin ninguno,
 *     `unknown:<agent>:<grupo>`, para que dos grupos sin `cwd` no se junten.
 *     El primero que llega a un proyecto fija el `cwd` que se muestra.
 *  3. Las sesiones de cada proyecto, de la mas reciente a la mas vieja. Los
 *     proyectos, en el orden en que aparecieron.
 */
export function buildProjects(
  sessions: Iterable<IndexedSession>,
  platform: string,
): Array<Omit<ProjectSummary, 'cwdExists'>> {
  const all = [...sessions];

  const groupCwd = new Map<string, string>();
  for (const session of all) {
    const group = `${session.agent}:${session.group}`;
    if (session.cwd !== null && session.cwd.length > 0 && !groupCwd.has(group)) {
      groupCwd.set(group, session.cwd);
    }
  }

  const projects = new Map<string, Omit<ProjectSummary, 'cwdExists'>>();
  for (const session of all) {
    const own = session.cwd !== null && session.cwd.length > 0 ? session.cwd : null;
    const effective = own ?? groupCwd.get(`${session.agent}:${session.group}`) ?? '';
    const key =
      effective.length > 0
        ? normalizeCwdKey(effective, platform)
        : `unknown:${session.agent}:${session.group}`;

    let project = projects.get(key);
    if (project === undefined) {
      // Sin cwd no podemos abrir pestanas ahi, pero igual se lista: ocultarlo
      // seria peor que mostrarlo marcado.
      project = {
        key,
        fallbackName: effective.length === 0 ? session.group : '',
        cwd: effective,
        sessions: [],
        lastActivityAt: 0,
      };
      projects.set(key, project);
    }
    project.sessions.push(session.summary);
    project.lastActivityAt = Math.max(project.lastActivityAt, session.summary.updatedAt);
  }

  for (const project of projects.values()) {
    project.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  return [...projects.values()];
}

/** Los items de una fuente, agrupados por `group` en el orden en que aparecen. */
function groupInOrder(items: readonly HistoryItem[]): HistoryItem[][] {
  const groups = new Map<string, HistoryItem[]>();
  for (const item of items) {
    const group = groups.get(item.group);
    if (group === undefined) groups.set(item.group, [item]);
    else group.push(item);
  }
  return [...groups.values()];
}

export declare interface SessionIndex {
  on<E extends keyof SessionIndexEvents>(event: E, listener: SessionIndexEvents[E]): this;
  emit<E extends keyof SessionIndexEvents>(
    event: E,
    ...args: Parameters<SessionIndexEvents[E]>
  ): boolean;
}

export class SessionIndex extends EventEmitter {
  private cache: CacheFileV4 = { version: CACHE_VERSION, entries: {} };

  /**
   * Las sesiones leidas, con clave `${agent}:${ref}`. El orden de insercion
   * importa: el primer `cwd` visto de un proyecto es el que se muestra.
   */
  private readonly sessions = new Map<string, IndexedSession>();

  /**
   * Si existe cada `cwd` en disco. Se guarda aparte para que `getProjects()`
   * siga siendo sincrono, y se llena **antes** de que la sesion entre a
   * `sessions`: si no, un proyecto que existe se veria tachado un instante.
   */
  private readonly cwdExists = new Map<string, boolean>();

  constructor(
    private readonly agents: AgentRegistry,
    /**
     * Que sesiones estan escondidas de la barra lateral.
     *
     * Se pregunta al emitir y no se guarda en la cache del indice: archivar es
     * una preferencia del usuario y la cache se invalida por `mtime` del
     * archivo, que no cambia al archivar. Mezclarlas haria que archivar
     * sobreviviera o se perdiera segun cuando se toco el archivo.
     */
    private readonly archived?: ArchivedSessions,
  ) {
    super();
  }

  private status: IndexStatus = { state: 'idle', scannedFiles: 0, totalFiles: 0 };
  private scanning = false;
  private rescanQueued = false;
  private cacheDirty = false;

  getProjects(): ProjectSummary[] {
    return buildProjects(this.sessions.values(), process.platform)
      .map((project) => this.finish(project))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * De que CLI es una sesion del historial, o null si el indice no la conoce.
   *
   * Decide con que CLI se reanuda: una sesion es de la CLI que la escribio, y
   * lanzar otra con su id no la encuentra.
   */
  agentOf(sessionId: string): AgentId | null {
    for (const session of this.sessions.values()) {
      if (session.summary.sessionId === sessionId) return session.agent;
    }
    return null;
  }

  /** Completa un proyecto armado para salir: si su carpeta existe, y que esta archivado. */
  private finish(project: Omit<ProjectSummary, 'cwdExists'>): ProjectSummary {
    return this.withArchived({
      ...project,
      cwdExists: project.cwd.length > 0 ? (this.cwdExists.get(project.cwd) ?? false) : false,
    });
  }

  /**
   * Marca cuales de las sesiones estan archivadas.
   *
   * Se marca en vez de filtrar: el cliente necesita saber cuantas hay
   * escondidas para ofrecer verlas, y filtrar aca obligaria a una peticion
   * aparte para lo mismo. Es el unico punto por donde salen los proyectos, asi
   * que la marca no se puede olvidar en un camino.
   */
  private withArchived(project: ProjectSummary): ProjectSummary {
    if (this.archived === undefined) return project;
    return {
      ...project,
      sessions: project.sessions.map((session) => ({
        ...session,
        archived: this.archived?.has(session.sessionId) ?? false,
      })),
    };
  }

  /** Reemite todo. Lo llama el socket cuando cambia que esta archivado. */
  refresh(): void {
    this.emit('projects', this.getProjects(), true);
  }

  getStatus(): IndexStatus {
    return this.status;
  }

  /** Carga la cache y lanza el primer escaneo sin esperarlo. */
  async start(): Promise<void> {
    await this.loadCache();
    void this.scan();
  }

  private setStatus(next: IndexStatus): void {
    this.status = next;
    this.emit('status', next);
  }

  private async loadCache(): Promise<void> {
    try {
      const raw = await readFile(sessionIndexCachePath(), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      const migrated = migrateIndexCache(parsed);
      if (migrated === null) return;
      this.cache = migrated;
      // Una cache de la version anterior se reescribe en la actual al terminar
      // el escaneo, aunque ningun archivo haya cambiado.
      if (asRecord(parsed)?.['version'] !== CACHE_VERSION) this.cacheDirty = true;
    } catch {
      // Sin cache se reindexa entero. No es un error.
    }
  }

  private async saveCache(): Promise<void> {
    if (!this.cacheDirty) return;
    this.cacheDirty = false;
    try {
      await mkdir(appConfigDir(), { recursive: true });
      await writeFile(sessionIndexCachePath(), JSON.stringify(this.cache), 'utf8');
    } catch (error) {
      console.warn('[indice] no se pudo guardar la cache:', error);
    }
  }

  /**
   * Escaneo completo. Reentrante: si llega otro pedido mientras corre, se
   * encola uno solo al final en vez de lanzar escaneos en paralelo.
   */
  async scan(): Promise<void> {
    if (this.scanning) {
      this.rescanQueued = true;
      return;
    }
    this.scanning = true;

    try {
      const sources = this.agents.all().map(({ adapter }) => ({
        agent: adapter.id,
        history: adapter.history,
      }));
      // Conteo previo para poder mostrar progreso real.
      const lists = await Promise.all(sources.map((source) => source.history.list()));

      if (lists.every((items) => items === null)) {
        this.sessions.clear();
        this.cwdExists.clear();
        this.setStatus({ state: 'ready', scannedFiles: 0, totalFiles: 0 });
        this.emit('projects', [], true);
        return;
      }

      const totalFiles = lists.reduce((total, items) => total + (items?.length ?? 0), 0);
      // Las dos juntas: una sesion sin su `cwdExists` se veria tachada.
      this.sessions.clear();
      this.cwdExists.clear();
      let scanned = 0;
      this.setStatus({ state: 'scanning', scannedFiles: 0, totalFiles });

      for (const [position, source] of sources.entries()) {
        const items = lists[position];
        if (items === null || items === undefined) continue;

        for (const group of groupInOrder(items)) {
          const batch: IndexedSession[] = [];
          for (const item of group) {
            const indexed = await this.read(source.agent, source.history, item);
            if (indexed !== null) batch.push(indexed);
            scanned += 1;
            // Progreso cada 10 archivos: suficiente para la barra, sin inundar el socket.
            if (scanned % 10 === 0) {
              this.setStatus({ state: 'scanning', scannedFiles: scanned, totalFiles });
            }
          }
          if (batch.length === 0) continue;

          // Una vez por `cwd` distinto, y antes de que la sesion sea visible.
          for (const session of batch) {
            if (session.cwd !== null && !this.cwdExists.has(session.cwd)) {
              this.cwdExists.set(session.cwd, await pathExists(session.cwd));
            }
          }
          /*
            El grupo entra entero y de una: una sesion sin `cwd` que se viera
            antes que la del mismo grupo que si lo trae armaria un proyecto
            `unknown:` que un instante despues ya no existe.
          */
          for (const session of batch) {
            this.sessions.set(cacheKey(session.agent, session.ref), session);
          }

          /*
            Se emite por grupo: la barra lateral se va llenando durante los 3 s.
            Cada proyecto tocado sale **ya fusionado** con lo de los grupos
            anteriores; uno parcial pisaria en el cliente al que ya estaba.
          */
          const fresh = new Set(batch.map((session) => session.summary));
          const touched = buildProjects(this.sessions.values(), process.platform).filter(
            (project) => project.sessions.some((summary) => fresh.has(summary)),
          );
          this.emit(
            'projects',
            touched.map((project) => this.finish(project)),
            false,
          );
        }
      }

      this.setStatus({ state: 'ready', scannedFiles: scanned, totalFiles });
      this.emit('projects', this.getProjects(), true);
      await this.saveCache();
    } finally {
      this.scanning = false;
      if (this.rescanQueued) {
        this.rescanQueued = false;
        void this.scan();
      }
    }
  }

  /**
   * Una sesion, de la cache si el archivo no cambio de tamano ni de fecha, o
   * leida de nuevo. null si no se pudo leer: un archivo ilegible o borrado a
   * mitad del escaneo no invalida el resto.
   */
  private async read(
    agent: AgentId,
    history: HistorySource,
    item: HistoryItem,
  ): Promise<IndexedSession | null> {
    const key = cacheKey(agent, item.ref);
    try {
      let cwd: string | null;
      let resumeCwd: string | null;
      let summary: ScannedSummary;
      const cached = this.cache.entries[key];
      if (
        cached !== undefined &&
        cached.mtimeMs === item.mtimeMs &&
        cached.sizeBytes === item.sizeBytes
      ) {
        // Tambien desde la cache: si no, un arranque en caliente se quedaria
        // sin lo que la CLI aprende al leer (con Claude Code, la variante).
        history.restored(item, cached.extra);
        cwd = cached.cwd.length > 0 ? cached.cwd : null;
        resumeCwd = cached.resumeCwd !== undefined && cached.resumeCwd.length > 0 ? cached.resumeCwd : null;
        summary = cached.summary;
      } else {
        const scanned = await history.scan(item);
        if (scanned === null) {
          /*
            Existe pero no es una sesion que se liste. No se cachea: una entrada
            vieja de ese mismo archivo —de cuando si lo era— tampoco sirve ya.
          */
          if (key in this.cache.entries) {
            delete this.cache.entries[key];
            this.cacheDirty = true;
          }
          return null;
        }
        cwd = scanned.cwd !== null && scanned.cwd.length > 0 ? scanned.cwd : null;
        resumeCwd =
          typeof scanned.resumeCwd === 'string' && scanned.resumeCwd.length > 0 && scanned.resumeCwd !== cwd
            ? scanned.resumeCwd
            : null;
        summary = scanned.summary;
        this.cache.entries[key] = {
          agent,
          ref: item.ref,
          group: item.group,
          mtimeMs: item.mtimeMs,
          sizeBytes: item.sizeBytes,
          cwd: cwd ?? '',
          // Solo cuando difiere: una entrada de Claude Code queda igual que antes.
          ...(resumeCwd !== null ? { resumeCwd } : {}),
          summary,
          extra: scanned.extra,
        };
        this.cacheDirty = true;
      }
      return {
        agent,
        ref: item.ref,
        group: item.group,
        cwd,
        summary: { ...summary, agent, cwd: resumeCwd ?? cwd ?? '', archived: false },
      };
    } catch {
      return null;
    }
  }

  /**
   * Reindexa lo que pudo cambiar con un aviso del watcher de una CLI.
   *
   * La fuente dice que sesiones toco ese archivo: con Claude Code es una, la
   * del propio archivo, pero con una base compartida pueden ser varias.
   */
  async refreshPath(agent: AgentId, filePath: string): Promise<void> {
    const history = this.agents.adapter(agent).history;
    let refs: readonly string[] | null;
    try {
      refs = await history.changedRefs(filePath);
    } catch {
      refs = null;
    }
    if (refs === null) return;

    /*
      Solo se avisa y se guarda si algo cambio. Una `codex exec` de otra app
      escribe su rollout cada poco, y cada escritura es un aviso de un archivo
      que no se lista ni se listaba: reemitir la barra entera a todos los
      clientes y reescribir la cache por eso era trabajo para nada, y lo pagaba
      tambien quien solo usa Claude Code.
    */
    let changed = false;
    for (const ref of refs) {
      const key = cacheKey(agent, ref);
      if (key in this.cache.entries) {
        delete this.cache.entries[key];
        this.cacheDirty = true;
      }

      let item: HistoryItem | null;
      try {
        item = await history.item(ref);
      } catch {
        item = null;
      }
      const indexed = item === null ? null : await this.read(agent, history, item);
      if (indexed === null) {
        if (this.sessions.delete(key)) changed = true;
        continue;
      }
      // Siempre de nuevo: la carpeta pudo aparecer o borrarse desde el escaneo.
      if (indexed.cwd !== null) this.cwdExists.set(indexed.cwd, await pathExists(indexed.cwd));
      // Un `set` sobre una clave que ya estaba conserva su posicion.
      this.sessions.set(key, indexed);
      changed = true;
    }

    if (changed) this.emit('projects', this.getProjects(), true);
    await this.saveCache();
  }
}
