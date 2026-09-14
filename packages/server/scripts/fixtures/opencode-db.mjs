/**
 * Una base de OpenCode de prueba, con el esquema real.
 *
 * El DDL de `project`, `session`, `message` y `part`, con sus indices, esta
 * copiado **literal** del que escribe la CLI 1.18.30 en una base nueva (leido
 * de `sqlite_master`, en solo lectura, el 13-09-2026). Una base que viene
 * migrada desde versiones viejas tiene las mismas columnas y los mismos
 * indices, en otro orden.
 *
 * `project` esta porque `session` la referencia con una clave foranea y
 * `DatabaseSync` las hace cumplir por defecto: sin ella, el primer `INSERT`
 * falla. Asi el escritor conserva tambien las cascadas (`ON DELETE CASCADE`),
 * que es lo que pasa en la base de verdad cuando se borra una sesion.
 *
 * Todo el contenido es inventado. `SECRETO` marca lo que la app no tiene que
 * leer nunca: cabeceras y cuerpo de un error del proveedor, texto de un
 * razonamiento, archivos de un `patch`, `state.metadata` salvo las respuestas
 * de una pregunta, `share_url` y `permission` de la sesion. Ninguna sentencia
 * de `OPENCODE_SQL` puede devolverlo.
 */

import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadSqlite } from '../../src/agents/sqlite.ts';

export const OPENCODE_DDL = Object.freeze([
  `CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        )`,
  `CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        )`,
  'CREATE INDEX `session_parent_idx` ON `session` (`parent_id`)',
  'CREATE INDEX `session_project_idx` ON `session` (`project_id`)',
  'CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`)',
  `CREATE TABLE \`message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        )`,
  'CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`)',
  `CREATE TABLE \`part\` (
          \`id\` text PRIMARY KEY,
          \`message_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_part_message_id_message_id_fk\` FOREIGN KEY (\`message_id\`) REFERENCES \`message\`(\`id\`) ON DELETE CASCADE
        )`,
  'CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`)',
  'CREATE INDEX `part_session_idx` ON `part` (`session_id`)',
]);

export const FIXTURE_PROJECT_ID = 'prj_fixture';

/** `models.json` de prueba: el mismo modelo con dos ventanas segun el proveedor. */
export const OPENCODE_MODELS_FIXTURE = Object.freeze({
  openai: { models: { 'gpt-5.6-terra': { limit: { context: 1050000 } } } },
  otro: { models: { 'gpt-5.6-terra': { limit: { context: 372000 } } } },
});

/** Largo en caracteres de la url de la imagen grande: 5 MB de base64. */
export const BIG_IMAGE_BASE64_LENGTH = 5 * 1024 * 1024;

// ---- Filas ------------------------------------------------------------------

export function sessionRow(fields) {
  return { project_id: FIXTURE_PROJECT_ID, slug: `slug-${fields.id}`, version: '1.18.30', parent_id: null, ...fields };
}

export function messageRow(sessionId, id, timeCreated, data, timeUpdated = timeCreated) {
  return { id, session_id: sessionId, time_created: timeCreated, time_updated: timeUpdated, data };
}

export function partRow(message, id, timeCreated, data, timeUpdated = timeCreated) {
  return {
    id, message_id: message.id, session_id: message.session_id, time_created: timeCreated, time_updated: timeUpdated, data,
  };
}

const openai = { providerID: 'openai', modelID: 'gpt-5.6-terra' };

const userData = (created) => ({ role: 'user', time: { created }, agent: 'build', model: openai });

const assistantData = (parentID, created, completed, extra = {}) => ({
  parentID,
  role: 'assistant',
  mode: 'build',
  agent: 'build',
  variant: 'xhigh',
  path: { cwd: 'D:\\Mi App', root: '/' },
  cost: 0,
  tokens: { total: 0, input: 0, output: 0, reasoning: 0, cache: { write: 0, read: 0 } },
  ...openai,
  time: completed === null ? { created } : { created, completed },
  finish: 'stop',
  ...extra,
});

const tokens = (input, output, reasoning, read, write) => ({
  total: input + output + reasoning + read + write, input, output, reasoning, cache: { read, write },
});

const text = (value, extra = {}) => ({ type: 'text', text: value, ...extra });

