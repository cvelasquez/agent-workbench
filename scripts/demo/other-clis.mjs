/**
 * Lo que la demo escribe de las otras tres CLIs: Codex, OpenCode y Antigravity
 * CLI. Aparte de `fixtures.mjs` porque cada una tiene su formato y juntas
 * duplicarian ese archivo.
 *
 *   <home>/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl   dos rollouts (CLAUDE.md 10)
 *   <home>/.local/share/opencode/opencode.db           base chica con el esquema real (11)
 *   <home>/.cache/opencode/models.json                 el catalogo, con un solo modelo
 *   <home>/.gemini/antigravity-cli/brain/<id>/…        dos transcripts (12)
 *   <home>/.gemini/antigravity-cli/history.jsonl       y lo que sale de ahi: la carpeta
 *   <bin>/codex, opencode, agy (+ .cmd)                CLIs simuladas
 *
 * Todo con la forma que lee cada adaptador y con textos inventados, igual que
 * las sesiones de Claude Code. Las rutas son las del `projectsRoot` que ve la
 * app (`W:\Projects` en Windows). Las CLIs simuladas contestan `--version` y
 * se quedan esperando: ninguna pestana de las capturas se lanza, y si alguien
 * despierta una en `pnpm demo` no pasa nada.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Las versiones que contestan las CLIs simuladas: las medidas en CLAUDE.md 9. */
export const SIMULATED_CLIS = [
  { command: 'codex', version: 'codex-cli 0.154.0' },
  { command: 'opencode', version: '1.18.30' },
  { command: 'agy', version: '1.2.2' },
];

