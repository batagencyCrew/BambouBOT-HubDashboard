'use strict';

/**
 * Field specs: the single source of input limits for every platform.
 *
 * Telegram drives its reply-based forms from these lists. Discord builds slash
 * options and modal inputs from them and runs modal values through the same
 * validators, so both platforms always accept and refuse exactly the same input.
 */

const { PLATFORMS } = require('../clients/bambou');
const { ValidationError } = require('./errors');

const PRESET_FIELDS = [
  { key: 'name', option: 'name', label: 'Preset name', max: 100, required: true },
  { key: 'id', option: 'id', label: 'Preset ID', max: 64, required: true, type: 'presetId' },
  { key: 'firstName', option: 'first_name', label: 'First name', max: 60 },
  { key: 'discoveryPlatform', option: 'discovery_platform', label: 'Discovery platform', max: 80 },
  { key: 'mymUrl', option: 'mym_url', label: 'MYM URL', type: 'url' },
  { key: 'specificUrl', option: 'specific_url', label: 'Extra URL', type: 'url' },
  { key: 'specificPlatform', option: 'specific_platform', label: 'Extra URL platform', type: 'platform' },
  { key: 'specificLabel', option: 'specific_label', label: 'Extra URL display label', max: 100 },
];

const KEY_FIELDS = [
  { key: 'label', option: 'label', label: 'Key label', max: 60, required: true },
  { key: 'rpm', option: 'rpm', label: 'Generations per minute', type: 'integer', min: 1, max: 600, default: 20 },
  { key: 'concurrent', option: 'concurrent', label: 'Simultaneous calls', type: 'integer', min: 1, max: 8, default: 2 },
  { key: 'daily', option: 'daily', label: 'Generations per UTC day', type: 'integer', min: 1, max: 100_000, default: 1000 },
  { key: 'scope', option: 'scope', label: 'Preset scope (comma-separated IDs, or all)', type: 'scope' },
];

const PAUSED_FIELD = { key: 'paused', option: 'paused', label: 'Pause the key (true / false)', type: 'boolean' };

const GMS_FIELDS = [
  { key: 'profile', option: 'profile', label: 'Destination profile', type: 'profile', required: true },
  { key: 'name', option: 'name', label: 'Display name (optional)', max: 100 },
  { key: 'shortcode', option: 'shortcode', label: 'Custom shortcode (optional; empty = generated)', max: 64, type: 'shortcode' },
];

const URL_MAX = 300;
const SCOPE_MAX = 100;

/* ------------------------------ validators ------------------------------ */

function integer(raw, label, min, max = Number.MAX_SAFE_INTEGER) {
  const value = String(raw ?? '').trim();
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < min || number > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return number;
}

function boolean(raw, label = 'paused') {
  if (raw === true || raw === false) return raw;
  const value = String(raw).trim().toLowerCase();
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${label} must be true or false.`);
}

function stringValue(raw, label, { max = 100, required = false } = {}) {
  const value = String(raw ?? '').trim();
  if (required && !value) throw new ValidationError(`${label} is required.`);
  if (value.length > max) throw new ValidationError(`${label} must be at most ${max} characters.`);
  return value;
}

/** Empty is allowed (= keep the current value); anything else must be a full http(s) URL. */
function httpUrl(raw, label) {
  const value = stringValue(raw, label, { max: URL_MAX });
  if (!value) return value;
  let url;
  try { url = new URL(value); } catch { /* handled below */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new ValidationError(`${label} must be a complete http:// or https:// URL.`);
  }
  return value;
}

/** Canonical platform name (case-insensitive match against the dashboard list). */
function platformValue(raw, label = 'Platform') {
  const value = stringValue(raw, label, { max: 80, required: true });
  const platform = PLATFORMS.find((item) => item.toLowerCase() === value.toLowerCase());
  if (!platform) throw new ValidationError(`${label} must be one of: ${PLATFORMS.join(', ')}.`);
  return platform;
}

function shortcodeValue(raw, label = 'Shortcode') {
  const value = stringValue(raw, label, { max: 64 });
  if (value && !/^[A-Za-z0-9_-]+$/.test(value)) throw new ValidationError('Shortcodes may contain letters, digits, "-" and "_" only.');
  return value;
}

/** "all" / empty → []; otherwise a de-duplicated list of ids (existence is checked by the key service). */
function scopeList(raw) {
  const value = String(raw ?? '').trim();
  if (!value || value.toLowerCase() === 'all') return [];
  const ids = [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))];
  if (ids.length > SCOPE_MAX) throw new ValidationError(`A key can be scoped to at most ${SCOPE_MAX} presets.`);
  return ids;
}

/** Positive numeric platform user id. */
function userId(raw, platformLabel = 'Telegram') {
  const id = String(raw ?? '').trim();
  // Discord snowflakes exceed Number.MAX_SAFE_INTEGER, so ids stay strings.
  if (!/^[1-9]\d{0,24}$/.test(id)) {
    throw new ValidationError(`Use a positive numeric ${platformLabel} user ID, not a username.${platformLabel === 'Telegram' ? ' The user can get it with /whoami.' : ''}`);
  }
  return id;
}

/**
 * Field-level validation that needs no I/O. Async checks (preset id collisions,
 * scope ids existing) live in the services.
 */
function validateBasic(field, raw) {
  switch (field.type) {
    case 'integer': return integer(raw, field.label, field.min, field.max);
    case 'boolean': return boolean(raw, field.label);
    case 'url': return httpUrl(raw, field.label);
    case 'platform': return platformValue(raw, field.label);
    case 'shortcode': return shortcodeValue(raw, field.label);
    default: return stringValue(raw, field.label, field);
  }
}

const fieldByKey = (fields, key) => fields.find((field) => field.key === key);

module.exports = {
  PRESET_FIELDS, KEY_FIELDS, PAUSED_FIELD, GMS_FIELDS, URL_MAX, SCOPE_MAX,
  integer, boolean, stringValue, httpUrl, platformValue, shortcodeValue, scopeList, userId,
  validateBasic, fieldByKey,
};
