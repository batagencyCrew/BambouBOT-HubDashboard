'use strict';
/**
 * <SITE NAME> automation — Bambou hub starter (Node.js 18+).
 *
 * Copy this folder, then replace every block marked TODO. Workers, logs, costs,
 * proxy health, issues, pause/resume, live worker count, config reload and
 * graceful stop are already wired to the hub.
 *
 * Run under the agent (recommended):
 *   bambou-agent --script-dir . --command "node main.js" \
 *       --file config.json --file .env --file proxies.txt
 *
 * Run alone for local testing (telemetry is dropped without an agent):
 *   node main.js
 */

const fs = require('fs');
const path = require('path');

// If the SDK is not installed as a package, point at a copy of sdk/node.
const { hub } = require(process.env.BAMBOUHUB_SDK || path.join(__dirname, 'vendor', 'bambouhub'));

const CONFIG_FILE = path.join(__dirname, 'config.json');
const ENV_FILE = path.join(__dirname, '.env');
const PROXIES_FILE = path.join(__dirname, 'proxies.txt');

// ---------------------------------------------------------------------------
// Configuration (config.json, .env, proxies.txt are editable from the hub)
// ---------------------------------------------------------------------------

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const values = {};
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '');
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return values;
}

function readProxies(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.split('#')[0].trim()).filter(Boolean);
}

const settings = {
  reload() {
    this.config = fs.existsSync(CONFIG_FILE) ? JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) : {};
    this.env = readEnv(ENV_FILE);
    this.proxies = readProxies(PROXIES_FILE);
    this.workers = Number(this.config.workers ?? 2);
    this.taskDelayMs = Number(this.config.task_delay_seconds ?? 2) * 1000;
    // TODO: read the settings your script needs, e.g.
    // this.targetUrl = this.config.target_url;
    // this.apiKey = this.env.AI_API_KEY || '';
  },
};
settings.reload();

// ---------------------------------------------------------------------------
// Prices: declare once, then hub.addCost(null, { provider }) anywhere uses them
// ---------------------------------------------------------------------------

// TODO: set your real unit prices (or pass an exact amount to addCost each time).
hub.setPrice('captcha-provider', 0.0008, { unit: 'solve' });
hub.setPrice('ai-provider', 0.0004, { unit: 'request' });

// ---------------------------------------------------------------------------
// Your automation
// ---------------------------------------------------------------------------

class TaskFailed extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const proxyLabel = (proxy) => `proxy-${settings.proxies.indexOf(proxy) + 1}`;

function pickProxy(index) {
  return settings.proxies.length ? settings.proxies[index % settings.proxies.length] : null;
}

async function openSession(workerName, proxy) {
  // TODO: create your browser/page/HTTP session for one worker
  // (Puppeteer browser, Playwright page, axios instance, ...). Return it.
  return null;
}

async function closeSession(session) {
  // TODO: close what openSession created.
}

async function doTask(worker, session, proxy) {
  // TODO: one unit of work (one chat, one signup, one post, ...).
  // Report costs where money is spent and proxy results where you learn them.
  // --- simulation: delete from here ----------------------------------------
  await sleep(500 + Math.random() * 1000);
  if (Math.random() < 0.05) {
    if (proxy) hub.proxy(proxyLabel(proxy), 'blocked', { url: proxy, detail: 'HTTP 403 (simulated)' });
    throw new TaskFailed('target page refused the request (simulated)');
  }
  hub.addCost(null, { provider: 'captcha-provider', category: 'captcha', worker });
  hub.addCost(null, { provider: 'ai-provider', category: 'ai', quantity: 3, worker });
  if (proxy) hub.proxy(proxyLabel(proxy), 'ok', { url: proxy });
  return { links_sent: Math.floor(Math.random() * 3), messages: 3 + Math.floor(Math.random() * 10) };
  // --- simulation: delete to here ------------------------------------------
}

// ---------------------------------------------------------------------------
// Worker loop (normally no changes needed)
// ---------------------------------------------------------------------------

async function workerLoop(index, control) {
  const name = `worker-${index + 1}`;
  const w = hub.worker(name);
  const proxy = pickProxy(index);
  let failures = 0;
  let session = null;
  try {
    session = await openSession(name, proxy);
    while (!control.stop && !hub.stopping) {
      if (hub.paused) {
        w.idle('paused from the hub');
        await hub.waitIfPaused();
        continue;
      }
      w.running();
      const started = Date.now();
      let result;
      try {
        result = await doTask(w, session, proxy);
      } catch (error) {
        if (!(error instanceof TaskFailed)) throw error;
        failures += 1;
        w.log.warning(`Task failed: ${error.message}`);
        hub.count('tasks_failed', 1, { worker: w });
        if (failures >= 5) {
          hub.issue(`${name} keeps failing`, `${failures} failures in a row; last: ${error.message}`, { key: `failing:${name}`, worker: w });
          w.error(`${failures} failures in a row`);
          await sleep(30_000);
        }
        continue;
      }
      failures = 0;
      w.taskDone();
      hub.count('tasks_completed', 1, { worker: w });
      hub.timing('task_seconds', (Date.now() - started) / 1000, { worker: w });
      for (const [metric, value] of Object.entries(result)) hub.count(metric, value, { worker: w });
      w.log.info(`Task finished: ${JSON.stringify(result)}`);
      await sleep(settings.taskDelayMs);
    }
    w.stopped();
  } catch (error) {
    w.log.error(`${name} crashed: ${error.message}`, { error });
    w.error(error.message);
    hub.issue(`${name} crashed`, "See the worker's logs for the stack trace.", { severity: 'critical', key: `crash:${name}`, worker: w });
  } finally {
    await closeSession(session).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Hub commands (buttons in the dashboard, /hub commands in the bot)
// ---------------------------------------------------------------------------

hub.onCommand('refresh_sessions', async () => {
  // TODO: implement (e.g. set a flag each worker checks), or delete this command.
  return 'Not implemented in this script yet';
}, { description: "Close and reopen every worker's session" });

hub.onConfigChange((file) => {
  settings.reload();
  hub.info(`Reloaded settings after hub edit of ${file} (workers=${settings.workers})`);
});

// ---------------------------------------------------------------------------
// Main: keeps the number of workers equal to config / hub "Set workers"
// ---------------------------------------------------------------------------

async function main() {
  hub.captureConsole();
  process.on('SIGTERM', () => { hub.stopping = true; });
  process.on('SIGINT', () => { hub.stopping = true; });
  hub.info(`Starting with ${settings.workers} workers and ${settings.proxies.length} proxies`);

  // TODO: report provider balances if you can query them, e.g. every 10 minutes:
  // hub.balance('captcha-provider', await captchaClient.balance(), { low: 5 });

  const running = new Map();   // index -> { promise, control }
  while (!hub.stopping) {
    const wanted = hub.desiredWorkers ?? settings.workers;
    for (let i = running.size; i < wanted; i += 1) {
      const control = { stop: false };
      running.set(i, { control, promise: workerLoop(i, control) });
    }
    for (const i of [...running.keys()].sort((a, b) => b - a)) {
      if (i < wanted) break;
      running.get(i).control.stop = true;
      running.delete(i);
      hub.removeWorker(`worker-${i + 1}`);
    }
    await sleep(1000);
  }
  hub.info('Stopping workers');
  for (const { control } of running.values()) control.stop = true;
  await Promise.race([Promise.all([...running.values()].map((r) => r.promise)), sleep(15_000)]);
  await hub.close();
}

main().catch(async (error) => {
  hub.critical(`Script crashed: ${error.message}`, { error });
  await hub.close();
  process.exit(1);
});
