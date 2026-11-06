'use strict';

/**
 * Pure preset logic shared by every platform: id validation, URL upsert, id
 * migration and the "preset setup" builder (duplicate or edit in one pass).
 * No I/O here. Tested offline in test/presets.test.js.
 */

const { setAtPath } = require('../clients/bambou');

const PRESET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ------------------------------------------------------------------ */
/* Preset helpers                                                      */
/* ------------------------------------------------------------------ */

function validatePresetId(raw) {
  const id = String(raw ?? '').trim();
  if (!id) return { ok: false, error: 'preset id is empty' };
  if (!PRESET_ID_RE.test(id)) return { ok: false, error: 'preset id may only contain letters, digits, "-" and "_" (1-64 chars)' };
  return { ok: true, id };
}

function findPreset(config, presetId) {
  return (config.presets || []).find((p) => String(p.id) === String(presetId)) || null;
}

/** Suggest a free 4-digit id, like the dashboard. */
function nextFreePresetId(config) {
  const taken = new Set((config.presets || []).map((p) => String(p.id)));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const id = String(1000 + Math.floor(Math.random() * 9000));
    if (!taken.has(id)) return id;
  }
  for (let candidate = 1000; candidate <= 9999; candidate += 1) {
    if (!taken.has(String(candidate))) return String(candidate);
  }
  return String(1000 + (taken.size % 9000));
}

/**
 * Update-or-add a URL item in preset.urls.items.
 * @param {object} preset
 * @param {object} opts {platform, displayLabel?, url, match: "platform"|"label", spaceBeforeDotCom?}
 * @returns {{item:object, created:boolean}}
 */
function upsertUrlItem(preset, { platform, displayLabel, url, match = 'platform', spaceBeforeDotCom = false }) {
  if (!preset.urls || typeof preset.urls !== 'object') preset.urls = { chooseRandomly: false, items: [] };
  if (!Array.isArray(preset.urls.items)) preset.urls.items = [];
  const items = preset.urls.items;
  const wanted = String(platform || 'Other');
  const label = String(displayLabel ?? wanted);
  const matches = (item) => (
    String(item.platform || '') === wanted
    && (match === 'platform' || String(item.displayLabel ?? '') === label)
  );
  const existing = items.find(matches);
  if (existing) {
    existing.url = String(url);
    existing.enabled = true;
    if (displayLabel !== undefined && displayLabel !== null) existing.displayLabel = label;
    if (spaceBeforeDotCom) existing.spaceBeforeDotCom = true;
    return { item: existing, created: false };
  }
  const item = {
    id: `url-${items.length + 1}`,
    platform: wanted,
    displayLabel: label,
    url: String(url),
    snapModel: '',
    spaceBeforeDotCom: Boolean(spaceBeforeDotCom),
    enabled: true,
  };
  items.push(item);
  return { item, created: true };
}

/** Re-point in-document references from one preset id to another. */
function migratePresetIdReferences(config, oldId, newId) {
  const from = String(oldId);
  const to = String(newId);
  let accounts = 0;
  let modelSetups = 0;
  for (const account of config.accounts || []) {
    if (String(account.presetId) === from) {
      account.presetId = to;
      accounts += 1;
    }
  }
  for (const setup of config.snapchat?.modelSetups || []) {
    if (String(setup.presetId) === from) {
      setup.presetId = to;
      modelSetups += 1;
    }
  }
  return { accounts, modelSetups };
}

/**
 * Build the "preset setup": either clone `sourceId` into a new preset or edit it in place,
 * applying the Main Settings fields and the URL items in one pass.
 *
 * Mutates `config` and returns a report. Caller saves the config.
 *
 * @param {object} opts
 * @param {object} opts.config
 * @param {string} opts.sourceId        source preset (for a clone) or target preset (for edit)
 * @param {boolean} [opts.clone=true]   true: duplicate; false: edit in place
 * @param {string} [opts.name]          new preset name        (undefined = keep)
 * @param {string} [opts.id]            new preset id          (required when cloning)
 * @param {string} [opts.firstName]     identity.name          (undefined = keep)
 * @param {string} [opts.discoveryPlatform] mainSettings.discoveryPlatform (undefined = keep)
 * @param {string} [opts.mymUrl]        update-or-add the MYM item
 * @param {string} [opts.specificUrl]   update-or-add one more item
 * @param {string} [opts.specificPlatform='Other']
 * @param {string} [opts.specificLabel] label for the specific item (default: platform)
 */
