'use strict';

/**
 * Discord adapter, fully offline: the real DiscordBot router and handlers driven by
 * duck-typed interactions against the local BambouAI mock. Like the real API, a
 * modal submission has no showModal(): step 1 must bridge to step 2 with a button.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DiscordBot } = require('../src/platforms/discord/bot');
const { commandsJson } = require('../src/platforms/discord/commands');
const { AccessStore } = require('../src/core/access');
const { createServices } = require('../src/services');
const { bambouServer, fakeGms, tempDir, silentLogger } = require('./helpers');

const OWNER = '670459548166914048';
const MATE = '42';

async function fixture(t) {
  const mock = await bambouServer(t);
  const studio = mock.studio({ maxRetries: 0 });
  await studio.login();
  const gms = fakeGms();
  const store = new AccessStore(path.join(tempDir(t), 'access.json'), { owners: { discord: OWNER } });
  const access = store.forPlatform('discord');
  const logger = silentLogger();
  const services = createServices({ studio, getGmsService: () => gms.service });
  const bot = new DiscordBot({ services, access, logger, secrets: () => ['test-login'] });
  return { mock, gms, access, store, logger, bot };
}

/** A duck-typed interaction; `kind` = command | modal | button | autocomplete. */
function interaction(kind, { user = OWNER, command, sub, options = {}, fields = {}, selects = {}, customId, dm = true, focused } = {}) {
  const replies = [];
  const dms = [];
  const i = {
    user: {
      id: user, tag: `user${user}`, username: `user${user}`,
      async send(text) { if (!dm) throw new Error('Cannot send messages to this user'); dms.push(text); },
    },
    channelId: 'c1', commandName: command, customId, replied: false, deferred: false,
    isAutocomplete: () => kind === 'autocomplete',
    isModalSubmit: () => kind === 'modal',
    isButton: () => kind === 'button',
    isChatInputCommand: () => kind === 'command',
    options: {
      getSubcommand: () => sub,
      getString: (n) => (n in options ? options[n] : null),
      getInteger: (n) => (n in options ? options[n] : null),
      getBoolean: (n) => (n in options ? options[n] : null),
      getUser: (n) => (n in options ? options[n] : null),
      getFocused: () => focused,
    },
    fields: {
      getTextInputValue: (n) => (n in fields ? fields[n] : ''),
      getStringSelectValues: (n) => selects[n] || [],
    },
    async reply(p) { i.replied = true; replies.push({ kind: 'reply', p }); },
    async deferReply() { i.deferred = true; replies.push({ kind: 'defer' }); },
    async editReply(p) { replies.push({ kind: 'editReply', p }); },
    async followUp(p) { replies.push({ kind: 'followUp', p }); },
    async update(p) { i.replied = true; replies.push({ kind: 'update', p }); },
    async showModal(m) { i.replied = true; replies.push({ kind: 'modal', p: m.toJSON() }); },
    async respond(choices) { replies.push({ kind: 'respond', p: choices }); },
  };
  return { i, replies, dms, text: () => replies.filter((r) => r.p?.content).map((r) => r.p.content).join('\n'), last: () => replies.at(-1) };
}

const run = async (bot, kind, opts) => { const x = interaction(kind, opts); await bot.handleInteraction(x.i); return x; };
const modalOf = (x) => x.replies.find((r) => r.kind === 'modal').p;
const tokenOf = (x) => modalOf(x).custom_id.split(':')[1];
const buttonIds = (payload) => payload.components.flatMap((row) => row.components.map((b) => b.data.custom_id));
const textInputs = (modal) => modal.components.map((row) => row.components[0]);

test('slash commands are built from the shared field specs', () => {
  const json = Object.fromEntries(commandsJson().map((c) => [c.name, c]));
  assert.deepEqual(Object.keys(json), ['preset', 'key', 'access', 'gms']);
  assert.equal(json.gms.options.length, 8);
  const create = json.key.options.find((o) => o.name === 'create');
  const rpm = create.options.find((o) => o.name === 'rpm');
  assert.equal(rpm.min_value, 1);
  assert.equal(rpm.max_value, 600);
  assert.equal(create.options.find((o) => o.name === 'daily').max_value, 100000);
  assert.equal(create.options.find((o) => o.name === 'label').max_length, 60);
  const platform = json.preset.options.find((o) => o.name === 'setup').options.find((o) => o.name === 'specific_platform');
  assert.equal(platform.autocomplete, true, 'autocomplete instead of the 25-choice cap');
  const perms = json.access.options.find((o) => o.name === 'add').options.find((o) => o.name === 'permissions');
  assert.equal(perms.choices.length, 7);
  const del = json.gms.options.find((o) => o.name === 'delete').options.find((o) => o.name === 'confirm');
  assert.ok(!del.required, 'confirm is optional; a button asks instead');
});

