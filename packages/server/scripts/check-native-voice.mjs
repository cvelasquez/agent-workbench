import assert from 'node:assert/strict';
import { parseAgentCapabilities } from '@agent-workbench/shared';
import { NativeVoiceController } from '../src/native-voice.ts';
import { DICTATION_TIMING, boxText, dictationBusy, takeDictation } from '../src/voice-dictation.ts';
import * as screens from './fixtures/voice-screens.mjs';
import {
  HOLD_TO_TALK_MS,
  SpaceHoldGesture,
  actionSlots,
  composerButtons,
  dictationInsertion,
  isHoldControl,
  spaceHoldMode,
  typedSpaceRange,
} from '../../web/src/composer-voice.ts';
import {
  CLAUDE_CODE_NATIVE_VOICE,
  CLAUDE_CODE_VOICE_DICTATION,
  CLAUDE_CODE_VOICE_STARTUP_DIALOG,
  claudeCapabilitiesForVersion,
  supportsClaudeNativeVoiceVersion,
} from '../src/agents/claude-code/index.ts';
import {
  ANTIGRAVITY_NATIVE_VOICE,
  ANTIGRAVITY_VOICE_DICTATION,
  antigravityCapabilitiesForVersion,
  supportsNativeVoiceVersion,
} from '../src/agents/antigravity/index.ts';
import {
  CODEX_NATIVE_VOICE,
  codexCapabilitiesForVersion,
  supportsCodexNativeVoiceVersion,
} from '../src/agents/codex/index.ts';

const claude = { defaultMode: 'dictation', modes: [{ mode: 'dictation', control: 'claude-hold-space' }] };
const antigravity = {
  defaultMode: 'dictation',
  modes: [
    { mode: 'dictation', control: 'antigravity-dictation' },
    { mode: 'live', control: 'antigravity-live' },
  ],
};
const codex = { defaultMode: 'live', modes: [{ mode: 'live', control: 'codex-live-f8' }] };

assert.deepEqual(CLAUDE_CODE_NATIVE_VOICE, claude);
assert.deepEqual(ANTIGRAVITY_NATIVE_VOICE, antigravity);
assert.deepEqual(CODEX_NATIVE_VOICE, codex);
assert.equal(CLAUDE_CODE_VOICE_STARTUP_DIALOG.test('Allow external CLAUDE.md file imports?'), true);
assert.equal(supportsClaudeNativeVoiceVersion('2.1.317'), false);
assert.equal(supportsClaudeNativeVoiceVersion('Claude Code 2.1.318'), true);
assert.equal(supportsClaudeNativeVoiceVersion('2.1.319'), true);
assert.equal(supportsClaudeNativeVoiceVersion(null), false);
assert.equal(supportsNativeVoiceVersion('1.4.9'), false);
assert.equal(supportsNativeVoiceVersion('1.5.0'), true);
assert.equal(supportsCodexNativeVoiceVersion('codex-cli 0.165.0'), false);
assert.equal(supportsCodexNativeVoiceVersion('codex-cli 0.166.0'), true);
assert.deepEqual(parseAgentCapabilities({ nativeVoice: claude }).nativeVoice, claudeCapabilitiesForVersion('2.1.319').nativeVoice);
assert.equal(antigravityCapabilitiesForVersion('1.4.9', false).nativeVoice, undefined);
assert.equal(codexCapabilitiesForVersion('0.165.0').nativeVoice, undefined);
assert.deepEqual(parseAgentCapabilities({ nativeVoice: codex }).nativeVoice, codex);

const writes = [];
const alive = new Set(['claude', 'agy', 'codex']);
const capabilities = new Map([
  ['claude', claude],
  ['agy', antigravity],
  ['codex', codex],
]);
let repeated;
let intervalMs = 0;
let timerStopped = false;
const controller = new NativeVoiceController({
  capabilityOf: (terminalId) => capabilities.get(terminalId) ?? null,
  isAlive: (terminalId) => alive.has(terminalId),
  write: (terminalId, data) => { writes.push([terminalId, data]); return alive.has(terminalId); },
  repeatEvery: (callback, ms) => { repeated = callback; intervalMs = ms; return 'timer'; },
  stopRepeating: (timer) => { assert.equal(timer, 'timer'); timerStopped = true; },
});
const socketA = {};
const socketB = {};

