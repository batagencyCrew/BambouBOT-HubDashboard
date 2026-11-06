'use strict';

/**
 * Bambou Hub module, fully offline: client headers and error mapping, the shared
 * command layer, Discord and Telegram handlers, the link flow and the alert
 * poller — all against the in-memory hub in hubfake.js (injected fetch).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { HubClient, HubError } = require('../src/clients/hub');
const { configValue } = require('../src/services/hub');
const hubCommands = require('../src/services/hubcommands');
const hubFormat = require('../src/core/hubformat');
const { createHubAlertPoller, formatAlert, parseChannel } = require('../src/services/hub-alerts');
const { DiscordBot } = require('../src/platforms/discord/bot');
const { commandsJson } = require('../src/platforms/discord/commands');
const { TelegramBot } = require('../src/platforms/telegram/bot');
const { AccessStore } = require('../src/core/access');
const { loadConfig, secretsOf } = require('../src/config');
const { createApp, runApp } = require('../src/app');
const { MARKDOWN } = require('../src/core/format');
const { tempDir, silentLogger } = require('./helpers');
const { fakeHub, TOKEN } = require('./hubfake');

const DISCORD_OWNER = '670459548166914048';
const ALICE = '42'; // linked on Discord
const STRANGER = '77'; // not linked anywhere

/* --------------------------------- client --------------------------------- */

