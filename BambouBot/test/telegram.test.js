'use strict';

/** Telegram adapter, fully offline: real Telegram/Bambou transports against local HTTP mocks. */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const environmentBeforeImport = { ...process.env };
const { TelegramBot, COMMANDS, contextOf } = require('../src/platforms/telegram/bot');
const { TelegramClient, TelegramError } = require('../src/platforms/telegram/client');
const parse = require('../src/platforms/telegram/parse');
const fields = require('../src/core/fields');
const { BambouStudio } = require('../src/clients/bambou');
const { AccessStore } = require('../src/core/access');
const { createServices } = require('../src/services');
const { PROFILES } = require('../src/services/gms');

const helpers = { ...parse, integer: fields.integer, boolean: fields.boolean, userId: fields.userId };

const TOKEN = '12345:test-token';
const tempRoot = fs.existsSync('/tmp/opencode') ? '/tmp/opencode' : os.tmpdir();

function makeConfig() {
  return {
    version: 1,
    presets: [{
      id: '1000', name: 'Template', archivedAt: '2026-01-01',
      identity: { name: 'Lina', age: 23 }, mainSettings: { discoveryPlatform: 'Chatnow', chattingStyle: 'casual' },
      strategy: { ctaEnabled: true }, cycles: [{ untouched: true }],
      urls: { chooseRandomly: false, items: [
        { id: 'url-1', platform: 'MYM', displayLabel: 'MYM', url: 'https://old.example/mym', enabled: true },
        { id: 'url-2', platform: 'Other', displayLabel: 'Extra', url: 'https://old.example/extra', enabled: false },
      ] },
    }],
    accounts: [{ id: 'account1', presetId: '1000' }],
    snapchat: { modelSetups: [{ id: 'model1', presetId: '1000' }] },
    engine: { untouched: 'engine' }, extension: {}, unknownModule: { mustSurvive: true },
  };
}

