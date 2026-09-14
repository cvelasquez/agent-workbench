/**
 * Fixtures inventados de los importadores de la copia propia (hito 28, caso 14).
 *
 * Nada de aca sale de una instalacion real: ids, carpetas, titulos y textos son
 * de prueba. El esquema de `conversation_summaries` es el de Antigravity 1.2.2,
 * **copiado** del chequeo del hito 27 y no importado de el (C8): si ese chequeo
 * cambia su fixture, este no tiene por que cambiar con el.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** `conversation_summaries` tal como la crea Antigravity 1.2.2. */
export const CREATE_SUMMARIES = 'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`preview` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT "",`source` text NOT NULL DEFAULT "",`project_id` text NOT NULL DEFAULT "",`agent_name` text NOT NULL DEFAULT "",`parent_conversation_id` text NOT NULL DEFAULT "",`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT "",`winning_conversation_id` text NOT NULL DEFAULT "",`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,`group_id` text NOT NULL DEFAULT "",PRIMARY KEY (`conversation_id`))';

/** La misma tabla sin `preview`: un formato que cambio. */
export const CREATE_SUMMARIES_WITHOUT_PREVIEW = 'CREATE TABLE `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT "",`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`app_data_dir` text NOT NULL DEFAULT "",`raw_summary` blob,PRIMARY KEY (`conversation_id`))';

/** Una fila con los valores por defecto de una conversacion del IDE. */
export const summaryRow = (id, fields = {}) => ({
  conversation_id: id,
  title: '',
  preview: '',
  step_count: 0,
  last_modified_time: '2026-03-01 10:00:00.0000000+00:00',
  workspace_uris: '',
  last_user_input_time: '2026-03-01 10:00:00+00:00',
  app_data_dir: 'antigravity',
  // Un blob que el rescate no tiene que leer nunca.
  raw_summary: Buffer.from('SECRETO-RAW-SUMMARY'),
  ...fields,
});

export function insertSummaries(db, rows) {
  const insert = db.prepare(
    'INSERT OR REPLACE INTO conversation_summaries (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, last_user_input_time, app_data_dir, raw_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of rows) {
    insert.run(row.conversation_id, row.title, row.preview, row.step_count, row.last_modified_time, row.workspace_uris, row.last_user_input_time, row.app_data_dir, row.raw_summary);
  }
}

/** La base en modo WAL, cerrada: sin `-wal` ni `-shm` al lado, como la deja la CLI en reposo. */
export async function writeSummariesDb(sqliteModule, file, rows, create = CREATE_SUMMARIES) {
  await mkdir(path.dirname(file), { recursive: true });
  const db = new sqliteModule.DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(create);
  if (create === CREATE_SUMMARIES) {
    insertSummaries(db, rows);
  } else {
    const insert = db.prepare('INSERT INTO conversation_summaries (conversation_id, step_count, last_modified_time, workspace_uris, app_data_dir) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) insert.run(row.conversation_id, row.step_count, row.last_modified_time, row.workspace_uris, row.app_data_dir);
  }
  db.close();
}

/** Un mensaje de un chat de Gemini CLI, con la forma medida (§1.1). */
export const geminiMessage = (id, type, timestamp, fields = {}) => ({ id, timestamp, type, content: '', ...fields });

/** Un `session-*.json`. */
export const geminiChat = ({ sessionId, projectHash, startTime, lastUpdated, messages }) => ({
  sessionId,
  projectHash,
  startTime,
  lastUpdated,
  messages,
});

/** Escribe `<geminiHome>/tmp/<folder>/chats/<name>` y devuelve la ruta. */
export async function writeGeminiChat(geminiHome, folder, name, content) {
  const dir = path.join(geminiHome, 'tmp', folder, 'chats');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return file;
}
