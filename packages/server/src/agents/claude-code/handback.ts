/**
 * El mensaje que Claude Code deshace cuando se lo detiene antes de que el
 * agente haga nada (hito 44, §4.16).
 *
 * Medido con la 2.1.301 (`docs/herramientas/claude-rewind/`, c01 a c10):
 *
 *  - Con un Esc antes de cualquier salida del agente, la CLI saca el mensaje de
 *    la conversacion y lo devuelve a **su** caja. No escribe nada: el mensaje
 *    queda en el JSONL, sin respuesta, y el siguiente cuelga de antes de el.
 *  - Con algo ya escrito (razonamiento, texto o una herramienta), deja el
 *    mensaje y escribe `[Request interrupted by user]`. No devuelve nada.
 *  - Un mensaje mandado con el agente trabajando tampoco vuelve: al
 *    interrumpir, la CLI lo manda como turno nuevo, y su linea se escribe
 *    **despues** del Esc.
 *
 * Por eso un mensaje se da por devuelto solo si:
 *
 *  1. no cuelga de la marca de interrupcion (el de la cola si: la CLI lo manda
 *     como turno nuevo detras de ella, medido en c10), y su linea no es de
 *     bastante despues del Esc (`HOUR_SLACK_MS`: con la maquina cargada, la
 *     CLI fecho el mensaje unos milisegundos despues del Esc de la app, en la
 *     prueba en vivo),
 *  2. despues de ella no hay ninguna linea del asistente ni del usuario (solo
 *     adjuntos y avisos del arnes), y
 *  3. la CLI dijo que esta libre **despues** del Esc (`statusUpdatedAt`).
 *
 * Si algo no se cumple no se toca nada: mandar un Ctrl+C sin saber que tiene la
 * caja de la CLI es justo lo que esto no hace (`queued-submits.ts`).
 */

import { debugLog } from '../../debug.js';
import { parseJsonlLine, readTailLines } from '../../jsonl-reader.js';
import type { QueuedSubmission, QueuedSubmitSource } from '../adapter.js';
import type { CliSessionStatus } from './cli-status.js';
import { cleanUserText, readTimestamp } from './jsonl-events.js';

/**
 * Separacion minima entre dos Ctrl+C. Con la caja vacia, uno solo avisa
 * "Press Ctrl-C again to exit" y el segundo cierra la CLI; no esta medido
 * cuanto dura esa ventana, y dos segundos sobran.
 */
export const CLAUDE_CODE_CLEAR_GAP_MS = 2_000;

/** Cuanto del final del archivo se mira: el mensaje es de recien. */
const TAIL_BYTES = 512 * 1024;

/** Cuanto despues del Esc puede estar fechada la linea del mensaje (ver arriba, 1). */
const HOUR_SLACK_MS = 2_000;

const INTERRUPTED_MARKER = '[Request interrupted by user';

/**
 * Sin `statusUpdatedAt` en el archivo de estado, cuanto despues del Esc se
 * cree un "libre". La CLI lo trae desde que se mide (2.1.261); esto es por si
 * deja de traerlo.
 */
const SETTLE_WITHOUT_STAMP_MS = 800;

/**
 * Cuanto despues del Esc se sigue buscando la linea del mensaje aunque la CLI
 * ya este libre: escribe su historial en tandas, y en la prueba en vivo la
 * linea llego despues de la primera mirada.
 */
const FLUSH_GRACE_MS = 3_000;

/** Lo que se compara entre lo mandado y la linea: sin envoltorios ni espacios de mas. */
function normalize(text: string): string {
  return cleanUserText(text).replace(/\s+/g, ' ').trim();
}

/** El texto de una linea `user`, o null si no es un mensaje escrito (un resultado, una marca). */
function promptTextOf(record: Record<string, unknown>): string | null {
  if (record['type'] !== 'user' || record['isMeta'] === true || record['isSidechain'] === true) return null;
  const message = record['message'];
  if (typeof message !== 'object' || message === null) return null;
  const content = (message as Record<string, unknown>)['content'];
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as Record<string, unknown>;
    if (record['type'] === 'tool_result') return null;
    if (record['type'] === 'text' && typeof record['text'] === 'string') texts.push(record['text']);
  }
  return texts.length === 0 ? null : texts.join('\n');
}

