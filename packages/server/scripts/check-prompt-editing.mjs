/**
 * Chequeo de corregir lo que se mando (hito 44, §4.16): el mensaje detenido
 * que vuelve al cuadro, volver a antes de un mensaje y la lista que sigue sola.
 *
 *   npx tsx scripts/check-prompt-editing.mjs
 *
 * Lo que se rompe en silencio:
 *
 *  - **Esconder lo que no se deshizo.** El JSONL de Claude Code es un arbol, y
 *    no todo lo que no cuelga de la linea anterior es una rama abandonada: los
 *    resultados de herramientas en paralelo y `/compact` tambien lo hacen. Si
 *    la regla se equivoca, el hilo pierde mensajes buenos sin que nada falle.
 *  - **Dar por devuelto un mensaje que la CLI entrego.** La app vaciaria la caja
 *    de la CLI y lo pondria otra vez en el cuadro: saldria dos veces.
 *  - **Elegir otro mensaje u otra opcion en el menu de rewind.** Deshacer
 *    codigo no tiene vuelta atras: el menu se lee de pantallas medidas, con
 *    redibujos a medias, y ante cualquier duda se cierra sin elegir.
 *  - **Que lo escondido vuelva** al dejar de mirar la conversacion y volver.
 *  - **La lista**: un año o un decimal tomados por lista, o la renumeracion
 *    que pisa otra lista.
 *
 * El seguidor real corre sobre un JSONL inventado con la forma medida: el home
 * apunta a una carpeta temporal antes de importar nada, y nunca se lee
 * `~/.claude`. No carga node-pty.
 */

import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = await mkdtemp(path.join(tmpdir(), 'agent-workbench-check-prompt-'));
process.env.HOME = root;
process.env.USERPROFILE = root;

const shared = await import('@agent-workbench/shared');
const { BranchTracker } = await import('../src/agents/claude-code/branch-tracker.ts');
const { ConversationFollower } = await import('../src/agents/claude-code/conversation-follower.ts');
const { ClaudeCodeSessionFollower } = await import('../src/agents/claude-code/session-follower.ts');
const { ModelVariantRegistry } = await import('../src/agents/claude-code/model-variants.ts');
const { sessionFilePath } = await import('../src/agents/claude-code/paths.ts');
const { findHandedBack, settledAfter } = await import('../src/agents/claude-code/handback.ts');
const rewindMenu = await import('../src/agents/claude-code/rewind-menu.ts');
const { rewindTargetFrom } = await import('../src/rewind-target.ts');
const { reclaimQueuedSubmits } = await import('../src/queued-submits.ts');
const { createPtyScreen } = await import('../src/pty-screen.ts');
const { ConversationHub } = await import('../src/conversation-hub.ts');
const { createClaudeCodeAdapter } = await import('../src/agents/claude-code/index.ts');
const { continueList } = await import('../../web/src/list-continuation.ts');
const rewindUi = await import('../../web/src/rewind-ui.ts');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' - ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);
const same = (a, b) => json(a) === json(b);

// --- Lineas del JSONL, con la forma medida (2.1.301) ------------------------

