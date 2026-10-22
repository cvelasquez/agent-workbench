/**
 * Chequeo de los limites del plan y de "Compactar" (hito 47, §6.37).
 *
 *   npx tsx scripts/check-plan-limits.mjs
 *
 * Lo que se rompe sin verse:
 *
 *  - **Que dato gana.** Los limites son de la cuenta y dos sesiones los publican
 *    vistos en momentos distintos: por ventana gana lo observado mas tarde, y
 *    una sesion quieta que vuelve a publicar lo viejo no pisa lo nuevo.
 *  - **Que lee cada CLI.** Codex en cada `token_count` (tambien con `info:
 *    null`), Claude Code y Antigravity CLI de los registros de sus scripts.
 *  - **El script de Claude Code**: lista blanca, `observedAt` que se conserva,
 *    la linea que imprime, y el comando del fragmento por Git Bash y por
 *    PowerShell, que es como lo corre la CLI en Windows (medido con la 2.1.303).
 *  - **Que se dibuja.** Las dos ventanas si caben; si cabe una, la de 5 horas,
 *    salvo que otra este al 90 %; el numero en rojo desde el 90 %; "Compactar"
 *    desde el 80 % del contexto, con el comando de cada CLI.
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA` y las `XDG_*` en una carpeta
 * temporal propia, fijadas **antes** de importar nada: no lee ni escribe el
 * `~/.claude` de verdad. No lanza ninguna CLI ni carga `node-pty`.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'src');

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-plan-'));
const home = path.join(root, 'home');
await mkdir(path.join(home, '.claude'), { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
process.env['CODEX_HOME'] = path.join(root, 'codex');

const shared = await import('@agent-workbench/shared');
const { setLocale } = await import('../../web/src/i18n/index.ts');
const planLimitsModule = await import('../src/agents/plan-limits.ts');
const { PlanLimitsBook, PlanLimitsRecordDir, planWindowsOfRecord, removeStalePlanRecords, PLAN_LIMITS_RECORD_MAX_BYTES } = planLimitsModule;
const { PlanLimitsBoard } = await import('../src/plan-limits-board.ts');
const { readRateLimits } = await import('../src/agents/codex/rollout-lines.ts');
const { CodexRolloutSink } = await import('../src/agents/codex/rollout-sink.ts');
const { JsonlFollower } = await import('../src/agents/jsonl-follower.ts');
const scriptModule = await import('../src/agents/claude-code/statusline-script.ts');
const {
  CLAUDE_STATUS_LINE_SCRIPT,
  CLAUDE_STATUS_LINE_SCRIPT_NAME,
  claudeStatusLineCommand,
  claudeStatusLineFragment,
  installClaudeStatusLineScript,
} = scriptModule;
const settingsModule = await import('../src/agents/claude-code/statusline-settings.ts');
const { claudeStatusLineStateOf, readClaudeStatusLineState, CLAUDE_SETTINGS_MAX_BYTES } = settingsModule;
const { createClaudeCodeAdapter, claudePlanRecordsDir } = await import('../src/agents/claude-code/index.ts');
const { integrationsDir } = await import('../src/paths.ts');
const planMeter = await import('../../web/src/plan-meter.ts');
const format = await import('../../web/src/i18n/format.ts');
const { compactCommandFor, AGENT_UI } = await import('../../web/src/agent-ui.ts');

// Los textos de la interfaz salen de `t()` (§6.23): se comparan con el espanol.
await setLocale('es');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' | ' + extra : ''}`);
  if (!ok) failures++;
};
const show = (value) => JSON.stringify(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 19, 14, 0, 0);
const win = (id, usedPercent, observedAt, extra = {}) => ({
  id,
  minutes: id === 'five_hour' ? 300 : id === 'seven_day' ? 10080 : null,
  usedPercent,
  resetsAt: NOW + 3 * HOUR,
  observedAt,
  ...extra,
});

/** Corre un proceso con un texto por stdin. */
function runProcess(file, args, input, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(file, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

// ---------------------------------------------------------------------------
// 1. Las ventanas: forma, union y vigencia (shared)
// ---------------------------------------------------------------------------

{
  const { parsePlanLimitWindow, parsePlanLimits, mergePlanLimitWindows, livePlanWindows, samePlanWindows, MAX_PLAN_LIMIT_WINDOWS } = shared;
  const good = win('five_hour', 23.5, NOW);
  check('1.1 una ventana completa se lee tal cual', same(parsePlanLimitWindow(good), good));
  check('1.1 sin duracion ni reinicio tambien (null)', parsePlanLimitWindow({ ...good, minutes: null, resetsAt: null })?.minutes === null);
  for (const [label, bad] of [
    ['un id con espacios', { ...good, id: 'cinco horas' }],
    ['un id que trata de salir', { ...good, id: '../x' }],
    ['un uso negativo', { ...good, usedPercent: -1 }],
    ['un uso que no es numero', { ...good, usedPercent: '23' }],
    ['sin observedAt', { ...good, observedAt: undefined }],
    ['una duracion de cero', { ...good, minutes: 0 }],
    ['un reinicio que no es numero', { ...good, resetsAt: '2026' }],
  ]) {
    check(`1.2 no se lee ${label}`, parsePlanLimitWindow(bad) === null);
  }
  check('1.3 una CLI que este lado no conoce no se lee', parsePlanLimits({ agent: 'gemini-cli', windows: [good] }) === null);
  check('1.3 una lista con una ventana rara se lee sin ella',
    parsePlanLimits({ agent: 'codex', windows: [good, { id: 'x' }] })?.windows.length === 1);

  /** El uso que queda al juntar `a` y `b`, en los dos ordenes; null si el orden cambia el resultado. */
  const winner = (a, b) => {
    const one = mergePlanLimitWindows([a], [b])[0].usedPercent;
    return mergePlanLimitWindows([b], [a])[0].usedPercent === one ? one : null;
  };
  // Lo que se vio el 19-10-2026 al pegar la status line: tres sesiones la
  // corrieron a la vez, y la quieta llego ultima con lo que habia visto antes.
  check('1.4 en la misma ventana gana el uso mayor, aunque se haya observado antes',
    winner(win('five_hour', 11, NOW - 500), win('five_hour', 10, NOW)) === 11);
  check('1.4 una ventana posterior gana aunque diga menos y se haya observado antes (la anterior se reinicio)',
    winner(win('five_hour', 40, NOW, { resetsAt: NOW - HOUR }), win('five_hour', 10, NOW - HOUR, { resetsAt: NOW + 4 * HOUR })) === 10);
  check('1.4 unos segundos de diferencia en el reinicio son la misma ventana',
    winner(win('300m', 20, NOW, { resetsAt: NOW + 3 * HOUR + 2000 }), win('300m', 25, NOW - HOUR, { resetsAt: NOW + 3 * HOUR })) === 25);
  const sameUse = mergePlanLimitWindows([win('five_hour', 7, NOW - HOUR)], [win('five_hour', 7, NOW)])[0];
  check('1.4 con el mismo uso, la observada mas tarde', sameUse.observedAt === NOW);
  check('1.4 sin reinicio en alguna, gana lo observado mas tarde aunque diga menos',
    winner(win('quota-x', 40, NOW - HOUR, { resetsAt: null }), win('quota-x', 10, NOW)) === 10);
  check('1.4 sin reinicio y con la misma hora, el uso mayor',
    winner(win('quota-x', 5, NOW, { resetsAt: null }), win('quota-x', 7, NOW, { resetsAt: null })) === 7);
  const merged = mergePlanLimitWindows([], [win('quota-x', 1, NOW), win('seven_day', 2, NOW), win('five_hour', 3, NOW)]);
  check('1.5 ordenadas de la mas corta a la mas larga, las sin duracion al final',
    same(merged.map((w) => w.id), ['five_hour', 'seven_day', 'quota-x']));
  const many = Array.from({ length: 12 }, (_, i) => win(`q${i}`, i, NOW));
  check('1.5 con tope', mergePlanLimitWindows([], many).length === MAX_PLAN_LIMIT_WINDOWS);
  check('1.6 una ventana que ya se reinicio no esta vigente; sin reinicio, si',
    livePlanWindows([win('a', 1, NOW, { resetsAt: NOW - 1 }), win('b', 1, NOW, { resetsAt: null }), win('c', 1, NOW)], NOW).map((w) => w.id).join() === 'b,c');
  check('1.7 samePlanWindows compara todo', samePlanWindows([good], [{ ...good }]) && !samePlanWindows([good], [{ ...good, observedAt: NOW + 1 }]));

  const message = shared.parseServerMessage(JSON.stringify({ type: 'plan.limits', limits: [{ agent: 'codex', windows: [good] }, { agent: 'otra-cli', windows: [good] }] }));
  check('1.8 plan.limits: se lee, sin la CLI que no se conoce', message?.type === 'plan.limits' && message.limits.length === 1 && message.limits[0].agent === 'codex');
  check('1.8 plan.limits sin lista no dice nada', shared.parseServerMessage(JSON.stringify({ type: 'plan.limits' })) === null);
  const info = shared.parseAgentInfo({ id: 'claude-code', label: 'Claude Code', command: 'claude', installUrl: 'x' });
  check('1.9 un servidor anterior no manda planLimitsSetup: null', info?.planLimitsSetup === null);
  const withSetup = shared.parseAgentInfo({
    id: 'claude-code', label: 'Claude Code', command: 'claude', installUrl: 'x',
    planLimitsSetup: { state: 'missing', settingsPath: 's', scriptPath: 'p', fragment: '{}' },
  });
  check('1.9 y uno nuevo se lee', withSetup?.planLimitsSetup?.state === 'missing');
}

// ---------------------------------------------------------------------------
// 2. El libro, la carpeta de registros y el tablero
// ---------------------------------------------------------------------------

{
  const book = new PlanLimitsBook();
  let calls = 0;
  const stop = book.subscribe(() => calls++);
  book.observe([win('five_hour', 10, NOW)]);
  // Lo de la ventana anterior, aunque dijera mas.
  book.observe([win('five_hour', 50, NOW - 6 * HOUR, { resetsAt: NOW - 2 * HOUR })]);
  book.observe([]);
  check('2.1 el libro avisa solo si cambio algo; lo viejo no pisa', calls === 1 && book.current()[0].usedPercent === 10, show({ calls, current: book.current() }));
  stop();
  book.observe([win('seven_day', 1, NOW)]);
  check('2.1 desuscrito, no avisa', calls === 1 && book.current().length === 2);

  const dir = path.join(root, 'records');
  await mkdir(dir, { recursive: true });
  const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const record = (windows) => JSON.stringify({ v: 1, at: NOW, sessionId: 'x', planLimits: windows });
  await writeFile(path.join(dir, `${id(1)}.json`), record([win('five_hour', 30, NOW - HOUR), win('seven_day', 20, NOW - HOUR)]));
  await writeFile(path.join(dir, `${id(2)}.json`), record([win('five_hour', 35, NOW)]));
  await writeFile(path.join(dir, 'otro.json'), record([win('five_hour', 99, NOW + HOUR)]));
  await writeFile(path.join(dir, `${id(3)}.json`), 'x'.repeat(PLAN_LIMITS_RECORD_MAX_BYTES + 1));
  const source = new PlanLimitsRecordDir(() => dir, { intervalMs: 60_000, now: () => Date.now() });
  let notified = 0;
  const stopSource = source.subscribe(() => notified++);
  await source.tick();
  const current = source.current();
  check('2.2 la carpeta: por ventana gana la lectura mas actual, de la sesion que sea',
    current.length === 2 && current[0].id === 'five_hour' && current[0].usedPercent === 35 && current[1].usedPercent === 20, show(current));
  check('2.2 un archivo que no se llama <uuid>.json no se lee, y uno enorme tampoco', !current.some((w) => w.usedPercent === 99));
  check('2.2 avisa al cambiar', notified >= 1);

  const before = notified;
  await writeFile(path.join(dir, `${id(2)}.json`), '{ a medio escribir');
  await source.tick();
  check('2.3 un registro a medio escribir no pisa lo anterior', source.current()[0].usedPercent === 35 && notified === before, show(source.current()));
  await rm(path.join(dir, `${id(2)}.json`));
  await source.tick();
  check('2.3 un registro que desaparece se va con lo suyo', source.current()[0].usedPercent === 30, show(source.current()));

  const old = new Date(Date.now() - 9 * 24 * HOUR);
  await utimes(path.join(dir, `${id(1)}.json`), old, old);
  await source.tick();
  check('2.4 un registro de hace mas de 8 dias no se lee', source.current().length === 0, show(source.current()));
  stopSource();
  source.dispose();

  check('2.5 planWindowsOfRecord: sin planLimits da [] y algo que no es un objeto, null',
    same(planWindowsOfRecord({ v: 1 }), []) && planWindowsOfRecord('x') === null);

  await writeFile(path.join(dir, `${id(4)}.json.123.tmp`), 'x');
  const oldTemp = new Date(Date.now() - 2 * HOUR);
  await utimes(path.join(dir, `${id(4)}.json.123.tmp`), oldTemp, oldTemp);
  await writeFile(path.join(dir, 'ajeno.txt'), 'x');
  await utimes(path.join(dir, 'ajeno.txt'), old, old);
  await removeStalePlanRecords(dir);
  const left = (await readdir(dir)).sort();
  check('2.6 la limpieza borra registros viejos y temporales de mas de una hora; nada ajeno',
    !left.includes(`${id(1)}.json`) && !left.includes(`${id(4)}.json.123.tmp`) && left.includes('ajeno.txt') && left.includes('otro.json'), show(left));

  // El tablero: retiene y suelta, y no manda CLIs sin ventanas.
  const a = new PlanLimitsBook();
  const b = new PlanLimitsBook();
  let subscribed = 0;
  const spy = (inner) => ({
    current: () => inner.current(),
    subscribe: (listener) => {
      subscribed++;
      const off = inner.subscribe(listener);
      return () => {
        subscribed--;
        off();
      };
    },
    dispose: () => inner.dispose(),
  });
  const board = new PlanLimitsBoard(() => [{ agent: 'codex', source: spy(a) }, { agent: 'claude-code', source: spy(b) }]);
  let changes = 0;
  board.onChange(() => changes++);
  check('2.7 sin ventanas conectadas no escucha a nadie', subscribed === 0);
  board.retain();
  board.retain();
  check('2.7 con la primera, escucha a cada fuente una vez', subscribed === 2);
  a.observe([win('300m', 5, NOW)]);
  check('2.7 un cambio de una fuente avisa, y la foto trae solo las CLIs con ventanas',
    changes === 1 && same(board.snapshot().map((l) => l.agent), ['codex']));
  board.release();
  check('2.7 con una ventana menos sigue escuchando', subscribed === 2);
  board.release();
  board.release();
  check('2.7 con la ultima deja de escuchar, y soltar de mas no rompe', subscribed === 0);
  board.dispose();
}

// ---------------------------------------------------------------------------
// 3. Codex: `rate_limits` en cada `token_count`
// ---------------------------------------------------------------------------

{
  const at = Date.parse('2026-10-16T17:13:38.155Z');
  // El que se midio el 19-10-2026 en esta maquina (0.162.1, plan free).
  const free = {
    type: 'token_count', info: null,
    rate_limits: {
      limit_id: 'codex', limit_name: null,
      primary: { used_percent: 98.0, window_minutes: 43200, resets_at: 1794500343 },
      secondary: null,
      credits: { has_credits: false, unlimited: false, balance: null },
      individual_limit: null, spend_control_reached: null, plan_type: 'free', rate_limit_reached_type: null,
    },
  };
  const freeWindows = readRateLimits(free, at);
  check('3.1 plan free: una ventana de 30 dias, con su reinicio en ms y la hora de la linea',
    same(freeWindows, [{ id: '43200m', minutes: 43200, usedPercent: 98, resetsAt: 1794500343000, observedAt: at }]), show(freeWindows));
  const paid = {
    type: 'token_count',
    rate_limits: {
      primary: { used_percent: 23.5, window_minutes: 300, resets_in_seconds: 600 },
      secondary: { used_percent: 41, window_minutes: 10080, resets_at: 1794500000 },
    },
  };
  const paidWindows = readRateLimits(paid, at);
  check('3.2 una cuenta paga: 5 horas y semana; resets_in_seconds se suma a la hora de la linea',
    paidWindows.length === 2 && paidWindows[0].id === '300m' && paidWindows[0].resetsAt === at + 600_000 && paidWindows[1].id === '10080m',
    show(paidWindows));
  check('3.3 sin hora de linea no hay como ordenar: nada', readRateLimits(paid, 0).length === 0);
  check('3.3 sin rate_limits, o vacio, nada', readRateLimits({ type: 'token_count' }, at).length === 0 && readRateLimits({ rate_limits: {} }, at).length === 0);
  check('3.3 una ventana sin used_percent se salta',
    readRateLimits({ rate_limits: { primary: { window_minutes: 300 }, secondary: { used_percent: 1, window_minutes: 10080 } } }, at).length === 1);

  // El sink: lo cuenta tambien con `info: null`, y solo si tiene a quien.
  const file = path.join(root, 'rollout.jsonl');
  const rec = (ms, payload) => JSON.stringify({ timestamp: new Date(ms).toISOString(), type: 'event_msg', payload }) + '\n';
  await writeFile(file, rec(at, free) + rec(at + 1000, { ...paid, info: { last_token_usage: { input_tokens: 5 }, total_token_usage: { input_tokens: 5, total_tokens: 5 }, model_context_window: 1000 } }));
  const seen = [];
  const sink = new CodexRolloutSink('', undefined, (windows) => seen.push(windows));
  await new JsonlFollower(file, sink).poll();
  check('3.4 el sink cuenta cada token_count, el de info: null incluido', seen.length === 2 && seen[0][0].id === '43200m' && seen[1].length === 2, show(seen));
  check('3.4 y el medidor de contexto sigue igual', sink.getUsage().contextWindow === 1000 && sink.getUsage().lastRequestTokens === 5);
  const quiet = new CodexRolloutSink('');
  await new JsonlFollower(file, quiet).poll();
  check('3.4 sin a quien contarle (la copia propia), no lee los limites', quiet.getUsage().contextWindow === 1000);

  // De punta a punta: el adaptador junta lo que leen los seguidores de su historial.
  const { createCodexAdapter } = await import('../src/agents/codex/index.ts');
  const paths = await import('../src/agents/codex/paths.ts');
  const adapter = createCodexAdapter();
  check('3.5 el adaptador de Codex declara planLimits, vacio al empezar', adapter.planLimits !== undefined && adapter.planLimits.current().length === 0);
  const pad = (n) => String(n).padStart(2, '0');
  const rolloutOf = async (sessionId, ms, content) => {
    const folder = paths.localDayFolder(path.join(process.env['CODEX_HOME'], 'sessions'), ms);
    await mkdir(folder, { recursive: true });
    const d = new Date(ms);
    const name = `rollout-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}-${sessionId}.jsonl`;
    await writeFile(path.join(folder, name), content);
  };
  const fresh = '01a145b3-5bb3-75e3-ae4b-1fab6b3c93b3';
  const stale = '01a145b3-5bb3-75e3-ae4b-1fab6b3c93b4';
  await rolloutOf(fresh, at, rec(at, paid));
  // Una sesion de la ventana de 5 horas anterior, que se reinicio hace 5 horas.
  const staleAt = at - 6 * HOUR;
  const staleResets = Math.floor((at - 5 * HOUR) / 1000);
  await rolloutOf(stale, staleAt, rec(staleAt, { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 80, window_minutes: 300, resets_at: staleResets } } }) + rec(staleAt, free));
  for (const sessionId of [fresh, stale]) {
    const follower = adapter.history.follow({ cwd: root, sessionId });
    await follower.start();
    await follower.poll();
  }
  const codexWindows = adapter.planLimits.current();
  check('3.5 los seguidores le cuentan lo que leen; lo de una sesion anterior no pisa lo nuevo, y ventanas distintas conviven',
    same(codexWindows.map((w) => [w.id, w.usedPercent]), [['300m', 23.5], ['10080m', 41], ['43200m', 98]]), show(codexWindows));
  await adapter.dispose();
}

