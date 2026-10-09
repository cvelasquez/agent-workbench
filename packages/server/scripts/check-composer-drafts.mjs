/**
 * Chequeo del borrador del cuadro de escritura entre arranques (§6.29).
 *
 *   npx tsx scripts/check-composer-drafts.mjs
 *
 * Lo que se rompe en silencio, y solo se nota al dia siguiente:
 *
 *  - **Un mensaje ya mandado que vuelve al cuadro.** El borrador se borra al
 *    mandar, del lado de la pagina y del servidor, y lo que el servidor diga
 *    despues de una reconexion no pisa una pestana que se toco.
 *  - **Dos instancias que se pisan el archivo** (§14.8): guardar relee y
 *    cambia solo lo suyo.
 *  - **Un borrador que se pierde al cambiar la conversacion de la pestana**, o
 *    uno que queda para siempre de una pestana que ya no esta.
 *  - **Un servidor anterior contestando cada pausa del teclado con un cartel**:
 *    la pagina no manda nada hasta que el servidor dice que guarda.
 *  - **Una ventana que no se entera de lo que se escribe en otra** (09-10-2026):
 *    el telefono seguia con el texto de cuando se abrio y la laptop sin nada. Y
 *    lo contrario, que no se ve hasta que pasa: lo que llega de otra ventana
 *    pisando lo que se esta escribiendo aca, o un texto mandado por un socket
 *    que se cayo y que la reconexion borra.
 *
 * Trabaja sobre una carpeta temporal propia, sin tocar la configuracion real.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_COMPOSER_DRAFT_CHARS,
  MAX_COMPOSER_DRAFT_PASTES,
  composerDraftChars,
  isEmptyComposerDraft,
  parseClientMessage,
  parseComposerDraft,
  parseServerMessage,
} from '@agent-workbench/shared';
import { DraftStore, DraftTabs, MAX_STORED_DRAFTS, draftEntriesOf, draftOwnerOf, workspaceDraftOwners } from '../src/draft-store.ts';
import { ComposerDrafts, draftOf, draftTooLong, localDraftOf, viewToRestore } from '../../web/src/composer-drafts.ts';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? 'OK  ' : 'FALLO'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!ok) failures++;
};
const json = (value) => JSON.stringify(value);

const dir = await mkdtemp(path.join(os.tmpdir(), 'aw-check-drafts-'));
const statePath = path.join(dir, 'composer-drafts.json');

const draft = (text, pasted = []) => ({ text, pasted });
const A = { agent: 'claude-code', sessionId: 'a1b2c3d4-0000-4000-8000-000000000001' };
const B = { agent: 'codex', sessionId: '0199aaaa-0000-7000-8000-000000000002' };

// --- 1. La forma del borrador ------------------------------------------------
{
  check('un borrador con texto y textos pegados se lee',
    json(parseComposerDraft({ text: 'hola [Pasted text #1]', pasted: [{ number: 1, text: 'log' }] })) ===
      json(draft('hola [Pasted text #1]', [{ number: 1, text: 'log' }])));
  check('sin texto o sin lista de pegados, no',
    parseComposerDraft({ pasted: [] }) === null && parseComposerDraft({ text: 'x' }) === null && parseComposerDraft('x') === null);
  check('el número de un pegado es un entero de 1 a 999999',
    [0, -1, 1.5, 1_000_000, '1', null].every((number) => parseComposerDraft({ text: '', pasted: [{ number, text: 'x' }] }) === null) &&
    parseComposerDraft({ text: '', pasted: [{ number: 999_999, text: 'x' }] }) !== null);
  check('dos pegados con el mismo número no son un borrador: sus marcas serían la misma',
    parseComposerDraft({ text: '', pasted: [{ number: 1, text: 'a' }, { number: 1, text: 'b' }] }) === null);
  const many = Array.from({ length: MAX_COMPOSER_DRAFT_PASTES + 1 }, (_, index) => ({ number: index + 1, text: 'x' }));
  check('ni uno con más pegados que el tope', parseComposerDraft({ text: '', pasted: many }) === null);
  check('vacío es sin texto con algo más que espacios y sin pegados con algo adentro',
    isEmptyComposerDraft(draft('  \n ', [{ number: 1, text: ' ' }])) && !isEmptyComposerDraft(draft('', [{ number: 1, text: 'x' }])) &&
    !isEmptyComposerDraft(draft('x')));
  check('el peso cuenta lo escrito y lo pegado', composerDraftChars(draft('abc', [{ number: 1, text: 'de' }])) === 5);
}

// --- 2. El protocolo ----------------------------------------------------------
{
  const message = parseClientMessage(json({ type: 'composer.draft', terminalId: 't1', draft: draft('hola') }));
  check('composer.draft se lee', json(message) === json({ type: 'composer.draft', terminalId: 't1', draft: draft('hola') }));
  check('sin pestaña o con un borrador mal formado, no',
    parseClientMessage(json({ type: 'composer.draft', draft: draft('x') })) === null &&
    parseClientMessage(json({ type: 'composer.draft', terminalId: 't1', draft: { text: 1, pasted: [] } })) === null);
  const drafts = parseServerMessage(json({
    type: 'composer.drafts',
    drafts: [{ terminalId: 't1', draft: draft('uno') }, { terminalId: 't2', draft: { text: 'dos' } }, { draft: draft('tres') }],
  }));
  check('composer.drafts descarta el mal formado sin llevarse los demás',
    drafts !== null && json(drafts.drafts) === json([{ terminalId: 't1', draft: draft('uno') }]), json(drafts));
  check('una lista vacía también se lee: dice que el servidor guarda',
    json(parseServerMessage(json({ type: 'composer.drafts', drafts: [] }))) === json({ type: 'composer.drafts', drafts: [] }));
  check('y sin lista, no', parseServerMessage(json({ type: 'composer.drafts' })) === null);
}

// --- 3. El almacén: ida y vuelta ------------------------------------------------
{
  let now = 1_000;
  const store = new DraftStore({ statePath, now: () => now });
  await store.load();
  check('sin archivo no hay borradores', store.size === 0);
  check('guardar uno', store.save(A, draft('un pedido largo', [{ number: 1, text: 'un log' }])) === 'saved');
  const copy = store.get(A);
  copy.text = 'tocado';
  copy.pasted[0].text = 'tocado';
  check('lo que devuelve es una copia', store.get(A).text === 'un pedido largo' && store.get(A).pasted[0].text === 'un log');
  check('el mismo otra vez no cambia nada', store.save(A, draft('un pedido largo', [{ number: 1, text: 'un log' }])) === 'unchanged');
  now = 2_000;
  check('otro distinto sí', store.save(A, draft('un pedido más largo', [{ number: 1, text: 'un log' }])) === 'saved');
  await store.flush();
  const written = JSON.parse(await readFile(statePath, 'utf8'));
  check('el archivo lleva la versión y los borradores, nada más', Object.keys(written).sort().join(',') === 'drafts,version' && written.version === 1);
  check('cada uno con su conversación, su hora y lo escrito',
    json(written.drafts) === json([{ agent: A.agent, sessionId: A.sessionId, updatedAt: 2_000, draft: draft('un pedido más largo', [{ number: 1, text: 'un log' }]) }]),
    json(written.drafts));

  const reloaded = new DraftStore({ statePath });
  await reloaded.load();
  check('al recargar vuelve', reloaded.get(A)?.text === 'un pedido más largo' && reloaded.get(A)?.pasted.length === 1);
  check('la conversación es la clave: la misma sesión en otra CLI no es la misma', reloaded.get({ agent: 'codex', sessionId: A.sessionId }) === null);

  check('uno vacío borra el guardado', store.save(A, draft('   ')) === 'deleted' && store.get(A) === null);
  check('y otra vez no borra nada', store.save(A, draft('')) === 'unchanged');
  store.save(A, draft('algo'));
  const huge = draft('x'.repeat(MAX_COMPOSER_DRAFT_CHARS - 1), [{ number: 1, text: 'yy' }]);
  check('uno que pasa del tope no se guarda, y el viejo se borra: volvería como si fuera todo',
    store.save(A, huge) === 'too-long' && store.get(A) === null);
  check('borrar el de una conversación que no tiene no avisa', store.delete(B) === false);
  await store.flush();
  check('el archivo queda sin borradores', JSON.parse(await readFile(statePath, 'utf8')).drafts.length === 0);
}

// --- 4. Dos instancias de la app sobre el mismo archivo -------------------------
{
  await rm(statePath, { force: true });
  const first = new DraftStore({ statePath });
  const second = new DraftStore({ statePath });
  await first.load();
  await second.load();
  first.save(A, draft('de la primera'));
  await first.flush();
  second.save(B, draft('de la segunda'));
  await second.flush();
  const both = JSON.parse(await readFile(statePath, 'utf8')).drafts.map((entry) => entry.draft.text).sort();
  check('guardar relee el archivo: la segunda no borra lo de la primera', json(both) === json(['de la primera', 'de la segunda']), json(both));
  check('y aprende lo que guardó la otra', second.get(A)?.text === 'de la primera');
  first.delete(A);
  await first.flush();
  second.save(B, draft('de la segunda, cambiado'));
  await second.flush();
  const after = JSON.parse(await readFile(statePath, 'utf8')).drafts.map((entry) => entry.draft.text);
  check('un borrado de la otra tampoco vuelve con la escritura siguiente', json(after) === json(['de la segunda, cambiado']), json(after));
}

// --- 5. Mudanzas, limpieza y tope ------------------------------------------------
{
  await rm(statePath, { force: true });
  let now = 10_000;
  const store = new DraftStore({ statePath, now: () => now });
  await store.load();
  store.save(A, draft('se muda'));
  const moved = { agent: 'claude-code', sessionId: 'a1b2c3d4-0000-4000-8000-00000000000f' };
  store.move(A, moved);
  check('mudar lleva el borrador a la conversación nueva', store.get(A) === null && store.get(moved)?.text === 'se muda');
  store.move(A, B);
  check('mudar sin borrador no crea nada', store.get(B) === null);

  store.save(B, draft('se queda'));
  store.retainOnly([B]);
  check('retainOnly deja solo las conversaciones del archivo de pestañas', store.get(moved) === null && store.get(B)?.text === 'se queda');
  await store.flush();
  check('y el archivo lo refleja', JSON.parse(await readFile(statePath, 'utf8')).drafts.length === 1);

  for (let index = 0; index < MAX_STORED_DRAFTS + 5; index += 1) {
    now += 1;
    store.save({ agent: 'claude-code', sessionId: `s-${index}` }, draft(`borrador ${index}`));
  }
  check(`pasado el tope quedan ${MAX_STORED_DRAFTS}, los más nuevos`,
    store.size === MAX_STORED_DRAFTS && store.get({ agent: 'claude-code', sessionId: 's-0' }) === null &&
    store.get({ agent: 'claude-code', sessionId: `s-${MAX_STORED_DRAFTS + 4}` }) !== null, String(store.size));
  await store.flush();
  check('y el archivo también', JSON.parse(await readFile(statePath, 'utf8')).drafts.length === MAX_STORED_DRAFTS);
}

// --- 6. Un archivo que no es de esta versión, o con basura -------------------------
{
  await writeFile(statePath, json({ version: 99, drafts: [{ agent: 'x', sessionId: 'y', updatedAt: 1, draft: draft('z') }] }));
  const future = new DraftStore({ statePath });
  await future.load();
  check('una versión desconocida se lee como vacía', future.size === 0);
  future.save(A, draft('nuevo'));
  await future.flush();
  const rewritten = JSON.parse(await readFile(statePath, 'utf8'));
  check('y el primer cambio la reescribe en la de ahora', rewritten.version === 1 && rewritten.drafts.length === 1);

  await writeFile(statePath, json({
    version: 1,
    drafts: [
      { agent: A.agent, sessionId: A.sessionId, updatedAt: 1, draft: draft('bien') },
      { agent: B.agent, updatedAt: 1, draft: draft('sin sesión') },
      { agent: B.agent, sessionId: B.sessionId, updatedAt: 1, draft: draft('   ') },
      'basura',
    ],
  }));
  const mixed = new DraftStore({ statePath });
  await mixed.load();
  check('uno mal formado se descarta sin llevarse los demás, y uno vacío no se lee',
    mixed.size === 1 && mixed.get(A)?.text === 'bien', String(mixed.size));
  await writeFile(statePath, '{ esto no es json');
  const broken = new DraftStore({ statePath });
  await broken.load();
  check('un archivo roto no tira el arranque', broken.size === 0);
}

// --- 7. De qué conversación es cada pestaña -----------------------------------------
{
  const tab = (terminalId, sessionId, extra = {}) => ({
    terminalId, kind: 'agent', cwd: 'D:\\x', agent: 'claude-code', sessionId, label: '', resumed: false,
    createdAt: 1, alive: true, exitCode: null, sleeping: false, ...extra,
  });
  check('una pestaña de agente con sesión tiene conversación',
    json(draftOwnerOf(tab('t1', A.sessionId))) === json(A));
  check('una consola no, ni una pestaña que todavía no sabe su id, ni una que no existe',
    draftOwnerOf(tab('t2', '', { kind: 'shell', agent: null })) === null && draftOwnerOf(tab('t3', '')) === null && draftOwnerOf(null) === null);

  const owners = workspaceDraftOwners({
    tabs: [{ agent: 'claude-code', cwd: 'D:\\x', sessionId: 's1', label: '' }],
    foreignTabs: [{ position: 1, raw: { agent: 'cli-futura', cwd: 'D:\\y', sessionId: 's2' } }, { position: 2, raw: { cwd: 'D:\\z' } }],
  });
  check('las del archivo de pestañas, también las que escribió una build más nueva',
    json(owners) === json([{ agent: 'claude-code', sessionId: 's1' }, { agent: 'cli-futura', sessionId: 's2' }]), json(owners));

  const tabs = new DraftTabs();
  const first = tabs.update([tab('t1', 's1'), tab('t2', '', { agent: 'codex' })]);
  check('la primera vez, todas aparecen', json(first.appeared.map((d) => d.terminalId)) === json(['t1', 't2']) && first.moved.length === 0);
  const again = tabs.update([tab('t1', 's1'), tab('t2', '', { agent: 'codex' })]);
  check('la segunda no', again.appeared.length === 0 && again.moved.length === 0);
  const discovered = tabs.update([tab('t1', 's1'), tab('t2', 'c1', { agent: 'codex' })]);
  check('descubrir la sesión no es mudarse: no había dónde estar', discovered.moved.length === 0);
  const cleared = tabs.update([tab('t1', 's1'), tab('t2', 'c2', { agent: 'codex' })]);
  check('cambiar de conversación sí', json(cleared.moved) === json([{ from: { agent: 'codex', sessionId: 'c1' }, to: { agent: 'codex', sessionId: 'c2' } }]));
  tabs.update([tab('t1', 's1'), tab('t2', '', { agent: 'codex' })]);
  const rediscovered = tabs.update([tab('t1', 's1'), tab('t2', 'c3', { agent: 'codex' })]);
  check('quedarse sin id en el medio conserva la anterior hasta que aparece la nueva',
    json(rediscovered.moved) === json([{ from: { agent: 'codex', sessionId: 'c2' }, to: { agent: 'codex', sessionId: 'c3' } }]));
  const closed = tabs.update([tab('t2', 'c3', { agent: 'codex' })]);
  const reopened = tabs.update([tab('t2', 'c3', { agent: 'codex' }), tab('t1', 's1')]);
  check('una que se cerró y vuelve con el mismo id aparece otra vez', closed.appeared.length === 0 && json(reopened.appeared.map((d) => d.terminalId)) === json(['t1']));

  const store = { get: (owner) => (json(owner) === json(A) ? draft('de A') : null) };
  const present = [tab('t1', A.sessionId), tab('t2', B.sessionId, { agent: 'codex' }), tab('t3', ''), tab('t4', '', { kind: 'shell', agent: null })];
  check('lo que el servidor manda de cada pestaña: su borrador, o uno vacío, que vacía el cuadro de una ventana que se perdió un envío',
    json(draftEntriesOf(present, store)) === json([{ terminalId: 't1', draft: draft('de A') }, { terminalId: 't2', draft: draft('') }]),
    json(draftEntriesOf(present, store)));
  check('con una conversación, sólo sus pestañas',
    json(draftEntriesOf(present, store, B)) === json([{ terminalId: 't2', draft: draft('') }]));
  check('y una consola o una pestaña sin conversación no tienen dónde guardar nada', draftEntriesOf(present.slice(2), store).length === 0);
}

// --- La página con un reloj de mentira, para las secciones 8 y 10 ------------------------
const clock = () => {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    setTimer: (callback, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers].sort(([, a], [, b]) => a.at - b.at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
    },
    pending: () => timers.size,
  };
};
const make = () => {
  const time = clock();
  const sent = [];
  let open = true;
  let ids = 0;
  const drafts = new ComposerDrafts({
    send: (terminalId, value) => sent.push({ terminalId, draft: value }),
    connected: () => open,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    newId: () => `id-${++ids}`,
    delayMs: 800,
  });
  return { drafts, time, sent, setOpen: (value) => { open = value; } };
};
const local = (text, items = []) => ({ text, items });
const chip = (number, text) => ({ id: `c${number}`, kind: 'text', number, text, lines: 1 });
const image = { id: 'img', kind: 'image', mediaType: 'image/png', base64: 'AAAA', dataUrl: 'data:', bytes: 3, name: 'a.png' };

// --- 8. La página: cuándo manda y qué no pisa ------------------------------------------
{
  check('lo que se guarda: el texto y los textos pegados, sin imágenes ni archivos',
    json(draftOf(local('hola', [chip(1, 'log'), image]))) === json(draft('hola', [{ number: 1, text: 'log' }])));
  const back = localDraftOf(draft('x', [{ number: 2, text: 'a\nb\nc' }]), () => 'nuevo');
  check('y de vuelta, fichas de texto con su número y sus líneas',
    back.items.length === 1 && back.items[0].kind === 'text' && back.items[0].number === 2 && back.items[0].lines === 3 && back.items[0].id === 'nuevo');
  check('el tope se mide igual que en el servidor',
    !draftTooLong(local('x'.repeat(MAX_COMPOSER_DRAFT_CHARS))) && draftTooLong(local('x'.repeat(MAX_COMPOSER_DRAFT_CHARS), [chip(1, 'y')])));

  {
    const { drafts, time, sent } = make();
    drafts.put('t1', local('antes de saber'));
    time.advance(5_000);
    check('antes de que el servidor diga que guarda, no se manda nada', sent.length === 0);
    drafts.restore([]);
    check('y en cuanto lo dice, sale lo que esperaba', json(sent) === json([{ terminalId: 't1', draft: draft('antes de saber') }]));
  }
  {
    const { drafts, time, sent } = make();
    drafts.restore([]);
    drafts.put('t1', local('h'));
    drafts.put('t1', local('ho'));
    time.advance(500);
    drafts.put('t1', local('hola'));
    time.advance(799);
    check('mientras se escribe no sale nada', sent.length === 0);
    time.advance(1);
    check('pasada la pausa sale una vez, lo último', json(sent) === json([{ terminalId: 't1', draft: draft('hola') }]));
    drafts.put('t1', local('hola'));
    time.advance(5_000);
    check('lo mismo otra vez no sale', sent.length === 1);
    drafts.put('t1', local('hola!'));
    drafts.put('t1', local('hola'));
    time.advance(5_000);
    check('escribir y deshacer antes de la pausa no manda nada', sent.length === 1);
    drafts.put('t1', local('hola', [image]));
    time.advance(5_000);
    check('una imagen no cambia lo que se guarda', sent.length === 1);
    drafts.put('t1', local('adiós'));
    drafts.submitted('t1', true);
    time.advance(5_000);
    check('mandar descarta lo que esperaba la pausa: saldría el mensaje ya mandado', sent.length === 1 && drafts.get('t1') === undefined);
    drafts.put('t1', local(''));
    time.advance(5_000);
    check('y el cuadro vacío después no manda nada: el servidor ya lo borró', sent.length === 1);
  }
  {
    const { drafts, time, sent } = make();
    const heard = [];
    drafts.onRestored((terminalId) => heard.push(terminalId));
    drafts.put('t2', local('escrito acá'));
    drafts.put('t3', local('', [image]));
    // Sin conexión todavía: el envío espera en la cola y sale después de la foto.
    drafts.submitted('t4', false);
    drafts.restore([
      { terminalId: 't1', draft: draft('del servidor', [{ number: 1, text: 'log' }]) },
      { terminalId: 't2', draft: draft('viejo') },
      { terminalId: 't3', draft: draft('otro') },
      { terminalId: 't4', draft: draft('ya mandado') },
    ]);
    check('va al cuadro el de una pestaña que nadie tocó, con su ficha',
      drafts.get('t1')?.text === 'del servidor' && drafts.get('t1')?.items.length === 1 && json(heard) === json(['t1', 't3']), json(heard));
    check('lo escrito acá no se pisa', drafts.get('t2')?.text === 'escrito acá');
    check('una con sólo una imagen recibe el texto, y la imagen se queda: no viaja',
      drafts.get('t3')?.text === 'otro' && json(drafts.get('t3')?.items.map((item) => item.kind)) === json(['image']));
    check('ni una donde se mandó: el servidor pudo contestar antes de ver el envío', drafts.get('t4') === undefined);
    time.advance(5_000);
    check('y lo escrito acá sale, pisando lo viejo del servidor', json(sent) === json([{ terminalId: 't2', draft: draft('escrito acá') }]), json(sent));
    drafts.put('t1', local('del servidor', [chip(1, 'log')]));
    time.advance(5_000);
    check('cargar lo del servidor en el cuadro no lo manda de vuelta', sent.length === 1);
  }
  {
    const { drafts, time, sent } = make();
    drafts.restore([{ terminalId: 't1', draft: draft('guardado') }]);
    drafts.put('t1', local('x'.repeat(MAX_COMPOSER_DRAFT_CHARS + 1)));
    time.advance(5_000);
    check('pasado el tope se borra lo guardado, en vez de dejar lo viejo', json(sent) === json([{ terminalId: 't1', draft: draft('') }]));
    drafts.put('t1', local('y'.repeat(MAX_COMPOSER_DRAFT_CHARS + 5)));
    time.advance(5_000);
    check('y no se vuelve a mandar mientras siga pasado', sent.length === 1);
  }
  {
    const { drafts, time, sent, setOpen } = make();
    drafts.restore([]);
    setOpen(false);
    drafts.put('t1', local('sin conexión'));
    time.advance(5_000);
    check('con el socket caído espera', sent.length === 0);
    setOpen(true);
    drafts.reconnected();
    drafts.put('t2', local('recién reconectado'));
    time.advance(5_000);
    check('al reconectar espera a que el servidor diga que guarda: puede ser otro', sent.length === 0);
    drafts.restore([]);
    check('y sale todo en cuanto lo dice', json(sent.map((entry) => entry.terminalId).sort()) === json(['t1', 't2']));
  }
  {
    const { drafts, time, sent } = make();
    drafts.restore([]);
    drafts.put('t1', local('de una que se cierra'));
    drafts.put('t2', local('de una que queda'));
    drafts.retain(['t2']);
    check('lo de una pestaña que se cerró se olvida, y no sale', drafts.get('t1') === undefined && time.pending() === 1);
    drafts.flushAll();
    check('al esconder la página, lo que esperaba sale ya', json(sent) === json([{ terminalId: 't2', draft: draft('de una que queda') }]) && time.pending() === 0);
  }
}

// --- 9. El cursor y el scroll de cada pestaña (0.5.0) -----------------------------------
//
// El cuadro es uno solo y cambia de texto con la pestaña. Al volver, quedaba
// mostrando el principio del texto: el usuario creyó que su lista terminaba en
// el punto 4 y siguió numerando desde ahí.
{
  const newDrafts = () =>
    new ComposerDrafts({
      send: () => {},
      connected: () => true,
      setTimer: () => 1,
      clearTimer: () => {},
      newId: () => 'id',
    });
  const view = (selectionStart, selectionEnd, scrollTop, backward = false) => ({ selectionStart, selectionEnd, backward, scrollTop });

  {
    const drafts = newDrafts();
    drafts.rememberView('t1', view(120, 120, 340));
    check('9.1 al volver, el cursor y el scroll son los que había',
      json(viewToRestore(500, drafts.viewOf('t1'))) === json({ start: 120, end: 120, direction: 'forward', scrollTop: 340 }),
      json(viewToRestore(500, drafts.viewOf('t1'))));
    check('9.2 una selección hacia atrás vuelve hacia atrás',
      json(viewToRestore(500, view(10, 40, 0, true))) === json({ start: 10, end: 40, direction: 'backward', scrollTop: 0 }));
    check('9.3 sin nada recordado, el cursor va al final y el cuadro baja hasta él',
      json(viewToRestore(500, undefined)) === json({ start: 500, end: 500, direction: 'forward', scrollTop: 'end' }));
    check('9.4 lo recordado no pasa del texto que hay',
      json(viewToRestore(30, view(120, 140, 340))) === json({ start: 30, end: 30, direction: 'forward', scrollTop: 340 }));
  }
  {
    const drafts = newDrafts();
    drafts.rememberView('t1', view(5, 5, 50));
    drafts.submitted('t1', true);
    check('9.5 al mandar, se olvida: el cuadro quedó vacío', drafts.viewOf('t1') === undefined);
  }
  {
    const drafts = newDrafts();
    drafts.rememberView('t1', view(5, 5, 50));
    drafts.rememberView('t2', view(7, 7, 70));
    drafts.put('t2', { text: 'tocada en esta página', items: [] });
    drafts.restore([
      { terminalId: 't1', draft: draft('llegó del servidor') },
      { terminalId: 't2', draft: draft('no pisa lo tocado') },
    ]);
    check('9.6 un borrador que llega del servidor cambia el texto: lo recordado se olvida',
      drafts.viewOf('t1') === undefined);
    check('9.7 en una pestaña tocada no llega nada, y lo recordado queda', drafts.viewOf('t2')?.scrollTop === 70);
  }
  {
    const drafts = newDrafts();
    drafts.rememberView('t1', view(5, 5, 50));
    drafts.rememberView('t2', view(7, 7, 70));
    drafts.retain(['t2']);
    check('9.8 lo de una pestaña que se cerró se olvida', drafts.viewOf('t1') === undefined && drafts.viewOf('t2') !== undefined);
  }
}

// --- 10. Entre ventanas, en vivo (09-10-2026) -----------------------------------------------
//
// El usuario escribía en la PC: el teléfono seguía con el texto de cuando se
// abrió —ni cambiando de pestaña ni reconectando— y la laptop no mostraba
// nada. El servidor manda cada cambio a todas las ventanas, también a la que
// lo escribió, y la página lo pone en el cuadro si ahí no hay nada propio
// todavía sin guardar.
{
  {
    const { drafts, time, sent } = make();
    const heard = [];
    drafts.onRestored((terminalId) => heard.push(terminalId));
    drafts.restore([{ terminalId: 't1', draft: draft('¿Puedes verlo?') }]);
    drafts.put('t1', local('¿Puedes verlo?'));
    drafts.restore([{ terminalId: 't1', draft: draft('¿Puedes verlo? Mira el teléfono') }]);
    check('10.1 lo que se escribe en otra ventana llega al cuadro, aunque ya mostrara un borrador anterior',
      drafts.get('t1')?.text === '¿Puedes verlo? Mira el teléfono' && json(heard) === json(['t1', 't1']), json(heard));
    drafts.put('t1', local('¿Puedes verlo? Mira el teléfono'));
    time.advance(5_000);
    check('10.2 y no vuelve al servidor: ya lo tiene', sent.length === 0, json(sent));
  }
  {
    const { drafts, time, sent } = make();
    const heard = [];
    drafts.onRestored((terminalId) => heard.push(terminalId));
    drafts.restore([]);
    drafts.put('t1', local('escribiendo acá'));
    drafts.restore([{ terminalId: 't1', draft: draft('de otra ventana') }]);
    check('10.3 no pisa lo que se está escribiendo en esta ventana', drafts.get('t1')?.text === 'escribiendo acá' && heard.length === 0);
    time.advance(800);
    check('10.4 y lo de acá sale igual: gana lo último', json(sent) === json([{ terminalId: 't1', draft: draft('escribiendo acá') }]), json(sent));
    drafts.rememberView('t1', { selectionStart: 3, selectionEnd: 3, backward: false, scrollTop: 0 });
    drafts.restore([{ terminalId: 't1', draft: draft('escribiendo acá') }]);
    check('10.5 el eco de lo propio no toca el cuadro ni el cursor', heard.length === 0 && drafts.viewOf('t1')?.selectionStart === 3);
    drafts.restore([{ terminalId: 't1', draft: draft('escribiendo acá, y sigo en el teléfono') }]);
    check('10.6 con lo propio ya guardado, lo de otra ventana llega',
      drafts.get('t1')?.text === 'escribiendo acá, y sigo en el teléfono' && json(heard) === json(['t1']));
  }
  {
    const { drafts, time } = make();
    const heard = [];
    drafts.onRestored((terminalId) => heard.push(terminalId));
    drafts.restore([]);
    drafts.put('t1', local('mío'));
    time.advance(800);
    drafts.restore([{ terminalId: 't1', draft: draft('de otra, procesado antes') }]);
    check('10.7 lo que el servidor guardó antes que lo propio no se muestra: lo propio lo va a pisar',
      drafts.get('t1')?.text === 'mío' && heard.length === 0);
    drafts.restore([{ terminalId: 't1', draft: draft('mío') }]);
    drafts.restore([{ terminalId: 't1', draft: draft('de otra, después') }]);
    check('10.8 lo que llega después del eco, sí', drafts.get('t1')?.text === 'de otra, después' && json(heard) === json(['t1']));
  }
  {
    const { drafts } = make();
    drafts.restore([{ terminalId: 't1', draft: draft('un pedido', [{ number: 1, text: 'log' }]) }]);
    const loaded = drafts.get('t1');
    drafts.put('t1', { text: loaded.text, items: [...loaded.items, image] });
    drafts.restore([{ terminalId: 't1', draft: draft('') }]);
    const after = drafts.get('t1');
    check('10.9 lo que se mandó desde otra ventana se vacía acá, y la imagen pegada acá se queda',
      after?.text === '' && json(after.items.map((item) => item.kind)) === json(['image']), json(after));
  }
  {
    const { drafts, time } = make();
    drafts.restore([]);
    drafts.put('t1', local('x'.repeat(MAX_COMPOSER_DRAFT_CHARS + 1)));
    time.advance(5_000);
    drafts.restore([{ terminalId: 't1', draft: draft('de otra ventana') }]);
    check('10.10 un texto que pasa del tope no se guarda, y tampoco lo pisa otra ventana',
      drafts.get('t1')?.text.length === MAX_COMPOSER_DRAFT_CHARS + 1);
  }

  // Mandar: lo que llega antes de que el servidor vacíe el borrador es de antes del envío.
  {
    const { drafts, setOpen } = make();
    const heard = [];
    drafts.onRestored((terminalId) => heard.push(terminalId));
    drafts.restore([{ terminalId: 't1', draft: draft('ya mandado') }]);
    drafts.put('t1', local('ya mandado'));
    setOpen(false);
    drafts.submitted('t1', false);
    setOpen(true);
    // La cola de la conexión sale antes de avisar que volvió; la foto es de antes de procesarla.
    drafts.reconnected();
    drafts.restore([{ terminalId: 't1', draft: draft('ya mandado') }]);
    check('10.11 un mensaje mandado sin conexión no vuelve con la foto de la reconexión',
      drafts.get('t1') === undefined && json(heard) === json(['t1']), json(heard));
    drafts.restore([{ terminalId: 't1', draft: draft('ya mandado') }]);
    check('10.12 ni con otra cosa que llegue antes de que el servidor lo vacíe', drafts.get('t1') === undefined);
    drafts.restore([{ terminalId: 't1', draft: draft('') }]);
    drafts.restore([{ terminalId: 't1', draft: draft('nuevo, de otra ventana') }]);
    check('10.13 después de vaciarlo, lo de otra ventana llega otra vez', drafts.get('t1')?.text === 'nuevo, de otra ventana');
  }
  {
    const { drafts, time } = make();
    drafts.restore([]);
    drafts.put('t1', local('mensaje'));
    time.advance(800);
    drafts.submitted('t1', true);
    drafts.restore([{ terminalId: 't1', draft: draft('mensaje') }]);
    check('10.14 el eco de un borrador que llega después de mandar no lo devuelve al cuadro', drafts.get('t1') === undefined);
  }
  {
    const { drafts, time } = make();
    drafts.restore([]);
    drafts.put('t1', local('no llegó'));
    time.advance(800);
    drafts.restore([{ terminalId: 't1', draft: draft('no llegó') }]);
    drafts.submitted('t1', true);
    // El socket se cayó con el envío adentro, y el servidor no lo vio: el borrador sigue ahí.
    drafts.reconnected();
    drafts.restore([{ terminalId: 't1', draft: draft('no llegó') }]);
    check('10.15 un envío que se perdió con el socket: la foto lo dice, y el texto vuelve al cuadro', drafts.get('t1')?.text === 'no llegó');
  }

  // Reconectar: lo que se mandó por un socket que ya estaba muerto.
  {
    const { drafts, time, sent } = make();
    drafts.restore([{ terminalId: 't1', draft: draft('base') }]);
    drafts.put('t1', local('base y más'));
    time.advance(800);
    drafts.reconnected();
    drafts.restore([{ terminalId: 't1', draft: draft('base') }]);
    check('10.16 lo que se mandó por un socket muerto no se pierde: el servidor sigue como estaba y el cuadro lo conserva',
      drafts.get('t1')?.text === 'base y más');
    time.advance(800);
    check('10.17 y sale otra vez', json(sent.map((entry) => entry.draft.text)) === json(['base y más', 'base y más']), json(sent));
  }
  {
    const { drafts, time, sent } = make();
    drafts.restore([{ terminalId: 't1', draft: draft('base') }]);
    drafts.put('t1', local('base y más'));
    time.advance(800);
    drafts.reconnected();
    drafts.restore([{ terminalId: 't1', draft: draft('lo siguió otra ventana') }]);
    check('10.18 pero si mientras tanto se siguió en otra ventana, gana lo del servidor', drafts.get('t1')?.text === 'lo siguió otra ventana');
    time.advance(5_000);
    check('10.19 y no se manda nada encima', sent.length === 1, json(sent));
  }
  {
    const { drafts, time, sent } = make();
    const heard = [];
    drafts.onRestored((terminalId) => heard.push(terminalId));
    drafts.restore([]);
    drafts.put('t1', local('llegó'));
    time.advance(800);
    drafts.reconnected();
    drafts.restore([{ terminalId: 't1', draft: draft('llegó') }]);
    time.advance(5_000);
    check('10.20 si llegó y sólo se perdió el eco, no se repite nada', sent.length === 1 && heard.length === 0);
  }
  {
    const { drafts, time, sent, setOpen } = make();
    drafts.restore([{ terminalId: 't1', draft: draft('base') }]);
    setOpen(false);
    drafts.put('t1', local('escrito sin conexión'));
    time.advance(5_000);
    setOpen(true);
    drafts.reconnected();
    drafts.restore([{ terminalId: 't1', draft: draft('de otra ventana') }]);
    check('10.21 lo escrito sin conexión no lo pisa la foto, y sale',
      drafts.get('t1')?.text === 'escrito sin conexión' && json(sent) === json([{ terminalId: 't1', draft: draft('escrito sin conexión') }]),
      json(sent));
  }
}

await rm(dir, { recursive: true, force: true });

console.log(failures === 0 ? '\nTodo bien.' : `\n${failures} fallo(s).`);
process.exit(failures === 0 ? 0 : 1);
