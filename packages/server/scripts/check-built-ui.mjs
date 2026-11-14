/**
 * Chequeo del servido de la interfaz compilada (SPA fallback y carpetas ocultas).
 *
 *   npx tsx scripts/check-built-ui.mjs
 *
 * Verifica que la interfaz compilada se sirva correctamente tanto desde una ruta
 * normal como desde una que contiene segmentos ocultos (p. ej. ~/.local/),
 * manteniendo el fallback de la SPA y el 404 para archivos inexistentes.
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import express from 'express';
import { mountBuiltUi, LOOKS_LIKE_FILE, NOT_FOUND_TEXT } from '../src/built-ui.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures += 1;
};

function get(url) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent: false,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (typeof addr === 'object' && addr !== null) {
        resolve(`http://127.0.0.1:${addr.port}`);
      } else {
        reject(new Error('No address'));
      }
    });
  });
}

function closeServer(server) {
  if (!server) return Promise.resolve();
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

// ---------------------------------------------------------------------------
// 1. Caso de error: index.html ausente
// ---------------------------------------------------------------------------
{
  const emptyDir = await mkdtemp(path.join(tmpdir(), 'aw-check-empty-'));
  let threw = false;
  try {
    const app = express();
    await mountBuiltUi(app, emptyDir);
  } catch (error) {
    threw = true;
    check('01 index.html ausente lanza excepcion', error instanceof Error && error.message.includes('No compiled interface') || error.message.includes('no compiled interface'));
  } finally {
    await rm(emptyDir, { recursive: true, force: true });
  }
  if (!threw) {
    check('01 index.html ausente lanza excepcion', false, 'no lanzo');
  }
}

// ---------------------------------------------------------------------------
// 2. Experimento controlado: carpeta normal vs carpeta oculta (.local)
// ---------------------------------------------------------------------------
async function testFixtureServing(suiteLabel, baseDirName) {
  const tmpBase = await mkdtemp(path.join(tmpdir(), baseDirName));
  const fixtureDist = path.join(tmpBase, 'web');
  const assetsDir = path.join(fixtureDist, 'assets');
  await mkdir(assetsDir, { recursive: true });

  const indexContent = '<!doctype html><html><body><div id="root">Hello SPA</div></body></html>';
  const jsContent = 'console.log("app");';

  await writeFile(path.join(fixtureDist, 'index.html'), indexContent, 'utf8');
  await writeFile(path.join(assetsDir, 'app.js'), jsContent, 'utf8');

  let server = null;
  try {
    const app = express();
    await mountBuiltUi(app, fixtureDist);
    server = http.createServer(app);
    const baseUrl = await listen(server);

    // a) GET / -> 200 + HTML de SPA
    const rootRes = await get(`${baseUrl}/`);
    const rootType = rootRes.headers['content-type'] ?? '';
    check(
      `${suiteLabel}: GET / devuelve 200 y HTML`,
      rootRes.status === 200 && rootType.startsWith('text/html') && rootRes.body.includes('<div id="root">'),
      `status=${rootRes.status}, type=${rootType}`,
    );

    // b) GET /settings (ruta de SPA sin extension) -> 200 + HTML de SPA
    const spaRouteRes = await get(`${baseUrl}/settings`);
    const spaRouteType = spaRouteRes.headers['content-type'] ?? '';
    check(
      `${suiteLabel}: GET /settings (ruta sin extension) devuelve 200 y HTML`,
      spaRouteRes.status === 200 && spaRouteType.startsWith('text/html') && spaRouteRes.body.includes('<div id="root">'),
      `status=${spaRouteRes.status}, type=${spaRouteType}`,
    );

    // c) GET /assets/app.js (asset existente) -> 200 + text/javascript
    const assetRes = await get(`${baseUrl}/assets/app.js`);
    const assetType = assetRes.headers['content-type'] ?? '';
    check(
      `${suiteLabel}: GET /assets/app.js devuelve 200 y javascript`,
      assetRes.status === 200 && assetType.startsWith('text/javascript'),
      `status=${assetRes.status}, type=${assetType}`,
    );

    // d) GET /assets/missing.js (asset inexistente con extension) -> 404 + text/plain
    const missingFileRes = await get(`${baseUrl}/assets/missing.js`);
    const missingFileType = missingFileRes.headers['content-type'] ?? '';
    check(
      `${suiteLabel}: GET /assets/missing.js devuelve 404 y no la SPA`,
      missingFileRes.status === 404 && missingFileType.startsWith('text/plain') && missingFileRes.body.includes(NOT_FOUND_TEXT),
      `status=${missingFileRes.status}, type=${missingFileType}`,
    );

    // e) GET /assets/missing (ruta bajo assets sin extension) -> 200 + HTML de SPA (frontera de LOOKS_LIKE_FILE)
    const missingSpaRes = await get(`${baseUrl}/assets/missing`);
    const missingSpaType = missingSpaRes.headers['content-type'] ?? '';
    check(
      `${suiteLabel}: GET /assets/missing (sin extension) cae en SPA fallback`,
      missingSpaRes.status === 200 && missingSpaType.startsWith('text/html') && missingSpaRes.body.includes('<div id="root">'),
      `status=${missingSpaRes.status}, type=${missingSpaType}`,
    );
  } finally {
    await closeServer(server);
    await rm(tmpBase, { recursive: true, force: true });
  }
}

// (a) Carpeta normal
await testFixtureServing('Carpeta normal', 'aw-check-normal-');

// (b) Carpeta oculta (.local)
await testFixtureServing('Carpeta oculta (.local)', '.aw-check-local-');

if (failures > 0) {
  console.error(`\n${failures} FALLO(S)`);
  process.exit(1);
} else {
  console.log('\nTODO OK');
}
