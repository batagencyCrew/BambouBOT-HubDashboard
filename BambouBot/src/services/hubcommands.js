'use strict';

/**
 * Platform-neutral hub commands. Both adapters (Discord slash commands, Telegram
 * `/hub …`) parse their own syntax, then call `execute()` and render the returned
 * text with the platform's style (PLAIN for Telegram, MARKDOWN for Discord).
 *
 * Permissions are never checked here: every hub call acts as the linked hub user
 * and the hub answers 401 (not linked) or 403 (missing permission). `hubErrorText`
 * turns those into one-line replies instead of errors.
 */

const { HubError } = require('../clients/hub');
const { DANGEROUS, LIFECYCLE } = require('./hub');
const fmt = require('../core/hubformat');
const { PLAIN, shorten } = require('../core/format');
const { ValidationError } = require('../core/errors');

const COMMANDS = [
  'sites', 'info', 'stats', 'start', 'stop', 'restart', 'pause', 'resume', 'workers',
  'logs', 'errors', 'costs', 'balances', 'proxies', 'files', 'show', 'set',
  'alerts', 'ack', 'mute', 'backup', 'link', 'unlink', 'whoami', 'rules',
];

const USAGE = [
  '/hub sites — every site with health and worker counts',
  '/hub info <site> · /hub stats [site] [period=24h] · /hub workers <site>',
  `/hub ${LIFECYCLE.join(' | ')} <site> — stop/restart ask for confirmation`,
  '/hub logs <site> [level=info] [limit=15] · /hub errors <site> [limit=15]',
  '/hub costs [site] [period=30d] · /hub balances [site] · /hub proxies <site>',
  '/hub files <site> · /hub show <site> <path> · /hub set <site> <path> <key> <value>',
  '/hub alerts · /hub ack <id> · /hub mute <id> [minutes=60] · /hub rules',
  '/hub backup <site> · /hub link <code> (no code = status) · /hub unlink · /hub rules',
  'Periods: 1h, 24h, 7d, 30d, 90d, 365d. Values with spaces must be quoted.',
].join('\n');

/** One-line reply for hub errors the user can fix; null = unexpected (log it). */
function hubErrorText(error, s = PLAIN) {
  if (!(error instanceof HubError)) return null;
  if (error.code === 'unlinked') return fmt.linkHelp(s);
  if (error.code === 'forbidden') return `⛔ ${error.message}`;
  if (['not_found', 'invalid', 'conflict', 'rate_limited'].includes(error.code)) return `⚠️ ${error.message}`;
  return null;
}

function needsConfirmation(name) {
  return DANGEROUS.has(name);
}

/** Text shown before a dangerous command runs, with the site's live health. */
async function confirmationText({ name, params, user, hub, s = PLAIN, hint = 'Nothing runs until you confirm.' }) {
  const site = await hub.site(user, params.site);
  const lines = [];
  if (name === 'set') {
    // Fails early (404, wrong format) before anything is asked; shows the masked current value.
    const file = await hub.file(user, params.site, params.path);
    if (!['env', 'json'].includes(file.format)) {
      throw new ValidationError(`${params.path} is a ${file.format} file; only .env and JSON files can be edited key by key from chat.`);
    }
    lines.push(`Confirm set ${s.code(params.key)} in ${s.code(file.path)} on ${s.bold(site.name)}?`,
      `Current: ${currentValue(file, params.key)} → new: ${params.value === '' ? '(empty)' : shorten(params.value, 200)}`);
  } else {
    lines.push(`Confirm ${name} ${s.bold(site.name)}?`);
  }
  lines.push(fmt.siteLine(site, s), hint);
  return lines.join('\n');
}

/** Masked current value of an env key / dotted JSON path, from the hub's parsed view. */
function currentValue(file, key) {
  if (file.format === 'env' && Array.isArray(file.parsed)) {
    const item = file.parsed.find((entry) => entry.key === key);
    return item ? shorten(String(item.value), 200) || '(empty)' : '(not set)';
  }
  if (file.format === 'json' && file.parsed && typeof file.parsed === 'object') {
    let node = file.parsed;
    for (const part of String(key).split('.')) {
      if (node === null || typeof node !== 'object' || !(part in node)) return '(not set)';
      node = node[part];
    }
    return shorten(typeof node === 'string' ? node : JSON.stringify(node), 200);
  }
  return '(unknown)';
}

/**
 * Run one hub command.
 * @param {object} opts
 * @param {string} opts.name
 * @param {object} opts.params      already validated/normalised by the adapter
 * @param {{platform:string,id:string}} opts.user
 * @param {object} opts.hub         HubService
 * @param {object} [opts.s]         style (PLAIN / MARKDOWN)
 * @param {object} [opts.page]      { beforeId } for logs
 * @param {number} [opts.max]       message limit (fmt.LIMITS.discord / .telegram)
 * @returns {Promise<{text:string, next?:{beforeId:number}, list?:object}>}
 */
async function execute(opts) {
  const max = opts.max || fmt.LIMITS.telegram;
  const result = await run({ ...opts, max });
  return { ...result, text: fmt.fit(result.text, max) };
}