test('platform autocomplete offers every dashboard platform, filtered', async (t) => {
  const f = await fixture(t);
  const x = await run(f.bot, 'autocomplete', { focused: { name: 'specific_platform', value: 'un' } });
  const names = x.last().p.map((c) => c.value);
  assert.ok(names.includes('Unlockd') && names.includes('Unfiltrd'), names.join(','));
  const keys = await run(f.bot, 'autocomplete', { focused: { name: 'key_id', value: '' } });
  assert.deepEqual(keys.last().p.map((c) => c.value), ['ak_scoped', 'ak_all'], 'revoked keys hidden');
  const denied = await run(f.bot, 'autocomplete', { user: MATE, focused: { name: 'source', value: '' } });
  assert.deepEqual(denied.last().p, []);
});

test('/preset setup: modal → Continue button → modal → exactly one save, public summary', async (t) => {
  const f = await fixture(t);
  const start = await run(f.bot, 'command', { command: 'preset', sub: 'setup', options: { source: '1000', specific_platform: 'snap', specific_label: 'Snap' } });
  const modal1 = modalOf(start);
  assert.match(modal1.custom_id, /^ps1:/);
  assert.deepEqual(textInputs(modal1).map((c) => c.custom_id), ['name', 'id', 'first', 'discovery']);
  assert.equal(textInputs(modal1)[0].value, 'Lina Chatnow');
  assert.match(textInputs(modal1)[1].value, /^\d{4}$/);
  const token = tokenOf(start);

  const step1 = await run(f.bot, 'modal', { customId: `ps1:${token}`, fields: { name: 'Nina alpha', id: '8686', first: 'Nina', discovery: 'alpha.example' } });
  assert.equal(step1.replies.length, 1);
  assert.match(step1.last().p.content, /Step 1 saved/);
  assert.ok(!step1.last().p.flags, 'public');
  assert.deepEqual(buttonIds(step1.last().p), [`psc:${token}`, `pcn:${token}`]);

  const cont = await run(f.bot, 'button', { customId: `psc:${token}` });
  const modal2 = modalOf(cont);
  assert.equal(modal2.custom_id, `ps2:${token}`);
  assert.equal(textInputs(modal2)[0].value, 'https://old.example.com');

  const save = await run(f.bot, 'modal', { customId: `ps2:${token}`, fields: { mym: 'https://getmysocial.com/nina', specific: 'https://snapchat.com/add/nina' } });
  assert.equal(f.mock.puts, 1);
  const created = f.mock.db.presets.find((p) => p.id === '8686');
  assert.equal(created.identity.name, 'Nina');
  assert.equal(created.urls.items.find((i) => i.platform === 'snap').displayLabel, 'Snap');
  assert.equal(f.mock.db.presets[0].urls.items[0].url, 'https://old.example.com', 'source untouched');
  assert.match(save.text(), /Duplicated `1000` → \*\*`8686`\*\*/);

  const replay = await run(f.bot, 'modal', { customId: `ps2:${token}`, fields: { mym: 'https://x.y' } });
  assert.match(replay.text(), /expired/);
  assert.equal(f.mock.puts, 1);
  assert.ok(f.logger.lines.some((l) => /platform=discord user=670459548166914048 chat=c1 action=preset\.setup\.execute id=8686/.test(l)));
});

test('/preset: invalid id or URL keeps the form, other users and cancel are handled', async (t) => {
  const f = await fixture(t);
  const start = await run(f.bot, 'command', { command: 'preset', sub: 'setup', options: { source: '1000' } });
  const token = tokenOf(start);
  const bad = await run(f.bot, 'modal', { customId: `ps1:${token}`, fields: { name: 'X', id: '1000' } });
  assert.match(bad.text(), /already in use/);
  assert.deepEqual(buttonIds(bad.last().p), [`psr:${token}`, `pcn:${token}`]);
  const fix = await run(f.bot, 'button', { customId: `psr:${token}` });
  assert.equal(textInputs(modalOf(fix))[1].value, '1000', 'typed values are kept');
  await run(f.bot, 'modal', { customId: `ps1:${token}`, fields: { name: 'X', id: '7001' } });
  const badUrl = await run(f.bot, 'modal', { customId: `ps2:${token}`, fields: { mym: 'not a url' } });
  assert.match(badUrl.text(), /complete http/);
  assert.equal(f.mock.puts, 0);

  f.access.add(MATE, ['presets']);
  const foreign = await run(f.bot, 'modal', { user: MATE, customId: `ps1:${token}`, fields: { name: 'X', id: '7002' } });
  assert.match(foreign.text(), /expired/);
  const foreignButton = await run(f.bot, 'button', { user: MATE, customId: `psc:${token}` });
  assert.match(foreignButton.text(), /belongs to another user/);

  const cancel = await run(f.bot, 'button', { customId: `pcn:${token}` });
  assert.equal(cancel.last().kind, 'update');
  const after = await run(f.bot, 'button', { customId: `psc:${token}` });
  assert.match(after.text(), /expired/);
  assert.equal(f.mock.puts, 0);
});

