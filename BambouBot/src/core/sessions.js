'use strict';

const crypto = require('node:crypto');

/**
 * TTL registry for multi-step forms and confirmations (both platforms).
 * Tokens are random hex; they go into Discord custom ids / Telegram callback data.
 */
class SessionStore {
  constructor({ ttlMs = 10 * 60_000, now = Date.now, tokenBytes = 6 } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.tokenBytes = tokenBytes;
    this.map = new Map();
  }

  create(data) {
    this.prune();
    const token = crypto.randomBytes(this.tokenBytes).toString('hex');
    const state = { ...data, token, createdAt: this.now() };
    this.map.set(token, state);
    return state;
  }

  /** Live (non-expired) state or undefined. */
  get(token) {
    const state = this.map.get(token);
    if (!state) return undefined;
    if (this.expired(state)) {
      this.map.delete(token);
      return undefined;
    }
    return state;
  }

  /** Raw lookup that also returns expired states (callers that report "expired" explicitly). */
  peek(token) {
    return this.map.get(token);
  }

  expired(state) {
    return this.now() - state.createdAt >= this.ttlMs;
  }

  delete(token) {
    return this.map.delete(token);
  }

  values() {
    return this.map.values();
  }

  /** Drop expired states; `onExpire` lets callers release related indexes. */
  prune(onExpire) {
    for (const state of [...this.map.values()]) {
      if (this.expired(state)) {
        this.map.delete(state.token);
        if (onExpire) onExpire(state);
      }
    }
  }
}

module.exports = { SessionStore };
