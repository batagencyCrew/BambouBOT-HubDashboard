import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { API, HttpError, origin } from '../lib/api.mjs';
import { ConfigSync, proxyText, validateProxy } from '../lib/config.mjs';
import { Supervisor } from '../lib/supervisor.mjs';
import { archive, Backups, uploadFile } from '../lib/backup.mjs';
import { privateDir, readJSON, writeJSON } from '../lib/storage.mjs';

async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hub-node-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const config = (extra = {}) => ({ revision: 1, local_sync_initialized: false, number_of_workers: 1, ai_api_key: '', ai_preset_id: '', proxies: [], ...extra });

test('origin enforces HTTPS, loopback exception and no credentials/path', () => {
  assert.equal(origin('https://example.org'), 'https://example.org');
  assert.equal(origin('http://localhost:8000'), 'http://localhost:8000');
  for (const url of ['http://example.org', 'https://user:secret@example.org', 'https://example.org/path', 'https://example.org/?secret=x']) assert.throws(() => origin(url));
});

test('first enrollment imports existing runtime, then authoritative clearing survives checkpoint loss', async t => {
  const dir = await temporary(t);
  await writeJSON(path.join(dir, 'config.json'), { ai_api_key: 'local', number_of_workers: 2, revision: 999, captcha_api_key: 'ignored' });
  await fs.writeFile(path.join(dir, 'proxies.txt'), '# comment\nhttp://user:pass@localhost:8080\n');
  let hub = config(); const payloads = [];
  const api = { request: async () => hub, post: async (endpoint, payload) => {
    payloads.push(payload);
    hub = config({ ...payload.config, revision: 2, local_sync_initialized: true }); return hub;
  } };
  const sync = new ConfigSync(api, dir);
  await sync.refresh();
  assert.deepEqual(payloads[0].config, { ai_api_key: 'local', number_of_workers: 2 });
  assert.equal(payloads[0].proxies_content, 'http://user:pass@localhost:8080\n');
  assert.equal((await fs.stat(path.join(dir, 'config.json'))).mode & 0o777, 0o600);
  hub = config({ revision: 3, local_sync_initialized: true, ai_api_key: '' });
  await sync.refresh();
  assert.equal((await readJSON(path.join(dir, 'config.json'))).ai_api_key, '');
  assert.equal(await fs.readFile(path.join(dir, 'proxies.txt'), 'utf8'), '');
  await fs.unlink(path.join(dir, '.sync.json'));
  await fs.writeFile(path.join(dir, 'proxies.txt'), 'http://stale:1234\n');
  api.post = async (_, payload) => { assert.deepEqual(payload, { expected_revision: 3 }); return hub; };
  await sync.refresh();
  assert.equal(await fs.readFile(path.join(dir, 'proxies.txt'), 'utf8'), '');
});

test('revision conflict retries once without local data; invalid import leaves local files intact', async t => {
  const dir = await temporary(t); let posts = 0;
  await writeJSON(path.join(dir, 'config.json'), { number_of_workers: 3 });
  const api = { request: async () => config({ revision: posts ? 2 : 1 }), post: async (_, body) => {
    if (++posts === 1) throw new HttpError(409);
    assert.deepEqual(body, { expected_revision: 2 }); return config({ revision: 3, local_sync_initialized: true });
  } };
  await new ConfigSync(api, dir).refresh(); assert.equal(posts, 2);
  await fs.unlink(path.join(dir, '.sync.json'));
  await fs.writeFile(path.join(dir, 'proxies.txt'), 'not a proxy');
  await assert.rejects(new ConfigSync(api, dir).refresh());
  assert.equal(await fs.readFile(path.join(dir, 'proxies.txt'), 'utf8'), 'not a proxy');
});

test('proxy credentials are percent encoded, including IPv6 host', () => {
  assert.equal(proxyText([{ url: 'socks5://[::1]:1080', username: 'a@b', password: 'p:/#' }]), 'socks5://a%40b:p%3A%2F%23@[::1]:1080\n');
});

