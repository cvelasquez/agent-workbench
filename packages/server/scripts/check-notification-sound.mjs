/**
 * Chequeo del sonido de aviso (§6.20).
 *
 *   npx tsx scripts/check-notification-sound.mjs
 *
 * Lo que se rompe en silencio: un aviso que suena con la tanda inicial tras
 * conectar (cada F5 sonaría), uno que repica entre dos herramientas, o uno que
 * suena con `unknown`, que con Codex es lo único que hay. Importa el módulo de
 * la interfaz, que no tiene JSX ni toca el navegador salvo en `ChimePlayer`,
 * que acá no se instancia.
 */

import {
  CHIMES,
  DONE_HOLD_MS,
  chimeFor,
  parseStoredSound,
  planChimes,
  soundButtonTitle,
} from '../../web/src/notification-sound.ts';
import { setLocale } from '../../web/src/i18n/index.ts';

// Los textos de la interfaz salen de `t()` (§6.23): este chequeo los compara
// con el español de siempre, así que lo fija antes de la primera comparación.
await setLocale('es');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};

const map = (entries) => new Map(Object.entries(entries));
const json = (value) => JSON.stringify(value);

// --- 1. Qué transición suena ------------------------------------------------
check('busy → idle es "terminó"', chimeFor('busy', 'idle') === 'done');
check('busy → waiting es "te espera"', chimeFor('busy', 'waiting') === 'attention');
check('idle → waiting también: la CLI pregunta sin haber trabajado', chimeFor('idle', 'waiting') === 'attention');
check('sin estado anterior no suena (tanda inicial, pestaña recién lanzada)',
  chimeFor(undefined, 'idle') === null && chimeFor(undefined, 'waiting') === null);
check('el mismo estado repetido no suena', chimeFor('idle', 'idle') === null && chimeFor('waiting', 'waiting') === null);
check('waiting → idle no es "terminó": el usuario contestó', chimeFor('waiting', 'idle') === null);
check('unknown no suena en ningún sentido (Codex)',
  chimeFor('unknown', 'idle') === null && chimeFor('busy', 'unknown') === null && chimeFor('idle', 'unknown') === null);
check('offline no suena', chimeFor('busy', 'offline') === null && chimeFor('offline', 'idle') === null);
check('idle → busy no suena', chimeFor('idle', 'busy') === null);

// --- 2. El plan sobre el mapa entero ----------------------------------------
{
  const first = planChimes(new Map(), map({ a: 'busy', b: 'waiting', c: 'idle' }));
  check('la tanda de conectar no hace sonar nada',
    first.now.length === 0 && first.later.length === 0, json(first));

  const done = planChimes(map({ a: 'busy', b: 'idle' }), map({ a: 'idle', b: 'idle' }));
  check('"terminó" no suena ya: espera el plazo',
    json(done) === json({ now: [], later: ['a'], cancel: ['a'] }), json(done));

  const attention = planChimes(map({ a: 'busy', b: 'busy' }), map({ a: 'waiting', b: 'busy' }));
  check('"te espera" suena ya, y sólo la pestaña que cambió',
    json(attention) === json({ now: ['a'], later: [], cancel: ['a'] }), json(attention));

  const backToWork = planChimes(map({ a: 'idle' }), map({ a: 'busy' }));
  check('volver a trabajar cancela el plazo y no suena',
    json(backToWork) === json({ now: [], later: [], cancel: ['a'] }), json(backToWork));

  const closed = planChimes(map({ a: 'idle', b: 'busy' }), map({ b: 'busy' }));
  check('una pestaña que desaparece del mapa cancela su plazo',
    json(closed) === json({ now: [], later: [], cancel: ['a'] }), json(closed));

  const both = planChimes(map({ a: 'busy', b: 'busy' }), map({ a: 'idle', b: 'waiting' }));
  check('dos pestañas en el mismo latido: cada una lo suyo',
    json(both) === json({ now: ['b'], later: ['a'], cancel: ['a', 'b'] }), json(both));

  const same = planChimes(map({ a: 'idle' }), map({ a: 'idle' }));
  check('un latido sin cambios no hace nada',
    json(same) === json({ now: [], later: [], cancel: [] }), json(same));
}

// --- 3. Las melodías y la preferencia ---------------------------------------
{
  const longest = (notes) => Math.max(...notes.map((n) => n.at + n.duration));
  check('ninguna melodía pasa del medio segundo',
    longest(CHIMES.done) <= 0.5 && longest(CHIMES.attention) <= 0.5,
    `${longest(CHIMES.done)} / ${longest(CHIMES.attention)}`);
  const direction = (notes) => Math.sign(notes[notes.length - 1].frequency - notes[0].frequency);
  check('"terminó" baja y "te espera" sube: se distinguen por el sentido',
    direction(CHIMES.done) === -1 && direction(CHIMES.attention) === 1);
  check('el plazo de "terminó" es más largo que un hueco entre herramientas', DONE_HOLD_MS >= 1000);

  check('la preferencia guardada se lee', parseStoredSound('on') === true && parseStoredSound('off') === false);
  check('y un valor raro cae al default', parseStoredSound('yes') === null && parseStoredSound('') === null);
  check('el título del botón dice el estado y qué hace el clic',
    soundButtonTitle(true).includes('activado') && soundButtonTitle(true).includes('silenciar') &&
    soundButtonTitle(false).includes('silenciado') && soundButtonTitle(false).includes('activar'));
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
