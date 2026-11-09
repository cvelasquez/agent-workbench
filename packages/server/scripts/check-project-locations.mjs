/**
 * Chequeo de las ubicaciones de proyecto (Hito 56): reasignar la carpeta de un
 * proyecto al migrar de PC.
 *
 *   npx tsx scripts/check-project-locations.mjs
 *
 * Una ubicacion dice "esta carpeta, que ya no existe, ahora esta en esta otra".
 * Lo que se rompe sin avisar:
 *
 *  - una resolucion que junta proyectos distintos (`D:\x2` bajo `D:\x`), que
 *    encadena una ubicacion con otra o que se come una unidad entera;
 *  - un archivo que se pierde al guardar otro ajuste, o que una version nueva
 *    de la app deja ilegible para una vieja y esta pisa;
 *  - una asociacion que esconde una carpeta que existe;
 *  - un pedido de un equipo remoto, o un cliente que nombra una ruta.
 *
 * Trabaja sobre un `APPDATA`/`XDG_CONFIG_HOME` temporal propio, para no tocar
 * la configuracion real de quien lo corre. No lanza ninguna CLI.
 *
 * Secciones: R la resolucion pura, S el almacen.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';

const root = path.join(tmpdir(), `check-project-locations-${process.pid}`);
await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
// Antes de importar nada: el indice lee el historial de Claude Code de este home, no del real.
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['APPDATA'] = root;
process.env['XDG_CONFIG_HOME'] = root;
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' - ' + extra : ''}`);
  if (!ok) failures++;
};
const show = (value) => JSON.stringify(value);

const shared = await import('@agent-workbench/shared');
const locations = await import('../src/project-locations.ts');
const { projectLocationsPath, appConfigDir } = await import('../src/paths.ts');
const { resolveLocation, makeLocation, isBroadFolder, ProjectLocationStore, ProjectLocationError } = locations;

// ---------------------------------------------------------------------------
// R. La resolucion pura
// ---------------------------------------------------------------------------

const WIN = 'win32';
const HOME = 'C:\\Users\\yo';
const at = (from, to) => makeLocation(from, to, WIN, 1);
const resolveWin = (cwd, list) => resolveLocation(cwd, list, WIN, HOME)?.cwd ?? null;

{
  const one = [at('D:\\MyProject', 'D:\\AWB\\MyProject')];

  check('R1 la carpeta misma pasa a la nueva', resolveWin('D:\\MyProject', one) === 'D:\\AWB\\MyProject', show(resolveWin('D:\\MyProject', one)));
  check('R1 con otra forma de escribirla: barras, mayusculas de unidad y barra final',
    resolveWin('d:/MyProject/', one) === 'D:\\AWB\\MyProject' && resolveWin('D:\\myproject', one) === 'D:\\AWB\\MyProject' &&
    resolveWin('\\\\?\\D:\\MyProject', one) === 'D:\\AWB\\MyProject');
  check('R2 una subcarpeta va con el proyecto, y conserva sus mayusculas',
    resolveWin('D:\\MyProject\\Web\\Src', one) === 'D:\\AWB\\MyProject\\Web\\Src', show(resolveWin('D:\\MyProject\\Web\\Src', one)));
  check('R2 el resto no se normaliza a minusculas ni se come espacios ni tildes',
    resolveWin('D:\\MyProject\\Diseño final\\Ñandú', one) === 'D:\\AWB\\MyProject\\Diseño final\\Ñandú');

  check('R3 por segmento entero: D:\\MyProject2 y D:\\MyProjectX\\web no son del proyecto',
    resolveWin('D:\\MyProject2', one) === null && resolveWin('D:\\MyProjectX\\web', one) === null);
  check('R4 nunca la carpeta de arriba ni una hermana',
    resolveWin('D:\\', one) === null && resolveWin('D:\\Otro', one) === null && resolveWin('E:\\MyProject', one) === null);
  check('R5 una carpeta vacia no se resuelve a nada', resolveLocation('', one, WIN, HOME) === null);

  const nested = [at('D:\\MyProject', 'D:\\A'), at('D:\\MyProject\\web', 'D:\\B')];
  check('R6 gana la mas especifica, y el resto se arma contra ella',
    resolveWin('D:\\MyProject\\web\\src', nested) === 'D:\\B\\src' && resolveWin('D:\\MyProject\\web', nested) === 'D:\\B',
    show(resolveWin('D:\\MyProject\\web\\src', nested)));
  check('R6 las demas subcarpetas siguen con la del proyecto',
    resolveWin('D:\\MyProject\\api', nested) === 'D:\\A\\api' && resolveWin('D:\\MyProject', nested) === 'D:\\A');
  const swapped = [...nested].reverse();
  check('R6 el orden de la lista no cambia el resultado', resolveWin('D:\\MyProject\\web\\src', swapped) === 'D:\\B\\src');

  const chain = [at('D:\\A', 'D:\\B'), at('D:\\B', 'D:\\C')];
  check('R7 una sola vuelta: A -> B y B -> C no encadenan', resolveWin('D:\\A\\x', chain) === 'D:\\B\\x' && resolveWin('D:\\B\\x', chain) === 'D:\\C\\x');
  const cycle = [at('D:\\A', 'D:\\B'), at('D:\\B', 'D:\\A')];
  check('R7 y un ciclo no se recorre: cada carpeta pasa a la otra una vez',
    resolveWin('D:\\A', cycle) === 'D:\\B' && resolveWin('D:\\B', cycle) === 'D:\\A');

  const reaches = resolveLocation('D:\\MyProject\\web', one, WIN, HOME);
  check('R8 el resultado dice la ubicacion usada y lo que quedaba por debajo',
    reaches !== null && reaches.location.from === 'D:\\MyProject' && reaches.location.to === 'D:\\AWB\\MyProject' && reaches.rest === 'web', show(reaches));
  check('R8 la misma carpeta: rest vacio', resolveLocation('D:\\MyProject', one, WIN, HOME)?.rest === '');

  // Lo que no se come: la raiz de una unidad y la carpeta del usuario valen solo ellas.
  const drive = [at('D:\\', 'E:\\copia')];
  check('R9 el origen es una unidad: solo ella misma, no todo lo que hay en la unidad',
    resolveWin('D:\\', drive) === 'E:\\copia' && resolveWin('D:\\proyecto', drive) === null && resolveWin('D:\\a\\b', drive) === null);
  const home = [at(HOME, 'D:\\perfil')];
  check('R9 el origen es la carpeta del usuario: solo ella',
    resolveWin(HOME, home) === 'D:\\perfil' && resolveWin(`${HOME}\\proyecto`, home) === null);
  const unc = [at('\\\\srv\\share', 'D:\\copia')];
  check('R9 el origen es la raiz de un recurso de red: solo ella',
    resolveWin('\\\\srv\\share', unc) === 'D:\\copia' && resolveWin('\\\\srv\\share\\p', unc) === null);
  const uncProject = [at('\\\\srv\\share\\p', 'D:\\copia')];
  check('R9 pero un proyecto dentro del recurso de red si lleva sus subcarpetas', resolveWin('\\\\srv\\share\\p\\web', uncProject) === 'D:\\copia\\web');
  check('isBroadFolder: unidad, carpeta del usuario y recurso de red; no un proyecto',
    isBroadFolder('D:\\', WIN, HOME) && isBroadFolder('d:', WIN, HOME) && isBroadFolder('c:/users/YO/', WIN, HOME) &&
    isBroadFolder('\\\\srv\\share', WIN, HOME) && !isBroadFolder('D:\\MyProject', WIN, HOME) && !isBroadFolder('\\\\srv\\share\\p', WIN, HOME));

  // macOS y Linux: las mayusculas cuentan.
  const posix = [makeLocation('/home/yo/Proj', '/srv/Proj', 'linux', 1)];
  const resolvePosix = (cwd, list = posix) => resolveLocation(cwd, list, 'linux', '/home/yo')?.cwd ?? null;
  check('R10 en Linux las mayusculas cuentan: /home/yo/proj no es /home/yo/Proj',
    resolvePosix('/home/yo/Proj') === '/srv/Proj' && resolvePosix('/home/yo/proj') === null && resolvePosix('/home/yo/Proj/Web/src') === '/srv/Proj/Web/src');
  check('R10 la raiz y la carpeta del usuario valen solo ellas',
    resolvePosix('/x', [makeLocation('/', '/mnt/copia', 'linux', 1)]) === null && resolvePosix('/', [makeLocation('/', '/mnt/copia', 'linux', 1)]) === '/mnt/copia' &&
    resolvePosix('/home/yo/p', [makeLocation('/home/yo', '/srv/yo', 'linux', 1)]) === null &&
    resolvePosix('/home/yo', [makeLocation('/home/yo', '/srv/yo', 'linux', 1)]) === '/srv/yo');
  check('R10 la clave es la de normalizeCwdKey de esa plataforma',
    makeLocation('D:\\MyProject\\', 'D:\\A', WIN, 1).fromKey === shared.normalizeCwdKey('D:\\MyProject\\', WIN) &&
    makeLocation('/a//b/', '/c', 'linux', 1).fromKey === '/a/b');

  // relativeUnder, la pieza compartida.
  check('relativeUnder: igual, adentro, afuera, por segmento entero y con las mayusculas del original',
    shared.relativeUnder('D:\\X', 'd:\\x', WIN) === '' && shared.relativeUnder('D:\\X\\Web\\Src', 'd:\\x', WIN) === 'Web\\Src' &&
    shared.relativeUnder('D:\\X2', 'D:\\X', WIN) === null && shared.relativeUnder('D:\\', 'D:\\X', WIN) === null &&
    shared.relativeUnder('D:\\X\\a', 'D:\\', WIN) === 'X\\a' && shared.relativeUnder('/a/B/c', '/a', 'linux') === 'B/c' &&
    shared.relativeUnder('/a/b', '/A', 'linux') === null && shared.relativeUnder('', 'D:\\X', WIN) === null);
}

// ---------------------------------------------------------------------------
// S. El almacen
// ---------------------------------------------------------------------------

const storeFile = path.join(root, 'almacen', 'project-locations.json');
const noLog = { warn: () => undefined };
const newStore = (file = storeFile, extra = {}) => new ProjectLocationStore(file, { platform: WIN, homeDir: HOME, log: noLog, now: () => 1_000, ...extra });
const readJson = async (file = storeFile) => JSON.parse(await readFile(file, 'utf8'));
const exists = async (file) => readFile(file).then(() => true, () => false);

{
  check('S0 la ruta del archivo: project-locations.json en la carpeta de la app, aparte de settings.json',
    projectLocationsPath() === path.join(appConfigDir(), 'project-locations.json') && projectLocationsPath() !== path.join(appConfigDir(), 'settings.json'), projectLocationsPath());

  const first = newStore();
  await first.load();
  check('S1 sin archivo: vacio, y leer no crea nada', first.list().length === 0 && !(await exists(storeFile)) && !(await exists(path.dirname(storeFile))));

  const saved = [];
  const off = first.onChange(() => saved.push(first.list().length));
  await first.set([{ from: 'D:\\MyProject', to: 'D:\\AWB\\MyProject' }]);
  const onDisk = await readJson();
  check('S2 set guarda version 1, la clave normalizada y la ruta tal cual',
    onDisk.version === 1 && onDisk.locations.length === 1 && onDisk.locations[0].from === 'D:\\MyProject' && onDisk.locations[0].to === 'D:\\AWB\\MyProject' &&
    onDisk.locations[0].fromKey === 'd:\\myproject' && typeof onDisk.locations[0].createdAt === 'number', show(onDisk));
  check('S2 la resolucion del almacen usa lo guardado', first.resolve('D:\\MyProject\\web')?.cwd === 'D:\\AWB\\MyProject\\web');
  check('S2 avisa el cambio una vez', saved.length === 1 && saved[0] === 1, show(saved));

  const again = newStore();
  await again.load();
  check('S3 sobrevive a un reinicio', again.list().length === 1 && again.resolve('D:\\MyProject')?.cwd === 'D:\\AWB\\MyProject');
  check('S3 el archivo no lleva nada mas que ubicaciones: ni historial, ni titulos, ni ajustes',
    Object.keys(onDisk).sort().join(',') === 'locations,version' && Object.keys(onDisk.locations[0]).sort().join(',') === 'createdAt,from,fromKey,to');

  await first.set([{ from: 'd:/myproject/', to: 'E:\\Otro\\MyProject' }]);
  check('S4 la misma carpeta escrita de otra forma reemplaza, no suma',
    first.list().length === 1 && first.list()[0].to === 'E:\\Otro\\MyProject' && (await readJson()).locations.length === 1, show(first.list()));
  const notifiedBefore = saved.length;
  const bytesBefore = await readFile(storeFile, 'utf8');
  await first.set([{ from: 'D:\\MYPROJECT\\', to: 'e:/otro/myproject/' }]);
  check('S4 lo mismo de nuevo, escrito de otra forma, no es un cambio: ni se escribe ni se avisa',
    saved.length === notifiedBefore && (await readFile(storeFile, 'utf8')) === bytesBefore, show(saved));
  await first.set([{ from: 'D:\\Otra', to: 'D:\\AWB\\Otra' }, { from: 'D:\\Tercera', to: 'D:\\AWB\\Tercera' }]);
  check('S4 varias a la vez', first.list().length === 3);

  const gone = await first.remove([shared.normalizeCwdKey('D:\\Otra', WIN)]);
  check('S5 quitar saca solo esa y lo dice', gone === true && first.list().length === 2 && first.resolve('D:\\Otra') === null && first.resolve('D:\\Tercera') !== null);
  check('S5 quitar lo que no esta no cambia nada ni avisa', (await first.remove(['d:\\nada'])) === false && first.list().length === 2 && saved.length === 4, show(saved));
  off();
  await first.set([{ from: 'D:\\Cuarta', to: 'D:\\AWB\\Cuarta' }]);
  check('S5 un oyente suelto no vuelve a llamarse', saved.length === 4);
}

// Archivos que no se entienden.
{
  const file = path.join(root, 'raros', 'project-locations.json');
  await mkdir(path.dirname(file), { recursive: true });

  await writeFile(file, 'esto no es json', 'utf8');
  const broken = newStore(file);
  await broken.load();
  check('S6 un archivo ilegible vale como vacio, y leerlo no lo toca', broken.list().length === 0 && (await readFile(file, 'utf8')) === 'esto no es json');
  await broken.set([{ from: 'D:\\MyProject', to: 'D:\\AWB\\MyProject' }]);
  check('S6 guardar encima de uno ilegible si se puede: era basura', (await readJson(file)).locations.length === 1);

  const future = JSON.stringify({ version: 99, locations: [{ from: 'D:\\X', to: 'D:\\Y', fromKey: 'd:\\x', createdAt: 1, extra: 'de una version nueva' }] });
  await writeFile(file, future, 'utf8');
  const foreign = newStore(file);
  await foreign.load();
  check('S7 un archivo de otra version no se lee', foreign.list().length === 0);
  const refused = await foreign.set([{ from: 'D:\\MyProject', to: 'D:\\AWB\\MyProject' }]).then(() => null, (error) => error);
  check('S7 y guardar se rechaza con un aviso, sin tocar el archivo',
    refused instanceof ProjectLocationError && refused.text.key === 'locationsOtherVersion' && (await readFile(file, 'utf8')) === future, show(refused?.text));
  const refusedRemove = await foreign.remove(['d:\\x']).then(() => null, (error) => error);
  check('S7 quitar tambien', refusedRemove instanceof ProjectLocationError && (await readFile(file, 'utf8')) === future);
  check('S7 y el aviso no se pierde en la lista vacia', foreign.list().length === 0);

  await writeFile(file, JSON.stringify({
    version: 1,
    locations: [
      { from: 'D:\\Buena', to: 'D:\\AWB\\Buena', fromKey: 'x', createdAt: 5 },
      { from: 42, to: 'D:\\X' },
      { from: '', to: 'D:\\X' },
      { from: 'D:\\SinDestino' },
      { from: 'D:\\Relativa', to: 'carpeta\\relativa' },
      'texto',
      null,
    ],
  }), 'utf8');
  const messy = newStore(file);
  await messy.load();
  check('S8 las entradas que no sirven se descartan sin perder las buenas',
    messy.list().length === 1 && messy.list()[0].from === 'D:\\Buena', show(messy.list()));
  check('S8 la clave se rehace de la ruta: la del archivo pudo escribirla otra plataforma', messy.list()[0]?.fromKey === 'd:\\buena');

  const bad = await Promise.all([
    messy.set([{ from: 'D:\\X', to: 'relativa' }]).then(() => null, (error) => error),
    messy.set([{ from: '', to: 'D:\\Y' }]).then(() => null, (error) => error),
    messy.set([]).then(() => 'ok', (error) => error),
  ]);
  check('S9 un destino relativo o un origen vacio se rechazan; una lista vacia no hace nada',
    bad[0] instanceof ProjectLocationError && bad[1] instanceof ProjectLocationError && bad[2] === 'ok' && messy.list().length === 1, show(bad.map((b) => b?.text?.key ?? b)));
}

// Dos escrituras a la vez, y dos instancias.
{
  const file = path.join(root, 'carrera', 'project-locations.json');
  const one = newStore(file);
  await one.load();
  await Promise.all(Array.from({ length: 20 }, (_, n) => one.set([{ from: `D:\\P${n}`, to: `D:\\AWB\\P${n}` }])));
  check('S10 veinte cambios a la vez en la misma instancia: ninguno se pierde', one.list().length === 20 && (await readJson(file)).locations.length === 20, show(one.list().length));

  const a = newStore(file);
  const b = newStore(file);
  await a.load();
  await b.load();
  await a.set([{ from: 'D:\\DeA', to: 'D:\\AWB\\DeA' }]);
  await b.set([{ from: 'D:\\DeB', to: 'D:\\AWB\\DeB' }]);
  const merged = (await readJson(file)).locations.map((entry) => entry.from);
  check('S11 dos instancias: la segunda relee antes de escribir y no borra lo de la primera',
    merged.includes('D:\\DeA') && merged.includes('D:\\DeB') && merged.length === 22, show(merged.length));
  check('S11 y la que escribio queda al dia con el disco', b.list().length === 22);
  await a.remove([shared.normalizeCwdKey('D:\\DeB', WIN)]);
  check('S11 quitar tambien parte de lo que hay en el disco', (await readJson(file)).locations.length === 21 && a.list().length === 21);
}

// Una escritura que falla.
{
  const blocker = path.join(root, 'es-un-archivo');
  await writeFile(blocker, 'no soy una carpeta', 'utf8');
  const store = newStore(path.join(blocker, 'project-locations.json'));
  await store.load();
  const failed = await store.set([{ from: 'D:\\MyProject', to: 'D:\\AWB\\MyProject' }]).then(() => null, (error) => error);
  check('S12 si no se puede escribir: el cambio falla y lo anterior sigue', failed !== null && store.list().length === 0, String(failed?.message ?? failed));
  const leftovers = (await readdir(root)).filter((name) => name.endsWith('.tmp'));
  check('S12 sin temporales sueltos', leftovers.length === 0, show(leftovers));
  const fileAfter = path.join(root, 'sano', 'project-locations.json');
  const healthy = newStore(fileAfter);
  await healthy.load();
  await healthy.set([{ from: 'D:\\MyProject', to: 'D:\\AWB\\MyProject' }]);
  const tmp = (await readdir(path.dirname(fileAfter))).filter((name) => name.endsWith('.tmp'));
  check('S12 y escribiendo bien tampoco quedan temporales', tmp.length === 0 && (await exists(fileAfter)));
}

// ---------------------------------------------------------------------------
// V. El servicio: vista previa, guardar y quitar, sobre un indice de verdad
// ---------------------------------------------------------------------------

{
  const { ProjectLocationService } = await import('../src/project-location-service.ts');
  const { AgentRegistry } = await import('../src/agents/registry.ts');
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { sessionFilePath, sessionsRoot } = await import('../src/agents/claude-code/paths.ts');
  const { SessionIndex } = await import('../src/session-index.ts');

  const platform = process.platform;
  const keyOf = (folder) => shared.normalizeCwdKey(folder, platform);
  const line = (value) => JSON.stringify(value) + '\n';
  const userLine = (id, cwd) => line({ type: 'user', uuid: id, timestamp: new Date().toISOString(), cwd, message: { role: 'user', content: 'hola' } });
  const protectedDir = path.join(root, 'carpeta-de-una-cli');
  await mkdir(path.join(protectedDir, 'sub'), { recursive: true });

  const adapter = createClaudeCodeAdapter();
  const agents = new AgentRegistry([adapter]);
  let counter = 0;

  /** Un mundo: la carpeta vieja (no existe), la nueva (existe) y las sesiones de cada una. */
  async function world(name, { newHasWeb = true } = {}) {
    const base = path.join(root, 'servicio', name);
    const oldMain = path.join(base, 'viejo', 'Proyecto');
    const oldWeb = path.join(oldMain, 'web');
    const oldSibling = path.join(base, 'viejo', 'Proyecto2');
    const newMain = path.join(base, 'nuevo', 'Proyecto');
    const newWeb = path.join(newMain, 'web');
    await mkdir(newHasWeb ? newWeb : newMain, { recursive: true });
    counter += 1;
    const id = (n) => `57575757-${String(counter).padStart(4, '0')}-4000-8000-00000000000${n}`;
    const ids = { main: id(1), web: id(2), own: id(3), sibling: id(4) };
    for (const [sessionId, cwd] of [[ids.main, oldMain], [ids.web, oldWeb], [ids.own, newMain], [ids.sibling, oldSibling]]) {
      const file = sessionFilePath(cwd, sessionId);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, userLine(`u-${sessionId.slice(-12)}`, cwd));
    }
    // Una conversacion que no dice en que carpeta corrio: su proyecto no tiene carpeta.
    const noCwdFolder = path.join(sessionsRoot(), `carpeta-sin-cwd-${name}`);
    await mkdir(noCwdFolder, { recursive: true });
    await writeFile(path.join(noCwdFolder, `${id(5)}.jsonl`), line({ type: 'ai-title', aiTitle: 'Nadie sabe donde', sessionId: id(5) }));
    const store = new ProjectLocationStore(path.join(base, 'project-locations.json'), { log: noLog });
    await store.load();
    const index = new SessionIndex(agents, undefined, undefined, undefined, store);
    await index.scan();
    const tabs = [];
    const pending = new Set();
    const service = new ProjectLocationService({
      index,
      store,
      tabs: () => tabs,
      hasPending: (terminalId) => pending.has(terminalId),
      protectedDirs: () => [protectedDir],
      platform,
    });
    const project = (key) => index.getProjects().find((p) => p.key === key);
    const ids2 = (key) => (project(key)?.sessions.map((s) => s.sessionId) ?? []).sort().join();
    return { base, oldMain, oldWeb, oldSibling, newMain, newWeb, ids, store, index, tabs, pending, service, project, ids2 };
  }
  const failsWith = async (promise) => promise.then(() => null, (error) => (error instanceof ProjectLocationError ? error.text : `no es ProjectLocationError: ${error}`));
  const keyOfError = (text) => (typeof text === 'string' ? text : (text?.key ?? null));

  // --- V1. La vista previa cuenta y no escribe nada
  {
    const w = await world('v1');
    const keyOld = keyOf(w.oldMain);
    const preview = await w.service.preview(keyOld, w.newMain);
    check('V1 la vista previa dice las carpetas anteriores y la nueva',
      preview.projectKey === keyOld && preview.from.length === 1 && preview.from[0] === w.oldMain && preview.to === w.newMain, show(preview));
    check('V1 cuenta lo que se mueve: la carpeta y su subcarpeta; no D:\\Proyecto2 ni lo que ya esta en la nueva',
      preview.moving === 2 && preview.inSubfolders === 1, show(preview));
    check('V1 y lo que la carpeta nueva ya tiene, que quedara junto', preview.inDestination === 1, show(preview));
    check('V1 sin pestanas ni nada pendiente', preview.tabs === 0 && preview.pending === 0);
    check('V1 no escribe nada: ni el almacen, ni la barra', w.store.list().length === 0 && !(await exists(path.join(w.base, 'project-locations.json'))) && w.project(keyOld)?.relocations === undefined);
  }

  // --- V2. Guardar
  {
    const w = await world('v2');
    const keyOld = keyOf(w.oldMain);
    const keyNew = keyOf(w.newMain);
    const emitted = [];
    w.index.on('projects', (projects, replace) => { if (replace) emitted.push(projects); });
    await w.service.apply(keyOld, w.newMain);
    check('V2 guarda una ubicacion por la carpeta anterior, con la nueva tal cual',
      w.store.list().length === 1 && w.store.list()[0].from === w.oldMain && w.store.list()[0].to === w.newMain, show(w.store.list()));
    check('V2 la barra queda al dia y se emitio a todos',
      emitted.length === 1 && w.ids2(keyNew) === [w.ids.main, w.ids.own].sort().join() && w.project(keyOld) === undefined, `${emitted.length} emisiones`);
    check('V2 la subcarpeta con historial tambien se movio', w.ids2(keyOf(w.newWeb)) === w.ids.web);
    check('V2 lo que no es del proyecto sigue en su carpeta', w.ids2(keyOf(w.oldSibling)) === w.ids.sibling && w.project(keyOf(w.oldSibling))?.relocations === undefined);
    check('V2 el archivo sobrevive a un reinicio y resuelve igual',
      await (async () => { const again = new ProjectLocationStore(path.join(w.base, 'project-locations.json'), { log: noLog }); await again.load(); return again.resolve(w.oldWeb)?.cwd === w.newWeb; })());

    // Lo mismo otra vez: no hay nada que cambiar.
    const same = await failsWith(w.service.preview(keyNew, w.newMain));
    check('V2 volver a elegir la misma carpeta: ya esta ahi, no se cambia nada', keyOfError(same) === 'locationSameFolder', show(same));

    // Cambiar a otra carpeta: la ubicacion se actualiza, no se encadena otra.
    const other = path.join(w.base, 'otra', 'Proyecto');
    await mkdir(other, { recursive: true });
    const changePreview = await w.service.preview(keyNew, other);
    check('V2 cambiar de ubicacion parte de la carpeta anterior (no de la nueva) y cuenta lo que se mueve',
      changePreview.from.length === 1 && changePreview.from[0] === w.oldMain && changePreview.moving === 2, show(changePreview));
    await w.service.apply(keyNew, other);
    check('V2 reubicar reemplaza, no encadena: sigue habiendo una sola ubicacion, apuntando a la nueva',
      w.store.list().length === 1 && w.store.list()[0].to === other && w.store.list()[0].from === w.oldMain, show(w.store.list()));
    check('V2 y el historial sigue junto, ahora en la otra carpeta', w.ids2(keyOf(other)) === [w.ids.main].sort().join() && w.project(keyOf(other))?.cwdExists === true);
    check('V2 lo que ya estaba en la primera carpeta nueva se queda alli', w.ids2(keyNew) === w.ids.own);
  }

  // --- V3. Lo que se rechaza, sin dejar nada a medias
  {
    const w = await world('v3');
    const keyOld = keyOf(w.oldMain);
    const rejected = async (label, promise, expectedKey) => {
      const text = await failsWith(promise);
      check(`V3 ${label}: ${expectedKey}, y no se guardo nada`, keyOfError(text) === expectedKey && w.store.list().length === 0 && !(await exists(path.join(w.base, 'project-locations.json'))), show(text));
    };
    await rejected('un proyecto que no esta en la barra', w.service.preview('d:\\no-esta', w.newMain), 'locationProjectGone');
    const noFolderKey = 'unknown:claude-code:carpeta-sin-cwd-v3';
    check('V3 el fixture: el proyecto sin carpeta esta en la barra', w.project(noFolderKey)?.cwd === '');
    await rejected('un proyecto cuyas conversaciones no dicen la carpeta', w.service.preview(noFolderKey, w.newMain), 'locationNoFolder');
    await rejected('un destino que no existe', w.service.preview(keyOld, path.join(w.base, 'no-existe')), 'locationDestinationInvalid');
    const asFile = path.join(w.base, 'soy-un-archivo.txt');
    await writeFile(asFile, 'x', 'utf8');
    await rejected('un destino que es un archivo', w.service.preview(keyOld, asFile), 'locationDestinationInvalid');
    await rejected('un destino dentro de la carpeta de una CLI', w.service.preview(keyOld, path.join(protectedDir, 'sub')), 'locationDestinationProtected');
    await rejected('un destino que es la carpeta de una CLI misma', w.service.preview(keyOld, protectedDir), 'locationDestinationProtected');
    await rejected('un proyecto cuya carpeta existe', w.service.preview(keyOf(w.newMain), path.join(w.base, 'nuevo')), 'locationNothingToMove');
    await rejected('apply con un destino que no existe', w.service.apply(keyOld, path.join(w.base, 'no-existe')), 'locationDestinationInvalid');

    // La carpeta anterior vuelve a existir entre la vista previa y la confirmacion.
    await w.service.preview(keyOld, w.newMain);
    await mkdir(w.oldMain, { recursive: true });
    await rejected('la carpeta anterior volvio a existir antes de confirmar', w.service.apply(keyOld, w.newMain), 'locationOriginExists');
    await rm(w.oldMain, { recursive: true, force: true });
    await w.service.apply(keyOld, w.newMain);
    check('V3 y con la carpeta anterior ausente de nuevo, guarda', w.store.list().length === 1);
  }

  // --- V4. Pestanas y envios pendientes: no se mueve nada solo
  {
    const w = await world('v4');
    const keyOld = keyOf(w.oldMain);
    const untouched = async (label) => check(`V4 ${label}: no se guardo nada`, w.store.list().length === 0 && !(await exists(path.join(w.base, 'project-locations.json'))));
    w.tabs.push({ terminalId: 'dormida', cwd: w.oldMain }, { terminalId: 'en-subcarpeta', cwd: path.join(w.oldWeb, 'src') });
    w.tabs.push({ terminalId: 'hermana', cwd: w.oldSibling }, { terminalId: 'en-el-destino', cwd: w.newMain }, { terminalId: 'otra-cosa', cwd: path.join(w.base, 'otro-lado') });
    const preview = await w.service.preview(keyOld, w.newMain);
    check('V4 la vista previa cuenta las pestanas de la carpeta anterior y sus subcarpetas, no las de al lado ni las del destino',
      preview.tabs === 2 && preview.pending === 0, show(preview));
    const tabsOpen = await failsWith(w.service.apply(keyOld, w.newMain));
    check('V4 con pestanas abiertas no se guarda y se pide cerrarlas', keyOfError(tabsOpen) === 'locationTabsOpen' && tabsOpen.params?.count === 2, show(tabsOpen));
    await untouched('con pestanas');

    w.pending.add('dormida');
    const withPending = await w.service.preview(keyOld, w.newMain);
    check('V4 y cuenta las que tienen mensajes en cola o programados', withPending.tabs === 2 && withPending.pending === 1, show(withPending));
    const blocked = await failsWith(w.service.apply(keyOld, w.newMain));
    check('V4 con algo pendiente el aviso lo dice, y tampoco se guarda', keyOfError(blocked) === 'locationPendingMessages' && blocked.params?.count === 1, show(blocked));
    await untouched('con algo pendiente');

    w.tabs.splice(0, 2);
    w.pending.clear();
    const free = await w.service.preview(keyOld, w.newMain);
    check('V4 cerradas las dos, ya no hay nada que bloquee', free.tabs === 0 && free.pending === 0, show(free));
    await w.service.apply(keyOld, w.newMain);
    check('V4 y se guarda', w.store.list().length === 1);
  }

  // --- V5. Quitar, la carpeta vieja que vuelve, y el destino que desaparece
  {
    const w = await world('v5');
    const keyOld = keyOf(w.oldMain);
    const keyNew = keyOf(w.newMain);
    await w.service.apply(keyOld, w.newMain);

    const nothing = await failsWith(w.service.remove(keyOf(w.oldSibling)));
    check('V5 quitar de un proyecto que no se movio: no hay nada que quitar', keyOfError(nothing) === 'locationNotMoved', show(nothing));
    const unknown = await failsWith(w.service.remove('d:\\no-esta'));
    check('V5 quitar de un proyecto que no esta en la barra', keyOfError(unknown) === 'locationProjectGone', show(unknown));

    // La vieja vuelve: en pausa, y quitarla sigue siendo posible.
    await mkdir(w.oldMain, { recursive: true });
    await w.index.refreshLocations();
    check('V5 con la carpeta vieja otra vez en disco el proyecto de la vieja avisa que la ubicacion esta en pausa',
      w.project(keyOld)?.relocations?.[0]?.paused === true && w.ids2(keyOld) === w.ids.main);
    await w.service.remove(keyOld);
    check('V5 y se puede quitar desde ahi', w.store.list().length === 0 && w.project(keyOld)?.relocations === undefined);
    await rm(w.oldMain, { recursive: true, force: true });
    await w.index.refreshLocations();
    check('V5 quitada, cada sesion vuelve a su carpeta', w.ids2(keyOld) === w.ids.main && w.ids2(keyNew) === w.ids.own);

    // Otra vez a la nueva; luego la nueva desaparece y se vuelve a ubicar.
    await w.service.apply(keyOld, w.newMain);
    const gone = path.join(w.base, 'nuevo-que-desaparece');
    await mkdir(gone, { recursive: true });
    await w.service.apply(keyNew, gone);
    await rm(gone, { recursive: true, force: true });
    await w.index.refreshLocations();
    const keyGone = keyOf(gone);
    check('V5 con el destino desaparecido el proyecto sigue junto y tachado', w.project(keyGone)?.cwdExists === false && w.ids2(keyGone) === w.ids.main);
    const again = await w.service.preview(keyGone, w.newMain);
    check('V5 ubicarlo de nuevo parte de la carpeta anterior, no del destino que ya no esta', again.from.length === 1 && again.from[0] === w.oldMain, show(again));
    await w.service.apply(keyGone, w.newMain);
    check('V5 y la ubicacion se actualiza sin encadenarse: una sola, de la vieja a la nueva',
      w.store.list().length === 1 && w.store.list()[0].from === w.oldMain && w.store.list()[0].to === w.newMain, show(w.store.list()));

    await w.service.remove(keyNew);
    check('V5 quitar deja el historial donde estaba y no borra nada', w.store.list().length === 0 && w.ids2(keyOld) === w.ids.main && w.ids2(keyNew) === w.ids.own);
    const twice = await failsWith(w.service.remove(keyOld));
    check('V5 quitar dos veces: la segunda no encuentra nada', keyOfError(twice) === 'locationNotMoved', show(twice));
  }

  // --- V6. Una subcarpeta con su propia ubicacion
  {
    const w = await world('v6', { newHasWeb: false });
    const keyOld = keyOf(w.oldMain);
    const keyNewWeb = keyOf(w.newWeb);
    await w.service.apply(keyOld, w.newMain);
    check('V6 la subcarpeta fue con el proyecto, pero esa carpeta no existe en la nueva: queda tachada',
      w.project(keyNewWeb)?.cwdExists === false && w.ids2(keyNewWeb) === w.ids.web);
    const elsewhere = path.join(w.base, 'web-aparte');
    await mkdir(elsewhere, { recursive: true });
    const preview = await w.service.preview(keyNewWeb, elsewhere);
    check('V6 ubicar solo la subcarpeta parte de su propia carpeta anterior y cuenta solo sus conversaciones',
      preview.from.length === 1 && preview.from[0] === w.oldWeb && preview.moving === 1 && preview.inSubfolders === 0, show(preview));
    await w.service.apply(keyNewWeb, elsewhere);
    check('V6 queda una ubicacion mas especifica y la del proyecto sigue como estaba',
      w.store.list().length === 2 && w.store.resolve(w.oldWeb)?.cwd === elsewhere && w.store.resolve(w.oldMain)?.cwd === w.newMain);
    check('V6 cada una en su carpeta: el proyecto no pierde la suya', w.ids2(keyOf(elsewhere)) === w.ids.web && w.ids2(keyOf(w.newMain)) === [w.ids.main, w.ids.own].sort().join());
    // Quitarla de la subcarpeta quita la suya, y vuelve a regir la del proyecto.
    await w.service.remove(keyOf(elsewhere));
    check('V6 quitar la de la subcarpeta no toca la del proyecto', w.store.list().length === 1 && w.store.list()[0].from === w.oldMain);
  }

  // --- V7. Un archivo de ubicaciones de otra version: no se pisa
  {
    const w = await world('v7');
    const file = path.join(w.base, 'project-locations.json');
    const future = JSON.stringify({ version: 99, locations: [] });
    await writeFile(file, future, 'utf8');
    const refused = await failsWith(w.service.apply(keyOf(w.oldMain), w.newMain));
    check('V7 con un archivo de otra version guardar se rechaza con el aviso, y el archivo queda igual',
      keyOfError(refused) === 'locationsOtherVersion' && (await readFile(file, 'utf8')) === future, show(refused));
  }

  agents.disposeAll();
}

