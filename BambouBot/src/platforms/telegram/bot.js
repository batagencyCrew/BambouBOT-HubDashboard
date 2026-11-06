'use strict';

/**
 * Telegram adapter. All business logic lives in ../../services; this file only
 * handles Telegram UX: reply-based forms (selective ForceReply), inline-keyboard
 * pickers/confirmations, per-chat/topic/user isolation and private secret delivery.
 *
 * Importing this module has no side effects (no env, no login, no polling).
 */

const { parseCommand, readOptions } = require('./parse');
const { SessionStore } = require('../../core/sessions');
const { PermissionError, ValidationError, redact, errorText } = require('../../core/errors');
const { shorten, paginate } = require('../../core/format');
const { integer, boolean, stringValue, userId } = require('../../core/fields');
const { PERMISSIONS } = require('../../core/access');
const { parsePermissions } = require('../../services/access');
const { linkId, periodValue } = require('../../services/gms');
const render = require('../../services/render');
const { fit, LIMITS } = require('../../core/hubformat');
const { TelegramHub } = require('./hub');

const COMMANDS = [
  { command: 'start', description: 'Open the BambouAI menu' },
  { command: 'help', description: 'Commands and examples' },
  { command: 'whoami', description: 'Your Telegram ID and permissions' },
  { command: 'preset', description: 'List, duplicate and edit presets' },
  { command: 'key', description: 'Manage assistant API keys' },
  { command: 'access', description: 'Owner: approve users and permissions' },
  { command: 'gms', description: 'GetMySocial links and click statistics' },
  { command: 'hub', description: 'Bambou Hub: sites, logs, alerts, config' },
  { command: 'skip', description: 'Keep the current value in a form' },
  { command: 'back', description: 'Go back one form field' },
  { command: 'cancel', description: 'Cancel your current form' },
];

const PRESET_ALIASES = { preset: 'source', from: 'source', first: 'first_name', discovery: 'discovery_platform', mym: 'mym_url', specific: 'specific_url' };

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const contextKey = (ctx) => `${ctx.chatId}:${ctx.threadId || ''}:${ctx.userId}`;

function contextOf(update) {
  const callback = update.callback_query;
  const message = callback?.message || update.message;
  const user = callback?.from || message?.from;
  // Channels/anonymous admins do not carry the operator's personal identity.
  if (!message?.chat || !user?.id || user.is_bot || (!callback && message.sender_chat)) return null;
  if (!['private', 'group', 'supergroup'].includes(message.chat.type)) return null;
  return {
    user, userId: String(user.id), chat: message.chat, chatId: String(message.chat.id),
    threadId: message.message_thread_id || null, messageId: message.message_id,
    originMessageId: message.message_id, message, callbackId: callback?.id,
  };
}

class TelegramBot {
  /**
   * @param {object} opts
   * @param {TelegramClient} opts.telegram
   * @param {object} opts.services   from createServices()
   * @param {PlatformAccess} opts.access  access.forPlatform('telegram')
   * @param {Function} opts.audit    from createAudit()
   */
  constructor({ telegram, services, access, audit, username = '', logger = console, now = Date.now,
    sessionTtlMs = 10 * 60_000, secrets = () => [] } = {}) {
    if (!telegram || !services || !access?.ownerId) throw new Error('TelegramBot requires telegram, services and an access view with an owner.');
    userId(access.ownerId);
    this.telegram = telegram;
    this.services = services;
    this.access = access;
    this.username = username;
    this.logger = logger;
    this.now = now;
    this.sessionTtlMs = sessionTtlMs;
    this.extraSecrets = secrets;
    this.auditLog = audit || require('../../core/audit').createAudit({ logger, secrets: () => this.secrets });
    this.sessions = new SessionStore({ ttlMs: sessionTtlMs, now });
    this.activeForms = new Map();
    this.queues = new Map();
    this.hub = new TelegramHub(this);
  }

  get secrets() {
    return [this.telegram.token, this.services.studio.loginKey, this.services.hub?.client?.token, ...this.extraSecrets()].filter(Boolean);
  }

  audit(ctx, action, detail = '') {
    this.auditLog({ platform: 'telegram', userId: ctx.userId, chatId: ctx.chatId }, action, detail);
  }

  authorize(ctx, permission, ownerOnly = false) {
    if (ownerOnly ? this.access.isOwner(ctx.userId) : this.access.has(ctx.userId, permission)) return;
    this.audit(ctx, 'access.denied', `permission=${ownerOnly ? 'owner' : permission}`);
    throw new PermissionError(ownerOnly ? 'Owner only.' : `You need the ${permission} permission. Ask the owner to approve Telegram user ID ${ctx.userId}.`);
  }

  /* ------------------------------ sessions ------------------------------- */

  consume(state) {
    this.sessions.delete(state.token);
    if (this.activeForms.get(state.contextKey) === state.token) this.activeForms.delete(state.contextKey);
  }

  prune() {
    this.sessions.prune((state) => {
      if (this.activeForms.get(state.contextKey) === state.token) this.activeForms.delete(state.contextKey);
    });
  }

  newState(ctx, data) {
    this.prune();
    return this.sessions.create({
      ...data, userId: ctx.userId, chatId: ctx.chatId, threadId: ctx.threadId,
      originMessageId: ctx.originMessageId, contextKey: contextKey(ctx), messageId: null, hasButtons: false,
    });
  }

