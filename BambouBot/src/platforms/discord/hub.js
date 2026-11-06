'use strict';

/**
 * Discord UX for `/hub`. The logic is in services/hubcommands.js; this file reads
 * slash options, asks for confirmation with buttons, and paginates logs/alerts.
 *
 * Permissions are the linked hub user's (the hub answers 401/403). access.json is
 * not consulted: a Discord user with no approval can still link a hub account.
 *
 * Custom ids (≤ 100 chars):  hcf:<yes|no>:<token>   confirm a dangerous command
 *                            hpg:<token>            older log page
 *                            hal:<token>:<page>     alert page
 *                            hak:<token>:<index>    acknowledge an alert of the page
 *                            hfs:<token>:<index>    show a file of the list
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { MARKDOWN, shorten } = require('../../core/format');
const { ValidationError, errorText } = require('../../core/errors');
const { LIMITS } = require('../../core/hubformat');
const hubCommands = require('../../services/hubcommands');

const PREFIXES = ['hcf', 'hpg', 'hal', 'hak', 'hfs'];
const NOT_CONFIGURED = 'The hub is not configured on this bot (HUB_URL / HUB_BOT_TOKEN).';

const button = (id, label, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId(id).setLabel(shorten(label, 80)).setStyle(style);

class DiscordHub {
  /** @param {import('./bot').DiscordBot} bot */
  constructor(bot) {
    this.bot = bot;
  }

  get service() {
    return this.bot.services.hub || null;
  }

  user(interaction) {
    return { platform: 'discord', id: String(interaction.user.id) };
  }

  /** Read and normalise the slash options of one subcommand. */
  params(interaction, sub) {
    const o = interaction.options;
    const str = (name) => {
      const value = o.getString(name);
      return value === null || value === undefined ? undefined : String(value);
    };
    const int = (name) => o.getInteger(name) ?? undefined;
    return {
      site: str('site')?.trim() || undefined,
      period: str('period'),
      level: str('level'),
      limit: int('limit'),
      path: str('path')?.trim(),
      key: str('key')?.trim(),
      value: sub === 'set' ? str('value') ?? '' : undefined,
      id: str('id')?.trim(),
      minutes: int('minutes'),
      code: str('code')?.trim(),
    };
  }

  /** Run a command; hub-side refusals become a one-line reply, never a crash. */
  async run(interaction, name, params, page = {}) {
    try {
      return await hubCommands.execute({ name, params, user: this.user(interaction), hub: this.service, s: MARKDOWN, page, max: LIMITS.discord });
    } catch (error) {
      const text = hubCommands.hubErrorText(error, MARKDOWN);
      if (text === null) throw error;
      this.bot.audit(interaction, `hub.${name}.refused`, `status=${error.status}${error.permission ? ` permission=${error.permission}` : ''}`);
      return { text, refused: true };
    }
  }

  async handle(interaction) {
    const sub = interaction.options.getSubcommand();
    if (!this.service) return this.bot.send(interaction, NOT_CONFIGURED);
    if (!hubCommands.COMMANDS.includes(sub)) throw new ValidationError('Unknown subcommand.');
    const params = this.params(interaction, sub);
    this.bot.audit(interaction, `hub.${sub}`, params.site ? `site=${params.site}` : '');
    await this.bot.defer(interaction);

    if (hubCommands.needsConfirmation(sub)) return this.askConfirmation(interaction, sub, params);

    const result = await this.run(interaction, sub, params);
    if (!result.refused) this.auditExecute(interaction, sub, params);
    return this.bot.send(interaction, this.payload(interaction, sub, params, result));
  }

  auditExecute(interaction, name, params) {
    if (['start', 'pause', 'resume', 'backup', 'ack', 'mute', 'link', 'unlink', 'stop', 'restart', 'set'].includes(name)) {
      const detail = [params.site && `site=${params.site}`, params.path && `path=${params.path}`, params.key && `key=${params.key}`, params.id && `id=${params.id}`]
        .filter(Boolean).join(' ');
      this.bot.audit(interaction, `hub.${name}.execute`, detail);
    }
  }

  /** Message + the buttons that belong to the result (pages, ack, show). */
  payload(interaction, name, params, result, state = null) {
    const rows = [];
    const sessions = this.bot.sessions;
    if ((name === 'logs' || name === 'errors') && result.next) {
      const next = state || sessions.create({ userId: interaction.user.id, kind: 'hubLogs', name, params, number: 1 });
      next.beforeId = result.next.beforeId;
      rows.push(new ActionRowBuilder().addComponents(button(`hpg:${next.token}`, `Older › page ${(next.number || 1) + 1}`)));
    }
    if (name === 'alerts' && result.alerts?.length) {
      const list = state || sessions.create({ userId: interaction.user.id, kind: 'hubAlerts', params });
      list.ids = result.alerts.map((alert) => alert.id);
      const acks = result.alerts.slice(0, 5).map((alert, index) => button(`hak:${list.token}:${index}`, `Ack ${String(alert.id).slice(0, 8)}`, ButtonStyle.Primary));
      rows.push(new ActionRowBuilder().addComponents(...acks));
      const { number, pages } = result.page;
      if (pages > 1) {
        const nav = [];
        if (number > 1) nav.push(button(`hal:${list.token}:${number - 1}`, '‹ Previous'));
        if (number < pages) nav.push(button(`hal:${list.token}:${number + 1}`, 'Next ›'));
        rows.push(new ActionRowBuilder().addComponents(...nav));
      }
    }
    if (name === 'files' && result.files?.length) {
      const paths = result.files.slice(0, 5);
      const list = sessions.create({ userId: interaction.user.id, kind: 'hubFiles', params, paths });
      rows.push(new ActionRowBuilder().addComponents(...paths.map((path, index) => button(`hfs:${list.token}:${index}`, `Show ${path}`))));
    }
    return { content: result.text, components: rows, allowedMentions: { parse: [] } };
  }

  async askConfirmation(interaction, name, params) {
    let text;
    try {
      text = await hubCommands.confirmationText({ name, params, user: this.user(interaction), hub: this.service, s: MARKDOWN });
    } catch (error) {
      const refusal = hubCommands.hubErrorText(error, MARKDOWN);
      if (refusal === null) throw error;
      return this.bot.send(interaction, refusal);
    }
    const state = this.bot.sessions.create({ userId: interaction.user.id, kind: 'hubConfirm', name, params });
    const label = name === 'set' ? 'Save value' : `${name[0].toUpperCase()}${name.slice(1)} now`;
    const row = new ActionRowBuilder().addComponents(
      button(`hcf:yes:${state.token}`, label, ButtonStyle.Danger),
      button(`hcf:no:${state.token}`, 'Cancel'),
    );
    return this.bot.send(interaction, { content: text, components: [row], allowedMentions: { parse: [] } });
  }

  /* -------------------------------- buttons ------------------------------- */

  handles(prefix) {
    return PREFIXES.includes(prefix);
  }

  ownState(interaction, token) {
    const state = this.bot.sessions.get(token);
    if (!state) return { error: 'This hub message expired — run the command again.' };
    if (state.userId !== interaction.user.id) return { error: 'This button belongs to another user.' };
    return { state };
  }

  async button(interaction) {
    if (!this.service) return interaction.reply({ content: NOT_CONFIGURED, flags: 64 });
    const [prefix, a, b] = interaction.customId.split(':');
    const token = prefix === 'hcf' ? b : a;
    const { state, error } = this.ownState(interaction, token);
    if (error) return interaction.reply({ content: error, flags: 64 });

    if (prefix === 'hcf') {
      // Claim before running so a double click cannot run the command twice.
      this.bot.sessions.delete(token);
      if (a !== 'yes') return interaction.update({ content: 'Cancelled — nothing was sent to the hub.', components: [] });
      await interaction.update({ content: `Sending ${state.name} to the hub…`, components: [] });
      const result = await this.run(interaction, state.name, state.params).catch((failure) => ({ text: `⚠️ ${errorText(failure, this.bot.secrets)}`, refused: true }));
      if (!result.refused) this.auditExecute(interaction, state.name, state.params);
      return interaction.editReply({ content: result.text, components: [] });
    }
    if (prefix === 'hpg') {
      const number = (state.number || 1) + 1;
      const result = await this.run(interaction, state.name, state.params, { beforeId: state.beforeId, number });
      state.number = number;
      if (!result.next) state.beforeId = null;
      return interaction.update(this.payload(interaction, state.name, state.params, result, result.next ? state : null));
    }
    if (prefix === 'hal') {
      const result = await this.run(interaction, 'alerts', state.params, { number: Number(b) || 1 });
      return interaction.update(this.payload(interaction, 'alerts', state.params, result, state));
    }
    if (prefix === 'hak') {
      const id = state.ids?.[Number(b)];
      if (!id) return interaction.reply({ content: 'That alert is no longer on this page.', flags: 64 });
      const result = await this.run(interaction, 'ack', { id });
      if (!result.refused) this.auditExecute(interaction, 'ack', { id });
      return interaction.reply({ content: result.text, allowedMentions: { parse: [] } });
    }
    if (prefix === 'hfs') {
      const path = state.paths?.[Number(b)];
      if (!path) return interaction.reply({ content: 'That file is no longer listed.', flags: 64 });
      const result = await this.run(interaction, 'show', { site: state.params.site, path });
      return interaction.reply({ content: result.text, allowedMentions: { parse: [] } });
    }
    return undefined;
  }

  /* ------------------------------ autocomplete ----------------------------- */

  async autocomplete(interaction, query) {
    if (!this.service) return [];
    const sites = await this.service.sites(this.user(interaction));
    return sites
      .filter((site) => !query || site.name.toLowerCase().includes(query) || String(site.slug).includes(query))
      .map((site) => ({ name: shorten(`${site.name} — ${site.health || '?'}`, 100), value: String(site.slug || site.name).slice(0, 100) }));
  }
}

module.exports = { DiscordHub, NOT_CONFIGURED, PREFIXES };
