'use strict';

/**
 * Short-lived cache of the studio config document, shared by both platforms.
 * A version counter prevents a read that was in flight during invalidate()
 * from putting a stale document back into the cache.
 */
class ConfigCache {
  constructor(studio, { ttlMs = 15_000, now = Date.now } = {}) {
    this.studio = studio;
    this.ttlMs = ttlMs;
    this.now = now;
    this.state = { config: null, at: 0, version: 0 };
  }

  async get(force = false) {
    const { config, at, version } = this.state;
    if (!force && config && this.now() - at < this.ttlMs) return config;
    const fresh = await this.studio.getConfig();
    if (version === this.state.version) this.state = { config: fresh, at: this.now(), version };
    return fresh;
  }

  invalidate() {
    this.state = { config: null, at: 0, version: this.state.version + 1 };
  }
}

module.exports = { ConfigCache };
