/**
 * Indice de proyectos y sesiones de `~/.claude/projects/`.
 *
 * Tres cosas que aprendimos midiendo la instalacion real y que explican el
 * diseno de este archivo (detalle en CLAUDE.md 4.6 y 4.7):
 *
 *  1. Indexar 228 archivos en frio cuesta 3,2 s. No puede bloquear el arranque:
 *     corre en segundo plano y emite por proyecto a medida que termina.
 *  2. Hay lineas de 290 KB, asi que la lectura es por lineas y no por bloques
 *     de bytes fijos (ver jsonl-reader.ts).
 *  3. 222 de 228 sesiones no tienen titulo propio. El fallback al primer
 *     mensaje del usuario es el caso normal, no la excepcion, y por eso se
 *     limpia con cuidado.
 *
 * Sobre el slug: el nombre de la carpeta NO se puede revertir a una ruta.
 * `cwd` siempre sale del contenido del JSONL.
 */

import { EventEmitter } from 'node:events';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type {
  IndexStatus,
  ProjectSummary,
  SessionSummary,
  SessionTitleSource,
} from '@agent-workbench/shared';
import type { ArchivedSessions } from './archived-sessions.js';
import { parseJsonlLine, readHeadLines, readTailLines } from './jsonl-reader.js';
import type { ModelVariantRegistry } from './model-variants.js';
import { appConfigDir, sessionIndexCachePath, sessionsRoot } from './paths.js';

/** Cuantas lineas de la cabeza mirar buscando cwd y titulo. El cwd mas tardio medido esta en la 8. */
const HEAD_MAX_LINES = 40;
/** Tope de bytes de la cabeza. Cubre el peor caso medido (372 KB para 25 lineas). */
const HEAD_MAX_BYTES = 512 * 1024;
/** Bloque final para fecha, ultimo mensaje y titulos tardios. */
const TAIL_MAX_BYTES = 64 * 1024;

const TITLE_MAX_LENGTH = 90;
/** Sube cuando cambia la forma de la cache. La v3 agrega `modelIds`. */
const CACHE_VERSION = 3;

interface CacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  cwd: string;
  summary: SessionSummary;
  /**
   * Ids completos de modelo vistos en las lineas `cost-state` del archivo.
   *
   * Se guardan porque son la unica parte del JSONL que trae el sufijo de
   * variante (`claude-opus-5[1m]`), y sin ellos el medidor de contexto vuelve a
   * suponer 200k para una sesion de 1M. Ver `model-variants.ts`.
   */
  modelIds: string[];
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

interface ScanResult {
  cwd: string | null;
  summary: SessionSummary;
  /** Ids completos de modelo vistos en `cost-state`. Casi siempre vacio. */
  modelIds: string[];
}

export interface SessionIndexEvents {
  status: (status: IndexStatus) => void;
  projects: (projects: ProjectSummary[], replace: boolean) => void;
}

/**
 * Aplana el `content` de un mensaje a texto plano.
 *
 * Puede ser un string suelto o un array de bloques. Solo interesan los de tipo
 * `text`: un `tool_result` como titulo de sesion no le dice nada a nadie.
 */
function extractMessageText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] !== 'text') continue;
    const text = record['text'];
    if (typeof text === 'string') parts.push(text);
  }

  const joined = parts.join(' ').trim();
  return joined.length > 0 ? joined : null;
}

/**
 * Deja el texto en una linea legible.
 *
 * Como casi todos los titulos salen de aca, vale la pena: se sacan los saltos
 * de linea, los comandos de la CLI y las etiquetas de sistema que ensucian el
 * listado.
 */
function toTitle(raw: string): string {
  let text = raw
    .replace(/<[^>]{1,80}>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length > TITLE_MAX_LENGTH) {
    text = `${text.slice(0, TITLE_MAX_LENGTH - 1).trimEnd()}…`;
  }
  return text;
}

/** true si la linea es un mensaje de usuario real y no ruido interno. */
function isRealUserMessage(record: Record<string, unknown>): boolean {
  if (record['type'] !== 'user') return false;
  if (record['isMeta'] === true) return false;
  if (record['isVisibleInTranscriptOnly'] === true) return false;
  return true;
}