test('client: bot token on every call, X-Bot-User only when acting for a user', async () => {
  const hub = fakeHub();
  const client = hub.client();
  await client.request('POST', '/api/bot/identity', { body: { platform: 'discord', platform_user: '42' } });
  await client.request('GET', '/api/sites', { asUser: { platform: 'discord', id: '42' } });
  await client.request('GET', '/api/sites', { asUser: 'telegram:111' });
  const [identity, asDiscord, asTelegram] = hub.requests;
  assert.equal(identity.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(identity.headers['X-Bot-User'], undefined);
  assert.equal(identity.headers['Content-Type'], 'application/json');
  assert.equal(asDiscord.headers['X-Bot-User'], 'discord:42');
  assert.equal(asTelegram.headers['X-Bot-User'], 'telegram:111');
  assert.equal(asDiscord.headers['Content-Type'], undefined, 'no body, no content type');
  assert.ok(!JSON.stringify(client).includes(TOKEN), 'the token is not enumerable');
  await assert.rejects(client.request('GET', 'https://evil.example/api'), /must start with \/api\//);
});

test('client: 401/403/404/409/429/400 map to stable codes; 403 names the permission', async () => {
  const scripted = (status, detail, headers = {}) => new HubClient({
    baseUrl: 'https://hub.test', token: TOKEN, maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({ detail }), { status, headers }),
  });
  const cases = [
    [401, 'Authentication required', 'unlinked', /not linked/],
    [403, 'Missing permission: control:lifecycle', 'forbidden', /lacks the control:lifecycle permission/],
    [404, 'Site not found', 'not_found', /Site not found/],
    [409, 'File changed since you loaded it', 'conflict', /reload and retry/],
    [429, 'Too many', 'rate_limited', /rate limiting/],
    [422, [{ loc: ['body', 'minutes'], msg: 'too big' }], 'invalid', /minutes: too big/],
  ];
  for (const [status, detail, code, message] of cases) {
    await assert.rejects(scripted(status, detail, { 'retry-after': '7' }).get('/api/sites', { asUser: 'discord:1' }), (error) => {
      assert.ok(error instanceof HubError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      assert.match(error.message, message);
      if (status === 403) assert.equal(error.permission, 'control:lifecycle');
      if (status === 429) assert.equal(error.retryAfter, 7);
      return true;
    });
  }
});

test('client: GETs retry on network/5xx, mutations are sent once, the token never leaks into errors', async () => {
  let calls = 0;
  const flaky = new HubClient({
    baseUrl: 'https://hub.test', token: TOKEN, maxRetries: 2, sleepImpl: async () => {},
    fetchImpl: async () => { calls += 1; if (calls < 3) throw new Error(`boom ${TOKEN}`); return new Response('[]', { status: 200 }); },
  });
  assert.deepEqual(await flaky.get('/api/sites'), []);
  assert.equal(calls, 3);

  let posts = 0;
  const down = new HubClient({
    baseUrl: 'https://hub.test', token: TOKEN, maxRetries: 2, sleepImpl: async () => {},
    fetchImpl: async () => { posts += 1; return new Response(JSON.stringify({ detail: `oops ${TOKEN}` }), { status: 503 }); },
  });
  await assert.rejects(down.post('/api/sites/x/commands', { action: 'stop' }), (error) => {
    assert.equal(error.code, 'unavailable');
    assert.ok(!error.message.includes(TOKEN));
    return true;
  });
  assert.equal(posts, 1, 'a mutation is never replayed');

  const unreachable = new HubClient({ baseUrl: 'https://hub.test', token: TOKEN, maxRetries: 0, fetchImpl: async () => { throw new Error(`refused ${TOKEN}`); } });
  await assert.rejects(unreachable.get('/api/sites'), (error) => error.code === 'unavailable' && /Hub unreachable/.test(error.message) && !error.message.includes(TOKEN));
});

/* --------------------------------- config --------------------------------- */

test('config: hub is optional, validated, and its token is a secret', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '.env');
  const base = ['BAMBOU_LOGIN_KEY=k', 'TELEGRAM_TOKEN=1:abc', 'TELEGRAM_OWNER_ID=2'];
  const load = (lines) => { fs.writeFileSync(file, [...base, ...lines].join('\n')); return loadConfig({ env: {}, file }); };
  const off = load([]);
  assert.equal(off.hub.enabled, false);
  assert.equal(off.hub.alerts, false);
  const on = load(['HUB_URL=https://hub.example.com/', `HUB_BOT_TOKEN=${TOKEN}`]);
  assert.deepEqual([on.hub.enabled, on.hub.url, on.hub.alerts, on.hub.alertIntervalMs], [true, 'https://hub.example.com', true, 20_000]);
  assert.ok(secretsOf(on).includes(TOKEN));
  assert.equal(load(['HUB_URL=https://hub.example.com', `HUB_BOT_TOKEN=${TOKEN}`, 'HUB_ALERTS=false']).hub.alerts, false);
  assert.throws(() => load(['HUB_URL=ftp://hub', `HUB_BOT_TOKEN=${TOKEN}`]), /HUB_URL must be a full http\(s\) URL/);
  assert.throws(() => load(['HUB_URL=https://hub.example.com', 'HUB_BOT_TOKEN=nope']), /HUB_BOT_TOKEN must be a hub bot service token/);
  assert.throws(() => load(['HUB_URL=https://hub.example.com']), /HUB_BOT_TOKEN is required/);
  assert.throws(() => load([`HUB_BOT_TOKEN=${TOKEN}`]), /HUB_URL is required/);
  assert.throws(() => load(['HUB_URL=https://hub.example.com', `HUB_BOT_TOKEN=${TOKEN}`, 'HUB_ALERTS=maybe']), /HUB_ALERTS must be true or false/);
});

/* ----------------------------- shared commands ----------------------------- */

const alice = { platform: 'discord', id: ALICE };

test('commands: sites show health and worker counts; lifecycle commands act as the user', async () => {
  const hub = fakeHub();
  const service = hub.service();
  const sites = await hubCommands.execute({ name: 'sites', user: alice, hub: service });
  assert.match(sites.text, /🟡 alpha — degraded · workers 3 running · 1 error \(4 total\)/);
  const start = await hubCommands.execute({ name: 'start', params: { site: 'alpha' }, user: alice, hub: service });
  assert.match(start.text, /✅ alpha: start delivered/);
  assert.deepEqual(hub.commands, [{ site: 'alpha', action: 'start', args: {}, by: 'discord:42' }]);
  const backup = await hubCommands.execute({ name: 'backup', params: { site: 'alpha' }, user: alice, hub: service });
  assert.match(backup.text, /agent is offline/);
  const ask = await hubCommands.confirmationText({ name: 'set', params: { site: 'alpha', path: '.env', key: 'API_KEY', value: 'new' }, user: alice, hub: service });
  assert.match(ask, /^Confirm set API_KEY in \.env on alpha\?\nCurrent: \*{8} → new: new\n🟡 alpha/);
  const set = await hubCommands.execute({ name: 'set', params: { site: 'alpha', path: '.env', key: 'WORKERS', value: '5' }, user: alice, hub: service });
  assert.match(set.text, /WORKERS set, revision 4/);
  assert.deepEqual(hub.patches, [{ path: '.env', base_revision: 3, set: { WORKERS: '5' } }]);
  assert.deepEqual([configValue('5', 'json'), configValue('true', 'json'), configValue('hello', 'json'), configValue('5', 'env')], [5, true, 'hello', '5']);
});