/** Una CLI simulada: `--version` contesta y cualquier otra cosa se queda en una consola. */
export function writeSimulatedCli(bin, command, version) {
  const shVersion = version.replace(/"/g, '');
  writeFileSync(
    path.join(bin, command),
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "${shVersion}"; exit 0; fi`,
      'echo',
      'echo "  Demo: esta pestana no lanza ningun agente. Solo sirve para las capturas."',
      'echo',
      'exec "${SHELL:-/bin/sh}" -i',
      '',
    ].join('\n'),
  );
  chmodSync(path.join(bin, command), 0o755);
  // En cmd los parentesis cierran el bloque del `if`: se escapan con `^`.
  const cmdVersion = version.replace(/[()]/g, (char) => `^${char}`);
  writeFileSync(
    path.join(bin, `${command}.cmd`),
    [
      '@echo off',
      `if "%~1"=="--version" (echo ${cmdVersion}& exit /b 0)`,
      'echo.',
      'echo   Demo: esta pestana no lanza ningun agente. Solo sirve para las capturas.',
      'echo.',
      'cmd /k "prompt $G$S"',
      '',
    ].join('\r\n'),
  );
}

const iso = (ms) => new Date(ms).toISOString();
const pad2 = (n) => String(n).padStart(2, '0');

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Un uuid v7 con la marca de `ms`, como los que pone Codex. */
function uuidV7(ms) {
  const hex = ms.toString(16).padStart(12, '0');
  const random = randomUUID().replace(/-/g, '');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${random.slice(0, 3)}-8${random.slice(3, 6)}-${random.slice(6, 18)}`;
}

/**
 * Un rollout de la 0.154, con las lineas que lee el adaptador: `session_meta`,
 * `task_started`, `turn_context`, el par `message/user` + `user_message`, las
 * llamadas `shell_command` y `apply_patch` con su salida, la respuesta final,
 * `token_count` y `task_complete`.
 *
 * steps: { u }, { cmd, output }, { patch, output }, { a }
 */
function codexRollout(codexHome, { cwd, startAt, steps, model = 'gpt-5.5', effort = 'high', contextStart = 14_200 }) {
  const id = uuidV7(startAt - 400);
  const lines = [];
  let at = startAt;
  let context = contextStart;
  let totalInput = 0;
  let totalOutput = 0;
  let calls = 0;
  const turnId = randomUUID();
  const push = (type, payload) => lines.push({ timestamp: iso(at), type, payload });
  const tick = (ms) => {
    at += ms;
  };

  push('session_meta', {
    id,
    timestamp: iso(startAt - 400),
    cwd,
    originator: 'codex-tui',
    cli_version: '0.154.0',
    source: 'cli',
    model_provider: 'openai',
    base_instructions: { text: 'Base instructions.' },
    history_mode: 'paginated',
  });
  const turnStart = at;
  push('event_msg', { type: 'task_started', turn_id: turnId, started_at: Math.floor(at / 1000), model_context_window: 258_400, collaboration_mode_kind: 'default' });
  push('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>…' }] });
  push('response_item', {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: `<environment_context>\n  <cwd>${cwd}</cwd>\n  <shell>powershell</shell>\n</environment_context>` }],
  });
  push('turn_context', {
    turn_id: turnId,
    cwd,
    approval_policy: 'on-request',
    model,
    collaboration_mode: { mode: 'default', settings: { model, reasoning_effort: effort } },
    effort,
    summary: 'none',
  });

  const tokenCount = (output) => {
    const cached = context - 1_800;
    totalInput += context;
    totalOutput += output;
    push('event_msg', {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: totalInput, cached_input_tokens: totalInput - 1_800, output_tokens: totalOutput, reasoning_output_tokens: 0, total_tokens: totalInput + totalOutput },
        last_token_usage: { input_tokens: context, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: context + output },
        model_context_window: 258_400,
      },
      rate_limits: {},
    });
    context += output + 900;
  };

  for (const step of steps) {
    if (step.u !== undefined) {
      push('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: step.u }] });
      tick(1);
      push('event_msg', { type: 'user_message', message: step.u, images: [], local_images: [], text_elements: [] });
      tick(4_000);
    } else if (step.cmd !== undefined) {
      const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
      calls += 1;
      push('response_item', { type: 'reasoning', summary: [], content: null, encrypted_content: 'gAAAAB' });
      tick(2_500);
      push('response_item', {
        type: 'function_call',
        name: 'shell_command',
        arguments: JSON.stringify({ command: step.cmd, workdir: cwd, timeout_ms: 120_000 }),
        call_id: callId,
      });
      tokenCount(80 + step.cmd.length);
      tick(1_800 + calls * 300);
      push('response_item', { type: 'function_call_output', call_id: callId, output: step.output });
      tick(1_500);
    } else if (step.patch !== undefined) {
      const callId = `call_${randomUUID().replace(/-/g, '').slice(0, 22)}`;
      push('response_item', { type: 'custom_tool_call', status: 'completed', call_id: callId, name: 'apply_patch', input: step.patch });
      tokenCount(Math.round(step.patch.length / 3.5));
      tick(900);
      push('response_item', {
        type: 'custom_tool_call_output',
        call_id: callId,
        output: JSON.stringify({ output: step.output, metadata: { exit_code: 0, duration_seconds: 0.1 } }),
      });
      tick(2_000);
    } else if (step.a !== undefined) {
      push('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: step.a }], phase: 'final_answer' });
      tokenCount(Math.round(step.a.length / 3.6));
      tick(300);
    }
  }
  push('event_msg', { type: 'task_complete', turn_id: turnId, completed_at: Math.floor(at / 1000), duration_ms: at - turnStart });

  const created = new Date(startAt - 400);
  const folder = path.join(
    codexHome,
    'sessions',
    String(created.getFullYear()),
    pad2(created.getMonth() + 1),
    pad2(created.getDate()),
  );
  mkdirSync(folder, { recursive: true });
  const name = `rollout-${created.getFullYear()}-${pad2(created.getMonth() + 1)}-${pad2(created.getDate())}T${pad2(created.getHours())}-${pad2(created.getMinutes())}-${pad2(created.getSeconds())}-${id}.jsonl`;
  const file = path.join(folder, name);
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  utimesSync(file, new Date(at), new Date(at));
  return { agent: 'codex', sessionId: id, cwd };
}

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

/**
 * El DDL de `project`, `session`, `message` y `part` que escribe la 1.18.30,
 * copiado de `packages/server/scripts/fixtures/opencode-db.mjs` (que no se puede
 * importar desde aca: importa TypeScript). Solo las columnas y los indices que
 * hacen falta para que la base sea la de verdad; el chequeo de columnas del
 * adaptador (`OPENCODE_REQUIRED_COLUMNS`) avisa si alguna deja de estar.
 */
const OPENCODE_DDL = [
  'CREATE TABLE `project` (`id` text PRIMARY KEY, `worktree` text NOT NULL, `vcs` text, `name` text, `icon_url` text, `icon_url_override` text, `icon_color` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_initialized` integer, `sandboxes` text NOT NULL, `commands` text)',
  'CREATE TABLE `session` (`id` text PRIMARY KEY, `project_id` text NOT NULL, `workspace_id` text, `parent_id` text, `slug` text NOT NULL, `directory` text NOT NULL, `path` text, `title` text NOT NULL, `version` text NOT NULL, `share_url` text, `summary_additions` integer, `summary_deletions` integer, `summary_files` integer, `summary_diffs` text, `metadata` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `revert` text, `permission` text, `agent` text, `model` text, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `time_compacting` integer, `time_archived` integer, CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE)',
  'CREATE INDEX `session_parent_idx` ON `session` (`parent_id`)',
  'CREATE INDEX `session_project_idx` ON `session` (`project_id`)',
  'CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`)',
  'CREATE TABLE `message` (`id` text PRIMARY KEY, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE)',
  'CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`)',
  'CREATE TABLE `part` (`id` text PRIMARY KEY, `message_id` text NOT NULL, `session_id` text NOT NULL, `time_created` integer NOT NULL, `time_updated` integer NOT NULL, `data` text NOT NULL, CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE)',
  'CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`)',
  'CREATE INDEX `part_session_idx` ON `part` (`session_id`)',
];

const OPENCODE_MODEL = { providerID: 'openai', modelID: 'gpt-5.5' };

/**
 * `node:sqlite` sin el aviso experimental en la salida de la demo. En un Node
 * sin el modulo (antes de la 22.13) da null: la app tampoco leeria la base.
 */
async function loadDatabaseSync() {
  const original = process.emitWarning;
  process.emitWarning = (warning, ...rest) => {
    if (String(warning).includes('SQLite')) return;
    original.call(process, warning, ...rest);
  };
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch {
    return null;
  } finally {
    process.emitWarning = original;
  }
}
const DatabaseSync = await loadDatabaseSync();

const openCodeId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 26)}`;

/**
 * Una sesion de OpenCode en filas. Los directorios con `/`, como los escribe la
 * CLI (CLAUDE.md 11.4); el adaptador los devuelve con los separadores del
 * sistema.
 *
 * steps: { u }, { tool, input, output }, { a }
 */
function openCodeSession({ cwd, startAt, title, steps }) {
  const sessionId = openCodeId('ses');
  const directory = cwd.replace(/\\/g, '/');
  const messages = [];
  const parts = [];
  let at = startAt;
  let userMessage = null;
  let assistant = null;
  let context = 11_800;

  const closeAssistant = () => {
    if (assistant === null) return;
    const output = 60 + assistant.outputChars / 3.6;
    const tokens = { total: 0, input: 1_200, output: Math.round(output), reasoning: 0, cache: { read: context, write: 0 } };
    tokens.total = tokens.input + tokens.output + tokens.cache.read;
    context += tokens.input + tokens.output;
    assistant.data.tokens = tokens;
    assistant.data.time.completed = at;
    assistant.row.time_updated = at;
    parts.push({ id: openCodeId('prt'), message_id: assistant.row.id, session_id: sessionId, time_created: at, time_updated: at, data: { type: 'step-finish', reason: assistant.data.finish, snapshot: 'demo', cost: 0, tokens } });
    assistant.row.data = assistant.data;
    assistant = null;
  };
  const openAssistant = () => {
    if (assistant !== null) return assistant;
    const id = openCodeId('msg');
    const data = {
      parentID: userMessage,
      role: 'assistant',
      mode: 'build',
      agent: 'build',
      variant: 'high',
      path: { cwd: directory, root: directory },
      cost: 0,
      tokens: null,
      ...OPENCODE_MODEL,
      time: { created: at },
      finish: 'stop',
    };
    const row = { id, session_id: sessionId, time_created: at, time_updated: at, data };
    messages.push(row);
    parts.push({ id: openCodeId('prt'), message_id: id, session_id: sessionId, time_created: at, time_updated: at, data: { type: 'step-start', snapshot: 'demo' } });
    assistant = { row, data, outputChars: 0 };
    return assistant;
  };

  for (const step of steps) {
    at += 1_000;
    if (step.u !== undefined) {
      closeAssistant();
      const id = openCodeId('msg');
      messages.push({ id, session_id: sessionId, time_created: at, time_updated: at, data: { role: 'user', time: { created: at }, agent: 'build', model: OPENCODE_MODEL } });
      parts.push({ id: openCodeId('prt'), message_id: id, session_id: sessionId, time_created: at + 1, time_updated: at + 1, data: { type: 'text', text: step.u } });
      userMessage = id;
      at += 3_000;
    } else if (step.tool !== undefined) {
      const current = openAssistant();
      current.data.finish = 'tool-calls';
      current.outputChars += JSON.stringify(step.input).length;
      parts.push({
        id: openCodeId('prt'),
        message_id: current.row.id,
        session_id: sessionId,
        time_created: at,
        time_updated: at + 900,
        data: {
          type: 'tool',
          tool: step.tool,
          callID: `call_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
          state: { status: 'completed', input: step.input, output: step.output, metadata: {}, title: step.tool, time: { start: at, end: at + 900 } },
        },
      });
      at += 2_500;
      // Cada tanda de llamadas es un paso: la respuesta que sigue es otro mensaje.
      if (step.last === true) closeAssistant();
    } else if (step.a !== undefined) {
      const current = openAssistant();
      current.data.finish = 'stop';
      current.outputChars += step.a.length;
      parts.push({ id: openCodeId('prt'), message_id: current.row.id, session_id: sessionId, time_created: at, time_updated: at, data: { type: 'text', text: step.a } });
      at += 1_500;
      closeAssistant();
    }
  }
  closeAssistant();

  const session = {
    id: sessionId,
    project_id: 'prj_demo',
    slug: `demo-${sessionId.slice(-6).toLowerCase()}`,
    directory,
    title,
    version: '1.18.30',
    time_created: startAt,
    time_updated: at,
  };
  return { session, messages, parts, ref: { agent: 'opencode', sessionId, cwd } };
}

