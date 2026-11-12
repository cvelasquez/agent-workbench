/**
 * Chequeo de la vista angosta (hito 38, §6.25).
 *
 *   npx tsx scripts/check-narrow-layout.mjs
 *
 * Lo que se rompe en silencio: una vista que se ofrece sin pestaña, un `tab`
 * de la dirección que se toma sin mirarle la forma, una tecla de la fila que
 * manda otra secuencia, y —lo que más cuesta ver usando la app en una PC— una
 * regla CSS de la vista angosta que se sale de sus dos `@media` y cambia el
 * escritorio. Importa `narrow-layout.ts`, que no tiene JSX ni toca el
 * navegador, y lee `styles.css` e `index.html` como texto.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSOLE_KEY_ROWS,
  NARROW_MAX_WIDTH,
  NARROW_MEDIA_QUERY,
  NARROW_VIEWS,
  NATIVE_BACK_HOOK,
  PHONE_APP_DISCONNECT_URL,
  PHONE_APP_SETTINGS_URL,
  PHONE_APP_UA_TOKEN,
  TAB_QUERY_PARAM,
  TERMINAL_KEYS,
  TOUCH_MEDIA_QUERY,
  enterSubmits,
  insidePhoneApp,
  isNarrowView,
  narrowBackAction,
  narrowViewLabelKey,
  narrowViews,
  panelTabOf,
  parseStoredNarrowView,
  readTabParam,
  resolveNarrowView,
  terminalKeyRows,
  withoutParams,
} from '../../web/src/narrow-layout.ts';
import {
  DRAG_SLOP_PX,
  MOMENTUM_MAX_VELOCITY,
  MOMENTUM_MIN_VELOCITY,
  isDrag,
  momentumStep,
  releaseVelocity,
  wholePixels,
} from '../../web/src/touch-scroll.ts';
import {
  NARROW_THREAD_TOOLS_STORAGE_KEY,
  THREAD_TOOLS_STORAGE_KEY,
  defaultThreadToolsOpen,
  parseStoredThreadTools,
  threadToolsStorageKey,
  threadToolsValue,
} from '../../web/src/thread-tools.ts';
import { setLocale, t } from '../../web/src/i18n/index.ts';

// Los textos de la interfaz salen de `t()` (§6.23): se comparan con el español.
await setLocale('es');

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);

// --- 1. El punto de corte y las vistas -----------------------------------------
{
  check('el punto de corte es 768 px (una tablet vertical entra), y las dos consultas lo dicen',
    NARROW_MAX_WIDTH === 768 && NARROW_MEDIA_QUERY === '(max-width: 768px)' && TOUCH_MEDIA_QUERY === '(hover: none)');
  check('las ocho vistas, en el orden de la tira',
    json(NARROW_VIEWS) === json(['chat', 'cli', 'git', 'files', 'plans', 'memory', 'notes', 'console']));
  check('sin pestaña solo hay chat (el estado vacío) y notas',
    json(narrowViews({ hasTab: false, plansAvailable: true })) === json(['chat', 'notes']));
  check('con pestaña y sin planes, todas menos planes',
    json(narrowViews({ hasTab: true, plansAvailable: false })) === json(['chat', 'cli', 'git', 'files', 'memory', 'notes', 'console']));
  check('con planes, en su lugar', json(narrowViews({ hasTab: true, plansAvailable: true })) === json([...NARROW_VIEWS]));
  const some = narrowViews({ hasTab: true, plansAvailable: false });
  check('la vista pedida se muestra si se ofrece; si no, chat',
    resolveNarrowView('files', some) === 'files' && resolveNarrowView('plans', some) === 'chat' &&
    resolveNarrowView('cli', ['chat', 'notes']) === 'chat');
  check('la guardada se lee, y otra cosa no',
    parseStoredNarrowView('git') === 'git' && parseStoredNarrowView('panel') === null && parseStoredNarrowView('') === null &&
    isNarrowView('console') && !isNarrowView('Chat'));
  check('cinco vistas dibujan una solapa del panel; chat, notas (solapa en la PC, vista propia aquí) y consola no',
    ['cli', 'git', 'files', 'plans', 'memory'].every((view) => panelTabOf(view) === view) &&
    ['chat', 'notes', 'console'].every((view) => panelTabOf(view) === null));
  check('cada vista tiene su texto',
    NARROW_VIEWS.every((view) => typeof t(narrowViewLabelKey(view)) === 'string' && t(narrowViewLabelKey(view)).length > 0) &&
    t(narrowViewLabelKey('chat')) === 'Chat' && t(narrowViewLabelKey('git')) === 'Cambios' && t(narrowViewLabelKey('notes')) === 'Notas');
}

// --- 2. `?tab=` en la dirección ---------------------------------------------------
{
  check('el parámetro se llama tab', TAB_QUERY_PARAM === 'tab');
  check('se lee, también junto al token',
    readTabParam('?tab=3b1f0c2e-9a2f-4c1b-8f3e-1234567890ab') === '3b1f0c2e-9a2f-4c1b-8f3e-1234567890ab' &&
    readTabParam('?token=abc&tab=x_y-Z9') === 'x_y-Z9');
  check('sin él, o con una forma que no es un id, null',
    readTabParam('') === null && readTabParam('?token=abc') === null && readTabParam('?tab=') === null &&
    readTabParam('?tab=a%20b') === null && readTabParam('?tab=<script>') === null && readTabParam(`?tab=${'a'.repeat(81)}`) === null);
  check('quitar parámetros conserva los demás, y sin ninguno no queda ni el signo',
    withoutParams('?token=abc&tab=x&renderer=webgl', ['token', 'tab']) === '?renderer=webgl' &&
    withoutParams('?token=abc&tab=x', ['token', 'tab']) === '' && withoutParams('', ['tab']) === '');
}

// --- 3. La fila de teclas -----------------------------------------------------------
{
  const ids = (keys) => keys.map((key) => key.id);
  const byId = new Map(TERMINAL_KEYS.map((key) => [key.id, key]));
  const consoleKeys = CONSOLE_KEY_ROWS.flat();
  const consoleById = new Map(consoleKeys.map((key) => [key.id, key]));
  const everyKey = [...new Set([...TERMINAL_KEYS, ...consoleKeys])];

  // La CLI: con Enter, los números, Esc y las flechas se contesta un menú que el hilo no dibuja.
  check('la CLI: quince teclas, cada una con su secuencia y sin repetirse',
    TERMINAL_KEYS.length === 15 && TERMINAL_KEYS.every((key) => key.data.length > 0 && key.label.length > 0) &&
    new Set(ids(TERMINAL_KEYS)).size === 15);
  check('Enter va primera, manda el retorno de carro y es la única destacada',
    TERMINAL_KEYS[0]?.id === 'enter' && TERMINAL_KEYS[0]?.data === '\r' && TERMINAL_KEYS[0]?.label === 'Enter' &&
    TERMINAL_KEYS.filter((key) => key.primary === true).length === 1 && TERMINAL_KEYS[0]?.primary === true);
  check('los números 1, 2 y 3, detrás de Enter, mandan ese carácter',
    json(TERMINAL_KEYS.slice(1, 4).map((key) => [key.label, key.data])) === json([['1', '1'], ['2', '2'], ['3', '3']]));
  check('con lo que se contesta un menú (Enter, 1 a 3, Esc y las flechas) delante de Tab y de las combinaciones con Ctrl',
    json(ids(TERMINAL_KEYS.slice(0, 9))) === json(['enter', 'option-1', 'option-2', 'option-3', 'esc', 'up', 'down', 'left', 'right']) &&
    json(ids(TERMINAL_KEYS.slice(9))) === json(['tab', 'shift-tab', 'interrupt', 'ctrl-o', 'ctrl-t', 'ctrl-x']));
  check('Esc, Tab y Shift+Tab mandan lo que manda un teclado',
    byId.get('esc')?.data === '\x1b' && byId.get('tab')?.data === '\t' && byId.get('shift-tab')?.data === '\x1b[Z');
  check('las flechas, en la forma que leen las CLIs',
    byId.get('up')?.data === '\x1b[A' && byId.get('down')?.data === '\x1b[B' && byId.get('left')?.data === '\x1b[D' && byId.get('right')?.data === '\x1b[C');
  check('Ctrl+C es el byte 3',
    byId.get('interrupt')?.data === '\x03');
  check('Ctrl+O, Ctrl+T y Ctrl+X son los bytes 15, 20 y 24',
    byId.get('ctrl-o')?.data === '\x0f' && byId.get('ctrl-t')?.data === '\x14' && byId.get('ctrl-x')?.data === '\x18' &&
    byId.get('ctrl-o')?.label === '^O' && byId.get('ctrl-t')?.label === '^T' && byId.get('ctrl-x')?.label === '^X');
  // Desde el teléfono el byte llega a la PC y pega su portapapeles, no el del teléfono (§5.2):
  // la CLI no lo ofrece, y la Consola lo trae sólo por nano, donde es "página siguiente".
  check('Ctrl+V no está en la CLI (pegaría el portapapeles de la PC); la Consola lo trae por nano',
    !TERMINAL_KEYS.some((key) => key.data === '\x16') && consoleById.get('ctrl-v')?.data === '\x16');

  // La Consola: que sobren y no que falten, porque lo que falta obliga a ir a la PC.
  check('la Consola: dos líneas de 15 y de 14 teclas, ninguna repetida (ni dentro de una línea ni entre las dos)',
    CONSOLE_KEY_ROWS.length === 2 && json(CONSOLE_KEY_ROWS.map((row) => row.length)) === json([15, 14]) &&
    consoleKeys.length === 29 && new Set(ids(consoleKeys)).size === 29 &&
    consoleKeys.every((key) => key.data.length > 0 && key.label.length > 0));
  // El teclado del teléfono ya tiene los números; en la CLI están para contestar un menú sin abrirlo.
  check('la Consola lleva las de la CLI con Enter primero, menos los números 1, 2 y 3',
    TERMINAL_KEYS.filter((key) => !/^option-\d$/.test(key.id)).every((key) => consoleKeys.includes(key)) &&
    !consoleKeys.some((key) => /^option-\d$/.test(key.id) || /^\d$/.test(key.data)) &&
    CONSOLE_KEY_ROWS[0]?.[0]?.id === 'enter');
  check('la primera pantalla de arriba son las ocho de siempre: Enter, Tab, ⇧Tab, Esc y las flechas',
    json(ids(CONSOLE_KEY_ROWS[0].slice(0, 8))) === json(['enter', 'tab', 'shift-tab', 'esc', 'up', 'down', 'left', 'right']));
  check('Ctrl+O y Ctrl+X (guardar y salir de nano) están en la primera pantalla de su línea, detrás de Ctrl+C',
    json(ids(CONSOLE_KEY_ROWS[1].slice(0, 8))) === json(['interrupt', 'ctrl-o', 'ctrl-x', 'ctrl-k', 'ctrl-u', 'ctrl-w', 'ctrl-r', 'ctrl-l']));
  check('Home, End, RePág, AvPág y Supr, en la forma que leen los shells y nano',
    consoleById.get('home')?.data === '\x1b[H' && consoleById.get('end')?.data === '\x1b[F' &&
    consoleById.get('page-up')?.data === '\x1b[5~' && consoleById.get('page-down')?.data === '\x1b[6~' &&
    consoleById.get('delete')?.data === '\x1b[3~');
  const ctrlKeys = consoleKeys.filter((key) => /^\^[A-Z]$/.test(key.label));
  check('cada Ctrl+letra de la Consola (dieciséis) manda el byte de su letra, que es la letra menos 64',
    ctrlKeys.length === 16 && ctrlKeys.every((key) => key.data === String.fromCharCode(key.label.charCodeAt(1) - 64)));
  check('las de un shell y de nano están: K, U, W, R, L, D, Z, A, E, G, V e Y',
    ['K', 'U', 'W', 'R', 'L', 'D', 'Z', 'A', 'E', 'G', 'V', 'Y'].every((letter) => consoleById.get(`ctrl-${letter.toLowerCase()}`)?.label === `^${letter}`));
  check('la CLI se ve en una línea y la Consola en dos',
    terminalKeyRows('cli').length === 1 && terminalKeyRows('cli')[0] === TERMINAL_KEYS &&
    terminalKeyRows('console') === CONSOLE_KEY_ROWS);

  check('cada tecla tiene su texto, con sus valores puestos',
    everyKey.every((key) => {
      const text = t(key.titleKey, key.titleParams);
      return text.length > 0 && !text.includes('{{');
    }));
  check('los textos nuevos, en español',
    t('narrow.keys.enter') === 'Enter (confirma la opción marcada)' &&
    t('narrow.keys.number', { number: '2' }) === 'Tecla 2 (elige la opción 2 de un menú)' &&
    t('narrow.keys.ctrl', { letter: 'K' }) === 'Ctrl+K' && t('narrow.keys.ctrlT') === 'Ctrl+T (en Codex muestra la transcripción)');

  // El cableado: qué fila ve cada vista, y que un botón no le robe el foco al teclado en pantalla.
  const shell = readFileSync(join(WEB, 'src', 'NarrowShell.tsx'), 'utf8');
  const keysView = readFileSync(join(WEB, 'src', 'TerminalKeys.tsx'), 'utf8');
  check('la Consola ve su fila y la CLI la suya, y al cambiar de vista la fila vuelve al principio',
    /const keysKind = view === 'console' \? 'console' : 'cli';/.test(shell) &&
    /<TerminalKeys key=\{keysKind\} kind=\{keysKind\} onKey=\{onTerminalKey\} \/>/.test(shell) &&
    /terminalKeyRows\(kind\)/.test(keysView));
  check('cada botón manda su secuencia, y no toma el foco: si no, el teclado en pantalla se cerraría',
    /onClick=\{\(\) => onKey\(key\.data\)\}/.test(keysView) && /onPointerDown=\{\(event\) => event\.preventDefault\(\)\}/.test(keysView));
}

// --- 3b. Enter en el cuadro de escritura --------------------------------------------
{
  const key = (mods = {}) => ({ shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...mods });
  check('en la PC, Enter manda y Shift+Enter o Alt+Enter no',
    enterSubmits(key(), false) && !enterSubmits(key({ shiftKey: true }), false) && !enterSubmits(key({ altKey: true }), false));
  check('en una pantalla táctil, Enter salta de línea: se manda con el botón',
    !enterSubmits(key(), true) && !enterSubmits(key({ shiftKey: true }), true));
  check('con un teclado físico en la pantalla táctil, Ctrl+Enter (o Cmd+Enter) manda',
    enterSubmits(key({ ctrlKey: true }), true) && enterSubmits(key({ metaKey: true }), true) &&
    !enterSubmits(key({ ctrlKey: true, shiftKey: true }), true));
}

// --- 3c. Deslizar el dedo sobre la terminal -----------------------------------------
{
  check('un toque que se mueve poco no es un arrastre: sigue abriendo el teclado',
    !isDrag(0, 0) && !isDrag(DRAG_SLOP_PX - 1, 0) && !isDrag(3, -3) && isDrag(0, DRAG_SLOP_PX + 1) && isDrag(-10, 2));
  // El dedo sube 300 px en 60 ms: la terminal va hacia el final, como la rueda hacia abajo.
  const flick = [{ t: 1000, y: 700 }, { t: 1020, y: 600 }, { t: 1040, y: 500 }, { t: 1060, y: 400 }];
  const up = releaseVelocity(flick, 1065);
  check('soltar tras un deslizón rápido hacia arriba da velocidad hacia el final', up > 4 && up <= MOMENTUM_MAX_VELOCITY, String(up));
  const down = releaseVelocity(flick.map((sample) => ({ ...sample, y: 1100 - sample.y })), 1065);
  check('y hacia abajo, hacia el principio, con la misma rapidez', Math.abs(down + up) < 1e-9, String(down));
  check('muy rápido no pasa del tope: un dedo no manda miles de líneas',
    releaseVelocity([{ t: 0, y: 2000 }, { t: 10, y: 0 }], 10) === MOMENTUM_MAX_VELOCITY);
  check('si el dedo se quedó quieto antes de soltar, no hay inercia', releaseVelocity(flick, 1200) === 0);
  check('con una sola muestra, tampoco', releaseVelocity([{ t: 0, y: 10 }], 5) === 0 && releaseVelocity([], 5) === 0);
  check('sólo cuenta el final del gesto: un arranque lento no frena un final rápido',
    releaseVelocity([{ t: 0, y: 900 }, { t: 500, y: 890 }, ...flick.map((s) => ({ ...s, t: s.t - 400 }))], 665) > 4);

  // La inercia se frena sola, cada vez menos, y siempre termina.
  let velocity = up;
  let travelled = 0;
  let frames = 0;
  let slowing = true;
  while (velocity !== 0 && frames < 10_000) {
    const step = momentumStep(velocity, 16);
    if (Math.abs(step.velocity) > Math.abs(velocity)) slowing = false;
    travelled += step.delta;
    velocity = step.velocity;
    frames += 1;
  }
  check('la inercia avanza en la dirección del gesto, se frena y termina en menos de 4 s',
    travelled > 300 && slowing && frames < 250 && velocity === 0, `${Math.round(travelled)} px en ${frames} cuadros`);
  check('por debajo del mínimo no arranca', momentumStep(MOMENTUM_MIN_VELOCITY / 2, 16).velocity === 0);
  check('un cuadro muy tardío (la pestaña estuvo en segundo plano) no hace saltar la terminal',
    Math.abs(momentumStep(2, 5000).delta) <= 2 * 50);
  // xterm redondea el desplazamiento: los restos se juntan para no perder distancia.
  let carry = 0;
  let sent = 0;
  for (let i = 0; i < 12; i++) {
    const whole = wholePixels(carry + 0.25);
    sent += whole.pixels;
    carry = whole.rest;
  }
  check('los restos de píxel se acumulan: doce pasos de 0,25 px mandan 3 px', sent === 3 && carry === 0, `${sent} + ${carry}`);
  const negative = wholePixels(-2.7);
  check('y hacia atrás igual', negative.pixels === -2 && Math.abs(negative.rest + 0.7) < 1e-9, json(negative));
}

// --- 4. El CSS de la vista angosta no se sale de sus @media ---------------------
{
  const css = readFileSync(join(WEB, 'src', 'styles.css'), 'utf8');
  /** El cuerpo del bloque `@media <query>`, por conteo de llaves. */
  const mediaBlock = (query) => {
    const starts = [];
    for (let at = css.indexOf(`@media ${query}`); at !== -1; at = css.indexOf(`@media ${query}`, at + 1)) starts.push(at);
    if (starts.length !== 1) return { count: starts.length, body: '' };
    const open = css.indexOf('{', starts[0]);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) return { count: 1, body: css.slice(open + 1, i) };
      }
    }
    return { count: 1, body: '' };
  };
  /**
   * Los selectores de un bloque, uno por regla y por coma, sin comentarios. Un
   * `@container` adentro (el medidor del plan, §6.37) no es un selector: cuenta
   * lo que va dentro de el.
   */
  const selectors = (body) =>
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}')
      .map((rule) => {
        const parts = rule.split('{');
        return parts.length < 2 ? '' : parts[parts.length - 2].replace(/^\s*@container[^{]*$/, '').trim();
      })
      .filter((selector) => selector.length > 0)
      .flatMap((selector) => selector.split(',').map((part) => part.trim()));

  const narrow = mediaBlock(NARROW_MEDIA_QUERY);
  check('hay un solo bloque @media de la vista angosta, y no está vacío', narrow.count === 1 && narrow.body.trim().length > 0);
  const narrowSelectors = selectors(narrow.body);
  const loose = narrowSelectors.filter((selector) => !/^(\.app-narrow\b|\.narrow-)/.test(selector));
  check(`las ${narrowSelectors.length} reglas de la vista angosta llevan .app-narrow o .narrow-: el escritorio no las ve`,
    narrowSelectors.length > 20 && loose.length === 0, loose.slice(0, 5).join(' | '));

  const touch = mediaBlock(TOUCH_MEDIA_QUERY);
  check('hay un solo bloque @media táctil', touch.count === 1 && touch.body.trim().length > 0);
  const touchSelectors = selectors(touch.body);
  const ALLOWED_TOUCH = /^(\.session-action|\.session-continue|\.session-move|\.session-row|\.project-action|\.project-actions|\.tab-close|\.chip-remove|\.turn-actions|\.tree-action|\.md-code-copy|\.strip-tab-close|\.icon-button|\.tree-item|\.session-item|\.project-row|\.tab\b|\.question-option|\.side-panel-tab|\.strip-tab\b|\.link-button|\.narrow-)/;
  const foreign = touchSelectors.filter((selector) => !ALLOWED_TOUCH.test(selector));
  check('el bloque táctil solo toca lo que aparecía con el mouse y los objetivos táctiles', foreign.length === 0, foreign.slice(0, 5).join(' | '));
  // En la regla que los muestra, no en cualquiera del bloque: un tamaño de dedo
  // para un botón invisible no sirve (29-10-2026).
  const shownRule = touch.body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('}')
    .map((rule) => rule.split('{'))
    .find((parts) => parts.length === 2 && /opacity:\s*1;/.test(parts[1]) && /pointer-events:\s*auto;/.test(parts[1]));
  const shown = shownRule === undefined ? [] : shownRule[0].split(',').map((part) => part.trim());
  check('lo que aparecía con el mouse queda visible en táctil',
    ['.session-action', '.project-action', '.session-continue', '.session-move', '.tab-close', '.chip-remove', '.turn-actions', '.tree-action', '.md-code-copy']
      .every((selector) => shown.includes(selector)), shown.join(' '));
  check('fuera de los dos @media no hay ninguna regla .narrow-',
    !/^\s*\.narrow-/m.test(css.replace(narrow.body, '').replace(touch.body, '')));

  // El chat velado conserva su tamaño (y su scroll), pero no se ve ni se toca nada de
  // adentro: la regla táctil deja visibles los botones de copiar, y sin el
  // `!important` le ganaban al velo y quedaban flotando sobre la otra vista.
  check('el chat velado esconde todo lo de adentro, también lo que lo táctil deja a la vista',
    /\.narrow-pane-veiled,\s*\.narrow-pane-veiled \*\s*\{\s*visibility:\s*hidden !important;\s*pointer-events:\s*none !important;\s*\}/.test(narrow.body));
  check('cada vista apilada es su propia capa: un z-index de adentro no pinta sobre la siguiente',
    /\n  \.narrow-pane \{[^}]*isolation:\s*isolate;/.test(narrow.body));
  const outside = css.replace(narrow.body, '').replace(touch.body, '');
  check('la terminal se queda con el gesto del dedo, en cualquier ancho',
    /\n\.terminal-surface \{[^}]*touch-action:\s*none;/.test(outside));

  // La fila de teclas: una o dos líneas dentro de una caja que se desliza de lado.
  check('la fila de teclas se desliza de lado, y sus líneas miden lo que la más larga para terminar alineadas',
    /\n {2}\.narrow-keys \{[^}]*overflow-x:\s*auto;/.test(narrow.body) &&
    /\n {2}\.narrow-keys-grid \{[^}]*width:\s*max-content;[^}]*min-width:\s*100%;/.test(narrow.body));
  const keyRule = narrow.body.indexOf('.narrow-key {');
  check('Enter lleva su color y su ancho después de `.narrow-key`: antes, la regla de todas se los pisa',
    keyRule > -1 && narrow.body.indexOf('.narrow-key-primary {') > keyRule);
}

