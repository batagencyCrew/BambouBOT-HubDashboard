#!/usr/bin/env node
'use strict';

/**
 * BambouBot: the BambouAI Discord and Telegram bots in one process.
 *
 *   node index.js                    # every platform with a token in .env
 *   node index.js --only discord     # just one (repeatable / comma-separated)
 *
 * See README.md for setup.
 */

const { loadConfig, secretsOf, ConfigError } = require('./src/config');
const { createApp, runApp } = require('./src/app');
const { errorText } = require('./src/core/errors');

function parseArgs(argv) {
  const only = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') only.push(...String(argv[++i] || '').split(','));
    else if (arg.startsWith('--only=')) only.push(...arg.slice(7).split(','));
    else if (arg === '-h' || arg === '--help') return { help: true };
    else throw new ConfigError([`Unknown argument: ${arg}`]);
  }
  return { only: only.map((s) => s.trim().toLowerCase()).filter(Boolean) };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('Usage: node index.js [--only discord|telegram]');
    return 0;
  }
  const config = loadConfig({ only: args.only });
  const app = createApp(config);
  console.log(`[app] starting: ${app.platforms.map((p) => p.name).join(', ')} — access file ${config.accessFile}`);

  const controller = new AbortController();
  const stop = (signal) => {
    console.log(`[app] ${signal} received — shutting down`);
    controller.abort();
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));

  const { failed } = await runApp(app, { signal: controller.signal });
  if (controller.signal.aborted) return 0;
  return failed.length ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    let secrets = [];
    try { secrets = secretsOf(loadConfig()); } catch { /* config itself is the problem */ }
    console.error(error instanceof ConfigError ? error.message : `BambouBot failed: ${errorText(error, secrets)}`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