function writeOpenCodeBase(home, sessions) {
  if (DatabaseSync === null) {
    console.warn('[demo] this Node has no node:sqlite: the demo runs without OpenCode history.');
    return;
  }
  const dataDir = path.join(home, '.local', 'share', 'opencode');
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'opencode.db'));
  try {
    db.exec('PRAGMA journal_mode = WAL');
    for (const ddl of OPENCODE_DDL) db.exec(ddl);
    const insert = (table, row) => {
      const keys = Object.keys(row);
      db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(
        ...keys.map((key) => (row[key] !== null && typeof row[key] === 'object' ? JSON.stringify(row[key]) : row[key])),
      );
    };
    const first = sessions[0]?.session.time_created ?? Date.now();
    insert('project', { id: 'prj_demo', worktree: '/', time_created: first, time_updated: first, sandboxes: '[]' });
    for (const { session, messages, parts } of sessions) {
      insert('session', session);
      for (const message of messages) insert('message', message);
      for (const part of parts) insert('part', part);
    }
  } finally {
    db.close();
  }

  // El catalogo de modelos: sin el, el medidor muestra los tokens sin limite.
  const cacheDir = path.join(home, '.cache', 'opencode');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    path.join(cacheDir, 'models.json'),
    JSON.stringify({ [OPENCODE_MODEL.providerID]: { models: { [OPENCODE_MODEL.modelID]: { limit: { context: 400_000, output: 128_000 } } } } }),
  );
}

