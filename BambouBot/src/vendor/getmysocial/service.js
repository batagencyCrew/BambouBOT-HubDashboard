'use strict';

/**
 * GetMySocial service layer (vendored from extras/GetMySocial/discord/gms-service.js).
 *
 * Works on the session-cookie backend. All links are direct links by default;
 * the client underneath supports landings too.
 *
 * Settings are injected by the caller (src/config.js reads them from .env):
 *   cookie               full Cookie header from a logged-in dashboard session (required)
 *   teamId               optional team scope (every call runs in that team context)
 *   baseUrl              optional, default https://getmysocial.com
 *   minRequestIntervalMs optional throttle between requests, default 350
 *   cacheTtlMs           optional read-cache TTL, default 30000
 */

const { GetMySocialSessionClient, GmsApiError, SessionExpiredError } = require('./session_client');

const PUBLIC_HOST_DEFAULT = 'getmysocial.com';

/** Analytics periods exposed to the bots (timeframes verified against the live v2 endpoints). */
const PERIODS = {
  today: { timeframe: 'today', label: 'today' },
  yesterday: { timeframe: 'yesterday', label: 'yesterday' },
  week: { timeframe: 'thisWeek', label: 'this week' },
  lastweek: { timeframe: 'lastWeek', label: 'last week' },
  month: { timeframe: 'thisMonth', label: 'this month' },
  lastmonth: { timeframe: 'lastMonth', label: 'last month' },
  all: { timeframe: 'allTime', label: 'all time' },
};

function periodInfo(period) {
  return PERIODS[period] || PERIODS.week;
}

class GmsService {
  constructor(opts = {}) {
    if (!opts.cookie) throw new Error('GetMySocial is not configured: set GMS_COOKIE in .env (see docs/GETTING_COOKIE.md).');
    this.client = opts.client || new GetMySocialSessionClient({
      cookie: opts.cookie,
      teamId: opts.teamId || null,
      baseUrl: opts.baseUrl || undefined,
      minRequestIntervalMs: opts.minRequestIntervalMs ?? 350,
    });
    this.cacheTtlMs = opts.cacheTtlMs ?? 30000;
    this._cache = new Map(); // key -> { at, value }
    this._teamName = null; // { id, name, at }: cached team-name lookup for context()
  }

  // ------------------------------------------------------------------ cache

  async _cached(key, fn, ttlMs = this.cacheTtlMs) {
    const hit = this._cache.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    this._cache.set(key, { at: Date.now(), value });
    return value;
  }

  /** Drop all cached reads (call after mutations). */
  refresh() {
    this._cache.clear();
  }

  // ------------------------------------------------------------------ reads

  /** All links (auto-paginated, cached). */
  async allLinks({ teamId } = {}) {
    const t = teamId ?? this.client.teamId ?? '';
    const key = `all:${t}`;
    const cached = this._cache.get(key);
    if (cached && Date.now() - cached.at < this.cacheTtlMs) return cached.value;
    const all = await this.client.listAll({ teamId });
    this._cache.set(key, { at: Date.now(), value: all });
    return all;
  }