assert.equal(await controller.start('claude', socketA, 'dictation'), true);
assert.deepEqual(writes.splice(0), [['claude', ' ']]);
assert.equal(intervalMs, 35);
repeated();
assert.deepEqual(writes.splice(0), [['claude', ' ']]);
assert.equal(controller.stop('claude', socketB, 'dictation'), false);
assert.equal(controller.stop('claude', socketA, 'dictation'), true);
assert.equal(timerStopped, true);
assert.deepEqual(writes.splice(0), []);
repeated();
assert.deepEqual(writes.splice(0), []);
assert.equal(await controller.start('claude', socketA, 'dictation'), true);
assert.deepEqual(writes.splice(0), [['claude', ' ']]);
controller.releaseSocket(socketA);
assert.equal(controller.isActive('claude'), false);
assert.deepEqual(writes.splice(0), [['claude', '\u001b']]);
assert.equal(await controller.start('claude', socketA, 'dictation'), true);
assert.deepEqual(writes.splice(0), [['claude', ' ']]);
assert.equal(controller.stop('claude', socketA, 'dictation', true), true);
assert.deepEqual(writes.splice(0), [['claude', '\u001b']]);

assert.equal(await controller.start('agy', socketA, 'dictation', async () => false), false);
assert.equal(controller.isActive('agy'), false);
assert.deepEqual(writes.splice(0), []);
assert.equal(await controller.start('agy', socketA, 'dictation'), true);
assert.deepEqual(writes.splice(0), [['agy', '/voice dictate\r']]);
assert.equal(controller.stop('agy', socketA, 'dictation'), true);
assert.deepEqual(writes.splice(0), [['agy', '\r']]);
assert.equal(await controller.start('agy', socketA, 'dictation'), true);
assert.equal(controller.stop('agy', socketA, 'dictation', true), true);
assert.deepEqual(writes.splice(0), [['agy', '/voice dictate\r'], ['agy', '\u001b']]);
assert.equal(await controller.start('agy', socketA, 'live'), true);
assert.deepEqual(writes.splice(0), [['agy', '/voice live\r']]);
controller.releaseSocket(socketA);
assert.deepEqual(writes.splice(0), [['agy', '/voice stop\r']]);

assert.equal(await controller.start('codex', socketA, 'live'), true);
assert.deepEqual(writes.splice(0), [['codex', '\u001b[19~']]);
assert.equal(await controller.start('codex', socketB, 'live'), false);
assert.equal(controller.stop('codex', socketA, 'live'), true);
assert.deepEqual(writes.splice(0), [['codex', '\u001b[19~']]);
assert.equal(await controller.start('codex', socketA, 'live'), true);
controller.releaseTerminal('codex');
assert.deepEqual(writes.splice(0), [['codex', '\u001b[19~'], ['codex', '\u001b[19~']]);
assert.equal(await controller.start('not-supported', socketA, 'live'), false);
assert.equal(controller.isActive('not-supported'), false);

let enterGuard;
let releaseGuard;
const guardEntered = new Promise((resolve) => { enterGuard = resolve; });
const guardGate = new Promise((resolve) => { releaseGuard = resolve; });
const pendingStart = controller.start('agy', socketA, 'dictation', async () => {
  enterGuard();
  return await guardGate;
});
await guardEntered;
assert.equal(controller.stop('agy', socketA, 'dictation'), true);
releaseGuard(true);
assert.equal(await pendingStart, false);
assert.deepEqual(writes.splice(0), []);
controller.dispose();

// ---------------------------------------------------------------------------
// El controlador dice si lo que se detuvo estaba grabando: solo entonces hay un dictado que recoger (§5.3.3)
// ---------------------------------------------------------------------------

