'use strict';

/**
 * Discord adapter. All business logic lives in ../../services; this file only
 * handles Discord UX: slash commands + autocomplete, modals (bridged by buttons,
 * because Discord cannot answer a modal with another modal), embeds, and private
 * secret delivery (DM, with an ephemeral fallback).
 *
 * Importing this module has no side effects. `createDiscordPlatform` (index.js)
 * wires it to a discord.js Client; the class itself is driven by plain objects
 * in the offline tests.
 */

const {
  MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  EmbedBuilder, StringSelectMenuBuilder, LabelBuilder,
} = require('discord.js');
const { PLATFORMS } = require('../../clients/bambou');
const { SessionStore } = require('../../core/sessions');
const { PermissionError, ValidationError, redact, errorText } = require('../../core/errors');
const { splitText, paginate, MARKDOWN } = require('../../core/format');
const { PRESET_FIELDS, GMS_FIELDS, fieldByKey } = require('../../core/fields');
const { parsePermissions } = require('../../services/access');
const { linkId, periodValue } = require('../../services/gms');
const render = require('../../services/render');

const EPHEMERAL = MessageFlags.Ephemeral;
const COLOR = 0x785eff; // GetMySocial brand purple
const MESSAGE_MAX = 1990;
const presetField = (key) => fieldByKey(PRESET_FIELDS, key);

class DiscordBot {
  /**
   * @param {object} opts
   * @param {object} opts.services   from createServices()
   * @param {PlatformAccess} opts.access  access.forPlatform('discord')
   * @param {Function} [opts.audit]  from createAudit()
   */
  constructor({ services, access, audit, logger = console, now = Date.now, sessionTtlMs = 10 * 60_000, secrets = () => [] } = {}) {
    if (!services || !access?.ownerId) throw new Error('DiscordBot requires services and an access view with an owner.');
    this.services = services;
    this.access = access;
    this.logger = logger;
    this.extraSecrets = secrets;
    this.auditLog = audit || require('../../core/audit').createAudit({ logger, secrets: () => this.secrets });
    this.sessions = new SessionStore({ ttlMs: sessionTtlMs, now, tokenBytes: 5 });
  }

  get secrets() {
    return [this.services.studio.loginKey, ...this.extraSecrets()].filter(Boolean);
  }

  audit(interaction, action, detail = '') {
    this.auditLog({ platform: 'discord', userId: interaction.user.id, chatId: interaction.channelId }, action, detail);
  }

  authorize(interaction, permission, ownerOnly = false) {
    const userId = interaction.user.id;
    if (ownerOnly ? this.access.isOwner(userId) : this.access.has(userId, permission)) return;
    this.audit(interaction, 'access.denied', `permission=${ownerOnly ? 'owner' : permission}`);
    throw new PermissionError(ownerOnly ? 'Owner only.' : `You need the \`${permission}\` permission for this. Ask the owner (\`/access list\`).`);
  }

  /* ------------------------------ replying ------------------------------- */

  /**
   * Reply, edit a deferred reply, or follow up, splitting long text into several
   * messages (components/embeds go on the last one).
   */
  async send(interaction, payload) {
    const base = typeof payload === 'string' ? { content: payload } : { ...payload };
    const chunks = base.content ? splitText(redact(base.content, this.secrets), MESSAGE_MAX) : [undefined];
    const { content, components, embeds, ...rest } = base;
    for (let i = 0; i < chunks.length; i += 1) {
      const last = i === chunks.length - 1;
      const message = {
        ...rest,
        ...(chunks[i] !== undefined ? { content: chunks[i] } : {}),
        ...(last && components ? { components } : {}),
        ...(last && embeds ? { embeds } : {}),
      };
      if (i === 0 && interaction.deferred && !interaction.replied) {
        const { flags, ...editable } = message;
        await interaction.editReply(editable);
      } else if (i === 0 && !interaction.replied && !interaction.deferred) await interaction.reply(message);
      else await interaction.followUp(message);
    }
  }

