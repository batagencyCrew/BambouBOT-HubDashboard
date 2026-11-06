'use strict';

/**
 * Assistant API key operations shared by Discord and Telegram.
 * Form values use the field keys (label, rpm, concurrent, daily, scope, paused);
 * the API uses label, rpm, maxConcurrent, dailyLimit, presetIds, disabled.
 */

const { KEY_FIELDS, PAUSED_FIELD, validateBasic, scopeList } = require('../core/fields');
const { ValidationError } = require('../core/errors');
const { findPreset } = require('../core/presets');

const PATCH_NAMES = { label: 'label', rpm: 'rpm', concurrent: 'maxConcurrent', daily: 'dailyLimit', scope: 'presetIds', paused: 'disabled' };
const EDIT_FIELDS = [...KEY_FIELDS, PAUSED_FIELD];

class KeyService {
  constructor({ studio, cache }) {
    this.studio = studio;
    this.cache = cache;
    this.fields = KEY_FIELDS;
    this.editFields = EDIT_FIELDS;
  }

  async list({ includeRevoked = true } = {}) {
    const keys = await this.studio.listApiKeys();
    return includeRevoked ? keys : keys.filter((key) => !key.revokedAt);
  }

  async find(keyId) {
    return (await this.studio.listApiKeys()).find((key) => String(key.id) === String(keyId)) || null;
  }

  /** "all"/empty → [] (every preset); otherwise ids that must exist. */
  async resolveScope(raw, { force = false } = {}) {
    const ids = Array.isArray(raw) ? raw : scopeList(raw);
    if (!ids.length) return [];
    const config = await this.cache.get(force);
    const unknown = ids.filter((id) => !findPreset(config, id));
    if (unknown.length) throw new ValidationError(`Unknown preset ID(s): ${unknown.join(', ')}. Use /preset list.`);
    return ids;
  }

  /** Validate one form field; scope is normalised to "all" or "id1,id2". */
  async validateField(field, raw) {
    if (field.type === 'scope') return (await this.resolveScope(raw)).join(',') || 'all';
    return validateBasic(field, raw);
  }

  /** Default values for a new key. */
  defaults() {
    return Object.fromEntries(KEY_FIELDS.map((field) => [field.key, field.default ?? (field.type === 'scope' ? 'all' : '')]));
  }

  /** Form values describing an existing key. */
  valuesOf(key) {
    return {
      label: key.label,
      rpm: key.rpm,
      concurrent: key.maxConcurrent,
      daily: key.dailyLimit,
      scope: (key.presetIds || []).join(',') || 'all',
      paused: Boolean(key.disabled),
    };
  }

  /**
   * Validate the supplied raw options (keys = field keys, undefined/null = not given).
   * @returns {Promise<object>} validated values for the supplied fields only
   */
  async validateSupplied(raw, { edit = false } = {}) {
    const out = {};
    for (const field of edit ? EDIT_FIELDS : KEY_FIELDS) {
      if (raw[field.key] === undefined || raw[field.key] === null) continue;
      out[field.key] = await this.validateField(field, raw[field.key]);
    }
    return out;
  }

  /**
   * Create a key. The response carries the one-time bbk_ secret in `key`.
   * @param {object} values validated form values (missing limits use the defaults)
   */
  async create(values) {
    const merged = { ...this.defaults(), ...values };
    if (!String(merged.label || '').trim()) throw new ValidationError('Key label is required.');
    const presetIds = await this.resolveScope(merged.scope, { force: true });
    const created = await this.studio.createApiKey({
      label: merged.label, rpm: merged.rpm, maxConcurrent: merged.concurrent, dailyLimit: merged.daily, presetIds,
    });
    return { created, presetIds, values: merged };
  }

  /**
   * API patch from validated values. With `original`, only changed fields are included.
   * @returns {Promise<object>} patch (possibly empty)
   */
  async buildPatch(values, original = null) {
    const patch = {};
    for (const field of EDIT_FIELDS) {
      if (values[field.key] === undefined) continue;
      if (original && values[field.key] === original[field.key]) continue;
      patch[PATCH_NAMES[field.key]] = field.key === 'scope'
        ? await this.resolveScope(values.scope, { force: true })
        : values[field.key];
    }
    return patch;
  }

  update(keyId, patch) {
    return this.studio.updateApiKey(keyId, patch);
  }

  revoke(keyId) {
    return this.studio.revokeApiKey(keyId);
  }
}

module.exports = { KeyService, PATCH_NAMES };