{
  const stopWrites = [];
  const stopController = new NativeVoiceController({
    capabilityOf: (terminalId) => (terminalId === 'agy' ? antigravity : null),
    isAlive: () => true,
    write: (terminalId, data) => { stopWrites.push([terminalId, data]); return true; },
  });
  const owner = {};
  assert.equal(stopController.stopRecording('agy', owner, 'dictation'), 'none', 'sin sesion no hay nada que recoger');
  assert.equal(await stopController.start('agy', owner, 'dictation'), true);
  assert.equal(stopController.stopRecording('agy', {}, 'dictation'), 'none', 'otro socket no detiene la grabacion');
  assert.equal(stopController.stopRecording('agy', owner, 'live'), 'none', 'ni con otro modo');
  assert.equal(stopController.stopRecording('agy', owner, 'dictation'), 'recorded', 'grabando: hay un dictado que recoger');
  assert.equal(stopController.isActive('agy'), false);
  assert.equal(await stopController.start('agy', owner, 'dictation'), true);
  assert.equal(stopController.stopRecording('agy', owner, 'dictation', true), 'cancelled', 'cancelado: no hay nada que recoger');
  assert.equal(stopController.stop('agy', owner, 'dictation'), false, 'stop sigue diciendo si habia algo');

  let openGate;
  const gate = new Promise((resolve) => { openGate = resolve; });
  const waiting = stopController.start('agy', owner, 'dictation', () => gate);
  assert.equal(stopController.stopRecording('agy', owner, 'dictation'), 'pending', 'sin haber empezado a grabar no hay dictado');
  openGate(true);
  assert.equal(await waiting, false);
  stopController.dispose();
}

// ---------------------------------------------------------------------------
// Leer el dictado de la caja de la CLI (§5.3.3), con las pantallas medidas el 06-11-2026
// ---------------------------------------------------------------------------

const SPOKEN = 'Hola, esto es una prueba de dictado para ver como la caja parte las lineas cuando el texto es largo y llega hasta el final del ancho disponible, y todavia sigue un poco mas.';
const claudeBox = CLAUDE_CODE_VOICE_DICTATION;
const agyBox = ANTIGRAVITY_VOICE_DICTATION;

{
  // La caja, de la pantalla: las lineas partidas se juntan, y lo que la CLI dibuja de ayuda no es texto.
  assert.equal(boxText(claudeBox, screens.CLAUDE_TYPED), SPOKEN, 'Claude: una caja de dos lineas se lee entera');
  assert.equal(boxText(claudeBox, screens.CLAUDE_CLEARED), '');
  assert.equal(boxText(claudeBox, screens.CLAUDE_EMPTY), '');
  assert.equal(boxText(claudeBox, ['nada de una caja']), null, 'sin caja a la vista no hay lectura');
  assert.equal(boxText(agyBox, screens.AGY_TYPED), SPOKEN, 'Antigravity: lo mismo');
  assert.equal(boxText(agyBox, screens.AGY_CLEARED), '');
  for (const hint of [screens.AGY_HINT_PLAN, screens.AGY_HINT_ACCEPT_EDITS, screens.AGY_HINT_AUTO]) {
    // Medido: la ayuda de cada modo no esta atenuada (color gris fijo) y el lector sin lo atenuado la lee.
    assert.equal(boxText(agyBox, hint), '', `la ayuda de la caja vacia no es un dictado: ${hint.find((line) => line.startsWith('>'))}`);
  }

  // Lo que la CLI dice mientras graba o transcribe: no es texto, y hay que esperarlo.
  for (const screen of [screens.CLAUDE_LISTENING, screens.CLAUDE_PROCESSING, screens.CLAUDE_HOLDING]) {
    assert.equal(dictationBusy(claudeBox, screen), true, `Claude ocupada: ${screen.join(' | ').slice(0, 120)}`);
  }
  for (const screen of [screens.CLAUDE_TYPED, screens.CLAUDE_CLEARED, screens.CLAUDE_NO_SPEECH, screens.CLAUDE_EMPTY]) {
    assert.equal(dictationBusy(claudeBox, screen), false, `Claude libre: ${screen.join(' | ').slice(0, 120)}`);
  }
  for (const screen of [screens.AGY_CONNECTING, screens.AGY_RECORDING, screens.AGY_FINISHING]) {
    assert.equal(dictationBusy(agyBox, screen), true, `Antigravity ocupada: ${screen.join(' | ').slice(0, 120)}`);
  }
  for (const screen of [screens.AGY_TYPED, screens.AGY_CLEARED, screens.AGY_DONE_EMPTY, screens.AGY_HINT_PLAN]) {
    assert.equal(dictationBusy(agyBox, screen), false, `Antigravity libre: ${screen.join(' | ').slice(0, 120)}`);
  }
  // Una caja que solo muestra el medidor de nivel de la grabacion tambien esta ocupada.
  assert.equal(dictationBusy(claudeBox, [...screens.CLAUDE_CLEARED.slice(0, 2), '❯ ▆', ...screens.CLAUDE_CLEARED.slice(3)]), true);
  // La palabra en el hilo, por arriba de la caja, no cuenta: solo se mira la zona de la caja.
  const thread = ['● Recording 00:01 lo dijo alguien en el hilo', 'y Connecting... tambien', 'y listening… y Voice: processing…', ''];
  assert.equal(dictationBusy(agyBox, [...thread, ...screens.AGY_TYPED]), false);
  assert.equal(dictationBusy(claudeBox, [...thread, ...screens.CLAUDE_TYPED]), false);
}

