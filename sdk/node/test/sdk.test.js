'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { Hub, proxyKey, uuid5 } = require('../src/index.js');

function fakeAgent() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhub-'));
  const socketPath = path.join(dir, 'agent.sock');
  const received = [];
  const clients = [];
  const server = net.createServer((sock) => {
    clients.push(sock);
    let buffer = '';
    sock.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        received.push(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
  });
  return new Promise((resolve) => server.listen(socketPath, () => resolve({ socketPath, received, clients, server })));
}

test('uuid5 matches the Python SDK', () => {
  // Python: uuid.uuid5(uuid.UUID('7d6f2a62-8f3c-4d8e-9a43-3b9c1e0b5a10'), 'local:worker-1')
  assert.strictEqual(uuid5('local:worker-1'), '1d6778e2-ae9a-5c69-8f42-7e20114b60be');
  assert.match(uuid5('x'), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('proxyKey ignores password and accepts host:port:user:pass', () => {
  assert.strictEqual(proxyKey('http://bob:one@1.2.3.4:80'), proxyKey('http://bob:two@1.2.3.4:80'));
  assert.strictEqual(proxyKey('1.2.3.4:80:bob:pw'), proxyKey('http://bob:pw@1.2.3.4:80'));
});

test('costs aggregate locally and summarise', async () => {
  const hub = new Hub();
  hub.configure({ flushInterval: 60000 });
  hub.setPrice('capsolver', 0.001, { unit: 'solve' });
  hub.addCost(null, { provider: 'capsolver', category: 'captcha' });
  hub.addCost(null, { provider: 'capsolver', category: 'captcha', quantity: 2 });
  hub.addCost(0.02, { provider: 'openai', category: 'ai', meta: { model: 'x' } });
  assert.deepStrictEqual(hub.costSummary(), { USD: { capsolver: 0.003, openai: 0.02 } });
  const batch = hub._drain();
  assert.strictEqual(batch.costs.length, 2);
  const cap = batch.costs.find((c) => c.provider === 'capsolver');
  assert.strictEqual(cap.amount, 0.003);
  assert.strictEqual(cap.meta.aggregated, 2);
  assert.throws(() => hub.addCost(null, { provider: 'unknown' }), /no price set/);
  assert.throws(() => hub.addCost(-1, { provider: 'x' }), /non-negative/);
  await hub.close();
});

test('socket transport: batches, commands and acks', async () => {
  const agent = await fakeAgent();
  const hub = new Hub();
  hub.configure({ socketPath: agent.socketPath, flushInterval: 60000 });
  const w = hub.worker('worker-1');
  w.running();
  w.log.error('login failed', { attempt: 2 });
  hub.count('links_sent', 3, { worker: w });
  hub.onCommand('refresh', async (args) => `refreshed ${args.n}`, { description: 'Refresh cookies' });
  assert.ok(await hub.flush());
  await new Promise((r) => setTimeout(r, 50));
  const batch = agent.received.find((m) => m.type === 'batch');
  assert.strictEqual(batch.logs[0].worker_name, 'worker-1');
  assert.strictEqual(batch.metrics[0].value, 3);
  assert.strictEqual(batch.presence.workers[0].status, 'running');
  assert.strictEqual(batch.presence.capabilities.commands[0].name, 'refresh');
  agent.clients[0].write(`${JSON.stringify({ type: 'command', command_id: 'c1', action: 'custom:refresh', args: { n: 2 } })}\n`);
  agent.clients[0].write(`${JSON.stringify({ type: 'command', command_id: 'c2', action: 'pause', args: {} })}\n`);
  await new Promise((r) => setTimeout(r, 100));
  assert.strictEqual(hub.paused, true);
  await hub.flush();
  await new Promise((r) => setTimeout(r, 50));
  const acks = agent.received.flatMap((m) => m.acks || []);
  assert.deepStrictEqual(acks.map((a) => [a.command_id, a.status]).sort(), [['c1', 'completed'], ['c2', 'completed']]);
  assert.strictEqual(acks.find((a) => a.command_id === 'c1').message, 'refreshed 2');
  await hub.close();
  agent.server.close();
});

test('failed flush keeps data for the next attempt', async () => {
  const hub = new Hub();
  hub.configure({ socketPath: '/nonexistent/agent.sock', flushInterval: 60000 });
  hub.info('kept');
  hub.addCost(1, { provider: 'p' });
  assert.strictEqual(await hub.flush(), false);
  assert.strictEqual(hub.queues.logs.length, 1);
  assert.strictEqual(hub.costs.individual.length, 1);
  await hub.close();
});
