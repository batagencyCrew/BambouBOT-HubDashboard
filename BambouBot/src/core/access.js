'use strict';

/**
 * Access store: one JSON file for every platform, with platform-scoped identities.
 *
 *   {
 *     "version": 2,
 *     "owners": { "discord": "670…", "telegram": "123…" },
 *     "users": {
 *       "discord:456":  { "permissions": ["presets"], "label": "…", "addedBy": "…", "addedAt": "…" },
 *       "telegram:789": { "permissions": ["gms"], … }
 *     }
 *   }
 *
 * Discord and Telegram user IDs are unrelated number spaces, so every lookup is
 * scoped to its platform through `store.forPlatform(name)`; the returned view has the
 * same API the bots always used (isOwner/has/permissionsOf/add/remove/list).
 *
 * Safety: an existing file that cannot be parsed or validated is never overwritten.
 * The constructor throws instead, so the bot refuses to start until it is fixed.
 * Writes go to a temp file first and are renamed into place, so they are atomic.
 */

const fs = require('node:fs');
const path = require('node:path');

const PERMISSIONS = ['presets', 'keys', 'gms'];
const PLATFORMS = ['discord', 'telegram'];
const ID_RE = /^[1-9]\d{0,24}$/;

class AccessFileError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AccessFileError';
  }
}

function validId(id) {
  return ID_RE.test(String(id ?? ''));
}

/** Validate a parsed v2 document; throws a descriptive AccessFileError. */
function validateDocument(doc, file) {
  const fail = (why) => { throw new AccessFileError(`Invalid access file ${file}: ${why}. Fix or restore it; it was not modified.`); };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) fail('not a JSON object');
  if (doc.version !== 2) {
    fail(doc.ownerId !== undefined
      ? 'this is a legacy single-platform file; convert it with `npm run migrate:access`'
      : `unsupported version ${JSON.stringify(doc.version)}`);
  }
  if (!doc.owners || typeof doc.owners !== 'object' || Array.isArray(doc.owners)) fail('"owners" must be an object');
  for (const [platform, id] of Object.entries(doc.owners)) {
    if (!PLATFORMS.includes(platform)) fail(`unknown platform "${platform}" in owners`);
    if (id !== null && !validId(id)) fail(`owner id for ${platform} must be numeric`);
  }
  if (!doc.users || typeof doc.users !== 'object' || Array.isArray(doc.users)) fail('"users" must be an object');
  for (const [key, entry] of Object.entries(doc.users)) {
    const [platform, id, extra] = key.split(':');
    if (extra !== undefined || !PLATFORMS.includes(platform) || !validId(id)) fail(`user key "${key}" must look like discord:<id> or telegram:<id>`);
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.permissions)) fail(`user ${key} has no permissions array`);
    const unknown = entry.permissions.filter((p) => !PERMISSIONS.includes(p));
    if (unknown.length) fail(`user ${key} has unknown permission(s) ${unknown.join(', ')}`);
  }
  return doc;
}

