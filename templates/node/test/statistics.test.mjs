import test from 'node:test';
import assert from 'node:assert/strict';
import { API } from '../lib/api.mjs';

test('statistics uses authenticated request path and exact absolute payload', async () => {
  const api = new API('https://hub.example', 'site-token');
  for (const [links, average] of [[0, null], [0, 0], [9007199254740991, 1_000_000_000], [12, 2.5]]) {
    let calls = 0;
    api.request = async (path, options) => {
      calls++;
      assert.equal(path, '/statistics');
      assert.deepEqual(options, { method: 'POST', json: {
        links_sent_successfully: links, average_messages_per_chat: average,
      } });
      return { site_id: 'site' };
    };
    assert.deepEqual(await api.reportStatistics(links, average), { site_id: 'site' });
    assert.equal(calls, 1);
  }
});

test('invalid statistics never makes a request', () => {
  const api = new API('https://hub.example', 'site-token');
  api.request = () => assert.fail('invalid snapshot reached API');
  for (const links of [-1, true, false, 1.5, 9007199254740992, NaN, Infinity, -Infinity, null, undefined, '1', 1n]) {
    assert.throws(() => api.reportStatistics(links, null), TypeError);
  }
  for (const average of [-1, true, false, NaN, Infinity, -Infinity, 1_000_000_001, undefined, '1', 1n]) {
    assert.throws(() => api.reportStatistics(1, average), TypeError);
  }
  assert.throws(() => api.reportStatistics(), TypeError);
});