// ---------------------------------------------------------------------------
// Antigravity CLI
// ---------------------------------------------------------------------------

const ANTIGRAVITY_MODEL_LABEL = 'Gemini 3.8 Flash (High)';

/** Con zona horaria local, como la escribe la CLI en `ADDITIONAL_METADATA`. */
function localStamp(ms) {
  const date = new Date(ms);
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const hours = pad2(Math.floor(Math.abs(offset) / 60));
  const minutes = pad2(Math.abs(offset) % 60);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}${sign}${hours}:${minutes}`;
}

/**
 * Una conversacion de la 1.2.2: `transcript_full.jsonl` y sus lineas de
 * `history.jsonl`. Como en la CLI, el primer mensaje se anota en el historial
 * sin `conversationId` (se escribe antes de crearla); la carpeta de una
 * conversacion de un solo mensaje sale de `last_conversations.json`.
 *
 * steps: { u }, { call, args, output }, { a }
 */
function antigravityConversation(cliRoot, { cwd, startAt, steps }) {
  const id = randomUUID();
  const lines = [];
  const history = [];
  let at = startAt;
  let index = 0;
  let firstUser = true;
  const step = (source, type, extra) => {
    lines.push({ step_index: index, source, type, status: 'DONE', created_at: iso(at), ...extra });
    index += 1;
  };

  for (const item of steps) {
    at += 1_500;
    if (item.u !== undefined) {
      const change = firstUser
        ? `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${ANTIGRAVITY_MODEL_LABEL}. No need to comment on this change if the user doesn't ask about it. If reporting what model you are, please use a human readable name instead of the exact string.\n</USER_SETTINGS_CHANGE>`
        : '';
      step('USER_EXPLICIT', 'USER_INPUT', {
        content: `<USER_REQUEST>\n${item.u}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${localStamp(at)}.\n</ADDITIONAL_METADATA>${change}`,
      });
      history.push({ display: item.u, timestamp: at, workspace: cwd, ...(firstUser ? {} : { conversationId: id }) });
      firstUser = false;
      at += 2_000;
    } else if (item.call !== undefined) {
      step('MODEL', 'PLANNER_RESPONSE', { tool_calls: [{ name: item.call, args: item.args }] });
      at += 1_200;
      const header = `Created At: ${localStamp(at - 900)}\nCompleted At: ${localStamp(at)}\n`;
      step('MODEL', 'GENERIC', { content: `${header}${item.output}` });
      at += 1_800;
    } else if (item.a !== undefined) {
      step('MODEL', 'PLANNER_RESPONSE', { content: `\n${item.a}\n` });
    }
  }

  const logs = path.join(cliRoot, 'brain', id, '.system_generated', 'logs');
  mkdirSync(logs, { recursive: true });
  const file = path.join(logs, 'transcript_full.jsonl');
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  utimesSync(file, new Date(at), new Date(at));
  return { ref: { agent: 'antigravity', sessionId: id, cwd }, history, lastAt: at };
}

