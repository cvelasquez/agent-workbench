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
  DEFAULT_VOLUME,
  DONE_HOLD_MS,
  MAX_VOLUME,
  MIN_VOLUME,
  PHONE_CHIME_STORAGE_KEY,
  chimeFor,
  clampVolume,
  parsePhoneChimeSource,
  parseStoredSound,
  parseStoredVolume,
  phoneChimeUrl,
  planChimes,
  soundButtonOn,
  soundButtonTitle,
  volumePercent,
  webChimeVolume,
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
  // Mejoras de la 0.4.0: el botón se ve encendido cuando el aviso se oye.
  check('el ♪ se ve encendido con el aviso activado y volumen',
    soundButtonOn(true, DEFAULT_VOLUME) && soundButtonOn(true, MIN_VOLUME));
  check('y apagado silenciado, o con volumen cero',
    !soundButtonOn(false, DEFAULT_VOLUME) && !soundButtonOn(true, 0) && !soundButtonOn(false, 0));
}

// --- 4. El volumen (hito 36) -------------------------------------------------
{
  check('el default está dentro del rango y el tope es 0,8',
    MIN_VOLUME > 0 && MIN_VOLUME < DEFAULT_VOLUME && DEFAULT_VOLUME < MAX_VOLUME && MAX_VOLUME === 0.8);
  check('el piso no es cero: silenciar es el clic, no la barrita', clampVolume(0) === MIN_VOLUME);
  check('un volumen de más se acota al tope', clampVolume(3) === MAX_VOLUME && clampVolume(0.3) === 0.3);
  check('el volumen guardado se lee', parseStoredVolume('0.35') === 0.35);
  check('uno fuera de rango se acota, no se descarta',
    parseStoredVolume('9') === MAX_VOLUME && parseStoredVolume('-1') === MIN_VOLUME);
  check('y uno que no es un número cae al default',
    parseStoredVolume('alto') === null && parseStoredVolume('') === null && parseStoredVolume('NaN') === null);
  check('el porcentaje es sobre el tope',
    volumePercent(MAX_VOLUME) === 100 && volumePercent(DEFAULT_VOLUME) === 25 && volumePercent(99) === 100);
}

// --- 5. Dentro de la app del teléfono (24-09-2026) ----------------------------
// Sonaba dos veces: la página y el aviso de Android. Se elige uno.
{
  check('en la app, "del sistema" calla la página, aunque el botón diga que suena',
    webChimeVolume(true, 'system', true, 0.3) === null);
  check('en la app, "de esta web" suena al máximo, sin mirar la barrita ni el botón',
    webChimeVolume(true, 'page', false, 0.05) === MAX_VOLUME);
  check('fuera de la app, mandan el botón y la barrita, como siempre',
    webChimeVolume(false, 'system', true, 0.3) === 0.3 && webChimeVolume(false, 'page', false, 0.3) === null &&
    webChimeVolume(false, 'page', true, 9) === MAX_VOLUME);
  check('la preferencia guardada se lee, y otra cosa cae al default',
    parsePhoneChimeSource('page') === 'page' && parsePhoneChimeSource('system') === 'system' &&
    parsePhoneChimeSource('web') === null && parsePhoneChimeSource('') === null);
  check('el contrato con la app: la clave y la dirección que intercepta',
    PHONE_CHIME_STORAGE_KEY === 'agent-workbench.phone-chime' &&
    phoneChimeUrl('page') === 'agentworkbench://chime?source=page' &&
    phoneChimeUrl('system') === 'agentworkbench://chime?source=system');
}

// --- 6. El pulso de la pestaña (12-10-2026) -----------------------------------
// La pestaña del agente que terminó o que espera se pinta como la activa, en
// dos pulsos, en el mismo instante del aviso: el sonido dice que alguien
// terminó y el pulso dice quién. Lo decide `planChimes`, cubierto arriba; acá
// va lo que no falla en ningún otro lado: los números de la animación, que
// viven en dos archivos, y que "como la activa" siga siendo cierto si un día
// cambia cómo se pinta la activa.
{
  const pulse = await import('../../web/src/attention-pulse.ts');
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../web/src/styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const declarations = (block) =>
    block.split(';').map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 0).sort();

  const rule = css.match(/\.tab\.tab-attention\s*\{([^}]*)\}/)?.[1] ?? '';
  check('la pestaña pulsa dos veces, 300 ms cada una, sin fundido',
    pulse.PULSE_MS === 300 && pulse.PULSE_COUNT === 2 &&
    rule.includes(`animation: tab-attention ${pulse.PULSE_CYCLE_MS}ms step-end ${pulse.PULSE_COUNT};`), rule.trim());

  const frames = css.match(/@keyframes tab-attention\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const lit = frames.match(/0%\s*\{([^}]*)\}/)?.[1] ?? '';
  const active = css.match(/\n\.tab-active\s*\{([^}]*)\}/)?.[1] ?? '';
  check('encendida se pinta igual que la pestaña activa: fondo, letra y el borde del color del proyecto',
    declarations(active).length === 3 && JSON.stringify(declarations(lit)) === JSON.stringify(declarations(active)),
    JSON.stringify({ lit: declarations(lit), active: declarations(active) }));
  check('y se apaga donde termina el pulso',
    new RegExp(`${pulse.PULSE_OFF_PERCENT}%,\\s*100%\\s*\\{[^}]*border-color: transparent;`).test(frames),
    frames.replace(/\s+/g, ' ').trim());
  check('la marca se quita cuando la animación terminó, ni antes ni mucho después',
    pulse.PULSE_ANIMATION_MS === pulse.PULSE_COUNT * pulse.PULSE_CYCLE_MS && pulse.PULSE_ANIMATION_MS <= 1_500,
    String(pulse.PULSE_ANIMATION_MS));
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