// ---------------------------------------------------------------------------
// W. La vista previa que espera, y el cableado del socket
// ---------------------------------------------------------------------------

{
  const { PendingLocationPreview } = await import('../src/project-location-service.ts');
  let n = 0;
  const slot = new PendingLocationPreview(() => `id-${++n}`);
  const first = slot.hold('proyecto-a', 'D:\\AWB\\A');
  check('W1 guardar da un id', first === 'id-1');
  check('W1 confirmar con ese id devuelve el proyecto y la carpeta', JSON.stringify(slot.take(first)) === JSON.stringify({ projectKey: 'proyecto-a', to: 'D:\\AWB\\A' }));
  check('W1 y se gasta: la segunda vez no hay nada', slot.take(first) === null);
  const second = slot.hold('proyecto-a', 'D:\\AWB\\A');
  const third = slot.hold('proyecto-b', 'D:\\AWB\\B');
  check('W2 una vista previa nueva reemplaza a la anterior: la vieja ya no vale', slot.take(second) === null);
  check('W2 un id que no es el de ahora no gasta el que espera', slot.take('otro-id') === null && slot.take('') === null);
  check('W2 el que espera sigue sirviendo', JSON.stringify(slot.take(third)) === JSON.stringify({ projectKey: 'proyecto-b', to: 'D:\\AWB\\B' }));
  check('W2 el id por defecto es unico', (() => { const real = new PendingLocationPreview(); return real.hold('a', 'b') !== real.hold('a', 'b'); })());

  // El socket: cada mensaje location.* cableado, con el selector de ese socket y sin rutas del cliente.
  const socketSource = await readFile(new URL('../src/terminal-socket.ts', import.meta.url), 'utf8');
  const code = socketSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const caseOf = (type) => {
    const start = code.indexOf(`case '${type}'`);
    if (start < 0) return '';
    const next = code.slice(start + 10).search(/\n {8}case '/);
    return code.slice(start, next < 0 ? undefined : start + 10 + next);
  };
  check('W3 el socket atiende los tres mensajes', ['location.preview', 'location.apply', 'location.remove'].every((type) => caseOf(type).length > 0));
  check('W3 la carpeta nueva sale del selector de este socket, nunca del mensaje',
    /pickers\.currentPath\(message\.pickerId\)/.test(caseOf('location.preview')) && !/message\.(to|cwd|path|folder)\b/.test(caseOf('location.preview') + caseOf('location.apply') + caseOf('location.remove')));
  check('W3 confirmar gasta la vista previa guardada', /pendingLocation\.take\(message\.previewId\)/.test(caseOf('location.apply')));
  check('W3 y los errores salen como location-failed con el requestId de quien pidio', /sendLocationError\(socket, error, requestId\)/.test(caseOf('location.preview')) &&
    /sendLocationError\(socket, error, requestId\)/.test(caseOf('location.remove')) && /'location-failed', error\.text, undefined, requestId/.test(code));
  check('W3 el servicio se arma con las pestanas de ahora y los envios pendientes de la cola y de los programados',
    /new ProjectLocationService\(\{[\s\S]*?tabs: \(\) => registry\.list\(\)[\s\S]*?conversations\.hasPending\(terminalId\)[\s\S]*?scheduler\.snapshot\(\)/.test(code));
  const indexSource = (await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  check('W4 el arranque carga el almacen antes del indice y se lo da al indice y al socket',
    /await projectLocations\.load\(\)/.test(indexSource) && /new SessionIndex\(agents, archived, catalog, worktreeLinks, projectLocations\)/.test(indexSource) &&
    /locations: projectLocations/.test(indexSource) && indexSource.indexOf('projectLocations.load()') < indexSource.indexOf('new SessionIndex('));
}

// ---------------------------------------------------------------------------
// X. La web: que la barra y App decidan con las funciones puras
// ---------------------------------------------------------------------------

{
  /*
    Lo que las funciones puras no ven: quien las llama. Expresiones exactas sobre
    el fuente, fragiles ante un refactor de esas lineas, como las de
    `check-vault.mjs` y `check-global-search.mjs`: es la unica forma de cubrirlo
    sin montar React.
  */
  const webSrc = new URL('../../web/src/', import.meta.url);
  const noComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sidebar = noComments(await readFile(new URL('Sidebar.tsx', webSrc), 'utf8'));
  const app = noComments(await readFile(new URL('App.tsx', webSrc), 'utf8'));
  const hook = noComments(await readFile(new URL('useProjectLocations.ts', webSrc), 'utf8'));
  const workspace = noComments(await readFile(new URL('useWorkspace.ts', webSrc), 'utf8'));
  const dialog = noComments(await readFile(new URL('ProjectLocationDialog.tsx', webSrc), 'utf8'));

  check('X1 la barra no retoma con un clic la fila de un proyecto movido, igual que la de una rama quitada',
    /const movedAway = session\.relocated === true;/.test(sidebar) &&
    /: canOpen && resumable && !branchGone && !movedAway;/.test(sidebar));
  check('X1 el ↪ de cada fila sale de rowContinuation, y se apaga si la carpeta del proyecto no esta',
    /const continuation = rowContinuation\(session\);/.test(sidebar) &&
    /continueTargets\(agents, session\.agent, session\.partial, continuation\.sameCliToo\)/.test(sidebar) &&
    /title=\{continuation\.title\}/.test(sidebar) && /blockedReason=\{rowContinueBlockedReason\(project\)\}/.test(sidebar));
  check('X2 "Ubicar carpeta…" solo con carpeta que ubicar y con manejador (una ventana remota no lo tiene)',
    /\{!project\.cwdExists && \([\s\S]*?onLocateProject !== null && project\.cwd\.length > 0 && \([\s\S]*?sidebar\.project\.locate/.test(sidebar));
  check('X2 la linea de la ubicacion anterior sale cuando el proyecto la trae, y cambiar solo con una ubicacion aplicada',
    /project\.relocations !== undefined && project\.relocations\.length > 0 && \(\s*<ProjectRelocationLine/.test(sidebar) &&
    /onChange !== null && active\.length > 0/.test(sidebar) && /onRemove !== null && \(/.test(sidebar));
  check('X3 App no le da los botones a un equipo remoto: cambian la configuracion del anfitrion',
    /onLocateProject=\{\s*remoteClient\s*\?\s*null/.test(app) && /onRemoveLocation=\{remoteClient \? null : locations\.remove\}/.test(app));
  check('X3 App abre el selector mientras se elige y el dialogo en los demas pasos',
    /locations\.step\.kind === 'choosing' && \(\s*<FolderPicker/.test(app) && /onChoose=\{\(pickerId\) => locations\.choose\(pickerId\)\}/.test(app) &&
    /locations\.step\.kind !== 'idle' && locations\.step\.kind !== 'choosing' && \(\s*<ProjectLocationDialog/.test(app));
  check('X4 el hook pide la vista previa con el selector y confirma con el id de la vista previa; ningun pedido lleva una ruta',
    /type: 'location\.preview', requestId, projectKey: current\.project\.key, pickerId/.test(hook) &&
    /type: 'location\.apply', requestId, previewId: current\.preview\.previewId/.test(hook) &&
    /type: 'location\.remove', requestId, projectKey: project\.key/.test(hook) &&
    !/connection\.send\(\{[^}]*\b(cwd|path|folder|to|from)\b/.test(hook));
  check('X4 lo que estaba en viaje se pierde con el socket, y la vista previa guardada tambien',
    /connection\.onReopen\(\(\) => \{[\s\S]*?inFlight\.current = null;[\s\S]*?current\.kind === 'ready' \? IDLE : current/.test(hook));
  check('X5 un location-failed no va al cartel general: lo dice el dialogo o el aviso de quitar',
    /if \(message\.code === 'location-failed'\) break;/.test(workspace) && /message\.code !== 'location-failed'/.test(hook));
  check('X6 confirmar se apaga con pestanas abiertas, y mientras guarda no se cierra con Escape',
    /const blocked = preview !== null && preview\.tabs > 0;/.test(dialog) && /disabled=\{blocked \|\| saving\}/.test(dialog) &&
    /if \(saving\) return;/.test(dialog));
}

await rm(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
