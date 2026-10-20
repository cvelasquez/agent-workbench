/**
 * Chequeo de las ramas aparte (hito 48, §6.38).
 *
 *   npx tsx scripts/check-worktrees.mjs
 *
 * Es lo primero de la app que escribe en git, y todo lo que puede salir mal
 * sale mal en silencio: una nota ignorada que se borra al quitar la rama, una
 * carpeta que otro programa tiene abierta y deja a git a medias, un enlace de
 * pnpm que se sigue hacia afuera, un `CLAUDE.md` que no llega a la rama, la
 * configuración de una CLI copiada con sus claves, un comando de git que
 * escribe fuera del único archivo que puede.
 *
 * Trabaja sobre repos temporales propios, con git aislado (sin configuración
 * global ni de sistema, y sin subir a buscar un repo de afuera), y la carpeta
 * de la app en una temporal. No toca ningún repositorio real.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' (' + extra + ')' : ''}`);
  if (!ok) failures++;
};

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-worktrees-'));
// git aislado: sin configuración global ni de sistema, y sin subir a buscar un repo de afuera.
const gitConfig = path.join(root, 'gitconfig');
await writeFile(gitConfig, '');
process.env.GIT_CONFIG_GLOBAL = gitConfig;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CEILING_DIRECTORIES = root;
process.env.GIT_AUTHOR_NAME = 'Prueba';
process.env.GIT_AUTHOR_EMAIL = 'prueba@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Prueba';
process.env.GIT_COMMITTER_EMAIL = 'prueba@example.invalid';
// La carpeta de la app y el home, propios, antes de importar nada.
process.env.APPDATA = path.join(root, 'appdata');
process.env.XDG_CONFIG_HOME = path.join(root, 'xdg');
process.env.HOME = path.join(root, 'home');
process.env.USERPROFILE = path.join(root, 'home');

const shared = await import('@agent-workbench/shared');
const { worktreeFolderFor, mainRootFromShape } = await import('../src/worktrees/names.ts');
const { readCheckout, branchFromHead, mainCwdFor } = await import('../src/worktrees/checkout.ts');
const wtGit = await import('../src/worktrees/git.ts');
const include = await import('../src/worktrees/include.ts');
const { WorktreeStore, parseWorktreesState } = await import('../src/worktrees/store.ts');
const { WorktreeLinks } = await import('../src/worktrees/links.ts');
const { WorktreeService, WorktreeError, folderInUse, notesConflictPrompt } = await import('../src/worktrees/service.ts');
const { buildProjects } = await import('../src/session-index.ts');
const { setLocale } = await import('../../web/src/i18n/index.ts');
const ui = await import('../../web/src/worktree-ui.ts');
await setLocale('es');

const windows = process.platform === 'win32';
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
const children = [];
process.on('exit', () => {
  for (const child of children) child.kill();
});

// ---------------------------------------------------------------------------
// N. El nombre de la rama y su carpeta (puro)
// ---------------------------------------------------------------------------

{
  const ok = ['hito-48', 'feat/login', 'a.b', 'Release_1.2', 'x'];
  const bad = {
    '': 'empty',
    '-x': 'starts-with-dash',
    'a..b': 'dots',
    'a b': 'characters',
    'ñandú': 'characters',
    'a.lock': 'lock',
    'a/b.lock/c': 'lock',
    '/a': 'slashes',
    'a/': 'slashes',
    'a//b': 'slashes',
    '.a': 'dots',
    'a/.b': 'dots',
    'a.': 'dots',
    con: 'reserved',
    'NUL.txt': 'reserved',
    'x/aux': null,
    HEAD: 'reserved',
    [`${'a'.repeat(101)}`]: 'too-long',
  };
  check('N1 nombres que sirven', ok.every((name) => shared.branchNameProblem(name) === null));
  const wrong = Object.entries(bad).filter(([name, problem]) => shared.branchNameProblem(name) !== problem);
  check('N2 cada nombre malo dice qué tiene', wrong.length === 0, wrong.map(([name]) => JSON.stringify(name)).join(' '));
  check('N3 la / de una rama pasa a - en su carpeta', shared.worktreeFolderName('feat/login/v2') === 'feat-login-v2');
  check('N4 la carpeta va al lado del proyecto, en <proyecto>.worktrees',
    worktreeFolderFor('D:\\Mi App', 'feat/login', path.win32) === 'D:\\Mi App.worktrees\\feat-login' &&
      worktreeFolderFor('/home/u/app', 'x', path.posix) === '/home/u/app.worktrees/x');
  check('N5 se reconoce la principal por la forma de la ruta',
    mainRootFromShape('D:\\Mi App.worktrees\\feat-login', path.win32) === 'D:\\Mi App' &&
      mainRootFromShape('/r/app/.claude/worktrees/x', path.posix) === '/r/app' &&
      mainRootFromShape('/r/app/otra', path.posix) === null &&
      mainRootFromShape('/r/.worktrees/x', path.posix) === null);
  check('N6 HEAD a rama', branchFromHead('ref: refs/heads/feat/x\n') === 'feat/x' && branchFromHead('0123abcd\n') === null);
}

// ---------------------------------------------------------------------------
// R. Un repo de prueba
// ---------------------------------------------------------------------------

async function makeRepo(name) {
  const repo = path.join(root, name);
  await mkdir(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  await writeFile(path.join(repo, 'README.md'), '# prueba\n');
  await writeFile(
    path.join(repo, '.gitignore'),
    ['CLAUDE.md', 'CHECKLIST.md', 'docs/', 'node_modules/', '.claude/', '.mcp.json', 'big/', 'linked/', 'suelto.txt', ''].join('\n'),
  );
  await writeFile(path.join(repo, '.worktreeinclude'), ['CHECKLIST.md', 'docs/', '.claude/', '.mcp.json', 'linked/', ''].join('\n'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'inicio');
  await writeFile(path.join(repo, 'CLAUDE.md'), '# Notas\nuna regla\n');
  await writeFile(path.join(repo, 'CHECKLIST.md'), '- [ ] uno\n- [ ] dos\n');
  await mkdir(path.join(repo, 'docs'), { recursive: true });
  await writeFile(path.join(repo, 'docs', 'a.md'), 'a\n');
  await mkdir(path.join(repo, '.claude'), { recursive: true });
  await writeFile(path.join(repo, '.claude', 'settings.local.json'), '{"env":{"CLAVE":"secreta"}}');
  await writeFile(path.join(repo, '.mcp.json'), '{"secreto":true}');
  return repo;
}

/** Un registro de pestañas de mentira: lo que el servicio abre, sin pty. */
function fakeRegistry() {
  const tabs = [];
  return {
    tabs,
    opened: [],
    async open(options) {
      const descriptor = {
        terminalId: `t${tabs.length + 1}`,
        kind: options.kind ?? 'agent',
        agent: options.agent ?? 'claude-code',
        cwd: options.cwd,
        sessionId: options.resumeSessionId ?? 's',
        label: '',
        resumed: options.resumeSessionId !== undefined,
        createdAt: 0,
        alive: false,
        exitCode: null,
        sleeping: true,
        launchedAt: null,
        worktree: null,
      };
      tabs.push(descriptor);
      this.opened.push(options);
      return descriptor;
    },
    list() {
      return [...tabs];
    },
    get(terminalId) {
      return tabs.find((tab) => tab.terminalId === terminalId) ?? null;
    },
  };
}

