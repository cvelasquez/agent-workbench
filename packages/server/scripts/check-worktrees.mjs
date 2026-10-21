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
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
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
const overlap = await import('../src/worktrees/overlap.ts');
const review = await import('../src/worktrees/review.ts');
const mergeNotes = await import('../src/worktrees/merge-notes.ts');
const { NoteBases, keepsNoteBase, NOTE_BASE_MAX_BYTES } = await import('../src/worktrees/note-bases.ts');
const { reviewPrompt, catchUpPrompt, sendBackPrompt } = review;
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

  // Notas: una cambia sólo en la rama, otra en los dos lados en partes distintas, otra en la misma
  // línea de los dos lados, y una nueva bajo una carpeta copiada.
  await writeFile(path.join(folder, 'CLAUDE.md'), '# Notas\nuna regla\notra regla de la rama\n');
  await writeFile(path.join(folder, 'CHECKLIST.md'), '- [x] uno\n- [ ] dos\n');
  await writeFile(path.join(repo, 'CHECKLIST.md'), '- [ ] uno\n- [ ] dos\n- [ ] tres\n');
  await writeFile(path.join(folder, 'docs', 'a.md'), 'a de la rama\n');
  await writeFile(path.join(repo, 'docs', 'a.md'), 'a de la principal\n');
  await writeFile(path.join(folder, 'docs', 'nuevo.md'), 'nuevo en la rama\n');
  plan = await service.planRemove(record.id);
  check('Q3 vuelven las que cambiaron sólo en la rama, lo nuevo bajo docs/ y la que se junta',
    JSON.stringify(plan.returning) === JSON.stringify(['CHECKLIST.md', 'CLAUDE.md', 'docs/nuevo.md']), plan.returning.join(' '));
  check('Q4 la que cambió en los dos lados en partes distintas se junta (21-10-2026)',
    JSON.stringify(plan.merging) === JSON.stringify(['CHECKLIST.md']), plan.merging.join(' '));
  check('Q4b la que cambió en la misma línea de los dos lados choca', JSON.stringify(plan.conflicts) === JSON.stringify(['docs/a.md']), plan.conflicts.join(' '));
  check('Q5 los comandos se muestran, sin --force', plan.commands.length === 1 && plan.commands[0].includes('worktree remove') && !plan.commands.join(' ').includes('--force'), plan.commands.join(' | '));
  check('Q6 la rama no se borra: tiene un commit sin integrar', plan.deletesBranch === false);
  check('Q7 la pestaña de la rama se nombra', plan.tabs.length === 1 && plan.tabs[0].label === path.basename(folder));
  refused = null;
  try {
    await service.remove(record.id, false, () => {});
  } catch (error) {
    refused = error;
  }
  check('Q8 con notas que chocan no se quita sin elegir perderlas', refused?.text?.key === 'worktreeNotesConflict' && existsSync(folder));
  check('Q9 el pedido al agente nombra las que chocaron, en inglés',
    notesConflictPrompt(repo, plan.conflicts).includes('docs/a.md') && /^Some ignored notes/.test(notesConflictPrompt(repo, plan.conflicts)));

  // La principal ya trajo lo de la rama: no hay nada que salvar, ni que juntar.
  await writeFile(path.join(repo, 'CHECKLIST.md'), '- [x] uno\n- [ ] dos\n- [ ] tres\n');
  await writeFile(path.join(repo, 'docs', 'a.md'), 'a de la principal\na de la rama\n');
  plan = await service.planRemove(record.id);
  check('Q10 si la principal ya tiene lo de la rama, no choca ni vuelve',
    plan.conflicts.length === 0 && !plan.returning.includes('CHECKLIST.md') && !plan.returning.includes('docs/a.md'),
    `${plan.conflicts.join(' ')} / ${plan.returning.join(' ')}`);

  // Otro programa parado en la carpeta (Windows no deja quitarla y git queda a medias).
  if (windows) {
    const holder = spawn(process.execPath, ['-e', "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"], {
      cwd: path.join(folder, 'docs'),
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    children.push(holder);
    // Windows le abre su carpeta al proceso mientras arranca, después del `spawn`. Sondear en ese
    // momento la renombra y el proceso queda vivo sin tomarla (18 de 20 veces en D:, medido el
    // 20-10-2026): se espera a que el proceso diga que corre, con tope, y se mira una vez.
    await Promise.race([
      new Promise((resolve) => holder.stdout.once('data', resolve)),
      new Promise((_, reject) => setTimeout(() => reject(new Error('el proceso de prueba no arrancó')), 30_000).unref()),
    ]);
    const taken = await folderInUse(folder);
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

  // Una rama sin commits propios está integrada para git: al quitarla se borra con -d.
  const plain = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'limpia', base: 'main', mode: 'new', copyNotes: false });
  const plainRecord = store.byPath(plain.cwd);
  check('V4 sin copiar las notas, no llegan', !existsSync(path.join(plain.cwd, 'CLAUDE.md')) && existsSync(path.join(plain.cwd, 'CHECKLIST.md')));
  const savedRecord = parseWorktreesState(await readFile(path.join(root, 'appdata', 'worktrees.json'), 'utf8')).find((candidate) => candidate.id === plainRecord.id);
  check('V4b el registro anota el commit del que salió la rama, también en disco',
    plainRecord.startCommit === git(repo, 'rev-parse', 'main').trim() && savedRecord?.startCommit === plainRecord.startCommit, String(plainRecord.startCommit));
  // Pero en Cambios no se llama "integrada": no trajo nada (decía "1 sin commit · integrada" en una rama recién creada).
  await writeFile(path.join(plain.cwd, 'a-medias.txt'), 'sin commit\n');
  const plainRows = await service.rows(plain.terminalId);
  const plainRow = plainRows.find((candidate) => candidate.branch === 'limpia');
  check('V4c una rama recién creada no se da por integrada, tampoco con algo sin commit',
    plainRow?.integrated === false && plainRow.ahead === 0 && plainRow.changes === 1 &&
      ui.rowStatusParts(plainRow).join(' · ') === '1 sin commit',
    JSON.stringify(plainRow));
  await rm(path.join(plain.cwd, 'a-medias.txt'));
  const plainPlan = await service.planRemove(plainRecord.id);
  check('V5 una rama integrada se borra, y el plan lo muestra', plainPlan.deletesBranch === true && plainPlan.commands.some((command) => command.includes('branch -d')));
  check('V5b el plan dice que no tiene commits propios, no que está integrada',
    plainPlan.branchUnused === true && shared.parseWorktreeRemovePlan(JSON.parse(JSON.stringify(plainPlan)))?.branchUnused === true);
  // Un registro de antes del arreglo no sabe de dónde salió la rama: queda como antes.
  await store.update(plainRecord.id, { startCommit: null });
  service.changed();
  const legacyRow = (await service.rows(plain.terminalId)).find((candidate) => candidate.branch === 'limpia');
  const legacyPlan = await service.planRemove(plainRecord.id);
  check('V5c sin el commit de salida, como antes: integrada, y se borra al quitarla',
    legacyRow?.integrated === true && legacyPlan.deletesBranch === true && legacyPlan.branchUnused === false, JSON.stringify(legacyRow));
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
// K. Una rama integrada que se borra al quitarla se vuelve a abrir igual, y
//    las ramas guardadas (20-10-2026)
// ---------------------------------------------------------------------------

{
  const closeTabsIn = (cwd) => {
    for (const opened of registry.tabs.filter((candidate) => candidate.cwd === cwd)) registry.tabs.splice(registry.tabs.indexOf(opened), 1);
  };
  const commitIn = async (cwd, file) => {
    await writeFile(path.join(cwd, file), `${file}\n`);
    git(cwd, 'add', file);
    git(cwd, 'commit', '-q', '-m', file);
  };
  const linkOf = (cwd) => new WorktreeLinks(store).sessionLink(cwd);

  // Integrada y quitada: la rama se borra, y sus conversaciones se pueden volver a abrir igual.
  const merged = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'integrada', base: 'main', mode: 'new', copyNotes: false });
  const mergedRecord = store.byPath(merged.cwd);
  await commitIn(merged.cwd, 'integrada.txt');
  git(repo, 'merge', '-q', '--ff-only', 'integrada');
  const mergedTip = git(repo, 'rev-parse', 'integrada').trim();
  const mergedPlan = await service.planRemove(mergedRecord.id);
  check('K1 integrada y con commits propios: el plan la borra, sin decir "sin commits propios"',
    mergedPlan.deletesBranch === true && mergedPlan.branchUnused === false && mergedPlan.commands.some((command) => command.includes('branch -d')));
  closeTabsIn(merged.cwd);
  const mergedOutcome = await service.remove(mergedRecord.id, false, () => {});
  const savedMerged = parseWorktreesState(await readFile(path.join(root, 'appdata', 'worktrees.json'), 'utf8')).find((candidate) => candidate.id === mergedRecord.id);
  check('K2 quitada: la rama se borró y el registro anota el commit donde quedó, también en disco',
    mergedOutcome.branchDeleted === true && git(repo, 'branch', '--list', 'integrada').trim() === '' &&
      store.get(mergedRecord.id)?.endCommit === mergedTip && savedMerged?.endCommit === mergedTip,
    String(store.get(mergedRecord.id)?.endCommit));
  const mergedLink = await linkOf(merged.cwd);
  check('K3 sin la rama, su conversación se puede volver a abrir igual',
    mergedLink?.worktree.exists === false && mergedLink.worktree.reopenable === true, JSON.stringify(mergedLink));
  sessions.set('claude-code:sesion-integrada', { agent: 'claude-code', sessionId: 'sesion-integrada', cwd: merged.cwd });
  const reopenedMerged = await service.reopen('claude-code', 'sesion-integrada');
  check('K4 volver a abrirla crea la rama otra vez en ese commit, en la misma carpeta, y reanuda la conversación',
    git(repo, 'rev-parse', 'integrada').trim() === mergedTip && existsSync(path.join(merged.cwd, 'integrada.txt')) &&
      reopenedMerged.cwd === merged.cwd && registry.opened.at(-1)?.resumeSessionId === 'sesion-integrada' &&
      store.get(mergedRecord.id)?.removedAt === null);
  closeTabsIn(merged.cwd);
  const mergedAgain = await service.remove(mergedRecord.id, false, () => {});
  check('K4b quitada otra vez, se vuelve a borrar y se puede volver a abrir',
    mergedAgain.branchDeleted === true && (await linkOf(merged.cwd))?.worktree.reopenable === true);

  // Un registro de antes no sabe dónde quedó; y un commit que git ya limpió no se puede usar.
  await store.update(mergedRecord.id, { endCommit: null });
  const legacyLink = await linkOf(merged.cwd);
  let legacyRefused = null;
  try {
    await service.reopen('claude-code', 'sesion-integrada');
  } catch (error) {
    legacyRefused = error;
  }
  await store.update(mergedRecord.id, { endCommit: 'f'.repeat(40) });
  const cleanedLink = await linkOf(merged.cwd);
  let cleanedRefused = null;
  try {
    await service.reopen('claude-code', 'sesion-integrada');
  } catch (error) {
    cleanedRefused = error;
  }
  check('K4c sin el commit donde quedó, o con uno que el repo ya no tiene, no se ofrece ni se crea nada',
    legacyLink?.worktree.reopenable === false && legacyRefused?.text?.key === 'worktreeBranchMissing' &&
      cleanedLink?.worktree.reopenable === false && cleanedRefused?.text?.key === 'worktreeBranchMissing' &&
      git(repo, 'branch', '--list', 'integrada').trim() === '' && !existsSync(merged.cwd),
    JSON.stringify([legacyLink, cleanedLink]));
  await store.update(mergedRecord.id, { endCommit: mergedTip });

  // Quitada sin integrar: la rama se queda. Integrada después a mano, se puede borrar desde Cambios.
  const kept = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'guardada', base: 'main', mode: 'new', copyNotes: false });
  const keptRecord = store.byPath(kept.cwd);
  await commitIn(kept.cwd, 'guardada.txt');
  closeTabsIn(kept.cwd);
  const keptOutcome = await service.remove(keptRecord.id, false, () => {});
  git(repo, 'merge', '-q', '--ff-only', 'guardada');
  const keptTip = git(repo, 'rev-parse', 'guardada').trim();
  const keptLink = await linkOf(kept.cwd);
  check('K4d quitada sin integrar: la rama se queda y su conversación se puede volver a abrir',
    keptOutcome.branchDeleted === false && !existsSync(kept.cwd) && git(repo, 'branch', '--list', 'guardada').trim().length > 0 &&
      keptLink?.worktree.reopenable === true,
    JSON.stringify(keptLink));

  // Una sin integrar, quitada: la rama se queda siempre (no se pierden sus commits).
  const unmerged = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'sin-integrar', base: 'main', mode: 'new', copyNotes: false });
  const unmergedRecord = store.byPath(unmerged.cwd);
  await commitIn(unmerged.cwd, 'sin-integrar.txt');
  closeTabsIn(unmerged.cwd);
  await service.remove(unmergedRecord.id, false, () => {});

  // `feat/notas`, de Q, también es guardada: se quitó con un commit sin integrar y la rama se quedó (Q15).
  const listed = await service.keptBranches(mainTab.terminalId);
  const listedBranch = (branch) => listed.find((candidate) => candidate.branch === branch);
  check('K5 Cambios lista las guardadas, por nombre, con lo que cada una no integró',
    JSON.stringify(listed.map((candidate) => candidate.branch)) === JSON.stringify(['feat/notas', 'guardada', 'sin-integrar']) &&
      JSON.stringify(listedBranch('guardada')) === JSON.stringify({ id: keptRecord.id, branch: 'guardada', base: 'main', ahead: 0 }) &&
      JSON.stringify(listedBranch('sin-integrar')) === JSON.stringify({ id: unmergedRecord.id, branch: 'sin-integrar', base: 'main', ahead: 1 }),
    JSON.stringify(listed));
  check('K6 la fila dice "integrada" o cuántos commits faltan',
    ui.keptStatusText(listedBranch('guardada')) === 'integrada' && ui.keptStatusText(listedBranch('sin-integrar')) === '1 commit sin integrar' &&
      ui.keptStatusText({ ...listedBranch('sin-integrar'), ahead: null }) === null);

  const deletePlan = await service.planDeleteBranch(keptRecord.id);
  check('K7 el plan de borrarla: git branch -d en la carpeta principal, sin nada que lo frene',
    deletePlan.command === 'git branch -d guardada' && path.resolve(deletePlan.folder) === path.resolve(repo) && deletePlan.blocker === null &&
      shared.parseWorktreeDeleteBranchPlan(JSON.parse(JSON.stringify(deletePlan)))?.command === deletePlan.command,
    JSON.stringify(deletePlan));
  const blockedPlan = await service.planDeleteBranch(unmergedRecord.id);
  let refusedDelete = null;
  try {
    await service.deleteKeptBranch(unmergedRecord.id);
  } catch (error) {
    refusedDelete = error;
  }
  check('K8 con commits que la base no tiene no se borra, y el diálogo dice por qué',
    blockedPlan.blocker === 'not-integrated' && refusedDelete?.text?.key === 'worktreeBranchNotIntegrated' &&
      git(repo, 'branch', '--list', 'sin-integrar').trim().length > 0 &&
      ui.deleteBranchBlockerText(blockedPlan).startsWith('Tiene 1 commit que main no tiene'),
    ui.deleteBranchBlockerText(blockedPlan) ?? '');

  // Como una que se guardó antes de que el registro anotara dónde quedaba: borrarla desde Cambios lo anota.
  await store.update(keptRecord.id, { endCommit: null });
  const deleted = await service.deleteKeptBranch(keptRecord.id);
  const afterLink = await linkOf(kept.cwd);
  const afterList = await service.keptBranches(mainTab.terminalId);
  check('K9 borrada: la rama no está y deja de listarse, pero su conversación se puede volver a abrir igual',
    deleted.branch === 'guardada' && git(repo, 'branch', '--list', 'guardada').trim() === '' &&
      JSON.stringify(afterList.map((candidate) => candidate.branch)) === JSON.stringify(['feat/notas', 'sin-integrar']) &&
      store.get(keptRecord.id)?.endCommit === keptTip && afterLink?.worktree.reopenable === true,
    JSON.stringify([afterList, afterLink]));

  // Vuelta a abrir, la guardada está sacada en su carpeta: no se lista ni se borra.
  sessions.set('claude-code:sesion-sin-integrar', { agent: 'claude-code', sessionId: 'sesion-sin-integrar', cwd: unmerged.cwd });
  await service.reopen('claude-code', 'sesion-sin-integrar');
  const reopenedRecord = store.get(unmergedRecord.id);
  const afterReopen = await service.keptBranches(mainTab.terminalId);
  check('K10 vuelta a abrir, deja de ser guardada',
    JSON.stringify(afterReopen.map((candidate) => candidate.branch)) === JSON.stringify(['feat/notas']) && reopenedRecord?.removedAt === null,
    JSON.stringify(afterReopen));
  let gone = null;
  try {
    await service.planDeleteBranch(unmergedRecord.id);
  } catch (error) {
    gone = error;
  }
  check('K11 y no se ofrece borrar la rama de una que está abierta', gone?.text?.key === 'worktreeUnknown');

  // La misma rama abierta otra vez con "Una rama que ya existe": su registro viejo sigue quitado, pero está sacada.
  const again = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'feat/notas', base: 'main', mode: 'existing', copyNotes: false });
  check('K10b una rama guardada que se vuelve a sacar en otra carpeta deja de listarse',
    !(await service.keptBranches(mainTab.terminalId)).some((candidate) => candidate.branch === 'feat/notas'));
  closeTabsIn(again.cwd);
  await service.remove(store.byPath(again.cwd).id, false, () => {});

  // Una rama que la app no creó (la abrió "Una rama que ya existe") nunca se ofrece borrar.
  git(repo, 'branch', 'ajena');
  const foreign = await service.create({ source: { kind: 'project', projectKey: 'proyecto' }, branch: 'ajena', base: 'main', mode: 'existing', copyNotes: false });
  const foreignRecord = store.byPath(foreign.cwd);
  closeTabsIn(foreign.cwd);
  await service.remove(foreignRecord.id, false, () => {});
  let foreignRefused = null;
  try {
    await service.planDeleteBranch(foreignRecord.id);
  } catch (error) {
    foreignRefused = error;
  }
  check('K14 una rama que no creó la app no se lista ni se borra',
    git(repo, 'branch', '--list', 'ajena').trim().length > 0 &&
      !(await service.keptBranches(mainTab.terminalId)).some((candidate) => candidate.branch === 'ajena') &&
      foreignRefused?.text?.key === 'worktreeUnknown');

  // Lo que viaja: un servidor anterior no manda las guardadas.
  const rowsOld = shared.parseServerMessage(JSON.stringify({ type: 'worktree.rows', terminalId: 't', rows: [] }));
  const rowsNew = shared.parseServerMessage(JSON.stringify({ type: 'worktree.rows', terminalId: 't', rows: [], kept: [listedBranch('sin-integrar'), { nada: true }] }));
  check('K12 las guardadas viajan aparte de las filas, y una que no se entiende se descarta',
    rowsOld?.kept === undefined && rowsNew?.kept?.length === 1 && rowsNew.kept[0].branch === 'sin-integrar');
  check('K13 los pedidos de borrar se nombran por el id, sin rutas',
    shared.parseClientMessage(JSON.stringify({ type: 'worktree.planDeleteBranch', requestId: 'r', worktreeId: 'w' }))?.worktreeId === 'w' &&
      shared.parseClientMessage(JSON.stringify({ type: 'worktree.deleteBranch', requestId: 'r' })) === null &&
      shared.parseServerMessage(JSON.stringify({ type: 'worktree.branchDeleted', requestId: 'r', worktreeId: 'w', branch: 'b' }))?.branch === 'b');
}

