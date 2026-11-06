'use strict';

/** BambouAI client: retry policy, re-login, one-PUT read-modify-write. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { BambouStudio, BambouError } = require('../src/clients/bambou');
const { bambouServer } = require('./helpers');

function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: init.method, url: String(url) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status, headers: next.headers || {} });
  };
  return { calls, fetchImpl };
}

test('reads are retried on 5xx/network errors; mutations are never replayed', async () => {
  const reads = scripted([{ status: 503, body: { error: 'busy' } }, new Error('ECONNRESET'), { status: 200, body: { keys: [] } }]);
  const studio = new BambouStudio({ baseUrl: 'http://mock', maxRetries: 2, fetchImpl: reads.fetchImpl });
  assert.deepEqual(await studio.listApiKeys(), []);
  assert.equal(reads.calls.length, 3);

  for (const [method, call] of [
    ['POST', (s) => s.createApiKey({ label: 'x' })],
    ['PATCH', (s) => s.updateApiKey('ak_1', { rpm: 1 })],
    ['DELETE', (s) => s.revokeApiKey('ak_1')],
    ['PUT', (s) => s.saveConfig({ presets: [], accounts: [] })],
  ]) {
    const writes = scripted([{ status: 503, body: { error: 'Injected 503' } }, { status: 200, body: {} }]);
    const s = new BambouStudio({ baseUrl: 'http://mock', maxRetries: 2, fetchImpl: writes.fetchImpl });
    await assert.rejects(call(s), (error) => error instanceof BambouError && error.status === 503);
    assert.equal(writes.calls.length, 1, `${method} sent exactly once`);
  }
  const network = scripted([new Error('socket hang up'), { status: 201, body: {} }]);
  const s = new BambouStudio({ baseUrl: 'http://mock', maxRetries: 2, fetchImpl: network.fetchImpl });
  await assert.rejects(s.createApiKey({ label: 'x' }), /Network error: socket hang up/);
  assert.equal(network.calls.length, 1);
});

test('a lost session triggers one re-login, then the request is repeated', async () => {
  const flow = scripted([
    { status: 401, body: { error: 'Session required' } },
    { status: 200, body: { authenticated: true }, headers: { 'Set-Cookie': 'bambou_session=new; Path=/' } },
    { status: 200, body: { keys: [{ id: 'ak_1' }] } },
  ]);
  const studio = new BambouStudio({ baseUrl: 'http://mock', loginKey: 'k', fetchImpl: flow.fetchImpl });
  assert.deepEqual(await studio.listApiKeys(), [{ id: 'ak_1' }]);
  assert.deepEqual(flow.calls.map((c) => c.method), ['GET', 'POST', 'GET']);
});

test('updateConfig is one GET + one PUT and serialises concurrent writers', async (t) => {
  const mock = await bambouServer(t);
  const studio = mock.studio();
  await studio.login();
  await Promise.all([
    studio.updateConfig((c) => { c.presets[0].name = 'A'; }),
    studio.updateConfig((c) => { c.presets[0].identity.name = 'B'; }),
  ]);
  assert.equal(mock.puts, 2);
  assert.equal(mock.db.presets[0].name, 'A');
  assert.equal(mock.db.presets[0].identity.name, 'B', 'second writer saw the first write');
  await assert.rejects(studio.updateConfig(() => ({})), /must keep the presets/);
});
