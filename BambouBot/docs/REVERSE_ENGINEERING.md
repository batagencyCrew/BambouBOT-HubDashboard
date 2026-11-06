# BambouAI — Reverse Engineering Report

**Date:** 2026-10-18
**Target:** `bambouaibot.com` (note: `bamboubotai.com` does not exist — NXDOMAIN; the real host
is **bambouaibot.com**, with per-operator spaces also served on subdomains, e.g. `pablo.bambouaibot.com`)
**Goal:** programmatic create/manage of **Presets, URLs, API Keys** (plus media, engine, live
supervision) from a Discord bot.

---

## TL;DR

BambouAI is a closed-source studio served as a single-page app, **but it ships its own machine
contract** (`/openapi.json` + `/api-docs.html`, in French) and the dashboard talks to a clean
JSON API. No scraping, no obfuscation, no CSRF token. Everything the Discord bot needs is a
plain HTTP call:

| Layer | Base | Auth | What it manages |
|---|---|---|---|
| **Studio session** | `https://bambouaibot.com` | `POST /api/login {"key":"<login key>"}` → HttpOnly cookie `bambou_session` | **Presets, URLs, API keys**, media, engine, conversations, accounts, live supervision |
| **Assistant key** | same host | `Authorization: Bearer bbk_…` | Generation only: `GET /api/assistant/presets`, `POST /api/assistant/generate` — what the chat bots should use |
| **Extension key** | same host | `X-Bambou-Extension-Key: …` | `GET /api/extension/config`, `POST /api/extension/generate` (browser-extension surface) |

The three keys are distinct credentials: the **login key** opens the studio session (management),
**bbk_ keys** are created inside Settings → API Keys and are the ones you distribute to bots,
the **extension key** belongs to the browser-extension integration.

**Key structural finding:** there is no separate "URL resource". The links the bots send live
**inside each preset** — `preset.urls.items[]` — and presets live inside one big **studio config
document**: `GET /api/studio/config` → mutate → `PUT /api/studio/config` (whole-document replace,
no partial updates, no merge). A client must therefore do read-modify-write; `bambou_client.js`
does it safely (serialised, fresh GET per write).

**Integration recommendation:** use `BambouStudio` (login key, cookie) from the Discord bot for
managing presets/URLs/keys; use `BambouAssistant` (bbk_ key) in the actual chatting workers.
Both ship in [`bambou_client.js`](bambou_client.js), zero dependencies, Node 18+.

---

## 1. How it was found / provenance

1. The workspace already contained a partial mirror of the site (`landing.html`, `app.js`,
   `openapi.json`, `api-docs.*`). All files were re-fetched live on 2026-10-18 and verified
   byte-identical:
   - `/app.js?v=persona-en-2` — md5 `617d54cc0548ffb806f87e49036ca5e2` (328 KB, the whole
     dashboard SPA in one file, unminified enough to read)
   - `/openapi.json` — md5 `f2a6f886b63657a21de0f0f3ddcf734d`, version `2026-10-04`
   - `/api-docs.html` + `/api-docs.js` — the official French curl reference
2. Auth header/route patterns were extracted from the bundle (`fetch` wrapper `api()` at the top
   of `app.js`), plus every `api("<path>")` call — that is how the internal routes not present
   in the OpenAPI (accounts, mailboxes, Snapchat fleet, media vaults/days, blocked messages,
   `import-section`) were recovered.
3. The full preset field inventory was recovered by extracting the editor's data paths
   (`identity.name`, `urls.items.${index}.url`, …) — 175 paths, see
   [`preset_schema.md`](preset_schema.md).
4. The client was validated against a mock implementing the observed contract
   (`node mock_test.js` — all checks pass, including cookie handling, whole-doc read-modify-write
   under concurrency, and automatic re-login after session loss).

Server-side details that CANNOT be verified without credentials are listed in §9.

---

## 2. Authentication model

### 2.1 Studio session (management — presets, URLs, keys, everything)

```
POST /api/login          body: {"key": "<login key>"}
                         200 → Set-Cookie: bambou_session=…; HttpOnly; (12 h browser max-age)
                         401 → invalid key
                         429 → 5 failed attempts / 10 min per IP, Retry-After: 600 (always)
```

