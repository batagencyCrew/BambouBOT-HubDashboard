import path from 'node:path';
import { atomicWrite, readJSON, readOptional, writeJSON } from './storage.mjs';

function proxyAddress(text) {
  // WHATWG URL drops default ports. Capture the explicit authority port first.
  if (/[\x00-\x20\x7f\\]/.test(text)) throw new Error('Invalid proxy');
  const match = /^(http|https|socks5):\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^:/@?#]+):([0-9]+)\/?$/.exec(text);
  if (!match) throw new Error('Invalid proxy');
  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid proxy');
  const u = new URL(text);
  if (!u.hostname || u.search || u.hash || (u.pathname && u.pathname !== '/')) throw new Error('Invalid proxy');
  for (const credential of [u.username, u.password]) {
    const decoded = decodeURIComponent(credential);
    if (/[\x00-\x1f\x7f]/.test(decoded)) throw new Error('Invalid proxy');
  }
  return { scheme: match[1], hostname: u.hostname, port };
}

export function validateProxy(text) {
  const lines = text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith('#'));
  if (lines.length > 1000) throw new Error('Too many proxies');
  for (const line of lines) {
    proxyAddress(line);
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}
export function proxyText(proxies) {
  return proxies.map(p => {
    const { scheme, hostname, port } = proxyAddress(p.url);
    const credentials = p.username || p.password ? `${encodeURIComponent(p.username || '')}:${encodeURIComponent(p.password || '')}@` : '';
    return `${scheme}://${credentials}${hostname}:${port}`;
  }).join('\n') + (proxies.length ? '\n' : '');
}
export function localConfig(value) {
  const result = {};
  for (const key of ['ai_api_key', 'ai_preset_id']) {
    if (value[key] !== undefined) { if (typeof value[key] !== 'string') throw new Error('Invalid config'); result[key] = value[key]; }
  }
  if (value.number_of_workers !== undefined) {
    if (!Number.isInteger(value.number_of_workers) || value.number_of_workers < 0 || value.number_of_workers > 100) throw new Error('Invalid worker count');
    result.number_of_workers = value.number_of_workers;
  }
  return result;
}
export class ConfigSync {
  constructor(api, dir) { this.api = api; this.dir = dir; }
  async refresh() {
    let config = await this.api.request('/config');
    const checkpoint = await readJSON(path.join(this.dir, '.sync.json'));
    if (!checkpoint?.initialized || !config.local_sync_initialized) {
      let payload = { expected_revision: config.revision };
      if (!checkpoint?.initialized && !config.local_sync_initialized) {
        const local = await readJSON(path.join(this.dir, 'config.json'));
        const proxies = await readOptional(path.join(this.dir, 'proxies.txt'));
        if (local !== null) payload.config = localConfig(local);
        if (proxies !== null) payload.proxies_content = validateProxy(proxies);
      }
      try { config = await this.api.post('/local-sync', payload); }
      catch (error) {
        if (error.status !== 409) throw error;
        config = await this.api.request('/config');
        config = await this.api.post('/local-sync', { expected_revision: config.revision });
      }
    }
    if (!Number.isInteger(config.revision) || config.revision < 0 || !config.local_sync_initialized || !Array.isArray(config.proxies)) throw new Error('Invalid hub config');
    const selected = localConfig(config);
    const proxies = proxyText(config.proxies);
    await writeJSON(path.join(this.dir, 'config.json'), { ...selected, revision: config.revision });
    await atomicWrite(path.join(this.dir, 'proxies.txt'), proxies);
    await writeJSON(path.join(this.dir, '.sync.json'), { initialized: true, revision: config.revision });
    return { ...selected, proxies: config.proxies, revision: config.revision };
  }
}