function writeAntigravity(home, conversations) {
  const cliRoot = path.join(home, '.gemini', 'antigravity-cli');
  mkdirSync(path.join(cliRoot, 'cache'), { recursive: true });
  const built = conversations.map((conversation) => antigravityConversation(cliRoot, conversation));
  const history = built.flatMap((item) => item.history).sort((a, b) => a.timestamp - b.timestamp);
  writeFileSync(path.join(cliRoot, 'history.jsonl'), history.map((line) => JSON.stringify(line)).join('\n') + '\n');
  const last = {};
  for (const item of [...built].sort((a, b) => a.lastAt - b.lastAt)) last[item.ref.cwd] = item.ref.sessionId;
  writeFileSync(path.join(cliRoot, 'cache', 'last_conversations.json'), JSON.stringify(last, null, 2));
  return built.map((item) => item.ref);
}

// ---------------------------------------------------------------------------
// Las sesiones de la demo
// ---------------------------------------------------------------------------

/**
 * Escribe el historial de las tres CLIs y sus binarios simulados.
 *
 * @param {{ home: string, bin: string, now: number, projects: Record<string, string> }} options
 *   `projects`: nombre del proyecto -> ruta tal como la ve la app.
 * @returns {{ codexTab: object, openCodeTab: object, antigravityTab: object }}
 *   Una sesion de cada CLI para las pestanas guardadas: `{ agent, sessionId, cwd }`.
 */
