'use strict';

/**
 * Text renderers shared by both platforms. Each takes a style (PLAIN for
 * Telegram, MARKDOWN for Discord) so wording stays identical everywhere.
 */

const { fmt, percent, keyState, shorten, PLAIN } = require('../core/format');
const { presetLinkBadges } = require('../core/presets');

/* -------------------------------- presets -------------------------------- */

function presetLine(preset, s = PLAIN) {
  const badges = presetLinkBadges(preset);
  return `• ${s.code(preset.id)} — ${s.bold(shorten(preset.name || '?'))} · FN ${preset.identity?.name || '—'} · ${preset.mainSettings?.discoveryPlatform || '—'}${badges.length ? ` · ${badges.join('+')}` : ''}${preset.archivedAt ? ' · archived' : ''}`;
}

function presetSummary({ operation, sourceId, values }) {
  return [
    `${operation === 'setup' ? 'Duplicate' : 'Edit'} preset ${sourceId}`,
    `Name: ${values.name}`, `ID: ${values.id}`, `First name: ${values.firstName || '(keep source)'}`,
    `Discovery: ${values.discoveryPlatform || '(keep source)'}`, `MYM URL: ${values.mymUrl || '(keep source)'}`,
    `Extra URL: ${values.specificUrl || '(keep source)'}`, `Extra platform: ${values.specificPlatform}`,
    `Extra label: ${values.specificLabel || values.specificPlatform}`,
  ].join('\n');
}

/** Result of PresetService.save(). */
function presetSaveReport(report, s = PLAIN) {
  const lines = [
    report.cloned
      ? `✅ Duplicated ${s.code(report.oldId)} → ${s.bold(s.code(report.newId))} (${report.preset.name})`
      : `✅ Updated preset ${s.bold(s.code(report.newId))} (${report.preset.name})`,
    `First name: ${report.preset.identity?.name || '—'} · Discovery: ${report.preset.mainSettings?.discoveryPlatform || '—'}`,
  ];
  if (report.changes.length) lines.push(`URLs: ${report.changes.join(' · ')}`);
  for (const item of report.preset.urls?.items || []) {
    lines.push(`${item.enabled ? '' : '⚪ '}${item.displayLabel || item.platform}: ${item.url || item.snapModel || '—'}`);
  }
  if (report.renamed) {
    lines.push(`References moved: ${report.migrated.accounts} account(s), ${report.migrated.modelSetups} Snapchat model setup(s).`);
    if (report.keyScopes.updated.length) lines.push(`API key scopes updated: ${report.keyScopes.updated.join(', ')}`);
    for (const failed of report.keyScopes.failed) lines.push(`⚠️ Key ${failed.id} scope not updated: ${failed.error}`);
    if (report.staleMedia) lines.push(`ℹ️ ${report.staleMedia} media record(s) keep the old ID; no API route migrates them. Vault links are unaffected.`);
  }
  return lines.join('\n');
}

/* ---------------------------------- keys --------------------------------- */

function keyLine(key, s = PLAIN) {
  const scope = (key.presetIds || []).length ? `presets ${key.presetIds.join(',')}` : 'all presets';
  return `• ${s.code(key.id)} — ${s.bold(key.label || '—')} · ${keyState(key)} · ${key.rpm}/min · ${key.maxConcurrent} concurrent · ${key.callsToday || 0}/${key.dailyLimit} today · ${scope}`;
}

function keySummary({ operation, keyId, values }) {
  return [
    `${operation === 'create' ? 'Create' : `Edit ${keyId}`} API key`,
    `Label: ${values.label}`, `${values.rpm}/min · ${values.concurrent} concurrent · ${values.daily}/day`,
    `Scope: ${values.scope}`, ...(operation === 'edit' ? [`Paused: ${values.paused}`] : []),
  ].join('\n');
}

function keyCreated({ created, presetIds, values }, s = PLAIN) {
  return `✅ Key ${s.code(created.id)} created (${s.bold(created.label || values.label)}) · ${created.rpm ?? values.rpm}/min · ${created.maxConcurrent ?? values.concurrent} concurrent · ${created.dailyLimit ?? values.daily}/day · ${presetIds.length ? `presets ${presetIds.join(',')}` : 'all presets'}`;
}

function keySecretMessage({ created, values }) {
  const prefix = `🔑 BambouAI key ${created.id} (${created.label || values.label})\nShown once — copy and keep this permanent private message.\n\n`;
  return { prefix, secret: created.key, text: `${prefix}${created.key}` };
}

