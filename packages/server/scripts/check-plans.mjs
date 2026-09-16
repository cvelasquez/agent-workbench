/**
 * Chequeo de los documentos de una sesion.
 *
 *   npx tsx scripts/check-plans.mjs [carpeta-temporal]
 *
 * Tres cosas que se rompen en silencio y por eso estan aca:
 *
 *  - **Que se detecten todos los caminos.** La CLI anuncia un plan con una
 *    linea `plan_mode` o con un `Write` a la carpeta de planes, y la sesion que
 *    motivo este panel usa el segundo. Desde el hito 31 hay dos origenes mas
 *    —el proyecto y la carpeta temporal de la sesion—, que son justamente los
 *    que el usuario no podia abrir. Mirando de menos, el panel se ve perfecto y
 *    esta vacio justo donde importa.
 *  - **Que la ref no se convierta en cualquier ruta.** Es el unico punto donde
 *    algo que viene del cliente nombra un archivo, y dos de las tres raices son
 *    carpetas donde el usuario escribe. Un agujero aca no se nota nunca usando
 *    la app.
 *  - **Que un enlace hacia afuera no se siga.** `resolveInside` resuelve los
 *    enlaces antes de leer: un `.md` del proyecto que apunta a
 *    `.credentials.json` no se abre (CLAUDE.md 2.1, 6.15).
 *
 * No toca `~/.claude/plans` ni la temporal real de ninguna sesion: la deteccion
 * se prueba sobre lineas armadas a mano, y las lecturas sobre una carpeta que
 * crea el propio chequeo.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toPlanRefs } from '../src/agents/claude-code/jsonl-events.ts';
import { describePlans, readPlan } from '../src/agents/claude-code/plans-store.ts';
import { scratchRoot } from '../src/agents/claude-code/paths.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

/** Un `Write` del asistente a esa ruta. */
const write = (filePath) => ({
  type: 'assistant',
  uuid: 'a1',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: filePath, content: '# x\n' } }],
  },
});

const root = await mkdtemp(path.join(tmpdir(), 'check-plans-'));
const cwd = path.join(root, 'proyecto');
await mkdir(path.join(cwd, 'plans'), { recursive: true });
const SESSION = '0f9c2a11-4d5e-4a6b-8c7d-9e0f1a2b3c4d';
const target = { cwd, sessionId: SESSION };
/** Una pestana sin sesion: solo reconoce planes de la CLI y del proyecto. */
const noSession = { cwd, sessionId: '' };

// --- 1. Los tres origenes ---------------------------------------------------

const planMode = {
  type: 'attachment',
  parentUuid: 'u1',
  attachment: {
    type: 'plan_mode',
    reminderType: 'full',
    planFilePath: 'C:\\Users\\Ana\\.claude\\plans\\virtual-chasing-peacock.md',
    planExists: false,
  },
};
check(
  'plan_mode -> ref del plan de la CLI',
  JSON.stringify(toPlanRefs(planMode, target)) === '["cli:virtual-chasing-peacock.md"]',
  JSON.stringify(toPlanRefs(planMode, target)),
);

const planExit = {
  type: 'attachment',
  attachment: {
    type: 'plan_mode_exit',
    planFilePath: '/home/ana/.claude/plans/mi-778-discrepancia.md',
    planExists: true,
  },
};
check(
  'plan_mode_exit, ruta con / -> ref',
  JSON.stringify(toPlanRefs(planExit, target)) === '["cli:mi-778-discrepancia.md"]',
  JSON.stringify(toPlanRefs(planExit, target)),
);

check(
  'Write a la carpeta de planes -> ref cli (el caso del hito 22)',
  JSON.stringify(toPlanRefs(write('C:\\Users\\Ana\\.claude\\plans\\mi-778.md'), target)) ===
    '["cli:mi-778.md"]',
);

// El caso del pedido del hito 31: el plan quedo DENTRO del proyecto.
const inProject = write(path.join(cwd, 'plans', 'plan-de-sincronizacion.md'));
check(
  'Write dentro del proyecto -> ref proj (el caso del pedido)',
  JSON.stringify(toPlanRefs(inProject, target)) === '["proj:plans/plan-de-sincronizacion.md"]',
  JSON.stringify(toPlanRefs(inProject, target)),
);

// Y el otro: el que el agente deja en su carpeta temporal.
const scratch = scratchRoot(cwd, SESSION);
const inScratch = write(path.join(scratch, 'scratchpad', 'hito-31-spec.md'));
check(
  'Write en la temporal de esta sesion -> ref tmp',
  JSON.stringify(toPlanRefs(inScratch, target)) === '["tmp:scratchpad/hito-31-spec.md"]',
  JSON.stringify(toPlanRefs(inScratch, target)),
);

