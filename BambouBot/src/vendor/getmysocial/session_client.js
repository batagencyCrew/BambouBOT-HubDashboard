'use strict';

/**
 * GetMySocial session client — manages links through the dashboard's own API
 * using your logged-in session cookie (workaround for the Agency-plan API paywall).
 *
 * Zero dependencies. Node 18+ (global fetch / FormData).
 *
 *   const { GetMySocialSessionClient } = require('./session_client');
 *   const gms = new GetMySocialSessionClient({ cookie: process.env.GMS_COOKIE });
 *   const link = await gms.createDirectLink({ shortcode: 'my-link', url: 'https://example.com', displayName: 'My Link' });
 *
 * Endpoint map + payload shapes: see SESSION_API.md in extras/GetMySocial (reverse-engineered 2026-10-18).
 *
 * Vendored copy for BambouBot (from extras/GetMySocial/getmysocial_session_client.js).
 */

const BASE_DEFAULT = 'https://getmysocial.com';
const UA_DEFAULT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const INVISIBLE_CHARS = /[\u00AD\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** Defaults mirrored from the dashboard's CreateLinkV3 editor (chunk `Bo()`). */
const BOT_PROTECTION_DEFAULT = { mode: 'off', redirectUrl: '' };
const SMART_REDIRECT_DEFAULT = { enabled: false, destinationUrl: '', triggerAfterVisits: 3, withinDays: 7 };

class GmsApiError extends Error {
  constructor(message, { status, body, code } = {}) {
    super(message);
    this.name = 'GmsApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

class SessionExpiredError extends GmsApiError {
  constructor(message = 'GetMySocial session expired — refresh GMS_COOKIE (see docs/GETTING_COOKIE.md).', meta = {}) {
    super(message, meta);
    this.name = 'SessionExpiredError';
  }
}

function stripInvisible(value) {
  return String(value ?? '').replace(INVISIBLE_CHARS, '').trim();
}

/** Extract the balanced JSON object that follows an assignment like `window.appData = {`. */
function extractWindowAppData(html) {
  const m = html.match(/window\.appData\s*=\s*\{/);
  if (!m) return null;
  const start = m.index + m[0].length - 1; // points at the opening '{'
  let depth = 0;
  let inStr = false;
  let quote = '';
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === quote) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const raw = html.slice(start, i + 1);
        try { return JSON.parse(raw); } catch { return null; }
      }
    }
  }
  return null;
}

const HTML_ENTITIES = { '&#x27;': "'", '&#39;': "'", '&quot;': '"', '&lt;': '<', '&gt;': '>', '&amp;': '&' };

function decodeHtmlEntities(s) {
  return String(s).replace(/&#x27;|&#39;|&quot;|&lt;|&gt;|&amp;/g, (e) => HTML_ENTITIES[e]);
}

/**
 * Parse SSR `data-props='{...}'` JSON islands (hydration props), e.g. the
 * sidebar: `<div data-props='{"user":...}' id=sidebar-v2-island>` or the link
 * editor island (which contains `formActionUrl`). Attributes may be unquoted.
 * Returns every parsable island, optionally restricted to one element id.
 */
function extractAllIslandProps(html, islandId) {
  let scope = html;
  if (islandId) {
    const idIdx = html.search(new RegExp(`id=["']?${islandId}["']?`));
    if (idIdx === -1) return [];
    const open = html.lastIndexOf('<', idIdx);
    const close = html.indexOf('>', idIdx);
    if (open === -1 || close === -1) return [];
    scope = html.slice(open, close + 1);
  }
  const out = [];
  const re = /data-props='([^']*)'/g;
  let m;
  while ((m = re.exec(scope))) {
    try { out.push(JSON.parse(decodeHtmlEntities(m[1]))); } catch { /* not JSON — skip */ }
  }
  return out;
}

