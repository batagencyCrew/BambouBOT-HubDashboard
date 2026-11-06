'use strict';

/**
 * GetMySocial operations shared by Discord and Telegram. The underlying
 * GmsService is created lazily, so the bots start fine without GMS_COOKIE
 * and only /gms reports the missing configuration.
 */

const { GmsService, PERIODS } = require('../vendor/getmysocial/service');
const { ValidationError } = require('../core/errors');
const { GMS_FIELDS, validateBasic } = require('../core/fields');

/** The fixed destination profiles: every new direct link points at one of these. */
const PROFILES = Object.freeze({
  lina: Object.freeze({ label: 'Lina', url: 'https://mym.fans/app/subscription/Lollylina/step1' }),
  louise: Object.freeze({ label: 'Louise', url: 'https://mym.fans/app/subscription/Loucherry/step1' }),
  mia: Object.freeze({ label: 'Mia', url: 'https://mym.fans/app/subscription/Foxsymia/step1' }),
});

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function profileValue(raw) {
  const profile = String(raw || '').trim().toLowerCase();
  if (!own(PROFILES, profile)) throw new ValidationError(`Choose a destination profile: ${Object.keys(PROFILES).join(', ')}.`);
  return profile;
}

function periodValue(raw = 'week') {
  const period = String(raw || 'week').trim().toLowerCase();
  if (!own(PERIODS, period)) throw new ValidationError(`Period must be one of: ${Object.keys(PERIODS).join(', ')}.`);
  return period;
}

const linkId = (link) => String(link._id || link.id || link.originalLink);

/** Lazily-constructed singleton around the vendored GmsService. */
function lazyGmsService(options) {
  let instance = null;
  return () => {
    if (!instance) instance = new GmsService(options);
    return instance;
  };
}

class GmsOperations {
  /** @param {object} opts { getService: () => GmsService-like } */
  constructor({ getService }) {
    this.getService = getService;
    this.fields = GMS_FIELDS;
    this.profiles = PROFILES;
    this.periods = PERIODS;
  }

  get service() {
    return this.getService();
  }

  validateField(field, raw) {
    if (field.type === 'profile') return profileValue(raw);
    return validateBasic(field, raw);
  }

  /** @returns {Promise<{link, profile, context}>} context may be null (lookup is best-effort) */
  async createLink({ profile, name, shortcode }) {
    const chosen = PROFILES[profileValue(profile)];
    const service = this.service;
    const link = await service.createDirectLink({
      url: chosen.url,
      displayName: name ? String(name).trim() : undefined,
      shortcode: shortcode ? String(shortcode).trim() : undefined,
    });
    let context = null;
    try { context = await service.context(); } catch { /* creation succeeded; never ask to retry it */ }
    return { link, profile: chosen, context };
  }
}

module.exports = { GmsOperations, PROFILES, PERIODS, profileValue, periodValue, linkId, lazyGmsService };
