'use strict';

/**
 * Hub text renderers. Pure functions returning plain strings (Telegram) or
 * markdown (Discord) through the shared style objects from core/format, so both
 * platforms show the same wording.
 *
 * Discord caps a message at 2000 characters and Telegram at 4096; `fit()` cuts
 * text to a limit with a visible note; `fitLines()` keeps whole lines (logs).
 */

const { fmt, shorten, PLAIN } = require('./format');

const LIMITS = { discord: 1900, telegram: 4000 };
const ICON = { healthy: '🟢', degraded: '🟡', offline: '🔴', unknown: '⚪' };
const SEVERITY = { critical: '🔴', warning: '🟡', info: '🔵' };

/** Site health icon, defaulting to the online flag when health is missing. */
function healthIcon(site) {
  if (site?.health) return ICON[site.health] || ICON.unknown;
  if (site?.online === true) return ICON.healthy;
  if (site?.online === false) return ICON.offline;
  return ICON.unknown;
}

/** "workers 3 running · 1 error" — enough to judge a restart. */
function workerSummary(site) {
  const counts = site?.workers || {};
  const parts = ['running', 'idle', 'error', 'starting', 'stopped']
    .filter((key) => counts[key])
    .map((key) => `${counts[key]} ${key}`);
  const total = site?.worker_total ?? Object.values(counts).reduce((sum, n) => sum + (Number(n) || 0), 0);
  return parts.length ? `workers ${parts.join(' · ')} (${total} total)` : `workers ${total}`;
}

