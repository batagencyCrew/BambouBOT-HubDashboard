// Opt-in payloads. Callers own real measurements and stable event IDs.
const codes = new Set(['proxy_blocked', 'proxy_auth', 'proxy_timeout', 'proxy_recovered', 'other']);
function uuid(value) {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) throw new TypeError('Invalid telemetry UUID');
  return value;
}
function label(value) {
  if (typeof value !== 'string' || !/^[a-z0-9_.-]{1,80}$/i.test(value) || /[\r\n]/.test(value) || /bbk_|sk_|sk-|bearer/i.test(value)) throw new TypeError('Telemetry label must be a nonsecret alias');
  return value;
}
function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid telemetry count');
  return value;
}
function measurement(value, maximum = Infinity) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > maximum) throw new TypeError('Invalid telemetry measurement');
  return value;
}
export function reportChat(api, event) {
  if (typeof event.converted !== 'boolean' || (event.random != null && typeof event.random !== 'boolean')) throw new TypeError('Invalid telemetry boolean');
  const payload = { event_id: uuid(event.event_id), worker_id: uuid(event.worker_id), msgs_in: count(event.msgs_in), msgs_out: count(event.msgs_out), links: count(event.links), converted: event.converted, duration: measurement(event.duration, 604800) };
  if (event.proxy_id != null) payload.proxy_id = uuid(event.proxy_id);
  if (event.room != null) {
    if (typeof event.room !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(event.room) || /[\r\n]/.test(event.room)) throw new TypeError('Invalid room pseudonym');
    payload.room = event.room;
  }
  if (event.random != null) payload.random = event.random;
  return api.post('/chats', payload);
}
export function reportAIUsage(api, event) {
  count(event.calls); count(event.error_429); count(event.error_502); measurement(event.latency_ms);
  if (event.error_429 + event.error_502 > event.calls || (event.calls === 0 && event.latency_ms !== 0)) throw new TypeError('Invalid AI batch totals');
  return api.post('/ai-usage', { event_id: uuid(event.event_id), key_id: label(event.key_id), calls: count(event.calls), error_429: count(event.error_429), error_502: count(event.error_502), latency_ms: measurement(event.latency_ms) });
}
export function reportProxyError(api, event) {
  if (!codes.has(event.code)) throw new TypeError('Invalid proxy error code');
  const payload = { worker_id: uuid(event.worker_id), level: 'error', message: 'Proxy status event', code: event.code };
  if (event.proxy_id != null) payload.proxy_id = uuid(event.proxy_id);
  return api.post('/errors', payload);
}