// La temporal gana al proyecto: si el `cwd` estuviera adentro de la temporal,
// la ref seria ambigua y el documento se listaria dos veces.
const other = write(path.join(scratchRoot(cwd, 'otra-sesion-0000'), 'scratchpad', 'x.md'));
check(
  'la temporal de OTRA sesion no es de esta',
  JSON.stringify(toPlanRefs(other, target)) === '[]',
  JSON.stringify(toPlanRefs(other, target)),
);

// Relativo: se resuelve contra el `cwd`, que es donde corre la CLI.
check(
  'un file_path relativo se resuelve contra el cwd',
  JSON.stringify(toPlanRefs(write('docs/notas.md'), target)) === '["proj:docs/notas.md"]',
  JSON.stringify(toPlanRefs(write('docs/notas.md'), target)),
);

// Varios documentos en el mismo mensaje: salen los dos, en orden.
const two = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', name: 'Write', input: { file_path: path.join(cwd, 'a.md') } },
      { type: 'tool_use', name: 'Write', input: { file_path: path.join(cwd, 'b.md') } },
    ],
  },
};
check(
  'dos Write en un mensaje -> dos refs, en orden',
  JSON.stringify(toPlanRefs(two, target)) === '["proj:a.md","proj:b.md"]',
  JSON.stringify(toPlanRefs(two, target)),
);

// --- 2. Lo que NO es un documento de la conversacion ------------------------

check(
  'un Write fuera de las tres raices no cuenta',
  JSON.stringify(toPlanRefs(write(path.join(root, 'afuera', 'ARQUITECTURA.md')), target)) === '[]',
);

check(
  'un .. que sale del proyecto tampoco',
  JSON.stringify(toPlanRefs(write(path.join(cwd, '..', 'afuera.md')), target)) === '[]',
  JSON.stringify(toPlanRefs(write(path.join(cwd, '..', 'afuera.md')), target)),
);

const edit = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        name: 'Edit',
        input: { file_path: path.join(cwd, 'CHECKLIST.md'), old_string: 'a', new_string: 'b' },
      },
    ],
  },
};
check('un Edit no cuenta: editar no es crear un documento', JSON.stringify(toPlanRefs(edit, target)) === '[]');

check(
  'un Write que no es .md no cuenta',
  JSON.stringify(toPlanRefs(write(path.join(cwd, 'notas.txt')), target)) === '[]',
);

const readCall = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      { type: 'tool_use', name: 'Read', input: { file_path: 'C:\\Users\\Ana\\.claude\\plans\\otro.md' } },
    ],
  },
};
check('leer un plan no lo convierte en plan de esta sesion', JSON.stringify(toPlanRefs(readCall, target)) === '[]');

const otherAttachment = { type: 'attachment', attachment: { type: 'file', filename: 'C:\\x\\a.png' } };
check('otro attachment no es un plan', JSON.stringify(toPlanRefs(otherAttachment, target)) === '[]');

const subdir = {
  type: 'attachment',
  attachment: { type: 'plan_mode', planFilePath: 'C:\\Users\\Ana\\.claude\\plans\\sub\\a.md' },
};
check('una subcarpeta de plans no cuenta', JSON.stringify(toPlanRefs(subdir, target)) === '[]');

const traversal = {
  type: 'attachment',
  attachment: {
    type: 'plan_mode',
    planFilePath: 'C:\\Users\\Ana\\.claude\\plans\\..\\.credentials.json',
  },
};
check('un .. en la ruta del plan se rechaza', JSON.stringify(toPlanRefs(traversal, target)) === '[]');

check('una linea sin nada no rompe', JSON.stringify(toPlanRefs({ type: 'user' }, target)) === '[]');
check(
  'un tipo desconocido tampoco',
  JSON.stringify(toPlanRefs({ type: 'file-history-delta' }, target)) === '[]',
);
check(
  'sin cwd solo se reconocen los planes de la CLI',
  JSON.stringify(toPlanRefs(write(path.join(cwd, 'a.md')), { cwd: '', sessionId: '' })) === '[]',
);
check(
  'sin sessionId, un .md de una temporal no es de nadie',
  JSON.stringify(toPlanRefs(inScratch, noSession)) === '[]',
  JSON.stringify(toPlanRefs(inScratch, noSession)),
);

// --- 3. El guardia de la ref, del otro lado ---------------------------------
//
// `describePlans` y `readPlan` reciben una ref y arman la ruta. Aunque haya
// salido de nuestra propia lista, se vuelve a validar: una validacion que
// depende de que el llamador se haya acordado no es una validacion.

