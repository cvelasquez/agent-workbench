/**
 * Una base SQLite ajena, abierta en solo lectura.
 *
 * Generico: no nombra ninguna CLI. Lo usa la que guarda su historial en una
 * base compartida en vez de un archivo por sesion (hito 26).
 *
 * `node:sqlite` y no `better-sqlite3`: viene con Node desde la 22.13 y no suma
 * un modulo nativo que compilar. En un Node anterior no esta —o esta detras de
 * una bandera y sin solo lectura, que es peor—, y ahi la base simplemente no se
 * lee: el resto de la app funciona igual.
 *
 * Cuatro cosas que no son evidentes, medidas sobre una base de prueba con la
 * 22.14 (SQLite 3.47.2):
 *
 *  - **Abrir en solo lectura no crea nada, pero la primera lectura crea `-wal`
 *    y `-shm`** si no existen. Es la semantica de WAL, y evitarla exige
 *    `immutable=1`, que deja de ver lo que el escritor confirma. Por eso un
 *    archivo que no existe **no se abre**: abrirlo fallaria igual, y no hay que
 *    dejar nada al lado.
 *  - **Un lector abierto ve lo que otro proceso confirma sin reabrir**, pero
 *    mientras esta abierto el escritor no puede borrar el `-wal` al cerrar, y en
 *    Windows no puede reemplazar la base. Por eso la conexion se cierra sola
 *    despues de un rato sin consultas y se reabre en la siguiente.
 *  - **Todo es sincrono y bloquea el servidor entero.** De ahi `busy_timeout`
 *    corto, y `all()` en vez de `iterate()`: un iterador vivo mantiene abierta
 *    la transaccion de lectura y retiene el WAL.
 *  - **El esquema es de otro y cambia con sus versiones.** Al abrir se comprueba
 *    que esten las columnas que se leen; si falta una, la base se deja de leer
 *    hasta reiniciar, con un aviso. Lo que sobra no importa.
 */

import { existsSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue, StatementSync } from 'node:sqlite';

/** Desde que version `node:sqlite` esta sin bandera. */
export const NODE_SQLITE_MIN_VERSION = '22.13';

/**
 * true si esta version de Node trae `node:sqlite` sin bandera: 22.13 o
 * posterior en la linea 22, 23.4 o posterior en la 23, y toda la 24 en adelante.
 *
 * No es cosmetico. Antes de eso el modulo existe detras de
 * `--experimental-sqlite`, y hasta la 22.12 y la 23.1 **su constructor ignora
 * `readOnly` sin avisar**: la base ajena se abriria en lectura y escritura, y al
 * cerrar la ultima conexion SQLite vuelca el `-wal` en la base. Medido en la
 * 22.14 con una conexion sin `readOnly` que solo lee: la base paso de 4 KB a
 * 108 KB y el `-wal` desaparecio. Por eso se mira la version antes de pedir el
 * modulo, y una que no se entiende cuenta como vieja.
 */
export function nodeHasUnflaggedSqlite(nodeVersion: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(nodeVersion);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}

export type SqliteUnavailableReason = 'node-too-old';

export interface SqliteModule {
  DatabaseSync: typeof DatabaseSync;
}

export type SqliteLoad = SqliteModule | { unavailable: SqliteUnavailableReason };

/** El texto que se muestra cuando `node:sqlite` no esta. `label` es el nombre de la CLI. */
export function sqliteUnavailableText(label: string, nodeVersion: string = process.version): string {
  return `this Node version (${nodeVersion}) has no node:sqlite; the ${label} history needs Node ${NODE_SQLITE_MIN_VERSION} or later.`;
}

/**
 * true si lo que se va a emitir es el aviso experimental de SQLite.
 *
 * `process.emitWarning` acepta `(texto, tipo)`, `(texto, { type })` y un
 * `Error` cuyo nombre es el tipo: se miran las tres formas.
 */
function isSqliteExperimentalWarning(warning: unknown, typeOrOptions: unknown): boolean {
  let type = 'Warning';
  let message: string;
  if (warning instanceof Error) {
    type = warning.name;
    message = warning.message;
  } else {
    message = String(warning);
    if (typeof typeOrOptions === 'string') {
      type = typeOrOptions;
    } else if (typeof typeOrOptions === 'object' && typeOrOptions !== null) {
      const declared = (typeOrOptions as { type?: unknown }).type;
      if (typeof declared === 'string') type = declared;
    }
  }
  return type === 'ExperimentalWarning' && message.includes('SQLite');
}

