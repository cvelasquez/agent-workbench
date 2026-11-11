// Contrato HTTP medido con @opencode/client 2.2.7, sin red ni datos del usuario.
// Ejecutar: pnpm --filter @agent-workbench/server exec tsx scripts/check-opencode-v2-client.mjs
import assert from 'node:assert/strict';
import { OpenCodeServeClient, parseGlobalEvent, ServeAuthError, ServeRequestError } from '../src/agents/opencode/serve-client.ts';

const sessionId = 'ses_012345678901234567890123';
const otherId = 'ses_987654321098765432109876';
const directory = 'D:\\Test Project';
const endpoint = { url: 'http://127.0.0.1:43210', username: 'opencode', password: 'temporary-test-password', protocol: 2 };
const calls = [];
let response = {};
const fakeFetch = async (input, init) => {
  calls.push({ url: new URL(String(input)), init, body: init.body === undefined ? undefined : JSON.parse(init.body) });
  return response instanceof Response ? response : Response.json(response);
};
const client = new OpenCodeServeClient(endpoint, fakeFetch);
const last = () => calls.at(-1);
let checks = 0;
const check = (name, assertion) => { assertion(); checks++; console.log(`ok ${checks}: ${name}`); };
const form = {
  id: 'form_test', sessionID: sessionId, title: 'Questions',
  metadata: { kind: 'question', tool: { messageID: 'message_test', id: 'call_test' } },
  fields: [
    { key: 'q0', type: 'string', options: [{ value: 'value-a', label: 'Option A' }], custom: false },
    { key: 'q1', type: 'multiselect', options: [{ value: 'value-b', label: 'Option B' }], custom: true },
  ],
};

response = { data: { id: sessionId } };
const created = await client.createSession(directory);
check('crear usa location en el body y lee data.id', () => {
  assert.equal(created, sessionId);
  assert.equal(last().url.pathname, '/api/session');
  assert.deepEqual(last().body, { location: { directory } });
  assert.equal(last().url.search, '');
  assert.equal(last().init.headers.Authorization, `Basic ${Buffer.from('opencode:temporary-test-password').toString('base64')}`);
});

response = { data: { [sessionId]: { type: 'running' }, [otherId]: { type: 'running' } } };
const statuses = await client.sessionStatus(directory);
check('active.running se traduce a busy', () => {
  assert.deepEqual(statuses, { [sessionId]: 'busy', [otherId]: 'busy' });
  assert.equal(last().url.pathname, '/api/session/active');
  assert.equal(last().url.search, '');
});

response = { location: { directory }, data: [{ id: 'perm_test', sessionID: sessionId, metadata: { private: 'discard' } }] };
const permissions = await client.pendingPermissions(directory);
check('permisos conservan solo id y sesion con query deepObject', () => {
  assert.deepEqual(permissions, [{ id: 'perm_test', sessionID: sessionId }]);
  assert.equal(last().url.pathname, '/api/permission/request');
  assert.equal(last().url.searchParams.get('location[directory]'), directory);
  assert.equal(last().url.searchParams.has('directory'), false);
});

response = { location: { directory }, data: [form, { id: 'generic', sessionID: sessionId, title: 'Form', fields: [{ key: 'age', type: 'number' }] }] };
const questions = await client.pendingQuestions(directory);
check('question nativa conserva enlace tool y forms generales bloquean envio', () => {
  assert.equal(last().url.pathname, '/api/form');
  assert.equal(last().url.searchParams.get('location[directory]'), directory);
  assert.deepEqual(questions[0].tool, { messageID: 'message_test', callID: 'call_test' });
  assert.deepEqual(questions[0].questions, [
    { options: [{ label: 'Option A' }], multiple: false, custom: false },
    { options: [{ label: 'Option B' }], multiple: true, custom: true },
  ]);
  assert.deepEqual(questions[1], { id: 'generic', sessionID: sessionId, questions: [], tool: null });
});

response = new Response(null, { status: 204 });
await client.replyQuestion(directory, 'form_test', [['Option A'], ['Option B', 'custom answer']]);
check('reply convierte etiquetas a valores y conserva keys/tipos', () => {
  assert.equal(last().url.pathname, `/api/session/${sessionId}/form/form_test/reply`);
  assert.deepEqual(last().body, { answer: { q0: 'value-a', q1: ['value-b', 'custom answer'] } });
  assert.equal(last().url.search, '');
});