// ---------------------------------------------------------------------------
// Hito 49: un repo con dos ramas que tocan el mismo archivo, y una base que avanza
// ---------------------------------------------------------------------------

/** Las pestañas del hito 49: cada una con su sesión (Codex nace sin), su actividad y si es de revisión. */
function fakeTeamRegistry() {
  const tabs = [];
  const activity = new Map();
  let count = 0;
  return {
    tabs,
    activity,
    opened: [],
    async open(options) {
      count += 1;
      const agent = options.agent ?? 'claude-code';
      const descriptor = {
        terminalId: `e${count}`,
        kind: options.kind ?? 'agent',
        agent,
        cwd: options.cwd,
        // Codex pone el id él mismo: su pestaña nace sin sesión y la descubre después.
        sessionId: options.resumeSessionId ?? (agent === 'codex' ? '' : `sesion-${count}`),
        label: options.label ?? '',
        resumed: options.resumeSessionId !== undefined,
        createdAt: count,
        alive: true,
        exitCode: null,
        sleeping: false,
        launchedAt: count,
        worktree: null,
        review: options.review === true,
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
    activityOf(terminalId) {
      return activity.get(terminalId) ?? null;
    },
  };
}

/** Un seguidor de mentira: la conversación del revisor, ya leída. null: no está. */
function fakeFollower(events) {
  return {
    label: 'falso',
    async start() {},
    async poll() {
      return { reset: false, added: [] };
    },
    getState: () => (events === null ? 'not-found' : 'live'),
    getTail: () => ({ events: events ?? [], hasMore: false }),
  };
}

let eventCount = 0;
const say = (role, ...parts) => ({ eventId: `ev${++eventCount}`, role, at: 0, parts, model: null, usage: null, effort: null, durationMs: null });
const said = (value) => ({ kind: 'text', text: value, truncated: false });
const toolCall = { kind: 'tool-call', toolUseId: 'u1', name: 'Bash', input: 'git diff', truncated: false };
const toolResult = { kind: 'tool-result', toolUseId: 'u1', text: 'diff', isError: false, truncated: false };
const looseObjects = (cwd) => Number(/count: (\d+)/.exec(git(cwd, 'count-objects', '-v'))?.[1] ?? '-1');
const tip = (cwd, ref) => git(cwd, 'rev-parse', ref).trim();
const errorKey = async (run) => {
  try {
    await run();
    return 'no falló';
  } catch (error) {
    return error instanceof WorktreeError ? error.text.key : String(error);
  }
};

const team = await makeRepo('equipo');
await writeFile(path.join(team, 'notes.txt'), `${Array.from({ length: 10 }, (_, index) => `linea ${index + 1}`).join('\n')}\n`);
await writeFile(path.join(team, 'viejo.txt'), 'renombrar\n');
git(team, 'add', 'notes.txt', 'viejo.txt');
git(team, 'commit', '-q', '-m', 'notas');
const teamStore = new WorktreeStore(path.join(root, 'appdata', 'worktrees-equipo.json'));
await teamStore.load();
const teamRegistry = fakeTeamRegistry();
const teamSessions = [];
const replies = new Map();
let clock = 1_000_000;
/** Pasado el tiempo de las filas guardadas: la próxima lectura es nueva. */
const tick = () => {
  clock += 10_000;
};
const teamService = new WorktreeService({
  store: teamStore,
  registry: teamRegistry,
  projectCwd: (key) => (key === 'equipo' ? team : null),
  findSession: (agent, sessionId) => teamSessions.find((session) => session.agent === agent && session.sessionId === sessionId) ?? null,
  sessionsUnder: (folder) =>
    teamSessions.filter((session) => {
      const relative = path.relative(path.resolve(folder), path.resolve(session.cwd));
      return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
    }),
  history: () => ({ wholeRead: true, follow: (target) => fakeFollower(replies.get(target.sessionId) ?? null) }),
  now: () => clock,
});
const teamTab = await teamRegistry.open({ cwd: team });
const created = {};
for (const [branch, agent] of [['feat/a', 'codex'], ['feat/b', 'claude-code']]) {
  const tab = await teamService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch, base: 'main', mode: 'new', copyNotes: false, agent });
  created[branch] = { tab, id: teamStore.byPath(tab.cwd).id, folder: tab.cwd };
}
const A = created['feat/a'];
const B = created['feat/b'];
const editLine = async (cwd, line, value) => {
  const lines = (await readFile(path.join(cwd, 'notes.txt'), 'utf8')).split('\n');
  lines[line - 1] = value;
  await writeFile(path.join(cwd, 'notes.txt'), lines.join('\n'));
};
await editLine(A.folder, 2, 'linea 2 de a');
await writeFile(path.join(A.folder, 'a.ts'), 'export const a = 1;\n');
git(A.folder, 'add', '.');
git(A.folder, 'commit', '-q', '-m', 'a: notas y a.ts');
await editLine(B.folder, 9, 'linea 9 de b');
git(B.folder, 'mv', 'viejo.txt', 'nuevo.txt');
git(B.folder, 'add', '.');
git(B.folder, 'commit', '-q', '-m', 'b: notas y renombre');
await editLine(team, 2, 'linea 2 de main');
git(team, 'add', 'notes.txt');
git(team, 'commit', '-q', '-m', 'main avanza');

