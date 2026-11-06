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
const { HubClient } = require('./clients/hub');
const { HubService } = require('./services/hub');
const { createHubAlertPoller } = require('./services/hub-alerts');

const DEFAULT_FACTORIES = {
  discord: (deps) => require('./platforms/discord').createDiscordPlatform(deps),
  telegram: (deps) => require('./platforms/telegram').createTelegramPlatform(deps),
};

/**
 * Build everything without touching the network.
 * @param {object} config            from loadConfig()
 * @param {object} [overrides]       { studio, getGmsService, hubClient, factories, logger }, used by tests
 */
function createApp(config, { studio, getGmsService, hubClient, factories = DEFAULT_FACTORIES, logger = console, sleepImpl } = {}) {
  const secrets = () => secretsOf(config);
  const audit = createAudit({ logger, secrets });

  // The BambouAI API has no idempotency keys: only reads are retried (see clients/bambou.js).
  const bambou = studio || new BambouStudio({ baseUrl: config.bambou.baseUrl, loginKey: config.bambou.loginKey, maxRetries: 2 });

  const owners = {};
  for (const name of ['discord', 'telegram']) if (config[name].enabled && config[name].ownerId) owners[name] = config[name].ownerId;
  const access = new AccessStore(config.accessFile, { owners, logger });

  const services = createServices({ studio: bambou, getGmsService: getGmsService || lazyGmsService(config.gms) });
  // Bambou Hub is optional: without HUB_URL + HUB_BOT_TOKEN, services.hub is null
  // and the /hub commands answer that the hub is not configured.
  const hubConfig = config.hub || { enabled: false };
  services.hub = hubConfig.enabled || hubClient
    ? new HubService({ client: hubClient || new HubClient({ baseUrl: hubConfig.url, token: hubConfig.token, timeoutMs: hubConfig.timeoutMs }) })
    : null;

  const platforms = [];
  for (const name of ['discord', 'telegram']) {
    if (!config[name].enabled) continue;
    if (!access.ownerOf(name)) {
      throw new Error(`No ${name} owner: set ${name.toUpperCase()}_OWNER_ID in .env (or run npm run migrate:access).`);
    }
    platforms.push(factories[name]({ config: config[name], services, access, audit, logger, secrets }));
  }

  let hubAlerts = null;
  if (services.hub && hubConfig.alerts) {
    hubAlerts = createHubAlertPoller({
      hub: services.hub, intervalMs: hubConfig.alertIntervalMs, logger, secrets, ...(sleepImpl ? { sleepImpl } : {}),
      // The hub decides routing; a platform this process does not run is a failed delivery.
      send: async ({ platform, ...target }) => {
        const running = platforms.find((p) => p.name === platform);
        if (!running || typeof running.sendAlert !== 'function') throw new Error(`${platform} is not running in this bot`);
        await running.sendAlert(target);
      },
    });
  }
  return { config, studio: bambou, access, services, platforms, logger, secrets, hubAlerts };
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
  // Alert delivery runs beside the platforms and never stops them (see services/hub-alerts.js).
  // Its own controller, so it also stops when every platform has failed.
  const alertControl = new AbortController();
  const stopAlerts = () => alertControl.abort();
  signal?.addEventListener('abort', stopAlerts, { once: true });
  const alerts = app.hubAlerts ? app.hubAlerts.start(alertControl.signal) : null;
  if (alerts) logger.log(`[hub] alert delivery on (${app.config.hub.url}, every ${Math.round(app.config.hub.alertIntervalMs / 1000)}s)`);
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
  stopAlerts();
  signal?.removeEventListener('abort', stopAlerts);
  if (alerts) await alerts;
  return { started, failed };
}

module.exports = { createApp, runApp, DEFAULT_FACTORIES };
