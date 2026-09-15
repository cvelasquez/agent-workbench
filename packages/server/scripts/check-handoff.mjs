/**
 * Chequeo de "Continuar en otra CLI" (hito 29).
 *
 *   npx tsx scripts/check-handoff.mjs
 *
 * Lo que se rompe en silencio al continuar una conversacion es el transcript:
 * un turno mal partido cita otro pedido, un tope que no se cumple deja a la CLI
 * que continua sin la cola, y un `ESC[201~` que se cuela termina escrito en una
 * pty. Cada caso de la especificacion tiene su bloque, numerado igual:
 *
 *  - H1: `splitTurns` y `selectTurns`, con la lectura que no llega al principio
 *    (M5): sin pedido inicial y la cuenta como minimo.
 *  - H2: `renderTranscript`: encabezados, una linea por herramienta, imagenes,
 *    preguntas y avisos; los dos topes (60 KB y 1 500 lineas, A2), soltando
 *    turnos viejos, y un solo turno enorme que se corta y se conserva.
 *  - H3: el saneado de todo lo que entra, tambien titulo y carpeta.
 *  - H4: `buildContinuationMessage` y `transcriptReferenceFor`.
 *  - H5: sin turnos no hay continuacion, y el motivo (`planTranscript`); y
 *    `continueSession` no abre ninguna pestana (espia del registro).
 *  - H6: la fuente de `continueSession`: la copia si la da (sin crear seguidor),
 *    si no el seguidor de la CLI con el tope de M5; sesion que el indice no
 *    tiene, sin carpeta, ilegible o importada sin copia; destino que no esta,
 *    la misma CLI, un fallo al abrir o al guardar. `SessionIndex.find` con una
 *    sesion nativa real y una fila de la copia, y el seguidor real de Claude Code.
 *    `resolveLaunchPlan` (M1a).
 *  - H7: `chooseDelivery` contra los literales reales: Claude Code `pty`, las
 *    demas `prefill`.
 *  - H8: `deliverWhenReady` (M3): sin sesion en el plazo, sin "lista", sin senal
 *    de "lista", imagenes que la CLI no recibe: cero escrituras. Con Claude
 *    Code, `noteSubmitted` antes de la primera escritura y las piezas de
 *    `buildSubmissionWrites`. `prefillReasonFor`.
 *  - H9: `PasteStore.saveText`: nombre, carpeta, contenido UTF-8, tope y borrado;
 *    fuera de Windows, permisos `0o700` y `0o600` (R29-4).
 *  - H10: la web: `continueTargets`, `noteSendable`, `waitingBarText` (B6), el
 *    aviso, el prellenado y el `↪` apagado sin mensajes (R29-5).
 *
 * Trabaja con `HOME`, `USERPROFILE`, `APPDATA` y las carpetas XDG apuntando a
 * una carpeta temporal propia, fijadas **antes** de importar nada. No importa
 * nada que cargue `node-pty` ni lanza ninguna CLI. Los textos son inventados.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(os.tmpdir(), 'aw-handoff-'));
const home = path.join(root, 'home');
await mkdir(home, { recursive: true });
process.env['HOME'] = home;
process.env['USERPROFILE'] = home;
process.env['APPDATA'] = path.join(root, 'appdata');
process.env['XDG_CONFIG_HOME'] = path.join(root, 'xdg');
process.env['XDG_DATA_HOME'] = path.join(root, 'xdg-data');
process.env['XDG_CACHE_HOME'] = path.join(root, 'xdg-cache');
process.env['XDG_STATE_HOME'] = path.join(root, 'xdg-state');
process.env['CODEX_HOME'] = path.join(root, 'codex');

const transcript = await import('../src/handoff/transcript.ts');
const {
  HANDOFF_EMPTY_MESSAGE,
  HANDOFF_MAX_BYTES,
  HANDOFF_MAX_LINES,
  HANDOFF_MAX_TURNS,
  HANDOFF_NO_TRANSCRIPT_MESSAGE,
  HANDOFF_QUOTE_CHARS,
  HANDOFF_TOOL_INPUT_CHARS,
  HANDOFF_TOOL_RESULT_CHARS,
  buildContinuationMessage,
  planTranscript,
  renderTranscript,
  selectTurns,
  splitTurns,
  transcriptReferenceFor,
} = transcript;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const show = (value) => JSON.stringify(value)?.slice(0, 400) ?? String(value);
const bytesOf = (text) => Buffer.byteLength(text, 'utf8');
const linesOf = (text) => text.split('\n').length - 1;

// ---------------------------------------------------------------------------
// Fixture: una conversacion inventada de 30 turnos
// ---------------------------------------------------------------------------

let clock = Date.UTC(2026, 8, 14, 10, 0, 0);
const ev = (eventId, role, parts, extra = {}) => ({
  eventId, role, at: (clock += 1000), parts, model: role === 'assistant' ? 'modelo-de-prueba' : null,
  usage: null, effort: null, durationMs: null, queued: false, ...extra,
});
const text = (value, truncated = false) => ({ kind: 'text', text: value, truncated });
const image = (index = 0) => ({ kind: 'image', index, mediaType: 'image/png', source: 'content' });
/** Un texto sin blancos cuyos cortes se distinguen: el caracter N+1 no es el N. */
const patterned = (length, seed) => Array.from({ length }, (_, k) => `${seed}0123456789`[k % 11]).join('');

const TOOL_INPUT = patterned(900, 'e');
const TOOL_RESULT = patterned(5_000, 'r');

function fixtureEvents(turnCount = 30) {
  const events = [
    // Lo anterior al primer pedido del usuario no es turno.
    ev('pre', 'assistant', [text('Hola, ¿en qué te ayudo?')]),
    ev('pre-blank', 'user', [text('   \n ')]),
  ];
  for (let n = 1; n <= turnCount; n += 1) {
    const userParts = [text(`Ajustá el importador de CSV, paso ${n}.`)];
    if (n === 1 || n === 30) userParts.push(image());
    events.push(ev(`u${n}`, 'user', userParts));
    events.push(ev(`a${n}`, 'assistant', [
      { kind: 'thinking' },
      text(`Reviso el paso ${n}.`),
      { kind: 'tool-call', toolUseId: `t${n}`, name: 'Bash', input: TOOL_INPUT, truncated: false },
    ]));
    events.push(ev(`r${n}`, 'user', [{ kind: 'tool-result', toolUseId: `t${n}`, text: TOOL_RESULT, isError: false, truncated: false, imageCount: 0 }]));
    if (n === 25) {
      events.push(ev('q25', 'assistant', [{
        kind: 'question', toolUseId: 'q-25',
        questions: [{ question: '¿Qué formato preferís?', header: 'Formato', multiSelect: false, options: [{ label: 'CSV', description: '' }, { label: 'JSON', description: '' }] }],
      }]));
      events.push(ev('qa25', 'user', [{ kind: 'tool-result', toolUseId: 'q-25', text: 'CSV', isError: false, truncated: false, imageCount: 0 }]));
    }
    if (n === 26) events.push(ev('n26', 'assistant', [{ kind: 'notice', notice: 'compacted', detail: '' }]));
    events.push(ev(`z${n}`, 'assistant', [text(`Listo el paso ${n}.`)]));
  }
  return events;
}

const header = (extra = {}) => ({
  sourceLabel: 'OpenCode', agent: 'opencode', cwd: 'D:\\Mi App', title: 'Ajustar el importador',
  sessionId: 'ses_prueba', lastAt: clock, partial: false, ...extra,
});

// ---------------------------------------------------------------------------
// H1. Turnos
// ---------------------------------------------------------------------------

