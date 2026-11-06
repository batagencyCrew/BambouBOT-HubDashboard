'use strict';

/**
 * In-memory Bambou Hub double, reached through an injected fetch (no network).
 * It mirrors the hub contract the bot relies on: bot token + X-Bot-User, 401 for
 * unlinked users, 403 "Missing permission: <name>", 404/409, /api/bot/* routes.
 */

const { HubClient } = require('../src/clients/hub');
const { HubService } = require('../src/services/hub');

const TOKEN = 'hbt_test_service_token_0123456789';
const SITE = {
  id: '11111111-1111-1111-1111-111111111111', slug: 'alpha', name: 'alpha', url: '', description: '',
  desired_state: 'running', health: 'degraded', online: true, last_seen_at: new Date().toISOString(),
  workers: { running: 3, idle: 0, error: 1, stopped: 0, starting: 0, unknown: 0 }, worker_total: 4, host: {}, process: {}, agent_version: '2.0.0',
};
const ALL = ['sites:view', 'control:lifecycle', 'control:pause', 'config:edit', 'alerts:ack', 'backups:request', 'users:manage'];

function fakeHub({ down = false } = {}) {
  const state = {
    down, requests: [], commands: [], patches: [], reports: [], acks: [], mutes: [],
    links: { 'discord:42': { username: 'alice', role: 'operator', permissions: [...ALL] }, 'telegram:111': { username: 'alice', role: 'operator', permissions: [...ALL] } },
    codes: { 'ABCD-1234': { username: 'bob', role: 'viewer', permissions: ['sites:view'] } },
    sites: [SITE],
    logs: Array.from({ length: 120 }, (_, i) => ({ id: i + 1, ts: '2026-11-06T10:42:03Z', level: i % 3 ? 'info' : 'error', worker_name: 'w1', message: `line ${i + 1} ${'x'.repeat(60)}` })),
    alerts: Array.from({ length: 13 }, (_, i) => ({ id: `${String(i).padStart(8, 'a')}-0000-4000-8000-000000000000`, severity: 'warning', title: `Alert ${i}`, status: 'open', site_name: 'alpha' })),
    files: { '.env': { path: '.env', format: 'env', revision: 3, in_sync: true, content: 'WORKERS=3\nAPI_KEY=********\n', secret_keys: ['API_KEY'], parsed: [{ key: 'WORKERS', value: '3' }, { key: 'API_KEY', value: '********' }] } },
    deliveries: [],
  };
  const json = (status, payload, headers = {}) => new Response(payload === undefined ? '' : JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  const deny = (permission) => json(403, { detail: `Missing permission: ${permission}` });

  state.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const headers = init.headers || {};
    const body = init.body ? JSON.parse(init.body) : undefined;
    state.requests.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers, body });
    if (state.down) throw new TypeError('fetch failed: connect ECONNREFUSED');
    if (headers.Authorization !== `Bearer ${TOKEN}`) return json(401, { detail: 'Invalid bot service token' });
    const route = `${init.method} ${u.pathname}`;

    if (route === 'POST /api/bot/link') {
      const user = state.codes[body.code];
      if (!user) return json(400, { detail: 'Invalid or expired link code' });
      delete state.codes[body.code];
      state.links[`${body.platform}:${body.platform_user}`] = user;
      return json(200, { user });
    }
    if (route === 'POST /api/bot/identity') {
      const user = state.links[`${body.platform}:${body.platform_user}`];
      return json(200, user ? { linked: true, user } : { linked: false });
    }
    if (route === 'POST /api/bot/unlink') {
      delete state.links[`${body.platform}:${body.platform_user}`];
      return json(200, { ok: true });
    }
    if (route === 'GET /api/bot/deliveries') return json(200, state.deliveries.filter((d) => !d.sent));
    const delivered = /^POST \/api\/bot\/deliveries\/(\d+)$/.exec(route);
    if (delivered) {
      state.reports.push({ id: Number(delivered[1]), ...body });
      const d = state.deliveries.find((item) => item.id === Number(delivered[1]));
      if (d && body.ok) d.sent = true;
      return json(200, { ok: true });
    }

    const user = state.links[headers['X-Bot-User']];
    if (!user) return json(401, { detail: 'Authentication required' });
    const can = (permission) => user.permissions.includes(permission);
    if (!can('sites:view')) return deny('sites:view');
    const siteMatch = /^\/api\/sites\/([^/]+)(\/.*)?$/.exec(u.pathname);
    let site = null;
    if (siteMatch) {
      const ref = decodeURIComponent(siteMatch[1]).toLowerCase();
      site = state.sites.find((s) => s.slug === ref || s.name.toLowerCase() === ref);
      if (!site) return json(404, { detail: 'Site not found' });
    }
    const rest = siteMatch?.[2] || '';
    if (route === 'GET /api/sites') return json(200, state.sites);
    if (site && init.method === 'GET' && rest === '') return json(200, site);
    if (site && rest === '/workers') return json(200, [{ id: 'w1', name: 'worker-1', status: 'running', tasks_completed: 12, last_seen_at: new Date().toISOString() }]);
    if (site && rest === '/stats') return json(200, { since: '2026-11-05T10:00:00Z', logs: { total: 10, errors: 2, warnings: 1 }, metrics: [], costs: [{ currency: 'USD', total: 1.5 }], tasks_completed: 99 });
    if (site && rest === '/commands' && init.method === 'POST') {
      const needs = { start: 'control:lifecycle', stop: 'control:lifecycle', restart: 'control:lifecycle', pause: 'control:pause', resume: 'control:pause' }[body.action];
      if (needs && !can(needs)) return deny(needs);
      state.commands.push({ site: site.slug, ...body, by: headers['X-Bot-User'] });
      return json(201, { id: 'c0ffee00-0000-4000-8000-000000000000', action: body.action, status: 'delivered', agent_online: true, site_name: site.name });
    }
    if (site && rest === '/backups/request') {
      if (!can('backups:request')) return deny('backups:request');
      return json(202, { command_id: 'b4c0ffee-0000', agent_online: false });
    }
    if (site && rest === '/files') return json(200, Object.values(state.files).map(({ content, ...file }) => file));
    if (site && rest === '/files/content') {
      const file = state.files[u.searchParams.get('path')];
      if (!file) return json(404, { detail: 'File not managed for this site' });
      if (init.method === 'GET') return json(200, file);
      if (!can('config:edit')) return deny('config:edit');
      if (body.base_revision !== file.revision) return json(409, { detail: 'File changed since you loaded it' });
      state.patches.push({ path: file.path, ...body });
      file.revision += 1;
      return json(200, { ...file, in_sync: false });
    }
    if (site && rest === '/proxy-health') return json(200, [{ proxy_key: 'p1', label: 'proxy 1', health: 'healthy', success_rate: 0.9, observations: 10 }]);
    if (route === 'GET /api/logs') {
      const levels = ['debug', 'info', 'notice', 'warning', 'error', 'critical'];
      const min = levels.indexOf(u.searchParams.get('level') || 'debug');
      const before = Number(u.searchParams.get('before_id')) || Infinity;
      const limit = Number(u.searchParams.get('limit')) || 100;
      const rows = state.logs.filter((l) => l.id < before && levels.indexOf(l.level) >= min).sort((a, b) => b.id - a.id).slice(0, limit);
      return json(200, { items: rows, next_before_id: rows.length === limit ? rows.at(-1).id : null });
    }
    if (route === 'GET /api/costs') return json(200, { group_by: 'site', rows: [{ key: 'alpha', currency: 'USD', total: 3.25, events: 4 }], totals: { USD: 3.25 } });
    if (route === 'GET /api/balances') return json(200, [{ site_name: 'alpha', provider: 'openai', currency: 'USD', balance: 2, low: true }]);
    if (route === 'GET /api/overview') return json(200, { totals: { sites: 1, online: 1, healthy: 0, degraded: 1, offline: 0, workers_running: 3, workers_idle: 0, workers_error: 1, errors_24h: 5, cost_today: { USD: 1 } }, alerts: [] });
    if (route === 'GET /api/alerts') return json(200, state.alerts);
    if (route === 'GET /api/alerts/rules') return json(200, { kinds: [], rules: [{ name: 'Offline', kind: 'site_offline', enabled: true, severity: 'critical' }] });
    const alertAction = /^POST \/api\/alerts\/([^/]+)\/(ack|mute)$/.exec(route);
    if (alertAction) {
      if (!can('alerts:ack')) return deny('alerts:ack');
      if (!state.alerts.some((a) => a.id === alertAction[1])) return json(404, { detail: 'Alert not found' });
      state[alertAction[2] === 'ack' ? 'acks' : 'mutes'].push({ id: alertAction[1], ...body });
      return json(200, { ok: true });
    }
    if (route === 'GET /api/users') return can('users:manage') ? json(200, [{ username: 'alice', role: 'operator' }]) : deny('users:manage');
    return json(404, { detail: `Unknown fake route ${route}` });
  };
  state.client = (opts = {}) => new HubClient({ baseUrl: 'https://hub.test', token: TOKEN, fetchImpl: state.fetch, maxRetries: 0, sleepImpl: async () => {}, ...opts });
  state.service = (opts) => new HubService({ client: state.client(opts) });
  return state;
}

module.exports = { fakeHub, TOKEN, SITE, ALL };
