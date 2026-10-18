import * as fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { HttpError } from './api.mjs';
import { privateDir, readJSON, writeJSON } from './storage.mjs';

const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
export async function archive(source, runtime, { maxBytes, timeout, signal, tempRoot = os.tmpdir(), stateDir = runtime }) {
  source = await fs.realpath(source);
  const tempBase = await fs.realpath(tempRoot);
  if (inside(source, tempBase)) throw new Error('Backup temp must be outside source');
  const dir = await fs.mkdtemp(path.join(tempBase, 'hub-backup-'));
  await fs.chmod(dir, 0o700);
  const file = path.join(dir, 'code.tar.gz');
  const excludes = [];
  const tempExcludes = [];
  runtime = await fs.realpath(runtime);
  stateDir = await fs.realpath(stateDir);
  for (const excluded of new Set([runtime, stateDir])) {
    if (inside(source, excluded) && excluded !== source) excludes.push(`--exclude=./${path.relative(source, excluded)}`);
  }
  // Runtime may intentionally be the codebase root (existing config/proxies).
  if (source === runtime || source === stateDir) for (const name of ['.sync.json', 'workers.json', 'commands.json', 'backups.json', 'backup-config.json']) {
    excludes.push(`--exclude=./${name}`);
    tempExcludes.push(`--exclude=./${name}.*.tmp`);
  }
  if (source === runtime) for (const name of ['config.json', 'proxies.txt']) tempExcludes.push(`--exclude=./${name}.*.tmp`);
  const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
  let child;
  try {
    // tar does not dereference symbolic links unless explicitly requested. No shell.
    child = spawn('tar', ['-czf', '-', '--no-wildcards', ...excludes, '--wildcards', ...tempExcludes, '--', '.'], { cwd: source, stdio: ['ignore', 'pipe', 'ignore'], signal: abort });
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error('Archive failed')));
    });
    let size = 0;
    const limiter = new Transform({ transform(chunk, encoding, callback) {
      size += chunk.length;
      callback(size > maxBytes ? new Error('Archive quota exceeded') : null, chunk);
    } });
    await Promise.all([exited, pipeline(child.stdout, limiter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), { signal: abort })]);
    return { file, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  } catch (error) {
    child?.kill('SIGKILL');
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function uploadFile(api, file, { filename = path.basename(file), source = 'direct', requestId, maxBytes = 1073741824, timeout = 300000, signal } = {}) {
  if (!filename || filename.length > 200 || /[\\/\x00-\x1f\x7f]/.test(filename) || filename.includes('..') || !['direct', 'scheduled', 'on_demand'].includes(source) || (source === 'on_demand' && !requestId)) throw new Error('Invalid upload metadata');
  // Open once without following links; verify the opened descriptor rather than racing stat/open.
  const { constants } = await import('node:fs');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let stream;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Upload quota exceeded');
    stream = handle.createReadStream({ autoClose: false, ...(stat.size ? { start: 0, end: stat.size - 1 } : {}) });
    const query = new URLSearchParams({ filename, source, ...(requestId ? { request_id: requestId } : {}) });
    return await api.request('/backups/upload?' + query, { method: 'POST', body: stream, signal, timeout, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stat.size) } });
  } finally { stream?.destroy(); await handle.close(); }
}

export class Backups {
  constructor(api, runtime, source, options = {}) {
    this.api = api; this.runtime = runtime; this.source = source;
    this.options = { maxBytes: 1073741824, timeout: 300000, ...options };
    this.file = path.join(options.stateDir || runtime, 'backups.json');
  }
  async init() { await privateDir(this.runtime); this.state = await readJSON(this.file, { requests: {}, lastUpload: null, lastAttempt: null }); }
  save() { return writeJSON(this.file, this.state); }
  async tick(signal) {
    const config = await this.api.request('/backup-config');
    const safeConfig = Object.fromEntries(['enabled', 'interval_minutes', 'destination_ids', 'agent_configured', 'agent_last_seen', 'next_backup_at'].filter(key => Object.hasOwn(config, key)).map(key => [key, config[key]]));
    await writeJSON(path.join(this.runtime, 'backup-config.json'), safeConfig);
    const interval = Math.max(15, config.interval_minutes || 1440) * 60000;
    const next = this.source && config.enabled ? new Date((this.state.lastAttempt || 0) + interval).toISOString() : null;
    await this.api.post('/backup-status', { configured: Boolean(this.source), next_backup_at: next });
    const requests = await this.api.request('/backup-requests');
    for (const [id, result] of Object.entries(this.state.requests)) {
      if (result.status === 'unknown' && !requests.some(r => r.id === id)) result.status = 'reconciled';
    }
    await this.save();
    for (const request of requests) {
      const previous = this.state.requests[request.id];
      if (previous?.status === 'accepted' || previous?.status === 'reconciled') continue;
      if (previous?.status === 'failed') {
        await this.api.post(`/backup-requests/${encodeURIComponent(request.id)}/ack`, { status: 'failed', message: 'Local backup failed' });
        continue;
      }
      if (!this.source) {
        this.state.requests[request.id] = { status: 'failed' }; await this.save();
        await this.api.post(`/backup-requests/${encodeURIComponent(request.id)}/ack`, { status: 'failed', message: 'Local backup source not configured' });
      } else await this.run('on_demand', request.id, signal);
    }
    if (this.source && config.enabled && Date.now() - (this.state.lastAttempt || 0) >= interval) await this.run('scheduled', null, signal);
  }
  async run(source, requestId, signal) {
    let packed; let attempted = false;
    try {
      this.state.lastAttempt = Date.now(); await this.save();
      packed = await archive(this.source, this.runtime, { ...this.options, signal });
      // Persist uncertainty BEFORE sending bytes, including across a process crash.
      if (requestId) this.state.requests[requestId] = { status: 'unknown' };
      this.state.lastOutcome = 'unknown'; await this.save();
      attempted = true;
      const result = await uploadFile(this.api, packed.file, { ...this.options, source, requestId, signal });
      // Acceptance is not cloud-transfer success. Persist this BEFORE any other work.
      this.state.lastUpload = new Date().toISOString();
      this.state.lastOutcome = 'accepted'; this.state.lastBackupId = result.id;
      if (requestId) this.state.requests[requestId] = { status: 'accepted', backupId: result.id };
      await this.save();
    } catch (error) {
      const definite = !attempted || (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 409);
      // Never overwrite a known accepted outcome when subsequent persistence fails.
      if (this.state.lastOutcome !== 'accepted' || !attempted) {
        this.state.lastOutcome = definite ? 'failed' : 'unknown';
        if (requestId) this.state.requests[requestId] = { status: definite ? 'failed' : 'unknown' };
      }
      await this.save();
      if (requestId && definite) await this.api.post(`/backup-requests/${encodeURIComponent(requestId)}/ack`, { status: 'failed', message: 'Local backup failed' });
    } finally { await packed?.cleanup(); }
  }
}