/**
 * Una pty de mentira: cada pantalla se ve desde su momento, el reloj corre con las esperas, y las
 * teclas de vaciar dejan la caja como dice `clearedLines` (o no, si la CLI no las atiende).
 */
function dictationWorld(timeline, { clearedLines, clearWorks = true, clearRefused = false } = {}) {
  let clock = 0;
  let cleared = false;
  const writes = [];
  return {
    writes,
    get clock() { return clock; },
    io: {
      screen: async () => {
        if (cleared) return clearedLines;
        let current = timeline[0][1];
        for (const [at, lines] of timeline) if (at <= clock) current = lines;
        return current;
      },
      wait: async (ms) => { clock += ms; },
      now: () => clock,
      clear: async (keys) => {
        if (clearRefused) return false;
        writes.push(keys);
        if (clearWorks) cleared = true;
        return true;
      },
    },
  };
}
const CLEAR = '\x15\x0b';

{
  // Claude: graba, procesa, aparece el texto: se lee entero, se vacia la caja y el texto sale.
  const world = dictationWorld(
    [[0, screens.CLAUDE_LISTENING], [300, screens.CLAUDE_PROCESSING], [900, screens.CLAUDE_TYPED]],
    { clearedLines: screens.CLAUDE_CLEARED },
  );
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'text', text: SPOKEN });
  assert.deepEqual(world.writes, [CLEAR.repeat(6)], 'dos lineas de caja: una pasada por linea, y de mas');
  assert.ok(world.clock >= 900, 'espero a que terminara de transcribir');
}
{
  // Antigravity: lo mismo, con sus indicadores.
  const world = dictationWorld(
    [[0, screens.AGY_RECORDING], [300, screens.AGY_FINISHING], [900, screens.AGY_TYPED]],
    { clearedLines: screens.AGY_CLEARED },
  );
  assert.deepEqual(await takeDictation(agyBox, world.io), { kind: 'text', text: SPOKEN });
  assert.deepEqual(world.writes, [CLEAR.repeat(6)]);
}
{
  // Sin voz, Claude lo dice ("No speech detected."): vacio enseguida y sin escribir una tecla.
  const world = dictationWorld([[0, screens.CLAUDE_LISTENING], [300, screens.CLAUDE_PROCESSING], [800, screens.CLAUDE_NO_SPEECH]]);
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'empty' });
  assert.deepEqual(world.writes, []);
  assert.ok(world.clock < 800 + DICTATION_TIMING.emptyGraceMs, 'con el aviso de la CLI no se espera el plazo de gracia');
}
{
  // Sin voz, Antigravity no dice nada: vacio despues del plazo de gracia, y la ayuda de la caja no es un dictado.
  for (const last of [screens.AGY_DONE_EMPTY, screens.AGY_HINT_PLAN]) {
    const world = dictationWorld([[0, screens.AGY_RECORDING], [400, screens.AGY_FINISHING], [1200, last]]);
    assert.deepEqual(await takeDictation(agyBox, world.io), { kind: 'empty' });
    assert.deepEqual(world.writes, []);
    assert.ok(world.clock >= 1200 + DICTATION_TIMING.emptyGraceMs, 'espera el plazo de gracia antes de decir que no hubo nada');
    assert.ok(world.clock < 1200 + DICTATION_TIMING.emptyGraceMs + 500);
  }
}
{
  // El aviso de un intento anterior no gana: la CLI todavia no habia empezado a grabar.
  const world = dictationWorld(
    [[0, screens.CLAUDE_NO_SPEECH], [400, screens.CLAUDE_LISTENING], [700, screens.CLAUDE_PROCESSING], [1200, screens.CLAUDE_TYPED]],
    { clearedLines: screens.CLAUDE_CLEARED },
  );
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'text', text: SPOKEN });
}
{
  // Un texto que todavia cambia no se toma: se espera a que dos lecturas seguidas digan lo mismo.
  const partial = [screens.CLAUDE_TYPED[0], screens.CLAUDE_TYPED[1], '❯ Hola, esto es', screens.CLAUDE_TYPED[4], screens.CLAUDE_TYPED[5]];
  const world = dictationWorld(
    [[0, screens.CLAUDE_PROCESSING], [500, partial], [580, screens.CLAUDE_TYPED]],
    { clearedLines: screens.CLAUDE_CLEARED },
  );
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'text', text: SPOKEN });
}
{
  // La caja no se vacia (una tecla cambiada en la CLI): el texto queda donde estaba y no sale a medias.
  const world = dictationWorld([[0, screens.CLAUDE_TYPED]], { clearWorks: false });
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'kept' });
  assert.equal(world.writes.length, 4, 'cuatro tandas y se rinde');
}
{
  // La escritura se niega (la terminal ya no esta): no se reintenta.
  const world = dictationWorld([[0, screens.CLAUDE_TYPED]], { clearRefused: true });
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'kept' });
  assert.deepEqual(world.writes, []);
}
{
  // Nunca se cuelga: sin caja a la vista (un dialogo encima), vacio al llegar al plazo.
  const world = dictationWorld([[0, ['un dialogo tapa la caja', 'Enter para seguir']]]);
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'empty' });
  assert.ok(world.clock >= DICTATION_TIMING.totalMs && world.clock < DICTATION_TIMING.totalMs + 1_000);
}
{
  // Grabando sin parar hasta el plazo: tampoco se cuelga, y no toma el medidor por texto.
  const world = dictationWorld([[0, screens.CLAUDE_LISTENING]]);
  assert.deepEqual(await takeDictation(claudeBox, world.io), { kind: 'empty' });
  assert.deepEqual(world.writes, []);
}

