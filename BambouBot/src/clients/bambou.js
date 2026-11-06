'use strict';

/**
 * BambouAI (bambouaibot.com) client — zero dependencies (Node 18+).
 *
 * Three auth surfaces (see docs/REVERSE_ENGINEERING.md):
 *
 *   BambouStudio     session cookie (POST /api/login with the *login key*)
 *                    → everything config-related: presets, URLs, API keys, media,
 *                      conversations, engine, live supervision.
 *   BambouAssistant  assistant API key "bbk_..." (Settings → API Keys)
 *                    → stateless generation from the bots: /api/assistant/*
 *   BambouExtension  extension key (X-Bambou-Extension-Key)
 *                    → /api/extension/* used by the browser extension.
 *
 * Reverse-engineered 2026-10-18 from the dashboard bundle (app.js md5
 * 617d54cc0548ffb806f87e49036ca5e2) + the public contract (/openapi.json v2026-10-04).
 * Routes are centralised in ROUTES so a server-side rename is a one-line fix.
 */

const DEFAULT_BASE_URL = 'https://bambouaibot.com';

/** Central route map — all confirmed against the live bundle/contract. */
const ROUTES = {
  health: () => `/health`,
  login: () => `/api/login`,
  logout: () => `/api/logout`,
  session: () => `/api/session`,

  // studio config / presets
  config: () => `/api/studio/config`, // GET + PUT (whole document)
  exportPreset: (id) => `/api/studio/presets/${encodeURIComponent(id)}/export`,
  importPreset: () => `/api/studio/presets/import`,
  importSection: (id) => `/api/studio/presets/${encodeURIComponent(id)}/import-section`,

  // assistant keys
  apiKeys: () => `/api/studio/api-keys`,
  apiKey: (keyId) => `/api/studio/api-keys/${encodeURIComponent(keyId)}`,

  // engine
  engineProfiles: () => `/api/studio/engine-profiles`,
  engineProfile: () => `/api/studio/engine-profile`,
  engineProfileKey: () => `/api/studio/engine-profile-key`,
  engineKey: () => `/api/studio/engine-key`,
  visionKey: () => `/api/studio/vision-key`,
  haikuKey: () => `/api/studio/haiku-key`,
  ollamaKey: () => `/api/studio/ollama-key`,
  ollamaModels: () => `/api/studio/ollama-models`,
  engineTest: () => `/api/studio/engine-test`,
  studioGenerate: () => `/api/studio/generate`,

  // media
  mediaLibrary: () => `/api/media/library`,
  mediaVaults: () => `/api/media/vaults`,
  mediaVault: (id) => `/api/media/vaults/${encodeURIComponent(id)}`,
  mediaDays: () => `/api/media/days`,
  mediaItems: () => `/api/media/items`,
  mediaItem: (id) => `/api/media/items/${encodeURIComponent(id)}`,
  mediaItemFile: (id) => `/api/media/items/${encodeURIComponent(id)}/file`,
  mediaPublicFile: (id) => `/api/media/public/${encodeURIComponent(id)}/file`,

  // conversations
  conversationsArchive: () => `/api/conversations/archive`,
  conversation: (accountId, partnerId) =>
    `/api/conversations/archive/${encodeURIComponent(accountId)}/${encodeURIComponent(partnerId)}`,
  conversationsExport: () => `/api/conversations/export`,

  // live supervision (internal dashboard routes, same session cookie)
  dashboard: () => `/api/dashboard`,
  accounts: () => `/api/accounts`,
  account: (id) => `/api/accounts/${encodeURIComponent(id)}`,
  accountSessionExport: (id) => `/api/accounts/${encodeURIComponent(id)}/session/export`,
  accountConversations: (id) => `/api/accounts/${encodeURIComponent(id)}/conversations`,
  mailboxes: () => `/api/mailboxes`,
  mailbox: (id) => `/api/mailboxes/${encodeURIComponent(id)}`,
  mailboxesImport: () => `/api/mailboxes/import`,
  adspowerProxies: () => `/api/adspower/proxies`,
  blockedMessages: () => `/api/studio/blocked-messages`,
  blockedMessagesClear: () => `/api/studio/blocked-messages/clear`,
  snapRdps: () => `/api/snap/rdps`,
  snapStatus: () => `/api/snap/status`,
  snapFleetHealth: () => `/api/snap/fleet-health`,
  snapCreate: () => `/api/snap/create`,
  snapCreateStatus: () => `/api/snap/create/status`,
  snapPlace: () => `/api/snap/place`,
  snapUnplace: () => `/api/snap/unplace`,

  // assistant-key surface (bbk_...)
  assistantPresets: () => `/api/assistant/presets`,
  assistantGenerate: () => `/api/assistant/generate`,

  // extension-key surface
  extensionConfig: () => `/api/extension/config`,
  extensionGenerate: () => `/api/extension/generate`,
};