const repo = await makeRepo('proyecto');
const outside = path.join(root, 'afuera');
await mkdir(outside, { recursive: true });
await writeFile(path.join(outside, 'testigo.txt'), 'no me borres\n');
// Un enlace hacia afuera que el `.worktreeinclude` nombra: no se sigue ni se copia.
await symlink(outside, path.join(repo, 'linked'), 'junction');

const store = new WorktreeStore(path.join(root, 'appdata', 'worktrees.json'));
await store.load();
const registry = fakeRegistry();
const sessions = new Map();
const service = new WorktreeService({
  store,
  registry,
  projectCwd: (key) => (key === 'proyecto' ? repo : null),
  findSession: (agent, sessionId) => sessions.get(`${agent}:${sessionId}`) ?? null,
});
const mainTab = await registry.open({ cwd: repo });

// ---------------------------------------------------------------------------
// I. Mirar antes de crear, y lo que se copia
// ---------------------------------------------------------------------------

{
  const inspection = await service.inspect({ kind: 'project', projectKey: 'proyecto' });
  check('I1 la principal y su rama', inspection.mainRoot === path.resolve(repo) && inspection.currentBranch === 'main');
  check('I2 la carpeta de las ramas va al lado', inspection.parentDir === `${path.resolve(repo)}.worktrees`);
  check('I3 la principal sin cambios', inspection.mainChanges === 0, String(inspection.mainChanges));
  const includeFiles = inspection.include?.sample ?? [];
  check('I4 el .worktreeinclude copia lo ignorado que nombra', includeFiles.includes('CHECKLIST.md') && includeFiles.includes('docs/a.md'), includeFiles.join(' '));
  check('I5 nunca la configuración de una CLI, aunque el archivo la pida',
    !includeFiles.some((file) => file.startsWith('.claude') || file === '.mcp.json'), includeFiles.join(' '));
  check('I6 un enlace hacia afuera no se copia', !includeFiles.some((file) => file.startsWith('linked')), includeFiles.join(' '));
  check('I7 las instrucciones ignoradas van aparte, y lo del .worktreeinclude no se cuenta dos veces',
    JSON.stringify(inspection.notes.sample) === JSON.stringify(['CLAUDE.md']), inspection.notes.sample.join(' '));
  let rejected = null;
  try {
    await service.inspect({ kind: 'project', projectKey: 'otro' });
  } catch (error) {
    rejected = error;
  }
  check('I8 un proyecto que la barra no tiene se rechaza', rejected instanceof WorktreeError);
}