// ---------------------------------------------------------------------------
// El cuadro: donde cae lo dictado, y el gesto de mantener Espacio (web/src/composer-voice.ts)
// ---------------------------------------------------------------------------

{
  assert.equal(dictationInsertion('', 0, 0, 'hola'), 'hola');
  assert.equal(dictationInsertion('hola', 4, 4, 'mundo'), ' mundo', 'detras de una palabra, con un espacio');
  assert.equal(dictationInsertion('hola ', 5, 5, 'mundo'), 'mundo', 'sin duplicar el espacio');
  assert.equal(dictationInsertion('hola\n', 5, 5, 'mundo'), 'mundo', 'despues de un salto de linea');
  assert.equal(dictationInsertion('abcd', 2, 2, 'x'), ' x ', 'en medio de una palabra: separado de los dos lados');
  assert.equal(dictationInsertion('ab cd', 2, 2, 'x'), ' x', 'antes de un espacio ya hay separacion');
  assert.equal(dictationInsertion('uno dos', 0, 0, 'cero'), 'cero ', 'al principio de un texto');
  assert.equal(dictationInsertion('hola XX', 5, 7, 'mundo'), 'mundo', 'lo seleccionado se reemplaza');

  assert.deepEqual(typedSpaceRange({ value: 'hola', start: 4 }, 'hola ', 5), { from: 4, to: 5 });
  assert.deepEqual(typedSpaceRange({ value: 'ab', start: 1 }, 'a b', 2), { from: 1, to: 2 });
  assert.equal(typedSpaceRange({ value: 'hola', start: 4 }, 'hola', 4), null, 'el espacio no llego a escribirse');
  assert.equal(typedSpaceRange({ value: 'hola', start: 4 }, 'hola x', 6), null, 'el texto cambio por otro lado');
  assert.equal(typedSpaceRange({ value: 'hola', start: 4 }, 'hola ', 4), null, 'el cursor se movio');
}

