'use strict';
/**
 * Bambou Hub SDK for Node.js automation scripts (Node 18+, no dependencies).
 *
 *   const { hub } = require('bambouhub');
 *   const w = hub.worker('worker-1');          // thread, worker_thread, page, process…
 *   w.running();  w.idle('no partner');  w.log.info('connected');
 *   hub.addCost(0.0008, { provider: 'capsolver', category: 'captcha' });
 *   hub.setPrice('capsolver', 0.0008, { unit: 'solve' }); hub.addCost(null, { provider: 'capsolver' });
 *   hub.count('links_sent');  hub.gauge('queue', 12);  hub.timing('chat_seconds', 31.2);
 *   hub.balance('capsolver', 3.12, { low: 5 });
 *   hub.proxy('proxy-1', 'blocked', { url: 'http://u:p@1.2.3.4:8080', detail: '403' });
 *   hub.issue('Login loop', 'worker-2 relogged 5 times', { severity: 'warning' });
 *   hub.onCommand('refresh_cookies', async (args) => '...');
 *   hub.onConfigChange((path) => reload(path));
 *   await hub.waitIfPaused();
 *
 * In a worker_thread, require the SDK there too: it forwards to the main thread
 * automatically (parentPort), so only one socket to the agent is used.
 */

const crypto = require('crypto');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');

let threads = null;
try { threads = require('worker_threads'); } catch { threads = null; }

const SDK = 'node/2.0.0';
const NAMESPACE = '7d6f2a62-8f3c-4d8e-9a43-3b9c1e0b5a10';
const LEVELS = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical']);
const STATUSES = new Set(['starting', 'running', 'idle', 'error', 'stopped']);
const PROXY_STATES = new Set(['ok', 'slow', 'blocked', 'auth', 'timeout', 'unknown']);
const MAX_QUEUE = 20000;

const now = () => new Date().toISOString();

function uuid5(name, namespace = NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name)])).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same key the hub computes for proxies in proxies.txt (scheme|host|port|username). */
function proxyKey(url) {
  let scheme = 'http', host = '', port = 0, user = '';
  if (url.includes('://') || url.includes('@')) {
    // Parse by hand: WHATWG URL drops "default" ports (http :80), the hub keeps them.
    const match = /^(?:([a-z0-9+.-]+):\/\/)?(?:([^:@/]*)(?::[^@/]*)?@)?(\[[^\]]+\]|[^:/]+)(?::(\d+))?/i.exec(url);
    if (match) {
      scheme = (match[1] || 'http').toLowerCase();
      user = decodeURIComponent(match[2] || '');
      host = match[3].replace(/^\[|\]$/g, '');
      port = Number(match[4]) || 0;
    }
  } else {
    const pieces = url.split(':');
    host = pieces[0]; port = Number(pieces[1]) || 0; user = pieces[2] || '';
  }
  return crypto.createHash('sha256').update(`${scheme}|${host.toLowerCase()}|${port}|${user}`).digest('hex').slice(0, 16);
}

function jsonable(value, depth = 0) {
  if (depth > 4) return String(value).slice(0, 200);
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => jsonable(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) out[String(k).slice(0, 100)] = jsonable(v, depth + 1);
    return out;
  }
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return String(value).slice(0, 2000);
}

class Worker {
  constructor(hub, name) {
    this.hub = hub;
    this.name = name;
    this.id = uuid5(`${hub.siteKey}:${name}`);
    this._status = 'starting';
    this.detail = {};
    this.tasksCompleted = 0;
    const emit = (level) => (message, context) => hub.log(level, message, { worker: this, context });
    this.log = { debug: emit('debug'), info: emit('info'), warning: emit('warning'), warn: emit('warning'),
      error: emit('error'), critical: emit('critical') };
  }

  status(status, reason, detail = {}) {
    if (!STATUSES.has(status)) throw new Error('status must be starting, running, idle, error or stopped');
    this._status = status;
    this.detail = { ...detail, ...(reason ? { reason } : {}) };
  }

  running(detail) { this.status('running', undefined, detail); }
  idle(reason, detail) { this.status('idle', reason, detail); }
  error(reason, detail) { this.status('error', reason, detail); }
  stopped() { this.status('stopped'); }
  taskDone(count = 1) { this.tasksCompleted += count; }

