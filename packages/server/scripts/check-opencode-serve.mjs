/**
 * Chequeo de OpenCode por `serve` + `attach` (hito 29, paso 4: las piezas sin cablear).
 *
 *   npx tsx scripts/check-opencode-serve.mjs
 *
 * Lo que se rompe en silencio con un servidor local es lo que no se ve usando la
 * app: que escuche en otra interfaz, que la contrasena se cuele en un error, que
 * una pregunta se conteste en la carpeta equivocada, que un corte de la conexion
 * deje el estado viejo para siempre. Cada caso de la especificacion tiene su
 * bloque, numerado igual:
 *
 *  - O1: `serveArgs` y el entorno del hijo: una sola clave mas, la contrasena de
 *    48 hex, sin heredada y con heredada (B3); sin consola compartida (M6).
 *  - O2: `parseListeningLine`; un `serve` que dice `0.0.0.0`, uno que no dice
 *    nada y uno que sale antes: error, sin la contrasena, y el proceso muerto.
 *  - O3: `ensure` a la vez arranca uno; `retain` y el apagado por inactividad con
 *    reloj de mentira; `ensure` despues arranca otro. R29-2: `ensure` con el
 *    apagado a punto de vencer lo vuelve a contar desde cero.
 *  - O4: el cliente: basic auth en todo, solo `127.0.0.1`, 401, HTML, la carpeta
 *    en la query, un id con otra forma, lo que se descarta de un permiso.
 *  - O5: `launchWithServe`: los argumentos de `attach`, la sesion creada por API,
 *    el id hostil que lanza sin tocar el `serve` (M1b), y sin `secrets` (A4).
 *  - O6: `parseSseChunk` y `parseGlobalEvent`.
 *  - O7: `OpenCodeServeStatus` contra el `serve` falso: foto, eventos, prioridad
 *    de la espera, otra sesion, reconexion con foto nueva, `serve` muerto.
 *    R29-1: permisos y preguntas de sub-agentes, por evento y en la foto.
 *  - O8: `OpenCodeQuestions` con la base de prueba: la carpeta de la pestana en
 *    la query (A1), etiquetas, texto saneado, y ningun POST cuando no toca.
 *  - O10: el gancho: corta una vez si trabaja, nunca si esta libre, no se suelta
 *    al escribir, y un corte que falla no deja una promesa sin manejar (M7).
 *  - O11 (paso 5): el adaptador cableado contra un `serve` falso que lanza el
 *    mismo: capacidades, entorno, lanzamiento, estado, preguntas, gancho,
 *    apagado por inactividad, otro `serve` despues y `dispose`; el permiso de
 *    una sub-agente con su padre en la base de prueba (R29-1). Tambien los
 *    rechazos puros del cuadro (D12) y de la tarjeta (B4).
 *  - O12: el historial no lista la sesion vacia que crea la app (D14) y avisa
 *    solo por una con titulo propio.
 *  - O13 (M2): un `serve` que muere sin que la app lo pida —solo, o matado por
 *    otro— avisa `requested: false`; la inactividad y `dispose`, true. Sus
 *    sesiones pasan a null con `server-closed` —tambien para quien se suscribe
 *    despues y aunque otra pestana lance un `serve` nuevo— hasta relanzarlas;
 *    el adaptador cableado lo hace de punta a punta con el falso. El libro de
 *    actividad, `wakeActionFor`, el protocolo, la barra y `advanceRelaunches`,
 *    y en el fuente que el registro, el socket y la vista los usen.
 *
 * El `serve` es `fixtures/fake-opencode-serve.mjs`, lanzado con el Node de este
 * proceso: ninguna CLI de verdad corre. `HOME`, `USERPROFILE`, `APPDATA` y las
 * `XDG_*` apuntan a una carpeta temporal propia **antes** de importar nada, y
 * no se importa nada que cargue `node-pty`.
 */

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-opencode-serve-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg-config');
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
process.env['CODEX_HOME'] = path.join(root, 'codex');
for (const name of ['OPENCODE_DB', 'OPENCODE_MODELS_PATH', 'OPENCODE_MODELS_URL', 'OPENCODE_SERVER_PASSWORD', 'OPENCODE_SERVER_USERNAME']) {
  delete process.env[name];
}

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (value) => JSON.stringify(value);

/** Espera por condicion, con tope. Nunca un `sleep` fijo. */
const waitFor = async (condition, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
};
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));
const rejectionOf = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
};
const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};

let unhandled = 0;
process.on('unhandledRejection', () => {
  unhandled++;
});

const serveProcess = await import('../src/agents/opencode/serve-process.ts');
const serveClient = await import('../src/agents/opencode/serve-client.ts');
const serveStatus = await import('../src/agents/opencode/serve-status.ts');
const serveQuestions = await import('../src/agents/opencode/serve-questions.ts');
const { launchWithServe, attachArgs } = await import('../src/agents/opencode/serve-launch.ts');
const { createServeLaunchHook } = await import('../src/agents/opencode/serve-hook.ts');
const { parseSseChunk, SSE_INITIAL_STATE } = await import('../src/agents/opencode/sse.ts');
const { OpenCodeServeProcess, serveArgs, parseListeningLine } = serveProcess;
const { OpenCodeServeClient, ServeAuthError, ServeRouteError, parseGlobalEvent } = serveClient;
const { OpenCodeServeStatus, activityOfTracked } = serveStatus;
const { OpenCodeQuestions, readPartCall, answersFor } = serveQuestions;

const fakeScript = fileURLToPath(new URL('./fixtures/fake-opencode-serve.mjs', import.meta.url));
const location = { resolvedPath: fakeScript, file: process.execPath, prefixArgs: [fakeScript], version: 'fake' };
const serveCwd = path.join(root, 'serve-cwd');

/** El entorno del proceso sin nada del `serve`, mas lo que pida el caso. */
const baseEnvFor = (extra = {}) => () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(OPENCODE_SERVER_|FAKE_OPENCODE_)/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
};

const spawned = [];
// Si el chequeo termina antes de la limpieza (un error sin atrapar), no deja ningun falso vivo.
process.on('exit', () => {
  for (const { child } of spawned) {
    try {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    } catch {
      // Ya no esta.
    }
  }
});
const spySpawn = (file, args, options) => {
  const child = spawn(file, args, options);
  spawned.push({ file, args, options, child });
  return child;
};

const serves = [];
const makeServe = (options = {}) => {
  const serve = new OpenCodeServeProcess({ location, baseEnv: baseEnvFor(), spawn: spySpawn, cwd: serveCwd, ...options });
  serves.push(serve);
  return serve;
};