// ---------------------------------------------------------------------------
// 4. Claude Code: el script, la linea y la configuracion
// ---------------------------------------------------------------------------

const SESSION = '8bce50c3-8819-451b-aff1-def6e206867d';
/** El JSON de la 2.1.303, con datos sensibles inventados. Sin `rate_limits` es la primera corrida. */
const claudeJson = (over = {}) => ({
  session_id: SESSION,
  transcript_path: 'C:\\Users\\u\\.claude\\projects\\carpeta-secreta\\x.jsonl',
  cwd: 'C:\\Users\\u\\carpeta-secreta',
  model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
  workspace: { current_dir: 'C:\\Users\\u\\carpeta-secreta' },
  version: '2.1.303',
  cost: { total_cost_usd: 1.2345 },
  context_window: { used_percentage: 4, context_window_size: 1000000 },
  ...over,
});
const limits = (fiveHour, sevenDay) => ({
  rate_limits: {
    five_hour: { used_percentage: fiveHour, resets_at: 1792433400 },
    seven_day: { used_percentage: sevenDay, resets_at: 1792425600 },
  },
});

{
  check('4.1 el script es LF, sin dependencias y dice su version',
    !CLAUDE_STATUS_LINE_SCRIPT.includes('\r') && CLAUDE_STATUS_LINE_SCRIPT.includes('// version: 1') && !/from '(?!node:)/.test(CLAUDE_STATUS_LINE_SCRIPT));
  const app = path.join(root, 'cc-app');
  const integrations = path.join(app, 'integrations');
  const records = path.join(app, 'agent-status', 'claude-code');
  const script = await installClaudeStatusLineScript(integrations);
  check('4.1 se instala con su nombre y su contenido', path.basename(script) === CLAUDE_STATUS_LINE_SCRIPT_NAME && (await readFile(script, 'utf8')) === CLAUDE_STATUS_LINE_SCRIPT);
  const recordFile = path.join(records, `${SESSION}.json`);

  const first = await runProcess(process.execPath, [script], JSON.stringify(claudeJson()));
  const firstRecord = JSON.parse(await readFile(recordFile, 'utf8').catch(() => 'null'));
  check('4.2 la primera corrida (sin rate_limits): exit 0, nada impreso, un registro sin ventanas',
    first.code === 0 && first.stdout === '' && first.stderr === '' && same(firstRecord?.planLimits, []), show([first, firstRecord]));

  const second = await runProcess(process.execPath, [script], JSON.stringify(claudeJson(limits(2, 21))));
  const text = await readFile(recordFile, 'utf8');
  const record = JSON.parse(text);
  check('4.3 con rate_limits: las dos ventanas, en ms, con su duracion',
    record.v === 1 && record.sessionId === SESSION && record.planLimits.length === 2 &&
    same(record.planLimits.map((w) => [w.id, w.minutes, w.usedPercent, w.resetsAt]), [['five_hour', 300, 2, 1792433400000], ['seven_day', 10080, 21, 1792425600000]]),
    show(record.planLimits));
  check('4.3 guarda solo v, at, sessionId, planLimits y los nombres de las claves',
    same(Object.keys(record).sort(), ['at', 'keys', 'planLimits', 'sessionId', 'v']) && record.keys.includes('rate_limits'), show(Object.keys(record)));
  // `keys` trae los nombres de lo que llego (`transcript_path`, `cwd`), nunca sus valores.
  for (const secret of ['carpeta-secreta', '1.2345', 'Haiku', 'claude-haiku', '.claude']) {
    check(`4.3 el registro no guarda ${secret}`, !text.includes(secret));
  }
  check('4.4 imprime una linea corta con las dos', /^5h 2% \(.+\) · week 21% \(.+\)\n$/.test(second.stdout) && second.stderr === '', show(second.stdout));
  check('4.4 lo que escribe el script lo lee el servidor', planWindowsOfRecord(record)?.length === 2);

  const firstSeen = record.planLimits[0].observedAt;
  await new Promise((resolve) => setTimeout(resolve, 20));
  await runProcess(process.execPath, [script], JSON.stringify(claudeJson(limits(2, 22))));
  const third = JSON.parse(await readFile(recordFile, 'utf8'));
  check('4.5 la ventana que no cambio conserva observedAt; la que cambio lo renueva',
    third.planLimits[0].observedAt === firstSeen && third.planLimits[1].observedAt > firstSeen, show(third.planLimits));

  const red = await runProcess(process.execPath, [script], JSON.stringify(claudeJson(limits(95, 50))));
  check('4.6 al 90 % o mas, el numero en rojo en la linea', red.stdout.includes('\u001b[31m95%\u001b[0m') && !red.stdout.includes('\u001b[31m50%'), show(red.stdout));

  const beforeOdd = (await readdir(records)).sort();
  const traversal = await runProcess(process.execPath, [script], JSON.stringify(claudeJson({ session_id: '../../x' })));
  const junk = await runProcess(process.execPath, [script], 'no-json');
  check('4.7 un id que no es uuid o un stdin que no es JSON: exit 0, nada impreso, ningun archivo',
    traversal.code === 0 && junk.code === 0 && traversal.stdout === '' && junk.stdout === '' && same((await readdir(records)).sort(), beforeOdd));
  check('4.7 no quedan temporales del rename', !(await readdir(records)).some((name) => name.endsWith('.tmp')));

  // El comando del fragmento.
  const winScript = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\agent-workbench\\integrations\\claude-code-statusline.mjs';
  check('4.8 Windows: barras normales y entre comillas, aunque haya espacios',
    claudeStatusLineCommand(winScript, 'win32') === 'node "C:/Users/Jane Doe/AppData/Roaming/agent-workbench/integrations/claude-code-statusline.mjs"');
  for (const bad of ['$', '`', '"']) {
    check(`4.8 una carpeta con ${bad} no tiene fragmento`, claudeStatusLineFragment(`C:\\Users\\a${bad}b\\x\\claude-code-statusline.mjs`, 'win32') === null);
  }
  check('4.8 macOS/Linux: la ruta tal cual; una barra invertida no tiene fragmento',
    claudeStatusLineCommand('/home/u/x.mjs', 'linux') === 'node "/home/u/x.mjs"' && claudeStatusLineCommand('/home/u\\x.mjs', 'darwin') === null);
  const fragment = JSON.parse(claudeStatusLineFragment(winScript, 'win32'));
  check('4.8 el fragmento: solo statusLine, con type y command', same(Object.keys(fragment), ['statusLine']) && same(Object.keys(fragment.statusLine), ['type', 'command']));
  check('4.8 el fragmento que se ofrece se detecta como active', claudeStatusLineStateOf(fragment.statusLine) === 'active');

  // Como lo corre la CLI en Windows: Git Bash, o PowerShell sin Git Bash (medido con la 2.1.303).
  if (process.platform === 'win32') {
    const spacedIntegrations = path.join(root, 'con espacio', 'app', 'integrations');
    const spacedScript = await installClaudeStatusLineScript(spacedIntegrations);
    const spacedRecords = path.join(root, 'con espacio', 'app', 'agent-status', 'claude-code');
    const command = claudeStatusLineCommand(spacedScript, 'win32');
    const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((candidate) => existsSync(candidate));
    if (bash !== undefined) {
      const viaBash = await runProcess(bash, ['-c', command], JSON.stringify(claudeJson({ session_id: SESSION.replace('8bce', 'aaaa'), ...limits(3, 4) })));
      check('4.9 por Git Bash, desde una carpeta con espacios: escribe el registro e imprime la linea',
        viaBash.code === 0 && viaBash.stdout.startsWith('5h 3%') && (await readdir(spacedRecords)).includes(`${SESSION.replace('8bce', 'aaaa')}.json`), show(viaBash));
    } else {
      console.log('     (sin Git Bash en esta maquina: 4.9 no corre)');
    }
    const viaPowerShell = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], JSON.stringify(claudeJson({ session_id: SESSION.replace('8bce', 'cccc'), ...limits(5, 6) })));
    check('4.10 por PowerShell, igual', viaPowerShell.code === 0 && viaPowerShell.stdout.startsWith('5h 5%'), show(viaPowerShell));
  }

  // Lo que se lee de settings.json.
  const settings = path.join(root, 'settings.json');
  check('4.11 sin archivo: missing', (await readClaudeStatusLineState(settings)) === 'missing');
  await writeFile(settings, '{ roto');
  check('4.11 JSON roto: unreadable', (await readClaudeStatusLineState(settings)) === 'unreadable');
  await writeFile(settings, '\uFEFF' + JSON.stringify({ model: 'opus', env: { ANTHROPIC_API_KEY: 'secreto' }, statusLine: fragment.statusLine }));
  check('4.11 con la linea de la app (y un BOM de editor): active', (await readClaudeStatusLineState(settings)) === 'active');
  await writeFile(settings, JSON.stringify({ statusLine: { type: 'command', command: '~/.claude/statusline.sh' } }));
  check('4.11 otra status line: other-command', (await readClaudeStatusLineState(settings)) === 'other-command');
  await writeFile(settings, JSON.stringify({ statusLine: { type: 'static' } }));
  check('4.11 sin comando: missing', (await readClaudeStatusLineState(settings)) === 'missing');
  await writeFile(settings, JSON.stringify({ pad: 'x'.repeat(CLAUDE_SETTINGS_MAX_BYTES) }));
  check('4.11 un archivo enorme no se lee: unreadable', (await readClaudeStatusLineState(settings)) === 'unreadable');
}