/**
 * El contenido de base (especificacion del hito 26, §13.1). Cuatro sesiones:
 *
 *  - `ses_z_vieja`: raiz, la mas vieja, con titulo propio.
 *  - `ses_a_nueva`: raiz posterior con un id **menor** (ordenar por id la pone
 *    primero, que es justo lo que no hay que hacer), el `cwd` escrito con `\`,
 *    titulo por defecto y un texto sintetico antes del primero real.
 *  - `ses_hija`: sub-agente de `ses_a_nueva`.
 *  - `ses_c_rica`: una de cada cosa que se dibuja o se descarta.
 */
export function openCodeBaseContent() {
  const sessions = [
    sessionRow({ id: 'ses_z_vieja', directory: 'D:/Mi App', title: 'Ordenar el menu principal', time_created: 1000, time_updated: 1400 }),
    sessionRow({
      id: 'ses_a_nueva', directory: 'D:\\Mi App', title: 'New session - 2026-09-01T10:00:00.000Z', time_created: 2000, time_updated: 2400,
    }),
    sessionRow({
      id: 'ses_hija', parent_id: 'ses_a_nueva', directory: 'D:\\Mi App', title: 'x (@explore subagent)', time_created: 2500, time_updated: 2600,
    }),
    sessionRow({
      id: 'ses_c_rica', directory: 'D:/Otro', title: 'Revisar el tablero', time_created: 3000, time_updated: 3990,
      share_url: 'https://example.invalid/share/SECRETO', permission: '[{"permission":"SECRETO"}]', metadata: '{"SECRETO":true}',
    }),
  ];

  const messages = [];
  const parts = [];
  const addMessage = (row) => { messages.push(row); return row; };
  const addPart = (message, id, timeCreated, data, timeUpdated) => { parts.push(partRow(message, id, timeCreated, data, timeUpdated)); };

  // ses_z_vieja
  const z1 = addMessage(messageRow('ses_z_vieja', 'msg_z1', 1100, userData(1100)));
  addPart(z1, 'prt_z1a', 1101, text('Ordena el menu principal por uso.'));
  const z2 = addMessage(messageRow('ses_z_vieja', 'msg_z2', 1200,
    assistantData('msg_z1', 1200, 1300, { variant: 'high', tokens: tokens(900, 120, 0, 8000, 0) }), 1300));
  addPart(z2, 'prt_z2a', 1201, { type: 'step-start', snapshot: 'abc' });
  addPart(z2, 'prt_z2b', 1202, text('Listo, quedo ordenado.'));
  addPart(z2, 'prt_z2c', 1203, { type: 'step-finish', reason: 'stop', snapshot: 'abc', cost: 0, tokens: tokens(900, 120, 0, 8000, 0) });

  // ses_a_nueva
  const a1 = addMessage(messageRow('ses_a_nueva', 'msg_a1', 2100, userData(2100)));
  addPart(a1, 'prt_a1a', 2101, text('Called the Read tool with the following input: {"filePath":"D:\\\\Mi App\\\\notas.txt"}', { synthetic: true }));
  addPart(a1, 'prt_a1b', 2102, text('Revisa las notas y propone un plan.'));
  const a2 = addMessage(messageRow('ses_a_nueva', 'msg_a2', 2200,
    assistantData('msg_a1', 2200, 2300, { tokens: tokens(1200, 200, 0, 9000, 0) }), 2300));
  addPart(a2, 'prt_a2a', 2201, text('Propongo tres pasos.'));

  // ses_hija
  const h1 = addMessage(messageRow('ses_hija', 'msg_h1', 2510, userData(2510)));
  addPart(h1, 'prt_h1a', 2511, text('Busca las notas.'));
  const h2 = addMessage(messageRow('ses_hija', 'msg_h2', 2520, assistantData('msg_h1', 2520, 2590), 2590));
  addPart(h2, 'prt_h2a', 2521, text('Estan en notas.txt.'));

  // ses_c_rica
  const c1 = addMessage(messageRow('ses_c_rica', 'msg_c01', 3100, userData(3100)));
  addPart(c1, 'prt_c01a', 3101, {
    type: 'file', mime: 'image/png', filename: 'captura.png', url: `data:image/png;base64,${'A'.repeat(BIG_IMAGE_BASE64_LENGTH)}`,
  });
  addPart(c1, 'prt_c01b', 3102, {
    type: 'file', mime: 'text/plain', filename: 'notas.txt', url: `data:text/plain;base64,${Buffer.from('hola').toString('base64')}`,
  });
  addPart(c1, 'prt_c01c', 3103, text('Mira la captura y revisa el tablero.'));

  const c2 = addMessage(messageRow('ses_c_rica', 'msg_c02', 3200,
    assistantData('msg_c01', 3200, 3290, { finish: 'tool-calls', tokens: tokens(1269, 459, 40, 47616, 0) }), 3290));
  addPart(c2, 'prt_c02a', 3201, { type: 'step-start', snapshot: 'abc' });
  addPart(c2, 'prt_c02b', 3202, { type: 'reasoning', text: 'SECRETO: lo que penso el modelo', time: { start: 3202, end: 3203 } });
  addPart(c2, 'prt_c02c', 3203, text('Análisis ñ '.repeat(1000).slice(0, 9000), { metadata: { openai: { itemId: 'msg_x', phase: 'commentary' } } }));
  addPart(c2, 'prt_c02d', 3204, {
    type: 'tool', tool: 'bash', callID: 'call_c02d',
    state: {
      status: 'completed', input: { command: 'dir', workdir: 'D:\\Otro', timeout: 120000 }, output: 'o'.repeat(5000),
      metadata: { output: 'SECRETO', exit: 0 }, title: 'dir', time: { start: 3204, end: 3210 },
    },
  });
  addPart(c2, 'prt_c02e', 3205, {
    type: 'tool', tool: 'read', callID: 'call_c02e',
    state: {
      status: 'error', input: { filePath: 'D:\\Otro\\falta.txt' }, error: 'File not found: D:\\Otro\\falta.txt',
      metadata: { SECRETO: true }, time: { start: 3205, end: 3206 },
    },
  });
  addPart(c2, 'prt_c02f', 3206, {
    type: 'tool', tool: 'bash', callID: 'call_c02f',
    state: { status: 'running', input: { command: 'npm test' }, metadata: { output: 'SECRETO a medias' }, time: { start: 3206 } },
  });
  addPart(c2, 'prt_c02g', 3207, {
    type: 'tool', tool: 'write', callID: 'call_c02g',
    state: {
      status: 'completed', input: { filePath: 'D:\\Otro\\grande.txt', content: 'w'.repeat(20000) }, output: 'Wrote file successfully.',
      metadata: { filepath: 'D:\\Otro\\grande.txt', SECRETO: true },
      attachments: [{ type: 'file', mime: 'image/png', url: 'data:image/png;base64,SECRETO' }],
      title: 'grande.txt', time: { start: 3207, end: 3208 },
    },
  });
  addPart(c2, 'prt_c02h', 3208, { type: 'step-finish', reason: 'tool-calls', snapshot: 'abc', cost: 0, tokens: tokens(1269, 459, 40, 47616, 0) });

  const c3 = addMessage(messageRow('ses_c_rica', 'msg_c03', 3300,
    assistantData('msg_c01', 3300, 3390, { tokens: tokens(2000, 300, 0, 48000, 512) }), 3390));
  addPart(c3, 'prt_c03a', 3301, { type: 'step-start', snapshot: 'abc' });
  addPart(c3, 'prt_c03b', 3302, {
    type: 'tool', tool: 'question', callID: 'call_c03b',
    state: {
      status: 'completed',
      input: {
        questions: [{
          header: 'Formato', question: '¿Que formato preferis?', multiple: false,
          options: [{ label: 'Tabla', description: 'Filas y columnas' }, { label: 'Lista', description: 'Vinetas' }],
        }],
      },
      output: 'User has answered your questions: "¿Que formato preferis?"="Tabla".',
      metadata: { answers: [['Tabla']], truncated: false }, title: 'Asked 1 question', time: { start: 3302, end: 3340 },
    },
  });
  addPart(c3, 'prt_c03c', 3303, {
    type: 'tool', tool: 'question', callID: 'call_c03c',
    state: {
      status: 'running',
      input: { questions: [{ header: 'Colores', question: '¿Que colores usas?', multiple: true, options: [{ label: 'Rojo' }, { label: 'Azul' }] }] },
      metadata: {}, time: { start: 3303 },
    },
  });
  addPart(c3, 'prt_c03d', 3304, {
    type: 'tool', tool: 'question', callID: 'call_c03d',
    state: { status: 'completed', input: { questions: 'no es una lista' }, output: 'sin respuesta', metadata: {}, time: { start: 3304, end: 3305 } },
  });
  addPart(c3, 'prt_c03e', 3305, { type: 'patch', hash: 'abc', files: ['D:\\Otro\\SECRETO.txt'] });
  addPart(c3, 'prt_c03f', 3306, text('Listo: arme la tabla.'));
  addPart(c3, 'prt_c03g', 3307, { type: 'step-finish', reason: 'stop', snapshot: 'abc', cost: 0, tokens: tokens(2000, 300, 0, 48000, 512) });

  const c4 = addMessage(messageRow('ses_c_rica', 'msg_c04', 3400, userData(3400)));
  addPart(c4, 'prt_c04a', 3401, { type: 'compaction', auto: true, tail_start_id: 'msg_c03' });
  const c5 = addMessage(messageRow('ses_c_rica', 'msg_c05', 3500,
    assistantData('msg_c04', 3500, 3590, { mode: 'compaction', agent: 'compaction', summary: true, tokens: tokens(164822, 1408, 516, 0, 0) }), 3590));
  addPart(c5, 'prt_c05a', 3501, text('Resumen: se reviso el tablero.'));

  const c6 = addMessage(messageRow('ses_c_rica', 'msg_c06', 3600, userData(3600)));
  addPart(c6, 'prt_c06a', 3601, text('Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.', { synthetic: true }));
  addPart(c6, 'prt_c06b', 3602, text('Segui con los graficos.'));
  addMessage(messageRow('ses_c_rica', 'msg_c07', 3700,
    assistantData('msg_c06', 3700, null, { finish: undefined, error: { name: 'MessageAbortedError', data: { message: 'The operation was aborted.' } } }), 3750));

  const c8 = addMessage(messageRow('ses_c_rica', 'msg_c08', 3800, userData(3800)));
  addPart(c8, 'prt_c08a', 3801, text('Proba de nuevo.'));
  addMessage(messageRow('ses_c_rica', 'msg_c09', 3900,
    assistantData('msg_c08', 3900, 3950, {
      finish: undefined,
      error: {
        name: 'APIError',
        data: {
          message: 'Insufficient balance', statusCode: 402, isRetryable: false,
          responseHeaders: { 'set-cookie': 'SECRETO=1; Path=/', 'x-request-id': 'req_1' },
          responseBody: '{"error":"SECRETO"}',
          metadata: { url: 'https://example.invalid/SECRETO' },
        },
      },
    }), 3950));

  return { sessions, messages, parts };
}

