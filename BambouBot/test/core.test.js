'use strict';

/** Pure core logic: presets builder, field validators, formatting, sessions, cache, errors, config. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const presets = require('../src/core/presets');
const fields = require('../src/core/fields');
const { splitText, paginate, shorten } = require('../src/core/format');
const { SessionStore } = require('../src/core/sessions');
const { ConfigCache } = require('../src/core/cache');
const { redact, errorText } = require('../src/core/errors');
const { createAudit } = require('../src/core/audit');
const { parsePermissions, permissionChoices } = require('../src/services/access');
const { loadConfig, parseEnv, ConfigError } = require('../src/config');
const { PLATFORMS } = require('../src/clients/bambou');
const { makeConfig, tempDir } = require('./helpers');

test('preset ids: validation and free-id suggestion', () => {
  assert.equal(presets.validatePresetId('4821').ok, true);
  assert.equal(presets.validatePresetId('48 21').ok, false);
  assert.equal(presets.validatePresetId('  ').ok, false);
  const config = makeConfig();
  for (let i = 0; i < 200; i += 1) assert.notEqual(presets.nextFreePresetId(config), '1000');
});

test('buildPresetSetup duplicates with main settings and both URLs, leaving the source untouched', () => {
  const config = makeConfig();
  const report = presets.buildPresetSetup({
    config, sourceId: '1000', clone: true, name: 'Lisa Snapchat', id: '7777', firstName: 'Lisa', discoveryPlatform: 'snapchat',
    mymUrl: 'https://getmysocial.com/lisa', specificUrl: 'https://snapchat.com/add/lisa', specificPlatform: 'snap', specificLabel: 'sn&p',
  });
  assert.equal(report.cloned, true);
  assert.equal(config.presets.length, 2);
  const created = config.presets[1];
  assert.equal(created.id, '7777');
  assert.equal(created.identity.name, 'Lisa');
  assert.equal(created.identity.age, 19);
  assert.equal(created.mainSettings.discoveryPlatform, 'snapchat');
  assert.equal(created.mainSettings.chattingStyle, 'youthful');
  assert.equal(created.urls.items.find((i) => i.platform === 'MYM').url, 'https://getmysocial.com/lisa');
  assert.equal(created.urls.items.find((i) => i.platform === 'snap').displayLabel, 'sn&p');
  assert.equal(config.presets[0].urls.items[0].url, 'https://old.example.com');
  assert.deepEqual(report.changes, ['MYM URL updated', 'specific URL added (sn&p)']);
});

test('buildPresetSetup rejects collisions, source reuse and a missing id', () => {
  assert.throws(() => presets.buildPresetSetup({ config: makeConfig(), sourceId: '1000', clone: true, id: '' }), /required/);
  assert.throws(() => presets.buildPresetSetup({ config: makeConfig(), sourceId: '1000', clone: true, id: '1000' }), /must differ/);
  const config = makeConfig();
  config.presets.push({ ...structuredClone(config.presets[0]), id: '2000', name: 'Other' });
  assert.throws(() => presets.buildPresetSetup({ config, sourceId: '1000', clone: true, id: '2000' }), /already used by "Other"/);
  assert.throws(() => presets.buildPresetSetup({ config, sourceId: 'missing', clone: true, id: '3000' }), /not found/);
});

test('editing in place renames the id and migrates only matching references', () => {
  const config = makeConfig();
  const report = presets.buildPresetSetup({ config, sourceId: '1000', clone: false, id: '5005' });
  assert.equal(config.presets.length, 1);
  assert.equal(config.presets[0].id, '5005');
  assert.equal(config.accounts[0].presetId, '5005');
  assert.equal(config.accounts[1].presetId, '2222');
  assert.equal(config.snapchat.modelSetups[0].presetId, '5005');
  assert.deepEqual(report.migrated, { accounts: 1, modelSetups: 1 });
  const untouched = makeConfig();
  presets.buildPresetSetup({ config: untouched, sourceId: '1000', clone: false, name: 'Renamed' });
  assert.equal(untouched.accounts[0].presetId, '1000');
});

test('upsertUrlItem matches by platform or label and is idempotent', () => {
  const preset = { urls: { items: [] } };
  assert.equal(presets.upsertUrlItem(preset, { platform: 'MYM', url: 'https://a' }).created, true);
  assert.equal(presets.upsertUrlItem(preset, { platform: 'MYM', url: 'https://b' }).created, false);
  presets.upsertUrlItem(preset, { platform: 'Other', displayLabel: 'one', url: 'https://1', match: 'label' });
  presets.upsertUrlItem(preset, { platform: 'Other', displayLabel: 'two', url: 'https://2', match: 'label' });
  assert.equal(preset.urls.items.length, 3);
  assert.equal(preset.urls.items[0].url, 'https://b');
  assert.deepEqual(presets.presetLinkBadges({ urls: { items: [{ platform: 'MYM', enabled: true }, { platform: 'Other', displayLabel: 'Extra', url: 'x', enabled: false }] } }), ['MYM', 'Extra(off)']);
});

test('field validators enforce the shared limits', () => {
  assert.equal(fields.integer('600', 'rpm', 1, 600), 600);
  assert.throws(() => fields.integer('0', 'rpm', 1, 600), /between 1 and 600/);
  assert.throws(() => fields.integer('20junk', 'rpm', 1, 600), /integer/);
  assert.equal(fields.boolean(false), false);
  assert.equal(fields.boolean('TRUE'), true);
  assert.throws(() => fields.boolean('maybe'), /true or false/);
  assert.equal(fields.httpUrl('', 'URL'), '');
  assert.throws(() => fields.httpUrl('javascript:alert(1)', 'URL'), /complete http/);
  assert.throws(() => fields.httpUrl('not-a-url', 'URL'), /complete http/);
  assert.equal(fields.platformValue('onlyfans'), 'OnlyFans');
  assert.equal(fields.platformValue('unfiltrd'), 'Unfiltrd', 'every dashboard platform is accepted');
  assert.throws(() => fields.platformValue('MySpace'), /must be one of/);
  assert.deepEqual(fields.scopeList(' all '), []);
  assert.deepEqual(fields.scopeList('1000, 2000,1000'), ['1000', '2000']);
  assert.throws(() => fields.scopeList(Array.from({ length: 101 }, (_, i) => i + 1).join(',')), /at most 100/);
  assert.throws(() => fields.shortcodeValue('bad code'), /letters, digits/);
  assert.equal(fields.userId('670459548166914048', 'Discord'), '670459548166914048', 'Discord snowflakes are accepted');
  assert.throws(() => fields.userId('@someone'), /numeric/);
  assert.equal(PLATFORMS.length, 29);
});

test('permission parsing accepts all, + and , combinations', () => {
  assert.deepEqual(parsePermissions('all'), ['presets', 'keys', 'gms']);
  assert.deepEqual(parsePermissions('presets+gms'), ['presets', 'gms']);
  assert.deepEqual(parsePermissions('keys, keys,gms'), ['keys', 'gms']);
  assert.throws(() => parsePermissions('keys+bogus'), /combination/);
  assert.throws(() => parsePermissions(''), /combination/);
  const choices = permissionChoices();
  assert.equal(choices.length, 7);
  assert.deepEqual(choices.at(-1), 'all');
  for (const choice of choices) assert.doesNotThrow(() => parsePermissions(choice));
});

test('formatting: splitting keeps Unicode intact, pagination clamps, shorten respects surrogates', () => {
  const text = `${'🌿'.repeat(3000)}\n${'x'.repeat(4500)}`;
  const chunks = splitText(text, 1990);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every((chunk) => chunk.length <= 1990 && !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.deepEqual(paginate([1, 2, 3], 9, 2), { page: 2, pages: 2, slice: [3], total: 3 });
  assert.equal(shorten('🌿🌿🌿', 4), '🌿…');
});

test('sessions expire, and pruning reports what expired', () => {
  let clock = 0;
  const store = new SessionStore({ ttlMs: 100, now: () => clock });
  const state = store.create({ userId: '1' });
  assert.match(state.token, /^[a-f0-9]{12}$/);
  assert.equal(store.get(state.token), state);
  clock = 100;
  assert.equal(store.get(state.token), undefined);
  const other = store.create({});
  clock = 300;
  const expired = [];
  store.prune((s) => expired.push(s.token));
  assert.deepEqual(expired, [other.token]);
});

test('config cache: TTL, invalidate, and no stale write-back from an in-flight read', async () => {
  let clock = 0;
  let version = 0;
  let release;
  const studio = { getConfig: () => new Promise((resolve) => { const v = ++version; release = () => resolve({ v }); }) };
  const cache = new ConfigCache(studio, { ttlMs: 1000, now: () => clock });
  const first = cache.get();
  release();
  assert.deepEqual(await first, { v: 1 });
  assert.deepEqual(await cache.get(), { v: 1 }, 'served from cache');
  const inFlight = cache.get(true);
  cache.invalidate();
  release();
  await inFlight;
  const fresh = cache.get();
  release();
  assert.deepEqual(await fresh, { v: 3 }, 'stale in-flight result was not cached');
});

test('errors and audit lines are redacted and single-line', () => {
  assert.equal(redact('token 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ and bbk_abc secret', ['secret']), 'token [redacted] and [redacted] [redacted]');
  const expired = Object.assign(new Error('x'), { name: 'SessionExpiredError' });
  assert.match(errorText(expired), /docs\/GETTING_COOKIE\.md/);
  assert.equal(errorText(Object.assign(new Error('Slow down'), { status: 429, retryAfter: 3 })), 'Slow down (HTTP 429; retry in 3s)');
  const lines = [];
  const audit = createAudit({ logger: { log: (l) => lines.push(l) }, secrets: () => ['hunter2'] });
  audit({ platform: 'discord', userId: '1', chatId: '2' }, 'key.create', 'label=hunter2\nbbk_xyz');
  assert.equal(lines[0], '[audit] platform=discord user=1 chat=2 action=key.create label=[redacted] [redacted]');
});

test('config: .env parsing, real env wins, platforms enabled by token, every problem reported', (t) => {
  assert.deepEqual(parseEnv('export A="x y" # c\nB=1 # comment\n# skip\nC=\'q\'\n'), { A: 'x y', B: '1', C: 'q' });
  const dir = tempDir(t);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'BAMBOU_LOGIN_KEY=from-file\nDISCORD_TOKEN=d\nDISCORD_OWNER_ID=1\nACCESS_FILE=state/a.json\n');
  const config = loadConfig({ env: { BAMBOU_LOGIN_KEY: 'from-env' }, file });
  assert.equal(config.bambou.loginKey, 'from-env');
  assert.equal(config.discord.enabled, true);
  assert.equal(config.telegram.enabled, false);
  assert.equal(config.accessFile, path.join(config.root, 'state/a.json'), 'relative to the project, not the cwd');
  assert.equal(config.gms.cookie, null);
  assert.throws(() => loadConfig({ env: { TELEGRAM_TOKEN: 'bad', TELEGRAM_OWNER_ID: '@me', TELEGRAM_POLL_TIMEOUT: '99' }, file: path.join(dir, 'none') }), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.problems.length, 4);
    return true;
  });
  const only = loadConfig({ env: { BAMBOU_LOGIN_KEY: 'k', TELEGRAM_TOKEN: '1:a', TELEGRAM_OWNER_ID: '5' }, file, only: ['telegram'] });
  assert.equal(only.discord.enabled, false);
  assert.equal(only.telegram.enabled, true);
  assert.throws(() => loadConfig({ env: { BAMBOU_LOGIN_KEY: 'k' }, file: path.join(dir, 'none'), only: ['discord'] }), /DISCORD_TOKEN is required/);
});
