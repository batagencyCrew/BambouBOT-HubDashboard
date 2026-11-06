'use strict';

/** Telegram Bot API transport, using only Node 18+ fetch. No webhook/server needed. */

const { setTimeout: delay } = require('node:timers/promises');
const { redact } = require('../../core/errors');
const { splitText } = require('../../core/format');

class TelegramError extends Error {
  constructor(message, { status = 0, errorCode = status, retryAfter, method } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = status;
    this.errorCode = errorCode;
    this.retryAfter = retryAfter;
    this.method = method;
  }
}

const wait = (ms, signal) => delay(ms, undefined, signal ? { signal } : undefined);

class TelegramClient {
  constructor({ token, baseUrl = 'https://api.telegram.org', fetchImpl = globalThis.fetch,
    timeoutMs = 40_000, maxRateLimitRetries = 2, sleepImpl = wait } = {}) {
    if (!token || !/^\d+:[A-Za-z0-9_-]+$/.test(token)) throw new Error('TELEGRAM_TOKEN must be the bot token issued by @BotFather.');
    if (typeof fetchImpl !== 'function') throw new Error('TelegramClient needs Node 18+ (global fetch).');
    this.token = token;
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRateLimitRetries = maxRateLimitRetries;
    this.sleepImpl = sleepImpl;
  }

  async call(method, params = {}, { signal, timeoutMs = this.timeoutMs } = {}) {
    if (!/^[a-z][a-z0-9]*$/i.test(method)) throw new Error('Invalid Telegram API method.');
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new Error('Telegram request aborted.');
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => controller.abort(new Error(`Telegram timeout after ${timeoutMs} ms`)), timeoutMs);
      let failure;
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/bot${this.token}/${method}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
          signal: controller.signal,
        });
        let payload;
        try { payload = await response.json(); } catch {
          throw new TelegramError('Telegram returned an invalid JSON response.', { status: response.status, method });
        }
        if (!response.ok || payload?.ok !== true) {
          throw new TelegramError(redact(payload?.description || `Telegram HTTP ${response.status}`, [this.token]), {
            status: response.status,
            errorCode: payload?.error_code || response.status,
            retryAfter: Number(payload?.parameters?.retry_after) || undefined,
            method,
          });
        }
        return payload.result;
      } catch (error) {
        failure = error instanceof TelegramError ? error : new TelegramError(
          redact(`Telegram request failed: ${controller.signal.aborted ? controller.signal.reason?.message || 'aborted' : error.message}`, [this.token]),
          { method },
        );
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
      // Only an explicit 429 is retried. Never replay a send after a network/5xx
      // error: Telegram might already have delivered it (especially a key secret).
      if (failure.errorCode === 429 && attempt < this.maxRateLimitRetries && failure.retryAfter > 0 && failure.retryAfter <= 60) {
        await this.sleepImpl(failure.retryAfter * 1000, signal);
      } else throw failure;
    }
  }

  getMe() { return this.call('getMe'); }
  getWebhookInfo() { return this.call('getWebhookInfo'); }
  setMyCommands(commands) { return this.call('setMyCommands', { commands }); }
  sendMessage(chatId, text, options = {}) { return this.call('sendMessage', { ...options, chat_id: chatId, text }); }
  editMessageText(chatId, messageId, text, options = {}) {
    return this.call('editMessageText', { ...options, chat_id: chatId, message_id: messageId, text });
  }
  editMessageReplyMarkup(chatId, messageId, replyMarkup = { inline_keyboard: [] }) {
    return this.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
  }
  answerCallbackQuery(id, options = {}) { return this.call('answerCallbackQuery', { ...options, callback_query_id: id }); }

  /** Attach an interactive keyboard only to the last chunk of a long response. */
  async sendText(chatId, text, options = {}) {
    const chunks = splitText(text);
    let message;
    for (let i = 0; i < chunks.length; i += 1) {
      const part = { ...options };
      if (i !== chunks.length - 1) delete part.reply_markup;
      if (i !== 0) delete part.reply_parameters;
      message = await this.sendMessage(chatId, chunks[i], part);
    }
    return message;
  }

  async poll(handler, { signal, timeout = 30, offset = 0, onError = () => {} } = {}) {
    let nextOffset = offset;
    let failures = 0;
    while (!signal?.aborted) {
      let updates;
      try {
        updates = await this.call('getUpdates', {
          offset: nextOffset, timeout, limit: 50, allowed_updates: ['message', 'callback_query'],
        }, { signal, timeoutMs: Math.max(this.timeoutMs, (timeout + 10) * 1000) });
        if (!Array.isArray(updates)) throw new TelegramError('getUpdates did not return an array.');
        failures = 0;
      } catch (error) {
        if (signal?.aborted) break;
        // Invalid credentials and a second poller/webhook require operator action.
        if ([401, 409].includes(error.errorCode)) throw error;
        onError(error);
        const backoff = error.retryAfter > 0 ? error.retryAfter * 1000 : Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
        try { await this.sleepImpl(backoff, signal); } catch (sleepError) {
          if (!signal?.aborted) throw sleepError;
        }
        continue;
      }
      for (const update of updates) {
        if (signal?.aborted) break;
        if (!Number.isSafeInteger(update.update_id) || update.update_id < nextOffset) continue;
        try { await handler(update); } catch (error) { onError(error); }
        nextOffset = update.update_id + 1;
      }
    }
    return nextOffset;
  }
}

module.exports = { TelegramClient, TelegramError };