async function run({ name, params = {}, user, hub, s = PLAIN, page = {}, max }) {
  switch (name) {
    case 'sites': {
      const list = await hub.sites(user);
      return { text: fmt.sites(list, s) };
    }
    case 'info':
      return { text: fmt.siteDetails(await hub.site(user, params.site), s) };
    case 'stats': {
      if (!params.site) {
        const overview = await hub.overview(user);
        const totals = overview.totals || {};
        const cost = Object.entries(totals.cost_today || {}).map(([currency, amount]) => `${Number(amount).toFixed(2)} ${currency}`).join(', ') || '—';
        return {
          text: [
            `${s.bold('Overview')} — ${totals.sites ?? 0} sites · ${totals.online ?? 0} online`,
            `Healthy ${totals.healthy ?? 0} · degraded ${totals.degraded ?? 0} · offline ${totals.offline ?? 0}`,
            `Workers: ${fmt.workerSummary({ workers: { running: totals.workers_running, idle: totals.workers_idle, error: totals.workers_error }, worker_total: (totals.workers_running || 0) + (totals.workers_idle || 0) + (totals.workers_error || 0) })}`,
            `Errors (24h): ${totals.errors_24h ?? 0} · cost today: ${cost}`,
            `Alerts: ${(overview.alerts || []).length} active`,
          ].join('\n'),
        };
      }
      return { text: fmt.stats(await hub.stats(user, params.site, params.period), s) };
    }
    case 'start': case 'stop': case 'restart': case 'pause': case 'resume':
      return { text: fmt.commandResult(await hub.command(user, params.site, name), s) };
    case 'workers':
      return { text: fmt.workers(await hub.workers(user, params.site), s) };
    case 'logs': case 'errors': {
      const level = name === 'errors' ? 'error' : params.level;
      const result = await hub.logs(user, { site: params.site, level, limit: params.limit, beforeId: page.beforeId });
      const items = result?.items || [];
      if (!items.length) return { text: page.beforeId ? 'No older entry.' : name === 'errors' ? 'No error logged for that site.' : 'No log entry at that level.' };
      const header = `${s.bold(name === 'errors' ? 'Errors' : 'Logs')}${params.site ? ` — ${params.site}` : ''}${level ? ` (${level}+)` : ''}${page.number > 1 ? ` · page ${page.number}` : ''}`;
      const view = fmt.fitLines(header, items.map((item) => fmt.logLine(item)), max - 120);
      // Keyset pagination: continue right after the last line actually shown.
      const cut = view.shown < items.length;
      const nextBefore = cut ? items[view.shown - 1].id : result?.next_before_id || null;
      const footer = nextBefore ? (cut ? `${items.length - view.shown} more line(s) on the next page.` : 'Older entries on the next page.') : 'End of the log.';
      return { text: `${view.text}\n${footer}`, ...(nextBefore ? { next: { beforeId: nextBefore } } : {}) };
    }
    case 'costs':
      return { text: fmt.costs(await hub.costs(user, { site: params.site, period: params.period, groupBy: params.groupBy }), s) };
    case 'balances':
      return { text: fmt.balances(await hub.balances(user, { site: params.site }), s) };
    case 'proxies':
      return { text: fmt.proxies(await hub.proxies(user, params.site, params.period), s) };
    case 'files': {
      const list = await hub.files(user, params.site);
      return { text: fmt.files(list, s), files: list.map((file) => file.path) };
    }
    case 'show':
      return { text: fmt.fileView(await hub.file(user, params.site, params.path), s) };
    case 'set': {
      const result = await hub.setFileValue(user, params.site, params.path, params.key, params.value);
      return { text: fmt.fileWrite(result, params.key, s) };
    }
    case 'alerts': {
      const all = await hub.alerts(user, { status: params.status, site: params.site, limit: 200 });
      const size = params.pageSize || 10;
      const pages = Math.max(1, Math.ceil(all.length / size));
      const number = Math.min(Math.max(1, page.number || 1), pages);
      const slice = all.slice((number - 1) * size, number * size);
      const text = fmt.alerts(slice, s, { total: all.length, page: number, pages });
      return { text, alerts: slice, page: { number, pages } };
    }
    case 'ack': {
      const { id } = await hub.ack(user, params.id);
      return { text: `✅ Alert ${s.code(id.slice(0, 8))} acknowledged.` };
    }
    case 'mute': {
      const { id } = await hub.mute(user, params.id, params.minutes);
      return { text: `🔇 Alert ${s.code(id.slice(0, 8))} muted for ${params.minutes || 60} minute(s).` };
    }
    case 'backup': {
      const result = await hub.backup(user, params.site);
      return { text: `✅ Backup requested${result?.agent_online === false ? ' — the agent is offline; it runs once reconnected' : ''}${result?.command_id ? ` (${s.code(String(result.command_id).slice(0, 8))})` : ''}.` };
    }
    case 'link': {
      if (!params.code) return execute({ name: 'whoami', params, user, hub, s });
      const result = await hub.link(user, params.code);
      return { text: fmt.linked(result?.user, s) };
    }
    case 'unlink':
      await hub.unlink(user);
      return { text: '✅ This chat is no longer linked to a hub account.' };
    case 'whoami': {
      const identity = await hub.identity(user);
      if (!identity?.linked) return { text: fmt.linkHelp(s) };
      const u = identity.user || {};
      return { text: `Linked to hub user ${s.bold(u.username || '?')} (${u.role || '—'})${u.site_scope ? ` · limited to ${u.site_scope.length} site(s)` : ''}.\nPermissions: ${(u.permissions || []).join(', ') || 'none'}` };
    }
    case 'rules':
      return { text: fmt.rules(await hub.rules(user), s) };
    default:
      throw new ValidationError(`Unknown hub command ${name}. Use /hub for the list.`);
  }
}

module.exports = { COMMANDS, USAGE, execute, needsConfirmation, confirmationText, hubErrorText };
