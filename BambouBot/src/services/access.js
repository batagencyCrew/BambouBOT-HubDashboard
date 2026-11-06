'use strict';

const { PERMISSIONS } = require('../core/access');
const { ValidationError } = require('../core/errors');

/** "all", "presets+keys", "keys,gms", "gms" → validated permission list. */
function parsePermissions(raw) {
  const requested = String(raw || '').trim().toLowerCase();
  if (requested === 'all') return [...PERMISSIONS];
  const permissions = [...new Set(requested.split(/[+,\s]+/).map((value) => value.trim()).filter(Boolean))];
  if (!permissions.length || permissions.some((value) => !PERMISSIONS.includes(value))) {
    throw new ValidationError(`Permissions must be all, or a combination of ${PERMISSIONS.join(', ')}.`);
  }
  return permissions;
}

/** Every non-empty permission combination, e.g. for Discord option choices. */
function permissionChoices() {
  const out = [];
  for (let mask = 1; mask < 2 ** PERMISSIONS.length; mask += 1) {
    const combo = PERMISSIONS.filter((_, index) => mask & (1 << index));
    out.push(combo.length === PERMISSIONS.length ? 'all' : combo.join('+'));
  }
  const size = (value) => (value === 'all' ? PERMISSIONS.length : value.split('+').length);
  return out.sort((a, b) => size(a) - size(b));
}

module.exports = { parsePermissions, permissionChoices };