test('commands: 403 names the permission, unlinked users get the link instruction, 404 is one line', async () => {
  const hub = fakeHub();
  hub.links['discord:42'].permissions = ['sites:view'];
  const service = hub.service();
  await assert.rejects(hubCommands.execute({ name: 'start', params: { site: 'alpha' }, user: alice, hub: service }), (error) => {
    assert.equal(hubCommands.hubErrorText(error), '⛔ Your hub account lacks the control:lifecycle permission.');
    return true;
  });
  assert.equal(hub.commands.length, 0);
  await assert.rejects(hubCommands.execute({ name: 'sites', user: { platform: 'discord', id: STRANGER }, hub: service }), (error) => {
    assert.match(hubCommands.hubErrorText(error), /^This chat is not linked to a hub account\. .*\/hub link <code>/);
    assert.ok(!hubCommands.hubErrorText(error).includes('\n'), 'one line');
    return true;
  });
  await assert.rejects(hubCommands.execute({ name: 'info', params: { site: 'nope' }, user: alice, hub: service }),
    (error) => hubCommands.hubErrorText(error) === '⚠️ Hub: Site not found.');
});

test('commands: logs fit the platform limit and paginate exactly after the last line shown', async () => {
  const hub = fakeHub();
  const service = hub.service();
  for (const max of [hubFormat.LIMITS.discord, hubFormat.LIMITS.telegram]) {
    const seen = [];
    let page = { number: 1 };
    for (let i = 0; i < 20; i += 1) {
      const result = await hubCommands.execute({ name: 'logs', params: { site: 'alpha', level: 'debug', limit: 50 }, user: alice, hub: service, page, max });
      assert.ok(result.text.length <= max, `page fits in ${max}`);
      seen.push(...[...result.text.matchAll(/line (\d+) /g)].map((m) => Number(m[1])));
      if (!result.next) break;
      page = { beforeId: result.next.beforeId, number: page.number + 1 };
    }
    assert.deepEqual(seen, Array.from({ length: 120 }, (_, i) => 120 - i), 'every line once, newest first');
  }
  const errors = await hubCommands.execute({ name: 'errors', params: { site: 'alpha' }, user: alice, hub: service });
  assert.equal(hub.requests.at(-1).query.level, 'error');
  assert.ok(!/INFO/.test(errors.text));
});

test('commands: long output is truncated with a note; alerts paginate by 10', async () => {
  const hub = fakeHub();
  hub.sites = Array.from({ length: 80 }, (_, i) => ({ ...hub.sites[0], slug: `s${i}`, name: `Site number ${i} with a long name` }));
  const service = hub.service();
  const sites = await hubCommands.execute({ name: 'sites', user: alice, hub: service, max: hubFormat.LIMITS.discord });
  assert.ok(sites.text.length <= hubFormat.LIMITS.discord);
  assert.match(sites.text, /truncated/);
  const first = await hubCommands.execute({ name: 'alerts', user: alice, hub: service });
  assert.deepEqual([first.alerts.length, first.page.pages], [10, 2]);
  assert.match(first.text, /Alerts \(13\) — page 1\/2/);
  const second = await hubCommands.execute({ name: 'alerts', user: alice, hub: service, page: { number: 2 } });
  assert.equal(second.alerts.length, 3);
  const ack = await hubCommands.execute({ name: 'ack', params: { id: first.alerts[0].id.slice(0, 8) }, user: alice, hub: service });
  assert.match(ack.text, /acknowledged/);
  assert.equal(hub.acks[0].id, first.alerts[0].id, 'prefix resolved to the full id');
  await assert.rejects(hubCommands.execute({ name: 'mute', params: { id: 'zz' }, user: alice, hub: service }), /Alert ids look like/);
});

