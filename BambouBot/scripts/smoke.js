'use strict';

/**
 * BambouAI live smoke test.
 *
 * Usage:
 *   npm run smoke                 # read-only checks (settings come from .env)
 *   npm run smoke -- --write      # also mutates (creates and then removes a test preset/key)
 * Optional env:
 *   BAMBOU_BASE_URL       default https://bambouaibot.com (use the space subdomain if any)
 *   BAMBOU_ASSISTANT_KEY  bbk_… key to additionally test /api/assistant/*
 *
 * Read-only by default so it is safe on a production space.
 */

const {
  BambouStudio,
  BambouAssistant,
  BambouError,
  DEFAULT_BASE_URL,
} = require('../src/clients/bambou');
const { readEnvironment } = require('../src/config');

// Settings come from BambouBot's .env (real environment variables win).
Object.assign(process.env, { ...readEnvironment().values, ...process.env });

const WRITE = process.argv.includes('--write');
const LOGIN_KEY = process.env.BAMBOU_LOGIN_KEY;
const BASE_URL = process.env.BAMBOU_BASE_URL || DEFAULT_BASE_URL;
const ASSISTANT_KEY = process.env.BAMBOU_ASSISTANT_KEY;

if (!LOGIN_KEY) {
  console.error('Set BAMBOU_LOGIN_KEY (the studio login key). Optional: --write, BAMBOU_ASSISTANT_KEY, BAMBOU_BASE_URL.');
  process.exit(1);
}

const studio = new BambouStudio({ baseUrl: BASE_URL, loginKey: LOGIN_KEY });
const tag = `smoke-${Math.random().toString(36).slice(2, 8)}`;

function line(name, ok, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
}

async function step(name, fn) {
  try {
    const out = await fn();
    line(name, true);
    return out;
  } catch (error) {
    const detail = error instanceof BambouError
      ? `HTTP ${error.status}${error.retryAfter ? ` retry-after=${error.retryAfter}s` : ''} ${error.message}`.trim()
      : error.message;
    line(name, false, detail);
    return undefined;
  }
}