async function fixture(t, { sessionTtlMs = 10 * 60_000 } = {}) {
  const directory = fs.mkdtempSync(path.join(tempRoot, 'bambou-telegram-'));
  const state = {
    directory, accessFile: path.join(directory, 'telegram-access.json'),
    db: makeConfig(), clock: 1000, puts: 0, keyCreates: 0, keyPatches: [], keyRevokes: [],
    requests: [], outbound: [], sent: [], messages: new Map(), logs: [], updates: [],
    nextMessage: 100, nextIncoming: 10_000, nextUpdate: 1,
    dmClosed: false, failSecret: false, failRevoke: false, webhook: '',
    keys: [
      { id: 'ak_scoped', label: 'Scoped', rpm: 20, maxConcurrent: 2, dailyLimit: 1000, callsToday: 0, presetIds: ['1000'], disabled: false, revokedAt: null },
      { id: 'ak_all', label: 'All', rpm: 30, maxConcurrent: 3, dailyLimit: 2000, callsToday: 5, presetIds: [], disabled: true, revokedAt: null },
      { id: 'ak_revoked', label: 'Revoked', rpm: 20, maxConcurrent: 2, dailyLimit: 1000, presetIds: [], disabled: true, revokedAt: '2026-01-01' },
    ],
    gmsCalls: [], gmsCreates: [], gmsRemoves: [], gmsContextFails: false,
    links: [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', originalLink: 'demo', displayName: 'Demo', status: 'active', redirectDeepLink: PROFILES.lina.url, selectedDomain: 'links.example' }],
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      state.requests.push({ method: req.method, path: url.pathname, body });
      if (url.pathname.startsWith(`/bot${TOKEN}/`)) {
        const method = url.pathname.split('/').pop();
        state.outbound.push({ method, body: structuredClone(body) });
        const ok = (result) => send(200, { ok: true, result });
        if (method === 'getMe') return ok({ id: 999, username: 'BambouTestBot', is_bot: true });
        if (method === 'getWebhookInfo') return ok({ url: state.webhook, pending_update_count: 0 });
        if (method === 'setMyCommands' || method === 'answerCallbackQuery') return ok(true);
        if (method === 'getUpdates') return ok(state.updates.filter((update) => update.update_id >= body.offset));
        if (method === 'sendMessage') {
          if (String(body.chat_id) === '111' && (state.dmClosed || state.failSecret && body.text.includes('bbk_'))) {
            return send(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
          }
          const message = {
            ...structuredClone(body), message_id: state.nextMessage++,
            chat: { id: Number(body.chat_id), type: Number(body.chat_id) < 0 ? 'supergroup' : 'private' },
            from: { id: 999, is_bot: true, first_name: 'Bambou Test' },
          };
          state.sent.push(message);
          state.messages.set(message.message_id, message);
          return ok(message);
        }
        if (method === 'editMessageText' || method === 'editMessageReplyMarkup') {
          const message = state.messages.get(body.message_id);
          if (!message) return send(400, { ok: false, error_code: 400, description: 'Bad Request: message to edit not found' });
          if (own(body, 'text')) message.text = body.text;
          if (own(body, 'reply_markup')) message.reply_markup = structuredClone(body.reply_markup);
          return ok(message);
        }
        return send(404, { ok: false, error_code: 404, description: `Unknown mock Telegram method ${method}` });
      }
      if (url.pathname === '/api/login') return send(200, { authenticated: true }, { 'Set-Cookie': 'bambou_session=test; Path=/' });
      if (!String(req.headers.cookie || '').includes('bambou_session=test')) return send(401, { error: 'Session required' });
      if (url.pathname === '/api/studio/config') {
        if (req.method === 'GET') return send(200, state.db);
        state.puts += 1;
        state.db = body;
        return send(200, state.db);
      }
      if (url.pathname === '/api/media/library') return send(200, { items: [{ id: 'media1', presetId: '1000' }] });
      if (url.pathname === '/api/studio/api-keys') {
        if (req.method === 'GET') return send(200, { keys: state.keys });
        state.keyCreates += 1;
        const key = { id: `ak_created_${state.keyCreates}`, ...body, disabled: false, revokedAt: null, callsToday: 0 };
        state.keys.push(key);
        return send(201, { ...key, key: `bbk_test_secret_${state.keyCreates}` });
      }
      const keyRoute = /^\/api\/studio\/api-keys\/([^/]+)$/.exec(url.pathname);
      if (keyRoute) {
        const id = decodeURIComponent(keyRoute[1]);
        const key = state.keys.find((item) => item.id === id);
        if (!key) return send(404, { error: 'Key not found' });
        if (req.method === 'PATCH') {
          state.keyPatches.push({ id, patch: body });
          Object.assign(key, body);
          return send(200, key);
        }
        if (req.method === 'DELETE') {
          state.keyRevokes.push(id);
          if (state.failRevoke) return send(503, { error: 'Temporary revocation failure' });
          key.revokedAt = '2026-10-25';
          key.disabled = true;
          return send(200, key);
        }
      }
      send(404, { error: `Unknown mock route: ${req.method} ${url.pathname}` });
    } catch (error) { send(500, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    fs.rmSync(directory, { recursive: true, force: true });
  });
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.telegram = new TelegramClient({ token: TOKEN, baseUrl: state.baseUrl, maxRateLimitRetries: 0 });
  state.studio = new BambouStudio({ baseUrl: state.baseUrl, loginKey: 'test-login', maxRetries: 0 });
  await state.studio.login();
  state.store = new AccessStore(state.accessFile, { owners: { telegram: '111' } });
  state.access = state.store.forPlatform('telegram');
  state.gms = {
    publicUrl: (link) => `https://${link.selectedDomain || 'getmysocial.com'}/${link.originalLink}`,
    async list(options) { state.gmsCalls.push({ method: 'list', options }); return state.links.slice(0, options.limit); },
    async resolve(ref) {
      const clean = String(ref).split('/').pop();
      return state.links.find((link) => [link._id, link.originalLink].includes(clean)) || null;
    },
    async info(ref) { state.gmsCalls.push({ method: 'info', ref }); const link = await this.resolve(ref); return link ? { link, clicks: { today: 0, last7: 12 } } : null; },
    async context() { if (state.gmsContextFails) throw new Error('Team lookup failed'); return { teamId: 'team1', teamName: 'Our team' }; },
    async createDirectLink(options) {
      state.gmsCreates.push(options);
      const link = { _id: `created-${state.gmsCreates.length}`, originalLink: options.shortcode || `generated-${state.gmsCreates.length}`, displayName: options.displayName || '', redirectDeepLink: options.url, status: 'active' };
      state.links.push(link);
      return link;
    },
    async setEnabled(ref, enabled) {
      state.gmsCalls.push({ method: 'setEnabled', ref, enabled });
      const link = await this.resolve(ref);
      if (!link) throw new Error('Link not found');
      const status = enabled ? 'active' : 'inactive';
      const changed = link.status !== status;
      link.status = status;
      return { link, status, changed };
    },
    async remove(ref) {
      state.gmsRemoves.push(ref);
      const link = await this.resolve(ref);
      if (!link) throw new Error('Link not found');
      state.links = state.links.filter((item) => item !== link);
      return { link, result: {} };
    },
    async stats(options) {
      state.gmsCalls.push({ method: 'stats', options });
      if (options.ref) return { mode: 'single', label: options.period, context: { teamName: 'Our team' }, link: await this.resolve(options.ref), row: { pageViews: 0, visitsWithClicks: 0, ctr: 0 } };
      return { mode: 'account', label: options.period, context: { teamName: 'Our team' }, rows: [{ originalLink: 'demo', pageViews: 42, visitsWithClicks: 0, ctr: 0 }], overview: { pageViews: 42, totalClicks: 0, ctr: 0 } };
    },
    refresh() { state.gmsCalls.push({ method: 'refresh' }); },
  };
  state.gmsFactory = () => state.gms;
  state.services = createServices({ studio: state.studio, getGmsService: () => state.gmsFactory(), now: () => state.clock });
  state.bot = new TelegramBot({ telegram: state.telegram, services: state.services, access: state.access,
    username: 'BambouTestBot', now: () => state.clock, sessionTtlMs,
    logger: { log: (line) => state.logs.push(line), warn: (line) => state.logs.push(line), error: (line) => state.logs.push(line) },
  });
  state.last = ({ chatId = '111', threadId = null } = {}) => [...state.sent].reverse().find((message) => String(message.chat.id) === String(chatId) && (message.message_thread_id || null) === threadId);
  state.active = ({ chatId = '111', userId = '111', threadId = null } = {}) => state.bot.sessions.peek(state.bot.activeForms.get(`${chatId}:${threadId || ''}:${userId}`));
  state.update = (text, { chatId = '111', userId = '111', threadId = null, replyTo, senderChat } = {}) => ({
    update_id: state.nextUpdate++, message: {
      message_id: state.nextIncoming++, text,
      from: { id: Number(userId), is_bot: false, first_name: 'Operator' },
      chat: { id: Number(chatId), type: Number(chatId) < 0 ? 'supergroup' : 'private' },
      ...(threadId ? { message_thread_id: threadId } : {}),
      ...(replyTo ? { reply_to_message: { message_id: replyTo } } : {}),
      ...(senderChat ? { sender_chat: senderChat } : {}),
    },
  });
  state.send = async (text, options = {}) => { await state.bot.handleUpdate(state.update(text, options)); return state.last(options); };
  state.respond = async (text, options = {}) => {
    const active = state.active(options);
    assert.ok(active, 'an active form exists');
    return state.send(text, { ...options, replyTo: active.messageId });
  };
  state.callback = (button, message, { userId = '111', chatId, threadId } = {}) => ({
    update_id: state.nextUpdate++, callback_query: {
      id: `callback-${state.nextUpdate}`, data: button.callback_data,
      from: { id: Number(userId), is_bot: false, first_name: 'Operator' },
      message: { ...structuredClone(message), ...(chatId ? { chat: { ...message.chat, id: Number(chatId) } } : {}),
        ...(threadId !== undefined ? { message_thread_id: threadId } : {}) },
    },
  });
  state.click = async (label, options = {}) => {
    const message = options.message || state.last(options);
    const button = message?.reply_markup?.inline_keyboard?.flat().find((item) => item.text === label);
    assert.ok(button, `button "${label}" exists`);
    await state.bot.handleUpdate(state.callback(button, message, options));
    return state.last(options);
  };
  return state;
}

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fullPreset = (operation, id = '7777') => `/preset ${operation} 1000 name="Nina Telegram" id=${id} first_name=Nina discovery_platform=Telegram mym_url=https://new.example/mym specific_url=https://new.example/extra specific_platform=Telegram specific_label=Contact`;
const publicHasSecret = (state, chatId = '-100') => state.sent.some((message) => String(message.chat.id) === chatId && message.text.includes('bbk_'));

test('importing the Telegram adapter does not load .env, log in or start either bot', () => {
  assert.deepEqual({ ...process.env }, environmentBeforeImport);
  assert.equal(COMMANDS.length, 11);
  assert.ok(COMMANDS.every((command) => /^[a-z_]{1,32}$/.test(command.command)));
});

test('command parser supports mentions, quoted values, booleans and both option styles', () => {
  const command = helpers.parseCommand('/key@BambouTestBot create "worker 01" rpm:25 scope="1000, 2000"', 'BambouTestBot');
  assert.equal(command.name, 'key');
  const options = helpers.readOptions(command.args.slice(1), { positionals: ['label'], allowed: ['rpm', 'scope'] });
  assert.deepEqual({ ...options }, { label: 'worker 01', rpm: '25', scope: '1000, 2000' });
  assert.equal(helpers.parseCommand('/key@OtherBot list', 'BambouTestBot'), null);
  assert.deepEqual(helpers.tokenize("John's label=\"a \\\"quoted\\\" value\""), ["John's", 'label=a "quoted" value']);
  assert.equal(helpers.boolean('false'), false);
  assert.equal(helpers.readOptions(['https://getmysocial.com/demo'], { positionals: ['link'] }).link, 'https://getmysocial.com/demo');
  assert.throws(() => helpers.tokenize('label="unfinished'), /Unclosed quote/);
  assert.throws(() => helpers.readOptions(['rpm=10', 'rpm:20'], { allowed: ['rpm'] }), /twice/);
  assert.throws(() => helpers.readOptions(['bad=1'], { allowed: ['rpm'] }), /Unknown option/);
  assert.throws(() => helpers.integer('20junk', 'rpm', 1, 600), /integer/);
  assert.throws(() => helpers.boolean('maybe'), /true or false/);
  assert.throws(() => helpers.userId('@someone'), /numeric/);
});

test('long replies preserve Unicode and attach buttons only to the last chunk', async (t) => {
  const f = await fixture(t);
  const text = `${'🌿'.repeat(3000)}\n${'x'.repeat(4500)}`;
  const markup = { inline_keyboard: [[{ text: 'Next', callback_data: 'next' }]] };
  const result = await f.telegram.sendText('-100', text, { reply_markup: markup });
  assert.equal(f.sent.map((message) => message.text).join(''), text);
  assert.ok(f.sent.every((message) => message.text.length <= 4000 && !/[\uD800-\uDBFF]$/.test(message.text)));
  assert.ok(f.sent.slice(0, -1).every((message) => !message.reply_markup));
  assert.deepEqual(result.reply_markup, markup);
});

test('Telegram retries explicit rate limits, not ambiguous sends, and redacts errors', async () => {
  let calls = 0;
  const waits = [];
  const client = new TelegramClient({ token: TOKEN, sleepImpl: async (ms) => waits.push(ms), fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too many requests', parameters: { retry_after: 2 } }), { status: 429 }) : new Response(JSON.stringify({ ok: true, result: true }));
  } });
  assert.equal(await client.call('sendMessage', {}), true);
  assert.deepEqual(waits, [2000]);
  calls = 0;
  const failing = new TelegramClient({ token: TOKEN, fetchImpl: async (url) => { calls += 1; throw new Error(`${url} bbk_do_not_log`); } });
  await assert.rejects(failing.sendMessage('111', 'test'), (error) => {
    assert.ok(!error.message.includes(TOKEN));
    assert.ok(!error.message.includes('bbk_'));
    return error instanceof TelegramError;
  });
  assert.equal(calls, 1);
  calls = 0;
  const serverError = new TelegramClient({ token: TOKEN, fetchImpl: async () => { calls += 1; return new Response(JSON.stringify({ ok: false, error_code: 503, description: 'Unavailable' }), { status: 503 }); } });
  await assert.rejects(serverError.sendMessage('111', 'test'), { errorCode: 503 });
  assert.equal(calls, 1);
});

test('polling backs off, advances offsets and ignores duplicate update IDs', async () => {
  const controller = new AbortController();
  const requests = [];
  const handled = [];
  const waits = [];
  const client = new TelegramClient({ token: TOKEN, maxRateLimitRetries: 0, sleepImpl: async (ms) => waits.push(ms), fetchImpl: async (_, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) throw new Error('Temporary connection failure');
    const result = requests.length === 2 ? [{ update_id: 10 }, { update_id: 10 }] : [{ update_id: 9 }, { update_id: 11 }];
    return new Response(JSON.stringify({ ok: true, result }));
  } });
  const offset = await client.poll(async (update) => { handled.push(update.update_id); if (update.update_id === 11) controller.abort(); }, { signal: controller.signal });
  assert.deepEqual(handled, [10, 11]);
  assert.equal(offset, 12);
  assert.equal(requests[2].offset, 11);
  assert.deepEqual(requests[0].allowed_updates, ['message', 'callback_query']);
  assert.deepEqual(waits, [1000]);
});

