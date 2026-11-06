# BambouBot

One codebase and **one process** for the BambouAI management bots on **Discord** and
**Telegram**:

- presets: duplicate, edit, rename-with-migration
- assistant API keys
- GetMySocial direct links and click stats
- per-platform owner/approved-user permissions

It replaces the two separate entry points in `../BambouBotAI/` (`bambou_bot.js` +
`telegram_bot.js`) and its dependency on `extras/GetMySocial`.

```bash
npm start                  # every platform that has a token in .env
npm run start:discord      # only Discord   (node index.js --only discord)
npm run start:telegram     # only Telegram
npm test                   # offline test suite (no tokens, no network)
```

## Setup

1. Node.js **18+**. The only dependency is `discord.js`:
   `npm ci` (`node_modules` is already installed here).
2. `cp .env.example .env && chmod 600 .env`, then fill it in. Required:
   - `BAMBOU_LOGIN_KEY`
   - for each bot you want: its token and owner ID (`DISCORD_TOKEN` + `DISCORD_OWNER_ID`, `TELEGRAM_TOKEN` + `TELEGRAM_OWNER_ID`)

   Optional:
   - `GMS_COOKIE`, `GMS_TEAM_ID` for `/gms` (see [docs/GETTING_COOKIE.md](docs/GETTING_COOKIE.md))
   - `DISCORD_GUILD_ID`
   - `ACCESS_FILE`

   A platform starts only when its token is set.
3. `npm start`. For usage on each platform, see [docs/PLATFORMS.md](docs/PLATFORMS.md).

Configuration errors are all reported together on startup, and the process exits
with status 1. Real environment variables override `.env`. `BAMBOU_ENV_FILE`
selects another file.

## How it is organised

```
index.js                      CLI entry: parses --only, loads config, runs the app, handles SIGINT/SIGTERM
src/
  config.js                   .env + environment → one validated config object
  app.js                      composition root: one studio session, cache, GMS client and access store,
                              shared by every platform; a failing platform doesn't stop the others
  core/                       pure building blocks (no platform code)
    access.js                 one access file, platform-scoped (discord:<id> / telegram:<id>)
    presets.js                preset duplicate/edit builder, URL upsert, id migration
    fields.js                 field specs + validators: the single source of input limits
    cache.js, sessions.js     versioned config cache, TTL form sessions
    errors.js, audit.js       redaction, error text, one audit-log format
    format.js                 splitting, pagination, plain/markdown styles
  services/                   business operations used by both platforms
    presets.js keys.js gms.js access.js
    render.js                 shared wording (plain text for Telegram, markdown for Discord)
  clients/bambou.js           BambouAI HTTP client (studio session, assistant, extension)
  vendor/getmysocial/         vendored GetMySocial session client + service (config injected)
  platforms/
    discord/                  slash commands built from the field specs, modals, embeds, DM delivery
    telegram/                 Bot API transport (long polling), parser, reply-based forms, inline keyboards
scripts/
  migrate-access.js           legacy access.json + telegram-access.json → one access file
  smoke.js                    live read-only check against BambouAI (npm run smoke)
test/                         node:test suites, fully offline against local HTTP mocks
docs/                         PLATFORMS.md, GETTING_COOKIE.md, REVERSE_ENGINEERING.md, preset_schema.md,
                              reference/ (captured openapi.json, routes, dashboard bundle)
```

To add a feature:

1. Put its logic in `src/services/`.
2. Put its limits in `src/core/fields.js`.
3. Add a thin handler in each `src/platforms/*/bot.js`.

Platform adapters never call the BambouAI or GetMySocial clients directly.

## Hub integration

The optional `hub` module controls Bambou Hub sites from Discord and Telegram and
delivers hub alerts. It is off unless both variables are set:

| Variable | Meaning |
| --- | --- |
| `HUB_URL` | hub base URL, e.g. `https://hub.example.com` |
| `HUB_BOT_TOKEN` | bot service token `hbt_…` (hub: `POST /api/service-tokens/bot`, needs `bots:manage`) |
| `HUB_ALERTS` | `false` turns alert delivery off (default `true`) |
| `HUB_ALERT_INTERVAL_MS` / `HUB_TIMEOUT_MS` | poll interval (default 20000) / request timeout (default 15000) |

**Permissions and linking.** `access.json` still governs `/preset`, `/key`, `/gms` and
`/access`. Hub commands use the permissions of the **linked hub user**: the bot sends
its token plus `X-Bot-User: <platform>:<id>`, and the hub checks every call itself
(a 403 is shown as "Your hub account lacks the `<permission>` permission").
To link, generate a code in the dashboard (Profile → link a chat account, valid 10
minutes, single use) and send `/hub link <code>`; `/hub unlink` removes the link.
An unlinked user gets a one-line instruction instead of hub data.

**Commands** (Discord `/hub <sub> option:value`; Telegram `/hub <sub> args`, positional
or `key=value`, values with spaces quoted):

```
sites                         info site            stats [site] [period]
start|pause|resume site       stop|restart site    (confirmation)
workers site                  logs site [level] [limit]     errors site [limit]
costs [site] [period]         balances [site]      proxies site
files site                    show site path       set site path key value (confirmation)
alerts                        ack id               mute id [minutes]
backup site                   link code            unlink
rules                         whoami               (/hub alone on Telegram: menu)
```