test('explicit default proxy ports survive seed/publication and percent-encoded spaces', async t => {
  const dir = await temporary(t);
  const proxies = [
    { url: 'http://host.example:80', username: 'a b', password: 'p @:/#' },
    { url: 'https://host.example:443', username: '', password: '' },
    { url: 'http://[::1]:80', username: '', password: '' },
    { url: 'https://[2001:db8::1]:443', username: 'v6', password: 'a b' },
  ];
  const canonical = 'http://a%20b:p%20%40%3A%2F%23@host.example:80\nhttps://host.example:443\nhttp://[::1]:80\nhttps://v6:a%20b@[2001:db8::1]:443\n';
  assert.equal(proxyText(proxies), canonical);
  assert.equal(validateProxy(canonical), canonical);
  await fs.writeFile(path.join(dir, 'proxies.txt'), canonical);
  const api = { request: async () => config(), post: async (_, payload) => {
    assert.equal(payload.proxies_content, canonical);
    return config({ local_sync_initialized: true, proxies });
  } };
  await new ConfigSync(api, dir).refresh();
  assert.equal(await fs.readFile(path.join(dir, 'proxies.txt'), 'utf8'), canonical);
  for (const value of ['http://a b:80', 'http://user:p ass@host:80', 'http://host:0', 'http://host:65536', 'http://host', 'http://a:%0A@host:80']) assert.throws(() => validateProxy(value));
});

test('real child lifecycle, stable UUIDs and durable command acknowledgement retries', async t => {
  const dir = await temporary(t);
  const pool = new Supervisor(dir); await pool.init();
  t.after(() => pool.action('stop'));
  await pool.configure(config()); await pool.action('start');
  const id = pool.snapshot()[0].id;
  assert.equal(pool.children.size, 1);
  for (let i = 0; i < 100 && pool.snapshot()[0].memory_mb === 0; i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pool.snapshot()[0].status, 'idle');
  assert.ok(pool.snapshot()[0].memory_mb > 0, 'child must execute and report actual RSS');
  assert.equal(pool.snapshot()[0].tasks_completed, 0);
  const command = { id: 'command-1', action: 'restart' };
  await assert.rejects(pool.command(command, async () => config(), async () => { throw new Error('ack lost'); }));
  const pid = pool.children.get(id).process.pid;
  await pool.command(command, async () => { throw new Error('must not refresh/repeat'); }, async (_, result) => assert.equal(result.status, 'completed'));
  assert.equal(pool.children.get(id).process.pid, pid);
  await pool.action('stop');
  const recovered = new Supervisor(dir); await recovered.init();
  assert.equal(recovered.state.slots[0].id, id);
  await recovered.command(command, async () => { throw new Error('no repeat after restart'); }, async () => {});
  assert.equal(recovered.snapshot()[0]?.tasks_completed || 0, 0);
});

test('archive excludes runtime/state and preserves symlink without following it', async t => {
  const root = await temporary(t); const source = path.join(root, 'source'); const runtime = path.join(source, 'runtime');
  await privateDir(runtime);
  await fs.writeFile(path.join(source, 'code.txt'), 'hello');
  await fs.writeFile(path.join(runtime, 'secret'), 'excluded');
  await fs.writeFile(path.join(root, 'outside'), 'not followed');
  await fs.symlink('../outside', path.join(source, 'link'));
  const packed = await archive(source, runtime, { maxBytes: 1_000_000, timeout: 5000 });
  t.after(packed.cleanup);
  const { stdout } = await promisify(execFile)('tar', ['-tvzf', packed.file]);
  assert.match(stdout, /code.txt/); assert.match(stdout, /link -> ..\/outside/); assert.doesNotMatch(stdout, /runtime/);
  await assert.rejects(archive(source, runtime, { maxBytes: 1, timeout: 5000 }));
});

test('source equal to runtime/state preserves ordinary code and secrets, excludes own state/temp', async t => {
  const source = await temporary(t);
  for (const name of ['main.mjs', '.env', 'config.json', 'proxies.txt', 'commands.json', '.sync.json', 'workers.json', 'backups.json', 'backup-config.json', 'commands.json.123.tmp', 'config.json.123.tmp']) await fs.writeFile(path.join(source, name), 'fixture');
  const packed = await archive(source, source, { maxBytes: 1_000_000, timeout: 5000 });
  t.after(packed.cleanup);
  const { stdout } = await promisify(execFile)('tar', ['-tzf', packed.file]);
  const names = stdout.trim().split('\n');
  for (const name of ['main.mjs', '.env', 'config.json', 'proxies.txt']) assert.ok(names.includes('./' + name), name);
  assert.doesNotMatch(stdout, /commands|\.sync|workers|backups|backup-config|\.tmp/);
});

test('arbitrary binary uploads stream with metadata, bearer auth and no redirects', async t => {
  const root = await temporary(t); const file = path.join(root, 'anything.bin');
  await fs.writeFile(file, Buffer.from([0, 255, 4, 3]));
  let received;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks);
    assert.equal(new URL(req.url, 'http://localhost').searchParams.get('source'), 'direct');
    res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"id":"backup"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = new API(`http://127.0.0.1:${server.address().port}`, 'test-token');
  assert.equal((await uploadFile(api, file)).id, 'backup');
  assert.deepEqual(received, Buffer.from([0, 255, 4, 3]));
  await assert.rejects(uploadFile(api, file, { maxBytes: 1 }));
  await fs.writeFile(file, ''); await uploadFile(api, file); assert.equal(received.length, 0);
});