// ---------------------------------------------------------------------------
// T. La rama contra su base, y contra las otras (hito 49)
// ---------------------------------------------------------------------------

{
  const scratchBefore = (await readdir(os.tmpdir())).filter((name) => name.startsWith('aw-merge-tree-')).sort();
  const objectsBefore = looseObjects(team);
  tick();
  const rows = await teamService.rows(teamTab.terminalId);
  const objectsAfter = looseObjects(team);
  const scratchAfter = (await readdir(os.tmpdir())).filter((name) => name.startsWith('aw-merge-tree-')).sort();
  const rowA = rows.find((row) => row.branch === 'feat/a');
  const rowB = rows.find((row) => row.branch === 'feat/b');
  const main = rows.find((row) => row.isMain);
  check('T1 cuánto avanzó la base y cuánto la rama', rowA?.behind === 1 && rowA.ahead === 1 && rowB?.behind === 1 && rowB.ahead === 1, JSON.stringify({ a: rowA, b: rowB }));
  check('T2 la que choca con la base dice en qué archivo',
    rowA?.merge?.state === 'conflicts' && JSON.stringify(rowA.merge.files) === JSON.stringify(['notes.txt']) && rowA.merge.fileCount === 1, JSON.stringify(rowA?.merge));
  check('T3 la que no choca lo dice', rowB?.merge?.state === 'clean' && rowB.merge.files.length === 0, JSON.stringify(rowB?.merge));
  check('T4 calcular el choque no deja objetos en el repo ni carpetas en la temporal',
    objectsBefore === objectsAfter && objectsBefore >= 0 && JSON.stringify(scratchBefore) === JSON.stringify(scratchAfter),
    `${objectsBefore} -> ${objectsAfter}`);
  check('T5 las dos ramas que tocan el mismo archivo se avisan una a la otra',
    JSON.stringify(rowA?.overlaps) === JSON.stringify([{ branch: 'feat/b', files: ['notes.txt'], fileCount: 1 }]) &&
      JSON.stringify(rowB?.overlaps) === JSON.stringify([{ branch: 'feat/a', files: ['notes.txt'], fileCount: 1 }]),
    JSON.stringify([rowA?.overlaps, rowB?.overlaps]));
  check('T6 la principal no se compara con nada', main?.behind === null && main.merge === null && main.overlaps.length === 0 && main.review === null);
  check('T7 sin revisión pedida, ninguna', rowA?.review === null && rowB?.review === null);

  // Sin `tick()`: lo guardado no venció, pero una punta se movió.
  await writeFile(path.join(A.folder, 'extra.ts'), 'export const extra = 1;\n');
  git(A.folder, 'add', 'extra.ts');
  git(A.folder, 'commit', '-q', '-m', 'a: extra');
  const afterCommit = (await teamService.rows(teamTab.terminalId)).find((row) => row.branch === 'feat/a');
  check('T8 un commit en una rama se ve en la lectura siguiente, sin esperar', afterCommit?.ahead === 2, JSON.stringify(afterCommit?.ahead));
  git(A.folder, 'reset', '-q', '--hard', 'HEAD~1');
}

// ---------------------------------------------------------------------------
// W. Ver cambios
// ---------------------------------------------------------------------------

{
  const changesA = await teamService.changes(A.id);
  check('W1 los commits de la rama, con su asunto, y los archivos que trae',
    changesA.commitCount === 1 && changesA.commits[0]?.subject === 'a: notas y a.ts' && changesA.commits[0].at > 0 &&
      JSON.stringify(changesA.files.map((file) => `${file.kind}:${file.path}`).sort()) === JSON.stringify(['added:a.ts', 'modified:notes.txt']) &&
      changesA.uncommitted === 0,
    JSON.stringify(changesA));
  const changesB = await teamService.changes(B.id);
  const renamed = changesB.files.find((file) => file.kind === 'renamed');
  check('W2 un renombre trae la ruta de antes', renamed?.path === 'nuevo.txt' && renamed.oldPath === 'viejo.txt', JSON.stringify(changesB.files));
  const diff = await teamService.changesDiff(A.id, 'notes.txt');
  check('W3 el diff de un archivo contra la base: lo que la rama quitó y puso',
    diff.lines.some((line) => line.kind === 'removed' && line.text === 'linea 2') && diff.lines.some((line) => line.kind === 'added' && line.text === 'linea 2 de a') &&
      !diff.lines.some((line) => line.text.includes('de main')),
    JSON.stringify(diff.lines.filter((line) => line.kind !== 'context')));
  const renameDiff = await teamService.changesDiff(B.id, 'nuevo.txt');
  check('W4 el de un renombre lo muestra como tal', renameDiff.lines.some((line) => line.text === 'rename from viejo.txt'), JSON.stringify(renameDiff.lines));
  const refused = [await errorKey(() => teamService.changesDiff(A.id, 'README.md')), await errorKey(() => teamService.changesDiff(A.id, '../equipo/notes.txt'))];
  check('W5 un archivo que la rama no cambió no se pide', refused.every((key) => key === 'worktreeFileNotInBranch'), refused.join(' '));
}

// ---------------------------------------------------------------------------
// Y. La revisión de otro agente
// ---------------------------------------------------------------------------

let reviewSession = '';
{
  const plan = await teamService.planReview(A.id);
  check('Y1 el plan: quién trabajó en la rama, el pedido en inglés y cuánto hay que revisar',
    plan.author === 'codex' && plan.prompt === reviewPrompt('feat/a', 'main') && plan.ahead === 1 && plan.uncommitted === 0 && plan.branchBusy === false,
    JSON.stringify(plan));
  teamRegistry.activity.set(A.tab.terminalId, 'busy');
  check('Y2 con la pestaña de la rama trabajando, se avisa', (await teamService.planReview(A.id)).branchBusy === true);
  teamRegistry.activity.set(A.tab.terminalId, 'idle');

  const before = { base: tip(team, 'main'), branch: tip(team, 'feat/a') };
  const { terminal, prompt } = await teamService.requestReview(A.id, 'claude-code');
  reviewSession = terminal.sessionId;
  const record = teamStore.get(A.id);
  check('Y3 la pestaña del revisor: en la carpeta de la rama, de revisión, con su CLI y sin nombre propio',
    terminal.review === true && terminal.cwd === A.folder && terminal.agent === 'claude-code' && terminal.label === '' &&
      teamRegistry.opened.at(-1)?.review === true && prompt === reviewPrompt('feat/a', 'main'));
  check('Y4 queda anotada: qué CLI, qué conversación y en qué commits estaban la base y la rama',
    record.review?.agent === 'claude-code' && record.review.sessionId === reviewSession && record.review.baseCommit === before.base &&
      record.review.branchCommit === before.branch && record.reviewSessions.includes(reviewSession),
    JSON.stringify(record.review));

  teamRegistry.activity.set(terminal.terminalId, 'busy');
  tick();
  let row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y5 con el revisor trabajando, en curso', row?.review?.state === 'working' && row.review.verdict === null, JSON.stringify(row?.review));
  teamRegistry.activity.set(terminal.terminalId, 'idle');
  tick();
  row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y6 libre y sin respuesta, todavía nada', row?.review?.state === 'pending', JSON.stringify(row?.review));

  replies.set(reviewSession, [
    say('user', said(prompt)),
    say('assistant', said('Voy a revisar la rama.'), toolCall),
    say('user', toolResult),
    say('assistant', said('1. notes.txt:2 cambia una línea sin test.')),
    say('assistant', said('**Verdict: needs changes**')),
  ]);
  tick();
  row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y7 contestó: pide cambios, del commit de ahora',
    row?.review?.state === 'done' && row.review.verdict === 'changes' && row.review.stale === false && row.review.terminalId === terminal.terminalId,
    JSON.stringify(row?.review));

  // El autor sigue trabajando: la revisión pasa a ser de un commit anterior.
  await writeFile(path.join(A.folder, 'a.ts'), 'export const a = 2;\n');
  git(A.folder, 'commit', '-q', '-am', 'a: arreglo');
  tick();
  row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y8 la rama avanzó después del pedido: de un commit anterior', row?.review?.stale === true, JSON.stringify(row?.review));

  // "Mandar a la rama": la respuesta entera, como ficha, en la pestaña del autor (no la del revisor).
  const sent = await teamService.sendReview(A.id);
  check('Y9 mandar a la rama: a la pestaña del autor, sin abrir otra, con la respuesta entera aparte',
    sent.terminal.terminalId === A.tab.terminalId && sent.opened === false && sent.text === sendBackPrompt() &&
      JSON.stringify(sent.pasted) === JSON.stringify(['1. notes.txt:2 cambia una línea sin test.\n\n**Verdict: needs changes**']),
    JSON.stringify(sent));

  // Sin la pestaña del autor: su conversación más reciente, que no sea la del revisor.
  teamRegistry.tabs.splice(teamRegistry.tabs.indexOf(A.tab), 1);
  teamSessions.push(
    { agent: 'codex', sessionId: 'autor-1', cwd: A.folder, updatedAt: 5, sizeBytes: 1, archived: false },
    { agent: 'claude-code', sessionId: reviewSession, cwd: A.folder, updatedAt: 10, sizeBytes: 1, archived: false },
  );
  const reopened = await teamService.sendReview(A.id);
  check('Y10 sin su pestaña, se reanuda la última conversación del autor, nunca la del revisor',
    reopened.opened === true && teamRegistry.opened.at(-1)?.resumeSessionId === 'autor-1' && teamRegistry.opened.at(-1)?.agent === 'codex',
    JSON.stringify(teamRegistry.opened.at(-1)));
  A.tab = reopened.terminal;

  // Un revisor que pone el id él mismo (Codex): la conversación se encuentra en su pestaña.
  const codexReview = await teamService.requestReview(A.id, 'codex');
  check('Y11 un revisor sin sesión todavía queda anotado sin ella', teamStore.get(A.id).review?.sessionId === '' && codexReview.terminal.sessionId === '');
  codexReview.terminal.sessionId = 'cx-1';
  replies.set('cx-1', [say('user', said('review')), say('assistant', said('Mirando el diff...'))]);
  teamRegistry.activity.set(codexReview.terminal.terminalId, 'unknown');
  tick();
  row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y12 la descubre en su pestaña y la anota', teamStore.get(A.id).review?.sessionId === 'cx-1' && teamStore.get(A.id).reviewSessions.includes('cx-1'));
  check('Y13 una CLI que no dice si trabaja, sin veredicto y con la pestaña viva: todavía nada',
    row?.review?.state === 'pending' && row.review.agent === 'codex', JSON.stringify(row?.review));
  replies.set('cx-1', [say('user', said('review')), say('assistant', said('Todo bien.\n\nVerdict: ready to integrate.'))]);
  tick();
  row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y14 con su veredicto: lista para integrar', row?.review?.state === 'done' && row.review.verdict === 'ready', JSON.stringify(row?.review));

  // Una rama sin nada propio no se revisa, y una sin revisión no tiene qué mandar.
  const fresh = await teamService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/c', base: 'main', mode: 'new', copyNotes: false });
  created['feat/c'] = { tab: fresh, id: teamStore.byPath(fresh.cwd).id, folder: fresh.cwd };
  const nothing = [await errorKey(() => teamService.requestReview(created['feat/c'].id, 'codex')), await errorKey(() => teamService.sendReview(created['feat/c'].id))];
  check('Y15 sin nada que revisar, no se abre nada; sin revisión, nada que mandar',
    nothing[0] === 'worktreeNothingToReview' && nothing[1] === 'worktreeNoReview' && !teamRegistry.opened.some((options) => options.review && options.cwd === fresh.cwd),
    nothing.join(' '));

  // Otro revisor que descubre su conversación, y se cierra antes de que nadie mire Cambios.
  const lateReview = await teamService.requestReview(A.id, 'codex');
  lateReview.terminal.sessionId = 'cx-2';
  await teamService.noteReviewSession(lateReview.terminal.terminalId);
  teamRegistry.tabs.splice(teamRegistry.tabs.indexOf(lateReview.terminal), 1);
  replies.set('cx-2', [say('user', said('review')), say('assistant', said('Nada que agregar.\n\nVerdict: ready to integrate'))]);
  tick();
  row = (await teamService.rows(teamTab.terminalId)).find((candidate) => candidate.branch === 'feat/a');
  check('Y16 la conversación se anota al descubrirla: con la pestaña ya cerrada, la revisión sigue',
    teamStore.get(A.id).review?.sessionId === 'cx-2' && teamStore.get(A.id).reviewSessions.includes('cx-2') &&
      row?.review?.state === 'done' && row.review.verdict === 'ready',
    JSON.stringify(row?.review));
}

