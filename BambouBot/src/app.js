'use strict';

/**
 * Composition root: one process, one studio session, one config cache, one
 * GetMySocial client and one access store, shared by every enabled platform.
 *
 * Platforms are independent. If one fails at startup or later (bad token,
 * Telegram webhook set, another poller running…), it is logged and the others
 * keep running. The app only fails when no platform is left.
 */

const { BambouStudio } = require('./clients/bambou');
const { AccessStore } = require('./core/access');
const { createAudit } = require('./core/audit');
const { errorText } = require('./core/errors');
const { createServices } = require('./services');
const { lazyGmsService } = require('./services/gms');
const { secretsOf } = require('./config');

const DEFAULT_FACTORIES = {
  discord: (deps) => require('./platforms/discord').createDiscordPlatform(deps),
  telegram: (deps) => require('./platforms/telegram').createTelegramPlatform(deps),
};

/**
 * Build everything without touching the network.
 * @param {object} config            from loadConfig()
 * @param {object} [overrides]       { studio, getGmsService, factories, logger }, used by tests
 */
function createApp(config, { studio, getGmsService, factories = DEFAULT_FACTORIES, logger = console } = {}) {
  const secrets = () => secretsOf(config);
  const audit = createAudit({ logger, secrets });

  // The BambouAI API has no idempotency keys: only reads are retried (see clients/bambou.js).
  const bambou = studio || new BambouStudio({ baseUrl: config.bambou.baseUrl, loginKey: config.bambou.loginKey, maxRetries: 2 });

  const owners = {};
  for (const name of ['discord', 'telegram']) if (config[name].enabled && config[name].ownerId) owners[name] = config[name].ownerId;
  const access = new AccessStore(config.accessFile, { owners, logger });

  const services = createServices({ studio: bambou, getGmsService: getGmsService || lazyGmsService(config.gms) });

  const platforms = [];
  for (const name of ['discord', 'telegram']) {
    if (!config[name].enabled) continue;
    if (!access.ownerOf(name)) {
      throw new Error(`No ${name} owner: set ${name.toUpperCase()}_OWNER_ID in .env (or run npm run migrate:access).`);
    }
    platforms.push(factories[name]({ config: config[name], services, access, audit, logger, secrets }));
  }
  return { config, studio: bambou, access, services, platforms, logger, secrets };
}

/**
 * Log in to BambouAI once, then start every platform.
 * Resolves when every platform has stopped (signal aborted or all failed).
 * @returns {Promise<{started:string[], failed:Array<{name,error}>}>}
 */
async function runApp(app, { signal } = {}) {
  const { logger, secrets } = app;
  await app.studio.login();
  logger.log(`[app] logged in to BambouAI (${app.config.bambou.baseUrl})`);

  const failed = [];
  const started = [];
  // Discord's start() resolves once ready; Telegram's resolves when polling ends.
  const lifetimes = app.platforms.map(async (platform) => {
    try {
      await platform.start({ signal });
      started.push(platform.name);
      // Platforms whose start() returns once ready (Discord) stay alive until shutdown;
      // discord.js reconnects to the gateway on its own.
      if (platform.persistent && signal && !signal.aborted) {
        await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
      }
    } catch (error) {
      if (signal?.aborted) return;
      failed.push({ name: platform.name, error });
      logger.error(`[${platform.name}] stopped: ${errorText(error, secrets())}`);
      try { await platform.stop(); } catch { /* already down */ }
      if (failed.length === app.platforms.length) logger.error('[app] no platform left running');
    }
  });
  await Promise.all(lifetimes);
  for (const platform of app.platforms) {
    try { await platform.stop(); } catch { /* already down */ }
  }
  return { started, failed };
}

module.exports = { createApp, runApp, DEFAULT_FACTORIES };
