'use strict';

const { TelegramClient } = require('./client');
const { TelegramBot } = require('./bot');

/**
 * Telegram platform factory: { name, start({ signal }), stop() }.
 * start() resolves when polling ends (signal aborted) and rejects on a fatal error
 * (bad token, webhook set, another poller running).
 */
function createTelegramPlatform({ config, services, access, audit, logger = console, secrets }) {
  const telegram = new TelegramClient({ token: config.token });
  const bot = new TelegramBot({ telegram, services, access: access.forPlatform('telegram'), audit, logger, secrets });
  return {
    name: 'telegram',
    bot,
    start: ({ signal } = {}) => bot.run({ signal, pollTimeout: config.pollTimeout }),
    async stop() { /* polling stops through the shared AbortSignal */ },
  };
}

module.exports = { createTelegramPlatform };