test('link flow: code redemption, identity and unlink go through /api/bot', async () => {
  const hub = fakeHub();
  const service = hub.service();
  const stranger = { platform: 'telegram', id: STRANGER };
  const status = await hubCommands.execute({ name: 'whoami', user: stranger, hub: service });
  assert.match(status.text, /not linked/);
  await assert.rejects(hubCommands.execute({ name: 'link', params: { code: 'WRONG-0000' }, user: stranger, hub: service }), /invalid or expired/);
  const linked = await hubCommands.execute({ name: 'link', params: { code: 'abcd-1234' }, user: stranger, hub: service });
  assert.match(linked.text, /Linked to hub user bob \(viewer\)/);
  const link = hub.requests.find((r) => r.path === '/api/bot/link' && r.body.code === 'ABCD-1234');
  assert.deepEqual(link.body, { platform: 'telegram', platform_user: STRANGER, code: 'ABCD-1234' }, 'code normalised to upper case');
  assert.equal(link.headers['X-Bot-User'], undefined, 'linking uses the service token only');
  assert.match((await hubCommands.execute({ name: 'whoami', user: stranger, hub: service })).text, /bob.*\nPermissions: sites:view/);
  await hubCommands.execute({ name: 'unlink', user: stranger, hub: service });
  assert.equal(hub.links[`telegram:${STRANGER}`], undefined);
});

test('formatting: markdown file view escapes fences, plain style has none', () => {
  const file = { path: '.env', format: 'env', revision: 1, in_sync: true, content: 'A=```x```' };
  assert.ok(!hubFormat.fileView(file, MARKDOWN).includes('A=```'));
  assert.ok(!hubFormat.fileView(file).includes('```\n'));
  assert.equal(hubFormat.fit('x'.repeat(5000), 2000).length <= 2000, true);
});

/* --------------------------------- Discord -------------------------------- */

function discordInteraction(kind, { user = ALICE, sub, options = {}, customId, focused } = {}) {
  const replies = [];
  const i = {
    user: { id: user, tag: `user${user}`, async send() {} },
    channelId: 'c1', commandName: 'hub', customId, replied: false, deferred: false,
    isAutocomplete: () => kind === 'autocomplete', isModalSubmit: () => false,
    isButton: () => kind === 'button', isChatInputCommand: () => kind === 'command',
    options: {
      getSubcommand: () => sub,
      getString: (n) => (n in options ? options[n] : null),
      getInteger: (n) => (n in options ? options[n] : null),
      getFocused: () => focused,
    },
    async reply(p) { i.replied = true; replies.push({ kind: 'reply', p }); },
    async deferReply() { i.deferred = true; replies.push({ kind: 'defer' }); },
    async editReply(p) { replies.push({ kind: 'editReply', p }); },
    async followUp(p) { replies.push({ kind: 'followUp', p }); },
    async update(p) { i.replied = true; replies.push({ kind: 'update', p }); },
    async respond(choices) { replies.push({ kind: 'respond', p: choices }); },
  };
  return { i, replies, last: () => replies.at(-1).p, text: () => replies.filter((r) => r.p?.content).map((r) => r.p.content).join('\n') };
}

function discordFixture(t, { hub = fakeHub(), withHub = true } = {}) {
  const store = new AccessStore(path.join(tempDir(t), 'access.json'), { owners: { discord: DISCORD_OWNER } });
  const services = { studio: { loginKey: 'test-login' }, hub: withHub ? hub.service() : null };
  const logger = silentLogger();
  const bot = new DiscordBot({ services, access: store.forPlatform('discord'), logger });
  const run = async (kind, opts) => { const x = discordInteraction(kind, opts); await bot.handleInteraction(x.i); return x; };
  return { hub, bot, run, logger };
}