/* ----------------------------------- gms ---------------------------------- */

const statusIcon = (status) => (status === 'active' ? '✅' : '⛔');

function gmsSummary(values, profiles) {
  return ['Create direct link', `Profile: ${profiles[values.profile]?.label || '—'}`, `Destination: ${profiles[values.profile]?.url || '—'}`,
    `Name: ${values.name || '(none)'}`, `Shortcode: ${values.shortcode || '(auto-generated)'}`].join('\n');
}

/** Labelled fields for a link, as [name, value] pairs (embeds or plain lines). */
function gmsLinkFields(link, service, clicks) {
  return [
    ['Name', link.displayName || '—'],
    ['Status', link.status || '—'],
    ['Group', link.groupName || (link.groupId ? String(link.groupId) : 'none')],
    ['Destination', link.redirectDeepLink || '—'],
    ['Public URL', service.publicUrl(link)],
    ...(clicks ? [['Clicks today', fmt(clicks.today)], ['Clicks 7d', fmt(clicks.last7)]] : []),
  ];
}

function gmsCreatedFields({ link, profile, context }, service) {
  return [
    ['Shortcode', link.originalLink],
    ['Status', link.status || 'active'],
    ['Name', link.displayName || '—'],
    ['URL', service.publicUrl(link)],
    ['Destination', link.redirectDeepLink || profile.url],
    ...(context?.teamName ? [['Team', context.teamName]] : []),
  ];
}

/**
 * Structured view of GmsService.stats() output.
 * @returns {{title:string, lines:string[], fields:Array<[string,string]>, footer:string|null, empty:string|null}}
 */
function gmsStats(result, s = PLAIN) {
  const team = result.context?.teamName || null;
  if (result.mode === 'single') {
    if (!result.link) return { title: '', lines: [], fields: [], footer: null, empty: 'No link found for that reference.' };
    const fields = [['Name', result.link.displayName || '—'], ['Status', result.link.status || '—']];
    if (result.row) {
      fields.push(['Visits', fmt(result.row.pageViews)], ['Visits with clicks', fmt(result.row.visitsWithClicks)], ['CTR', percent(result.row.ctr)]);
    } else if (result.clicks) {
      fields.push(['Clicks today', fmt(result.clicks.today)], ['Clicks 7d', fmt(result.clicks.last7)]);
    } else {
      fields.push(['Statistics', `No analytics data for ${result.label}.`]);
    }
    return { title: `📊 ${team ? `${team} · ` : ''}${result.link.originalLink} — ${result.label}`, lines: [], fields, footer: team ? `Team: ${team}` : null, empty: null };
  }
  const overview = result.overview || {};
  const lines = (result.rows || []).map((row, index) => `${index + 1}. ${s.code(row.originalLink)} — ${s.bold(fmt(row.pageViews))} visits · ${fmt(row.visitsWithClicks)} with clicks · CTR ${percent(row.ctr)}`);
  if (!lines.length) lines.push('(no links)');
  const fields = [];
  if (overview.pageViews !== undefined || overview.totalClicks !== undefined) {
    fields.push(['Total visits', fmt(overview.pageViews)], ['Total clicks', fmt(overview.totalClicks)], ['CTR', percent(overview.ctr)]);
  }
  for (const [key, label] of [['topLocation', 'Top country'], ['topReferrer', 'Top referrer'], ['topDevice', 'Top device']]) {
    if (overview[key]) fields.push([label, `${overview[key].name} (${overview[key].percent}%)`]);
  }
  const footer = overview.periodStartDate && overview.periodEndDate
    ? `${String(overview.periodStartDate).slice(0, 10)} → ${String(overview.periodEndDate).slice(0, 10)}`
    : null;
  return { title: `📊 ${team ? `${team} · ` : ''}Click stats — ${result.label}`, lines, fields, footer, empty: null };
}

/** Flatten a structured view to plain text lines. */
function asText({ title, lines = [], fields = [], footer = null, empty = null }) {
  if (empty) return empty;
  return [title, ...lines, ...fields.map(([name, value]) => `${name}: ${value}`), ...(footer ? [footer] : [])].filter(Boolean).join('\n');
}

module.exports = {
  presetLine, presetSummary, presetSaveReport,
  keyLine, keySummary, keyCreated, keySecretMessage,
  statusIcon, gmsSummary, gmsLinkFields, gmsCreatedFields, gmsStats, asText,
};
