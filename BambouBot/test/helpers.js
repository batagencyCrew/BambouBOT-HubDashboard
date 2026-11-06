'use strict';

/** Shared offline fixtures: a local mock of the BambouAI contract and a fake GMS service. */

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BambouStudio } = require('../src/clients/bambou');
const { PROFILES } = require('../src/services/gms');

function makeConfig() {
  return {
    version: 1,
    presets: [{
      id: '1000', name: 'Lina Chatnow', archivedAt: null,
      identity: { name: 'Lina', age: 19 }, mainSettings: { discoveryPlatform: 'Chatnow', chattingStyle: 'youthful' },
      strategy: { ctaEnabled: true }, cycles: [{ untouched: true }],
      urls: { chooseRandomly: false, items: [{ id: 'url-1', platform: 'MYM', displayLabel: 'MYM', url: 'https://old.example.com', enabled: true }] },
    }],
    accounts: [{ id: 'acc1', presetId: '1000' }, { id: 'acc2', presetId: '2222' }],
    snapchat: { modelSetups: [{ id: 'm1', presetId: '1000' }] },
    engine: { untouched: true }, extension: {}, unknownModule: { mustSurvive: true },
  };
}

function makeKeys() {
  return [
    { id: 'ak_scoped', label: 'Scoped', rpm: 20, maxConcurrent: 2, dailyLimit: 1000, callsToday: 0, presetIds: ['1000'], disabled: false, revokedAt: null },
    { id: 'ak_all', label: 'All', rpm: 30, maxConcurrent: 3, dailyLimit: 2000, callsToday: 5, presetIds: [], disabled: true, revokedAt: null },
    { id: 'ak_revoked', label: 'Revoked', rpm: 20, maxConcurrent: 2, dailyLimit: 1000, presetIds: [], disabled: true, revokedAt: '2026-01-01' },
  ];
}

/**
 * Start a mock BambouAI server.
 * state.fail = { 'POST /api/studio/api-keys': 503 } makes a route fail (counting still happens).
 */
async function bambouServer(t, { config = makeConfig(), keys = makeKeys() } = {}) {
  const state = { db: config, keys, puts: 0, keyCreates: 0, keyPatches: [], keyRevokes: [], requests: [], fail: {}, media: [{ id: 'media1', presetId: '1000' }] };
  const server = http.createServer(async (req, res) => {
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : {};
      const route = `${req.method} ${url.pathname.replace(/\/api\/studio\/api-keys\/.+$/, '/api/studio/api-keys/:id')}`;
      state.requests.push({ route, method: req.method, path: url.pathname, body });
      if (url.pathname === '/api/login') return send(200, { authenticated: true }, { 'Set-Cookie': 'bambou_session=test; Path=/' });
      if (!String(req.headers.cookie || '').includes('bambou_session=test')) return send(401, { error: 'Session required' });
      if (state.fail[route]) return send(state.fail[route], { error: `Injected failure ${state.fail[route]}` });
      if (url.pathname === '/api/studio/config') {
        if (req.method === 'GET') return send(200, state.db);
        state.puts += 1;
        state.db = body;
        return send(200, state.db);
      }
      if (url.pathname === '/api/media/library') return send(200, { items: state.media });
      if (url.pathname === '/api/studio/api-keys') {
        if (req.method === 'GET') return send(200, { keys: state.keys });
        state.keyCreates += 1;
        const key = { id: `ak_created_${state.keyCreates}`, rpm: 20, maxConcurrent: 2, dailyLimit: 1000, presetIds: [], ...body, disabled: false, revokedAt: null, callsToday: 0 };
        state.keys.push(key);
        return send(201, { ...key, key: `bbk_test_secret_${state.keyCreates}` });
      }
      const keyRoute = /^\/api\/studio\/api-keys\/([^/]+)$/.exec(url.pathname);
      if (keyRoute) {
        const id = decodeURIComponent(keyRoute[1]);
        const key = state.keys.find((item) => item.id === id);
        if (!key) return send(404, { error: 'Key not found' });
        if (req.method === 'PATCH') {
          state.keyPatches.push({ id, patch: body });
          Object.assign(key, body);
          return send(200, key);
        }
        if (req.method === 'DELETE') {
          state.keyRevokes.push(id);
          key.revokedAt = '2026-10-25';
          key.disabled = true;
          return send(200, key);
        }
      }
      return send(404, { error: `Unknown mock route: ${req.method} ${url.pathname}` });
    } catch (error) { return send(500, { error: error.message }); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  state.baseUrl = `http://127.0.0.1:${server.address().port}`;
  state.studio = (opts = {}) => new BambouStudio({ baseUrl: state.baseUrl, loginKey: 'test-login', ...opts });
  return state;
}

function tempDir(t, prefix = 'bamboubot-') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** In-memory GmsService double with the same contract as the vendored service. */
function fakeGms() {
  const state = { calls: [], creates: [], removes: [], contextFails: false };
  state.links = [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', originalLink: 'demo', displayName: 'Demo', status: 'active', redirectDeepLink: PROFILES.lina.url, selectedDomain: 'links.example' }];
  state.service = {
    publicUrl: (link) => `https://${link.selectedDomain || 'getmysocial.com'}/${link.originalLink}`,
    async list(options) { state.calls.push({ method: 'list', options }); return state.links.slice(0, options.limit); },
    async resolve(ref) {
      const clean = String(ref).split('/').pop();
      return state.links.find((link) => [link._id, link.originalLink].includes(clean)) || null;
    },
    async info(ref) { state.calls.push({ method: 'info', ref }); const link = await this.resolve(ref); return link ? { link, clicks: { today: 0, last7: 12 } } : null; },
    async context() { if (state.contextFails) throw new Error('Team lookup failed'); return { teamId: 'team1', teamName: 'Our team' }; },
    async createDirectLink(options) {
      state.creates.push(options);
      const link = { _id: `created-${state.creates.length}`, originalLink: options.shortcode || `generated-${state.creates.length}`, displayName: options.displayName || '', redirectDeepLink: options.url, status: 'active' };
      state.links.push(link);
      return link;
    },
    async setEnabled(ref, enabled) {
      const link = await this.resolve(ref);
      if (!link) throw new Error('Link not found');
      const status = enabled ? 'active' : 'inactive';
      const changed = link.status !== status;
      link.status = status;
      return { link, status, changed };
    },
    async remove(ref) {
      state.removes.push(ref);
      const link = await this.resolve(ref);
      if (!link) throw new Error('Link not found');
      state.links = state.links.filter((item) => item !== link);
      return { link, result: {} };
    },
    async stats(options) {
      state.calls.push({ method: 'stats', options });
      if (options.ref) return { mode: 'single', label: options.period, context: { teamName: 'Our team' }, link: await this.resolve(options.ref), row: { pageViews: 0, visitsWithClicks: 0, ctr: 0 } };
      return { mode: 'account', label: options.period, context: { teamName: 'Our team' }, rows: [{ originalLink: 'demo', pageViews: 42, visitsWithClicks: 0, ctr: 0 }], overview: { pageViews: 42, totalClicks: 0, ctr: 0 } };
    },
    refresh() { state.calls.push({ method: 'refresh' }); },
  };
  return state;
}

const silentLogger = (lines = []) => ({ log: (l) => lines.push(l), warn: (l) => lines.push(l), error: (l) => lines.push(l), lines });

module.exports = { makeConfig, makeKeys, bambouServer, tempDir, fakeGms, silentLogger };