function lastSeen(value) {
  if (!value) return 'never seen';
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'never seen';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function siteLine(site, s = PLAIN) {
  return `${healthIcon(site)} ${s.bold(shorten(site.name, 60))} — ${site.health || (site.online ? 'online' : 'offline')} · ${workerSummary(site)} · seen ${lastSeen(site.last_seen_at)}`;
}

/* --------------------------------- lists --------------------------------- */

function sites(list, s = PLAIN) {
  if (!list?.length) return 'No site yet — add one in the hub dashboard.';
  const healthy = list.filter((site) => site.health === 'healthy').length;
  return [`${s.bold('Hub sites')} — ${list.length} total · ${healthy} healthy`, ...list.map((site) => siteLine(site, s))].join('\n');
}

function siteDetails(site, s = PLAIN) {
  const lines = [
    `${healthIcon(site)} ${s.bold(shorten(site.name, 80))} ${s.code(site.slug)}`,
    `Health: ${site.health || '—'}${site.online ? ' (agent connected)' : ' (agent offline)'} · desired state: ${site.desired_state || '—'}`,
    workerSummary(site),
    `Last seen: ${lastSeen(site.last_seen_at)}${site.agent_version ? ` · agent ${site.agent_version}` : ''}`,
    ...(site.url ? [`URL: ${site.url}`] : []),
    ...(site.description ? [shorten(site.description, 400)] : []),
  ];
  const host = site.host || {};
  const process = site.process || {};
  const facts = [
    host.cpu_percent !== undefined ? `cpu ${Math.round(host.cpu_percent)}%` : null,
    host.memory_percent !== undefined ? `ram ${Math.round(host.memory_percent)}%` : null,
    process.pid ? `pid ${process.pid}` : null,
    process.restarts !== undefined ? `restarts ${process.restarts}` : null,
  ].filter(Boolean);
  if (facts.length) lines.push(`Host: ${facts.join(' · ')}`);
  return lines.join('\n');
}

function workers(list, s = PLAIN) {
  if (!list?.length) return 'No worker reported in the last day.';
  const lines = list.map((worker) => {
    const facts = [
      worker.status,
      worker.tasks_completed !== undefined ? `${fmt(worker.tasks_completed)} tasks` : null,
      worker.cpu_percent !== undefined ? `cpu ${Math.round(worker.cpu_percent)}%` : null,
      `seen ${lastSeen(worker.last_seen_at)}`,
    ].filter(Boolean);
    return `• ${s.bold(shorten(worker.name || worker.id, 50))} — ${facts.join(' · ')}`;
  });
  return [`${s.bold('Workers')} (${list.length})`, ...lines].join('\n');
}

function stats(result, s = PLAIN) {
  const logs = result?.logs || {};
  const lines = [
    `${s.bold('Stats')}${result?.since ? ` since ${new Date(result.since).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`,
    `Logs: ${fmt(logs.total)} total · ${fmt(logs.errors)} error(s) · ${fmt(logs.warnings)} warning(s)`,
    `Tasks completed: ${fmt(result?.tasks_completed)}`,
  ];
  for (const cost of result?.costs || []) lines.push(`Cost: ${cost.total.toFixed(2)} ${cost.currency}`);
  const metrics = result?.metrics || [];
  if (metrics.length) {
    lines.push('Metrics:');
    for (const metric of metrics.slice(0, 20)) lines.push(`• ${metric.name}: ${Number(metric.value).toFixed(2)}${metric.peak !== undefined ? ` (peak ${Number(metric.peak).toFixed(2)})` : ''}`);
    if (metrics.length > 20) lines.push(`… ${metrics.length - 20} more metric(s)`);
  }
  return lines.join('\n');
}

function commandResult(result, s = PLAIN) {
  const site = result?.site_name ? `${s.bold(result.site_name)}: ` : '';
  if (result?.ok === false && result?.error) return `⚠️ ${site}${result.error}`;
  const status = result?.status || 'pending';
  const online = result?.agent_online === false ? ' — the agent is offline, so it will run when it reconnects' : '';
  const action = result?.action ? result.action.replace(/^custom:/, 'custom ') : 'command';
  return `✅ ${site}${action} ${status}${result?.id ? ` (${s.code(String(result.id).slice(0, 8))})` : ''}${online}`;
}

/** One log line: "[06-11 10:42:03] ERROR worker-2 message". */
function logLine(item) {
  const ts = String(item.ts || '');
  const at = ts.length >= 19 ? `${ts.slice(5, 10)} ${ts.slice(11, 19)}` : ts;
  const who = item.worker_name ? ` ${shorten(item.worker_name, 20)}` : '';
  const exception = item.exception ? ` — ${shorten(String(item.exception).split('\n').filter(Boolean).pop() || '', 120)}` : '';
  return `[${at}] ${String(item.level || 'info').toUpperCase()}${who} ${shorten(String(item.message ?? '').replace(/\s+/g, ' '), 300)}${exception}`;
}

function costs(result, s = PLAIN) {
  const totals = Object.entries(result?.totals || {});
  if (!totals.length) return 'No cost recorded for that period.';
  const lines = [`${s.bold('Costs')} — ${result.group_by || 'day'} (${result.period || ''})`.trim()];
  for (const [currency, total] of totals) lines.push(`Total: ${Number(total).toFixed(2)} ${currency}`);
  for (const row of (result.rows || []).slice(0, 25)) {
    lines.push(`• ${row.key} — ${Number(row.total).toFixed(2)} ${row.currency}${row.events ? ` (${row.events} events)` : ''}`);
  }
  if ((result.rows || []).length > 25) lines.push(`… ${result.rows.length - 25} more row(s)`);
  return lines.join('\n');
}

function balances(list, s = PLAIN) {
  if (!list?.length) return 'No balance reported yet.';
  return [`${s.bold('Balances')}`, ...list.map((item) => {
    const low = item.low ? ' ⚠️ LOW' : '';
    return `• ${item.site_name ? `${item.site_name} · ` : ''}${item.provider}${item.label ? ` (${item.label})` : ''}: ${Number(item.balance).toFixed(2)} ${item.currency}${low}`;
  })].join('\n');
}

function proxies(list, s = PLAIN) {
  if (!list?.length) return 'No proxy observation in that period.';
  return [`${s.bold('Proxy health')} (${list.length})`, ...list.map((item) => {
    const rate = item.success_rate === null || item.success_rate === undefined ? '—' : `${Math.round(item.success_rate * 100)}%`;
    return `• ${shorten(item.label || item.proxy_key, 60)} — ${item.health || item.last_state || '—'} · success ${rate} · ${fmt(item.observations)} obs`;
  })].join('\n');
}

function files(list, s = PLAIN) {
  if (!list?.length) return 'No managed file for this site. The agent declares them (config.json, .env, proxies.txt…).';
  return [`${s.bold('Managed files')} (${list.length})`, ...list.map((file) => {
    const sync = file.in_sync ? 'in sync' : `revision ${file.revision} not applied${file.apply_error ? ' (error)' : ''}`;
    return `• ${s.code(file.path)} — ${file.format || 'text'} · ${sync}${file.secret_keys?.length ? ' · has secrets' : ''}`;
  })].join('\n');
}

const CONTENT_LIMIT = 1200;

function fileView(file, s = PLAIN) {
  const content = String(file?.content ?? '');
  const shown = content.length > CONTENT_LIMIT ? `${content.slice(0, CONTENT_LIMIT)}\n… (${content.length - CONTENT_LIMIT} more characters — open the file in the hub)` : content;
  return [
    `${s.bold(file.path)} — ${file.format || 'text'} · revision ${file.revision}${file.in_sync ? ' · in sync' : ' · not applied'}${file.revealed ? '' : ' · secrets masked'}`,
    shown ? (s.name === 'markdown' ? `\`\`\`\n${shown.replace(/```/g, 'ˋˋˋ')}\n\`\`\`` : shown) : '(empty file)',
    ...(file.parse_error ? [`⚠️ ${file.parse_error}`] : []),
  ].join('\n');
}

