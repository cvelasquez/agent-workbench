/**
 * Chequeo del almacen de notas.
 *
 *   npx tsx scripts/check-notes-store.mjs
 *
 * Es el otro sitio del servidor que escribe archivos con datos del cliente
 * —el primero es el pegado del cuadro de escritura— y el unico que borra. Lo
 * que se rompe en silencio: aceptar como imagen algo que no lo es, dejar
 * archivos huerfanos al cerrar una nota, o leer un archivo cuyo id no cuelga de
 * ninguna nota.
 *
 * Trabaja sobre un directorio temporal propio, sin tocar la configuracion real.
 */

import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const dir = path.join(tmpdir(), `check-notes-${process.pid}`);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const statePath = path.join(dir, 'notes.json');
const imagesDir = path.join(dir, 'notes-images');

const { NotesStore, NotesError } = await import('../src/notes-store.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const throws = async (fn) => {
  try {
    await fn();
    return null;
  } catch (error) {
    return error;
  }
};

// Un PNG de 1x1, real. La firma es lo que decide, asi que tiene que ser valido.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// ---------------------------------------------------------------------------
// Ida y vuelta
// ---------------------------------------------------------------------------

const store = new NotesStore(statePath, imagesDir);
await store.load();
check('sin archivo, no hay notas', store.list().length === 0);

const A = 'a1b2c3d4-0000-4000-8000-000000000001';
store.create(A);
check('crear deja la nota en la lista', store.list().length === 1);
check('update avisa que cambio', store.update(A, 'primera idea') === true);
check('update con el mismo texto no cambia nada', store.update(A, 'primera idea') === false);

check(
  'un id con forma rara se rechaza',
  (await throws(() => store.create('../../etc'))) instanceof NotesError,
  'el id solo es una clave, pero igual no se acepta cualquier cosa',
);
check(
  'un id repetido se rechaza',
  (await throws(() => store.create(A))) instanceof NotesError,
);

// ---------------------------------------------------------------------------
// Imagenes: firma, no tipo declarado
// ---------------------------------------------------------------------------

const image = await store.addImage(A, 'image/png', PNG_1x1);
check('la imagen queda colgada de la nota', store.get(A).images.length === 1);
check('el id lo pone el servidor y es un UUID', /^[0-9a-f-]{36}$/.test(image.imageId));
const onDisk = await readdir(imagesDir);
check('y hay exactamente un archivo en disco', onDisk.length === 1, onDisk.join(','));

const asJpeg = await store.addImage(A, 'image/jpeg', PNG_1x1);
check(
  'gana la firma: un PNG declarado como JPEG se guarda como PNG',
  asJpeg.mediaType === 'image/png' && (await readdir(imagesDir)).every((f) => f.endsWith('.png')),
);

const notImage = Buffer.from('<script>alert(1)</script>').toString('base64');
check(
  'algo que no es imagen se rechaza aunque diga image/png',
  (await throws(() => store.addImage(A, 'image/png', notImage))) instanceof NotesError,
);
check('y no deja archivo', (await readdir(imagesDir)).length === 2);

check(
  'un tipo desconocido se rechaza antes de mirar los bytes',
  (await throws(() => store.addImage(A, 'image/svg+xml', PNG_1x1))) instanceof NotesError,
);

const read = await store.readImage(image.imageId);
check('la imagen se lee de vuelta tal cual', read !== null && read.data === PNG_1x1);
check(
  'un id que no cuelga de ninguna nota no se lee, exista o no el archivo',
  (await store.readImage('00000000-0000-4000-8000-000000000000')) === null,
);

check('quitar una imagen avisa', (await store.removeImage(A, asJpeg.imageId)) === true);
check('y borra el archivo', (await readdir(imagesDir)).length === 1);
check('quitar una que no esta no avisa', (await store.removeImage(A, asJpeg.imageId)) === false);

// ---------------------------------------------------------------------------
// Persistencia
// ---------------------------------------------------------------------------

