export class HttpError extends Error {
  constructor(status) { super(`Hub HTTP ${status}`); this.status = status; }
}
export function origin(value) {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) throw new Error('HUB_URL must be an HTTPS origin (loopback HTTP allowed)');
  return url.origin;
}
export class API {
  constructor(url, token, timeout = 20_000) {
    this.url = origin(url);
    if (!token || /[\r\n]/.test(token)) throw new Error('HUB_AGENT_TOKEN is required');
    this.token = token; this.timeout = timeout;
  }
  async request(endpoint, { method = 'GET', json, body, signal, timeout = this.timeout, headers = {} } = {}) {
    const response = await fetch(this.url + '/api/agent' + endpoint, {
      method, redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
      headers: { ...headers, Authorization: `Bearer ${this.token}`, ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : body, ...(body ? { duplex: 'half' } : {}),
    });
    if (!response.ok) { await response.body?.cancel(); throw new HttpError(response.status); }
    return response.json();
  }
  post(endpoint, json) { return this.request(endpoint, { method: 'POST', json }); }
  reportStatistics(linksSentSuccessfully, averageMessagesPerChat) {
    if (!Number.isSafeInteger(linksSentSuccessfully) || linksSentSuccessfully < 0) {
      throw new TypeError('links_sent_successfully must be a nonnegative safe integer');
    }
    if (averageMessagesPerChat !== null &&
        (typeof averageMessagesPerChat !== 'number' || !Number.isFinite(averageMessagesPerChat) ||
         averageMessagesPerChat < 0 || averageMessagesPerChat > 1_000_000_000)) {
      throw new TypeError('average_messages_per_chat must be null or finite in [0, 1000000000]');
    }
    return this.post('/statistics', {
      links_sent_successfully: linksSentSuccessfully,
      average_messages_per_chat: averageMessagesPerChat,
    });
  }
}
// Never log raw exceptions, response bodies, worker messages, URLs, paths or keys.
export const safeError = error => error instanceof HttpError ? `Hub HTTP ${error.status}` : 'Local operation failed';