const ids = (payload) => (payload.components || []).flatMap((row) => row.components.map((b) => b.data.custom_id));

test('discord: /hub has at most 25 subcommands, each within Discord limits', () => {
  const hub = commandsJson().find((c) => c.name === 'hub');
  assert.ok(hub.options.length <= 25);
  const names = hub.options.map((o) => o.name);
  for (const name of ['sites', 'info', 'stats', 'start', 'stop', 'restart', 'pause', 'resume', 'workers', 'logs', 'errors', 'costs', 'balances',
    'proxies', 'files', 'show', 'set', 'alerts', 'ack', 'mute', 'backup', 'link', 'unlink']) assert.ok(names.includes(name), name);
  for (const sub of hub.options) assert.ok((sub.options?.length ?? 0) <= 25);
});

test('discord: unapproved (access.json) but linked users can use /hub; unlinked get the link line', async (t) => {
  const { run } = discordFixture(t);
  const sites = await run('command', { sub: 'sites' });
  assert.match(sites.text(), /\*\*alpha\*\* — degraded · workers 3 running · 1 error/);
  const stranger = await run('command', { user: STRANGER, sub: 'sites' });
  assert.match(stranger.text(), /^This chat is not linked to a hub account/);
  assert.match((await run('command', { sub: 'whoami' })).text(), /Linked to hub user \*\*alice\*\*/);
});

test('discord: stop asks with live health, runs once on confirm, cancel sends nothing, foreign clicks refused', async (t) => {
  const { hub, run, logger } = discordFixture(t);
  const ask = await run('command', { sub: 'stop', options: { site: 'alpha' } });
  assert.match(ask.text(), /Confirm stop \*\*alpha\*\*\?\n🟡 \*\*alpha\*\* — degraded · workers 3 running · 1 error/);
  assert.equal(hub.commands.length, 0, 'nothing sent before confirmation');
  const [yes, no] = ids(ask.last());
  assert.match(yes, /^hcf:yes:/);
  const foreign = await run('button', { user: STRANGER, customId: yes });
  assert.match(foreign.text(), /belongs to another user/);
  const confirmed = await run('button', { customId: yes });
  assert.match(confirmed.text(), /✅ \*\*alpha\*\*: stop delivered/);
  assert.equal(hub.commands.length, 1);
  const again = await run('button', { customId: yes });
  assert.match(again.text(), /expired/);
  assert.equal(hub.commands.length, 1, 'a double click does not stop twice');
  assert.ok(logger.lines.some((l) => /action=hub\.stop\.execute site=alpha/.test(l)));

  const ask2 = await run('command', { sub: 'restart', options: { site: 'alpha' } });
  const cancelled = await run('button', { customId: ids(ask2.last())[1] });
  assert.match(cancelled.text(), /Cancelled/);
  assert.equal(hub.commands.length, 1);
  assert.ok(no);
});

test('discord: confirmed command refused with 403 is rendered, not thrown', async (t) => {
  const { hub, run } = discordFixture(t);
  hub.links['discord:42'].permissions = ['sites:view'];
  const ask = await run('command', { sub: 'set', options: { site: 'alpha', path: '.env', key: 'WORKERS', value: '9' } });
  const done = await run('button', { customId: ids(ask.last())[0] });
  assert.match(done.text(), /⛔ Your hub account lacks the config:edit permission/);
  assert.equal(hub.patches.length, 0);
});