{
  // El tope: un `node_modules` por un error en el archivo no entra.
  const big = await makeRepo('grande');
  await writeFile(path.join(big, '.worktreeinclude'), 'big/\n');
  git(big, 'add', '.worktreeinclude');
  git(big, 'commit', '-q', '-m', 'tope');
  await mkdir(path.join(big, 'big'), { recursive: true });
  await Promise.all(
    Array.from({ length: shared.WORKTREE_COPY_MAX_FILES + 1 }, (_, index) => writeFile(path.join(big, 'big', `f${index}.txt`), 'x')),
  );
  const plan = await include.planCopy(big);
  check('I9 pasado el tope, la selección se marca y no se copia', plan?.include?.overCap === true);
}

// ---------------------------------------------------------------------------
// C. Crear
// ---------------------------------------------------------------------------

const folder = worktreeFolderFor(path.resolve(repo), 'feat/notas');
{
  const tab = await service.create({ source: { kind: 'terminal', terminalId: mainTab.terminalId }, branch: 'feat/notas', base: 'main', mode: 'new', copyNotes: true });
  check('C1 la carpeta existe, al lado y con la / pasada a -', existsSync(folder) && folder.endsWith('feat-notas'));
  check('C2 git la tiene como rama aparte de la principal', git(repo, 'worktree', 'list', '--porcelain').includes('branch refs/heads/feat/notas'));
  check('C3 la pestaña se abre en la carpeta de la rama', tab.cwd === folder && registry.opened.at(-1)?.cwd === folder);
  check('C4 las notas ignoradas llegaron', existsSync(path.join(folder, 'CLAUDE.md')) && existsSync(path.join(folder, 'CHECKLIST.md')) && existsSync(path.join(folder, 'docs', 'a.md')));
  check('C5 la configuración de las CLIs no llegó', !existsSync(path.join(folder, '.claude')) && !existsSync(path.join(folder, '.mcp.json')));
  check('C6 el enlace hacia afuera no llegó', !existsSync(path.join(folder, 'linked')));
  const record = store.byPath(folder);
  check('C7 queda anotada, con la huella de cada nota y las carpetas enteras',
    record !== null && record.createdBranch && record.copied.length === 3 && record.copiedDirs.includes('docs'), JSON.stringify(record?.copiedDirs));
  check('C8 la principal no se tocó', git(repo, 'status', '--porcelain') === '');

  const tries = [
    [{ branch: 'feat/notas', mode: 'new' }, 'worktreeBranchExists'],
    [{ branch: 'a..b', mode: 'new' }, 'worktreeBranchInvalid'],
    [{ branch: 'otra', mode: 'new', base: 'no-existe' }, 'worktreeBaseMissing'],
    [{ branch: 'feat/notas', mode: 'existing' }, 'worktreeBranchInUse'],
    [{ branch: 'no-existe', mode: 'existing' }, 'worktreeBranchMissing'],
  ];
  const wrong = [];
  for (const [request, key] of tries) {
    try {
      await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, base: 'main', copyNotes: true, ...request });
      wrong.push(`${request.branch}: creó`);
    } catch (error) {
      if (!(error instanceof WorktreeError) || error.text.key !== key) wrong.push(`${request.branch}: ${error?.text?.key ?? error}`);
    }
  }
  check('C9 lo que no se puede crear dice por qué y no crea nada', wrong.length === 0 && registry.opened.length === 2, wrong.join(' / '));
}