let before = calls.length;
await assert.rejects(client.replyQuestion(directory, 'generic', [['42']]), ServeRequestError);
await assert.rejects(client.replyQuestion('D:\\Other', 'form_test', [['Option A'], []]), ServeRequestError);
check('form general y carpeta ajena nunca envian respuesta', () => assert.equal(calls.length, before));

response = { location: { directory }, data: [form] };
await client.pendingQuestions(directory);
before = calls.length;
await assert.rejects(client.replyQuestion(directory, 'form_test', [['invalid'], []]), ServeRequestError);
await assert.rejects(client.replyQuestion(directory, 'form_test', [['Option A', 'Option A'], []]), ServeRequestError);
check('respuesta invalida o multiple en campo simple no envia POST', () => assert.equal(calls.length, before));

response = new Response(null, { status: 204 });
await client.replyQuestion(directory, 'form_test', [[], []]);
check('omitir preguntas deja ausentes las keys de respuesta', () => assert.deepEqual(last().body, { answer: {} }));

response = { location: { directory }, data: [] };
await client.pendingQuestions(directory);
before = calls.length;
await assert.rejects(client.replyQuestion(directory, 'form_test', [['Option A'], []]), ServeRequestError);
check('una foto nueva descarta forms que ya no estan pendientes', () => assert.equal(calls.length, before));

response = { interrupted: true };
await client.abort(directory, sessionId);
check('interrupt reemplaza abort sin reanudar trabajo', () => {
  assert.equal(last().url.pathname, `/api/session/${sessionId}/interrupt`);
  assert.deepEqual(last().body, { resume: false });
});

response = { data: { id: 'inbox_test' } };
assert.equal(await client.promptAsync(directory, sessionId, 'no hagas nada, responde ok', { agent: 'previous', providerID: 'provider', modelID: 'model', variant: 'old' }), 'sent');
check('prompt V2 hereda agente/modelo de sesion y conserva cola', () => {
  assert.equal(last().url.pathname, `/api/session/${sessionId}/prompt`);
  assert.deepEqual(last().body, { text: 'no hagas nada, responde ok', delivery: 'queue' });
});
response = new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
const missingSession = await client.promptAsync(directory, sessionId, 'ok', null);
check('una sesion ausente no se declara enviada', () => assert.equal(missingSession, 'not-sent'));

response = new Response(null, { status: 204 });
await client.moveSession(directory, sessionId, 'D:\\Target');
check('move usa la ruta y el cuerpo de V2', () => {
  assert.equal(last().url.pathname, `/api/session/${sessionId}/move`);
  assert.deepEqual(last().body, { directory: 'D:\\Target', delivery: 'queue' });
});

const event = (type, data, location = { directory }) => JSON.stringify({ id: 'event_test', created: 1, type, data, ...(location === null ? {} : { location }) });
check('eventos V2 se normalizan al contrato interno', () => {
  assert.deepEqual(parseGlobalEvent(event('session.execution.started', { sessionID: sessionId }, null), 2), { type: 'session.status', directory: '', sessionId, status: 'busy' });
  for (const type of ['session.execution.succeeded','session.execution.failed','session.execution.interrupted']) {
    assert.deepEqual(parseGlobalEvent(event(type, { sessionID: sessionId }, null), 2), { type: 'session.status', directory: '', sessionId, status: 'idle' });
  }
  assert.deepEqual(parseGlobalEvent(event('session.status', { sessionID: sessionId, status: { type: 'busy' } }), 2), { type: 'session.status', directory, sessionId, status: 'busy' });
  assert.deepEqual(parseGlobalEvent(event('session.idle', { sessionID: sessionId }, null), 2), { type: 'session.status', directory: '', sessionId, status: 'idle' });
  assert.deepEqual(parseGlobalEvent(event('permission.asked', { id: 'perm', sessionID: sessionId }), 2), { type: 'permission.asked', directory, sessionId, requestId: 'perm' });
  assert.deepEqual(parseGlobalEvent(event('permission.replied', { requestID: 'perm', sessionID: sessionId }), 2), { type: 'permission.replied', directory, sessionId, requestId: 'perm' });
  assert.deepEqual(parseGlobalEvent(event('form.created', { form }), 2), { type: 'question.asked', directory, sessionId, requestId: 'form_test' });
  assert.deepEqual(parseGlobalEvent(event('form.replied', { id: 'form_test', sessionID: sessionId, answer: {} }), 2), { type: 'question.replied', directory, sessionId, requestId: 'form_test' });
  assert.deepEqual(parseGlobalEvent(event('form.cancelled', { id: 'form_test', sessionID: sessionId }), 2), { type: 'question.rejected', directory, sessionId, requestId: 'form_test' });
  assert.equal(parseGlobalEvent(event('session.status', { status: { type: 'busy' } }), 2), null);
  assert.equal(parseGlobalEvent(event('unknown', { sessionID: sessionId }), 2), null);
});