/** Un mensaje que la CLI devolvio a su caja. */
export interface HandedBack {
  /** Lo que vuelve al cuadro: el texto que se escribio, sin las referencias a imagenes. */
  text: string;
  /** El `uuid` de su linea, que es el id del mensaje en el hilo. */
  eventId: string;
}

/**
 * Los mensajes de `submissions` que la CLI devolvio a su caja, segun las
 * lineas del final del archivo. Puro: lo prueba `check-prompt-editing.mjs`.
 */
export function findHandedBack(
  lines: readonly string[],
  submissions: readonly QueuedSubmission[],
  interruptedAt: number,
): HandedBack[] {
  const records = lines.map((line) => parseJsonlLine(line));
  const found: HandedBack[] = [];
  for (const submission of submissions) {
    const wanted = normalize(submission.text);
    if (wanted.length === 0) continue;

    let at = -1;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index];
      if (record === null || record === undefined) continue;
      const text = promptTextOf(record);
      if (text !== null && normalize(text) === wanted) {
        at = index;
        break;
      }
    }
    if (at === -1) continue;

    const line = records[at] as Record<string, unknown>;
    const uuid = line['uuid'];
    if (typeof uuid !== 'string' || uuid.length === 0) continue;
    // (1) No es un mensaje en cola que la CLI mando detras de la interrupcion.
    if (readTimestamp(line['timestamp']) > interruptedAt + HOUR_SLACK_MS) continue;
    const parent = records.find((record) => record !== null && record !== undefined && record['uuid'] === line['parentUuid']);
    if (parent !== undefined && parent !== null && (promptTextOf(parent) ?? '').startsWith(INTERRUPTED_MARKER)) continue;

    // (2) Nada del asistente ni del usuario despues.
    let answered = false;
    for (let index = at + 1; index < records.length; index += 1) {
      const record = records[index];
      if (record === null || record === undefined || record['isSidechain'] === true) continue;
      if (record['type'] === 'assistant' || record['type'] === 'user') {
        answered = true;
        break;
      }
    }
    if (answered) continue;

    found.push({ text: submission.original ?? submission.text, eventId: uuid });
  }
  return found;
}

/** (3) La CLI dijo que esta libre despues del Esc. */
export function settledAfter(status: CliSessionStatus | null, interruptedAt: number, now: number): boolean {
  if (status === null || status.status !== 'idle') return false;
  if (status.statusUpdatedAt !== null) return status.statusUpdatedAt >= interruptedAt;
  return now - interruptedAt >= SETTLE_WITHOUT_STAMP_MS;
}

export interface ClaudeCodeHandbackDeps {
  /** El archivo de esa sesion. */
  sessionFile: (cwd: string, sessionId: string) => string;
  /** El estado que la CLI publica para esa sesion, en el acto. */
  status: (sessionId: string) => Promise<CliSessionStatus | null>;
  now?: () => number;
}

export function createClaudeCodeHandback(deps: ClaudeCodeHandbackDeps): QueuedSubmitSource {
  const now = deps.now ?? Date.now;
  return {
    clearGapMs: CLAUDE_CODE_CLEAR_GAP_MS,
    returnReason: 'stopped-early',
    async check(target, submissions, interruptedAt) {
      try {
        const status = await deps.status(target.sessionId);
        const lines = await readTailLines(deps.sessionFile(target.cwd, target.sessionId), { maxBytes: TAIL_BYTES });
        const found = findHandedBack(lines, submissions, interruptedAt);
        const settled = settledAfter(status, interruptedAt, now());
        debugLog('write', `handback check: status ${status?.status ?? 'none'}, settled ${settled}, handed back ${found.length}`);
        return {
          settled,
          undelivered: found.map((each) => each.text),
          withdrawn: found.map((each) => each.eventId),
          // Sin la CLI libre, o sin la linea todavia en disco, no se concluye nada.
          pending: !settled || (found.length === 0 && now() - interruptedAt < FLUSH_GRACE_MS),
        };
      } catch {
        /*
          Sin archivo todavia: en una sesion nueva la CLI lo crea con su primera
          tanda, y puede no estar en la primera mirada (prueba en vivo). No se
          toca nada, pero se sigue mirando hasta el tope de la recuperacion.
        */
        debugLog('write', 'handback check: no session file yet');
        return { settled: false, undelivered: [], pending: true };
      }
    },
  };
}