test('polling stops on a conflicting poller and aborts an in-flight long poll', async () => {
  const conflict = new TelegramClient({ token: TOKEN, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error_code: 409, description: 'Conflict' }), { status: 409 }) });
  await assert.rejects(conflict.poll(async () => {}), { errorCode: 409 });
  const controller = new AbortController();
  let requestStarted;
  const started = new Promise((resolve) => { requestStarted = resolve; });
  const client = new TelegramClient({ token: TOKEN, fetchImpl: async (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    requestStarted();
  }) });
  const poll = client.poll(async () => {}, { signal: controller.signal });
  await started;
  controller.abort();
  assert.equal(await poll, 0);
});

test('unapproved users can identify themselves but cannot access services', async (t) => {
  const f = await fixture(t);
  const options = { userId: '222', chatId: '-100' };
  await f.send('/whoami', options);
  assert.match(f.last(options).text, /Telegram user ID: 222/);
  for (const command of ['/preset list', '/key create worker', '/gms list', '/access list']) await f.send(command, options);
  assert.equal(f.keyCreates, 0);
  assert.equal(f.puts, 0);
  assert.equal(f.gmsCalls.length, 0);
  assert.ok(!f.requests.some((request) => request.path.startsWith('/api/studio')));
  assert.match(f.last(options).text, /Owner only/);
});

