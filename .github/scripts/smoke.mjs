/**
 * Smoke test of the published package, the way a user gets it:
 *
 *   node .github/scripts/smoke.mjs <path to agent-workbench-X.Y.Z.tgz>
 *
 * It installs the tarball in an empty folder (so `node-pty` is downloaded or
 * compiled for this OS and this Node), and then checks the two things that
 * break per platform and that no unit check sees:
 *
 *  1. the server starts, prints its URL, serves the interface with the token,
 *     and refuses a request without it or from a foreign origin;
 *  2. the pseudo-terminal really spawns a process and its output comes back.
 *
 * No agent CLI is needed: without one the app still serves the interface.
 *
 * On Windows the log may show "Error: AttachConsole failed" from a helper
 * process of node-pty when the pty is killed. It's noise, not a failure.
 */
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const tarball = process.argv[2] ? path.resolve(process.argv[2]) : null;
if (!tarball || !existsSync(tarball)) {
  console.error('Usage: node .github/scripts/smoke.mjs <tarball.tgz>');
  process.exit(2);
}

const isWindows = process.platform === 'win32';
const root = mkdtempSync(path.join(tmpdir(), 'aw-smoke-'));
const appDir = path.join(root, 'app');
const homeDir = path.join(root, 'home');
let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`);
  if (!ok) failures++;
};

console.log(`Node ${process.version} on ${process.platform} ${process.arch}`);
console.log(`Installing ${path.basename(tarball)} in ${appDir} ...`);
mkdirSync(appDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
// A copy with a plain relative name: nothing to quote for the shell npm needs on Windows.
copyFileSync(tarball, path.join(appDir, 'package.tgz'));
execFileSync('npm', ['init', '-y'], { cwd: appDir, stdio: 'ignore', shell: true });
execFileSync('npm', ['install', '--no-audit', '--no-fund', './package.tgz'], { cwd: appDir, stdio: 'inherit', shell: true });

const packageDir = path.join(appDir, 'node_modules', 'agent-workbench');
const serverFile = path.join(packageDir, 'dist', 'server.js');
check('the package installs its server', existsSync(serverFile));
check('the bin shim exists', existsSync(path.join(appDir, 'node_modules', '.bin', isWindows ? 'agent-workbench.cmd' : 'agent-workbench')));

// ---- 1. the server ----------------------------------------------------------

const env = {
  ...process.env,
  AGENT_WORKBENCH_NO_OPEN: '1',
  AGENT_WORKBENCH_NO_RESTORE: '1',
  // Its own home: nothing is written in the profile of whoever runs this.
  HOME: homeDir,
  USERPROFILE: homeDir,
  APPDATA: path.join(homeDir, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(homeDir, 'AppData', 'Local'),
  XDG_CONFIG_HOME: path.join(homeDir, '.config'),
  XDG_DATA_HOME: path.join(homeDir, '.local', 'share'),
  XDG_CACHE_HOME: path.join(homeDir, '.cache'),
  XDG_STATE_HOME: path.join(homeDir, '.local', 'state'),
};
const server = spawn(process.execPath, [serverFile], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
const url = await new Promise((resolve) => {
  const onData = (chunk) => {
    log += chunk.toString();
    const match = log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/);
    if (match) resolve(match[0]);
  };
  server.stdout.on('data', onData);
  server.stderr.on('data', onData);
  server.on('exit', (code) => resolve(`exited:${code}`));
  setTimeout(() => resolve('timeout'), 60_000);
});

if (!url.startsWith('http')) {
  check('the server starts and prints its URL', false, `${url}\n${log.slice(-2000)}`);
} else {
  check('the server starts and prints its URL', true, url.replace(/token=.*/, 'token=…'));
  const base = new URL(url);
  const get = (target, headers = {}) => fetch(target, { headers, redirect: 'manual' }).then(async (r) => ({ status: r.status, body: await r.text() }));
  try {
    const withToken = await get(url);
    check('with the token: the interface', withToken.status === 200 && withToken.body.includes('Agent Workbench'), `HTTP ${withToken.status}`);
    const withoutToken = await get(`${base.origin}/`);
    check('without the token: refused', withoutToken.status === 401, `HTTP ${withoutToken.status}`);
    const foreign = await get(url, { Origin: 'http://evil.example' });
    check('from a foreign origin: refused', foreign.status === 403, `HTTP ${foreign.status}`);
    check('it listens on loopback only', base.hostname === '127.0.0.1');
  } catch (error) {
    check('the server answers', false, error instanceof Error ? error.message : String(error));
  }
}

server.kill();
await new Promise((resolve) => (server.exitCode === null ? server.once('exit', resolve) : resolve()));

// ---- 2. the pseudo-terminal -------------------------------------------------
// After the server on purpose: on macOS node-pty ships its `spawn-helper`
// without the executable bit, and the app repairs it when it starts
// (`pty-helper.ts`). Spawning here, with the very node-pty the app uses, is what
// proves that a tab will be able to start a CLI.

const ptyOutput = await new Promise((resolve) => {
  let output = '';
  let settled = false;
  let child = null;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    // On Windows the console host outlives the command until the pty is
    // killed, and it keeps the temp folder busy. No signal: ConPTY takes none.
    try {
      child?.kill();
    } catch {
      // Already gone.
    }
    resolve(value);
  };
  try {
    const pty = createRequire(path.join(packageDir, 'package.json'))('node-pty');
    // The command stays alive after printing, so the kill below ends a live
    // process: killing a pty whose process already left makes node-pty's
    // helper print a harmless but noisy "AttachConsole failed" on Windows.
    const [file, args] = isWindows ? [process.env.ComSpec ?? 'cmd.exe', ['/k', 'echo pty-ok']] : ['/bin/sh', ['-c', 'echo pty-ok; sleep 30']];
    child = pty.spawn(file, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: root, env: process.env });
    child.onData((data) => {
      output += data;
      if (output.includes('pty-ok')) finish(output);
    });
    child.onExit(() => setTimeout(() => finish(output), 500));
    setTimeout(() => finish(`${output}\n(timeout)`), 20_000);
  } catch (error) {
    finish(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
});
check('node-pty spawns a process and returns its output', ptyOutput.includes('pty-ok'), ptyOutput.includes('pty-ok') ? '' : JSON.stringify(ptyOutput.slice(0, 300)));

// A leftover temp folder isn't a failure of the package, and the cleanup never
// gets to hold the result: a synchronous rm with retries can wait forever on a
// folder that Windows still considers busy.
await Promise.race([
  rm(root, { recursive: true, force: true }).catch(() => {}),
  new Promise((resolve) => setTimeout(resolve, 10_000)),
]);

console.log(failures === 0 ? '\nSmoke test passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
