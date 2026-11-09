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
  isAgentId,
  isImportedAgentId,
  normalizeCwdKey,
  parseSessionSummary,
  type AgentId,
  type IndexStatus,
  type ProjectRelocation,
  type ProjectSummary,
  type SessionAgentId,
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
import type { ProjectLocationStore, Relocation } from './project-locations.js';
import type { VaultSummary } from './vault/catalog.js';
import type { WorktreeLink, WorktreeLinks } from './worktrees/links.js';

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
   * Completo: con `agent`, `cwd`, `archived` en false (lo marca `withArchived`),
   * `storage` `native` y `partial` false. Su `cwd` es el de reanudar, que puede
   * no ser el de arriba.
   */
  summary: SessionSummary;
}

/**
 * Una sesion que entra a un proyecto: nativa (`IndexedSession`) o de la copia
 * propia. `buildProjects` no distingue: agrupa por `cwd` y, sin `cwd`, por
 * `agent` + `group`.
 */
export interface ProjectInput {
  agent: SessionAgentId;
  group: string;
  cwd: string | null;
  summary: SessionSummary;
}

/**
 * Lo que el indice necesita de la copia propia (`vault/catalog.ts`). Una vista
 * y no la clase: el indice no escribe ni lee la copia, solo mezcla lo que ya
 * esta listado.
 */
export interface VaultCatalogView {
  summaries(): readonly VaultSummary[];
  onChange(listener: () => void): () => void;
}

/**
 * Como quedo el `list()` de la fuente de una CLI en el ultimo escaneo.
 *
 *  - `listed`: dio la lista. Lo que no esta ahi, no esta en el historial.
 *  - `missing`: la raiz del historial no existe. Tampoco esta.
 *  - `unreadable`: la raiz existe y no se pudo leer (una base ocupada, una
 *    carpeta sin permiso, un `list()` que lanzo). **No se sabe** que hay: una
 *    copia de esa CLI no se muestra como "copia", porque probablemente la
 *    sesion sigue ahi (D7, R4).
 */
/** `off`: la CLI esta apagada en Ajustes (Hito 41) y su historial no se leyo a proposito. */
export type NativeListState = 'listed' | 'missing' | 'unreadable' | 'off';

const vaultPairKey = (agent: string, sessionId: string): string => `${agent}/${sessionId}`;

/**
 * Las sesiones de la copia que el historial nativo ya no tiene, listas para
 * `buildProjects`. Pura: la prueba el chequeo.
 *
 *  - Con el indice sin terminar (`ready` false), ninguna: durante un escaneo
 *    en frio todas las sesiones de Claude Code aparecerian como "copia" los
 *    3 s que tarda (D7).
 *  - Una copia entra si su par `(agent, sessionId)` no esta entre las nativas
 *    **y** es de una fuente importada (no tiene historial nativo) o el
 *    historial de su CLI se leyo (`listed`) o no existe (`missing`). Una CLI sin
 *    estado —no esta registrada en este indice— cuenta como `missing`: no hay
 *    historial nativo que la pueda tener.
 *  - Sale con `storage 'vault'`, el `partial` y el `group` de la cabecera, y
 *    `archived` en false (lo marca `withArchived`, como a las demas). Una copia
 *    con `cwd` agrupa por su propio `vault:<agent>:<sessionId>` aunque la
 *    cabecera diga otro: si no, le prestaria su `cwd` a otra copia sin `cwd`
 *    del mismo grupo y la metería en un proyecto que no es el suyo.
 */
export function vaultOnlySessions(
  natives: Iterable<Pick<IndexedSession, 'agent' | 'summary'>>,
  vault: readonly VaultSummary[],
  listState: ReadonlyMap<AgentId, NativeListState>,
  ready: boolean,
): ProjectInput[] {
  if (!ready || vault.length === 0) return [];

  const native = new Set<string>();
  for (const session of natives) native.add(vaultPairKey(session.agent, session.summary.sessionId));

  const result: ProjectInput[] = [];
  const seen = new Set<string>();
  for (const copy of vault) {
    const pair = vaultPairKey(copy.agent, copy.sessionId);
    if (native.has(pair) || seen.has(pair)) continue;
    /*
      Ni la de una CLI que no se pudo leer, ni la de una apagada en Ajustes: esa
      no tiene que aparecer en ningun lado (lo encontro la revision de la 0.5.0;
      sin estado, caia a `missing` y sus copias volvian a la barra).
    */
    if (!isImportedAgentId(copy.agent)) {
      const state = listState.get(copy.agent) ?? 'missing';
      if (state === 'unreadable' || state === 'off') continue;
    }
    seen.add(pair);
    const hasCwd = copy.cwd.length > 0;
    result.push({
      agent: copy.agent,
      group: hasCwd ? `vault:${copy.agent}:${copy.sessionId}` : copy.group,
      cwd: hasCwd ? copy.cwd : null,
      summary: {
        agent: copy.agent,
        sessionId: copy.sessionId,
        cwd: copy.cwd,
        title: copy.title,
        titleSource: copy.titleSource,
        updatedAt: copy.updatedAt,
        sizeBytes: copy.sizeBytes,
        archived: false,
        storage: 'vault',
        partial: copy.partial,
        worktree: null,
      },
    });
  }
  return result;
}