  snapshot() {
    return { id: this.id, name: this.name, status: this._status, detail: this.detail,
      tasks_completed: this.tasksCompleted, pid: process.pid };
  }
}

class Hub extends EventEmitter {
  constructor() {
    super();
    this.siteKey = process.env.HUB_SITE_ID || process.env.HUB_SITE || 'local';
    this.workers = new Map();
    this.queues = { logs: [], metrics: [], proxies: [], issues: [], acks: [] };
    this.balances = new Map();
    this.costs = { pending: new Map(), individual: [], prices: new Map(), totals: new Map() };
    this.handlers = new Map();
    this.configCallbacks = [];
    this.paused = false;
    this.stopping = false;
    this.desiredWorkers = null;
    this.dropped = 0;
    this.flushInterval = 2000;
    this._started = false;
    this._socket = null;
    this._buffer = '';
    this._timer = null;
    this._isThread = Boolean(threads && !threads.isMainThread && threads.parentPort);
  }

  // -- setup -------------------------------------------------------------
  configure({ socketPath, hubUrl, token, flushInterval, site } = {}) {
    if (site) this.siteKey = site;
    if (flushInterval) this.flushInterval = Math.max(500, flushInterval);
    this.socketPath = socketPath || process.env.HUB_AGENT_SOCKET || null;
    this.hubUrl = (hubUrl || process.env.HUB_URL || '').replace(/\/$/, '');
    this.token = token || process.env.HUB_AGENT_TOKEN || '';
    this._start();
    return this;
  }

  _ensure() { if (!this._started) this.configure(); }