test('/preset edit rename migrates references and key scopes', async (t) => {
  const f = await fixture(t);
  const start = await run(f.bot, 'command', { command: 'preset', sub: 'edit', options: { preset: '1000' } });
  const token = tokenOf(start);
  await run(f.bot, 'modal', { customId: `ps1:${token}`, fields: { name: 'Lina', id: '5005', first: 'Lina', discovery: 'Chatnow' } });
  const save = await run(f.bot, 'modal', { customId: `ps2:${token}`, fields: { mym: 'https://old.example.com' } });
  assert.equal(f.mock.db.presets.length, 1);
  assert.equal(f.mock.db.accounts[0].presetId, '5005');
  assert.deepEqual(f.mock.keys[0].presetIds, ['5005']);
  assert.match(save.text(), /API key scopes updated: ak_scoped/);
  assert.match(save.text(), /media record\(s\) keep the old ID/);
});

test('/key create: limits and scopes are validated before anything is created', async (t) => {
  const f = await fixture(t);
  for (const options of [{ label: 'w', rpm: 0 }, { label: 'w', concurrent: 9 }, { label: 'w', daily: 100001 }, { label: 'w', scope: 'missing' }, { label: 'x'.repeat(61) }]) {
    const x = await run(f.bot, 'command', { command: 'key', sub: 'create', options });
    assert.match(x.text(), /⚠️/);
  }
  assert.equal(f.mock.keyCreates, 0);
});

test('/key create: secret goes to DM; public reply never contains it', async (t) => {
  const f = await fixture(t);
  const x = await run(f.bot, 'command', { command: 'key', sub: 'create', options: { label: 'worker', rpm: 25, scope: '1000' } });
  assert.equal(f.mock.keyCreates, 1);
  assert.equal(x.dms.length, 1);
  assert.ok(x.dms[0].includes('bbk_test_secret_1'));
  assert.ok(!x.text().includes('bbk_test_secret'));
  assert.match(x.text(), /Key `ak_created_1` created \(\*\*worker\*\*\) · 25\/min .* presets 1000\n📬 A permanent copy was sent to your DMs/);
  assert.ok(f.logger.lines.every((l) => !l.includes('bbk_test')));
});

test('/key create: DMs closed → ephemeral fallback; fallback failure → key revoked', async (t) => {
  const f = await fixture(t);
  const x = await run(f.bot, 'command', { command: 'key', sub: 'create', options: { label: 'worker' }, dm: false });
  const follow = x.replies.filter((r) => r.kind === 'followUp');
  assert.equal(follow.length, 1);
  assert.ok(follow[0].p.flags, 'ephemeral');
  assert.ok(follow[0].p.content.includes('bbk_test_secret_1'));
  assert.match(x.text().split('🔑')[0], /DMs are closed/);
  assert.equal(f.mock.keyRevokes.length, 0);

  const y = interaction('command', { command: 'key', sub: 'create', options: { label: 'worker2' }, dm: false });
  const realFollow = y.i.followUp;
  y.i.followUp = async (p) => { if (p.flags) throw new Error('Unknown interaction'); return realFollow(p); };
  await f.bot.handleInteraction(y.i);
  assert.deepEqual(f.mock.keyRevokes, ['ak_created_2']);
  assert.match(y.text(), /new key was revoked/);
  assert.ok(!y.text().includes('bbk_test_secret'));
});

