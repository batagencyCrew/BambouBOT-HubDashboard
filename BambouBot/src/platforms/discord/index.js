'use strict';

const { Client, GatewayIntentBits, Events, REST, Routes } = require('discord.js');
const { DiscordBot } = require('./bot');
const { commandsJson } = require('./commands');
const { errorText } = require('../../core/errors');

/**
 * Discord platform factory: { name, start({ signal }), stop() }.
 * start() resolves once the gateway is ready and commands are registered; it
 * rejects when the login fails (bad token, missing intents…).
 */
function createDiscordPlatform({ config, services, access, audit, logger = console, secrets = () => [] }) {
  const view = access.forPlatform('discord');
  const bot = new DiscordBot({ services, access: view, audit, logger, secrets });
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const allSecrets = () => [config.token, ...secrets()];

  client.on(Events.InteractionCreate, (interaction) => {
    bot.handleInteraction(interaction).catch((error) => logger.error(`[discord] unhandled: ${errorText(error, allSecrets())}`));
  });
  client.on(Events.Error, (error) => logger.warn(`[discord] client error: ${errorText(error, allSecrets())}`));

  async function registerCommands(appId) {
    const rest = new REST().setToken(config.token);
    const body = commandsJson();
    try {
      if (config.guildId) {
        await rest.put(Routes.applicationGuildCommands(appId, config.guildId), { body });
        logger.log(`[discord] registered commands in guild ${config.guildId}`);
      } else {
        await rest.put(Routes.applicationCommands(appId), { body });
        logger.log('[discord] registered commands globally');
      }
    } catch (error) {
      logger.error(`[discord] command registration failed: ${errorText(error, allSecrets())}`);
    }
  }

  return {
    name: 'discord',
    persistent: true, // start() resolves when ready, not when the bot stops
    bot,
    client,
    async start({ signal } = {}) {
      const ready = new Promise((resolve) => client.once(Events.ClientReady, resolve));
      signal?.addEventListener('abort', () => client.destroy(), { once: true });
      await client.login(config.token);
      const c = await ready;
      await registerCommands(c.user.id);
      logger.log(`[discord] ${c.user.tag} ready — owner ${view.ownerId}`);
    },
    async stop() {
      await client.destroy();
    },
  };
}

module.exports = { createDiscordPlatform };