const hostile = [
  'cli:..\\.credentials.json',
  'cli:../.credentials.json',
  'cli:sub/plan.md',
  'cli:sub\\plan.md',
  'cli:C:\\Windows\\win.ini',
  'cli:/etc/passwd',
  'cli:\\\\servidor\\share\\plan.md',
  'cli:plan.md\u0000.png',
  'cli:.',
  'cli:..',
  'cli:',
  'cli:plan.txt',
  'proj:../afuera.md',
  'proj:..\\afuera.md',
  'proj:/etc/passwd',
  'proj:C:\\Windows\\win.ini',
  'proj:\\\\servidor\\share\\plan.md',
  'proj:sub\\plan.md',
  'proj:plan.md\u0000.png',
  'proj:notas.txt',
  'proj:',
  'tmp:../../otra/x.md',
  'tmp:/etc/passwd',
  'plan.md',
  'otro:plan.md',
  '',
];

const described = await describePlans(target, hostile);
check(
  'ninguna ref hostil llega a describirse',
  described.length === 0,
  described.map((p) => p.fileName).join(', '),
);

let leaked = null;
for (const ref of hostile) {
  const content = await readPlan(target, ref);
  if (content !== null) leaked = ref;
}
check('ninguna se puede leer', leaked === null, String(leaked));

// --- 4. Lectura de verdad, sobre la carpeta del chequeo ----------------------

await writeFile(path.join(cwd, 'plans', 'plan-de-sincronizacion.md'), '# Sincronizacion\n', 'utf8');
await mkdir(path.join(scratch, 'scratchpad'), { recursive: true });
await writeFile(path.join(scratch, 'scratchpad', 'hito-31-spec.md'), '# Spec\n', 'utf8');

const listed = await describePlans(target, [
  'proj:plans/plan-de-sincronizacion.md',
  'tmp:scratchpad/hito-31-spec.md',
  'cli:no-existe-este-plan-de-prueba.md',
]);
check(
  'los tres se listan, con su origen y su ruta',
  listed.length === 3 &&
    listed[0].origin === 'project' &&
    listed[0].exists === true &&
    listed[0].title === 'plan-de-sincronizacion' &&
    listed[0].path === 'plans/plan-de-sincronizacion.md' &&
    listed[1].origin === 'scratch' &&
    listed[1].exists === true &&
    listed[1].path === 'scratchpad/hito-31-spec.md' &&
    listed[2].origin === 'cli-plans' &&
    listed[2].exists === false &&
    listed[2].path === '',
  JSON.stringify(listed),
);
check('el tamano sale del disco', listed[0].sizeBytes > 0);

const readProject = await readPlan(target, 'proj:plans/plan-de-sincronizacion.md');
check(
  'un documento del proyecto se lee',
  readProject !== null && readProject.text.startsWith('# Sincronizacion'),
  JSON.stringify(readProject),
);

const readScratch = await readPlan(target, 'tmp:scratchpad/hito-31-spec.md');
check('uno de la temporal tambien', readScratch !== null && readScratch.text.startsWith('# Spec'));

check(
  'una ref valida de una pestana sin cwd no se lee',
  (await readPlan({ cwd: '', sessionId: '' }, 'proj:plans/plan-de-sincronizacion.md')) === null,
);
check(
  'ni una tmp sin sessionId',
  (await readPlan(noSession, 'tmp:scratchpad/hito-31-spec.md')) === null,
);

// Un enlace dentro del proyecto que apunta afuera: `resolveInside` lo resuelve
// antes de leer. Es el mismo caso que el `CLAUDE.md` enlazado de §6.15.
const secret = path.join(root, 'secreto.md');
await writeFile(secret, 'CREDENCIALES\n', 'utf8');
let linked = false;
try {
  await symlink(secret, path.join(cwd, 'enlace.md'));
  linked = true;
} catch {
  // En Windows sin permiso para crear enlaces: el caso se salta y se dice.
}
if (linked) {
  const viaLink = await readPlan(target, 'proj:enlace.md');
  check('un .md del proyecto que enlaza afuera no se lee', viaLink === null, JSON.stringify(viaLink));
  const describedLink = await describePlans(target, ['proj:enlace.md']);
  check(
    'y se lista como que no esta, en vez de esconderse',
    describedLink.length === 1 && describedLink[0].exists === false,
    JSON.stringify(describedLink),
  );
} else {
  console.log('OMITIDO el enlace hacia afuera (sin permiso para crear symlinks)');
}

await rm(root, { recursive: true, force: true });

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