// --- 4b. La app del teléfono (hito 38, Fase B) -------------------------------------
{
  const closed = { dialogOpen: false, sheetOpen: false, drawerOpen: false };
  check('Atrás cierra lo de más arriba primero: diálogo, hoja, cajón',
    narrowBackAction({ dialogOpen: true, sheetOpen: true, drawerOpen: true, view: 'cli' }) === 'close-dialog' &&
    narrowBackAction({ dialogOpen: false, sheetOpen: true, drawerOpen: true, view: 'cli' }) === 'close-sheet' &&
    narrowBackAction({ dialogOpen: false, sheetOpen: false, drawerOpen: true, view: 'cli' }) === 'close-drawer');
  check('sin nada encima vuelve al chat, y en el chat no hace nada: la app se va al fondo',
    narrowBackAction({ ...closed, view: 'git' }) === 'show-chat' && narrowBackAction({ ...closed, view: 'console' }) === 'show-chat' &&
    narrowBackAction({ ...closed, view: 'chat' }) === null);
  check('la app se reconoce por su marca en el user agent, y un navegador no',
    insidePhoneApp('Mozilla/5.0 (Linux; Android 15; wv) Chrome/124.0 Mobile Safari/537.36 AgentWorkbenchAndroid/0.1.0') &&
    !insidePhoneApp('Mozilla/5.0 (Linux; Android 15) Chrome/124.0 Mobile Safari/537.36') && PHONE_APP_UA_TOKEN === 'AgentWorkbenchAndroid/');
  check('el contrato con la app: la función de Atrás y las direcciones de ajustes y desconectar',
    NATIVE_BACK_HOOK === 'agentWorkbenchBack' && PHONE_APP_SETTINGS_URL === 'agentworkbench://settings' &&
    PHONE_APP_DISCONNECT_URL === 'agentworkbench://disconnect');
  check('los enlaces de la app, en la fila de Conexión, y el selector de sonido tienen sus textos',
    t('narrow.menu.chimeSystem') === 'Del sistema' && t('narrow.menu.chimePage') === 'De esta web' && t('narrow.menu.phoneAppSettings') === 'Ajustes' &&
    t('narrow.menu.phoneAppDisconnect') === 'Desconectar');
}

