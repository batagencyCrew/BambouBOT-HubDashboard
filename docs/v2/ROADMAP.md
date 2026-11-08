# v2 status and roadmap

v2 is **live** on the hub host since the switch from v1 (see [DEPLOYMENT.md](DEPLOYMENT.md)).

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Postgres schema + migrations, users/roles/permissions, sessions, audit log, bot service tokens, v1 importer | ✅ done |
| 2. Agent + SDK | `bambou-agent`, Python SDK, Node SDK, cost accumulator | ✅ done (real-process end-to-end test) |
| 3. Hub data & control | ingest, file sync, commands, proxy health, balances, WebSocket push | ✅ done |
| 4. Dashboard | React rebuild with routing, all screens | ✅ done (browser smoke test) |
| 5. Alerts & bots | rule engine, BambouBot `/hub` module, alert delivery | ✅ done and running (`bambou.service`) |
| 6. Backups | per-site Drive folders, retention, retries | ✅ done (real rclone test); no destinations configured yet |
| 7. Onboarding | integration guide, Python + Node starters (`templates/v2`) | ✅ done; both starters tested under the agent against the live hub |
| Cut-over | v1 → v2 on the hub host | ✅ done; v1 kept for rollback |

## Next

* **Move the VPSes to `bambou-agent`.** The two live VPSes still run the v1 agent
  through the compatibility API: heartbeats, logs, commands and config work, but there
  are no per-worker SDK logs, costs, pause/resume or `.env` sync until they are moved.
  No script has been migrated yet.
* **Configure backups.** Add rclone destinations and per-site schedules in the
  dashboard (the v1 rclone config was copied to the hub).
* **Alert channels.** Set default Discord/Telegram channels under **Alerts**, and link
  chat accounts with `/hub link`.

## Known gaps

* Dashboard features the backend already supports:
  * account page (password change, own sessions)
  * live `/ws` push (the UI polls every 10 s)
  * viewing old file revisions' content (restore works)
  * structured env/JSON edits
  * `reload_config` and custom-command buttons
  * backup exclude editor
* Discord allows 25 subcommands per group, all used by `/hub`; there is no `users` command.
* Provider balances come only from scripts (`hub.balance`); the hub does not query providers.

## Decisions

* **Postgres 16 with native monthly partitions** instead of TimescaleDB: already on the
  host, no extension to install, and telemetry is kept forever.
* **One agent per VPS + thin SDK in the script.** The agent:
  * survives script crashes
  * owns the hub connection and buffers offline
  * does file sync and backups

  The script only talks to a local unix socket. Any worker model (threads, asyncio,
  processes, browsers) declares workers through the SDK.
* **Bots act as linked hub users.** One permission system for dashboard and chat.
* **File text is stored, not re-rendered,** so `.env`/`proxies.txt` comments survive.
* **Backups classify failures:**
  * the agent does not retry permanent 4xx rejections
  * transfers retry with backoff for up to about 3.5 h
  * partial or failed local copies are cleaned after 72 h

  This fixes the v1 audit findings.
* **Site names are data, not code.** Tests and examples use `alpha`/`beta`/`demo`.
