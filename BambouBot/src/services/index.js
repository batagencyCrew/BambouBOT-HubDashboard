'use strict';

const { ConfigCache } = require('../core/cache');
const { PresetService } = require('./presets');
const { KeyService } = require('./keys');
const { GmsOperations } = require('./gms');

/**
 * Build the shared service layer. One instance serves every platform, so both
 * bots share one studio session, one config cache and one GetMySocial client.
 *
 * @param {object} opts
 * @param {object} opts.studio        BambouStudio (or a compatible mock)
 * @param {Function} opts.getGmsService  () => GmsService-like (lazy)
 * @param {Function} [opts.now]
 */
function createServices({ studio, getGmsService, now = Date.now, cacheTtlMs = 15_000 }) {
  const cache = new ConfigCache(studio, { ttlMs: cacheTtlMs, now });
  return {
    studio,
    cache,
    presets: new PresetService({ studio, cache }),
    keys: new KeyService({ studio, cache }),
    gms: new GmsOperations({ getService: getGmsService }),
  };
}

module.exports = { createServices };
