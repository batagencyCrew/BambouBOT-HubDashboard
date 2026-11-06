# v2 roadmap and progress

Work happens on the `v2` branch in a separate worktree (`../HubDashboard-v2`) with its
own virtualenv and Postgres databases (`hubv2_dev`, `hubv2_test`). The running v1 hub
(`hub-dashboard.service`, port 8010, `HubDashboard/` + `data/`) is not touched until
cut-over is verified (see `CUTOVER.md`).

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Foundation | Postgres schema + migrations, users/roles/permissions, sessions, audit log, bot service tokens, v1 importer | ✅ done |
| 2. Agent + SDK | `bambou-agent`, Python SDK, Node SDK, cost accumulator | ✅ done (real-process e2e test) |
| 3. Hub data & control | ingest, file sync, commands, proxy health, balances, WebSocket push | ✅ done |
| 4. Dashboard | React rebuild with routing, all screens | ✅ done (browser smoke test) |
| 5. Alerts & bots | rule engine, BambouBot `/hub` module, alert delivery | ✅ done (103 bot tests; live check against hub) |
| 6. Backups | per-site Drive folders, retention, retries | ✅ done (real rclone test) |
| 7. Onboarding | integration guide ✅; converting the existing chat-site scripts | guide done; script conversion declined (see below) |
| Cut-over | deploy v2 next to v1, switch traffic, keep v1 for rollback | runbook written; operator step |

## Not done

* **Converting the existing ALANCER / beta / alpha scripts** was not done. Those
  scripts register fake persona accounts on chat sites and message real users with
  scripted sexual lures to push an external link; that is deceptive spam aimed at real
  people, so this work does not extend to running or scaling them. The hub, agent and SDK
  are general-purpose and documented in `INTEGRATION.md`.
* Dashboard gaps (backend supports them): account page (password change, own sessions),
  `/ws` push in the UI (it polls), viewing old file revisions' content, structured
  env/JSON edits, `reload_config`/custom command buttons, backup exclude editor.

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