test('/key edit + delete: patch only what was passed; revoke needs initiator or owner, once', async (t) => {
  const f = await fixture(t);
  const edit = await run(f.bot, 'command', { command: 'key', sub: 'edit', options: { key_id: 'ak_all', paused: false, scope: '1000' } });
  assert.deepEqual(f.mock.keyPatches[0].patch, { presetIds: ['1000'], disabled: false });
  assert.match(edit.text(), /✅ • `ak_all` — \*\*All\*\* · active/);
  const nothing = await run(f.bot, 'command', { command: 'key', sub: 'edit', options: { key_id: 'ak_all' } });
  assert.match(nothing.text(), /Nothing to change/);
  const revoked = await run(f.bot, 'command', { command: 'key', sub: 'delete', options: { key_id: 'ak_revoked' } });
  assert.match(revoked.text(), /already revoked/);

  f.access.add(MATE, ['keys']);
  f.access.add('43', ['keys']);
  const ask = await run(f.bot, 'command', { user: MATE, command: 'key', sub: 'delete', options: { key_id: 'ak_scoped' } });
  const [yes] = buttonIds(ask.last().p);
  assert.equal(yes, `kdel:yes:ak_scoped:${MATE}`);
  const other = await run(f.bot, 'button', { user: '43', customId: yes });
  assert.match(other.text(), /Only the user who started this/);
  assert.equal(f.mock.keyRevokes.length, 0);
  const owner = await run(f.bot, 'button', { user: OWNER, customId: yes });
  assert.equal(owner.replies[0].kind, 'update', 'buttons removed before the API call');
  assert.deepEqual(owner.replies[0].p.components, []);
  assert.deepEqual(f.mock.keyRevokes, ['ak_scoped']);
  f.access.remove(MATE);
  const lost = await run(f.bot, 'button', { user: MATE, customId: yes });
  assert.match(lost.text(), /`keys` permission/);
});

test('permissions: unapproved users are refused and nothing reaches the studio', async (t) => {
  const f = await fixture(t);
  const before = f.mock.requests.length;
  for (const [command, sub] of [['preset', 'list'], ['key', 'list'], ['gms', 'list'], ['access', 'list']]) {
    const x = await run(f.bot, 'command', { user: MATE, command, sub, options: {} });
    assert.match(x.text(), /⛔/);
  }
  assert.equal(f.mock.requests.length, before);
  assert.ok(f.logger.lines.some((l) => /action=access\.denied permission=owner/.test(l)));
});

