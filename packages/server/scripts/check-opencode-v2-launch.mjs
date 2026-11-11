import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveArgs, parseListeningLine, OpenCodeServeProcess } from '../src/agents/opencode/serve-process.ts';
import { attachArgs, launchWithServe } from '../src/agents/opencode/serve-launch.ts';
import { versionedHistory } from '../src/agents/opencode/versioned-history.ts';
import { createOpenCodeAdapter } from '../src/agents/opencode/index.ts';

const location = { file: process.execPath, resolvedPath: process.execPath, prefixArgs: [], version: 'opencode v2.2.7' };
assert.deepEqual(serveArgs(location), ['serve', '--hostname', '127.0.0.1', '--port', '0']);
assert.equal(parseListeningLine('server listening on http://127.0.0.1:3456', 2), 'http://127.0.0.1:3456');
assert.equal(parseListeningLine('server listening on http://0.0.0.0:3456', 2), null);
assert.equal(parseListeningLine('server listening on https://127.0.0.1:3456', 2), null);
const endpoint = { protocol: 2, url: 'http://127.0.0.1:3456', username: 'opencode', password: 'transient-only' };
const id = 'ses_newSession0000000000000001';
assert.deepEqual(attachArgs(location, endpoint, id), ['--server', 'http://opencode:transient-only@127.0.0.1:3456/', '--session', id]);
const v1 = { ...location, version: '1.19.5', prefixArgs: ['/c', 'opencode.cmd'] };
assert.equal(serveArgs(v1).at(-1), '--mdns=false');
assert.equal(attachArgs(v1, { ...endpoint, protocol: undefined }, id).at(-1), endpoint.password);
let launched = 0;
assert.throws(() => launchWithServe({ ensure: () => { launched++; } }, { location, cwd: '.', resumeSessionId: 'bad&id' }), /Invalid/);
assert.equal(launched, 0);
const dir = await mkdtemp(path.join(tmpdir(), 'aw-v2-launch-'));
let spawnedEnv;
const serve = new OpenCodeServeProcess({
 location, cwd: dir, baseEnv: () => ({ OPENCODE_PASSWORD: 'inherited-secret', OPENCODE_SERVER_USERNAME: 'custom', OPENCODE_SERVER_PASSWORD: 'old' }),
 spawn: (_file, args, options) => {
  assert(!args.some(arg => arg.includes('mdns')));
  spawnedEnv = options.env;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = 0; child.signalCode = null;
  queueMicrotask(() => { child.stdout.write('server listening on http://127.0.0.1:3456\n'); child.emit('close'); });
  return child;
 },
});
try {
 const ready = await serve.ensure();
 assert.equal(ready.protocol, 2);
 assert.equal(ready.username, 'opencode');
 assert.match(ready.password, /^[a-f0-9]{48}$/);
 assert.equal(spawnedEnv.OPENCODE_PASSWORD, ready.password);
 assert.equal(spawnedEnv.OPENCODE_SERVER_PASSWORD, ready.password);
} finally { await serve.dispose(); await rm(dir, { recursive: true, force: true }); }
const plan = await launchWithServe({ ensure: async () => endpoint, createSession: async () => id, track() {} },
  { location, cwd: '.', resumeSessionId: null, proposedSessionId: '', launchToken: 'test' });
assert.equal(plan.session.sessionId, id);
assert.deepEqual(plan.args, attachArgs(location, endpoint, id));
const adapter = createOpenCodeAdapter({ env: {}, sqlite: () => ({ unavailable: 'node-too-old' }) });
try {
 const inherited = { PATH: 'original', OPENCODE_PASSWORD: 'foreign-server', opencode_server_password: 'foreign-server-fallback' };
 const terminalEnv = { ...inherited };
 const input = { location, cwd: '.', resumeSessionId: id, proposedSessionId: id, launchToken: 'test' };
 await adapter.beforeLaunch({ ...input, location: v1 }, terminalEnv);
 assert.deepEqual(terminalEnv, inherited, 'OpenCode 1 conserva el entorno anterior');
 await adapter.beforeLaunch(input, terminalEnv);
 assert.deepEqual(terminalEnv, { PATH: 'original' }, 'solo se descartan contraseñas de otros servidores en la copia del TUI2');
 assert.equal(inherited.OPENCODE_PASSWORD, 'foreign-server', 'no modifica el entorno del usuario');
} finally { await adapter.dispose(); }
let schemaReads = 0;
const common = { roots: () => ['watched.db'], rootExists: async () => true };
const unavailable = versionedHistory(() => { schemaReads++; throw new Error('database is locked'); }, common);
assert.deepEqual(unavailable.roots(), ['watched.db']);
assert.equal(await unavailable.rootExists(), true);
assert.equal(schemaReads, 0, 'vigilar la ruta no abre una base potencialmente ocupada');
let closed = 0;
let starts = 0;
const source = (label) => ({ ...common, follow: () => ({
 label, start: async () => { starts++; }, close: async () => { closed++; },
 poll: async () => ({ reset: false, added: [{ eventId: label }], turns: [], parts: [], plans: [] }),
 getTail: () => ({ events: [{ eventId: label }], hasMore: false }),
}) });
const legacy = source('legacy');
const modern = source('modern');
let selected = legacy;
const migrating = versionedHistory(() => selected, common).follow({ sessionId: id, cwd: '.' });
await migrating.start();
assert.equal((await migrating.poll()).added[0].eventId, 'legacy');
selected = modern;
const migrated = await migrating.poll();
assert.equal(migrated.reset, true, 'una pestaña seguida antes de migrar se rehace con el lector nuevo');
assert.equal(migrated.added[0].eventId, 'modern');
assert.equal(migrating.label, 'modern');
assert.equal(migrating.getTail(10).events[0].eventId, 'modern');
assert.equal(closed, 1);
assert.equal(starts, 2);
assert.equal((await migrating.poll()).reset, false);
await migrating.close();
console.log('OK OpenCode 2: launch, loopback, temporary password, and OpenCode 1 compatibility');
