/**
 * El historial de OpenCode: las sesiones raiz de su base SQLite.
 *
 * Solo lectura, y solo `session`, `message` y `part` (§2 de la especificacion
 * del hito 26). La base no es un archivo por sesion, y eso cambia tres cosas
 * respecto de Claude Code y Codex:
 *
 *  - **La ref de cada sesion es su id**, y la raiz del watcher es la base
 *    entera, con su propio aviso (`HistoryRoot.watch`, sondeo de `stat` en
 *    `db-signal.ts`): un watcher de archivos sobre una base que otro proceso
 *    mantiene abierta avisa tarde o nunca.
 *  - **"Que sesiones cambiaron" se pregunta** (`changedRefs`): la foto
 *    `id -> time_updated` de las raices contra la anterior. Nuevas, cambiadas y
 *    borradas, en ese orden. Un cursor global no veria las borradas.
 *  - **`updatedAt` es `session.time_updated`.** Medido: es mayor o igual que la
 *    hora del ultimo mensaje en 295 de 295 sesiones, asi que un mensaje nuevo
 *    siempre toca la sesion y el indice no lee `message` para ordenar.
 *
 * Lo que no se lista: los sub-agentes (`parent_id` no nulo; 76 de 295, medido),
 * que no se pueden reanudar solos, y desde el hito 29 las raices sin mensajes y
 * con el titulo por defecto, que es como quedan las que crea la app por API al
 * abrir una pestana (D14). `time_archived` se ignora: la barra no podria
 * desarchivar sin escribir la base, y el archivado propio de la app sigue
 * sirviendo.
 *
 * Una base ilegible un instante (ocupada, a medio reemplazar) no es una base
 * vacia: `list` da null y `changedRefs` una lista vacia, y nada se borra de la
 * barra por eso. Tampoco si falla despues de `changedRefs`, al leer una de las
 * sesiones que dio: `item` y `scan` **lanzan** en vez de dar null —null es "no
 * esta" o "no se lista", y el indice la quitaria— y la sesion vuelve en la
 * proxima respuesta de `changedRefs`, que ya la habia dado por vista.
 */

import { stat } from 'node:fs/promises';
import type { SessionTitleSource } from '@agent-workbench/shared';
import type {
  FollowOptions,
  HistoryItem,
  HistoryRoot,
  HistorySource,
  ScannedSession,
  SessionFollower,
} from '../adapter.js';
import { toTitle, UNTITLED_SESSION_TITLE } from '../session-title.js';
import type { SqliteLoad } from '../sqlite.js';
import type { ContextWindowLookup, OpenCodeDatabase } from './session-follower.js';
import { OpenCodeSessionFollower } from './session-follower.js';
import {
  OPENCODE_SQL,
  type FirstUserTextRow,
  type FoundRow,
  type RootRow,
  type RootStampRow,
  type SessionRow,
} from './sql.js';

/** Los titulos que pone OpenCode mientras no genero uno: no dicen nada. */
export const DEFAULT_TITLE_PATTERN = /^(New session|Child session) - \d{4}-\d{2}-\d{2}T[\d:.]+Z$/;

export interface OpenCodeHistoryDeps {
  /** La base, o null si no hay nada que leer (`OPENCODE_DB=:memory:`). */
  dbFile: string | null;
  db: OpenCodeDatabase;
  /** El aviso de cambios de la base. */
  signal: { subscribe(listener: () => void): () => void };
  catalog: ContextWindowLookup;
  platform: string;
  /** De donde sale `node:sqlite`: sin modulo no se declara raiz. */
  sqlite: () => SqliteLoad;
  /** Para el aviso unico de una raiz sin mensajes. */
  warn?: (message: string) => void;
}

/**
 * La ruta tal como la escribe OpenCode, con los separadores del sistema.
 *
 * Medido: las 295 sesiones guardan `directory` con `/` (`D:/Mi App`). En Windows
 * se entrega `D:\Mi App`, solo cambiando separadores y sin barras finales salvo
 * en la raiz de una unidad: si no, la cabecera y el `cwd` de la pestana saldrian
 * con `/`. No es reconstruir una ruta (§4.1 de CLAUDE.md), es la misma con otro
 * separador. En los demas sistemas, tal cual. Vacia: null.
 */
