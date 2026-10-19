import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

test('real worker hook receives heartbeat slot UUID on spawn and config updates without a hub token', async t => {
  const originalToken = process.env.HUB_AGENT_TOKEN;
  process.env.HUB_AGENT_TOKEN = 'supervisor-only-test-token';
  t.after(() => {
    if (originalToken === undefined) delete process.env.HUB_AGENT_TOKEN;
    else process.env.HUB_AGENT_TOKEN = originalToken;
  });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-hook-context-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'lib'));
  // Exercise production supervisor/worker modules with a locally supplied hook.
  for (const file of ['lib/supervisor.mjs', 'lib/storage.mjs', 'worker.mjs']) {
    await fs.copyFile(new URL(`../${file}`, import.meta.url), path.join(dir, file));
  }
  await fs.writeFile(path.join(dir, 'hooks.mjs'), `
    export async function performTask({ config, signal, workerId }) {
      process.send({ type: 'hook-observation', workerId, revision: config.revision,
        tokenPresent: Object.hasOwn(process.env, 'HUB_AGENT_TOKEN'),
        aborted: signal.aborted });
      return false;
    }
  `);
  const { Supervisor } = await import(pathToFileURL(path.join(dir, 'lib/supervisor.mjs')));
  const pool = new Supervisor(path.join(dir, 'state'));
  t.after(() => pool.action('stop'));
  await pool.init();
  await pool.configure({ number_of_workers: 1, revision: 1 });
  await pool.action('start');
  const workerId = pool.snapshot()[0].id;
  const child = pool.children.get(workerId).process;
  const pid = child.pid;
  const observations = [];
  child.on('message', message => { if (message.type === 'hook-observation') observations.push(message); });
  async function waitForRevision(revision) {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const message = observations.find(event => event.revision === revision);
      if (message) return message;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`worker hook did not observe revision ${revision}`);
  }
  assert.deepEqual(await waitForRevision(1), {
    type: 'hook-observation', workerId, revision: 1, tokenPresent: false, aborted: false,
  });
  await pool.configure({ number_of_workers: 1, revision: 2 });
  assert.deepEqual(await waitForRevision(2), {
    type: 'hook-observation', workerId, revision: 2, tokenPresent: false, aborted: false,
  });
  assert.equal(pool.snapshot()[0].id, workerId);
  assert.equal(pool.children.get(workerId).process.pid, pid);
});
