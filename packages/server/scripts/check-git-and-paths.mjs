/**
 * Chequeo del parseo de git y del guardia de rutas.
 *
 *   npx tsx scripts/check-git-and-paths.mjs [carpeta-temporal]
 *
 * Cubre las dos cosas del Hito 4 que fallan en silencio:
 *
 *  - **El parser de `--porcelain=v2 -z`.** Un registro de rename se lleva un
 *    campo extra; si no se consume, el parser se desincroniza y a partir de ahi
 *    interpreta rutas como registros. El sintoma es una lista de cambios que se
 *    ve casi bien, que es peor que una que se ve mal.
 *  - **El guardia de rutas.** Es lo unico que impide que una ruta del cliente
 *    lea fuera del `cwd` de la pestana, y un agujero ahi no se nota nunca
 *    usando la app normalmente.
 *
 * Trabaja sobre una carpeta temporal propia y no toca ningun repositorio real.
 */

import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parsePorcelainV2, parseUnifiedDiff, parseWorktreeListZ, parseWorktrees } from '../src/git-repo.ts';
import { InvalidPathError, resolveInside } from '../src/path-guard.ts';
import { NO_CLI_FOLDERS } from '../src/cli-folders.ts';
import { existingFiles } from '../src/file-browser.ts';

const dir = process.argv[2] ?? path.join(process.cwd(), '.check-git');
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

// ---------------------------------------------------------------------------
// porcelain v2
// ---------------------------------------------------------------------------

const NUL = '\0';
const status = [
  '# branch.oid abcdef1234567890',
  '# branch.head feat/milestone-4',
  '# branch.upstream origin/feat/milestone-4',
  '# branch.ab +3 -2',
  '1 M. N... 100644 100644 100644 aaa bbb src/preparado.ts',
  '1 .M N... 100644 100644 100644 aaa bbb src/sin-preparar.ts',
  '1 MM N... 100644 100644 100644 aaa bbb src/los dos.ts',
  '2 R. N... 100644 100644 100644 aaa bbb R100 src/nuevo.ts',
  'src/viejo.ts',
  '1 .D N... 100644 100644 000000 aaa bbb src/borrado.ts',
  'u UU N... 100644 100644 100644 100644 a b c src/conflicto.ts',
  '? src/sin-seguimiento.ts',
  '? "con espacios y ñ.ts"',
  '',
].join(NUL);

const parsed = parsePorcelainV2(status);

check('rama leida', parsed.branch === 'feat/milestone-4', parsed.branch ?? 'null');
check('head corto a 8', parsed.head === 'abcdef12', parsed.head ?? 'null');
check('upstream leido', parsed.upstream === 'origin/feat/milestone-4');
check('adelante/atras', parsed.ahead === 3 && parsed.behind === 2, `+${parsed.ahead} -${parsed.behind}`);

const find = (p, stage) => parsed.changes.find((c) => c.path === p && c.stage === stage);

check('preparado', find('src/preparado.ts', 'staged')?.kind === 'modified');
check('sin preparar', find('src/sin-preparar.ts', 'unstaged')?.kind === 'modified');
check(
  'MM aparece en las dos areas',
  find('src/los dos.ts', 'staged') !== undefined && find('src/los dos.ts', 'unstaged') !== undefined,
);
check('ruta con espacios entera', find('src/los dos.ts', 'staged')?.path === 'src/los dos.ts');

const renamed = find('src/nuevo.ts', 'staged');
check('rename detectado', renamed?.kind === 'renamed');
check('rename trae la ruta vieja', renamed?.oldPath === 'src/viejo.ts', renamed?.oldPath ?? 'null');

