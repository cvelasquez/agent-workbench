/**
 * Chequeo del puente de la memoria compartida.
 *
 *   npx tsx scripts/check-memory-bridge.mjs
 *
 * Es la unica parte de la app que escribe dentro de un proyecto, y todo lo que
 * puede salir mal ahi sale mal en silencio: un byte de mas fuera de las marcas,
 * una linea repetida en `.gitignore` en cada instalacion, una junction que
 * lleva la escritura a otra carpeta, una nota que se pisa. Por eso cada regla
 * del puente tiene su caso.
 *
 * Trabaja sobre carpetas temporales propias y un home falso. No toca ningun
 * repositorio real ni el `~/.claude` de verdad, y git corre con configuracion
 * aislada: un `.gitignore` global del usuario cambiaria lo que se ignora.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MEMORY_BLOCK_END,
  MEMORY_BLOCK_START,
  MEMORY_INDEX_TEMPLATE,
  defaultMemoryInstallOptions,
  encodeClientMessage,
  encodeServerMessage,
  memoryBlock,
  parseClientMessage,
  parseServerMessage,
} from '@agent-workbench/shared';
import {
  MemoryBridgeError,
  importNativeMemory,
  inspectMemory,
  installMemory,
  planMemoryInstall,
  readMemoryNote,
} from '../src/memory-bridge.ts';
import { MemoryHub, UnknownTerminalError, isRelevantPath } from '../src/memory-hub.ts';
import { InvalidPathError } from '../src/path-guard.ts';
import { projectSlugFor } from '../src/paths.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-memory-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });

// git aislado: sin configuracion global ni de sistema, y sin subir a buscar un
// repo por encima de la carpeta temporal.
const gitConfig = path.join(root, 'gitconfig');
await writeFile(gitConfig, '');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = root;

function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ana Torres',
      GIT_AUTHOR_EMAIL: 'ana@example.com',
      GIT_COMMITTER_NAME: 'Ana Torres',
      GIT_COMMITTER_EMAIL: 'ana@example.com',
    },
  }).toString();
}

function commit(cwd, message) {
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ana Torres',
      GIT_AUTHOR_EMAIL: 'ana@example.com',
      GIT_COMMITTER_NAME: 'Ana Torres',
      GIT_COMMITTER_EMAIL: 'ana@example.com',
    },
  });
}

/** 0 si git ignora la ruta, 1 si no. */
const checkIgnore = (cwd, rel) =>
  spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd }).status;

const both = {
  instructionFiles: ['AGENTS.md', 'CLAUDE.md'],
  gitMode: 'ignore',
  importNative: false,
  copyFromMainWorktree: false,
};
const only = (file, extra = {}) => ({ ...both, instructionFiles: [file], ...extra });

const project = async (name) => {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
};
const exists = async (target) => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};
const read = (dir, rel) => readFile(path.join(dir, rel));
const readText = async (dir, rel) => (await read(dir, rel)).toString('utf8');
const put = async (dir, rel, content) => {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), content);
};

/** Contenido completo de un arbol, sin seguir enlaces. Para comparar byte a byte. */
async function snapshot(dir, { skipGit = true } = {}) {
  const entries = [];
  const walk = async (current, prefix) => {
    const items = await readdir(current, { withFileTypes: true });
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const item of items) {
      const rel = prefix === '' ? item.name : `${prefix}/${item.name}`;
      const full = path.join(current, item.name);
      if (item.isSymbolicLink()) entries.push(`${rel} -> enlace`);
      else if (item.isDirectory()) {
        if (skipGit && item.name === '.git') continue;
        entries.push(`${rel}/`);
        await walk(full, rel);
      } else entries.push(`${rel} ${(await readFile(full)).toString('base64')}`);
    }
  };
  await walk(dir, '');
  return entries.join('\n');
}

/** Resuelve y rechaza con la clase esperada. */
async function rejectsWith(run, Klass) {
  try {
    await run();
    return { ok: false, message: 'no fallo' };
  } catch (error) {
    return { ok: error instanceof Klass, message: error instanceof Error ? error.message : String(error) };
  }
}

const count = (text, needle) => text.split(needle).length - 1;
const crlf = (text) => text.replace(/\n/g, '\r\n');

