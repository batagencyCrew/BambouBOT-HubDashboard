'use strict';

/**
 * Hub → chat alert delivery.
 *
 * Every `intervalMs` the poller asks the hub for pending deliveries
 * (GET /api/bot/deliveries — the service token alone, no X-Bot-User), sends each
 * one to the channel the hub chose, then reports the outcome back
 * (POST /api/bot/deliveries/{id} {ok, error}). Routing belongs to the hub: the
 * poller only ever sends where `platform` + `channel` say.
 *
 * Channel formats: discord `guildId:channelId`, telegram `chatId` (optional
 * `chatId:threadId`). Both are plain strings resolved by the caller's `send`.
 *
 * Resilience: the hub being down never throws out of the loop — failures back off
 * (interval × 2^failures, capped at 5 min) and every send is awaited, so one bad
 * channel cannot skip the rest. A send failure is reported `ok:false` and the hub
 * retries it later. `stop()` settles quickly; the loop never keeps the process alive.
 */

const { setTimeout: defaultDelay } = require('node:timers/promises');
const { errorText } = require('../core/errors');
const { shorten } = require('../core/format');

const MAX_BACKOFF_MS = 5 * 60_000;

/** Alert → message text. Plain text: both platforms accept it. */
function formatAlert(delivery) {
  const icon = delivery.severity === 'critical' ? '🔴' : delivery.severity === 'warning' ? '🟡' : '🔵';
  const lines = [`${icon} ${shorten(delivery.title || 'Hub alert', 200)}`];
  if (delivery.site_name) lines.push(`Site: ${delivery.site_name}`);
  if (delivery.body) lines.push(shorten(delivery.body, 1500));
  const status = delivery.status && delivery.status !== 'open' ? `Status: ${delivery.status}` : '';
  if (status) lines.push(status);
  lines.push(`Alert ${String(delivery.alert_id || delivery.id).slice(0, 8)}`);
  return lines.join('\n');
}

function parseChannel(delivery) {
  const chatId = String(delivery.channel ?? '').trim();
  if (!chatId) return null;
  if (delivery.platform === 'discord') {
    const [guildId, channelId] = chatId.split(':');
    if (!guildId || !channelId) return null;
    return { platform: 'discord', guildId, channelId };
  }
  if (delivery.platform === 'telegram') {
    const [chat, thread] = chatId.split(':');
    if (!chat) return null;
    return { platform: 'telegram', chatId: chat, threadId: thread || null };
  }
  return null;
}

/**
 * Build the poller without starting it.
 * @param {object} opts
 * @param {object} opts.hub         HubService (deliveries/reportDelivery)
 * @param {Function} opts.send      async ({platform, channel, text}) => void — throws on failure
 * @param {number} [opts.intervalMs=20000]
 * @param {object} [opts.logger]
 * @param {Function} [opts.secrets] () => secret strings for redaction
 */
function createHubAlertPoller({ hub, send, intervalMs = 20_000, logger = console, secrets = () => [], sleepImpl = defaultDelay } = {}) {
  if (!hub || typeof send !== 'function') throw new Error('The hub alert poller needs a hub service and a send function.');
  const state = { running: false, failures: 0, deliveries: null };
  const sleep = (ms, signal) => (signal ? sleepImpl(ms, undefined, { signal }).catch(() => {}) : sleepImpl(ms));
  const backoff = () => Math.min(MAX_BACKOFF_MS, intervalMs * 2 ** Math.min(state.failures, 5));

  /** One pass: fetch the pending deliveries, send, report. Returns the count sent. */
  async function deliverOnce() {
    const list = await hub.deliveries(50);
    let sent = 0;
    for (const delivery of Array.isArray(list) ? list : []) {
      const target = parseChannel(delivery);
      let failure = null;
      if (!target) failure = `Unknown delivery target ${delivery.platform}:${delivery.channel}`;
      else {
        try {
          await send({ ...target, text: formatAlert(delivery), delivery });
          sent += 1;
        } catch (error) {
          failure = errorText(error, secrets()).slice(0, 500) || 'send failed';
        }
      }
      try {
        await hub.reportDelivery(delivery.id, !failure, failure);
      } catch (error) {
        // The hub will show the delivery again; never crash, never spin.
        logger.warn(`[hub-alerts] could not report delivery ${delivery.id}: ${errorText(error, secrets())}`);
      }
      if (failure) logger.warn(`[hub-alerts] delivery ${delivery.id} failed: ${failure}`);
    }
    state.deliveries = { lastCount: sent, at: new Date().toISOString() };
    return sent;
  }

  async function loop(signal) {
    state.running = true;
    try {
      while (!signal?.aborted) {
        try {
          await deliverOnce();
          state.failures = 0;
        } catch (error) {
          if (signal?.aborted) break;
          state.failures += 1;
          logger.warn(`[hub-alerts] poll failed (${state.failures}): ${errorText(error, secrets())}`);
        }
        await sleep(backoff(), signal);
      }
    } finally {
      state.running = false;
    }
  }

  return {
    state,
    deliverOnce,
    /** Start in the background; the returned promise settles when stopped. */
    start(signal) {
      if (state.running) return state.promise;
      state.promise = loop(signal);
      return state.promise;
    },
    async stop() { state.running = false; },
    get failures() { return state.failures; },
  };
}

module.exports = { createHubAlertPoller, formatAlert, parseChannel, MAX_BACKOFF_MS };
