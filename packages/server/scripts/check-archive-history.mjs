/**
 * Chequeo de "Archivar historial": que sesiones entran en el corte.
 *
 *   npx tsx scripts/check-archive-history.mjs
 *
 * Es una accion que esconde de a cientos. Las formas de romperla no se ven a
 * ojo: un corte a medianoche UTC en vez de local, una sesion de otra CLI que se
 * cuela, o una con pestana abierta que se cuenta y el servidor despues no
 * archiva.
 *
 * Importa el modulo de la interfaz: no tiene JSX justamente para esto. Fija la
 * zona horaria del proceso para que el corte local no coincida con el UTC por
 * casualidad de la maquina donde corre.
 */

import {
  archiveCandidatesByAgent,
  sessionsToArchiveBefore,
  startOfLocalDay,
} from '../../web/src/archive-history.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const HOUR = 60 * 60 * 1000;

function session(sessionId, agent, updatedAt, archived = false) {
  return {
    agent,
    sessionId,
    cwd: '',
    title: sessionId,
    titleSource: 'first-message',
    updatedAt,
    sizeBytes: 1,
    archived,
  };
}

function project(key, sessions) {
  return {
    key,
    fallbackName: '',
    cwd: key,
    cwdExists: true,
    sessions,
    lastActivityAt: Math.max(0, ...sessions.map((s) => s.updatedAt)),
  };
}

const sorted = (ids) => [...ids].sort();
const same = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

// --- 1. El corte es la medianoche local, no la UTC ---------------------------
{
  // UTC+9 sin horario de verano: la medianoche local es las 15:00 UTC del dia
  // anterior, y cualquier corte en UTC cae nueve horas corrido.
  process.env.TZ = 'Asia/Tokyo';
  check('la zona horaria se aplico', new Date(Date.UTC(2026, 0, 1)).getTimezoneOffset() === -540);

  // 14-09 10:00 en Tokio = 14-09 01:00 UTC.
  const now = Date.UTC(2026, 8, 14, 1, 0);
  const cutoff = startOfLocalDay(now);
  check(
    'medianoche de Tokio, no de UTC',
    cutoff === Date.UTC(2026, 8, 13, 15, 0),
    `dio ${new Date(cutoff).toISOString()}`,
  );

  // 14-09 23:30 en Tokio = 14-09 14:30 UTC: sigue siendo el 14 local.
  check(
    'a ultima hora del dia, el mismo corte',
    startOfLocalDay(Date.UTC(2026, 8, 14, 14, 30)) === Date.UTC(2026, 8, 13, 15, 0),
  );
  // 15-09 00:30 en Tokio = 14-09 15:30 UTC: ya es otro dia local.
  check(
    'pasada la medianoche local, el dia siguiente',
    startOfLocalDay(Date.UTC(2026, 8, 14, 15, 30)) === Date.UTC(2026, 8, 14, 15, 0),
  );
  check('la medianoche en punto es su propio corte', startOfLocalDay(cutoff) === cutoff);
}

{
  // El dia del cambio de hora: a mediodia el desfase ya no es el de las 00:00.
  // En Nueva York el 08-03-2026 empieza el horario de verano a las 2:00.
  process.env.TZ = 'America/New_York';
  const noon = Date.UTC(2026, 2, 8, 16, 0); // 12:00 EDT
  check(
    'dia del cambio de hora: la medianoche con el desfase de medianoche',
    startOfLocalDay(noon) === Date.UTC(2026, 2, 8, 5, 0),
    `dio ${new Date(startOfLocalDay(noon)).toISOString()}`,
  );
}

// --- 2. Que sesiones entran ----------------------------------------------------
process.env.TZ = 'Asia/Tokyo';
const cutoff = startOfLocalDay(Date.UTC(2026, 8, 14, 1, 0));

const projects = [
  project('/a', [
    session('oc-old-1', 'opencode', cutoff - 48 * HOUR),
    session('oc-old-2', 'opencode', cutoff - 1),
    session('oc-today', 'opencode', cutoff + HOUR),
    session('oc-at-cutoff', 'opencode', cutoff),
    session('oc-archived', 'opencode', cutoff - 10 * HOUR, true),
    session('oc-open', 'opencode', cutoff - 5 * HOUR),
    session('cc-old', 'claude-code', cutoff - 5 * HOUR),
  ]),
  project('/b', [
    // El mismo id en otro proyecto: una sola sesion para el archivo.
    session('oc-old-1', 'opencode', cutoff - 48 * HOUR),
    session('oc-old-3', 'opencode', cutoff - 3 * HOUR),
    session('cx-today', 'codex', cutoff + 2 * HOUR),
  ]),
];
const open = new Set(['oc-open']);