/** Lee un archivo de sesion y devuelve su resumen y el cwd que declara. */
async function scanSessionFile(filePath: string, sessionId: string): Promise<ScanResult> {
  const info = await stat(filePath);

  const [headLines, tailLines] = await Promise.all([
    readHeadLines(filePath, { maxLines: HEAD_MAX_LINES, maxBytes: HEAD_MAX_BYTES }),
    readTailLines(filePath, { maxBytes: TAIL_MAX_BYTES }),
  ]);

  let cwd: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let firstUserText: string | null = null;
  const modelIds = new Set<string>();

  const inspect = (line: string): void => {
    const record = parseJsonlLine(line);
    if (record === null) return;

    // El cwd no esta garantizado en la primera linea: se busca hasta hallarlo.
    if (cwd === null && typeof record['cwd'] === 'string') cwd = record['cwd'];

    const type = record['type'];
    /*
      Las claves de `modelUsage` son el unico lugar del JSONL donde aparece el
      sufijo de variante del modelo. Se cosechan aca y no en un barrido aparte
      porque `cost-state` vive en la cola del archivo, que esta lectura ya
      hace: el dato sale gratis.
    */
    if (type === 'cost-state') {
      const modelUsage = record['modelUsage'];
      if (typeof modelUsage === 'object' && modelUsage !== null) {
        for (const id of Object.keys(modelUsage)) modelIds.add(id);
      }
      return;
    }
    if (type === 'custom-title' && typeof record['customTitle'] === 'string') {
      customTitle = record['customTitle'];
    } else if (type === 'ai-title' && typeof record['aiTitle'] === 'string') {
      aiTitle = record['aiTitle'];
    } else if (firstUserText === null && isRealUserMessage(record)) {
      const message = record['message'];
      if (typeof message === 'object' && message !== null) {
        firstUserText = extractMessageText((message as Record<string, unknown>)['content']);
      }
    }
  };

  for (const line of headLines) inspect(line);
  // La cola tambien puede traer titulos: se midio uno en la linea 358 de 365.
  for (const line of tailLines) inspect(line);

  let title: string;
  let titleSource: SessionTitleSource;
  if (customTitle !== null) {
    title = toTitle(customTitle);
    titleSource = 'custom';
  } else if (aiTitle !== null) {
    title = toTitle(aiTitle);
    titleSource = 'ai';
  } else if (firstUserText !== null) {
    title = toTitle(firstUserText);
    titleSource = 'first-message';
  } else {
    title = 'Sesion sin titulo';
    titleSource = 'none';
  }

  if (title.length === 0) {
    title = 'Sesion sin titulo';
    titleSource = 'none';
  }

  return {
    cwd,
    modelIds: [...modelIds],
    summary: {
      sessionId,
      title,
      titleSource,
      updatedAt: info.mtimeMs,
      sizeBytes: info.size,
      // Lo pone `withArchived` al emitir, no la cache: ver el constructor.
      archived: false,
    },
  };
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

export declare interface SessionIndex {
  on<E extends keyof SessionIndexEvents>(event: E, listener: SessionIndexEvents[E]): this;
  emit<E extends keyof SessionIndexEvents>(
    event: E,
    ...args: Parameters<SessionIndexEvents[E]>
  ): boolean;
}

export class SessionIndex extends EventEmitter {
  private readonly root = sessionsRoot();
  private cache: CacheFile = { version: CACHE_VERSION, entries: {} };

  /**
   * Registro de variantes de modelo que alimenta este indice.
   *
   * Va por constructor y no como evento porque no es informacion de la barra
   * lateral: es un efecto util de una lectura que ya se hacia. Ver
   * `model-variants.ts` para por que el dato no puede salir de otro lado.
   */
  constructor(
    private readonly modelVariants?: ModelVariantRegistry,
    /**
     * Que sesiones estan escondidas de la barra lateral.
     *
     * Se pregunta al emitir y no se guarda en la cache del indice: archivar es
     * una preferencia del usuario y la cache se invalida por `mtime` del
     * `.jsonl`, que no cambia al archivar. Mezclarlas haria que archivar
     * sobreviviera o se perdiera segun cuando se toco el archivo.
     */
    private readonly archived?: ArchivedSessions,
  ) {
    super();
  }

  private projects = new Map<string, ProjectSummary>();
  private status: IndexStatus = { state: 'idle', scannedFiles: 0, totalFiles: 0 };
  private scanning = false;
  private rescanQueued = false;
  private cacheDirty = false;

  getProjects(): ProjectSummary[] {
    return [...this.projects.values()]
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .map((project) => this.withArchived(project));
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
      if (typeof parsed !== 'object' || parsed === null) return;
      const record = parsed as Record<string, unknown>;
      if (record['version'] !== CACHE_VERSION) return;
      const entries = record['entries'];
      if (typeof entries === 'object' && entries !== null) {
        this.cache = { version: CACHE_VERSION, entries: entries as Record<string, CacheEntry> };
      }
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
      if (!(await pathExists(this.root))) {
        this.projects.clear();
        this.setStatus({ state: 'ready', scannedFiles: 0, totalFiles: 0 });
        this.emit('projects', [], true);
        return;
      }

      const directories = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      // Conteo previo para poder mostrar progreso real.
      let totalFiles = 0;
      const filesBySlug = new Map<string, string[]>();
      for (const slug of directories) {
        try {
          const files = (await readdir(path.join(this.root, slug))).filter((name) =>
            name.endsWith('.jsonl'),
          );
          if (files.length === 0) continue;
          filesBySlug.set(slug, files);
          totalFiles += files.length;
        } catch {
          // Carpeta ilegible: se salta sin romper el resto del indice.
        }
      }

      this.projects.clear();
      let scanned = 0;
      this.setStatus({ state: 'scanning', scannedFiles: 0, totalFiles });

      for (const [slug, files] of filesBySlug) {
        const project = await this.scanProject(slug, files, () => {
          scanned += 1;
          // Progreso cada 10 archivos: suficiente para la barra, sin inundar el socket.
          if (scanned % 10 === 0) {
            this.setStatus({ state: 'scanning', scannedFiles: scanned, totalFiles });
          }
        });

        if (project !== null) {
          this.projects.set(slug, project);
          // Se emite por proyecto: la barra lateral se va llenando durante los 3 s.
          this.emit('projects', [this.withArchived(project)], false);
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

  private async scanProject(
    slug: string,
    files: string[],
    onFileScanned: () => void,
  ): Promise<ProjectSummary | null> {
    const sessions: SessionSummary[] = [];
    let cwd: string | null = null;
    let lastActivityAt = 0;

    for (const fileName of files) {
      const filePath = path.join(this.root, slug, fileName);
      const sessionId = fileName.replace(/\.jsonl$/i, '');

      try {
        const info = await stat(filePath);
        const cached = this.cache.entries[filePath];

        // La cache vale mientras el archivo no haya cambiado de tamano ni fecha.
        if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.sizeBytes === info.size) {
          sessions.push(cached.summary);
          if (cached.cwd.length > 0 && cwd === null) cwd = cached.cwd;
          lastActivityAt = Math.max(lastActivityAt, cached.summary.updatedAt);
          // Tambien desde la cache: si no, un arranque en caliente se quedaria
          // sin saber que variante usa la instalacion.
          for (const id of cached.modelIds ?? []) {
            this.modelVariants?.observe(id, cached.mtimeMs);
          }
          onFileScanned();
          continue;
        }

        const result = await scanSessionFile(filePath, sessionId);
        sessions.push(result.summary);
        if (result.cwd !== null && cwd === null) cwd = result.cwd;
        lastActivityAt = Math.max(lastActivityAt, result.summary.updatedAt);
        for (const id of result.modelIds) this.modelVariants?.observe(id, info.mtimeMs);

        this.cache.entries[filePath] = {
          mtimeMs: info.mtimeMs,
          sizeBytes: info.size,
          cwd: result.cwd ?? '',
          summary: result.summary,
          modelIds: result.modelIds,
        };
        this.cacheDirty = true;
      } catch {
        // Un archivo ilegible o borrado a mitad del escaneo no invalida el resto.
      }
      onFileScanned();
    }

    if (sessions.length === 0) return null;

    sessions.sort((a, b) => b.updatedAt - a.updatedAt);

    // Sin cwd no podemos abrir pestanas ahi, pero igual se lista: ocultarlo
    // seria peor que mostrarlo marcado.
    const resolvedCwd = cwd ?? '';
    return {
      slug,
      cwd: resolvedCwd,
      cwdExists: resolvedCwd.length > 0 ? await pathExists(resolvedCwd) : false,
      sessions,
      lastActivityAt,
    };
  }

  /** Reindexa un solo archivo. Lo usa el watcher. */
  async refreshFile(filePath: string): Promise<void> {
    const relative = path.relative(this.root, filePath);
    const [slug] = relative.split(path.sep);
    if (slug === undefined || slug.length === 0 || slug.startsWith('..')) return;

    delete this.cache.entries[filePath];
    this.cacheDirty = true;

    try {
      const files = (await readdir(path.join(this.root, slug))).filter((name) =>
        name.endsWith('.jsonl'),
      );
      const project = await this.scanProject(slug, files, () => undefined);
      if (project === null) {
        this.projects.delete(slug);
      } else {
        this.projects.set(slug, project);
      }
    } catch {
      this.projects.delete(slug);
    }

    this.emit('projects', this.getProjects(), true);
    await this.saveCache();
  }
}
