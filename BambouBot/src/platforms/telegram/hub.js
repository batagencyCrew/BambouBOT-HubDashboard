'use strict';

/**
 * Telegram UX for `/hub <command> [args]`. The logic is in services/hubcommands.js.
 *
 *   /hub logs alpha level=error limit=20
 *   /hub set alpha .env WORKERS 4
 *   /hub set site=alpha path=config.json key=limits.daily value="1 000"
 *
 * Dangerous commands (stop, restart, set) open a confirmation: Confirm/Cancel
 * buttons, or reply "yes" / "no" to it. Logs and alerts are paginated with
 * inline buttons; the alert list has Ack buttons and the file list Show buttons.
 *
 * Permissions are the linked hub user's (the hub answers 401/403); access.json
 * is not consulted, so anyone can link their own hub account.
 */

const { readOptions } = require('./parse');
const { ValidationError } = require('../../core/errors');
const { PLAIN } = require('../../core/format');
const { LIMITS } = require('../../core/hubformat');
const hubCommands = require('../../services/hubcommands');

const NOT_CONFIGURED = 'The hub is not configured on this bot (HUB_URL / HUB_BOT_TOKEN).';

/** Positional arguments per command; every other option is key=value only. */
const SYNTAX = {
  sites: { positionals: [] },
  info: { positionals: ['site'] },
  stats: { positionals: ['site'], allowed: ['period'] },
  start: { positionals: ['site'] },
  stop: { positionals: ['site'] },
  restart: { positionals: ['site'] },
  pause: { positionals: ['site'] },
  resume: { positionals: ['site'] },
  workers: { positionals: ['site'] },
  logs: { positionals: ['site'], allowed: ['level', 'limit'] },
  errors: { positionals: ['site'], allowed: ['limit'] },
  costs: { positionals: ['site'], allowed: ['period'] },
  balances: { positionals: ['site'] },
  proxies: { positionals: ['site'], allowed: ['period'] },
  files: { positionals: ['site'] },
  show: { positionals: ['site', 'path'] },
  set: { positionals: ['site', 'path', 'key', 'value'] },
  alerts: { positionals: [], allowed: ['status', 'site'] },
  ack: { positionals: ['id'] },
  mute: { positionals: ['id', 'minutes'] },
  backup: { positionals: ['site'] },
  link: { positionals: ['code'] },
  unlink: { positionals: [] },
  whoami: { positionals: [] },
  rules: { positionals: [] },
};
const REQUIRED = {
  info: ['site'], start: ['site'], stop: ['site'], restart: ['site'], pause: ['site'], resume: ['site'], workers: ['site'],
  logs: ['site'], errors: ['site'], proxies: ['site'], files: ['site'], show: ['site', 'path'], set: ['site', 'path', 'key'],
  ack: ['id'], mute: ['id'], backup: ['site'],
};

const YES = /^(yes|y|oui|confirm)$/i;
const NO = /^(no|n|non|cancel)$/i;

class TelegramHub {
  /** @param {import('./bot').TelegramBot} bot */
  constructor(bot) {
    this.bot = bot;
  }

  get service() {
    return this.bot.services.hub || null;
  }

  user(ctx) {
    return { platform: 'telegram', id: String(ctx.userId) };
  }

  parse(sub, tokens) {
    const syntax = SYNTAX[sub];
    const options = readOptions(tokens, { positionals: syntax.positionals, allowed: syntax.allowed || [], aliases: { file: 'path', count: 'limit' } });
    for (const name of REQUIRED[sub] || []) {
      if (!options[name]) throw new ValidationError(`Usage: /hub ${sub} ${SYNTAX[sub].positionals.map((p) => ((REQUIRED[sub] || []).includes(p) ? `<${p}>` : `[${p}]`)).join(' ')}`.trim());
    }
    if (sub === 'set' && options.value === undefined) options.value = '';
    return options;
  }

  async run(ctx, name, params, page = {}) {
    try {
      return await hubCommands.execute({ name, params, user: this.user(ctx), hub: this.service, s: PLAIN, page, max: LIMITS.telegram });
    } catch (error) {
      const text = hubCommands.hubErrorText(error, PLAIN);
      if (text === null) throw error;
      this.bot.audit(ctx, `hub.${name}.refused`, `status=${error.status}${error.permission ? ` permission=${error.permission}` : ''}`);
      return { text, refused: true };
    }
  }

  auditExecute(ctx, name, params) {
    if (['start', 'pause', 'resume', 'backup', 'ack', 'mute', 'link', 'unlink', 'stop', 'restart', 'set'].includes(name)) {
      const detail = [params.site && `site=${params.site}`, params.path && `path=${params.path}`, params.key && `key=${params.key}`, params.id && `id=${params.id}`]
        .filter(Boolean).join(' ');
      this.bot.audit(ctx, `hub.${name}.execute`, detail);
    }
  }

