/**
 * Chequeo de los planes de una sesion.
 *
 *   npx tsx scripts/check-plans.mjs [carpeta-temporal]
 *
 * Dos cosas que se rompen en silencio y por eso estan aca:
 *
 *  - **Que se detecten los dos caminos.** La CLI anuncia un plan con una linea
 *    `plan_mode` o con un `Write` a la carpeta de planes, y la sesion que
 *    motivo este panel usa el segundo. Mirando solo el primero, el panel se ve
 *    perfecto y esta vacio justo donde importa.
 *  - **Que el nombre no se convierta en cualquier ruta.** Es el unico punto
 *    donde algo que viene del cliente nombra un archivo fuera del `cwd` de la
 *    pestana. Un agujero aca no se nota nunca usando la app.
 *
 * No toca `~/.claude/plans`: la deteccion se prueba sobre lineas armadas a
 * mano, y el guardia sobre nombres.
 */

import { toPlanFileName } from '../src/agents/claude-code/jsonl-events.ts';
import { describePlans, readPlan } from '../src/agents/claude-code/plans-store.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

// --- 1. Los dos caminos por los que la CLI anuncia un plan -------------------

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
  'plan_mode -> nombre del archivo',
  toPlanFileName(planMode) === 'virtual-chasing-peacock.md',
  String(toPlanFileName(planMode)),
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
  'plan_mode_exit, ruta con / -> nombre',
  toPlanFileName(planExit) === 'mi-778-discrepancia.md',
  String(toPlanFileName(planExit)),
);

const writePlan = {
  type: 'assistant',
  uuid: 'a1',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Write',
        input: {
          file_path: 'C:\\Users\\Ana\\.claude\\plans\\mi-778-discrepancia-vistas-monitor.md',
          content: '# Plan\n',
        },
      },
    ],
  },
};
check(
  'Write a la carpeta de planes -> nombre (el caso del pedido)',
  toPlanFileName(writePlan) === 'mi-778-discrepancia-vistas-monitor.md',
  String(toPlanFileName(writePlan)),
);

// --- 2. Lo que NO es un plan -------------------------------------------------

const writeElsewhere = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        name: 'Write',
        input: { file_path: 'D:\\proyecto\\ARQUITECTURA.md', content: '# x' },
      },
    ],
  },
};
check('un Write al proyecto no es un plan', toPlanFileName(writeElsewhere) === null);

const readPlanCall = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        name: 'Read',
        input: { file_path: 'C:\\Users\\Ana\\.claude\\plans\\otro.md' },
      },
    ],
  },
};
check('leer un plan no lo convierte en plan de esta sesion', toPlanFileName(readPlanCall) === null);

const otherAttachment = {
  type: 'attachment',
  attachment: { type: 'file', filename: 'C:\\x\\a.png' },
};
check('otro attachment no es un plan', toPlanFileName(otherAttachment) === null);

const subdir = {
  type: 'attachment',
  attachment: { type: 'plan_mode', planFilePath: 'C:\\Users\\Ana\\.claude\\plans\\sub\\a.md' },
};
check('una subcarpeta de plans no cuenta', toPlanFileName(subdir) === null);

const traversal = {
  type: 'attachment',
  attachment: {
    type: 'plan_mode',
    planFilePath: 'C:\\Users\\Ana\\.claude\\plans\\..\\.credentials.json',
  },
};
check('un .. en la ruta del plan se rechaza', toPlanFileName(traversal) === null);

check('una linea sin nada no rompe', toPlanFileName({ type: 'user' }) === null);
check('un tipo desconocido tampoco', toPlanFileName({ type: 'file-history-delta' }) === null);

// --- 3. El guardia del nombre, del otro lado --------------------------------
//
// `describePlans` y `readPlan` reciben un nombre y arman la ruta. Aunque el
// nombre haya salido de nuestra propia lista, se vuelve a validar: una
// validacion que depende de que el llamador se haya acordado no es una
// validacion.

const hostile = [
  '..\\.credentials.json',
  '../.credentials.json',
  'sub/plan.md',
  'sub\\plan.md',
  'C:\\Windows\\win.ini',
  '/etc/passwd',
  '\\\\servidor\\share\\plan.md',
  'plan.md\u0000.png',
  '.',
  '..',
  '',
  'plan.txt',
];

const described = await describePlans(hostile);
check(
  'ningun nombre hostil llega a describirse',
  described.length === 0,
  described.map((p) => p.fileName).join(', '),
);

let leaked = null;
for (const name of hostile) {
  const content = await readPlan(name);
  if (content !== null) leaked = name;
}
check('ninguno se puede leer', leaked === null, String(leaked));

// Un nombre valido si pasa el guardia, aunque el archivo no exista: se lista
// diciendo que no esta, que es lo que ve el usuario cuando se borra un plan.
const ok = await describePlans(['no-existe-este-plan-de-prueba.md']);
check(
  'un plan valido que no esta en disco se lista igual',
  ok.length === 1 && ok[0].exists === false && ok[0].title === 'no-existe-este-plan-de-prueba',
  JSON.stringify(ok),
);

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