// ---------------------------------------------------------------------------
// 5. El adaptador de Claude Code, de punta a punta
// ---------------------------------------------------------------------------

{
  const adapter = createClaudeCodeAdapter({ platform: 'win32', settingsPollMs: 60_000 });
  check('5.1 declara planLimits y planLimitsSetup', adapter.planLimits !== undefined && typeof adapter.planLimitsSetup === 'function');
  await adapter.prepare();
  const setup = adapter.planLimitsSetup();
  const script = path.join(integrationsDir(), CLAUDE_STATUS_LINE_SCRIPT_NAME);
  check('5.2 prepare instala el script en integrations/, y sin settings.json el estado es missing',
    existsSync(script) && setup.state === 'missing' && setup.scriptPath === script && setup.settingsPath === path.join(home, '.claude', 'settings.json'),
    show(setup));
  check('5.2 el fragmento nombra ese script con barras normales', setup.fragment !== null && setup.fragment.includes(script.replace(/\\/g, '/')));

  await writeFile(path.join(home, '.claude', 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: JSON.parse(setup.fragment).statusLine.command } }));
  check('5.3 refreshSetup ve la linea pegada y dice que cambio', (await adapter.refreshSetup()) === true && adapter.planLimitsSetup().state === 'active');
  check('5.3 una segunda vez no cambia nada', (await adapter.refreshSetup()) === false);

  await runProcess(process.execPath, [script], JSON.stringify(claudeJson(limits(12, 34))));
  let heard = 0;
  const stop = adapter.planLimits.subscribe(() => heard++);
  await adapter.planLimits.tick();
  const windows = adapter.planLimits.current();
  check('5.4 lo que escribe el script de la app lo lee el adaptador', windows.length === 2 && windows[0].usedPercent === 12 && heard >= 1, show(windows));
  check('5.4 en la carpeta de registros de la app', existsSync(path.join(claudePlanRecordsDir(), `${SESSION}.json`)));
  stop();
  await adapter.dispose();
}