/**
 * `node:sqlite` a partir de un cargador de modulos internos. Separado de
 * `loadSqlite` para que el chequeo pruebe el caso sin modulo en una version de
 * Node que si lo trae.
 *
 * Mientras dura la llamada, `process.emitWarning` descarta **solo** el aviso
 * experimental de SQLite, y se restaura en el `finally`. Una bandera
 * `--disable-warning` no sirve: `pnpm dev` pasa por tsx y el paquete de npm
 * arranca con un shebang, y en ninguno de los dos hay forma portable de
 * pasarla. El aviso sale al cargar el modulo, una sola vez por proceso.
 *
 * `nodeVersion` es inyectable para que el chequeo pruebe una version vieja con
 * un cargador que igual devuelve el modulo, que es el caso de la bandera.
 */
export function loadSqliteFrom(
  getBuiltinModule: ((id: string) => unknown) | undefined,
  nodeVersion: string = process.versions.node,
): SqliteLoad {
  const unavailable: SqliteLoad = { unavailable: 'node-too-old' };
  // Con la bandera el modulo carga, pero sin `readOnly`: ni se pide.
  if (!nodeHasUnflaggedSqlite(nodeVersion)) return unavailable;
  // Antes de la 20.16 y la 22.3 ni siquiera existe el cargador.
  if (typeof getBuiltinModule !== 'function') return unavailable;

  const original = process.emitWarning;
  const filtered = (...args: unknown[]): void => {
    if (isSqliteExperimentalWarning(args[0], args[1])) return;
    Reflect.apply(original, process, args);
  };
  process.emitWarning = filtered as typeof process.emitWarning;
  try {
    // La version ya se comprobo; esto cubre un Node que la reporta y no lo trae.
    const loaded = getBuiltinModule('node:sqlite') as Partial<SqliteModule> | undefined;
    if (loaded === undefined || loaded === null || typeof loaded.DatabaseSync !== 'function') return unavailable;
    return { DatabaseSync: loaded.DatabaseSync };
  } catch {
    return unavailable;
  } finally {
    process.emitWarning = original;
  }
}

let loadedOnce: SqliteLoad | null = null;

/** `node:sqlite`, o el motivo por el que no esta. Se pide una vez por proceso. */
export function loadSqlite(): SqliteLoad {
  if (loadedOnce === null) {
    const getBuiltinModule = typeof process.getBuiltinModule === 'function'
      ? (id: string): unknown => process.getBuiltinModule(id)
      : undefined;
    loadedOnce = loadSqliteFrom(getBuiltinModule);
  }
  return loadedOnce;
}

export interface ColumnRequirement {
  table: string;
  columns: readonly string[];
}

/**
 * - `ok`: se puede leer (o todavia no se intento y el archivo existe).
 * - `missing`: el archivo no existe. Se vuelve a mirar en cada consulta.
 * - `no-sqlite`: este Node no trae `node:sqlite`.
 * - `schema`: falta una columna que se lee. Hasta reiniciar.
 * - `error`: fallo la apertura o la ultima consulta. Se reintenta en la siguiente.
 */
export type ReadOnlyDatabaseStatus = 'ok' | 'missing' | 'no-sqlite' | 'schema' | 'error';

/** Un parametro de una sentencia: posicional, o un objeto con los nombrados. */
export type SqlParam = SQLInputValue | Record<string, SQLInputValue>;

export interface ReadOnlyDatabaseOptions {
  /** Cuanto sin consultas antes de cerrar la conexion. */
  idleCloseMs: number;
  /** Columnas sin las que no se lee nada. */
  required: readonly ColumnRequirement[];
  /** Para los avisos: el nombre de la CLI. */
  label: string;
  /** Para el chequeo: de donde sale `node:sqlite`. */
  sqlite?: () => SqliteLoad;
}

/**
 * Espera maxima de una consulta a que el escritor suelte la base. Corta a
 * proposito: la llamada es sincrona y el servidor entero espera con ella.
 */
const BUSY_TIMEOUT_MS = 250;

/** Las columnas de las tablas pedidas. Constante: la lista de tablas va como JSON. */
const SCHEMA_PROBE_SQL =
  "SELECT m.name AS table_name, p.name AS column_name FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN (SELECT value FROM json_each(?))";

/** SQLITE_BUSY, con o sin codigo extendido. */
function isBusy(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { errcode?: unknown }).errcode;
  if (typeof code === 'number') return (code & 0xff) === 5;
  return error instanceof Error && /database is locked/i.test(error.message);
}