  _start() {
    if (this._started) return;
    this._started = true;
    if (this._isThread) {
      // Worker thread: relay batches to the main thread's SDK instance.
      threads.parentPort.on('message', (msg) => {
        if (msg && msg.__bambouhub) this._dispatch(msg.__bambouhub);
      });
    }
    this._timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushInterval);
    this._timer.unref?.();
    process.once('beforeExit', () => { this.flush().catch(() => {}); });
  }

  /** Attach a worker_thread so its SDK batches reach the agent and commands reach it. */
  attachThread(worker) {
    this._ensure();
    worker.on('message', (msg) => {
      if (msg && msg.__bambouhub_batch) this._mergeBatch(msg.__bambouhub_batch, worker);
    });
    this._threads = this._threads || new Set();
    this._threads.add(worker);
    worker.once('exit', () => {
      this._threads.delete(worker);
      for (const id of worker.__bambouWorkers || []) {
        const w = [...this.workers.values()].find((x) => x.id === id);
        if (w) w._status = 'stopped';
      }
    });
    return worker;
  }

  async close() {
    for (const w of this.workers.values()) if (!['stopped', 'error'].includes(w._status)) w._status = 'stopped';
    await this.flush().catch(() => {});
    if (this._timer) clearInterval(this._timer);
    if (this._socket) this._socket.end();
  }

  // -- workers -----------------------------------------------------------
  worker(name) {
    this._ensure();
    if (!this.workers.has(name)) this.workers.set(name, new Worker(this, name));
    return this.workers.get(name);
  }

  removeWorker(name) {
    const w = this.workers.get(name);
    if (w) { w._status = 'stopped'; this._removed = [...(this._removed || []), w.snapshot()]; this.workers.delete(name); }
  }

  // -- logs --------------------------------------------------------------
  log(level, message, { worker, context, error, source = '' } = {}) {
    this._ensure();
    level = LEVELS.has(String(level).toLowerCase()) ? String(level).toLowerCase() : 'info';
    const entry = { ts: now(), level, message: String(message).slice(0, 8000), source };
    if (worker) { entry.worker_id = worker.id; entry.worker_name = worker.name; }
    if (context) entry.context = jsonable(context);
    if (error) entry.exception = String(error && error.stack ? error.stack : error).slice(-16000);
    this._push('logs', entry);
  }

  debug(m, o) { this.log('debug', m, o); }
  info(m, o) { this.log('info', m, o); }
  warning(m, o) { this.log('warning', m, o); }
  error(m, o) { this.log('error', m, o); }
  critical(m, o) { this.log('critical', m, o); }

  /** Mirror console.warn/error (and optionally log/info) to the hub. */
  captureConsole({ includeInfo = false } = {}) {
    const wrap = (method, level) => {
      const original = console[method].bind(console);
      console[method] = (...args) => {
        original(...args);
        try { this.log(level, args.map((a) => (typeof a === 'string' ? a : (a && a.stack) || JSON.stringify(a))).join(' '), { source: 'console' }); } catch { /* ignore */ }
      };
    };
    wrap('warn', 'warning');
    wrap('error', 'error');
    if (includeInfo) { wrap('log', 'info'); wrap('info', 'info'); }
  }

  // -- metrics -----------------------------------------------------------
  metric(name, value = 1, { kind = 'count', worker, labels = {} } = {}) {
    this._ensure();
    if (!['count', 'gauge', 'duration'].includes(kind)) throw new Error('kind must be count, gauge or duration');
    this._push('metrics', { ts: now(), name, kind, value: Number(value), worker_id: worker ? worker.id : null, labels: jsonable(labels) });
  }

  count(name, value = 1, opts = {}) { this.metric(name, value, { ...opts, kind: 'count' }); }
  gauge(name, value, opts = {}) { this.metric(name, value, { ...opts, kind: 'gauge' }); }
  timing(name, seconds, opts = {}) { this.metric(name, seconds, { ...opts, kind: 'duration' }); }

  // -- costs -------------------------------------------------------------
  setPrice(provider, amount, { currency = 'USD', unit = null } = {}) {
    this.costs.prices.set(provider, { amount: Number(amount), currency: currency.toUpperCase(), unit });
  }

  /**
   * Record spending wherever it happens: addCost(0.002, {provider:'openai', category:'ai'}).
   * Pass amount=null to use setPrice(). Entries are summed locally and sent every
   * few seconds; {breakdown:true} or meta sends the entry individually.
   */
  addCost(amount, { provider = 'other', category = 'other', quantity = 1, unit = null, currency = 'USD',
    worker = null, meta = null, breakdown = false } = {}) {
    this._ensure();
    if (amount === null || amount === undefined) {
      const price = this.costs.prices.get(provider);
      if (!price) throw new Error(`No amount given and no price set for ${provider}; call hub.setPrice() first`);
      amount = price.amount * quantity;
      currency = price.currency;
      unit = unit || price.unit;
    }
    amount = Number(amount);
    if (!(amount >= 0) || !Number.isFinite(amount)) throw new Error('Cost amount must be a non-negative number');
    currency = String(currency || 'USD').toUpperCase().slice(0, 3);
    const totalKey = `${provider}|${currency}`;
    this.costs.totals.set(totalKey, (this.costs.totals.get(totalKey) || 0) + amount);
    const workerId = worker ? worker.id : null;
    if (breakdown || meta) {
      this.costs.individual.push({ event_id: crypto.randomUUID(), ts: now(), provider, category, amount: +amount.toFixed(6),
        currency, quantity, unit, worker_id: workerId, meta: jsonable(meta || {}) });
      return;
    }
    const key = JSON.stringify([provider, category, currency, unit, workerId]);
    const entry = this.costs.pending.get(key) || { amount: 0, quantity: 0, count: 0 };
    entry.amount += amount; entry.quantity += quantity; entry.count += 1;
    this.costs.pending.set(key, entry);
  }

  /** Running totals since start: { USD: { capsolver: 1.23 } }. */
  costSummary() {
    const out = {};
    for (const [key, total] of this.costs.totals) {
      const [provider, currency] = key.split('|');
      (out[currency] = out[currency] || {})[provider] = +total.toFixed(6);
    }
    return out;
  }

  balance(provider, amount, { currency = 'USD', low = null, label = '' } = {}) {
    this._ensure();
    this.balances.set(`${provider}|${label}`, { provider, label, balance: Number(amount), currency: currency.toUpperCase(), low_threshold: low });
  }

  // -- proxies / issues ----------------------------------------------------
  proxy(label, state, { key, url, detail = '' } = {}) {
    this._ensure();
    if (!PROXY_STATES.has(state)) throw new Error('Unknown proxy state');
    this._push('proxies', { ts: now(), key: key || (url ? proxyKey(url) : label), label, state, detail: String(detail).slice(0, 500) });
  }

  issue(title, detail = '', { severity = 'warning', key, worker, data = {} } = {}) {
    this._ensure();
    this._push('issues', { title, detail, severity, key: key || `${this.siteKey}:${worker ? worker.name : 'script'}:${title}`,
      worker_id: worker ? worker.id : null, data: jsonable(data) });
    this.flush().catch(() => {});
  }

  // -- commands --------------------------------------------------------------
  onCommand(name, handler, { description = '', args = {} } = {}) {
    this._ensure();
    this.handlers.set(name, { handler, description, args });
    return this;
  }

  onConfigChange(callback) { this._ensure(); this.configCallbacks.push(callback); return this; }

  async waitIfPaused(pollMs = 1000) {
    while (this.paused && !this.stopping) await new Promise((r) => setTimeout(r, pollMs));
  }

  async _handleCommand(message) {
    const action = message.action || '';
    const id = message.command_id;
    const name = action.startsWith('custom:') ? action.slice(7) : action;
    const args = message.args || {};
    if (name === 'pause') this.paused = true;
    if (name === 'resume') this.paused = false;
    if (name === 'set_workers' && Number.isInteger(args.count)) this.desiredWorkers = args.count;
    if (name === 'stop') this.stopping = true;
    this.emit('command', { name, args });
    if (name === 'pause' || name === 'resume') this.emit(name);
    if (name === 'set_workers') this.emit('set_workers', args.count);
    const entry = this.handlers.get(name);
    if (!entry || !entry.handler) {
      if (entry && entry.remote) return; // handled inside a worker_thread, which acks itself
      // Built-ins update hub.paused / hub.desiredWorkers / hub.stopping for the script to read.
      if (['pause', 'resume', 'stop', 'set_workers'].includes(name)) return this._ack(id, 'completed', `${name} applied`);
      return this._ack(id, 'failed', `Script has no handler for '${name}'`);
    }
    try {
      const result = await entry.handler(args);
      this._ack(id, 'completed', result === undefined || result === null ? '' : String(result).slice(0, 2000));
    } catch (error) {
      this.log('error', `Command ${name} failed: ${error.message}`, { error });
      this._ack(id, 'failed', String(error.message || error).slice(0, 2000));
    }
  }

  _ack(commandId, status, message = '') {
    if (commandId) { this._push('acks', { command_id: commandId, status, message }); this.flush().catch(() => {}); }
  }

  _dispatch(message) {
    if (message.type === 'command') this._handleCommand(message);
    else if (message.type === 'files_changed') {
      for (const path of message.paths || []) for (const cb of this.configCallbacks) {
        try { cb(path); } catch (error) { this.log('error', `Config callback failed for ${path}`, { error }); }
      }
    } else if (message.type === 'state') {
      this.paused = Boolean(message.paused);
      if (Number.isInteger(message.desired_workers)) this.desiredWorkers = message.desired_workers;
    }
    if (this._threads) for (const t of this._threads) t.postMessage({ __bambouhub: message });
  }

  // -- transport -------------------------------------------------------------
  _push(queue, item) {
    const q = this.queues[queue];
    if (q.length >= MAX_QUEUE) { q.shift(); this.dropped += 1; }
    q.push(item);
  }

  _mergeBatch(batch, thread) {
    for (const key of Object.keys(this.queues)) for (const item of batch[key] || []) this._push(key, item);
    for (const c of batch.costs || []) this.costs.individual.push(c);
    for (const b of batch.balances || []) this.balances.set(`${b.provider}|${b.label}`, b);
    const presence = batch.presence || {};
    thread.__bambouWorkers = (presence.workers || []).map((w) => w.id);
    this._threadWorkers = this._threadWorkers || new Map();
    this._threadWorkers.set(thread, presence.workers || []);
    for (const cmd of presence.capabilities?.commands || []) {
      if (!this.handlers.has(cmd.name)) this.handlers.set(cmd.name, { handler: null, description: cmd.description, args: cmd.args, remote: true });
    }
  }

  _drain() {
    const take = (q, n = 5000) => q.splice(0, n);
    const costs = this.costs.individual.splice(0);
    for (const [key, entry] of this.costs.pending) {
      const [provider, category, currency, unit, workerId] = JSON.parse(key);
      costs.push({ event_id: crypto.randomUUID(), ts: now(), provider, category, amount: +entry.amount.toFixed(6), currency,
        quantity: entry.quantity, unit, worker_id: workerId, meta: { aggregated: entry.count } });
    }
    this.costs.pending.clear();
    const balances = [...this.balances.values()];
    this.balances.clear();
    let workers = [...this.workers.values()].map((w) => w.snapshot());
    if (this._removed) { workers = workers.concat(this._removed); this._removed = null; }
    if (this._threadWorkers) for (const list of this._threadWorkers.values()) workers = workers.concat(list);
    const commands = [...this.handlers.entries()].map(([name, h]) => ({ name, description: h.description, args: h.args }));
    return { logs: take(this.queues.logs), metrics: take(this.queues.metrics), costs, balances,
      proxies: take(this.queues.proxies), issues: take(this.queues.issues, 200), acks: take(this.queues.acks, 200),
      presence: { workers, capabilities: { sdk: SDK, commands }, paused: this.paused, dropped: this.dropped } };
  }

  _requeue(batch) {
    for (const key of Object.keys(this.queues)) this.queues[key].unshift(...(batch[key] || []));
    this.costs.individual.unshift(...(batch.costs || []));
    for (const b of batch.balances || []) if (!this.balances.has(`${b.provider}|${b.label}`)) this.balances.set(`${b.provider}|${b.label}`, b);
  }

  async flush() {
    this._ensure();
    if (this._flushing) return false;
    this._flushing = true;
    const batch = this._drain();
    try {
      if (this._isThread) {
        threads.parentPort.postMessage({ __bambouhub_batch: batch });
      } else if (this.socketPath) {
        await this._sendSocket(batch);
      } else if (this.hubUrl && this.token) {
        await this._sendHttp(batch);
      }
      return true;
    } catch (error) {
      this._requeue(batch);
      return false;
    } finally {
      this._flushing = false;
    }
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      sock.once('error', reject);
      sock.once('connect', () => {
        sock.removeListener('error', reject);
        sock.on('error', () => { if (this._socket === sock) this._socket = null; });
        sock.on('close', () => { if (this._socket === sock) this._socket = null; });
        sock.on('data', (chunk) => {
          this._buffer += chunk.toString('utf8');
          let index;
          while ((index = this._buffer.indexOf('\n')) >= 0) {
            const line = this._buffer.slice(0, index);
            this._buffer = this._buffer.slice(index + 1);
            if (line.trim()) { try { this._dispatch(JSON.parse(line)); } catch { /* ignore */ } }
          }
        });
        sock.unref?.();
        sock.write(`${JSON.stringify({ type: 'hello', pid: process.pid, sdk: SDK, host: os.hostname() })}\n`);
        this._socket = sock;
        resolve(sock);
      });
    });
  }

  async _sendSocket(batch) {
    const sock = this._socket || await this._connect();
    await new Promise((resolve, reject) => sock.write(`${JSON.stringify({ type: 'batch', ...batch })}\n`, (e) => (e ? reject(e) : resolve())));
  }

  async _sendHttp(batch) {
    const headers = { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json', 'User-Agent': SDK };
    const response = await fetch(`${this.hubUrl}/api/agent/v2/batch`, { method: 'POST', headers, body: JSON.stringify(batch) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const reply = await response.json();
    if (reply.desired_state === 'paused') this.paused = true;
    else if (reply.desired_state === 'running') this.paused = false;
    if (!this._lastPoll || Date.now() - this._lastPoll > 5000) {
      this._lastPoll = Date.now();
      const commands = await (await fetch(`${this.hubUrl}/api/agent/v2/commands`, { headers })).json();
      for (const command of commands || []) {
        if (['start', 'restart'].includes(command.action)) { this._ack(command.command_id, 'failed', 'Direct mode: run under bambou-agent for start/restart'); continue; }
        this._handleCommand(command);
      }
    }
  }
}

const hub = new Hub();
module.exports = { hub, Hub, Worker, proxyKey, uuid5, SDK };