test('owner approvals persist independently and invalid grants are rejected', async (t) => {
  const f = await fixture(t);
  await f.send('/access add 222 presets+gms label="Telegram teammate"');
  assert.deepEqual(new AccessStore(f.accessFile).forPlatform('telegram').permissionsOf('222'), ['presets', 'gms']);
  assert.equal(f.access.has('222', 'keys'), false);
  await f.send('/access add 333 all');
  assert.deepEqual(f.access.permissionsOf('333').sort(), ['gms', 'keys', 'presets']);
  await f.send('/access add 444 keys+bogus');
  assert.equal(f.access.has('444', 'keys'), false);
  await f.send('/access list');
  assert.match(f.last().text, /Telegram teammate/);
  await f.send('/access remove 222');
  assert.deepEqual(new AccessStore(f.accessFile).forPlatform('telegram').permissionsOf('222'), []);
});

test('other-bot commands and anonymous/channel updates are ignored', async (t) => {
  const f = await fixture(t);
  await f.send('/preset@OtherBot list');
  await f.send('/key create worker', { senderChat: { id: -100 } });
  const update = f.update('/key create worker');
  update.message.chat.type = 'channel';
  assert.equal(contextOf(update), null);
  await f.bot.handleUpdate(update);
  assert.equal(f.sent.length, 0);
  assert.equal(f.keyCreates, 0);
});