const events = fixtureEvents();
const turns = splitTurns(events);
{
  check('H1 30 turnos', turns.length === 30, String(turns.length));
  check('H1 numerados de 1 a 30, en orden', turns.every((turn, index) => turn.number === index + 1));
  check('H1 lo anterior al primer pedido no es turno (ni un pedido en blanco)',
    turns[0].events[0].eventId === 'u1' && !turns.some((turn) => turn.events.some((event) => event.eventId === 'pre' || event.eventId === 'pre-blank')));
  check('H1 un user con solo tool-result no abre turno: queda en el turno en curso',
    turns[0].events.some((event) => event.eventId === 'r1') && turns[1].events[0].eventId === 'u2', show(turns[0].events.map((event) => event.eventId)));

  const selection = selectTurns(turns);
  check('H1 selectTurns: los ultimos 20, del 11 al 30',
    selection.turns.length === HANDOFF_MAX_TURNS && HANDOFF_MAX_TURNS === 20 && selection.turns[0].number === 11 && selection.turns.at(-1).number === 30);
  check('H1 selectTurns: opening = turno 1, totalTurns 30, completa',
    selection.opening?.number === 1 && selection.totalTurns === 30 && selection.complete === true);
  const twelve = selectTurns(turns.slice(0, 12));
  check('H1 con 12 turnos entran todos y opening es null', twelve.turns.length === 12 && twelve.opening === null && twelve.totalTurns === 12);

  // M5: la lectura se corto antes del principio.
  const partialRead = selectTurns(turns, 20, false);
  check('H1 (M5) lectura incompleta: sin pedido inicial y marcada',
    partialRead.opening === null && partialRead.complete === false && partialRead.turns.length === 20 && partialRead.totalTurns === 30);
  const plan = planTranscript({ header: header(), events, complete: false });
  check('H1 (M5) el transcript dice "más de N turnos", sin "Pedido inicial", y la cuenta es un minimo',
    plan.ok && plan.totalTurnsIsMinimum === true && plan.markdown.includes('de más de 30 turnos') && !plan.markdown.includes('## Pedido inicial'),
    plan.ok ? plan.markdown.slice(0, 400) : show(plan));
  const completePlan = planTranscript({ header: header(), events });
  check('H1 (M5) la lectura completa no se marca', completePlan.ok && completePlan.totalTurnsIsMinimum === false && completePlan.totalTurns === 30);
}

// ---------------------------------------------------------------------------
// H2. El documento
// ---------------------------------------------------------------------------