  activeForm(ctx) {
    return this.sessions.peek(this.activeForms.get(contextKey(ctx)));
  }

  async activate(state) {
    const old = this.sessions.peek(this.activeForms.get(state.contextKey));
    if (old) { this.consume(old); await this.clearButtons(old); }
    this.activeForms.set(state.contextKey, state.token);
  }

  async clearButtons(state) {
    if (state.hasButtons && state.messageId) {
      state.hasButtons = false;
      try { await this.telegram.editMessageReplyMarkup(state.chatId, state.messageId); } catch { /* old/deleted message */ }
    }
  }

  /* ------------------------------ messaging ------------------------------ */

  async reply(ctx, text, options = {}) {
    return this.telegram.sendText(ctx.chatId, redact(text, this.secrets), {
      ...(ctx.threadId ? { message_thread_id: ctx.threadId } : {}),
      ...(ctx.messageId ? { reply_parameters: { message_id: ctx.messageId, allow_sending_without_reply: true } } : {}),
      link_preview_options: { is_disabled: true },
      ...options,
    });
  }

  async answer(ctx, text, showAlert = false) {
    ctx.answered = true;
    try {
      await this.telegram.answerCallbackQuery(ctx.callbackId, text ? { text: shorten(redact(text, this.secrets), 180), show_alert: showAlert } : {});
    } catch { /* Telegram's callback acknowledgement may already have expired */ }
  }

