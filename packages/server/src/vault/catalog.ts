/**
 * Lo que hay en la copia propia, leido de sus cabeceras (hito 28).
 *
 * Al cargar se lee **solo la primera linea** de cada `sessions/<agent>/<id>.jsonl`
 * —una sesion de la copia puede pesar decenas de MB y la barra solo necesita el
 * titulo y las fechas—, y despues de cada escritura propia se relee la de esa
 * sesion (`refresh`). El cuerpo se lee entero solo cuando alguien lo pide
 * (`readBody`): abrir una fila "copia" o exportar.
 *
 * Las reglas de lo que se lista, las mismas de `shared/src/vault.ts`:
 *
 *  - Solo `<id>.jsonl` con un id que no puede ser ruta, dentro de la carpeta de
 *    una fuente conocida. Un temporal (`*.tmp`) no termina en `.jsonl` y no
 *    aparece nunca.
 *  - La cabecera tiene que decir la misma fuente y el mismo id que la ruta. Un
 *    archivo movido a mano a otra carpeta se listaria con una identidad que no
 *    es la suya.
 *  - **Un formato que no se conoce no se lista ni se pisa** (D15). Se recuerda
 *    aparte (`hasForeignFormat`) para que quien escribe lo respete: una app mas
 *    nueva escribio ahi, sobre la misma carpeta sincronizada.
 *
 * El catalogo no conoce ninguna CLI ni lee nada fuera de su carpeta.
 */

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  SESSION_AGENT_IDS,
  VAULT_ASSET_NAME_PATTERN,
  VAULT_FORMAT,
  parseVaultBodyLine,
  parseVaultHeader,
  type SessionAgentId,
  type SessionTitleSource,
  type VaultBodyLine,
  type VaultHeader,
} from '@agent-workbench/shared';
import { parseJsonlLine, readHeadLines } from '../jsonl-reader.js';
import { agentSessionsDir, assetsDir, isSafeSessionId, sessionFile, sessionsRoot } from './paths.js';

/** Tope de la cabecera. Un titulo y un medidor: 64 KB sobran. */
const HEADER_MAX_BYTES = 64 * 1024;
/** Cabeceras que se leen a la vez al cargar. */
const LOAD_CONCURRENCY = 16;

/** Lo que el indice necesita de una sesion de la copia. */
export interface VaultSummary {
  agent: SessionAgentId;
  sessionId: string;
  cwd: string;
  group: string;
  title: string;
  titleSource: SessionTitleSource;
  updatedAt: number;
  /** Bytes del `.jsonl` (sin assets). */
  sizeBytes: number;
  partial: boolean;
}

interface CatalogEntry {
  header: VaultHeader;
  sizeBytes: number;
  assetBytes: number;
}

type EntryRead =
  | { kind: 'listed'; entry: CatalogEntry }
  /** Cabecera de un formato que esta app no conoce: no se lista ni se pisa. */
  | { kind: 'foreign' }
  /** No esta, o no es una sesion valida de la copia. */
  | { kind: 'absent' };

const keyOf = (agent: string, sessionId: string): string => `${agent}/${sessionId}`;

function isSessionAgentId(value: string): value is SessionAgentId {
  return (SESSION_AGENT_IDS as readonly string[]).includes(value);
}

async function assetBytesOf(dir: string, agent: SessionAgentId, sessionId: string): Promise<number> {
  const folder = assetsDir(dir, agent, sessionId);
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return 0;
  }
  let total = 0;
  for (const name of names) {
    if (!VAULT_ASSET_NAME_PATTERN.test(name)) continue;
    try {
      const info = await stat(path.join(folder, name));
      if (info.isFile()) total += info.size;
    } catch {
      // Borrado mientras se contaba: no suma.
    }
  }
  return total;
}