// Lo que de verdad se rompe si el campo extra del rename no se consume: todo lo
// que viene despues del rename.
check('el parser NO se desincroniza tras un rename', find('src/borrado.ts', 'unstaged')?.kind === 'deleted');
check('conflicto', find('src/conflicto.ts', 'conflict')?.kind === 'conflict');
check('sin seguimiento', find('src/sin-seguimiento.ts', 'untracked')?.kind === 'untracked');
check(
  'la ruta vieja no se cuela como cambio suelto',
  parsed.changes.every((c) => c.path !== 'src/viejo.ts'),
);
check('cantidad total de cambios', parsed.changes.length === 9, String(parsed.changes.length));

// HEAD desprendido y repo sin commits.
const detached = parsePorcelainV2(['# branch.oid (initial)', '# branch.head (detached)', ''].join(NUL));
check('HEAD desprendido -> rama null', detached.branch === null);
check('repo sin commits -> head null', detached.head === null);

// ---------------------------------------------------------------------------
// diff unificado
// ---------------------------------------------------------------------------

const diff = parseUnifiedDiff(
  [
    'diff --git a/x.ts b/x.ts',
    'index 111..222 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    '@@ -10,4 +10,5 @@ function f() {',
    ' contexto uno',
    '-borrada',
    '+agregada uno',
    '+agregada dos',
    ' contexto dos',
    '\\ No newline at end of file',
    '',
  ].join('\n'),
);

const added = diff.lines.filter((l) => l.kind === 'added');
const removed = diff.lines.filter((l) => l.kind === 'removed');
const context = diff.lines.filter((l) => l.kind === 'context');

check('diff: 2 agregadas, 1 borrada, 2 de contexto',
  added.length === 2 && removed.length === 1 && context.length === 2);
check('numeracion del hunk arranca en 10', context[0]?.oldLine === 10 && context[0]?.newLine === 10);
check('la borrada numera solo el lado viejo', removed[0]?.oldLine === 11 && removed[0]?.newLine === null);
check('la agregada numera solo el lado nuevo', added[0]?.newLine === 11 && added[0]?.oldLine === null);
check('el contexto de despues sigue las dos cuentas',
  context[1]?.oldLine === 12 && context[1]?.newLine === 13,
  `${context[1]?.oldLine}/${context[1]?.newLine}`);
check('el marcador no queda en el texto', added[0]?.text === 'agregada uno', added[0]?.text ?? '');
check('"\\ No newline" es meta, no una linea del archivo',
  diff.lines.some((l) => l.kind === 'meta' && l.text.startsWith('\\')));

// ---------------------------------------------------------------------------
// worktree list
// ---------------------------------------------------------------------------

// Hito 48: `worktree list --porcelain -z`. Campos separados por NUL, cada
// carpeta cerrada por un NUL vacio; sin `-z`, una ruta con un salto de linea
// partia el registro.
const worktreeList = [
  'worktree /repo',
  'HEAD abc',
  'branch refs/heads/main',
  '',
  'worktree /repo-wt',
  'HEAD def',
  'detached',
  '',
  'worktree /otra\ncarpeta',
  'HEAD fed',
  'branch refs/heads/feat/x',
  'locked razon',
  'prunable gitdir file points to non-existent location',
  '',
].join('\0');
const worktrees = parseWorktrees(worktreeList, '/repo');

check('tres worktrees', worktrees.length === 3, String(worktrees.length));
check('refs/heads/ recortado', worktrees[0]?.branch === 'main', worktrees[0]?.branch ?? 'null');
check('el actual se marca', worktrees[0]?.isCurrent === true && worktrees[1]?.isCurrent === false);
check('detached -> rama null', worktrees[1]?.branch === null);
check('la primera es la principal, y solo ella', worktrees[0]?.isMain === true && worktrees[1]?.isMain === false && worktrees[2]?.isMain === false);
check('una ruta con salto de linea no parte el registro', worktrees[2]?.branch === 'feat/x' && worktrees[2]?.path.includes('\n') === true, JSON.stringify(worktrees[2]));
const entries = parseWorktreeListZ(worktreeList);
check('bloqueada y podable se leen', entries[2]?.locked === true && entries[2]?.prunable === true && entries[0]?.locked === false);
const bare = parseWorktrees(['worktree /repo.git', 'bare', '', 'worktree /wt', 'HEAD a', 'branch refs/heads/b', ''].join('\0'), '/wt');
check('un repo desnudo no es una carpeta del panel', bare.length === 1 && bare[0]?.branch === 'b' && bare[0]?.isCurrent === true, JSON.stringify(bare));

// ---------------------------------------------------------------------------
// guardia de rutas
// ---------------------------------------------------------------------------

const root = path.join(dir, 'proyecto');
const outside = path.join(dir, 'afuera');
await mkdir(path.join(root, 'src'), { recursive: true });
await mkdir(outside, { recursive: true });
await writeFile(path.join(root, 'src', 'a.ts'), 'contenido');
await writeFile(path.join(outside, 'secreto.txt'), 'no se debe leer');

const accepts = async (relative, options) => {
  try {
    await resolveInside(root, relative, options);
    return true;
  } catch {
    return false;
  }
};
const rejects = async (relative, options) => {
  try {
    await resolveInside(root, relative, options);
    return false;
  } catch (error) {
    return error instanceof InvalidPathError;
  }
};

check('acepta la raiz', await accepts('', { mustExist: true }));
check('acepta un archivo interno', await accepts('src/a.ts', { mustExist: true }));
check('acepta una ruta que aun no existe', await accepts('src/todavia-no.ts', {}));
check('rechaza ..', await rejects('../afuera/secreto.txt', {}));
check('rechaza .. anidado', await rejects('src/../../afuera/secreto.txt', {}));
check('rechaza absoluta posix', await rejects('/etc/passwd', {}));
check('rechaza absoluta windows', await rejects('C:\\Windows\\System32', {}));
check('rechaza UNC', await rejects('\\\\servidor\\share', {}));
check('rechaza byte nulo', await rejects('src/a.ts\0.png', {}));
check('rechaza .. con barra invertida', await rejects('..\\afuera\\secreto.txt', {}));
check('mustExist rechaza lo que no existe', await rejects('src/fantasma.ts', { mustExist: true }));

// Un enlace dentro del proyecto que apunta afuera pasa el chequeo de texto sin
// problemas: lo unico que lo atrapa es resolver el enlace contra el disco.
let symlinkSupported = true;
try {
  await symlink(outside, path.join(root, 'atajo'), 'junction');
} catch {
  symlinkSupported = false;
}
if (symlinkSupported) {
  check('rechaza un enlace que apunta afuera', await rejects('atajo/secreto.txt', { mustExist: true }));
} else {
  console.log('OMITIDO enlace simbolico — el sistema no dejo crearlo');
}

// Cuales de las rutas que nombro el agente son archivos del proyecto (§6.33):
// lo que el hilo vuelve enlace. Pasa por el mismo guardia que leer, y lo que no
// esta, no es un archivo o cae fuera cuenta igual: no se dice cual de las tres.
const asked = [
  'src/a.ts',
  'src',
  'src/fantasma.ts',
  '../afuera/secreto.txt',
  'C:\\Windows\\win.ini',
  '/etc/passwd',
  'atajo/secreto.txt',
  'src/a.ts\0.png',
];
check('de las rutas que se preguntan, solo las que son un archivo de adentro',
  JSON.stringify(await existingFiles(root, asked, NO_CLI_FOLDERS)) === JSON.stringify(['src/a.ts']), JSON.stringify(await existingFiles(root, asked, NO_CLI_FOLDERS)));
check('sin rutas, ninguna; y con una carpeta que ya no esta, tampoco, sin lanzar',
  (await existingFiles(root, [], NO_CLI_FOLDERS)).length === 0 && (await existingFiles(path.join(dir, 'no-existe'), ['src/a.ts'], NO_CLI_FOLDERS)).length === 0);

await rm(dir, { recursive: true, force: true });

console.log(`\n${failures === 0 ? 'TODO OK' : `${failures} FALLO(S)`}`);
process.exit(failures === 0 ? 0 : 1);