const T0 = Date.parse('2026-10-15T20:00:00.000Z');
const at = (seconds) => new Date(T0 + seconds * 1_000).toISOString();
const user = (uuid, parent, text, seconds = 0) => ({
  type: 'user', uuid, parentUuid: parent, timestamp: at(seconds), isSidechain: false,
  message: { role: 'user', content: text },
});
const assistant = (uuid, parent, text, seconds = 1) => ({
  type: 'assistant', uuid, parentUuid: parent, timestamp: at(seconds), isSidechain: false,
  message: {
    role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  },
});
const toolUse = (uuid, parent, id, name = 'Read', input = { file_path: 'a.txt' }) => ({
  type: 'assistant', uuid, parentUuid: parent, timestamp: at(1), isSidechain: false,
  message: { role: 'assistant', model: 'claude-opus-5', content: [{ type: 'tool_use', id, name, input }] },
});
const toolResult = (uuid, parent, id) => ({
  type: 'user', uuid, parentUuid: parent, timestamp: at(1), isSidechain: false,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
const attachment = (uuid, parent) => ({
  type: 'attachment', uuid, parentUuid: parent, timestamp: at(0), isSidechain: false, attachment: { type: 'date' },
});
const turnEnd = (uuid, parent) => ({ type: 'system', subtype: 'turn_duration', uuid, parentUuid: parent, durationMs: 1000, isSidechain: false });
const interruptedMarker = (uuid, parent, seconds = 3) => ({
  type: 'user', uuid, parentUuid: parent, timestamp: at(seconds), isSidechain: false,
  message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
});
const compact = (uuid, logical) => ({
  type: 'system', subtype: 'compact_boundary', uuid, parentUuid: null, logicalParentUuid: logical, isSidechain: false,
});
const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

/** Lo que el seguidor de Claude Code entrega, de un archivo entero. */
async function visibleOf(records) {
  const file = path.join(root, `seguido-${Math.random().toString(36).slice(2)}.jsonl`);
  await writeFile(file, jsonl(records));
  const follower = new ConversationFollower(file);
  const first = await follower.poll();
  return { follower, first, ids: follower.getTail(1000).events.map((event) => event.eventId) };
}

// --- A. El arbol de la conversacion ----------------------------------------

{
  const tracker = new BranchTracker();
  const feed = (uuid, parent, prompt = false, mayBranch = prompt) => tracker.observe({ uuid, parent, prompt, mayBranch, speaks: true });
  feed('p1', null, true);
  feed('a1', 'p1');
  feed('t1', 'a1');
  feed('t2', 't1');
  feed('r1', 't1', false, false);
  feed('r2', 't2', false, false);
  feed('a2', 'r2');
  check('A1 herramientas en paralelo: cada resultado cuelga de su llamada y no se esconde nada', tracker.hiddenCount() === 0);
  feed('p2', 'a2', true);
  feed('b2', 'p2');
  const changed = feed('p3', 'a2', true);
  check('A2 volver a antes de un mensaje con respuesta: se esconde ese mensaje y lo que cuelga de el', changed && tracker.isHidden('p2') && tracker.isHidden('b2'));
  check('A2 lo del camino se ve, resultados en paralelo incluidos', ['p1', 'a1', 't1', 't2', 'r1', 'r2', 'a2', 'p3'].every((uuid) => !tracker.isHidden(uuid)));
}
{
  const tracker = new BranchTracker();
  const feed = (uuid, parent, prompt = false, mayBranch = prompt) => tracker.observe({ uuid, parent, prompt, mayBranch, speaks: true });
  feed('p1', null, true);
  feed('a1', 'p1');
  feed('e1', 'a1');
  feed('c1', 'e1');
  check('A3 /compact, con el padre en logicalParentUuid: nada escondido', tracker.hiddenCount() === 0);
  feed('s1', 'c1', true);
  check('A3 el mensaje despues de compactar sigue la misma rama', tracker.hiddenCount() === 0);
}
{
  const tracker = new BranchTracker();
  const feed = (uuid, parent, prompt = false, mayBranch = prompt) => tracker.observe({ uuid, parent, prompt, mayBranch, speaks: true });
  feed('p1', null, true);
  feed('a1', 'p1');
  feed('d1', 'a1');
  feed('x', 'd1', true);
  feed('x-att', 'x');
  check('A4 retirar un mensaje que no es del usuario: no', tracker.withdraw('a1') === false);
  check('A4 retirar el mensaje detenido: esconde el y lo que cuelga', tracker.withdraw('x') === true && tracker.isHidden('x') && tracker.isHidden('x-att'));
  check('A4 retirarlo otra vez no cambia nada', tracker.withdraw('x') === false && tracker.withdrawnFrom() === 'x');
  feed('y', 'd1', true);
  check('A4 el mensaje corregido cuelga de antes: la CLI lo confirma y se olvida el retiro',
    tracker.withdrawnFrom() === null && tracker.isHidden('x') && !tracker.isHidden('y'));
}
{
  const tracker = new BranchTracker();
  const feed = (uuid, parent, prompt = false, mayBranch = prompt, speaks = true) =>
    tracker.observe({ uuid, parent, prompt, mayBranch, speaks });
  feed('p1', null, true);
  feed('a1', 'p1');
  feed('x', 'a1', true);
  feed('x-1', 'x', false, false, false);
  tracker.withdraw('x');
  feed('x-2', 'x-1', false, false, false);
  check('A5 un adjunto del mensaje retirado que llega tarde no lo vuelve a mostrar',
    tracker.isHidden('x') && tracker.isHidden('x-2') && tracker.withdrawnFrom() === 'x');
  feed('x-sigue', 'x-2');
  check('A5 si la CLI sigue hablando en la rama retirada, vuelve a verse', !tracker.isHidden('x') && tracker.withdrawnFrom() === null);
}
{
  const tracker = new BranchTracker();
  const feed = (uuid, parent, prompt = false, mayBranch = prompt) => tracker.observe({ uuid, parent, prompt, mayBranch, speaks: true });
  feed('p1', null, true);
  feed('a1', 'p1');
  feed('p2', 'a1', true);
  feed('a2', 'p2');
  feed('n', null, true);
  check('A6 volver a antes del primer mensaje: el mensaje nuevo es raiz y todo lo anterior se esconde',
    ['p1', 'a1', 'p2', 'a2'].every((uuid) => tracker.isHidden(uuid)) && !tracker.isHidden('n'));
}

// --- B. El seguidor de Claude Code, con lineas medidas ----------------------

{
  // c02: el mensaje equivocado (con sus adjuntos) y el corregido, los dos raiz.
  const { ids, first } = await visibleOf([
    user('x', null, 'Mensaje equivocado'),
    attachment('x1', 'x'),
    user('y', null, 'Responde solo con la palabra hola', 5),
    attachment('y1', 'y'),
    assistant('y2', 'y1', 'hola', 6),
    turnEnd('y3', 'y2'),
  ]);
  check('B1 el mensaje detenido y reenviado no se ve; el corregido y su respuesta si', same(ids, ['y', 'y2']), json(ids));
  check('B1 la primera lectura avisa el reinicio', first.reset === true);
}
{
  // 233bd1a7:647/649 de la medicion: dos hermanos que cuelgan del mismo resumen.
  const { ids } = await visibleOf([
    user('p1', null, 'primero'),
    assistant('a1', 'p1', 'uno'),
    turnEnd('d1', 'a1'),
    { type: 'system', subtype: 'away_summary', uuid: 's1', parentUuid: 'd1', isSidechain: false },
    user('x', 's1', 'el video esta muy bueno'),
    user('y', 's1', 'el video esta muy bueno, corregido', 8),
    assistant('a2', 'y', 'ok', 9),
  ]);
  check('B2 un mensaje deshecho en medio de la conversacion: solo se esconde el', same(ids, ['p1', 'a1', 'y', 'a2']), json(ids));
}
{
  const { ids } = await visibleOf([
    user('p1', null, 'lee los dos'),
    toolUse('t1', 'p1', 'tu1'),
    toolUse('t2', 't1', 'tu2'),
    toolResult('r1', 't1', 'tu1'),
    toolResult('r2', 't2', 'tu2'),
    assistant('a1', 'r2', 'listo'),
    compact('c1', 'a1'),
    user('p2', 'c1', 'sigue'),
  ]);
  check('B3 herramientas en paralelo y /compact: no se esconde nada', same(ids, ['p1', 't1', 't2', 'r1', 'r2', 'a1', 'p2']), json(ids));
}
{
  // Incremental: el mensaje llega, se retira (la CLI no escribe nada), y despues el corregido.
  const file = path.join(root, 'incremental.jsonl');
  await writeFile(file, jsonl([user('p1', null, 'hola'), assistant('a1', 'p1', 'que tal'), turnEnd('d1', 'a1'), user('x', 'd1', 'me equivoque')]));
  const follower = new ConversationFollower(file);
  await follower.poll();
  check('B4 antes de retirarlo, el mensaje se ve', follower.getTail(10).events.some((event) => event.eventId === 'x'));
  check('B4 retirarlo cambia lo que se ve', follower.withdrawFrom('x') === true && follower.withdrawnFrom() === 'x');
  check('B4 y deja de entregarse', !follower.getTail(10).events.some((event) => event.eventId === 'x'));
  await appendFile(file, jsonl([user('y', 'd1', 'ahora si'), assistant('a2', 'y', 'bien')]));
  const next = await follower.poll();
  const ids = follower.getTail(10).events.map((event) => event.eventId);
  check('B4 el corregido llega como agregado: lo escondido no cambio, el retirado sigue afuera y el retiro se olvida',
    same(next.added.map((event) => event.eventId), ['y', 'a2']) && same(ids, ['p1', 'a1', 'y', 'a2']) && follower.withdrawnFrom() === null,
    json({ reset: next.reset, ids }));
  check('B4 retirar un mensaje que ya no esta en la conversacion: no', follower.withdrawFrom('x') === false);
}
{
  // Lineas sin `parentUuid` (fixtures viejos): no abren ni cierran ramas.
  const { ids } = await visibleOf([
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { role: 'user', content: 'uno' } },
    { type: 'user', uuid: 'u2', timestamp: at(1), message: { role: 'user', content: 'dos' } },
  ]);
  check('B5 sin parentUuid no se esconde nada', same(ids, ['u1', 'u2']), json(ids));
}

// --- C. El mensaje que la CLI devolvio a su caja ----------------------------

{
  const interruptedAt = T0 + 2_000;
  const lines = (records) => records.map((record) => JSON.stringify(record));
  const sent = [{ text: 'Mensaje equivocado', original: 'Mensaje equivocado', at: T0 + 500 }];
  const back = findHandedBack(lines([user('d1', null, 'antes'), user('x', 'd1', 'Mensaje equivocado', 0), attachment('x1', 'x')]), sent, interruptedAt);
  check('C1 sin respuesta ni marca despues: devuelto, con su id', same(back, [{ text: 'Mensaje equivocado', eventId: 'x' }]), json(back));
  check('C2 con la marca de interrupcion: entregado',
    findHandedBack(lines([user('x', null, 'Mensaje equivocado'), attachment('x1', 'x'), interruptedMarker('m', 'x1')]), sent, interruptedAt).length === 0);
  check('C3 con una respuesta: entregado',
    findHandedBack(lines([user('x', null, 'Mensaje equivocado'), assistant('a', 'x', 'ok')]), sent, interruptedAt).length === 0);
  check('C4 escrito bastante despues del Esc: no',
    findHandedBack(lines([user('x', null, 'Mensaje equivocado', 5)]), sent, interruptedAt).length === 0);
  check('C4 un mensaje en cola que la CLI mando detras de la interrupcion (c10), aunque sea enseguida: no',
    findHandedBack(lines([user('a', null, 'otro'), interruptedMarker('m', 'a', 2), user('x', 'm', 'Mensaje equivocado', 2)]), sent, interruptedAt).length === 0);
  check('C4 fechado unos milisegundos despues del Esc (la CLI tardo en tomar el Enter): devuelto igual',
    findHandedBack(lines([user('x', null, 'Mensaje equivocado', 2.3)]), sent, interruptedAt).length === 1);
  const wrapped = '<pasted_content id="8350">\nlinea uno\nlinea dos\n</pasted_content id="8350">';
  const longSent = [{ text: 'linea uno\nlinea dos', original: 'linea uno\nlinea dos', at: T0 }];
  check('C5 un pegado largo que la CLI envolvio en sus etiquetas casa igual',
    findHandedBack(lines([user('x', null, wrapped)]), longSent, interruptedAt).length === 1);
  const withImage = [{ text: '@"C:\\tmp\\pegada-1.png" mira esto', original: 'mira esto', at: T0 }];
  const imageBack = findHandedBack(lines([user('x', null, '@"C:\\tmp\\pegada-1.png" mira esto')]), withImage, interruptedAt);
  check('C6 vuelve el texto del cuadro, sin la referencia a la imagen', imageBack[0]?.text === 'mira esto', json(imageBack));
  check('C7 libre despues del Esc: si', settledAfter({ status: 'idle', waitingFor: null, statusUpdatedAt: interruptedAt + 300 }, interruptedAt, interruptedAt + 400));
  check('C7 libre pero de antes del Esc: no', !settledAfter({ status: 'idle', waitingFor: null, statusUpdatedAt: interruptedAt - 300 }, interruptedAt, interruptedAt + 400));
  check('C7 trabajando: no', !settledAfter({ status: 'busy', waitingFor: null, statusUpdatedAt: interruptedAt + 300 }, interruptedAt, interruptedAt + 400));
  check('C7 sin fecha en el estado: despues de un rato',
    !settledAfter({ status: 'idle', waitingFor: null, statusUpdatedAt: null }, interruptedAt, interruptedAt + 100) &&
      settledAfter({ status: 'idle', waitingFor: null, statusUpdatedAt: null }, interruptedAt, interruptedAt + 1_000));
}
{
  const calls = [];
  const outcome = await reclaimQueuedSubmits({
    source: {
      clearGapMs: 0,
      returnReason: 'stopped-early',
      check: async () => ({ settled: true, undelivered: ['mira esto'], withdrawn: ['x'] }),
    },
    target: () => ({ cwd: 'D:\\p', sessionId: 's' }),
    submissions: [{ text: 'mira esto', at: 1 }],
    interruptedAt: 2,
    lastClearKeyAt: () => null,
    writeClearKey: () => { calls.push('clear'); return true; },
    prefill: (text) => calls.push(`prefill:${text}`),
    withdraw: (ids) => calls.push(`withdraw:${ids.join(',')}`),
    wait: async () => undefined,
    now: () => 3,
  });
  check('C8 devuelto: vacia la caja, trae el texto al cuadro y lo esconde del hilo, en ese orden',
    outcome === 'reclaimed' && same(calls, ['clear', 'prefill:mira esto', 'withdraw:x']), json(calls));
}
{
  // La linea del mensaje llega a disco despues de la primera mirada: se sigue esperando.
  let looks = 0;
  const calls = [];
  const outcome = await reclaimQueuedSubmits({
    source: {
      clearGapMs: 0,
      returnReason: 'stopped-early',
      check: async () => {
        looks += 1;
        return looks < 3
          ? { settled: looks > 1, undelivered: [], pending: true }
          : { settled: true, undelivered: ['tarde'], withdrawn: ['z'], pending: false };
      },
    },
    target: () => ({ cwd: 'D:\\p', sessionId: 's' }),
    submissions: [{ text: 'tarde', at: 1 }],
    interruptedAt: 2,
    lastClearKeyAt: () => null,
    writeClearKey: () => { calls.push('clear'); return true; },
    prefill: (text) => calls.push(`prefill:${text}`),
    withdraw: (ids) => calls.push(`withdraw:${ids.join(',')}`),
    wait: async () => undefined,
    now: () => 3,
  });
  check('C10 la linea llega tarde a disco: se sigue mirando y se recupera',
    outcome === 'reclaimed' && looks === 3 && same(calls, ['clear', 'prefill:tarde', 'withdraw:z']), json({ outcome, looks, calls }));
}
{
  // Una sesion nueva: el archivo todavia no existe en la primera mirada. Se sigue mirando, sin tocar nada.
  const { createClaudeCodeHandback } = await import('../src/agents/claude-code/handback.ts');
  const source = createClaudeCodeHandback({
    sessionFile: () => path.join(root, 'no-existe-todavia.jsonl'),
    status: async () => ({ status: 'idle', waitingFor: null, statusUpdatedAt: Date.now() }),
  });
  const result = await source.check({ cwd: root, sessionId: 's' }, [{ text: 'hola', at: 1 }], Date.now() - 100);
  check('C11 sin archivo todavia: nada que devolver, pero pendiente', result.undelivered.length === 0 && result.pending === true, json(result));
}
{
  const adapter = createClaudeCodeAdapter();
  check('C9 Claude Code declara el mensaje detenido y el menu de rewind',
    adapter.queuedSubmits?.returnReason === 'stopped-early' && typeof adapter.rewind?.run === 'function' && adapter.capabilities.rewind === true);
  adapter.dispose();
}

// --- D. El menu de rewind, leido de pantallas medidas -----------------------

const M = '\u276f';
const LIST_CURRENT = [
  `${M} Crea un archivo nota.txt con el texto uno. No hagas nada mas.`,
  '\u2594\u2594\u2594\u2594',
  '   Rewind',
  '   Restore the code and/or conversation to the point before\u2026',
  '     \u2191 1 more',
  '     Responde solo con la palabra dos',
  '     No code changes',
  `   ${M} (current)`,
  '   Enter to continue \u00b7 Esc to cancel',
];
const CONFIRM_CODE = [
  '   Rewind',
  '   Confirm you want to restore to the point before you sent this message:',
  '   \u2502 Crea un archivo nota.txt con el texto uno. No hagas nada mas.',
  '   \u2502 (14s ago)',
  '   The conversation will be forked.',
  '   The code will be restored -1 in nota.txt.',
  `   ${M} 1. Restore code and conversation`,
  '     2. Restore conversation',
  '     3. Restore code',
  '     4. Summarize from here',
  '   \u2193 5. Summarize up to here',
  '   \u26a0 Rewinding does not affect files edited manually or via bash.',
];
/** La lista como la dibujo la CLI en la pestana de la app (prueba en vivo): con lineas en blanco. */
const LIST_SPACED = [
  `${M} Responde solo con la palabra dos`,
  '\u25cf dos',
  '',
  '   Rewind',
  '',
  '   Restore the code and/or conversation to the point before\u2026',
  '',
  '     \u2191 1 more',
  '     Responde solo con la palabra dos',
  '     No code changes',
  '',
  `   ${M} (current)`,
  '',
  '   Enter to continue \u00b7 Esc to cancel',
];
{
  const spaced = rewindMenu.readRewindScreen(LIST_SPACED);
  check('D0 con lineas en blanco entre titulo, explicacion y lista (la terminal de la app): se lee igual',
    spaced.kind === 'list' && spaced.selected === null, json(spaced));
  const list = rewindMenu.readRewindScreen(LIST_CURRENT);
  check('D1 la lista con "(current)" marcado: sin mensaje elegido, y el de la conversacion de arriba no cuenta',
    list.kind === 'list' && list.selected === null, json(list));
  const confirm = rewindMenu.readRewindScreen(CONFIRM_CODE);
  check('D2 la confirmacion: el mensaje citado y las cinco opciones, la primera marcada',
    confirm.kind === 'confirm' && same(confirm.quoted, ['Crea un archivo nota.txt con el texto uno. No hagas nada mas.']) &&
      same(confirm.options.map((option) => `${option.number}${option.selected ? '*' : ''} ${option.label}`), [
        '1* Restore code and conversation', '2 Restore conversation', '3 Restore code', '4 Summarize from here', '5 Summarize up to here',
      ]), json(confirm));
  check('D3 sin menu: none', rewindMenu.readRewindScreen([`${M} hola`, 'auto mode on']).kind === 'none');
  check('D4 un mensaje largo se ve como su primera linea con \u2026',
    rewindMenu.shownMatches('Necesito que revises esto con cuidado, linea por linea:\u2026', 'Necesito que revises esto con cuidado, linea por linea:'));
  check('D4 cortado por el ancho', rewindMenu.shownMatches('Crea un archivo nota.txt con el te\u2026', 'Crea un archivo nota.txt con el texto uno.'));
  check('D4 sin \u2026 tiene que ser igual', !rewindMenu.shownMatches('Crea un archivo', 'Crea un archivo nota.txt'));
  check('D4 otro texto no casa', !rewindMenu.shownMatches('Responde solo con la palabra dos', 'Responde solo con la palabra uno'));
}

/**
 * Una CLI de mentira con el menu medido: lista, confirmacion y la caja. Cuenta
 * lo que se le escribio y que opcion se ejecuto. Con `torn`, despues de cada
 * tecla la primera lectura es un redibujo a medias: la marca no esta en ningun
 * lado.
 */
function fakeCli({ items, opens = true, quote = null, torn = false }) {
  let state = 'prompt';
  let selected = items.length;
  let option = 0;
  let options = [];
  let editor = '';
  let lastEsc = false;
  let tearNext = false;
  let clock = 0;
  const writes = [];
  const result = { restoredWith: null, restoredIndex: null };
  const shown = (text) => (text.includes('\n') ? `${text.split('\n')[0]}\u2026` : text);
  const optionsFor = (index) =>
    items.slice(index).some((item) => item.code !== 'No code changes')
      ? ['Restore code and conversation', 'Restore conversation', 'Restore code', 'Summarize from here', 'Summarize up to here']
      : ['Restore conversation', 'Summarize from here', 'Summarize up to here', 'Never mind'];
  const render = (withMarker) => {
    const marker = (on) => (on && withMarker ? `   ${M} ` : '     ');
    if (state === 'list') {
      return [
        `${M} ${items[0]?.text.split('\n')[0] ?? ''}`,
        '   Rewind',
        '   Restore the code and/or conversation to the point before\u2026',
        ...items.flatMap((item, index) => [`${marker(index === selected)}${shown(item.text)}`, `     ${item.code}`]),
        `${marker(selected === items.length)}(current)`,
        '   Enter to continue \u00b7 Esc to cancel',
      ];
    }
    if (state === 'confirm') {
      const quoted = quote ?? items[selected].text.split('\n')[0];
      return [
        '   Rewind',
        '   Confirm you want to restore to the point before you sent this message:',
        `   \u2502 ${quoted}`,
        '   \u2502 (12s ago)',
        '   The conversation will be forked.',
        ...options.map((label, index) => `${marker(index === option)}${index + 1}. ${label}`),
      ];
    }
    return ['Claude Code', `${M} ${editor.length > 0 ? editor : 'Try "create a util logging.py that..."'}`, 'auto mode on'];
  };
  const io = {
    write(data) {
      writes.push(data);
      tearNext = torn;
      if (data === '\x1b') {
        if (state === 'prompt') {
          if (lastEsc && opens) {
            state = 'list';
            selected = items.length;
          }
          lastEsc = !lastEsc;
        } else if (state === 'list') state = 'prompt';
        else if (state === 'confirm') state = 'list';
        return true;
      }
      lastEsc = false;
      if (data === '\x1b[A') {
        if (state === 'list') selected = Math.max(0, selected - 1);
        else if (state === 'confirm') option = Math.max(0, option - 1);
      } else if (data === '\x1b[B') {
        if (state === 'list') selected = Math.min(items.length, selected + 1);
        else if (state === 'confirm') option = Math.min(options.length - 1, option + 1);
      } else if (data === '\r') {
        if (state === 'list' && selected < items.length) {
          state = 'confirm';
          options = optionsFor(selected);
          option = 0;
        } else if (state === 'confirm' && options[option]?.startsWith('Restore')) {
          result.restoredWith = options[option];
          result.restoredIndex = selected;
          editor = items[selected].text.split('\n')[0];
          state = 'prompt';
        }
      } else if (data === '\x03') {
        if (state === 'prompt') editor = '';
      }
      return true;
    },
    async screen() {
      if (tearNext) {
        tearNext = false;
        return render(false);
      }
      return render(true);
    },
    async wait(ms) {
      clock += ms;
    },
    now: () => (clock += 1),
  };
  return { io, writes, result, state: () => state, editor: () => editor };
}

const FAST = { keyGapMs: 0, stepTimeoutMs: 300, pollMs: 1 };
const ITEMS = [
  { text: 'Crea un archivo nota.txt con el texto uno.', code: 'nota.txt +1' },
  { text: 'Responde solo con la palabra dos', code: 'No code changes' },
];
const request = (over = {}) => ({ firstLine: 'Crea un archivo nota.txt con el texto uno.', occurrence: 1, maxSteps: 10, restoreCode: true, ...over });
{
  const cli = fakeCli({ items: ITEMS });
  const outcome = await rewindMenu.runRewind(cli.io, request(), FAST);
  check('D5 conversacion y codigo: llega al mensaje, elige la opcion por su nombre y vacia la caja',
    outcome.kind === 'done' && outcome.codeRestored && outcome.editorCleared &&
      cli.result.restoredWith === 'Restore code and conversation' && cli.result.restoredIndex === 0 && cli.editor() === '',
    json({ outcome, result: cli.result }));
}
{
  const cli = fakeCli({ items: ITEMS });
  const outcome = await rewindMenu.runRewind(cli.io, request({ restoreCode: false }), FAST);
  check('D6 solo la conversacion: baja una opcion y elige "Restore conversation"',
    outcome.kind === 'done' && !outcome.codeRestored && cli.result.restoredWith === 'Restore conversation', json(cli.result));
}
{
  const cli = fakeCli({ items: ITEMS });
  const outcome = await rewindMenu.runRewind(cli.io, request({ firstLine: 'Responde solo con la palabra dos' }), FAST);
  check('D7 conversacion y codigo sin cambios de codigo: la CLI no lo ofrece, se elige la conversacion y se dice',
    outcome.kind === 'done' && outcome.codeRestored === false && cli.result.restoredWith === 'Restore conversation' && cli.result.restoredIndex === 1,
    json({ outcome, result: cli.result }));
}
{
  const items = [
    { text: 'sigue', code: 'No code changes' },
    { text: 'otra cosa', code: 'No code changes' },
    { text: 'sigue', code: 'No code changes' },
  ];
  const cli = fakeCli({ items });
  const outcome = await rewindMenu.runRewind(cli.io, request({ firstLine: 'sigue', occurrence: 2 }), FAST);
  check('D8 dos mensajes iguales: el segundo contando desde abajo', outcome.kind === 'done' && cli.result.restoredIndex === 0, json(cli.result));
}
{
  const cli = fakeCli({ items: ITEMS });
  const outcome = await rewindMenu.runRewind(cli.io, request({ firstLine: 'Un mensaje que no esta' }), FAST);
  check('D9 no lo encuentra: cierra el menu sin elegir nada',
    outcome.kind === 'failed' && outcome.reason === 'message-not-found' && cli.result.restoredWith === null && cli.state() === 'prompt',
    json({ outcome, state: cli.state() }));
}
{
  const cli = fakeCli({ items: ITEMS, opens: false });
  const outcome = await rewindMenu.runRewind(cli.io, request(), FAST);
  check('D10 el menu no se abre: no se escribe nada mas que el Esc Esc',
    outcome.kind === 'failed' && outcome.reason === 'menu-not-open' && same(cli.writes, ['\x1b', '\x1b']), json(cli.writes));
}
{
  const cli = fakeCli({ items: ITEMS, quote: 'Otro mensaje cualquiera' });
  const outcome = await rewindMenu.runRewind(cli.io, request(), FAST);
  check('D11 la confirmacion cita otro mensaje: se cierra sin confirmar',
    outcome.kind === 'failed' && cli.result.restoredWith === null && cli.state() === 'prompt', json({ outcome, state: cli.state() }));
}
{
  const cli = fakeCli({ items: ITEMS, torn: true });
  const outcome = await rewindMenu.runRewind(cli.io, request({ restoreCode: false }), FAST);
  check('D12 con redibujos a medias despues de cada tecla, elige igual el mensaje y la opcion correctos',
    outcome.kind === 'done' && cli.result.restoredWith === 'Restore conversation' && cli.result.restoredIndex === 0, json({ outcome, result: cli.result }));
}
{
  const items = [{ text: 'Necesito que revises esto:\n1. uno\n2. dos', code: 'No code changes' }];
  const cli = fakeCli({ items });
  const outcome = await rewindMenu.runRewind(cli.io, request({ firstLine: 'Necesito que revises esto:' }), FAST);
  check('D13 un mensaje de varias lineas se encuentra por su primera linea', outcome.kind === 'done' && cli.result.restoredIndex === 0);
}

// --- E. La pantalla emulada --------------------------------------------------

{
  const screen = createPtyScreen(60, 6, '\x1b[2J\x1b[2;4H\u276f\x1b[1Chola\x1b[3;4HRestore\x1b[1Cthe\x1b[1Ccode');
  const lines = await screen.lines();
  screen.feed('\x1b[2;4H \x1b[3;4H\u276f');
  const after = await screen.lines();
  screen.dispose();
  check('E1 el cursor movido con ESC[nC se lee como espacio', lines[1] === '   \u276f hola' && lines[2] === '   Restore the code', json(lines));
  check('E2 lo que llega despues se aplica antes de leer', after[2].startsWith('   \u276f'), json(after));
}

// --- F. Lo que se le pide al menu, del hilo ----------------------------------

{
  const event = (eventId, role, parts) => ({ eventId, role, at: 0, parts, model: null, usage: null, effort: null, durationMs: null, queued: false });
  const text = (value, truncated = false) => ({ kind: 'text', text: value, truncated });
  const events = [
    event('u1', 'user', [text('sigue')]),
    event('a1', 'assistant', [text('ok')]),
    event('u2', 'user', [text('Haz esto:\nlinea dos', true)]),
    event('r1', 'user', [{ kind: 'tool-result', toolUseId: 't', text: 'x', isError: false, truncated: false, imageCount: 0 }]),
    event('u3', 'user', [text('sigue')]),
  ];
  const target = rewindTargetFrom(events, 'u1');
  check('F1 la primera linea, cuantas iguales hay hasta el final y cuantos mensajes',
    target !== null && target.firstLine === 'sigue' && target.occurrence === 2 && target.promptsFromHere === 3, json(target));
  const long = rewindTargetFrom(events, 'u2');
  check('F2 un texto recortado se marca, para leerlo entero', long?.truncated === true && long.firstLine === 'Haz esto:', json(long));
  check('F3 un resultado de herramienta no es un mensaje', rewindTargetFrom(events, 'r1') === null && rewindTargetFrom(events, 'a1') === null);
  check('F4 la web ofrece volver solo en los mensajes del usuario',
    rewindUi.isPromptEvent(events[0]) && !rewindUi.isPromptEvent(events[1]) && !rewindUi.isPromptEvent(events[3]));
  const calls = [
    event('c1', 'assistant', [{ kind: 'tool-call', toolUseId: '1', name: 'Write', input: JSON.stringify({ file_path: 'D:\\Mi App\\src\\a.ts', content: 'x' }), truncated: false }]),
    event('c2', 'assistant', [{ kind: 'tool-call', toolUseId: '2', name: 'Edit', input: '{"file_path":"D:\\\\Mi App\\\\notas.md","old_string":"muy larg', truncated: true }]),
    event('c3', 'assistant', [{ kind: 'tool-call', toolUseId: '3', name: 'Read', input: JSON.stringify({ file_path: 'D:\\Mi App\\leido.md' }), truncated: false }]),
    event('c4', 'assistant', [{ kind: 'tool-call', toolUseId: '4', name: 'Write', input: JSON.stringify({ file_path: 'D:\\Mi App\\src\\a.ts', content: 'y' }), truncated: false }]),
    event('c5', 'assistant', [{ kind: 'tool-call', toolUseId: '5', name: 'Edit', input: JSON.stringify({ file_path: 'C:\\fuera\\b.ts' }), truncated: false }]),
  ];
  const files = rewindUi.changedFilesAfter([...events.slice(0, 1), ...calls], 'u1', 'D:\\Mi App');
  check('F5 los archivos tocados desde ahi: relativos al proyecto, sin repetir, sin los leidos, y aunque la entrada llegue recortada',
    same(files, ['src\\a.ts', 'notas.md', 'C:\\fuera\\b.ts']), json(files));
  check('F6 la cita del dialogo: las primeras lineas, con \u2026 si sigue',
    rewindUi.rewindPreview(event('p', 'user', [text('a\nb\nc')]), 2) === 'a\nb\u2026' && rewindUi.rewindPreview(event('p', 'user', [text('corto')])) === 'corto');
}

// --- G. El hub: lo escondido sobrevive a dejar de mirar ----------------------

{
  const cwd = path.join(root, 'proyecto');
  await mkdir(cwd, { recursive: true });
  const sessionId = '3b1f6c2e-0000-4000-8000-000000000044';
  const file = sessionFilePath(cwd, sessionId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jsonl([user('p1', null, 'hola'), assistant('a1', 'p1', 'que tal'), turnEnd('d1', 'a1'), user('x', 'd1', 'me equivoque')]));

  const variants = new ModelVariantRegistry();
  const adapter = {
    id: 'claude-code',
    capabilities: { ...shared.NO_CAPABILITIES, sessionIdAtLaunch: true, rewind: true },
    status: null,
    history: { follow: (target) => new ClaudeCodeSessionFollower(target.cwd, target.sessionId, variants), plans: null, followPollMs: null },
  };
  const agents = { get: (id) => (id === 'claude-code' ? { adapter, location: null } : null) };
  const registry = new EventEmitter();
  registry.get = (terminalId) =>
    terminalId === 't'
      ? { terminalId: 't', kind: 'agent', agent: 'claude-code', cwd, sessionId, label: '', resumed: false, createdAt: 0, alive: true, exitCode: null, sleeping: false }
      : null;
  registry.launchedAtOf = () => T0;
  const hub = new ConversationHub(registry, agents);
  const resets = [];
  hub.on('reset', (terminalId) => resets.push(terminalId));

  const ids = (snapshot) => snapshot.events.map((event) => event.eventId);
  const first = await hub.subscribe('t');
  check('G1 antes de retirar, el hilo tiene el mensaje', ids(first).includes('x'), json(ids(first)));
  const target = hub.rewindTarget('t', 'p1');
  check('G2 lo que el menu necesita sale del hilo', target?.firstLine === 'hola' && target.occurrence === 1 && target.promptsFromHere === 2, json(target));
  hub.withdraw('t', 'x');
  check('G3 retirar avisa un reinicio y el hilo deja de tenerlo', same(resets, ['t']) && !ids(hub.getSnapshot('t')).includes('x'));
  hub.unsubscribe('t');
  const again = await hub.subscribe('t');
  check('G4 se dejo de mirar y se volvio: sigue escondido', !ids(again).includes('x'), json(ids(again)));
  await appendFile(file, jsonl([user('y', 'd1', 'ahora si'), assistant('a2', 'y', 'bien')]));
  hub.onHistoryChanged('claude-code', file);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const after = hub.getSnapshot('t');
  check('G5 la CLI escribe el corregido: queda el, y el retirado sigue afuera', same(ids(after), ['p1', 'a1', 'y', 'a2']), json(ids(after)));
  hub.unsubscribe('t');
  const fresh = await hub.subscribe('t');
  check('G6 con la rama nueva escrita, volver a mirar no esconde nada de mas', same(ids(fresh), ['p1', 'a1', 'y', 'a2']), json(ids(fresh)));

  // El mensaje se escondio antes de que el seguidor lo leyera: queda pendiente y se aplica al leerlo.
  const resetsBefore = resets.length;
  await appendFile(file, jsonl([user('z', 'a2', 'otro equivocado', 20)]));
  hub.withdraw('t', 'z');
  await new Promise((resolve) => setTimeout(resolve, 400));
  const late = hub.getSnapshot('t');
  check('G7 retirar un mensaje que el seguidor todavia no leyo: lo esconde en cuanto lo lee',
    !ids(late).includes('z') && resets.length > resetsBefore, json({ ids: ids(late), resets: resets.length - resetsBefore }));
  hub.disposeAll();
}

// --- H. La lista que sigue sola -----------------------------------------------

{
  const press = (value, caret = value.length) => {
    const change = continueList(value, caret, caret);
    if (change === null) return null;
    return { value: value.slice(0, change.from) + change.text + value.slice(change.to), caret: change.caret };
  };
  check('H1 1. sigue con 2.', same(press('1. primero'), { value: '1. primero\n2. ', caret: 14 }));
  check('H2 con parentesis', press('3) tercero')?.value === '3) tercero\n4) ');
  check('H3 letras con parentesis, en minuscula y en mayuscula', press('a) uno')?.value === 'a) uno\nb) ' && press('C) tres')?.value === 'C) tres\nD) ');
  check('H4 despues de la z no sigue', press('z) ultima') === null);
  check('H5 viñetas - y *, con su sangria', press('  - uno')?.value === '  - uno\n  - ' && press('* dos')?.value === '* dos\n* ');
  check('H6 un item vacio termina la lista', same(press('1. uno\n2. '), { value: '1. uno\n', caret: 7 }));
  check('H7 sin lista, el salto de siempre', press('hola') === null);
  check('H8 un año o un decimal no son listas', press('2024. fue un buen año') === null && press('1.5 litros') === null);
  check('H9 letras con punto no (A. Perez)', press('A. Perez') === null);
  check('H10 el cursor dentro del marcador: el salto de siempre', press('12. algo', 1) === null);
  check('H11 con texto seleccionado: el salto de siempre', continueList('1. hola', 3, 5) === null);
  check('H12 en medio del texto lo parte en dos items', press('1. hola mundo', 7)?.value === '1. hola\n2.  mundo');
  check('H13 renumera los que siguen', press('1. uno\n2. dos\n3. tres', 6)?.value === '1. uno\n2. \n3. dos\n4. tres');
  check('H14 no renumera otra lista ni otra sangria',
    press('1. uno\n  1. sub\n2. dos', 6)?.value === '1. uno\n2. \n  1. sub\n2. dos');
}

console.log(failures === 0 ? '\nTODO OK' : `\n${failures} FALLO(S)`);
process.exit(failures === 0 ? 0 : 1);