- The **login key is not the bbk_ API key** and not the extension key. It is the key entered on
  the dashboard login screen (`#admin-key` in the bundle).
- Sessions live **in server memory**: a server restart logs everyone out (per the docs: "Les
  sessions sont en mémoire et sont perdues au redémarrage du serveur"). A long-running Discord
  bot must therefore survive 401s — `BambouStudio` re-logs in automatically and retries once.
- `GET /api/session` → `{authenticated: bool}`. `POST /api/logout` drops it.
- No CSRF token anywhere; plain HTTP with the cookie is enough (the official curl examples use
  just `-b bambou-cookies.txt`).
- **There is no server-side way to revoke a session**; rotate the login key server-side if leaked.

### 2.2 Assistant keys (`bbk_…`) — for generation

Created from the studio session via Settings → API Keys (`/api/studio/api-keys`). Used as
`Authorization: Bearer bbk_…`. Only the whole key's *fingerprint* is stored server-side; the
plain key is returned **exactly once** at creation. Scoped per key: allowed presets, rpm,
concurrency, daily quota, pause/revoke. This is the credential to ship to chat workers.

### 2.3 Extension key

Sent as `X-Bambou-Extension-Key`. Powers the browser extension: `GET /api/extension/config`
(presets, vaults, ban keywords, webhook settings) and `POST /api/extension/generate`.
Quirk: `presetId` must be a JSON **string**; a number yields `"Preset inconnu."` HTTP 500.

### 2.4 Spaces

Data is per-space and spaces are hosts (main domain or operator subdomains like
`pablo.bambouaibot.com`). A client just targets the right base URL; the API is identical.

---

## 3. Route map

Full inventory with auth modes and one-line purposes: [`api_routes.txt`](api_routes.txt).
Highlights for the Discord bot:

**Management (session cookie)**
```
GET    /api/studio/config                              whole studio document
PUT    /api/studio/config                              whole-document save (≤1 MiB, 1..100 presets)
GET    /api/studio/presets/{id}/export                 re-importable preset export
POST   /api/studio/presets/import                      import (client sends {payload})
POST   /api/studio/presets/{id}/import-section         per-section swap (undocumented, used by UI)
GET    /api/studio/api-keys                            list keys (no secrets)
POST   /api/studio/api-keys                            create (returns bbk_ once)
PATCH  /api/studio/api-keys/{keyId}                    label/limits/presetIds/disabled
DELETE /api/studio/api-keys/{keyId}                    revoke (final)
GET    /api/media/library | POST /api/media/vaults | POST /api/media/days | POST/PATCH/DELETE /api/media/items[/id]
GET    /api/conversations/archive | /api/conversations/export
GET    /api/dashboard                                  live workers report            (internal)
POST   /api/accounts, GET/POST/DELETE /api/accounts/{id}, …/session/export, …/conversations
GET/POST /api/mailboxes[/import], DELETE /api/mailboxes/{id}
GET    /api/adspower/proxies
GET/POST /api/studio/blocked-messages[clear]           messages filtered by the chat sites
GET/POST /api/snap/rdps|status|fleet-health|create|create/status|place|unplace
PUT    /api/studio/engine-key | vision-key | haiku-key | ollama-key
GET    /api/studio/engine-profiles | PUT engine-profile | PUT engine-profile-key | POST engine-test
POST   /api/studio/generate                            playground generation
```

**Generation (bbk_)**
```
GET  /api/assistant/presets     id/name/language/archived per preset, filtered by key scope
POST /api/assistant/generate    {presetId, messages[]} — stateless: full history every call
```

---

## 4. Data model

### 4.1 The studio config document

`GET /api/studio/config` returns one JSON document:

```
{
  version:      1,               // schema version (live value: 1)
  updatedAt:    "2026-…Z",       // last save timestamp
  presets:       [ … ],          // 1..100, see preset_schema.md
  accounts:      [ … ],          // ChatNow worker accounts (presetId, proxy, recreate triggers…)
  engine:        { … },          // AI provider/model/temperature/vision settings (keys never returned)
  snapchat:      { modelSetups, accounts{receiving,overflow}, handleUrlTemplate, rdps, pacing, … },
  extension:     { … },          // extension settings incl. wordReplacements, webhooks, ban keywords
  abbreviations: { … }           // word-shortening table used by workers
}
```

`PUT` rules (from the contract, all confirmed in the bundle's save flow):
- **whole document** — not a partial update; concurrent edits are *not* merged, last write wins;
- at least 1 preset must remain (archived counts), max 100 presets, body ≤ 1 MiB;
- unknown extra fields are preserved (the schema is `additionalProperties: true`);
- the response is the normalised saved document — use it as the new source of truth.

### 4.2 Presets

Full field inventory (identity, persona, style, strategy, behavior, mainSettings, openers,
cycles/phases, ctaScripts, urls, objections, sprinkles, followups, finishers, ignoreConditions,
media): [`preset_schema.md`](preset_schema.md). Preset ids in the UI are random 4-digit strings
(`"1048"`), but the server accepts any string id (`[A-Za-z0-9_-]{1,64}` per the assistant docs).
`archivedAt` (ISO date or null) archives a preset without deleting it — **archived presets stay
usable by API keys**; it is a dashboard-organisation flag only.

### 4.3 URLs — where the funnel links live

There is no links resource on the server. Each preset carries its own CTA links:

```
preset.urls = {
  chooseRandomly: false,        // pick a random enabled link at each CTA send
  items: [{
    id: "url-1",                // dashboard editor id
    platform: "OnlyFans",       // "snap" = auto Snapchat; 28 other labels; free text accepted
    displayLabel: "…",          // dashboard label
    url: "https://…",           // sent EXACTLY as stored (no rewriting)
    snapModel: "",              // platform==="snap" only: model-setup id, handle resolved at send
    spaceBeforeDotCom: false,   // inserts a space before ".com" to slip past chat-site filters
    enabled: true
  }]
}
```

- Platform enum (dashboard): `snap, OnlyFans, Phone Number, Telegram, Fansly, Chaturbate,
  I Want Clips, Fanplace, Premium Snapchat, MYM, AVN Stars, Fanvue, 4Based, FetLife,
  Feet Finder, Patreon, FanCentro, UVIU, Loyal Fans, Just For Fans, FlirtingFans, Many Vids,
  Uncove, Clips4Sale, Unlockd, FanTime, Ifans, Unfiltrd, Other`.
- `urls.spacedLinkInstructions: [{id, messages:[str]}]` — messages sent to explain a deliberately
  spaced link (see §5.13). **Confirmed in production**: several presets store the link already
  broken (`"getmysocial. com/…"` + instruction "get rid of the space before the dot") instead of
  using `spaceBeforeDotCom: true`, which is the automated variant of the same trick.
- **`platform: "snap"` is an indirection**: at send time the server picks a handle from
  `config.snapchat.modelSetups[id=snapModel].accountPool`, preferring ones in
  `snapchat.accounts.receiving`, then `.overflow`, and formats it with
  `snapchat.handleUrlTemplate` (`{username}` placeholder). Snapchat items in the live space carry
  a model id (e.g. `"8282"`) and sometimes only a `displayLabel` like `"👻"` — no literal URL.
- `strategy.ctaLink` is the legacy single-link field from before the URL editor; keep it in sync
  or ignore it — the current dashboard sends from `urls.items[]`.

### 4.4 Assistant API keys

Per [`openapi.json`](openapi.json) + UI code:

| field | meaning |
|---|---|
| `id` | `ak_…` — used in the URL to patch/revoke. Not a secret. |
| `label` | who uses it (≤60 chars) |
| `hint` | last 4 chars of the key, to recognise it |
| `rpm` | generations/minute, 1–600 (default 20) |
| `maxConcurrent` | simultaneous generations, 1–8 (default 2) |
| `dailyLimit` | generations per UTC day, 1–100 000 (default 1 000) |
| `presetIds` | allowed presets; `[]` = **all presets including future ones**; unknown id → 400 |
| `disabled` | true = paused, calls get 403; patching is immediate |
| `revokedAt` | set by DELETE, final; a revoked key cannot be patched |
| `lastUsedAt`, `callsSinceStart`, `callsToday` | usage counters; **reset on server restart** (not durable) |

Limits: at most **50 active keys**; the plain key (`bbk_…`) is only in the POST 201 response.
Pause (`PATCH {disabled:true}`) is reversible; `DELETE` is not.

### 4.5 Media (optional for the bot)

Live `GET /api/media/library` shape: `{vaults:[{id,name}], presets, categories, daysByVault:{…},
items:[…]}`. Items are a flat list — each item carries `id, vaultId, presetId, dayId, category,
fileName, mimeType, context, description, overlay, disappearing, tags, createdAt, url`. Categories:
`primary | sad | happy | sexy | pose | audio | hidden`. Uploads go through `POST /api/media/items`
with the file as a base64 **data URL** (`data:image/jpeg;base64,…`). Size limits seen in the UI:
image ≤18 MB, audio ≤30 MB, video/mp4 ≤40 MB. Items are patchable
(`{overlay:{text,preset,y,fontSize},description,disappearing}`) and deletable. Days are created per
vault (`POST /api/media/days {vaultId,name}`); vault and day ids are 4-digit strings like presets.

---

## 5. Protocol quirks & gotchas

1. **Whole-document writes.** `PUT /api/studio/config` replaces everything. Always do a fresh
   GET inside your write path (the client serialises concurrent updates to avoid lost edits).
2. **In-memory sessions.** Server restart ⇒ 401 on the next call. Auto re-login and retry.
3. **Login brute-force protection.** 5 failures / 10 min per IP ⇒ 429 with `Retry-After: 600`.
   Don't retry login aggressively; back off exactly per header.
4. **French error strings** in `{"error": "…"}` — display them as-is; they are precise
   ("Preset inconnu : 9999.", "Corps de requete trop grand (8 Kio maximum).", …).
5. **Preset id is a string.** Numbers break `/api/extension/generate` (500). Always send JSON
   strings.
6. **Assistant generation is stateless.** Send the whole history on every call: ≤40 messages,
   ≤2 000 chars each, ≤30 000 total (UTF-16 units), last message must be `user`, roles only
   `user|assistant` (`system` is rejected). Unknown preset: 404 (all-presets keys) or 403
   (scoped keys — deliberate, to avoid probing).
7. **Archived presets remain usable** by API keys. To actually block, revoke/pause keys or remove
   the preset from the key's `presetIds`.
8. **Counters are ephemeral.** `callsToday`, `lastUsedAt` reset with the server; don't build
   billing/quota reporting on them, use the daily generation endpoints or/and your own logging.
9. **Internal routes exist** beyond the OpenAPI (accounts, dashboard, mailboxes, Snapchat fleet,
   media vaults/days, blocked messages, `import-section`). They use the same session cookie and
   were confirmed in the bundle; treat them as more change-prone than the documented ones.
10. **No CSRF token, no Origin check observed** on the JSON API. Cookie + JSON is sufficient —
    convenient for the bot, but it also means the login key alone compromises the space; keep it
    in an root-readable env file, not in the repo.
11. **`import-section` section names**: `main, openers, phases, cta, urls, objections, sprinkles,
    followups, finishers, ignorelist, media` (the `optimizations` tab is computed client-side, not
    a section). Section import only touches those preset modules.
12. **Base64 media in JSON** — mind the payload sizes; item uploads are separate from the 1 MiB
    config doc limit.
13. **Dual-generation presets.** Every live preset carries both the editable flow sections
    (`cycles`, `openers`, `ctaScripts`, `followups`, `finishers` — what the dashboard renders and
    writes) and flat mirrors (`phases` = all cycle phases re-listed with `interestTarget`,
    `sequences` = `{openers,cta,followups,finishers}` as plain string arrays; ids match 1:1).
    Edit the editable sections and let the server normalise — treat `phases`/`sequences` as
    derived. `urls`, `strategy`, `identity`-family, `media` are single-source.
14. **Link-filter evasion layers stack.** Order of decreasing subtlety, all in production use:
    `wordReplacements` in `config.extension` (rewrites `snap→sn&p`, `page→paaage`, `mym→m#y#m`
    before sending), a manually broken URL string plus `urls.spacedLinkInstructions` messages,
    or the `spaceBeforeDotCom: true` flag. The blocked-messages log (§3) lists exactly which
    words each chat site filters and how often — use it to tune these tables.

---

## 6. Deliverables in this folder

| file | role |
|---|---|
| [`bambou_client.js`](bambou_client.js) | Zero-dep Node 18+ client. `BambouStudio` (login key → presets, URLs, API keys, media, engine, supervision), `BambouAssistant` (bbk_ generation), `BambouExtension`. Central `ROUTES` map, cookie jar, retry/backoff, auto re-login, serialised read-modify-write. |
| [`smoke_test.js`](smoke_test.js) | Live test. Read-only by default; `--write` exercises preset+URL+key create/cleanup. |
| [`mock_test.js`](mock_test.js) | Offline verification of the client against a fake of the contract (all PASS). |
| [`bambou_bot.js`](bambou_bot.js) | The scoped Discord bot (discord.js v14): `/preset list\|setup\|edit`, `/key list\|create\|edit\|delete`, `/access add\|remove\|list`. Two-step modal form for the duplicate-and-configure flow, autocomplete from the live preset list, confirm buttons for key revocation, permission middleware + `[audit]` log. |
| [`bot_core.js`](bot_core.js) | Pure logic behind the bot (no discord.js): `AccessStore` (owner + approved users, JSON file), `buildPresetSetup` (duplicate or edit in one atomic config save), URL upsert, id-rename migration, formatting helpers. |
| [`bot_core_test.js`](bot_core_test.js) | Offline tests for the above (all PASS), including the duplicate flow and the id rename against the mock contract. |
| [`gms_command.js`](gms_command.js) + [`gms_test.js`](gms_test.js) | GetMySocial `/gms` command (HTTP in `../GetMySocial/discord/gms-service.js`) + its offline harness. |
| [`preset_flow_test.js`](preset_flow_test.js) | Offline harness for the `/preset setup` flow: mock interactions reproduce Discord's rule that a modal submit cannot answer with another modal, so the modal → Continue button → modal → single-save bridge stays tested. |
| [`env.js`](env.js) + `.env` / `.env.example` | Zero-dep `.env` loader; the bot and smoke test read `./.env` automatically (shell env vars win). `.env` ships with the login key filled — fill in `DISCORD_TOKEN` + `DISCORD_OWNER_ID`. `.gitignore` keeps credentials out of any future repo. |
| [`preset_schema.md`](preset_schema.md) | Full preset/config field inventory. |
| [`api_routes.txt`](api_routes.txt) | Every route with auth mode + purpose. |
| `openapi.json`, `api-docs.html/js`, `app.js`, `landing.html` | Raw provenance (live-fetched, byte-identical to the deployed site on 2026-10-18). |

### Usage sketch

```js
const { BambouStudio, BambouAssistant } = require('./bambou_client');

const studio = new BambouStudio({ loginKey: process.env.BAMBOU_LOGIN_KEY }); // baseUrl defaults to bambouaibot.com
await studio.login();

// set the link a preset sends
await studio.setPrimaryUrl('1048', {
  url: 'https://onlyfans.com/…', platform: 'OnlyFans', spaceBeforeDotCom: true,
});

// create a scoped assistant key for a worker (bbk_ shown once)
const key = await studio.createApiKey({ label: 'worker-alpha-01', presetIds: ['1048'], rpm: 60 });

// worker side
const assistant = new BambouAssistant({ apiKey: key.key });
const reply = await assistant.generate({
  presetId: '1048',
  messages: [{ role: 'user', content: 'hey, how are you?' }],
});
```

### Discord bot (`bambou_bot.js`) — presets + keys + `/gms`

| command | permission | what it does |
|---|---|---|
| `/preset list [page]` | `presets` | `id · name · first name · discovery platform · URL flags · archive marker` |
| `/preset setup source:…` | `presets` | **duplicates** the source preset, then a two-step form (modal → **Continue** button → modal; Discord can't chain modals): (1) preset name, preset id, first name, discovery platform → (2) MYM URL, extra URL. Values are prefilled from the source; one atomic config save applies everything. |
| `/preset edit preset:…` | `presets` | same form on an existing preset. If the id is changed, accounts, snapchat model setups and any scoped `bbk_` key are re-pointed to the new id in the same operation. |
| `/key list` | `keys` | state, limits, today's usage, scope |
| `/key create label:…` | `keys` | optional `rpm` / `concurrent` / `daily` / `scope`; the `bbk_` value is DM'd to the creator as a permanent copy (ephemeral fallback if their DMs are closed) |
| `/key edit key_id:…` | `keys` | label, limits, scope, pause/resume |
| `/key delete key_id:…` | `keys` | confirmation buttons, then final revoke |
| `/gms list\|create\|info\|enable\|disable\|delete\|stats\|refresh` | `gms` | GetMySocial direct links + click stats; guided create uses the same modal → Continue → modal bridge |
| `/access add\|remove\|list` | owner | approved users with `presets`, `keys` and/or `gms` |

"First name" is the dashboard's own label for `identity.name`; "Discovery platform" is
`mainSettings.discoveryPlatform` (free text — `Chatnow`, `snapchat`, `alpha.example`, …).
Permissions live in `access.json` (owner id + approved users); every command is checked before
it runs and every operation prints an `[audit]` line to the console. All replies are public in
the channel; the only private content is the one-time `bbk_` reveal, which is DM'd to its
creator as a permanent copy — with an ephemeral follow-up as fallback when their DMs are
closed.

```bash
npm i
# fill .env: DISCORD_TOKEN, DISCORD_OWNER_ID  (BAMBOU_LOGIN_KEY is already set)
npm run bot
# optional in .env: DISCORD_GUILD_ID (instant command registration), BAMBOU_BASE_URL, ACCESS_FILE
```

---

## 7. Security posture (for the operator)

- The **login key** is the master credential of the space (full config + key creation). Recommend
  a dedicated bot env file, root-readable, never committed; rotate in the dashboard if leaked.
- Worker-facing `bbk_` keys: create one per worker/site with `presetIds` scoping and sane
  `rpm`/`dailyLimit`; pause instead of revoke when debugging; revoke on decommission.
- This environment holds production credentials by design (per project onboarding) — the smoke
  test makes no write unless `--write` is passed, and cleans up test objects.

---

## 8. Suggested Discord-bot workflow

1. `BAMBOU_LOGIN_KEY` + `BAMBOU_BASE_URL` in the bot's env file; `BambouStudio` on boot.
2. `/bambou status` for a health check (presets, keys, live workers).
3. Per site/preset: `/bambou url set <preset> <link>` (or with `space_before_dot_com` when the
   target chat blocks links), `/bambou key create` for that site's workers — the bbk_ goes to
   the worker's env, never to chat.
4. Periodically: `/bambou preset list` + `blocked-messages` summary to spot filtered links and
   replace wording/URLs.

---

## 9. Verification status

**Live verification: DONE (2026-10-18)** against the production space on `bambouaibot.com` with
the operator's login key — all read-only:

- `smoke_test.js` (read-only pass): **all steps PASS** — login/session, `GET /api/studio/config`
  (30 presets, 30 accounts), per-preset URL readout, `GET /api/studio/api-keys` (7 keys),
  engine profiles (10), media library (8 vaults), `GET /api/dashboard` (internal), blocked
  messages (internal).
- Deep read-only introspection confirmed and corrected the schema notes: dual-generation preset
  sections (§5.13), `spacedLinkInstructions` + live evasion pattern (§4.3, §5.14), real media
  library shape (§4.5), real dashboard shape (`{domain, generatedAt, totals, accounts[]}`),
  engine-profiles shape (`{activeId, profiles[]}`).
- `mock_test.js`: 23/23 PASS (offline contract checks).
- **No write was performed** on the account. `--write` remains available for a later controlled
  pass (creates then deletes a tagged test preset and key).

To re-run any time:

```bash
cd extras/BambouBotAI
BAMBOU_LOGIN_KEY=… node smoke_test.js            # read-only inventory
BAMBOU_LOGIN_KEY=… node smoke_test.js --write    # + create/cleanup a tagged test preset/key
```

The login key is never stored in any file in this repo; it is passed via the environment only.