try {
  // --- 1. Carpeta vacia fuera de git -----------------------------------------

  const c1 = await project('c1');
  const applied1 = await installMemory(c1, both, home);
  check(
    'install crea el indice de plantilla',
    (await readText(c1, '.agents/memory/MEMORY.md')) === MEMORY_INDEX_TEMPLATE,
  );
  check(
    'install crea AGENTS.md con su bloque',
    (await readText(c1, 'AGENTS.md')) === `${memoryBlock('AGENTS.md')}\n`,
  );
  const claude1 = await readText(c1, 'CLAUDE.md');
  check(
    'install crea CLAUDE.md con su bloque y el import del indice',
    claude1 === `${memoryBlock('CLAUDE.md')}\n` &&
      claude1.includes('\n@.agents/memory/MEMORY.md\n<!-- /agent-workbench:memory -->'),
  );
  check('fuera de git no se crea .gitignore', !(await exists(path.join(c1, '.gitignore'))));
  check(
    'lo aplicado: indice, AGENTS.md y CLAUDE.md creados',
    applied1.map((c) => `${c.file}:${c.action}`).join(',') ===
      '.agents/memory/MEMORY.md:create,AGENTS.md:create,CLAUDE.md:create',
    applied1.map((c) => `${c.file}:${c.action}`).join(','),
  );
  const status1 = await inspectMemory(c1, home);
  check(
    'el estado dice instalado y fuera de un repo',
    status1.installed && status1.git.kind === 'not-repo' && status1.notes.length === 0,
    JSON.stringify(status1.git),
  );

  // --- 2. Idempotencia ------------------------------------------------------

  const before2 = await snapshot(c1);
  const plan2 = await planMemoryInstall(c1, both, home);
  const applied2 = await installMemory(c1, both, home);
  check('segunda instalacion: el plan esta vacio', plan2.length === 0, JSON.stringify(plan2));
  check('segunda instalacion: no aplica nada', applied2.length === 0, JSON.stringify(applied2));
  check('segunda instalacion: los bytes no cambian', (await snapshot(c1)) === before2);

  // --- 3. BOM y CRLF --------------------------------------------------------

  const c3 = await project('c3');
  const original3 = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('# Reglas\r\n\r\nUsá pnpm, año 2026.\r\nSin any.\r\n', 'utf8'),
  ]);
  await put(c3, 'AGENTS.md', original3);
  const applied3 = await installMemory(c3, only('AGENTS.md'), home);
  const after3 = await read(c3, 'AGENTS.md');
  check('append-block sobre un archivo existente', applied3.some((c) => c.file === 'AGENTS.md' && c.action === 'append-block'));
  check('el contenido original queda intacto byte a byte (BOM incluido)', after3.subarray(0, original3.length).equals(original3));
  const appended3 = after3.subarray(original3.length).toString('utf8');
  check(
    'el bloque se agrega con CRLF, precedido de una linea en blanco',
    appended3 === `\r\n${crlf(memoryBlock('AGENTS.md'))}\r\n`,
    JSON.stringify(appended3.slice(0, 40)),
  );
  check('ningun LF suelto en lo agregado', !/(^|[^\r])\n/.test(appended3));

  await put(c3, 'CLAUDE.md', 'sin salto final');
  await installMemory(c3, only('CLAUDE.md'), home);
  check(
    'sin salto final: se agrega uno, la linea en blanco y el bloque',
    (await readText(c3, 'CLAUDE.md')) === `sin salto final\n\n${memoryBlock('CLAUDE.md')}\n`,
  );

  // --- 4. Bloque viejo -------------------------------------------------------

  const c4 = await project('c4');
  const head4 = 'Antes del bloque, con ñ.\n\n';
  const tail4 = '\n\nDespués del bloque.\n';
  await put(c4, 'AGENTS.md', `${head4}${MEMORY_BLOCK_START}\nTexto viejo del bloque.\n${MEMORY_BLOCK_END}${tail4}`);
  const applied4 = await installMemory(c4, only('AGENTS.md'), home);
  const after4 = await read(c4, 'AGENTS.md');
  const head4Bytes = Buffer.from(head4, 'utf8');
  const tail4Bytes = Buffer.from(tail4, 'utf8');
  check('replace-block sobre el bloque viejo', applied4.some((c) => c.file === 'AGENTS.md' && c.action === 'replace-block'));
  check('lo de antes de las marcas queda identico', after4.subarray(0, head4Bytes.length).equals(head4Bytes));
  check('lo de despues de las marcas queda identico', after4.subarray(after4.length - tail4Bytes.length).equals(tail4Bytes));
  check(
    'entre las marcas queda el bloque actual',
    after4.subarray(head4Bytes.length, after4.length - tail4Bytes.length).toString('utf8') === memoryBlock('AGENTS.md'),
  );
  const status4 = await inspectMemory(c4, home);
  check('el estado lo da por al dia', status4.files[0].hasBlock && status4.files[0].blockCurrent);

  // --- 4b. Marcas citadas: no son el bloque ------------------------------------

  // Un documento que explica el puente cita las marcas. Es literalmente lo que
  // dice el CLAUDE.md de este repositorio: tomarlo por el bloque metia el
  // bloque entero entre las comillas invertidas del parrafo.
  const c4b = await project('c4b');
  const cited4b = Buffer.from(
    `# Reglas\n\nLa app escribe un bloque entre \`${MEMORY_BLOCK_START}\` y\n\`${MEMORY_BLOCK_END}\` que dice algo.\n`,
    'utf8',
  );
  await put(c4b, 'CLAUDE.md', cited4b);
  const status4b = await inspectMemory(c4b, home);
  check(
    'marcas citadas en comillas invertidas: no hay bloque ni marca rota',
    !status4b.files[1].hasBlock && !status4b.files[1].brokenBlock,
    JSON.stringify(status4b.files[1]),
  );
  const applied4b = await installMemory(c4b, only('CLAUDE.md', { gitMode: 'version' }), home);
  const after4b = await read(c4b, 'CLAUDE.md');
  check(
    'y se agrega el bloque al final, sin tocar el parrafo',
    applied4b.some((c) => c.file === 'CLAUDE.md' && c.action === 'append-block') &&
      after4b.subarray(0, cited4b.length).equals(cited4b) &&
      after4b.subarray(cited4b.length).toString('utf8') === `\n${memoryBlock('CLAUDE.md')}\n`,
    applied4b.map((c) => `${c.file}:${c.action}`).join(','),
  );
  check(
    'y la segunda instalacion no cambia nada',
    (await installMemory(c4b, only('CLAUDE.md', { gitMode: 'version' }), home)).length === 0,
  );

  // Las marcas dentro de un bloque de codigo son un ejemplo; el bloque real,
  // abajo, es el que se reemplaza.
  const c4c = await project('c4c');
  const head4c = `# Reglas\n\nAsi se ve el bloque:\n\n\`\`\`md\n${MEMORY_BLOCK_START}\nejemplo\n${MEMORY_BLOCK_END}\n\`\`\`\n\n`;
  const tail4c = '\nFin.\n';
  await put(c4c, 'AGENTS.md', `${head4c}${MEMORY_BLOCK_START}\nviejo\n${MEMORY_BLOCK_END}${tail4c}`);
  const applied4c = await installMemory(c4c, only('AGENTS.md', { gitMode: 'version' }), home);
  const after4c = await readText(c4c, 'AGENTS.md');
  check(
    'marcas dentro de un bloque de codigo: se ignoran y se reemplaza el bloque real',
    applied4c.some((c) => c.file === 'AGENTS.md' && c.action === 'replace-block') &&
      after4c === `${head4c}${memoryBlock('AGENTS.md')}${tail4c}`,
    JSON.stringify(after4c.slice(0, 120)),
  );
  const status4c = await inspectMemory(c4c, home);
  check('y el estado lo da por al dia', status4c.files[0].hasBlock && status4c.files[0].blockCurrent && !status4c.files[0].brokenBlock);

  // Una sola marca citada no rompe nada: no es una marca.
  const c4d = await project('c4d');
  await put(c4d, 'AGENTS.md', `Las notas van despues de \`${MEMORY_BLOCK_START}\`.\n`);
  const status4d = await inspectMemory(c4d, home);
  check('una marca de inicio citada sola no es un bloque roto', !status4d.files[0].brokenBlock && !status4d.files[0].hasBlock);
  const install4d = await installMemory(c4d, only('AGENTS.md', { gitMode: 'version' }), home).then(
    (applied) => applied.some((c) => c.file === 'AGENTS.md' && c.action === 'append-block'),
    () => false,
  );
  check('y se puede instalar', install4d);

  // Un bloque de codigo sin cerrar llega hasta el final: sin tratarlo, el bloque
  // agregado quedaba adentro y cada instalacion agregaba otro.
  const c4e = await project('c4e');
  await put(c4e, 'AGENTS.md', '# Reglas\n\n```\nsin cerrar\n');
  await installMemory(c4e, only('AGENTS.md', { gitMode: 'version' }), home);
  const before4e = await snapshot(c4e);
  const again4e = await installMemory(c4e, only('AGENTS.md', { gitMode: 'version' }), home);
  check(
    'un bloque de codigo sin cerrar no hace que cada instalacion agregue otro bloque',
    again4e.length === 0 && (await snapshot(c4e)) === before4e &&
      count(await readText(c4e, 'AGENTS.md'), MEMORY_BLOCK_START) === 1,
    JSON.stringify(again4e),
  );

  // Hasta tres espacios antes y blancos despues siguen siendo la marca.
  const c4f = await project('c4f');
  await put(c4f, 'AGENTS.md', `antes\n  ${MEMORY_BLOCK_START}  \r\nviejo\n${MEMORY_BLOCK_END}\t\ndespues\n`);
  await installMemory(c4f, only('AGENTS.md', { gitMode: 'version' }), home);
  check(
    'una marca con sangria corta y blancos al final sigue siendo la marca',
    (await readText(c4f, 'AGENTS.md')) === `antes\n  ${memoryBlock('AGENTS.md')}\t\ndespues\n`,
    JSON.stringify((await readText(c4f, 'AGENTS.md')).slice(-50)),
  );

  // --- 5. Marca rota -------------------------------------------------------

  const c5 = await project('c5');
  const broken5 = `Reglas\n${MEMORY_BLOCK_START}\nsin cierre\n`;
  await put(c5, 'AGENTS.md', broken5);
  const status5 = await inspectMemory(c5, home);
  check('el estado marca el bloque roto', status5.files[0].brokenBlock && !status5.files[0].hasBlock);
  const failed5 = await rejectsWith(() => installMemory(c5, both, home), MemoryBridgeError);
  check('instalar con una marca rota falla con mensaje', failed5.ok && failed5.message.includes('AGENTS.md'), failed5.message);
  check('el archivo con la marca rota no cambia', (await readText(c5, 'AGENTS.md')) === broken5);
  check('y no se escribio nada mas', !(await exists(path.join(c5, '.agents'))) && !(await exists(path.join(c5, 'CLAUDE.md'))));
  await put(c5, 'CLAUDE.md', `solo el cierre\n${MEMORY_BLOCK_END}\n`);
  check('un cierre sin inicio tambien es un bloque roto', (await inspectMemory(c5, home)).files[1].brokenBlock);

  // --- 5b. Bloque repetido y cierre suelto ------------------------------------

  // Dos bloques (una fusion, un copiar y pegar): mirar solo el primero decia "al
  // dia" con el segundo viejo, y el agente leia instrucciones contradictorias.
  const c5b = await project('c5b');
  const twice5b = `${memoryBlock('AGENTS.md')}\n\n${MEMORY_BLOCK_START}\nviejo\n${MEMORY_BLOCK_END}\n`;
  await put(c5b, 'AGENTS.md', twice5b);
  const status5b = await inspectMemory(c5b, home);
  check('dos bloques son un bloque roto, no uno al dia', status5b.files[0].brokenBlock && !status5b.files[0].blockCurrent, JSON.stringify(status5b.files[0]));
  const failed5b = await rejectsWith(() => installMemory(c5b, only('AGENTS.md', { gitMode: 'version' }), home), MemoryBridgeError);
  check('y no se instala', failed5b.ok && (await readText(c5b, 'AGENTS.md')) === twice5b, failed5b.message);
  await put(c5b, 'CLAUDE.md', `${memoryBlock('CLAUDE.md')}\n${MEMORY_BLOCK_END}\n`);
  check('un cierre suelto despues del bloque tambien es roto', (await inspectMemory(c5b, home)).files[1].brokenBlock);

  // --- 5c. Un archivo en UTF-16 -----------------------------------------------

  // Lo que deja `>` en Windows PowerShell 5.1. Pegarle el bloque en UTF-8 lo
  // dejaba con dos codificaciones, y el estado lo daba por al dia.
  const c5c = await project('c5c');
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('# Notas\r\n', 'utf16le')]);
  await put(c5c, 'AGENTS.md', utf16);
  const status5c = await inspectMemory(c5c, home);
  check(
    'UTF-16: el estado lo marca y no ve bloque',
    status5c.files[0].problem === 'encoding' && status5c.files[0].exists && !status5c.files[0].hasBlock,
    JSON.stringify(status5c.files[0]),
  );
  const failed5c = await rejectsWith(() => installMemory(c5c, only('AGENTS.md', { gitMode: 'version' }), home), MemoryBridgeError);
  check('UTF-16: instalar falla con mensaje y no toca el archivo', failed5c.ok && failed5c.message.includes('UTF-8') && (await read(c5c, 'AGENTS.md')).equals(utf16), failed5c.message);
  check('UTF-16: y no se escribio nada', !(await exists(path.join(c5c, '.agents'))));

  // --- 6. Repo git, ignorar ------------------------------------------------

  const c6 = await project('c6');
  await put(c6, 'README.md', '# Proyecto\n');
  git(c6, 'init', '-q', '-b', 'main');
  commit(c6, 'chore: inicio');
  check('antes de instalar, el repo no ignora la memoria', checkIgnore(c6, '.agents/memory/MEMORY.md') === 1);
  await installMemory(c6, both, home);
  const ignore6 = await readText(c6, '.gitignore');
  const lines6 = ignore6.split('\n');
  check(
    '.gitignore con la memoria y los dos archivos creados de cero',
    lines6.includes('.agents/memory/') && lines6.includes('AGENTS.md') && lines6.includes('CLAUDE.md') &&
      lines6.includes('# Memoria compartida de los agentes (Agent Workbench)'),
    JSON.stringify(ignore6),
  );
  check('git check-ignore confirma la memoria', checkIgnore(c6, '.agents/memory/MEMORY.md') === 0);
  check('git check-ignore confirma AGENTS.md y CLAUDE.md', checkIgnore(c6, 'AGENTS.md') === 0 && checkIgnore(c6, 'CLAUDE.md') === 0);
  const status6 = await inspectMemory(c6, home);
  check('el estado dice repo que ignora', status6.git.kind === 'repo' && status6.git.ignored && status6.git.worktree === null, JSON.stringify(status6.git));
  const applied6b = await installMemory(c6, both, home);
  const ignore6b = await readText(c6, '.gitignore');
  check('segunda instalacion en el repo no aplica nada', applied6b.length === 0, JSON.stringify(applied6b));
  check(
    'y no duplica lineas',
    ignore6b === ignore6 && count(ignore6b, '.agents/memory/') === 1 && count(ignore6b, '# Memoria compartida') === 1,
  );

  const c6c = await project('c6c');
  await put(c6c, 'README.md', '# Proyecto\n');
  await put(c6c, 'AGENTS.md', '# Reglas del equipo\n');
  await put(c6c, '.gitignore', 'node_modules/');
  git(c6c, 'init', '-q', '-b', 'main');
  commit(c6c, 'chore: inicio');
  await installMemory(c6c, both, home);
  const ignore6c = await readText(c6c, '.gitignore');
  const lines6c = ignore6c.split('\n');
  check(
    'con AGENTS.md preexistente, no se agrega al ignore',
    lines6c.includes('.agents/memory/') && lines6c.includes('CLAUDE.md') && !lines6c.includes('AGENTS.md'),
    JSON.stringify(ignore6c),
  );
  check('el .gitignore previo sin salto final queda intacto al principio', ignore6c.startsWith('node_modules/\n\n# Memoria'));

  // La linea ya esta pero el indice se versiono antes: git no ignora un archivo
  // con seguimiento, y aun asi no hay que volver a escribirla en cada instalacion.
  const c6d = await project('c6d');
  await put(c6d, '.agents/memory/MEMORY.md', MEMORY_INDEX_TEMPLATE);
  await put(c6d, 'AGENTS.md', 'reglas\n');
  await put(c6d, 'CLAUDE.md', 'reglas\n');
  git(c6d, 'init', '-q', '-b', 'main');
  commit(c6d, 'chore: inicio');
  const gitignore6d = '# Memoria compartida de los agentes (Agent Workbench)\n.agents/memory/\n';
  await put(c6d, '.gitignore', gitignore6d);
  check('el indice con seguimiento no figura como ignorado', checkIgnore(c6d, '.agents/memory/MEMORY.md') === 1);
  const applied6d = await installMemory(c6d, both, home);
  check(
    'una linea que ya esta en .gitignore no se repite',
    (await readText(c6d, '.gitignore')) === gitignore6d && applied6d.every((c) => c.file !== '.gitignore'),
    JSON.stringify(applied6d.map((c) => c.file)),
  );

  // --- 6e. Una escritura que falla a mitad ------------------------------------

  // `.gitignore` se escribe primero. Si iba al final y fallaba una escritura
  // anterior, al reintentar AGENTS.md ya existia, no contaba como creado de
  // cero, y quedaba sin ignorar, listo para commitearse.
  if (process.platform === 'win32') {
    const c6e = await project('c6e');
    await put(c6e, 'README.md', '# Proyecto\n');
    await put(c6e, 'CLAUDE.md', 'reglas del repo\n');
    git(c6e, 'init', '-q', '-b', 'main');
    commit(c6e, 'chore: inicio');
    // Solo lectura: en Windows el `rename` sobre ese archivo falla con EPERM.
    await chmod(path.join(c6e, 'CLAUDE.md'), 0o444);
    let failedMidway = false;
    try {
      await installMemory(c6e, both, home);
    } catch {
      failedMidway = true;
    } finally {
      await chmod(path.join(c6e, 'CLAUDE.md'), 0o644);
    }
    check('la instalacion con CLAUDE.md de solo lectura falla a mitad', failedMidway && (await exists(path.join(c6e, 'AGENTS.md'))));
    check('y AGENTS.md, creado antes de fallar, ya quedo ignorado', checkIgnore(c6e, 'AGENTS.md') === 0);
    await installMemory(c6e, both, home);
    const ignore6e = await readText(c6e, '.gitignore');
    check(
      'al reintentar, AGENTS.md sigue ignorado y sin lineas repetidas',
      checkIgnore(c6e, 'AGENTS.md') === 0 && count(ignore6e, 'AGENTS.md') === 1 && !ignore6e.split('\n').includes('CLAUDE.md'),
      JSON.stringify(ignore6e),
    );
  } else {
    console.log('OMITIDO escritura a mitad — el archivo de solo lectura solo frena el rename en Windows');
  }

  // --- 7. Repo git, versionar ------------------------------------------------

  const c7 = await project('c7');
  await put(c7, 'README.md', '# Proyecto\n');
  git(c7, 'init', '-q', '-b', 'main');
  commit(c7, 'chore: inicio');
  const applied7 = await installMemory(c7, { ...both, gitMode: 'version' }, home);
  check('versionar: no se crea .gitignore', !(await exists(path.join(c7, '.gitignore'))));
  check('versionar: ningun cambio toca .gitignore', applied7.every((c) => c.file !== '.gitignore'));
  const c7b = await project('c7b');
  await put(c7b, '.gitignore', 'dist/\n');
  git(c7b, 'init', '-q', '-b', 'main');
  commit(c7b, 'chore: inicio');
  await installMemory(c7b, { ...both, gitMode: 'version' }, home);
  check('versionar: un .gitignore existente queda sin tocar', (await readText(c7b, '.gitignore')) === 'dist/\n');

  // --- 8. Worktree enlazado ---------------------------------------------------

  const main8 = await project('c8-main');
  await put(main8, 'README.md', '# Principal\n');
  await put(main8, '.gitignore', '.agents/\n');
  git(main8, 'init', '-q', '-b', 'main');
  commit(main8, 'chore: inicio');
  await put(main8, '.agents/memory/MEMORY.md', '# Memoria\n\n- [Uno](uno.md) — primera\n- [Dos](dos.md) — segunda\n');
  await put(main8, '.agents/memory/uno.md', '---\nname: Uno\ndescription: primera\n---\nhecho uno\n');
  await put(main8, '.agents/memory/dos.md', 'hecho dos del principal\n');
  const wt8 = path.join(root, 'c8-wt');
  git(main8, 'worktree', 'add', '-q', '-b', 'feature', wt8);
  await put(wt8, '.agents/memory/dos.md', 'dos propio del worktree\n');

  const status8 = await inspectMemory(wt8, home);
  const mainPath8 = status8.git.kind === 'repo' ? status8.git.worktree?.mainPath : undefined;
  const sameDir = async (a, b) =>
    a !== undefined && (await stat(a)).ino === (await stat(b)).ino && path.basename(a) === path.basename(b);
  check('worktree: mainPath es el principal', await sameDir(mainPath8, main8), String(mainPath8));
  check('worktree: el principal tiene memoria', status8.git.kind === 'repo' && status8.git.worktree?.mainHasMemory === true);
  const status8main = await inspectMemory(main8, home);
  check('el principal no es un worktree enlazado', status8main.git.kind === 'repo' && status8main.git.worktree === null);

  const applied8 = await installMemory(wt8, { ...both, copyFromMainWorktree: true }, home);
  check(
    'worktree: el indice se copia en vez de usar la plantilla',
    (await read(wt8, '.agents/memory/MEMORY.md')).equals(await read(main8, '.agents/memory/MEMORY.md')) &&
      applied8.some((c) => c.file === '.agents/memory/MEMORY.md' && c.action === 'copy'),
  );
  check('worktree: copia las notas que faltan', (await read(wt8, '.agents/memory/uno.md')).equals(await read(main8, '.agents/memory/uno.md')));
  check('worktree: no pisa una nota que ya estaba', (await readText(wt8, '.agents/memory/dos.md')) === 'dos propio del worktree\n');
  const notes8 = (await inspectMemory(wt8, home)).notes;
  check(
    'las notas se describen con el frontmatter o el nombre',
    notes8.some((n) => n.name === 'uno.md' && n.title === 'Uno' && n.description === 'primera') &&
      notes8.some((n) => n.name === 'dos.md' && n.title === 'dos' && n.description === ''),
    JSON.stringify(notes8.map((n) => [n.name, n.title, n.description])),
  );

  // --- 8b. Worktree principal con la memoria enlazada hacia afuera -------------

  // La ruta del principal la da git, pero lo que hay adentro no: un `.agents`
  // que en el principal es una junction a otra carpeta copiaba al worktree lo
  // que hubiera ahi, con una previsualizacion que decia "Copia de <principal>".
  const main8b = await project('c8b-main');
  await put(main8b, 'README.md', '# Principal\n');
  await put(main8b, '.gitignore', '.agents\n');
  git(main8b, 'init', '-q', '-b', 'main');
  commit(main8b, 'chore: inicio');
  const outside8b = await project('c8b-afuera');
  await put(outside8b, 'memory/MEMORY.md', '# Ajena\n\n- [Privado](privado.md) — de afuera\n');
  await put(outside8b, 'memory/privado.md', 'SECRETO DE AFUERA\n');
  let linked8b = true;
  try {
    await symlink(outside8b, path.join(main8b, '.agents'), 'junction');
  } catch {
    linked8b = false;
  }
  if (linked8b) {
    const wt8b = path.join(root, 'c8b-wt');
    git(main8b, 'worktree', 'add', '-q', '-b', 'feature', wt8b);
    const status8b = await inspectMemory(wt8b, home);
    check(
      'worktree: un .agents enlazado hacia afuera en el principal no cuenta como memoria',
      status8b.git.kind === 'repo' && status8b.git.worktree !== null && status8b.git.worktree.mainHasMemory === false,
      JSON.stringify(status8b.git),
    );
    const plan8b = await planMemoryInstall(wt8b, { ...both, copyFromMainWorktree: true }, home);
    check('y el plan no copia nada de ahi', plan8b.every((c) => c.action !== 'copy'), JSON.stringify(plan8b.map((c) => `${c.file}:${c.action}`)));
    await installMemory(wt8b, { ...both, copyFromMainWorktree: true }, home);
    check(
      'ni la instalacion',
      !(await exists(path.join(wt8b, '.agents/memory/privado.md'))) &&
        (await readText(wt8b, '.agents/memory/MEMORY.md')) === MEMORY_INDEX_TEMPLATE,
    );
  } else {
    console.log('OMITIDO worktree con junction — el sistema no dejo crearla');
  }

  // El indice del principal enlazado a un archivo de afuera. Pide permiso de
  // enlaces simbolicos en Windows: sin el, se omite.
  const main8c = await project('c8c-main');
  await put(main8c, 'README.md', '# Principal\n');
  await put(main8c, '.gitignore', '.agents\n');
  git(main8c, 'init', '-q', '-b', 'main');
  commit(main8c, 'chore: inicio');
  await put(root, 'c8c-afuera.md', '# Credenciales de mentira\n');
  await mkdir(path.join(main8c, '.agents', 'memory'), { recursive: true });
  let linked8c = true;
  try {
    await symlink(path.join(root, 'c8c-afuera.md'), path.join(main8c, '.agents', 'memory', 'MEMORY.md'), 'file');
  } catch {
    linked8c = false;
  }
  if (linked8c) {
    const wt8c = path.join(root, 'c8c-wt');
    git(main8c, 'worktree', 'add', '-q', '-b', 'feature', wt8c);
    const status8c = await inspectMemory(wt8c, home);
    check(
      'worktree: un MEMORY.md del principal enlazado hacia afuera no cuenta como memoria',
      status8c.git.kind === 'repo' && status8c.git.worktree?.mainHasMemory === false,
      JSON.stringify(status8c.git),
    );
  } else {
    console.log('OMITIDO MEMORY.md enlazado en el principal — el sistema no dejo crear el enlace');
  }

  // --- 9. .agents como junction hacia afuera ------------------------------------

  const c9 = await project('c9');
  const outside9 = await project('c9-afuera');
  await put(outside9, 'memory/secreto.md', 'no se debe leer\n');
  let linked = true;
  try {
    await symlink(outside9, path.join(c9, '.agents'), 'junction');
  } catch {
    linked = false;
  }
  if (linked) {
    const outsideBefore = await snapshot(outside9);
    const projectBefore = await snapshot(c9);
    const install9 = await rejectsWith(() => installMemory(c9, both, home), InvalidPathError);
    check('una junction .agents hacia afuera: instalar se rechaza', install9.ok, install9.message);
    const plan9 = await rejectsWith(() => planMemoryInstall(c9, both, home), InvalidPathError);
    check('y planear tambien', plan9.ok, plan9.message);
    const import9 = await rejectsWith(() => importNativeMemory(c9, home), InvalidPathError);
    check('y importar tambien', import9.ok, import9.message);
    const read9 = await rejectsWith(() => readMemoryNote(c9, 'secreto.md'), InvalidPathError);
    check('y leer una nota a traves de ella', read9.ok, read9.message);
    check('afuera no se escribio nada', (await snapshot(outside9)) === outsideBefore);
    check('adentro tampoco', (await snapshot(c9)) === projectBefore);
  } else {
    console.log('OMITIDO junction — el sistema no dejo crearla');
  }

  // --- 9b. El temporal no se puede adivinar ------------------------------------

  // Con `.<nombre>.<pid>.tmp` y `writeFile`, un enlace duro puesto de antemano
  // con ese nombre recibia la escritura —fuera del proyecto— y el `rename`
  // dejaba AGENTS.md enlazado a ese archivo. Un enlace duro no pide permisos.
  const c9b = await project('c9b');
  await put(c9b, 'AGENTS.md', 'contenido del repo\n');
  const outside9b = path.join(root, 'c9b-afuera.txt');
  await writeFile(outside9b, 'no se toca\n');
  let hardLinked9b = true;
  try {
    await link(outside9b, path.join(c9b, `.AGENTS.md.${process.pid}.tmp`));
  } catch {
    hardLinked9b = false;
  }
  if (hardLinked9b) {
    await installMemory(c9b, only('AGENTS.md', { gitMode: 'version' }), home);
    check('un temporal con el nombre viejo enlazado afuera no recibe la escritura', (await readFile(outside9b, 'utf8')) === 'no se toca\n');
    check(
      'y AGENTS.md queda como archivo propio, con el bloque',
      (await stat(path.join(c9b, 'AGENTS.md'))).nlink === 1 &&
        (await readText(c9b, 'AGENTS.md')) === `contenido del repo\n\n${memoryBlock('AGENTS.md')}\n`,
    );
  } else {
    console.log('OMITIDO temporal enlazado — el sistema no dejo crear el enlace duro');
  }
  check(
    'no quedan temporales del puente despues de instalar',
    (await readdir(c1)).every((name) => !name.endsWith('.tmp')) &&
      (await readdir(path.join(c1, '.agents', 'memory'))).every((name) => !name.endsWith('.tmp')),
  );

  // --- 9c. Un archivo de instrucciones enlazado hacia afuera -------------------

  // Un repo puede versionar `CLAUDE.md` como enlace a `~/.claude/.credentials.json`.
  // Ni abrir la solapa lo lee, y no impide instalar en AGENTS.md: antes, el
  // enlace bloqueaba instalar de cualquier forma, e importar tambien.
  const c9c = await project('c9c');
  const outside9c = await project('c9c-afuera');
  await put(outside9c, 'CLAUDE.md', `# Dotfiles\n\n${memoryBlock('CLAUDE.md')}\n`);
  const outsideBefore9c = await snapshot(outside9c);
  let linkKind9c = 'archivo';
  try {
    await symlink(path.join(outside9c, 'CLAUDE.md'), path.join(c9c, 'CLAUDE.md'), 'file');
  } catch {
    // Sin permiso de enlaces simbolicos en Windows: una junction a la carpeta
    // tambien resuelve afuera, que es lo que se prueba.
    linkKind9c = 'junction';
    await symlink(outside9c, path.join(c9c, 'CLAUDE.md'), 'junction');
  }
  const status9c = await inspectMemory(c9c, home);
  check(
    `CLAUDE.md enlazado afuera (${linkKind9c}): el estado no lo lee`,
    status9c.files[1].problem === 'outside' && status9c.files[1].exists &&
      !status9c.files[1].hasBlock && !status9c.files[1].blockCurrent,
    JSON.stringify(status9c.files[1]),
  );
  check(
    'y Claude Code no cuenta como que llega',
    status9c.reach[0].agent === 'claude-code' && !status9c.reach[0].reaches,
    JSON.stringify(status9c.reach[0]),
  );
  const install9c = await installMemory(c9c, only('AGENTS.md', { gitMode: 'version' }), home).then(
    (applied) => ({ ok: applied.some((c) => c.file === 'AGENTS.md'), message: '' }),
    (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
  check('instalar solo en AGENTS.md no se bloquea por ese enlace', install9c.ok, install9c.message);
  const reach9c = (await inspectMemory(c9c, home)).reach;
  check(
    'con el puente instalado, el alcance dice por que Claude Code no llega',
    !reach9c[0].reaches && reach9c[0].via === 'CLAUDE.md apunta fuera del proyecto' && reach9c[1].reaches,
    JSON.stringify(reach9c[0]),
  );
  const import9c = await importNativeMemory(c9c, home).then(
    () => ({ ok: true, message: '' }),
    (error) => ({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
  check('importar tampoco', import9c.ok, import9c.message);
  const chosen9c = await rejectsWith(() => installMemory(c9c, only('CLAUDE.md', { gitMode: 'version' }), home), InvalidPathError);
  check('elegirlo si se rechaza', chosen9c.ok, chosen9c.message);
  check('y afuera no cambio nada', (await snapshot(outside9c)) === outsideBefore9c);

  const c10 = await project('c10');
  await installMemory(c10, both, home);
  await put(c10, '.agents/memory/nota.md', '# Una nota\n\nEl hecho.\n');
  await put(root, 'c10-secreto.md', 'afuera\n');
  const hostile10 = ['../x.md', '../c10-secreto.md', 'C:\\x.md', 'a/b.md', 'a\\b.md', 'x.txt', 'x\0.md', '..', 'nota:ads.md'];
  let leaked10 = null;
  for (const name of hostile10) {
    const outcome = await rejectsWith(() => readMemoryNote(c10, name), InvalidPathError);
    if (!outcome.ok) leaked10 = `${JSON.stringify(name)}: ${outcome.message}`;
  }
  check('readMemoryNote rechaza cada nombre hostil', leaked10 === null, String(leaked10));
  const note10 = await readMemoryNote(c10, 'nota.md');
  check('lee una nota valida', note10?.text === '# Una nota\n\nEl hecho.\n' && note10.truncated === false);
  const index10 = await readMemoryNote(c10, 'MEMORY.md');
  check('lee el indice', index10?.text === MEMORY_INDEX_TEMPLATE);
  check('una nota que no existe es null', (await readMemoryNote(c10, 'nada.md')) === null);
  await put(c10, '.agents/memory/grande.md', 'x'.repeat(300 * 1024));
  const big10 = await readMemoryNote(c10, 'grande.md');
  check('una nota grande se recorta a 256 KB', big10?.truncated === true && big10.text.length === 256 * 1024);

  // --- 11. Memoria nativa -----------------------------------------------------

  const c11 = await project('c11');
  const slug11 = projectSlugFor(c11);
  const upper11 = slug11.toUpperCase();
  check('el slug de prueba tiene otra capitalizacion', upper11 !== slug11);
  const nativeUpper = path.join(home, '.claude', 'projects', upper11, 'memory');
  const nativeExact = path.join(home, '.claude', 'projects', slug11, 'memory');
  await put(nativeUpper, 'MEMORY.md', '# Memory\n\n- [Decisión ORM](decision-orm.md) — por qué\n- [Trampa](trampa.md) — ya pisada\n- [Conflicto](conflicto.md) — nativo\n');
  await put(nativeUpper, 'decision-orm.md', '---\nname: Decisión ORM\n---\nnativo\n');
  await put(nativeUpper, 'trampa.md', 'trampa nativa\n');
  await put(nativeUpper, 'conflicto.md', 'version nativa\n');
  await put(nativeExact, 'extra.md', 'extra nativa\n');
  await put(home, '.claude/projects/otro-proyecto/memory/ajena.md', 'de otro proyecto\n');

  const importEarly = await rejectsWith(() => importNativeMemory(c11, home), MemoryBridgeError);
  check('importar sin la carpeta compartida pide instalar primero', importEarly.ok && importEarly.message.includes('Instalá el puente primero'), importEarly.message);

  await installMemory(c11, both, home);
  await put(c11, '.agents/memory/conflicto.md', 'version compartida\n');
  await writeFile(
    path.join(c11, '.agents/memory/MEMORY.md'),
    `${MEMORY_INDEX_TEMPLATE}- [Conflicto](conflicto.md) — compartido\n`,
  );
  const status11 = await inspectMemory(c11, home);
  check('nativa: available y pending', status11.native.available === 4 && status11.native.pending === 3, JSON.stringify(status11.native));

  const homeBefore11 = await snapshot(home);
  const import11 = await importNativeMemory(c11, home);
  check(
    'importa los pendientes',
    JSON.stringify([...import11.copied].sort()) === JSON.stringify(['decision-orm.md', 'extra.md', 'trampa.md']),
    JSON.stringify(import11),
  );
  check('un nombre en conflicto va a skipped', JSON.stringify(import11.skipped) === JSON.stringify(['conflicto.md']));
  check('y no se pisa', (await readText(c11, '.agents/memory/conflicto.md')) === 'version compartida\n');
  check('la nota importada es identica', (await readText(c11, '.agents/memory/trampa.md')) === 'trampa nativa\n');
  const index11 = await readText(c11, '.agents/memory/MEMORY.md');
  check(
    'fusiona el indice una vez por nota',
    count(index11, '(decision-orm.md)') === 1 && count(index11, '(trampa.md)') === 1 && count(index11, '(conflicto.md)') === 1,
    JSON.stringify(index11),
  );
  check('las lineas fusionadas van al final', index11.endsWith('- [Trampa](trampa.md) — ya pisada\n'));
  check('la memoria nativa no se toca', (await snapshot(home)) === homeBefore11);
  check('despues de importar no queda nada pendiente', (await inspectMemory(c11, home)).native.pending === 0);

  const before11b = await snapshot(c11);
  const import11b = await importNativeMemory(c11, home);
  check('reimportar copia 0', import11b.copied.length === 0, JSON.stringify(import11b));
  check('reimportar no cambia un byte', (await snapshot(c11)) === before11b);

  const c11c = await project('c11c');
  const slug11c = projectSlugFor(c11c);
  await put(path.join(home, '.claude', 'projects', slug11c.toLowerCase(), 'memory'), 'MEMORY.md', '- [Hecho](hecho.md) — algo\n');
  await put(path.join(home, '.claude', 'projects', slug11c.toLowerCase(), 'memory'), 'hecho.md', 'hecho\n');
  const plan11c = await planMemoryInstall(c11c, { ...both, importNative: true }, home);
  const indexChange11c = plan11c.find((c) => c.file === '.agents/memory/MEMORY.md');
  check(
    'instalar importando: el indice nuevo trae la linea fusionada, en un solo cambio',
    indexChange11c?.action === 'create' &&
      indexChange11c.preview.includes('- [Hecho](hecho.md) — algo') &&
      plan11c.filter((c) => c.file === '.agents/memory/MEMORY.md').length === 1 &&
      plan11c.some((c) => c.file === '.agents/memory/hecho.md' && c.action === 'copy'),
    JSON.stringify(plan11c.map((c) => `${c.file}:${c.action}`)),
  );
  await installMemory(c11c, { ...both, importNative: true }, home);
  check(
    'y lo escribe',
    (await readText(c11c, '.agents/memory/MEMORY.md')) === `${MEMORY_INDEX_TEMPLATE}- [Hecho](hecho.md) — algo\n` &&
      (await readText(c11c, '.agents/memory/hecho.md')) === 'hecho\n',
  );

  // --- 12. Alcance por CLI ----------------------------------------------------

  const reachOf = (status) =>
    Object.fromEntries(status.reach.map((r) => [r.agent, `${r.reaches ? 'si' : 'no'}:${r.via}`]));

  const c12a = await project('c12a');
  await installMemory(c12a, only('AGENTS.md'), home);
  const reach12a = reachOf(await inspectMemory(c12a, home));
  check(
    'solo AGENTS.md: llegan Codex, Antigravity y OpenCode',
    reach12a['claude-code'] === 'no:falta el bloque en CLAUDE.md' &&
      reach12a.codex === 'si:AGENTS.md' &&
      reach12a.antigravity === 'si:AGENTS.md' &&
      reach12a.opencode === 'si:AGENTS.md',
    JSON.stringify(reach12a),
  );

  const c12b = await project('c12b');
  await installMemory(c12b, only('CLAUDE.md'), home);
  const reach12b = reachOf(await inspectMemory(c12b, home));
  check(
    'solo CLAUDE.md: llegan Claude Code y OpenCode por respaldo',
    reach12b['claude-code'] === 'si:CLAUDE.md' &&
      reach12b.codex === 'no:falta el bloque en AGENTS.md' &&
      reach12b.antigravity === 'no:falta el bloque en AGENTS.md' &&
      reach12b.opencode === 'si:CLAUDE.md (respaldo)',
    JSON.stringify(reach12b),
  );
  await put(c12b, 'AGENTS.md', '# Reglas sin bloque\n');
  const reach12b2 = reachOf(await inspectMemory(c12b, home));
  check('con un AGENTS.md sin bloque, OpenCode ya no usa el respaldo', reach12b2.opencode === 'no:falta el bloque en AGENTS.md', JSON.stringify(reach12b2));

  const status12c = await inspectMemory(c1, home);
  const reach12c = reachOf(status12c);
  check(
    'los dos: llegan las cuatro, en orden',
    status12c.reach.map((r) => r.agent).join(',') === 'claude-code,codex,antigravity,opencode' &&
      Object.values(reach12c).every((value) => value.startsWith('si:')) &&
      reach12c.opencode === 'si:AGENTS.md',
    JSON.stringify(reach12c),
  );
  await rm(path.join(c12a, '.agents', 'memory', 'MEMORY.md'));
  check('sin indice no llega ninguna', (await inspectMemory(c12a, home)).reach.every((r) => !r.reaches));

  const fragments = status12c.globalFragments;
  check(
    'fragmentos globales: los cuatro, sin escribir nada',
    fragments.length === 4 &&
      fragments[0].text === '@~/.agents/global.md' &&
      fragments[1].kind === 'command' && fragments[1].text.includes(path.join(home, '.codex', 'AGENTS.md')) &&
      fragments[2].text.includes(path.join(home, '.gemini', 'GEMINI.md')) &&
      fragments[3].text === `"instructions": ["${home.replace(/\\/g, '/')}/.agents/global.md"]` &&
      !(await exists(path.join(home, '.agents'))),
    JSON.stringify(fragments.map((f) => f.text)),
  );

  // --- 13. inspectMemory no crea nada -------------------------------------------

  const c13 = await project('c13');
  await put(c13, 'README.md', 'nada\n');
  await put(c13, 'CLAUDE.md', 'reglas sin bloque\n');
  const before13 = await snapshot(c13);
  const home13 = await snapshot(home);
  const status13 = await inspectMemory(c13, home);
  check('inspectMemory no crea nada en el proyecto', (await snapshot(c13)) === before13);
  check('ni en el home', (await snapshot(home)) === home13);
  check(
    'y describe lo que hay',
    !status13.folderExists && !status13.indexExists && !status13.installed &&
      status13.files[1].exists && !status13.files[1].hasBlock && !status13.files[0].exists,
  );
  const c13repo = await project('c13repo');
  await put(c13repo, 'README.md', 'nada\n');
  git(c13repo, 'init', '-q', '-b', 'main');
  commit(c13repo, 'chore: inicio');
  const before13repo = await snapshot(c13repo, { skipGit: false });
  await inspectMemory(c13repo, home);
  await planMemoryInstall(c13repo, both, home);
  check('ni inspeccionar ni planear escriben en un repo, .git incluido', (await snapshot(c13repo, { skipGit: false })) === before13repo);

  // --- 14. git que no arranca -------------------------------------------------

  const savedPath = process.env.PATH;
  process.env.PATH = '';
  let status14;
  try {
    status14 = await inspectMemory(c6, home);
  } finally {
    process.env.PATH = savedPath;
  }
  check(
    'sin git en el PATH el estado es error, no "no es un repo"',
    status14.git.kind === 'error' && status14.git.message.length > 0,
    JSON.stringify(status14.git),
  );
  process.env.PATH = '';
  let install14;
  try {
    install14 = await rejectsWith(() => installMemory(c13, both, home), MemoryBridgeError);
  } finally {
    process.env.PATH = savedPath;
  }
  check('y con gitMode ignore no se instala a ciegas', install14.ok && !(await exists(path.join(c13, '.agents'))), install14.message);
  // La salida que ofrece el panel: sin tocar .gitignore si se puede.
  check('con git en error, las opciones por defecto no tocan .gitignore', defaultMemoryInstallOptions(status14).gitMode === 'version');
  process.env.PATH = '';
  let plan14;
  try {
    plan14 = await planMemoryInstall(c13, { ...both, gitMode: 'version' }, home).then(
      (changes) => ({ ok: true, changes }),
      (error) => ({ ok: false, changes: [], message: error instanceof Error ? error.message : String(error) }),
    );
  } finally {
    process.env.PATH = savedPath;
  }
  check(
    'y con gitMode version el plan sale igual, sin .gitignore',
    plan14.ok && plan14.changes.some((c) => c.file === 'AGENTS.md') && plan14.changes.every((c) => c.file !== '.gitignore'),
    plan14.message ?? JSON.stringify(plan14.changes.map((c) => c.file)),
  );

  // --- Protocolo: requestId y el problema de un archivo ---------------------------

  const planMessage = parseClientMessage(
    encodeClientMessage({ type: 'memory.plan', terminalId: 't1', options: both, requestId: 'memory-1' }),
  );
  check('memory.plan conserva su requestId', planMessage?.type === 'memory.plan' && planMessage.requestId === 'memory-1');
  const bareRead = parseClientMessage(JSON.stringify({ type: 'memory.read', terminalId: 't1', name: 'a.md' }));
  check('sin requestId el pedido sigue siendo valido', bareRead?.type === 'memory.read' && !('requestId' in bareRead));
  const emptyId = parseClientMessage(JSON.stringify({ type: 'memory.import', terminalId: 't1', requestId: '' }));
  check('un requestId vacio no se acepta como id', emptyId?.type === 'memory.import' && !('requestId' in emptyId));
  const planned = parseServerMessage(
    encodeServerMessage({ type: 'memory.planned', terminalId: 't1', changes: [], requestId: 'memory-2' }),
  );
  check('memory.planned devuelve el requestId', planned?.type === 'memory.planned' && planned.requestId === 'memory-2');
  const statusMessage = parseServerMessage(encodeServerMessage({ type: 'memory.status', terminalId: 't1', status: status9c }));
  check(
    'memory.status viaja con el problema de cada archivo',
    statusMessage?.type === 'memory.status' && statusMessage.status.files[1].problem === 'outside' &&
      statusMessage.status.files[0].problem === null,
  );
  const badProblem = JSON.parse(encodeServerMessage({ type: 'memory.status', terminalId: 't1', status: status9c }));
  badProblem.status.files[0].problem = 'otro';
  check('un problema desconocido invalida el estado', parseServerMessage(JSON.stringify(badProblem)) === null);

  // --- Filtro del watcher -----------------------------------------------------

  const cwd = path.join(root, 'w');
  const relevant = (rel) => isRelevantPath(cwd, path.join(cwd, rel));
  check(
    'el watcher deja pasar solo lo que cambia el estado',
    isRelevantPath(cwd, cwd) &&
      relevant('.agents') && relevant('.agents/memory') && relevant('.agents/memory/nota.md') &&
      relevant('AGENTS.md') && relevant('CLAUDE.md') && relevant('.gitignore') &&
      !relevant('node_modules') && !relevant('src/AGENTS.md') && !relevant('.agents/rules') &&
      !relevant('.agents/memory/.nota.md.123.tmp') && !relevant('.agents/memory/sub/nota.md') &&
      !isRelevantPath(cwd, path.join(root, 'otro')),
  );

  // --- El hub: cola por cwd y watcher -----------------------------------------

  const cH = await project('hub');
  const registry = { get: (id) => (id === 't1' || id === 't2' ? { cwd: cH } : null) };
  const hub = new MemoryHub(registry, home);
  const emitted = [];
  hub.on('status', (terminalId, status) => emitted.push({ terminalId, status }));
  try {
    const first = await hub.subscribe('t1');
    await hub.subscribe('t2');
    check('hub: suscribirse devuelve el estado', first !== null && !first.installed);
    check('hub: una pestana desconocida no se suscribe', (await hub.subscribe('nadie')) === null);
    const unknown = await rejectsWith(() => hub.plan('nadie', both), UnknownTerminalError);
    check('hub: operar sobre una pestana desconocida falla con su error', unknown.ok, unknown.message);

    // Dos instalaciones a la vez sobre el mismo cwd: sin la cola, las dos
    // planean antes de que la otra escriba y la segunda choca con lo creado.
    let serialized = false;
    let detail = '';
    try {
      const [a, b] = await Promise.all([hub.install('t1', both), hub.install('t2', both)]);
      serialized = a.applied.length === 3 && b.applied.length === 0 && b.status?.installed === true;
      detail = `${a.applied.length}/${b.applied.length}`;
    } catch (error) {
      detail = error instanceof Error ? error.message : String(error);
    }
    check('hub: dos instalaciones simultaneas se serializan', serialized, detail);

    // El watcher ve una nota escrita por fuera. Se espera por condicion, con
    // tope: se reescribe una nota hasta que llegue el aviso, por si el watcher
    // todavia no habia terminado de arrancar.
    const deadline = Date.now() + 15_000;
    let seen = false;
    for (let attempt = 0; !seen && Date.now() < deadline; attempt += 1) {
      await put(cH, '.agents/memory/vista.md', `# Vista ${attempt}\n`);
      const until = Date.now() + 700;
      while (!seen && Date.now() < until) {
        seen = emitted.some(
          ({ terminalId, status }) => terminalId === 't2' && status.notes.some((n) => n.name === 'vista.md'),
        );
        if (!seen) await new Promise((resolve) => setImmediate(resolve));
      }
    }
    check('hub: el watcher avisa a los suscriptores de ese cwd', seen);
  } finally {
    await hub.disposeAll();
  }
} catch (error) {
  failures++;
  console.log('FALLO excepcion inesperada —', error instanceof Error ? error.stack : String(error));
} finally {
  // En Windows el watcher del hub puede tardar un instante en soltar la carpeta:
  // `rm` reintenta solo ante EBUSY/EPERM.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch((error) => {
    console.log(`AVISO no se pudo borrar ${root}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

console.log(`\n${failures === 0 ? 'TODO OK' : `${failures} FALLO(S)`}`);
process.exit(failures === 0 ? 0 : 1);
