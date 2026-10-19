import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConfigSync } from '../lib/config.mjs';

test('documented Node env-file opt-in preserves exported environment precedence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-env-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '.env'), 'HUB_URL=https://file.example\nHUB_AGENT_TOKEN=file-token\n');
  const options = { cwd: dir, env: { PATH: process.env.PATH, HUB_AGENT_TOKEN: 'exported-token' } };
  const script = 'console.log(JSON.stringify([process.env.HUB_URL ?? null, process.env.HUB_AGENT_TOKEN]))';
  const plain = await promisify(execFile)(process.execPath, ['-e', script], options);
  assert.deepEqual(JSON.parse(plain.stdout), [null, 'exported-token']);
  const loaded = await promisify(execFile)(process.execPath, ['--env-file=.env', '-e', script], options);
  assert.deepEqual(JSON.parse(loaded.stdout), ['https://file.example', 'exported-token']);
});

test('extras stay local across enrollment, clearing and checkpoint loss; no secret discovery', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-local-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'config.json');
  const extras = { password: 'local-secret', nested: { list: [true, null, 3] }, __unmanaged: 'value' };
  await fs.writeFile(file, JSON.stringify({ ...extras, ai_api_key: 'seed', number_of_workers: 2 }));
  await fs.writeFile(path.join(dir, '.env'), 'SECRET=env-secret\n');
  await fs.writeFile(path.join(dir, 'automation-settings.json'), '{"secret":"other-secret"}');
  let hub = { revision: 0, local_sync_initialized: false, number_of_workers: 0, ai_api_key: '', ai_preset_id: '', proxies: [] };
  const posts = [];
  const api = { request: async () => hub, post: async (_, payload) => {
    posts.push(payload);
    hub = { ...hub, revision: hub.revision + 1, local_sync_initialized: true };
    return hub;
  } };
  const sync = new ConfigSync(api, dir);
  await sync.refresh();
  assert.deepEqual(posts, [{ expected_revision: 0, config: { ai_api_key: 'seed', number_of_workers: 2 } }]);
  await sync.refresh();
  await fs.unlink(path.join(dir, '.sync.json'));
  await sync.refresh();
  assert.deepEqual(posts[1], { expected_revision: 1 });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const key of Object.keys(extras)) assert.deepEqual(saved[key], extras[key]);
  assert.equal(saved.ai_api_key, '');
  assert.equal(saved.number_of_workers, 0);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

for (const invalid of ['{secret', '[]', 'null', '"secret"']) {
  test(`invalid existing JSON blocks publication: ${invalid}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-local-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const originals = { 'config.json': invalid, 'proxies.txt': 'keep', '.sync.json': '{"initialized":true,"revision":1}' };
    for (const [name, content] of Object.entries(originals)) await fs.writeFile(path.join(dir, name), content);
    const api = { request: async () => ({ revision: 2, local_sync_initialized: true, number_of_workers: 0, proxies: [] }), post: async () => assert.fail('unexpected upload') };
    await assert.rejects(new ConfigSync(api, dir).refresh(), /files preserved/);
    for (const [name, content] of Object.entries(originals)) assert.equal(await fs.readFile(path.join(dir, name), 'utf8'), content);
  });
}