// ---------------------------------------------------------------------------
// U. Ponerse al día
// ---------------------------------------------------------------------------

{
  const asked = await teamService.catchUp(A.id);
  check('U1 el pedido de traer la base, con los archivos que van a chocar, a la pestaña del autor',
    asked.text === catchUpPrompt('main', ['notes.txt'], 0) && asked.text.includes('git rebase main') && asked.terminal.terminalId === A.tab.terminalId &&
      asked.opened === false && asked.pasted.length === 0,
    asked.text);
  await writeFile(path.join(A.folder, 'sin-commit.txt'), 'x\n');
  const dirty = await teamService.catchUp(A.id);
  check('U2 con trabajo sin commit, pide primero commitearlo o guardarlo', dirty.text.includes('commit or stash what is not committed yet'));
  await rm(path.join(A.folder, 'sin-commit.txt'));
  check('U3 una rama al día no tiene nada que traer', (await errorKey(() => teamService.catchUp(created['feat/c'].id))) === 'worktreeUpToDate');
}

// ---------------------------------------------------------------------------
// F. Integrar: sólo `merge --ff-only`, en la carpeta de la base
// ---------------------------------------------------------------------------

{
  let plan = await teamService.planIntegrate(B.id);
  check('F1 con la base adelante no se puede: hay que ponerse al día',
    plan.blocker === 'behind' && plan.command === null && plan.behind === 1 && plan.baseFolder === path.resolve(team), JSON.stringify(plan));
  const mainBefore = tip(team, 'main');
  check('F2 integrar se niega y la base no se mueve',
    (await errorKey(() => teamService.integrate(B.id))) === 'worktreeBaseAdvanced' && tip(team, 'main') === mainBefore);

  // Lo que haría el agente de la rama: el rebase, en su terminal.
  git(B.folder, 'rebase', '-q', 'main');
  plan = await teamService.planIntegrate(B.id);
  check('F3 al día: el comando exacto, en la carpeta de la base, con lo que entra',
    plan.blocker === null && plan.command === 'git merge --ff-only feat/b' && plan.ahead === 1 && plan.behind === 0 &&
      plan.baseFolder === path.resolve(team) && plan.files.includes('notes.txt') && plan.files.includes('nuevo.txt') &&
      plan.tabs.some((tab) => tab.terminalId === teamTab.terminalId),
    JSON.stringify(plan));

  // La rama avanza con el diálogo abierto: lo que se integraría ya no es lo que el plan mostró.
  const seenTip = plan.branchCommit;
  await writeFile(path.join(B.folder, 'tarde.txt'), 'tarde\n');
  git(B.folder, 'add', 'tarde.txt');
  git(B.folder, 'commit', '-q', '-m', 'b: tarde');
  check('F14 la rama avanzó después del plan: integrar se niega y la base no se mueve',
    seenTip === tip(team, 'refs/heads/feat/b~1') && (await errorKey(() => teamService.integrate(B.id, seenTip))) === 'worktreeBranchMoved' &&
      tip(team, 'main') === mainBefore,
    String(seenTip));
  git(B.folder, 'reset', '-q', '--hard', 'HEAD~1');

  // Un cambio sin commit en la base, en un archivo que la rama toca: git se negaría.
  await writeFile(path.join(team, 'notes.txt'), 'cambio local\n');
  plan = await teamService.planIntegrate(B.id);
  check('F4 con un cambio local en un archivo que la rama toca, no se ofrece',
    plan.blocker === 'local-changes' && JSON.stringify(plan.localConflicts) === JSON.stringify(['notes.txt']), JSON.stringify(plan.localConflicts));
  check('F5 e integrar se niega sin tocar el cambio local',
    (await errorKey(() => teamService.integrate(B.id))) === 'worktreeLocalChanges' &&
      (await readFile(path.join(team, 'notes.txt'), 'utf8')) === 'cambio local\n' && tip(team, 'main') === mainBefore);
  git(team, 'checkout', '--', 'notes.txt');

  // Un cambio local en otro archivo no estorba, y queda como estaba.
  await writeFile(path.join(team, 'otro.txt'), 'mío\n');
  const outcome = await teamService.integrate(B.id);
  check('F6 integra: la base queda en la punta de la rama, sin commit nuevo',
    outcome.commits === 1 && outcome.base === 'main' && tip(team, 'main') === tip(team, 'feat/b') && tip(team, 'HEAD') === tip(team, 'feat/b') &&
      git(team, 'log', '--format=%P', '-1').trim().split(' ').length === 1,
    JSON.stringify(outcome));
  check('F7 el cambio local en otro archivo sigue ahí, y la principal tiene lo de la rama',
    (await readFile(path.join(team, 'otro.txt'), 'utf8')) === 'mío\n' && existsSync(path.join(team, 'nuevo.txt')) &&
      (await readFile(path.join(team, 'notes.txt'), 'utf8')).includes('linea 9 de b'));
  await rm(path.join(team, 'otro.txt'));
  tick();
  const rowB = (await teamService.rows(teamTab.terminalId)).find((row) => row.branch === 'feat/b');
  check('F8 integrada: sin nada adelante, y quitarla también borra la rama',
    rowB?.integrated === true && rowB.ahead === 0 && (await teamService.planRemove(B.id)).deletesBranch === true, JSON.stringify(rowB));
  check('F9 una rama integrada ya no tiene nada que integrar', (await teamService.planIntegrate(B.id)).blocker === 'nothing');

  // Una etiqueta con el nombre de la rama: el nombre solo nombraría la etiqueta.
  const tagged = await teamService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/d', base: 'main', mode: 'new', copyNotes: false });
  await writeFile(path.join(tagged.cwd, 'd.txt'), 'd\n');
  git(tagged.cwd, 'add', 'd.txt');
  git(tagged.cwd, 'commit', '-q', '-m', 'd');
  git(team, 'tag', 'feat/d', 'main~1');
  const taggedId = teamStore.byPath(tagged.cwd).id;
  // Si el estado de la rama no se lee (la rama leída como `heads/feat/d`), el plan falla: se reporta y se sigue.
  const taggedPlan = await teamService.planIntegrate(taggedId).catch((error) => ({ command: null, failed: error?.text?.key ?? String(error) }));
  check('F10 con una etiqueta del mismo nombre, el comando nombra la rama entera',
    taggedPlan.command === 'git merge --ff-only refs/heads/feat/d', String(taggedPlan.command ?? taggedPlan.failed));
  await teamService.integrate(taggedId).catch(() => undefined);
  check('F11 e integra la rama, no la etiqueta',
    tip(team, 'main') === tip(team, 'refs/heads/feat/d') && tip(team, 'main') !== tip(team, 'refs/tags/feat/d'));

  // Una base que no está sacada en ninguna carpeta: no hay dónde integrar.
  git(team, 'branch', 'otra-base');
  const orphan = await teamService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/e', base: 'otra-base', mode: 'new', copyNotes: false });
  await writeFile(path.join(orphan.cwd, 'e.txt'), 'e\n');
  git(orphan.cwd, 'add', 'e.txt');
  git(orphan.cwd, 'commit', '-q', '-m', 'e');
  const orphanId = teamStore.byPath(orphan.cwd).id;
  plan = await teamService.planIntegrate(orphanId);
  check('F12 una base que no está en ninguna carpeta lo dice', plan.blocker === 'no-base-folder' && plan.baseFolder === null && plan.command === null, JSON.stringify(plan));
  check('F13 e integrar se niega', (await errorKey(() => teamService.integrate(orphanId))) === 'worktreeBaseNotOpen');

  // Una rama que se llama como otra referencia de git, con un stash guardado: `stash` solo nombraría el stash.
  const stashed = await teamService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'stash', base: 'main', mode: 'new', copyNotes: false });
  await writeFile(path.join(stashed.cwd, 's.txt'), 's\n');
  git(stashed.cwd, 'add', 's.txt');
  git(stashed.cwd, 'commit', '-q', '-m', 's');
  await writeFile(path.join(team, 'guardado.txt'), 'g\n');
  git(team, 'add', 'guardado.txt');
  git(team, 'stash', 'push', '-q', '-m', 'guardado');
  const stashedId = teamStore.byPath(stashed.cwd).id;
  const stashedPlan = await teamService.planIntegrate(stashedId);
  check('F15 una rama llamada como otra referencia (stash): el comando nombra la rama entera',
    stashedPlan.command === 'git merge --ff-only refs/heads/stash', String(stashedPlan.command));
  await teamService.integrate(stashedId, stashedPlan.branchCommit ?? undefined).catch(() => undefined);
  check('F16 e integra la rama, no el stash',
    tip(team, 'main') === tip(team, 'refs/heads/stash') && tip(team, 'main') !== tip(team, 'refs/stash') && !existsSync(path.join(team, 'guardado.txt')));
  git(team, 'stash', 'drop', '-q');
}

