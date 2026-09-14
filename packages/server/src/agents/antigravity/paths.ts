/**
 * Donde guarda Antigravity CLI lo que esta app lee.
 *
 * Todo cuelga de `~/.gemini/antigravity-cli/`, salvo los proyectos, que la CLI
 * comparte con el IDE en `~/.gemini/config/projects/`. De esas carpetas se lee
 * solo lo que nombra esta lista y **nada se escribe**; `~/.gemini` no se
 * recorre nunca (medido: mas de 120 s) y `~/.gemini/antigravity/` es del IDE.
 *
 * Todo se calcula en cada llamada con `os.homedir()`, no al importar: el
 * chequeo cambia `USERPROFILE` antes de usarlo.
 *
 * Una ruta que depende de un id solo se arma si el id tiene la forma esperada:
 * los ids llegan de archivos de la CLI y del cliente, y un `..` armaria una
 * ruta fuera de la carpeta.
 */

import { homedir } from 'node:os';
import path from 'node:path';
import { CONVERSATION_ID_PATTERN } from './constants.js';

/** Un id de proyecto de `config/projects/`. Medido: uuids y dos ids con nombre. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

export function geminiHome(): string {
  return path.join(homedir(), '.gemini');
}

/** `~/.gemini/antigravity-cli`. */
export function cliRoot(): string {
  return path.join(geminiHome(), 'antigravity-cli');
}

/** Una carpeta por conversacion, con el id como nombre. */
export function brainRoot(): string {
  return path.join(cliRoot(), 'brain');
}

export interface TranscriptPaths {
  /** `transcript_full.jsonl`: los argumentos como JSON de verdad, sin recortes. */
  full: string;
  /** `transcript.jsonl`: el respaldo, con argumentos doble-codificados. */
  compact: string;
}

/** Los dos transcripts de una conversacion, o null si el id no es un uuid. */
export function transcriptPaths(conversationId: string): TranscriptPaths | null {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  const logs = path.join(brainRoot(), conversationId, '.system_generated', 'logs');
  return {
    full: path.join(logs, 'transcript_full.jsonl'),
    compact: path.join(logs, 'transcript.jsonl'),
  };
}

export interface ConversationFiles {
  /** Formato anterior a la 1.2.2. */
  pb: string;
  /** Formato de la 1.2.2 (SQLite). Existe desde el primer mensaje. */
  db: string;
}

/**
 * Los archivos de estado de una conversacion, o null si el id no es un uuid.
 * De estos **solo se hace `stat`**: el contenido no se abre nunca.
 */
export function conversationFiles(conversationId: string): ConversationFiles | null {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  const folder = path.join(cliRoot(), 'conversations');
  return {
    pb: path.join(folder, `${conversationId}.pb`),
    db: path.join(folder, `${conversationId}.db`),
  };
}

/** Una linea por prompt tecleado en el TUI. */
export function historyPath(): string {
  return path.join(cliRoot(), 'history.jsonl');
}

/** La ultima conversacion de cada carpeta. */
export function lastConversationsPath(): string {
  return path.join(cliRoot(), 'cache', 'last_conversations.json');
}

/** El indice de conversaciones (SQLite en modo WAL): se lee siempre por copia. */
export function summariesDbPath(): string {
  return path.join(cliRoot(), 'conversation_summaries.db');
}

export function projectsRoot(): string {
  return path.join(geminiHome(), 'config', 'projects');
}

/** El archivo de un proyecto, o null si el id no tiene forma de id. */
export function projectFilePath(projectId: string): string | null {
  if (!PROJECT_ID_PATTERN.test(projectId) || /^\.+$/.test(projectId)) return null;
  return path.join(projectsRoot(), `${projectId}.json`);
}

/** La configuracion de la CLI. Se lee con lista blanca; la app no la escribe. */
export function settingsPath(): string {
  return path.join(cliRoot(), 'settings.json');
}

/** Los logs de la CLI. Solo el respaldo del descubrimiento los mira. */
export function cliLogRoot(): string {
  return path.join(cliRoot(), 'log');
}
