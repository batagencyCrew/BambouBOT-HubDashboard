'use strict';

/** Shared services, independent of any platform. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServices } = require('../src/services');
const { PRESET_FIELDS, KEY_FIELDS } = require('../src/core/fields');
const render = require('../src/services/render');
const { MARKDOWN } = require('../src/core/format');
const { bambouServer, fakeGms } = require('./helpers');

async function setup(t) {
  const mock = await bambouServer(t);
  const studio = mock.studio({ maxRetries: 0 });
  await studio.login();
  const gms = fakeGms();
  return { mock, gms, services: createServices({ studio, getGmsService: () => gms.service }) };
}

const field = (list, key) => list.find((f) => f.key === key);

test('preset prefill, id validation and save report', async (t) => {
  const { mock, services } = await setup(t);
  const { values } = await services.presets.prefill('setup', '1000', { specificPlatform: 'telegram' });
  assert.match(values.id, /^\d{4}$/);
  assert.notEqual(values.id, '1000');
  assert.equal(values.specificPlatform, 'Telegram', 'canonical platform name');
  assert.equal(values.specificLabel, 'Telegram');
  await assert.rejects(services.presets.prefill('setup', '1000', { specificPlatform: 'MySpace' }), /must be one of/);
  await assert.rejects(services.presets.prefill('edit', 'nope'), /not found/);
  const idField = field(PRESET_FIELDS, 'id');
  await assert.rejects(services.presets.validateField(idField, '1000', { operation: 'setup', sourceId: '1000' }), /already in use/);
  assert.equal(await services.presets.validateField(idField, '1000', { operation: 'edit', sourceId: '1000' }), '1000');
  await assert.rejects(services.presets.validateField(field(PRESET_FIELDS, 'mymUrl'), 'ftp://x', {}), /complete http/);

  const report = await services.presets.save({ operation: 'setup', sourceId: '1000', values: { ...values, id: '7777', mymUrl: 'https://new/mym' } });
  assert.equal(mock.puts, 1);
  assert.equal(report.cloned, true);
  assert.match(render.presetSaveReport(report), /Duplicated 1000 → 7777/);
  assert.match(render.presetSaveReport(report, MARKDOWN), /Duplicated `1000` → \*\*`7777`\*\*/);
});

test('renaming a preset re-points scoped keys and counts stale media', async (t) => {
  const { mock, services } = await setup(t);
  const { values } = await services.presets.prefill('edit', '1000');
  const report = await services.presets.save({ operation: 'edit', sourceId: '1000', values: { ...values, id: '5005' } });
  assert.equal(report.renamed, true);
  assert.deepEqual(report.keyScopes, { updated: ['ak_scoped'], failed: [] });
  assert.equal(report.staleMedia, 1);
  assert.deepEqual(mock.keys[0].presetIds, ['5005']);
  assert.deepEqual(mock.keys[1].presetIds, []);
  assert.match(render.presetSaveReport(report), /API key scopes updated: ak_scoped/);
});

test('key scope resolution, defaults, creation and patch diffing', async (t) => {
  const { mock, services } = await setup(t);
  const keys = services.keys;
  assert.deepEqual(await keys.resolveScope('all'), []);
  assert.deepEqual(await keys.resolveScope('1000,1000'), ['1000']);
  await assert.rejects(keys.resolveScope('1000,missing'), /Unknown preset ID\(s\): missing/);
  assert.deepEqual(keys.defaults(), { label: '', rpm: 20, concurrent: 2, daily: 1000, scope: 'all' });
  await assert.rejects(keys.validateSupplied({ rpm: 0 }), /between 1 and 600/);
  await assert.rejects(keys.validateSupplied({ label: 'x'.repeat(61) }), /at most 60/);
  await assert.rejects(keys.create({ label: '  ' }), /label is required/);
  assert.equal(mock.keyCreates, 0);

  const result = await keys.create({ label: 'worker', rpm: 25, scope: '1000' });
  assert.equal(mock.keyCreates, 1);
  assert.deepEqual(mock.requests.at(-1).body, { label: 'worker', rpm: 25, maxConcurrent: 2, dailyLimit: 1000, presetIds: ['1000'] });
  assert.match(render.keyCreated(result), /Key ak_created_1 created \(worker\) · 25\/min · 2 concurrent · 1000\/day · presets 1000/);
  assert.equal(render.keySecretMessage(result).secret, 'bbk_test_secret_1');

  const original = keys.valuesOf(mock.keys[1]);
  assert.deepEqual(await keys.buildPatch({ ...original }, original), {});
  assert.deepEqual(await keys.buildPatch({ ...original, paused: false, scope: '1000' }, original), { presetIds: ['1000'], disabled: false });
  assert.deepEqual(await keys.buildPatch(await keys.validateSupplied({ concurrent: 4, scope: 'all' }, { edit: true })), { maxConcurrent: 4, presetIds: [] });
  assert.equal(field(KEY_FIELDS, 'daily').max, 100000);
});

test('GMS operations validate profiles and survive a failed team lookup', async (t) => {
  const { services, gms } = await setup(t);
  await assert.rejects(services.gms.createLink({ profile: '__proto__' }), /Choose a destination profile/);
  gms.contextFails = true;
  const result = await services.gms.createLink({ profile: 'Mia', name: ' Mia ', shortcode: '' });
  assert.deepEqual(gms.creates[0], { url: services.gms.profiles.mia.url, displayName: 'Mia', shortcode: undefined });
  assert.equal(result.context, null);
  const fields = render.gmsCreatedFields(result, gms.service);
  assert.deepEqual(fields.map(([n]) => n), ['Shortcode', 'Status', 'Name', 'URL', 'Destination']);
});

test('GMS stats view shows zero values instead of hiding them', () => {
  const view = render.gmsStats({ mode: 'account', label: 'this week', context: { teamName: 'T' }, rows: [{ originalLink: 'a', pageViews: 3, visitsWithClicks: 0, ctr: 0 }], overview: { pageViews: 3, totalClicks: 0, ctr: 0, periodStartDate: '2026-01-01T00:00:00Z', periodEndDate: '2026-01-07T00:00:00Z' } });
  assert.equal(view.title, '📊 T · Click stats — this week');
  assert.equal(view.lines[0], '1. a — 3 visits · 0 with clicks · CTR 0%');
  assert.deepEqual(view.fields.find(([n]) => n === 'CTR'), ['CTR', '0%']);
  assert.equal(view.footer, '2026-01-01 → 2026-01-07');
  assert.equal(render.asText(render.gmsStats({ mode: 'single', link: null })), 'No link found for that reference.');
});

test('GMS is lazy: a missing cookie only fails /gms, not startup', () => {
  const { lazyGmsService } = require('../src/services/gms');
  const get = lazyGmsService({ cookie: null });
  assert.throws(() => get(), /GMS_COOKIE/);
});