test('discord: logs paginate with an Older button; alerts have ack + page buttons; files have show buttons', async (t) => {
  const { hub, run } = discordFixture(t);
  const logs = await run('command', { sub: 'logs', options: { site: 'alpha', level: 'debug', limit: 50 } });
  for (const r of logs.replies) if (r.p?.content) assert.ok(r.p.content.length <= 2000);
  const [older] = ids(logs.last());
  assert.match(older, /^hpg:/);
  const page2 = await run('button', { customId: older });
  assert.equal(page2.replies[0].kind, 'update');
  assert.match(page2.last().content, /page 2/);

  const alerts = await run('command', { sub: 'alerts' });
  const buttons = ids(alerts.last());
  assert.equal(buttons.filter((b) => b.startsWith('hak:')).length, 5);
  assert.ok(buttons.some((b) => /^hal:.+:2$/.test(b)));
  await run('button', { customId: buttons[0] });
  assert.equal(hub.acks.length, 1);
  const next = await run('button', { customId: buttons.find((b) => b.startsWith('hal:')) });
  assert.match(next.last().content, /page 2\/2/);

  const files = await run('command', { sub: 'files', options: { site: 'alpha' } });
  const [show] = ids(files.last());
  const shown = await run('button', { customId: show });
  assert.match(shown.text(), /WORKERS=3\nAPI_KEY=\*\*\*\*\*\*\*\*/);
});

test('discord: link/unlink, site autocomplete, and a bot without hub config', async (t) => {
  const { hub, run } = discordFixture(t);
  const linked = await run('command', { user: STRANGER, sub: 'link', options: { code: 'ABCD-1234' } });
  assert.match(linked.text(), /Linked to hub user \*\*bob\*\*/);
  const auto = await run('autocomplete', { focused: { name: 'site', value: 'cam' } });
  assert.deepEqual(auto.last(), [{ name: 'alpha — degraded', value: 'alpha' }]);
  await run('command', { user: STRANGER, sub: 'unlink' });
  assert.equal(hub.links[`discord:${STRANGER}`], undefined);
  const off = discordFixture(t, { withHub: false });
  assert.match((await off.run('command', { sub: 'sites' })).text(), /hub is not configured/);
});

/* -------------------------------- Telegram -------------------------------- */

function telegramFixture(t, { hub = fakeHub() } = {}) {
  const sent = [];
  let nextId = 500;
  const telegram = {
    token: '12345:test-token',
    async sendText(chatId, text, options = {}) { return this.sendMessage(chatId, text, options); },
    async sendMessage(chatId, text, options = {}) { const m = { message_id: nextId++, chat: { id: chatId }, text, ...options }; sent.push(m); return m; },
    async editMessageText(chatId, messageId, text, options = {}) { const m = sent.find((x) => x.message_id === messageId); Object.assign(m, { text, ...options }); return m; },
    async editMessageReplyMarkup(chatId, messageId) { const m = sent.find((x) => x.message_id === messageId); if (m) delete m.reply_markup; return m; },
    async answerCallbackQuery() { return true; },
  };
  const store = new AccessStore(path.join(tempDir(t), 'access.json'), { owners: { telegram: '999' } });
  const services = { studio: { loginKey: 'test-login' }, hub: hub.service() };
  const bot = new TelegramBot({ telegram, services, access: store.forPlatform('telegram'), username: 'BambouTestBot', logger: silentLogger() });
  let incoming = 1;
  const message = (text, { userId = '111', replyTo } = {}) => ({
    update_id: incoming, message: {
      message_id: incoming++, text, from: { id: Number(userId), is_bot: false }, chat: { id: Number(userId), type: 'private' },
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
    },
  });
  const say = (text, opts) => bot.handleUpdate(message(text, opts));
  // Buttons are remembered so a replayed click still carries its original data.
  const keyboards = new Map();
  const click = (msg, index = 0, { userId = '111' } = {}) => {
    if (msg.reply_markup) keyboards.set(msg.message_id, msg.reply_markup.inline_keyboard.flat());
    return bot.handleUpdate({
    update_id: incoming++, callback_query: {
      id: `cb${incoming}`, from: { id: Number(userId), is_bot: false }, data: keyboards.get(msg.message_id)[index].callback_data,
      message: { message_id: msg.message_id, chat: { id: Number(userId), type: 'private' } },
    },
    });
  };
  return { hub, bot, sent, say, click, last: () => sent.at(-1) };
}