// ---------------------------------------------------------------------------
// H. Las notas que cambiaron en los dos lados se juntan, y viajan al integrar
//    (21-10-2026)
// ---------------------------------------------------------------------------

{
  // Sus propias copias de origen, y limpiar sin esperar: las de las otras secciones no se tocan.
  const notesDir = path.join(root, 'copias-de-origen');
  const notesBases = new NoteBases(notesDir, { graceMs: 0 });
  const notesService = new WorktreeService({
    store: teamStore,
    registry: teamRegistry,
    projectCwd: (key) => (key === 'equipo' ? team : null),
    findSession: () => null,
    noteBases: notesBases,
  });
  // Una nota que no es de texto viaja a la rama, pero su copia no se guarda: podría ser una clave.
  await writeFile(path.join(team, 'docs', 'secreto.env'), 'TOKEN=x\n');
  const bitacora = 'intro\nel final del parrafo.\n';
  await writeFile(path.join(team, 'docs', 'bitacora.md'), bitacora);
  const opened = await notesService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/notas-h', base: 'main', mode: 'new', copyNotes: true });
  const H = teamStore.byPath(opened.cwd);
  const baseOf = (file) => H.copied.find((entry) => entry.path === file)?.hash;
  const kept = await readdir(notesDir);
  check('H1 al crear se guarda la copia de origen de cada nota de texto, y de nada más',
    ['CHECKLIST.md', 'CLAUDE.md', 'docs/a.md', 'docs/bitacora.md'].every((file) => kept.includes(baseOf(file))) &&
      baseOf('docs/secreto.env') !== undefined && !kept.includes(baseOf('docs/secreto.env')),
    kept.join(' '));

  // En los dos lados: la lista en partes distintas; la bitácora pegada (la principal alarga el último
  // párrafo y la rama agrega una sección justo debajo, como la de fix/comp); y docs/a.md en la misma línea.
  await writeFile(path.join(opened.cwd, 'CHECKLIST.md'), '- [x] uno\n- [ ] dos\n');
  await writeFile(path.join(team, 'CHECKLIST.md'), '- [ ] uno\n- [ ] dos\n- [ ] tres\n');
  await writeFile(path.join(opened.cwd, 'docs', 'bitacora.md'), `${bitacora}\n## Nueva\nde la rama\n`);
  await writeFile(path.join(team, 'docs', 'bitacora.md'), 'intro\nel final del parrafo, alargado\ncon otra linea.\n');
  await writeFile(path.join(opened.cwd, 'docs', 'a.md'), 'a de la rama\n');
  await writeFile(path.join(team, 'docs', 'a.md'), 'a de la principal\n');
  await writeFile(path.join(opened.cwd, 'h.txt'), 'h\n');
  git(opened.cwd, 'add', 'h.txt');
  git(opened.cwd, 'commit', '-q', '-m', 'h');

  let plan = await notesService.planIntegrate(H.id);
  check('H2 el plan de integrar dice qué notas viajan, cuáles se juntan y cuál se queda',
    plan.blocker === null && JSON.stringify(plan.notes?.returning) === JSON.stringify(['CHECKLIST.md', 'docs/bitacora.md']) &&
      JSON.stringify(plan.notes?.merging) === JSON.stringify(['CHECKLIST.md', 'docs/bitacora.md']) &&
      JSON.stringify(plan.notes?.conflicts) === JSON.stringify(['docs/a.md']) &&
      shared.parseWorktreeIntegratePlan(JSON.parse(JSON.stringify(plan)))?.notes?.merging.length === 2,
    JSON.stringify(plan.notes));
  const outcome = await notesService.integrate(H.id, plan.branchCommit ?? undefined);
  const checklist = await readFile(path.join(team, 'CHECKLIST.md'), 'utf8');
  check('H3 integrar trae los commits y las notas, juntas con lo que cambió en la principal',
    tip(team, 'main') === tip(team, 'feat/notas-h') && outcome.notes?.returned === 2 &&
      JSON.stringify(outcome.notes?.stayed) === JSON.stringify(['docs/a.md']) && checklist === '- [x] uno\n- [ ] dos\n- [ ] tres\n',
    JSON.stringify({ outcome, checklist }));
  const joined = await readFile(path.join(team, 'docs', 'bitacora.md'), 'utf8');
  check('H4 la bitácora: el párrafo alargado de la principal y, debajo, la sección de la rama (git lo daba por choque)',
    joined === 'intro\nel final del parrafo, alargado\ncon otra linea.\n\n## Nueva\nde la rama\n', JSON.stringify(joined));
  check('H5 la que no se puede juntar no se tocó en la principal', (await readFile(path.join(team, 'docs', 'a.md'), 'utf8')) === 'a de la principal\n');

  const branchChecklist = await readFile(path.join(opened.cwd, 'CHECKLIST.md'));
  const syncedBase = include.hashOf(branchChecklist);
  check('H6 lo que viajó pasa a ser el origen de cada nota, con su copia guardada',
    teamStore.get(H.id)?.copied.find((entry) => entry.path === 'CHECKLIST.md')?.hash === syncedBase &&
      (await notesBases.load(syncedBase))?.equals(branchChecklist) === true);
  plan = await notesService.planRemove(H.id);
  check('H7 quitarla después no las trae otra vez: sólo queda la que choca',
    plan.returning.length === 0 && JSON.stringify(plan.conflicts) === JSON.stringify(['docs/a.md']) && plan.deletesBranch === true,
    JSON.stringify(plan));

  // El agente de la rama sigue: lo nuevo se junta contra lo que ya viajó, no contra lo de antes.
  await writeFile(path.join(opened.cwd, 'CHECKLIST.md'), '- [x] uno\n- [x] dos\n');
  await writeFile(path.join(team, 'CHECKLIST.md'), '- [x] uno\n- [ ] dos\n- [ ] tres\n- [ ] cuatro\n');
  plan = await notesService.planRemove(H.id);
  check('H8 lo que la rama cambió después de integrar se junta al quitarla',
    JSON.stringify(plan.merging) === JSON.stringify(['CHECKLIST.md']) && JSON.stringify(plan.conflicts) === JSON.stringify(['docs/a.md']),
    JSON.stringify(plan));
  const removal = await notesService.remove(H.id, true, () => {});
  check('H9 quitada: lo nuevo vuelve junto, y sólo se pierde lo de la que choca, como se eligió',
    removal.returned === 1 && removal.discarded === 1 && removal.branchDeleted === true &&
      (await readFile(path.join(team, 'CHECKLIST.md'), 'utf8')) === '- [x] uno\n- [x] dos\n- [ ] tres\n- [ ] cuatro\n' &&
      (await readFile(path.join(team, 'docs', 'a.md'), 'utf8')) === 'a de la principal\n',
    JSON.stringify(removal));
  check('H10 y sus copias de origen se borran', !(await readdir(notesDir)).includes(syncedBase));

  // Una rama de antes del 21-10-2026 no tiene copias de origen: si una nota cambió en los dos lados, se pregunta como antes.
  const old = await notesService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/vieja-h', base: 'main', mode: 'new', copyNotes: true });
  const oldRecord = teamStore.byPath(old.cwd);
  await rm(path.join(notesDir, oldRecord.copied.find((entry) => entry.path === 'CHECKLIST.md').hash));
  await writeFile(path.join(old.cwd, 'CHECKLIST.md'), `${await readFile(path.join(old.cwd, 'CHECKLIST.md'), 'utf8')}- [ ] de la rama\n`);
  await writeFile(path.join(team, 'CHECKLIST.md'), `- [ ] arriba\n${await readFile(path.join(team, 'CHECKLIST.md'), 'utf8')}`);
  plan = await notesService.planRemove(oldRecord.id);
  check('H11 sin la copia de origen, como antes: cambió en los dos lados y se pregunta',
    JSON.stringify(plan.conflicts) === JSON.stringify(['CHECKLIST.md']) && plan.merging.length === 0, JSON.stringify(plan));
  await notesService.remove(oldRecord.id, true, () => {});

  // Lo que no deja quitar una rama: el pedido de commitear va al cuadro de su agente, sin mandar.
  const pending = await notesService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/commit-h', base: 'main', mode: 'new', copyNotes: false });
  const pendingRecord = teamStore.byPath(pending.cwd);
  await writeFile(path.join(pending.cwd, 'pendiente.txt'), 'p\n');
  const asked = await notesService.commitRequest(pendingRecord.id);
  check('H12 con algo sin commit, el pedido va a la pestaña de la rama, nombra el archivo, en inglés y sin subir nada',
    asked.terminal.cwd === pending.cwd && asked.opened === false && asked.text.includes('pendiente.txt') &&
      /^This branch folder has uncommitted changes/.test(asked.text) && asked.text.includes("Don't push"),
    asked.text);
  await rm(path.join(pending.cwd, 'pendiente.txt'));
  check('H13 sin nada sin commit, lo dice', (await errorKey(() => notesService.commitRequest(pendingRecord.id))) === 'worktreeNothingToCommit');
  await notesService.remove(pendingRecord.id, false, () => {});

  // Quitar falla a mitad de camino: una nota ya se escribió (juntada) y la siguiente no se puede escribir
  // (en la principal hay una carpeta con su nombre). Al reintentar, la primera no se junta otra vez.
  await writeFile(path.join(team, 'docs', 'a-junta.md'), 'intro\nfin.\n');
  const halfway = await notesService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/mitad-h', base: 'main', mode: 'new', copyNotes: false });
  const halfwayRecord = teamStore.byPath(halfway.cwd);
  await writeFile(path.join(halfway.cwd, 'docs', 'a-junta.md'), 'intro\nfin.\n\n## Nueva\n');
  await writeFile(path.join(team, 'docs', 'a-junta.md'), 'intro\nfin, alargado.\n');
  await writeFile(path.join(halfway.cwd, 'docs', 'z-traba.md'), 'nueva en la rama\n');
  await mkdir(path.join(team, 'docs', 'z-traba.md'), { recursive: true });
  const failed = await errorKey(() => notesService.remove(halfwayRecord.id, false, () => {}));
  const juntada = 'intro\nfin, alargado.\n\n## Nueva\n';
  check('H14 quitar falla a mitad: la nota juntada ya está en la principal, y su origen nuevo quedó anotado',
    failed === 'worktreeNotesFailed' && (await readFile(path.join(team, 'docs', 'a-junta.md'), 'utf8')) === juntada &&
      teamStore.get(halfwayRecord.id)?.copied.find((entry) => entry.path === 'docs/a-junta.md')?.hash ===
        include.hashOf(await readFile(path.join(halfway.cwd, 'docs', 'a-junta.md'))) && existsSync(halfway.cwd),
    failed);
  await rm(path.join(team, 'docs', 'z-traba.md'), { recursive: true });
  const retried = await notesService.remove(halfwayRecord.id, false, () => {});
  check('H15 al reintentar, la juntada no vuelve a juntarse (nada repetido) y la otra llega',
    retried.returned === 1 && (await readFile(path.join(team, 'docs', 'a-junta.md'), 'utf8')) === juntada &&
      (await readFile(path.join(team, 'docs', 'z-traba.md'), 'utf8')) === 'nueva en la rama\n' && !existsSync(halfway.cwd),
    JSON.stringify(retried));

  // Un CLAUDE.md versionado no es una nota: lo lleva git. Integrar no avisa que "se queda en la rama".
  git(team, 'add', '-f', 'CLAUDE.md');
  git(team, 'commit', '-q', '-m', 'CLAUDE.md versionado');
  const tracked = await notesService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/versionado-h', base: 'main', mode: 'new', copyNotes: true });
  const trackedRecord = teamStore.byPath(tracked.cwd);
  await writeFile(path.join(tracked.cwd, 'CLAUDE.md'), `${await readFile(path.join(tracked.cwd, 'CLAUDE.md'), 'utf8')}una regla de la rama\n`);
  git(tracked.cwd, 'add', 'CLAUDE.md');
  git(tracked.cwd, 'commit', '-q', '-m', 'regla');
  const trackedRemove = await notesService.planRemove(trackedRecord.id);
  const trackedPlan = await notesService.planIntegrate(trackedRecord.id);
  check('H16 un CLAUDE.md versionado no cuenta como nota, ni al quitar ni al integrar',
    !trackedRemove.conflicts.includes('CLAUDE.md') && !trackedRemove.returning.includes('CLAUDE.md') && trackedPlan.notes === null,
    JSON.stringify({ conflicts: trackedRemove.conflicts, notes: trackedPlan.notes }));
  const trackedOutcome = await notesService.integrate(trackedRecord.id, trackedPlan.branchCommit ?? undefined);
  check('H17 y git lo integra: la principal tiene la regla de la rama, sin aviso de notas',
    trackedOutcome.notes === undefined && (await readFile(path.join(team, 'CLAUDE.md'), 'utf8')).includes('una regla de la rama'));
  await notesService.remove(trackedRecord.id, false, () => {});

  // "Pedirle al agente que las junte" (pedido del usuario el 21-10-2026): el agente junta editando, no copiando,
  // y la rama guarda líneas que la principal ya no tiene. Antes la pregunta no se iba nunca.
  await writeFile(path.join(team, 'docs', 'pedido.md'), '- [ ] tarea\n');
  const asking = await notesService.create({ source: { kind: 'project', projectKey: 'equipo' }, branch: 'feat/pedido-h', base: 'main', mode: 'new', copyNotes: false });
  const askingRecord = teamStore.byPath(asking.cwd);
  const branchVersion = '- [x] tarea (de la rama)\n';
  await writeFile(path.join(asking.cwd, 'docs', 'pedido.md'), branchVersion);
  await writeFile(path.join(team, 'docs', 'pedido.md'), '- [ ] tarea (de la principal)\n');
  plan = await notesService.planRemove(askingRecord.id);
  const askedText = (await notesService.notesRequest(askingRecord.id)).text;
  const savedAsk = parseWorktreesState(await readFile(path.join(root, 'appdata', 'worktrees-equipo.json'), 'utf8'))
    .find((candidate) => candidate.id === askingRecord.id)?.notesAsked;
  check('H18 al pedirle al agente que la junte, se anota cómo estaba en los dos lados, también en disco',
    JSON.stringify(plan.conflicts) === JSON.stringify(['docs/pedido.md']) && askedText.includes('docs/pedido.md') &&
      savedAsk?.length === 1 && savedAsk[0].path === 'docs/pedido.md' && savedAsk[0].branch === include.hashOf(Buffer.from(branchVersion)) &&
      savedAsk[0].main === include.hashOf(Buffer.from('- [ ] tarea (de la principal)\n')),
    JSON.stringify(savedAsk));
  plan = await notesService.planRemove(askingRecord.id);
  check('H19 mientras la principal no cambie, el agente no la juntó: se sigue preguntando',
    JSON.stringify(plan.conflicts) === JSON.stringify(['docs/pedido.md']) && plan.resolved.length === 0 && ui.removeAction(plan) === 'ask-notes');
  // Lo que hace el agente: la junta a su manera en la principal, sin copiar la línea de la rama tal cual.
  const joinedByAgent = '- [x] tarea (de la rama, con lo de la principal)\n';
  await writeFile(path.join(team, 'docs', 'pedido.md'), joinedByAgent);
  plan = await notesService.planRemove(askingRecord.id);
  check('H20 la principal cambió y la rama no: la juntó el agente, no frena y el botón quita',
    plan.conflicts.length === 0 && JSON.stringify(plan.resolved) === JSON.stringify(['docs/pedido.md']) &&
      !plan.returning.includes('docs/pedido.md') && ui.removeAction(plan) === 'remove' &&
      shared.parseWorktreeRemovePlan(JSON.parse(JSON.stringify(plan)))?.resolved.length === 1,
    JSON.stringify(plan));
  await writeFile(path.join(asking.cwd, 'docs', 'pedido.md'), '- [x] tarea (la rama siguió)\n');
  const branchMoved = await notesService.planRemove(askingRecord.id);
  await writeFile(path.join(asking.cwd, 'docs', 'pedido.md'), branchVersion);
  check('H21 si la rama la cambia después del pedido, se vuelve a preguntar',
    JSON.stringify(branchMoved.conflicts) === JSON.stringify(['docs/pedido.md']) && branchMoved.resolved.length === 0);

  // Integrar: la juntada no viaja ni "se queda", y su versión de la rama pasa a ser el origen.
  await writeFile(path.join(asking.cwd, 'pedido.txt'), 'p\n');
  git(asking.cwd, 'add', 'pedido.txt');
  git(asking.cwd, 'commit', '-q', '-m', 'pedido');
  const askPlan = await notesService.planIntegrate(askingRecord.id);
  const askOutcome = await notesService.integrate(askingRecord.id, askPlan.branchCommit ?? undefined);
  check('H22 integrar: la que juntó el agente no viaja ni se queda en la rama, y la principal queda como la dejó',
    JSON.stringify(askPlan.notes?.resolved) === JSON.stringify(['docs/pedido.md']) && askPlan.notes?.conflicts.length === 0 &&
      (askOutcome.notes?.stayed ?? []).length === 0 && (await readFile(path.join(team, 'docs', 'pedido.md'), 'utf8')) === joinedByAgent &&
      teamStore.get(askingRecord.id)?.copied.find((entry) => entry.path === 'docs/pedido.md')?.hash === include.hashOf(Buffer.from(branchVersion)),
    JSON.stringify({ notes: askPlan.notes, outcome: askOutcome }));
  const askRemoval = await notesService.remove(askingRecord.id, false, () => {});
  check('H23 quitada sin preguntar: la nota que juntó el agente queda como estaba',
    askRemoval.discarded === 0 && (await readFile(path.join(team, 'docs', 'pedido.md'), 'utf8')) === joinedByAgent && !existsSync(asking.cwd),
    JSON.stringify(askRemoval));
}

