'use strict';

/**
 * Preset operations shared by Discord and Telegram: list, form prefill, field
 * validation (including id collisions), and the one-save duplicate/edit flow
 * with key-scope re-pointing after an id rename.
 */

const presets = require('../core/presets');
const { PRESET_FIELDS, validateBasic, platformValue, stringValue } = require('../core/fields');
const { ValidationError } = require('../core/errors');

class PresetService {
  constructor({ studio, cache }) {
    this.studio = studio;
    this.cache = cache;
    this.fields = PRESET_FIELDS;
  }

  async list({ force = false } = {}) {
    const config = await this.cache.get(force);
    return config.presets || [];
  }

  async find(presetId, { force = false } = {}) {
    return presets.findPreset(await this.cache.get(force), presetId);
  }

  /**
   * Initial form values for a duplicate ("setup") or "edit" of `sourceId`.
   * @returns {Promise<{preset:object, values:object}>}
   */
  async prefill(operation, sourceId, { specificPlatform, specificLabel, force = true } = {}) {
    if (!['setup', 'edit'].includes(operation)) throw new Error(`Unknown preset operation ${operation}`);
    const config = await this.cache.get(force);
    const preset = presets.findPreset(config, sourceId);
    if (!preset) throw new ValidationError(`Preset ${sourceId} not found. Use /preset list.`);
    const { mym, extra } = presets.urlItemsOf(preset);
    // A platform passed by the user must be a listed one; an existing (even unlisted) value is kept.
    if (specificPlatform) specificPlatform = platformValue(specificPlatform, 'Extra URL platform');
    if (specificLabel !== undefined && specificLabel !== null) specificLabel = stringValue(specificLabel, 'Extra URL display label', { max: 100 });
    const platform = specificPlatform || (operation === 'edit' && extra?.platform) || 'Other';
    const label = specificLabel || (operation === 'edit' && extra?.displayLabel) || platform;
    return {
      preset,
      values: {
        name: preset.name || '',
        id: operation === 'setup' ? presets.nextFreePresetId(config) : String(preset.id),
        firstName: preset.identity?.name || '',
        discoveryPlatform: preset.mainSettings?.discoveryPlatform || '',
        mymUrl: mym?.url || '',
        specificUrl: extra?.url || '',
        specificPlatform: platform,
        specificLabel: label,
      },
    };
  }

  /**
   * Validate one preset form field.
   * @param {object} field     one of PRESET_FIELDS
   * @param {*} raw
   * @param {object} ctx       { operation, sourceId, values } (values = current draft)
   */
  async validateField(field, raw, { operation, sourceId, values = {} } = {}) {
    // Keep an existing (possibly custom, unlisted) extra platform when it is left unchanged.
    if (field.type === 'platform' && values.specificPlatform && String(raw ?? '').trim() === values.specificPlatform) {
      return values.specificPlatform;
    }
    const value = validateBasic(field, raw);
    if (field.type === 'presetId') await this.checkNewId(value, { operation, sourceId });
    return value;
  }

  /** Throws when `id` is malformed or already used by another preset. */
  async checkNewId(id, { operation, sourceId }) {
    const check = presets.validatePresetId(id);
    if (!check.ok) throw new ValidationError(check.error);
    const existing = presets.findPreset(await this.cache.get(true), check.id);
    if (existing && (operation === 'setup' || check.id !== String(sourceId))) {
      throw new ValidationError(`Preset ID ${check.id} is already in use${existing.name ? ` by "${existing.name}"` : ''}.`);
    }
    return check.id;
  }

  /** Validate a complete set of values (used before saving, whatever the platform). */
  async validateAll(values, ctx) {
    const out = { ...values };
    for (const field of this.fields) {
      if (values[field.key] === undefined) continue;
      out[field.key] = await this.validateField(field, values[field.key], { ...ctx, values });
    }
    return out;
  }

  /**
   * Apply the form in exactly one config save. When an edit renames the preset id,
   * re-point scoped API keys and count media records that keep the old id.
   */
  async save({ operation, sourceId, values }) {
    let report;
    await this.studio.updateConfig((config) => {
      report = presets.buildPresetSetup({
        config,
        sourceId,
        clone: operation === 'setup',
        name: values.name,
        id: values.id,
        firstName: values.firstName,
        discoveryPlatform: values.discoveryPlatform,
        mymUrl: values.mymUrl,
        specificUrl: values.specificUrl,
        specificPlatform: values.specificPlatform,
        specificLabel: values.specificLabel,
      });
    });
    this.cache.invalidate();

    report.renamed = !report.cloned && report.newId !== report.oldId;
    report.keyScopes = { updated: [], failed: [] };
    report.staleMedia = 0;
    if (report.renamed) {
      report.keyScopes = await this.repointKeyScopes(report.oldId, report.newId);
      try {
        const library = await this.studio.listMediaLibrary();
        report.staleMedia = (library?.items || []).filter((item) => String(item.presetId) === report.oldId).length;
      } catch { /* media scan is best-effort */ }
    }
    return report;
  }

  /**
   * Server-side assistant keys keep their own preset scope; after an id change,
   * re-point every active key that was scoped to the old id.
   */
  async repointKeyScopes(oldId, newId) {
    const updated = [];
    const failed = [];
    let keys;
    try {
      keys = await this.studio.listApiKeys();
    } catch (error) {
      return { updated, failed: [{ id: '(list)', error: error.message }] };
    }
    for (const key of keys) {
      if (key.revokedAt) continue;
      if (!Array.isArray(key.presetIds) || !key.presetIds.includes(String(oldId))) continue;
      const presetIds = key.presetIds.map((id) => (String(id) === String(oldId) ? String(newId) : id));
      try {
        await this.studio.updateApiKey(key.id, { presetIds });
        updated.push(key.id);
      } catch (error) {
        failed.push({ id: key.id, error: error.message });
      }
    }
    return { updated, failed };
  }
}

module.exports = { PresetService };
