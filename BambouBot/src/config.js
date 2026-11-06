'use strict';

/**
 * Configuration: one .env file (next to package.json, or BAMBOU_ENV_FILE) plus the
 * real environment, which always wins. loadConfig() never exits the process; it
 * returns a validated object or throws a ConfigError listing every problem.
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

class ConfigError extends Error {
  constructor(problems) {
    super(`Configuration error:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/** Parse .env text: KEY=value, KEY="quoted", export KEY=value, # comments. */
function parseEnv(raw) {
  const out = {};
  for (const line of String(raw).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const quote = value[0];
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      const comment = value.search(/\s#/);
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Merge the .env file under the real environment (real variables win). */
function readEnvironment({ env = process.env, file } = {}) {
  const envFile = file || env.BAMBOU_ENV_FILE || path.join(ROOT, '.env');
  let fromFile = {};
  try {
    fromFile = parseEnv(fs.readFileSync(envFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || env.BAMBOU_ENV_FILE) {
      if (error.code === 'ENOENT') throw new ConfigError([`BAMBOU_ENV_FILE points to a missing file: ${envFile}`]);
      throw new ConfigError([`Cannot read ${envFile}: ${error.message}`]);
    }
  }
  return { values: { ...fromFile, ...env }, envFile };
}

const blank = (value) => value === undefined || value === null || String(value).trim() === '';

/** http(s) URL without a trailing slash. An invalid value is reported and ignored. */
function urlSetting(values, name, problems) {
  const raw = String(values[name] ?? '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch {
    problems.push(`${name} must be a full http(s) URL, e.g. https://hub.example.com`);
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    problems.push(`${name} must be a full http(s) URL (http or https)`);
    return null;
  }
  return raw.replace(/\/+$/, '');
}

/** true/false from an environment value; anything else is a configuration problem. */
function booleanSetting(values, name, def, problems) {
  if (blank(values[name])) return def;
  const value = String(values[name]).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(value)) return true;
  if (['false', '0', 'no', 'off'].includes(value)) return false;
  problems.push(`${name} must be true or false`);
  return def;
}

function intSetting(values, name, def, min, max, problems) {
  if (blank(values[name])) return def;
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < min || n > max) {
    problems.push(`${name} must be an integer between ${min} and ${max}`);
    return def;
  }
  return n;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.env]       environment (default process.env)
 * @param {string} [opts.file]      .env path override
 * @param {string[]} [opts.only]    restrict to these platforms (CLI --only)
 */
function loadConfig({ env = process.env, file, only } = {}) {
  const { values, envFile } = readEnvironment({ env, file });
  const problems = [];
  const id = (name) => {
    const value = String(values[name] ?? '').trim();
    if (!value) return null;
    if (!/^[1-9]\d{0,24}$/.test(value)) problems.push(`${name} must be a numeric user id (not a username)`);
    return value;
  };

  const wanted = only && only.length ? only : null;
  for (const name of wanted || []) {
    if (!['discord', 'telegram'].includes(name)) problems.push(`Unknown platform "${name}" (use discord or telegram)`);
  }
  const enabled = (name, token) => (wanted ? wanted.includes(name) : !blank(token));

  const discord = {
    enabled: enabled('discord', values.DISCORD_TOKEN),
    token: String(values.DISCORD_TOKEN || '').trim(),
    ownerId: id('DISCORD_OWNER_ID'),
    guildId: String(values.DISCORD_GUILD_ID || '').trim() || null,
  };
  const telegram = {
    enabled: enabled('telegram', values.TELEGRAM_TOKEN),
    token: String(values.TELEGRAM_TOKEN || '').trim(),
    ownerId: id('TELEGRAM_OWNER_ID'),
    pollTimeout: intSetting(values, 'TELEGRAM_POLL_TIMEOUT', 30, 1, 50, problems),
  };
  if (discord.enabled && !discord.token) problems.push('DISCORD_TOKEN is required to run the Discord bot');
  if (telegram.enabled && !telegram.token) problems.push('TELEGRAM_TOKEN is required to run the Telegram bot');
  if (telegram.token && !/^\d+:[A-Za-z0-9_-]+$/.test(telegram.token)) problems.push('TELEGRAM_TOKEN must be the bot token issued by @BotFather');
  if (!discord.enabled && !telegram.enabled && !wanted) problems.push('Nothing to start: set DISCORD_TOKEN and/or TELEGRAM_TOKEN');

  const bambou = {
    loginKey: String(values.BAMBOU_LOGIN_KEY || '').trim(),
    baseUrl: String(values.BAMBOU_BASE_URL || '').trim() || 'https://bambouaibot.com',
  };
  if (!bambou.loginKey) problems.push('BAMBOU_LOGIN_KEY is required (the studio login key)');

  const accessFile = path.resolve(ROOT, String(values.ACCESS_FILE || '').trim() || 'data/access.json');

  const gms = {
    cookie: String(values.GMS_COOKIE || '').trim() || null,
    teamId: String(values.GMS_TEAM_ID || '').trim() || null,
    baseUrl: String(values.GMS_BASE_URL || '').trim() || undefined,
    minRequestIntervalMs: intSetting(values, 'GMS_MIN_INTERVAL_MS', 350, 0, 60_000, problems),
    cacheTtlMs: intSetting(values, 'GMS_CACHE_TTL_MS', 30_000, 0, 3_600_000, problems),
  };

  // Bambou Hub: optional. Without both values the hub module is simply off.
  const hubUrl = urlSetting(values, 'HUB_URL', problems);
  const hubToken = String(values.HUB_BOT_TOKEN || '').trim() || null;
  if (hubToken && !/^hbt_[A-Za-z0-9_-]{10,}$/.test(hubToken)) problems.push('HUB_BOT_TOKEN must be a hub bot service token (hbt_…)');
  if (hubToken && !hubUrl && blank(values.HUB_URL)) problems.push('HUB_URL is required when HUB_BOT_TOKEN is set');
  if (hubUrl && !hubToken) problems.push('HUB_BOT_TOKEN is required when HUB_URL is set (create one in the hub: Users → Bot token)');
  const hubEnabled = Boolean(hubUrl && hubToken);
  const hub = {
    enabled: hubEnabled,
    url: hubUrl,
    token: hubToken,
    timeoutMs: intSetting(values, 'HUB_TIMEOUT_MS', 15_000, 1000, 120_000, problems),
    alerts: hubEnabled && booleanSetting(values, 'HUB_ALERTS', true, problems),
    alertIntervalMs: intSetting(values, 'HUB_ALERT_INTERVAL_MS', 20_000, 5_000, 600_000, problems),
  };

  if (problems.length) throw new ConfigError(problems);
  return { root: ROOT, envFile, discord, telegram, bambou, accessFile, gms, hub };
}

/** Every secret value that must never appear in logs or public replies. */
function secretsOf(config) {
  return [config.discord.token, config.telegram.token, config.bambou.loginKey, config.gms.cookie, config.hub?.token].filter(Boolean);
}

module.exports = { loadConfig, parseEnv, readEnvironment, secretsOf, ConfigError, ROOT };