{
  const { markdown, includedTurns } = renderTranscript(header(), selectTurns(turns));
  const lines = markdown.split('\n');
  check('H2 entran los 20 turnos', includedTurns === 20, String(includedTurns));
  check('H2 "## Pedido inicial" antes de "## Turno 11 · usuario", y hasta "## Turno 30 · asistente"',
    markdown.indexOf('## Pedido inicial') !== -1 && markdown.indexOf('## Pedido inicial') < markdown.indexOf('## Turno 11 · usuario') &&
    markdown.includes('## Turno 30 · asistente') && !markdown.includes('## Turno 10 · usuario'));
  check('H2 el pedido inicial es el texto del turno 1',
    markdown.slice(markdown.indexOf('## Pedido inicial'), markdown.indexOf('## Turno 11')).includes('Ajustá el importador de CSV, paso 1.'));
  check('H2 la cabecera dice de donde viene y cuanto incluye',
    markdown.startsWith('# Continuación de una conversación con OpenCode\n') && markdown.includes('- Proyecto: `D:\\Mi App`') &&
    markdown.includes('- Conversación: Ajustar el importador (opencode, ses_prueba)') && markdown.includes('Incluye los últimos 20 de 30 turnos.'),
    markdown.slice(0, 500));

  const toolLines = lines.filter((line) => line.startsWith('- `Bash`'));
  const toolLine = toolLines[0] ?? '';
  check('H2 una linea por herramienta, una por turno incluido', toolLines.length === 20, String(toolLines.length));
  check(`H2 la entrada va a ${HANDOFF_TOOL_INPUT_CHARS} caracteres con "…"`,
    HANDOFF_TOOL_INPUT_CHARS === 300 && toolLine.includes(`\`${TOOL_INPUT.slice(0, 300)}…\``) && !toolLine.includes(TOOL_INPUT.slice(0, 301)), toolLine.slice(0, 120));
  check(`H2 el resultado va a ${HANDOFF_TOOL_RESULT_CHARS} caracteres, marcado "recortado"`,
    HANDOFF_TOOL_RESULT_CHARS === 600 && toolLine.includes(`→ recortado: ${TOOL_RESULT.slice(0, 600)}…`) && !toolLine.includes(TOOL_RESULT.slice(0, 601)),
    toolLine.slice(-120));
  check('H2 "[imagen no incluida]" en el turno 30 y en el pedido inicial',
    markdown.split('[imagen no incluida]').length - 1 === 2 &&
    markdown.slice(markdown.indexOf('## Turno 30 · usuario')).includes('[imagen no incluida]'));
  check('H2 la pregunta con su respuesta', markdown.includes('- Pregunta "¿Qué formato preferís?": respondida "CSV"'));
  check('H2 el aviso', markdown.includes('- Aviso: Contexto compactado'));
  check('H2 ninguna parte thinking deja rastro, y nada sale "undefined"',
    !/thinking|razon|undefined|\[object/i.test(markdown));
  check(`H2 dentro de los topes (${HANDOFF_MAX_BYTES} bytes, ${HANDOFF_MAX_LINES} lineas)`,
    HANDOFF_MAX_BYTES === 60_000 && HANDOFF_MAX_LINES === 1_500 && bytesOf(markdown) <= 60_000 && linesOf(markdown) <= 1_500,
    `${bytesOf(markdown)} bytes, ${linesOf(markdown)} lineas`);
  check('H2 la ultima respuesta es lo ultimo del documento', markdown.trimEnd().endsWith('Listo el paso 30.'));

  // Textos de 9 000 x 40: no entran 20 turnos.
  const heavy = [];
  for (let n = 1; n <= 40; n += 1) {
    heavy.push(ev(`hu${n}`, 'user', [text(`${n} ${patterned(9_000, 'u')}`)]));
    heavy.push(ev(`ha${n}`, 'assistant', [text(`respuesta ${n}`)]));
  }
  const heavySelection = selectTurns(splitTurns(heavy));
  const heavyRender = renderTranscript(header(), heavySelection);
  check('H2 textos de 9 000 x 40: dentro de 60 KB, soltando turnos viejos',
    bytesOf(heavyRender.markdown) <= HANDOFF_MAX_BYTES && heavyRender.includedTurns < 20 && heavyRender.includedTurns >= 1 &&
    heavyRender.markdown.includes('## Turno 40 · usuario') && !heavyRender.markdown.includes('## Turno 21 · usuario'),
    `${bytesOf(heavyRender.markdown)} bytes, ${heavyRender.includedTurns} turnos`);
  check('H2 la cabecera cuenta los que entraron, y el texto largo va cortado a 8 000',
    heavyRender.markdown.includes(`Incluye los últimos ${heavyRender.includedTurns} de 40 turnos.`) &&
    heavyRender.markdown.includes('… (recortado)') && !heavyRender.markdown.includes(`40 ${patterned(9_000, 'u')}`.slice(0, 8_001)));
  check('H2 el pedido inicial se conserva aunque se suelten turnos', heavyRender.markdown.includes('## Pedido inicial'));

  // Muchas herramientas cortas: el que corta es el tope de lineas.
  const busy = [];
  for (let n = 1; n <= 40; n += 1) {
    busy.push(ev(`bu${n}`, 'user', [text(`pedido ${n}`)]));
    const calls = Array.from({ length: 100 }, (_, k) => ({ kind: 'tool-call', toolUseId: `b${n}-${k}`, name: 'Read', input: `archivo-${k}.txt`, truncated: false }));
    busy.push(ev(`ba${n}`, 'assistant', calls));
  }
  const busyRender = renderTranscript(header(), selectTurns(splitTurns(busy)));
  check('H2 100 herramientas por turno: dentro de 1 500 lineas, soltando turnos viejos',
    linesOf(busyRender.markdown) <= HANDOFF_MAX_LINES && busyRender.includedTurns < 20 && busyRender.includedTurns >= 1 &&
    bytesOf(busyRender.markdown) <= HANDOFF_MAX_BYTES && busyRender.markdown.includes('## Turno 40 · asistente'),
    `${linesOf(busyRender.markdown)} lineas, ${busyRender.includedTurns} turnos`);

  // Un solo turno enorme: se cortan sus textos y se conserva.
  const huge = [ev('hx', 'user', [text(`Revisá todo. ${patterned(9_000, 'x')}`)])];
  for (let k = 0; k < 30; k += 1) huge.push(ev(`hy${k}`, 'assistant', [text(`Parte ${k}: ${patterned(8_000, 'y')}`)]));
  const hugeRender = renderTranscript(header(), selectTurns(splitTurns(huge)));
  check('H2 un solo turno enorme: se corta, entra en 60 KB y el turno queda',
    hugeRender.includedTurns === 1 && bytesOf(hugeRender.markdown) <= HANDOFF_MAX_BYTES &&
    hugeRender.markdown.includes('## Turno 1 · usuario') && hugeRender.markdown.includes('Revisá todo.') &&
    hugeRender.markdown.includes('Parte 29:') && hugeRender.markdown.includes('… (recortado)'),
    `${bytesOf(hugeRender.markdown)} bytes`);

  // Un solo turno con 3 000 herramientas: ni cortando textos entra; se omite el medio.
  const endless = [ev('ex', 'user', [text('Recorré el repositorio.')])];
  endless.push(ev('ey', 'assistant', Array.from({ length: 3_000 }, (_, k) => ({
    kind: 'tool-call', toolUseId: `e-${k}`, name: 'Read', input: `herramienta-${k} ${patterned(400, 'i')}`, truncated: false,
  }))));
  endless.push(ev('ez', 'assistant', [text('Terminé de recorrerlo.')]));
  const endlessRender = renderTranscript(header(), selectTurns(splitTurns(endless)));
  check('H2 un turno con 3 000 herramientas: el medio se omite, dentro de los dos topes',
    endlessRender.includedTurns === 1 && bytesOf(endlessRender.markdown) <= HANDOFF_MAX_BYTES && linesOf(endlessRender.markdown) <= HANDOFF_MAX_LINES &&
    endlessRender.markdown.includes('líneas omitidas'),
    `${bytesOf(endlessRender.markdown)} bytes, ${linesOf(endlessRender.markdown)} lineas`);
  check('H2 y conserva el pedido, la primera herramienta y lo ultimo que respondio',
    endlessRender.markdown.includes('## Turno 1 · usuario') && endlessRender.markdown.includes('Recorré el repositorio.') &&
    endlessRender.markdown.includes('herramienta-0 ') && endlessRender.markdown.trimEnd().endsWith('Terminé de recorrerlo.'));

  // Topes chicos a mano: la misma regla con otros numeros.
  const tight = renderTranscript(header(), selectTurns(turns), 8_000, 60);
  check('H2 con topes de 8 KB y 60 lineas tambien se cumplen',
    bytesOf(tight.markdown) <= 8_000 && linesOf(tight.markdown) <= 60 && tight.includedTurns >= 1 && tight.markdown.includes('## Turno 30 · usuario'),
    `${bytesOf(tight.markdown)} bytes, ${linesOf(tight.markdown)} lineas, ${tight.includedTurns} turnos`);
}

// ---------------------------------------------------------------------------
// H3. Saneado
// ---------------------------------------------------------------------------

{
  const hostile = 'a\x1b[201~b\x1b[31mrojo\r\nsegunda\x00fin';
  const dirty = [
    ev('du', 'user', [text(hostile)]),
    ev('da', 'assistant', [
      text(hostile),
      { kind: 'tool-call', toolUseId: 'dt', name: 'Ba\x1bsh', input: hostile, truncated: false },
    ]),
    ev('dr', 'user', [{ kind: 'tool-result', toolUseId: 'dt', text: hostile, isError: true, truncated: false, imageCount: 0 }]),
  ];
  const plan = planTranscript({
    header: header({ title: `Título ${hostile}`, cwd: `D:\\carpeta\x1b[200~ rara\r\n`, sourceLabel: `Open\x1b[201~Code`, sessionId: 'ses\x00_x' }),
    events: dirty,
  });
  const markdown = plan.ok ? plan.markdown : '';
  check('H3 el transcript no lleva ESC, NUL ni CR', plan.ok && !markdown.includes('\x1b') && !markdown.includes('\x00') && !markdown.includes('\r'), show(markdown));
  check('H3 lo que queda del texto es texto: \\r\\n pasa a \\n', markdown.includes('ab[31mrojo\nsegundafin'), show(markdown));
  check('H3 titulo, carpeta, etiqueta e id saneados',
    markdown.includes('Continuación de una conversación con OpenCode') && markdown.includes('Título ab[31mrojo segundafin') &&
    markdown.includes('- Proyecto: `D:\\carpeta rara`') && markdown.includes('ses_x'), markdown.slice(0, 400));
  const message = buildContinuationMessage({
    sourceLabel: `Open\x1b[201~Code`, includedTurns: 1, reference: transcriptReferenceFor('C:\\t\\c.md', 'at-quoted'), lastRequest: hostile,
  });
  check('H3 el mensaje no lleva ESC, NUL ni CR', !message.includes('\x1b') && !message.includes('\x00') && !message.includes('\r'), show(message));
  check('H3 y cita el pedido saneado, linea por linea', message.includes('> ab[31mrojo\n> segundafin'), show(message));
}

// ---------------------------------------------------------------------------
// H4. El mensaje y la referencia
// ---------------------------------------------------------------------------

{
  const longRequest = Array.from({ length: 30 }, (_, k) => `${String(k).padStart(2, '0')}${patterned(98, 'q')}`).join('\n');
  check('H4 el pedido del fixture mide 3 000 o mas', longRequest.length >= 3_000, String(longRequest.length));
  const message = buildContinuationMessage({
    sourceLabel: 'OpenCode', includedTurns: 20, reference: '"C:\\t\\continuacion-1-3f2a9c1b.md"', lastRequest: longRequest,
  });
  const [intro, quoted] = message.split('\n\n');
  check('H4 presenta la continuacion, la cantidad y la referencia',
    intro === 'Esto continúa una conversación que empezó con otro asistente (OpenCode).\nEl transcript de los últimos 20 turnos está en "C:\\t\\continuacion-1-3f2a9c1b.md".\nLeelo entero y seguí desde el último pedido, que fue:',
    show(intro));
  const quoteLines = (quoted ?? '').split('\n');
  const body = quoteLines.map((line) => line.replace(/^> ?/, '')).join('\n');
  check(`H4 el pedido de 3 000 se cita cortado a ${HANDOFF_QUOTE_CHARS}, con "…"`,
    HANDOFF_QUOTE_CHARS === 1_000 && body === `${longRequest.slice(0, 1_000)}…`, `${body.length} caracteres`);
  check('H4 cada linea citada empieza con "> "', quoteLines.length > 1 && quoteLines.every((line) => line.startsWith('> ')), show(quoteLines.slice(0, 3)));

  const bare = buildContinuationMessage({ sourceLabel: 'Codex', includedTurns: 1, reference: '"C:\\t\\c.md"', lastRequest: null });
  check('H4 sin pedido: sin cita', !bare.includes('>') && bare.endsWith('Leelo entero y seguí desde donde quedó.') && bare.includes('del último turno'), show(bare));
  check('H4 un pedido en blanco cuenta como sin pedido',
    !buildContinuationMessage({ sourceLabel: 'Codex', includedTurns: 2, reference: 'x', lastRequest: '  \n ' }).includes('>'));

  check('H4 at-quoted: @"ruta" con espacios, igual que una imagen',
    transcriptReferenceFor('C:\\Carpeta con espacios\\c.md', 'at-quoted') === '@"C:\\Carpeta con espacios\\c.md"');
  check('H4 quoted-path: "ruta" entre comillas, sin @',
    transcriptReferenceFor('C:\\Carpeta con espacios\\c.md', 'quoted-path') === '"C:\\Carpeta con espacios\\c.md"');
  const { fileReference } = await import('../src/pty-input.ts');
  check('H4 (B2) at-quoted es fileReference', transcriptReferenceFor('/tmp/a b/c.md', 'at-quoted') === fileReference('/tmp/a b/c.md', 'at-quoted'));
}

// ---------------------------------------------------------------------------
// H5. Sin turnos no hay continuacion
// ---------------------------------------------------------------------------

{
  const empty = planTranscript({ header: header(), events: [] });
  check('H5 sin eventos: no hay continuacion, con el motivo', empty.ok === false && empty.message === HANDOFF_EMPTY_MESSAGE && !('markdown' in empty), show(empty));
  const noRequest = planTranscript({
    header: header(),
    events: [
      ev('x1', 'assistant', [text('Hola.')]),
      ev('x2', 'user', [{ kind: 'tool-result', toolUseId: 'x', text: 'salida', isError: false, truncated: false, imageCount: 0 }]),
      ev('x3', 'user', [image()]),
    ],
  });
  check('H5 sin ningun pedido con texto (solo asistente, resultados e imagenes): igual', noRequest.ok === false && noRequest.message === HANDOFF_EMPTY_MESSAGE, show(noRequest));
  const noTranscript = planTranscript({ header: header({ agent: 'antigravity', sourceLabel: 'Antigravity CLI' }), events: [], state: 'no-transcript' });
  check('H5 una fuente en no-transcript dice que esa CLI no dejo transcript legible',
    noTranscript.ok === false && noTranscript.message === HANDOFF_NO_TRANSCRIPT_MESSAGE && noTranscript.message.includes('no dejó transcript legible'), show(noTranscript));
  const partialImport = planTranscript({ header: header({ agent: 'antigravity-ide', partial: true }), events: [] });
  check('H5 (B9) una sesion importada parcial sin eventos: tampoco', partialImport.ok === false && partialImport.message === HANDOFF_EMPTY_MESSAGE);

  const fine = planTranscript({ header: header({ partial: true }), events });
  check('H5 con turnos si hay continuacion, con el ultimo pedido y las cuentas',
    fine.ok === true && fine.includedTurns === 20 && fine.totalTurns === 30 && fine.lastRequest === 'Ajustá el importador de CSV, paso 30.' &&
    fine.markdown.includes('- Historial parcial:'), fine.ok ? '' : show(fine));
}

// ---------------------------------------------------------------------------
// Piezas comunes de H5 a H9: dobles del registro, el indice y las CLIs
// ---------------------------------------------------------------------------

const shared = await import('@agent-workbench/shared');
const handoff = await import('../src/handoff/handoff.ts');
const { continueSession, chooseDelivery, readSourceEvents, continuationLabel, HANDOFF_DELIVERY_TIMEOUT_MS } = handoff;
const { deliverWhenReady, prefillReasonFor } = await import('../src/deliver-when-ready.ts');
const { PasteStore, PasteTextError, MAX_TEXT_BYTES } = await import('../src/paste-store.ts');
const { TerminalOpenError, resolveLaunchPlan } = await import('../src/terminal-open-error.ts');
const { TerminalWriteQueue } = await import('../src/terminal-write-queue.ts');
const { buildSubmissionWrites } = await import('../src/pty-input.ts');
const { CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_INPUT } = await import('../src/agents/claude-code/index.ts');
const { CODEX_CAPABILITIES, CODEX_INPUT } = await import('../src/agents/codex/index.ts');
const { OPENCODE_CAPABILITIES } = await import('../src/agents/opencode/index.ts');
const { ANTIGRAVITY_BASE_CAPABILITIES, ANTIGRAVITY_STATUS_LINE_CAPABILITIES } = await import('../src/agents/antigravity/index.ts');

const HANDOFF_CWD = path.join(root, 'proyecto con espacios');
await mkdir(HANDOFF_CWD, { recursive: true });

/**
 * Un seguidor falso que se comporta como `JsonlFollower`: guarda los ultimos
 * `maxEvents` y pagina hacia atras dentro de lo que guardo. Cuenta cuantas veces
 * se lo creo y con que opciones.
 */
function fakeHistory(events, { state = 'live', wholeRead = true } = {}) {
  const calls = { follow: 0, options: [], targets: [] };
  return {
    calls,
    ...(wholeRead ? { wholeRead: true } : {}),
    follow(target, options) {
      calls.follow += 1;
      calls.options.push(options);
      calls.targets.push(target);
      const max = options?.maxEvents ?? 4_000;
      const kept = events.slice(-max);
      const dropped = events.length - kept.length;
      let polls = 0;
      return {
        label: 'seguidor-falso',
        start: async () => undefined,
        poll: async () => ({ reset: false, added: polls++ === 0 ? kept : [], turns: [], plans: [], parts: [] }),
        getState: () => state,
        getUsage: () => shared.EMPTY_CONTEXT_USAGE,
        getPermissionMode: () => null,
        getTail: (limit) => {
          const page = kept.slice(-limit);
          return { events: page, hasMore: kept.length > page.length || dropped > 0 };
        },
        getPageBefore: (id, limit) => {
          const index = kept.findIndex((event) => event.eventId === id);
          if (index <= 0) return { events: [], hasMore: false };
          const start = Math.max(0, index - limit);
          return { events: kept.slice(start, index), hasMore: start > 0 || dropped > 0 };
        },
        getPlanFiles: () => [],
        readImage: async () => null,
        noticeChange: () => false,
        hasOpenToolCall: () => false,
      };
    },
  };
}

const LOCATED = { resolvedPath: 'x', file: 'x', prefixArgs: [], version: '1.0' };
const registered = (id, label, capabilities, input, history, location = LOCATED) => ({
  adapter: { id, label, capabilities, input, history }, location,
});

const summaryOf = (agent, sessionId, extra = {}) => ({
  agent, sessionId, cwd: HANDOFF_CWD, title: 'Ajustar el importador de CSV con BOM y otros detalles largos', titleSource: 'first-message',
  updatedAt: clock, sizeBytes: 10, archived: false, storage: 'native', partial: false, ...extra,
});

function fakeRegistry({ fail = null } = {}) {
  const opened = [];
  return {
    opened,
    async open(options) {
      opened.push(options);
      if (fail !== null) throw fail;
      return {
        terminalId: `tab-${opened.length}`, kind: 'agent', agent: options.agent, cwd: options.cwd, sessionId: `ses-${opened.length}`,
        label: options.label, resumed: false, createdAt: 1, alive: true, exitCode: null, sleeping: false,
      };
    },
  };
}

const pasteRoot = path.join(root, 'pegados');

/** Deps de `continueSession` con todo falso salvo lo que se pise. */
function continueDeps({ sessions = [summaryOf('opencode', 'ses_origen')], history = fakeHistory(events), archive = null, registry = fakeRegistry(), pasteStore = new PasteStore(pasteRoot), targets, maxEvents } = {}) {
  const closed = [];
  const agents = new Map([
    ['claude-code', registered('claude-code', 'Claude Code', CLAUDE_CODE_CAPABILITIES, CLAUDE_CODE_INPUT, fakeHistory([]))],
    ['codex', registered('codex', 'Codex', CODEX_CAPABILITIES, CODEX_INPUT, fakeHistory([]))],
    ['opencode', registered('opencode', 'OpenCode', OPENCODE_CAPABILITIES, { transcriptReference: 'quoted-path' }, history)],
    ...(targets ?? []),
  ]);
  return {
    closed,
    registry,
    deps: {
      registry,
      closeTab: (terminalId) => closed.push(terminalId),
      agents: { get: (id) => agents.get(id) ?? null },
      index: { find: (agent, sessionId) => sessions.find((s) => s.agent === agent && s.sessionId === sessionId) ?? null },
      pasteStore,
      archive,
      ...(maxEvents !== undefined ? { maxEvents } : {}),
    },
  };
}

const request = (extra = {}) => ({ agent: 'opencode', sessionId: 'ses_origen', target: 'claude-code', ...extra });
/** La ruta que nombra el mensaje, en cualquiera de las dos formas. */
const pathInMessage = (message) => /"([^"]+\.md)"/.exec(message)?.[1] ?? null;