// ---------------------------------------------------------------------------
// L. A qué proyecto pertenece una carpeta
// ---------------------------------------------------------------------------

{
  const checkout = await readCheckout(path.join(folder, 'docs'));
  check('L1 desde una subcarpeta de la rama se llega a la principal',
    checkout?.linked === true && checkout.mainRoot === path.resolve(repo) && checkout.branch === 'feat/notas', JSON.stringify(checkout));
  check('L2 la misma subcarpeta del lado de la principal', checkout !== null && mainCwdFor(path.join(folder, 'docs'), checkout) === path.join(path.resolve(repo), 'docs'));
  const main = await readCheckout(repo);
  check('L3 la principal es la principal', main?.linked === false && main.branch === 'main');
  check('L4 fuera de git, nada', (await readCheckout(outside)) === null);

  // Un `.git` escrito a mano que apunta a otro repo no se cree.
  const forged = path.join(root, 'falsa');
  await mkdir(forged, { recursive: true });
  await writeFile(path.join(forged, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'feat-notas')}\n`);
  const fake = await readCheckout(forged);
  check('L5 un .git que no apunta de vuelta no hace una rama aparte', fake !== null && fake.linked === false, JSON.stringify(fake));

  const links = new WorktreeLinks(store);
  const link = await links.sessionLink(folder);
  check('L6 la sesión de la rama va al proyecto de la principal, con su rama',
    link?.mainCwd === path.resolve(repo) && link.worktree.branch === 'feat/notas' && link.worktree.exists, JSON.stringify(link));
  check('L7 la carpeta del proyecto no es una rama aparte', (await links.sessionLink(repo)) === null);
  const gone = await links.sessionLink(path.join(root, 'otro.worktrees', 'vieja'));
  check('L8 una carpeta que ya no está se reconoce por la forma de su ruta',
    gone?.mainCwd === path.join(root, 'otro') && gone.worktree.exists === false && gone.worktree.reopenable === false, JSON.stringify(gone));
  const tabLink = await links.tabWorktree(folder);
  check('L9 la pestaña sabe su rama y su principal', tabLink?.linked === true && tabLink.branch === 'feat/notas' && tabLink.mainCwd === path.resolve(repo));

  // La barra: una sesión de la rama cae en el proyecto de la principal.
  const summary = (sessionId, cwd) => ({
    agent: 'claude-code', sessionId, cwd, title: sessionId, titleSource: 'none', updatedAt: 1, sizeBytes: 1,
    archived: false, storage: 'native', partial: false, worktree: null,
  });
  const projects = buildProjects(
    [
      { agent: 'claude-code', group: 'g1', cwd: folder, summary: summary('s1', folder) },
      { agent: 'claude-code', group: 'g2', cwd: repo, summary: summary('s2', repo) },
    ],
    process.platform,
    (cwd) => (cwd === folder ? link : null),
  );
  check('L10 un proyecto, el de la principal, con la rama en su sesión',
    projects.length === 1 && projects[0].cwd === path.resolve(repo) &&
      projects[0].sessions.find((s) => s.sessionId === 's1')?.worktree?.branch === 'feat/notas' &&
      projects[0].sessions.find((s) => s.sessionId === 's2')?.worktree === null,
    JSON.stringify(projects.map((p) => p.cwd)));

  // Las pestañas: la de la rama cae junto a las de su proyecto (§6.8).
  const describe = new Map([
    ['a', { kind: 'agent', cwd: repo, worktree: { mainCwd: repo, branch: 'main', linked: false } }],
    ['b', { kind: 'agent', cwd: outside, worktree: null }],
  ]);
  const index = shared.insertionIndex(['a', 'b'], (id) => describe.get(id), { kind: 'agent', cwd: folder, worktree: { mainCwd: repo, branch: 'feat/notas', linked: true } }, process.platform);
  check('L11 la pestaña de una rama cae junto a las de su proyecto', index === 1, String(index));
}

// ---------------------------------------------------------------------------
// S. El estado de cada rama, para Cambios
// ---------------------------------------------------------------------------

{
  await writeFile(path.join(folder, 'nuevo.ts'), 'export {};\n');
  git(folder, 'add', 'nuevo.ts');
  git(folder, 'commit', '-q', '-m', 'trabajo de la rama');
  await writeFile(path.join(folder, 'sin-commit.ts'), 'x\n');
  const tab = registry.tabs.find((candidate) => candidate.cwd === folder);
  const rows = await service.rows(tab.terminalId);
  const row = rows.find((candidate) => candidate.branch === 'feat/notas');
  const main = rows.find((candidate) => candidate.isMain);
  check('S1 la rama: su id, un archivo sin commit, un commit adelante, sin integrar',
    row?.id === store.byPath(folder)?.id && row.changes === 1 && row.ahead === 1 && row.integrated === false && row.isCurrent === true,
    JSON.stringify(row));
  check('S2 la principal se lista, sin id ni comparación', main?.id === null && main.ahead === null && main.isCurrent === false, JSON.stringify(main));
}

// ---------------------------------------------------------------------------
// Q. Quitar
// ---------------------------------------------------------------------------

{
  const record = store.byPath(folder);
  let plan = await service.planRemove(record.id);
  check('Q1 con trabajo sin commit no se quita, y lo dice', plan.uncommittedCount === 1 && plan.uncommitted[0] === 'sin-commit.ts', JSON.stringify(plan.uncommitted));
  let refused = null;
  try {
    await service.remove(record.id, false, () => {});
  } catch (error) {
    refused = error;
  }
  check('Q2 y quitar se niega sin tocar nada', refused instanceof WorktreeError && refused.text.key === 'worktreeUncommitted' && existsSync(folder));
  await rm(path.join(folder, 'sin-commit.ts'));

  // Notas: una cambia sólo en la rama, otra en los dos lados, una nueva bajo una carpeta copiada.
  await writeFile(path.join(folder, 'CLAUDE.md'), '# Notas\nuna regla\notra regla de la rama\n');
  await writeFile(path.join(folder, 'CHECKLIST.md'), '- [x] uno\n- [ ] dos\n');
  await writeFile(path.join(repo, 'CHECKLIST.md'), '- [ ] uno\n- [ ] dos\n- [ ] tres\n');
  await writeFile(path.join(folder, 'docs', 'nuevo.md'), 'nuevo en la rama\n');
  plan = await service.planRemove(record.id);
  check('Q3 vuelven las que cambiaron sólo en la rama, y lo nuevo bajo docs/',
    JSON.stringify(plan.returning) === JSON.stringify(['CLAUDE.md', 'docs/nuevo.md']), plan.returning.join(' '));
  check('Q4 la que cambió en los dos lados choca', JSON.stringify(plan.conflicts) === JSON.stringify(['CHECKLIST.md']), plan.conflicts.join(' '));
  check('Q5 los comandos se muestran, sin --force', plan.commands.length === 1 && plan.commands[0].includes('worktree remove') && !plan.commands.join(' ').includes('--force'), plan.commands.join(' | '));
  check('Q6 la rama no se borra: tiene un commit sin integrar', plan.deletesBranch === false);
  check('Q7 la pestaña de la rama se nombra', plan.tabs.length === 1 && plan.tabs[0].label === path.basename(folder));
  refused = null;
  try {
    await service.remove(record.id, false, () => {});
  } catch (error) {
    refused = error;
  }
  check('Q8 con notas que chocan no se quita sin "quitar igual"', refused?.text?.key === 'worktreeNotesConflict' && existsSync(folder));
  check('Q9 el pedido al agente nombra las que chocaron, en inglés', notesConflictPrompt(repo, plan.conflicts).includes('CHECKLIST.md') && /^Some ignored notes/.test(notesConflictPrompt(repo, plan.conflicts)));

  // La principal ya trajo lo de la rama: no hay nada que salvar.
  await writeFile(path.join(repo, 'CHECKLIST.md'), '- [x] uno\n- [ ] dos\n- [ ] tres\n');
  plan = await service.planRemove(record.id);
  check('Q10 si la principal ya tiene cada línea de la rama, no choca', plan.conflicts.length === 0, plan.conflicts.join(' '));

  // Otro programa parado en la carpeta (Windows no deja quitarla y git queda a medias).
  if (windows) {
    const holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: path.join(folder, 'docs'), stdio: 'ignore' });
    children.push(holder);
    await new Promise((resolve) => holder.once('spawn', resolve));
    // El proceso toma su carpeta al arrancar, un poco después del `spawn`: se espera la condición, con tope.
    let taken = false;
    for (const deadline = Date.now() + 5_000; !taken && Date.now() < deadline; ) {
      taken = await folderInUse(folder);
      if (!taken) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    check('Q11 una carpeta tomada se detecta sin cambiar nada', taken && existsSync(folder));
    registry.tabs.splice(registry.tabs.findIndex((candidate) => candidate.cwd === folder), 1);
    plan = await service.planRemove(record.id);
    check('Q12 sin pestañas de la app adentro, el plan dice que está en uso', plan.inUse === true);
    holder.kill();
    await new Promise((resolve) => holder.once('exit', resolve));
  }

  // Un enlace de pnpm dentro de la rama, hacia afuera: git no lo borra, y lo que queda se borra sin seguirlo.
  if (windows) {
    await mkdir(path.join(folder, 'node_modules'), { recursive: true });
    await symlink(outside, path.join(folder, 'node_modules', 'pkg'), 'junction');
  }

  const closed = [];
  const outcome = await service.remove(record.id, false, (terminalId) => closed.push(terminalId));
  check('Q13 quitada: la carpeta no está y git no la tiene', !existsSync(folder) && !git(repo, 'worktree', 'list', '--porcelain').includes('feat-notas'));
  check('Q14 las notas volvieron a la principal',
    outcome.returned === 2 && (await readFile(path.join(repo, 'CLAUDE.md'), 'utf8')).includes('otra regla de la rama') && existsSync(path.join(repo, 'docs', 'nuevo.md')));
  check('Q15 la rama con trabajo sin integrar se queda', outcome.branchDeleted === false && git(repo, 'branch', '--list', 'feat/notas').trim().length > 0);
  check('Q16 el enlace hacia afuera no se siguió: el testigo sigue', existsSync(path.join(outside, 'testigo.txt')));
  check('Q17 la carpeta <proyecto>.worktrees vacía también se fue', !existsSync(path.dirname(folder)));
  check('Q18 el registro la da por quitada', store.get(record.id)?.removedAt !== null);
}

// ---------------------------------------------------------------------------
// V. Volver a abrir, y una rama integrada que se borra
// ---------------------------------------------------------------------------

{
  const record = store.byPath(folder);
  sessions.set('claude-code:sesion-1', { agent: 'claude-code', sessionId: 'sesion-1', cwd: folder });
  const links = new WorktreeLinks(store);
  const link = await links.sessionLink(folder);
  check('V1 la sesión de una rama quitada se puede volver a abrir', link?.worktree.exists === false && link.worktree.reopenable === true, JSON.stringify(link));
  const tab = await service.reopen('claude-code', 'sesion-1');
  check('V2 vuelve en la misma carpeta, con sus notas, y se reanuda',
    existsSync(path.join(folder, 'nuevo.ts')) && existsSync(path.join(folder, 'CLAUDE.md')) && tab.cwd === folder && registry.opened.at(-1)?.resumeSessionId === 'sesion-1');
  check('V3 el registro la vuelve a dar por viva', store.get(record.id)?.removedAt === null);

  // Una rama sin commits propios está integrada: al quitarla se borra con -d.
  const plain = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'limpia', base: 'main', mode: 'new', copyNotes: false });
  const plainRecord = store.byPath(plain.cwd);
  check('V4 sin copiar las notas, no llegan', !existsSync(path.join(plain.cwd, 'CLAUDE.md')) && existsSync(path.join(plain.cwd, 'CHECKLIST.md')));
  const plainPlan = await service.planRemove(plainRecord.id);
  check('V5 una rama integrada se borra, y el plan lo muestra', plainPlan.deletesBranch === true && plainPlan.commands.some((command) => command.includes('branch -d')));
  for (const opened of registry.tabs.filter((candidate) => candidate.cwd === plain.cwd)) registry.tabs.splice(registry.tabs.indexOf(opened), 1);
  const plainOutcome = await service.remove(plainRecord.id, false, () => {});
  check('V6 y se borró con -d', plainOutcome.branchDeleted === true && git(repo, 'branch', '--list', 'limpia').trim() === '');

  // "Quitar igual": la nota que chocó se pierde, y lo dice.
  await writeFile(path.join(folder, 'CHECKLIST.md'), 'rama\n');
  await writeFile(path.join(repo, 'CHECKLIST.md'), 'principal\n');
  for (const opened of registry.tabs.filter((candidate) => candidate.cwd === folder)) registry.tabs.splice(registry.tabs.indexOf(opened), 1);
  const forced = await service.remove(record.id, true, () => {});
  check('V7 "quitar igual" quita y cuenta lo que se perdió, sin tocar la principal',
    forced.discarded === 1 && (await readFile(path.join(repo, 'CHECKLIST.md'), 'utf8')) === 'principal\n' && !existsSync(folder));
}

// ---------------------------------------------------------------------------
// P. Las piezas puras
// ---------------------------------------------------------------------------

{
  const buffer = (text) => Buffer.from(text, 'utf8');
  const base = include.hashOf(buffer('a\n'));
  check('P1 sin cambios en la rama, nada', include.noteVerdict(base, buffer('a\n'), buffer('b\n')) === 'unchanged');
  check('P2 cambió sólo en la rama: vuelve', include.noteVerdict(base, buffer('a\nb\n'), buffer('a\n')) === 'return');
  check('P3 no está en la principal: vuelve', include.noteVerdict(null, buffer('nueva\n'), null) === 'return');
  check('P4 en los dos lados: choca', include.noteVerdict(base, buffer('rama\n'), buffer('principal\n')) === 'conflict');
  check('P5 la principal ya tiene cada línea: nada', include.noteVerdict(base, buffer('x\n'), buffer('x\ny\n')) === 'unchanged');
  check('P6 configuración de una CLI, en cualquier nivel',
    include.isCliConfigPath('.claude/settings.json') && include.isCliConfigPath('pkg/.codex/x') && include.isCliConfigPath('sub/opencode.json') && !include.isCliConfigPath('docs/claude.md'));
  const state = parseWorktreesState(JSON.stringify({ version: 2, worktrees: [{ id: 'x' }] }));
  check('P7 un worktrees.json de otra versión se ignora entero', state.length === 0);

  // La web: la etiqueta de rama sólo con ramas aparte abiertas.
  const linkedTab = { terminalId: 'l', worktree: { mainCwd: 'D:\\App', branch: 'feat', linked: true } };
  const mainTab = { terminalId: 'm', worktree: { mainCwd: 'd:\\app', branch: 'main', linked: false } };
  const otherTab = { terminalId: 'o', worktree: { mainCwd: 'D:\\Otra', branch: 'main', linked: false } };
  check('P8 la pestaña de una rama aparte lleva su rama', ui.tabBranch(linkedTab, [linkedTab, mainTab], 'win32') === 'feat');
  check('P9 la principal la lleva sólo con una rama aparte de su proyecto abierta',
    ui.tabBranch(mainTab, [linkedTab, mainTab], 'win32') === 'main' && ui.tabBranch(mainTab, [mainTab, otherTab], 'win32') === null);
  check('P10 fuera de git, nada', ui.tabBranch({ terminalId: 'x', worktree: null }, [linkedTab], 'win32') === null);
  const inspection = { mainRoot: 'D:\\Mi App', parentDir: 'D:\\Mi App.worktrees', separator: '\\', currentBranch: 'main', branches: [{ name: 'main', checkedOut: true }, { name: 'vieja', checkedOut: false }], mainChanges: 0, include: null, notes: { files: 0, bytes: 0, overCap: false, sample: [] } };
  check('P11 el comando que se muestra, con comillas donde hacen falta',
    ui.createCommandPreview(inspection, 'feat/x', 'main', 'new') === 'git worktree add -b feat/x "D:\\Mi App.worktrees\\feat-x" main' &&
      ui.createCommandPreview(inspection, 'vieja', 'main', 'existing') === 'git worktree add "D:\\Mi App.worktrees\\vieja" vieja');
  check('P12 una rama que ya existe se dice antes de crear', ui.createBlocker(inspection, 'vieja', 'new', 'main') !== null && ui.createBlocker(inspection, 'nueva', 'new', 'main') === null);
}

// ---------------------------------------------------------------------------
// E. El protocolo
// ---------------------------------------------------------------------------

{
  const create = shared.parseClientMessage(JSON.stringify({ type: 'worktree.create', requestId: 'r', source: { kind: 'project', projectKey: 'k' }, branch: 'b', base: 'main', mode: 'new', copyNotes: true, agent: 'no-existe' }));
  check('E1 una CLI desconocida se conserva para rechazarla', create?.type === 'worktree.create' && create.unsupportedAgent === 'no-existe' && create.agent === undefined);
  const withPath = shared.parseClientMessage(JSON.stringify({ type: 'worktree.inspect', requestId: 'r', source: { kind: 'path', path: 'C:\\x' } }));
  check('E2 un pedido no puede nombrar una ruta', withPath === null);
  const rows = shared.parseServerMessage(JSON.stringify({ type: 'worktree.rows', terminalId: 't', rows: [{ path: 'D:\\x', branch: 'b', id: null, base: 'main', isCurrent: false, isMain: false, changes: 1, ahead: 2, integrated: false }, { nada: true }] }));
  check('E3 una fila que no se entiende se descarta sola', rows?.type === 'worktree.rows' && rows.rows.length === 1 && rows.rows[0].ahead === 2);
  const descriptor = shared.parseTerminalDescriptor({ terminalId: 't', kind: 'agent', agent: 'claude-code', cwd: 'D:\\x', sessionId: 's', label: '', resumed: false, createdAt: 0, alive: true });
  check('E4 un servidor anterior no manda la rama: null', descriptor?.worktree === null);
}

// ---------------------------------------------------------------------------
// G. Ningún comando de git que escriba fuera de worktrees/git.ts (§6.1)
// ---------------------------------------------------------------------------

{
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
  const files = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith('.ts')) files.push(full);
    }
  };
  await walk(srcDir);
  const relative = (file) => path.relative(srcDir, file).split(path.sep).join('/');
  const sources = new Map(await Promise.all(files.map(async (file) => [relative(file), await readFile(file, 'utf8')])));

  const runsGit = [...sources].filter(([, text]) => /execFile\(\s*'git'/.test(text)).map(([name]) => name).sort();
  check('G1 sólo tres archivos lanzan git', JSON.stringify(runsGit) === JSON.stringify(['git-repo.ts', 'memory-bridge.ts', 'worktrees/git.ts']), runsGit.join(' '));

  const WRITES = /'(commit|push|checkout|switch|reset|rebase|merge|stash|cherry-pick|revert|apply|am|gc|prune|update-ref|update-index|clean|restore|tag|config|rm|mv|add|remove|-D|--force|-f)'/g;
  const leaks = [];
  for (const name of ['git-repo.ts', 'memory-bridge.ts']) {
    for (const match of sources.get(name).matchAll(WRITES)) leaks.push(`${name}: ${match[0]}`);
  }
  check('G2 git-repo.ts y memory-bridge.ts sólo leen', leaks.length === 0, leaks.join(' '));

  const own = sources.get('worktrees/git.ts');
  const ownWrites = [...own.matchAll(WRITES)].map((match) => match[1]).sort();
  check('G3 worktrees/git.ts escribe sólo worktree add, worktree remove y branch -d',
    JSON.stringify(ownWrites) === JSON.stringify(['add', 'add', 'remove']) && /\['branch', '-d', branch\]/.test(own), ownWrites.join(' '));
  check('G4 nunca --force, -D ni -f', !/'--force'|'-D'|'-f'/.test(own));
  check('G5 los tres corren por el camino que escribe, y nada más', (own.match(/write: true/g) ?? []).length === 3);
  const callers = [...sources].filter(([name, text]) => name !== 'worktrees/git.ts' && /\b(addWorktree|removeWorktree|deleteBranch)\(/.test(text)).map(([name]) => name);
  check('G6 sólo el servicio los llama', JSON.stringify(callers) === JSON.stringify(['worktrees/service.ts']), callers.join(' '));
}

for (const child of children) child.kill();
await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
