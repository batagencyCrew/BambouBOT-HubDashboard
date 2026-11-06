# v2 roadmap and progress

Work happens on the `v2` branch in a separate worktree (`../HubDashboard-v2`) with its
own virtualenv and Postgres databases (`hubv2_dev`, `hubv2_test`). The running v1 hub
(`hub-dashboard.service`, port 8010, `HubDashboard/` + `data/`) is not touched until
cut-over is verified (see `CUTOVER.md`).

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Postgres schema + migrations, users/roles/permissions, sessions, audit log, bot service tokens, v1 importer | ✅ done |
| 2. Agent + SDK | `bambou-agent`, Python SDK, Node SDK, cost accumulator | in progress |
| 3. Hub data & control | ingest, file sync, commands, proxy health, balances, WebSocket push | ✅ core done |
| 4. Dashboard | React rebuild with routing, all screens | pending |
| 5. Alerts & bots | rule engine ✅; BambouBot hub module | in progress |
| 6. Backups | per-site Drive folders, retention, retries | ✅ hub side; agent side pending |
| 7. Onboarding | migrate beta/alpha; pilot one ALANCER script; guide | pending |
| Cut-over | deploy v2 next to v1, switch traffic, keep v1 for rollback | pending |

## Decisions

* **Postgres 16 with native monthly partitions** instead of TimescaleDB: available on
  the host today, no extension to install, and telemetry is kept forever as requested.
* **One agent per VPS + thin SDK in the script.** The agent survives script crashes,
  owns the hub connection, buffers offline, and does file sync and backups; the script
  only talks to a local unix socket. Scripts with any worker model (threads, asyncio,
  processes, browsers) declare workers through the SDK.
* **Bots act as linked hub users.** One permission system for dashboard and chat.
* **File text is stored, not re-rendered,** so `.env`/`proxies.txt` comments survive.
* **Backups: classify failures.** Permanent 4xx rejections are not retried by the
  agent; transfers retry with backoff up to ~3.5 h; partial/failed local copies are
  cleaned after 72 h. Fixes the v1 audit findings.