  /** List with optional server-side substring query. */
  async list({ query, limit = 20, teamId } = {}) {
    if (query) {
      const s = await this.client.search(query, { teamId });
      return (Array.isArray(s && s.links) ? s.links : []).slice(0, limit);
    }
    const { links } = await this.allLinks({ teamId });
    return [...links]
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, limit);
  }

  /** Resolve a link by id / shortcode / full URL. */
  async resolve(ref, { teamId } = {}) {
    const clean = String(ref || '').trim();
    if (!clean) return null;
    const { links } = await this.allLinks({ teamId });
    const isId = /^[a-f0-9]{24}$/i.test(clean);
    const hit = links.find((l) =>
      (isId && String(l._id || l.id) === clean) ||
      String(l.originalLink || '').toLowerCase() === clean.toLowerCase());
    if (hit) return hit;
    return this.client.findLink(clean, { teamId }); // fallback: fresh server search
  }

  /** Link details + click sparkline data. */
  async info(ref, { teamId } = {}) {
    const link = await this.resolve(ref, { teamId });
    if (!link) return null;
    let clicks = null;
    try {
      const sp = await this.client.sparklines([String(link._id || link.id)], { teamId });
      const id = String(link._id || link.id);
      const series = (sp && sp.sparklines && sp.sparklines[id]) || null;
      clicks = series ? { today: series[series.length - 1] || 0, last7: series.slice(-7).reduce((a, b) => a + (b || 0), 0) } : null;
    } catch { /* sparklines are best-effort */ }
    return { link, clicks };
  }

  /**
   * Click statistics. Account mode: overview + top-links leaderboard from the
   * v2 analytics endpoints. Single mode: one link's row (visits / visits-with-
   * clicks / CTR) with a sparkline fallback (today + 7d) when it has no row.
   */
  async stats({ ref, period = 'week', teamId, limit = 10, sortBy = 'pageViews' } = {}) {
    const { timeframe, label } = periodInfo(period);
    const context = await this.context({ teamId });

    let overview = null;
    try {
      overview = await this.client.analyticsOverview({ timeframe, teamId });
    } catch { /* degrade to per-link only */ }

    if (ref) {
      const link = await this.resolve(ref, { teamId });
      if (!link) return { mode: 'single', link: null, row: null, clicks: null, timeframe, label, context };
      const id = String(link._id || link.id);
      let row = null;
      try {
        const pl = await this.client.analyticsPerLink({ timeframe, pageSize: 100, sortBy, teamId });
        row = (pl.links || []).find((r) => String(r.id) === id) || null;
      } catch { /* fall through to sparkline */ }
      let clicks = null;
      if (!row) {
        try {
          const sp = await this.client.sparklines([id], { teamId });
          const series = (sp && sp.sparklines && sp.sparklines[id]) || null;
          if (series) clicks = { today: series[series.length - 1] || 0, last7: series.slice(-7).reduce((a, b) => a + (b || 0), 0) };
        } catch { /* best-effort */ }
      }
      return { mode: 'single', link, row, clicks, timeframe, label, context };
    }

    let rows = [];
    try {
      const pl = await this.client.analyticsPerLink({ timeframe, pageSize: Math.min(Math.max(limit, 1), 100), sortBy, teamId });
      rows = pl.links || [];
    } catch { /* fall through to sparkline leaderboard */ }

    if (!overview && rows.length === 0) {
      // Legacy fallback: sparkline-based leaderboard (pre-v2 behaviour).
      const { links } = await this.allLinks({ teamId });
      if (links.length === 0) return { mode: 'account', rows: [], overview: null, timeframe, label, context };
      const ids = links.map((l) => String(l._id || l.id)).slice(0, 100);
      const sp = await this.client.sparklines(ids, { teamId });
      const series = (sp && sp.sparklines) || {};
      rows = links
        .map((l) => {
          const id = String(l._id || l.id);
          const s = series[id] || [];
          return {
            id,
            originalLink: l.originalLink,
            displayName: l.displayName,
            pageViews: s.slice(-7).reduce((a, b) => a + (b || 0), 0),
            visitsWithClicks: null,
            ctr: null,
            legacy: true,
          };
        })
        .sort((a, b) => b.pageViews - a.pageViews)
        .slice(0, limit);
    }
    return { mode: 'account', rows, overview, timeframe, label, context };
  }

  /** Teams (for a /gms whoami-style helper or diagnostics). */
  teams() {
    return this.client.teams();
  }

  usage({ teamId } = {}) {
    return this.client.usage({ teamId });
  }

  /** Active context: { teamId, teamName }. Team name comes from the sidebar island (cached 10 min). */
  async context({ teamId } = {}) {
    const t = teamId ?? this.client.teamId ?? null;
    if (!t) return { teamId: null, teamName: null };
    if (this._teamName && this._teamName.id === String(t) && Date.now() - this._teamName.at < 600000) {
      return { teamId: String(t), teamName: this._teamName.name };
    }
    let name = null;
    try {
      const teams = await this.client.teams();
      const all = [...((teams && teams.owned) || []), ...((teams && teams.member) || [])];
      const hit = all.find((x) => String(x._id || x.id) === String(t));
      if (hit) name = hit.name || null;
    } catch { /* name unknown — not fatal */ }
    this._teamName = { id: String(t), name, at: Date.now() };
    return { teamId: String(t), teamName: name };
  }

  /** Public URL for a link (custom domain aware). */
  publicUrl(link) {
    const domain = link.selectedDomain || PUBLIC_HOST_DEFAULT;
    return `https://${domain}/${link.originalLink || ''}`;
  }

  // --------------------------------------------------------------- mutations

  /**
   * Create a direct link.
   * group: group id OR name — name is resolved (optionally created).
   */
  async createDirectLink({ shortcode, url, displayName, group, createGroupIfMissing = false, teamId } = {}) {
    let groupId = '';
    if (group) {
      const t = teamId ?? this.client.teamId ?? undefined;
      const groups = await this.client.listGroups({ teamId: t });
      const byId = groups.find((g) => String(g.id) === String(group));
      const byName = groups.find((g) => String(g.name || '').toLowerCase() === String(group).toLowerCase());
      if (byId) groupId = String(byId.id);
      else if (byName) groupId = String(byName.id);
      else if (createGroupIfMissing) {
        const created = await this.client.createGroup(String(group), { teamId: t });
        groupId = String((created && created.group && created.group.id) || '');
      } else {
        throw new GmsApiError(`Group "${group}" not found (pass create_group:true to create it).`, { status: 404 });
      }
    }
    const link = await this.client.createDirectLink({ shortcode, url, displayName, groupId }, { teamId });
    this.refresh();
    return link;
  }

  /** Enable/disable (idempotent). */
  async setEnabled(ref, enabled, { teamId } = {}) {
    const link = await this.resolve(ref, { teamId });
    if (!link) throw new GmsApiError(`No link found for "${ref}".`, { status: 404 });
    const r = await this.client.setEnabled(String(link._id || link.id), enabled, { teamId });
    this.refresh();
    return { link, ...r };
  }

  /** Delete a link (resolves ref first so callers can show what was deleted). */
  async remove(ref, { teamId } = {}) {
    const link = await this.resolve(ref, { teamId });
    if (!link) throw new GmsApiError(`No link found for "${ref}".`, { status: 404 });
    const r = await this.client.deleteLink(String(link._id || link.id), { teamId });
    this.refresh();
    return { link, result: r };
  }

  /** Update a direct link (read-modify-write is done inside the client). */
  async updateDirectLink(ref, patch, { teamId } = {}) {
    const link = await this.resolve(ref, { teamId });
    if (!link) throw new GmsApiError(`No link found for "${ref}".`, { status: 404 });
    const r = await this.client.updateDirectLink(String(link._id || link.id), patch, { teamId });
    this.refresh();
    return { link, result: r };
  }
}

module.exports = { GmsService, PERIODS, GmsApiError, SessionExpiredError };