(async () => {
  console.log(`BambouAI smoke test — ${BASE_URL}${WRITE ? ' (WRITE enabled)' : ' (read-only)'}\n`);

  // 1. auth
  const login = await step('login (studio login key)', () => studio.login());
  if (!login?.authenticated) {
    console.error('\nLogin failed — check BAMBOU_LOGIN_KEY / BAMBOU_BASE_URL. (5 failures / 10 min = 429.)');
    process.exit(1);
  }
  await step('session check', async () => {
    const s = await studio.session();
    if (!s.authenticated) throw new Error('session not authenticated');
  });

  // 2. studio config
  const config = await step('GET /api/studio/config', () => studio.getConfig());
  if (config) {
    console.log(`      → ${config.presets?.length ?? 0} preset(s), ${config.accounts?.length ?? 0} account(s)`
      + `, engine=${config.engine?.provider || '?'}, snapchat=${config.snapchat ? 'yes' : 'no'}, extension=${config.extension ? 'yes' : 'no'}`);
  }

  // 3. presets + URLs
  if (config) {
    await step('presets have ids/names', () => {
      const bad = (config.presets || []).filter((p) => !p.id || !p.name);
      if (bad.length) throw new Error(`${bad.length} preset(s) missing id/name`);
      console.log(`      → ${(config.presets || []).map((p) => `${p.id}:${p.name}${p.archivedAt ? ' (archived)' : ''}`).join(', ').slice(0, 300)}`);
    });
    await step('URLs visible per preset', () => {
      for (const preset of config.presets || []) {
        const items = preset.urls?.items || [];
        const active = items.filter((i) => i.enabled && (i.url || i.platform === 'snap'));
        if (items.length) {
          console.log(`      → [${preset.id}] ${items.length} url item(s), ${active.length} active: `
            + items.map((i) => `${i.platform}${i.url ? ':' + String(i.url).slice(0, 40) : ''}${i.enabled ? '' : ' (off)'}`).join(' | ').slice(0, 240));
        }
      }
    });
  }

  // 4. API keys list
  const keys = await step('GET /api/studio/api-keys', () => studio.listApiKeys());
  if (keys) {
    console.log(`      → ${keys.length} key(s): ${keys.map((k) => `${k.label} [${k.id.slice(0, 11)}…, rpm ${k.rpm}${k.disabled ? ', paused' : ''}${k.revokedAt ? ', revoked' : ''}]`).join('; ').slice(0, 300)}`);
  }

  // 5. engine profiles
  await step('GET /api/studio/engine-profiles', async () => {
    const profiles = await studio.listEngineProfiles();
    const list = Array.isArray(profiles) ? profiles : profiles?.profiles || profiles?.engines || [];
    console.log(`      → ${Array.isArray(list) ? list.length : '?'} profile(s)`);
  });

  // 6. media library
  await step('GET /api/media/library', async () => {
    const lib = await studio.listMediaLibrary();
    const vaults = lib?.vaults || [];
    const items = Array.isArray(lib?.items) ? lib.items : [];
    const perVault = new Map();
    for (const item of items) perVault.set(item.vaultId, (perVault.get(item.vaultId) || 0) + 1);
    console.log(`      → ${vaults.length} vault(s), ${items.length} item(s): ${vaults.map((v) => `${v.name} (${perVault.get(v.id) || 0})`).join(', ').slice(0, 240)}`);
  });

  // 7. supervision internals (may be absent on some spaces)
  await step('GET /api/dashboard (internal)', async () => {
    const dash = await studio.getDashboard();
    const t = dash?.totals || {};
    console.log(`      → accounts=${t.accounts ?? '?'}, online=${t.online ?? '?'}, conversations=${t.conversations ?? '?'}, unread=${t.unread ?? '?'}`);
  });
  await step('GET /api/studio/blocked-messages (internal)', async () => {
    const blocked = await studio.getBlockedMessages();
    console.log(`      → ${blocked?.total ?? blocked?.items?.length ?? 0} blocked message(s)`);
  });

  // 8. assistant key surface, when provided
  if (ASSISTANT_KEY) {
    const assistant = new BambouAssistant({ apiKey: ASSISTANT_KEY, baseUrl: BASE_URL });
    await step('GET /api/assistant/presets (bbk_)', async () => {
      const presets = await assistant.listPresets();
      console.log(`      → ${(presets.presets || []).length} preset(s) allowed for this key`);
    });
    await step('POST /api/assistant/generate (bbk_)', async () => {
      const presets = await assistant.listPresets();
      const first = (presets.presets || [])[0];
      if (!first) throw new Error('no preset allowed for this key');
      const result = await assistant.generate({
        presetId: first.id,
        messages: [{ role: 'user', content: 'Salut ! Ça va ?' }],
      });
      const reply = result?.reply ?? result?.message ?? JSON.stringify(result).slice(0, 160);
      console.log(`      → [${first.id}] ${String(reply).slice(0, 200)}`);
    });
  } else {
    console.log('SKIP  assistant key surface (set BAMBOU_ASSISTANT_KEY to test it)');
  }

  // ---- write checks -------------------------------------------------------
  if (WRITE && config) {
    console.log('\n-- write checks (create + remove a test preset and a test key) --');

    let presetId = null;
    await step('createPreset (clone)', async () => {
      const created = await studio.createPreset({ name: `[smoke] ${tag}`, group: tag });
      presetId = created.id;
      console.log(`      → created preset ${created.id}`);
    });

    if (presetId) {
      await step('setPrimaryUrl + read back', async () => {
        await studio.setPrimaryUrl(presetId, { url: 'https://example.com/smoke', platform: 'Other', spaceBeforeDotCom: true });
        const urls = await studio.listUrls(presetId);
        if (!(urls.length === 1 && urls[0].url === 'https://example.com/smoke' && urls[0].spaceBeforeDotCom)) {
          throw new Error(`unexpected urls after setPrimaryUrl: ${JSON.stringify(urls)}`);
        }
      });

      await step('exportPreset', async () => {
        const doc = await studio.exportPreset(presetId);
        if (!doc || typeof doc !== 'object') throw new Error('empty export');
        console.log(`      → export keys: ${Object.keys(doc).slice(0, 8).join(', ')}`);
      });

      await step('archivePreset + restore', async () => {
        await studio.archivePreset(presetId);
        if (!(await studio.getPreset(presetId)).archivedAt) throw new Error('archivedAt not set');
        await studio.restorePreset(presetId);
        if ((await studio.getPreset(presetId)).archivedAt) throw new Error('archivedAt not cleared');
      });

      await step('deletePreset (cleanup)', async () => {
        await studio.deletePreset(presetId);
        const still = (await studio.listPresets()).some((p) => p.id === presetId);
        if (still) throw new Error('preset still present after delete');
      });
    }

    let keyId = null;
    await step('createApiKey + pause/resume/revoke (cleanup)', async () => {
      const made = await studio.createApiKey({ label: `[smoke] ${tag}`, rpm: 5, maxConcurrent: 1, dailyLimit: 50 });
      keyId = made.id;
      if (!String(made.key || '').startsWith('bbk_')) throw new Error('no bbk_ key returned');
      await studio.pauseApiKey(keyId);
      await studio.resumeApiKey(keyId);
      const revoked = await studio.revokeApiKey(keyId);
      if (!revoked.revokedAt) throw new Error('revokedAt missing');
      console.log(`      → key ${keyId} created, paused, resumed, revoked`);
    });
  } else if (!WRITE) {
    console.log('\n(write checks skipped — pass --write to exercise preset + key creation/cleanup)');
  }

  console.log(`\nDone.${process.exitCode ? ' Some steps FAILed — see above.' : ''}`);
})().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exit(1);
});
