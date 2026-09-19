/**
 * Donde guarda Codex lo que esta app lee, y como se nombra.
 *
 * De la carpeta de Codex se leen **dos** subcarpetas y ninguna se escribe:
 * `sessions/AAAA/MM/DD/rollout-*.jsonl` y `archived_sessions/rollout-*.jsonl`.
 * `CODEX_HOME` entero no se lista nunca: ahi viven `auth.json` y las bases de
 * estado, y un `readdir` de esa carpeta ya es mirar lo que no hace falta
 * (regla 2.1).
 *
 * Todo se calcula en cada llamada, no al importar: el chequeo cambia
 * `CODEX_HOME` y el usuario puede arrancar el servidor con otro.
 */

import { homedir } from 'node:os';
import path from 'node:path';

/** Las sesiones que se listan: las que abrio una persona en la TUI o el editor. */
export const INTERACTIVE_SOURCES: readonly string[] = ['cli', 'vscode'];

/**
 * Los modos de historial que se leen. `legacy` es el de la 0.128; la TUI de la
 * 0.154 escribe `paginated` (medido en la verificacion de cierre del hito 25:
 * las sesiones nuevas de esta maquina, todas). Los dos traen los mismos
 * `response_item`; cambia de donde sale el mensaje del usuario
 * (`readUserMessageEvent`). Un modo que no se conoce no se lista.
 */
export const LISTED_HISTORY_MODES: readonly string[] = ['legacy', 'paginated'];

/**
 * `rollout-<AAAA-MM-DDTHH-MM-SS local>-<uuid>.jsonl`. Medido en 13 de 13.
 *
 * No acepta `.jsonl.zst` (compresion detras de una bandera apagada) ni la
 * forma `<uuid>_<rollout_id>` que la 0.154 usa para los hilos `paginated`: esos
 * formatos no se leen, y listarlos daria conversaciones vacias sin explicacion.
 */
export const ROLLOUT_FILE_PATTERN =
  /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cabeza que se lee de un rollout, al listarlo y al descubrirlo.
 *
 * La linea 0 pesa ~22 KB (trae las instrucciones de base) y el primer mensaje
 * del usuario va dos veces —en `message/user` y en `user_message`—: medido, esa
 * linea **termina** a 173–179 KB en 3 de 13 archivos. El megabyte deja margen
 * para un primer mensaje largo; las 40 lineas, para una version que escriba
 * mas lineas delante.
 */
export const ROLLOUT_HEAD_MAX_LINES = 40;
export const ROLLOUT_HEAD_MAX_BYTES = 1024 * 1024;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Valores de `CODEX_HOME` ya avisados, para no repetir el aviso en cada llamada. */
const warnedHomes = new Set<string>();

/**
 * true si la ruta no depende del `cwd` de nadie.
 *
 * En Windows `path.isAbsolute('\\codex')` es true, pero esa ruta cuelga de la
 * unidad actual: la de la pty puede no ser la del servidor. Se exige unidad o
 * UNC.
 */
function isFullyQualified(candidate: string): boolean {
  if (!path.isAbsolute(candidate)) return false;
  return process.platform !== 'win32' || /^([a-zA-Z]:[\\/]|[\\/]{2})/.test(candidate);
}

/**
 * La carpeta de Codex, o null si no se puede saber cual es.
 *
 * `CODEX_HOME` si esta definida y no vacia; si no, `~/.codex`. Una
 * `CODEX_HOME` relativa la resuelve Codex contra el `cwd` de su pty y esta app
 * contra el del servidor: serian dos carpetas distintas con el mismo nombre, y
 * leer la equivocada mostraria el historial de otro lado. Ahi no se lee nada y
 * se avisa una vez.
 */
export function codexHome(): string | null {
  const configured = process.env['CODEX_HOME'];
  if (configured === undefined || configured.length === 0) {
    return path.join(homedir(), '.codex');
  }
  if (isFullyQualified(configured)) return configured;
  if (!warnedHomes.has(configured)) {
    warnedHomes.add(configured);
    console.warn(
      `[codex] CODEX_HOME isn't an absolute path (${configured}): the Codex history isn't read.`,
    );
  }
  return null;
}

export function codexSessionsRoot(): string | null {
  const home = codexHome();
  return home === null ? null : path.join(home, 'sessions');
}

export function codexArchivedRoot(): string | null {
  const home = codexHome();
  return home === null ? null : path.join(home, 'archived_sessions');
}

export interface RolloutFileName {
  /** En minusculas. */
  sessionId: string;
  /** La hora local del nombre, al segundo, tal como la escribio Codex. */
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** Lo que dice el nombre de un rollout, o null si no es uno que se lea. */
export function parseRolloutFileName(name: string): RolloutFileName | null {
  const match = ROLLOUT_FILE_PATTERN.exec(name);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, id] = match;
  if (id === undefined) return null;
  return {
    sessionId: id.toLowerCase(),
    year: Number(year),
    month: Number(month),
    day: Number(day),
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
  };
}

/**
 * La marca de tiempo de un uuid v7, en epoch ms, o null si no es v7.
 *
 * Codex pone ids v7: los primeros 48 bits son los milisegundos de creacion.
 * Medido, quedan entre 20 y 1070 ms antes de `session_meta.payload.timestamp`.
 */
export function uuidV7Millis(id: string): number | null {
  if (!isUuid(id)) return null;
  if (id.charAt(14) !== '7') return null;
  return Number.parseInt(id.replace(/-/g, '').slice(0, 12), 16);
}

/**
 * `<root>/AAAA/MM/DD` del dia **local** de `epochMs`.
 *
 * Local porque asi arma Codex la carpeta (`now_local()` al crear el hilo): con
 * la fecha UTC, una sesion de las 22 h en UTC-3 se buscaria en la
 * carpeta del dia siguiente.
 */
export function localDayFolder(root: string, epochMs: number): string {
  const date = new Date(epochMs);
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return path.join(root, year, month, day);
}

/**
 * Las carpetas de dia que cubren `[fromMs, toMs]`, sin repetir.
 *
 * Se recorre por dia de calendario y no sumando 24 h: con un cambio de horario
 * un dia dura 23 o 25 horas, y sumar 24 h desde las 00:30 puede saltarse uno.
 */
export function localDayFolders(root: string, fromMs: number, toMs: number): string[] {
  const folders: string[] = [];
  const cursor = new Date(fromMs);
  cursor.setHours(12, 0, 0, 0);
  const end = new Date(toMs);
  end.setHours(12, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    const folder = localDayFolder(root, cursor.getTime());
    if (!folders.includes(folder)) folders.push(folder);
    cursor.setDate(cursor.getDate() + 1);
  }
  return folders;
}