test('telegram: /hub commands with positional and key=value args; replies fit 4096', async (t) => {
  const { hub, say, last } = telegramFixture(t);
  await say('/hub sites');
  assert.match(last().text, /^Hub sites — 1 total/);
  await say('/hub logs alpha level=debug limit=50');
  assert.ok(last().text.length <= 4096);
  assert.equal(hub.requests.at(-1).query.limit, '50');
  await say('/hub set site=alpha path=config.json key=a');
  assert.match(last().text, /File not managed/);
  await say('/hub info');
  assert.match(last().text, /Usage: \/hub info <site>/);
  await say('/hub bogus');
  assert.match(last().text, /Unknown hub command/);
  await say('/hub sites', { userId: '555' });
  assert.match(last().text, /not linked to a hub account/);
});

test('telegram: restart needs "yes" (reply or button); anything else cancels', async (t) => {
  const { hub, say, click, last, sent } = telegramFixture(t);
  await say('/hub restart alpha');
  assert.match(last().text, /Confirm restart alpha\?\n🟡 alpha — degraded · workers 3 running · 1 error/);
  const ask = last();
  await say('maybe', { replyTo: ask.message_id });
  assert.match(last().text, /Cancelled — restart was not sent/);
  assert.equal(hub.commands.length, 0);

  await say('/hub restart alpha');
  await say('yes', { replyTo: last().message_id });
  assert.match(last().text, /✅ alpha: restart delivered/);
  assert.equal(hub.commands.length, 1);

  await say('/hub stop alpha');
  const confirm = last();
  await click(confirm, 0);
  assert.equal(hub.commands.at(-1).action, 'stop');
  const before = sent.length;
  await click(confirm, 0);
  assert.equal(hub.commands.length, 2, 'a replayed confirmation does not run twice');
  assert.ok(sent.length >= before);
});

test('telegram: log pages edit in place; alert Ack buttons; file Show buttons', async (t) => {
  const { hub, say, click, last } = telegramFixture(t);
  await say('/hub logs alpha level=debug limit=50');
  const page1 = last();
  const firstText = page1.text;
  await click(page1, 0);
  assert.notEqual(page1.text, firstText, 'edited to the next page');
  assert.match(page1.text, /page 2/);

  await say('/hub alerts');
  const alerts = last();
  await click(alerts, 0);
  assert.equal(hub.acks.length, 1);
  assert.match(last().text, /acknowledged/);

  await say('/hub files alpha');
  await click(last(), 0);
  assert.match(last().text, /^\.env — env · revision 3/);
});

/* ------------------------------ alert poller ------------------------------ */

const delivery = (id, platform, channel, extra = {}) => ({ id, platform, channel, attempts: 0, alert_id: `alert-${id}-uuid`, severity: 'critical', title: 'alpha offline', body: 'No heartbeat for 5 minutes', status: 'open', site_name: 'alpha', ...extra });

test('alerts: each delivery goes to the hub-chosen channel and is reported back', async () => {
  const hub = fakeHub();
  hub.deliveries = [delivery(1, 'discord', '123:456'), delivery(2, 'telegram', '-1001'), delivery(3, 'telegram', '-1002:7')];
  const sends = [];
  const poller = createHubAlertPoller({ hub: hub.service(), send: async (target) => sends.push(target), logger: silentLogger() });
  assert.equal(await poller.deliverOnce(), 3);
  assert.deepEqual(sends.map(({ text, delivery: d, ...target }) => target), [
    { platform: 'discord', guildId: '123', channelId: '456' },
    { platform: 'telegram', chatId: '-1001', threadId: null },
    { platform: 'telegram', chatId: '-1002', threadId: '7' },
  ]);
  assert.match(sends[0].text, /^🔴 alpha offline\nSite: alpha\nNo heartbeat/);
  assert.deepEqual(hub.reports, [{ id: 1, ok: true }, { id: 2, ok: true }, { id: 3, ok: true }]);
  assert.equal(await poller.deliverOnce(), 0, 'sent deliveries are not re-sent');
  assert.equal(parseChannel({ platform: 'discord', channel: 'only-one' }), null);
  assert.match(formatAlert({ title: 't', alert_id: 'abcdef123456', status: 'resolved' }), /Status: resolved\nAlert abcdef12/);
});

