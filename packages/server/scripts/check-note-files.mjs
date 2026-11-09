/** Prueba los adjuntos generales de notas sobre un directorio temporal propio. */
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MAX_SUBMIT_FILE_BYTES,
  parseClientMessage,
  parseServerMessage,
} from '@agent-workbench/shared';
import { NotesStore, NotesError } from '../src/notes-store.ts';
import { noteFilesForComposer } from '../../web/src/note-to-composer.ts';
import { PasteStore } from '../src/paste-store.ts';
import { attachmentLine, attachmentReference, textWithAttachments } from '../src/attachments.ts';
import { buildSubmission } from '../src/pty-input.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'check-note-files-'));
const statePath = path.join(dir, 'notes.json');
const imagesDir = path.join(dir, 'notes-images');
const filesDir = path.join(imagesDir, 'files');
const stores = [];
let checks = 0;
function check(label, fn) {
  fn();
  checks++;
  console.log(`OK ${label}`);
}
function newStore() {
  const store = new NotesStore(statePath, imagesDir);
  stores.push(store);
  return store;
}
async function filesOnDisk() {
  return readdir(filesDir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}
const toBase64 = (text) => Buffer.from(text).toString('base64');
const noteId = 'note-files';

try {
  const store = newStore();
  await store.load();
  store.create(noteId);
  const examples = [
    ['informe.pdf', '%PDF-1.7\narchivo de prueba'],
    ['voz.wav', 'RIFF\u0000\u0000\u0000\u0000WAVEfmt '],
    ['video.mp4', '\u0000\u0000\u0000\u0018ftypmp42'],
    ['documentos.zip', 'PK\u0003\u0004archivo'],
  ];
  const saved = [];
  for (const [name, text] of examples) {
    const data = toBase64(text);
    const file = await store.addFile(noteId, name, data);
    saved.push(file);
    check(`${name}: referencia con nombre y peso`, () => {
      assert.equal(file.name, name);
      assert.equal(file.bytes, Buffer.byteLength(text));
      assert.match(file.fileId, /^[0-9a-f-]{36}$/);
      assert.ok(store.get(noteId).files.some((entry) => entry.fileId === file.fileId));
    });
    const read = await store.readFile(file.fileId);
    check(`${name}: se recuperan los bytes originales`, () => assert.deepEqual(read, { name, data }));
  }
  const ready = await store.readForSubmit(noteId);
  check('una nota solo con archivos se prepara completa para enviar', () => {
    assert.equal(ready.text, '');
    assert.deepEqual(ready.images, []);
    assert.deepEqual(ready.files, examples.map(([name, text]) => ({ name, data: toBase64(text) })));
  });

  const composerFiles = noteFilesForComposer(ready.files);
  check('al cuadro conserva orden, nombre y bytes de los archivos', () => {
    assert.deepEqual(composerFiles.map(({name, bytes, base64}) => ({name, bytes, base64})),
      examples.map(([name, text]) => ({ name, bytes: Buffer.byteLength(text), base64: toBase64(text) })));
  });
  const pasteStore = new PasteStore(path.join(dir, 'pasted'));
  const lines = [];
  for (const file of ready.files) {
    const stored = await pasteStore.saveAttachment('test-terminal', file.name, file.data);
    assert.equal((await readFile(stored.path)).toString('base64'), file.data);
    lines.push(attachmentLine(file.name, stored.bytes, attachmentReference(stored.path, 'quoted-path')));
  }
  const payload = buildSubmission(textWithAttachments(ready.text, lines), []);
  check('el envio al agente incluye las rutas de todos los archivos guardados', () => {
    assert.equal(lines.length, 4);
    for (const file of ready.files) assert.ok(payload.includes(file.name));
    assert.ok(payload.includes(path.join(dir, 'pasted', 'test-terminal')));
    assert.equal((payload.match(/Attached file/g) ?? []).length, 4);
  });

  const unknown = await store.readFile('../../notes.json');
  check('una ruta que no es id de un adjunto no permite leer archivos', () => assert.equal(unknown, null));
  await assert.rejects(() => store.addFile('missing-note', 'a.pdf', toBase64('a')), NotesError);
  check('una nota inexistente no recibe archivos', () => assert.equal(store.list().length, 1));

  const beforeRejected = await filesOnDisk();
  for (const name of ['program.exe', '../program.exe', 'program.éxe', 'library.dll', 'setup.msi', 'shortcut.lnk']) {
    await assert.rejects(() => store.addFile(noteId, name, toBase64('payload')), NotesError);
    check(`se rechaza el ejecutable ${name}`, () => assert.equal(store.get(noteId).files.length, 4));
  }
  await assert.rejects(() => store.addFile(noteId, 'empty.pdf', ''), NotesError);
  const tooLarge = Buffer.alloc(MAX_SUBMIT_FILE_BYTES + 1, 1).toString('base64');
  await assert.rejects(() => store.addFile(noteId, 'large.mp4', tooLarge), NotesError);
  check('rechazar vacios y archivos demasiado grandes no deja referencias ni archivos', () => {
    assert.equal(store.get(noteId).files.length, 4);
  });
  assert.deepEqual((await filesOnDisk()).sort(), beforeRejected.sort());

  const maxData = Buffer.alloc(MAX_SUBMIT_FILE_BYTES, 7).toString('base64');
  const exact = await store.addFile(noteId, 'exact.wav', maxData);
  const exactRead = await store.readFile(exact.fileId);
  check('el limite exacto de 10 MiB se acepta sin alterar los bytes', () => {
    assert.equal(MAX_SUBMIT_FILE_BYTES, 10 * 1024 * 1024);
    assert.equal(exact.bytes, MAX_SUBMIT_FILE_BYTES);
    assert.equal(exactRead.data, maxData);
  });
  assert.equal(await store.removeFile(noteId, exact.fileId), true);
  check('quitar un adjunto elimina su lectura y conserva los demas', () => {
    assert.equal(store.get(noteId).files.length, 4);
  });
  assert.equal(await store.readFile(exact.fileId), null);
  assert.equal(await store.removeFile(noteId, exact.fileId), false);

  const originalName = 'carpeta/Informe del mes.pdf';
  const named = await store.addFile(noteId, originalName, toBase64('nombre'));
  check('el nombre original permanece en los metadatos', () => assert.equal(named.name, originalName));
  check('la pista con carpeta no produce subcarpetas en disco', () => {
    assert.equal((store.get(noteId).files ?? []).length, 5);
  });
  const entries = await readdir(filesDir, { withFileTypes: true });
  assert.ok(entries.every((entry) => entry.isFile()));
  const longName = 'a'.repeat(300) + '.pdf';
  const longNamed = await store.addFile(noteId, longName, toBase64('largo'));
  check('el nombre almacenado tiene un limite de 255 caracteres', () => assert.ok(longNamed.name.length <= 255));

  await store.flush();
  const serialized = await readFile(statePath, 'utf8');
  check('la persistencia guarda referencias, sin copiar el contenido al JSON', () => {
    const written = JSON.parse(serialized);
    assert.equal(written.version, 1);
    assert.equal(written.notes[0].files.length, 6);
    for (const [, text] of examples) assert.ok(!serialized.includes(toBase64(text)));
  });
  const reloaded = newStore();
  await reloaded.load();
  check('recargar conserva todos los adjuntos', () => assert.deepEqual(reloaded.get(noteId).files, store.get(noteId).files));
  assert.deepEqual(await reloaded.readFile(saved[0].fileId), { name: examples[0][0], data: toBase64(examples[0][1]) });
  assert.equal(await reloaded.delete(noteId), true);
  assert.equal(await reloaded.delete(noteId), false);
  check('cerrar la nota borra todos sus archivos', () => assert.equal(reloaded.list().length, 0));
  assert.deepEqual(await filesOnDisk(), []);
  await reloaded.flush();

  const oldNote = { noteId: 'old-note', text: 'nota anterior', images: [], createdAt: 1, updatedAt: 1 };
  await writeFile(statePath, JSON.stringify({ version: 1, notes: [oldNote] }));
  const legacy = newStore();
  await legacy.load();
  check('las notas anteriores sin campo files se siguen leyendo', () => {
    assert.equal(legacy.get('old-note').text, oldNote.text);
    assert.equal((legacy.get('old-note').files ?? []).length, 0);
  });
  await legacy.addFile('old-note', 'nuevo.pdf', toBase64('nuevo'));
  for (let i = 1; i < 20; i++) await legacy.addFile('old-note', `${i}.txt`, toBase64(String(i)));
  await assert.rejects(() => legacy.addFile('old-note', '21.txt', toBase64('21')), NotesError);
  check('cada nota admite veinte archivos y rechaza el siguiente', () => assert.equal(legacy.get('old-note').files.length, 20));
  assert.equal((await filesOnDisk()).length, 20);
  await legacy.delete('old-note');
  assert.deepEqual(await filesOnDisk(), []);

  legacy.create('concurrent-note');
  const concurrent = await Promise.allSettled(Array.from({ length: 21 }, (_, i) =>
    legacy.addFile('concurrent-note', `${i}.txt`, toBase64(String(i)))));
  check('veintiuna subidas simultaneas respetan el tope de veinte archivos', () => {
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 20);
    const rejected = concurrent.filter((result) => result.status === 'rejected');
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof NotesError);
    assert.equal(legacy.get('concurrent-note').files.length, 20);
  });
  assert.equal((await filesOnDisk()).length, 20);
  await legacy.delete('concurrent-note');
  assert.deepEqual(await filesOnDisk(), []);

  legacy.create('closing-note');
  const uploading = legacy.addFile('closing-note', 'cerrando.wav', toBase64('wave'));
  const rejectedUpload = assert.rejects(() => uploading, NotesError);
  const closed = await legacy.delete('closing-note');
  await rejectedUpload;
  check('cerrar durante una subida impide agregar el adjunto a una nota borrada', () => {
    assert.equal(closed, true);
    assert.equal(legacy.get('closing-note'), null);
  });
  assert.deepEqual(await filesOnDisk(), []);

  const messages = [
    { type: 'notes.addFile', noteId, file: { name: 'voz.wav', data: toBase64('wave') } },
    { type: 'notes.removeFile', noteId, fileId: saved[0].fileId },
    { type: 'notes.file', fileId: saved[0].fileId },
  ];
  for (const message of messages) {
    check(`el protocolo acepta ${message.type}`, () => assert.deepEqual(parseClientMessage(JSON.stringify(message)), message));
  }
  for (const message of [
    { type: 'notes.addFile', noteId, file: { data: 'abc' } },
    { type: 'notes.addFile', file: { name: 'a.pdf', data: 'abc' } },
    { type: 'notes.removeFile', noteId },
    { type: 'notes.file', fileId: 3 },
  ]) {
    check(`el protocolo rechaza ${message.type} incompleto`, () => assert.equal(parseClientMessage(JSON.stringify(message)), null));
  }
  for (const data of [null, toBase64('contenido')]) {
    const message = { type: 'notes.fileData', fileId: saved[0].fileId, name: saved[0].name, data };
    check('el protocolo lee acuses y contenido de archivo', () => assert.deepEqual(parseServerMessage(JSON.stringify(message)), message));
  }
  check('el protocolo conserva notas anteriores', () => {
    const parsed = parseServerMessage(JSON.stringify({ type: 'notes.list', notes: [oldNote] }));
    assert.equal(parsed.notes[0].text, oldNote.text);
    assert.equal((parsed.notes[0].files ?? []).length, 0);
  });
  check('el protocolo rechaza referencias con rutas dentro del id de archivo', () => {
    const tampered = { ...oldNote, files: [{ fileId: '../otra-ruta', name: 'a.pdf', bytes: 1 }] };
    assert.equal(parseServerMessage(JSON.stringify({ type: 'notes.list', notes: [tampered] })), null);
  });
  console.log(`\n${checks} comprobaciones correctas`);
} finally {
  for (const store of stores) await store.flush();
  if (path.dirname(dir) !== tmpdir() || !path.basename(dir).startsWith('check-note-files-')) {
    throw new Error('El directorio temporal no coincide con la carpeta de esta prueba');
  }
  await rm(dir, { recursive: true, force: true });
}
