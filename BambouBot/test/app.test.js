'use strict';

/** Composition root and CLI: platform selection, failure isolation, startup refusals. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createApp, runApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { bambouServer, tempDir, silentLogger } = require('./helpers');

const ROOT = path.join(__dirname, '..');

function writeEnv(dir, lines) {
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function fakePlatform(name, behaviour) {
  const calls = { start: 0, stop: 0 };
  const factory = ({ access }) => ({
    name, calls, persistent: behaviour === 'persistent', ownerId: access.forPlatform(name).ownerId,
    async start({ signal }) {
      calls.start += 1;
      if (behaviour === 'fail') throw new Error(`${name} cannot start: bad token 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ`);
      if (behaviour === 'poll') await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    async stop() { calls.stop += 1; },
  });
  return { factory, calls };
}

test('one login, shared services, and a failing platform does not stop the other', async (t) => {
  const mock = await bambouServer(t);
  const dir = tempDir(t);
  const file = writeEnv(dir, ['BAMBOU_LOGIN_KEY=test-login', `BAMBOU_BASE_URL=${mock.baseUrl}`, 'DISCORD_TOKEN=d', 'DISCORD_OWNER_ID=1',
    'TELEGRAM_TOKEN=1:abc', 'TELEGRAM_OWNER_ID=2', `ACCESS_FILE=${path.join(dir, 'access.json')}`]);
  const config = loadConfig({ env: {}, file });
  const discord = fakePlatform('discord', 'fail');
  const telegram = fakePlatform('telegram', 'poll');
  const logger = silentLogger();
  const app = createApp(config, { factories: { discord: discord.factory, telegram: telegram.factory }, logger });
  assert.deepEqual(app.platforms.map((p) => [p.name, p.ownerId]), [['discord', '1'], ['telegram', '2']]);

  const controller = new AbortController();
  const running = runApp(app, { signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(discord.calls.start, 1);
  assert.equal(telegram.calls.start, 1);
  assert.equal(mock.requests.filter((r) => r.path === '/api/login').length, 1, 'one studio login for both platforms');
  assert.ok(logger.lines.some((l) => /\[discord\] stopped: discord cannot start: bad token \[redacted\]/.test(l)));
  assert.ok(!logger.lines.some((l) => /no platform left/.test(l)), 'telegram is still running');
  controller.abort();
  const result = await running;
  assert.deepEqual(result.started, ['telegram']);
  assert.deepEqual(result.failed.map((f) => f.name), ['discord']);
  assert.ok(telegram.calls.stop >= 1);
});

test('when every platform fails, runApp resolves with all failures', async (t) => {
  const mock = await bambouServer(t);
  const dir = tempDir(t);
  const file = writeEnv(dir, ['BAMBOU_LOGIN_KEY=test-login', `BAMBOU_BASE_URL=${mock.baseUrl}`, 'TELEGRAM_TOKEN=1:abc', 'TELEGRAM_OWNER_ID=2', `ACCESS_FILE=${path.join(dir, 'a.json')}`]);
  const telegram = fakePlatform('telegram', 'fail');
  const logger = silentLogger();
  const app = createApp(loadConfig({ env: {}, file }), { factories: { telegram: telegram.factory }, logger });
  const result = await runApp(app, { signal: new AbortController().signal });
  assert.deepEqual(result.failed.map((f) => f.name), ['telegram']);
  assert.ok(logger.lines.some((l) => /no platform left/.test(l)));
});

test('--only selects platforms, a platform without an owner is refused', (t) => {
  const dir = tempDir(t);
  const file = writeEnv(dir, ['BAMBOU_LOGIN_KEY=k', 'DISCORD_TOKEN=d', 'DISCORD_OWNER_ID=1', 'TELEGRAM_TOKEN=1:abc', `ACCESS_FILE=${path.join(dir, 'a.json')}`]);
  const factories = { discord: fakePlatform('discord').factory, telegram: fakePlatform('telegram').factory };
  const app = createApp(loadConfig({ env: {}, file, only: ['discord'] }), { factories, logger: silentLogger() });
  assert.deepEqual(app.platforms.map((p) => p.name), ['discord']);
  assert.throws(() => createApp(loadConfig({ env: {}, file }), { factories, logger: silentLogger() }), /No telegram owner: set TELEGRAM_OWNER_ID/);
});

test('real platform factories build without network access', (t) => {
  const dir = tempDir(t);
  const file = writeEnv(dir, ['BAMBOU_LOGIN_KEY=k', 'DISCORD_TOKEN=d', 'DISCORD_OWNER_ID=1', 'TELEGRAM_TOKEN=1:abc', 'TELEGRAM_OWNER_ID=2', `ACCESS_FILE=${path.join(dir, 'a.json')}`]);
  const app = createApp(loadConfig({ env: {}, file }), { logger: silentLogger() });
  assert.deepEqual(app.platforms.map((p) => p.name), ['discord', 'telegram']);
  assert.equal(app.platforms[0].bot.services, app.platforms[1].bot.services, 'one shared service layer');
  app.platforms[0].client.destroy();
});

test('CLI: clear errors, exit 1, and an invalid access file is left untouched', (t) => {
  const dir = tempDir(t);
  const cli = (env, args = []) => spawnSync(process.execPath, [path.join(ROOT, 'index.js'), ...args], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8', timeout: 10_000,
  });
  const nothing = cli({ BAMBOU_ENV_FILE: writeEnv(dir, ['BAMBOU_LOGIN_KEY=k']) });
  assert.equal(nothing.status, 1);
  assert.match(nothing.stderr, /Nothing to start: set DISCORD_TOKEN and\/or TELEGRAM_TOKEN/);

  const accessFile = path.join(dir, 'access.json');
  fs.writeFileSync(accessFile, 'invalid JSON');
  const corrupt = cli({ BAMBOU_ENV_FILE: writeEnv(dir, ['BAMBOU_LOGIN_KEY=k', 'TELEGRAM_TOKEN=1:abc', 'TELEGRAM_OWNER_ID=2', `ACCESS_FILE=${accessFile}`]) });
  assert.equal(corrupt.status, 1);
  assert.match(corrupt.stderr, /Invalid access file .*not valid JSON/);
  assert.equal(fs.readFileSync(accessFile, 'utf8'), 'invalid JSON');

  const unknownArg = cli({ BAMBOU_ENV_FILE: path.join(dir, '.env') }, ['--bogus']);
  assert.equal(unknownArg.status, 1);
  assert.match(unknownArg.stderr, /Unknown argument: --bogus/);
  const help = cli({}, ['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--only discord\|telegram/);
});
