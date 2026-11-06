import assert from 'node:assert/strict';
import { parseAgentCapabilities } from '@agent-workbench/shared';
import { NativeVoiceController } from '../src/native-voice.ts';
import {
  CLAUDE_CODE_NATIVE_VOICE,
  CLAUDE_CODE_VOICE_STARTUP_DIALOG,
  claudeCapabilitiesForVersion,
  supportsClaudeNativeVoiceVersion,
} from '../src/agents/claude-code/index.ts';
import {
  ANTIGRAVITY_NATIVE_VOICE,
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

console.log('Capacidades de voz nativa, versiones, secuencias de PTY y liberación por socket: todo bien.');