// ---------------------------------------------------------------------------
// H5 (continuacion). Sin turnos no se abre nada
// ---------------------------------------------------------------------------

{
  const noTurns = [ev('nt1', 'assistant', [text('Hola.')]), ev('nt2', 'user', [image()])];
  const { deps, registry } = continueDeps({ archive: { events: async () => ({ events: noTurns, partial: false, complete: true }) } });
  const outcome = await continueSession(deps, request());
  check('H5 continueSession sin turnos: continue-failed con el motivo, y registry.open no se llamo',
    outcome.ok === false && outcome.code === 'continue-failed' && outcome.message === HANDOFF_EMPTY_MESSAGE && registry.opened.length === 0, show(outcome));

  const blank = continueDeps({ history: fakeHistory([], { state: 'no-transcript' }), sessions: [summaryOf('opencode', 'ses_origen')] });
  const noTranscript = await continueSession(blank.deps, request());
  check('H5 continueSession de una fuente en no-transcript: el motivo de esa CLI, y nada abierto',
    noTranscript.ok === false && noTranscript.message === HANDOFF_NO_TRANSCRIPT_MESSAGE && blank.registry.opened.length === 0, show(noTranscript));
}

// ---------------------------------------------------------------------------
// H6. De donde salen los eventos, y lo que corta antes de abrir
// ---------------------------------------------------------------------------

