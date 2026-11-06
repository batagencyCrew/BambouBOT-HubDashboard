'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { AccessStore, AccessFileError, migrateLegacy } = require('../src/core/access');
const migrate = require('../scripts/migrate-access');
const { tempDir, silentLogger } = require('./helpers');

const DISCORD_OWNER = '670459548166914048';

test('platform views are isolated: the same numeric id is a different person per platform', (t) => {
  const file = path.join(tempDir(t), 'access.json');
  const store = new AccessStore(file, { owners: { discord: DISCORD_OWNER, telegram: '111' } });
  const discord = store.forPlatform('discord');
  const telegram = store.forPlatform('telegram');
  assert.deepEqual(discord.permissionsOf(DISCORD_OWNER), ['presets', 'keys', 'gms']);
  assert.deepEqual(telegram.permissionsOf(DISCORD_OWNER), []);
  assert.equal(telegram.add('222', ['presets', 'gms'], { label: 'mate' }).ok, true);
  assert.deepEqual(telegram.permissionsOf('222'), ['presets', 'gms']);
  assert.deepEqual(discord.permissionsOf('222'), [], 'a Telegram grant never leaks to Discord');
  assert.equal(discord.add(DISCORD_OWNER, ['keys']).ok, false, 'owner cannot be re-added');
  assert.equal(discord.add('abc', ['keys']).ok, false);
  assert.equal(discord.add('333', ['bogus']).ok, false);
  assert.deepEqual(telegram.list().map((u) => u.id), ['222']);
  assert.deepEqual(discord.list(), []);
  const reloaded = new AccessStore(file).forPlatform('telegram');
  assert.deepEqual(reloaded.permissionsOf('222'), ['presets', 'gms']);
  assert.equal(reloaded.remove('222').ok, true);
  assert.equal(reloaded.remove('222').ok, false);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
});

test('a corrupt, legacy or invalid access file is refused and never overwritten', (t) => {
  const dir = tempDir(t);
  const cases = {
    'garbage.json': 'invalid JSON',
    'legacy.json': JSON.stringify({ ownerId: '1', users: {} }),
    'badkey.json': JSON.stringify({ version: 2, owners: {}, users: { '123': { permissions: [] } } }),
    'badperm.json': JSON.stringify({ version: 2, owners: {}, users: { 'discord:123': { permissions: ['root'] } } }),
    'badowner.json': JSON.stringify({ version: 2, owners: { discord: '@me' }, users: {} }),
  };
  for (const [name, content] of Object.entries(cases)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, content);
    assert.throws(() => new AccessStore(file, { owners: { discord: '1' } }), AccessFileError, name);
    assert.equal(fs.readFileSync(file, 'utf8'), content, `${name} untouched`);
  }
  assert.throws(() => new AccessStore(path.join(dir, 'legacy.json')), /migrate:access/);
});

test('configured owners seed a new file and override (with a warning) a different stored owner', (t) => {
  const file = path.join(tempDir(t), 'nested', 'access.json');
  new AccessStore(file, { owners: { discord: '1' } });
  const log = silentLogger();
  const store = new AccessStore(file, { owners: { discord: '2', telegram: '3' }, logger: log });
  assert.equal(store.ownerOf('discord'), '2');
  assert.equal(store.ownerOf('telegram'), '3');
  assert.ok(log.lines.some((line) => /discord owner 1 replaced by the configured owner 2/.test(line)));
  assert.throws(() => new AccessStore(file, { owners: { telegram: 'me' } }), /numeric/);
});

test('migration merges both legacy files into one v2 document', () => {
  const doc = migrateLegacy({
    discord: { ownerId: DISCORD_OWNER, users: { '42': { permissions: ['presets', 'keys'], label: 'BIPRO', addedBy: DISCORD_OWNER, addedAt: '2026-01-01T00:00:00.000Z' } } },
    telegram: { ownerId: '111', users: { '42': { permissions: ['gms', 'bogus'] }, '43': { permissions: [] } } },
  });
  assert.deepEqual(doc.owners, { discord: DISCORD_OWNER, telegram: '111' });
  assert.deepEqual(Object.keys(doc.users).sort(), ['discord:42', 'telegram:42']);
  assert.equal(doc.users['discord:42'].label, 'BIPRO');
  assert.deepEqual(doc.users['telegram:42'].permissions, ['gms']);
  assert.throws(() => migrateLegacy({ discord: { ownerId: 'x', users: {} } }), /not numeric/);
});

test('migrate-access script: dry run by default, --write, refuses to clobber without --force', (t) => {
  const dir = tempDir(t);
  const discord = path.join(dir, 'access.json');
  const telegram = path.join(dir, 'telegram-access.json');
  const out = path.join(dir, 'out', 'access.json');
  fs.writeFileSync(discord, JSON.stringify({ ownerId: '1', users: { '5': { permissions: ['keys'] } } }));
  fs.writeFileSync(telegram, JSON.stringify({ ownerId: '2', users: {} }));
  const log = () => {};
  const dry = migrate.run(['--discord', discord, '--telegram', telegram, '--out', out], { log });
  assert.equal(dry.written, false);
  assert.equal(fs.existsSync(out), false);
  migrate.run(['--discord', discord, '--telegram', telegram, '--out', out, '--write'], { log });
  const store = new AccessStore(out);
  assert.deepEqual(store.forPlatform('discord').permissionsOf('5'), ['keys']);
  assert.equal(store.ownerOf('telegram'), '2');
  assert.throws(() => migrate.run(['--discord', discord, '--out', out, '--write'], { log }), /--force/);
  migrate.run(['--discord', discord, '--out', out, '--write', '--force'], { log });
  assert.ok(fs.readdirSync(path.dirname(out)).some((name) => name.includes('.bak-')), 'backup kept');
  assert.equal(JSON.parse(fs.readFileSync(discord, 'utf8')).ownerId, '1', 'sources untouched');
});
