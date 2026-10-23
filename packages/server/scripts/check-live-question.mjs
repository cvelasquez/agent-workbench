/**
 * Chequeo de la pregunta leida de la pantalla (23-10-2026, §5.5.4).
 *
 *   npx tsx scripts/check-live-question.mjs
 *
 * Claude Code no escribe la pregunta de `AskUserQuestion` en su historial hasta
 * que se contesta, y la app la lee del menu que la CLI dibuja. Lo que se rompe
 * en silencio:
 *
 *  - **Contestar otra cosa.** Una lectura que corre las opciones, o un menu
 *    tocado en la solapa CLI que se toma por recien abierto: los numeros eligen
 *    otra opcion, o caen dentro de un texto. Nada se manda sin releer
 *    (`verify`), y el lector es estricto: lo que no tiene la forma medida no es
 *    una pregunta.
 *  - **Leer lo que no se contesta con teclas.** Varias preguntas (se ve una),
 *    opciones con vista previa (el numero no contesta), la lista recortada de
 *    una terminal baja, la pantalla de enviar.
 *  - **Mostrarla dos veces**, si la linea del historial llego antes de
 *    contestarla.
 *  - **Que la tarjeta cambie de id** por un redibujo a medias: la web perderia
 *    lo que ya se mando.
 *
 * Las pantallas son las medidas con la CLI 2.1.309 (`fixtures/question-screens.mjs`).
 * No lanza la CLI, no carga node-pty y no lee `~/.claude`: el home apunta a una
 * carpeta temporal antes de importar nada.
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-workbench-check-live-question-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.APPDATA = path.join(root, 'AppData', 'Roaming');
process.env.LOCALAPPDATA = path.join(root, 'AppData', 'Local');

const shared = await import('@agent-workbench/shared');
const screens = await import('./fixtures/question-screens.mjs');
const { readQuestionScreen, createClaudeCodeScreenQuestions, QUESTION_WAITING_FOR } = await import(
  '../src/agents/claude-code/question-screen.ts'
);
const { LiveQuestionWatch, LIVE_QUESTION_ID_PREFIX } = await import('../src/live-question.ts');
const { buildAnswerKeys, answerKeysRefusal, ANSWER_FREE_TEXT_MULTI_TEXT, ANSWER_INVALID_TEXT } = await import(
  '../src/pty-input.ts'
);
const { ConversationHub } = await import('../src/conversation-hub.ts');
const { AgentRegistry } = await import('../src/agents/registry.ts');
const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' - ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);

/** Espera por condicion, con tope: nunca un tiempo fijo. */
async function waitFor(condition, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return condition();
}

/** La pregunta del input real, en la forma que lee la pantalla. */
const itemOf = (scenario) => {
  const question = screens.INPUTS[scenario]?.questions?.[0];
  return {
    question: question.question,
    header: question.header,
    multiSelect: question.multiSelect === true,
    options: question.options.map((option) => ({ label: option.label, description: option.description })),
  };
};

// --- A. El lector, contra las pantallas medidas -------------------------------