/**
 * El estado de una fuente despues de su `list()`. Pura: la prueba el chequeo.
 *
 * `listed` si dio una lista. Si dio null o lanzo: sin `rootExists`, `missing`
 * cuando dio null (su contrato dice que null es "la raiz falta") y `unreadable`
 * cuando lanzo; con `rootExists`, lo que diga —true es que la raiz esta y no se
 * pudo leer—. Un `rootExists` que lanza tampoco sabe: `unreadable`.
 */
export async function nativeListState(
  history: Pick<HistorySource, 'rootExists'>,
  outcome: { items: readonly HistoryItem[] | null; threw: boolean },
): Promise<NativeListState> {
  if (outcome.items !== null) return 'listed';
  if (history.rootExists === undefined) return outcome.threw ? 'unreadable' : 'missing';
  try {
    return (await history.rootExists()) ? 'unreadable' : 'missing';
  } catch {
    return 'unreadable';
  }
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
  // Una entrada de la cache es siempre de una CLI con adaptador: un id
  // importado ahi se descarta, igual que antes de que existieran.
  if (parsed === null || !isAgentId(parsed.agent)) return null;
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
 *  4. Hito 48: una sesion de una rama aparte (`linkOf`) va al proyecto de su
 *     carpeta principal, con su rama en `worktree`. Sin eso era otro proyecto.
 *  5. Hito 56: la carpeta de un proyecto que se movio (`relocateOf`, §13.14) se
 *     cambia por la nueva, **despues** de la rama: la principal de una rama
 *     quitada tambien se mudo. La fila conserva su carpeta (`summary.cwd`) y
 *     sale con `relocated`; el proyecto dice de donde vienen sus conversaciones.
 */
export function buildProjects(
  sessions: Iterable<ProjectInput>,
  platform: string,
  linkOf: (cwd: string) => WorktreeLink | null = () => null,
  relocateOf: (cwd: string) => Relocation | null = () => null,
): Array<Omit<ProjectSummary, 'cwdExists' | 'isGitRepo'>> {
  const projects = new Map<string, Omit<ProjectSummary, 'cwdExists' | 'isGitRepo'>>();
  const moved = new Map<string, Map<string, ProjectRelocation>>();
  for (const placement of placeSessions(sessions, platform, linkOf, relocateOf)) {
    const { input: session, link, relocation, effective, key } = placement;
    // La que no se aplica (en pausa) deja la sesion donde estaba.
    const applied = relocation !== null && !relocation.paused;

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
    // Una copia solo si cambia algo: el resumen de entrada es de quien lo armo.
    let summary = session.summary;
    if (link !== null) summary = { ...summary, worktree: link.worktree };
    if (applied) summary = { ...summary, relocated: true };
    project.sessions.push(summary);
    project.lastActivityAt = Math.max(project.lastActivityAt, session.summary.updatedAt);

    if (relocation !== null) {
      let locations = moved.get(key);
      if (locations === undefined) {
        locations = new Map();
        moved.set(key, locations);
      }
      const fromKey = normalizeCwdKey(relocation.from, platform);
      const known = locations.get(fromKey);
      if (known === undefined) {
        locations.set(fromKey, { from: relocation.from, to: relocation.to, sessions: 1, paused: relocation.paused });
      } else {
        known.sessions += 1;
      }
    }
  }

  for (const project of projects.values()) {
    project.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    const locations = moved.get(project.key);
    if (locations !== undefined) {
      project.relocations = [...locations.values()].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    }
  }
  return [...projects.values()];
}

/** Hito 56. Donde cae una sesion de la barra, para el servicio de ubicaciones (`locationPlacements`). */
export interface LocationPlacement {
  agent: SessionAgentId;
  sessionId: string;
  archived: boolean;
  /** La clave del proyecto en el que cae, con las ubicaciones aplicadas. */
  projectKey: string;
  /** La carpeta del historial (la principal, si era de una rama aparte): de donde sale la ubicacion. */
  base: string;
  /** Si esa carpeta existe en disco. */
  baseExists: boolean;
  /** La ubicacion que la alcanza, aplicada o en pausa; null si ninguna. */
  relocation: Relocation | null;
}

/** Donde cae una sesion de la barra y por que (`placeSessions`). */
export interface SessionPlacement {
  input: ProjectInput;
  /** La rama aparte de su carpeta, o null. */
  link: WorktreeLink | null;
  /** La carpeta del historial, ya en la principal si era de una rama aparte. */
  base: string;
  /** Hito 56. La ubicacion que alcanza a `base`, aplicada o en pausa; null si ninguna. */
  relocation: Relocation | null;
  /** La carpeta del proyecto en el que cae (vacia si ninguna sesion del grupo trae `cwd`). */
  effective: string;
  /** La clave de ese proyecto. */
  key: string;
}

/**
 * De cada sesion, en que proyecto cae. Pura. Es la mitad de `buildProjects` que
 * decide el proyecto, aparte para que el servicio de ubicaciones (hito 56) vea
 * lo mismo que la barra sin repetir la regla.
 *
 * Cada grupo nativo (`agent` + `group`) aporta el **primer** `cwd` no vacio de
 * sus sesiones: es el respaldo de las que no traen.
 */
export function placeSessions(
  sessions: Iterable<ProjectInput>,
  platform: string,
  linkOf: (cwd: string) => WorktreeLink | null = () => null,
  relocateOf: (cwd: string) => Relocation | null = () => null,
): SessionPlacement[] {
  const all = [...sessions];

  const groupCwd = new Map<string, string>();
  for (const session of all) {
    const group = `${session.agent}:${session.group}`;
    if (session.cwd !== null && session.cwd.length > 0 && !groupCwd.has(group)) {
      groupCwd.set(group, session.cwd);
    }
  }

  return all.map((input) => {
    const own = input.cwd !== null && input.cwd.length > 0 ? input.cwd : null;
    const sessionCwd = own ?? groupCwd.get(`${input.agent}:${input.group}`) ?? '';
    const link = sessionCwd.length > 0 ? linkOf(sessionCwd) : null;
    const base = link?.mainCwd ?? sessionCwd;
    const relocation = base.length > 0 ? relocateOf(base) : null;
    const effective = relocation !== null && !relocation.paused ? relocation.cwd : base;
    const key =
      effective.length > 0
        ? normalizeCwdKey(effective, platform)
        : `unknown:${input.agent}:${input.group}`;
    return { input, link, base, relocation, effective, key };
  });
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

  /**
   * Hito 48. La rama aparte de cada `cwd` (null si no es una), y si cada carpeta
   * de proyecto es de git. Se aprenden junto con `cwdExists` y por lo mismo: la
   * barra se arma sin tocar el disco.
   */
  private readonly cwdLink = new Map<string, WorktreeLink | null>();
  private readonly cwdGit = new Map<string, boolean>();

  /**
   * Hito 56 (§13.14). La ubicacion que alcanza a cada carpeta del historial
   * (despues de la rama aparte), aplicada o en pausa, o null. Se aprende junto
   * con `cwdExists` y por lo mismo: la barra se arma sin tocar el disco. No
   * entra a la cache del indice: mover un proyecto no cambia ningun archivo.
   */
  private readonly cwdRelocation = new Map<string, Relocation | null>();

  /**
   * Como quedo el `list()` de cada CLI en el ultimo escaneo. Decide si una
   * copia de esa CLI se muestra (`vaultOnlySessions`). `refreshPath` no lo
   * toca: un aviso del watcher dice que un archivo cambio, no que la raiz se
   * pudo leer.
   */
  private listState: ReadonlyMap<AgentId, NativeListState> = new Map();

  private readonly stopCatalog: (() => void) | null;

  constructor(
    private readonly agents: Pick<AgentRegistry, 'all' | 'adapter'> & Partial<Pick<AgentRegistry, 'historySources'>>,
    /**
     * Que sesiones estan escondidas de la barra lateral.
     *
     * Se pregunta al emitir y no se guarda en la cache del indice: archivar es
     * una preferencia del usuario y la cache se invalida por `mtime` del
     * archivo, que no cambia al archivar. Mezclarlas haria que archivar
     * sobreviviera o se perdiera segun cuando se toco el archivo.
     */
    private readonly archived?: Pick<ArchivedSessions, 'has'>,
    /**
     * La copia propia (hito 28). Sus sesiones se mezclan con las nativas **al
     * emitir** y solo con el indice listo; nunca entran a la cache. Ausente: el
     * indice de siempre.
     */
    private readonly catalog?: VaultCatalogView,
    /**
     * Hito 48: de que proyecto y que rama es cada carpeta. Ausente: cada carpeta
     * es su proyecto, como siempre. Hito 54: y a que rama paso la app cada
     * conversacion (`movedTo`).
     */
    private readonly links?: Pick<WorktreeLinks, 'sessionLink' | 'isGitRepo'> & Partial<Pick<WorktreeLinks, 'movedTo'>>,
    /**
     * Hito 56: a donde se movio la carpeta de cada proyecto en esta PC. Ausente:
     * cada carpeta es la suya, como siempre.
     */
    private readonly locations?: Pick<ProjectLocationStore, 'resolve'>,
  ) {
    super();
    this.stopCatalog =
      catalog === undefined
        ? null
        : catalog.onChange(() => {
            void this.onCatalogChange();
          });
  }

  private status: IndexStatus = { state: 'idle', scannedFiles: 0, totalFiles: 0 };
  private scanning = false;
  private rescanQueued = false;
  /** La relectura en curso de cada archivo (`refreshPath`), y si llego otro aviso mientras corria. */
  private readonly refreshing = new Map<string, { again: boolean; done: Promise<void> }>();
  private cacheDirty = false;
  /**
   * Lo que aportaron las copias a la ultima barra completa que salio
   * (`vaultSignature`). Se anota en cada emision completa, sea cual sea el
   * motivo: si solo la anotara el aviso del catalogo, una emision por un cambio
   * nativo en el medio dejaria comparando contra una barra que ya no es la del
   * cliente.
   */
  private emittedVaultSignature: string | null = null;

  getProjects(): ProjectSummary[] {
    return this.projectsWith(this.vaultCopies());
  }

  /** Las copias que entran a la barra ahora (`vaultOnlySessions`). */
  private vaultCopies(): ProjectInput[] {
    return vaultOnlySessions(
      this.sessions.values(),
      this.catalog?.summaries() ?? [],
      this.listState,
      this.status.state === 'ready',
    );
  }

  /** La rama aparte de una carpeta del historial, tal como la ve la barra. */
  linkOf(cwd: string): WorktreeLink | null {
    return this.cwdLink.get(cwd) ?? null;
  }

  /**
   * Hito 54: una conversacion que la app paso a una rama aparte va en la barra
   * a esa rama, y se retoma ahi. Su archivo no lo dice (sigue en la carpeta de
   * la principal, y el `cwd` de sus lineas cambia tambien cuando el agente entra
   * a una subcarpeta): lo dice el registro de las ramas. Se aplica al emitir,
   * como archivar, y no en la cache: mudarla no cambia el archivo.
   */
  private placed(session: IndexedSession): IndexedSession {
    const folder = this.links?.movedTo?.(session.agent, session.summary.sessionId) ?? null;
    if (folder === null) return session;
    return { ...session, cwd: folder, summary: { ...session.summary, cwd: folder } };
  }

  /** Las sesiones nativas, cada una donde va en la barra. */
  private placedSessions(): IndexedSession[] {
    return [...this.sessions.values()].map((session) => this.placed(session));
  }

  /**
   * Hito 56. A donde se movio una carpeta del historial, ya aprendida, o null si
   * no se movio o la ubicacion esta en pausa. Lo usa quien necesita la carpeta de
   * ahora de una sesion (continuarla). Una carpeta que nadie aprendio con esa
   * escritura se resuelve igual contra las ubicaciones de ahora.
   */
  relocationOf(cwd: string): Relocation | null {
    const learned = this.cwdRelocation.get(cwd);
    if (learned !== undefined) return learned !== null && !learned.paused ? learned : null;
    const resolved = this.locations?.resolve(cwd) ?? null;
    // Sin saber si la carpeta anterior existe, no se aplica: mejor no mover que esconder una carpeta que existe.
    if (resolved === null || this.cwdExists.get(resolved.location.from) !== false) return null;
    return { cwd: resolved.cwd, from: resolved.location.from, to: resolved.location.to, paused: false };
  }

  private relocateOf(cwd: string): Relocation | null {
    return this.cwdRelocation.get(cwd) ?? null;
  }

  /** Todas las sesiones de la barra, nativas y copias, tal como `getProjects` las ubica. */
  private allInputs(): ProjectInput[] {
    return [...this.placedSessions(), ...this.vaultCopies()];
  }

  private projectsWith(copies: readonly ProjectInput[]): ProjectSummary[] {
    return buildProjects(
      [...this.placedSessions(), ...copies],
      process.platform,
      (cwd) => this.linkOf(cwd),
      (cwd) => this.relocateOf(cwd),
    )
      .map((project) => this.finish(project))
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  }

  /**
   * Hito 56. Donde cae cada sesion de la barra: de que carpeta del historial
   * salio, si esa carpeta existe en disco, y la ubicacion que la alcanza. Es lo
   * que necesita el servicio de ubicaciones para armar la vista previa y las
   * carpetas que se asocian, con la misma regla que la barra.
   */
  locationPlacements(): LocationPlacement[] {
    return placeSessions(
      this.allInputs(),
      process.platform,
      (cwd) => this.linkOf(cwd),
      (cwd) => this.relocateOf(cwd),
    ).map((placement) => ({
      agent: placement.input.agent,
      sessionId: placement.input.summary.sessionId,
      archived: this.archived?.has(placement.input.summary.sessionId) ?? false,
      projectKey: placement.key,
      base: placement.base,
      baseExists: this.cwdExists.get(placement.base) ?? false,
      relocation: placement.relocation,
    }));
  }

  /** Todo lo que una copia pone en la barra: su fila, su proyecto y si existe su carpeta. */
  private vaultSignature(copies: readonly ProjectInput[]): string {
    return JSON.stringify(
      copies.map((copy) => [
        copy.agent,
        copy.group,
        copy.cwd,
        copy.summary,
        copy.cwd === null ? null : (this.cwdExists.get(copy.cwd) ?? false),
      ]),
    );
  }

  /** La barra entera a los clientes. Toda emision completa pasa por aca. */
  private emitProjects(): void {
    const copies = this.vaultCopies();
    this.emittedVaultSignature = this.vaultSignature(copies);
    this.emit('projects', this.projectsWith(copies), true);
  }

  /** Suelta el catalogo. El indice de la app vive lo que el proceso; esto es para las pruebas. */
  dispose(): void {
    this.stopCatalog?.();
  }

  /**
   * Si existe la carpeta de cada copia. Las que ya se conocen no se vuelven a
   * mirar: el mapa se rehace entero en cada escaneo, igual que el de las
   * nativas.
   */
  private async learnVaultCwds(): Promise<void> {
    for (const copy of this.catalog?.summaries() ?? []) {
      if (copy.cwd.length > 0) await this.learnCwd(copy.cwd);
    }
  }

  /**
   * Lo que la barra necesita saber de una carpeta, antes de que su sesion sea
   * visible: si existe y, con ramas aparte, de que proyecto es y si ese
   * proyecto es de git. `fresh` vuelve a mirar si existe: la carpeta pudo
   * aparecer o borrarse desde el escaneo.
   */
  private async learnCwd(cwd: string, fresh = false): Promise<void> {
    if (fresh || !this.cwdExists.has(cwd)) this.cwdExists.set(cwd, await pathExists(cwd));
    let projectCwd = cwd;
    if (this.links !== undefined) {
      if (fresh || !this.cwdLink.has(cwd)) this.cwdLink.set(cwd, await this.links.sessionLink(cwd).catch(() => null));
      projectCwd = this.cwdLink.get(cwd)?.mainCwd ?? cwd;
      if (projectCwd !== cwd && (fresh || !this.cwdExists.has(projectCwd))) {
        this.cwdExists.set(projectCwd, await pathExists(projectCwd));
      }
      if (fresh || !this.cwdGit.has(projectCwd)) {
        this.cwdGit.set(projectCwd, await this.links.isGitRepo(projectCwd).catch(() => false));
      }
    }
    await this.learnRelocation(projectCwd, fresh);
  }

  /**
   * Hito 56. Si la carpeta del historial se movio (`locations`), y a donde: la
   * ubicacion se aplica solo mientras la carpeta anterior **no existe**. Si vuelve
   * a existir queda en pausa y el historial vuelve a su carpeta, para que una
   * asociacion nunca esconda una carpeta que esta en disco. Aprende ademas si la
   * carpeta nueva existe y si es de git, antes de que la sesion sea visible.
   */
  private async learnRelocation(base: string, fresh: boolean): Promise<void> {
    if (this.locations === undefined) return;
    const resolved = this.locations.resolve(base);
    if (resolved === null) {
      this.cwdRelocation.set(base, null);
      return;
    }
    const { from, to } = resolved.location;
    if (fresh || !this.cwdExists.has(from)) this.cwdExists.set(from, await pathExists(from));
    const paused = this.cwdExists.get(from) === true;
    this.cwdRelocation.set(base, { cwd: paused ? base : resolved.cwd, from, to, paused });
    if (paused) return;
    if (fresh || !this.cwdExists.has(resolved.cwd)) this.cwdExists.set(resolved.cwd, await pathExists(resolved.cwd));
    if (this.links !== undefined && (fresh || !this.cwdGit.has(resolved.cwd))) {
      this.cwdGit.set(resolved.cwd, await this.links.isGitRepo(resolved.cwd).catch(() => false));
    }
  }

  /** Cada carpeta que conoce el indice, donde va en la barra: la de una conversacion pasada a una rama (Hito 54) y las copias. */
  private knownCwds(): Set<string> {
    const cwds = new Set<string>();
    for (const session of this.placedSessions()) if (session.cwd !== null) cwds.add(session.cwd);
    for (const copy of this.catalog?.summaries() ?? []) if (copy.cwd.length > 0) cwds.add(copy.cwd);
    return cwds;
  }

  /**
   * Hito 48: se creo, se quito o se volvio a abrir una rama aparte. Se vuelve a
   * mirar cada carpeta conocida y se reemite la barra: una sesion de una rama
   * quitada pasa a decirlo, y la de una nueva cae en su proyecto.
   */
  async refreshWorktrees(): Promise<void> {
    if (this.links === undefined) return;
    for (const cwd of this.knownCwds()) await this.learnCwd(cwd, true);
    this.emitProjects();
  }

  /**
   * Hito 56. Se guardo, se cambio o se quito la ubicacion de un proyecto, o una
   * carpeta anterior volvio a existir. Se vuelve a mirar cada carpeta conocida
   * y se reemite la barra a todos.
   */
  async refreshLocations(): Promise<void> {
    for (const cwd of this.knownCwds()) await this.learnCwd(cwd, true);
    this.emitProjects();
  }

  /**
   * La copia cambio (una carga, una sesion escrita). Con el indice listo se
   * reemite todo, **pero solo si cambio lo que las copias ponen en la barra**:
   * en la primera pasada el catalogo avisa una vez por sesion escrita, casi
   * todas tienen su nativa —que gana— y cada aviso era la barra entera a cada
   * ventana. Durante un escaneo no hace falta, porque la emision final ya las
   * lleva y las de cada grupo no llevan copias.
   */
  private async onCatalogChange(): Promise<void> {
    await this.learnVaultCwds();
    if (this.status.state !== 'ready') return;
    if (this.vaultSignature(this.vaultCopies()) === this.emittedVaultSignature) return;
    this.emitProjects();
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

  /**
   * La fila de la barra de una sesion, por su CLI y su id, o null si la barra no
   * la lista (hito 29).
   *
   * Primero las nativas y despues las que solo estan en la copia propia
   * (`vaultOnlySessions`), que es exactamente lo que ve el usuario: continuar
   * una fila "copia" tiene que encontrarla. Por par y no solo por id, al reves
   * que `agentOf`: una copia importada puede tener el mismo id que una nativa
   * de otra fuente, y quien pide dice de cual.
   *
   * El `cwd` del resumen es el de reanudar (`ScannedSession.resumeCwd`), y puede
   * ser `''`. Sin marcar archivada: no le hace falta a nadie que pregunte esto.
   */
  find(agent: SessionAgentId, sessionId: string): SessionSummary | null {
    for (const session of this.sessions.values()) {
      // Con la carpeta de la rama si la app la paso a una (Hito 54): de ahi se retoma.
      if (session.agent === agent && session.summary.sessionId === sessionId) return this.placed(session).summary;
    }
    for (const copy of this.vaultCopies()) {
      if (copy.agent === agent && copy.summary.sessionId === sessionId) return copy.summary;
    }
    return null;
  }

  /**
   * Las sesiones de las CLIs registradas tal como las leyo el indice, en su
   * orden y sin marcar archivadas. Las usa el escritor de la copia propia
   * (hito 28), que decide aparte que se copia.
   */
  nativeSessions(): readonly IndexedSession[] {
    return [...this.sessions.values()];
  }

  /** Completa un proyecto armado para salir: si su carpeta existe, y que esta archivado. */
  private finish(project: Omit<ProjectSummary, 'cwdExists' | 'isGitRepo'>): ProjectSummary {
    return this.withArchived({
      ...project,
      cwdExists: project.cwd.length > 0 ? (this.cwdExists.get(project.cwd) ?? false) : false,
      isGitRepo: project.cwd.length > 0 ? (this.cwdGit.get(project.cwd) ?? false) : false,
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
    this.emitProjects();
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
      console.warn("[index] couldn't save the cache:", error);
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
      // Las apagadas en Ajustes no se leen (Hito 41): `historySources`.
      const sources = (this.agents.historySources?.() ?? this.agents.all()).map(({ adapter }) => ({
        agent: adapter.id,
        history: adapter.history,
      }));
      /*
        Conteo previo para poder mostrar progreso real.

        Una fuente cuyo `list()` lanza no se lleva al resto: antes el escaneo
        entero fallaba y la barra se quedaba sin llegar a `ready`. Queda
        `unreadable`, que es justo lo que impide mostrar sus copias.
      */
      const outcomes = await Promise.all(
        sources.map(async (source) => {
          try {
            return { items: await source.history.list(), threw: false };
          } catch (error) {
            console.warn(`[index] couldn't list the history of ${source.agent}:`, error);
            return { items: null, threw: true };
          }
        }),
      );
      const lists = outcomes.map((outcome) => outcome.items);
      const states = new Map<AgentId, NativeListState>();
      for (const [position, source] of sources.entries()) {
        const outcome = outcomes[position] ?? { items: null, threw: true };
        states.set(source.agent, await nativeListState(source.history, outcome));
      }
      // Las que no son fuente estan apagadas en Ajustes (Hito 41): ni sus copias se muestran.
      for (const { adapter } of this.agents.all()) {
        if (!states.has(adapter.id)) states.set(adapter.id, 'off');
      }
      this.listState = states;

      if (lists.every((items) => items === null)) {
        /*
          Ningun historial nativo (C3). Es el caso de "cambie de maquina": la
          copia es lo unico que hay, y tiene que salir por el mismo camino que
          siempre en vez de un `[]` literal.
        */
        this.sessions.clear();
        this.cwdExists.clear();
        this.cwdLink.clear();
        this.cwdGit.clear();
        this.cwdRelocation.clear();
        await this.learnVaultCwds();
        this.setStatus({ state: 'ready', scannedFiles: 0, totalFiles: 0 });
        this.emitProjects();
        return;
      }

      const totalFiles = lists.reduce((total, items) => total + (items?.length ?? 0), 0);
      // Las dos juntas: una sesion sin su `cwdExists` se veria tachada.
      this.sessions.clear();
      this.cwdExists.clear();
      this.cwdLink.clear();
      this.cwdGit.clear();
      this.cwdRelocation.clear();
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
            const { cwd } = this.placed(session);
            if (cwd !== null) await this.learnCwd(cwd);
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
          const all = this.placedSessions();
          /*
            Las del grupo se reconocen por CLI e id y no por el objeto: una fila de
            una rama aparte o de un proyecto movido sale como una copia del resumen
            (`buildProjects`), y por referencia su proyecto nunca contaba como tocado.
          */
          const freshPairs = new Set(batch.map((session) => `${session.agent}:${session.summary.sessionId}`));
          const touched = buildProjects(
            all,
            process.platform,
            (cwd) => this.linkOf(cwd),
            (cwd) => this.relocateOf(cwd),
          ).filter((project) => project.sessions.some((summary) => freshPairs.has(`${summary.agent}:${summary.sessionId}`)));
          this.emit(
            'projects',
            touched.map((project) => this.finish(project)),
            false,
          );
        }
      }

      // Antes de pasar a `ready`: la emision final ya lleva las copias, y una
      // sin su `cwdExists` se veria tachada.
      await this.learnVaultCwds();
      this.setStatus({ state: 'ready', scannedFiles: scanned, totalFiles });
      this.emitProjects();
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
    try {
      return await this.readOrThrow(agent, history, item);
    } catch {
      return null;
    }
  }

  /**
   * Lo mismo que `read`, pero sin juntar los dos null: devuelve null solo si la
   * fuente dice que no es una sesion que se liste, y **lanza** si no se pudo
   * leer. `refreshPath` necesita la diferencia.
   */
  private async readOrThrow(
    agent: AgentId,
    history: HistorySource,
    item: HistoryItem,
  ): Promise<IndexedSession | null> {
    const key = cacheKey(agent, item.ref);
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
      // Todo lo que sale de una fuente de historial es nativo y completo: la
      // copia propia se mezcla despues, al emitir (hito 28).
      summary: {
        ...summary,
        agent,
        cwd: resumeCwd ?? cwd ?? '',
        archived: false,
        storage: 'native',
        partial: false,
        // La pone `buildProjects` (hito 48): depende de la carpeta, no del archivo.
        worktree: null,
      },
    };
  }

  /**
   * Reindexa lo que pudo cambiar con un aviso del watcher de una CLI.
   *
   * La fuente dice que sesiones toco ese archivo: con Claude Code es una, la
   * del propio archivo, pero con una base compartida pueden ser varias.
   *
   * **Una sola a la vez por archivo** (§4.11.1). Con el antivirus revisando el
   * archivo entero en cada apertura, una sesion de 86 MB tardaba 68 s en
   * abrirse, y la CLI avisa cada pocos cientos de ms: cada aviso dejaba otra
   * lectura esperando en un hilo de disco, y con los cuatro de Node ocupados se
   * paraba todo lo demas, el hilo de la conversacion incluido. Los avisos que
   * llegan mientras corre se juntan en una vuelta mas, y quien espera la promesa
   * espera tambien esa vuelta.
   */
  refreshPath(agent: AgentId, filePath: string): Promise<void> {
    const key = `${agent}\u0000${filePath}`;
    const running = this.refreshing.get(key);
    if (running !== undefined) {
      running.again = true;
      return running.done;
    }
    const state = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await this.refreshPathOnce(agent, filePath);
        } while (state.again);
      } finally {
        this.refreshing.delete(key);
      }
    })();
    this.refreshing.set(key, state);
    return state.done;
  }

  private async refreshPathOnce(agent: AgentId, filePath: string): Promise<void> {
    const history = this.agents.adapter(agent).history;
    let refs: readonly string[] | null;
    try {
      refs = await history.changedRefs(filePath);
    } catch {
      refs = null;
    }
    // Una lista vacia —un checkpoint de una base compartida, una sesion hija— no toca nada.
    if (refs === null || refs.length === 0) return;

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
      const cachedBefore = this.cache.entries[key];
      if (cachedBefore !== undefined) {
        delete this.cache.entries[key];
        this.cacheDirty = true;
      }

      /*
        "No esta" y "no se pudo leer" no son lo mismo. `item` da null si la
        sesion ya no existe, y `scan` null si no es una que se liste: esas se
        quitan. Si cualquiera de los dos **lanza** —una base ocupada mas que el
        `busy_timeout`, un archivo tomado un instante— queda lo que la barra ya
        tenia, con su entrada de cache. Antes se quitaba, y con una base
        compartida la sesion no volvia hasta su proximo cambio: la foto de
        `changedRefs` ya la daba por leida (R26-4). La fuente que la vuelva a
        pedir se encarga de reintentar.
      */
      let indexed: IndexedSession | null;
      try {
        const item = await history.item(ref);
        indexed = item === null ? null : await this.readOrThrow(agent, history, item);
      } catch {
        if (cachedBefore !== undefined && !(key in this.cache.entries)) this.cache.entries[key] = cachedBefore;
        continue;
      }
      if (indexed === null) {
        if (this.sessions.delete(key)) changed = true;
        continue;
      }
      // Siempre de nuevo: la carpeta pudo aparecer o borrarse desde el escaneo.
      const placedCwd = this.placed(indexed).cwd;
      if (placedCwd !== null) await this.learnCwd(placedCwd, true);
      // Un `set` sobre una clave que ya estaba conserva su posicion.
      this.sessions.set(key, indexed);
      changed = true;
    }

    if (changed) this.emitProjects();
    await this.saveCache();
  }
}