test('guided preset duplication preserves source/modules and saves exactly once', async (t) => {
  const f = await fixture(t);
  const before = structuredClone(f.db);
  await f.send('/preset setup 1000');
  assert.equal(f.last().reply_markup.force_reply, true);
  assert.equal(f.last().reply_markup.selective, true);
  assert.match(f.last().text, /Preset name/);
  for (const value of ['Nina Telegram', '7777', 'Nina', 'Telegram', 'https://new.example/mym', 'https://new.example/extra', 'Telegram', 'Contact']) await f.respond(value);
  assert.equal(f.puts, 0);
  assert.match(f.last().text, /Nothing is saved/);
  await f.click('Save preset');
  assert.equal(f.puts, 1);
  const created = f.db.presets.find((preset) => preset.id === '7777');
  assert.equal(created.name, 'Nina Telegram');
  assert.equal(created.identity.age, 23);
  assert.equal(created.identity.name, 'Nina');
  assert.deepEqual(created.cycles, before.presets[0].cycles);
  assert.equal(created.archivedAt, null);
  assert.equal(created.urls.items.find((item) => item.platform === 'MYM').url, 'https://new.example/mym');
  assert.equal(created.urls.items.find((item) => item.platform === 'Telegram').displayLabel, 'Contact');
  assert.deepEqual(f.db.presets[0], before.presets[0]);
  assert.deepEqual(f.db.unknownModule, before.unknownModule);
  assert.deepEqual(f.db.accounts, before.accounts);
  assert.match(f.last().text, /Duplicated 1000 → 7777/);
  assert.equal(f.active(), undefined);
});

test('preset picker paginates and selects without putting IDs in callback data', async (t) => {
  const f = await fixture(t);
  for (let i = 1; i < 12; i += 1) f.db.presets.push({ ...structuredClone(f.db.presets[0]), id: String(1000 + i), name: `Template ${i}` });
  await f.send('/preset setup');
  assert.match(f.last().text, /page 1\/2/);
  assert.match(f.last().text, /MYM\+Extra\(off\)/);
  assert.ok(f.last().reply_markup.inline_keyboard.flat().every((button) => Buffer.byteLength(button.callback_data) <= 64));
  await f.click('Next ›');
  assert.match(f.last().text, /page 2\/2/);
  await f.click('1010 — Template 10');
  assert.equal(f.active().sourceId, '1010');
  assert.equal(f.puts, 0);
});

test('preset ID rename migrates accounts, Snapchat references and active scoped keys', async (t) => {
  const f = await fixture(t);
  await f.send(fullPreset('edit', '8888'));
  await f.click('Save preset');
  assert.equal(f.puts, 1);
  assert.equal(f.db.presets.length, 1);
  assert.equal(f.db.accounts[0].presetId, '8888');
  assert.equal(f.db.snapchat.modelSetups[0].presetId, '8888');
  assert.deepEqual(f.keys[0].presetIds, ['8888']);
  assert.deepEqual(f.keys[1].presetIds, []);
  assert.equal(f.keyPatches.length, 1);
  assert.match(f.last().text, /media record\(s\) keep the old ID/);
});

test('invalid IDs and URLs keep the form on the same field without saving', async (t) => {
  const f = await fixture(t);
  await f.send('/preset setup 1000');
  await f.respond('Nina');
  await f.respond('1000');
  assert.equal(f.active().index, 1);
  assert.equal(f.puts, 0);
  assert.ok(f.sent.some((message) => /already in use/.test(message.text)));
  await f.respond('7777');
  await f.send('/skip');
  await f.send('/skip');
  await f.respond('not-a-url');
  assert.equal(f.active().index, 4);
  assert.ok(f.sent.some((message) => /complete http/.test(message.text)));
});

