/**
 * Resumen de un archivo de sesion de `~/.claude/projects/`, sin leerlo entero.
 *
 * Tres cosas que aprendimos midiendo la instalacion real (CLAUDE.md 4.6 y 4.7):
 *
 *  1. Hay lineas de 290 KB, asi que la lectura es por lineas y no por bloques
 *     de bytes fijos (ver jsonl-reader.ts).
 *  2. Cabeza y cola alcanzan para los titulos: capturo los 7 de 7, incluido uno
 *     en la linea 358 de 365.
 *  3. 222 de 228 sesiones no tienen titulo propio. El fallback al primer
 *     mensaje del usuario es el caso normal, no la excepcion, y por eso se
 *     limpia con cuidado.
 */

import { stat } from 'node:fs/promises';
import type { SessionSummary, SessionTitleSource } from '@agent-workbench/shared';
import { parseJsonlLine, readHeadLines, readTailLines } from '../../jsonl-reader.js';

/** Cuantas lineas de la cabeza mirar buscando cwd y titulo. El cwd mas tardio medido esta en la 8. */
const HEAD_MAX_LINES = 40;
/** Tope de bytes de la cabeza. Cubre el peor caso medido (372 KB para 25 lineas). */
const HEAD_MAX_BYTES = 512 * 1024;
/** Bloque final para fecha, ultimo mensaje y titulos tardios. */
const TAIL_MAX_BYTES = 64 * 1024;

const TITLE_MAX_LENGTH = 90;

/** Lo que dice la barra de una sesion sin ningun texto que sirva de titulo. */
export const UNTITLED_SESSION_TITLE = 'Sesion sin titulo';

export interface ScanResult {
  cwd: string | null;
  /** Sin `agent` ni `cwd`: los pone el indice, que sabe de que CLI es. */
  summary: Omit<SessionSummary, 'agent' | 'cwd'>;
  /** Ids completos de modelo vistos en `cost-state`. Casi siempre vacio. */
  modelIds: string[];
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
 *
 * Exportada porque el titulo de una sesion de Codex sale igual de su primer
 * mensaje, y dos limpiezas distintas harian que la misma barra se leyera
 * distinto segun la CLI.
 */
export function toTitle(raw: string): string {
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
export async function scanSessionFile(filePath: string, sessionId: string): Promise<ScanResult> {
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
    title = UNTITLED_SESSION_TITLE;
    titleSource = 'none';
  }

  if (title.length === 0) {
    title = UNTITLED_SESSION_TITLE;
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
      // Lo pone `withArchived` al emitir, no la cache: ver el constructor de `SessionIndex`.
      archived: false,
    },
  };
}