export function buildOtherClis({ home, bin, now, projects }) {
  for (const { command, version } of SIMULATED_CLIS) writeSimulatedCli(bin, command, version);

  const codexHome = path.join(home, '.codex');
  const codexTab = codexRollout(codexHome, {
    cwd: projects.facturacion,
    startAt: now - 62 * MIN,
    steps: [
      { u: 'Validate the tax ID before issuing the invoice: eleven digits and a valid check digit.' },
      {
        cmd: 'rg -n "TaxId" src',
        output: 'Exit code: 0\nWall time: 0.3 seconds\nOutput:\nsrc/Invoices/InvoiceIssuer.cs:41:        var taxId = request.Customer.TaxId;\nsrc/Invoices/InvoiceRequest.cs:12:    public string TaxId { get; init; } = "";\n',
      },
      {
        cmd: 'Get-Content src/Invoices/InvoiceIssuer.cs -TotalCount 60',
        output: 'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nnamespace Invoicing.Invoices;\n\npublic sealed class InvoiceIssuer\n{\n    …\n',
      },
      {
        patch: '*** Begin Patch\n*** Add File: src/Invoices/TaxIdValidator.cs\n+namespace Invoicing.Invoices;\n+\n+public static class TaxIdValidator\n+{\n+    private static readonly int[] Weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];\n+\n+    public static bool IsValid(string taxId) { … }\n+}\n*** End Patch\n',
        output: 'Success. Updated the following files:\nA src/Invoices/TaxIdValidator.cs\n',
      },
      {
        patch: '*** Begin Patch\n*** Update File: src/Invoices/InvoiceIssuer.cs\n@@\n-        var taxId = request.Customer.TaxId;\n+        var taxId = request.Customer.TaxId;\n+        if (!TaxIdValidator.IsValid(taxId)) throw new InvalidInvoiceException("Invalid tax ID");\n*** End Patch\n',
        output: 'Success. Updated the following files:\nM src/Invoices/InvoiceIssuer.cs\n',
      },
      {
        cmd: 'dotnet test --filter TaxIdValidator',
        output: 'Exit code: 0\nWall time: 9.8 seconds\nOutput:\nPassed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12\n',
      },
      {
        a: 'I added `TaxIdValidator` with the mod-11 algorithm and call it in `InvoiceIssuer` before building the invoice: an invalid tax ID stops issuance with `InvalidInvoiceException` and never reaches the tax authority.\n\nAll twelve test cases pass, including individual and company IDs, one with only ten digits and one with a wrong check digit.',
      },
    ],
  });
  codexRollout(codexHome, {
    cwd: projects.portal,
    startAt: now - DAY - 5 * HOUR,
    steps: [
      { u: 'Login with a code fails when the email has uppercase letters. Find out why.' },
      {
        cmd: 'rg -n "email" src/auth',
        output: 'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nsrc/auth/login-code.ts:18:  const user = await users.findByEmail(input.email);\nsrc/auth/send-code.ts:9:  const email = input.email.trim().toLowerCase();\n',
      },
      {
        patch: '*** Begin Patch\n*** Update File: src/auth/login-code.ts\n@@\n-  const user = await users.findByEmail(input.email);\n+  const user = await users.findByEmail(input.email.trim().toLowerCase());\n*** End Patch\n',
        output: 'Success. Updated the following files:\nM src/auth/login-code.ts\n',
      },
      {
        a: 'The code was stored with the email in lowercase, but validation looked it up with the email exactly as the user typed it. Now both ends normalize it the same way.',
      },
    ],
  });

  const openCodeSessions = [
    openCodeSession({
      cwd: projects.reservas,
      startAt: now - 2 * DAY - 7 * HOUR,
      title: 'Prevent overlapping bookings of a room',
      steps: [
        { u: 'Two bookings of the same room can overlap. Add the check to the API.' },
        { tool: 'grep', input: { pattern: 'createBooking', include: '*.ts' }, output: 'src/bookings/service.ts:\n  Line 22: export async function createBooking(data: NewBooking) {' },
        { tool: 'read', input: { filePath: 'src/bookings/service.ts' }, output: '<file>\n00022| export async function createBooking(data: NewBooking) {\n00023|   return db.bookings.insert(data);\n00024| }\n</file>', last: true },
        { a: 'The booking was inserted without looking at the others. I added a query that looks for another booking of the same room whose time range overlaps the new one, and if there is one it returns 409 with the conflicting booking.' },
      ],
    }),
    openCodeSession({
      cwd: projects.inventario,
      startAt: now - 47 * MIN,
      title: 'Import stock from Excel',
      steps: [
        { u: 'Import the stock from an Excel spreadsheet. The first row holds the headers.' },
        { tool: 'read', input: { filePath: 'src/importer.py' }, output: '<file>\n00001| import openpyxl\n00002| \n00003| \n00004| def read_sheet(path: str) -> list[dict]:\n</file>' },
        { tool: 'glob', input: { pattern: 'tests/**/*.py' }, output: 'tests/test_movements.py' },
        { tool: 'edit', input: { filePath: 'src/importer.py', oldString: 'def read_sheet', newString: 'def import_stock' }, output: 'Edit applied successfully.' },
        { tool: 'bash', input: { command: 'pytest tests -q', description: 'Run the tests' }, output: '....                                                         [100%]\n4 passed in 0.62s', last: true },
        { a: 'The import checks that every SKU exists before touching the stock, and at the end shows a summary: rows read, applied and rejected, with the reason for each rejection. All four tests pass, including one with a spreadsheet that has an unknown SKU.' },
      ],
    }),
  ];
  writeOpenCodeBase(home, openCodeSessions);

  const [antigravityTab] = writeAntigravity(home, [
    {
      cwd: projects.dashboard,
      startAt: now - 25 * MIN,
      steps: [
        { u: 'Add a region filter to the monthly sales chart.' },
        {
          call: 'view_file',
          args: { AbsolutePath: `${projects.dashboard.replace(/\\/g, '/')}/src/charts/MonthlySales.tsx`, toolAction: 'Viewing file', toolSummary: 'View chart' },
          output: 'File Path: `src/charts/MonthlySales.tsx`\nTotal Lines: 48\n1: export function MonthlySales({ data }: Props) {\n',
        },
        {
          call: 'run_command',
          args: { CommandLine: 'npm test -- charts', Cwd: projects.dashboard, WaitMsBeforeAsync: 5000, toolAction: 'Running tests', toolSummary: 'Run chart tests' },
          output: 'The command completed successfully.\nOutput:\n Test Files  2 passed (2)\n      Tests  9 passed (9)\n',
        },
        { a: 'Done: the chart has a region picker in the top right corner, and the chosen region travels in the URL, so the link can be shared. "All" adds up the regions as before, and all nine chart tests pass.' },
      ],
    },
    {
      cwd: projects.tienda,
      startAt: now - 4 * DAY - 2 * HOUR,
      steps: [
        { u: 'Make sure catalog prices are always shown with two decimals.' },
        {
          call: 'run_command',
          args: { CommandLine: 'git grep -n "toFixed" src', Cwd: projects.tienda, WaitMsBeforeAsync: 5000, toolAction: 'Searching', toolSummary: 'Search price formatting' },
          output: 'The command completed successfully.\nOutput:\nsrc/catalog/ProductList.tsx:22: ${product.price.toFixed(2)}\nsrc/checkout/Checkout.tsx:27: Total: ${total.toFixed(2)}\n',
        },
        { a: 'Both places already use `toFixed(2)`. What was failing was the discounted price, which was computed and shown without rounding.' },
        { u: 'Move it into a `formatPrice` function and use it in all three places.' },
        { a: 'Done: `formatPrice` lives in `src/format.ts`, and the catalog, the checkout and the discounted price all use it.' },
      ],
    },
  ]);

  return { codexTab, openCodeTab: openCodeSessions[1].ref, antigravityTab };
}