async function readEntry(dir: string, agent: SessionAgentId, sessionId: string): Promise<EntryRead> {
  const file = sessionFile(dir, agent, sessionId);
  let sizeBytes: number;
  try {
    const info = await stat(file);
    if (!info.isFile()) return { kind: 'absent' };
    sizeBytes = info.size;
  } catch {
    return { kind: 'absent' };
  }

  let first: string | undefined;
  try {
    [first] = await readHeadLines(file, { maxLines: 1, maxBytes: HEADER_MAX_BYTES });
  } catch {
    return { kind: 'absent' };
  }
  const record = first === undefined ? null : parseJsonlLine(first);
  const header = parseVaultHeader(record);
  if (header === null) {
    const foreign = record !== null && record['kind'] === 'header' && record['format'] !== VAULT_FORMAT;
    return foreign ? { kind: 'foreign' } : { kind: 'absent' };
  }
  if (header.agent !== agent || header.sessionId !== sessionId) return { kind: 'absent' };

  return { kind: 'listed', entry: { header, sizeBytes, assetBytes: await assetBytesOf(dir, agent, sessionId) } };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const position = next;
      next += 1;
      results[position] = await run(items[position] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class VaultCatalog {
  private dir: string | null = null;
  private entries = new Map<string, CatalogEntry>();
  private foreign = new Set<string>();
  private summaryCache: readonly VaultSummary[] | null = null;
  /** Sube con cada `load`: una lectura que empezo contra otra carpeta no pisa la nueva. */
  private generation = 0;
  private readonly listeners = new Set<() => void>();

  /** La carpeta cargada, o null antes del primer `load`. */
  getDir(): string | null {
    return this.dir;
  }

  /**
   * Lee todas las cabeceras de `dir`. Una carpeta que no existe es una copia
   * vacia, no un error: es como arranca quien nunca la encendio. Avisa siempre.
   */
  async load(dir: string): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    this.dir = dir;

    const keys: { agent: SessionAgentId; sessionId: string }[] = [];
    let agentFolders: string[] = [];
    try {
      agentFolders = await readdir(sessionsRoot(dir));
    } catch {
      agentFolders = [];
    }
    for (const folder of agentFolders) {
      if (!isSessionAgentId(folder)) continue;
      let names: string[];
      try {
        names = await readdir(agentSessionsDir(dir, folder));
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith('.jsonl')) continue;
        const sessionId = name.slice(0, -'.jsonl'.length);
        if (isSafeSessionId(sessionId)) keys.push({ agent: folder, sessionId });
      }
    }

    const reads = await mapLimited(keys, LOAD_CONCURRENCY, (key) => readEntry(dir, key.agent, key.sessionId));
    if (generation !== this.generation) return;

    const entries = new Map<string, CatalogEntry>();
    const foreign = new Set<string>();
    keys.forEach((key, position) => {
      const read = reads[position];
      if (read?.kind === 'listed') entries.set(keyOf(key.agent, key.sessionId), read.entry);
      else if (read?.kind === 'foreign') foreign.add(keyOf(key.agent, key.sessionId));
    });
    this.entries = entries;
    this.foreign = foreign;
    this.summaryCache = null;
    this.emit();
  }

  /** Relee una sesion despues de escribirla. Avisa solo si cambio lo que se lista. */
  async refresh(agent: SessionAgentId, sessionId: string): Promise<void> {
    const dir = this.dir;
    if (dir === null || !isSafeSessionId(sessionId)) return;
    const generation = this.generation;
    const read = await readEntry(dir, agent, sessionId);
    if (generation !== this.generation) return;

    const key = keyOf(agent, sessionId);
    const before = JSON.stringify(this.entries.get(key) ?? null);
    const wasForeign = this.foreign.has(key);
    this.entries.delete(key);
    this.foreign.delete(key);
    if (read.kind === 'listed') this.entries.set(key, read.entry);
    else if (read.kind === 'foreign') this.foreign.add(key);

    if (before !== JSON.stringify(this.entries.get(key) ?? null) || wasForeign !== this.foreign.has(key)) {
      this.summaryCache = null;
      this.emit();
    }
  }

  /** Las sesiones listadas, en orden estable (fuente e id). */
  summaries(): readonly VaultSummary[] {
    if (this.summaryCache === null) {
      this.summaryCache = [...this.entries.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, { header, sizeBytes }]) => ({
          agent: header.agent,
          sessionId: header.sessionId,
          cwd: header.cwd,
          group: header.group,
          title: header.title,
          titleSource: header.titleSource,
          updatedAt: header.updatedAt,
          sizeBytes,
          partial: header.partial,
        }));
    }
    return this.summaryCache;
  }

  header(agent: SessionAgentId, sessionId: string): VaultHeader | null {
    return this.entries.get(keyOf(agent, sessionId))?.header ?? null;
  }

  /** true si en disco hay una copia de esa sesion con un formato que esta app no conoce. */
  hasForeignFormat(agent: SessionAgentId, sessionId: string): boolean {
    return this.foreign.has(keyOf(agent, sessionId));
  }

  /**
   * El cuerpo de una sesion listada, linea por linea: eventos y documentos.
   *
   * Nada si no esta en el catalogo —se busca por id, nunca por ruta— o si
   * mientras tanto el archivo dejo de ser esa sesion. Una linea que no parsea
   * se salta sola, sin llevarse el resto.
   */
  async *readBody(agent: SessionAgentId, sessionId: string): AsyncGenerator<VaultBodyLine> {
    for await (const line of this.bodyLines(agent, sessionId)) {
      const body = parseVaultBodyLine(parseJsonlLine(line));
      if (body !== null) yield body;
    }
  }

  /**
   * Las lineas del cuerpo sin parsear, despues de comprobar la cabecera: lo
   * que lee el buscador global (hito 29), que salta una linea enorme **antes**
   * de pagar el `JSON.parse`. Las mismas reglas que `readBody`, que se arma
   * sobre esto. Cortar el recorrido cierra el archivo.
   */
  async *bodyLines(agent: SessionAgentId, sessionId: string): AsyncGenerator<string> {
    const dir = this.dir;
    if (dir === null || !this.entries.has(keyOf(agent, sessionId))) return;

    // Se abre antes de armar el lector: un archivo borrado entre el catalogo y
    // la lectura falla aca, y no como un error del flujo que readline no reenvia.
    const handle = await open(sessionFile(dir, agent, sessionId), 'r').catch(() => null);
    if (handle === null) return;
    const input = handle.createReadStream({ encoding: 'utf8' });
    const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
    let sawHeader = false;
    try {
      for await (const raw of lines) {
        const line = raw.trim();
        if (line.length === 0) continue;
        if (!sawHeader) {
          const header = parseVaultHeader(parseJsonlLine(line));
          if (header === null || header.agent !== agent || header.sessionId !== sessionId) return;
          sawHeader = true;
          continue;
        }
        yield line;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  /**
   * Copias validas en disco y lo que ocupan, assets incluidos. `passSessions`
   * son las que escribio una pasada (fuente `native`): la unica escritura que
   * corre con la copia encendida. Un importador tambien deja sesiones y
   * `vault.json`, pero no encendio nada.
   */
  stats(): { sessions: number; bytes: number; passSessions: number } {
    let bytes = 0;
    let passSessions = 0;
    for (const entry of this.entries.values()) {
      bytes += entry.sizeBytes + entry.assetBytes;
      if (entry.header.source.kind === 'native') passSessions += 1;
    }
    return { sessions: this.entries.size, bytes, passSessions };
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.warn('[vault] a catalog listener threw:', error);
      }
    }
  }
}
