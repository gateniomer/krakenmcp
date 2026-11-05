// Unit tests for the built-in MCP server (src/mcp.js) and tool input schemas (src/schema.js).
// The e2e tests cover the same server end to end through the official SDK client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, PROTOCOL_VERSIONS } from '../../src/mcp.js';
import { str, num, int, bool, oneOf, list, obj, input, validate } from '../../src/schema.js';

function harness(opts = {}) {
  const sent = [];
  const server = createServer({ info: { name: 't', version: '0' }, instructions: 'hi', ...opts,
    out: { write: (s) => sent.push(JSON.parse(s)) } });
  let id = 0;
  const call = async (method, params) => { const i = ++id; await server.handle({ jsonrpc: '2.0', id: i, method, params }); return sent.find((m) => m.id === i); };
  return { server, sent, call };
}

test('initialize negotiates the protocol version and reports capabilities, info and instructions', async () => {
  const { call } = harness();
  const r = (await call('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'c' } })).result;
  assert.equal(r.protocolVersion, '2025-06-18');
  assert.deepEqual(r.capabilities, { tools: {}, resources: { subscribe: true }, logging: {} });
  assert.equal(r.instructions, 'hi');
  assert.equal((await call('initialize', { protocolVersion: '1999-01-01' })).result.protocolVersion, PROTOCOL_VERSIONS[0]);
  const off = harness({ tools: false });
  assert.deepEqual((await off.call('initialize', {})).result.capabilities, { logging: {} });
  assert.equal((await off.call('tools/list')).error.code, -32601, 'a tool-less server has no tools methods');
});

test('tools: list, validated call, tool errors as isError, unknown tools and methods as JSON-RPC errors', async () => {
  const { server, call } = harness();
  server.tool('echo', { description: 'd', input: { x: str({ required: true }), n: num({ default: 2 }) } }, (args) =>
    ({ content: [{ type: 'text', text: JSON.stringify(args) }] }));
  const [t] = (await call('tools/list')).result.tools;
  assert.deepEqual(t, { name: 'echo', description: 'd',
    inputSchema: { type: 'object', properties: { x: { type: 'string' }, n: { type: 'number', default: 2 } }, required: ['x'] } });
  assert.equal((await call('tools/call', { name: 'echo', arguments: { x: 'a', junk: 1 } })).result.content[0].text, '{"x":"a","n":2}');
  const bad = (await call('tools/call', { name: 'echo', arguments: {} })).result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /arguments\.x is required/);
  assert.equal((await call('tools/call', { name: 'nope' })).error.code, -32602);
  assert.equal((await call('frobnicate')).error.code, -32601);
  assert.deepEqual((await call('ping')).result, {});
});

test('progress goes to the caller\'s token; logs respect logging/setLevel; resources match their template', async () => {
  const { server, sent, call } = harness();
  server.tool('slow', { description: '', input: {} }, (_, { progress }) => { progress?.(1, 'half'); return { content: [] }; });
  await call('tools/call', { name: 'slow', arguments: {}, _meta: { progressToken: 'tok' } });
  assert.deepEqual(sent.find((m) => m.method === 'notifications/progress').params, { progressToken: 'tok', progress: 1, message: 'half' });

  server.log('debug', 'k', 'hidden');
  server.log('info', 'k', 'shown');
  assert.deepEqual(sent.filter((m) => m.method === 'notifications/message').map((m) => m.params.data), ['shown']);
  assert.equal((await call('logging/setLevel', { level: 'loud' })).error.code, -32602);

  server.resourceTemplate({ uriTemplate: 'k://run/{id}', name: 'run', match: /^k:\/\/run\/(?<id>\w+)$/,
    read: (uri, { id }) => { if (id === 'missing') throw new Error('no run'); return { uri, text: id }; } });
  assert.deepEqual((await call('resources/templates/list')).result.resourceTemplates, [{ uriTemplate: 'k://run/{id}', name: 'run' }]);
  assert.equal((await call('resources/read', { uri: 'k://run/abc' })).result.contents[0].text, 'abc');
  assert.match((await call('resources/read', { uri: 'k://run/missing' })).error.message, /no run/);
  assert.match((await call('resources/read', { uri: 'k://other' })).error.message, /unknown resource/);
  let seen;
  server.onSubscribe = (u) => { seen = u; };
  await call('resources/subscribe', { uri: 'k://run/abc' });
  assert.equal(seen, 'k://run/abc');
  assert.ok(server.isSubscribed('k://run/abc'));
  await call('resources/unsubscribe', { uri: 'k://run/abc' });
  assert.ok(!server.isSubscribed('k://run/abc'));
});

test('notifications and stray responses get no reply; malformed requests get invalid request', async () => {
  const { server, sent } = harness();
  await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await server.handle({ jsonrpc: '2.0', id: 9, result: {} });
  assert.equal(sent.length, 0);
  await server.handle({ id: 3, method: 'ping' });
  assert.deepEqual(sent[0], { jsonrpc: '2.0', id: 3, error: { code: -32600, message: 'invalid request' } });
});

test('schemas: helpers build JSON Schema; validate fills defaults, drops unknown keys, rejects bad values', () => {
  const schema = input({
    id: str({ required: true, description: 'd' }), n: int({ min: 0, max: 5, default: 1 }), f: bool(),
    kind: oneOf(['a', 'b']), ids: list(str(), { maxItems: 2 }), m: str({ nullable: true }),
    stage: obj({ model: str() }),
  });
  assert.deepEqual(schema.required, ['id']);
  assert.deepEqual(schema.properties.m.type, ['string', 'null']);
  assert.deepEqual(JSON.parse(JSON.stringify(schema.properties.stage)), { type: 'object', properties: { model: { type: 'string' } } });
  assert.deepEqual(validate(schema, { id: 'x', m: null, stage: { model: 'o', extra: 1 }, junk: true }),
    { id: 'x', n: 1, m: null, stage: { model: 'o' } });
  for (const [args, re] of [[{}, /id is required/], [{ id: 1 }, /id must be string/], [{ id: 'x', n: 1.5 }, /n must be integer/],
    [{ id: 'x', n: 9 }, /n must be <= 5/], [{ id: 'x', n: -1 }, /n must be >= 0/], [{ id: 'x', kind: 'c' }, /one of a, b/],
    [{ id: 'x', ids: ['a', 'b', 'c'] }, /at most 2/], [{ id: 'x', ids: [1] }, /ids\[0\] must be string/], [{ id: 'x', f: 'yes' }, /f must be boolean/]]) {
    assert.throws(() => validate(schema, args), re);
  }
});

test('when stdin closes, requests already received are still answered before the server exits', async () => {
  const { Readable, Writable } = await import('node:stream');
  const sent = [];
  const out = new Writable({ write(chunk, _, cb) { if (chunk.length) sent.push(JSON.parse(chunk)); cb(); } });
  const server = createServer({ info: { name: 't', version: '0' }, out });
  server.tool('slow', { description: '', input: {} }, async () => { await new Promise((r) => setTimeout(r, 50)); return { content: [] }; });
  const exit = process.exit;
  const exited = new Promise((r) => { process.exit = r; });
  try {
    server.start(Readable.from(['{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"slow","arguments":{}}}\n']));
    assert.equal(await exited, 0);
  } finally { process.exit = exit; }
  assert.deepEqual(sent.map((m) => m.id), [1], 'the slow call was answered before exit');
});