test('/skip, /back and /cancel operate only on the caller’s active form', async (t) => {
  const f = await fixture(t);
  await f.send('/preset setup 1000');
  await f.send('/skip');
  const suggested = f.active().values.id;
  await f.send('/skip');
  assert.equal(f.active().index, 2);
  await f.send('/back');
  assert.equal(f.active().index, 1);
  assert.equal(f.active().values.id, suggested);
  await f.respond('7777');
  await f.send('/cancel');
  assert.equal(f.active(), undefined);
  assert.equal(f.puts, 0);
  await f.send(fullPreset('setup'));
  await f.send('/back');
  assert.match(f.last().text, /All fields were supplied/);
  assert.equal(f.active().phase, 'confirm');
  await f.send('/cancel');
});

test('forms reject foreign users, chats, topics, stale replies and unrelated chatter', async (t) => {
  const f = await fixture(t);
  f.access.add('222', ['presets']);
  const ctx = { chatId: '-100', threadId: 7 };
  await f.send('/preset setup 1000', ctx);
  const oldPrompt = f.last(ctx).message_id;
  await f.send('not an answer', ctx);
  await f.send('foreign', { ...ctx, userId: '222', replyTo: oldPrompt });
  await f.send('wrong topic', { ...ctx, threadId: 8, replyTo: oldPrompt });
  assert.equal(f.active(ctx).index, 0);
  await f.respond('Nina', ctx);
  await f.send('stale', { ...ctx, replyTo: oldPrompt });
  assert.equal(f.active(ctx).index, 1);
  await f.send('/cancel', ctx);
  await f.send(fullPreset('setup'), ctx);
  const confirmation = f.last(ctx);
  await f.click('Save preset', { ...ctx, userId: '222', message: confirmation });
  await f.click('Save preset', { ...ctx, chatId: '-200', message: confirmation });
  await f.click('Save preset', { ...ctx, threadId: 8, message: confirmation });
  assert.equal(f.puts, 0);
  assert.ok(f.outbound.filter((call) => call.method === 'answerCallbackQuery').every((call) => call.body.show_alert));
});

test('expiration is enforced at submission, and permissions are checked again', async (t) => {
  const f = await fixture(t, { sessionTtlMs: 100 });
  await f.send(fullPreset('setup'));
  const expired = f.last();
  f.clock += 100;
  await f.click('Save preset', { message: expired });
  assert.equal(f.puts, 0);
  assert.equal(f.active(), undefined);
  assert.match(f.outbound.at(-1).body.text, /expired/);
  f.access.add('222', ['presets']);
  const ctx = { userId: '222', chatId: '-100' };
  await f.send(fullPreset('setup'), ctx);
  const confirmation = f.last(ctx);
  f.access.remove('222');
  await f.click('Save preset', { ...ctx, message: confirmation });
  assert.equal(f.puts, 0);
  assert.match(f.last(ctx).text, /presets permission/);
});

test('double-clicking or replaying a save cannot create a second preset', async (t) => {
  const f = await fixture(t);
  await f.send(fullPreset('setup'));
  const message = f.last();
  const button = message.reply_markup.inline_keyboard.flat().find((item) => item.text === 'Save preset');
  const one = f.callback(button, message);
  const two = f.callback(button, message);
  await Promise.all([f.bot.handleUpdate(one), f.bot.handleUpdate(two)]);
  await f.bot.handleUpdate(f.callback(button, message));
  assert.equal(f.puts, 1);
  assert.equal(f.db.presets.filter((preset) => preset.id === '7777').length, 1);
});

test('key creation from a group fails before mutation when DMs are unavailable', async (t) => {
  const f = await fixture(t);
  f.dmClosed = true;
  await f.send('/key create "worker 01" rpm=25 scope=1000', { chatId: '-100' });
  assert.equal(f.keyCreates, 0);
  assert.match(f.last({ chatId: '-100' }).text, /No key was created/);
  assert.match(f.last({ chatId: '-100' }).text, /https:\/\/t.me\/BambouTestBot\?start=keys/);
  assert.equal(publicHasSecret(f), false);
});

test('group key creation delivers the secret only to its creator’s private chat', async (t) => {
  const f = await fixture(t);
  await f.send('/key create "worker 01" rpm:25 concurrent:4 daily:2500 scope:1000', { chatId: '-100', threadId: 9 });
  assert.equal(f.keyCreates, 1);
  const key = f.keys.at(-1);
  assert.equal(key.label, 'worker 01');
  assert.equal(key.rpm, 25);
  assert.equal(key.maxConcurrent, 4);
  assert.deepEqual(key.presetIds, ['1000']);
  const secrets = f.sent.filter((message) => message.text.includes('bbk_'));
  assert.equal(secrets.length, 1);
  assert.equal(String(secrets[0].chat.id), '111');
  const entity = secrets[0].entities[0];
  assert.equal(secrets[0].text.slice(entity.offset, entity.offset + entity.length), 'bbk_test_secret_1');
  assert.equal(publicHasSecret(f), false);
  assert.ok(f.logs.every((line) => !line.includes('bbk_')));
  assert.match(f.last({ chatId: '-100', threadId: 9 }).text, /secret is in your private chat/);
});