export function nativeCwd(directory: string, platform: string): string | null {
  if (directory.length === 0) return null;
  if (platform !== 'win32' || !/^([a-zA-Z]:[\\/]|[\\/]{2})/.test(directory)) return directory;
  let native = directory.replace(/\//g, '\\');
  while (native.endsWith('\\') && !/^[a-zA-Z]:\\$/.test(native) && native.length > 2) {
    native = native.slice(0, -1);
  }
  return native;
}

const itemOf = (row: { id: string; directory: string; time_updated: number }): HistoryItem => ({
  ref: row.id,
  sessionId: row.id,
  /*
    El grupo es la carpeta tal como la escribio OpenCode, o la propia sesion si
    no tiene: el indice le presta el `cwd` del grupo a una sesion que no trae, y
    un grupo unico para toda la base se lo prestaria de otro proyecto.
  */
  group: row.directory.length > 0 ? row.directory : row.id,
  mtimeMs: row.time_updated,
  // No se muestra en ningun lado, y medirlo exigiria leer `part` entera.
  sizeBytes: 0,
});

export function createOpenCodeHistory(deps: OpenCodeHistoryDeps): HistorySource {
  const { dbFile, db } = deps;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  /** La foto de las raices de la ultima lectura, para `changedRefs`. null: todavia ninguna. */
  let stamps: Map<string, number> | null = null;
  /**
   * Las refs que no se pudieron leer despues de que la foto las diera por
   * vistas. Van otra vez en la proxima respuesta de `changedRefs`: si no, una
   * sesion que el indice conservo sin releer quedaria vieja hasta su proximo
   * cambio.
   */
  const retry = new Set<string>();
  let warnedWithoutMessages = false;

  /** true si la base se puede consultar ahora (o todavia no se intento y el archivo esta). */
  const readable = (): boolean => db.status() === 'ok' || db.status() === 'error';

  /**
   * La fila de una sesion, o undefined si no esta. Lanza si la base no se pudo
   * leer, tambien cuando la consulta no fallo pero la base dejo de leerse (una
   * columna que falta): ahi undefined no diria que la sesion no esta.
   */
  const sessionRow = (ref: string): SessionRow | undefined => {
    const row = db.get<SessionRow>(OPENCODE_SQL.sessionById, ref);
    if (db.status() !== 'ok') throw new Error(`the OpenCode database couldn't be read (${db.status()})`);
    return row;
  };

  /** Anota la ref para reintentarla y relanza. */
  const unreadable = (ref: string, error: unknown): never => {
    retry.add(ref);
    throw error;
  };

  const scanRow = (item: HistoryItem): ScannedSession | null => {
    const row = sessionRow(item.ref);
    // Borrada entre el listado y esta lectura: no esta, y eso no es un error.
    if (row === undefined || row.parent_id !== null) return null;

    const defaultTitle = DEFAULT_TITLE_PATTERN.test(row.title);
    const hasMessages = db.get<FoundRow>(OPENCODE_SQL.sessionHasMessages, row.id) !== undefined;
    // Sin la base legible, "sin mensajes" no dice nada: null la sacaria de la barra.
    if (db.status() !== 'ok') throw new Error(`the OpenCode database couldn't be read (${db.status()})`);
    if (!hasMessages) {
      /*
        Hito 29 (D14): cada pestana nueva crea su sesion por API antes de
        lanzar, y la sesion queda vacia hasta el primer mensaje —o para
        siempre, si se cierra sin escribir—. Esa no se lista, como una de
        Claude Code que no llego a escribir su archivo. Tampoco se borra: seria
        una segunda escritura destructiva de la app. En cuanto recibe un
        mensaje cambia `time_updated`, `changedRefs` la da y se lista.
      */
      if (defaultTitle) return null;
      /*
        Una sin mensajes pero con titulo propio no la creo la app. Es el rastro
        del dia que OpenCode mude los mensajes a otra tabla: hoy hay
        `session_message` con cambios de modelo y de agente, y 0 raices sin
        mensajes (critica M6 del hito 26). Una vez por arranque.
      */
      if (!warnedWithoutMessages) {
        warnedWithoutMessages = true;
        warn('[opencode] some sessions have no rows in the message table: their conversation may look empty. If it happens with a session that has messages, OpenCode changed where it stores them.');
      }
    }

    let title: string;
    let titleSource: SessionTitleSource;
    if (defaultTitle) {
      const first = db.get<FirstUserTextRow>(OPENCODE_SQL.firstUserText, row.id)?.text ?? null;
      title = first === null ? '' : toTitle(first);
      titleSource = 'first-message';
    } else {
      // OpenCode genera los titulos, y uno renombrado no se distingue de uno generado.
      title = toTitle(row.title);
      titleSource = 'ai';
    }
    if (title.length === 0) {
      // Lo mismo que dicen las otras CLIs: una fila vacia en la barra no se puede leer.
      title = UNTITLED_SESSION_TITLE;
      titleSource = 'none';
    }

    return {
      cwd: nativeCwd(row.directory, deps.platform),
      summary: {
        sessionId: row.id,
        title,
        titleSource,
        updatedAt: row.time_updated,
        sizeBytes: 0,
      },
      extra: {},
    };
  };

  return {
    /*
      La raiz se declara aunque la base no exista todavia: OpenCode la crea con
      su primera sesion, y el sondeo la ve nacer. Sin `node:sqlite` no hay nada
      que avisar.
    */
    roots(): readonly HistoryRoot[] {
      if (dbFile === null || 'unavailable' in deps.sqlite()) return [];
      return [
        {
          path: dbFile,
          depth: 0,
          accepts: (filePath) => filePath === dbFile,
          awaitWriteFinish: false,
          watch: (onChange) => deps.signal.subscribe(() => onChange(dbFile)),
        },
      ];
    },

    async list(): Promise<HistoryItem[] | null> {
      if (dbFile === null || !readable()) return null;
      try {
        const rows = db.all<RootRow>(OPENCODE_SQL.listRoots);
        // La primera consulta es la que descubre una base sin las columnas que se leen.
        if (db.status() !== 'ok') return null;
        stamps = new Map(rows.map((row) => [row.id, row.time_updated]));
        return rows.map(itemOf);
      } catch (error) {
        // El indice no atrapa: una base ocupada no puede tumbar el escaneo de las demas CLIs.
        warn(`[opencode] couldn't list the history: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    },

    async changedRefs(filePath: string): Promise<readonly string[] | null> {
      if (dbFile === null || filePath !== dbFile) return null;
      if (!readable()) return [];
      let rows: RootStampRow[];
      try {
        rows = db.all<RootStampRow>(OPENCODE_SQL.rootStamps);
      } catch {
        return [];
      }
      if (db.status() !== 'ok') return [];

      const previous = stamps ?? new Map<string, number>();
      const current = new Map(rows.map((row) => [row.id, row.time_updated]));
      const added: string[] = [];
      const changed: string[] = [];
      for (const [id, updated] of current) {
        const before = previous.get(id);
        if (before === undefined) added.push(id);
        else if (before !== updated) changed.push(id);
      }
      const removed = [...previous.keys()].filter((id) => !current.has(id));
      stamps = current;
      const listed = new Set([...added, ...changed, ...removed]);
      const again = [...retry].filter((id) => !listed.has(id));
      retry.clear();
      return [...added, ...changed, ...removed, ...again];
    },

    async item(ref: string): Promise<HistoryItem | null> {
      if (dbFile === null) return null;
      let row: SessionRow | undefined;
      try {
        row = sessionRow(ref);
      } catch (error) {
        return unreadable(ref, error);
      }
      if (row === undefined || row.parent_id !== null) return null;
      return itemOf(row);
    },

    async scan(item: HistoryItem): Promise<ScannedSession | null> {
      try {
        return scanRow(item);
      } catch (error) {
        return unreadable(item.ref, error);
      }
    },

    // OpenCode no aprende nada de la instalacion al leer una sesion.
    restored: () => undefined,

    /**
     * true si la sesion esta en la base. Con la base ilegible, true: ante la duda
     * se intenta `-s <id>` y la CLI dice si no esta, en vez de abrir callada una
     * sesion nueva. Sin base, false.
     */
    async exists(_cwd: string, sessionId: string): Promise<boolean> {
      if (dbFile === null || db.status() === 'missing') return false;
      if (!readable()) return true;
      try {
        const found = db.get<FoundRow>(OPENCODE_SQL.sessionExists, sessionId);
        if (db.status() !== 'ok') return true;
        return found !== undefined;
      } catch {
        return true;
      }
    },

    /**
     * true si el archivo de la base esta. Es lo que separa las dos razones por
     * las que `list` da null: sin base (no hay historial) o con la base ocupada
     * o ilegible (lo hay, pero ahora no se lee). Solo `stat`: no abre la base.
     */
    async rootExists(): Promise<boolean> {
      if (dbFile === null) return false;
      try {
        await stat(dbFile);
        return true;
      } catch {
        return false;
      }
    },

    follow(target: { cwd: string; sessionId: string }, options?: FollowOptions): SessionFollower {
      return new OpenCodeSessionFollower({
        db,
        catalog: deps.catalog,
        sessionId: target.sessionId,
        dbFile,
        limits: options?.limits,
        maxEvents: options?.maxEvents,
      });
    },

    // `follow` respeta `FollowOptions`, tambien en los cortes de SQL (hito 28).
    wholeRead: true,

    plans: null,

    /*
      Sin relectura periodica: el aviso de la base ya es un sondeo propio cada
      500 ms (`db-signal.ts`) y llega al hub por el watcher, tambien con el
      escritor abierto (medido: el `-wal` cambia de fecha en 60 de 60 commits).
    */
    followPollMs: null,
  };
}