// ---- La base ----------------------------------------------------------------

const toValue = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : value);

/**
 * Crea `<dir>/opencode.db` (o `fileName`) en WAL, con el esquema, un proyecto
 * inventado y las filas. `dropColumns` quita columnas despues de crear las
 * tablas: es como se prueba una base de una version que no las tiene.
 *
 * Devuelve el escritor **abierto**, para los casos que escriben con el lector
 * mirando. Hay que cerrarlo (`close`) antes de borrar la carpeta: en Windows un
 * archivo abierto no se borra.
 */
export async function createOpenCodeFixture(dir, { sessions = [], messages = [], parts = [], dropColumns = [], fileName = 'opencode.db' } = {}) {
  await mkdir(dir, { recursive: true });
  const sqlite = loadSqlite();
  if ('unavailable' in sqlite) throw new Error('Este Node no trae node:sqlite: el fixture de OpenCode necesita 22.13 o posterior.');
  const file = path.join(dir, fileName);
  const writer = new sqlite.DatabaseSync(file);
  writer.exec('PRAGMA journal_mode = WAL');
  for (const ddl of OPENCODE_DDL) writer.exec(ddl);
  for (const { table, column } of dropColumns) writer.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);

  const insert = (table, row) => {
    const keys = Object.keys(row).filter((key) => row[key] !== undefined);
    writer.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
      .run(...keys.map((key) => toValue(row[key])));
  };
  const update = (table, id, fields) => {
    const keys = Object.keys(fields);
    writer.prepare(`UPDATE ${table} SET ${keys.map((key) => `${key} = ?`).join(', ')} WHERE id = ?`)
      .run(...keys.map((key) => toValue(fields[key])), id);
  };
  const remove = (table, id) => {
    writer.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  };

  insert('project', { id: FIXTURE_PROJECT_ID, worktree: 'D:/Mi App', time_created: 1, time_updated: 1, sandboxes: '[]' });
  for (const row of sessions) insert('session', row);
  for (const row of messages) insert('message', row);
  for (const row of parts) insert('part', row);

  let open = true;
  return {
    file,
    walFile: `${file}-wal`,
    dir,
    writer,
    insertSession: (row) => insert('session', sessionRow(row)),
    insertMessage: (row) => insert('message', row),
    insertPart: (row) => insert('part', row),
    update,
    remove,
    close: () => {
      if (!open) return;
      open = false;
      writer.close();
    },
  };
}