test('bare /key create guides limits and creates only after confirmation', async (t) => {
  const f = await fixture(t);
  await f.send('/key create');
  await f.respond('worker');
  for (let i = 0; i < 4; i += 1) await f.send('/skip');
  assert.equal(f.keyCreates, 0);
  await f.click('Save key');
  assert.equal(f.keyCreates, 1);
  assert.deepEqual(f.keys.at(-1).presetIds, []);
  assert.equal(f.keyRevokes.length, 0);
});

test('failed one-time secret delivery revokes the orphan key without public leakage', async (t) => {
  const f = await fixture(t);
  f.failSecret = true;
  await f.send('/key create worker', { chatId: '-100' });
  assert.equal(f.keyCreates, 1);
  assert.deepEqual(f.keyRevokes, ['ak_created_1']);
  assert.equal(publicHasSecret(f), false);
  assert.match(f.last({ chatId: '-100' }).text, /new key was revoked/);
  assert.ok(f.logs.every((line) => !line.includes('bbk_')));
});

test('an orphan that cannot be revoked is reported by ID, never by secret', async (t) => {
  const f = await fixture(t);
  f.failSecret = true;
  f.failRevoke = true;
  await f.send('/key create worker', { chatId: '-100' });
  assert.equal(f.keyCreates, 1);
  assert.equal(f.keyRevokes.length, 1);
  assert.match(f.last({ chatId: '-100' }).text, /Revoke key ak_created_1 manually/);
  assert.equal(publicHasSecret(f), false);
});

test('invalid key limits, long labels and unknown scopes do not create keys', async (t) => {
  const f = await fixture(t);
  for (const command of ['/key create worker rpm=0', '/key create worker concurrent=9', '/key create worker daily=100001', '/key create worker scope=missing', `/key create ${'x'.repeat(61)}`]) await f.send(command);
  assert.equal(f.keyCreates, 0);
  assert.equal(f.keyRevokes.length, 0);
});

test('key edits support false booleans and partial scopes; unchanged forms do not PATCH', async (t) => {
  const f = await fixture(t);
  await f.send('/key edit ak_all paused=false scope=1000 rpm=44');
  assert.equal(f.keys[1].disabled, false);
  assert.equal(f.keys[1].rpm, 44);
  assert.deepEqual(f.keys[1].presetIds, ['1000']);
  assert.deepEqual(f.keyPatches[0].patch, { rpm: 44, presetIds: ['1000'], disabled: false });
  await f.send('/key edit ak_all scope=all');
  assert.deepEqual(f.keys[1].presetIds, []);
  const count = f.keyPatches.length;
  await f.send('/key edit ak_all');
  for (let i = 0; i < 6; i += 1) await f.send('/skip');
  await f.click('Save key');
  assert.equal(f.keyPatches.length, count);
  assert.match(f.last().text, /Nothing changed/);
});

test('key picker refresh continues to exclude revoked keys', async (t) => {
  const f = await fixture(t);
  await f.send('/key delete');
  assert.match(f.last().text, /2 total/);
  assert.ok(!f.last().text.includes('ak_revoked'));
  await f.click('Refresh');
  assert.match(f.last().text, /2 total/);
  assert.ok(!f.last().text.includes('ak_revoked'));
});

test('key revocation requires its initiator or owner and consumes confirmation once', async (t) => {
  const f = await fixture(t);
  f.access.add('222', ['keys']);
  f.access.add('333', ['keys']);
  const ctx = { userId: '222', chatId: '-100' };
  await f.send('/key delete ak_scoped', ctx);
  const message = f.last(ctx);
  const button = message.reply_markup.inline_keyboard.flat().find((item) => item.text === 'Confirm (final)');
  await f.bot.handleUpdate(f.callback(button, message, { userId: '333' }));
  assert.equal(f.keyRevokes.length, 0);
  await f.bot.handleUpdate(f.callback(button, message, { userId: '111' }));
  await f.bot.handleUpdate(f.callback(button, message, { userId: '222' }));
  assert.deepEqual(f.keyRevokes, ['ak_scoped']);
});

test('simultaneous owner and initiator confirmations cannot revoke a key twice', async (t) => {
  const f = await fixture(t);
  f.access.add('222', ['keys']);
  const ctx = { userId: '222', chatId: '-100' };
  await f.send('/key delete ak_scoped', ctx);
  const message = f.last(ctx);
  const button = message.reply_markup.inline_keyboard.flat().find((item) => item.text === 'Confirm (final)');
  await Promise.all([
    f.bot.handleUpdate(f.callback(button, message, { userId: '222' })),
    f.bot.handleUpdate(f.callback(button, message, { userId: '111' })),
  ]);
  assert.deepEqual(f.keyRevokes, ['ak_scoped']);
});