class AccessStore {
  /**
   * @param {string} filePath
   * @param {object} [opts]
   * @param {object} [opts.owners]  { discord?, telegram? } from the environment: they seed a
   *                                missing owner and override a different stored one.
   * @param {object} [opts.logger]
   */
  constructor(filePath, { owners = {}, logger = console } = {}) {
    this.filePath = path.resolve(filePath);
    this.logger = logger;
    this.data = { version: 2, owners: {}, users: {} };
    this.load();
    let dirty = !fs.existsSync(this.filePath);
    for (const [platform, id] of Object.entries(owners)) {
      if (!id) continue;
      if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}`);
      if (!validId(id)) throw new AccessFileError(`The ${platform} owner id must be a numeric user id (got "${id}").`);
      const current = this.data.owners[platform];
      if (current === String(id)) continue;
      if (current) this.logger.warn(`[access] ${platform} owner ${current} replaced by the configured owner ${id}`);
      this.data.owners[platform] = String(id);
      dirty = true;
    }
    if (dirty) this.save();
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return this.data; // first start: created on save()
      throw new AccessFileError(`Cannot read access file ${this.filePath}: ${error.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new AccessFileError(`Invalid access file ${this.filePath}: not valid JSON. Fix or restore it; it was not modified.`);
    }
    validateDocument(parsed, this.filePath);
    this.data = {
      version: 2,
      owners: Object.fromEntries(Object.entries(parsed.owners).filter(([, id]) => id).map(([p, id]) => [p, String(id)])),
      users: parsed.users,
    };
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, this.filePath);
    return this.data;
  }

  ownerOf(platform) {
    return this.data.owners[platform] || null;
  }

  /** A view bound to one platform, with the familiar single-platform API. */
  forPlatform(platform) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}`);
    return new PlatformAccess(this, platform);
  }
}

class PlatformAccess {
  constructor(store, platform) {
    this.store = store;
    this.platform = platform;
  }

  key(userId) {
    return `${this.platform}:${String(userId)}`;
  }

  get ownerId() {
    return this.store.ownerOf(this.platform);
  }

  isOwner(userId) {
    return Boolean(this.ownerId) && String(userId) === this.ownerId;
  }

  /** Owner has everything; approved users only what was granted. */
  permissionsOf(userId) {
    if (this.isOwner(userId)) return [...PERMISSIONS];
    const entry = this.store.data.users[this.key(userId)];
    return entry && Array.isArray(entry.permissions) ? entry.permissions.filter((p) => PERMISSIONS.includes(p)) : [];
  }

  has(userId, permission) {
    return this.permissionsOf(userId).includes(permission);
  }

  add(userId, permissions, { label = '', addedBy = '' } = {}) {
    const id = String(userId ?? '');
    if (!validId(id)) return { ok: false, error: 'user id must be a positive number' };
    if (this.isOwner(id)) return { ok: false, error: 'this user is the owner and already has every permission' };
    const perms = [...new Set((permissions || []).filter((p) => PERMISSIONS.includes(p)))];
    if (!perms.length) return { ok: false, error: `permission list must include at least one of: ${PERMISSIONS.join(', ')}` };
    const entry = { permissions: perms, label: String(label || ''), addedBy: String(addedBy || ''), addedAt: new Date().toISOString() };
    this.store.data.users[this.key(id)] = entry;
    this.store.save();
    return { ok: true, entry };
  }

  remove(userId) {
    const key = this.key(userId);
    if (!this.store.data.users[key]) return { ok: false, error: 'this user is not in the approved list' };
    delete this.store.data.users[key];
    this.store.save();
    return { ok: true };
  }

  list() {
    const prefix = `${this.platform}:`;
    return Object.entries(this.store.data.users)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, entry]) => ({ id: key.slice(prefix.length), ...entry }));
  }
}

/**
 * Convert legacy single-platform files ({ ownerId, users: { id: entry } }) into one v2 document.
 * @param {object} legacy { discord?: object, telegram?: object } parsed legacy documents
 */
function migrateLegacy(legacy) {
  const doc = { version: 2, owners: {}, users: {} };
  for (const [platform, data] of Object.entries(legacy)) {
    if (!data) continue;
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform ${platform}`);
    if (typeof data !== 'object' || Array.isArray(data)) throw new AccessFileError(`${platform}: not a JSON object`);
    if (data.ownerId) {
      if (!validId(data.ownerId)) throw new AccessFileError(`${platform}: owner id "${data.ownerId}" is not numeric`);
      doc.owners[platform] = String(data.ownerId);
    }
    for (const [id, entry] of Object.entries(data.users || {})) {
      if (!validId(id)) throw new AccessFileError(`${platform}: user id "${id}" is not numeric`);
      const permissions = Array.isArray(entry?.permissions) ? entry.permissions.filter((p) => PERMISSIONS.includes(p)) : [];
      if (!permissions.length) continue;
      doc.users[`${platform}:${id}`] = {
        permissions,
        label: String(entry.label || ''),
        addedBy: String(entry.addedBy || ''),
        addedAt: entry.addedAt || new Date().toISOString(),
      };
    }
  }
  return validateDocument(doc, '(migrated)');
}

module.exports = { PERMISSIONS, PLATFORMS, AccessStore, PlatformAccess, AccessFileError, validateDocument, migrateLegacy };