test('alerts: a failed send is reported ok:false with the error and does not stop the others', async () => {
  const hub = fakeHub();
  hub.deliveries = [delivery(1, 'discord', '1:2'), delivery(2, 'slack', 'x'), delivery(3, 'telegram', '5')];
  const logger = silentLogger();
  const poller = createHubAlertPoller({
    hub: hub.service(), logger, secrets: () => ['secret-value-123'],
    send: async (target) => { if (target.platform === 'discord') throw new Error('Missing Access secret-value-123'); },
  });
  assert.equal(await poller.deliverOnce(), 1);
  assert.deepEqual(hub.reports.map((r) => [r.id, r.ok]), [[1, false], [2, false], [3, true]]);
  assert.equal(hub.reports[0].error, 'Missing Access [redacted]');
  assert.match(hub.reports[1].error, /Unknown delivery target slack:x/);
});

test('alerts: the hub being down never throws out of the loop and backs off', async () => {
  const hub = fakeHub({ down: true });
  const waits = [];
  const controller = new AbortController();
  const logger = silentLogger();
  const poller = createHubAlertPoller({
    hub: hub.service(), intervalMs: 1000, logger, send: async () => {},
    sleepImpl: async (ms) => { waits.push(ms); if (waits.length === 4) { hub.down = false; hub.deliveries = [delivery(9, 'telegram', '1')]; } if (waits.length >= 6) controller.abort(); },
  });
  await poller.start(controller.signal);
  assert.deepEqual(waits.slice(0, 4), [2000, 4000, 8000, 16000], 'exponential backoff while down');
  assert.equal(waits[4], 1000, 'back to the normal interval after recovery');
  assert.deepEqual(hub.reports, [{ id: 9, ok: true }]);
  assert.ok(logger.lines.some((l) => /\[hub-alerts\] poll failed \(1\): Hub unreachable/.test(l)));
  assert.ok(!logger.lines.some((l) => l.includes(TOKEN)));
});

test('app: hub off by default; on with HUB_URL/HUB_BOT_TOKEN; HUB_ALERTS=false disables the poller', async (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, '.env');
  const base = ['BAMBOU_LOGIN_KEY=k', 'TELEGRAM_TOKEN=1:abc', 'TELEGRAM_OWNER_ID=2', `ACCESS_FILE=${path.join(dir, 'a.json')}`];
  const factory = () => ({ name: 'telegram', async start({ signal }) { await new Promise((r) => signal.addEventListener('abort', r, { once: true })); }, async stop() {}, sendAlert: async (target) => sent.push(target) });
  const sent = [];
  const make = (lines, overrides = {}) => {
    fs.writeFileSync(file, [...base, ...lines].join('\n'));
    return createApp(loadConfig({ env: {}, file }), { factories: { telegram: factory }, logger: silentLogger(), studio: { login: async () => {}, loginKey: 'k' }, ...overrides });
  };
  const off = make([]);
  assert.equal(off.services.hub, null);
  assert.equal(off.hubAlerts, null);
  const quiet = make(['HUB_URL=https://hub.test', `HUB_BOT_TOKEN=${TOKEN}`, 'HUB_ALERTS=false']);
  assert.ok(quiet.services.hub);
  assert.equal(quiet.hubAlerts, null);

  const hub = fakeHub();
  hub.deliveries = [delivery(1, 'telegram', '-100'), delivery(2, 'discord', '1:2')];
  const controller = new AbortController();
  const app = make(['HUB_URL=https://hub.test', `HUB_BOT_TOKEN=${TOKEN}`, 'HUB_ALERT_INTERVAL_MS=5000'], {
    hubClient: hub.client(), sleepImpl: async () => { controller.abort(); },
  });
  await runApp(app, { signal: controller.signal });
  assert.deepEqual(sent.map((s) => s.chatId), ['-100']);
  assert.deepEqual(hub.reports.map((r) => [r.id, r.ok]), [[1, true], [2, false]], 'discord is not running here: reported as failed');
  assert.match(hub.reports[1].error, /discord is not running/);
});