/** URL platform values the dashboard offers (others store fine, only these have labels). */
const PLATFORMS = [
  'snap', 'OnlyFans', 'Phone Number', 'Telegram', 'Fansly', 'Chaturbate', 'I Want Clips',
  'Fanplace', 'Premium Snapchat', 'MYM', 'AVN Stars', 'Fanvue', '4Based', 'FetLife',
  'Feet Finder', 'Patreon', 'FanCentro', 'UVIU', 'Loyal Fans', 'Just For Fans',
  'FlirtingFans', 'Many Vids', 'Uncove', 'Clips4Sale', 'Unlockd', 'FanTime', 'Ifans',
  'Unfiltrd', 'Other',
];

/** Preset section names (section import/export). */
const SECTIONS = ['main', 'openers', 'phases', 'cta', 'urls', 'objections', 'sprinkles',
  'followups', 'finishers', 'ignorelist', 'media'];

/** Section → preset modules mapping (dashboard SECTION_MODULES). */
const SECTION_MODULES = {
  main: ['identity', 'persona', 'style', 'strategy', 'behavior', 'mainSettings'],
  openers: ['openers'],
  phases: ['cycles'],
  cta: ['ctaScripts'],
  urls: ['urls'],
  objections: ['objections'],
  sprinkles: ['sprinkles'],
  followups: ['followups'],
  finishers: ['finishers'],
  ignorelist: ['ignoreConditions'],
  media: ['media'],
};

class BambouError extends Error {
  constructor(message, { status, body, retryAfter } = {}) {
    super(message);
    this.name = 'BambouError';
    this.status = status;
    this.body = body;
    this.retryAfter = retryAfter; // seconds, when the server sent Retry-After (429)
  }
}

