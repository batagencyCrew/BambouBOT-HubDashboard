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


/* ---------------------------------- hub ----------------------------------- */

/**
 * `/hub` has a single option list in Discord (max 25), so list-only commands
 * (rules) live here too. Each command maps to src/services/hubcommands.js.
 */
const siteOption = (o, required = true) => o.setName('site').setDescription('Site name or slug').setRequired(required).setMaxLength(100).setAutocomplete(true);
const hubPeriod = (o, def) => o.setName('period').setDescription(`Time range (default ${def})`).addChoices(
  ...['1h', '24h', '7d', '30d', '90d', '365d'].map((value) => ({ name: value, value })));
const hubLevel = (o) => o.setName('level').setDescription('Minimum level (default info)').addChoices(
  ...['debug', 'info', 'notice', 'warning', 'error', 'critical'].map((value) => ({ name: value, value })));
const hubLimit = (o) => o.setName('limit').setDescription('Lines (1-50, default 15)').setMinValue(1).setMaxValue(50);

const hubCommand = new SlashCommandBuilder()
  .setName('hub').setDescription('Bambou Hub: sites, health, logs, costs, alerts, config files')
  .addSubcommand((s) => s.setName('sites').setDescription('Every site with health and worker counts'))
  .addSubcommand((s) => s.setName('info').setDescription('One site: health, workers, host').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('stats').setDescription('Overview, or one site’s logs/metrics/costs')
    .addStringOption((o) => siteOption(o, false)).addStringOption((o) => hubPeriod(o, '24h')))
  .addSubcommand((s) => s.setName('start').setDescription('Start a site').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('stop').setDescription('Stop a site (asks for confirmation)').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('restart').setDescription('Restart a site (asks for confirmation)').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('pause').setDescription('Pause the workers').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('resume').setDescription('Resume the workers').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('workers').setDescription('Workers and their state').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('logs').setDescription('Recent logs (paginated)')
    .addStringOption((o) => siteOption(o)).addStringOption((o) => hubLevel(o)).addIntegerOption((o) => hubLimit(o)))
  .addSubcommand((s) => s.setName('errors').setDescription('Recent errors (paginated)')
    .addStringOption((o) => siteOption(o)).addIntegerOption((o) => hubLimit(o)))
  .addSubcommand((s) => s.setName('costs').setDescription('Spending for all sites or one site')
    .addStringOption((o) => siteOption(o, false)).addStringOption((o) => hubPeriod(o, '30d')))
  .addSubcommand((s) => s.setName('balances').setDescription('Provider balances (low ones flagged)')
    .addStringOption((o) => siteOption(o, false)))
  .addSubcommand((s) => s.setName('proxies').setDescription('Proxy health for a site')
    .addStringOption((o) => siteOption(o)).addStringOption((o) => hubPeriod(o, '24h')))
  .addSubcommand((s) => s.setName('files').setDescription('Managed config files of a site').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('show').setDescription('Show a config file (secrets masked)')
    .addStringOption((o) => siteOption(o))
    .addStringOption((o) => o.setName('path').setDescription('config.json, .env, proxies.txt…').setRequired(true).setMaxLength(300)))
  .addSubcommand((s) => s.setName('set').setDescription('Set one config value (asks for confirmation)')
    .addStringOption((o) => siteOption(o))
    .addStringOption((o) => o.setName('path').setDescription('File, e.g. .env or config.json').setRequired(true).setMaxLength(300))
    .addStringOption((o) => o.setName('key').setDescription('Env variable or dotted JSON path').setRequired(true).setMaxLength(200))
    .addStringOption((o) => o.setName('value').setDescription('New value (leave empty to clear)').setMaxLength(1000)))
  .addSubcommand((s) => s.setName('alerts').setDescription('Active alerts, with ack buttons'))
  .addSubcommand((s) => s.setName('ack').setDescription('Acknowledge an alert')
    .addStringOption((o) => o.setName('id').setDescription('Alert id (the 8 characters shown)').setRequired(true).setMaxLength(36)))
  .addSubcommand((s) => s.setName('mute').setDescription('Mute an alert')
    .addStringOption((o) => o.setName('id').setDescription('Alert id').setRequired(true).setMaxLength(36))
    .addIntegerOption((o) => o.setName('minutes').setDescription('Minutes (1-43200, default 60)').setMinValue(1).setMaxValue(43_200)))
  .addSubcommand((s) => s.setName('backup').setDescription('Request a backup now').addStringOption((o) => siteOption(o)))
  .addSubcommand((s) => s.setName('link').setDescription('Link this Discord account to a hub user (code from the dashboard)')
    .addStringOption((o) => o.setName('code').setDescription('Link code from the hub dashboard').setRequired(true).setMaxLength(40)))
  .addSubcommand((s) => s.setName('unlink').setDescription('Unlink this Discord account from the hub'))
  .addSubcommand((s) => s.setName('rules').setDescription('Alert rules of the hub'))
  .addSubcommand((s) => s.setName('whoami').setDescription('Which hub user this Discord account is linked to'));

const COMMANDS = [presetCommand, keyCommand, accessCommand, gmsCommand, hubCommand];

module.exports = { presetCommand, keyCommand, accessCommand, gmsCommand, hubCommand, COMMANDS, commandsJson: () => COMMANDS.map((c) => c.toJSON()) };