  async defer(interaction) {
    if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === 'function') await interaction.deferReply();
  }

  /** Error → user-facing reply; never throws. */
  async fail(interaction, error) {
    const text = errorText(error, this.secrets);
    const expected = error instanceof PermissionError || error instanceof ValidationError;
    if (!expected) this.logger.error(`[discord] interaction error: ${text}`);
    this.audit(interaction, expected ? 'invalid' : 'error', text);
    try {
      await this.send(interaction, `${error instanceof PermissionError ? '⛔' : '⚠️'} ${text}`);
    } catch { /* interaction gone */ }
  }

  ownSession(token, interaction) {
    const state = this.sessions.get(token);
    return state && state.userId === interaction.user.id ? state : null;
  }

  /* ------------------------------- routing ------------------------------- */

  async handleInteraction(interaction) {
    if (interaction.isAutocomplete()) return this.autocomplete(interaction);
    try {
      if (interaction.isModalSubmit()) {
        const [prefix, token] = interaction.customId.split(':');
        if (prefix === 'ps1') return await this.handleModalStep1(interaction, token);
        if (prefix === 'ps2') return await this.handleModalStep2(interaction, token);
        if (prefix === 'gm1') return await this.handleGmsModal(interaction, token);
        return undefined;
      }
      if (interaction.isButton()) return await this.handleButton(interaction);
      if (!interaction.isChatInputCommand()) return undefined;
      const sub = interaction.options.getSubcommand(false);
      switch (interaction.commandName) {
        case 'preset':
          this.authorize(interaction, 'presets');
          if (sub === 'list') return await this.presetList(interaction);
          return await this.openSetupForm(interaction, sub);
        case 'key':
          this.authorize(interaction, 'keys');
          return await this.handleKey(interaction);
        case 'access':
          this.authorize(interaction, null, true);
          return await this.handleAccess(interaction);
        case 'gms':
          this.authorize(interaction, 'gms');
          return await this.handleGms(interaction);
        default:
          return undefined;
      }
    } catch (error) {
      return this.fail(interaction, error);
    }
  }

  async autocomplete(interaction) {
    try {
      const focused = interaction.options.getFocused(true);
      const query = String(focused.value || '').toLowerCase();
      const userId = interaction.user.id;
      let choices = [];
      if (['source', 'preset'].includes(focused.name) && this.access.has(userId, 'presets')) {
        choices = (await this.services.presets.list())
          .filter((p) => !query || String(p.id).toLowerCase().includes(query) || String(p.name || '').toLowerCase().includes(query))
          .map((p) => ({ name: `${p.id} — ${p.name}${p.archivedAt ? ' (archived)' : ''}`.slice(0, 100), value: String(p.id) }));
      } else if (focused.name === 'specific_platform' && this.access.has(userId, 'presets')) {
        choices = PLATFORMS.filter((p) => !query || p.toLowerCase().includes(query)).map((p) => ({ name: p, value: p }));
      } else if (focused.name === 'key_id' && this.access.has(userId, 'keys')) {
        choices = (await this.services.keys.list({ includeRevoked: false }))
          .filter((k) => !query || k.id.toLowerCase().includes(query) || String(k.label).toLowerCase().includes(query))
          .map((k) => ({ name: `${k.id} — ${k.label}${k.disabled ? ' (paused)' : ''}`.slice(0, 100), value: k.id }));
      }
      await interaction.respond(choices.slice(0, 25));
    } catch {
      try { await interaction.respond([]); } catch { /* expired */ }
    }
  }

  /* ------------------------------- presets ------------------------------- */

  async presetList(interaction) {
    const presets = await this.services.presets.list();
    const page = paginate(presets, interaction.options.getInteger('page') || 1, 10);
    const lines = page.slice.map((preset) => render.presetLine(preset, MARKDOWN));
    await this.send(interaction, `**Presets** — page ${page.page}/${page.pages} (${page.total} total)\n${lines.join('\n') || '(no preset)'}`);
  }

  /** Opens step 1 (Main Settings) of the duplicate ("setup") or "edit" form. */
  async openSetupForm(interaction, kind) {
    if (!['setup', 'edit'].includes(kind)) throw new ValidationError('Unknown subcommand.');
    const sourceId = interaction.options.getString(kind === 'setup' ? 'source' : 'preset');
    const { preset, values } = await this.services.presets.prefill(kind, sourceId, {
      specificPlatform: interaction.options.getString('specific_platform') || undefined,
      specificLabel: interaction.options.getString('specific_label') || undefined,
      force: false, // must answer within 3 s; the id is re-checked against fresh data on submit
    });
    const state = this.sessions.create({ userId: interaction.user.id, kind, sourceId: String(preset.id), values });
    await interaction.showModal(this.step1Modal(state));
    this.audit(interaction, `preset.${kind}.form`, `source=${preset.id}`);
  }

  textInput(id, label, value, { required = false, max = 100, placeholder } = {}) {
    const builder = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
      .setRequired(required).setMaxLength(max);
    const initial = String(value ?? '').slice(0, max);
    if (initial) builder.setValue(initial);
    if (placeholder) builder.setPlaceholder(placeholder);
    return new ActionRowBuilder().addComponents(builder);
  }

  step1Modal(state) {
    const v = state.values;
    return new ModalBuilder()
      .setCustomId(`ps1:${state.token}`)
      .setTitle(`${state.kind === 'setup' ? 'Duplicate' : 'Edit'} ${state.sourceId}`.slice(0, 45))
      .addComponents(
        this.textInput('name', 'Preset name', v.name, { required: true, max: presetField('name').max }),
        this.textInput('id', 'Preset ID', v.id, { required: true, max: presetField('id').max }),
        this.textInput('first', 'First name', v.firstName, { max: presetField('firstName').max }),
        this.textInput('discovery', 'Discovery platform', v.discoveryPlatform, { max: presetField('discoveryPlatform').max, placeholder: 'Chatnow, snapchat, alpha.example…' }),
      );
  }

  step2Modal(state) {
    return new ModalBuilder()
      .setCustomId(`ps2:${state.token}`)
      .setTitle('URLs')
      .addComponents(
        this.textInput('mym', 'MYM URL', state.values.mymUrl, { max: 300, placeholder: 'https://…' }),
        this.textInput('specific', `Extra URL (${state.values.specificLabel || state.values.specificPlatform})`.slice(0, 45), state.values.specificUrl, { max: 300, placeholder: 'second link to send as CTA' }),
      );
  }

  formRow(token, primary) {
    return new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${primary.id}:${token}`).setLabel(primary.label).setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`pcn:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
  }

  /** Continue/cancel row for the preset form (Discord can't chain modal → modal directly). */
  setupContinueRow(token) {
    return this.formRow(token, { id: 'psc', label: 'Continue — URLs' });
  }

  async validateInto(state, keys) {
    const presets = this.services.presets;
    for (const key of keys) {
      state.values[key] = await presets.validateField(presetField(key), state.values[key], {
        operation: state.kind, sourceId: state.sourceId, values: state.values,
      });
    }
  }

  async handleModalStep1(interaction, token) {
    const state = this.ownSession(token, interaction);
    if (!state) return this.send(interaction, 'This form expired — run the command again.');
    this.authorize(interaction, 'presets');
    const read = (id) => interaction.fields.getTextInputValue(id);
    // Keep what was typed, so "Fix step 1" reopens the modal with it.
    Object.assign(state.values, { name: read('name'), id: read('id'), firstName: read('first'), discoveryPlatform: read('discovery') });
    try {
      await this.validateInto(state, ['name', 'id', 'firstName', 'discoveryPlatform']);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return this.send(interaction, { content: `⚠️ ${error.message}`, components: [this.formRow(token, { id: 'psr', label: 'Fix step 1' })] });
    }
    const v = state.values;
    const summary = [`name **${v.name}**`, `id \`${v.id}\``, v.firstName && `first name ${v.firstName}`, v.discoveryPlatform && `discovery ${v.discoveryPlatform}`]
      .filter(Boolean).join(' · ');
    await this.send(interaction, {
      content: `✅ Step 1 saved — ${summary}.\nOne more step: the URLs (MYM + extra ${v.specificLabel || v.specificPlatform}).`,
      components: [this.setupContinueRow(token)],
    });
    this.audit(interaction, `preset.${state.kind}.step1`, `source=${state.sourceId} newId=${v.id}`);
  }

  /** psc / psr buttons: (re)open a step of the preset form. */
  async continueSetup(interaction, step = 2) {
    const token = interaction.customId.split(':')[1];
    const state = this.sessions.get(token);
    if (!state) return this.send(interaction, 'This form expired — run /preset setup again.');
    if (state.userId !== interaction.user.id) return this.send(interaction, 'This button belongs to another user.');
    return interaction.showModal(step === 1 ? this.step1Modal(state) : this.step2Modal(state));
  }

  /** pcn button: abandons the form. */
  async cancelSetup(interaction) {
    const token = interaction.customId.split(':')[1];
    const state = this.sessions.get(token);
    if (state && state.userId !== interaction.user.id) return this.send(interaction, 'This button belongs to another user.');
    this.sessions.delete(token);
    return interaction.update({ content: 'Cancelled — nothing was saved.', components: [] });
  }

  async handleModalStep2(interaction, token) {
    const state = this.ownSession(token, interaction);
    if (!state) return this.send(interaction, 'This form expired — run the command again.');
    this.authorize(interaction, 'presets');
    Object.assign(state.values, {
      mymUrl: interaction.fields.getTextInputValue('mym'),
      specificUrl: interaction.fields.getTextInputValue('specific'),
    });
    try {
      await this.validateInto(state, ['mymUrl', 'specificUrl']);
    } catch (error) {
      if (!(error instanceof ValidationError)) throw error;
      return this.send(interaction, { content: `⚠️ ${error.message}`, components: [this.formRow(token, { id: 'psc', label: 'Fix URLs' })] });
    }
    // Claim the session before the mutation so a double submit cannot save twice.
    this.sessions.delete(token);
    await this.defer(interaction);
    try {
      const report = await this.services.presets.save({ operation: state.kind, sourceId: state.sourceId, values: state.values });
      this.audit(interaction, `preset.${state.kind}.execute`, `id=${report.newId}`);
      await this.send(interaction, render.presetSaveReport(report, MARKDOWN));
    } catch (error) {
      this.audit(interaction, `preset.${state.kind}.error`, error.message);
      throw error;
    }
  }

  /* --------------------------------- keys -------------------------------- */

  async handleKey(interaction) {
    const sub = interaction.options.getSubcommand();
    const keys = this.services.keys;
    const o = interaction.options;

    if (sub === 'list') {
      const list = await keys.list();
      return this.send(interaction, list.length ? list.map((key) => render.keyLine(key, MARKDOWN)).join('\n') : 'No API key yet — /key create.');
    }

    if (sub === 'create') {
      const supplied = await keys.validateSupplied({
        label: o.getString('label'), rpm: o.getInteger('rpm'), concurrent: o.getInteger('concurrent'),
        daily: o.getInteger('daily'), scope: o.getString('scope'),
      });
      await this.defer(interaction);
      const result = await keys.create(supplied);
      this.audit(interaction, 'key.create.execute', `id=${result.created?.id} scope=${result.presetIds.join(',') || 'all'}`);
      return this.deliverKeyResult(interaction, result);
    }

    const keyId = o.getString('key_id');
    const key = await keys.find(keyId);
    if (!key) throw new ValidationError(`Key \`${keyId}\` not found — /key list.`);
    if (key.revokedAt) return this.send(interaction, `Key \`${keyId}\` is already revoked.`);

    if (sub === 'delete') {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`kdel:yes:${key.id}:${interaction.user.id}`).setLabel('Revoke (final)').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`kdel:no:${key.id}:${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
      );
      return this.send(interaction, { content: `Revoke \`${key.id}\` (**${key.label}**)? This is final — pause with \`/key edit paused:true\` instead if unsure.`, components: [row] });
    }

    if (sub === 'edit') {
      const supplied = await keys.validateSupplied({
        label: o.getString('label'), rpm: o.getInteger('rpm'), concurrent: o.getInteger('concurrent'),
        daily: o.getInteger('daily'), scope: o.getString('scope'), paused: o.getBoolean('paused'),
      }, { edit: true });
      const patch = await keys.buildPatch(supplied);
      if (!Object.keys(patch).length) return this.send(interaction, 'Nothing to change — pass at least one of label/rpm/concurrent/daily/scope/paused.');
      const updated = await keys.update(key.id, patch);
      this.audit(interaction, 'key.edit.execute', `id=${key.id} fields=${Object.keys(patch).join(',')}`);
      return this.send(interaction, `✅ ${render.keyLine(updated, MARKDOWN)}`);
    }
    throw new ValidationError('Unknown subcommand.');
  }

  /**
   * The bbk_ secret is DM'd to its creator as a permanent copy; if DMs are closed
   * it falls back to an ephemeral follow-up. The channel only ever sees the public
   * confirmation. If neither private path works, the key is revoked.
   */
  async deliverKeyResult(interaction, result) {
    const { created } = result;
    const publicText = render.keyCreated(result, MARKDOWN);
    const revokeOrphan = async (why) => {
      let revoked = false;
      try { await this.services.keys.revoke(created.id); revoked = true; } catch { /* report the id, never the secret */ }
      this.audit(interaction, 'key.delivery.failed', `id=${created?.id || 'unknown'} revoked=${revoked}`);
      return `⚠️ ${why} ${revoked ? 'The new key was revoked; retry once DMs are open.' : `Revoke key \`${created?.id || '(unknown ID)'}\` manually with /key delete.`} No secret was posted publicly.`;
    };
    if (typeof created?.key !== 'string' || !created.key.startsWith('bbk_')) {
      return this.send(interaction, await revokeOrphan('BambouAI did not return the one-time key secret.'));
    }

    const secret = render.keySecretMessage(result);
    let dmSent = false;
    try {
      await interaction.user.send(`${secret.prefix}\`\`\`\n${secret.secret}\n\`\`\``);
      dmSent = true;
    } catch { /* DMs closed or the bot is blocked — fall back to a private reply */ }

    if (dmSent) return this.send(interaction, `${publicText}\n📬 A permanent copy was sent to your DMs.`);

    await this.send(interaction, `${publicText}\n📬 DMs are closed — the value is in the private message just below.`);
    try {
      // Not through send(): the secret must never be redacted or split.
      await interaction.followUp({ content: `🔑 The \`bbk_\` value — shown once, store it now:\n\`\`\`\n${secret.secret}\n\`\`\``, flags: EPHEMERAL });
    } catch {
      await interaction.followUp({ content: await revokeOrphan('Could not deliver the private key.') }).catch(() => {});
    }
    return undefined;
  }

  /* -------------------------------- buttons ------------------------------ */

  async handleButton(interaction) {
    const id = interaction.customId;
    const [prefix] = id.split(':');
    if (['psc', 'psr', 'pcn'].includes(prefix)) {
      this.authorize(interaction, 'presets');
      if (prefix === 'pcn') return this.cancelSetup(interaction);
      return this.continueSetup(interaction, prefix === 'psr' ? 1 : 2);
    }
    if (prefix === 'kdel') return this.confirmKeyDelete(interaction);
    if (prefix === 'gdel') return this.confirmGmsDelete(interaction);
    return undefined;
  }

  /** Initiator (or owner) only; permission is checked again at click time. */
  checkInitiator(interaction, initiator, permission) {
    this.authorize(interaction, permission);
    if (interaction.user.id !== initiator && !this.access.isOwner(interaction.user.id)) {
      throw new PermissionError('Only the user who started this (or the owner) can confirm.');
    }
  }

  async confirmKeyDelete(interaction) {
    const [, decision, keyId, initiator] = interaction.customId.split(':');
    this.checkInitiator(interaction, initiator, 'keys');
    if (decision === 'no') return interaction.update({ content: 'Cancelled — nothing was revoked.', components: [] });
    // Remove the buttons first so a second click cannot revoke twice.
    await interaction.update({ content: `Revoking \`${keyId}\`…`, components: [] });
    try {
      const revoked = await this.services.keys.revoke(keyId);
      this.audit(interaction, 'key.revoke.execute', `id=${keyId}`);
      await interaction.editReply({ content: `✅ Key \`${keyId}\`${revoked?.label ? ` (**${revoked.label}**)` : ''} revoked.` });
    } catch (error) {
      await interaction.editReply({ content: `⚠️ ${errorText(error, this.secrets)}` });
    }
    return undefined;
  }

  /* -------------------------------- access ------------------------------- */

  async handleAccess(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
      const user = interaction.options.getUser('user');
      const permissions = parsePermissions(interaction.options.getString('permissions'));
      const label = interaction.options.getString('label') || user.tag || user.username || '';
      const result = this.access.add(user.id, permissions, { label, addedBy: interaction.user.id });
      if (!result.ok) throw new ValidationError(result.error);
      this.audit(interaction, 'access.add.execute', `user=${user.id} permissions=${permissions.join(',')}`);
      return this.send(interaction, { content: `✅ <@${user.id}> approved with \`${permissions.join('`, `')}\` (${result.entry.label}).`, allowedMentions: { parse: [] } });
    }
    if (sub === 'remove') {
      const user = interaction.options.getUser('user');
      const result = this.access.remove(user.id);
      if (!result.ok) throw new ValidationError(result.error);
      this.audit(interaction, 'access.remove.execute', `user=${user.id}`);
      return this.send(interaction, { content: `✅ <@${user.id}> removed.`, allowedMentions: { parse: [] } });
    }
    const users = this.access.list();
    const lines = users.length
      ? users.map((u) => `• <@${u.id}> — \`${u.permissions.join('`, `')}\`${u.label ? ` (${u.label})` : ''}`)
      : ['(no approved user yet — /access add)'];
    return this.send(interaction, { content: `Owner: <@${this.access.ownerId}>\nApproved users:\n${lines.join('\n')}`, allowedMentions: { parse: [] } });
  }

  /* --------------------------------- gms --------------------------------- */

  embed(title, { description, fields = [], footer } = {}) {
    const embed = new EmbedBuilder().setColor(COLOR).setTitle(String(title).slice(0, 256));
    if (description) embed.setDescription(String(description).slice(0, 4096));
    const inline = (name) => !['Destination', 'Public URL', 'URL', 'Statistics'].includes(name);
    if (fields.length) embed.addFields(fields.slice(0, 25).map(([name, value]) => ({ name, value: String(value || '—').slice(0, 1024), inline: inline(name) })));
    if (footer) embed.setFooter({ text: footer });
    return embed;
  }

  async handleGms(interaction) {
    const sub = interaction.options.getSubcommand();
    const o = interaction.options;
    this.audit(interaction, `gms.${sub}`);
    if (sub === 'create') return this.startGmsCreate(interaction);

    const service = this.services.gms.service;
    if (sub === 'refresh') {
      service.refresh();
      return this.send(interaction, '🔄 Cache cleared — links will be re-fetched.');
    }
    if (sub === 'delete') return this.askGmsDelete(interaction);

    await this.defer(interaction);
    if (sub === 'list') {
      const query = o.getString('query') || undefined;
      const links = await service.list({ query, limit: o.getInteger('limit') || 10 });
      if (!links.length) return this.send(interaction, query ? `No links matching \`${query}\`.` : 'No links yet.');
      const lines = links.map((link) => `${render.statusIcon(link.status)} \`${link.originalLink}\`${link.displayName ? ` — ${link.displayName}` : ''}`);
      return this.send(interaction, { embeds: [this.embed(query ? `Links matching "${query}"` : 'GetMySocial links', {
        description: lines.join('\n'), footer: `${links.length} shown · use /gms info <shortcode> for details`,
      })] });
    }
    if (sub === 'info') {
      const found = await service.info(o.getString('link'));
      if (!found) return this.send(interaction, 'No link found for that reference.');
      return this.send(interaction, { embeds: [this.embed(`${render.statusIcon(found.link.status)} ${found.link.originalLink}`, {
        fields: render.gmsLinkFields(found.link, service, found.clicks),
      })] });
    }
    if (sub === 'enable' || sub === 'disable') {
      const result = await service.setEnabled(o.getString('link'), sub === 'enable');
      this.audit(interaction, `gms.${sub}.execute`, `id=${linkId(result.link)}`);
      return this.send(interaction, `${render.statusIcon(result.status)} \`${result.link.originalLink}\` is now **${result.status}**${result.changed ? '' : ' (already was)'}.`);
    }
    if (sub === 'stats') {
      const result = await service.stats({ ref: o.getString('link') || undefined, period: periodValue(o.getString('period') || 'week') });
      const view = render.gmsStats(result, MARKDOWN);
      if (view.empty) return this.send(interaction, view.empty);
      return this.send(interaction, { embeds: [this.embed(view.title, { description: view.lines.join('\n') || undefined, fields: view.fields, footer: view.footer })] });
    }
    throw new ValidationError('Unknown subcommand.');
  }

  async askGmsDelete(interaction) {
    const service = this.services.gms.service;
    const ref = interaction.options.getString('link');
    const confirm = interaction.options.getBoolean('confirm');
    if (confirm === false) return this.send(interaction, 'Deletion not confirmed — omit `confirm` for a confirmation button, or set it to true.');
    await this.defer(interaction);
    const link = await service.resolve(ref);
    if (!link) return this.send(interaction, 'No link found for that reference.');
    if (confirm === true) return this.deleteGmsLink(interaction, linkId(link));
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`gdel:yes:${linkId(link)}:${interaction.user.id}`.slice(0, 100)).setLabel('Delete (final)').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`gdel:no:-:${interaction.user.id}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );
    return this.send(interaction, { content: `Permanently delete \`${link.originalLink}\` (${link.displayName || 'no name'})?\n${service.publicUrl(link)}`, components: [row] });
  }

  async deleteGmsLink(interaction, ref) {
    const result = await this.services.gms.service.remove(ref);
    this.audit(interaction, 'gms.delete.execute', `id=${linkId(result.link)}`);
    return `🗑️ Deleted \`${result.link.originalLink}\` (${result.link.displayName || 'no name'}).`;
  }

  async confirmGmsDelete(interaction) {
    const [, decision, ref, initiator] = interaction.customId.split(':');
    this.checkInitiator(interaction, initiator, 'gms');
    if (decision === 'no') return interaction.update({ content: 'Cancelled — nothing was deleted.', components: [] });
    await interaction.update({ content: 'Deleting…', components: [] });
    try {
      await interaction.editReply({ content: await this.deleteGmsLink(interaction, ref) });
    } catch (error) {
      await interaction.editReply({ content: `⚠️ ${errorText(error, this.secrets)}` });
    }
    return undefined;
  }

  /** /gms create: opens a modal for whatever was not passed; creates directly if everything was. */
  async startGmsCreate(interaction) {
    const gms = this.services.gms;
    const o = interaction.options;
    const values = { profile: o.getString('profile') || '', name: o.getString('name') || '', shortcode: o.getString('shortcode') || '' };
    if (values.shortcode) values.shortcode = gms.validateField(fieldByKey(GMS_FIELDS, 'shortcode'), values.shortcode);
    const missing = [];
    if (!gms.profiles[values.profile]) missing.push('profile');
    if (!values.name) missing.push('name');
    if (!values.shortcode) missing.push('shortcode');
    const state = this.sessions.create({ userId: interaction.user.id, values, missing });
    if (missing.length) return interaction.showModal(this.gmsModal(state));
    return this.finishGmsCreate(interaction, state);
  }

  gmsModal(state) {
    const gms = this.services.gms;
    const components = state.missing.map((id) => {
      if (id === 'profile') {
        return new LabelBuilder().setLabel('Destination profile').setStringSelectMenuComponent(
          new StringSelectMenuBuilder().setCustomId('profile').setPlaceholder('Choose the destination profile')
            .setMinValues(1).setMaxValues(1)
            .addOptions(Object.entries(gms.profiles).map(([value, p]) => ({ label: p.label, value }))),
        );
      }
      const field = fieldByKey(GMS_FIELDS, id);
      const input = new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(field.max);
      if (id === 'shortcode') input.setPlaceholder('auto-generated if left empty');
      return new LabelBuilder().setLabel(id === 'name' ? 'Display name (optional)' : 'Custom shortcode (optional)').setTextInputComponent(input);
    });
    return new ModalBuilder().setCustomId(`gm1:${state.token}`).setTitle('New direct link').addComponents(...components);
  }

  async handleGmsModal(interaction, token) {
    const state = this.ownSession(token, interaction);
    if (!state) return this.send(interaction, '⌛ This form expired (or belongs to someone else) — run `/gms create` again.');
    this.authorize(interaction, 'gms');
    for (const id of state.missing) {
      if (id === 'profile') {
        const [picked] = interaction.fields.getStringSelectValues(id);
        if (picked) state.values.profile = picked;
      } else {
        state.values[id] = interaction.fields.getTextInputValue(id).trim();
      }
    }
    return this.finishGmsCreate(interaction, state);
  }

  async finishGmsCreate(interaction, state) {
    this.sessions.delete(state.token);
    const gms = this.services.gms;
    if (!gms.profiles[state.values.profile]) return this.send(interaction, '⚠️ No destination profile selected — run `/gms create` again.');
    const values = {
      profile: state.values.profile,
      name: gms.validateField(fieldByKey(GMS_FIELDS, 'name'), state.values.name),
      shortcode: gms.validateField(fieldByKey(GMS_FIELDS, 'shortcode'), state.values.shortcode),
    };
    await this.defer(interaction);
    const result = await gms.createLink(values);
    this.audit(interaction, 'gms.create.execute', `id=${linkId(result.link)}`);
    const fields = render.gmsCreatedFields(result, gms.service);
    const team = fields.find(([name]) => name === 'Team');
    return this.send(interaction, { embeds: [this.embed('✅ Direct link created', {
      fields: fields.filter(([name]) => name !== 'Team'), footer: team ? `Team: ${team[1]}` : undefined,
    })] });
  }
}

module.exports = { DiscordBot };
