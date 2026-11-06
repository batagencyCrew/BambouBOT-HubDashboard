'use strict';

const { redact } = require('./errors');

/**
 * One audit format for every platform:
 *   [audit] platform=discord user=123 chat=456 action=key.create id=ak_…
 * Lines are redacted (known secrets, bbk_ keys, bot tokens) and newline-free.
 */
function createAudit({ logger = console, secrets = () => [] } = {}) {
  return function audit({ platform, userId, chatId }, action, detail = '') {
    const parts = [`[audit] platform=${platform}`, `user=${userId}`];
    if (chatId) parts.push(`chat=${chatId}`);
    parts.push(`action=${action}`);
    if (detail) parts.push(detail);
    logger.log(redact(parts.join(' '), secrets()).replace(/[\r\n]+/g, ' '));
  };
}

module.exports = { createAudit };