// --- 5. El viewport -------------------------------------------------------------------
{
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const viewport = /<meta\s+name="viewport"\s+content="([^"]+)"/.exec(html)?.[1] ?? '';
  check('el viewport llega a los bordes y se achica con el teclado en pantalla',
    /width=device-width/.test(viewport) && /viewport-fit=cover/.test(viewport) && /interactive-widget=resizes-content/.test(viewport), viewport);
  check('theme-color, para la barra del sistema', /<meta name="theme-color"/.test(html));
}

// --- 6. Las ramas aparte en el teléfono (hito 48, §6.38) ----------------------------
// Lo mismo que en la PC (decisión 5): la hoja de pestañas lleva la etiqueta de
// rama y el color del proyecto con las mismas reglas que la barra de pestañas.
{
  const shell = readFileSync(join(WEB, 'src', 'NarrowShell.tsx'), 'utf8');
  const tabBar = readFileSync(join(WEB, 'src', 'TabBar.tsx'), 'utf8');
  check('la hoja de pestañas y la barra usan la misma regla de la etiqueta de rama',
    /tabBranch\(terminal, terminals, platform\)/.test(shell) && /tabBranch\(terminal, terminals, platform\)/.test(tabBar));
  check('y el mismo color de proyecto',
    /projectColor\(tabColorCwd\(terminal\)\)/.test(shell) && /projectColor\(tabColorCwd\(activeTerminal\)\)/.test(shell) &&
      /projectColor\(tabColorCwd\(terminal\)\)/.test(tabBar));
}

