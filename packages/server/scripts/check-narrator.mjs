/**
 * Chequeo del narrador (hito 57, §6.40).
 *
 *   npx tsx scripts/check-narrator.mjs
 *
 * Lo que se rompe en silencio:
 *
 *  1. Qué se dice: sólo el texto del agente y sus preguntas; nada de
 *     herramientas, resultados, razonamiento ni usuario. Y cómo: sin marcas de
 *     Markdown, los bloques de código y las tablas anunciados y saltados, las
 *     URL por "un enlace", las rutas por su nombre de archivo, una fecha intacta.
 *  2. Retomar tras un `reset` sin repetir, avisando el hueco, y sin leer el
 *     historial al encender.
 *  3. La fila: Saltar sólo el mensaje que suena, Callar todo, devolver un trozo.
 *  4. La voz: sólo locales, el orden por idioma (la predeterminada si es del
 *     idioma, la región del navegador, otra región), nunca otro idioma callado,
 *     y los pasos según el sistema.
 *  5. Una sola pestaña narrada en el servidor, que se va al cerrarla; el
 *     protocolo con el id de ventana validado.
 *  6. El registro de suscripciones que comparten el hilo y el narrador: la
 *     misma pestaña sin pisarse, y una sola suscripción tras reconectar.
 *  7. El cableado, contra el fuente: el socket, el hilo, el hook y la app.
 *
 * No lanza ninguna CLI ni abre un navegador: importa los módulos puros.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  NARRATOR_WINDOW_ID_PATTERN,
  parseClientMessage,
  parseServerMessage,
} from '../../shared/src/index.ts';
import { NarratorState } from '../src/narrator-state.ts';
import {
  MAX_CHUNK_CHARS,
  NarratorQueue,
  narratorMessages,
  planReset,
  speechChunks,
  speechText,
} from '../../web/src/narrator-text.ts';
import {
  DEFAULT_RATE,
  MAX_RATE,
  MIN_RATE,
  clampRate,
  newWindowId,
  parseStoredRate,
  parseStoredVoice,
  pickVoice,
  voiceOptions,
  voicePlatform,
  wantedTag,
} from '../../web/src/narrator-voices.ts';
import { ConversationSubscriptions } from '../../web/src/conversation-subscriptions.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (relative) => readFileSync(path.join(here, relative), 'utf8');

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);

const PHRASES = { codeBlock: 'Sigue un bloque de código.', table: 'Sigue una tabla.', link: 'un enlace' };
const say = (markdown) => speechText(markdown, PHRASES);

const event = (eventId, role, parts) => ({
  eventId,
  role,
  at: 0,
  parts,
  model: null,
  usage: null,
  effort: null,
  durationMs: null,
  queued: false,
});
const text = (value) => ({ kind: 'text', text: value, truncated: false });

// --- 1. Qué se dice, y cómo ------------------------------------------------------
{
  const events = [
    event('u1', 'user', [text('Hazme el build')]),
    event('a1', 'assistant', [{ kind: 'thinking' }, text('Estoy dejando anotado el build.')]),
    event('a2', 'assistant', [{ kind: 'tool-call', toolUseId: 't1', name: 'Read', input: '{}', truncated: false }]),
    event('u2', 'user', [{ kind: 'tool-result', toolUseId: 't1', text: 'contenido', isError: false, truncated: false, imageCount: 0 }]),
    event('a3', 'assistant', [{ kind: 'notice', notice: 'interrupted', detail: '' }, text('Ahora agrego la línea del índice.')]),
  ];
  const messages = narratorMessages(events, PHRASES);
  check('1.1 sólo el texto del agente, en orden',
    json(messages.map((m) => m.chunks.join(' '))) === json(['Estoy dejando anotado el build.', 'Ahora agrego la línea del índice.']),
    json(messages));
  check('1.2 nada del usuario, de herramientas, de resultados, del razonamiento ni de los avisos',
    !json(messages).includes('Hazme') && !json(messages).includes('contenido') && !json(messages).includes('Read') && !json(messages).includes('Interrumpido'));
  check('1.3 cada mensaje se nombra por su evento y su parte (Saltar salta ese)',
    json(messages.map((m) => m.messageId)) === json(['a1#1', 'a3#1']));

  const question = narratorMessages([event('q1', 'assistant', [{
    kind: 'question',
    toolUseId: 'q',
    questions: [{ question: '¿Libero el **permiso** de red?', header: 'Red', multiSelect: false, options: [{ label: 'Sí', description: '' }, { label: 'No', description: '' }] }],
  }])], PHRASES);
  check('1.4 una pregunta se dice con sus opciones, sin marcas',
    question.length === 1 && question[0].chunks.join(' ') === '¿Libero el permiso de red? Sí, No.', json(question));

  check('1.5 negritas, títulos y viñetas sin marcas, una oración por línea',
    say('## Lo que verifiqué:\n- **Descarga** lista\n- El *AAB* firmado') === 'Lo que verifiqué: Descarga lista. El AAB firmado.',
    say('## Lo que verifiqué:\n- **Descarga** lista\n- El *AAB* firmado'));
  check('1.6 un bloque de código se anuncia y se salta entero',
    say('Antes.\n```ts\nconst x = 1;\n```\nDespués.') === 'Antes. Sigue un bloque de código. Después.',
    say('Antes.\n```ts\nconst x = 1;\n```\nDespués.'));
  check('1.7 una tabla se anuncia una vez y se salta',
    say('Tabla:\n| a | b |\n|---|---|\n| 1 | 2 |\nFin.') === 'Tabla: Sigue una tabla. Fin.',
    say('Tabla:\n| a | b |\n|---|---|\n| 1 | 2 |\nFin.'));
  check('1.8 un enlace con texto se dice por su texto',
    say('**Descarga:** [el AAB](https://expo.dev/artifacts/eas/x.aab) (vence el 07-12-2026).') === 'Descarga: el AAB (vence el 07-12-2026).',
    say('**Descarga:** [el AAB](https://expo.dev/artifacts/eas/x.aab) (vence el 07-12-2026).'));
  check('1.9 una URL suelta es "un enlace"',
    say('Descarga: https://expo.dev/artifacts/eas/NHhhLOStFmoaIwcUDLkl.aab (vence)') === 'Descarga: un enlace (vence)',
    say('Descarga: https://expo.dev/artifacts/eas/NHhhLOStFmoaIwcUDLkl.aab (vence)'));
  check('1.10 una ruta de Windows, por su nombre de archivo',
    say('Copia en `C:\\Users\\alguien\\AppData\\Local\\Temp\\aab-1.6.0\\dictamd-1.6.0-9.aab`') === 'Copia en dictamd-1.6.0-9.aab.',
    say('Copia en `C:\\Users\\alguien\\AppData\\Local\\Temp\\aab-1.6.0\\dictamd-1.6.0-9.aab`'));
  check('1.11 una ruta con barras, por su nombre; código en línea corto, tal cual',
    say('Cambié `packages/web/src/App.tsx` del commit `36f7512`.') === 'Cambié App.tsx del commit 36f7512.',
    say('Cambié `packages/web/src/App.tsx` del commit `36f7512`.'));
  check('1.12 una fecha, una fracción y "y/o" no son rutas',
    say('El 16/11/2026, 3/4 de los casos y/o más.') === 'El 16/11/2026, 3/4 de los casos y/o más.',
    say('El 16/11/2026, 3/4 de los casos y/o más.'));
  check('1.13 un identificador con guiones bajos no pierde los guiones',
    say('La variable snake_case_name queda.') === 'La variable snake_case_name queda.');
  check('1.14 un mensaje vacío o sólo de código no deja trozos vacíos',
    speechChunks(say('')).length === 0 && narratorMessages([event('a', 'assistant', [text('   ')])], PHRASES).length === 0);

  const long = Array.from({ length: 40 }, (_, i) => `Oración número ${i} con algo de texto`).join('. ') + '.';
  const chunks = speechChunks(long);
  check('1.15 un mensaje largo se parte en trozos que no pasan el tope',
    chunks.length > 1 && chunks.every((chunk) => chunk.length <= MAX_CHUNK_CHARS), json(chunks.map((c) => c.length)));
  check('1.16 partir no pierde palabras', chunks.join(' ') === long);
  const run = 'palabra '.repeat(80).trim();
  check('1.17 una oración sin puntos más larga que el tope también se parte',
    speechChunks(run).every((chunk) => chunk.length <= MAX_CHUNK_CHARS) && speechChunks(run).join(' ') === run);
}

// --- 2. Retomar tras un reset ---------------------------------------------------
{
  const tail = [event('e1', 'assistant', [text('uno')]), event('e2', 'user', [text('dos')]), event('e3', 'assistant', [text('tres')]), event('e4', 'assistant', [text('cuatro')])];
  check('2.1 sin nada visto, el tramo es historial: no se lee',
    json(planReset(tail, null, new Set())) === json({ fresh: [], gap: false }));
  const resumed = planReset(tail, 'e2', new Set(['e1', 'e2']));
  check('2.2 con el último visto en el tramo, se lee lo que sigue',
    json(resumed.fresh.map((e) => e.eventId)) === json(['e3', 'e4']) && !resumed.gap);
  const crossed = planReset(tail, 'e2', new Set(['e1', 'e2', 'e3']));
  check('2.3 lo que ya llegó por append no se repite',
    json(crossed.fresh.map((e) => e.eventId)) === json(['e4']));
  const gap = planReset(tail, 'e0', new Set(['e0']));
  check('2.4 el último visto fuera del tramo: hueco, y sólo el último mensaje del agente',
    gap.gap && json(gap.fresh.map((e) => e.eventId)) === json(['e4']), json(gap));
  check('2.5 un tramo todo visto (el del hilo al mirarla) no es hueco ni lee nada',
    json(planReset(tail, 'e9', new Set(['e1', 'e2', 'e3', 'e4']))) === json({ fresh: [], gap: false }));
}

// --- 3. La fila -------------------------------------------------------------------
{
  const queue = new NarratorQueue();
  queue.push({ messageId: 'a', chunks: ['a1', 'a2', 'a3'] });
  queue.push({ messageId: 'b', chunks: ['b1'] });
  check('3.1 cuenta mensajes, no trozos', queue.pendingMessages() === 2 && queue.size === 4);
  const first = queue.next();
  queue.dropMessage(first.messageId);
  check('3.2 Saltar descarta lo que queda de ese mensaje y deja el siguiente',
    json(queue.next()) === json({ messageId: 'b', text: 'b1' }) && queue.size === 0);
  queue.push({ messageId: 'c', chunks: ['c1', 'c2'] });
  const c1 = queue.next();
  queue.requeue(c1);
  check('3.3 un trozo que no se dijo vuelve al frente', json(queue.next()) === json(c1));
  queue.clear();
  check('3.4 Callar vacía la fila', queue.size === 0 && queue.next() === null);
}

// --- 4. La voz --------------------------------------------------------------------
{
  const v = (name, lang, extra = {}) => ({ voiceURI: name, name, lang, localService: true, default: false, ...extra });
  // Lo medido en esta PC el 16-11-2026: David por defecto, en inglés, con el español instalado.
  const pc = [v('David', 'en-US', { default: true }), v('Mark', 'en-US'), v('Zira', 'en-US'), v('Raul', 'es-MX'), v('Sabina', 'es-MX'),
    v('Google español', 'es-ES', { localService: false })];
  const pick = (voices, uiLocale, browserLanguages = [], saved = null) => pickVoice(voices, { saved, uiLocale, browserLanguages });

  const es = pick(pc, 'es', ['es-419', 'es']);
  check('4.1 la predeterminada de otro idioma no se usa: con la interfaz en español, una voz de español',
    es.kind === 'voice' && es.voice.lang === 'es-MX', json(es));
  check('4.2 una voz en línea no se elige nunca', pick([v('Google español', 'es-ES', { localService: false })], 'es').kind === 'missing');
  const en = pick(pc, 'en', ['en-US']);
  check('4.3 la predeterminada del sistema, si es del idioma del usuario', en.kind === 'voice' && en.voice.name === 'David');
  const fr = pick([v('Hortense', 'fr-FR'), v('Julie', 'fr-CA'), v('David', 'en-US', { default: true })], 'fr', ['fr-CA', 'en']);
  check('4.4 la región que pide el navegador gana a otra del mismo idioma', fr.kind === 'voice' && fr.voice.name === 'Julie', json(fr));
  const frDefault = pick([v('Hortense', 'fr-FR', { default: true }), v('Julie', 'fr-CA')], 'fr', ['fr-CA']);
  check('4.5 la predeterminada del idioma gana a la región', frDefault.kind === 'voice' && frDefault.voice.name === 'Hortense');
  const ptOther = pick([v('Joana', 'pt-PT')], 'pt-BR', ['pt-BR']);
  check('4.6 sin la región, otra del mismo idioma', ptOther.kind === 'voice' && ptOther.voice.name === 'Joana');
  const missing = pick(pc, 'ja', ['ja']);
  check('4.7 sin voz del idioma: falta, con la predeterminada local para usar igual',
    missing.kind === 'missing' && missing.fallback?.name === 'David', json(missing));
  check('4.8 sin ninguna voz local: falta y no hay a cuál caer',
    json(pick([v('Google', 'en-US', { localService: false })], 'en')) === json({ kind: 'missing', fallback: null }));
  check('4.9 la elegida en Ajustes gana, aunque sea de otro idioma', pick(pc, 'es', [], 'Zira').voice?.name === 'Zira');
  check('4.10 una elegida que ya no está se ignora', pick(pc, 'es', [], 'Borrada').voice?.lang === 'es-MX');
  check('4.11 una elegida en línea no se usa', pick(pc, 'es', [], 'Google español').voice?.localService === true);
  check('4.12 la etiqueta buscada: interfaz con la región del navegador',
    wantedTag('es', ['en-US', 'es-AR']) === 'es-ar' && wantedTag('pt-BR', ['en']) === 'pt-br' && wantedTag('zh-CN', ['zh_TW']) === 'zh-tw');
  check('4.13 el selector: sólo locales, las del idioma primero',
    json(voiceOptions(pc, 'es').map((x) => x.name)) === json(['Raul', 'Sabina', 'David', 'Mark', 'Zira']));
  check('4.14 el sistema para los pasos',
    voicePlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') === 'windows' &&
    voicePlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)') === 'mac' &&
    voicePlatform('Mozilla/5.0 (X11; Linux x86_64)') === 'linux' &&
    voicePlatform('Mozilla/5.0 (Linux; Android 15)') === 'other');
  check('4.15 la velocidad guardada: dentro del rango y al paso',
    parseStoredRate('1.25') === 1.3 && parseStoredRate('9') === null && parseStoredRate('x') === null &&
    clampRate(0.1) === MIN_RATE && clampRate(5) === MAX_RATE && DEFAULT_RATE === 1);
  check('4.16 una voz guardada vacía es "automática"', parseStoredVoice('') === null && parseStoredVoice(' Sabina ') === 'Sabina');
}

// --- 5. El servidor y el protocolo -----------------------------------------------
{
  const exists = (id) => id === 't1' || id === 't2';
  const state = new NarratorState();
  check('5.1 arranca apagado', state.current() === null);
  check('5.2 encender cambia', state.set({ terminalId: 't1', windowId: 'ventanaA1' }, exists) && state.current()?.terminalId === 't1');
  check('5.3 lo mismo otra vez no cambia (no se avisa a nadie)', !state.set({ terminalId: 't1', windowId: 'ventanaA1' }, exists));
  check('5.4 otra pestaña reemplaza a la anterior: una sola en toda la app',
    state.set({ terminalId: 't2', windowId: 'ventanaA1' }, exists) && state.current()?.terminalId === 't2');
  check('5.5 otra ventana se la lleva', state.set({ terminalId: 't2', windowId: 'ventanaB1' }, exists) && state.current()?.windowId === 'ventanaB1');
  check('5.6 una pestaña que no existe no cambia nada',
    !state.set({ terminalId: 'nada', windowId: 'ventanaA1' }, exists) && state.current()?.terminalId === 't2');
  check('5.7 cerrar otra pestaña no lo apaga', !state.dropTerminal('t1') && state.current() !== null);
  check('5.8 cerrar la narrada lo apaga', state.dropTerminal('t2') && state.current() === null);
  check('5.9 apagar lo apagado no cambia', !state.set(null, exists));

  const ok = parseClientMessage(json({ type: 'narrator.set', narrator: { terminalId: 't1', windowId: 'abcDEF12_-' } }));
  check('5.10 narrator.set se lee', json(ok) === json({ type: 'narrator.set', narrator: { terminalId: 't1', windowId: 'abcDEF12_-' } }));
  check('5.11 apagar es null', json(parseClientMessage(json({ type: 'narrator.set', narrator: null }))) === json({ type: 'narrator.set', narrator: null }));
  check('5.12 un id de ventana mal formado descarta el mensaje',
    parseClientMessage(json({ type: 'narrator.set', narrator: { terminalId: 't1', windowId: 'corto' } })) === null &&
    parseClientMessage(json({ type: 'narrator.set', narrator: { terminalId: 't1', windowId: 'con espacio y más' } })) === null &&
    parseClientMessage(json({ type: 'narrator.set', narrator: { windowId: 'abcDEF12' } })) === null &&
    parseClientMessage(json({ type: 'narrator.set' })) === null);
  check('5.13 narrator.state se lee, y con null',
    json(parseServerMessage(json({ type: 'narrator.state', narrator: { terminalId: 't1', windowId: 'abcDEF12' } }))) ===
      json({ type: 'narrator.state', narrator: { terminalId: 't1', windowId: 'abcDEF12' } }) &&
    json(parseServerMessage(json({ type: 'narrator.state', narrator: null }))) === json({ type: 'narrator.state', narrator: null }));
  let bytes = 0;
  const windowId = newWindowId((array) => array.map(() => bytes++ * 7));
  check('5.14 el id que genera la web cumple la forma del protocolo', NARRATOR_WINDOW_ID_PATTERN.test(windowId) && windowId.length === 16, windowId);
}

// --- 6. El registro de suscripciones ---------------------------------------------
{
  const sent = [];
  let reopen = () => {};
  const subs = new ConversationSubscriptions({ send: (m) => sent.push(`${m.type}:${m.terminalId}`), onReopen: (h) => { reopen = h; return () => {}; } });

  // El hilo mira t1; el narrador enciende t1 (la misma): no se pide el tramo otra vez.
  const thread1 = subs.acquire('t1', { needsSnapshot: true });
  const narr = subs.acquire('t1', { needsSnapshot: false });
  check('6.1 el narrador sobre la pestaña que el hilo ya sigue no la rehace (no le borra al hilo lo cargado)',
    json(sent) === json(['conversation.subscribe:t1']), json(sent));
  // El usuario pasa a t2: el hilo suelta t1, pero el narrador la sigue.
  thread1();
  const thread2 = subs.acquire('t2', { needsSnapshot: true });
  check('6.2 cambiar de pestaña no apaga la narrada', !sent.includes('conversation.unsubscribe:t1') && subs.holders('t1') === 1);
  // Vuelve a t1: el hilo necesita su tramo, aunque el narrador ya esté suscrito.
  sent.length = 0;
  thread2();
  const thread1b = subs.acquire('t1', { needsSnapshot: true });
  check('6.3 el hilo que vuelve a la narrada pide su tramo', json(sent) === json(['conversation.unsubscribe:t2', 'conversation.subscribe:t1']), json(sent));
  // Tras una reconexión, una sola suscripción por pestaña.
  sent.length = 0;
  reopen();
  check('6.4 al reconectar, una sola por pestaña seguida', json(sent) === json(['conversation.subscribe:t1']), json(sent));
  narr();
  narr();
  check('6.5 soltar dos veces no descuenta dos', subs.holders('t1') === 1 && !sent.includes('conversation.unsubscribe:t1'));
  thread1b();
  check('6.6 el último que la suelta la apaga', sent[sent.length - 1] === 'conversation.unsubscribe:t1' && subs.holders('t1') === 0);
}

// --- 7. El cableado, contra el fuente ---------------------------------------------
{
  const socket = read('../src/terminal-socket.ts');
  check('7.1 el socket atiende narrator.set y avisa a todas sólo si cambió',
    /case 'narrator\.set':\s*if \(narrator\.set\(message\.narrator, \(terminalId\) => registry\.get\(terminalId\) !== undefined\)\) \{\s*broadcast\(\{ type: 'narrator\.state', narrator: narrator\.current\(\) \}\);/.test(socket));
  check('7.2 al conectar se manda el estado, aunque esté apagado',
    /send\(socket, \{ type: 'narrator\.state', narrator: narrator\.current\(\) \}\);\s*\/\/ Los mensajes programados/.test(socket));
  check('7.3 cerrar la pestaña narrada lo apaga en todas las ventanas',
    /if \(narrator\.dropTerminal\(terminalId\)\) broadcast\(\{ type: 'narrator\.state', narrator: null \}\);/.test(socket));

  const conversation = read('../../web/src/useConversation.ts');
  check('7.4 el hilo se suscribe por el registro, pidiendo su tramo, y no por su cuenta',
    /conversationSubscriptions\(connection\)\.acquire\(terminalId, \{ needsSnapshot: true \}\)/.test(conversation) &&
    !/type: 'conversation\.(un)?subscribe'/.test(conversation));

  const hook = read('../../web/src/useNarrator.ts');
  check('7.5 el narrador se suscribe por el registro, y pide el tramo sólo al retomar',
    /conversationSubscriptions\(connection\)\.acquire\(terminalId, \{ needsSnapshot: resumed !== null \}\)/.test(hook));
  check('7.6 sólo la ventana dueña sigue la pestaña narrada',
    /const ownedTerminal = isOwner \? holder\.terminalId : null;/.test(hook) && /if \(ownedTerminal === null\) return;\s*const terminalId = ownedTerminal;/.test(hook));
  check('7.7 al encender, lo que el hilo ya muestra cuenta como visto (no se lee el historial)',
    /seenRef\.current = new Set\(events\.map\(\(event\) => event\.eventId\)\);/.test(hook) &&
    /const fresh = message\.events\.filter\(\(event\) => !seenRef\.current\.has\(event\.eventId\)\);/.test(hook));
  check('7.8 "te espera" sale del mismo cambio que el sonido, sólo de la narrada',
    /if \(chimeFor\(before, next\) === 'attention'\) \{/.test(hook) && /const next = activity\.get\(ownedTerminal\);/.test(hook));
  check('7.9 el hook no habla con la red: sin fetch ni otra conexión',
    !/\bfetch\(|XMLHttpRequest|new WebSocket|sendBeacon/.test(hook) && !/\bfetch\(|XMLHttpRequest|new WebSocket/.test(read('../../web/src/narrator-voices.ts')));
  check('7.10 fuera de la app del teléfono: ahí no se midió la voz del WebView',
    /speechAvailable\(\) && !insidePhoneApp\(navigator\.userAgent\)/.test(hook));

  const app = read('../../web/src/App.tsx');
  check('7.11 la app arma el narrador, el botón con los eventos del hilo, el parlante y el aviso',
    /const narrator = useNarrator\(connection, activity, notifyTabs\.nameOf\);/.test(app) &&
    /<NarratorButton\s+narrator=\{narrator\}\s+terminalId=\{activeTerminalId\}\s+events=\{conversation\.events\}/.test(app) &&
    /attention=\{sound\.attention\}\s+narrator=\{narrator\}/.test(app) &&
    /<NarratorVoiceDialog narrator=\{narrator\} \/>/.test(app));
}

if (failures > 0) {
  console.error(`\n${failures} caso(s) fallaron`);
  process.exit(1);
}
console.log('\nTodo OK');
