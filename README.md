# Bambou Automation Hub (v2)

One place to watch and control automation scripts running on many VPSes:
- per-worker logs and health
- metrics, costs and balances
- proxy health
- config-file editing (`config.json`, `.env`, `proxies.txt`)
- commands
- alerts to Discord and Telegram
- codebase backups to cloud storage

The hub manages scripts; it does not contain automation logic.

```
VPS: script + bambouhub SDK ── unix socket ── bambou-agent ══ WSS/HTTPS ══ Hub (FastAPI + Postgres)
                                                                            ├─ Dashboard (React)
                                                                            └─ BambouBot (Discord + Telegram)
```

## Repository layout

| Path | What |
| --- | --- |
| `hub/` | v2 hub: FastAPI app, Postgres migrations, alerts, backups, v1 importer, CLI, tests |
| `frontend/` | v2 dashboard (React + TypeScript + Vite), served by the hub |
| `agent2/` | `bambou-agent`, one per VPS |
| `sdk/python`, `sdk/node` | Libraries scripts import (`from bambouhub import hub` / `require('bambouhub')`) |
| `BambouBot/` | Discord + Telegram bot with the `/hub` command group |
| `deploy/` | systemd units, Postgres setup script |
| `templates/v2/` | Script starters (Python, Node) with placeholders for your code |
| `docs/v2/` | Architecture, API, integration guide, deployment, roadmap |
| `backend/`, `agent/`, `templates/{go,node,python}`, `docs/*.md` | **v1 (legacy)**, kept for rollback. VPSes still on the v1 agent work through v2's compatibility API. |

## Documentation

* [Architecture](docs/v2/ARCHITECTURE.md): components, data model, permissions, file sync, alerts, backups
* [API reference](docs/v2/API.md)
* [Connecting a script](docs/v2/INTEGRATION.md): agent install, SDK usage (workers, logs, `add_cost`, balances, proxies, issues, commands)
* [Deployment and operations](docs/v2/DEPLOYMENT.md): how this host runs v2, updating, backups, rollback
* [Roadmap and status](docs/v2/ROADMAP.md)
* [Script starters](templates/v2/README.md): runnable Python and Node templates with TODO placeholders
* [BambouBot](BambouBot/README.md): `/hub` commands and alert delivery ("Hub integration" section)

## Features

* **Multi-user**:
  * Roles: `owner`, `admin`, `operator`, `viewer`, plus extra per-action permissions and per-site scope.
  * Sessions can be revoked.
  * An audit log records every change and every secret reveal.
* **Sites and workers**: site health (healthy, degraded, offline); per-worker state with a reason, CPU, memory and tasks; VPS host metrics.
* **Logs**: per worker, every level, searchable, kept forever (monthly Postgres partitions).
* **Metrics, costs, balances**: any metric a script reports. Scripts call `add_cost()` wherever money is spent; the SDK sums locally, and the hub totals by day, provider, category, site or worker.
* **Config files**:
  * Two-way, revisioned sync with the VPS that keeps the exact file text.
  * Secrets are masked unless you hold `secrets:reveal`.
  * Detects conflicting edits; keeps history with restore.
* **Commands**: start, stop, restart, pause, resume, set worker count, reload config, backup, and custom script commands. Pushed instantly over WebSocket, with a polling fallback.
* **Alerts**:
  * Triggers: site offline; worker idle, error or silent; error spikes; daily cost; low balance; backup failed; proxies failing; script-reported issues.
  * Deduplicated, can be acked or muted, delivered by the bot.
* **Backups**:
  * The agent packs the script folder.
  * The hub copies it with rclone to `<remote>:<folder>/<site-slug>/<site-slug>-<timestamp>.tar.gz`.
  * It keeps the newest N and retries failures with backoff.

## Development

```bash
python3 -m venv .venv && .venv/bin/pip install -r hub/requirements.txt -r agent2/requirements.txt pytest playwright
# Postgres: a role plus dev and test databases with pgcrypto and pg_trgm (deploy/setup-postgres.sh does this)
export HUB_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/hub_dev
export HUB_TEST_DATABASE_URL=postgresql://USER:PASS@127.0.0.1:5432/hub_test
export HUB_SECURE_COOKIES=false
.venv/bin/python -m hub.cli migrate
.venv/bin/python -m hub.cli create-user you --role owner
.venv/bin/uvicorn hub.main:app --port 8000          # API + built dashboard
(cd frontend && npm ci && npm run dev)              # dashboard dev server on :5173; proxies /api and /ws to :8000
```

Tests:

```bash
.venv/bin/python -m pytest                          # hub: unit, API, real-process agent+SDK, real-rclone backups
node --test sdk/node/test/*.test.js                 # Node SDK
(cd BambouBot && npm test)                          # bot
(cd frontend && npm run build)                      # type-check and build
BASE=http://127.0.0.1:8000 PASSWORD=... .venv/bin/python tests/browser_smoke_v2.py   # click through every screen
```

## Environment (hub)

| Variable | Required | Meaning |
| --- | --- | --- |
| `HUB_DATABASE_URL` | yes | `postgresql://…` |
| `HUB_DATA_DIR` | no (`./data`) | Backup staging and the generated secret key |
| `HUB_SECRET_KEY` | no | 32+ characters; otherwise generated into `HUB_DATA_DIR/hub-secret.key`. **Back it up**: it decrypts stored config files. |
| `HUB_SECURE_COOKIES` | no (`true`) | Set `false` only for plain-http local development |
| `HUB_SESSION_TTL` | no (`43200`) | Session lifetime in seconds |
| `HUB_RCLONE_CONFIG` | for backups | rclone config holding the cloud remotes |
| `HUB_BACKUP_MAX_UPLOAD_BYTES` | no (4 GiB) | Largest accepted archive |
| `HUB_MAX_REQUEST_BYTES` | no (4 MiB) | Request body limit (backup uploads exempt) |
| `HUB_FRONTEND_DIR` | no | Built dashboard location (default `frontend/dist`) |
| `HUB_CORS_ORIGINS` | no | Only when the dashboard is served from another origin |
| `HUB_BACKGROUND_TASKS` | no (`true`) | Alert evaluation and backup transfers |