export class ReadOnlyDatabase {
  private connection: DatabaseSync | null = null;
  private readonly statements = new Map<string, StatementSync>();
  /** null: todavia no se intento abrir. */
  private state: ReadOnlyDatabaseStatus | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private warnedNoSqlite = false;

  constructor(
    private readonly file: string,
    private readonly options: ReadOnlyDatabaseOptions,
  ) {}

  private load(): SqliteLoad {
    return (this.options.sqlite ?? loadSqlite)();
  }

  /**
   * Barato y sin abrir nada: antes de la primera consulta dice si el archivo
   * esta, no si se puede leer.
   */
  status(): ReadOnlyDatabaseStatus {
    if (this.state !== null) return this.state;
    if ('unavailable' in this.load()) return 'no-sqlite';
    return existsSync(this.file) ? 'ok' : 'missing';
  }

  /** Prepara (cacheado por texto) y devuelve todas las filas. Nunca `iterate()`. */
  all<T>(sql: string, ...params: SqlParam[]): T[] {
    const db = this.connect();
    if (db === null) return [];
    return this.run(db, sql, (statement) => Reflect.apply(statement.all, statement, params) as T[]);
  }

  get<T>(sql: string, ...params: SqlParam[]): T | undefined {
    const db = this.connect();
    if (db === null) return undefined;
    return this.run(db, sql, (statement) => Reflect.apply(statement.get, statement, params) as T | undefined);
  }

  /** Cierra la conexion. La proxima consulta la reabre, salvo tras `schema`. */
  close(): void {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.statements.clear();
    const connection = this.connection;
    this.connection = null;
    if (connection !== null) {
      try {
        connection.close();
      } catch {
        // Ya cerrada: no hay nada que soltar.
      }
    }
  }

  private run<R>(db: DatabaseSync, sql: string, read: (statement: StatementSync) => R): R {
    this.touch();
    try {
      let statement = this.statements.get(sql);
      if (statement === undefined) {
        statement = db.prepare(sql);
        this.statements.set(sql, statement);
      }
      return read(statement);
    } catch (error) {
      // Una base ocupada un instante no es una base rota.
      if (!isBusy(error)) {
        this.state = 'error';
        this.close();
      }
      throw error;
    }
  }

  /** La conexion, abriendola si hace falta. null: no hay nada que leer. */
  private connect(): DatabaseSync | null {
    if (this.state === 'schema') return null;
    if (this.connection !== null) return this.connection;

    const sqlite = this.load();
    if ('unavailable' in sqlite) {
      this.state = 'no-sqlite';
      if (!this.warnedNoSqlite) {
        this.warnedNoSqlite = true;
        console.warn(`[${this.options.label}] ${sqliteUnavailableText(this.options.label)}`);
      }
      return null;
    }
    if (!existsSync(this.file)) {
      this.state = 'missing';
      return null;
    }

    let db: DatabaseSync;
    try {
      db = new sqlite.DatabaseSync(this.file, { readOnly: true });
    } catch (error) {
      if (!isBusy(error)) this.state = 'error';
      throw error;
    }

    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const missing = this.missingColumn(db);
      if (missing !== null) {
        db.close();
        this.state = 'schema';
        console.warn(
          `[${this.options.label}] ${this.file} is missing the column ${missing.table}.${missing.column}: it isn't read until a restart.`,
        );
        return null;
      }
    } catch (error) {
      try {
        db.close();
      } catch {
        // Nada que soltar.
      }
      if (!isBusy(error)) this.state = 'error';
      throw error;
    }

    this.connection = db;
    this.state = 'ok';
    return db;
  }

  private missingColumn(db: DatabaseSync): { table: string; column: string } | null {
    const tables = this.options.required.map((requirement) => requirement.table);
    if (tables.length === 0) return null;
    const rows = db.prepare(SCHEMA_PROBE_SQL).all(JSON.stringify(tables));
    const present = new Set(rows.map((row) => `${String(row['table_name'])}.${String(row['column_name'])}`));
    for (const requirement of this.options.required) {
      for (const column of requirement.columns) {
        if (!present.has(`${requirement.table}.${column}`)) return { table: requirement.table, column };
      }
    }
    return null;
  }

  /** Reinicia el cierre por inactividad. Sin `unref`, un script que la use no termina. */
  private touch(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.close();
    }, this.options.idleCloseMs);
    this.idleTimer.unref();
  }
}