{
  const key = (extra = {}) => ({ key: ' ', repeat: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, isComposing: false, ...extra });
  const world = (canStart = true) => {
    const log = [];
    let scheduled = null;
    const gesture = new SpaceHoldGesture({
      canStart: () => canStart,
      onHold: (snapshot) => log.push(['hold', snapshot]),
      onRelease: () => log.push(['release']),
      schedule: (callback, ms) => { scheduled = { callback, ms }; return scheduled; },
      unschedule: (handle) => { if (scheduled === handle) scheduled = null; },
    });
    return {
      gesture,
      log,
      get scheduled() { return scheduled; },
      fire: () => { const pending = scheduled; scheduled = null; pending?.callback(); },
    };
  };
  const box = { value: 'hola', start: 4, end: 4 };
  assert.equal(HOLD_TO_TALK_MS, 1_000);

  // Un toque normal: el espacio se escribe, no se arma nada que quede colgado.
  let w = world();
  assert.equal(w.gesture.keyDown(key(), box), false, 'el primer espacio se escribe como siempre');
  assert.equal(w.scheduled?.ms, HOLD_TO_TALK_MS);
  w.gesture.keyUp({ key: ' ' });
  assert.equal(w.scheduled, null, 'soltar antes de tiempo desarma el gesto');
  assert.deepEqual(w.log, []);

  // Mantenido: las repeticiones no escriben espacios, pasado el tiempo arranca, y soltar termina.
  w = world();
  assert.equal(w.gesture.keyDown(key(), box), false);
  assert.equal(w.gesture.keyDown(key({ repeat: true }), box), true, 'la repeticion se traga');
  assert.equal(w.gesture.keyDown(key({ repeat: true }), box), true);
  assert.deepEqual(w.log, [], 'todavia no arranco');
  w.fire();
  assert.deepEqual(w.log, [['hold', { value: 'hola', start: 4 }]], 'arranca una vez, con el cuadro de antes del primer espacio');
  assert.equal(w.gesture.holding, true);
  assert.equal(w.gesture.keyDown(key({ repeat: true }), box), true, 'sigue tragando las repeticiones');
  w.gesture.keyUp({ key: ' ' });
  assert.deepEqual(w.log, [['hold', { value: 'hola', start: 4 }], ['release']]);
  assert.equal(w.gesture.holding, false);
  assert.equal(w.gesture.keyDown(key({ repeat: true }), box), false, 'sin gesto, las repeticiones pasan');

  // Soltado despues de las repeticiones pero antes del tiempo: no arranca ni suelta nada.
  w = world();
  w.gesture.keyDown(key(), box);
  assert.equal(w.gesture.keyDown(key({ repeat: true }), box), true);
  w.gesture.keyUp({ key: ' ' });
  assert.deepEqual(w.log, []);
  assert.equal(w.scheduled, null);

  // Sin voz disponible, el espacio es solo un espacio: ni se arma ni se traga nada.
  w = world(false);
  assert.equal(w.gesture.keyDown(key(), box), false);
  assert.equal(w.scheduled, null);
  assert.equal(w.gesture.keyDown(key({ repeat: true }), box), false);

  // Con modificadores, con el IME, con una seleccion o con otra tecla: nada.
  for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }, { key: 'a' }]) {
    w = world();
    assert.equal(w.gesture.keyDown(key(extra), box), false);
    assert.equal(w.scheduled, null, `no arma con ${JSON.stringify(extra)}`);
  }
  w = world();
  assert.equal(w.gesture.keyDown(key(), { value: 'hola', start: 0, end: 4 }), false);
  assert.equal(w.scheduled, null, 'con texto seleccionado el espacio lo reemplaza: no se arma');

  // Cancelar (se perdio el foco, o la voz termino por otro lado) deja todo como al principio.
  w = world();
  w.gesture.keyDown(key(), box);
  w.fire();
  w.gesture.cancel();
  w.gesture.keyUp({ key: ' ' });
  assert.deepEqual(w.log, [['hold', { value: 'hola', start: 4 }]], 'cancelado: soltar ya no suelta nada');
  assert.equal(w.gesture.holding, false);

  // Un segundo toque sin haber soltado el primero (se perdio el keyup) vuelve a armar con lo de ahora.
  w = world();
  w.gesture.keyDown(key(), box);
  w.gesture.keyDown(key(), { value: 'hola ', start: 5, end: 5 });
  w.fire();
  assert.deepEqual(w.log, [['hold', { value: 'hola ', start: 5 }]]);

  // Y despues de soltar se puede volver a mantener.
  w.gesture.keyUp({ key: ' ' });
  w.gesture.keyDown(key(), box);
  w.fire();
  assert.equal(w.log.filter((entry) => entry[0] === 'hold').length, 2);
}

