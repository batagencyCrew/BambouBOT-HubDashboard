'use strict';

/**
 * Discord slash-command definitions. Limits come from the shared field specs,
 * so Discord's client-side validation matches Telegram's server-side checks.
 */

const { SlashCommandBuilder } = require('discord.js');
const { KEY_FIELDS, fieldByKey } = require('../../core/fields');
const { permissionChoices } = require('../../services/access');
const { PROFILES, PERIODS } = require('../../services/gms');

const keyField = (key) => fieldByKey(KEY_FIELDS, key);

function integerOption(option, field, description) {
  return option.setName(field.option).setDescription(description).setMinValue(field.min).setMaxValue(field.max);
}

const presetCommand = new SlashCommandBuilder()
  .setName('preset').setDescription('BambouAI presets')
  .addSubcommand((s) => s.setName('list').setDescription('List the presets')
    .addIntegerOption((o) => o.setName('page').setDescription('Page number').setMinValue(1)))
  .addSubcommand((s) => s.setName('setup').setDescription('Duplicate a preset and configure it (Main Settings + URLs)')
    .addStringOption((o) => o.setName('source').setDescription('Preset to duplicate').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('specific_platform').setDescription('Platform of the extra URL (default Other)').setAutocomplete(true))
    .addStringOption((o) => o.setName('specific_label').setDescription('Display label of the extra URL (default = platform)').setMaxLength(100)))
  .addSubcommand((s) => s.setName('edit').setDescription('Edit the Main Settings + URLs of an existing preset')
    .addStringOption((o) => o.setName('preset').setDescription('Preset to edit').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('specific_platform').setDescription('Platform of the extra URL (default: existing / Other)').setAutocomplete(true))
    .addStringOption((o) => o.setName('specific_label').setDescription('Display label of the extra URL (default: existing / platform)').setMaxLength(100)));

const rpm = keyField('rpm');
const concurrent = keyField('concurrent');
const daily = keyField('daily');
const label = keyField('label');

const keyCommand = new SlashCommandBuilder()
  .setName('key').setDescription('BambouAI assistant API keys (bbk_)')
  .addSubcommand((s) => s.setName('list').setDescription('List the keys'))
  .addSubcommand((s) => s.setName('create').setDescription('Create a key (shown once!)')
    .addStringOption((o) => o.setName('label').setDescription('Who uses it, e.g. "alpha-01"').setRequired(true).setMaxLength(label.max))
    .addIntegerOption((o) => integerOption(o, rpm, `Generations/minute (${rpm.min}-${rpm.max}, default ${rpm.default})`))
    .addIntegerOption((o) => integerOption(o, concurrent, `Simultaneous calls (${concurrent.min}-${concurrent.max}, default ${concurrent.default})`))
    .addIntegerOption((o) => integerOption(o, daily, `Generations/day UTC (${daily.min}-${daily.max}, default ${daily.default})`))
    .addStringOption((o) => o.setName('scope').setDescription('Preset ids, comma-separated ("all" or empty = every preset)')))
  .addSubcommand((s) => s.setName('edit').setDescription('Change a key (limits, scope, pause)')
    .addStringOption((o) => o.setName('key_id').setDescription('ak_… key').setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName('label').setDescription('New label').setMaxLength(label.max))
    .addIntegerOption((o) => integerOption(o, rpm, `Generations/minute (${rpm.min}-${rpm.max})`))
    .addIntegerOption((o) => integerOption(o, concurrent, `Simultaneous calls (${concurrent.min}-${concurrent.max})`))
    .addIntegerOption((o) => integerOption(o, daily, `Generations/day UTC (${daily.min}-${daily.max})`))
    .addStringOption((o) => o.setName('scope').setDescription('Preset ids, comma-separated; "all" = every preset'))
    .addBooleanOption((o) => o.setName('paused').setDescription('true = pause the key, false = resume')))
  .addSubcommand((s) => s.setName('delete').setDescription('Revoke a key — FINAL, cannot be undone')
    .addStringOption((o) => o.setName('key_id').setDescription('ak_… key').setRequired(true).setAutocomplete(true)));

const accessCommand = new SlashCommandBuilder()
  .setName('access').setDescription('Owner only: approved users and permissions')
  .addSubcommand((s) => s.setName('add').setDescription('Approve a user (or change their permissions)')
    .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(true))
    .addStringOption((o) => o.setName('permissions').setDescription('What they may do').setRequired(true)
      .addChoices(...permissionChoices().map((value) => ({ name: value.replace(/\+/g, ' + '), value }))))
    .addStringOption((o) => o.setName('label').setDescription('Note, e.g. "BIPRO"').setMaxLength(100)))
  .addSubcommand((s) => s.setName('remove').setDescription('Remove a user')
    .addUserOption((o) => o.setName('user').setDescription('Discord user').setRequired(true)))
  .addSubcommand((s) => s.setName('list').setDescription('Show the owner and approved users'));

const PERIOD_NAMES = {
  today: 'Today', yesterday: 'Yesterday', week: 'This week', lastweek: 'Last week',
  month: 'This month', lastmonth: 'Last month', all: 'All time',
};

const linkOption = (o, required = true) => o.setName('link').setDescription('Shortcode, id, or URL').setRequired(required);

const gmsCommand = new SlashCommandBuilder()
  .setName('gms').setDescription('GetMySocial direct links: create, manage, stats')
  .addSubcommand((s) => s.setName('list').setDescription('List the direct links')
    .addStringOption((o) => o.setName('query').setDescription('Search in name / shortcode / URL'))
    .addIntegerOption((o) => o.setName('limit').setDescription('Max results (1-25, default 10)').setMinValue(1).setMaxValue(25)))
  .addSubcommand((s) => s.setName('create').setDescription('Create a direct link (a form asks for whatever you skip)')
    .addStringOption((o) => o.setName('profile').setDescription('Destination profile (asked in the form if omitted)')
      .addChoices(...Object.entries(PROFILES).map(([value, profile]) => ({ name: profile.label, value }))))
    .addStringOption((o) => o.setName('name').setDescription('Display name').setMaxLength(100))
    .addStringOption((o) => o.setName('shortcode').setDescription('Custom slug (optional — auto-generated if omitted)').setMaxLength(64)))
  .addSubcommand((s) => s.setName('info').setDescription('Show a link’s details and clicks').addStringOption((o) => linkOption(o)))
  .addSubcommand((s) => s.setName('enable').setDescription('Activate a link').addStringOption((o) => linkOption(o)))
  .addSubcommand((s) => s.setName('disable').setDescription('Deactivate a link').addStringOption((o) => linkOption(o)))
  .addSubcommand((s) => s.setName('delete').setDescription('Permanently delete a link (asks for confirmation)')
    .addStringOption((o) => linkOption(o))
    .addBooleanOption((o) => o.setName('confirm').setDescription('true = delete without the confirmation button')))
  .addSubcommand((s) => s.setName('stats').setDescription('Clicks: one link, or a leaderboard for every link')
    .addStringOption((o) => linkOption(o, false).setDescription('Optional: shortcode, id, or URL'))
    .addStringOption((o) => o.setName('period').setDescription('Time range (default: this week)')
      .addChoices(...Object.keys(PERIODS).map((value) => ({ name: PERIOD_NAMES[value] || value, value })))))
  .addSubcommand((s) => s.setName('refresh').setDescription('Clear the local cache (re-fetch links)'));

const COMMANDS = [presetCommand, keyCommand, accessCommand, gmsCommand];

module.exports = { presetCommand, keyCommand, accessCommand, gmsCommand, COMMANDS, commandsJson: () => COMMANDS.map((c) => c.toJSON()) };
