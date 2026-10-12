/**
 * Resumen de una sesion de Pi para la barra lateral, sin leerla entera.
 *
 * Cabeza y cola, como con las demas CLIs. La cabeza trae la primera linea
 * —`{"type":"session","id","cwd",…}`— y el primer mensaje del usuario, que es
 * el titulo; la cola, el ultimo `session_info`, que es el nombre que le puso
 * `/name` y gana sobre el mensaje (CLAUDE.md 16.3).
 *
 * El nombre no depende de la rama: medido, siguio valiendo con su entrada en
 * una rama abandonada (16.8). Por eso se toma el ultimo del archivo.
 *
 * **Una sesion se lista solo si el id de su primera linea es el del nombre del
 * archivo**: Pi la busca por el de adentro (`--session-id`), y una que no
 * casa no se podria reanudar por el nombre con el que aparece.
 */

import type { HistoryItem, ScannedSession } from '../adapter.js';
import { parseJsonlLine, readHeadLines, readTailLines } from '../../jsonl-reader.js';
import { toTitle, UNTITLED_SESSION_TITLE } from '../session-title.js';
import { TRANSPORT_LIMITS } from '../transport-limits.js';
import { readEntry, readHeader, type PiSessionHeader } from './session-entries.js';

/**
 * Cabeza que se lee. El archivo nace con cinco lineas —la cabecera, el modelo,
 * el nivel de razonamiento, el prompt del sistema (unos 6 KB) y el primer
 * mensaje—, pero un `!comando` anterior o un mensaje con mucho texto pegado lo
 * corren.
 */
export const PI_HEAD_MAX_LINES = 40;
export const PI_HEAD_MAX_BYTES = 512 * 1024;

/** Cola para el ultimo `session_info`. */
const TAIL_MAX_BYTES = 128 * 1024;

/** La primera linea de un archivo de sesion, o null si no es una cabecera. */
export async function readSessionHeader(file: string): Promise<PiSessionHeader | null> {
  const [first] = await readHeadLines(file, { maxLines: 1, maxBytes: 64 * 1024 });
  const record = first === undefined ? null : parseJsonlLine(first);
  return record === null ? null : readHeader(record);
}

/** El texto del primer mensaje del usuario entre esas lineas, o ''. */
function firstUserText(lines: readonly string[]): string {
  for (const [index, line] of lines.entries()) {
    const record = parseJsonlLine(line);
    const entry = record === null ? null : readEntry(record, index + 1, TRANSPORT_LIMITS);
    if (entry === null || entry.fact.kind !== 'user') continue;
    for (const part of entry.fact.parts) {
      if (part.kind === 'text' && part.text.trim().length > 0) return part.text;
    }
  }
  return '';
}

/** El ultimo nombre de `/name` entre esas lineas, o ''. */
function lastSessionName(lines: readonly string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    // Filtro barato: casi ninguna linea de la cola es esta, y algunas pesan mucho.
    if (line === undefined || !line.includes('"session_info"')) continue;
    const record = parseJsonlLine(line);
    const entry = record === null ? null : readEntry(record, index + 1, TRANSPORT_LIMITS);
    if (entry !== null && entry.fact.kind === 'info') return entry.fact.name;
  }
  return '';
}

/**
 * El resumen de una sesion, o null si el archivo no es una que se liste.
 * Lanza si no se puede leer: el indice salta ese item.
 */
export async function scanPiSession(item: HistoryItem): Promise<ScannedSession | null> {
  const found: { header: PiSessionHeader | null } = { header: null };
  const head = await readHeadLines(item.ref, {
    maxLines: PI_HEAD_MAX_LINES,
    maxBytes: PI_HEAD_MAX_BYTES,
    // Se decide con la primera linea: si no es una cabecera, no se lee mas.
    stopAfter: (line, index) => {
      if (index > 0) return false;
      const record = parseJsonlLine(line);
      found.header = record === null ? null : readHeader(record);
      return found.header === null;
    },
  });
  const header = found.header;
  if (header === null || header.sessionId !== item.sessionId) return null;

  const tail = await readTailLines(item.ref, { maxBytes: TAIL_MAX_BYTES });
  const name = toTitle(lastSessionName(tail) || lastSessionName(head));
  const first = name.length > 0 ? '' : toTitle(firstUserText(head));
  const title = name.length > 0 ? name : first;

  return {
    cwd: header.cwd,
    summary: {
      sessionId: item.sessionId,
      title: title.length > 0 ? title : UNTITLED_SESSION_TITLE,
      titleSource: name.length > 0 ? 'custom' : first.length > 0 ? 'first-message' : 'none',
      updatedAt: item.mtimeMs,
      sizeBytes: item.sizeBytes,
    },
    extra: {},
  };
}