function buildPresetSetup({
  config,
  sourceId,
  clone = true,
  name,
  id,
  firstName,
  discoveryPlatform,
  mymUrl,
  specificUrl,
  specificPlatform = 'Other',
  specificLabel,
} = {}) {
  const source = findPreset(config, sourceId);
  if (!source) throw new Error(`Preset not found: ${sourceId}`);

  const oldId = String(source.id);
  const target = clone ? structuredClone(source) : source;

  if (clone) target.archivedAt = null;

  const newId = String(id ?? '').trim() || (clone ? '' : oldId);
  if (clone && !newId) throw new Error('New preset id is required when duplicating.');
  if (newId) {
    const check = validatePresetId(newId);
    if (!check.ok) throw new Error(check.error);
    if (clone && newId === oldId) throw new Error(`The new id must differ from the source preset id (${oldId}).`);
    const collision = (config.presets || []).find((p) => String(p.id) === newId && p !== target);
    if (collision) throw new Error(`Preset id ${newId} is already used by "${collision.name}".`);
    target.id = newId;
  }

  if (name !== undefined && String(name).trim()) target.name = String(name).trim();
  if (firstName !== undefined && String(firstName).trim()) setAtPath(target, 'identity.name', String(firstName).trim());
  if (discoveryPlatform !== undefined && String(discoveryPlatform).trim()) {
    setAtPath(target, 'mainSettings.discoveryPlatform', String(discoveryPlatform).trim());
  }

  const changes = [];
  if (mymUrl !== undefined && String(mymUrl).trim()) {
    const result = upsertUrlItem(target, { platform: 'MYM', displayLabel: 'MYM', url: String(mymUrl).trim(), match: 'platform' });
    changes.push(`MYM URL ${result.created ? 'added' : 'updated'}`);
  }
  if (specificUrl !== undefined && String(specificUrl).trim()) {
    const platform = String(specificPlatform || 'Other');
    const label = String(specificLabel || platform);
    const result = upsertUrlItem(target, { platform, displayLabel: label, url: String(specificUrl).trim(), match: 'label' });
    changes.push(`specific URL ${result.created ? 'added' : 'updated'} (${label})`);
  }

  const migrated = { accounts: 0, modelSetups: 0 };
  if (clone) {
    config.presets = [...(config.presets || []), target];
  } else if (newId && newId !== oldId) {
    Object.assign(migrated, migratePresetIdReferences(config, oldId, newId));
  }

  return { preset: target, oldId, newId: String(target.id), changes, migrated, cloned: Boolean(clone) };
}

/** The MYM item and the first non-MYM ("extra") item of a preset. */
function urlItemsOf(preset) {
  const items = preset?.urls?.items || [];
  return {
    items,
    mym: items.find((item) => String(item.platform) === 'MYM') || null,
    extra: items.find((item) => String(item.platform) !== 'MYM') || null,
  };
}

/** Link badges for list views, e.g. ["MYM", "Extra(off)"]. */
function presetLinkBadges(preset) {
  const { items, mym } = urlItemsOf(preset);
  return [
    ...(mym ? [`MYM${mym.enabled ? '' : '(off)'}`] : []),
    ...items.filter((item) => item !== mym && (item.url || item.platform === 'snap'))
      .map((item) => `${item.displayLabel || item.platform}${item.enabled ? '' : '(off)'}`),
  ];
}

module.exports = {
  PRESET_ID_RE,
  validatePresetId,
  findPreset,
  nextFreePresetId,
  upsertUrlItem,
  migratePresetIdReferences,
  buildPresetSetup,
  urlItemsOf,
  presetLinkBadges,
};