const IDEMPOTENT = new Set(['GET', 'HEAD', 'OPTIONS']);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function deepMerge(target, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? target : patch;
  const out = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Mirror of the dashboard's setAtPath(): creates missing intermediate objects. */
function setAtPath(root, pathname, value) {
  const keys = String(pathname).split('.');
  const finalKey = keys.pop();
  const target = keys.reduce((obj, key) => {
    if (obj[key] === undefined || obj[key] === null) obj[key] = {};
    return obj[key];
  }, root);
  target[finalKey] = value;
  return root;
}

function valueAtPath(root, pathname) {
  return String(pathname).split('.').reduce((value, key) => (value === undefined || value === null ? value : value[key]), root);
}

/** Minimal cookie jar (fetch does not persist cookies). */
class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  capture(response) {
    const headerList = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : []);
    for (const line of headerList) {
      const [pair] = String(line).split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  header() {
    if (!this.cookies.size) return undefined;
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  clear() {
    this.cookies.clear();
  }
}

class BambouHttp {
  /**
   * @param {object} opts
   * @param {string} [opts.baseUrl]   space base URL (subdomains are separate spaces)
   * @param {number} [opts.timeoutMs=30000]
   * @param {number} [opts.maxRetries=2]  retries on network errors/429/5xx (honours Retry-After, capped).
   *                                      Only idempotent methods (GET/HEAD) are retried: the API has no
   *                                      idempotency keys, so replaying a POST/PUT/PATCH/DELETE after an
   *                                      ambiguous failure could e.g. create a second API key.
   * @param {typeof fetch} [opts.fetchImpl]
   */
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = 30000, maxRetries = 2, fetchImpl } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.fetchImpl = fetchImpl || globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') throw new Error('BambouHttp: global fetch missing (need Node 18+)');
    this.jar = new CookieJar();
  }

  /** Extra auth headers — overridden by the key-based subclasses. */
  authHeaders() {
    return {};
  }

  async request(method, path, { body, query, headers = {}, raw = false, _retriedAuth = false } = {}) {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
      }
    }

    const maxRetries = IDEMPOTENT.has(String(method).toUpperCase()) ? this.maxRetries : 0;
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`BambouAI timeout after ${this.timeoutMs} ms`)), this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers: {
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
            ...(this.jar.header() ? { Cookie: this.jar.header() } : {}),
            ...this.authHeaders(),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        lastError = error;
        if (attempt < maxRetries) {
          await sleep(250 * 2 ** attempt);
          continue;
        }
        throw new BambouError(`Network error: ${error.message}`, { status: 0, body: null });
      }
      clearTimeout(timer);
      this.jar.capture(response);

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after'));
          const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** attempt;
          lastError = await this.#toError(response);
          await sleep(waitMs);
          continue;
        }
      }
      if (!response.ok) {
        const error = await this.#toError(response);
        // Session lost (server restart drops in-memory sessions): re-login once if we can.
        if (error.status === 401 && !_retriedAuth && typeof this.onUnauthorized === 'function' && path !== ROUTES.login()) {
          const reauth = await this.onUnauthorized();
          if (reauth) return this.request(method, path, { body, query, headers, raw, _retriedAuth: true });
        }
        throw error;
      }

      if (raw) return response.arrayBuffer();
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    throw lastError instanceof BambouError ? lastError : new BambouError(String(lastError?.message || 'Request failed'));
  }

  async #toError(response) {
    let body = null;
    let message = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      try {
        body = text ? JSON.parse(text) : null;
        if (body && typeof body.error === 'string' && body.error) message = body.error;
      } catch {
        body = text || null;
      }
    } catch { /* keep defaults */ }
    const retryAfter = Number(response.headers.get('retry-after'));
    return new BambouError(message, {
      status: response.status,
      body,
      retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Studio session client — presets, URLs, API keys, media, everything  */
/* ------------------------------------------------------------------ */

class BambouStudio extends BambouHttp {
  /**
   * @param {object} [opts]
   * @param {string} [opts.loginKey]  the studio login key (dashboard login screen).
   *                                  When set, a 401 triggers one automatic re-login
   *                                  (server sessions are in-memory and die on restart).
   */
  constructor(opts = {}) {
    super(opts);
    this.loginKey = opts.loginKey || null;
    this.onUnauthorized = async () => {
      if (!this.loginKey) return false;
      try {
        await this.login(this.loginKey);
        return true;
      } catch {
        return false;
      }
    };
  }

  // ---- auth -------------------------------------------------------

  /** POST /api/login — opens the 12 h "bambou_session" cookie. */
  async login(loginKey = this.loginKey) {
    if (!loginKey) throw new BambouError('loginKey is required (the studio login key)');
    this.jar.clear();
    const payload = await this.request('POST', ROUTES.login(), { body: { key: loginKey } });
    this.loginKey = loginKey;
    return payload; // {authenticated:true}
  }

  async session() {
    return this.request('GET', ROUTES.session());
  }

  async logout() {
    const payload = await this.request('POST', ROUTES.logout());
    this.jar.clear();
    return payload;
  }

  // ---- studio config (read-modify-write; PUT replaces the WHOLE doc) ----

  _withConfigLock(task) {
    const run = async () => task();
    const chained = (this._configChain || Promise.resolve()).then(run, run);
    this._configChain = chained.catch(() => {});
    return chained;
  }

  async getConfig() {
    return this.request('GET', ROUTES.config());
  }

  async saveConfig(config) {
    return this.request('PUT', ROUTES.config(), { body: config });
  }

  /**
   * Safe read-modify-write. The mutator receives a deep clone of the fresh config,
   * mutates it freely, and may return a replacement document (or nothing).
   * Concurrent updateConfig() calls on this instance are serialised.
   */
  async updateConfig(mutator) {
    return this._withConfigLock(async () => {
      const current = await this.getConfig();
      const draft = structuredClone(current);
      const replacement = await mutator(draft);
      const next = replacement === undefined ? draft : replacement;
      if (!next || !Array.isArray(next.presets) || !Array.isArray(next.accounts)) {
        throw new BambouError('updateConfig: the document must keep the presets[] and accounts[] arrays');
      }
      return this.saveConfig(next);
    });
  }

  // ---- presets ------------------------------------------------------

  async listPresets({ includeArchived = true } = {}) {
    const config = await this.getConfig();
    const presets = Array.isArray(config.presets) ? config.presets : [];
    return includeArchived ? presets : presets.filter((p) => !p.archivedAt);
  }

  async getPreset(presetId, { includeArchived = true } = {}) {
    const presets = await this.listPresets({ includeArchived });
    const preset = presets.find((p) => String(p.id) === String(presetId));
    if (!preset) throw new BambouError(`Preset not found: ${presetId}`, { status: 404 });
    return preset;
  }

  /** 4-digit random id, mirroring the dashboard's uniquePresetId(). */
  _uniquePresetId(config) {
    const ids = new Set((config.presets || []).map((p) => String(p.id)));
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const id = String(1000 + Math.floor(Math.random() * 9000));
      if (!ids.has(id)) return id;
    }
    for (let candidate = 1000; candidate <= 9999; candidate += 1) {
      if (!ids.has(String(candidate))) return String(candidate);
    }
    throw new BambouError('No free 4-digit preset id left.');
  }

  /**
   * Create a preset by cloning an existing one (the server requires ≥1 preset,
   * so there is always a source). Mirrors the dashboard "add preset" button.
   *
   * @param {object} opts
   * @param {string} [opts.name]
   * @param {string} [opts.group]
   * @param {string} [opts.id]        explicit id (default: random 4 digits)
   * @param {string} [opts.from]      preset id to clone (default: first preset)
   * @param {object} [opts.overrides] deep-merged over the clone (e.g. {identity:{name:'Lina'}})
   */
  async createPreset({ name, group = '', id, from = null, overrides = {} } = {}) {
    let createdId = null;
    await this.updateConfig((config) => {
      const presets = config.presets || [];
      const source = structuredClone(from ? presets.find((p) => String(p.id) === String(from)) : presets[0]);
      if (!source) throw new BambouError(`Source preset not found: ${from ?? '(no preset)'}`);
      const number = presets.length + 1;
      source.id = id ? String(id) : this._uniquePresetId(config);
      source.archivedAt = null;
      source.name = name || `Nouveau preset ${number}`;
      source.group = group;
      deepMerge(source, overrides);
      createdId = source.id;
      config.presets = [...presets, source];
    });
    return this.getPreset(createdId);
  }

  /** Duplicate an existing preset (dashboard "duplicate" button). */
  async duplicatePreset(presetId, { name } = {}) {
    let createdId = null;
    await this.updateConfig((config) => {
      const presets = config.presets || [];
      const source = presets.find((p) => String(p.id) === String(presetId));
      if (!source) throw new BambouError(`Preset not found: ${presetId}`, { status: 404 });
      const clone = structuredClone(source);
      clone.id = this._uniquePresetId(config);
      clone.archivedAt = null;
      clone.name = name || `${clone.name} copie`;
      createdId = clone.id;
      config.presets = [...presets, clone];
    });
    return this.getPreset(createdId);
  }

  /**
   * Mutate one preset inside the config document.
   * @param {string} presetId
   * @param {(preset:object, config:object)=>void|object} updater mutate in place, or return a replacement preset
   */
  async updatePreset(presetId, updater) {
    return this.updateConfig((config) => {
      const preset = (config.presets || []).find((p) => String(p.id) === String(presetId));
      if (!preset) throw new BambouError(`Preset not found: ${presetId}`, { status: 404 });
      const replacement = updater(preset, config);
      if (replacement !== undefined) {
        const index = config.presets.indexOf(preset);
        config.presets[index] = replacement;
      }
    });
  }

  /** Set one dotted-path field on a preset (mirrors the dashboard setAtPath). */
  async setPresetField(presetId, path, value) {
    return this.updatePreset(presetId, (preset) => {
      setAtPath(preset, path, value);
    });
  }

  async getPresetField(presetId, path) {
    const preset = await this.getPreset(presetId);
    return valueAtPath(preset, path);
  }

  /** Archive (true) or restore (false) — the dashboard stores an ISO date in archivedAt. */
  async archivePreset(presetId, archived = true) {
    return this.updatePreset(presetId, (preset) => {
      preset.archivedAt = archived ? new Date().toISOString() : null;
    });
  }

  restorePreset(presetId) {
    return this.archivePreset(presetId, false);
  }

  /** Delete a preset. The server requires at least one preset (archived counts). */
  async deletePreset(presetId) {
    let deleted = false;
    await this.updateConfig((config) => {
      const before = config.presets || [];
      const after = before.filter((p) => String(p.id) !== String(presetId));
      if (after.length === before.length) throw new BambouError(`Preset not found: ${presetId}`, { status: 404 });
      if (!after.length) throw new BambouError('At least one preset must remain in the configuration.');
      deleted = true;
      config.presets = after;
    });
    return deleted;
  }

  // ---- preset export / import ----------------------------------------

  async exportPreset(presetId) {
    return this.request('GET', ROUTES.exportPreset(presetId));
  }

  /** Accepts an export document (or {payload:doc}). Returns {importedPresetId, ...config}. */
  async importPreset(document, { wrap = false } = {}) {
    const body = wrap ? { payload: document } : document;
    return this.request('POST', ROUTES.importPreset(), { body });
  }

  /** Build a section document client-side (mirrors the dashboard export button). */
  async exportSection(presetId, section) {
    const modules = SECTION_MODULES[section];
    if (!modules) throw new BambouError(`Unknown section: ${section} (${SECTIONS.join(', ')})`);
    const preset = await this.getPreset(presetId);
    const baked = {};
    for (const key of modules) baked[key] = preset[key];
    return {
      format: 'bambouai-section',
      version: 1,
      section,
      exportedAt: new Date().toISOString(),
      fromPreset: { id: preset.id, name: preset.name },
      modules: baked,
    };
  }

  /** POST …/import-section — server-side section swap into an existing preset. */
  async importSection(presetId, section, sectionDocument) {
    if (!SECTION_MODULES[section]) throw new BambouError(`Unknown section: ${section}`);
    const payload = sectionDocument.format === 'bambouai-section'
      ? sectionDocument
      : {
        format: 'bambouai-section',
        version: 1,
        section,
        exportedAt: new Date().toISOString(),
        fromPreset: null,
        modules: sectionDocument,
      };
    const response = await this.request('POST', ROUTES.importSection(presetId), { body: { section, payload } });
    const { importedSection, presetId: targetId, ...config } = response;
    return { config, importedSection, presetId: targetId };
  }

  // ---- URLs (preset.urls.items[]) -------------------------------------

  async listUrls(presetId) {
    const preset = await this.getPreset(presetId, { includeArchived: true });
    return Array.isArray(preset.urls?.items) ? preset.urls.items : [];
  }

  _normalizeUrlItem(item, index) {
    const url = {
      id: `url-${index + 1}`,
      platform: 'Other',
      displayLabel: 'plateforme privee',
      url: '',
      snapModel: '',
      spaceBeforeDotCom: false,
      enabled: true,
      ...item,
    };
    if (item && item.platform === 'snap') {
      // Snapchat items carry a model-setup id, no literal URL.
      if (!url.snapModel) url.snapModel = '';
    }
    return url;
  }

  /**
   * Add a URL to a preset.
   * @param {string} presetId
   * @param {object} item  {url, platform?, displayLabel?, snapModel?, spaceBeforeDotCom?, enabled?}
   */
  async addUrl(presetId, item = {}) {
    let created = null;
    await this.updatePreset(presetId, (preset) => {
      if (!preset.urls || typeof preset.urls !== 'object') preset.urls = { chooseRandomly: false, items: [] };
      if (!Array.isArray(preset.urls.items)) preset.urls.items = [];
      created = this._normalizeUrlItem(item, preset.urls.items.length);
      preset.urls.items.push(created);
    });
    return created;
  }

  /** ref: numeric index, {index}, {id} or a plain id string. */
  _findUrlIndex(preset, ref) {
    const items = Array.isArray(preset.urls?.items) ? preset.urls.items : [];
    if (typeof ref === 'number') return ref;
    const index = ref?.index;
    if (typeof index === 'number') return index;
    const id = ref?.id ?? ref;
    return items.findIndex((i) => String(i.id) === String(id));
  }

  async updateUrl(presetId, ref, patch) {
    let updated = null;
    await this.updatePreset(presetId, (preset) => {
      const index = this._findUrlIndex(preset, ref);
      const items = preset.urls?.items || [];
      if (index < 0 || index >= items.length) throw new BambouError(`URL not found (${JSON.stringify(ref)})`, { status: 404 });
      items[index] = { ...items[index], ...patch };
      updated = items[index];
    });
    return updated;
  }

  async setUrlEnabled(presetId, ref, enabled) {
    return this.updateUrl(presetId, ref, { enabled: Boolean(enabled) });
  }

  async removeUrl(presetId, ref) {
    let removed = null;
    await this.updatePreset(presetId, (preset) => {
      const index = this._findUrlIndex(preset, ref);
      const items = preset.urls?.items || [];
      if (index < 0 || index >= items.length) throw new BambouError(`URL not found (${JSON.stringify(ref)})`, { status: 404 });
      removed = items.splice(index, 1)[0];
    });
    return removed;
  }

  async setChooseRandomly(presetId, value) {
    return this.updatePreset(presetId, (preset) => {
      if (!preset.urls || typeof preset.urls !== 'object') preset.urls = { chooseRandomly: false, items: [] };
      preset.urls.chooseRandomly = Boolean(value);
    });
  }

  /** Replace every URL of the preset with a single enabled one (typical "set the link" op). */
  async setPrimaryUrl(presetId, { url, platform = 'Other', displayLabel, spaceBeforeDotCom = false } = {}) {
    if (!url) throw new BambouError('setPrimaryUrl: url is required');
    return this.updatePreset(presetId, (preset) => {
      preset.urls = {
        chooseRandomly: false,
        items: [{
          id: 'url-1',
          platform,
          displayLabel: displayLabel || platform,
          url,
          snapModel: '',
          spaceBeforeDotCom: Boolean(spaceBeforeDotCom),
          enabled: true,
        }],
      };
    });
  }

  async clearUrls(presetId) {
    return this.updatePreset(presetId, (preset) => {
      preset.urls = { chooseRandomly: false, items: [] };
    });
  }

  // ---- assistant API keys ----------------------------------------------

  /** @returns {Promise<Array>} keys without secrets (id ak_…, hint, limits, counters). */
  async listApiKeys() {
    const payload = await this.request('GET', ROUTES.apiKeys());
    return Array.isArray(payload?.keys) ? payload.keys : [];
  }

  /**
   * Create an assistant key. The clear key (bbk_…) is returned ONCE by the server
   * and never again — store it immediately.
   *
   * @param {object} opts {label, rpm?, maxConcurrent?, dailyLimit?, presetIds?}
   *   presetIds: [] or omitted = all presets (including future ones);
   *   [ids] = only those presets.
   */
  async createApiKey({ label, rpm, maxConcurrent, dailyLimit, presetIds } = {}) {
    if (!label || !String(label).trim()) throw new BambouError('createApiKey: label is required');
    const body = { label: String(label).trim() };
    if (rpm !== undefined) body.rpm = rpm;
    if (maxConcurrent !== undefined) body.maxConcurrent = maxConcurrent;
    if (dailyLimit !== undefined) body.dailyLimit = dailyLimit;
    if (presetIds !== undefined) body.presetIds = presetIds;
    return this.request('POST', ROUTES.apiKeys(), { body });
  }

  /** Partial update: label, rpm, maxConcurrent, dailyLimit, presetIds, disabled. */
  async updateApiKey(keyId, patch) {
    return this.request('PATCH', ROUTES.apiKey(keyId), { body: patch });
  }

  pauseApiKey(keyId) {
    return this.updateApiKey(keyId, { disabled: true });
  }

  resumeApiKey(keyId) {
    return this.updateApiKey(keyId, { disabled: false });
  }

  /** Revocation is immediate and final; revokeApiKey is irreversible — pause instead if unsure. */
  async revokeApiKey(keyId) {
    return this.request('DELETE', ROUTES.apiKey(keyId));
  }

  // ---- AI engine ---------------------------------------------------------

  async listEngineProfiles() {
    return this.request('GET', ROUTES.engineProfiles());
  }

  /** Select the active engine profile (provider catalog id). */
  async selectEngineProfile(id) {
    return this.request('PUT', ROUTES.engineProfile(), { body: { id } });
  }

  async setEngineProfileKey(id, key) {
    return this.request('PUT', ROUTES.engineProfileKey(), { body: { id, key } });
  }

  async setEngineKey(key) {
    return this.request('PUT', ROUTES.engineKey(), { body: { key } });
  }

  async setVisionKey(key) {
    return this.request('PUT', ROUTES.visionKey(), { body: { key } });
  }

  async setHaikuKey(key) {
    return this.request('PUT', ROUTES.haikuKey(), { body: { key } });
  }

  async setOllamaKey(key) {
    return this.request('PUT', ROUTES.ollamaKey(), { body: { key } });
  }

  async listOllamaModels() {
    return this.request('POST', ROUTES.ollamaModels());
  }

  async testEngine() {
    return this.request('POST', ROUTES.engineTest());
  }

  /** Playground generation with the studio session. */
  async generate({ presetId, messages }) {
    return this.request('POST', ROUTES.studioGenerate(), { body: { presetId: String(presetId), messages } });
  }

  // ---- media vaults --------------------------------------------------------

  async listMediaLibrary() {
    return this.request('GET', ROUTES.mediaLibrary());
  }

  async createVault(name) {
    return this.request('POST', ROUTES.mediaVaults(), { body: { name } });
  }

  async renameVault(vaultId, name) {
    return this.request('PATCH', ROUTES.mediaVault(vaultId), { body: { name } });
  }

  async deleteVault(vaultId) {
    return this.request('DELETE', ROUTES.mediaVault(vaultId));
  }

  async createDay(vaultId, name) {
    return this.request('POST', ROUTES.mediaDays(), { body: { vaultId, name } });
  }

  /**
   * Upload a media item (the payload is a base64 data URL, like the dashboard).
   * Limits seen in the bundle: image ≤ 18 MB, audio ≤ 30 MB, video/mp4 ≤ 40 MB.
   */
  async uploadMedia({ vaultId, dayId, category = 'primary', context = 'either', fileName, mimeType, data }) {
    return this.request('POST', ROUTES.mediaItems(), {
      body: { vaultId, dayId, category, context, fileName, mimeType, data },
    });
  }

  /** Read a local file and upload it (needs fs; kept optional so the client stays browser-friendly). */
  async uploadMediaFile(vaultId, filePath, { dayId, category = 'primary', context = 'either' } = {}) {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const buffer = await fs.readFile(filePath);
    const fileName = path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mimeType = {
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
      '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'audio/ogg',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    }[ext];
    if (!mimeType) throw new BambouError(`uploadMediaFile: unrecognised file extension (${ext})`);
    return this.uploadMedia({
      vaultId,
      dayId,
      category,
      context,
      fileName,
      mimeType,
      data: `data:${mimeType};base64,${buffer.toString('base64')}`,
    });
  }

  /** PATCH an item: {overlay:{text,preset,y,fontSize}, description, disappearing}. */
  async updateMediaItem(itemId, patch) {
    return this.request('PATCH', ROUTES.mediaItem(itemId), { body: patch });
  }

  async deleteMediaItem(itemId) {
    return this.request('DELETE', ROUTES.mediaItem(itemId));
  }

  mediaItemFileUrl(itemId) {
    return this.baseUrl + ROUTES.mediaItemFile(itemId);
  }

  // ---- conversations ----------------------------------------------------------

  async listConversationsArchive() {
    return this.request('GET', ROUTES.conversationsArchive());
  }

  async getConversation(accountId, partnerId) {
    return this.request('GET', ROUTES.conversation(accountId, partnerId));
  }

  async exportConversations() {
    return this.request('GET', ROUTES.conversationsExport());
  }

  // ---- live supervision (internal routes) ---------------------------------------

  async getDashboard() {
    return this.request('GET', ROUTES.dashboard());
  }

  async getAccount(accountId) {
    return this.request('GET', ROUTES.account(accountId));
  }

  /** Create a ChatNow account (dashboard "add account" form payload). */
  async createAccount(payload) {
    return this.request('POST', ROUTES.accounts(), { body: payload });
  }

  async updateAccount(accountId, payload) {
    return this.request('POST', ROUTES.account(accountId), { body: payload });
  }

  async deleteAccount(accountId) {
    return this.request('DELETE', ROUTES.account(accountId));
  }

  async exportAccountSession(accountId) {
    return this.request('POST', ROUTES.accountSessionExport(accountId));
  }

  async getAccountConversations(accountId) {
    return this.request('GET', ROUTES.accountConversations(accountId));
  }

  async listMailboxes() {
    return this.request('GET', ROUTES.mailboxes());
  }

  /** Import "email:password" lines. */
  async importMailboxes(text) {
    return this.request('POST', ROUTES.mailboxesImport(), { body: { text } });
  }

  async deleteMailbox(mailboxId) {
    return this.request('DELETE', ROUTES.mailbox(mailboxId));
  }

  async listAdspowerProxies() {
    return this.request('GET', ROUTES.adspowerProxies());
  }

  async getBlockedMessages() {
    return this.request('GET', ROUTES.blockedMessages());
  }

  async clearBlockedMessages() {
    return this.request('POST', ROUTES.blockedMessagesClear());
  }

  async snapRdps() {
    return this.request('GET', ROUTES.snapRdps());
  }

  async snapStatus() {
    return this.request('GET', ROUTES.snapStatus());
  }

  async snapFleetHealth() {
    return this.request('GET', ROUTES.snapFleetHealth());
  }

  async snapCreate(firstName, count = 1) {
    return this.request('POST', ROUTES.snapCreate(), { body: { firstName, count } });
  }

  async snapCreateStatus() {
    return this.request('GET', ROUTES.snapCreateStatus());
  }

  async snapPlace(provision = false) {
    return this.request('POST', ROUTES.snapPlace(), { body: { provision } });
  }

  async snapUnplace(usernames) {
    return this.request('POST', ROUTES.snapUnplace(), { body: { usernames: [].concat(usernames) } });
  }
}

/* ------------------------------------------------------------------ */
/* Assistant client — bbk_… key, what the chat bots should actually    */
/* use for generation.                                                 */
/* ------------------------------------------------------------------ */

class BambouAssistant extends BambouHttp {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey  "bbk_…" (Settings → API Keys; shown once at creation)
   */
  constructor({ apiKey, ...opts } = {}) {
    super(opts);
    if (!apiKey) throw new Error('BambouAssistant: apiKey (bbk_…) is required');
    this.apiKey = apiKey;
  }

  authHeaders() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }

  async listPresets() {
    return this.request('GET', ROUTES.assistantPresets());
  }

  /**
   * Stateless generation: send the FULL history each call (≤ 40 messages,
   * ≤ 2000 chars each, ≤ 30 000 total, last message role "user").
   * @param {object} opts {presetId:"…", messages:[{role:"user"|"assistant", content:"…"}]}
   */
  async generate({ presetId, messages }) {
    return this.request('POST', ROUTES.assistantGenerate(), {
      body: { presetId: String(presetId), messages },
    });
  }
}

/* ------------------------------------------------------------------ */
/* Extension client — X-Bambou-Extension-Key                           */
/* ------------------------------------------------------------------ */

class BambouExtension extends BambouHttp {
  constructor({ extensionKey, ...opts } = {}) {
    super(opts);
    if (!extensionKey) throw new Error('BambouExtension: extensionKey is required');
    this.extensionKey = extensionKey;
  }

  authHeaders() {
    return { 'X-Bambou-Extension-Key': this.extensionKey };
  }

  async getConfig() {
    return this.request('GET', ROUTES.extensionConfig());
  }

  async generate({ presetId, messages }) {
    // Note: presetId MUST be a JSON string ("1048", not 1048) or the server answers
    // "Preset inconnu." with HTTP 500.
    return this.request('POST', ROUTES.extensionGenerate(), {
      body: { presetId: String(presetId), messages },
    });
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  ROUTES,
  PLATFORMS,
  SECTIONS,
  SECTION_MODULES,
  BambouError,
  BambouStudio,
  BambouAssistant,
  BambouExtension,
  setAtPath,
  valueAtPath,
  deepMerge,
};