test('GetMySocial wizard shares the Discord profiles and supports optional fields', async (t) => {
  const f = await fixture(t);
  await f.send('/gms create');
  assert.deepEqual(f.last().reply_markup.inline_keyboard[0].map((button) => button.text), ['Lina', 'Louise', 'Mia']);
  await f.click('Louise');
  await f.send('/skip');
  await f.send('/skip');
  assert.equal(f.gmsCreates.length, 0);
  await f.click('Create link');
  assert.deepEqual(f.gmsCreates[0], { url: PROFILES.louise.url, displayName: undefined, shortcode: undefined });
  assert.match(f.last().text, /generated-1/);
  assert.match(f.last().text, /Team: Our team/);
});

test('GetMySocial direct creation validates choices and reports success despite a team lookup failure', async (t) => {
  const f = await fixture(t);
  await f.send('/gms create __proto__ name=Wrong shortcode=wrong');
  assert.equal(f.gmsCreates.length, 0);
  f.gmsContextFails = true;
  await f.send('/gms create mia name="Mia Telegram" shortcode=mia-telegram');
  assert.equal(f.gmsCreates.length, 1);
  assert.equal(f.gmsCreates[0].url, PROFILES.mia.url);
  assert.equal(f.gmsCreates[0].displayName, 'Mia Telegram');
  assert.match(f.last().text, /Direct link created/);
});

test('GetMySocial list/info/toggles/stats/cache match the service contract', async (t) => {
  const f = await fixture(t);
  await f.send('/gms list query=demo limit=25');
  assert.match(f.last().text, /https:\/\/links.example\/demo/);
  assert.deepEqual(f.gmsCalls.at(-1).options, { query: 'demo', limit: 25 });
  await f.send('/gms info https://links.example/demo');
  assert.match(f.last().text, /Clicks today: 0 · Clicks 7d: 12/);
  await f.send('/gms disable demo');
  assert.equal(f.links[0].status, 'inactive');
  await f.send('/gms enable demo');
  assert.equal(f.links[0].status, 'active');
  for (const period of ['today', 'yesterday', 'week', 'lastweek', 'month', 'lastmonth', 'all']) await f.send(`/gms stats period=${period}`);
  assert.match(f.last().text, /Total clicks: 0/);
  assert.match(f.last().text, /CTR: 0%/);
  await f.send('/gms stats demo period=all');
  assert.match(f.last().text, /Visits: 0/);
  await f.send('/gms refresh');
  assert.equal(f.gmsCalls.at(-1).method, 'refresh');
});

test('GetMySocial deletion requires confirmation and resolves a stable link ID', async (t) => {
  const f = await fixture(t);
  await f.send('/gms delete demo confirm=false');
  assert.equal(f.gmsRemoves.length, 0);
  await f.send('/gms delete demo');
  assert.equal(f.gmsRemoves.length, 0);
  await f.click('Confirm (final)');
  assert.deepEqual(f.gmsRemoves, ['aaaaaaaaaaaaaaaaaaaaaaaa']);
  await f.send('/gms create lina name=Demo shortcode=demo2');
  await f.send('/gms delete demo2 confirm=true');
  assert.equal(f.gmsRemoves.length, 2);
});

test('public errors and labels are plain text and redact credentials', async (t) => {
  const f = await fixture(t);
  f.gmsFactory = () => { throw new Error(`Failure ${TOKEN} bbk_hidden_secret test-login`); };
  await f.send('/gms list', { chatId: '-100' });
  const message = f.last({ chatId: '-100' });
  assert.ok(!message.text.includes(TOKEN));
  assert.ok(!message.text.includes('bbk_'));
  assert.ok(!message.text.includes('test-login'));
  assert.equal(message.parse_mode, undefined);
  assert.ok(f.logs.every((line) => !line.includes(TOKEN) && !line.includes('bbk_')));
});

test('startup registers Telegram commands and polls without a Discord token', async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  f.updates = [f.update('/whoami')];
  const handle = f.bot.handleUpdate.bind(f.bot);
  f.bot.handleUpdate = async (update) => { await handle(update); controller.abort(); };
  const offset = await f.bot.run({ signal: controller.signal, pollTimeout: 1 });
  assert.equal(offset, f.updates[0].update_id + 1);
  assert.deepEqual(f.outbound.find((request) => request.method === 'setMyCommands').body.commands, COMMANDS);
  assert.ok(f.outbound.some((request) => request.method === 'getUpdates'));
  assert.match(f.last().text, /Telegram user ID: 111/);
});

test('startup does not silently delete an existing webhook', async (t) => {
  const f = await fixture(t);
  f.webhook = 'https://existing.example/webhook';
  await assert.rejects(f.bot.run(), /has a webhook/);
  assert.ok(!f.outbound.some((request) => ['getUpdates', 'deleteWebhook'].includes(request.method)));
});