  async interactive(ctx, state, text, rows, { edit = false } = {}) {
    const replyMarkup = { inline_keyboard: rows.map((row) => row.map(([label, action]) => ({
      text: shorten(label, 60), callback_data: `bt:${state.token}:${action}`,
    }))) };
    const content = redact(text, this.secrets);
    let message;
    if (edit && state.messageId && content.length <= 4000) {
      try {
        message = await this.telegram.editMessageText(ctx.chatId, state.messageId, content, {
          reply_markup: replyMarkup, link_preview_options: { is_disabled: true },
        });
      } catch (error) {
        if (/message is not modified/i.test(error.message)) return;
        if (!(error.errorCode === 400 && /message to edit not found|message can't be edited/i.test(error.message))) throw error;
      }
    }
    if (!message) {
      if (edit) await this.clearButtons(state);
      message = await this.reply(ctx, content, { reply_markup: replyMarkup });
    }
    state.messageId = message.message_id;
    state.hasButtons = true;
  }

  async menu(ctx, text, actions, { permission = null, ownerOnly = false } = {}) {
    const state = this.newState(ctx, { type: 'menu', actions, permission, ownerOnly });
    const rows = [];
    for (let i = 0; i < actions.length; i += 2) rows.push(actions.slice(i, i + 2).map((action, index) => [action.label, `m${i + index}`]));
    await this.interactive(ctx, state, text, rows);
  }

  async help(ctx) {
    const permissions = this.access.permissionsOf(ctx.userId);
    const lines = [
      'BambouAI — Telegram management bot',
      `Your Telegram user ID: ${ctx.userId}`,
      `Permissions: ${permissions.join(', ') || 'none (ask the owner to approve your ID)'}`,
      '',
      '/whoami — show your user/chat IDs and permissions',
      'Forms: reply to the bot’s question; /skip keeps the current value, /back corrects the previous field, /cancel abandons it.',
      'Values containing spaces must be quoted. Named options accept key=value or key:value.',
    ];
    const actions = [];
    if (permissions.includes('presets')) {
      lines.push('', 'Presets:', '/preset list [page]', '/preset setup [source_id] — duplicate + configure', '/preset edit [preset_id] — edit + migrate renamed IDs',
        '/preset setup 1000 specific_platform=Telegram specific_label="Contact"');
      actions.push({ label: 'Presets', command: '/preset list' }, { label: 'Duplicate preset', command: '/preset setup' });
    }
    if (permissions.includes('keys')) {
      lines.push('', 'API keys:', '/key list [page]', '/key create [label] [rpm=20 concurrent=2 daily=1000 scope=all]',
        '/key edit [key_id] [label=... rpm=... concurrent=... daily=... scope=... paused=true|false]', '/key delete [key_id] — confirmation required',
        'Secrets are sent only to your private chat. Open the bot there with /start before creating a key from a group.');
      actions.push({ label: 'API keys', command: '/key list' }, { label: 'Create key', command: '/key create' });
    }
    if (permissions.includes('gms')) {
      lines.push('', 'GetMySocial:', `/gms list [query] [limit=10]`, `/gms create [${Object.keys(this.services.gms.profiles).join('|')}] [name="..." shortcode=...]`,
        '/gms info <link>', '/gms enable <link> / /gms disable <link>', '/gms delete <link> [confirm=true]',
        '/gms stats [link] [period=week]', `Periods: ${Object.keys(this.services.gms.periods).join(', ')}`, '/gms refresh');
      actions.push({ label: 'GetMySocial links', command: '/gms list' }, { label: 'Click stats', command: '/gms stats' });
    }
    if (this.services.hub) {
      lines.push('', 'Bambou Hub (permissions come from your linked hub account):', '/hub — every hub command', '/hub sites · /hub alerts · /hub link <code>');
      actions.push({ label: 'Hub sites', command: '/hub sites' });
    }
    if (this.access.isOwner(ctx.userId)) {
      lines.push('', 'Owner access:', `/access add <telegram_user_id> <${PERMISSIONS.join('+')}> [label="..."]`, '/access remove <telegram_user_id>', '/access list',
        `Any combination of ${PERMISSIONS.join(', ')} is accepted; all grants every permission.`);
      actions.push({ label: 'Approved users', command: '/access list' });
    }
    if (actions.length) await this.menu(ctx, lines.join('\n'), actions);
    else await this.reply(ctx, lines.join('\n'));
  }

  /* ------------------------------- routing ------------------------------- */

  /** Queue each user's chat/topic independently; a replay cannot submit a form twice. */
  async handleUpdate(update) {
    const ctx = contextOf(update);
    if (!ctx) return;
    const key = contextKey(ctx);
    const task = (this.queues.get(key) || Promise.resolve()).then(() => this.processUpdate(ctx, update));
    this.queues.set(key, task);
    try { await task; } finally { if (this.queues.get(key) === task) this.queues.delete(key); }
  }

  async processUpdate(ctx, update) {
    this.prune();
    try {
      if (update.callback_query) return await this.handleCallback(ctx, update.callback_query.data || '');
      if (typeof ctx.message.text !== 'string') return;
      const command = parseCommand(ctx.message.text, this.username);
      if (command) return await this.command(ctx, command);
      // Commands addressed to another bot must not become a form answer.
      if (ctx.message.text.startsWith('/')) return;
      const state = this.activeForm(ctx);
      if (state?.type === 'confirmation' && state.operation === 'hub' && !this.sessions.expired(state) &&
        (ctx.message.reply_to_message?.message_id === state.messageId || ctx.chat.type === 'private')) {
        return await this.hub.takeReply(ctx, state, ctx.message.text);
      }
      if (!state || state.type !== 'form' || state.phase !== 'collect') return;
      if (ctx.message.reply_to_message?.message_id !== state.messageId) return;
      this.authorize(ctx, state.permission);
      await this.takeFormValue(ctx, state, ctx.message.text);
    } catch (error) {
      const text = errorText(error, this.secrets);
      this.audit(ctx, error instanceof ValidationError ? 'invalid' : 'error', text);
      if (ctx.callbackId && !ctx.answered) await this.answer(ctx, text, true);
      try { await this.reply(ctx, `${error instanceof PermissionError ? '⛔' : '⚠️'} ${text}`); } catch (sendError) {
        this.logger.error(`Telegram reply failed: ${errorText(sendError, this.secrets)}`);
      }
    }
  }

  async command(ctx, { name, args }) {
    if (name === 'start' || name === 'help') return this.help(ctx);
    if (name === 'whoami') return this.reply(ctx, [
      `Telegram user ID: ${ctx.userId}`, `Chat ID: ${ctx.chatId}`,
      ...(ctx.threadId ? [`Topic ID: ${ctx.threadId}`] : []),
      `Permissions: ${this.access.permissionsOf(ctx.userId).join(', ') || 'none'}`,
    ].join('\n'));
    if (['skip', 'back', 'cancel'].includes(name)) return this.formControl(ctx, name);
    if (name === 'preset') { this.authorize(ctx, 'presets'); return this.presetCommand(ctx, args); }
    if (name === 'key') { this.authorize(ctx, 'keys'); return this.keyCommand(ctx, args); }
    if (name === 'access') { this.authorize(ctx, null, true); return this.accessCommand(ctx, args); }
    if (name === 'gms') { this.authorize(ctx, 'gms'); return this.gmsCommand(ctx, args); }
    // Hub permissions come from the linked hub user (the hub checks them), not access.json.
    if (name === 'hub') return this.hub.command(ctx, args);
    return this.reply(ctx, 'Unknown command. Use /help.');
  }

  /* -------------------------------- forms -------------------------------- */

  async formControl(ctx, command) {
    const state = this.activeForm(ctx);
    if (!state) return this.reply(ctx, 'No active form (it may have expired). Start a command again.');
    this.authorize(ctx, state.permission);
    if (command === 'cancel') {
      this.consume(state);
      await this.clearButtons(state);
      this.audit(ctx, 'form.cancel');
      return this.reply(ctx, 'Cancelled — nothing was saved.');
    }
    if (state.type !== 'form') return this.reply(ctx, 'Use the confirmation buttons, or /cancel.');
    if (command === 'back') {
      if (!state.fields.length) return this.reply(ctx, 'All fields were supplied in the command. Use /cancel and run the command again to change them.');
      state.index = state.phase === 'confirm' ? state.fields.length - 1 : Math.max(0, state.index - 1);
      return this.promptForm(ctx, state);
    }
    if (state.phase !== 'collect') return this.reply(ctx, 'Review the form and use Save, /back or /cancel.');
    return this.takeFormValue(ctx, state, state.values[state.fields[state.index].key]);
  }

  /** Delegate validation to the service that owns the form. */
  validateField(field, raw, state) {
    if (state.formKind === 'preset') {
      return this.services.presets.validateField(field, raw, { operation: state.operation, sourceId: state.sourceId, values: state.values });
    }
    if (state.formKind === 'key') return this.services.keys.validateField(field, raw);
    return this.services.gms.validateField(field, raw);
  }

  async startForm(ctx, data, fields, values, options = {}) {
    // Validate supplied options before replacing an unfinished form.
    const draft = { ...data, values: { ...values } };
    const explicit = new Set();
    for (const field of fields) {
      if (own(options, field.option)) {
        draft.values[field.key] = await this.validateField(field, options[field.option], draft);
        explicit.add(field.key);
      }
    }
    const state = this.newState(ctx, {
      ...draft, type: 'form', fields: fields.filter((field) => !explicit.has(field.key)),
      explicit, index: 0, phase: 'collect',
    });
    await this.activate(state);
    this.audit(ctx, `${data.formKind}.${data.operation}.form`);
    await this.promptForm(ctx, state);
  }

  formTitle(state) {
    if (state.formKind === 'preset') return `${state.operation === 'setup' ? 'Duplicate' : 'Edit'} preset ${state.sourceId}`;
    if (state.formKind === 'key') return `${state.operation === 'create' ? 'Create' : 'Edit'} API key`;
    return 'Create GetMySocial link';
  }

  formSummary(state) {
    if (state.formKind === 'preset') return render.presetSummary(state);
    if (state.formKind === 'key') return render.keySummary(state);
    return render.gmsSummary(state.values, this.services.gms.profiles);
  }

  async promptForm(ctx, state) {
    await this.clearButtons(state);
    if (state.index >= state.fields.length) {
      state.phase = 'confirm';
      const save = state.formKind === 'preset' ? 'Save preset' : state.formKind === 'key' ? 'Save key' : 'Create link';
      return this.interactive(ctx, state, `${this.formSummary(state)}\n\nNothing is saved until you confirm.${state.fields.length ? ' /back edits the last field.' : ''}`, [
        [[save, 'save'], ['Cancel', 'cancel']],
      ]);
    }
    state.phase = 'collect';
    const field = state.fields[state.index];
    const current = state.values[field.key];
    const title = `${this.formTitle(state)} — ${state.index + 1}/${state.fields.length}`;
    const question = `${title}\n\n${field.label}\nCurrent: ${shorten(current === '' || current === undefined ? '(empty)' : current, 600)}\n\nReply to this message with a value. /skip keeps the current value; /back goes back; /cancel abandons the form.`;
    if (field.type === 'profile') {
      return this.interactive(ctx, state, question, [
        Object.values(this.services.gms.profiles).map((profile, index) => [profile.label, `v${index}`]),
        [['Cancel', 'cancel']],
      ]);
    }
    const message = await this.reply(ctx, question, {
      reply_markup: { force_reply: true, selective: true, input_field_placeholder: shorten(field.label, 64) },
      reply_parameters: { message_id: state.originMessageId, allow_sending_without_reply: true },
    });
    state.messageId = message.message_id;
  }

  async takeFormValue(ctx, state, raw) {
    const field = state.fields[state.index];
    let value;
    try { value = await this.validateField(field, raw, state); } catch (error) {
      await this.reply(ctx, `⚠️ ${errorText(error, this.secrets)}`);
      return this.promptForm(ctx, state);
    }
    if (field.key === 'specificPlatform' && !state.explicit.has('specificLabel') && state.values.specificLabel === state.values.specificPlatform) {
      state.values.specificLabel = value;
    }
    state.values[field.key] = value;
    state.index += 1;
    await this.promptForm(ctx, state);
  }

  /* ------------------------------- presets ------------------------------- */

  async presetCommand(ctx, args) {
    const [rawSub, ...tokens] = args;
    const sub = (rawSub || '').toLowerCase();
    this.audit(ctx, `preset.${sub || 'menu'}`);
    if (!sub) return this.menu(ctx, 'Presets — list, duplicate or edit.', [
      { label: 'List presets', command: '/preset list' }, { label: 'Duplicate preset', command: '/preset setup' }, { label: 'Edit preset', command: '/preset edit' },
    ], { permission: 'presets' });
    if (sub === 'list') {
      const options = readOptions(tokens, { positionals: ['page'] });
      return this.showPresets(ctx, { page: own(options, 'page') ? integer(options.page, 'page', 1) : 1 });
    }
    if (!['setup', 'edit'].includes(sub)) throw new ValidationError('Use /preset list, /preset setup or /preset edit.');
    const options = readOptions(tokens, {
      positionals: ['source'], allowed: this.services.presets.fields.map((field) => field.option), aliases: PRESET_ALIASES,
    });
    if (!options.source) return this.showPresets(ctx, { purpose: sub, options });
    return this.startPreset(ctx, sub, options.source, options);
  }

  async showPresets(ctx, { page = 1, purpose = null, options = {}, state = null, refresh = false } = {}) {
    const presets = await this.services.presets.list({ force: refresh });
    const result = paginate(presets, page, 10);
    if (!state) state = this.newState(ctx, { type: 'presetList', permission: 'presets', purpose, options });
    const edit = Boolean(state.messageId);
    state.ids = presets.map((preset) => String(preset.id));
    state.page = result.page;
    const rows = [];
    if (state.purpose) {
      result.slice.forEach((preset, index) => rows.push([[`${preset.id} — ${preset.name || '?'}`, `s${(result.page - 1) * 10 + index}`]]));
    } else rows.push([['Duplicate a preset', 'setup'], ['Edit a preset', 'edit']]);
    rows.push(this.navigation(result));
    if (state.purpose) rows.push([['Cancel', 'cancel']]);
    await this.interactive(ctx, state, [
      `${state.purpose ? `Choose a preset to ${state.purpose === 'setup' ? 'duplicate' : 'edit'}` : 'Presets'} — page ${result.page}/${result.pages} (${result.total} total)`,
      result.slice.map((preset) => render.presetLine(preset)).join('\n') || '(no presets)',
    ].join('\n'), rows, { edit });
  }

  navigation(result) {
    const navigation = [];
    if (result.page > 1) navigation.push(['‹ Previous', `p${result.page - 1}`]);
    if (result.page < result.pages) navigation.push(['Next ›', `p${result.page + 1}`]);
    navigation.push(['Refresh', 'refresh']);
    return navigation;
  }

  async startPreset(ctx, operation, sourceId, options = {}) {
    const { preset, values } = await this.services.presets.prefill(operation, sourceId, {
      specificPlatform: options.specific_platform, specificLabel: options.specific_label,
    });
    return this.startForm(ctx, { formKind: 'preset', operation, sourceId: String(preset.id), permission: 'presets' },
      this.services.presets.fields, values, options);
  }

  /* --------------------------------- keys -------------------------------- */

  async keyCommand(ctx, args) {
    const [rawSub, ...tokens] = args;
    const sub = (rawSub || '').toLowerCase();
    const keys = this.services.keys;
    this.audit(ctx, `key.${sub || 'menu'}`);
    if (!sub) return this.menu(ctx, 'Assistant API keys — secrets are delivered privately.', [
      { label: 'List keys', command: '/key list' }, { label: 'Create key', command: '/key create' },
      { label: 'Edit key', command: '/key edit' }, { label: 'Revoke key', command: '/key delete' },
    ], { permission: 'keys' });
    if (sub === 'list') {
      const options = readOptions(tokens, { positionals: ['page'] });
      return this.showKeys(ctx, { page: own(options, 'page') ? integer(options.page, 'page', 1) : 1 });
    }
    if (sub === 'create') {
      const options = readOptions(tokens, { positionals: ['label'], allowed: keys.fields.map((field) => field.option) });
      const values = keys.defaults();
      if (!options.label) return this.startForm(ctx, { formKind: 'key', operation: 'create', permission: 'keys' }, keys.fields, values, options);
      for (const field of keys.fields) if (own(options, field.option)) values[field.key] = await keys.validateField(field, options[field.option]);
      return this.createKey(ctx, values);
    }
    if (!['edit', 'delete'].includes(sub)) throw new ValidationError('Use /key list, create, edit or delete.');
    const options = readOptions(tokens, {
      positionals: ['key_id'], allowed: sub === 'edit' ? keys.editFields.map((field) => field.option) : [],
      aliases: { id: 'key_id', max_concurrent: 'concurrent', daily_limit: 'daily' },
    });
    if (!options.key_id) return this.showKeys(ctx, { purpose: sub, options });
    return this.startKeyAction(ctx, sub, options.key_id, options);
  }

  async showKeys(ctx, { page = 1, purpose = null, options = {}, state = null } = {}) {
    const effectivePurpose = state?.purpose || purpose;
    const keys = await this.services.keys.list({ includeRevoked: !effectivePurpose });
    const result = paginate(keys, page, 10);
    if (!state) state = this.newState(ctx, { type: 'keyList', permission: 'keys', purpose, options });
    const edit = Boolean(state.messageId);
    state.ids = keys.map((key) => String(key.id));
    state.page = result.page;
    const rows = [];
    if (state.purpose) result.slice.forEach((key, index) => rows.push([[`${key.id} — ${key.label || '—'}`, `s${(result.page - 1) * 10 + index}`]]));
    else rows.push([['Create key', 'create'], ['Edit key', 'edit'], ['Revoke key', 'delete']]);
    rows.push(this.navigation(result));
    if (state.purpose) rows.push([['Cancel', 'cancel']]);
    return this.interactive(ctx, state, [
      `${state.purpose ? `Choose a key to ${state.purpose === 'delete' ? 'revoke' : 'edit'}` : 'API keys'} — page ${result.page}/${result.pages} (${result.total} total)`,
      result.slice.map((key) => render.keyLine(key)).join('\n') || '(no keys)',
    ].join('\n'), rows, { edit });
  }

  async startKeyAction(ctx, operation, keyId, options = {}) {
    const keys = this.services.keys;
    const key = await keys.find(keyId);
    if (!key) throw new ValidationError(`Key ${keyId} not found. Use /key list.`);
    if (key.revokedAt) return this.reply(ctx, `Key ${key.id} is already revoked.`);
    if (operation === 'delete') return this.confirm(ctx, {
      operation: 'keyDelete', permission: 'keys', keyId: key.id, allowOwner: true,
    }, `Revoke ${key.id} (${key.label})? This is final. Use /key edit ${key.id} paused=true to pause it instead.`);
    const values = keys.valuesOf(key);
    const fields = keys.editFields;
    if (fields.some((field) => own(options, field.option))) {
      const supplied = {};
      for (const field of fields) if (own(options, field.option)) supplied[field.key] = await keys.validateField(field, options[field.option]);
      const patch = await keys.buildPatch(supplied);
      this.authorize(ctx, 'keys');
      const updated = await keys.update(key.id, patch);
      this.audit(ctx, 'key.edit.execute', `id=${key.id} fields=${Object.keys(patch).join(',')}`);
      return this.reply(ctx, `✅ ${render.keyLine(updated)}`);
    }
    return this.startForm(ctx, { formKind: 'key', operation: 'edit', keyId: key.id, permission: 'keys', original: values }, fields, values);
  }

  async createKey(ctx, values) {
    // Validate the scope before anything else, so a typo never costs a key.
    await this.services.keys.resolveScope(values.scope, { force: true });
    if (ctx.chat.type !== 'private') {
      // Telegram cannot DM a user until they have opened this bot themselves.
      // Test that path BEFORE creating an unrecoverable one-time credential.
      try {
        await this.telegram.sendMessage(ctx.userId, '📬 Your next BambouAI API key will be delivered privately here.', { disable_notification: true });
      } catch {
        const link = this.username ? `https://t.me/${this.username}?start=keys` : 'the bot’s private chat';
        return this.reply(ctx, `⛔ No key was created. Open ${link}, send /start, then retry here. The bot must be able to message you privately.`);
      }
    }
    this.authorize(ctx, 'keys');
    const result = await this.services.keys.create(values);
    const { created } = result;
    try {
      if (typeof created?.key !== 'string' || !created.key.startsWith('bbk_')) throw new Error('BambouAI did not return the one-time key secret.');
      const secret = render.keySecretMessage(result);
      await this.telegram.sendMessage(ctx.userId, secret.text, {
        entities: [{ type: 'pre', offset: secret.prefix.length, length: secret.secret.length }],
        link_preview_options: { is_disabled: true },
      });
    } catch {
      let revoked = false;
      if (created?.id) {
        try { await this.services.keys.revoke(created.id); revoked = true; } catch { /* report orphan ID, never the secret */ }
      }
      this.audit(ctx, 'key.delivery.failed', `id=${created?.id || 'unknown'} revoked=${revoked}`);
      return this.reply(ctx, `⚠️ Could not deliver the private key. ${revoked ? 'The new key was revoked; retry after fixing your private chat.' : `Revoke key ${created?.id || '(unknown ID)'} manually with /key delete or the studio.`} No secret was posted publicly.`);
    }
    this.audit(ctx, 'key.create.execute', `id=${created.id} scope=${result.presetIds.join(',') || 'all'}`);
    return this.reply(ctx, `${render.keyCreated(result)}\n📬 The secret is in your private chat.`);
  }

  /* -------------------------------- access ------------------------------- */

  async accessCommand(ctx, args) {
    const [rawSub, ...tokens] = args;
    const sub = (rawSub || '').toLowerCase();
    this.audit(ctx, `access.${sub || 'menu'}`);
    if (!sub) return this.menu(ctx, `Owner only:\n/access add <Telegram user ID> <${PERMISSIONS.join('+')}> [label="..."]\n/access remove <Telegram user ID>\n/access list\nUse all, or any combination of ${PERMISSIONS.join(', ')}.`, [
      { label: 'List approved users', command: '/access list' },
    ], { ownerOnly: true });
    if (sub === 'list') {
      readOptions(tokens);
      const users = this.access.list();
      return this.reply(ctx, `Owner: ${this.access.ownerId}\nApproved Telegram users:\n${users.map((user) => `• ${user.id} — ${user.permissions.join(', ')}${user.label ? ` (${user.label})` : ''}`).join('\n') || '(none)'}`);
    }
    if (!['add', 'remove'].includes(sub)) throw new ValidationError('Use /access add, remove or list.');
    const options = readOptions(tokens, { positionals: sub === 'add' ? ['user', 'permissions', 'label'] : ['user'] });
    const targetId = userId(options.user);
    if (sub === 'remove') {
      const result = this.access.remove(targetId);
      if (!result.ok) throw new ValidationError(result.error);
      this.audit(ctx, 'access.remove.execute', `user=${targetId}`);
      return this.reply(ctx, `✅ Telegram user ${targetId} removed.`);
    }
    const permissions = parsePermissions(options.permissions);
    const result = this.access.add(targetId, permissions, { label: stringValue(options.label, 'Label', { max: 100 }), addedBy: ctx.userId });
    if (!result.ok) throw new ValidationError(result.error);
    this.audit(ctx, 'access.add.execute', `user=${targetId} permissions=${permissions.join(',')}`);
    return this.reply(ctx, `✅ Telegram user ${targetId} approved: ${permissions.join(', ')}${result.entry.label ? ` (${result.entry.label})` : ''}.`);
  }

  /* --------------------------------- gms --------------------------------- */

  async gmsCommand(ctx, args) {
    const [rawSub, ...tokens] = args;
    const sub = (rawSub || '').toLowerCase();
    const gms = this.services.gms;
    this.audit(ctx, `gms.${sub || 'menu'}`);
    if (!sub) return this.menu(ctx, 'GetMySocial direct links and statistics. /help lists every command.', [
      { label: 'List links', command: '/gms list' }, { label: 'Create link', command: '/gms create' },
      { label: 'Click stats', command: '/gms stats' }, { label: 'Refresh cache', command: '/gms refresh' },
    ], { permission: 'gms' });
    if (sub === 'create') {
      const options = readOptions(tokens, { positionals: ['profile'], allowed: ['name', 'shortcode'] });
      if (gms.fields.every((field) => own(options, field.option))) {
        const values = {};
        for (const field of gms.fields) values[field.key] = gms.validateField(field, options[field.option]);
        return this.createGmsLink(ctx, values);
      }
      return this.startForm(ctx, { formKind: 'gms', operation: 'create', permission: 'gms' }, gms.fields,
        { profile: '', name: '', shortcode: '' }, options);
    }
    const service = gms.service;
    if (sub === 'list') {
      const options = readOptions(tokens, { positionals: ['query'], allowed: ['limit'] });
      const limit = own(options, 'limit') ? integer(options.limit, 'limit', 1, 25) : 10;
      const links = await service.list({ query: options.query || undefined, limit });
      return this.menu(ctx, [
        options.query ? `GetMySocial links matching "${options.query}"` : 'GetMySocial links',
        links.map((link) => `${render.statusIcon(link.status)} ${link.originalLink}${link.displayName ? ` — ${link.displayName}` : ''}\n${service.publicUrl(link)}`).join('\n') || '(no links)',
        `${links.length} shown; /gms info <shortcode> shows details.`,
      ].join('\n'), [{ label: 'Create link', command: '/gms create' }, { label: 'Click stats', command: '/gms stats' }], { permission: 'gms' });
    }
    if (sub === 'refresh') {
      readOptions(tokens);
      service.refresh();
      return this.reply(ctx, '🔄 GetMySocial cache cleared.');
    }
    if (sub === 'stats') {
      const options = readOptions(tokens, { positionals: ['link'], allowed: ['period'] });
      const period = periodValue(options.period);
      const result = await service.stats({ ref: options.link || undefined, period });
      return this.reply(ctx, render.asText(render.gmsStats(result)));
    }
    if (!['info', 'enable', 'disable', 'delete'].includes(sub)) throw new ValidationError('Use /gms list, create, info, enable, disable, delete, stats or refresh.');
    const options = readOptions(tokens, { positionals: ['link'], allowed: sub === 'delete' ? ['confirm'] : [] });
    if (!options.link) throw new ValidationError(`Usage: /gms ${sub} <shortcode, ID or URL>`);
    if (sub === 'info') {
      const found = await service.info(options.link);
      if (!found) return this.reply(ctx, 'No link found for that reference.');
      const { link, clicks } = found;
      const fields = render.gmsLinkFields(link, service, clicks);
      const clickLine = clicks ? [`Clicks today: ${fields.at(-2)[1]} · Clicks 7d: ${fields.at(-1)[1]}`] : [];
      return this.reply(ctx, [
        `${render.statusIcon(link.status)} ${link.originalLink}`,
        ...(clicks ? fields.slice(0, -2) : fields).map(([name, value]) => `${name}: ${value}`),
        ...clickLine,
      ].join('\n'));
    }
    if (sub === 'enable' || sub === 'disable') {
      this.authorize(ctx, 'gms');
      const result = await service.setEnabled(options.link, sub === 'enable');
      this.audit(ctx, `gms.${sub}.execute`, `id=${linkId(result.link)}`);
      return this.reply(ctx, `${render.statusIcon(result.status)} ${result.link.originalLink} is now ${result.status}${result.changed ? '' : ' (already was)'}.`);
    }
    if (own(options, 'confirm')) {
      if (!boolean(options.confirm, 'confirm')) return this.reply(ctx, 'Deletion not confirmed — use confirm=true or omit it for a confirmation button.');
      this.authorize(ctx, 'gms');
      const result = await service.remove(options.link);
      this.audit(ctx, 'gms.delete.execute', `id=${linkId(result.link)}`);
      return this.reply(ctx, `🗑️ Deleted ${result.link.originalLink} (${result.link.displayName || 'no name'}).`);
    }
    const link = await service.resolve(options.link);
    if (!link) return this.reply(ctx, 'No link found for that reference.');
    return this.confirm(ctx, { operation: 'gmsDelete', permission: 'gms', ref: linkId(link) },
      `Permanently delete ${link.originalLink} (${link.displayName || 'no name'})?\n${service.publicUrl(link)}`);
  }

  async createGmsLink(ctx, values) {
    this.authorize(ctx, 'gms');
    const result = await this.services.gms.createLink(values);
    this.audit(ctx, 'gms.create.execute', `id=${linkId(result.link)}`);
    const service = this.services.gms.service;
    return this.reply(ctx, ['✅ Direct link created', ...render.gmsCreatedFields(result, service).map(([name, value]) => `${name}: ${value}`)].join('\n'));
  }

  /* ---------------------------- confirmations ---------------------------- */

  async confirm(ctx, data, text) {
    const state = this.newState(ctx, { ...data, type: 'confirmation' });
    await this.activate(state);
    await this.interactive(ctx, state, text, [[['Confirm (final)', 'save'], ['Cancel', 'cancel']]]);
  }

  async handleCallback(ctx, data) {
    const match = /^bt:([a-f0-9]{12}):([a-z0-9]+)$/.exec(data);
    const state = match && this.sessions.peek(match[1]);
    if (!state) return this.answer(ctx, 'This form or menu expired. Start the command again.', true);
    if (ctx.chatId !== state.chatId || ctx.threadId !== state.threadId ||
      (ctx.userId !== state.userId && !(state.allowOwner && this.access.isOwner(ctx.userId)))) {
      return this.answer(ctx, 'This button belongs to another user, chat or topic.', true);
    }
    if (state.messageId !== ctx.messageId) return this.answer(ctx, 'This step is no longer active.', true);
    if (state.ownerOnly) this.authorize(ctx, null, true);
    else if (state.permission) this.authorize(ctx, state.permission);
    await this.answer(ctx);
    // An owner and the initiating user have different queues. Either may have
    // consumed this confirmation while its acknowledgement was in flight.
    if (this.sessions.peek(state.token) !== state) return;
    if (this.sessions.expired(state)) {
      this.consume(state);
      return this.reply(ctx, 'This form expired. Start the command again.');
    }
    ctx.originMessageId = state.originMessageId;
    const action = match[2];
    if (action === 'cancel') {
      this.consume(state);
      await this.clearButtons(state);
      this.audit(ctx, 'form.cancel');
      return this.reply(ctx, 'Cancelled — nothing was saved.');
    }
    if (state.type === 'menu' && /^m\d+$/.test(action)) {
      const entry = state.actions[Number(action.slice(1))];
      if (!entry) return;
      this.consume(state);
      await this.clearButtons(state);
      return this.command(ctx, parseCommand(entry.command, this.username));
    }
    if (await this.hub.callback(ctx, state, action)) return;
    if (state.type === 'presetList' || state.type === 'keyList') {
      const presets = state.type === 'presetList';
      if (/^p\d+$/.test(action) || action === 'refresh') {
        const page = action === 'refresh' ? state.page : Number(action.slice(1));
        return presets ? this.showPresets(ctx, { state, page, refresh: action === 'refresh' }) : this.showKeys(ctx, { state, page });
      }
      if (/^s\d+$/.test(action) && state.purpose) {
        const id = state.ids[Number(action.slice(1))];
        if (!id) return;
        this.consume(state);
        await this.clearButtons(state);
        return presets ? this.startPreset(ctx, state.purpose, id, state.options) : this.startKeyAction(ctx, state.purpose, id, state.options);
      }
      if ((presets ? ['setup', 'edit'] : ['create', 'edit', 'delete']).includes(action)) {
        this.consume(state);
        await this.clearButtons(state);
        return this.command(ctx, { name: presets ? 'preset' : 'key', args: [action] });
      }
      return;
    }
    if (state.type === 'form' && state.phase === 'collect' && state.fields[state.index].type === 'profile' && /^v\d+$/.test(action)) {
      const profile = Object.keys(this.services.gms.profiles)[Number(action.slice(1))];
      if (profile) return this.takeFormValue(ctx, state, profile);
      return;
    }
    if (action !== 'save' || !(state.type === 'confirmation' || (state.type === 'form' && state.phase === 'confirm'))) return;
    // Claim synchronously after acknowledgement, before any mutation await.
    this.consume(state);
    await this.clearButtons(state);
    this.authorize(ctx, state.permission);
    if (state.type === 'confirmation') {
      if (state.operation === 'keyDelete') {
        await this.services.keys.revoke(state.keyId);
        this.audit(ctx, 'key.revoke.execute', `id=${state.keyId}`);
        return this.reply(ctx, `✅ Key ${state.keyId} revoked.`);
      }
      const result = await this.services.gms.service.remove(state.ref);
      this.audit(ctx, 'gms.delete.execute', `id=${state.ref}`);
      return this.reply(ctx, `🗑️ Deleted ${result.link.originalLink} (${result.link.displayName || 'no name'}).`);
    }
    if (state.formKind === 'preset') {
      const report = await this.services.presets.save(state);
      this.audit(ctx, `preset.${state.operation}.execute`, `id=${state.values.id}`);
      return this.reply(ctx, render.presetSaveReport(report));
    }
    if (state.formKind === 'gms') return this.createGmsLink(ctx, state.values);
    if (state.operation === 'create') return this.createKey(ctx, state.values);
    const patch = await this.services.keys.buildPatch(state.values, state.original);
    if (!Object.keys(patch).length) return this.reply(ctx, 'Nothing changed — the key was left untouched.');
    this.authorize(ctx, 'keys');
    const updated = await this.services.keys.update(state.keyId, patch);
    this.audit(ctx, 'key.edit.execute', `id=${state.keyId} fields=${Object.keys(patch).join(',')}`);
    return this.reply(ctx, `✅ ${render.keyLine(updated)}`);
  }

  /** Hub alert delivery: plain text into `chatId` (optionally a forum topic). */
  async sendAlert({ chatId, threadId, text }) {
    if (!/^-?\d{1,20}$/.test(String(chatId))) throw new Error(`Telegram chat id ${chatId} is not numeric`);
    await this.telegram.sendMessage(chatId, fit(redact(text, this.secrets), LIMITS.telegram), {
      ...(threadId ? { message_thread_id: Number(threadId) } : {}),
      link_preview_options: { is_disabled: true },
    });
  }

  /* -------------------------------- startup ------------------------------ */

  /**
   * Prepare (getMe, webhook check, command registration) then long-poll until `signal` aborts.
   * The studio login is done once by the app, not here.
   */
  async run({ signal, pollTimeout = 30 } = {}) {
    const me = await this.telegram.getMe();
    this.username = me.username || this.username;
    const webhook = await this.telegram.getWebhookInfo();
    if (webhook.url) throw new Error('This Telegram bot has a webhook. Remove it before using long polling (see docs/PLATFORMS.md).');
    try { await this.telegram.setMyCommands(COMMANDS); } catch (error) {
      this.logger.warn(`[telegram] command registration failed: ${errorText(error, this.secrets)}`);
    }
    this.logger.log(`[telegram] @${this.username} ready — owner ${this.access.ownerId}`);
    return this.telegram.poll((update) => this.handleUpdate(update), {
      signal, timeout: pollTimeout,
      onError: (error) => this.logger.warn(`[telegram] polling: ${errorText(error, this.secrets)}`),
    });
  }
}

module.exports = { TelegramBot, COMMANDS, contextOf, contextKey };