  async command(ctx, args) {
    const [rawSub, ...tokens] = args;
    const sub = (rawSub || '').toLowerCase();
    this.bot.audit(ctx, `hub.${sub || 'menu'}`);
    if (!this.service) return this.bot.reply(ctx, NOT_CONFIGURED);
    if (!sub || sub === 'help') {
      return this.bot.menu(ctx, `Bambou Hub\n${hubCommands.USAGE}`, [
        { label: 'Sites', command: '/hub sites' }, { label: 'Alerts', command: '/hub alerts' },
        { label: 'Overview', command: '/hub stats' }, { label: 'Link status', command: '/hub whoami' },
      ]);
    }
    if (!SYNTAX[sub]) throw new ValidationError('Unknown hub command. Send /hub for the list.');
    const params = this.parse(sub, tokens);
    if (hubCommands.needsConfirmation(sub)) return this.askConfirmation(ctx, sub, params);
    const result = await this.run(ctx, sub, params);
    if (!result.refused) this.auditExecute(ctx, sub, params);
    return this.show(ctx, sub, params, result);
  }

  /** Reply with the result and its buttons (pages, ack, show). */
  async show(ctx, name, params, result, state = null) {
    const rows = [];
    let type = null;
    if ((name === 'logs' || name === 'errors') && result.next) {
      type = 'hubLogs';
      rows.push([[`Older › page ${(state?.number || 1) + 1}`, 'next']]);
    } else if (name === 'alerts' && result.alerts?.length) {
      type = 'hubAlerts';
      rows.push(result.alerts.slice(0, 5).map((alert, index) => [`Ack ${String(alert.id).slice(0, 8)}`, `a${index}`]));
      const { number, pages } = result.page;
      const nav = [];
      if (number > 1) nav.push(['‹ Previous', `p${number - 1}`]);
      if (number < pages) nav.push(['Next ›', `p${number + 1}`]);
      if (nav.length) rows.push(nav);
    } else if (name === 'files' && result.files?.length) {
      type = 'hubFiles';
      result.files.slice(0, 6).forEach((path, index) => rows.push([[`Show ${path}`, `f${index}`]]));
    }
    if (!type) {
      if (state) await this.bot.clearButtons(state);
      return this.bot.reply(ctx, result.text);
    }
    const target = state || this.bot.newState(ctx, { type, hubCommand: name, params, number: 1 });
    if (type === 'hubLogs') target.beforeId = result.next.beforeId;
    if (type === 'hubAlerts') target.ids = result.alerts.map((alert) => alert.id);
    if (type === 'hubFiles') target.paths = result.files.slice(0, 6);
    return this.bot.interactive(ctx, target, result.text, rows, { edit: Boolean(state) });
  }

  async askConfirmation(ctx, name, params) {
    let text;
    try {
      text = await hubCommands.confirmationText({
        name, params, user: this.user(ctx), hub: this.service, s: PLAIN,
        hint: 'Press Confirm, or reply "yes" to this message (anything else cancels).',
      });
    } catch (error) {
      const refusal = hubCommands.hubErrorText(error, PLAIN);
      if (refusal === null) throw error;
      return this.bot.reply(ctx, refusal);
    }
    const state = this.bot.newState(ctx, { type: 'confirmation', operation: 'hub', hubCommand: name, params });
    await this.bot.activate(state);
    return this.bot.interactive(ctx, state, text, [[['Confirm', 'save'], ['Cancel', 'cancel']]]);
  }

  async execute(ctx, state) {
    const result = await this.run(ctx, state.hubCommand, state.params);
    if (!result.refused) this.auditExecute(ctx, state.hubCommand, state.params);
    return this.bot.reply(ctx, result.text);
  }

  /** A text reply to an open hub confirmation: "yes" runs it, anything else cancels. */
  async takeReply(ctx, state, text) {
    this.bot.consume(state);
    await this.bot.clearButtons(state);
    if (YES.test(String(text).trim())) return this.execute(ctx, state);
    this.bot.audit(ctx, 'form.cancel');
    return this.bot.reply(ctx, `Cancelled — ${state.hubCommand} was not sent${NO.test(String(text).trim()) ? '' : ' (reply "yes" to confirm)'}.`);
  }

  /** Callback buttons of hub lists; returns true when handled. */
  async callback(ctx, state, action) {
    if (state.type === 'confirmation' && state.operation === 'hub') {
      if (action !== 'save') return false;
      this.bot.consume(state);
      await this.bot.clearButtons(state);
      await this.execute(ctx, state);
      return true;
    }
    if (state.type === 'hubLogs' && action === 'next') {
      const number = (state.number || 1) + 1;
      const result = await this.run(ctx, state.hubCommand, state.params, { beforeId: state.beforeId, number });
      state.number = number;
      await this.show(ctx, state.hubCommand, state.params, result, state);
      return true;
    }
    if (state.type === 'hubAlerts') {
      if (/^p\d+$/.test(action)) {
        const result = await this.run(ctx, 'alerts', state.params, { number: Number(action.slice(1)) });
        await this.show(ctx, 'alerts', state.params, result, state);
        return true;
      }
      if (/^a\d+$/.test(action)) {
        const id = state.ids?.[Number(action.slice(1))];
        if (!id) return true;
        const result = await this.run(ctx, 'ack', { id });
        if (!result.refused) this.auditExecute(ctx, 'ack', { id });
        await this.bot.reply(ctx, result.text);
        return true;
      }
    }
    if (state.type === 'hubFiles' && /^f\d+$/.test(action)) {
      const path = state.paths?.[Number(action.slice(1))];
      if (!path) return true;
      const result = await this.run(ctx, 'show', { site: state.params.site, path });
      await this.bot.reply(ctx, result.text);
      return true;
    }
    return ['hubLogs', 'hubAlerts', 'hubFiles'].includes(state.type);
  }
}

module.exports = { TelegramHub, SYNTAX, NOT_CONFIGURED };
