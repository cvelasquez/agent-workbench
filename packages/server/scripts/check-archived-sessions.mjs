/**
 * Chequeo del estado de sesiones archivadas.
 *
 *   npx tsx scripts/check-archived-sessions.mjs
 *
 * Es estado persistido que se lee una sola vez, al arrancar, y que decide que
 * ve el usuario en la barra lateral. Las dos formas de romperlo son silenciosas
 * y opuestas: perder la lista hace reaparecer todo lo que se archivo, y leer
 * mal un formato futuro esconde sesiones que nadie escondio.
 *
 * Trabaja sobre un `APPDATA`/`XDG_CONFIG_HOME` temporal propio, para no tocar
 * la configuracion real de quien lo corre.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = path.join(tmpdir(), `check-archived-${process.pid}`);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

// El store resuelve la carpeta al escribir, asi que alcanza con apuntarla antes
// de importarlo.
process.env['APPDATA'] = dir;
process.env['XDG_CONFIG_HOME'] = dir;

const { ArchivedSessions } = await import('../src/archived-sessions.ts');
const { archivedSessionsPath } = await import('../src/paths.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const C = '33333333-3333-3333-3333-333333333333';

// ---------------------------------------------------------------------------
// Ida y vuelta
// ---------------------------------------------------------------------------

const store = new ArchivedSessions();
await store.load();
check('sin archivo, no hay nada archivado', store.snapshot().length === 0);

check('archivar dos avisa que cambio', store.set([A, B], true) === true);
check('y quedan archivadas', store.has(A) && store.has(B));
check('lo que no se archivo, no', !store.has(C));

check(
  'archivar lo ya archivado no cambia nada',
  store.set([A], true) === false,
  'sin esto, la barra lateral se repinta entera por un clic sin efecto',
);

check('restaurar avisa que cambio', store.set([A], false) === true);
check('y deja de estar archivada', !store.has(A));
check('restaurar lo que no estaba no cambia nada', store.set([C], false) === false);

await store.flush();

const reloaded = new ArchivedSessions();
await reloaded.load();
check('sobrevive al reinicio', reloaded.has(B) && !reloaded.has(A), reloaded.snapshot().join(','));

// El conjunto que sale no puede ser el que usa el store por dentro.
const snapshot = reloaded.snapshot();
snapshot.push('intruso');
check('el snapshot es una copia', !reloaded.has('intruso'));

// ---------------------------------------------------------------------------
// Archivos que no entendemos
// ---------------------------------------------------------------------------

const target = archivedSessionsPath();

await writeFile(target, 'esto no es json', 'utf8');
const broken = new ArchivedSessions();
await broken.load();
check('un archivo corrupto no lanza y arranca vacio', broken.snapshot().length === 0);

await writeFile(target, JSON.stringify({ version: 99, sessionIds: [A, B] }), 'utf8');
const future = new ArchivedSessions();
await future.load();
check(
  'una version desconocida se ignora entera',
  future.snapshot().length === 0,
  'interpretar mal un formato futuro esconderia sesiones que nadie escondio',
);

await writeFile(target, JSON.stringify({ version: 1, sessionIds: [A, 42, '', null, B] }), 'utf8');
const messy = new ArchivedSessions();
await messy.load();
check(
  'las entradas que no son texto se descartan sin perder las buenas',
  messy.has(A) && messy.has(B) && messy.snapshot().length === 2,
  messy.snapshot().join(','),
);

// ---------------------------------------------------------------------------
// Lo que NO hace
// ---------------------------------------------------------------------------

const written = JSON.parse(await readFile(target, 'utf8'));
check(
  'solo se guardan ids: ni rutas, ni titulos, ni nada de ~/.claude',
  Object.keys(written).sort().join(',') === 'sessionIds,version',
  Object.keys(written).join(','),
);

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