{
  const basic = readQuestionScreen(screens.BASIC_OPEN);
  check('A1 la basica: pregunta, encabezado y tres opciones con su descripcion, igual que el input',
    basic !== null && same(basic.item, itemOf('q1-basica')), json(basic?.item));
  check('A1 recien abierta esta sin tocar', basic?.untouched === true);

  const moved = readQuestionScreen(screens.BASIC_CURSOR_MOVED);
  check('A2 la marca en otra opcion: la misma pregunta (la clave no lleva la marca)', moved !== null && moved.key === basic?.key);
  check('A2 y sigue sin tocar: el numero elige la opcion este donde este la marca (medido: flecha abajo y el 3 eligio la 3)',
    moved?.untouched === true);

  check('A3 contestada: ya no hay menu', readQuestionScreen(screens.BASIC_ANSWERED) === null);

  const two = readQuestionScreen(screens.TWO_OPTIONS);
  check('A4 dos opciones, con el pie en la ultima fila de la pantalla', two !== null && same(two.item, itemOf('q2-cancelar')),
    json(two?.item));

  const long = readQuestionScreen(screens.LONG_OPEN);
  check('A5 la pregunta larga va con la barra a la izquierda: se quita y se juntan las lineas, igual que el input',
    long !== null && same(long.item, itemOf('q3-larga')), json(long?.item));

  check('A6 un redibujo a medias al achicar la terminal no es una pregunta', readQuestionScreen(screens.LONG_RESIZED) === null);

  const writing = readQuestionScreen(screens.LONG_WRITING);
  check('A7 con la marca en "Type something" es la misma pregunta', writing !== null && writing.key === long?.key);
  check('A7 pero tocada: ahi un numero se escribe como texto', writing?.untouched === false);

  const multi = readQuestionScreen(screens.MULTI_OPEN);
  check('A8 opcion multiple: las etiquetas sin la casilla, y la de enviar no es una opcion',
    multi !== null && same(multi.item, itemOf('q4-multiple')), json(multi?.item));
  check('A8 recien abierta, sin tocar', multi?.untouched === true);

  const checked = readQuestionScreen(screens.MULTI_CHECKED);
  check('A9 con una casilla marcada en la solapa CLI: la misma pregunta', checked !== null && checked.key === multi?.key);
  check('A9 pero tocada: el numero la desmarcaria', checked?.untouched === false);

  check('A10 la pantalla de enviar no es una pregunta', readQuestionScreen(screens.MULTI_REVIEW) === null);
  check('A11 dos preguntas en una llamada: se ve una sola, no se lee', readQuestionScreen(screens.TWO_QUESTIONS) === null);
  check('A12 opciones con vista previa: el numero no contesta (medido), no se lee', readQuestionScreen(screens.PREVIEW) === null);

  const narrow = readQuestionScreen(screens.NARROW);
  check('A13 en 45 columnas: la pregunta y el pie partidos en dos lineas se juntan', narrow !== null && same(narrow.item, itemOf('q8-angosta')),
    json(narrow?.item));
  check('A13 y es la misma pregunta que en 110 columnas', narrow?.key === basic?.key);

  check('A14 la lista recortada de una terminal baja, sin la pregunta: no se lee', readQuestionScreen(screens.SHORT) === null);

  const markdown = readQuestionScreen(screens.MARKDOWN);
  check('A15 markdown sin dibujar, una etiqueta "1. Instalar" y una descripcion "2. Despues": igual que el input',
    markdown !== null && same(markdown.item, itemOf('r1-markdown')), json(markdown?.item));

  const medium = readQuestionScreen(screens.MEDIUM_OPEN);
  check('A16 una pregunta de dos lineas, con la barra', medium !== null && same(medium.item, itemOf('r3-mediana')), json(medium?.item));
  check('A17 con la marca en "Type something" por flechas: tocada', readQuestionScreen(screens.MEDIUM_ON_WRITE)?.untouched === false);
  check('A18 con texto escrito en la respuesta propia: no se lee', readQuestionScreen(screens.MEDIUM_TYPED) === null);

  const newline = readQuestionScreen(screens.NEWLINE);
  const newlineInput = itemOf('r4-dos-parrafos');
  check('A19 un salto de linea en la pregunta se lee como espacio, y las opciones sin descripcion quedan sin ella',
    newline !== null && same(newline.item, { ...newlineInput, question: newlineInput.question.replace(/\n/g, ' ') }), json(newline?.item));

  const cut = readQuestionScreen(screens.NARROW_LONG_LABELS);
  const cutInput = itemOf('r5-etiqueta-larga');
  check('A20 etiquetas partidas en 45 columnas: se lee, con las dos opciones en su numero',
    cut !== null && cut.item.options.length === 2);
  check('A20 lo partido de la etiqueta pasa a la descripcion, pero no se pierde nada (limite conocido, §5.5.4)',
    cut !== null && cut.item.options.every((option, index) => {
      const input = cutInput.options[index];
      return `${option.label} ${option.description}` === `${input.label} ${input.description}`;
    }), json(cut?.item.options));
  check('A20 y sigue casando con la del historial: la etiqueta leida es el principio de la de verdad',
    cut !== null && shared.sameQuestionItem(cut.item, cutInput));
  check('A20 (control) una etiqueta distinta no casa',
    cut !== null && !shared.sameQuestionItem(cut.item, { ...cutInput, options: [cutInput.options[0], { label: 'Otra cosa', description: '' }] }));

  const four = readQuestionScreen(screens.FOUR_OPTIONS);
  check('A21 cuatro opciones en 110x24', four !== null && same(four.item, itemOf('r6-cuatro-cortas')), json(four?.item));
  check('A22 con la marca en "Chat about this": tocada (medido: el numero no hace nada ahi)',
    readQuestionScreen(screens.FOUR_ON_CHAT)?.untouched === false);

  // La del historial casa con la leida: el hub no muestra dos y la web marca la de verdad.
  const pairs = [
    [basic, 'q1-basica'], [two, 'q2-cancelar'], [long, 'q3-larga'], [multi, 'q4-multiple'], [narrow, 'q8-angosta'],
    [markdown, 'r1-markdown'], [medium, 'r3-mediana'], [newline, 'r4-dos-parrafos'], [four, 'r6-cuatro-cortas'],
  ];
  check('A23 cada pregunta leida casa con la del historial (sameQuestionItem)',
    pairs.every(([read, scenario]) => read !== null && shared.sameQuestionItem(read.item, itemOf(scenario))));
  check('A23 (control) dos preguntas distintas no casan', !shared.sameQuestionItem(basic.item, two.item));

  // Lo que no tiene la forma medida no es una pregunta.
  const base = screens.BASIC_OPEN;
  const replaceLine = (lines, from, to) => lines.map((line) => (line === from ? to : line));
  check('A24 una opcion sin su numero de corrido: no se lee',
    readQuestionScreen(replaceLine(base, '  3. DuckDB', '  5. DuckDB')) === null);
  check('A24 "Chat about this" con un numero que no sigue: no se lee',
    readQuestionScreen(replaceLine(base, '  5. Chat about this', '  7. Chat about this')) === null);
  check('A24 sin encabezado: no se lee', readQuestionScreen(replaceLine(base, ' ☐ Base', 'Base')) === null);
  check('A24 una linea que no es de una opcion entre las opciones: no se lee',
    readQuestionScreen(replaceLine(base, '     Un archivo local, sin servidor.', 'Un archivo local, sin servidor.')) === null);
  check('A24 otro pie: no se lee',
    readQuestionScreen(replaceLine(base, 'Enter to select · ↑/↓ to navigate · Esc to cancel', 'Enter to confirm · Esc to exit')) === null);
  check('A24 el pie de la vista previa: no se lee',
    readQuestionScreen(replaceLine(base, 'Enter to select · ↑/↓ to navigate · Esc to cancel',
      'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel')) === null);
  check('A24 casillas en una sin barra de solapas: no se lee',
    readQuestionScreen(replaceLine(base, '  2. SQLite', '  2. [ ] SQLite')) === null);
  check('A24 una flecha de lista recortada en lugar de la marca: no se lee',
    readQuestionScreen(replaceLine(base, '  3. DuckDB', '↓ 3. DuckDB')) === null);

  /*
    Cada senal de "tocada" y de "varias preguntas" sola, sin la que en la CLI
    real la acompana: medidas, aparecen juntas, y una sola defensa rota no se
    notaria.
  */
  const FOOTER = 'Enter to select · ↑/↓ to navigate · Esc to cancel';
  const FOOTER_EDIT = 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Notepad · Esc to cancel';
  const markerOnWrite = replaceLine(replaceLine(base, '❯ 1. PostgreSQL', '  1. PostgreSQL'), '  4. Type something.', '❯ 4. Type something.');
  check('A26 la marca en "Type something", sin el ctrl+g del pie: tocada', readQuestionScreen(markerOnWrite)?.untouched === false);
  check('A26 el ctrl+g en el pie con la marca en una opcion: tocada',
    readQuestionScreen(replaceLine(base, FOOTER, FOOTER_EDIT))?.untouched === false);
  check('A26 una casilla marcada con el cuadrito sin tachar: tocada',
    readQuestionScreen(replaceLine(screens.MULTI_CHECKED, '←  ☒ Revisión  ✔ Submit  →', '←  ☐ Revisión  ✔ Submit  →'))?.untouched === false);
  check('A26 el cuadrito tachado sin casillas marcadas: tocada',
    readQuestionScreen(replaceLine(screens.MULTI_OPEN, '←  ☐ Revisión  ✔ Submit  →', '←  ☒ Revisión  ✔ Submit  →'))?.untouched === false);
  check('A26 dos preguntas con el pie de una sola: no se lee (la barra de solapas)',
    readQuestionScreen(replaceLine(screens.TWO_QUESTIONS, 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel', FOOTER)) === null);
  check('A26 una de opcion multiple con otra pregunta en la barra, y el pie de una sola: no se lee',
    readQuestionScreen(replaceLine(screens.MULTI_OPEN, '←  ☐ Revisión  ✔ Submit  →', '←  ☐ Revisión  ☐ Otra  ✔ Submit  →')) === null);
  check('A26 el pie de varias preguntas con una sola solapa: no se lee',
    readQuestionScreen(replaceLine(screens.TWO_QUESTIONS, '←  ☐ Lenguaje  ☐ Pruebas  ✔ Submit  →', ' ☐ Lenguaje')) === null);
  check('A26 (control) la de una pregunta armada asi se lee',
    readQuestionScreen(replaceLine(replaceLine(screens.TWO_QUESTIONS, 'Enter to select · Tab/Arrow keys to navigate · Esc to cancel', FOOTER),
      '←  ☐ Lenguaje  ☐ Pruebas  ✔ Submit  →', ' ☐ Lenguaje'))?.untouched === true);

  const adapter = createClaudeCodeAdapter();
  check('A25 Claude Code declara el lector, para "input needed", y tarjetas de pregunta',
    adapter.screenQuestions?.waitingFor === QUESTION_WAITING_FOR && QUESTION_WAITING_FOR === 'input needed' &&
      adapter.screenQuestions?.read === readQuestionScreen && adapter.capabilities.questionCards === true);
  adapter.dispose();
}

// --- B. Las teclas de una pregunta leida ---------------------------------------

{
  const shapeOf = (read) => read.item.options.length > 0 ? [{ multiSelect: read.item.multiSelect, optionCount: read.item.options.length }] : [];
  const basic = readQuestionScreen(screens.BASIC_OPEN);
  check('B1 la tercera opcion es el 3 (medido: DuckDB)', same(buildAnswerKeys(shapeOf(basic), [[2]]), ['3']));
  check('B2 la respuesta escrita es el numero de "Type something", el pegado y Enter (medido con el 5 de cuatro opciones)',
    same(buildAnswerKeys(shapeOf(readQuestionScreen(screens.LONG_OPEN)), [{ kind: 'free', text: 'otra' }]),
      ['5', '\x1b[200~otra\x1b[201~', '\r']));
  const multi = readQuestionScreen(screens.MULTI_OPEN);
  check('B3 opcion multiple: marca, Tab y enviar (medido: "Servidor, Android")',
    same(buildAnswerKeys(shapeOf(multi), [[0, 2]]), ['1', '3', '\t', '1']));
  const free = [{ kind: 'free', text: 'x' }];
  check('B4 opcion multiple con respuesta escrita: no hay teclas (medido: el texto se pierde)',
    buildAnswerKeys(shapeOf(multi), free) === null);
  check('B4 y el aviso lo dice', answerKeysRefusal(shapeOf(multi), free) === ANSWER_FREE_TEXT_MULTI_TEXT);
  check('B4 (control) lo demas es "no corresponde"', answerKeysRefusal(shapeOf(basic), [[7]]) === ANSWER_INVALID_TEXT);
}

// --- C. El vigilante de la pantalla ----------------------------------------------

/** Una pantalla de mentira: devuelve las lineas que se le pongan y cuenta las lecturas. */
function fakeScreen(initial) {
  const state = { lines: initial, reads: 0, disposed: false };
  return {
    state,
    screen: {
      feed: () => undefined,
      lines: async () => {
        state.reads += 1;
        return state.lines;
      },
      dispose: () => {
        state.disposed = true;
      },
    },
  };
}
const FAST = { fastPollMs: 2, slowPollMs: 2, settleMs: 1_000, verifyTimeoutMs: 500 };
const reader = createClaudeCodeScreenQuestions();

{
  const fake = fakeScreen(screens.BASIC_OPEN);
  let changes = 0;
  let next = 0;
  const watch = new LiveQuestionWatch({
    openScreen: () => fake.screen,
    reader,
    onChange: () => (changes += 1),
    timing: FAST,
    newId: () => `${LIVE_QUESTION_ID_PREFIX}${++next}`,
  });
  watch.start();
  await waitFor(() => watch.current() !== null);
  const first = watch.current();
  check('C1 se publica la pregunta leida, con un id de la app', first?.part.toolUseId === `${LIVE_QUESTION_ID_PREFIX}1` &&
    same(first?.part.questions, [readQuestionScreen(screens.BASIC_OPEN).item]), json(first));
  check('C1 solo despues de dos lecturas iguales', fake.state.reads >= 2);

  fake.state.lines = screens.BASIC_CURSOR_MOVED;
  const readsBefore = fake.state.reads;
  await waitFor(() => fake.state.reads >= readsBefore + 6);
  check('C3 mover la marca no cambia la tarjeta ni su id', changes === 1 && watch.current()?.part.toolUseId === first?.part.toolUseId);

  check('C6 releer antes de contestar: la misma, sin tocar', (await watch.verify(first.part.toolUseId)) === 'ok');
  check('C6 con otro id: ya no es la que se muestra', (await watch.verify('screen-otro')) === 'gone');

  fake.state.lines = screens.TWO_OPTIONS;
  check('C6 otra pregunta en pantalla: cambio', (await watch.verify(first.part.toolUseId)) === 'changed');

  fake.state.lines = screens.BASIC_ANSWERED;
  await waitFor(() => watch.current() === null);
  check('C4 sin menu en pantalla, se deja de publicar', watch.current() === null && changes >= 2);

  fake.state.lines = screens.BASIC_OPEN;
  await waitFor(() => watch.current() !== null);
  check('C5 la misma pregunta que vuelve (un redibujo a medias) conserva su id', watch.current()?.part.toolUseId === first?.part.toolUseId);

  watch.stop();
  const readsAtStop = fake.state.reads;
  check('C8 parar suelta la pantalla y no publica nada', fake.state.disposed && watch.current() === null);
  // Otro vigilante como reloj: cuando el haya leido varias veces, el parado tuvo tiempo de leer y no lo hizo.
  const clock = fakeScreen(screens.BASIC_OPEN);
  const ticking = new LiveQuestionWatch({ openScreen: () => clock.screen, reader, onChange: () => undefined, timing: FAST });
  ticking.start();
  await waitFor(() => clock.state.reads >= 8);
  ticking.stop();
  check('C8 y no vuelve a leer', fake.state.reads <= readsAtStop + 1, `${readsAtStop} -> ${fake.state.reads}`);
}

{
  // Una pantalla que no se queda quieta no publica nada.
  const fake = fakeScreen(screens.BASIC_OPEN);
  let flip = false;
  fake.screen.lines = async () => {
    fake.state.reads += 1;
    flip = !flip;
    return flip ? screens.BASIC_OPEN : screens.TWO_OPTIONS;
  };
  const watch = new LiveQuestionWatch({ openScreen: () => fake.screen, reader, onChange: () => undefined, timing: FAST });
  watch.start();
  await waitFor(() => fake.state.reads >= 12);
  check('C2 una pantalla que cambia en cada lectura no se publica', watch.current() === null);
  watch.stop();
}

{
  const fake = fakeScreen(screens.MULTI_OPEN);
  const watch = new LiveQuestionWatch({ openScreen: () => fake.screen, reader, onChange: () => undefined, timing: FAST });
  watch.start();
  await waitFor(() => watch.current() !== null);
  fake.state.lines = screens.MULTI_CHECKED;
  check('C6 la misma con una casilla marcada en la solapa CLI: tocada', (await watch.verify(watch.current().part.toolUseId)) === 'touched');
  fake.state.lines = screens.BASIC_ANSWERED;
  check('C6 sin menu: ya no esta', (await watch.verify(watch.current()?.part.toolUseId ?? '')) === 'gone');
  watch.stop();
}

{
  const fake = fakeScreen(screens.BASIC_OPEN);
  const throwing = { waitingFor: 'input needed', read: () => { throw new Error('lector roto'); } };
  const watch = new LiveQuestionWatch({ openScreen: () => fake.screen, reader: throwing, onChange: () => undefined, timing: FAST });
  watch.start();
  await waitFor(() => fake.state.reads >= 4);
  check('C7 un lector que falla no publica nada ni tira el servidor', watch.current() === null);
  watch.stop();

  const none = new LiveQuestionWatch({ openScreen: () => null, reader, onChange: () => undefined, timing: FAST });
  none.start();
  check('C9 sin pantalla (sin proceso), nada', none.current() === null && (await none.verify('screen-x')) === 'gone');
  check('C9 y la del historial se contesta como siempre', (await none.check(itemOf('q1-basica'))) === 'unknown');
  none.stop();
}

{
  // La pregunta del historial (la CLI la escribio antes de contestarla): tambien se relee.
  const fake = fakeScreen(screens.BASIC_OPEN);
  const watch = new LiveQuestionWatch({ openScreen: () => fake.screen, reader, onChange: () => undefined, timing: FAST });
  watch.start();
  check('C10 la del historial, la misma en pantalla y sin tocar', (await watch.check(itemOf('q1-basica'))) === 'ok');
  fake.state.lines = screens.BASIC_CURSOR_MOVED;
  check('C10 con la marca movida sigue bien', (await watch.check(itemOf('q1-basica'))) === 'ok');
  fake.state.lines = screens.LONG_WRITING;
  check('C10 con la marca en "Type something": tocada', (await watch.check(itemOf('q3-larga'))) === 'touched');
  fake.state.lines = screens.TWO_OPTIONS;
  check('C10 otra pregunta en pantalla: cambio', (await watch.check(itemOf('q1-basica'))) === 'changed');
  fake.state.lines = screens.NARROW_LONG_LABELS;
  check('C10 la misma con las etiquetas partidas (45 columnas): bien', (await watch.check(itemOf('r5-etiqueta-larga'))) === 'ok');
  fake.state.lines = screens.TWO_QUESTIONS;
  check('C10 varias preguntas no se leen: se contesta como siempre', (await watch.check(itemOf('q1-basica'))) === 'unknown');
  fake.state.lines = screens.BASIC_ANSWERED;
  check('C10 sin menu: tampoco se sabe', (await watch.check(itemOf('q1-basica'))) === 'unknown');
  watch.stop();
}

// --- D. El hub: cuando se lee, cuando no, y la del historial gana --------------

/**
 * Una CLI de mentira con lo justo: estado que el chequeo empuja, tarjetas de
 * pregunta, el lector de Claude Code y un seguidor cuyo final se elige.
 */
function fakeCli({ screenQuestions = createClaudeCodeScreenQuestions() } = {}) {
  const listeners = [];
  const tail = { events: [] };
  let pending = [];
  const follower = {
    label: 'mentira.jsonl',
    start: async () => undefined,
    poll: async () => {
      const added = pending;
      pending = [];
      return { reset: false, added, turns: [], plans: [], parts: [] };
    },
    getState: () => 'live',
    getUsage: () => ({ ...shared.EMPTY_CONTEXT_USAGE }),
    getPermissionMode: () => null,
    getTail: () => ({ events: tail.events, hasMore: false }),
    getPageBefore: () => ({ events: [], hasMore: false }),
    getPlanFiles: () => [],
    readImage: async () => null,
    noticeChange: (filePath) => filePath === 'mentira.jsonl',
    hasOpenToolCall: () => false,
    runningSubagents: () => [],
  };
  const adapter = {
    id: 'claude-code', label: 'Mentira', command: 'mentira', installUrl: 'https://example.com',
    capabilities: { ...shared.NO_CAPABILITIES, questionCards: true },
    locate: async () => null, missingMessage: () => ({ key: 'raw', params: { text: 'falta' } }),
    launch: () => { throw new Error('no'); },
    environment: (base) => ({ env: { ...base }, notice: null }), onSpawned: () => null,
    history: {
      roots: () => [], list: async () => null, changedRefs: async () => null, item: async () => null,
      scan: async () => { throw new Error('no'); }, restored: () => undefined, exists: async () => false,
      follow: () => follower, plans: null,
    },
    status: {
      subscribe: (_sessionId, listener) => {
        listeners.push(listener);
        return () => listeners.splice(listeners.indexOf(listener), 1);
      },
      waitUntilReady: async () => true,
      dispose: () => undefined,
    },
    ...(screenQuestions === null ? {} : { screenQuestions }),
    defaults: async () => null, protectedDirs: () => [], dispose: () => undefined,
  };
  return {
    adapter,
    tail,
    push: (status) => listeners.forEach((listener) => listener(status)),
    arrive: (events) => {
      pending = events;
      tail.events = [...tail.events, ...events];
    },
  };
}

function hubWith(cli, screen) {
  let opened = 0;
  const registry = {
    get: (terminalId) => terminalId === 't1'
      ? { terminalId: 't1', kind: 'agent', cwd: root, agent: 'claude-code', sessionId: '11111111-2222-4333-8444-555555555555',
          label: 't1', resumed: false, createdAt: 0, alive: true, exitCode: null, sleeping: false }
      : null,
    on: () => undefined,
    launchedAtOf: () => 1,
    watchScreen: () => {
      opened += 1;
      return screen;
    },
  };
  const hub = new ConversationHub(registry, new AgentRegistry([cli.adapter]));
  const emitted = [];
  hub.on('liveQuestion', (terminalId, question) => emitted.push({ terminalId, question }));
  return { hub, emitted, opened: () => opened };
}

const WAITING = { activity: 'waiting', waitingFor: 'input needed' };

{
  const cli = fakeCli();
  const fake = fakeScreen(screens.BASIC_OPEN);
  const { hub, emitted, opened } = hubWith(cli, fake.screen);
  const snapshot = await hub.subscribe('t1');
  check('D1 sin espera, el snapshot no trae pregunta', snapshot?.liveQuestion === null);

  cli.push(WAITING);
  await waitFor(() => emitted.length > 0, 5_000);
  const shown = emitted.at(-1)?.question;
  check('D2 esperando "input needed" con el menu en pantalla: se avisa la pregunta',
    shown?.kind === 'question' && shown.toolUseId.startsWith(LIVE_QUESTION_ID_PREFIX) &&
      same(shown.questions, [readQuestionScreen(screens.BASIC_OPEN).item]), json(shown));
  check('D2 y es la que contesta el socket', hub.getLiveQuestion('t1')?.toolUseId === shown?.toolUseId);
  check('D2 el snapshot la trae', hub.getSnapshot('t1')?.liveQuestion?.toolUseId === shown?.toolUseId);
  check('D3 releer antes de contestar: ok', (await hub.verifyLiveQuestion('t1', shown.toolUseId)) === 'ok');
  check('D3 con otro id, o sin seguir la pestana: ya no esta',
    (await hub.verifyLiveQuestion('t1', 'screen-otro')) === 'gone' && (await hub.verifyLiveQuestion('t9', shown.toolUseId)) === 'gone');

  const historyPart = { kind: 'question', toolUseId: 'toolu_1', questions: [itemOf('q1-basica')] };
  check('D8 la del historial se relee con la pantalla de la espera', (await hub.checkHistoryQuestion('t1', historyPart)) === 'ok');
  check('D8 una de varias preguntas no se relee',
    (await hub.checkHistoryQuestion('t1', { ...historyPart, questions: [itemOf('q1-basica'), itemOf('q2-cancelar')] })) === 'unknown');
  check('D8 una pestana que nadie sigue tampoco', (await hub.checkHistoryQuestion('t9', historyPart)) === 'unknown');

  // La linea de la pregunta llega al historial sin respuesta: gana la tarjeta de siempre.
  const input = itemOf('q1-basica');
  cli.arrive([{ eventId: 'e-pregunta', role: 'assistant', timestamp: null, parts: [{ kind: 'question', toolUseId: 'toolu_1', questions: [input] }] }]);
  hub.onHistoryChanged('claude-code', 'mentira.jsonl');
  await waitFor(() => emitted.at(-1)?.question === null, 5_000);
  check('D4 la pregunta que llego al historial antes de contestarla no se muestra dos veces',
    emitted.at(-1)?.question === null && hub.getLiveQuestion('t1') === null);

  cli.push({ activity: 'busy', waitingFor: null });
  check('D5 al dejar de esperar se suelta la pantalla', fake.state.disposed);
  check('D5 la pantalla se abrio una sola vez en toda la espera', opened() === 1);
  hub.disposeAll();
}

{
  const cli = fakeCli();
  const fake = fakeScreen(screens.BASIC_OPEN);
  const { hub, emitted, opened } = hubWith(cli, fake.screen);
  await hub.subscribe('t1');
  cli.push(WAITING);
  await waitFor(() => emitted.length > 0, 5_000);
  cli.push({ activity: 'idle', waitingFor: null });
  check('D5 contestada en la solapa CLI: al dejar de esperar se avisa que ya no hay',
    emitted.at(-1)?.question === null && hub.getLiveQuestion('t1') === null);

  // El oyente del estado decide en el acto: si fuera a leer, ya habria abierto la pantalla.
  cli.push({ activity: 'waiting', waitingFor: 'permission prompt' });
  check('D6 un permiso no se lee de la pantalla', opened() === 1);
  hub.disposeAll();
}

{
  const cli = fakeCli({ screenQuestions: null });
  const fake = fakeScreen(screens.BASIC_OPEN);
  const { hub, opened } = hubWith(cli, fake.screen);
  await hub.subscribe('t1');
  cli.push(WAITING);
  check('D7 una CLI sin lector no abre la pantalla nunca', opened() === 0 && hub.getLiveQuestion('t1') === null);
  hub.disposeAll();
}

// --- F. La web: la tarjeta del historial hereda lo de la leida -----------------

{
  const { liveCarryOvers } = await import('../../web/src/live-question-ui.ts');
  const base = itemOf('q1-basica');
  const asked = (id, item = base) => ({ eventId: `e-${id}`, role: 'assistant', parts: [{ kind: 'question', toolUseId: id, questions: [item] }] });
  const record = (patch = {}) => ({ terminalId: 't1', item: base, selections: [[1]], failure: null, ...patch });

  const sent = liveCarryOvers([asked('toolu_1')], new Map([['screen-1', record()]]), 't1');
  check('F1 la mandada desde la leida: la del historial hereda lo elegido',
    same(sent, [{ liveId: 'screen-1', toolUseId: 'toolu_1', selections: [[1]], failure: null }]), json(sent));

  const refused = liveCarryOvers([asked('toolu_1')], new Map([['screen-1', record({ selections: null, failure: 'no' })]]), 't1');
  check('F2 la rechazada: hereda el rechazo, no lo elegido (diria "Respondida" con la CLI esperando)',
    same(refused, [{ liveId: 'screen-1', toolUseId: 'toolu_1', selections: null, failure: 'no' }]), json(refused));

  const twice = liveCarryOvers([asked('toolu_viejo'), asked('toolu_nuevo')], new Map([['screen-1', record()]]), 't1');
  check('F3 con la misma pregunta dos veces, la hereda la de abajo', twice.length === 1 && twice[0]?.toolUseId === 'toolu_nuevo', json(twice));

  check('F4 la de otra pestana no', liveCarryOvers([asked('toolu_1')], new Map([['screen-1', record({ terminalId: 't2' })]]), 't1').length === 0);
  check('F5 otra pregunta no', liveCarryOvers([asked('toolu_1', itemOf('q2-cancelar'))], new Map([['screen-1', record()]]), 't1').length === 0);
  const severalParts = { eventId: 'e-x', role: 'assistant', parts: [{ kind: 'question', toolUseId: 'toolu_x', questions: [base, itemOf('q2-cancelar')] }] };
  check('F6 una de varias preguntas no (la leida es siempre de una)', liveCarryOvers([severalParts], new Map([['screen-1', record()]]), 't1').length === 0);

  const two = liveCarryOvers([asked('toolu_a'), asked('toolu_b', itemOf('q2-cancelar'))],
    new Map([['screen-1', record()], ['screen-2', record({ item: itemOf('q2-cancelar'), selections: [[0]] })]]), 't1');
  check('F7 dos leidas, cada una con la suya',
    two.length === 2 && two.some((each) => each.liveId === 'screen-1' && each.toolUseId === 'toolu_a') &&
      two.some((each) => each.liveId === 'screen-2' && each.toolUseId === 'toolu_b'), json(two));
}

// --- E. El protocolo ---------------------------------------------------------------

{
  const part = { kind: 'question', toolUseId: 'screen-1', questions: [itemOf('q1-basica')] };
  const parsed = shared.parseServerMessage(json({ type: 'conversation.liveQuestion', terminalId: 't1', question: part }));
  check('E1 conversation.liveQuestion se lee con su pregunta', parsed?.type === 'conversation.liveQuestion' && same(parsed.question, part));
  const gone = shared.parseServerMessage(json({ type: 'conversation.liveQuestion', terminalId: 't1', question: null }));
  check('E2 null es "ya no hay"', gone?.type === 'conversation.liveQuestion' && gone.question === null);
  check('E3 algo que no es una pregunta no se toma por null',
    shared.parseServerMessage(json({ type: 'conversation.liveQuestion', terminalId: 't1', question: { kind: 'text', text: 'x' } })) === null);

  const reset = {
    type: 'conversation.reset', terminalId: 't1', sessionId: 's', state: 'live', events: [], hasMore: false,
    usage: shared.EMPTY_CONTEXT_USAGE, permissionMode: null, defaults: { model: null, effort: null, contextWindow: null },
    waitingFor: null, openToolCall: false, subagents: [], queue: [],
  };
  const old = shared.parseServerMessage(json(reset));
  check('E4 un servidor anterior no la manda: el reset se lee con ninguna', old?.type === 'conversation.reset' && old.liveQuestion === null);
  const fresh = shared.parseServerMessage(json({ ...reset, liveQuestion: part }));
  check('E4 y con ella, la trae', fresh?.type === 'conversation.reset' && same(fresh.liveQuestion, part));
}

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