const ids = sessionsToArchiveBefore(projects, 'opencode', cutoff, open);
check(
  'las de esa CLI anteriores al corte',
  same(ids, ['oc-old-1', 'oc-old-2', 'oc-old-3']),
  `dio ${JSON.stringify(ids)}`,
);
check('un milisegundo antes del corte entra', ids.includes('oc-old-2'));
check('la de hoy no entra', !ids.includes('oc-today'));
check('updatedAt igual al corte no entra', !ids.includes('oc-at-cutoff'));
check('una archivada no entra', !ids.includes('oc-archived'));
check('con pestana abierta no entra', !ids.includes('oc-open'));
check('otra CLI no entra', !ids.includes('cc-old') && !ids.includes('cx-today'));
check('sin duplicados', ids.length === new Set(ids).size, `dio ${JSON.stringify(ids)}`);

check(
  'la pestana abierta entra si se cierra',
  sessionsToArchiveBefore(projects, 'opencode', cutoff, new Set()).includes('oc-open'),
);
check(
  'la otra CLI tiene lo suyo',
  same(sessionsToArchiveBefore(projects, 'claude-code', cutoff, open), ['cc-old']),
);
check(
  'una CLI sin nada anterior a hoy da vacio',
  sessionsToArchiveBefore(projects, 'codex', cutoff, open).length === 0,
);
check('sin proyectos, vacio', sessionsToArchiveBefore([], 'opencode', cutoff, open).length === 0);

// --- 3. La cuenta por CLI ------------------------------------------------------
{
  // El orden de la lista de CLIs del `hello`, que es el que se ve: al reves del
  // de aparicion en `projects`, para que un orden por aparicion no pase.
  const order = ['claude-code', 'codex', 'opencode'];
  const byAgent = archiveCandidatesByAgent(projects, cutoff, open, order);
  check(
    'una fila por CLI con candidatas, en el orden de la lista de CLIs',
    JSON.stringify(byAgent) ===
      JSON.stringify([
        { agent: 'claude-code', count: 1 },
        { agent: 'opencode', count: 3 },
      ]),
    `dio ${JSON.stringify(byAgent)}`,
  );

  // Una CLI con historial que no esta en la lista va al final, y entre las que
  // faltan manda el orden de aparicion.
  const missing = archiveCandidatesByAgent(
    [
      project('/e', [
        session('cx-old', 'codex', cutoff - HOUR),
        session('oc-old', 'opencode', cutoff - HOUR),
        session('cc-old-2', 'claude-code', cutoff - HOUR),
      ]),
    ],
    cutoff,
    new Set(),
    ['opencode'],
  );
  check(
    'una CLI que no esta en la lista va al final, en orden de aparicion',
    JSON.stringify(missing.map((row) => row.agent)) ===
      JSON.stringify(['opencode', 'codex', 'claude-code']),
    `dio ${JSON.stringify(missing)}`,
  );
  check(
    'sin lista de CLIs, el orden de aparicion',
    JSON.stringify(archiveCandidatesByAgent(projects, cutoff, open, []).map((row) => row.agent)) ===
      JSON.stringify(['opencode', 'claude-code']),
  );

  check('una CLI sin candidatas no tiene fila', !byAgent.some((row) => row.agent === 'codex'));
  check(
    'la cuenta es la lista que se archiva',
    byAgent.every(
      (row) =>
        row.count === sessionsToArchiveBefore(projects, row.agent, cutoff, open).length,
    ),
  );
  check('todo archivado: ninguna fila', archiveCandidatesByAgent(
    [project('/c', [session('x', 'opencode', cutoff - HOUR, true)])],
    cutoff,
    open,
    order,
  ).length === 0);
  // Una sola CLI: tambien se ofrece. Es el caso de quien solo tiene historial
  // viejo de una.
  const single = archiveCandidatesByAgent(
    [project('/d', [session('y', 'opencode', cutoff - HOUR)])],
    cutoff,
    new Set(),
    order,
  );
  check(
    'con una sola CLI tambien hay fila',
    JSON.stringify(single) === JSON.stringify([{ agent: 'opencode', count: 1 }]),
  );
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