{
  // La copia da eventos: se usan y el seguidor ni se crea.
  const history = fakeHistory(events);
  const archivedEvents = fixtureEvents(3).map((event) =>
    event.eventId === 'u3' ? { ...event, parts: [text('Pedido que solo esta en la copia.')] } : event);
  let archiveCalls = 0;
  const fromArchive = continueDeps({
    history,
    archive: { events: async (agent, sessionId) => { archiveCalls += 1; return agent === 'opencode' && sessionId === 'ses_origen' ? { events: archivedEvents, partial: true, complete: true } : null; } },
  });
  const outcome = await continueSession(fromArchive.deps, request());
  const file = outcome.ok ? pathInMessage(outcome.message) : null;
  const markdown = file === null ? '' : await readFile(file, 'utf8');
  check('H6 la copia da eventos: se usan y el seguidor falso no se crea',
    outcome.ok && archiveCalls === 1 && history.calls.follow === 0 && markdown.includes('Pedido que solo esta en la copia.'), show(outcome));
  check('H6 lo parcial de la copia llega a la cabecera, y la cuenta sale de la copia',
    outcome.ok && markdown.includes('- Historial parcial:') && outcome.continued.totalTurns === 3 && outcome.continued.includedTurns === 3 &&
    outcome.continued.totalTurnsIsMinimum === false);
  check('H6 la pestana se abre con la CLI pedida, en la carpeta de la sesion y con su etiqueta',
    fromArchive.registry.opened.length === 1 && fromArchive.registry.opened[0].agent === 'claude-code' &&
    fromArchive.registry.opened[0].cwd === HANDOFF_CWD && fromArchive.registry.opened[0].kind === 'agent' &&
    fromArchive.registry.opened[0].label === continuationLabel(summaryOf('opencode', 'x').title), show(fromArchive.registry.opened));
  check('H6 continued describe el origen y la pestana nueva',
    outcome.ok && outcome.continued.terminalId === 'tab-1' && outcome.descriptor.terminalId === 'tab-1' &&
    shared.parseServerMessage(JSON.stringify({ type: 'session.continued', requestId: 'r', ...outcome.continued }))?.source.sessionId === 'ses_origen');

  // La copia da null: el seguidor nativo, con el tope de M5.
  const nativeHistory = fakeHistory(events);
  const native = continueDeps({ history: nativeHistory, archive: { events: async () => null } });
  const nativeOutcome = await continueSession(native.deps, request());
  check('H6 la copia da null: lee el seguidor de la CLI de origen, con maxEvents 5 000 y la carpeta de la sesion',
    nativeOutcome.ok && nativeHistory.calls.follow === 1 && nativeHistory.calls.options[0]?.maxEvents === 5_000 &&
    nativeHistory.calls.targets[0]?.cwd === HANDOFF_CWD && nativeHistory.calls.targets[0]?.sessionId === 'ses_origen' &&
    nativeOutcome.continued.totalTurns === 30 && nativeOutcome.continued.includedTurns === 20, show(nativeOutcome));
  const nativeFile = nativeOutcome.ok ? pathInMessage(nativeOutcome.message) : null;
  const nativeMarkdown = nativeFile === null ? '' : await readFile(nativeFile, 'utf8');
  check('H6 y el archivo guardado es el transcript: pedido inicial, turno 30, sin marca de parcial',
    nativeMarkdown.includes('## Pedido inicial') && nativeMarkdown.includes('## Turno 30 · usuario') && !nativeMarkdown.includes('Historial parcial'));
  check('H6 sin copia (archive null) tambien lee el seguidor', (await continueSession(continueDeps({ archive: null }).deps, request())).ok === true);

  // M5: la lectura se corta en el tope.
  const capped = continueDeps({ history: fakeHistory(events), maxEvents: 50 });
  const cappedOutcome = await continueSession(capped.deps, request());
  const cappedFile = cappedOutcome.ok ? pathInMessage(cappedOutcome.message) : null;
  const cappedMarkdown = cappedFile === null ? '' : await readFile(cappedFile, 'utf8');
  check('H6 (M5) con mas eventos que el tope: la cuenta es un minimo y no hay pedido inicial',
    cappedOutcome.ok && cappedOutcome.continued.totalTurnsIsMinimum === true && !cappedMarkdown.includes('## Pedido inicial') &&
    cappedMarkdown.includes('de más de'), show(cappedOutcome.ok ? cappedOutcome.continued : cappedOutcome));
  const whole = await readSourceEvents(fakeHistory(events), { cwd: HANDOFF_CWD, sessionId: 'x' });
  check('H6 (M5) readSourceEvents pagina hasta el principio: todos los eventos, en orden, completa',
    whole !== null && whole.complete === true && whole.events.length === events.length &&
    whole.events.every((event, index) => event.eventId === events[index].eventId), show(whole?.events.length));
  const cut = await readSourceEvents(fakeHistory(events), { cwd: HANDOFF_CWD, sessionId: 'x' }, 120);
  check('H6 (M5) con tope 120: los ultimos 120, marcada incompleta',
    cut !== null && cut.complete === false && cut.events.length === 120 && cut.events.at(-1).eventId === events.at(-1).eventId);
  const noWhole = await readSourceEvents(fakeHistory(events, { wholeRead: false }), { cwd: HANDOFF_CWD, sessionId: 'x' });
  check('H6 (M5) una fuente sin wholeRead se sigue sin opciones y se pagina igual',
    noWhole !== null && noWhole.events.length === events.length && noWhole.complete === true);

  // Lo que corta antes de abrir nada.
  const refusals = [
    ['la sesion que el indice no tiene', continueDeps({ sessions: [] }), request(), 'continue-failed', 'no está en el historial'],
    ['una sesion sin carpeta (M4)', continueDeps({ sessions: [summaryOf('opencode', 'ses_origen', { cwd: '' })] }), request(), 'continue-failed', 'no dice en qué carpeta'],
    ['un seguidor que no llega a live', continueDeps({ history: fakeHistory(events, { state: 'waiting' }) }), request(), 'continue-failed', 'No se encontró el historial'],
    ['una importada sin copia', continueDeps({ sessions: [summaryOf('gemini-cli', 'g1', { storage: 'vault' })] }), request({ agent: 'gemini-cli', sessionId: 'g1' }), 'continue-failed', 'No se encontró el historial'],
    ['un destino que este servidor no tiene', continueDeps(), request({ target: 'antigravity' }), 'agent-unsupported', 'no sabe lanzar'],
    ['un destino no instalado', continueDeps({ targets: [['antigravity', registered('antigravity', 'Antigravity CLI', ANTIGRAVITY_BASE_CAPABILITIES, CODEX_INPUT, fakeHistory([]), null)]] }), request({ target: 'antigravity' }), 'cli-not-found', 'no esta instalada'],
    ['la misma CLI', continueDeps(), request({ target: 'opencode' }), 'continue-failed', 'ya es de esa CLI'],
  ];
  for (const [label, setup, input, code, fragment] of refusals) {
    const refused = await continueSession(setup.deps, input);
    check(`H6 ${label}: ${code} y registry.open no se llamo`,
      refused.ok === false && refused.code === code && refused.message.includes(fragment) && setup.registry.opened.length === 0, show(refused));
  }
  const throwing = continueDeps({ history: { wholeRead: true, follow: () => { throw new Error('base ilegible'); } } });
  const threw = await continueSession(throwing.deps, request());
  check('H6 un seguidor que lanza: continue-failed con el detalle, nada abierto',
    threw.ok === false && threw.code === 'continue-failed' && threw.detail === 'base ilegible' && throwing.registry.opened.length === 0, show(threw));

  // Fallos despues de decidir.
  const badCwd = continueDeps({ registry: fakeRegistry({ fail: new TerminalOpenError('invalid-cwd', 'El directorio no existe: x') }) });
  const openFailed = await continueSession(badCwd.deps, request());
  check('H6 un TerminalOpenError al abrir pasa con su codigo', openFailed.ok === false && openFailed.code === 'invalid-cwd' && badCwd.closed.length === 0, show(openFailed));
  const brokenStore = continueDeps({ pasteStore: { saveText: async () => { throw new Error('disco lleno'); } } });
  const saveFailed = await continueSession(brokenStore.deps, request());
  check('H6 si el transcript no se guarda: se cierra la pestana recien abierta y continue-failed',
    saveFailed.ok === false && saveFailed.code === 'continue-failed' && saveFailed.detail === 'disco lleno' &&
    brokenStore.registry.opened.length === 1 && brokenStore.closed.length === 1 && brokenStore.closed[0] === 'tab-1', show(saveFailed));

  check('H6 la etiqueta corta el titulo a 40 con "…", y sin titulo dice solo Continuacion',
    continuationLabel('x'.repeat(60)) === `Continuación: ${'x'.repeat(40)}…` && continuationLabel('Corto') === 'Continuación: Corto' &&
    continuationLabel('  ') === 'Continuación');

  // M1a: un launch que falla, de cualquier forma, es spawn-failed con el mensaje.
  const syncThrow = await resolveLaunchPlan(() => { throw new Error('Id de sesion invalido.'); }).catch((error) => error);
  const asyncThrow = await resolveLaunchPlan(async () => { throw new Error('No se pudo arrancar el servidor'); }).catch((error) => error);
  const passThrough = await resolveLaunchPlan(() => { throw new TerminalOpenError('cli-not-found', 'falta'); }).catch((error) => error);
  const plan = { file: 'x', args: ['--a'], session: { kind: 'discover' } };
  check('H6 (M1a) resolveLaunchPlan: un throw sincronico es spawn-failed con el mensaje como detalle',
    syncThrow instanceof TerminalOpenError && syncThrow.code === 'spawn-failed' && syncThrow.detail === 'Id de sesion invalido.', show(syncThrow));
  check('H6 (M1a) una promesa rechazada tambien, y un TerminalOpenError pasa tal cual',
    asyncThrow instanceof TerminalOpenError && asyncThrow.code === 'spawn-failed' && asyncThrow.detail === 'No se pudo arrancar el servidor' &&
    passThrough instanceof TerminalOpenError && passThrough.code === 'cli-not-found');
  check('H6 (M1a) un plan sincronico y uno asincronico salen iguales',
    (await resolveLaunchPlan(() => plan)) === plan && (await resolveLaunchPlan(async () => plan)) === plan);
}

