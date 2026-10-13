/**
 * Chequeo del visor de documentos de Archivos y Planes (Hito 40, §6.31).
 *
 *   npx tsx scripts/check-doc-viewer.mjs
 *
 * Lo que se rompe sin verse:
 *
 *  - **Las pestañas de documentos.** Abrir dos veces el mismo no lo duplica, el
 *    tope cierra el que hace mas que no se mira y nunca el que se acaba de
 *    abrir, cerrar el activo muestra el vecino, y cada pestana de proyecto
 *    tiene las suyas: ir a otro proyecto y volver no cierra nada.
 *  - **Lo guardado para F5** se lee con desconfianza: un valor roto o tocado no
 *    tira la pagina, y lo de una pestana que ya no esta se olvida.
 *  - **La busqueda**: sin distinguir mayusculas, sin cambiar el largo del texto
 *    (las posiciones se usan para marcar en la pagina) y a traves de los trozos
 *    en que el resaltador parte una linea.
 *  - **Un enlace de un .md** abre otro documento del proyecto, y nunca algo de
 *    afuera.
 *
 * Puro: no carga React, ni un navegador, ni el servidor.
 */

const tabs = await import('../../web/src/doc-tabs.ts');
const search = await import('../../web/src/doc-search.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);
const keys = (strip) => strip.docs.map((doc) => doc.key).join(',');

// --- 1. Las pestanas de una solapa --------------------------------------------
{
  const { EMPTY_STRIP, openDoc, closeDoc, selectDoc, showList, setDocMode, MAX_OPEN_DOCS } = tabs;
  let strip = openDoc(EMPTY_STRIP, { key: 'a.md', title: 'a.md' });
  strip = openDoc(strip, { key: 'b.md', title: 'b.md' });
  check('1.1 abrir agrega al final y lo muestra', keys(strip) === 'a.md,b.md' && strip.active === 'b.md');
  strip = openDoc(strip, { key: 'a.md', title: 'a.md' });
  check('1.2 abrir uno que ya esta no lo duplica: lo trae al frente', keys(strip) === 'a.md,b.md' && strip.active === 'a.md');
  check('1.3 la lista se ve sin cerrar nada', json(showList(strip)) === json({ ...strip, active: null }));
  const listed = showList(strip);
  check('1.4 elegir una pestana desde la lista la muestra', selectDoc(listed, 'b.md').active === 'b.md');
  check('1.5 elegir una que no esta no cambia nada', json(selectDoc(listed, 'zzz')) === json(listed));

  let three = openDoc(openDoc(openDoc(EMPTY_STRIP, { key: 'x', title: 'x' }), { key: 'y', title: 'y' }), { key: 'z', title: 'z' });
  three = selectDoc(three, 'y');
  const closedActive = closeDoc(three, 'y');
  check('1.6 cerrar la activa muestra la que queda en su lugar', keys(closedActive) === 'x,z' && closedActive.active === 'z');
  const closedLast = closeDoc(selectDoc(three, 'z'), 'z');
  check('1.7 cerrar la ultima, activa, muestra la anterior', closedLast.active === 'y');
  const closedOther = closeDoc(three, 'x');
  check('1.8 cerrar otra no cambia la que se ve', closedOther.active === 'y' && keys(closedOther) === 'y,z');
  const closedAll = closeDoc(closeDoc(closeDoc(three, 'x'), 'y'), 'z');
  check('1.9 sin documentos, se ve la lista', closedAll.docs.length === 0 && closedAll.active === null);

  let full = EMPTY_STRIP;
  for (let index = 1; index <= MAX_OPEN_DOCS; index++) full = openDoc(full, { key: `d${index}`, title: `d${index}` });
  full = selectDoc(full, 'd1');
  full = openDoc(full, { key: 'nuevo', title: 'nuevo' });
  check(`1.10 pasado el tope (${MAX_OPEN_DOCS}) se cierra el que hace mas que no se mira, no el primero`,
    full.docs.length === MAX_OPEN_DOCS && !keys(full).split(',').includes('d2') && keys(full).includes('d1') && full.active === 'nuevo',
    keys(full));
  check('1.11 el modo de un .md se guarda en su pestana', setDocMode(full, 'nuevo', 'source').docs.find((doc) => doc.key === 'nuevo')?.mode === 'source');
}

// --- 2. Cada pestana de proyecto tiene las suyas ----------------------------------
{
  const { EMPTY_DOC_TABS, stripOf, withStrip, openDoc, pruneTerminals } = tabs;
  let state = withStrip(EMPTY_DOC_TABS, 't1', 'file', openDoc(stripOf(EMPTY_DOC_TABS, 't1', 'file'), { key: 'src/a.ts', title: 'a.ts' }));
  state = withStrip(state, 't1', 'plan', openDoc(stripOf(state, 't1', 'plan'), { key: 'cli:plan.md', title: 'plan' }));
  state = withStrip(state, 't2', 'file', openDoc(stripOf(state, 't2', 'file'), { key: 'README.md', title: 'README.md' }));
  check('2.1 los archivos y los planes de una pestana van por separado',
    keys(stripOf(state, 't1', 'file')) === 'src/a.ts' && keys(stripOf(state, 't1', 'plan')) === 'cli:plan.md');
  check('2.2 otra pestana de proyecto tiene los suyos, y no toca los de la primera',
    keys(stripOf(state, 't2', 'file')) === 'README.md' && keys(stripOf(state, 't1', 'file')) === 'src/a.ts');
  check('2.3 una pestana sin nada abierto da una tira vacia', stripOf(state, 't9', 'file').docs.length === 0);
  const pruned = pruneTerminals(state, ['t2']);
  check('2.4 lo de una pestana cerrada se olvida', stripOf(pruned, 't1', 'file').docs.length === 0 && keys(stripOf(pruned, 't2', 'file')) === 'README.md');
  check('2.5 sin pestanas en la lista no se olvida nada (todavia no llego)', json(pruneTerminals(state, [])) === json(state));
}

// --- 2b. Lo que sigue abierto, para soltar el contenido de lo que no --------------
{
  const { EMPTY_DOC_TABS, stripOf, withStrip, openDoc, liveDocIds, docId, MAX_OPEN_DOCS } = tabs;
  let strip = stripOf(EMPTY_DOC_TABS, 't1', 'file');
  for (let index = 0; index <= MAX_OPEN_DOCS; index++) strip = openDoc(strip, { key: `f${index}`, title: `f${index}` });
  const state = withStrip(withStrip(EMPTY_DOC_TABS, 't1', 'file', strip), 't1', 'plan', openDoc(stripOf(EMPTY_DOC_TABS, 't1', 'plan'), { key: 'cli:p.md', title: 'p' }));
  const live = liveDocIds(state);
  check('2.6 lo que el tope cerro ya no esta entre lo abierto: su contenido se suelta',
    !live.has(docId('t1', 'file', 'f0')) && live.has(docId('t1', 'file', `f${MAX_OPEN_DOCS}`)) && live.has(docId('t1', 'plan', 'cli:p.md')) &&
      live.size === MAX_OPEN_DOCS + 1);
}

// --- 3. Lo guardado para F5 -------------------------------------------------------
{
  const { EMPTY_DOC_TABS, stripOf, withStrip, openDoc, serializeDocTabs, parseDocTabs, MAX_OPEN_DOCS } = tabs;
  const state = withStrip(EMPTY_DOC_TABS, 't1', 'file', openDoc(stripOf(EMPTY_DOC_TABS, 't1', 'file'), { key: 'docs/x.md', title: 'x.md' }));
  const back = parseDocTabs(serializeDocTabs(state));
  check('3.1 ida y vuelta', json(stripOf(back, 't1', 'file')) === json(stripOf(state, 't1', 'file')));
  check('3.2 un valor roto se lee como vacio', json(parseDocTabs('{no es json')) === json(EMPTY_DOC_TABS) && json(parseDocTabs('[1,2]')) === json(EMPTY_DOC_TABS));
  const tampered = parseDocTabs(JSON.stringify({
    t1: { file: { docs: [{ key: 'ok.md', title: 'ok' }, { key: '', title: 'vacia' }, { key: 5, title: 'numero' }, 'basura'], active: 'no-esta' }, plan: 'x' },
    t2: null,
  }));
  check('3.3 lo que no tiene forma se descarta sin llevarse lo demas',
    keys(stripOf(tampered, 't1', 'file')) === 'ok.md' && stripOf(tampered, 't1', 'file').active === null && stripOf(tampered, 't1', 'plan').docs.length === 0,
    json(tampered));
  const many = { t1: { file: { docs: Array.from({ length: 30 }, (_, index) => ({ key: `f${index}`, title: `f${index}` })), active: null } } };
  check(`3.4 nunca mas de ${MAX_OPEN_DOCS} por tira, aunque el guardado traiga mas`, stripOf(parseDocTabs(JSON.stringify(many)), 't1', 'file').docs.length === MAX_OPEN_DOCS);
  const longKey = { t1: { file: { docs: [{ key: 'x'.repeat(5_000), title: 'larga' }], active: null } } };
  check('3.5 una ruta absurda no se lee', stripOf(parseDocTabs(JSON.stringify(longKey)), 't1', 'file').docs.length === 0);
}

// --- 4. La busqueda en el documento -----------------------------------------------
{
  const { foldForSearch, findMatches, locateOffset, stepIndex } = search;
  check('4.1 sin distinguir mayusculas', json(findMatches('Hola hola HOLA', 'hola')) === json([0, 5, 10]));
  check('4.2 sin solaparse', json(findMatches('aaaa', 'aa')) === json([0, 2]));
  check('4.3 sin aguja no hay coincidencias', findMatches('texto', '').length === 0);
  const tricky = 'İstanbul ß ǅ';
  check('4.4 doblar no cambia el largo (las posiciones marcan en la pagina)', foldForSearch(tricky).length === tricky.length);
  // "const foo" partido por el resaltador en tres nodos: "const", " ", "foo = 1"
  const nodes = ['const', ' ', 'foo = 1'];
  const ends = [];
  let total = 0;
  for (const node of nodes) ends.push((total += node.length));
  const [start] = findMatches(nodes.join(''), 'const foo');
  check('4.5 una coincidencia que cruza trozos empieza en el primero',
    json(locateOffset(ends, start, 'start')) === json({ node: 0, offset: 0 }));
  check('4.6 y termina en el ultimo', json(locateOffset(ends, start + 'const foo'.length, 'end')) === json({ node: 2, offset: 3 }));
  check('4.7 un final justo en el borde de un trozo queda en ese trozo, no en el siguiente',
    json(locateOffset(ends, 5, 'end')) === json({ node: 0, offset: 5 }) && json(locateOffset(ends, 5, 'start')) === json({ node: 1, offset: 0 }));
  check('4.8 Enter y Mayus+Enter dan la vuelta', stepIndex(2, 3, 1) === 0 && stepIndex(0, 3, -1) === 2 && stepIndex(0, 0, 1) === 0);
}

// --- 5. Los enlaces de un .md -------------------------------------------------------
{
  const { resolveDocLink, isMarkdownPath } = search;
  check('5.1 relativo a la carpeta del documento', resolveDocLink('docs/plan.md', 'ref-x.md') === 'docs/ref-x.md');
  check('5.2 con ./ y ../ dentro del proyecto', resolveDocLink('docs/a/plan.md', './b.md') === 'docs/a/b.md' && resolveDocLink('docs/plan.md', '../README.md') === 'README.md');
  check('5.3 sin el ancla ni la consulta', resolveDocLink('plan.md', 'otro.md#seccion') === 'otro.md' && resolveDocLink('plan.md', 'otro.md?x=1') === 'otro.md');
  check('5.4 nada que salga del proyecto, ni absoluto, ni una direccion, ni un ancla sola',
    resolveDocLink('plan.md', '../afuera.md') === null && resolveDocLink('docs/plan.md', '../../afuera.md') === null &&
      resolveDocLink('plan.md', '/etc/passwd') === null && resolveDocLink('plan.md', 'C:/x.md') === null &&
      resolveDocLink('plan.md', '\\\\server\\share\\x.md') === null && resolveDocLink('plan.md', 'https://example.com/x.md') === null &&
      resolveDocLink('plan.md', 'mailto:alguien') === null && resolveDocLink('plan.md', '#arriba') === null);
  check('5.5 los espacios codificados se leen', resolveDocLink('plan.md', 'mi%20nota.md') === 'mi nota.md');
  check('5.7 lo codificado se mira despues de decodificar: ni una unidad, ni una raiz, ni subir afuera',
    resolveDocLink('README.md', 'C%3A/Windows/win.ini') === null && resolveDocLink('x.md', '%2Fetc%2Fpasswd') === null &&
      resolveDocLink('docs/a.md', '..%2F..%2Fafuera.md') === null && resolveDocLink('a.md', 'b%5C..%5C..%5Cafuera.md') === null);
  check('5.8 ningun tramo con dos puntos (una unidad o un flujo alterno de Windows)',
    resolveDocLink('a.md', 'notas.md:oculto') === null && resolveDocLink('a.md', 'sub/C:x.md') === null);
  check('5.6 que es Markdown: por la extension', isMarkdownPath('docs/x.md') && isMarkdownPath('X.MARKDOWN') && !isMarkdownPath('x.mdx.ts') && !isMarkdownPath('md'));
}

// --- 6. Las rutas que nombra el hilo (§6.33, 13-10-2026) -----------------------------
//
// El agente nombra un archivo del proyecto y un clic lo abre en Archivos. Lo
// que se rompe sin verse: que el cliente le pregunte al servidor por algo de
// afuera del proyecto, que cada palabra entre acentos graves sea un pedido, o
// que una ruta que el servidor no confirmo se vuelva enlace.
{
  const paths = await import('../../web/src/project-paths.ts');
  const shared = await import('@agent-workbench/shared');
  const { readFileSync } = await import('node:fs');
  const win = { cwd: 'D:\\Mi Proyecto', platform: 'win32' };
  const posix = { cwd: '/home/ana/proyecto', platform: 'linux' };
  const of = (mention, root = win) => paths.projectPathOf(mention, root);

  check('6.1 una relativa, con cualquiera de las dos barras y sin el ./ de adelante',
    of('apps/mobile/store/listing.md') === 'apps/mobile/store/listing.md' && of('src\\app\\main.ts') === 'src/app/main.ts' &&
      of('./docs/guia.md') === 'docs/guia.md');
  check('6.2 sin la linea ni el ancla: src/app.ts:12, :12:5, :12-20 y #L12',
    of('src/app.ts:12') === 'src/app.ts' && of('src/app.ts:12:5') === 'src/app.ts' && of('src/app.ts:12-20') === 'src/app.ts' &&
      of('src/app.ts#L12-L20') === 'src/app.ts');
  check('6.3 entre comillas, como la deja el boton del arbol, y con el @ de una mencion',
    of('"D:\\Mi Proyecto\\docs\\guia.md"') === 'docs/guia.md' && of('@src/app.ts') === 'src/app.ts');
  check('6.4 una absoluta vale solo si cae dentro del proyecto; en Windows, sin distinguir mayusculas',
    of('D:\\Mi Proyecto\\docs\\guia.md') === 'docs/guia.md' && of('d:/mi proyecto/docs/guia.md') === 'docs/guia.md' &&
      of('D:\\Otro\\docs\\guia.md') === null && of('C:\\Windows\\win.ini') === null && of('\\\\servidor\\share\\x.md') === null &&
      of('D:\\Mi Proyecto Dos\\x.md') === null && of('D:\\Mi Proyecto') === null);
  check('6.5 fuera de Windows: una absoluta de adentro vale, distinguiendo mayusculas; una con unidad, no',
    of('/home/ana/proyecto/src/a.ts', posix) === 'src/a.ts' && of('/home/ana/Proyecto/src/a.ts', posix) === null &&
      of('/etc/passwd', posix) === null && of('C:/x/a.ts', posix) === null);
  check('6.6 en Windows, una que empieza con / no se adivina', of('/d/Mi Proyecto/src/a.ts') === null && of('/src/a.ts') === null);
  check('6.7 nada que salga con .., ni el home, ni una direccion, ni un patron, ni una opcion',
    of('../afuera/x.md') === null && of('docs/../../x.md') === null && of('~/notas/x.md') === null &&
      of('https://example.com/a/b.md') === null && of('src/**/*.ts') === null && of('--force/x.md') === null &&
      of('a.md\nb.md') === null && of('sub/C:x.md') === null);
  check('6.8 un .. que se queda adentro se resuelve', of('docs/a/../guia.md') === 'docs/guia.md');
  check('6.9 una palabra sola sin extension no se pregunta; un archivo de la raiz, si',
    of('main') === null && of('README') === null && of('npm run build') === null && of('localhost:3000') === null &&
      of('README.md') === 'README.md' && of('.gitignore') === '.gitignore' && of('package.json:5') === 'package.json');
  check('6.10 vacia, o mas larga de lo que el servidor acepta, no', of('') === null && of('   ') === null &&
    of(`src/${'x'.repeat(shared.FILES_CHECK_MAX_PATH_CHARS)}.ts`) === null);

  const link = (href, root = win) => paths.projectLinkPathOf(href, root);
  check('6.11 el destino de un enlace: sin ancla ni consulta, y decodificado',
    link('docs/mi%20guia.md#pasos') === 'docs/mi guia.md' && link('docs/guia.md?x=1') === 'docs/guia.md');
  check('6.12 un enlace con esquema, una unidad codificada o un ancla sola no son del proyecto',
    link('mailto:alguien') === null && link('file:///etc/passwd') === null && link('C%3A/Windows/win.ini') === null &&
      link('#arriba') === null && link('..%2F..%2Fafuera.md') === null && link('%E0%A4%A') === null);

  const text = [
    'Los pasos estan en `docs/guia.md` y en [la lista](apps/mobile/notes.md#L3).',
    'Corre `pnpm build`, mira `src/app.ts:12` y otra vez `docs/guia.md`.',
    'Texto suelto con barras, src/suelto.ts, no cuenta. Tampoco https://example.com/x.md',
    '```',
    'npm run dev',
    '```',
  ].join('\n');
  check('6.13 los candidatos de un texto: lo que va entre acentos graves y los enlaces, sin repetir',
    json(paths.pathCandidates(text, win)) === json(['docs/guia.md', 'src/app.ts', 'apps/mobile/notes.md']), json(paths.pathCandidates(text, win)));

  const known = new Map([['docs/guia.md', true], ['docs/plan.md', false]]);
  check('6.14 se pregunta lo que no se conoce y lo que antes no estaba; lo que ya esta, o va en camino, no',
    json(paths.pathsToCheck(['docs/guia.md', 'docs/plan.md', 'src/a.ts', 'src/b.ts'], known, new Set(['src/b.ts']))) === json(['docs/plan.md', 'src/a.ts']));
  const after = paths.withChecked(known, ['docs/plan.md', 'src/a.ts'], ['docs/plan.md']);
  check('6.15 la respuesta dice de cada ruta pedida si esta: lo que no volvio, no esta',
    after.get('docs/plan.md') === true && after.get('src/a.ts') === false && after.get('docs/guia.md') === true && known.get('docs/plan.md') === false);

  // El protocolo.
  const many = Array.from({ length: shared.FILES_CHECK_MAX_PATHS + 20 }, (_, index) => `src/f${index}.ts`);
  const parsed = shared.parseClientMessage(json({ type: 'files.check', terminalId: 't1', requestId: 'r1', paths: ['a.md', 7, '', 'x'.repeat(shared.FILES_CHECK_MAX_PATH_CHARS + 1), 'b.md'] }));
  check('6.16 files.check: lo que no tiene forma se descarta solo, sin invalidar el pedido',
    json(parsed) === json({ type: 'files.check', terminalId: 't1', requestId: 'r1', paths: ['a.md', 'b.md'] }), json(parsed));
  check('6.17 y pasado el tope, el resto tampoco',
    shared.parseClientMessage(json({ type: 'files.check', terminalId: 't1', requestId: 'r1', paths: many })).paths.length === shared.FILES_CHECK_MAX_PATHS);
  check('6.18 sin pestana, sin eco o sin lista, no es un pedido',
    shared.parseClientMessage(json({ type: 'files.check', requestId: 'r', paths: [] })) === null &&
      shared.parseClientMessage(json({ type: 'files.check', terminalId: 't', paths: [] })) === null &&
      shared.parseClientMessage(json({ type: 'files.check', terminalId: 't', requestId: 'r' })) === null);
  check('6.19 files.checked se lee con su eco',
    json(shared.parseServerMessage(json({ type: 'files.checked', terminalId: 't1', requestId: 'r1', existing: ['a.md'] }))) ===
      json({ type: 'files.checked', terminalId: 't1', requestId: 'r1', existing: ['a.md'] }) &&
      shared.parseServerMessage(json({ type: 'files.checked', terminalId: 't1', existing: [] })) === null);
  const hello = (extra) => shared.parseServerMessage(json({ type: 'hello', protocolVersion: shared.PROTOCOL_VERSION, agents: [], defaultAgent: null, platform: 'win32', defaultCwd: 'D:\\x', shellName: null, ...extra }));
  check('6.20 un servidor anterior no dice fileCheck, y la pagina no pregunta', hello({}).fileCheck === false && hello({ fileCheck: true }).fileCheck === true);

  // El cableado, leido como texto.
  const hook = readFileSync(new URL('../../web/src/useFileLinks.ts', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../../web/src/ConversationView.tsx', import.meta.url), 'utf8');
  const socket = readFileSync(new URL('../src/terminal-socket.ts', import.meta.url), 'utf8');
  check('6.21 solo es enlace lo que el servidor confirmo, y solo se pregunta con el servidor que contesta',
    hook.includes('known?.get(path) === true') && /if \(!enabled \|\| terminalId === null \|\| cwd\.length === 0\) return;/.test(hook));
  check('6.22 solo el texto del agente: lo del usuario se muestra tal cual',
    hook.includes("if (event.role !== 'assistant') continue;") && /<Markdown text=\{part\.text\} needle=\{needle\} codeLink=\{fileLinks\?\.code\} localLink=\{fileLinks\?\.link\} \/>/.test(view));
  check('6.23 el servidor anuncia que contesta, y contesta por el guardia de rutas',
    socket.includes('fileCheck: true,') && socket.includes('await existingFiles(cwd, message.paths)'));
}

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
