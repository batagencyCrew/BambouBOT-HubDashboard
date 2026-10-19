import test from 'node:test';
import assert from 'node:assert/strict';
import { reportChat, reportAIUsage, reportProxyError } from '../lib/telemetry.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const chat = { event_id: id, worker_id: id, msgs_in: 2, msgs_out: 3, links: 1, converted: false, duration: 4.5 };
const usage = { event_id: id, key_id: 'primary-alias', calls: 5, error_429: 1, error_502: 0, latency_ms: 12.5 };

test('opt-in helpers send exact whitelisted payloads through existing client', async () => {
  const calls = [];
  const api = { post: async (endpoint, payload) => { calls.push([endpoint, payload]); return { accepted: true }; } };
  assert.deepEqual(await reportChat(api, { ...chat, proxy_id: id, room: 'room-alias', random: false, token: 'must-not-send' }), { accepted: true });
  await reportChat(api, chat);
  await reportAIUsage(api, { ...usage, secret: 'must-not-send' });
  await reportProxyError(api, { worker_id: id, proxy_id: id, code: 'proxy_recovered', body: 'must-not-send' });
  assert.deepEqual(calls, [
    ['/chats', { ...chat, proxy_id: id, room: 'room-alias', random: false }],
    ['/chats', chat], ['/ai-usage', usage],
    ['/errors', { worker_id: id, proxy_id: id, code: 'proxy_recovered', level: 'error', message: 'Proxy status event' }],
  ]);
});

test('invalid values never send requests or echo secrets', () => {
  const api = { post: () => assert.fail('invalid payload sent') };
  for (const [key, value] of [['event_id', 'bad'], ['msgs_in', true], ['links', -1], ['converted', 1], ['duration', Infinity], ['duration', 604801], ['room', 'private@email.test'], ['random', 0], ['proxy_id', 'bad']]) assert.throws(() => reportChat(api, { ...chat, [key]: value }));
  for (const [key, value] of [['key_id', 'sk-private-secret'], ['key_id', 'slot-bbk_private'], ['key_id', 'Bearer private'], ['key_id', 'https://private'], ['calls', false], ['calls', 0], ['error_429', -1], ['error_502', 5], ['error_502', 1.2], ['latency_ms', NaN]]) {
    assert.throws(() => reportAIUsage(api, { ...usage, [key]: value }), e => !e.message.includes('private'));
  }
  assert.throws(() => reportProxyError(api, { worker_id: id, code: 'raw upstream body' }));
});

test('backend boundaries, nullable options and measured zero batches', async () => {
  const sent = [];
  const api = { post: async (endpoint, payload) => sent.push([endpoint, payload]) };
  await reportChat(api, { ...chat, duration: 604800, proxy_id: null, room: null, random: null });
  assert.deepEqual(sent[0], ['/chats', { ...chat, duration: 604800 }]);
  await reportChat(api, { ...chat, room: '9'.repeat(128) });
  await reportAIUsage(api, { ...usage, key_id: '9'.repeat(80), latency_ms: 1e20 });
  await reportAIUsage(api, { ...usage, calls: 0, error_429: 0, error_502: 0, latency_ms: 0 });
  assert.equal(sent.length, 4);
  assert.throws(() => reportChat(api, { ...chat, room: 'x'.repeat(129) }));
  assert.throws(() => reportAIUsage(api, { ...usage, key_id: 'x'.repeat(81) }));
});