// H6 con piezas reales: el indice encuentra la fila, y el seguidor de Claude Code la lee.
{
  const { AgentRegistry } = await import('../src/agents/registry.ts');
  const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
  const { sessionFilePath } = await import('../src/agents/claude-code/paths.ts');
  const { SessionIndex } = await import('../src/session-index.ts');

  const sessionId = '2b3c4d5e-0000-4000-8000-000000000029';
  const file = sessionFilePath(HANDOFF_CWD, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  const at = new Date(Date.UTC(2026, 8, 14, 9, 0, 0)).toISOString();
  const lines = [];
  for (let n = 1; n <= 3; n += 1) {
    lines.push({ type: 'user', uuid: `real-u${n}`, timestamp: at, cwd: HANDOFF_CWD, sessionId, message: { role: 'user', content: `Pedido real número ${n}: revisá el importador.` } });
    lines.push({ type: 'assistant', uuid: `real-a${n}`, timestamp: at, cwd: HANDOFF_CWD, sessionId, message: { role: 'assistant', model: 'modelo-de-prueba', content: [{ type: 'text', text: `Respuesta ${n}, ñandú 🦤.` }] } });
  }
  await writeFile(file, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');

  const vaultCopy = {
    agent: 'gemini-cli', sessionId: 'gemini-copia-1', cwd: HANDOFF_CWD, group: 'g', title: 'Una charla importada',
    titleSource: 'first-message', updatedAt: 5, sizeBytes: 1, partial: false,
  };
  const catalog = { summaries: () => [vaultCopy], onChange: () => () => undefined };
  const adapter = createClaudeCodeAdapter();
  const agentRegistry = new AgentRegistry([adapter]);
  const index = new SessionIndex(agentRegistry, undefined, catalog);
  await index.start();
  const deadline = Date.now() + 10_000;
  while (index.getStatus().state !== 'ready' && Date.now() < deadline) await new Promise((resolve) => setImmediate(resolve));

  const found = index.find('claude-code', sessionId);
  check('H6 SessionIndex.find: la sesion nativa, con su carpeta y storage native',
    found !== null && found.sessionId === sessionId && found.cwd === HANDOFF_CWD && found.storage === 'native' && found.agent === 'claude-code', show(found));
  check('H6 SessionIndex.find: la fila que solo esta en la copia, con storage vault',
    index.find('gemini-cli', 'gemini-copia-1')?.storage === 'vault');
  check('H6 SessionIndex.find: por par, no por id: otra CLI con el mismo id no la encuentra',
    index.find('codex', sessionId) === null && index.find('claude-code', 'no-existe') === null);

  const real = continueDeps({ sessions: [], targets: [] });
  real.deps.index = index;
  real.deps.agents = {
    get: (id) => id === 'claude-code'
      ? { adapter, location: null }
      : id === 'codex' ? registered('codex', 'Codex', CODEX_CAPABILITIES, CODEX_INPUT, fakeHistory([])) : null,
  };
  const outcome = await continueSession(real.deps, { agent: 'claude-code', sessionId, target: 'codex' });
  const saved = outcome.ok ? pathInMessage(outcome.message) : null;
  const markdown = saved === null ? '' : await readFile(saved, 'utf8');
  check('H6 con el seguidor real de Claude Code (instalada o no): el transcript sale del archivo',
    outcome.ok && outcome.continued.totalTurns === 3 && markdown.includes('Pedido real número 3') && markdown.includes('Respuesta 3, ñandú 🦤.') &&
    markdown.startsWith('# Continuación de una conversación con Claude Code'), show(outcome));
  check('H6 (H7) hacia Codex: prefilled y la ruta entre comillas, sin @',
    outcome.ok && outcome.continued.delivery === 'prefilled' && outcome.message.includes(`"${saved}"`) && !outcome.message.includes('@"'));
  index.dispose();
  agentRegistry.disposeAll();
}

// ---------------------------------------------------------------------------
// H7. Como llega
// ---------------------------------------------------------------------------

{
  check('H7 chooseDelivery: con readySignal pty, sin el prefill',
    chooseDelivery({ readySignal: true }) === 'pty' && chooseDelivery({ readySignal: false }) === 'prefill');
  const real = {
    'claude-code': chooseDelivery(CLAUDE_CODE_CAPABILITIES),
    codex: chooseDelivery(CODEX_CAPABILITIES),
    opencode: chooseDelivery(OPENCODE_CAPABILITIES),
    antigravity: chooseDelivery(ANTIGRAVITY_BASE_CAPABILITIES),
    'antigravity con status line': chooseDelivery(ANTIGRAVITY_STATUS_LINE_CAPABILITIES),
  };
  check('H7 contra los literales reales: Claude Code pty; Codex, OpenCode y Antigravity (con status line o no) prefill',
    JSON.stringify(real) === JSON.stringify({ 'claude-code': 'pty', codex: 'prefill', opencode: 'prefill', antigravity: 'prefill', 'antigravity con status line': 'prefill' }),
    JSON.stringify(real));

  const toClaude = await continueSession(continueDeps().deps, request({ target: 'claude-code' }));
  check('H7 hacia Claude Code: sending, y el archivo nombrado con @"ruta"',
    toClaude.ok && toClaude.continued.delivery === 'sending' && /@"[^"]+continuacion-\d+-[0-9a-f]{8}\.md"/.test(toClaude.message), show(toClaude));
  check('H7 el mensaje presenta la CLI de origen y cita el ultimo pedido',
    toClaude.ok && toClaude.message.startsWith('Esto continúa una conversación que empezó con otro asistente (OpenCode).') &&
    toClaude.message.includes('> Ajustá el importador de CSV, paso 30.'));
  check('H7 el plazo de la entrega es 15 s', HANDOFF_DELIVERY_TIMEOUT_MS === 15_000);
}

// ---------------------------------------------------------------------------
// H8. deliverWhenReady
// ---------------------------------------------------------------------------

{
  /** Una pestana falsa, su CLI y una fila real que cuenta lo que escribe. */
  function deliverSetup({ sessionId = 'ses-1', kind = 'agent', capabilities = CLAUDE_CODE_CAPABILITIES, input = CLAUDE_CODE_INPUT, ready = true, timer = 'never' } = {}) {
    const log = [];
    const tab = { kind, sessionId };
    let exists = true;
    const listeners = new Set();
    const queue = new TerminalWriteQueue({ wait: async () => undefined });
    const waits = [];
    let saved = 0;
    const deps = {
      describe: () => (exists ? { ...tab } : null),
      onChanged: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      adapterOf: () => ({
        capabilities,
        input,
        status: { subscribe: () => () => undefined, dispose: () => undefined, waitUntilReady: async (id, ms) => { waits.push([id, ms]); return ready; } },
      }),
      saveImage: async (terminalId, mediaType) => { log.push(`save:${mediaType}`); saved += 1; return path.join(root, 'img', `${saved}.png`); },
      noteSubmitted: (terminalId, submitted) => log.push(`submitted:${submitted}`),
      enqueue: (terminalId, job, options) => { log.push('enqueue'); return queue.enqueue(terminalId, job, options); },
      setTimer: (callback) => {
        if (timer === 'now') callback();
        return () => log.push('timer-cancelled');
      },
    };
    const writes = [];
    const write = (piece) => { writes.push(piece); log.push('write'); return true; };
    return {
      deps, log, writes, write, waits, queue, listeners,
      setSession: (id) => { tab.sessionId = id; for (const listener of [...listeners]) listener(); },
      remove: () => { exists = false; for (const listener of [...listeners]) listener(); },
    };
  }
  const deliver = (setup, extra = {}) => deliverWhenReady(setup.deps, { terminalId: 't1', text: 'Hola agente.', images: [], timeoutMs: 15_000, write: setup.write, ...extra });

  const noSession = deliverSetup({ sessionId: '', timer: 'now' });
  const noSessionOutcome = await deliver(noSession);
  check('H8 una pestana que no gana sesion en el plazo (reloj inyectado): no-session y 0 escrituras',
    noSessionOutcome.kind === 'no-session' && noSession.writes.length === 0 && !noSession.log.includes('enqueue') && noSession.waits.length === 0,
    show(noSession.log));
  check('H8 y suelta el aviso del registro', noSession.listeners.size === 0);
  check('H8 prefillReasonFor(no-session) es not-ready', prefillReasonFor(noSessionOutcome) === 'not-ready');

  const late = deliverSetup({ sessionId: '' });
  const latePromise = deliver(late);
  await new Promise((resolve) => setImmediate(resolve));
  const waitedBefore = late.waits.length;
  late.setSession('ses-tarde');
  const lateOutcome = await latePromise;
  check('H8 la sesion llega por el aviso del registro, sin sondeo: recien ahi espera "lista" y escribe',
    waitedBefore === 0 && lateOutcome.kind === 'sent' && late.waits[0]?.[0] === 'ses-tarde' && late.listeners.size === 0 && late.writes.length === 1,
    show(late.log));

  const gone = deliverSetup({ sessionId: '' });
  const gonePromise = deliver(gone);
  await new Promise((resolve) => setImmediate(resolve));
  gone.remove();
  const goneOutcome = await gonePromise;
  check('H8 la pestana se cierra mientras espera: gone, 0 escrituras y sin nada que prellenar',
    goneOutcome.kind === 'gone' && gone.writes.length === 0 && prefillReasonFor(goneOutcome) === null);

  const notReady = deliverSetup({ ready: false });
  const notReadyOutcome = await deliver(notReady);
  check('H8 waitUntilReady false: not-ready y 0 escrituras', notReadyOutcome.kind === 'not-ready' && notReady.writes.length === 0 && !notReady.log.includes('enqueue'));

  const noSignal = deliverSetup({ capabilities: CODEX_CAPABILITIES, input: CODEX_INPUT });
  const noSignalOutcome = await deliver(noSignal);
  check('H8 sin readySignal no se escribe nada ni se espera',
    noSignalOutcome.kind === 'no-ready-signal' && noSignal.writes.length === 0 && noSignal.waits.length === 0 && prefillReasonFor(noSignalOutcome) === 'send-failed');

  const noImages = deliverSetup({ input: { ...CLAUDE_CODE_INPUT, imageReference: null } });
  const noImagesOutcome = await deliver(noImages, { images: [{ mediaType: 'image/png', data: 'AA==' }] });
  check('H8 imagenes que la CLI no recibe: no-images, antes de esperar, 0 escrituras',
    noImagesOutcome.kind === 'no-images' && noImages.writes.length === 0 && noImages.waits.length === 0);

  const shell = deliverSetup({ kind: 'shell' });
  check('H8 una consola no es un agente', (await deliver(shell)).kind === 'no-agent' && shell.writes.length === 0);

  // M3: el caso de Claude Code, igual que una nota de siempre.
  const claude = deliverSetup();
  const images = [{ mediaType: 'image/png', data: 'AA==' }, { mediaType: 'image/jpeg', data: 'AQ==' }];
  const claudeOutcome = await deliver(claude, { text: 'Revisá esto:\nlinea dos', images });
  const expected = buildSubmissionWrites('Revisá esto:\nlinea dos', [path.join(root, 'img', '1.png'), path.join(root, 'img', '2.png')], CLAUDE_CODE_INPUT);
  check('H8 (M3) Claude Code: readySignal, id conocido y lista: sent, con la espera por su id y el plazo pedido',
    claudeOutcome.kind === 'sent' && claude.waits.length === 1 && claude.waits[0][0] === 'ses-1' && claude.waits[0][1] === 15_000, show(claudeOutcome));
  check('H8 (M3) noteSubmitted antes de la primera escritura, despues de guardar las imagenes',
    JSON.stringify(claude.log) === JSON.stringify(['enqueue', 'save:image/png', 'save:image/jpeg', 'submitted:Revisá esto:\nlinea dos', 'write']), show(claude.log));
  check('H8 (M3) las piezas son las de buildSubmissionWrites(text, images, CLAUDE_CODE_INPUT)',
    JSON.stringify(claude.writes) === JSON.stringify(expected) && expected !== null, show(claude.writes));

  const codexPieces = deliverSetup({ capabilities: { ...CODEX_CAPABILITIES, readySignal: true }, input: CODEX_INPUT });
  await deliver(codexPieces);
  check('H8 una CLI de piezas separadas escribe sus piezas en orden',
    JSON.stringify(codexPieces.writes) === JSON.stringify(buildSubmissionWrites('Hola agente.', [], CODEX_INPUT)) && codexPieces.writes.length > 1, show(codexPieces.writes));

  const refused = deliverSetup();
  const refusedOutcome = await deliverWhenReady(refused.deps, { terminalId: 't1', text: 'x', images: [], timeoutMs: 1, write: () => false });
  check('H8 una terminal que no acepta la pieza: refused, y la continuacion va al cuadro con send-failed',
    refusedOutcome.kind === 'refused' && prefillReasonFor(refusedOutcome) === 'send-failed');

  const interrupted = deliverSetup();
  interrupted.deps.enqueue = (terminalId, job, options) => {
    const run = interrupted.queue.enqueue(terminalId, job, options);
    interrupted.queue.interrupt(terminalId);
    return run;
  };
  const interruptedOutcome = await deliver(interrupted);
  check('H8 una interrupcion antes de empezar: interrupted y 0 escrituras', interruptedOutcome.kind === 'interrupted' && interrupted.writes.length === 0);

  const failedImage = deliverSetup();
  failedImage.deps.saveImage = async () => { throw new Error('firma desconocida'); };
  const failedImageOutcome = await deliver(failedImage, { images });
  check('H8 una imagen que no se guarda: image-failed con el detalle y 0 escrituras',
    failedImageOutcome.kind === 'image-failed' && failedImageOutcome.detail === 'firma desconocida' && failedImage.writes.length === 0);
  check('H8 prefillReasonFor: sent y nothing no prellenan', prefillReasonFor({ kind: 'sent' }) === null && prefillReasonFor({ kind: 'nothing' }) === null);
}

// ---------------------------------------------------------------------------
// H9. PasteStore.saveText
// ---------------------------------------------------------------------------

{
  const storeRoot = path.join(root, 'pegados-h9');
  const store = new PasteStore(storeRoot);
  const content = '# Continuación\n\nÑandú, café y un emoji 🦤 al final.\n';
  const saved = await store.saveText('terminal-h9', 'continuacion', content);
  const name = path.basename(saved.path);
  check('H9 nombre continuacion-<n>-<8 hex>.md', /^continuacion-\d+-[0-9a-f]{8}\.md$/.test(name), name);
  check('H9 dentro de la subcarpeta de la pestana', path.dirname(saved.path) === path.join(storeRoot, 'terminal-h9'), saved.path);
  const back = await readFile(saved.path);
  check('H9 contenido UTF-8 identico, sin BOM, y bytes contados',
    back.toString('utf8') === content && back[0] !== 0xef && saved.bytes === Buffer.byteLength(content, 'utf8'));
  const second = await store.saveText('terminal-h9', 'continuacion', 'otra');
  check('H9 dos guardados no se pisan', second.path !== saved.path && (await readdir(path.join(storeRoot, 'terminal-h9'))).length === 2);

  const hostile = await store.saveText('../../fuera', 'continuacion', 'x');
  check('H9 un id de pestana hostil no saca el archivo de la carpeta', path.dirname(path.dirname(hostile.path)) === storeRoot, hostile.path);

  const tooBig = await store.saveText('terminal-grande', 'continuacion', 'a'.repeat(MAX_TEXT_BYTES + 1)).catch((error) => error);
  const bigFolder = await stat(path.join(storeRoot, 'terminal-grande')).then(() => true, () => false);
  check(`H9 mas de ${MAX_TEXT_BYTES} bytes: PasteTextError y ningun archivo`,
    tooBig instanceof PasteTextError && !bigFolder && MAX_TEXT_BYTES === HANDOFF_MAX_BYTES + 4 * 1024, show(String(tooBig)));
  check('H9 justo en el tope se guarda', (await store.saveText('terminal-tope', 'continuacion', 'b'.repeat(MAX_TEXT_BYTES))).bytes === MAX_TEXT_BYTES);

  /*
    R29-4: en Linux la temporal es compartida, y el transcript trae la
    conversacion. En Windows %TEMP% es por usuario y los bits no dicen nada.
  */
  if (process.platform !== 'win32') {
    const modeOf = async (file) => (await stat(file)).mode & 0o777;
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
    const image = await store.save('terminal-modos', 'image/png', png);
    check('H9 (R29-4) la carpeta de la pestana 0700; el transcript y la imagen pegada 0600',
      (await modeOf(path.dirname(saved.path))) === 0o700 && (await modeOf(saved.path)) === 0o600 &&
      (await modeOf(path.dirname(image.path))) === 0o700 && (await modeOf(image.path)) === 0o600,
      show([await modeOf(path.dirname(saved.path)), await modeOf(saved.path), await modeOf(image.path)]));
  } else {
    console.log('--    H9 (R29-4) permisos 0700 y 0600: solo fuera de Windows');
  }

  await store.clearTerminal('terminal-h9');
  const cleared = await stat(path.join(storeRoot, 'terminal-h9')).then(() => false, () => true);
  check('H9 clearTerminal lo borra', cleared);
}

// ---------------------------------------------------------------------------
// H10. La web
// ---------------------------------------------------------------------------

{
  const ui = await import('../../web/src/agent-ui.ts');
  const info = (id, label, available, capabilities = shared.NO_CAPABILITIES) => ({
    id, label, command: id, available, version: available ? '1.0' : null, installUrl: 'https://example.com',
    missingMessage: available ? null : 'falta', capabilities, environmentNotice: null, statusLine: null,
  });
  const onlyClaude = [info('claude-code', 'Claude Code', true), info('codex', 'Codex', false), info('opencode', 'OpenCode', false), info('antigravity', 'Antigravity CLI', false)];
  const all = [info('claude-code', 'Claude Code', true), info('codex', 'Codex', true), info('opencode', 'OpenCode', true), info('antigravity', 'Antigravity CLI', true)];
  const ids = (list) => list.map((agent) => agent.id).join(',');

  check('H10 continueTargets con solo Claude Code disponible: [] (D21)',
    ui.continueTargets(onlyClaude, 'claude-code').length === 0 && ui.continueTargets(onlyClaude, 'codex').length === 0 &&
    ui.continueTargets(onlyClaude, 'gemini-cli').length === 0);
  check('H10 con las cuatro y fuente OpenCode: Claude Code, Codex y Antigravity CLI, en orden de registro (decision 1)',
    ids(ui.continueTargets(all, 'opencode')) === 'claude-code,codex,antigravity', ids(ui.continueTargets(all, 'opencode')));
  check('H10 una no instalada no se ofrece',
    ids(ui.continueTargets([all[0], all[1], info('opencode', 'OpenCode', false)], 'claude-code')) === 'codex');
  check('H10 fuente importada: todas las instaladas; parcial o sin fuente: []',
    ids(ui.continueTargets(all, 'gemini-cli')) === 'claude-code,codex,opencode,antigravity' &&
    ui.continueTargets(all, 'antigravity-ide', true).length === 0 && ui.continueTargets(all, null).length === 0);
  check('H10 antes del hello (sin CLIs) no se ofrece nada', ui.continueTargets([], 'claude-code').length === 0);

  const sendable = {
    'claude-code': ui.controlsFor(CLAUDE_CODE_CAPABILITIES).noteSendable,
    codex: ui.controlsFor(CODEX_CAPABILITIES).noteSendable,
    opencode: ui.controlsFor(OPENCODE_CAPABILITIES).noteSendable,
    antigravity: ui.controlsFor(ANTIGRAVITY_STATUS_LINE_CAPABILITIES).noteSendable,
  };
  check('H10 noteSendable sigue siendo readySignal (sin promptApi, A4): solo Claude Code',
    JSON.stringify(sendable) === JSON.stringify({ 'claude-code': true, codex: false, opencode: false, antigravity: false }), JSON.stringify(sendable));

  check('H10 (B6) waitingBarText con permission prompt: el texto de hoy, palabra por palabra, con tarjetas o sin',
    ui.waitingBarText('permission prompt') === 'La CLI esta esperando que autorices una herramienta.' &&
    ui.waitingBarText('permission prompt', true) === 'La CLI esta esperando que autorices una herramienta.');
  check('H10 (B6) el resto: el texto de hoy, con tarjetas o sin',
    ['dialog open', 'input needed', 'worker request', ''].every((label) =>
      ui.waitingBarText(label) === 'La CLI esta esperando una respuesta tuya.' && ui.waitingBarText(label, true) === 'La CLI esta esperando una respuesta tuya.'));
  check('H10 (B6) una pregunta con tarjetas se contesta en el hilo; sin tarjetas, el texto de siempre',
    ui.waitingBarText('question', true) === 'El agente te hizo una pregunta: respondela en el hilo.' &&
    ui.waitingBarText('question', false) === 'La CLI esta esperando una respuesta tuya.');

  check('H10 el aviso: CLI, N de M turnos y lo que se pierde',
    ui.handoffNoticeText('OpenCode', 20, 57, false) ===
      'Continuación de OpenCode: el agente arranca de un transcript de los últimos 20 de 57 turnos, no del contexto que tenía. Los resultados de herramientas van recortados y las imágenes no viajan.',
    ui.handoffNoticeText('OpenCode', 20, 57, false));
  check('H10 el aviso con una lectura cortada dice "de más de M", y con todos no dice "últimos"',
    ui.handoffNoticeText('Codex', 20, 57, true).includes('de los últimos 20 de más de 57 turnos') &&
    ui.handoffNoticeText('Codex', 3, 3, false).includes('de los 3 turnos,') && ui.handoffNoticeText('Codex', 1, 1, false).includes('del único turno'));
  check('H10 prellenar: el texto solo con el cuadro vacio; si no, antes y con una linea en blanco',
    ui.mergePrefill('', 'Continuá.') === 'Continuá.' && ui.mergePrefill('  \n', 'Continuá.') === 'Continuá.' &&
    ui.mergePrefill('lo mio', 'Continuá.') === 'Continuá.\n\nlo mio');
  check('H10 el medidor apaga el boton mientras la sesion se descubre o si no hay sesion',
    ui.continueBlockedReason('abc', true, true) !== null && ui.continueBlockedReason('', false, true) !== null && ui.continueBlockedReason('abc', false, true) === null);
  // R29-5: Claude Code tiene id desde el lanzamiento, pero sin mensajes no hay nada en el historial que continuar.
  check('H10 (R29-5) con id y sin mensajes en el hilo, el boton se apaga y dice por que',
    ui.continueBlockedReason('abc', false, false) === 'Esta conversación todavía no tiene mensajes que continuar.',
    String(ui.continueBlockedReason('abc', false, false)));

  /*
    Medido en la prueba en vivo: con texto largo en el filtro de la barra, el clic
    en `↪` le saca el foco al campo, Chrome devuelve su scroll a cero y ese scroll
    cerraba el menu recien abierto. Nodos de mentira: solo `contains`.
  */
  const node = (name, children = []) => ({ name, contains: (other) => other === node.all[name] || children.some((c) => node.all[c]?.contains(other)) });
  node.all = {};
  for (const [name, children] of [['anchor', []], ['menuItem', []], ['filter', []], ['list', ['anchor']], ['menu', ['menuItem']], ['document', ['list', 'filter', 'menu']]]) {
    node.all[name] = node(name, children);
  }
  const { anchor, menu, menuItem, filter, list, document } = node.all;
  check('H10 el scroll de un campo de texto que pierde el foco no cierra el menu de ↪',
    ui.scrollClosesMenu(filter, anchor, menu) === false);
  check('H10 el scroll de la lista que contiene el boton, o del documento, si lo cierra',
    ui.scrollClosesMenu(list, anchor, menu) === true && ui.scrollClosesMenu(document, anchor, menu) === true);
  check('H10 el scroll dentro del propio menu no lo cierra; un destino sin contains, si',
    ui.scrollClosesMenu(menuItem, anchor, menu) === false && ui.scrollClosesMenu(null, anchor, menu) === true && ui.scrollClosesMenu({}, anchor, null) === true);
  const menuSource = await readFile(new URL('../../web/src/AgentMenu.tsx', import.meta.url), 'utf8');
  check('H10 AgentMenu decide el cierre por scroll con scrollClosesMenu',
    /onScroll[\s\S]{0,200}scrollClosesMenu\(event\.target, anchor, menuRef\.current\)/.test(menuSource));
}

await rm(root, { recursive: true, force: true });
console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