function fileWrite(result, key, s = PLAIN) {
  return `✅ ${s.code(result?.path || 'file')} updated — ${s.code(key)} set, revision ${result?.revision}${result?.in_sync ? ' · in sync' : ' · push pending'}.`;
}

function alerts(list, s = PLAIN, { total = list?.length || 0, page = 1, pages = 1 } = {}) {
  if (!list?.length) return 'No active alert. 🎉';
  return [`${s.bold('Alerts')} (${total})${pages > 1 ? ` — page ${page}/${pages}` : ''}`, ...list.map((alert) => {
    const icon = SEVERITY[alert.severity] || '•';
    return `${icon} ${s.code(String(alert.id).slice(0, 8))} ${alert.site_name ? `[${alert.site_name}] ` : ''}${shorten(alert.title, 150)} — ${alert.status || 'open'}`;
  })].join('\n');
}

function rules(result, s = PLAIN) {
  const list = result?.rules || [];
  if (!list.length) return 'No alert rule configured.';
  return [`${s.bold('Alert rules')} (${list.length})`, ...list.map((rule) => `• ${rule.enabled ? '✅' : '⏸️'} ${shorten(rule.name, 80)} — ${rule.kind}${rule.site_id ? '' : ' (all sites)'} · ${rule.severity || 'warning'}`)].join('\n');
}

function users(list, s = PLAIN) {
  if (!list?.length) return 'No hub user.';
  const roles = list.map((user) => user.role || '').filter(Boolean);
  const summary = [...new Set(roles)].map((role) => `${role}s: ${roles.filter((value) => value === role).length}`).join(' · ');
  return [`${s.bold('Hub users')} (${list.length})${summary ? ` — ${summary}` : ''}`, ...list.map((user) => `• ${shorten(user.username || user.id, 40)} (${user.role || '—'})${user.disabled ? ' — disabled' : ''}`)].join('\n');
}

function linkHelp(s = PLAIN) {
  return `This chat is not linked to a hub account. Open the hub dashboard → Profile → ${s.bold('Link a chat account')}, generate a code, then send ${s.code('/hub link <code>')} here (codes last 10 minutes).`;
}

function linked(user, s = PLAIN) {
  return `✅ Linked to hub user ${s.bold(user?.username || '?')} (${user?.role || '—'}). Use /hub sites.`;
}

/** Fit `text` into a message limit, appending a note when it had to be cut. */
function fit(text, max = LIMITS.telegram, note = '… (truncated — narrow it down or paginate)') {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  const room = max - note.length - 2;
  return `${shorten(value, room)}\n${note}`;
}

/** Keep whole lines under `max`; returns how many lines were shown. */
function fitLines(header, lines, max) {
  let text = header;
  let shown = 0;
  for (const line of lines) {
    if (text.length + 1 + line.length > max) break;
    text += `\n${line}`;
    shown += 1;
  }
  if (!shown && lines.length) {
    text += `\n${shorten(lines[0], Math.max(20, max - text.length - 1))}`;
    shown = 1;
  }
  return { text, shown };
}

module.exports = {
  LIMITS, ICON, SEVERITY, healthIcon, workerSummary, lastSeen, siteLine,
  sites, siteDetails, workers, stats, commandResult, logLine, costs, balances, proxies,
  files, fileView, fileWrite, alerts, rules, users, linkHelp, linked, fit, fitLines, CONTENT_LIMIT,
};
