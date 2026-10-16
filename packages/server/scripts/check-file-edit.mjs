/**
 * Chequeo de editar un archivo desde Archivos (Hito 46, §6.36).
 *
 *   npx tsx scripts/check-file-edit.mjs
 *
 * Es la segunda escritura de la app dentro de un proyecto, despues de la
 * memoria compartida, y todo lo que puede salir mal ahi sale en silencio:
 *
 *  - **Lo que se guarda**: el texto que se mando, con los saltos de linea del
 *    archivo (un `.env` de Windows guardado en LF sale entero como cambiado), el
 *    BOM y los permisos del original, y ningun temporal suelto.
 *  - **Lo que no se escribe nunca**: afuera del proyecto, por un enlace, en un
 *    archivo que no existe (no se crea), en una carpeta, en la carpeta de una
 *    CLI, mas de 512 KB, un archivo de solo lectura o uno que el visor no ofrece
 *    editar.
 *  - **La huella**: si el disco ya no tiene lo que se abrio, no se escribe nada
 *    y se devuelve lo que hay.
 *  - **Archivos sin carpetas de CLI**: un proyecto abierto en la carpeta de
 *    usuario no lista `.claude`, no lo recorre y no lee nada de adentro, ni por
 *    una junction.
 *  - **El protocolo** de `files.write` y `files.saved`.
 *
 * Trabaja sobre una carpeta temporal propia y un home falso. No lanza ninguna
 * CLI ni toca un proyecto real.
 */

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// El home, APPDATA y git van a la carpeta del chequeo antes de importar nada.
const root = await mkdtemp(path.join(os.tmpdir(), 'aw-file-edit-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.APPDATA = path.join(root, 'appdata');
const gitConfig = path.join(root, 'gitconfig');
await writeFile(gitConfig, '');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = root;

const shared = await import('@agent-workbench/shared');
const { cliFolders, NO_CLI_FOLDERS } = await import('../src/cli-folders.ts');
const { existingFiles, listDirectory, readPreview, searchFiles, MAX_PREVIEW_BYTES } = await import('../src/file-browser.ts');
const { FileWriteError, saveProjectFile, withLineEndings } = await import('../src/file-write.ts');
const { writeAtomically } = await import('../src/atomic-write.ts');
const { InvalidPathError } = await import('../src/path-guard.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const windows = process.platform === 'win32';

/** El error que lanzo, o null. */
async function thrown(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

/** Ningun temporal de `atomic-write.ts` en esa carpeta. */
async function noTemporaries(dir) {
  return (await readdir(dir)).every((name) => !name.endsWith('.tmp'));
}

/** Una junction (Windows) o un enlace de carpeta; false si el sistema no deja. */
async function linkDir(target, link) {
  try {
    await symlink(target, link, 'junction');
    return true;
  } catch {
    return false;
  }
}

// --- El fixture ---------------------------------------------------------------

const project = path.join(home, 'proyecto');
const outside = path.join(root, 'afuera');
const cliDir = path.join(home, '.claude');
await mkdir(path.join(project, 'src'), { recursive: true });
await mkdir(outside, { recursive: true });
await mkdir(cliDir, { recursive: true });
await writeFile(path.join(outside, 'secreto.txt'), 'de afuera\n');
await writeFile(path.join(cliDir, '.credentials.json'), '{"token":"no se lee"}\n');

const LF = 'A=1\nB=2\n';
const CRLF = 'A=1\r\nB=2\r\nC=3\r\n';
const BOM_TEXT = '\uFEFFtitulo\nlinea\n';
await writeFile(path.join(project, 'lf.env'), LF);
await writeFile(path.join(project, 'crlf.env'), CRLF);
await writeFile(path.join(project, 'bom.txt'), BOM_TEXT);
await writeFile(path.join(project, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
await writeFile(path.join(project, 'cr.txt'), 'a\rb\r');
await writeFile(path.join(project, 'binario.bin'), Buffer.from([0x00, 0x01, 0x02]));
await writeFile(path.join(project, 'grande.txt'), 'x'.repeat(MAX_PREVIEW_BYTES + 10));
await writeFile(path.join(project, 'src', 'a.ts'), 'export const a = 1;\n');

const folders = await cliFolders([cliDir]);
/** La junction de la carpeta de usuario hacia .claude (3.8), si el sistema dejo crearla. */
let cliLink = false;

// --- 1. Lo que el visor ofrece editar ---------------------------------------------
{
  const lf = await readPreview(project, 'lf.env', folders);
  check('1.1 un texto en UTF-8 se puede editar, con la huella de sus bytes', lf.editable === true && lf.hash === sha(Buffer.from(LF)));
  const crlf = await readPreview(project, 'crlf.env', folders);
  check('1.2 uno con CRLF tambien, y el texto llega con sus \\r\\n', crlf.editable === true && crlf.text === CRLF);
  const latin = await readPreview(project, 'latin1.txt', folders);
  check('1.3 uno que no esta en UTF-8 no se edita, y no lleva huella', latin.editable === undefined && latin.hash === undefined);
  const cr = await readPreview(project, 'cr.txt', folders);
  check('1.4 uno con \\r sueltos no se edita: el cuadro los cambiaria', cr.editable === undefined);
  const big = await readPreview(project, 'grande.txt', folders);
  check('1.5 control: el grande pasa el tope', (await stat(path.join(project, 'grande.txt'))).size > MAX_PREVIEW_BYTES);
  check('1.6 uno cortado por tamano no se edita', big.truncated === true && big.editable === undefined);
  const bom = await readPreview(project, 'bom.txt', folders);
  check('1.7 uno con BOM se edita, y el BOM viene en el texto', bom.editable === true && bom.text.startsWith('\uFEFF'));
  const binary = await readPreview(project, 'binario.bin', folders);
  check('1.8 un binario no se edita', binary.binary === true && binary.editable === undefined);
  const parsed = shared.parseFilePreview({ ...lf });
  const forged = shared.parseFilePreview({ ...lf, hash: 'no-es-una-huella' });
  check('1.9 el parser conserva editable con una huella con forma, y lo descarta sin ella',
    parsed?.editable === true && parsed.hash === lf.hash && forged !== null && forged.editable === undefined && forged.hash === undefined);
}

// --- 2. Guardar ----------------------------------------------------------------------
{
  const file = path.join(project, 'lf.env');
  const result = await saveProjectFile(project, 'lf.env', 'A=1\nB=22\nC=3\n', sha(Buffer.from(LF)), folders);
  const written = await readFile(file, 'utf8');
  check('2.1 guarda lo que se mando, y devuelve el archivo como quedo',
    result.outcome === 'saved' && written === 'A=1\nB=22\nC=3\n' && result.preview?.hash === sha(Buffer.from(written)), json(written));

  const crlfFile = path.join(project, 'crlf.env');
  check('2.2 control: el original esta en CRLF', (await readFile(crlfFile, 'utf8')).includes('\r\n'));
  await saveProjectFile(project, 'crlf.env', 'A=1\nB=2\nC=3\nD=4\n', sha(Buffer.from(CRLF)), folders);
  check('2.3 un archivo en CRLF sigue en CRLF, tambien en la linea nueva',
    (await readFile(crlfFile, 'utf8')) === 'A=1\r\nB=2\r\nC=3\r\nD=4\r\n', json(await readFile(crlfFile, 'utf8')));

  check('2.4 mezclado, toman los que mas aparecen',
    withLineEndings('a\nb\nc\n', 'x\r\ny\r\nz\n') === 'a\r\nb\r\nc\r\n' && withLineEndings('a\nb\n', 'x\r\ny\nz\n') === 'a\nb\n');
  check('2.5 sin saltos en el original, y lo que llega con \\r\\n, queda en \\n',
    withLineEndings('a\nb', 'x') === 'a\nb' && withLineEndings('a\r\nb\r\n', 'x\ny\n') === 'a\nb\n');

  const bomFile = path.join(project, 'bom.txt');
  await saveProjectFile(project, 'bom.txt', '\uFEFFtitulo\notra\n', sha(Buffer.from(BOM_TEXT)), folders);
  const bomBytes = await readFile(bomFile);
  check('2.6 el BOM sigue', bomBytes[0] === 0xef && bomBytes[1] === 0xbb && bomBytes[2] === 0xbf);
  check('2.7 no queda ningun temporal', await noTemporaries(project));

  if (windows) {
    console.log('OMITIDO 2.8 permisos: en Windows no hay modo que conservar');
  } else {
    const secret = path.join(project, 'privado.env');
    await writeFile(secret, 'K=1\n');
    await chmod(secret, 0o600);
    await saveProjectFile(project, 'privado.env', 'K=2\n', sha(Buffer.from('K=1\n')), folders);
    check('2.8 un .env en 600 sigue en 600', ((await stat(secret)).mode & 0o777) === 0o600, ((await stat(secret)).mode & 0o777).toString(8));
  }

  // Un enlace de archivo del proyecto a otro del proyecto: se guarda en el destino y el enlace queda.
  const real = path.join(project, 'src', 'real.txt');
  await writeFile(real, 'uno\n');
  let fileLink = true;
  try {
    await symlink(real, path.join(project, 'enlace.txt'), 'file');
  } catch {
    fileLink = false;
  }
  if (fileLink) {
    await saveProjectFile(project, 'enlace.txt', 'dos\n', sha(Buffer.from('uno\n')), folders);
    check('2.9 por un enlace se guarda el destino, y el enlace sigue siendo un enlace',
      (await readFile(real, 'utf8')) === 'dos\n' && (await lstat(path.join(project, 'enlace.txt'))).isSymbolicLink());
  } else {
    console.log('OMITIDO 2.9 enlace de archivo: el sistema no dejo crearlo');
  }
}

// --- 3. Lo que no se escribe -------------------------------------------------------
{
  const secretPath = path.join(outside, 'secreto.txt');
  const secretHash = sha(await readFile(secretPath));
  const absolute = await thrown(saveProjectFile(project, secretPath, 'pisado', secretHash, folders));
  check('3.1 una ruta absoluta se rechaza', absolute instanceof InvalidPathError);
  const dotdot = await thrown(saveProjectFile(project, '../../afuera/secreto.txt', 'pisado', secretHash, folders));
  check('3.2 un .. se rechaza', dotdot instanceof InvalidPathError);
  if (await linkDir(outside, path.join(project, 'atajo'))) {
    const viaLink = await thrown(saveProjectFile(project, 'atajo/secreto.txt', 'pisado', secretHash, folders));
    check('3.3 un enlace hacia afuera se rechaza', viaLink instanceof InvalidPathError);
  } else {
    console.log('OMITIDO 3.3 junction: el sistema no dejo crearla');
  }
  check('3.4 lo de afuera quedo igual', (await readFile(secretPath, 'utf8')) === 'de afuera\n');

  const missing = await saveProjectFile(project, 'nuevo.txt', 'hola', sha(Buffer.from('')), folders);
  let created = true;
  try {
    await stat(path.join(project, 'nuevo.txt'));
  } catch {
    created = false;
  }
  check('3.5 un archivo que no existe: "cambio", sin vista, y no se crea', missing.outcome === 'changed' && missing.preview === null && !created);

  const dir = await thrown(saveProjectFile(project, 'src', 'texto', sha(Buffer.from('')), folders));
  check('3.6 una carpeta no se guarda', dir instanceof FileWriteError);

  const credentials = path.join(cliDir, '.credentials.json');
  const credentialsHash = sha(await readFile(credentials));
  const inCli = await thrown(saveProjectFile(home, '.claude/.credentials.json', '{}', credentialsHash, folders));
  check('3.7 en la carpeta de una CLI no se escribe, aunque caiga en el proyecto',
    inCli instanceof InvalidPathError && inCli.text.key === 'cliFolderClosed');
  cliLink = await linkDir(cliDir, path.join(home, 'enlace-cli'));
  if (cliLink) {
    const viaCliLink = await thrown(saveProjectFile(home, 'enlace-cli/.credentials.json', '{}', credentialsHash, folders));
    check('3.8 ni por una junction del proyecto hacia ella', viaCliLink instanceof InvalidPathError && viaCliLink.text.key === 'cliFolderClosed');
  } else {
    console.log('OMITIDO 3.8 junction: el sistema no dejo crearla');
  }
  check('3.9 las credenciales quedaron igual', (await readFile(credentials, 'utf8')) === '{"token":"no se lee"}\n');

  const current = await readFile(path.join(project, 'src', 'a.ts'));
  const tooBig = await thrown(saveProjectFile(project, 'src/a.ts', 'y'.repeat(MAX_PREVIEW_BYTES + 1), sha(current), folders));
  check('3.10 mas de 512 KB no se guarda', tooBig instanceof FileWriteError && tooBig.text.key === 'fileSaveTooLarge');

  const stale = await saveProjectFile(project, 'src/a.ts', 'pisado\n', sha(Buffer.from('otra version\n')), folders);
  check('3.11 con la huella de otra version: "cambio", con lo que hay ahora',
    stale.outcome === 'changed' && stale.preview?.text === current.toString('utf8') && stale.preview?.hash === sha(current));
  check('3.12 y el archivo queda byte por byte igual', (await readFile(path.join(project, 'src', 'a.ts'))).equals(current));

  const latin = await readFile(path.join(project, 'latin1.txt'));
  const notEditable = await thrown(saveProjectFile(project, 'latin1.txt', 'cafe\n', sha(latin), folders));
  check('3.13 lo que el visor no ofrece editar no se guarda, aunque llegue con su huella',
    notEditable instanceof FileWriteError && (await readFile(path.join(project, 'latin1.txt'))).equals(latin));

  const locked = path.join(project, 'solo-lectura.txt');
  await writeFile(locked, 'fijo\n');
  await chmod(locked, 0o444);
  const blocked = await thrown(saveProjectFile(project, 'solo-lectura.txt', 'cambiado\n', sha(Buffer.from('fijo\n')), folders));
  check('3.14 uno de solo lectura no se reemplaza', blocked instanceof FileWriteError && blocked.text.key === 'fileSaveBlocked');
  check('3.15 queda como estaba, sin temporales', (await readFile(locked, 'utf8')) === 'fijo\n' && (await noTemporaries(project)));
  await chmod(locked, 0o644);

  const target = path.join(project, 'atomico.txt');
  await writeFile(target, 'antes\n');
  const refused = await thrown(writeAtomically(target, Buffer.from('despues\n'), { beforeRename: async () => { throw new Error('no'); } }));
  check('3.16 si algo falla antes del rename, el destino no se toca y el temporal se borra',
    refused !== null && (await readFile(target, 'utf8')) === 'antes\n' && (await noTemporaries(project)));
}

// --- 4. Archivos sin carpetas de CLI -------------------------------------------------
{
  const open = await listDirectory(home, '', NO_CLI_FOLDERS, { includeHidden: true });
  check('4.1 control: sin el guardia, el arbol de la carpeta de usuario lista .claude', open.entries.some((entry) => entry.name === '.claude'));
  const guarded = await listDirectory(home, '', folders, { includeHidden: true });
  const plain = await listDirectory(home, '', folders);
  check('4.2 con el guardia no la lista, ni con el ojo abierto', !guarded.entries.some((entry) => entry.name === '.claude'));
  check('4.3 ni la cuenta entre lo escondido: el ojo la mostraria', plain.hiddenCount === (await listDirectory(home, '', NO_CLI_FOLDERS)).hiddenCount);
  if (cliLink) {
    check('4.4 control: sin el guardia, el enlace hacia ella se lista', open.entries.some((entry) => entry.name === 'enlace-cli'));
    check('4.5 con el guardia, el enlace tampoco', !guarded.entries.some((entry) => entry.name === 'enlace-cli'));
  } else {
    console.log('OMITIDO 4.4 y 4.5 junction: el sistema no dejo crearla');
  }
  const inside = await thrown(listDirectory(home, '.claude', folders));
  check('4.6 no entra', inside instanceof InvalidPathError && inside.text.key === 'cliFolderClosed');
  const read = await thrown(readPreview(home, '.claude/.credentials.json', folders));
  check('4.7 no lee nada de adentro', read instanceof InvalidPathError && read.text.key === 'cliFolderClosed');
  if (cliLink) {
    const viaLink = await thrown(readPreview(home, 'enlace-cli/.credentials.json', folders));
    check('4.8 ni por el enlace', viaLink instanceof InvalidPathError && viaLink.text.key === 'cliFolderClosed');
  }

  const found = await searchFiles(home, 'credentials', NO_CLI_FOLDERS, { includeHidden: true });
  check('4.9 control: sin el guardia, la busqueda encuentra las credenciales', found.entries.some((entry) => entry.name === '.credentials.json'));
  const searched = await searchFiles(home, 'credentials', folders, { includeHidden: true });
  check('4.10 con el guardia no las encuentra', searched.entries.length === 0, json(searched.entries.map((entry) => entry.path)));
  check('4.11 los enlaces del hilo tampoco las vuelven enlace',
    json(await existingFiles(home, ['.claude/.credentials.json', 'proyecto/src/a.ts'], folders)) === json(['proyecto/src/a.ts']));

  const fromInside = await thrown(listDirectory(cliDir, '', folders));
  const searchInside = await thrown(searchFiles(cliDir, 'credentials', folders));
  check('4.12 un proyecto que cae entero en una no lista ni busca nada',
    fromInside instanceof InvalidPathError && searchInside instanceof InvalidPathError);

  if (windows) {
    const upper = await cliFolders([cliDir.toUpperCase()]);
    check('4.13 en Windows, sin distinguir mayusculas', upper.holds(path.join(cliDir, '.credentials.json')));
  } else {
    console.log('OMITIDO 4.13 mayusculas: solo en Windows');
  }
  check('4.14 una CLI que no esta instalada se cuida igual', (await cliFolders([path.join(home, '.codex')])).holds(path.join(home, '.codex', 'auth.json')));
}

// --- 5. El protocolo ---------------------------------------------------------------
{
  const hash = sha(Buffer.from('x'));
  const client = (message) => shared.parseClientMessage(json(message));
  const write = { type: 'files.write', terminalId: 't1', requestId: 'r1', path: '.env', text: 'A=1\n', baseHash: hash };
  check('5.1 files.write pasa con ruta, texto y huella', json(client(write)) === json(write));
  check('5.2 sin huella con forma, sin texto o sin requestId no pasa',
    client({ ...write, baseHash: 'abc' }) === null && client({ ...write, text: undefined }) === null && client({ ...write, requestId: undefined }) === null);
  check('5.3 un texto vacio si pasa: vaciar un archivo es guardarlo', client({ ...write, text: '' })?.text === '');

  const server = (message) => shared.parseServerMessage(json(message));
  const preview = { path: '.env', language: 'bash', text: 'A=1\n', sizeBytes: 4, truncated: false, binary: false, editable: true, hash };
  const saved = { type: 'files.saved', terminalId: 't1', requestId: 'r1', path: '.env', outcome: 'saved', preview };
  check('5.4 files.saved con el archivo como quedo', json(server(saved)) === json(saved));
  check('5.5 guardado sin archivo no dice nada, y se descarta', server({ ...saved, preview: null }) === null);
  check('5.6 "cambio" sin archivo es que ya no esta', server({ ...saved, outcome: 'changed', preview: null })?.preview === null);
  check('5.7 un resultado desconocido o una vista rota se descartan',
    server({ ...saved, outcome: 'copied' }) === null && server({ ...saved, outcome: 'changed', preview: { path: 1 } }) === null);

  const hello = (extra) => server({ type: 'hello', protocolVersion: shared.PROTOCOL_VERSION, agents: [], defaultAgent: null, platform: 'win32', defaultCwd: 'D:\\x', shellName: null, ...extra });
  check('5.8 un servidor anterior no dice fileWrite, y el visor no ofrece Editar', hello({}).fileWrite === false && hello({ fileWrite: true }).fileWrite === true);
  check('5.9 el error de guardar tiene su codigo', shared.SERVER_ERROR_CODES.includes('write-failed'));
  check('5.10 la version del protocolo no cambio: todo es aditivo', shared.PROTOCOL_VERSION === 8);
}

// --- 6. El cableado, leido como texto -------------------------------------------------
{
  const { readFileSync } = await import('node:fs');
  const socket = readFileSync(new URL('../src/terminal-socket.ts', import.meta.url), 'utf8');
  check('6.1 el servidor anuncia que guarda, y guarda por saveProjectFile',
    socket.includes('fileWrite: true,') && /case 'files\.write':[\s\S]{0,900}saveProjectFile\(cwd, message\.path, message\.text, message\.baseHash, await folders\)/.test(socket));
  check('6.2 leer, listar, buscar y abrir pasan por las carpetas de las CLIs',
    socket.includes('listDirectory(cwd, message.path, await folders') &&
      socket.includes('searchFiles(cwd, message.query, await folders') &&
      socket.includes('readPreview(cwd, message.path, await folders)') &&
      /case 'files\.reveal':[\s\S]{0,600}\(await folders\)\.contains\(absolute\)/.test(socket));
}

await rm(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