await store.flush();
const written = JSON.parse(await readFile(statePath, 'utf8'));
check('el archivo lleva version y notas, nada mas', Object.keys(written).sort().join(',') === 'notes,version');
check(
  'y no lleva los bytes de las imagenes',
  !JSON.stringify(written).includes(PNG_1x1),
  'una imagen en el JSON haria que cada tecla reescribiera megas',
);

const reloaded = new NotesStore(statePath, imagesDir);
await reloaded.load();
const back = reloaded.get(A);
check(
  'al recargar vuelve el texto y la referencia a la imagen',
  back !== null && back.text === 'primera idea' && back.images.length === 1,
);
check(
  'y la imagen se lee desde el almacen recargado',
  (await reloaded.readImage(image.imageId))?.data === PNG_1x1,
);

// ---------------------------------------------------------------------------
// Cerrar borra, y borra todo
// ---------------------------------------------------------------------------

check('cerrar avisa', (await reloaded.delete(A)) === true);
check('cerrar lo que ya no esta no avisa', (await reloaded.delete(A)) === false);
check('no quedan imagenes huerfanas', (await readdir(imagesDir)).length === 0);
await reloaded.flush();
check('y el archivo queda sin notas', JSON.parse(await readFile(statePath, 'utf8')).notes.length === 0);

// ---------------------------------------------------------------------------
// Mandar la nota al agente
//
// El servidor arma el mismo pegado que un mensaje del cuadro de escritura. Lo
// que se rompe en silencio: una ruta con espacios sin comillas se corta en el
// primer espacio (CLAUDE.md 5.3), y un texto sin sanear puede cerrar el pegado
// a mitad y dejar el resto entrando como teclas.
// ---------------------------------------------------------------------------

const { buildSubmission, fileReference } = await import('../src/pty-input.ts');

const S = 'a1b2c3d4-0000-4000-8000-000000000009';
const sendStore = new NotesStore(statePath, imagesDir);
await sendStore.load();
sendStore.create(S);
sendStore.update(S, 'mira estas dos');
await sendStore.addImage(S, 'image/png', PNG_1x1);
await sendStore.addImage(S, 'image/png', PNG_1x1);

const ready = await sendStore.readForSubmit(S);
check('la nota sale con su texto y sus dos imagenes',
  ready?.text === 'mira estas dos' && ready?.images.length === 2,
  `${ready?.images.length} imagenes`);
check('y las imagenes salen en base64, no como rutas',
  ready?.images.every((image) => image.data === PNG_1x1) === true);

// Las rutas con espacios son lo normal en Windows (C:\Users\Jane Doe\...).
const BS = String.fromCharCode(92);
const withSpaces = [`C:${BS}Users${BS}Jane Doe${BS}a b.png`, `D:${BS}otro dir${BS}c.png`];
const payload = buildSubmission(ready?.text ?? '', withSpaces.map(fileReference));
check('las dos rutas van entre comillas',
  withSpaces.every((route) => payload?.includes(`@"${route}"`) === true),
  String(payload));
check('y el texto de la nota viaja adentro del pegado',
  payload?.includes('mira estas dos') === true);

// Un ESC[201~ en la nota cerraria el pegado a mitad y el resto entraria como
// teclas. Es la misma trampa que el cuadro de escritura, por el mismo camino.
const PASTE_END = `${String.fromCharCode(27)}[201~`;
sendStore.update(S, `antes ${PASTE_END} despues`);
const dirty = await sendStore.readForSubmit(S);
const dirtyPayload = buildSubmission(dirty?.text ?? '', []);
check('un delimitador de pegado dentro de la nota se sanea',
  dirtyPayload !== null && dirtyPayload.split(PASTE_END).length === 2,
  JSON.stringify(dirtyPayload));

check('una nota que no existe no se manda', (await sendStore.readForSubmit('no-existe')) === null);
await sendStore.delete(S);

// ---------------------------------------------------------------------------
// Un formato futuro no se interpreta
// ---------------------------------------------------------------------------

await writeFile(statePath, JSON.stringify({ version: 99, notes: [{ noteId: 'x', text: 'y' }] }));
const future = new NotesStore(statePath, imagesDir);
await future.load();
check('una version desconocida se ignora entera', future.list().length === 0);

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
