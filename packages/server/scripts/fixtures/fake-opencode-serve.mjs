/**
 * Un `opencode serve` de mentira, para `check-opencode-serve.mjs` (hito 29).
 *
 *   node fake-opencode-serve.mjs serve --hostname 127.0.0.1 --port 0 --mdns=false
 *
 * Se lanza con `process.execPath` como `CliLocation` falsa. Escucha en
 * `127.0.0.1` con un puerto elegido por el sistema, imprime la misma linea que
 * la CLI y sirve con `node:http` las rutas que usa la app, con basic auth
 * (`OPENCODE_SERVER_USERNAME` o `opencode`, y `OPENCODE_SERVER_PASSWORD`).
 * Cada peticion queda anotada. Nada de lo que responde es real.
 *
 * Como se porta lo decide `FAKE_OPENCODE_SERVE_MODE`:
 *
 *  - `ok` (o ausente): arranca normal.
 *  - `wide`: dice que escucha en `0.0.0.0`.
 *  - `silent`: escucha pero no dice nada.
 *  - `early-exit`: escribe en stderr un texto con la contrasena y sale con 3.
 *
 * Y el chequeo lo maneja por `/__fake/*`, con la misma autorizacion:
 *
 *  - `POST /__fake/state`: mezcla el estado (`status`, `permissions` y
 *    `questions` por carpeta, `sessionId`, `html`: rutas que responden HTML).
 *  - `GET /__fake/requests`: lo anotado.
 *  - `POST /__fake/emit`: manda `{directory, payload}` a cada flujo abierto, y
 *    lo aplica al estado (un permiso o una pregunta quedan pendientes).
 *  - `POST /__fake/drop`: corta los flujos abiertos.
 *  - `POST /__fake/exit`: termina el proceso.
 */

import http from 'node:http';

const mode = process.env.FAKE_OPENCODE_SERVE_MODE ?? 'ok';
const password = process.env.OPENCODE_SERVER_PASSWORD ?? '';
const username = process.env.OPENCODE_SERVER_USERNAME || 'opencode';

if (mode === 'early-exit') {
  process.stderr.write(`Error: no se pudo abrir la base (password=${password})\n`);
  process.exit(3);
}

/*
  Se lanza `detached`, como el de verdad: si el chequeo muere a mitad (un
  `throw` que nadie atrapa) nadie lo mataria. Se va solo cuando su padre ya no
  esta.
*/
const parent = process.ppid;
setInterval(() => {
  try {
    process.kill(parent, 0);
  } catch (error) {
    if (error.code !== 'EPERM') process.exit(0);
  }
}, 500).unref();

if (password.length === 0) process.stdout.write('Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.\n');

const expected = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

const state = {
  status: {},
  permissions: {},
  questions: {},
  sessionId: 'ses_fakeSession0000000000000001',
  html: [],
};
const requests = [];
const streams = new Set();

/**
 * Lo que se emite tambien cambia el estado, como en el `serve` de verdad: una
 * foto pedida despues de un evento lo refleja. Sin esto, una foto que cae justo
 * despues de `permission.asked` diria que no hay nada pendiente.
 */
function applyToState(event) {
  const directory = event?.directory ?? '';
  const type = event?.payload?.type;
  const properties = event?.payload?.properties ?? {};
  const list = (key) => (state[key][directory] ??= []);
  switch (type) {
    case 'session.status':
      (state.status[directory] ??= {})[properties.sessionID] = properties.status;
      break;
    case 'permission.asked':
      list('permissions').push(properties);
      break;
    case 'permission.replied':
      state.permissions[directory] = list('permissions').filter((item) => item.id !== properties.requestID);
      break;
    case 'question.asked':
      list('questions').push(properties);
      break;
    case 'question.replied':
    case 'question.rejected':
      state.questions[directory] = list('questions').filter((item) => item.id !== properties.requestID);
      break;
    default:
      break;
  }
}

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(body === undefined ? '' : JSON.stringify(body));
};

const readBody = (request) =>
  new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const raw = await readBody(request);
  let body = null;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  const authorization = request.headers.authorization ?? '';
  const authorized = authorization === expected;

  if (url.pathname.startsWith('/__fake/')) {
    if (!authorized) return json(response, 401, { error: 'unauthorized' });
    switch (url.pathname) {
      case '/__fake/state':
        Object.assign(state, body ?? {});
        return json(response, 200, true);
      case '/__fake/requests':
        return json(response, 200, requests);
      case '/__fake/emit': {
        applyToState(body);
        const frame = `data: ${JSON.stringify(body)}\n\n`;
        for (const stream of streams) stream.write(frame);
        return json(response, 200, streams.size);
      }
      case '/__fake/drop': {
        const count = streams.size;
        for (const stream of streams) stream.destroy();
        streams.clear();
        return json(response, 200, count);
      }
      case '/__fake/exit':
        json(response, 200, true);
        setImmediate(() => process.exit(0));
        return undefined;
      default:
        return json(response, 404, false);
    }
  }

  requests.push({
    method: request.method,
    path: url.pathname,
    search: url.search,
    directory: url.searchParams.get('directory'),
    body,
    basic: authorization.startsWith('Basic '),
    authorized,
    at: Date.now(),
  });

  if (!authorized) return json(response, 401, { error: 'unauthorized' });
  if (state.html.includes(url.pathname)) {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return response.end('<!doctype html><html><body>app</body></html>');
  }

  const directory = url.searchParams.get('directory') ?? '';
  if (request.method === 'GET' && url.pathname === '/global/event') {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    response.write(': conectado\n\n');
    streams.add(response);
    response.on('close', () => streams.delete(response));
    return undefined;
  }
  if (request.method === 'POST' && url.pathname === '/session') return json(response, 200, { id: state.sessionId, directory });
  if (request.method === 'GET' && url.pathname === '/session/status') return json(response, 200, state.status[directory] ?? {});
  if (request.method === 'GET' && url.pathname === '/permission') return json(response, 200, state.permissions[directory] ?? []);
  if (request.method === 'GET' && url.pathname === '/question') return json(response, 200, state.questions[directory] ?? []);
  if (request.method === 'POST' && /^\/question\/[^/]+\/reply$/.test(url.pathname)) return json(response, 200, true);
  if (request.method === 'POST' && /^\/session\/[^/]+\/abort$/.test(url.pathname)) return json(response, 200, true);
  return json(response, 404, { error: 'not found' });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  if (mode === 'silent') return;
  const host = mode === 'wide' ? '0.0.0.0' : '127.0.0.1';
  process.stdout.write(`opencode server listening on http://${host}:${port}\n`);
});