// ---------------------------------------------------------------------------
// M. Las piezas puras del hito 49
// ---------------------------------------------------------------------------

{
  const tree = 'a'.repeat(40);
  check('M1 merge-tree: limpio, choca, y lo demás no se sabe',
    JSON.stringify(wtGit.parseMergeTree({ code: 0, stdout: `${tree}\0`, stderr: '' })) === JSON.stringify({ clean: true, files: [] }) &&
      JSON.stringify(wtGit.parseMergeTree({ code: 1, stdout: `${tree}\0a.txt\0b.bin\0a.txt\0`, stderr: '' })) === JSON.stringify({ clean: false, files: ['a.txt', 'b.bin'] }) &&
      wtGit.parseMergeTree({ code: 1, stdout: '', stderr: 'merge-tree: nope - not something we can merge' }) === null &&
      wtGit.parseMergeTree({ code: 128, stdout: '', stderr: 'fatal: refusing to merge unrelated histories' }) === null);
  check('M2 la carpeta de objetos va entre comillas sólo si trae el separador',
    wtGit.alternatesValue('D:\\Agent Explorer\\.git\\objects', 'win32') === 'D:\\Agent Explorer\\.git\\objects' &&
      wtGit.alternatesValue('D:\\a;b\\.git\\objects', 'win32') === '"D:\\\\a;b\\\\.git\\\\objects"' &&
      wtGit.alternatesValue('/x:y/.git/objects', 'linux') === '"/x:y/.git/objects"');
  check('M3 name-status -z, con un renombre que trae dos rutas',
    JSON.stringify(wtGit.parseNameStatusZ('M\0a.txt\0R087\0viejo.txt\0nuevo.txt\0A\0b.txt\0D\0c.txt\0')) ===
      JSON.stringify([
        { path: 'a.txt', oldPath: null, kind: 'modified' },
        { path: 'nuevo.txt', oldPath: 'viejo.txt', kind: 'renamed' },
        { path: 'b.txt', oldPath: null, kind: 'added' },
        { path: 'c.txt', oldPath: null, kind: 'deleted' },
      ]));
  const files = [{ path: 'docs/a.md', oldPath: null, kind: 'added' }, { path: 'nuevo.txt', oldPath: 'viejo.txt', kind: 'renamed' }];
  check('M4 lo local que toca la rama: una carpeta nueva entera y la ruta de antes de un renombre',
    JSON.stringify(overlap.pathsTouching(['docs/', 'viejo.txt', 'otro.txt'], files)) === JSON.stringify(['docs/', 'viejo.txt']));
  check('M5 las ramas que comparten archivos, con tope',
    JSON.stringify(overlap.overlapsFor('a', [{ branch: 'a', files }, { branch: 'b', files: [{ path: 'viejo.txt', oldPath: null, kind: 'modified' }] }, { branch: 'c', files: [] }], 8)) ===
      JSON.stringify([{ branch: 'b', files: ['viejo.txt'], fileCount: 1 }]));
  check('M6 el veredicto: sólo la última línea, con o sin marcado',
    review.readVerdict('bien\nVerdict: ready to integrate') === 'ready' &&
      review.readVerdict('- **`Verdict: needs changes`.**') === 'changes' &&
      review.readVerdict('Verdict: ready to integrate\nPero mirá esto.') === 'none' &&
      review.readVerdict('verdict:   READY TO INTEGRATE') === 'ready' &&
      review.readVerdict('Veredicto: listo') === 'none' && review.readVerdict(null) === 'none');
  check('M6b el veredicto como título o dentro de un bloque de código',
    review.readVerdict('Hallazgos.\n\n## Verdict: needs changes') === 'changes' &&
      review.readVerdict('Hallazgos.\n\n```\nVerdict: ready to integrate\n```\n') === 'ready' &&
      review.readVerdict('```\n```') === 'none');
  check('M7 la última respuesta: lo que dijo después de la última herramienta, entero',
    review.lastReplyText([say('user', said('x')), say('assistant', said('antes'), toolCall), say('user', toolResult), say('assistant', said('uno')), say('assistant', said('dos'))]) === 'uno\n\ndos' &&
      review.lastReplyText([say('user', said('x'))]) === null);
  check('M7b si lo último que dijo vino con una herramienta, eso es la respuesta, no un texto vacío',
    review.lastReplyText([say('user', said('x')), say('assistant', said('Verdict: ready to integrate'), toolCall)]) === 'Verdict: ready to integrate');
  check('M8 los pedidos van en inglés y nombran la rama y la base',
    reviewPrompt('fix-login', 'main').startsWith('Review the work on this branch, `fix-login`, against `main`.') &&
      reviewPrompt('fix-login', 'main').endsWith('`Verdict: ready to integrate` or `Verdict: needs changes`.') &&
      catchUpPrompt('main', [], 0) === "Bring this branch up to date with `main`: run `git rebase main`, resolve any conflicts, run the checks again, and tell me when it's done." &&
      /^A reviewer went over this branch/.test(sendBackPrompt()));
  const candidates = (pairs) => pairs.map(([id, guard]) => ({ id, guard }));
  check('M9 quién revisa por defecto: otra CLI, la que mejor se protege; con una sola, esa',
    shared.defaultReviewer('claude-code', candidates([['claude-code', 'cli'], ['codex', 'cli'], ['opencode', null]])) === 'codex' &&
      shared.defaultReviewer('codex', candidates([['claude-code', 'cli'], ['codex', 'cli']])) === 'claude-code' &&
      shared.defaultReviewer('claude-code', candidates([['claude-code', 'cli'], ['opencode', null], ['pi', 'tools']])) === 'pi' &&
      shared.defaultReviewer('claude-code', candidates([['claude-code', 'cli']])) === 'claude-code' &&
      shared.defaultReviewer(null, candidates([['opencode', null], ['codex', 'cli']])) === 'codex' &&
      shared.defaultReviewer(null, []) === null);

  // La web: lo que dice cada fila, en español.
  const row = {
    id: 'x', path: 'D:\\x', branch: 'feat/a', base: 'main', isCurrent: false, isMain: false, changes: 0, ahead: 1, integrated: false,
    behind: 2, merge: { state: 'conflicts', files: ['App.tsx', 'styles.css'], fileCount: 3 },
    overlaps: [{ branch: 'fix-login', files: ['src/App.tsx'], fileCount: 1 }], review: null,
  };
  check('M10 la fila: la base avanzó, choca, y otra rama toca lo mismo',
    JSON.stringify(ui.rowTeamLines(row)) === JSON.stringify(['main avanzó 2 commits · choca en 3 archivos: App.tsx y styles.css…', 'también lo toca fix-login: App.tsx']),
    JSON.stringify(ui.rowTeamLines(row)));
  check('M11 integrar se apaga con la base adelante o sin nada, con el porqué',
    ui.rowIntegrateBlocker(row) === 'main avanzó: primero ponte al día.' && ui.rowIntegrateBlocker({ ...row, behind: 0, ahead: 0 }) !== null &&
      ui.rowIntegrateBlocker({ ...row, behind: 0 }) === null);
  const summary = { agent: 'codex', state: 'done', verdict: 'changes', stale: true, requestedAt: 0, terminalId: null };
  check('M12 la revisión, en palabras', ui.reviewText(summary, 'Codex') === 'Revisión de Codex: pide cambios (de un commit anterior)' &&
    ui.reviewText({ ...summary, state: 'working', verdict: null, stale: false }, 'Codex') === 'Revisión de Codex: en curso', ui.reviewText(summary, 'Codex'));
  check('M13 cómo arranca cada CLI para revisar',
    ui.reviewGuardText({ readOnlyLaunch: { mode: null, guard: 'cli' } }, 'Codex').includes('solo lectura') &&
      ui.reviewGuardText({ readOnlyLaunch: { mode: null, guard: 'tools' } }, 'Pi').includes('consola') &&
      ui.reviewGuardText({ readOnlyLaunch: null }, 'OpenCode').startsWith('OpenCode puede editar'));
  const actionsOf = (candidate) => Object.entries(ui.rowActions(candidate)).filter(([, on]) => on).map(([name]) => name).sort().join(' ');
  const oldServerRow = { ...row, behind: null, merge: null, overlaps: [], review: null };
  check('M16 las acciones del hito 49 sólo con un servidor que las conoce (el del 48 no manda `behind`)',
    actionsOf(oldServerRow) === '' && actionsOf(row) === 'catchUp integrate review viewChanges' &&
      actionsOf({ ...row, review: { ...summary, stale: false } }) === 'catchUp integrate review sendReview viewChanges' &&
      actionsOf({ ...row, id: null }) === '',
    `${actionsOf(oldServerRow)} | ${actionsOf(row)}`);

  // Sin carpeta temporal donde poner los objetos, el choque no se sabe: no tumba las filas.
  const savedTemp = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  const missing = path.join(root, 'no-existe', 'temporal');
  Object.assign(process.env, { TEMP: missing, TMP: missing, TMPDIR: missing });
  let noTemp;
  try {
    noTemp = await wtGit.mergeTreeCheck(team, 'main', 'feat/a').then((value) => ({ value }), (error) => ({ error: String(error) }));
  } finally {
    for (const [key, value] of Object.entries(savedTemp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  check('M14 sin carpeta temporal, el choque queda sin saber y no falla', os.tmpdir() !== missing && noTemp?.value === null, JSON.stringify(noTemp));

  // Una etiqueta con el nombre de la rama sacada: el nombre de la rama sigue siendo el suyo.
  const tagRepo = await mkdtemp(path.join(root, 'etiqueta-'));
  git(tagRepo, 'init', '-q', '-b', 'main');
  git(tagRepo, 'commit', '-q', '--allow-empty', '-m', 'base');
  git(tagRepo, 'tag', 'main');
  check('M15 la rama sacada, con una etiqueta del mismo nombre', (await wtGit.currentBranch(tagRepo)) === 'main', String(await wtGit.currentBranch(tagRepo)));
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
// J. Juntar las dos versiones de una nota (puro, 21-10-2026)
// ---------------------------------------------------------------------------

{
  const join = (base, main, branch) =>
    mergeNotes.mergeNote(Buffer.from(base, 'latin1'), Buffer.from(main, 'latin1'), Buffer.from(branch, 'latin1'))?.toString('latin1') ?? null;
  check('J1 cambios en partes distintas: van los dos', join('a\nb\nc\nd\ne\n', 'A\nb\nc\nd\ne\n', 'a\nb\nc\nd\nE\n') === 'A\nb\nc\nd\nE\n');
  check('J1b dos líneas vecinas cambiadas, una en cada lado: no chocan', join('a\nb\nc\n', 'A\nb\nc\n', 'a\nB\nc\n') === 'A\nB\nc\n');
  check('J2 pegados no chocan: el párrafo alargado y la sección de abajo, en ese orden',
    join('intro\nfin.\n', 'intro\nfin, alargado.\n', 'intro\nfin.\n\n## Nueva\n') === 'intro\nfin, alargado.\n\n## Nueva\n');
  check('J3 dos agregados en el mismo lugar van los dos, primero el de la principal',
    join('- uno\n', '- uno\n- de la principal\n', '- uno\n- de la rama\n') === '- uno\n- de la principal\n- de la rama\n');
  check('J4 el mismo cambio en los dos lados va una vez', join('a\nb\n', 'a\nB\n', 'a\nB\n') === 'a\nB\n');
  check('J5 la misma línea cambiada distinto en cada lado choca', join('a\nb\n', 'a\nB1\n', 'a\nB2\n') === null);
  check('J6 un agregado adentro de lo que el otro reemplazó choca', join('a\nb\nc\n', 'a\nX\n', 'a\nb\nnueva\nc\n') === null);
  check('J7 una CLI que reescribió con \\n una nota con \\r\\n no la cambió: se junta lo demás, con el fin de línea de la principal',
    join('a\r\nb\r\nc\r\n', 'A\r\nb\r\nc\r\n', 'a\nb\nc\nd\n') === 'A\r\nb\r\nc\r\nd\r\n');
  check('J7b si la que pasó la nota a \\n es la principal, la junta no la devuelve a medias a \\r\\n',
    join('a\r\nb\r\nc\r\nd\r\n', 'A\nb\nc\nd\n', 'a\r\nb\r\nc\r\nD\r\n') === 'A\nb\nc\nD\n');
  check('J8 sin fin de línea al final, lo agregado no se pega a la última línea', join('a\nb', 'a\nb\nc', 'z\na\nb') === 'z\na\nb\nc');
  // Y cuando la última línea sin terminar sale de la principal, que no la cambió, y la rama agrega detrás.
  check('J8b tampoco si la principal agrega arriba y la rama agrega al final', join('a\nb', 'x\na\nb', 'a\nb\nc') === 'x\na\nb\nc');
  const many = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix}${index}\n`).join('');
  check('J9 pasado el tope de lo que se compara, no se junta: se pregunta',
    mergeNotes.lineChanges(['x\n'], Array.from({ length: 50 }, (_, index) => `${index}\n`), 10) === null &&
      join(many(3000, 'a'), many(3000, 'b'), `${many(3000, 'a')}extra\n`) === null);

  // El cálculo, contra lo que tiene que dar en cualquier caso: con un generador fijo, siempre los mismos.
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const randomLines = () => Array.from({ length: Math.floor(random() * 12) }, () => `${'abcd'[Math.floor(random() * 4)]}\n`);
  let wrongDiff = 0;
  let wrongMerge = 0;
  for (let round = 0; round < 500; round += 1) {
    const a = randomLines();
    const b = randomLines();
    const changes = mergeNotes.lineChanges(a, b);
    if (changes === null || mergeNotes.applyChanges(a, changes).join('') !== b.join('')) wrongDiff += 1;
    if (join(a.join(''), a.join(''), b.join('')) !== b.join('') || join(a.join(''), b.join(''), a.join('')) !== b.join('')) wrongMerge += 1;
  }
  check('J10 aplicar los cambios de una versión hacia otra da la otra (500 al azar)', wrongDiff === 0, String(wrongDiff));
  check('J11 juntar con un lado sin cambios da el otro (500 al azar)', wrongMerge === 0, String(wrongMerge));

  const text = (value) => Buffer.from(value, 'utf8');
  const origin = text('- uno\n- dos\n');
  const originHash = include.hashOf(origin);
  const outcome = include.noteOutcome(originHash, text('- [x] uno\n- dos\n'), text('- uno\n- dos\n- tres\n'), origin);
  check('J12 con la copia de origen, lo que cambió en los dos lados se junta',
    outcome.verdict === 'merge' && outcome.content?.toString('utf8') === '- [x] uno\n- dos\n- tres\n');
  // Con la principal como origen, juntar daría la rama entera y pisaría lo de la principal: tiene que chocar.
  check('J13 una copia que no es la de esa huella no se usa: choca, como antes',
    include.noteVerdict(originHash, text('- [x] uno\n- dos\n'), text('- uno\n- dos\n- tres\n'), text('- uno\n- dos\n- tres\n')) === 'conflict');
  check('J14 si juntas dan la principal, no hay nada que traer',
    include.noteVerdict(originHash, text('- [x] uno\n- dos\n'), text('- [x] uno\n- dos\n- tres\n'), origin) === 'unchanged');
  const asked = { branch: include.hashOf(text('- [x] rama\n')), main: include.hashOf(text('- principal\n')) };
  check('J14b pedida al agente: si la principal cambió y la rama no, la juntó; si no, se sigue preguntando',
    include.noteVerdict(originHash, text('- [x] rama\n'), text('- juntas\n'), null, asked) === 'resolved' &&
      include.noteVerdict(originHash, text('- [x] rama\n'), text('- principal\n'), null, asked) === 'conflict' &&
      include.noteVerdict(originHash, text('- [x] otra\n'), text('- juntas\n'), null, asked) === 'conflict');
  check('J15 se guarda la copia de una nota de texto, nunca de un .env, un binario ni algo enorme',
    keepsNoteBase('docs/a.md', text('a\n')) && keepsNoteBase('NOTAS.TXT', text('a\n')) && !keepsNoteBase('.env', text('A=1\n')) &&
      !keepsNoteBase('docs/clave.env', text('A=1\n')) && !keepsNoteBase('docs/a.md', Buffer.from([97, 0, 98])) &&
      !keepsNoteBase('docs/a.md', Buffer.alloc(NOTE_BASE_MAX_BYTES + 1, 97)));

  const basesDir = path.join(root, 'copias-j');
  const bases = new NoteBases(basesDir, { graceMs: 0 });
  await bases.save('a.md', text('hola\n'));
  await bases.save('b.md', text('chau\n'));
  await bases.save('.env', text('TOKEN=x\n'));
  const hola = include.hashOf(text('hola\n'));
  const chau = include.hashOf(text('chau\n'));
  await writeFile(path.join(basesDir, hola), 'cambiada\n');
  check('J16 una copia que alguien cambió no se usa, y una huella que no es una huella no se busca',
    (await bases.load(hola)) === null && (await bases.load('../worktrees.json')) === null && (await readdir(basesDir)).length === 2);
  await bases.save('a.md', text('hola\n'));
  await writeFile(path.join(basesDir, 'LEEME.txt'), 'no es una copia\n');
  await bases.prune(new Set([hola]));
  check('J17 se vuelve a guardar bien, y limpiar deja sólo las que se nombran, sin tocar lo demás',
    (await bases.load(hola))?.toString('utf8') === 'hola\n' && (await bases.load(chau)) === null && existsSync(path.join(basesDir, 'LEEME.txt')));
  const fresh = new NoteBases(basesDir);
  await fresh.save('c.md', text('recien\n'));
  await fresh.prune(new Set());
  check('J18 lo recién guardado no se limpia: una rama que se está creando todavía no está en el registro',
    (await fresh.load(include.hashOf(text('recien\n'))))?.toString('utf8') === 'recien\n');
  // Una copia vieja que otra rama nueva vuelve a necesitar: guardarla otra vez le renueva la fecha.
  const viejo = include.hashOf(text('compartida\n'));
  await fresh.save('d.md', text('compartida\n'));
  const anHourAgo = new Date(Date.now() - 3_600_000);
  await utimes(path.join(basesDir, viejo), anHourAgo, anHourAgo);
  await fresh.save('e.md', text('compartida\n'));
  await fresh.prune(new Set());
  check('J19 una copia que ya estaba y se vuelve a guardar tampoco se limpia enseguida',
    (await fresh.load(viejo))?.toString('utf8') === 'compartida\n');

  // Juntar otra vez sobre lo ya juntado (si no se llegó a anotar el origen nuevo, o alguien lo pasó a mano):
  // lo de la rama no se repite, en las formas de una nota que crece.
  const once = (base, main, branch) => join(base, join(base, main, branch) ?? '', branch);
  check('J20 juntar otra vez la bitácora y la lista da lo mismo: nada repetido',
    once('intro\nfin.\n', 'intro\nfin, alargado.\n', 'intro\nfin.\n\n## Nueva\n') === 'intro\nfin, alargado.\n\n## Nueva\n' &&
      once('- uno\n', '- uno\n- de la principal\n', '- uno\n- de la rama\n') === '- uno\n- de la principal\n- de la rama\n' &&
      join('- uno\n', '- uno\n- de la rama\n- de la principal\n', '- uno\n- de la rama\n') === '- uno\n- de la rama\n- de la principal\n');
}

// ---------------------------------------------------------------------------
// D. El diálogo de quitar: un solo botón principal, y siempre hace algo
//    (21-10-2026)
// ---------------------------------------------------------------------------

{
  const plan = {
    id: 'w', branch: 'fix/comp', path: 'D:\\x', commands: [], uncommitted: [], uncommittedCount: 0, tabs: [],
    returning: [], merging: [], conflicts: [], inUse: false, deletesBranch: true, branchUnused: false, createdBranch: true,
  };
  check('D1 sin nada que frene, el botón quita', ui.removeAction(plan) === 'remove');
  check('D2 con algo que frena, el botón lo destraba: commitear, volver a intentar o juntar las notas',
    ui.removeAction({ ...plan, uncommitted: ['a.ts'], uncommittedCount: 1 }) === 'ask-commit' &&
      ui.removeAction({ ...plan, inUse: true }) === 'retry' &&
      ui.removeAction({ ...plan, conflicts: ['CHECKLIST.md'] }) === 'ask-notes' &&
      ui.removeAction({ ...plan, uncommittedCount: 1, conflicts: ['CHECKLIST.md'] }) === 'ask-commit');
  check('D3 qué pasa con la carpeta y con la rama, en cada caso',
    ui.removeFateText(plan).startsWith('Ya está integrada') &&
      ui.removeFateText({ ...plan, branchUnused: true }).startsWith('No tiene commits propios') &&
      ui.removeFateText({ ...plan, deletesBranch: false }).startsWith('Todavía no está integrada') &&
      ui.removeFateText({ ...plan, deletesBranch: false, createdBranch: false }).startsWith('La rama fix/comp ya existía'));
  const fromOld = shared.parseWorktreeRemovePlan(JSON.parse(JSON.stringify({ ...plan, returning: ['a.md'], merging: undefined, createdBranch: undefined })));
  const fromNew = shared.parseWorktreeRemovePlan({ ...plan, returning: ['a.md'], merging: ['a.md', 'otra.md'], createdBranch: false });
  check('D4 el plan de un servidor anterior: ninguna se junta y la rama es de la app; una que se junta tiene que volver',
    fromOld?.merging.length === 0 && fromOld.createdBranch === true &&
      JSON.stringify(fromNew?.merging) === JSON.stringify(['a.md']) && fromNew.createdBranch === false);
  const integratePlan = {
    id: 'w', branch: 'b', base: 'main', baseFolder: 'D:\\x', command: 'git merge --ff-only b', branchCommit: null, ahead: 1, behind: 0,
    files: [], fileCount: 0, review: null, tabs: [], localConflicts: [], branchUncommitted: 0, blocker: null,
  };
  check('D5 el plan de integrar sin notas (un servidor anterior) y con ellas',
    shared.parseWorktreeIntegratePlan(integratePlan)?.notes === null &&
      JSON.stringify(shared.parseWorktreeIntegratePlan({ ...integratePlan, notes: { returning: ['a.md'], conflicts: [] } })?.notes) ===
        JSON.stringify({ returning: ['a.md'], merging: [], resolved: [], conflicts: [] }));
  check('D6 lo que integrar dice de las notas viaja, y sin ellas no aparece',
    shared.parseWorktreeIntegrateOutcome({ commits: 1, base: 'main' })?.notes === undefined &&
      JSON.stringify(shared.parseWorktreeIntegrateOutcome({ commits: 1, base: 'main', notes: { returned: 2, stayed: ['a.md'] } })?.notes) ===
        JSON.stringify({ returned: 2, stayed: ['a.md'] }));
  check('D7 el pedido de commitear nombra los archivos y cuántos más hay, y no sube nada',
    review.commitPrompt(['a.ts', 'b.ts'], 5).includes('a.ts, b.ts and 3 more') && review.commitPrompt(['a.ts'], 1).includes("Don't push") &&
      !review.commitPrompt(['a.ts'], 1).includes('more'));
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

  // Hito 49: los pedidos nombran la rama por su id, y sólo `changesDiff` una ruta, que el servidor valida.
  const review = shared.parseClientMessage(JSON.stringify({ type: 'worktree.requestReview', requestId: 'r', worktreeId: 'w', agent: 'no-existe', label: 'x', path: 'C:\\x' }));
  check('E5 pedir revisión con una CLI desconocida se conserva para rechazarla, y nada más viaja',
    review?.type === 'worktree.requestReview' && review.unsupportedAgent === 'no-existe' &&
      JSON.stringify(Object.keys(review).sort()) === JSON.stringify(['agent', 'requestId', 'type', 'unsupportedAgent', 'worktreeId']));
  const simple = ['worktree.changes', 'worktree.planReview', 'worktree.sendReview', 'worktree.catchUp', 'worktree.askCommit', 'worktree.planIntegrate', 'worktree.integrate'];
  check('E6 los pedidos del hito 49 con id y sin él',
    simple.every((type) => shared.parseClientMessage(JSON.stringify({ type, requestId: 'r', worktreeId: 'w' }))?.type === type &&
      shared.parseClientMessage(JSON.stringify({ type, requestId: 'r' })) === null) &&
      shared.parseClientMessage(JSON.stringify({ type: 'worktree.changesDiff', requestId: 'r', worktreeId: 'w' })) === null);
  const oldRow = shared.parseWorktreeRow({ path: 'D:\\x', branch: 'b', id: 'w', base: 'main', isCurrent: false, isMain: false, changes: 0, ahead: 1, integrated: false });
  check('E7 una fila de un servidor del hito 48: sin base, choque, avisos ni revisión',
    oldRow?.behind === null && oldRow.merge === null && oldRow.overlaps.length === 0 && oldRow.review === null);
  const badReview = shared.parseWorktreeRow({ ...oldRow, review: { agent: 'codex', state: 'otro', requestedAt: 0 } });
  check('E8 una revisión con un estado que no se conoce se descarta, la fila no', badReview !== null && badReview.review === null);
  const prefill = shared.parseServerMessage(JSON.stringify({ type: 'composer.prefill', terminalId: 't', text: 'x', reason: 'requested', pasted: ['notas'] }));
  const badPrefill = shared.parseServerMessage(JSON.stringify({ type: 'composer.prefill', terminalId: 't', text: 'x', reason: 'requested', pasted: [1] }));
  check('E9 las fichas de un prellenado viajan, y una que no es texto lo invalida', JSON.stringify(prefill?.pasted) === JSON.stringify(['notas']) && badPrefill === null);
  check('E10 un descriptor sin la marca de revisión no es de revisión', descriptor?.review === false);
  const commit = 'c'.repeat(40);
  const integrate = shared.parseClientMessage(JSON.stringify({ type: 'worktree.integrate', requestId: 'r', worktreeId: 'w', branchCommit: commit }));
  check('E11 integrar lleva la punta que vio el plan, y una que no es un commit lo invalida',
    integrate?.type === 'worktree.integrate' && integrate.branchCommit === commit &&
      shared.parseClientMessage(JSON.stringify({ type: 'worktree.integrate', requestId: 'r', worktreeId: 'w', branchCommit: 'main' })) === null);
  const answered = shared.parseServerMessage(JSON.stringify({ type: 'composer.prefill', terminalId: 't', text: 'x', reason: 'requested', requestId: 'r' }));
  const oldPlan = shared.parseWorktreeIntegratePlan({
    id: 'w', branch: 'b', base: 'main', baseFolder: 'D:\\x', command: 'git merge --ff-only b', ahead: 1, behind: 0, files: ['a'], fileCount: 1,
    review: null, tabs: [], localConflicts: [], branchUncommitted: 0, blocker: null,
  });
  check('E12 el prellenado dice a qué pedido contesta, y el plan de un servidor anterior no trae la punta',
    answered?.type === 'composer.prefill' && answered.requestId === 'r' && oldPlan !== null && oldPlan.branchCommit === null);
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
  check('G3 worktrees/git.ts escribe sólo worktree add, worktree remove, branch -d y merge --ff-only',
    JSON.stringify(ownWrites) === JSON.stringify(['add', 'add', 'merge', 'remove']) && /\['branch', '-d', branch\]/.test(own) &&
      /\['merge', '--ff-only', target\]/.test(own),
    ownWrites.join(' '));
  check('G4 nunca --force, -D, -f, --no-ff ni --squash', !/'--force'|'-D'|'-f'|'--no-ff'|'--squash'/.test(own));
  check('G5 los cuatro corren por el camino que escribe, y nada más', (own.match(/write: true/g) ?? []).length === 4);
  const callers = [...sources].filter(([name, text]) => name !== 'worktrees/git.ts' && /\b(addWorktree|removeWorktree|deleteBranch|fastForward)\(/.test(text)).map(([name]) => name);
  check('G6 sólo el servicio los llama', JSON.stringify(callers) === JSON.stringify(['worktrees/service.ts']), callers.join(' '));
  // El rebase de ponerse al día lo hace el agente en su terminal, nunca la app (decisión 2 del hito 49).
  const rebasing = [...sources].filter(([, text]) => /'rebase'|"rebase"/.test(text)).map(([name]) => name);
  check('G7 ningún archivo del servidor arma un rebase', rebasing.length === 0, rebasing.join(' '));
}

for (const child of children) child.kill();
await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