/** First parsable `data-props` island (optionally of one element id), or null. */
function extractIslandProps(html, islandId) {
  return extractAllIslandProps(html, islandId)[0] || null;
}

/** Parse the `<script id=page-data type=application/json>` block (per-page state). */
function extractPageData(html) {
  const m = html.match(/<script[^>]*id=["']?page-data["']?[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

class GetMySocialSessionClient {
  /**
   * @param {object} opts
   * @param {string} opts.cookie     Full `Cookie` header value from a logged-in session.
   * @param {string} [opts.teamId]   Default team scope (`teamId` query param) for all calls.
   * @param {string} [opts.baseUrl]  Default https://getmysocial.com
   * @param {string} [opts.userAgent]
   * @param {number} [opts.minRequestIntervalMs=350]
   * @param {number} [opts.timeoutMs=30000]
   */
  constructor({ cookie, teamId = null, baseUrl = BASE_DEFAULT, userAgent = UA_DEFAULT, minRequestIntervalMs = 350, timeoutMs = 30000 } = {}) {
    if (!cookie) throw new Error('GetMySocialSessionClient: cookie is required');
    this.cookie = cookie;
    this.teamId = teamId || null;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.userAgent = userAgent;
    this.minRequestIntervalMs = minRequestIntervalMs;
    this.timeoutMs = timeoutMs;
    this._nextAt = 0;
    this._editRouteCache = new Map(); // linkId -> formActionUrl
  }

  _throttle() {
    const now = Date.now();
    const wait = Math.max(0, this._nextAt - now);
    this._nextAt = Math.max(now, this._nextAt) + this.minRequestIntervalMs;
    return wait > 0 ? new Promise((r) => setTimeout(r, wait)) : Promise.resolve();
  }

  _url(path, query) {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null || v === '') continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  }

  _scope(teamId) {
    return teamId !== undefined ? teamId : this.teamId;
  }

  async _request(method, path, { query, json, form, html, headers = {}, referer } = {}) {
    await this._throttle();
    const url = this._url(path, query);
    const h = {
      Accept: html ? 'text/html,application/xhtml+xml' : 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: this.cookie,
      'User-Agent': this.userAgent,
      ...headers,
    };
    if (method !== 'GET' && method !== 'HEAD') {
      h.Origin = this.baseUrl;
      h.Referer = referer || `${this.baseUrl}/dashboard/links`;
    }
    let body;
    if (form) body = form; // multipart — fetch sets the boundary
    else if (json !== undefined) {
      body = JSON.stringify(json);
      h['Content-Type'] = 'application/json';
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: ac.signal });
    } catch (e) {
      throw new GmsApiError(`Network error calling ${path}: ${e.message}`, {});
    } finally {
      clearTimeout(timer);
    }

    if (res.status >= 300 && res.status < 400) {
      throw new SessionExpiredError(undefined, { status: res.status });
    }

    const text = await res.text();
    let data = null;
    let isJson = false;
    try {
      data = text ? JSON.parse(text) : null;
      isJson = true;
    } catch { /* not JSON */ }

    if (!res.ok) {
      const errNode = data && data.error;
      const msg = (typeof errNode === 'string' && errNode)
        || (errNode && errNode.message)
        || (data && data.message)
        || `HTTP ${res.status}`;
      throw new GmsApiError(msg, { status: res.status, body: data });
    }
    if (html) return text;
    if (!isJson && text && /<html|<!doctype/i.test(text)) {
      throw new SessionExpiredError('Received an HTML page instead of JSON — session likely expired.');
    }
    return data;
  }

  // ------------------------------------------------------------------ reads

  /** Board (groups + first page of links). */
  board({ teamId } = {}) {
    return this._request('GET', '/api/links/board', { query: { teamId: this._scope(teamId) } });
  }

  /** One page of a group's links. */
  groupPage(groupId, { teamId, limit = 100, after } = {}) {
    return this._request('GET', `/api/links/board/group/${encodeURIComponent(groupId)}`, {
      query: { limit, after, teamId: this._scope(teamId) },
    });
  }

  /** Server-side search over display name / shortcode / URL. */
  search(query, { teamId } = {}) {
    return this._request('GET', '/api/links/board/search', { query: { q: query, teamId: this._scope(teamId) } });
  }

  /** Lightweight link list for pickers. */
  searchableList(query, { teamId } = {}) {
    return this._request('GET', '/api/links/searchable-list', { query: { q: query, teamId: this._scope(teamId) } });
  }

  /** Per-link daily clicks + ctr. */
  sparklines(linkIds, { teamId } = {}) {
    const ids = (Array.isArray(linkIds) ? linkIds : [linkIds]).join(',');
    return this._request('GET', '/api/links/board/sparklines', {
      query: { linkIds: ids, teamId: this._scope(teamId) },
    });
  }

  /** Plan usage/limits (optionally team-scoped). */
  usage({ teamId } = {}) {
    return this._request('GET', '/api/user/usage', { query: { teamId: this._scope(teamId) } });
  }

  // --------------------------------------------------------------- analytics

  /**
   * Account analytics overview for a timeframe.
   * Returns pageViews, totalClicks, visitsWithClicks, ctr, conversionRate,
   * periodStartDate/periodEndDate, topLink, topLocation, topReferrer, topDevice,
   * referrerBreakdown, deviceBreakdown, statsMap (country counts), leaderboardData.
   * Verified presets: today, yesterday, thisWeek, lastWeek, thisMonth, lastMonth,
   * allTime (invalid values are silently coerced server-side — stick to the list).
   */
  analyticsOverview({ timeframe = 'thisWeek', timeframeType = 'preset', startDate = '', endDate = '', teamId } = {}) {
    const t = this._scope(teamId);
    return this._request('POST', '/api/dashboard/v2/overview', {
      json: { timeframe, timeframeType, startDate, endDate, ...(t ? { teamId: t } : {}) },
    });
  }

  /**
   * Per-link analytics rows, sorted server-side.
   * Each row: { id, originalLink, displayName, pageViews, visitsWithClicks, ctr, sparklineData[] }.
   * `sortBy`: 'pageViews' | 'visitsWithClicks' | 'ctr'.
   */
  analyticsPerLink({ timeframe = 'thisWeek', timeframeType = 'preset', startDate = '', endDate = '', page = 1, pageSize = 10, sortBy = 'pageViews', sortDir = 'desc', teamId } = {}) {
    const t = this._scope(teamId);
    return this._request('POST', '/api/dashboard/v2/per-link', {
      json: { timeframe, timeframeType, startDate, endDate, page, pageSize, sortBy, sortDir, ...(t ? { teamId: t } : {}) },
    });
  }

  /** Teams the account belongs to (parsed from the SSR sidebar island — there is
   *  no GET /api/teams; POST /api/teams creates a team). */
  async teams() {
    const props = await this.sidebarProps();
    if (!props) throw new GmsApiError('Could not parse sidebarTeams from /dashboard (page markup changed?)');
    return props.sidebarTeams || { owned: [], member: [] };
  }

  /** Sidebar island props: { user, sidebarTeams, currentTeamId, ... }. */
  async sidebarProps() {
    const html = await this._request('GET', '/dashboard', { html: true });
    return extractIslandProps(html, 'sidebar-v2-island');
  }

  /** Group list (convenience: reads groups out of the board response). */
  async listGroups({ teamId } = {}) {
    const b = await this.board({ teamId });
    return Array.isArray(b && b.groups) ? b.groups : [];
  }

  /**
   * All links across every group, paginating group pages.
   * @returns {Promise<{groups: Array, links: Array, totalLinks: number|undefined}>}
   */
  async listAll({ teamId, maxPagesPerGroup = 10, pageLimit = 100 } = {}) {
    const t = this._scope(teamId);
    const b = await this.board({ teamId: t });
    const byId = new Map();
    const add = (l) => {
      if (!l) return;
      const id = String(l._id || l.id || '');
      if (id && !byId.has(id)) byId.set(id, l);
    };
    (Array.isArray(b && b.links) ? b.links : []).forEach(add);

    const groups = Array.isArray(b && b.groups) ? b.groups : [];
    const pages = (b && b.pages) || {};
    for (const g of groups) {
      let cursor = pages[g.id] && pages[g.id].nextCursor || null;
      let hasMore = pages[g.id] ? !!pages[g.id].hasMore : (g.total > 0);
      let page = 0;
      while (hasMore && page < maxPagesPerGroup) {
        const r = await this.groupPage(g.id, { teamId: t, limit: pageLimit, after: cursor });
        (Array.isArray(r && r.links) ? r.links : []).forEach(add);
        cursor = (r && r.nextCursor) || null;
        hasMore = !!(r && r.hasMore);
        page++;
      }
    }
    return { groups, links: [...byId.values()], totalLinks: b && b.totalLinks };
  }

  /**
   * Resolve a link by Mongo id, shortcode, or a getmysocial.com URL containing it.
   * @returns {Promise<object|null>}
   */
  async findLink(ref, { teamId } = {}) {
    const clean = stripInvisible(String(ref || '').replace(/^https?:\/\/[^/]+\//i, '').replace(/\/+$/, ''));
    if (!clean) return null;
    const isId = /^[a-f0-9]{24}$/i.test(clean);

    // Search first (cheap), then fall back to a full board scan.
    try {
      const s = await this.search(clean, { teamId });
      const hits = Array.isArray(s && s.links) ? s.links : [];
      const exact = hits.find((l) =>
        (isId && String(l._id || l.id) === clean) ||
        String(l.originalLink || '').toLowerCase() === clean.toLowerCase());
      if (exact) return exact;
      if (hits.length === 1) return hits[0];
    } catch { /* fall through to board scan */ }

    const all = await this.listAll({ teamId });
    return all.links.find((l) =>
      (isId && String(l._id || l.id) === clean) ||
      String(l.originalLink || '').toLowerCase() === clean.toLowerCase()) || null;
  }

  // --------------------------------------------------------------- mutations

  /** Build the exact multipart field map the dashboard sends for a direct link. */
  buildDirectLinkFields({
    shortcode, url, displayName,
    teamId, groupId,
    botProtection = BOT_PROTECTION_DEFAULT,
    deeplinkMode = 'off',
    selectedDomain = 'getmysocial.com',
    openInNewTab = false,
    ageVerificationEnabled = false,
    adultLinkCaptcha = false,
    geofilters = [],
    smartRedirect = SMART_REDIRECT_DEFAULT,
    extra = {},
  } = {}) {
    return {
      teamId: teamId || '',
      originalLink: stripInvisible(shortcode),
      displayName: displayName || '',
      typeLink: 'deeplink',
      redirectDeepLink: url || '',
      botProtection: JSON.stringify(botProtection || BOT_PROTECTION_DEFAULT),
      ageVerificationEnabled: !!ageVerificationEnabled,
      adultLinkCaptcha: !!adultLinkCaptcha,
      selectedDomain,
      groupId: groupId || '',
      geofilters: JSON.stringify(geofilters || []),
      smartRedirect: JSON.stringify(smartRedirect || SMART_REDIRECT_DEFAULT),
      template: '0',
      textsColor: '0',
      customTextColor: '#6366F1',
      buttonsStyles: '0',
      fontFamily: '0',
      backgroundColor: '0',
      customBackgroundColor: '#8B5CF6',
      nameUser: '',
      bio: '',
      showProfilePicture: true,
      verifiedBadge: false,
      verifiedBadgeColor: '#1DA1F2',
      backgroundBlur: false,
      redirectCtaSubtitle: '',
      redirectCtaButton: '',
      profilePictureSlides: '[]',
      links: JSON.stringify({ links: [] }),
      socialMediaLinks: '[]',
      socialIconSize: 0,
      socialIconFloating: false,
      fallbackLocation: 'Paris, France',
      online: false,
      responseTime: '',
      audioEnabled: false,
      seoEnabled: false,
      trafficRecovery: JSON.stringify({ enabled: false, destinationUrl: '' }),
      fomoModal: JSON.stringify({ enabled: false }),
      deeplinkMode,
      openInNewTab: !!openInNewTab,
      disableLinkLogos: false,
      hotjarSiteId: '',
      ...extra,
    };
  }

  _formFromFields(fields) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }
    return fd;
  }

  /** Create a direct link (deeplink). Resolves to the created link object. */
  async createDirectLink(payload, { teamId } = {}) {
    const t = this._scope(teamId);
    const fields = this.buildDirectLinkFields({ ...payload, teamId: t || '' });
    const res = await this._request('POST', '/api/links/create', { form: this._formFromFields(fields) });
    return (res && res.link) || res;
  }

  /**
   * Discover the edit POST route + SSR link data for a link.
   * The dashboard passes `formActionUrl` into the editor at render time — the
   * source can be window.appData, a `<script id=page-data>` block, or a
   * `data-props` island, depending on the page, so all are tried.
   */
  async resolveEditContext(linkId, { teamId } = {}) {
    const t = this._scope(teamId);
    const path = t
      ? `/dashboard/teams/${encodeURIComponent(t)}/links/edit/${encodeURIComponent(linkId)}`
      : `/dashboard/links/edit/${encodeURIComponent(linkId)}`;
    const html = await this._request('GET', path, { html: true, referer: `${this.baseUrl}${path}` });
    const out = { formActionUrl: null, link: null };

    let m = html.match(/"formActionUrl"\s*:\s*"([^"]+)"/);
    if (m) out.formActionUrl = m[1].replace(/\\u002F/gi, '/');

    for (const src of [extractWindowAppData(html), extractPageData(html), ...extractAllIslandProps(html)]) {
      if (!src || typeof src !== 'object') continue;
      if (!out.formActionUrl && typeof src.formActionUrl === 'string') out.formActionUrl = src.formActionUrl;
      if (!out.link) {
        const candidates = [src.linkData, src.link, src.props && src.props.linkData, src.data && src.data.link];
        for (const c of candidates) {
          if (c && typeof c === 'object') { out.link = c; break; }
        }
      }
      if (!out.link && Array.isArray(src.links)) {
        out.link = src.links.find((l) => String(l._id || l.id) === String(linkId)) || null;
      }
      if (out.formActionUrl && out.link) break;
    }

    if (!out.formActionUrl) {
      // last resort: raw html scan for an /api/links/...edit path
      m = html.match(/\/api\/links\/[a-zA-Z0-9/_-]*edit[a-zA-Z0-9/_{}$.:-]*/);
      if (m) out.formActionUrl = m[0];
    }
    return out;
  }

  /** Candidate edit routes, tried in order when discovery fails (404 falls through).
   *  Confirmed live: POST /api/links/update/{id} (formActionUrl from the SSR edit page). */
  _editCandidates(linkId) {
    return [
      `/api/links/update/${encodeURIComponent(linkId)}`,
      `/api/links/edit/${encodeURIComponent(linkId)}`,
    ];
  }

  /**
   * Update a direct link (read-modify-write).
   *
   * patch: { url?, shortcode?, displayName?, groupId?, botProtection?, deeplinkMode?,
   *          selectedDomain?, openInNewTab?, ageVerificationEnabled?, adultLinkCaptcha?,
   *          geofilters?, smartRedirect?, extra? }
   */
  async updateDirectLink(linkId, patch = {}, { teamId } = {}) {
    const t = this._scope(teamId);
    const current = await this.findLink(linkId, { teamId: t });
    if (!current) throw new GmsApiError(`Link not found: ${linkId}`, { status: 404 });

    let ctx = null;
    try {
      ctx = await this.resolveEditContext(linkId, { teamId: t });
    } catch (e) {
      if (e instanceof SessionExpiredError) throw e;
      ctx = null;
    }
    if (ctx && ctx.formActionUrl) this._editRouteCache.set(String(linkId), ctx.formActionUrl);
    const base = ctx && ctx.link ? { ...current, ...ctx.link } : current;

    const pick = (k, d) => (patch[k] !== undefined ? patch[k] : (base[k] !== undefined && base[k] !== null ? base[k] : d));

    const fields = this.buildDirectLinkFields({
      shortcode: patch.shortcode !== undefined ? patch.shortcode : base.originalLink,
      url: patch.url !== undefined ? patch.url : base.redirectDeepLink,
      displayName: patch.displayName !== undefined ? patch.displayName : base.displayName,
      teamId: t || '',
      groupId: pick('groupId', ''),
      botProtection: pick('botProtection', BOT_PROTECTION_DEFAULT),
      deeplinkMode: pick('deeplinkMode', 'off'),
      selectedDomain: pick('selectedDomain', 'getmysocial.com'),
      openInNewTab: pick('openInNewTab', false),
      ageVerificationEnabled: pick('ageVerificationEnabled', false),
      adultLinkCaptcha: pick('adultLinkCaptcha', false),
      geofilters: pick('geofilters', []),
      smartRedirect: pick('smartRedirect', SMART_REDIRECT_DEFAULT),
      extra: patch.extra || {},
    });

    // Echo extra writable content fields so they are not wiped by the PUT-style server.
    const ECHO_KEYS = [
      'nameUser', 'bio', 'template', 'textsColor', 'customTextColor', 'buttonsStyles', 'fontFamily',
      'backgroundColor', 'customBackgroundColor', 'showProfilePicture', 'verifiedBadge', 'verifiedBadgeColor',
      'backgroundBlur', 'redirectCtaSubtitle', 'redirectCtaButton', 'socialIconSize', 'socialIconFloating',
      'fallbackLocation', 'online', 'responseTime', 'audioEnabled', 'seoEnabled', 'disableLinkLogos',
      'hotjarSiteId', 'whitelabel', 'googleAnalytics', 'facebookPixel', 'snapchatPixel', 'tiktokPixel',
      'xPixel', 'xEventId',
    ];
    for (const k of ECHO_KEYS) {
      if (base[k] !== undefined && base[k] !== null && fields[k] === undefined) {
        fields[k] = typeof base[k] === 'object' ? JSON.stringify(base[k]) : base[k];
      }
    }
    for (const k of ['socialMediaLinks', 'trackingParameters', 'facebookPixelEvents', 'snapchatPixelEvents', 'tiktokPixelEvents', 'seo', 'fomoModal', 'trafficRecovery']) {
      if (base[k] !== undefined && base[k] !== null) fields[k] = JSON.stringify(base[k]);
    }

    const cached = this._editRouteCache.get(String(linkId));
    const routes = cached ? [cached] : this._editCandidates(linkId);
    let lastErr = null;
    for (const route of routes) {
      try {
        const res = await this._request('POST', route, { form: this._formFromFields(fields) });
        this._editRouteCache.set(String(linkId), route);
        return (res && (res.link || res)) || res;
      } catch (e) {
        lastErr = e;
        if (e instanceof GmsApiError && e.status === 404) continue; // wrong route guess — try next
        throw e;
      }
    }
    throw new GmsApiError(
      `Could not resolve the edit route for ${linkId}. Run diagnose_live.js to discover it. Last error: ${lastErr && lastErr.message}`,
      { status: lastErr && lastErr.status },
    );
  }

  /** Toggle link status server-side. Returns the new status string. */
  async toggleStatus(linkId, { teamId } = {}) {
    const res = await this._request('PATCH', `/api/links/${encodeURIComponent(linkId)}/status`, {
      query: { teamId: this._scope(teamId) },
      json: {},
    });
    if (res && res.success === false) {
      const err = new GmsApiError(res.message || 'Could not update status', { status: 403, body: res });
      if (res.upgrade_required) err.code = 'upgrade_required';
      throw err;
    }
    return res;
  }

  /** Idempotent enable/disable: reads current status, toggles only when needed.
   *  Server status vocabulary: 'active' | 'inactive' (disabled). The PATCH endpoint
   *  flips between the two, so it is only called when the current state differs. */
  async setEnabled(linkId, enabled, { teamId } = {}) {
    const link = await this.findLink(linkId, { teamId });
    if (!link) throw new GmsApiError(`Link not found: ${linkId}`, { status: 404 });
    const status = String(link.status || '');
    const isActive = status === 'active';
    const isInactive = status === 'inactive' || status === 'disabled';
    if (enabled ? isActive : isInactive) return { status, changed: false };
    const res = await this.toggleStatus(String(link._id || link.id || linkId), { teamId });
    return { status: (res && res.status) || (enabled ? 'active' : 'inactive'), changed: true };
  }

  /** Delete one link. The single-delete route turns permission denials into a
   *  generic HTTP 500 on team links; fall back to bulk-delete, which returns a
   *  proper 403 (or succeeds if the 500 was spurious). */
  async deleteLink(linkId, { teamId } = {}) {
    try {
      return await this._request('DELETE', `/api/links/${encodeURIComponent(linkId)}`, {
        query: { teamId: this._scope(teamId) },
      });
    } catch (e) {
      if (!(e instanceof GmsApiError) || e.status !== 500) throw e;
      return this.deleteLinksBulk([linkId], { teamId });
    }
  }

  /** Delete up to 100 links in one call. */
  deleteLinksBulk(ids, { teamId } = {}) {
    return this._request('POST', '/api/links/delete-bulk', {
      query: { teamId: this._scope(teamId) },
      json: { linkIds: ids.map(String), teamId: this._scope(teamId) ?? null },
    });
  }

  /** Duplicate a link. */
  duplicateLink({ linkId, shortcode, displayName, teamId } = {}) {
    const t = this._scope(teamId);
    return this._request('POST', '/api/links/duplicate', {
      query: { teamId: t },
      json: {
        originalLinkId: linkId,
        newOriginalLink: stripInvisible(shortcode),
        newDisplayName: displayName,
        teamId: t ?? null,
      },
    });
  }

  // ------------------------------------------------------------------ groups

  createGroup(name, { teamId } = {}) {
    const t = this._scope(teamId);
    return this._request('POST', '/api/links/groups', { json: t ? { name, teamId: t } : { name } });
  }

  renameGroup(groupId, name, { teamId } = {}) {
    return this._request('PATCH', `/api/links/groups/${encodeURIComponent(groupId)}`, {
      query: { teamId: this._scope(teamId) },
      json: { name },
    });
  }

  deleteGroup(groupId, { teamId } = {}) {
    return this._request('DELETE', `/api/links/groups/${encodeURIComponent(groupId)}`, {
      query: { teamId: this._scope(teamId) },
    });
  }

  assignGroupBulk(linkIds, groupId, { teamId } = {}) {
    const t = this._scope(teamId);
    return this._request('POST', '/api/links/assign-group-bulk', {
      query: { teamId: t },
      json: { linkIds: linkIds.map(String), groupId: groupId || null, teamId: t ?? null },
    });
  }
}

module.exports = {
  GetMySocialSessionClient,
  GmsApiError,
  SessionExpiredError,
  extractWindowAppData,
  extractIslandProps,
  extractAllIslandProps,
  extractPageData,
  stripInvisible,
  BOT_PROTECTION_DEFAULT,
  SMART_REDIRECT_DEFAULT,
};