// --- 7. La barra del hilo plegable (29-10-2026) ---------------------------------------
// Se pliegan la búsqueda y sus botones; los medidores quedan siempre. En el
// teléfono empieza plegada, en la PC desplegada, y cada vista guarda la suya.
{
  check('la PC y la vista angosta guardan en claves distintas',
    threadToolsStorageKey(false) === THREAD_TOOLS_STORAGE_KEY && threadToolsStorageKey(true) === NARROW_THREAD_TOOLS_STORAGE_KEY &&
      THREAD_TOOLS_STORAGE_KEY !== NARROW_THREAD_TOOLS_STORAGE_KEY);
  check('sin nada guardado: desplegada en la PC, plegada en el teléfono',
    defaultThreadToolsOpen(false) === true && defaultThreadToolsOpen(true) === false);
  check('lo guardado vuelve tal cual, y lo que no tiene forma no se toma',
    parseStoredThreadTools(threadToolsValue(true)) === true && parseStoredThreadTools(threadToolsValue(false)) === false &&
      parseStoredThreadTools('true') === null && parseStoredThreadTools('') === null);

  const view = readFileSync(join(WEB, 'src', 'ConversationView.tsx'), 'utf8');
  check('plegada se van la búsqueda, CLI, Rama y la letra',
    /\{toolsOpen && \(\s*<input\s+className="conversation-search-input"/.test(view) &&
      /\{toolsOpen && onContinue !== undefined && \(/.test(view) && /\{toolsOpen && onMoveToBranch !== undefined && \(/.test(view) &&
      /\{toolsOpen && threadFont !== undefined && \(/.test(view));
  check('los medidores no dependen de que esté desplegada',
    /\n {8}<div className="thread-meters">/.test(view) && !/toolsOpen && \(\s*<div className="thread-meters">/.test(view));
  check('plegarla borra la búsqueda, y un acierto del buscador general la despliega',
    /if \(toolsOpen\) setQuery\(''\);/.test(view) && /setQuery\(searchRequest\.query\);\s*setToolsOpen\?\.\(true\);/.test(view));

  const css = readFileSync(join(WEB, 'src', 'styles.css'), 'utf8');
  check('en el teléfono, plegada, el botón y los medidores van en una sola línea',
    /\n {2}\.app-narrow \.thread-tools-closed \.thread-meters \{\s*flex: 1 1 0;/.test(css));
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
