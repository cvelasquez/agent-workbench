/**
 * Resumen de un rollout de Codex para la barra lateral, sin leerlo entero.
 *
 * Cabeza y cola, como con Claude Code: la cabeza trae la `session_meta` (linea
 * 0) y el primer mensaje del usuario, que es el titulo; la cola, el ultimo
 * `turn_context`, que dice en que carpeta se reanuda.
 *
 * **No toda sesion se lista** (C16 de la especificacion del hito 25):
 *
 *  - Solo las que abrio una persona (`source` `cli` o `vscode`). Las `exec` las
 *    lanza otra app y `codex resume` tampoco las ofrece.
 *  - Solo `history_mode` ausente, `legacy` o `paginated` (el de la TUI de la
 *    0.154). Un modo que no se conoce no se lista: los mensajes podrian no
 *    escribirse asi, y la conversacion saldria vacia sin explicacion.
 *  - Solo si el id del nombre es el de la `session_meta`: el que no casa no es
 *    un rollout que se pueda reanudar por su nombre.
 */

import type { HistoryItem, ScannedSession } from '../adapter.js';
import { parseJsonlLine, readHeadLines, readTailLines } from '../../jsonl-reader.js';
import { debugLog } from '../../debug.js';
import { toTitle, UNTITLED_SESSION_TITLE } from '../session-title.js';
import {
  INTERACTIVE_SOURCES,
  LISTED_HISTORY_MODES,
  ROLLOUT_HEAD_MAX_BYTES,
  ROLLOUT_HEAD_MAX_LINES,
} from './paths.js';
import {
  readSessionMeta,
  readTurnContext,
  readUserMessageEvent,
  stripImageLabels,
  type SessionMeta,
} from './rollout-lines.js';

/** Cola para el ultimo `turn_context`: hay uno por turno. */
const TAIL_MAX_BYTES = 256 * 1024;

/** `payload` de una linea con ese `type` (y ese `payload.type`, si se da). */
function payloadOf(line: string, type: string, kind?: string): Record<string, unknown> | null {
  const record = parseJsonlLine(line);
  if (record === null || record['type'] !== type) return null;
  const payload = record['payload'];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (kind !== undefined && value['type'] !== kind) return null;
  return value;
}

/**
 * El resumen de un rollout, o null si no es una sesion que se liste.
 * Lanza si el archivo no se puede leer: el indice salta ese item.
 */
/** La `session_meta` de la linea 0, si es la de una sesion que se lista. */
function listableMeta(line: string, item: HistoryItem): SessionMeta | null {
  const metaPayload = payloadOf(line, 'session_meta');
  const meta = metaPayload === null ? null : readSessionMeta(metaPayload);
  if (meta === null) return null;
  if (meta.id.toLowerCase() !== item.sessionId.toLowerCase()) return null;
  if (typeof meta.source !== 'string' || !INTERACTIVE_SOURCES.includes(meta.source)) return null;
  if (meta.historyMode !== null && !LISTED_HISTORY_MODES.includes(meta.historyMode)) {
    debugLog('indice', `rollout de codex ${item.sessionId.slice(0, 8)} en modo ${meta.historyMode}: no se lista`);
    return null;
  }
  if (meta.cwd.length === 0) return null;
  return meta;
}

export async function scanRollout(item: HistoryItem): Promise<ScannedSession | null> {
  /*
    Se decide con la linea 0 y, si no se lista, no se lee nada mas. El null no
    se cachea (el indice lo vuelve a mirar en cada arranque y con cada aviso del
    watcher), y las `exec` de otra app pueden ser miles: leerles la cabeza entera
    —hasta 1 MB cada una— para tirarla era el costo, no la linea 0 de ~22 KB.
  */
  const found: { meta: SessionMeta | null } = { meta: null };
  const head = await readHeadLines(item.ref, {
    maxLines: ROLLOUT_HEAD_MAX_LINES,
    maxBytes: ROLLOUT_HEAD_MAX_BYTES,
    stopAfter: (line, index) => {
      if (index > 0) return false;
      found.meta = listableMeta(line, item);
      return found.meta === null;
    },
  });
  const meta = found.meta;
  if (meta === null) return null;

  let title = '';
  for (const line of head) {
    const payload = payloadOf(line, 'event_msg');
    const message = payload === null ? null : readUserMessageEvent(payload);
    if (message === null) continue;
    title = toTitle(stripImageLabels(message.message, Number.POSITIVE_INFINITY));
    break;
  }

  let resumeCwd: string | null = null;
  const tail = await readTailLines(item.ref, { maxBytes: TAIL_MAX_BYTES });
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const line = tail[index];
    const payload = line === undefined ? null : payloadOf(line, 'turn_context');
    const cwd = payload === null ? null : readTurnContext(payload)?.cwd ?? null;
    if (cwd !== null) {
      resumeCwd = cwd;
      break;
    }
  }

  return {
    cwd: meta.cwd,
    resumeCwd: resumeCwd !== null && resumeCwd !== meta.cwd ? resumeCwd : null,
    summary: {
      sessionId: item.sessionId,
      // Sin texto, lo mismo que dice una de Claude Code: una fila vacia en la barra no se puede leer.
      title: title.length > 0 ? title : UNTITLED_SESSION_TITLE,
      titleSource: title.length > 0 ? 'first-message' : 'none',
      updatedAt: item.mtimeMs,
      sizeBytes: item.sizeBytes,
    },
    extra: {},
  };
}