const basicOf = (endpoint) => `Basic ${Buffer.from(`${endpoint.username}:${endpoint.password}`).toString('base64')}`;
/** Manda algo al control del falso. Sin cuerpo es GET. */
const control = async (endpoint, route, body) => {
  const response = await fetch(`${endpoint.url}${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: basicOf(endpoint), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return response.json();
};
const requestsOf = (endpoint) => control(endpoint, '/__fake/requests');

/** Temporizadores de mentira: nada corre hasta `advance`. */
const manualClock = () => {
  let now = 0;
  let sequence = 0;
  const pending = new Map();
  return {
    timers: {
      setTimeout: (callback, ms) => {
        const id = ++sequence;
        pending.set(id, { at: now + ms, callback });
        return id;
      },
      clearTimeout: (id) => {
        pending.delete(id);
      },
    },
    pending: () => pending.size,
    /** Avanza y devuelve cuantos temporizadores corrieron. */
    advance: (ms) => {
      now += ms;
      let fired = 0;
      for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now && pending.has(id)) {
          pending.delete(id);
          fired++;
          timer.callback();
        }
      }
      return fired;
    },
  };
};

const HEX48 = /^[0-9a-f]{48}$/;

// ---------------------------------------------------------------------------
// O1. Los argumentos y el entorno del `serve`
// ---------------------------------------------------------------------------

{
  check('O1 serveArgs: las banderas de red explicitas, con el prefijo delante',
    same(serveArgs(location), [fakeScript, 'serve', '--hostname', '127.0.0.1', '--port', '0', '--mdns=false']), show(serveArgs(location)));
  const shim = { resolvedPath: 'C:\\x\\opencode.cmd', file: 'cmd.exe', prefixArgs: ['/c', 'C:\\x\\opencode.cmd'], version: null };
  check('O1 serveArgs con un shim: /c y la ruta primero',
    same(serveArgs(shim), ['/c', 'C:\\x\\opencode.cmd', 'serve', '--hostname', '127.0.0.1', '--port', '0', '--mdns=false']));

  // Sin heredada: exactamente una clave mas.
  const base = baseEnvFor({ FAKE_OPENCODE_SERVE_MODE: 'ok' });
  const plain = makeServe({ baseEnv: base });
  const before = spawned.length;
  const endpoint = await plain.ensure();
  const launched = spawned[before];
  const childEnv = launched?.options.env ?? {};
  const added = Object.keys(childEnv).filter((key) => !(key in base()));
  const removed = Object.keys(base()).filter((key) => !(key in childEnv));
  check('O1 sin heredada: el hijo tiene exactamente una clave mas, OPENCODE_SERVER_PASSWORD',
    same(added, ['OPENCODE_SERVER_PASSWORD']) && same(removed, []), show({ added, removed }));
  check('O1 la contrasena es de 48 hex, y es la del endpoint',
    HEX48.test(childEnv['OPENCODE_SERVER_PASSWORD'] ?? '') && childEnv['OPENCODE_SERVER_PASSWORD'] === endpoint.password);
  check('O1 lo demas del entorno va tal cual',
    Object.entries(base()).every(([key, value]) => childEnv[key] === value));
  check('O1 la contrasena no va en la linea de comando',
    !(launched?.args ?? []).some((arg) => arg.includes(endpoint.password)));
  check('O1 (M6) sin consola compartida: sin ventana, sin stdin, en su carpeta vacia; detached solo fuera de Windows',
    launched?.options.detached === (process.platform !== 'win32') && launched?.options.windowsHide === true &&
    same(launched?.options.stdio, ['ignore', 'pipe', 'pipe']) && launched?.options.cwd === serveCwd,
    show({ detached: launched?.options.detached, windowsHide: launched?.options.windowsHide, stdio: launched?.options.stdio }));

  /*
    En Windows `detached` es DETACHED_PROCESS: medido con la 1.18.30, el `serve`
    sin consola escucha pero su linea de escucha no llega al pipe, y la pestana
    no se abria. Se comprueba por plataforma con un spawn que solo anota las
    opciones y falla, sin lanzar nada.
  */
  for (const platform of ['win32', 'linux']) {
    const recorded = [];
    const recorder = (file, args, options) => {
      recorded.push(options);
      throw new Error('sin lanzar');
    };
    const probe = new OpenCodeServeProcess({ location, baseEnv: baseEnvFor(), spawn: recorder, cwd: serveCwd, platform });
    const failure = await probe.ensure().then(() => null, (error) => error);
    await probe.dispose();
    check(`O1 (M6) en ${platform}: detached ${platform !== 'win32'}, sin ventana y sin stdio heredado`,
      failure !== null && recorded.length === 1 && recorded[0].detached === (platform !== 'win32') &&
      recorded[0].windowsHide === true && same(recorded[0].stdio, ['ignore', 'pipe', 'pipe']),
      show(recorded.map((options) => ({ detached: options.detached, windowsHide: options.windowsHide, stdio: options.stdio }))));
  }
  check('O1 usuario por defecto: opencode, y el endpoint es 127.0.0.1',
    endpoint.username === 'opencode' && /^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.url), show({ user: endpoint.username, url: endpoint.url }));

  // Con heredada: las mismas claves, valor nuevo. Y el usuario heredado.
  const inheritedBase = baseEnvFor({ FAKE_OPENCODE_SERVE_MODE: 'ok', OPENCODE_SERVER_PASSWORD: 'heredada', OPENCODE_SERVER_USERNAME: 'otro' });
  const inherited = makeServe({ baseEnv: inheritedBase });
  const beforeInherited = spawned.length;
  const inheritedEndpoint = await inherited.ensure();
  const inheritedEnv = spawned[beforeInherited]?.options.env ?? {};
  check('O1 con heredada: las mismas claves, y la contrasena la pone la app',
    same(Object.keys(inheritedEnv).sort(), Object.keys(inheritedBase()).sort()) &&
    HEX48.test(inheritedEnv['OPENCODE_SERVER_PASSWORD'] ?? '') && inheritedEnv['OPENCODE_SERVER_PASSWORD'] !== 'heredada');
  check('O1 el usuario heredado se usa en el basic auth, y el falso lo acepta',
    inheritedEndpoint.username === 'otro' && Array.isArray(await control(inheritedEndpoint, '/__fake/requests')));
  check('O1 una contrasena por arranque: dos procesos, dos contrasenas',
    inheritedEndpoint.password !== endpoint.password);

  await plain.dispose();
  await inherited.dispose();
  check('O1 dispose termina los dos', await waitFor(() => [launched, spawned[beforeInherited]].every((item) => !isAlive(item.child.pid))));
}

// ---------------------------------------------------------------------------
// O2. La linea de escucha y los arranques que fallan
// ---------------------------------------------------------------------------

{
  check('O2 parseListeningLine: 127.0.0.1 -> la URL', parseListeningLine('opencode server listening on http://127.0.0.1:4096') === 'http://127.0.0.1:4096');
  check('O2 parseListeningLine: con texto delante tambien', parseListeningLine('INFO  opencode server listening on http://127.0.0.1:51234') === 'http://127.0.0.1:51234');
  const rejected = [
    'opencode server listening on http://0.0.0.0:4096',
    'opencode server listening on http://localhost:4096',
    'opencode server listening on https://127.0.0.1:4096',
    'opencode server listening on http://127.0.0.1:0',
    'opencode server listening on http://127.0.0.1:99999',
    'Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.',
    'basura',
    '',
  ].filter((line) => parseListeningLine(line) !== null);
  check('O2 parseListeningLine: 0.0.0.0, localhost, https, puertos imposibles o basura -> null', same(rejected, []), show(rejected));

  const startFailure = async (mode, extra = {}) => {
    const serve = makeServe({ baseEnv: baseEnvFor({ FAKE_OPENCODE_SERVE_MODE: mode }), ...extra });
    const before = spawned.length;
    const error = await rejectionOf(serve.ensure());
    const launched = spawned[before];
    const dead = launched === undefined ? false : await waitFor(() => !isAlive(launched.child.pid));
    const password = launched?.options.env?.['OPENCODE_SERVER_PASSWORD'] ?? '';
    await serve.dispose();
    return { error, dead, password, message: error instanceof Error ? error.message : String(error) };
  };

  const wide = await startFailure('wide');
  check('O2 un serve que dice 0.0.0.0: ensure rechaza y lo dice', wide.error instanceof Error && wide.message.includes('0.0.0.0'), wide.message);
  check('O2 ... y el proceso ya no existe', wide.dead);

  const silent = await startFailure('silent', { startTimeoutMs: 400 });
  check('O2 sin linea de escucha en el plazo: ensure rechaza', silent.error instanceof Error && silent.message.includes('no dijo en que puerto'), silent.message);
  check('O2 ... y el proceso ya no existe', silent.dead);

  const early = await startFailure('early-exit');
  check('O2 salida temprana: el error dice que salio y trae la cola de stderr',
    early.error instanceof Error && early.message.includes('salio antes de escuchar') && early.message.includes('no se pudo abrir la base'), early.message);
  check('O2 ... sin la contrasena: queda ***', HEX48.test(early.password) && !early.message.includes(early.password) && early.message.includes('***'));
}

// ---------------------------------------------------------------------------
// O3. Un solo proceso, y el apagado por inactividad
// ---------------------------------------------------------------------------

{
  const clock = manualClock();
  const serve = makeServe({ baseEnv: baseEnvFor(), timers: clock.timers, idleStopMs: 1000 });
  const exits = [];
  serve.onExit((endpoint) => exits.push(endpoint));
  const before = spawned.length;
  const [a, b] = await Promise.all([serve.ensure(), serve.ensure()]);
  const c = await serve.ensure();
  check('O3 ensure dos veces a la vez, y otra despues: un solo proceso y el mismo endpoint',
    spawned.length - before === 1 && a === b && b === c, show({ spawned: spawned.length - before }));
  const first = spawned[before];

  const release = serve.retain();
  clock.advance(10_000);
  check('O3 con una pty retenida no se apaga aunque pase el plazo', isAlive(first.child.pid) && (await serve.ensure()) === a);

  const second = serve.retain();
  release();
  release();
  clock.advance(10_000);
  check('O3 soltar dos veces la misma cuenta una: con otra retenida sigue vivo', isAlive(first.child.pid) && spawned.length - before === 1);

  second();
  clock.advance(999);
  check('O3 sin ptys, antes del plazo sigue vivo', isAlive(first.child.pid));
  clock.advance(1);
  check('O3 al cumplirse idleStopMs el proceso termina', await waitFor(() => !isAlive(first.child.pid)));
  check('O3 ... y avisa su salida con el endpoint que dejo de valer', await waitFor(() => exits.length === 1 && exits[0] === a), show(exits.length));

  const d = await serve.ensure();
  check('O3 ensure despues arranca otro proceso', spawned.length - before === 2 && d !== a && isAlive(spawned[before + 1].child.pid));

  // M7: una liberacion despues de dispose no hace nada.
  const late = serve.retain();
  await serve.dispose();
  const timersBefore = clock.pending();
  let threw = false;
  try {
    late();
  } catch {
    threw = true;
  }
  check('O3 (M7) release despues de dispose: inerte, sin lanzar y sin programar nada', !threw && clock.pending() === timersBefore);
  check('O3 ensure despues de dispose rechaza', (await rejectionOf(serve.ensure())) instanceof Error);
  check('O3 dispose termina el segundo', await waitFor(() => !isAlive(spawned[before + 1].child.pid)));
}

// R29-2: una pestana que se abre con el apagado a punto de vencer. Entre
// `ensure()` y el `retain()` de `onSpawned` van la sesion por HTTP y la pty.
{
  const clock = manualClock();
  const serve = makeServe({ timers: clock.timers, idleStopMs: 1000 });
  const before = spawned.length;
  const endpoint = await serve.ensure();
  const child = spawned[before].child;
  serve.retain()();
  clock.advance(999);
  const again = await serve.ensure();
  const firedAtOldDeadline = clock.advance(1);
  check('O3 (R29-2) ensure con el apagado a punto de vencer lo reprograma: al vencer el plazo viejo no se mata',
    again === endpoint && firedAtOldDeadline === 0 && isAlive(child.pid), show({ firedAtOldDeadline }));
  const firedAtNewDeadline = clock.advance(999);
  check('O3 (R29-2) ... y si ese lanzamiento nunca retiene, se apaga al cumplirse el plazo entero',
    firedAtNewDeadline === 1 && (await waitFor(() => !isAlive(child.pid))), show({ firedAtNewDeadline }));
  await serve.dispose();
}

// ---------------------------------------------------------------------------
// El `serve` compartido por O4, O5, O8 y O10
// ---------------------------------------------------------------------------

const main = makeServe();
const mainEndpoint = await main.ensure();
const client = new OpenCodeServeClient(mainEndpoint, undefined, { reconnectDelaysMs: [20, 40, 80] });

// ---------------------------------------------------------------------------
// O4. El cliente
// ---------------------------------------------------------------------------

{
  const hostile = ['http://10.0.0.1:1', 'http://localhost:1', 'https://127.0.0.1:1', 'http://127.0.0.1', 'http://127.0.0.1:1/x', 'no es una url']
    .filter((url) => {
      try {
        new OpenCodeServeClient({ url, username: 'opencode', password: 'x' });
        return true;
      } catch {
        return false;
      }
    });
  check('O4 el constructor lanza con otro host, https, sin puerto o con ruta', same(hostile, []), show(hostile));

  const dir = 'D:\\Mi App';
  const id = await client.createSession(dir);
  const requests = await requestsOf(mainEndpoint);
  const create = requests.find((item) => item.method === 'POST' && item.path === '/session');
  check('O4 createSession devuelve el id del serve', id === 'ses_fakeSession0000000000000001', id);
  check('O4 createSession manda ?directory=D%3A%5CMi%20App y {}',
    create?.search === '?directory=D%3A%5CMi%20App' && same(create?.body, {}), show(create));

  await control(mainEndpoint, '/__fake/state', {
    status: { [dir]: { ses_a: { type: 'busy' }, ses_b: { type: 'retry', attempt: 1, message: 'x', next: 1 }, ses_c: { type: 'raro' } } },
    permissions: {
      [dir]: [{ id: 'per_1', sessionID: 'ses_a', permission: 'external_directory', patterns: ['C:\\privado\\*'], metadata: { comando: 'dir' }, always: [] }],
    },
    questions: {
      [dir]: [
        { id: 'que_1', sessionID: 'ses_a', questions: [{ question: 'x', header: 'h', options: [{ label: 'A', description: 'a' }] }], tool: { messageID: 'msg_1', callID: 'call_1' } },
        { id: 'que_2', sessionID: 'ses_a', questions: 'no es una lista' },
      ],
    },
  });
  const statuses = await client.sessionStatus(dir);
  check('O4 sessionStatus: busy, retry, y un tipo desconocido cuenta como trabajando',
    same(statuses, { ses_a: 'busy', ses_b: 'retry', ses_c: 'busy' }), show(statuses));
  const permissions = await client.pendingPermissions(dir);
  check('O4 pendingPermissions: solo id y sesion (sin metadata ni patterns)', same(permissions, [{ id: 'per_1', sessionID: 'ses_a' }]), show(permissions));
  const questions = await client.pendingQuestions(dir);
  check('O4 pendingQuestions: multiple false y custom true por defecto; lo que no tiene forma, afuera',
    same(questions, [{ id: 'que_1', sessionID: 'ses_a', questions: [{ options: [{ label: 'A' }], multiple: false, custom: true }], tool: { messageID: 'msg_1', callID: 'call_1' } }]),
    show(questions));

  const abortError = await rejectionOf(client.abort(dir, 'ses_x&calc'));
  const afterAbort = await requestsOf(mainEndpoint);
  check('O4 abort con un id hostil lanza sin peticion', abortError instanceof Error && !afterAbort.some((item) => item.path.includes('calc')));

  const all = await requestsOf(mainEndpoint);
  check('O4 toda peticion lleva Authorization: Basic valida', all.length >= 4 && all.every((item) => item.basic && item.authorized), show(all.length));
  check('O4 toda peticion lleva la carpeta en la query', all.every((item) => item.directory === dir), show(all.map((item) => item.directory)));

  const wrong = new OpenCodeServeClient({ ...mainEndpoint, password: 'otra' });
  check('O4 un 401 es ServeAuthError', (await rejectionOf(wrong.createSession(dir))) instanceof ServeAuthError);

  await control(mainEndpoint, '/__fake/state', { html: ['/question'] });
  const html = await rejectionOf(client.pendingQuestions(dir));
  check('O4 text/html es ServeRouteError (version sin esa ruta)', html instanceof ServeRouteError, String(html));
  await control(mainEndpoint, '/__fake/state', { html: [], sessionId: 'ses_x&calc' });
  const badId = await rejectionOf(client.createSession(dir));
  check('O4 un id de sesion que no casa el patron lanza', badId instanceof Error && !(badId instanceof ServeAuthError), String(badId));
  await control(mainEndpoint, '/__fake/state', { sessionId: 'ses_fakeSession0000000000000001', status: {}, permissions: {}, questions: {} });
}

// ---------------------------------------------------------------------------
// O5. El lanzamiento con `attach`
// ---------------------------------------------------------------------------

{
  const tracked = [];
  let ensures = 0;
  const deps = {
    ensure: () => {
      ensures++;
      return main.ensure();
    },
    createSession: (endpoint, directory) => new OpenCodeServeClient(endpoint).createSession(directory),
    track: (endpoint, sessionId, directory) => tracked.push({ endpoint, sessionId, directory }),
  };
  const cwd = 'C:\\Proyecto con espacios';
  const input = { location, cwd, resumeSessionId: null, proposedSessionId: 'x', launchToken: 't' };

  const before = (await requestsOf(mainEndpoint)).length;
  const plan = await launchWithServe(deps, input);
  const id = 'ses_fakeSession0000000000000001';
  check('O5 nueva: [..., attach, url, --dir, ., --session, id, --password, pw]',
    same(plan.args, [fakeScript, 'attach', mainEndpoint.url, '--dir', '.', '--session', id, '--password', mainEndpoint.password]) &&
    plan.file === process.execPath && same(plan.args, attachArgs(location, mainEndpoint, id)), show(plan.args.slice(1, 7)));
  check('O5 nueva: la sesion es known con el id creado por API', same(plan.session, { kind: 'known', sessionId: id }));
  check('O5 ningun argumento despues del prefijo tiene espacios, aunque la carpeta si', plan.args.slice(1).every((arg) => !/\s/.test(arg)));
  check('O5 (A4) el plan no trae secrets', !('secrets' in plan));
  const creates = (await requestsOf(mainEndpoint)).slice(before).filter((item) => item.method === 'POST' && item.path === '/session');
  check('O5 la sesion se crea en la carpeta de la pestana', creates.length === 1 && creates[0].directory === cwd, show(creates));
  check('O5 se rastrea la sesion con su carpeta y el endpoint', same(tracked.map((item) => [item.sessionId, item.directory]), [[id, cwd]]) && tracked[0].endpoint === mainEndpoint);

  const resumeId = 'ses_reanudada00000000000000001';
  const beforeResume = (await requestsOf(mainEndpoint)).length;
  const resumed = await launchWithServe(deps, { ...input, resumeSessionId: resumeId });
  const resumeRequests = (await requestsOf(mainEndpoint)).slice(beforeResume);
  check('O5 reanudar: el id tal cual y ninguna sesion nueva',
    resumed.args.includes(resumeId) && same(resumed.session, { kind: 'known', sessionId: resumeId }) &&
    !resumeRequests.some((item) => item.path === '/session'), show(resumeRequests.map((item) => item.path)));

  const ensuresBefore = ensures;
  const requestsBefore = (await requestsOf(mainEndpoint)).length;
  let syncError = null;
  let returned;
  try {
    returned = launchWithServe(deps, { ...input, resumeSessionId: 'ses_x&calc' });
  } catch (error) {
    syncError = error;
  }
  check('O5 (M1b) reanudar con ses_x&calc lanza sincronico, no rechaza', syncError instanceof Error && returned === undefined, String(syncError));
  check('O5 ... sin tocar el serve: ni ensure ni peticiones',
    ensures === ensuresBefore && (await requestsOf(mainEndpoint)).length === requestsBefore);

  const failing = { ...deps, ensure: () => Promise.reject(new serveProcess.ServeStartError('salio antes de escuchar (codigo 3): ***')) };
  const pending = launchWithServe(failing, input);
  const failure = await rejectionOf(pending);
  check('O5 un serve que no arranca rechaza con el motivo',
    pending instanceof Promise && failure instanceof Error && failure.message.startsWith('No se pudo arrancar el servidor de OpenCode: salio antes'), String(failure));
}

// ---------------------------------------------------------------------------
// O6. SSE y los eventos globales
// ---------------------------------------------------------------------------

{
  const encoder = new TextEncoder();
  const feed = (chunks) => {
    let state = SSE_INITIAL_STATE;
    const messages = [];
    for (const chunk of chunks) {
      const result = parseSseChunk(state, typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      state = result.state;
      messages.push(...result.messages);
    }
    return { state, messages };
  };

  const text = 'data: {"t":"ñandú 🦆 listo"}\r\n\r\n';
  const bytes = encoder.encode(text);
  const byteByByte = feed([...bytes].map((byte) => Uint8Array.of(byte)));
  check('O6 byte a byte, con UTF-8 partido a mitad de caracter: un mensaje, sin reemplazos',
    byteByByte.messages.length === 1 && byteByByte.messages[0].data === '{"t":"ñandú 🦆 listo"}' && !byteByByte.messages[0].data.includes('�'),
    show(byteByByte.messages));
  let everySplit = true;
  for (let cut = 1; cut < bytes.length; cut++) {
    const result = feed([bytes.slice(0, cut), bytes.slice(cut)]);
    if (result.messages.length !== 1 || result.messages[0].data !== '{"t":"ñandú 🦆 listo"}') everySplit = false;
  }
  check('O6 partido en cualquier byte: siempre el mismo mensaje', everySplit);

  const crlf = feed(['data: a\r', '\ndata: b\r', '\n\r', '\n']);
  check('O6 \\r\\n partido entre dos pedazos no despacha antes: un mensaje "a\\nb"',
    crlf.messages.length === 1 && crlf.messages[0].data === 'a\nb', show(crlf.messages));
  const bareCr = feed(['data: x\rdata: y\r\r']);
  check('O6 \\r solo tambien termina linea', bareCr.messages.length === 1 && bareCr.messages[0].data === 'x\ny', show(bareCr.messages));

  const multi = feed([': latido\n\nevent: aviso\nid: 7\ndata: uno\ndata:dos\nretry: 10\nraro: x\n\n', 'data: sin cerrar\n']);
  check('O6 comentarios afuera; dos data unidas; event, id; retry y campos raros ignorados',
    same(multi.messages, [{ event: 'aviso', data: 'uno\ndos', id: '7' }]), show(multi.messages));
  check('O6 un evento sin la linea vacia final no se despacha, y queda pendiente', same(multi.state.dataLines, ['sin cerrar']));
  const next = parseSseChunk(multi.state, encoder.encode('\n'));
  check('O6 ... y sale con el pedazo siguiente, con el id de antes y event por defecto',
    same(next.messages, [{ event: 'message', data: 'sin cerrar', id: '7' }]), show(next.messages));
  check('O6 parseSseChunk no modifica el estado que recibe', same(multi.state.dataLines, ['sin cerrar']));

  const envelope = (payload, directory = 'D:\\Mi App') => JSON.stringify({ directory, payload });
  const parsed = [
    parseGlobalEvent(envelope({ type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'busy' } } })),
    parseGlobalEvent(envelope({ type: 'permission.asked', properties: { id: 'per_1', sessionID: 'ses_1', permission: 'read', patterns: ['C:\\x'], metadata: { a: 1 } } })),
    parseGlobalEvent(envelope({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'per_1', reply: 'once' } })),
    parseGlobalEvent(envelope({ type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_1', questions: [] } })),
    parseGlobalEvent(envelope({ type: 'question.replied', properties: { sessionID: 'ses_1', requestID: 'que_1', answers: [['B']] } })),
    parseGlobalEvent(envelope({ type: 'question.rejected', properties: { sessionID: 'ses_1', requestID: 'que_1' } })),
  ];
  check('O6 parseGlobalEvent: los seis tipos que se usan, sin metadata ni patterns', same(parsed, [
    { type: 'session.status', directory: 'D:\\Mi App', sessionId: 'ses_1', status: 'busy' },
    { type: 'permission.asked', directory: 'D:\\Mi App', sessionId: 'ses_1', requestId: 'per_1' },
    { type: 'permission.replied', directory: 'D:\\Mi App', sessionId: 'ses_1', requestId: 'per_1' },
    { type: 'question.asked', directory: 'D:\\Mi App', sessionId: 'ses_1', requestId: 'que_1' },
    { type: 'question.replied', directory: 'D:\\Mi App', sessionId: 'ses_1', requestId: 'que_1' },
    { type: 'question.rejected', directory: 'D:\\Mi App', sessionId: 'ses_1', requestId: 'que_1' },
  ]), show(parsed));
  const ignored = [
    envelope({ type: 'message.part.updated', properties: { sessionID: 'ses_1' } }),
    envelope({ type: 'server.connected', properties: {} }),
    envelope({ type: 'session.status', properties: { status: { type: 'idle' } } }),
    envelope({ type: 'question.asked', properties: { sessionID: 'ses_1' } }),
    JSON.stringify({ payload: { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } } }),
    'no es json',
  ].filter((data) => parseGlobalEvent(data) !== null);
  check('O6 un type desconocido, sin sesion, sin id, sin carpeta o que no es JSON: se ignora', same(ignored, []), show(ignored));
}

// ---------------------------------------------------------------------------
// O7. El estado, contra un `serve` propio (este caso lo mata)
// ---------------------------------------------------------------------------

{
  check('O7 prioridad pura: con permiso y pregunta a la vez gana el permiso',
    same(activityOfTracked({ status: 'busy', permissions: new Set(['per_1']), questions: new Set(['que_1']) }), { activity: 'waiting', waitingFor: 'permission prompt' }));
  check('O7 (R29-1) prioridad pura: permiso, pregunta propia, pregunta de una sub-agente',
    same(activityOfTracked({ status: 'busy', permissions: new Set(), questions: new Set(['que_1']), childQuestions: new Set(['que_2']) }), { activity: 'waiting', waitingFor: 'question' }) &&
    same(activityOfTracked({ status: 'busy', permissions: new Set(), questions: new Set(), childQuestions: new Set(['que_2']) }), { activity: 'waiting', waitingFor: 'input needed' }));
  check('O7 prioridad pura: retry trabaja',
    same(activityOfTracked({ status: 'retry', permissions: new Set(), questions: new Set() }), { activity: 'busy', waitingFor: null }));

  // La foto y los eventos que se cruzan, con un cliente de mentira: nada depende del orden de llegada.
  {
    const deferred = () => {
      let resolve;
      let reject;
      const promise = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      return { promise, resolve, reject };
    };
    const calls = [];
    let onEvent = null;
    let onConnected = null;
    const stub = {
      endpoint: { url: 'http://127.0.0.1:1', username: 'opencode', password: 'x' },
      sessionStatus: (directory) => {
        const call = { directory, status: deferred(), permissions: deferred(), questions: deferred() };
        calls.push(call);
        return call.status.promise;
      },
      pendingPermissions: () => calls.at(-1).permissions.promise,
      pendingQuestions: () => calls.at(-1).questions.promise,
      events: (event, connected) => {
        onEvent = event;
        onConnected = connected;
        return () => {};
      },
    };
    const answerCall = (call, { status = {}, permissions = [], questions = [] } = {}) => {
      call.status.resolve(status);
      call.permissions.resolve(permissions);
      call.questions.resolve(questions);
    };
    const clock = manualClock();
    const status = new OpenCodeServeStatus({ timers: clock.timers, snapshotRetryDelaysMs: [100] });
    const sid = 'ses_cruce000000000000000000001';
    const dir = 'D:\\Cruce';
    status.track(sid, dir, stub);
    check('O7 antes de la primera foto no se sabe nada: current null', status.current(sid) === null && calls.length === 1);
    onEvent({ type: 'permission.asked', directory: dir, sessionId: sid, requestId: 'per_1' });
    status.track(sid, dir, stub);
    onConnected();
    answerCall(calls[0], { status: { [sid]: 'busy' } });
    await waitFor(() => status.current(sid) !== null);
    check('O7 una foto que se pidio antes del evento no lo pisa: sigue esperando el permiso',
      same(status.current(sid), { activity: 'waiting', waitingFor: 'permission prompt' }), show(status.current(sid)));
    check('O7 otra foto pedida con la primera en camino sale una sola vez al terminar', await waitFor(() => calls.length === 2) && calls.length === 2, show(calls.length));
    calls[1].status.reject(new Error('caida'));
    calls[1].permissions.resolve([]);
    calls[1].questions.resolve([]);
    await waitFor(() => clock.pending() === 1);
    check('O7 una foto que falla se reintenta con el reloj, y lo sabido se conserva',
      clock.pending() === 1 && calls.length === 2 && same(status.current(sid), { activity: 'waiting', waitingFor: 'permission prompt' }));
    clock.advance(100);
    check('O7 ... al vencer la espera, otra foto', calls.length === 3);
    answerCall(calls[2], { status: {}, permissions: [] });
    check('O7 ... y la foto nueva manda: sin permiso y sin estado, libre', await waitFor(() => status.current(sid)?.activity === 'idle'), show(status.current(sid)));
    status.dispose();
  }

  /*
    R29-1: los permisos y preguntas de un sub-agente. OpenCode los guarda con el
    id de la sesion hija, y el TUI enganchado a la raiz los muestra en la vista
    raiz, con la raiz en busy por su `task`. Cliente de mentira: eventos y fotos
    a mano.
  */
  {
    const dir = 'D:\\Sub agentes';
    const rootId = 'ses_raiz00000000000000000000001';
    const child = 'ses_hija00000000000000000000001';
    const grandchild = 'ses_nieta0000000000000000000001';
    const stranger = 'ses_ajena0000000000000000000001';
    const unknown = 'ses_nadie0000000000000000000009';
    const parents = { [child]: rootId, [grandchild]: child, [stranger]: null, [rootId]: null };
    const lookups = [];
    const parentOf = (id) => {
      lookups.push(id);
      return id in parents ? { parentId: parents[id] } : null;
    };
    let photo = { status: { [rootId]: 'busy', [child]: 'busy' }, permissions: [], questions: [] };
    let onEvent = null;
    let onConnected = null;
    const stub = {
      endpoint: { url: 'http://127.0.0.1:2', username: 'opencode', password: 'x' },
      sessionStatus: async () => photo.status,
      pendingPermissions: async () => photo.permissions,
      pendingQuestions: async () => photo.questions,
      events: (event, connected) => {
        onEvent = event;
        onConnected = connected;
        return () => {};
      },
    };
    const keyOf = (value) => (value === null ? 'null' : `${value.activity}:${value.waitingFor ?? ''}`);
    const status = new OpenCodeServeStatus({ parentOf });
    const seen = [];
    status.subscribe(rootId, (value) => seen.push(keyOf(value)));
    status.track(rootId, dir, stub);
    await waitFor(() => seen.at(-1) === 'busy:');
    const ev = (type, sessionId, requestId) => onEvent({ type, directory: dir, sessionId, requestId });

    onEvent({ type: 'session.status', directory: dir, sessionId: child, status: 'idle' });
    check('O7 (R29-1) el estado de una hija no cambia el de la raiz, ni hace buscar su padre',
      keyOf(status.current(rootId)) === 'busy:' && lookups.length === 0, show({ current: status.current(rootId), lookups }));
    ev('permission.asked', child, 'per_h1');
    check('O7 (R29-1) un permiso de una sub-agente pone a la raiz en waiting permission prompt',
      keyOf(status.current(rootId)) === 'waiting:permission prompt' && seen.at(-1) === 'waiting:permission prompt', show(seen));
    ev('permission.replied', child, 'per_h1');
    check('O7 (R29-1) ... al contestarlo vuelve a busy, y el padre se busco una sola vez',
      keyOf(status.current(rootId)) === 'busy:' && lookups.filter((id) => id === child).length === 1, show(lookups));
    ev('question.asked', grandchild, 'que_n1');
    check('O7 (R29-1) una pregunta de una nieta: waiting input needed, no la de responder en el hilo',
      keyOf(status.current(rootId)) === 'waiting:input needed', show(status.current(rootId)));
    ev('question.asked', rootId, 'que_r1');
    check('O7 (R29-1) con una pregunta propia a la vez, gana la propia (tiene tarjeta)', keyOf(status.current(rootId)) === 'waiting:question');
    ev('question.replied', rootId, 'que_r1');
    check('O7 (R29-1) ... contestada la propia, queda la de la nieta', keyOf(status.current(rootId)) === 'waiting:input needed');
    ev('question.rejected', grandchild, 'que_n1');
    check('O7 (R29-1) ... y cerrada la de la nieta, busy', keyOf(status.current(rootId)) === 'busy:');
    ev('permission.asked', stranger, 'per_x');
    ev('permission.asked', unknown, 'per_y');
    check('O7 (R29-1) un permiso de otra raiz, o de una sesion que la base no conoce, no toca a la raiz', keyOf(status.current(rootId)) === 'busy:');

    photo = {
      status: { [rootId]: 'busy' },
      permissions: [{ id: 'per_f1', sessionID: child }, { id: 'per_f2', sessionID: stranger }],
      questions: [{ id: 'que_f1', sessionID: grandchild, questions: [], tool: null }],
    };
    onConnected();
    check('O7 (R29-1) la foto atribuye a la raiz el permiso pendiente de su hija',
      await waitFor(() => seen.at(-1) === 'waiting:permission prompt'), show(seen));
    photo = { ...photo, permissions: [{ id: 'per_f2', sessionID: stranger }] };
    onConnected();
    check('O7 (R29-1) ... sin el permiso, la pregunta pendiente de la nieta: input needed',
      await waitFor(() => seen.at(-1) === 'waiting:input needed'), show(seen));
    status.dispose();

    const plain = new OpenCodeServeStatus();
    photo = { status: { [rootId]: 'busy' }, permissions: [], questions: [] };
    plain.track(rootId, dir, stub);
    await waitFor(() => plain.current(rootId) !== null);
    ev('permission.asked', child, 'per_h2');
    check('O7 (R29-1) sin quien busque padres, lo de una hija se ignora como antes', keyOf(plain.current(rootId)) === 'busy:');
    plain.dispose();
  }

  const own = makeServe();
  const endpoint = await own.ensure();
  const ownClient = new OpenCodeServeClient(endpoint, undefined, { reconnectDelaysMs: [20, 40, 80] });
  const status = new OpenCodeServeStatus({ snapshotRetryDelaysMs: [20, 40, 80] });
  own.onExit((ended) => status.detach(ended));

  const dir = 'D:\\Estado con espacios';
  const sid = 'ses_estado00000000000000000001';
  const other = 'ses_otra000000000000000000001';
  await control(endpoint, '/__fake/state', { status: { [dir]: { [sid]: { type: 'busy' } } } });
  const keyOf = (value) => (value === null ? 'null' : `${value.activity}:${value.waitingFor ?? ''}`);

  const nobody = [];
  status.subscribe('ses_nadie0000000000000000001', (value) => nobody.push(keyOf(value)));
  check('O7 una sesion no rastreada -> null en el acto', same(nobody, ['null']));

  const seen = [];
  const stop = status.subscribe(sid, (value) => seen.push(keyOf(value)));
  const otherSeen = [];
  status.subscribe(other, (value) => otherSeen.push(keyOf(value)));
  status.track(sid, dir, ownClient);
  check('O7 foto inicial con busy -> busy', await waitFor(() => seen.at(-1) === 'busy:'), show(seen));
  check('O7 current() dice lo mismo', same(status.current(sid), { activity: 'busy', waitingFor: null }));

  const emit = (payload) => control(endpoint, '/__fake/emit', { directory: dir, payload });
  check('O7 el flujo de eventos esta abierto', await waitFor(async () => (await emit({ type: 'server.heartbeat', properties: {} })) > 0));
  await emit({ type: 'permission.asked', properties: { id: 'per_1', sessionID: sid, permission: 'read', patterns: [], metadata: {}, always: [] } });
  check('O7 permission.asked -> waiting permission prompt', await waitFor(() => seen.at(-1) === 'waiting:permission prompt'), show(seen));
  await emit({ type: 'question.asked', properties: { id: 'que_1', sessionID: sid, questions: [] } });
  await emit({ type: 'permission.replied', properties: { sessionID: sid, requestID: 'per_1', reply: 'once' } });
  check('O7 con los dos pendientes gana el permiso; al contestarlo, waiting question',
    await waitFor(() => seen.at(-1) === 'waiting:question') && same(seen, ['null', 'busy:', 'waiting:permission prompt', 'waiting:question']), show(seen));
  await emit({ type: 'question.replied', properties: { sessionID: sid, requestID: 'que_1', answers: [['B']] } });
  check('O7 question.replied -> vuelve a busy', await waitFor(() => seen.at(-1) === 'busy:'), show(seen));

  const countBefore = seen.length;
  await emit({ type: 'session.status', properties: { sessionID: other, status: { type: 'idle' } } });
  await emit({ type: 'permission.asked', properties: { id: 'per_9', sessionID: other, permission: 'read', patterns: [], metadata: {}, always: [] } });
  await emit({ type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } });
  check('O7 eventos de otra sesion no avisan: solo llega el idle de esta',
    await waitFor(() => seen.at(-1) === 'idle:') && seen.length === countBefore + 1 && same(otherSeen, ['null']), show({ seen, otherSeen }));

  check('O7 waitUntilReady de una sesion no rastreada: false enseguida', (await status.waitUntilReady(other, 5000)) === false);
  check('O7 waitUntilReady libre y sin nada pendiente: true', (await status.waitUntilReady(sid, 5000)) === true);
  await emit({ type: 'session.status', properties: { sessionID: sid, status: { type: 'busy' } } });
  await waitFor(() => seen.at(-1) === 'busy:');
  check('O7 waitUntilReady ocupada todo el plazo: false', (await status.waitUntilReady(sid, 60)) === false);
  const ready = status.waitUntilReady(sid, 5000);
  await emit({ type: 'session.status', properties: { sessionID: sid, status: { type: 'idle' } } });
  check('O7 waitUntilReady espera por condicion: pasa a idle -> true', (await ready) === true);

  // Reconexion: el falso corta el flujo; la foto nueva trae lo que paso sin conexion.
  const snapshotsBefore = (await requestsOf(endpoint)).filter((item) => item.path === '/session/status').length;
  await control(endpoint, '/__fake/state', {
    status: { [dir]: { [sid]: { type: 'busy' } } },
    questions: { [dir]: [{ id: 'que_7', sessionID: sid, questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }] }] }] },
  });
  const dropped = await control(endpoint, '/__fake/drop', {});
  check('O7 el falso corta el flujo', dropped >= 1, show(dropped));
  check('O7 reconecta y rehace la foto: waiting question sin ningun evento',
    await waitFor(async () => seen.at(-1) === 'waiting:question' &&
      (await requestsOf(endpoint)).filter((item) => item.path === '/session/status').length > snapshotsBefore), show(seen));
  const snapshotRequests = (await requestsOf(endpoint)).filter((item) => ['/session/status', '/permission', '/question'].includes(item.path));
  check('O7 la foto se pide con la carpeta de la sesion', snapshotRequests.length >= 6 && snapshotRequests.every((item) => item.directory === dir));

  status.detach({ ...endpoint });
  check('O7 el aviso de salida de otro endpoint no suelta al actual', status.current(sid) !== null);

  await control(endpoint, '/__fake/exit', {});
  check('O7 el proceso muere -> listener(null)', await waitFor(() => seen.at(-1) === 'null'), show(seen));
  check('O7 ... current null y waitUntilReady false', status.current(sid) === null && (await status.waitUntilReady(sid, 5000)) === false);

  stop();
  status.dispose();
  await own.dispose();
}

// ---------------------------------------------------------------------------
// O8. Contestar preguntas, con la base de prueba
// ---------------------------------------------------------------------------

{
  const { createOpenCodeFixture, openCodeBaseContent, partRow } = await import('./fixtures/opencode-db.mjs');
  const { OPENCODE_REQUIRED_COLUMNS } = await import('../src/agents/opencode/sql.ts');
  const { ReadOnlyDatabase } = await import('../src/agents/sqlite.ts');

  const content = openCodeBaseContent();
  const c3 = { id: 'msg_c03', session_id: 'ses_c_rica' };
  const question = (callID, input) => ({
    type: 'tool', tool: 'question', callID,
    state: { status: 'running', input, metadata: {}, time: { start: 3308 } },
  });
  content.parts.push(
    partRow(c3, 'prt_q1', 3308, question('call_q1', { questions: [{ header: 'Letra', question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }] })),
    partRow(c3, 'prt_q3', 3309, question('call_q3', { questions: [{ header: 'Cerrada', question: '¿Si o no?', options: [{ label: 'Si' }, { label: 'No' }] }] })),
    partRow(c3, 'prt_q4', 3310, question('call_q4', { questions: [{ header: 'Otra', question: '¿Cual?', options: [{ label: 'X' }] }] })),
  );
  const fixture = await createOpenCodeFixture(path.join(root, 'db'), content);
  const db = new ReadOnlyDatabase(fixture.file, { idleCloseMs: 60_000, required: OPENCODE_REQUIRED_COLUMNS, label: 'OpenCode' });

  check('O8 readPartCall: mensaje y callID de una pregunta', same(readPartCall(db, 'prt_q1', 'ses_c_rica'), { messageId: 'msg_c03', callId: 'call_q1' }));
  check('O8 readPartCall: de otra sesion, de otra herramienta o que no existe -> null',
    readPartCall(db, 'prt_q1', 'ses_z_vieja') === null && readPartCall(db, 'prt_c02d', 'ses_c_rica') === null && readPartCall(db, 'prt_nada', 'ses_c_rica') === null);

  const cwd = 'D:\\Otro con espacios';
  const tool = (callID, messageID = 'msg_c03') => ({ messageID, callID });
  await control(mainEndpoint, '/__fake/state', {
    questions: {
      [cwd]: [
        { id: 'que_1', sessionID: 'ses_c_rica', questions: [{ question: '¿A o B?', header: 'Letra', options: [{ label: 'A' }, { label: 'B' }] }], tool: tool('call_q1') },
        { id: 'que_2', sessionID: 'ses_c_rica', questions: [{ question: 'Colores', header: 'C', multiple: true, options: [{ label: 'Rojo' }, { label: 'Verde' }, { label: 'Azul' }] }], tool: tool('call_c03c') },
        { id: 'que_3', sessionID: 'ses_c_rica', questions: [{ question: '¿Si o no?', header: 'Cerrada', custom: false, options: [{ label: 'Si' }, { label: 'No' }] }], tool: tool('call_q3') },
        { id: 'que_4', sessionID: 'ses_c_rica', questions: [{ question: '¿Cual?', header: 'Otra', options: [{ label: 'X' }] }], tool: tool('call_q4', 'msg_otro') },
      ],
    },
  });

  const requestsBefore = (await requestsOf(mainEndpoint)).length;
  let serveUp = true;
  const questions = new OpenCodeQuestions({
    lookupCall: (partId, sessionId) => readPartCall(db, partId, sessionId),
    client: () => (serveUp ? client : null),
  });
  const target = { cwd, sessionId: 'ses_c_rica' };
  const replies = async () => (await requestsOf(mainEndpoint)).filter((item) => item.method === 'POST' && /^\/question\/.+\/reply$/.test(item.path));

  const single = await questions.answer(target, 'prt_q1', [[1]]);
  const afterSingle = await replies();
  check('O8 pedido pendiente que casa -> answered', single === 'answered', single);
  check('O8 ... POST /question/que_1/reply?directory=<carpeta de la pestana> con {"answers":[["B"]]}',
    afterSingle.length === 1 && afterSingle[0].path === '/question/que_1/reply' &&
    afterSingle[0].search === `?directory=${encodeURIComponent(cwd)}` && same(afterSingle[0].body, { answers: [['B']] }), show(afterSingle));
  check('O8 (A1) la carpeta es la de la pestana, no la del serve', afterSingle[0]?.directory === cwd && afterSingle[0]?.directory !== serveCwd);
  const lookups = (await requestsOf(mainEndpoint)).slice(requestsBefore).filter((item) => item.method === 'GET' && item.path === '/question');
  check('O8 (A1) los pendientes tambien se piden con la carpeta de la pestana', lookups.length >= 1 && lookups.every((item) => item.directory === cwd));

  const multiple = await questions.answer(target, 'prt_c03c', [[2, 0]]);
  const afterMultiple = await replies();
  check('O8 multiple -> las etiquetas en el orden de las opciones',
    multiple === 'answered' && afterMultiple.length === 2 && afterMultiple[1].path === '/question/que_2/reply' &&
    same(afterMultiple[1].body, { answers: [['Rojo', 'Azul']] }), show(afterMultiple[1]));

  const free = await questions.answer(target, 'prt_q1', [{ kind: 'free', text: '  \x1b[201~Ninguna\r\nde las dos\x00\x1b ' }]);
  const afterFree = await replies();
  check('O8 texto libre saneado: sin escapes ni nulos, \\r\\n como \\n, sin espacios a los lados',
    free === 'answered' && afterFree.length === 3 && same(afterFree[2].body, { answers: [['Ninguna\nde las dos']] }), show(afterFree[2]?.body));

  const invalid = [
    ['cantidad distinta', 'prt_q1', [[1], [0]]],
    ['indice fuera de rango', 'prt_q1', [[5]]],
    ['indice negativo', 'prt_q1', [[-1]]],
    ['opcion unica con dos', 'prt_q1', [[0, 1]]],
    ['multiple vacia', 'prt_c03c', [[]]],
    ['multiple con repetidas', 'prt_c03c', [[1, 1]]],
    ['texto vacio tras sanear', 'prt_q1', [{ kind: 'free', text: ' \x1b[200~ ' }]],
    ['texto de mas de 2 000', 'prt_q1', [{ kind: 'free', text: 'x'.repeat(2001) }]],
  ];
  const invalidOutcomes = [];
  for (const [label, partId, selections] of invalid) {
    invalidOutcomes.push([label, await questions.answer(target, partId, selections)]);
  }
  check('O8 lo que no contesta la pregunta -> invalid', invalidOutcomes.every(([, outcome]) => outcome === 'invalid'), show(invalidOutcomes));
  // B4 (paso 5): la tarjeta ofrece escribir siempre; la pregunta cerrada lo rechaza con su propio motivo.
  const closed = await questions.answer(target, 'prt_q3', [{ kind: 'free', text: 'quizas' }]);
  const closedBadIndex = await questions.answer(target, 'prt_q3', [[7]]);
  check('O8 custom false con texto -> no-free-text; con un indice fuera de rango sigue siendo invalid',
    closed === 'no-free-text' && closedBadIndex === 'invalid', show([closed, closedBadIndex]));
  check('O8 ... y ningun POST', (await replies()).length === 3);
  check('O8 answersFor acepta 2 000 caracteres justos', same(answersFor([{ options: [], multiple: false, custom: true }], [{ kind: 'free', text: 'y'.repeat(2000) }]), [['y'.repeat(2000)]]));

  const notPending = [
    ['callID que no esta pendiente', target, 'prt_c03b'],
    ['messageID distinto', target, 'prt_q4'],
    ['parte de otra sesion', { cwd, sessionId: 'ses_z_vieja' }, 'prt_q1'],
    ['parte que no existe', target, 'prt_nada'],
    ['otra carpeta: el serve no la tiene pendiente ahi', { cwd: 'D:\\Otra carpeta', sessionId: 'ses_c_rica' }, 'prt_q1'],
  ];
  const notPendingOutcomes = [];
  for (const [label, where, partId] of notPending) {
    notPendingOutcomes.push([label, await questions.answer(where, partId, [[0]])]);
  }
  serveUp = false;
  notPendingOutcomes.push(['sin serve', await questions.answer(target, 'prt_q1', [[0]])]);
  serveUp = true;
  check('O8 lo que no esta pendiente -> not-pending', notPendingOutcomes.every(([, outcome]) => outcome === 'not-pending'), show(notPendingOutcomes));
  check('O8 ... y ningun POST', (await replies()).length === 3);

  db.close();
  fixture.close();
  await control(mainEndpoint, '/__fake/state', { questions: {} });
}

// ---------------------------------------------------------------------------
// O10. El gancho de la pestana
// ---------------------------------------------------------------------------

{
  const status = new OpenCodeServeStatus({ snapshotRetryDelaysMs: [20, 40, 80] });
  const cwd = 'D:\\Gancho';
  const busy = 'ses_ganchobusy0000000000000001';
  const idle = 'ses_ganchoidle0000000000000001';
  await control(mainEndpoint, '/__fake/state', { status: { [cwd]: { [busy]: { type: 'busy' } } } });
  status.track(busy, cwd, client);
  status.track(idle, cwd, client);
  check('O10 el estado conoce las dos sesiones', await waitFor(() => status.current(busy)?.activity === 'busy' && status.current(idle)?.activity === 'idle'));

  const aborts = async (sessionId) => (await requestsOf(mainEndpoint)).filter((item) => item.method === 'POST' && item.path === `/session/${sessionId}/abort`);
  /** Una peticion cualquiera, para saber que lo anterior ya llego al falso. */
  const marker = async () => {
    const before = (await requestsOf(mainEndpoint)).length;
    await client.sessionStatus('D:\\Marcador');
    return waitFor(async () => (await requestsOf(mainEndpoint)).length > before);
  };

  let releasedBusy = 0;
  const hook = createServeLaunchHook({
    sessionId: busy, cwd, release: () => releasedBusy++, current: () => status.current(busy), abort: (dir, id) => client.abort(dir, id),
  });
  hook.onInput('x');
  await marker();
  check('O10 onInput("x") no suelta nada ni corta', releasedBusy === 0 && (await aborts(busy)).length === 0);

  hook.cancel();
  hook.onExit();
  check('O10 cancel con busy -> un POST .../abort con la carpeta', await waitFor(async () => (await aborts(busy)).length === 1));
  await marker();
  const busyAborts = await aborts(busy);
  check('O10 cancel y onExit seguidos -> uno solo, y se suelta una vez',
    busyAborts.length === 1 && busyAborts[0].directory === cwd && releasedBusy === 1, show({ aborts: busyAborts.length, releasedBusy }));

  let releasedIdle = 0;
  const idleHook = createServeLaunchHook({
    sessionId: idle, cwd, release: () => releasedIdle++, current: () => status.current(idle), abort: (dir, id) => client.abort(dir, id),
  });
  idleHook.onExit();
  await marker();
  check('O10 con idle -> ningun abort, y se suelta', (await aborts(idle)).length === 0 && releasedIdle === 1);

  let waitingAborts = 0;
  createServeLaunchHook({
    sessionId: busy, cwd, release: () => {}, current: () => ({ activity: 'waiting', waitingFor: 'question' }),
    abort: () => {
      waitingAborts++;
      return Promise.resolve();
    },
  }).cancel();
  check('O10 esperando una respuesta tambien corta', waitingAborts === 1);

  // M7: el `serve` ya murio en el apagado; el corte rechaza o lanza, y nada queda sin manejar.
  const unhandledBefore = unhandled;
  let threw = false;
  try {
    createServeLaunchHook({
      sessionId: busy, cwd, release: () => {}, current: () => ({ activity: 'busy', waitingFor: null }),
      abort: () => Promise.reject(new Error('el serve ya no esta')),
    }).cancel();
    createServeLaunchHook({
      sessionId: busy, cwd, release: () => {}, current: () => ({ activity: 'busy', waitingFor: null }),
      abort: () => {
        throw new Error('sin cliente');
      },
    }).cancel();
  } catch {
    threw = true;
  }
  await flushAsync();
  await flushAsync();
  await flushAsync();
  check('O10 (M7) un abort que rechaza o lanza: cancel no lanza y no queda ninguna promesa sin manejar',
    !threw && unhandled === unhandledBefore, show({ threw, unhandled: unhandled - unhandledBefore }));

  let releasedAfterDeath = 0;
  let abortsAfterDeath = 0;
  status.detach();
  createServeLaunchHook({
    sessionId: busy, cwd, release: () => releasedAfterDeath++, current: () => status.current(busy),
    abort: () => {
      abortsAfterDeath++;
      return Promise.resolve();
    },
  }).cancel();
  check('O10 (M7) con el serve ya soltado el estado es null: se suelta y no se pide nada', releasedAfterDeath === 1 && abortsAfterDeath === 0);
  status.dispose();
}

// ---------------------------------------------------------------------------
// O11. El adaptador cableado (paso 5): capacidades, lanzamiento, estado,
// preguntas, gancho y dispose, contra un `serve` falso que lanza el propio
// adaptador
// ---------------------------------------------------------------------------

{
  const { createOpenCodeAdapter, OPENCODE_CAPABILITIES } = await import('../src/agents/opencode/index.ts');
  const { createOpenCodeFixture, openCodeBaseContent, partRow } = await import('./fixtures/opencode-db.mjs');

  check('O11 OPENCODE_CAPABILITIES igual al literal de §5.3, sin promptApi (A4)', same(OPENCODE_CAPABILITIES, {
    sessionIdAtLaunch: true, resume: true, statusSource: true, readySignal: false, permissionCycle: null, models: null, efforts: null,
    questionCards: true, imagesByPath: 'bare-path-paste', fileMentions: null, rewind: false, contextWindowSource: 'usage-with-catalog', plans: false,
    waitingBlocksSubmit: true,
  }) && !('promptApi' in OPENCODE_CAPABILITIES), show(OPENCODE_CAPABILITIES));

  const content = openCodeBaseContent();
  const c3 = { id: 'msg_c03', session_id: 'ses_c_rica' };
  content.parts.push(partRow(c3, 'prt_q1', 3308, {
    type: 'tool', tool: 'question', callID: 'call_q1',
    state: { status: 'running', input: { questions: [{ header: 'Letra', question: '¿A o B?', options: [{ label: 'A' }, { label: 'B' }] }] }, metadata: {}, time: { start: 3308 } },
  }));
  const fixture = await createOpenCodeFixture(path.join(root, 'db-o11'), content);

  const clock = manualClock();
  const before = spawned.length;
  const adapter = createOpenCodeAdapter({
    env: { OPENCODE_DB: fixture.file },
    home,
    serveEnv: baseEnvFor(),
    serveProcess: { spawn: spySpawn, cwd: serveCwd, timers: clock.timers, idleStopMs: 1000 },
    serveClient: { reconnectDelaysMs: [20, 40, 80] },
    serveStatus: { snapshotRetryDelaysMs: [20, 40, 80] },
  });

  const environment = adapter.environment({ PATH: 'p', OPENCODE_SERVER_PASSWORD: 'heredada', VACIA: undefined });
  check('O11 environment(): copia sin claves nuevas ni aviso; la pty no gana la contrasena del serve',
    same(environment, { env: { PATH: 'p', OPENCODE_SERVER_PASSWORD: 'heredada' }, notice: null }), show(environment));
  check('O11 defaults(): null (opencode.json no se abre)', (await adapter.defaults('D:\\x')) === null);
  check('O11 crear el adaptador no lanza ningun serve', spawned.length === before);

  const cwd = path.join(root, 'proyecto con espacios');
  const input = (extra = {}) => ({ location, cwd, resumeSessionId: null, proposedSessionId: 'propuesto', launchToken: 't', ...extra });
  const [plan, twin] = await Promise.all([adapter.launch(input()), adapter.launch(input())]);
  const fakeId = 'ses_fakeSession0000000000000001';
  const url = plan.args[2];
  const password = plan.args.at(-1);
  const endpoint = { url, username: 'opencode', password };
  const first = spawned[before];
  check('O11 dos lanzamientos a la vez: un solo serve', spawned.length - before === 1 && first !== undefined, show(spawned.length - before));
  check('O11 launch nueva: attach al serve con la sesion creada por API, known',
    plan.file === process.execPath && /^http:\/\/127\.0\.0\.1:\d+$/.test(url) && HEX48.test(password) &&
    same(plan.args, [fakeScript, 'attach', url, '--dir', '.', '--session', fakeId, '--password', password]) &&
    same(plan.session, { kind: 'known', sessionId: fakeId }) && same(twin.args, plan.args), show(plan.args.slice(1, 7)));
  check('O11 la contrasena del TUI es la del entorno del serve', first?.options.env?.['OPENCODE_SERVER_PASSWORD'] === password);
  const createsOf = async () => (await requestsOf(endpoint)).filter((item) => item.method === 'POST' && item.path === '/session');
  const creates = await createsOf();
  check('O11 cada sesion nueva se crea con la carpeta de la pestana', creates.length === 2 && creates.every((item) => item.directory === cwd), show(creates));

  const resumeId = 'ses_reanudada00000000000000001';
  const resumed = await adapter.launch(input({ resumeSessionId: resumeId }));
  check('O11 reanudar: el mismo serve, el id tal cual y ninguna sesion nueva',
    spawned.length - before === 1 && same(resumed.session, { kind: 'known', sessionId: resumeId }) && resumed.args.includes(resumeId) &&
    (await createsOf()).length === 2);
  let hostileThrew = false;
  try {
    adapter.launch(input({ resumeSessionId: 'ses_x&calc' }));
  } catch {
    hostileThrew = true;
  }
  check('O11 (M1b) reanudar con un id hostil lanza sincronico desde el adaptador', hostileThrew);

  const keyOf = (value) => (value === null ? 'null' : `${value.activity}:${value.waitingFor ?? ''}`);
  const seen = [];
  const stopStatus = adapter.status.subscribe(fakeId, (value) => seen.push(keyOf(value)));
  check('O11 status: la sesion lanzada se rastrea con el serve del adaptador: idle', await waitFor(() => seen.at(-1) === 'idle:'), show(seen));
  const emit = (payload) => control(endpoint, '/__fake/emit', { directory: cwd, payload });
  check('O11 el flujo de eventos esta abierto', await waitFor(async () => (await emit({ type: 'server.heartbeat', properties: {} })) > 0));
  await emit({ type: 'question.asked', properties: { id: 'que_o11', sessionID: fakeId, questions: [] } });
  check('O11 status: una pregunta del serve -> waiting question', await waitFor(() => seen.at(-1) === 'waiting:question'), show(seen));
  await emit({ type: 'question.rejected', properties: { sessionID: fakeId, requestID: 'que_o11' } });
  await waitFor(() => seen.at(-1) === 'idle:');

  // R29-1 cableado: el padre de una sub-agente sale de la base, de a una fila.
  const subagent = 'ses_hijaFake000000000000000001';
  fixture.insertSession({ id: subagent, parent_id: fakeId, directory: cwd, title: 'y (@explore subagent)', time_created: 5000, time_updated: 5000 });
  await emit({ type: 'permission.asked', properties: { id: 'per_o11', sessionID: subagent, permission: 'external_directory', patterns: [], metadata: {}, always: [] } });
  check('O11 (R29-1) un permiso de una sub-agente de la base -> la pestana raiz en waiting permission prompt',
    await waitFor(() => seen.at(-1) === 'waiting:permission prompt'), show(seen));
  await emit({ type: 'permission.replied', properties: { sessionID: subagent, requestID: 'per_o11', reply: 'once' } });
  check('O11 (R29-1) ... contestado, vuelve a libre', await waitFor(() => seen.at(-1) === 'idle:'), show(seen));

  await control(endpoint, '/__fake/state', {
    questions: { [cwd]: [{ id: 'que_1', sessionID: 'ses_c_rica', questions: [{ question: '¿A o B?', header: 'Letra', options: [{ label: 'A' }, { label: 'B' }] }], tool: { messageID: 'msg_c03', callID: 'call_q1' } }] },
  });
  const answered = await adapter.questions.answer({ cwd, sessionId: 'ses_c_rica' }, 'prt_q1', [[1]]);
  const repliesOf = async () => (await requestsOf(endpoint)).filter((item) => item.method === 'POST' && /^\/question\/.+\/reply$/.test(item.path));
  const replies = await repliesOf();
  check('O11 questions: la parte de la base casa con el pedido del serve y se contesta con la carpeta de la pestana',
    answered === 'answered' && replies.length === 1 && replies[0].directory === cwd && same(replies[0].body, { answers: [['B']] }), show([answered, replies]));

  await emit({ type: 'session.status', properties: { sessionID: fakeId, status: { type: 'busy' } } });
  await waitFor(() => seen.at(-1) === 'busy:');
  const spawnedContext = (extra) => ({
    terminalId: 't1', sessionId: fakeId, cwd, resumed: false, pid: 1, launchedAt: Date.now(), launchToken: 't',
    readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: () => undefined, ...extra,
  });
  const hook = adapter.onSpawned(spawnedContext());
  const resumedHook = adapter.onSpawned(spawnedContext({ terminalId: 't2', sessionId: resumeId, resumed: true }));
  // Lo que se mira es que el apagado no corrio: matar es asincrono, y el proceso seguiria vivo un instante igual.
  const firedWithTabs = clock.advance(10_000);
  check('O11 con pestanas vivas el serve no se apaga aunque pase el plazo', firedWithTabs === 0 && isAlive(first.child.pid), show(firedWithTabs));
  const abortsOf = async (sessionId) => (await requestsOf(endpoint)).filter((item) => item.method === 'POST' && item.path === `/session/${sessionId}/abort`);
  hook.onInput('x');
  hook.cancel();
  hook.onExit();
  check('O11 cerrar la pestana ocupada corta su sesion en el serve, una vez y con su carpeta',
    await waitFor(async () => (await abortsOf(fakeId)).length === 1) && (await abortsOf(fakeId))[0].directory === cwd);
  const firedWithOne = clock.advance(10_000);
  check('O11 con la otra pestana viva, el serve sigue', firedWithOne === 0 && isAlive(first.child.pid), show(firedWithOne));
  resumedHook.onExit();
  check('O11 la reanudada, libre, se suelta sin cortar nada', (await abortsOf(resumeId)).length === 0);
  const firedEarly = clock.advance(999);
  check('O11 sin pestanas, antes del plazo sigue vivo', firedEarly === 0 && isAlive(first.child.pid), show(firedEarly));
  clock.advance(1);
  check('O11 sin pestanas, al vencer el plazo el serve se apaga', await waitFor(() => !isAlive(first.child.pid)));
  check('O11 ... el estado lo sabe: la sesion pasa a null (offline)', await waitFor(() => seen.at(-1) === 'null'), show(seen));
  // Un cliente viejo que siguiera en uso pediria a un puerto muerto y rechazaria: se atrapa para que falle por su nombre.
  const afterDeath = await adapter.questions.answer({ cwd, sessionId: 'ses_c_rica' }, 'prt_q1', [[1]]).catch((error) => error);
  check('O11 ... y las preguntas ya no tienen serve: not-pending, sin pedir nada', afterDeath === 'not-pending', String(afterDeath));
  stopStatus();

  const again = await adapter.launch(input());
  const second = spawned[before + 1];
  check('O11 lanzar despues arranca otro serve, con otra URL y otra conexion',
    spawned.length - before === 2 && second !== undefined && again.args[2] !== url && isAlive(second.child.pid));
  const seenAgain = [];
  adapter.status.subscribe(fakeId, (value) => seenAgain.push(keyOf(value)));
  check('O11 el estado sigue la sesion con el serve nuevo', await waitFor(() => seenAgain.at(-1) === 'idle:'), show(seenAgain));

  const secondEndpoint = { url: again.args[2], username: 'opencode', password: again.args.at(-1) };
  await control(secondEndpoint, '/__fake/state', { status: { [cwd]: { [fakeId]: { type: 'busy' } } } });
  await control(secondEndpoint, '/__fake/emit', { directory: cwd, payload: { type: 'session.status', properties: { sessionID: fakeId, status: { type: 'busy' } } } });
  await waitFor(() => seenAgain.at(-1) === 'busy:');
  const lateHook = adapter.onSpawned(spawnedContext({ terminalId: 't3' }));
  const unhandledBefore = unhandled;
  const disposed = adapter.dispose();
  check('O11 dispose devuelve una promesa', disposed instanceof Promise);
  await disposed;
  check('O11 dispose() termina el falso', await waitFor(() => !isAlive(second.child.pid)));
  let lateThrew = false;
  try {
    lateHook.cancel();
  } catch {
    lateThrew = true;
  }
  await flushAsync();
  await flushAsync();
  check('O11 (M7) el gancho que se cancela despues del apagado no lanza, no corta y no deja promesas sin manejar',
    !lateThrew && unhandled === unhandledBefore && adapter.status.current(fakeId) === null);
  fixture.close();
}

// Los rechazos del cuadro y de la tarjeta (D12, B4), puros: el socket solo ejecuta lo que sale de aca.
{
  const pty = await import('../src/pty-input.ts');
  const { ActivityBook } = await import('../src/terminal-activity.ts');
  const ui = await import('../../web/src/agent-ui.ts');
  const { OPENCODE_CAPABILITIES } = await import('../src/agents/opencode/index.ts');
  const { CLAUDE_CODE_CAPABILITIES } = await import('../src/agents/claude-code/index.ts');

  const refuse = (over) => pty.submitRefusal({ label: 'OpenCode', approvesPendingOnCycle: false, waitingFor: null, blind: false, openToolCall: false, ...over });
  check('O11 (D12) OpenCode esperando: el cuadro se rechaza con su motivo',
    refuse({ waitingBlocksSubmit: true, activity: 'waiting' }) === pty.waitingSubmitMessage('OpenCode') &&
    pty.waitingSubmitMessage('OpenCode') === 'OpenCode esta esperando una respuesta: contestala antes de mandar otro mensaje.');
  const passing = ['busy', 'idle', 'offline', 'unknown', null].map((activity) => refuse({ waitingBlocksSubmit: true, activity }));
  check('O11 (D12) trabajando, libre, sin proceso o sin dato: pasa', passing.every((value) => value === null), show(passing));
  check('O11 (D12) sin la capacidad, esperando no bloquea (Claude Code sigue igual)',
    refuse({ waitingBlocksSubmit: false, activity: 'waiting' }) === null && refuse({ activity: 'waiting' }) === null);

  const book = new ActivityBook();
  book.set('t', 'waiting');
  check('O11 (D12) el registro devuelve la ultima actividad de una pestana, y null sin dato',
    book.get('t') === 'waiting' && book.get('otra') === null && (book.delete('t'), book.get('t') === null));

  check('O11 (D12) el cuadro de OpenCode se apaga con el texto de la barra, y con la pregunta en el hilo lo dice',
    ui.pendingApprovalNotice(OPENCODE_CAPABILITIES, 'permission prompt', true) === ui.waitingBarText('permission prompt') &&
    ui.pendingApprovalNotice(OPENCODE_CAPABILITIES, 'question', true) === 'El agente te hizo una pregunta: respondela en el hilo.');
  check('O11 (D12) sin espera, sin proceso, o con Claude Code: el cuadro no se apaga',
    ui.pendingApprovalNotice(OPENCODE_CAPABILITIES, null, true) === null &&
    ui.pendingApprovalNotice(OPENCODE_CAPABILITIES, 'question', false) === null &&
    ui.pendingApprovalNotice(CLAUDE_CODE_CAPABILITIES, 'permission prompt', true) === null);

  const texts = ['answered', 'not-pending', 'invalid', 'no-free-text'].map(pty.answerFailureMessage);
  check('O11 respuesta por API: los textos de answer-failed son los de las teclas, y B4 tiene el suyo',
    texts[0] === null && texts[1] === pty.ANSWER_NOT_PENDING_MESSAGE && texts[1] === 'Esa pregunta ya no esta esperando respuesta.' &&
    texts[2] === pty.ANSWER_INVALID_MESSAGE && texts[2] === 'La respuesta no corresponde a la pregunta.' &&
    typeof texts[3] === 'string' && texts[3].includes('no acepta respuesta escrita'), show(texts));
}

// ---------------------------------------------------------------------------
// O12. El historial no lista las sesiones vacias que crea la app (D14)
// ---------------------------------------------------------------------------

{
  const { createOpenCodeFixture, openCodeBaseContent, messageRow } = await import('./fixtures/opencode-db.mjs');
  const { OPENCODE_SQL, OPENCODE_REQUIRED_COLUMNS } = await import('../src/agents/opencode/sql.ts');
  const { ReadOnlyDatabase, loadSqlite } = await import('../src/agents/sqlite.ts');
  const { createOpenCodeHistory } = await import('../src/agents/opencode/history.ts');

  const fixture = await createOpenCodeFixture(path.join(root, 'db-o12'), openCodeBaseContent());
  const db = new ReadOnlyDatabase(fixture.file, { idleCloseMs: 60_000, required: OPENCODE_REQUIRED_COLUMNS, label: 'OpenCode' });
  const warnings = [];
  const history = createOpenCodeHistory({
    dbFile: fixture.file, db, catalog: { contextWindow: async () => null }, platform: 'win32', sqlite: loadSqlite,
    signal: { subscribe: () => () => undefined }, warn: (message) => warnings.push(message),
  });
  const scanOf = async (id) => history.scan(await history.item(id));

  fixture.insertSession({ id: 'ses_creadaPorLaApi0000000001', directory: 'D:/Mi App', title: 'New session - 2026-09-14T10:00:00.000Z', time_created: 5000, time_updated: 5000 });
  const empty = await scanOf('ses_creadaPorLaApi0000000001');
  check('O12 raiz sin mensajes y con "New session - ...": null, y sin aviso', empty === null && warnings.length === 0, show([empty, warnings]));
  const listed = (await history.list())?.map((item) => item.ref) ?? [];
  check('O12 list la enumera (sin leer mensajes): lo que la saca de la barra es scan', listed.includes('ses_creadaPorLaApi0000000001'), show(listed));

  fixture.insertMessage(messageRow('ses_creadaPorLaApi0000000001', 'msg_o12_1', 5100, { role: 'user' }));
  fixture.update('session', 'ses_creadaPorLaApi0000000001', { time_updated: 5100 });
  const changed = await history.changedRefs(fixture.file);
  const withMessage = await scanOf('ses_creadaPorLaApi0000000001');
  check('O12 con su primer mensaje cambia, se lee y se lista', changed.includes('ses_creadaPorLaApi0000000001') && withMessage !== null, show([changed, withMessage?.summary]));

  fixture.insertSession({ id: 'ses_tituloPropio00000000001', directory: 'D:/Mi App', title: 'Un titulo propio', time_created: 6000, time_updated: 6000 });
  fixture.insertSession({ id: 'ses_tituloPropio00000000002', directory: 'D:/Mi App', title: 'Otro titulo propio', time_created: 6100, time_updated: 6100 });
  const own = await scanOf('ses_tituloPropio00000000001');
  await scanOf('ses_tituloPropio00000000002');
  check('O12 sin mensajes y con titulo propio: se lista, y avisa una sola vez',
    own !== null && own.summary.title === 'Un titulo propio' && warnings.length === 1 && warnings[0].includes('message'), show(warnings));

  /*
    Una base que deja de leerse justo al preguntar por los mensajes (una
    columna que falta: la consulta no lanza y da undefined) no es "sin
    mensajes": null sacaria de la barra una sesion con titulo por defecto.
  */
  let breakOnMessages = false;
  let broken = false;
  const flaky = {
    status: () => (broken ? 'schema' : db.status()),
    all: (sql, ...params) => db.all(sql, ...params),
    get: (sql, ...params) => {
      if (breakOnMessages && sql === OPENCODE_SQL.sessionHasMessages) {
        broken = true;
        return undefined;
      }
      return db.get(sql, ...params);
    },
  };
  const flakyHistory = createOpenCodeHistory({
    dbFile: fixture.file, db: flaky, catalog: { contextWindow: async () => null }, platform: 'win32', sqlite: loadSqlite,
    signal: { subscribe: () => () => undefined }, warn: () => undefined,
  });
  const defaultTitled = await flakyHistory.item('ses_a_nueva');
  breakOnMessages = true;
  let outcome;
  try {
    outcome = await flakyHistory.scan(defaultTitled);
  } catch (error) {
    outcome = error;
  }
  check('O12 con la base ilegible al preguntar por los mensajes: lanza (se reintenta), no da null',
    broken && outcome instanceof Error, String(outcome));

  check('O12 partCallById filtra por id y sesion, solo preguntas',
    /\bWHERE id = \$id AND session_id = \$s\b/.test(OPENCODE_SQL.partCallById) && OPENCODE_SQL.partCallById.includes("'$.tool') = 'question'"));
  check('O12 (D7) sin discoveryRows', !('discoveryRows' in OPENCODE_SQL));
  db.close();
  fixture.close();
}

// ---------------------------------------------------------------------------
// O13. El `serve` que muere sin que la app lo pida (M2): el motivo llega a la
// pestana, la vista ofrece relanzar y relanzar vuelve a enganchar la sesion
// ---------------------------------------------------------------------------

{
  const keyWithReason = (value, reason) => (value === null ? `null${reason === undefined ? '' : `:${reason}`}` : `${value.activity}:${value.waitingFor ?? ''}`);

  // El proceso: quien lo mato.
  {
    const clock = manualClock();
    const serve = makeServe({ timers: clock.timers, idleStopMs: 1000 });
    const exits = [];
    serve.onExit((endpoint, exit) => exits.push({ endpoint, requested: exit?.requested }));

    const first = await serve.ensure();
    await control(first, '/__fake/exit', {});
    check('O13 un serve que muere solo avisa requested: false', await waitFor(() => exits.length === 1) && exits[0].endpoint === first && exits[0].requested === false, show(exits.map((e) => e.requested)));

    const second = await serve.ensure();
    const secondChild = spawned.at(-1).child;
    secondChild.kill();
    check('O13 uno que mata otro proceso (no la app) tambien: requested false', await waitFor(() => exits.length === 2) && exits[1].endpoint === second && exits[1].requested === false, show(exits.map((e) => e.requested)));

    const third = await serve.ensure();
    serve.retain()();
    clock.advance(1000);
    check('O13 el apagado por inactividad avisa requested: true', await waitFor(() => exits.length === 3) && exits[2].endpoint === third && exits[2].requested === true, show(exits.map((e) => e.requested)));

    const fourth = await serve.ensure();
    await serve.dispose();
    check('O13 dispose avisa requested: true', await waitFor(() => exits.length === 4) && exits[3].endpoint === fourth && exits[3].requested === true, show(exits.map((e) => e.requested)));
  }

  // El estado, con un cliente de mentira: a quien le llega el motivo y hasta cuando.
  {
    const stubFor = (url) => ({
      endpoint: { url, username: 'opencode', password: 'x' },
      sessionStatus: async () => ({}),
      pendingPermissions: async () => [],
      pendingQuestions: async () => [],
      events: (_event, connected) => {
        setImmediate(connected);
        return () => {};
      },
    });
    const status = new OpenCodeServeStatus();
    const stubA = stubFor('http://127.0.0.1:11');
    const tracked = 'ses_perdida0000000000000000001';
    const other = 'ses_otraSinServe00000000000001';
    const seen = [];
    const otherSeen = [];
    status.subscribe(tracked, (value, reason) => seen.push(keyWithReason(value, reason)));
    status.subscribe(other, (value, reason) => otherSeen.push(keyWithReason(value, reason)));
    status.track(tracked, 'D:\\Perdida', stubA);
    await waitFor(() => seen.at(-1) === 'idle:');

    status.detach(stubA.endpoint, 'server-closed');
    check('O13 detach con motivo: la sesion que atendia recibe null con server-closed; la que no, nada nuevo',
      seen.at(-1) === 'null:server-closed' && same(otherSeen, ['null']), show({ seen, otherSeen }));
    const late = [];
    status.subscribe(tracked, (value, reason) => late.push(keyWithReason(value, reason)));
    check('O13 quien se suscribe despues (el registro al rehacer el seguimiento) tambien recibe el motivo', same(late, ['null:server-closed']), show(late));

    const stubB = stubFor('http://127.0.0.1:12');
    status.track('ses_otraPestana000000000000001', 'D:\\Otra', stubB);
    status.detach(stubB.endpoint);
    check('O13 otra pestana lanza un serve nuevo y ese se apaga pedido: la perdida conserva su motivo',
      seen.at(-1) === 'null:server-closed' && late.at(-1) === 'null:server-closed', show({ seen, late }));

    const stubC = stubFor('http://127.0.0.1:13');
    status.track(tracked, 'D:\\Perdida', stubC);
    check('O13 relanzarla (track) olvida el motivo: vuelve a tener estado', await waitFor(() => seen.at(-1) === 'idle:'), show(seen));
    status.detach(stubC.endpoint);
    check('O13 ... y un apagado pedido despues es un null sin motivo', seen.at(-1) === 'null', show(seen));

    // Si muere antes de la primera foto, quien ya habia recibido un null a secas tambien se entera del motivo.
    const hanging = {
      ...stubFor('http://127.0.0.1:14'),
      sessionStatus: () => new Promise(() => {}),
      pendingPermissions: () => new Promise(() => {}),
      pendingQuestions: () => new Promise(() => {}),
    };
    status.track(tracked, 'D:\\Perdida', hanging);
    await flushAsync();
    const beforePhoto = seen.length;
    status.detach(hanging.endpoint, 'server-closed');
    check('O13 muerto antes de la primera foto: del null a secas al null con motivo tambien se avisa',
      seen.at(-1) === 'null:server-closed' && seen.length === beforePhoto + 1, show(seen));
    status.dispose();
  }

  // El adaptador cableado, contra el `serve` falso que lanza el mismo.
  {
    const { createOpenCodeAdapter } = await import('../src/agents/opencode/index.ts');
    const clock = manualClock();
    const before = spawned.length;
    const adapter = createOpenCodeAdapter({
      env: { OPENCODE_DB: path.join(root, 'o13-no-existe.db') },
      home,
      serveEnv: baseEnvFor(),
      serveProcess: { spawn: spySpawn, cwd: serveCwd, timers: clock.timers, idleStopMs: 1000 },
      serveClient: { reconnectDelaysMs: [20, 40, 80] },
      serveStatus: { snapshotRetryDelaysMs: [20, 40, 80] },
    });
    const cwd = path.join(root, 'proyecto o13');
    const input = (extra = {}) => ({ location, cwd, resumeSessionId: null, proposedSessionId: 'p', launchToken: 't', ...extra });
    const plan = await adapter.launch(input());
    const sessionId = plan.session.sessionId;
    const endpoint = { url: plan.args[2], username: 'opencode', password: plan.args.at(-1) };
    const hook = adapter.onSpawned({
      terminalId: 'o13', sessionId, cwd, resumed: false, pid: 1, launchedAt: Date.now(), launchToken: 't',
      readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: () => undefined,
    });
    const seen = [];
    adapter.status.subscribe(sessionId, (value, reason) => seen.push(keyWithReason(value, reason)));
    await waitFor(() => seen.at(-1) === 'idle:');
    const firstChild = spawned[before].child;

    await control(endpoint, '/__fake/exit', {});
    check('O13 adaptador: el serve muere solo con una pestana viva -> la sesion pasa a null con server-closed',
      await waitFor(() => seen.at(-1) === 'null:server-closed') && !isAlive(firstChild.pid), show(seen));

    // Relanzar: el registro termina el TUI (su gancho sale) y lanza de nuevo con la misma sesion.
    hook.onExit();
    const relaunched = await adapter.launch(input({ resumeSessionId: sessionId }));
    const secondEndpoint = { url: relaunched.args[2], username: 'opencode', password: relaunched.args.at(-1) };
    check('O13 relanzar arranca otro serve y hace attach a la misma sesion, sin crear otra',
      spawned.length - before === 2 && relaunched.args[2] !== plan.args[2] && same(relaunched.session, { kind: 'known', sessionId }) &&
      (await requestsOf(secondEndpoint)).filter((item) => item.method === 'POST' && item.path === '/session').length === 0,
      show({ spawned: spawned.length - before, session: relaunched.session }));
    const relaunchedSeen = [];
    const hook2 = adapter.onSpawned({
      terminalId: 'o13', sessionId, cwd, resumed: true, pid: 2, launchedAt: Date.now(), launchToken: 't2',
      readOutput: () => '', write: () => true, onDone: () => undefined, reportSessionId: () => undefined,
    });
    adapter.status.subscribe(sessionId, (value, reason) => relaunchedSeen.push(keyWithReason(value, reason)));
    check('O13 ... y la sesion relanzada vuelve a tener estado, sin motivo', await waitFor(() => relaunchedSeen.at(-1) === 'idle:') && seen.at(-1) === 'idle:', show({ relaunchedSeen, seen }));

    hook2.onExit();
    clock.advance(1000);
    check('O13 un apagado por inactividad no lleva motivo: null a secas', await waitFor(() => seen.at(-1) === 'null'), show(seen));
    await adapter.dispose();
  }

  // Lo puro del registro, el protocolo y la vista.
  {
    const { ActivityBook, wakeActionFor } = await import('../src/terminal-activity.ts');
    const { parseServerMessage, TERMINAL_OFFLINE_REASONS } = await import('@agent-workbench/shared');
    const ui = await import('../../web/src/agent-ui.ts');

    const book = new ActivityBook();
    book.set('t1', 'offline', 'server-closed');
    book.set('t2', 'idle', 'server-closed');
    check('O13 ActivityBook guarda el motivo solo con offline, y lo reparte en el snapshot',
      book.get('t1') === 'offline' && book.offlineReasonOf('t1') === 'server-closed' && book.offlineReasonOf('t2') === null &&
      same(book.snapshot(), [{ terminalId: 't1', activity: 'offline', offlineReason: 'server-closed' }, { terminalId: 't2', activity: 'idle' }]), show(book.snapshot()));
    book.set('t1', 'offline');
    check('O13 un offline sin motivo (el TUI viejo que sale) lo borra', book.offlineReasonOf('t1') === null && same(book.snapshot()[0], { terminalId: 't1', activity: 'offline' }));

    const actions = [
      wakeActionFor({ launching: false, alive: false, offlineReason: null }),
      wakeActionFor({ launching: false, alive: true, offlineReason: null }),
      wakeActionFor({ launching: false, alive: true, offlineReason: 'server-closed' }),
      wakeActionFor({ launching: true, alive: true, offlineReason: 'server-closed' }),
      wakeActionFor({ launching: true, alive: false, offlineReason: null }),
      wakeActionFor({ launching: false, alive: false, offlineReason: 'server-closed' }),
    ];
    check('O13 wakeActionFor: dormida -> spawn; viva -> none; viva con el servidor cerrado -> restart; lanzandose -> none',
      same(actions, ['spawn', 'none', 'restart', 'none', 'none', 'spawn']), show(actions));

    const parsed = parseServerMessage(JSON.stringify({ type: 'terminal.activity', terminalId: 't', activity: 'offline', offlineReason: 'server-closed' }));
    const unknownReason = parseServerMessage(JSON.stringify({ type: 'terminal.activity', terminalId: 't', activity: 'offline', offlineReason: 'otro' }));
    const wrongActivity = parseServerMessage(JSON.stringify({ type: 'terminal.activity', terminalId: 't', activity: 'busy', offlineReason: 'server-closed' }));
    check('O13 protocolo terminal.activity: el motivo viaja con offline; uno desconocido o con otra actividad se descarta sin perder el mensaje',
      same(TERMINAL_OFFLINE_REASONS, ['server-closed']) && same(parsed, { type: 'terminal.activity', terminalId: 't', activity: 'offline', offlineReason: 'server-closed' }) &&
      same(unknownReason, { type: 'terminal.activity', terminalId: 't', activity: 'offline' }) && same(wrongActivity, { type: 'terminal.activity', terminalId: 't', activity: 'busy' }),
      show({ parsed, unknownReason, wrongActivity }));

    const states = [
      ui.serverClosedBarState({ offlineReason: 'server-closed', alive: true, relaunching: false }),
      ui.serverClosedBarState({ offlineReason: 'server-closed', alive: false, relaunching: false }),
      ui.serverClosedBarState({ offlineReason: null, alive: true, relaunching: false }),
      ui.serverClosedBarState({ offlineReason: null, alive: false, relaunching: true }),
    ];
    check('O13 la barra: con el motivo y la CLI viva ofrece relanzar; relanzando gana aunque la CLI vieja ya salio; sin motivo, nada',
      same(states, ['offer', null, null, 'relaunching']), show(states));
    check('O13 la barra lo dice en una frase, con la etiqueta de la CLI, y el boton dice Relanzar',
      ui.serverClosedBarText('OpenCode') === 'El servidor de OpenCode se cerró y esta pestaña quedó sin conexión.' &&
      ui.serverClosedBarText(null) === 'El servidor de la CLI se cerró y esta pestaña quedó sin conexión.' &&
      ui.SERVER_CLOSED_RELAUNCH_TEXT === 'Relanzar' && ui.SERVER_CLOSED_RELAUNCHING_TEXT === 'Relanzando…');

    const phases = new Map([['t', 'waiting-exit'], ['cerrada', 'waiting-exit']]);
    const step1 = ui.advanceRelaunches(phases, [{ terminalId: 't', alive: true }]);
    const step2 = ui.advanceRelaunches(step1.phases, [{ terminalId: 't', alive: false }]);
    const step3 = ui.advanceRelaunches(step2.phases, [{ terminalId: 't', alive: false }]);
    const step4 = ui.advanceRelaunches(step3.phases, [{ terminalId: 't', alive: true }]);
    check('O13 advanceRelaunches: la lista con el TUI viejo vivo no termina nada; sale -> exited; vive el nuevo -> termina; cerrada -> termina',
      same([...step1.phases], [['t', 'waiting-exit']]) && same(step1.finished, ['cerrada']) &&
      same([...step2.phases], [['t', 'exited']]) && step2.finished.length === 0 &&
      same([...step3.phases], [['t', 'exited']]) && step4.phases.size === 0 && same(step4.finished, ['t']),
      show({ step1, step2: [...step2.phases], step4 }));

    /*
      Con el socket caido en medio de un relanzamiento, la pagina puede no ver
      nunca la lista del medio: al reconectar llega una sola, con el TUI nuevo
      ya vivo. `advanceRelaunches` —a proposito— no termina un 'waiting-exit'
      con una lista viva, y un relanzamiento fallido se queda en 'exited' con
      una muerta. Por eso la vista suelta las fases al reconectar (abajo, en el
      fuente) y la barra la decide la lista.
    */
    const stuck = ui.advanceRelaunches(new Map([['t', 'waiting-exit']]), [{ terminalId: 't', alive: true }]);
    const stuckFailed = ui.advanceRelaunches(new Map([['t', 'exited']]), [{ terminalId: 't', alive: false }]);
    const released = ui.advanceRelaunches(new Map(), [{ terminalId: 't', alive: true }]);
    check('O13 reconexion: una sola lista, viva o muerta, no suelta un relanzamiento; sin fase, la barra la decide la lista',
      same([...stuck.phases], [['t', 'waiting-exit']]) && same([...stuckFailed.phases], [['t', 'exited']]) &&
      released.phases.size === 0 &&
      ui.serverClosedBarState({ offlineReason: null, alive: true, relaunching: false }) === null &&
      ui.serverClosedBarState({ offlineReason: 'server-closed', alive: true, relaunching: false }) === 'offer',
      show({ stuck: [...stuck.phases], stuckFailed: [...stuckFailed.phases] }));

    /*
      Lo que las funciones puras no ven: que el registro, el socket y la vista
      decidan con ellas. Expresiones exactas sobre el fuente, fragiles ante un
      refactor de esas lineas, como las de `check-global-search.mjs`.
    */
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
    const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
    const { readFile } = await import('node:fs/promises');
    const registrySource = await readFile(path.join(srcDir, 'terminal-registry.ts'), 'utf8');
    const socketSource = await readFile(path.join(srcDir, 'terminal-socket.ts'), 'utf8');
    const indexSource = await readFile(path.join(srcDir, 'agents/opencode/index.ts'), 'utf8');
    const viewSource = await readFile(path.join(webDir, 'ConversationView.tsx'), 'utf8');
    const appSource = await readFile(path.join(webDir, 'App.tsx'), 'utf8');
    const workspaceSource = await readFile(path.join(webDir, 'useWorkspace.ts'), 'utf8');
    check('O13 fuente: el adaptador marca server-closed solo si la app no pidio la salida',
      /status\.detach\(endpoint, exit\.requested \? null : 'server-closed'\);/.test(indexSource));
    check('O13 fuente: el registro sigue el motivo y despertar decide con wakeActionFor, terminando la CLI vieja antes de relanzar',
      /status\.subscribe\(sessionId, \(current, offlineReason\) => \{\s*this\.setActivity\(terminalId, current === null \? 'offline' : current\.activity, current === null \? \(offlineReason \?\? null\) : null\);/.test(registrySource) &&
      /offlineReason: this\.activity\.offlineReasonOf\(terminalId\),/.test(registrySource) &&
      /if \(action === 'restart' && !\(await this\.endSessionForRestart\(entry\)\)\) \{/.test(registrySource));
    check('O13 fuente: el socket manda el motivo por evento y al conectar',
      /\{ type: 'terminal\.activity', terminalId, activity, offlineReason \}/.test(socketSource) &&
      /send\(socket, \{ type: 'terminal\.activity', \.\.\.entry \}\);/.test(socketSource));
    check('O13 fuente: la vista dibuja la barra con Relanzar = despertar, y el cuadro se apaga con su texto',
      /<ServerClosedBar text=\{serverClosed\.text\} relaunching=\{serverClosed\.state === 'relaunching'\} onRelaunch=\{onWakeCli\} \/>/.test(viewSource) &&
      /const blockedReason =\s*serverClosedNotice \?\?/.test(appSource) &&
      /if \(offlineReasonsRef\.current\.get\(terminalId\) === 'server-closed'\) \{/.test(workspaceSource) &&
      /const relaunches = advanceRelaunches\(relaunchPhases\.current, message\.terminals\);/.test(workspaceSource));
    // Desde el hito 31 tambien las pestanas provisionales: su `terminal.opened`
    // viaja por el socket que recibio el pedido, asi que con el socket caido no
    // llega nunca y quedarian en la barra para siempre.
    check('O13 fuente: al reconectar se sueltan "Relanzando…", "Abriendo…" y las provisionales: el error o la lista del medio pudieron perderse con el socket viejo',
      /const offReopen = connection\.onReopen\(\(\) => \{(?:\s*\/\/[^\n]*)*\s*dropAllPending\(\);\s*setWaking\(\(current\) => \(current\.size === 0 \? current : new Set\(\)\)\);\s*if \(relaunchPhases\.current\.size > 0\) \{\s*relaunchPhases\.current = new Map\(\);\s*setRelaunching\(new Set\(\)\);\s*\}\s*\}\);/.test(workspaceSource) &&
      /offReopen\(\);\s*connection\.close\(\);/.test(workspaceSource));
  }
}

// ---------------------------------------------------------------------------
// Limpieza: ningun `serve` de mentira queda vivo
// ---------------------------------------------------------------------------

for (const serve of serves) await serve.dispose();
check('limpieza: todos los procesos lanzados terminaron', await waitFor(() => spawned.every((item) => item.child.pid === undefined || !isAlive(item.child.pid))),
  show(spawned.filter((item) => item.child.pid !== undefined && isAlive(item.child.pid)).length));
check('ninguna promesa quedo sin manejar', unhandled === 0, show(unhandled));

await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