`stop`, `restart` and `set` show the site's live health and worker counts and wait for
a confirmation (button on Discord; button or reply `yes` on Telegram). Replies fit
Discord's 2000 / Telegram's 4096 characters: lists are truncated with a note, logs page
with an **Older** button (keyset, no gaps), alerts page by 10 with **Ack** buttons, and the
file list has **Show** buttons. File contents are always masked by the hub.

**Alert delivery.** `src/services/hub-alerts.js` polls `GET /api/bot/deliveries`,
sends each alert to the channel the hub chose — Discord `guildId:channelId`, Telegram
`chatId` (or `chatId:topicId`) — and reports `POST /api/bot/deliveries/{id}` with
`{ok, error}`. A hub outage is logged and retried with exponential backoff (max 5 min);
it never stops the bots. A channel on a platform this process does not run is
reported as failed so the hub can retry or show it.

Code: `src/clients/hub.js` (HTTP + error mapping), `src/services/hub.js` (API calls,
validation), `src/services/hubcommands.js` (shared command layer),
`src/core/hubformat.js` (text), `src/platforms/{discord,telegram}/hub.js` (UX).

## Behaviour changes compared with BambouBotAI

Where the two old bots behaved differently, both now use the safer behaviour:

| | Now | Before |
|---|---|---|
| Retries | Only reads (GET) are retried. POST/PUT/PATCH/DELETE are never replayed | Discord retried mutations, so a network error could create a second key |
| Discord key secret | DM, then ephemeral fallback. If both fail, the key is revoked | The key could be left orphaned |
| Discord input limits | rpm 1–600, concurrent 1–8, daily 1–100000, label ≤ 60, http(s) URLs, scope deduped and ≤ 100, preset-ID collision checked at step 1 (with a **Fix** button) | Not enforced |
| Discord platforms | All 29, via autocomplete | 25 (Unlockd, FanTime, Ifans and Unfiltrd were missing) |
| Discord `/access add` | All 7 permission combinations | 5 |
| Discord `/gms delete` | Confirmation button; `confirm:true` still skips it | A `confirm` boolean was required |
| Discord long replies | Split into several messages | Cut at 1990 characters |
| Discord stats | 0 % CTR and "0 with clicks" are shown | Hidden |
| Access file | One file for both platforms. A corrupt or invalid file means refuse to start, never overwrite | Discord silently reset a corrupt file |
| Owner override | Logged as a warning on both platforms | Telegram changed it silently |
| Audit log | Same format on both: `[audit] platform= user= chat= action=`, redacted, single line | Discord logged `cmd=undefined` on modals and didn't redact |
| Telegram platform field | Must be a listed platform (an unlisted existing value can still be kept) | Accepted any value equal to the current one |
| Config saves | One process means both bots' preset saves are serialised | Two processes could overwrite each other |
| Client error messages | English | Some were in French |
| Cookie guide | `docs/GETTING_COOKIE.md` | Two different paths |

## Moving over from BambouAIBot (not done yet)

Nothing in `../BambouBotAI/`, `extras/` or systemd was changed. `.env` here was filled
by copying the values from `BambouBotAI/.env` and `extras/GetMySocial/.env`. When
you're ready:

```bash
cd /root/Projects/BambouBOT/BOTS/BambouBot

# 1. Merge the live approvals (dry run first, then write):
npm run migrate:access -- --discord /var/lib/bambou-discord/access.json \
  --telegram /var/lib/bambou-telegram/telegram-access.json --out /var/lib/bambou/access.json
sudo mkdir -p /var/lib/bambou && sudo chmod 700 /var/lib/bambou
npm run migrate:access -- --discord /var/lib/bambou-discord/access.json \
  --telegram /var/lib/bambou-telegram/telegram-access.json --out /var/lib/bambou/access.json --write

# 2. Stop the old bots. Telegram allows only one poller per token.
sudo systemctl disable --now bambou-discord bambou-telegram

# 3. Install and start the unified service:
sudo cp bambou.service /etc/systemd/system/bambou.service
sudo systemctl daemon-reload && sudo systemctl enable --now bambou
journalctl -u bambou -f
```

The unit uses the same hardening as the old ones. State lives in `/var/lib/bambou/`
(`ACCESS_FILE` is set in the unit), and the project folder is mounted read-only.

To roll back:

```bash
sudo systemctl disable --now bambou
sudo systemctl enable --now bambou-discord bambou-telegram
```

The old access files are never modified.

## Tests

`npm test` runs about 100 offline tests against local HTTP mocks:

- `core.test.js`: preset builder, validators, formatting, sessions, cache, redaction, config
- `access.test.js`: platform isolation, corrupt-file refusal, owner override, migration script
- `client.test.js`: GET-only retries, re-login, serialised config writes
- `services.test.js`: preset/key/GMS services and shared renderers
- `telegram.test.js`: the full original Telegram suite, ported
- `discord.test.js`: the router, preset modal flow, key delivery and revoke, access, GMS, splitting
- `app.test.js`: one login shared by both platforms, failure isolation, `--only`, CLI errors
- `hub.test.js`: hub client headers/error mapping, commands (403, unlinked, truncation, pagination),
  Discord/Telegram confirmations and buttons, linking, alert poller (delivery, failures, hub down)

`npm run smoke` is a live, read-only check against BambouAI.
`npm run smoke -- --write` creates and removes a test preset and key.
