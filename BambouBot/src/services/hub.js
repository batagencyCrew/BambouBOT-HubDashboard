'use strict';

/**
 * Bambou Hub operations used by both platforms.
 *
 * Every call that touches hub data is made *as* the chat user (`user` =
 * { platform, id }): the hub resolves the linked hub account and applies its
 * permissions, so this layer never decides who may do what. A 401 means the chat
 * user is not linked; a 403 names the missing permission (see clients/hub.js).
 *
 * Inputs are validated here so Discord and Telegram accept exactly the same values.
 */

const { HubClient, HubError } = require('../clients/hub');
const { ValidationError } = require('../core/errors');

const PLATFORMS = ['discord', 'telegram'];
const LEVELS = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
const STATS_PERIODS = ['1h', '24h', '7d', '30d', '90d', '365d'];
const ALERT_STATUSES = ['active', 'open', 'acknowledged', 'resolved', 'all'];
const LIFECYCLE = ['start', 'stop', 'restart', 'pause', 'resume'];
/** Actions that ask for a confirmation first. */
const DANGEROUS = new Set(['stop', 'restart', 'set', 'set_workers']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const enc = encodeURIComponent;

function siteRef(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new ValidationError('A site is required (name or slug — see /hub sites).');
  if (value.length > 200 || /[\u0000-\u001f]/.test(value)) throw new ValidationError('That site name is not valid.');
  return value;
}

function filePath(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new ValidationError('A file path is required (see /hub files).');
  if (value.length > 300 || value.startsWith('/') || value.split(/[\\/]/).includes('..') || /[\u0000-\u001f]/.test(value)) {
    throw new ValidationError('File paths are relative to the script folder, e.g. config.json or .env.');
  }
  return value;
}

function configKey(raw) {
  const value = String(raw ?? '').trim();
  if (!value) throw new ValidationError('A key is required (env variable name or dotted JSON path).');
  if (value.length > 200 || !/^[A-Za-z0-9_.\-[\]]+$/.test(value)) throw new ValidationError('Keys may only contain letters, digits, _ . - and [ ].');
  return value;
}

/**
 * Values typed in chat are text. For JSON files a literal number/true/false/null
 * or a JSON object/array/quoted string is sent typed; everything else as a string.
 */
function configValue(raw, format) {
  const value = String(raw ?? '');
  if (value.length > 4000) throw new ValidationError('Values must be at most 4000 characters.');
  if (format !== 'json') return value;
  const trimmed = value.trim();
  if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(trimmed) || /^[[{"]/.test(trimmed)) {
    try { return JSON.parse(trimmed); } catch { /* keep the text */ }
  }
  return value;
}

function boundedInt(raw, label, min, max, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ValidationError(`${label} must be an integer between ${min} and ${max}.`);
  return n;
}

function oneOf(raw, label, allowed, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) throw new ValidationError(`${label} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function linkCode(raw) {
  const value = String(raw ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9-]{4,40}$/.test(value)) throw new ValidationError('Link codes look like ABCD-1234 — generate one in the hub dashboard (Profile → Link a chat account).');
  return value;
}

function asUser(user) {
  if (!user || !PLATFORMS.includes(user.platform) || !/^[1-9]\d{0,24}$/.test(String(user.id ?? ''))) {
    throw new Error('Hub calls need a { platform, id } chat user.');
  }
  return { platform: user.platform, id: String(user.id) };
}

class HubService {
  /** @param {{ client: HubClient }} opts */
  constructor({ client }) {
    if (!client) throw new Error('HubService requires a hub client.');
    this.client = client;
  }

  call(method, path, user, body) {
    return this.client.request(method, path, { asUser: user ? asUser(user) : undefined, body });
  }

  /* --------------------------------- identity -------------------------------- */

  /** @returns {Promise<{linked:boolean, user?:object}>} */
  identity(user) {
    const u = asUser(user);
    return this.client.request('POST', '/api/bot/identity', { body: { platform: u.platform, platform_user: u.id } });
  }

  async link(user, code) {
    const u = asUser(user);
    const value = linkCode(code);
    try {
      return await this.client.request('POST', '/api/bot/link', { body: { platform: u.platform, platform_user: u.id, code: value } });
    } catch (error) {
      if (error instanceof HubError && error.status === 400) throw new ValidationError('That link code is invalid or expired — generate a new one in the hub dashboard (codes last 10 minutes and work once).');
      throw error;
    }
  }

  unlink(user) {
    const u = asUser(user);
    return this.client.request('POST', '/api/bot/unlink', { body: { platform: u.platform, platform_user: u.id } });
  }

  /* ---------------------------------- sites ---------------------------------- */

  sites(user) { return this.call('GET', '/api/sites', user); }
  site(user, ref) { return this.call('GET', `/api/sites/${enc(siteRef(ref))}`, user); }
  workers(user, ref) { return this.call('GET', `/api/sites/${enc(siteRef(ref))}/workers`, user); }
  overview(user) { return this.call('GET', '/api/overview', user); }

  stats(user, ref, period) {
    const p = oneOf(period, 'period', STATS_PERIODS, '24h');
    return this.call('GET', HubClient.path(`/api/sites/${enc(siteRef(ref))}/stats`, { period: p }), user);
  }

  /** start/stop/restart/pause/resume/set_workers/reload_config/custom:<name>. */
  command(user, ref, action, args = {}) {
    const name = String(action || '');
    if (![...LIFECYCLE, 'set_workers', 'reload_config'].includes(name) && !/^custom:[a-z0-9_.-]{1,60}$/.test(name)) {
      throw new ValidationError(`Unknown hub command ${name}.`);
    }
    const body = { action: name, args: {} };
    if (name === 'set_workers') body.args = { count: boundedInt(args.count, 'Worker count', 0, 1000) };
    else if (name.startsWith('custom:')) body.args = args || {};
    if (name === 'set_workers' && body.args.count === undefined) throw new ValidationError('Worker count is required.');
    return this.call('POST', `/api/sites/${enc(siteRef(ref))}/commands`, user, body);
  }

  backup(user, ref) { return this.call('POST', `/api/sites/${enc(siteRef(ref))}/backups/request`, user, {}); }

  /* --------------------------------- telemetry ------------------------------- */

  logs(user, { site, level, limit, beforeId, q } = {}) {
    const query = {
      site: site ? siteRef(site) : undefined,
      level: oneOf(level, 'level', LEVELS, 'info'),
      limit: boundedInt(limit, 'limit', 1, 50, 15),
      before_id: beforeId ? boundedInt(beforeId, 'before_id', 1, Number.MAX_SAFE_INTEGER) : undefined,
      q: q ? String(q).slice(0, 200) : undefined,
    };
    return this.call('GET', HubClient.path('/api/logs', query), user);
  }

  costs(user, { site, period, groupBy } = {}) {
    return this.call('GET', HubClient.path('/api/costs', {
      site: site ? siteRef(site) : undefined,
      period: oneOf(period, 'period', STATS_PERIODS, '30d'),
      group_by: oneOf(groupBy, 'group_by', ['day', 'provider', 'category', 'site', 'worker'], site ? 'provider' : 'site'),
    }), user);
  }

  balances(user, { site } = {}) {
    return this.call('GET', HubClient.path('/api/balances', { site: site ? siteRef(site) : undefined }), user);
  }

  proxies(user, ref, period) {
    return this.call('GET', HubClient.path(`/api/sites/${enc(siteRef(ref))}/proxy-health`, { period: oneOf(period, 'period', STATS_PERIODS, '24h') }), user);
  }

  /* ----------------------------------- files --------------------------------- */

  files(user, ref) { return this.call('GET', `/api/sites/${enc(siteRef(ref))}/files`, user); }

  /** Masked view (never `reveal`: secrets are not posted into chats). */
  file(user, ref, path) {
    return this.call('GET', HubClient.path(`/api/sites/${enc(siteRef(ref))}/files/content`, { path: filePath(path) }), user);
  }

  /**
   * Set one key. The current revision is read first and sent as base_revision, so
   * a concurrent edit is refused (409) instead of being overwritten.
   */
  async setFileValue(user, ref, path, key, value) {
    const site = siteRef(ref);
    const p = filePath(path);
    const k = configKey(key);
    const current = await this.file(user, site, p);
    if (!['env', 'json'].includes(current.format)) {
      throw new ValidationError(`${p} is a ${current.format} file; only .env and JSON files can be edited key by key from chat.`);
    }
    return this.call('PATCH', HubClient.path(`/api/sites/${enc(site)}/files/content`, { path: p }), user, {
      base_revision: current.revision, set: { [k]: configValue(value, current.format) },
    });
  }

  /* ----------------------------------- alerts -------------------------------- */

  alerts(user, { status, site, limit } = {}) {
    return this.call('GET', HubClient.path('/api/alerts', {
      status: oneOf(status, 'status', ALERT_STATUSES, 'active'),
      site: site ? siteRef(site) : undefined,
      limit: boundedInt(limit, 'limit', 1, 200, 100),
    }), user);
  }

  /** Full UUID, or a unique prefix of one of the visible alerts (≥ 4 chars). */
  async resolveAlertId(user, ref) {
    const value = String(ref ?? '').trim().toLowerCase();
    if (UUID_RE.test(value)) return value;
    if (!/^[0-9a-f-]{4,36}$/.test(value)) throw new ValidationError('Alert ids look like 3f2a9c1e (the first characters shown by /hub alerts).');
    const matches = (await this.alerts(user, { status: 'all', limit: 200 })).filter((alert) => String(alert.id).startsWith(value));
    if (!matches.length) throw new ValidationError(`No alert starts with ${value} — see /hub alerts.`);
    if (matches.length > 1) throw new ValidationError(`${matches.length} alerts start with ${value}; type more characters.`);
    return matches[0].id;
  }

  async ack(user, ref) {
    const id = await this.resolveAlertId(user, ref);
    await this.call('POST', `/api/alerts/${enc(id)}/ack`, user, {});
    return { id };
  }

  async mute(user, ref, minutes) {
    const id = await this.resolveAlertId(user, ref);
    const result = await this.call('POST', `/api/alerts/${enc(id)}/mute`, user, { minutes: boundedInt(minutes, 'minutes', 1, 43_200, 60) });
    return { id, ...result };
  }

  rules(user) { return this.call('GET', '/api/alerts/rules', user); }
  users(user) { return this.call('GET', '/api/users', user); }

  /* --------------------------- alert delivery (bot) --------------------------- */

  deliveries(limit = 50) { return this.client.request('GET', HubClient.path('/api/bot/deliveries', { limit })); }

  reportDelivery(id, ok, error) {
    const body = ok ? { ok: true } : { ok: false, error: String(error || 'delivery failed').slice(0, 500) };
    return this.client.request('POST', `/api/bot/deliveries/${enc(String(id))}`, { body });
  }
}

module.exports = {
  HubService, LEVELS, STATS_PERIODS, ALERT_STATUSES, LIFECYCLE, DANGEROUS,
  siteRef, filePath, configKey, configValue, linkCode,
};