let resolveEvent;
const received = new Promise((resolve, reject) => {
  resolveEvent = resolve;
  const timeout = setTimeout(() => reject(new Error('No llego el evento SSE')), 2_000);
  resolveEvent = (value) => { clearTimeout(timeout); resolve(value); };
});
let sseRequest;
const sseClient = new OpenCodeServeClient(endpoint, async (url, init) => {
  sseRequest = { url: new URL(String(url)), init };
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(`data: ${event('session.execution.succeeded', { sessionID: sessionId }, null)}\r\n\r\n`));
  } }), { headers: { 'content-type': 'text/event-stream' } });
});
const closeEvents = sseClient.events((value) => resolveEvent(value), () => {});
const receivedEvent = await received;
closeEvents();
check('flujo SSE usa /api/event y aplica normalizacion', () => {
  assert.equal(sseRequest.url.pathname, '/api/event');
  assert.equal(receivedEvent.status, 'idle');
  assert.equal(sseRequest.init.signal.aborted, true);
});

response = new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
await assert.rejects(client.createSession(directory), ServeAuthError);
before = calls.length;
await assert.rejects(client.abort(directory, 'ses_bad&command'), /Invalid OpenCode session id/);
assert.equal(calls.length, before);
assert.throws(() => new OpenCodeServeClient({ ...endpoint, url: 'http://example.com:43210' }), /127\.0\.0\.1/);
check('rechaza autenticacion invalida, ids hostiles y servidor externo', () => assert.equal(calls.length, before));

response = { unexpected: [] };
before = calls.length;
await assert.rejects(client.sessionStatus(directory), ServeRequestError);
await assert.rejects(client.pendingPermissions(directory), ServeRequestError);
await assert.rejects(client.pendingQuestions(directory), ServeRequestError);
check('un contrato inesperado no deja la sesion falsamente libre', () => assert.equal(calls.length, before + 3));

response = { location: { directory }, data: [
  { ...form, id: 'conditional', fields: [{ ...form.fields[0], when: [{ key: 'other', op: 'eq', value: 'x' }] }] },
  { ...form, id: 'hidden', fields: [{ ...form.fields[0], hidden: true }] },
  { ...form, id: 'duplicate', fields: [{ ...form.fields[0], options: [{ label: 'Same', value: 'a' }, { label: 'Same', value: 'b' }] }] },
] };
const unsupportedForms = await client.pendingQuestions(directory);
check('campos condicionales, ocultos o ambiguos se responden en terminal', () => assert.deepEqual(unsupportedForms.map((item) => item.tool), [null, null, null]));

const v1 = new OpenCodeServeClient({ ...endpoint, protocol: undefined }, fakeFetch);
response = { id: sessionId };
assert.equal(await v1.createSession(directory), sessionId);
check('V1 conserva rutas/query/body originales', () => {
  assert.equal(last().url.pathname, '/session');
  assert.equal(last().url.searchParams.get('directory'), directory);
  assert.deepEqual(last().body, {});
  assert.deepEqual(parseGlobalEvent(JSON.stringify({ directory, payload: { type: 'session.status', properties: { sessionID: sessionId, status: { type: 'idle' } } } })), { type: 'session.status', directory, sessionId, status: 'idle' });
});

console.log(`${checks} comprobaciones correctas de OpenCode V2 y compatibilidad V1`);
