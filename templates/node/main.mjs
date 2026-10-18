import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { API, safeError } from './lib/api.mjs';
import { privateDir } from './lib/storage.mjs';
import { ConfigSync } from './lib/config.mjs';
import { Supervisor } from './lib/supervisor.mjs';
import { Backups } from './lib/backup.mjs';

async function main() {
const api = new API(process.env.HUB_URL, process.env.HUB_AGENT_TOKEN);
const runtime = path.resolve(process.env.HUB_RUNTIME_DIR || './runtime');
await privateDir(runtime);
const stateDir = path.resolve(process.env.HUB_STATE_DIR || runtime);
await privateDir(stateDir);
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort());
const sync = new ConfigSync(api, runtime);
let syncing;
const refresh = () => syncing ||= sync.refresh().finally(() => { syncing = null; });
let reporting = false;
const supervisor = new Supervisor(stateDir, workerId => {
  if (reporting) return;
  reporting = true;
  api.post('/errors', { worker_id: workerId, level: 'error', message: 'Worker hook or process failed' }).catch(() => {}).finally(() => { setTimeout(() => { reporting = false; }, 5000).unref(); });
});
await supervisor.init();
function positive(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}
const backupSource = process.env.HUB_BACKUP_DIR || process.env.HUB_BACKUP_SOURCE;
const backups = new Backups(api, runtime, backupSource ? path.resolve(backupSource) : null, {
  stateDir,
  maxBytes: positive('HUB_BACKUP_MAX_BYTES', 1073741824), timeout: positive('HUB_BACKUP_TIMEOUT_MS', 300000),
  ...(process.env.HUB_BACKUP_TEMP ? { tempRoot: path.resolve(process.env.HUB_BACKUP_TEMP) } : {}),
});
await backups.init();
let recovered = false; let configured = false;
async function loop(interval, action) {
  while (!controller.signal.aborted) {
    try { await action(); } catch (error) { console.error(safeError(error)); }
    try { await sleep(interval, null, { signal: controller.signal }); } catch { break; }
  }
}
const loops = [
  loop(30000, async () => {
    const config = await refresh();
    await supervisor.exclusive(async () => { await supervisor.configure(config); configured = true; });
  }),
  loop(15000, async () => {
    const workers = supervisor.snapshot();
    const degraded = workers.some(w => w.status === 'error' || (supervisor.running && w.status === 'stopped'));
    const result = await api.post('/heartbeat', { status: degraded ? 'degraded' : 'healthy', workers });
    if (!recovered) await supervisor.exclusive(async () => {
      if (recovered) return;
      if (!configured) { await supervisor.configure(await refresh()); configured = true; }
      await supervisor.action(result.desired_state === 'running' ? 'start' : 'stop');
      recovered = true;
    });
  }),
  loop(5000, async () => {
    // Initial desired-state recovery must precede explicit queued commands.
    if (!recovered) return;
    const commands = await api.request('/commands');
    for (const command of commands) await supervisor.exclusive(() => supervisor.command(command, refresh, (id, result) => api.post(`/commands/${encodeURIComponent(id)}/ack`, result)));
    await supervisor.exclusive(() => supervisor.reconcile());
  }),
  loop(10000, () => backups.tick(controller.signal)),
];
await Promise.all(loops);
await supervisor.exclusive(() => supervisor.action('stop'));
}

main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