{
  // Enviar solo aparece con algo para enviar; Detener, con el agente trabajando.
  const buttons = (alive, activity, hasSomething) => composerButtons({ alive, activity, hasSomething });
  assert.deepEqual(buttons(true, 'idle', false), { showStop: false, showSend: false }, 'cuadro vacio y agente quieto: ni Enviar apagado');
  assert.deepEqual(buttons(true, 'idle', true), { showStop: false, showSend: true });
  assert.deepEqual(buttons(true, 'working', false), { showStop: true, showSend: false });
  assert.deepEqual(buttons(true, 'working', true), { showStop: true, showSend: true });
  assert.deepEqual(buttons(false, 'idle', true), { showStop: false, showSend: true }, 'sin CLI viva se ve, apagado por el cuadro');
  assert.deepEqual(buttons(true, undefined, false), { showStop: true, showSend: false }, 'actividad sin saber: Detener, como siempre');

  // El lugar de la derecha sale de los botones que pueden aparecer, no de los que se ven ahora:
  // asi el texto no salta al escribir la primera letra.
  assert.equal(actionSlots({ voiceButtons: 0, stop: false, suggestion: false }), 1, 'solo el lugar de Enviar');
  assert.equal(actionSlots({ voiceButtons: 0, stop: true, suggestion: false }), 2);
  assert.equal(actionSlots({ voiceButtons: 1, stop: false, suggestion: false }), 2);
  assert.equal(actionSlots({ voiceButtons: 1, stop: true, suggestion: false }), 3);
  assert.equal(actionSlots({ voiceButtons: 2, stop: false, suggestion: false }), 3, 'Antigravity: microfono y rayitas, uno al lado del otro');
  assert.equal(actionSlots({ voiceButtons: 0, stop: false, suggestion: true }), 2);

  // Cual de los botones es el de mantener apretado, y que modo arranca Espacio mantenido.
  assert.equal(isHoldControl('claude-hold-space'), true);
  assert.equal(isHoldControl('antigravity-dictation'), true);
  assert.equal(isHoldControl('antigravity-live'), false);
  assert.equal(isHoldControl('codex-live-f8'), false);
  assert.equal(isHoldControl(undefined), false);
  assert.equal(spaceHoldMode(claude.modes), 'dictation');
  assert.equal(spaceHoldMode(antigravity.modes), 'dictation', 'con los dos modos, Espacio dicta');
  assert.equal(spaceHoldMode([...antigravity.modes].reverse()), 'dictation', 'sin importar el orden');
  assert.equal(spaceHoldMode(codex.modes), 'live', 'Codex solo tiene la voz en vivo');
  assert.equal(spaceHoldMode([]), null);
}

console.log('Capacidades de voz nativa, versiones, secuencias de PTY, liberación por socket, dictado al cuadro y gesto de Espacio: todo bien.');