test('/access: owner manages Discord users only; mentions are not pinged', async (t) => {
  const f = await fixture(t);
  const add = await run(f.bot, 'command', { command: 'access', sub: 'add', options: { user: { id: MATE, tag: 'mate#1' }, permissions: 'presets+gms' } });
  assert.match(add.text(), /<@42> approved with `presets`, `gms` \(mate#1\)/);
  assert.deepEqual(add.last().p.allowedMentions, { parse: [] });
  assert.deepEqual(f.access.permissionsOf(MATE), ['presets', 'gms']);
  assert.deepEqual(f.store.forPlatform('telegram').permissionsOf(MATE), []);
  const list = await run(f.bot, 'command', { command: 'access', sub: 'list' });
  assert.match(list.text(), /Owner: <@670459548166914048>\nApproved users:\n• <@42> — `presets`, `gms`/);
  const self = await run(f.bot, 'command', { command: 'access', sub: 'add', options: { user: { id: OWNER }, permissions: 'keys' } });
  assert.match(self.text(), /already has every permission/);
  await run(f.bot, 'command', { command: 'access', sub: 'remove', options: { user: { id: MATE } } });
  assert.deepEqual(f.access.permissionsOf(MATE), []);
});

test('long replies are split across messages instead of being cut', async (t) => {
  const f = await fixture(t);
  for (let i = 1; i <= 40; i += 1) f.mock.db.presets.push({ ...structuredClone(f.mock.db.presets[0]), id: String(2000 + i), name: `${'Very long preset name '.repeat(4)}${i}` });
  f.access.add(MATE, ['keys']);
  for (let i = 0; i < 40; i += 1) f.mock.keys.push({ ...f.mock.keys[0], id: `ak_${i}`, label: 'x'.repeat(50) });
  const x = await run(f.bot, 'command', { command: 'key', sub: 'list' });
  const parts = x.replies.filter((r) => r.p?.content);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((r) => r.p.content.length <= 1990));
  assert.equal(parts[0].kind, 'reply');
  assert.ok(parts.slice(1).every((r) => r.kind === 'followUp'));
  assert.ok(x.text().includes('ak_39'), 'nothing was dropped');
});

test('/gms create: modal for missing fields only, direct create when complete', async (t) => {
  const f = await fixture(t);
  const bare = await run(f.bot, 'command', { command: 'gms', sub: 'create', options: {} });
  const modal = modalOf(bare);
  assert.match(modal.custom_id, /^gm1:/);
  assert.deepEqual(modal.components.map((c) => c.component.custom_id), ['profile', 'name', 'shortcode']);
  assert.deepEqual(modal.components[0].component.options.map((o) => o.value), ['lina', 'louise', 'mia']);
  const noProfile = await run(f.bot, 'modal', { customId: modal.custom_id, fields: { name: 'X' } });
  assert.match(noProfile.text(), /No destination profile/);
  assert.equal(f.gms.creates.length, 0);

  const partial = await run(f.bot, 'command', { command: 'gms', sub: 'create', options: { profile: 'louise' } });
  const pm = modalOf(partial);
  assert.deepEqual(pm.components.map((c) => c.component.custom_id), ['name', 'shortcode']);
  const thief = await run(f.bot, 'modal', { user: MATE, customId: pm.custom_id, fields: {} });
  assert.match(thief.text(), /expired/);
  const done = await run(f.bot, 'modal', { customId: pm.custom_id, fields: { name: '', shortcode: '' } });
  assert.deepEqual(f.gms.creates[0], { url: f.bot.services.gms.profiles.louise.url, displayName: undefined, shortcode: undefined });
  const embed = done.replies.find((r) => r.p?.embeds).p.embeds[0].data;
  assert.equal(embed.title, '✅ Direct link created');
  assert.equal(embed.footer.text, 'Team: Our team');

  const bad = await run(f.bot, 'command', { command: 'gms', sub: 'create', options: { profile: 'mia', name: 'M', shortcode: 'bad code' } });
  assert.match(bad.text(), /letters, digits/);
  await run(f.bot, 'command', { command: 'gms', sub: 'create', options: { profile: 'mia', name: 'M', shortcode: 'mia-1' } });
  assert.equal(f.gms.creates.length, 2);
});

test('/gms delete asks with a button unless confirm:true; list/info/stats embeds', async (t) => {
  const f = await fixture(t);
  const ask = await run(f.bot, 'command', { command: 'gms', sub: 'delete', options: { link: 'demo' } });
  const [yes, no] = buttonIds(ask.last().p);
  assert.equal(yes, `gdel:yes:aaaaaaaaaaaaaaaaaaaaaaaa:${OWNER}`);
  assert.equal(f.gms.removes.length, 0);
  await run(f.bot, 'button', { customId: no });
  assert.equal(f.gms.removes.length, 0);
  const del = await run(f.bot, 'button', { customId: yes });
  assert.deepEqual(f.gms.removes, ['aaaaaaaaaaaaaaaaaaaaaaaa']);
  assert.match(del.replies.at(-1).p.content, /Deleted `demo`/);

  await run(f.bot, 'command', { command: 'gms', sub: 'create', options: { profile: 'lina', name: 'L', shortcode: 'l2' } });
  const notConfirmed = await run(f.bot, 'command', { command: 'gms', sub: 'delete', options: { link: 'l2', confirm: false } });
  assert.match(notConfirmed.text(), /not confirmed/);
  await run(f.bot, 'command', { command: 'gms', sub: 'delete', options: { link: 'l2', confirm: true } });
  assert.equal(f.gms.removes.length, 2);

  f.gms.links.push({ _id: 'b'.repeat(24), originalLink: 'demo', displayName: 'Demo', status: 'active', selectedDomain: 'links.example' });
  const stats = await run(f.bot, 'command', { command: 'gms', sub: 'stats', options: { period: 'all' } });
  const embed = stats.replies.find((r) => r.p?.embeds).p.embeds[0].data;
  assert.equal(embed.title, '📊 Our team · Click stats — all');
  assert.match(embed.description, /0 with clicks · CTR 0%/);
  const info = await run(f.bot, 'command', { command: 'gms', sub: 'info', options: { link: 'demo' } });
  const infoEmbed = info.replies.find((r) => r.p?.embeds).p.embeds[0].data;
  assert.ok(infoEmbed.fields.some((field) => field.name === 'Clicks 7d' && field.value === '12'));
});

test('errors are redacted in replies and logs', async (t) => {
  const f = await fixture(t);
  f.bot.services.gms.getService = () => { throw new Error('boom test-login bbk_leak 123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ'); };
  const x = await run(f.bot, 'command', { command: 'gms', sub: 'list', options: {} });
  assert.equal(x.text(), '⚠️ boom [redacted] [redacted] [redacted]');
  assert.ok(f.logger.lines.every((l) => !l.includes('test-login') && !l.includes('bbk_leak')));
});
