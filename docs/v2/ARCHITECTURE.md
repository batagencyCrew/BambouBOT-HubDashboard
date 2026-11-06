# Bambou Hub v2 — Architecture

The hub is the single place to watch and control every automation script on every
VPS. It does **not** run automation logic: it gathers logs, worker health,
metrics, costs, balances and proxy health, it edits each script's config files,
it sends commands, it raises alerts, and it backs up the code.

```
 VPS (one script per site)                                  Hub VPS
┌──────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ your script                          │        │ FastAPI hub  (hub/)                  │
│  └─ bambouhub SDK (Python / Node)    │        │  ├─ /api/*        dashboard + bots   │
│       logs · workers · metrics       │  unix  │  ├─ /api/agent/v2 agent HTTP API     │
│       costs · balances · proxies     │ socket │  ├─ /ws/site      agent push socket  │
│       issues · command handlers      ├───────►│  ├─ /ws/bot       bot event stream   │
│ bambou-agent  (agent2/)              │ WSS +  │  ├─ /api/agent/*  v1 compatibility   │
│  ├─ hub connection + disk buffer     │ HTTPS  │  ├─ alert engine  (tasks thread)     │
│  ├─ supervises the script process    │◄──────►│  └─ backup transfers → rclone        │
│  ├─ syncs config.json/.env/proxies   │        │ Postgres 16                          │
│  ├─ host metrics                     │        └──────────┬───────────────────────────┘
│  └─ codebase backups                 │                   │ HTTPS + WSS (service token)
└──────────────────────────────────────┘        ┌──────────▼───────────────────────────┐
                                                │ BambouBot (Discord + Telegram)       │
                                                │  hub commands + alert delivery       │
                                                └──────────────────────────────────────┘
```

## Components

| Path | What |
| --- | --- |
| `hub/` | FastAPI app, Postgres schema (`hub/migrations`), alert engine, backups, v1 importer |
| `agent2/` | `bambou-agent`: one per VPS; supervises the script, syncs files, buffers, backs up |
| `sdk/python`, `sdk/node` | Libraries a script imports to report and to receive commands |
| `frontend/` | React dashboard (served by the hub) |
| `BambouBot/` | Discord + Telegram bot, with the `hub` module talking to `/api` |

## Data model (Postgres)

* **Identity**: `users` (role + extra permissions + optional site scope), `sessions`
  (revocable cookie sessions), `service_tokens` (bot), `bot_links` (chat user ↔ hub user),
  `audit_log` (every change, every secret reveal).
* **Inventory**: `sites`, `site_tokens` (rotatable, several active allowed),
  `workers` (latest state), `agent_reports` (host + process + backup state),
  `site_capabilities` (custom commands and files the script declared).
* **Telemetry** — kept forever, monthly partitions: `event_logs`, `worker_samples`,
  `metrics`. `cost_events` (dedup by receipt), `account_balances` (latest per provider),
  `proxy_observations`.
* **Config files**: `site_files` (exact text, encrypted; revision + applied revision),
  `site_file_history`.
* **Control**: `commands` (pending → delivered → running → completed/failed/superseded).
* **Alerts**: `alert_rules`, `alerts` (deduplicated by key), `alert_deliveries`.
* **Backups**: `backup_destinations` (rclone remotes), `site_backup_config`, `backups`,
  `backup_files`, `backup_transfers`.

## Permissions

`hub/permissions.py` defines every permission (`sites:view`, `control:lifecycle`,
`config:edit`, `secrets:reveal`, …) and the role defaults (`owner`, `admin`,
`operator`, `viewer`). A user may get extra permissions and may be limited to some
sites. The **same check** runs for the dashboard and for the bots: the bot acts *as*
the linked hub user (`X-Bot-User`), so a Telegram user can never do more than their
hub account.

## Config files

The hub manages any file in the script root: `config.json`, `.env`, `proxies.txt`,
JSON proxy pools, or plain text. It keeps the **exact text** so comments and order
survive. Reads are masked (secret-looking keys and proxy passwords become
`********`); `secrets:reveal` shows real values and is audited. Editing a masked
document keeps any value left as `********`.

Sync is revisioned. Hub edits create revision N+1 and are pushed to the agent,
which writes atomically and acknowledges with the file's sha256. Hand edits on the
VPS are detected and pushed up; if both sides changed, the hub version wins on disk
and the local text is kept in history (`local-conflict`), so nothing is lost.

## Commands

`start · stop · restart · pause · resume · set_workers{count} · reload_config ·
backup · custom:<name>{args}`. Lifecycle commands set the site's desired state and
supersede older unacknowledged lifecycle commands (no stale replays). Commands
are pushed over the WebSocket instantly, and are also delivered by polling.

## Alerts

Rules (`hub/alerts.py`): site offline, worker idle/error/silent, error spike,
daily cost, low balance, backup failed/stale, proxies failing, plus
**script-reported issues** (`hub.issue(...)` in the SDK). Alerts are deduplicated
by key, resolve automatically when the condition clears, can be acknowledged or
muted, and are delivered through the bot to configured Discord/Telegram channels.

## Backups

The agent packs the script folder (`.git`, `node_modules`, venvs excluded by
default) and streams it to the hub. The hub copies it with rclone to every
destination as `<remote>:<folder>/<site-slug>/<site-slug>-<UTC timestamp>.tar.gz`
— one folder per script inside your parent folder — keeps the newest
`keep_count` archives, and deletes its local copy once all copies succeeded.

## Compatibility with v1

Sites imported from v1 keep their ids and token hashes. The v1 agent API
(`/api/agent/heartbeat`, `/config`, `/commands`, `/errors`, `/statistics`,
`/ai-usage`, backups) is served on top of v2 storage, so deployed agents keep
working until they are moved to `bambou-agent`.
