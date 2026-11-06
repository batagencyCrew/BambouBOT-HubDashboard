'use strict';

/**
 * Bambou Hub HTTP client (plain fetch, no dependency).
 *
 * The bot authenticates with its service token (hbt_…). When it acts for a chat
 * user it adds `X-Bot-User: <platform>:<platformUserId>`; the hub then applies
 * exactly the linked hub user's permissions. The token itself grants nothing on
 * /api/* except the identity, link and delivery routes under /api/bot.
 *
 * Errors are mapped to HubError with a stable `code`:
 *   unlinked (401) · forbidden (403, `permission` set) · not_found (404) ·
 *   conflict (409) · rate_limited (429, `retryAfter`) · invalid (400/422) ·
 *   unavailable (network, timeout, 5xx).
 * Only GETs are retried (network/5xx), mutations are sent exactly once.
 * The token is never part of a message, a log line or an error.
 */

const { setTimeout: delay } = require('node:timers/promises');
const { redact } = require('../core/errors');

const CODES = { 400: 'invalid', 401: 'unlinked', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 422: 'invalid', 429: 'rate_limited' };

class HubError extends Error {
  constructor(message, { status = 0, code = 'unavailable', permission = null, retryAfter = 0, detail = '' } = {}) {
    super(message);
    this.name = 'HubError';
    this.status = status;
    this.code = code;
    this.permission = permission;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

/** FastAPI `detail` may be a string or a validation list. */
function detailText(payload) {
  const detail = payload?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => `${(item.loc || []).filter((part) => part !== 'body').join('.') || 'value'}: ${item.msg || 'invalid'}`).join('; ');
  }
  return '';
}

function messageFor(status, code, detail, permission) {
  if (code === 'unlinked') return 'Your chat account is not linked to a hub user.';
  if (code === 'forbidden') return permission ? `Your hub account lacks the ${permission} permission.` : `Hub refused: ${detail || 'permission denied'}.`;
  if (code === 'not_found') return detail ? `Hub: ${detail}.` : 'Not found on the hub.';
  if (code === 'conflict') return `Hub conflict: ${detail || 'the item changed meanwhile'} — reload and retry.`;
  if (code === 'rate_limited') return 'The hub is rate limiting requests — try again shortly.';
  if (code === 'invalid') return `Hub rejected the request: ${detail || 'invalid input'}.`;
  return `Hub error ${status}${detail ? `: ${detail}` : ''}.`;
}

class HubClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl     HUB_URL
   * @param {string} opts.token       HUB_BOT_TOKEN (hbt_…)
   * @param {Function} [opts.fetchImpl]
   */
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, timeoutMs = 15_000, maxRetries = 1, sleepImpl = (ms) => delay(ms) } = {}) {
    if (!baseUrl) throw new Error('HubClient requires a base URL.');
    if (!token) throw new Error('HubClient requires a bot service token.');
    if (typeof fetchImpl !== 'function') throw new Error('HubClient needs Node 18+ (global fetch).');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    // Kept off enumerable properties so util.inspect/JSON never shows it.
    Object.defineProperty(this, 'token', { value: token, enumerable: false });
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.sleepImpl = sleepImpl;
  }

  /** Build `/api/...` with query parameters; null/undefined/'' are dropped. */
  static path(base, query = {}) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${base}${base.includes('?') ? '&' : '?'}${qs}` : base;
  }

  /**
   * @param {string} method
   * @param {string} path        starting with /api/
   * @param {object} [opts]
   * @param {{platform:string,id:string}|string} [opts.asUser]  chat user to act for
   * @param {object} [opts.body]
   */
  async request(method, path, { asUser, body, signal } = {}) {
    const verb = String(method).toUpperCase();
    if (!String(path).startsWith('/api/')) throw new Error('Hub paths must start with /api/.');
    const headers = { Authorization: `Bearer ${this.token}`, Accept: 'application/json' };
    if (asUser) headers['X-Bot-User'] = typeof asUser === 'string' ? asUser : `${asUser.platform}:${asUser.id}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const retries = verb === 'GET' ? this.maxRetries : 0;
    for (let attempt = 0; ; attempt += 1) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error(`timeout after ${this.timeoutMs} ms`)), this.timeoutMs);
      let failure;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: verb, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
        });
        const raw = await response.text();
        let payload = null;
        if (raw) {
          try { payload = JSON.parse(raw); } catch { payload = null; }
        }
        if (response.ok) {
          if (raw && payload === null) throw new HubError('The hub returned an invalid JSON response.', { status: response.status });
          return payload;
        }
        const detail = redact(detailText(payload), [this.token]).slice(0, 300);
        const code = CODES[response.status] || 'unavailable';
        const permission = response.status === 403 ? (/permission:\s*([a-z_]+:[a-z_]+)/i.exec(detail)?.[1] || null) : null;
        const retryAfter = Number(response.headers?.get?.('retry-after')) || 0;
        failure = new HubError(messageFor(response.status, code, detail, permission), { status: response.status, code, permission, retryAfter, detail });
      } catch (error) {
        if (error instanceof HubError) failure = error;
        else {
          const reason = controller.signal.aborted ? controller.signal.reason?.message || 'aborted' : error.message;
          failure = new HubError(redact(`Hub unreachable: ${reason}`, [this.token]), { code: 'unavailable' });
        }
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      const transient = failure.code === 'unavailable' && (failure.status === 0 || failure.status >= 500);
      if (transient && attempt < retries && !signal?.aborted) {
        await this.sleepImpl(500 * 2 ** attempt);
        continue;
      }
      throw failure;
    }
  }

  get(path, opts) { return this.request('GET', path, opts); }
  post(path, body, opts = {}) { return this.request('POST', path, { ...opts, body: body ?? {} }); }
  patch(path, body, opts = {}) { return this.request('PATCH', path, { ...opts, body }); }
}

module.exports = { HubClient, HubError };