test('on-demand runs with schedule off; unknown acceptance reconciles without false failure ack', async t => {
  const root = await temporary(t); const runtime = path.join(root, 'runtime'); const source = path.join(root, 'source');
  await privateDir(runtime); await privateDir(source); await fs.writeFile(path.join(source, 'code'), 'hi');
  let queued = true; let uploads = 0; let acks = 0;
  const api = { request: async endpoint => {
    if (endpoint === '/backup-config') return { enabled: false, interval_minutes: 15, destination_ids: ['target'], cloud_secret: 'must not persist' };
    if (endpoint === '/backup-requests') return queued ? [{ id: 'request-1' }] : [];
    uploads++; queued = false; throw new Error('response lost after acceptance');
  }, post: async endpoint => { if (endpoint.includes('/ack')) acks++; return {}; } };
  const backups = new Backups(api, runtime, source, { maxBytes: 10000, timeout: 5000 });
  await backups.init(); await backups.tick();
  assert.equal(uploads, 1); assert.equal(acks, 0); assert.equal(backups.state.lastOutcome, 'unknown');
  await backups.tick();
  assert.equal(backups.state.requests['request-1'].status, 'reconciled'); assert.equal(acks, 0);
  assert.equal((await readJSON(path.join(runtime, 'backup-config.json'))).cloud_secret, undefined);
  assert.equal((await fs.stat(path.join(runtime, 'backup-config.json'))).mode & 0o777, 0o600);
});

test('redirects never forward credentials; request timeout is bounded', async t => {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { Location: '/elsewhere' }); res.end(); }
    else if (req.url.endsWith('/slow')) setTimeout(() => res.end('{}'), 150).unref();
    else { assert.fail('redirect was followed'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const api = new API(`http://127.0.0.1:${server.address().port}`, 'test', 50);
  await assert.rejects(api.request('/redirect'));
  await assert.rejects(api.request('/slow'));
});

test('main runs no-argument with standard directory envs, safe config files, independent backup polling', async t => {
  const root = await temporary(t);
  const runtime = path.join(root, 'runtime'); const state = path.join(root, 'state');
  await privateDir(runtime); await privateDir(state);
  await fs.writeFile(path.join(runtime, 'proxies.txt'), 'http://existing:8080\n');
  let enrolled = false; let sawStatus = false; let sawHeartbeat = false;
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    let result = {};
    if (req.url === '/api/agent/config') result = config({ local_sync_initialized: enrolled });
    if (req.url === '/api/agent/local-sync') {
      assert.equal(JSON.parse(body).proxies_content, 'http://existing:8080\n'); enrolled = true;
      result = config({ local_sync_initialized: true, proxies: [{ id: 'p', url: 'http://existing:8080', username: '', password: '' }] });
    }
    if (req.url === '/api/agent/heartbeat') { sawHeartbeat = true; result = { desired_state: 'stopped' }; }
    if (req.url === '/api/agent/backup-config') result = { enabled: false, interval_minutes: 15, destination_ids: [] };
    if (req.url === '/api/agent/backup-status') sawStatus = true;
    if (req.url === '/api/agent/backup-requests' || req.url === '/api/agent/commands') result = [];
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const child = spawn(process.execPath, ['main.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { PATH: process.env.PATH, HUB_URL: `http://127.0.0.1:${server.address().port}`, HUB_AGENT_TOKEN: 'test', HUB_RUNTIME_DIR: runtime, HUB_STATE_DIR: state, HUB_BACKUP_DIR: root },
    stdio: 'ignore',
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  t.after(async () => { child.kill('SIGTERM'); await exited; });
  for (let i = 0; i < 100; i++) {
    if (await readJSON(path.join(runtime, '.sync.json')) && await readJSON(path.join(state, 'workers.json')) && sawStatus && sawHeartbeat) break;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.equal(enrolled, true); assert.equal(sawHeartbeat, true); assert.equal(sawStatus, true);
  assert.equal((await readJSON(path.join(runtime, 'backup-config.json'))).enabled, false);
  assert.equal((await readJSON(path.join(state, 'workers.json'))).slots.length, 1);
  assert.equal((await fs.readdir(runtime)).includes('commands.json'), false);
  assert.equal((await fs.readFile(path.join(runtime, 'config.json'), 'utf8')).includes('test'), false);
  child.kill('SIGTERM'); assert.equal(await exited, 0);
});