// ---------------------------------------------------------------------------
// 6. La web: que se dibuja (sin JSX)
// ---------------------------------------------------------------------------

{
  const { planMeterView, planWindowLabel, planPercentText, planLevel, planIdleState, planSetupTitle, planMeterTitle, planTimeLeftText } = planMeter;
  const five = win('five_hour', 23, NOW);
  const week = win('seven_day', 11, NOW, { resetsAt: NOW + 5 * 24 * HOUR + 10 * HOUR });
  const both = planMeterView([week, five], NOW);
  check('6.1 las dos, de la mas corta a la mas larga, y la prioritaria es la de 5 horas',
    same(both?.shown.map((w) => w.id), ['five_hour', 'seven_day']) && both?.priorityId === 'five_hour', show(both));
  const hot = planMeterView([win('five_hour', 40, NOW), win('seven_day', 93, NOW)], NOW);
  check('6.2 con la semana al 90 % o mas y las 5 horas no, la prioritaria es la semana', hot?.priorityId === 'seven_day');
  const bothHot = planMeterView([win('five_hour', 91, NOW), win('seven_day', 95, NOW)], NOW);
  check('6.2 con las dos arriba del 90 %, vuelve a ser la de 5 horas', bothHot?.priorityId === 'five_hour');
  check('6.3 una ventana que ya se reinicio no se dibuja, y sin ninguna no hay medidor',
    planMeterView([win('five_hour', 50, NOW, { resetsAt: NOW - 1 })], NOW) === null && planMeterView([], NOW) === null);
  const quotas = planMeterView([win('q-a', 10, NOW, { minutes: 10080 }), win('q-b', 70, NOW, { minutes: 10080 }), five], NOW);
  check('6.4 dos ventanas de la misma duracion ocupan un lugar, el de la mas usada; el titulo las nombra a todas',
    same(quotas?.shown.map((w) => w.id), ['five_hour', 'q-b']) && quotas?.all.length === 3, show(quotas));
  const three = planMeterView([win('five_hour', 10, NOW), win('d', 20, NOW, { minutes: 1440 }), win('seven_day', 95, NOW)], NOW);
  check('6.4 con tres, la prioritaria siempre entra entre las dos que se dibujan',
    same(three?.shown.map((w) => w.id), ['five_hour', 'seven_day']) && three?.priorityId === 'seven_day', show(three));

  check('6.5 los nombres de las ventanas',
    planWindowLabel({ minutes: 300 }) === '5h' && planWindowLabel({ minutes: 10080 }) === 'Semana' && planWindowLabel({ minutes: 43200 }) === 'Mes' &&
    planWindowLabel({ minutes: 1440 }) === 'Día' && planWindowLabel({ minutes: 2880 }) === '2d' && planWindowLabel({ minutes: 120 }) === '2h' &&
    planWindowLabel({ minutes: null }) === 'Cuota');
  check('6.6 el porcentaje: nunca 100 antes de llegar',
    planPercentText(99.6) === format.formatPercent(99) && planPercentText(100) === format.formatPercent(100) && planPercentText(11.4) === format.formatPercent(11),
    show([planPercentText(99.6), planPercentText(11.4)]));
  check('6.7 los umbrales: 75 amarillo, 90 rojo', planLevel(74.9) === 'ok' && planLevel(75) === 'warn' && planLevel(89.9) === 'warn' && planLevel(90) === 'danger');
  check('6.8 lo que falta: 5d 10h, 10h 23m, 23m y <1m',
    format.formatTimeLeft((5 * 24 + 10) * HOUR + 59_000) === '5d 10h' && format.formatTimeLeft(10 * HOUR + 23 * 60_000) === '10h 23m' &&
    format.formatTimeLeft(23 * 60_000) === '23m' && format.formatTimeLeft(30_000) === '<1m' && format.formatTimeLeft(-5) === '<1m');
  check('6.8 sin reinicio no hay tiempo', planTimeLeftText({ resetsAt: null }, NOW) === null && planTimeLeftText(week, NOW) === '5d 10h');
  const title = planMeterTitle(both, NOW);
  check('6.9 el titulo: una linea por ventana y el ultimo dato',
    title.split('\n').length === 3 && title.startsWith('5h: ') && title.includes('Semana: ') && title.includes('se reinicia en 5d 10h') && title.includes('Último dato'), show(title));
  check('6.10 sin ventanas: configurar, esperar o nada, segun la status line',
    planIdleState(null) === 'hidden' && planIdleState('active') === 'waiting' && planIdleState('missing') === 'configure' && planIdleState('other-command') === 'configure');
  check('6.10 los titulos sin ventanas', planSetupTitle('missing').includes('Configurar') && planSetupTitle('active').includes('primera respuesta'));

  // "Compactar": el comando de cada CLI y el umbral.
  check('6.11 las cinco CLIs compactan con /compact', Object.keys(AGENT_UI).every((agent) => compactCommandFor(agent) === '/compact') && compactCommandFor(null) === null);
  const meterSource = await readFile(path.join(WEB_SRC, 'ContextMeter.tsx'), 'utf8');
  check('6.12 "Compactar" sale desde el 70 % de la ventana (pedido del 20-10-2026), y solo con la accion de la CLI',
    /export const COMPACT_RATIO = 0\.7;/.test(meterSource) && /compactAction !== null && ratio !== null && ratio >= COMPACT_RATIO/.test(meterSource));

  // Despues de compactar, sin medir hasta la respuesta siguiente (20-10-2026): sin numero no hay barra ni "Compactar".
  const ui = await import('../../web/src/agent-ui.ts');
  const measuredUsage = { ...shared.EMPTY_CONTEXT_USAGE, lastRequestTokens: 760000, contextWindow: 1000000, assistantMessages: 40 };
  const compactedUsage = { ...measuredUsage, compacted: true };
  const sources = ['usage-with-variants', 'usage-with-catalog', 'token-count', 'status-line'];
  check('6.15 con la marca de compactar, ninguna fuente mide; sin ella, todas',
    sources.every((source) => ui.meterMeasured(source, compactedUsage) === false && ui.meterMeasured(source, measuredUsage) === true));
  check('6.15 sin medir tras compactar dibuja la ventana que ya midio la sesion, antes que la configurada; una cota deducida no',
    ui.meterIdleWindow('usage-with-variants', compactedUsage, 200000) === 1000000 &&
    ui.meterIdleWindow('usage-with-variants', { ...compactedUsage, contextWindowEstimated: true }, null) === null &&
    ui.meterIdleWindow('usage-with-variants', measuredUsage, null) === null);
  check('6.15 el titulo dice que se compacto y que el tamano llega con la respuesta siguiente',
    ui.meterIdleDetail('CLAUDE.md', 'usage-with-variants', true).includes('compactó') &&
    ui.meterIdleDetail('CLAUDE.md', 'status-line', true) === ui.meterIdleDetail(null, null, true) &&
    ui.meterIdleDetail('CLAUDE.md', 'usage-with-variants') !== ui.meterIdleDetail('CLAUDE.md', 'usage-with-variants', true));
  check('6.15 la marca viaja: el parser del protocolo la conserva y no la inventa',
    shared.parseContextUsage(JSON.parse(JSON.stringify(compactedUsage)))?.compacted === true &&
    shared.parseContextUsage(JSON.parse(JSON.stringify(measuredUsage)))?.compacted === undefined &&
    shared.parseContextUsage({ ...measuredUsage, compacted: 'si' })?.compacted === undefined);
  const appSource = await readFile(path.join(WEB_SRC, 'App.tsx'), 'utf8');
  check('6.12 apagado sin CLI abierta, y con el agente trabajando o esperando; manda por sendCommand (sin tocar el borrador)',
    /!activeTerminal\.alive\s*\? t\('meter\.compactNoCli'\)/.test(appSource) &&
    /activeActivity === 'busy' \|\| activeActivity === 'waiting'/.test(appSource) &&
    /onCompact: \(\) => sendCommand\(activeCompactCommand\)/.test(appSource));

  // El CSS: la fila es el contenedor, y lo que se esconde al achicarse.
  const css = await readFile(path.join(WEB_SRC, 'styles.css'), 'utf8');
  check('6.13 la fila del buscador es el contenedor del medidor del plan',
    /\.conversation-search \{[^}]*container-type: inline-size;[^}]*container-name: thread-toolbar;/.test(css));
  check('6.13 sin sitio se va primero la ventana que no es la prioritaria, y despues la palabra y la barra',
    /@container thread-toolbar \(max-width: (\d+)px\) \{\s*\.plan-meter \.plan-window-extra \{\s*display: none;/.test(css) &&
    /@container thread-toolbar \(max-width: (\d+)px\) \{\s*\.plan-meter \.plan-label,\s*\.plan-meter \.plan-bar \{\s*display: none;/.test(css));
  // En el telefono los medidores bajan a su linea: contra la fila entera, el del
  // plan quedaba en su forma corta con la linea casi vacia (19-10-2026).
  const conversationSource = await readFile(path.join(WEB_SRC, 'ConversationView.tsx'), 'utf8');
  check('6.14 los dos medidores van juntos en un envoltorio que en el escritorio no es una caja',
    /<div className="thread-meters">\s*<PlanMeter[\s\S]*?<ContextMeter[\s\S]*?\/>\s*<\/div>/.test(conversationSource) &&
    /\.thread-meters \{\s*display: contents;\s*\}/.test(css));
  check('6.14 en la vista angosta la fila deja de ser el contenedor y lo es la linea de los medidores, entera',
    /\.app-narrow \.conversation-search \{[^}]*container-type: normal;/.test(css) &&
    /\.app-narrow \.thread-meters \{[^}]*flex: 0 0 100%;[^}]*flex-wrap: wrap;[^}]*container-type: inline-size;[^}]*container-name: thread-meters;/.test(css));
  const narrowCut = (what) => Number(css.match(new RegExp(`@container thread-meters \\(max-width: (\\d+)px\\) \\{\\s*${what}`))?.[1] ?? NaN);
  const extraCut = narrowCut('\\.app-narrow \\.plan-meter \\.plan-window-extra \\{\\s*display: none;');
  const labelCut = narrowCut('\\.app-narrow \\.plan-meter \\.plan-label,\\s*\\.app-narrow \\.plan-meter \\.plan-bar \\{\\s*display: none;');
  // La linea mide la pantalla menos 20 px. 393 es el telefono de la captura; 342,
  // lo que pide en espanol la prioritaria entera, y 566, las dos en el idioma mas largo.
  check('6.14 los cortes de la linea: a 393 px la prioritaria con palabra y barra, a 360 la forma corta, a 600 las dos',
    labelCut >= 342 && labelCut < 393 - 20 && extraCut >= 566 && extraCut < 600 - 20, JSON.stringify({ extraCut, labelCut }));
  check('6.13 el numero en rojo', /\.plan-danger \{[^}]*color: var\(--danger\);/.test(css));
  // Hasta el 22-10-2026 "Compactar" colgaba debajo del medidor, sobre el hilo, y se
  // veia fuera de sitio: ahora es un boton mas de la fila, despues del numero.
  check('6.13 "Compactar" va en la fila, despues del numero, con la forma de los botones de al lado, y no flota',
    /<span className="meter-value">[\s\S]*?<\/span>\s*\{offerCompact && compactAction !== null && \(\s*<button\s+className="icon-button meter-compact-button"/.test(meterSource) &&
    /\.meter-compact-button \{/.test(css) && !/\.meter-compact-button \{[^}]*position:/.test(css) && !/meter-anchor/.test(css + meterSource));
}

await rm(root, { recursive: true, force: true }).catch(() => undefined);
console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
