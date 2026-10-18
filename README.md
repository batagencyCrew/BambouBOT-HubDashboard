# Bambou Automation Hub

A self-hosted dashboard, central API, and VPS agent for managing site automation you own or are authorized to operate. No external database or hosted dashboard service is required.

## What is included

- Site inventory with heartbeat-based health (offline after 60 seconds).
- Worker status, CPU, memory, and completed-task telemetry.
- Per-site statistics for successful links and average messages per chat, supplied by the automation.
- Site-specific event/error logs, configuration, and proxy pools.
- Proxy type selection for manual entry and validated text-file import with duplicate detection.
- Encrypted AI/captcha API keys and proxy passwords; write-only dashboard fields.
- BambouBotAI preset dropdown populated from its API using the site's saved or newly entered AI key.
- Durable start/stop/restart requests with delivery and acknowledgement states.
- Script → hub → cloud backups with any-file uploads, scheduled/on-demand packaging, and rclone destinations (Google Drive, S3, OneDrive, etc.).
- Separate administrator and site-scoped agent credentials.
- SQLite persistence, a Python process supervisor, and Docker + automatic HTTPS deployment.

The hub coordinates lifecycle and configuration; **it does not implement site automation, AI inference calls, or captcha solving**. Plug in your own permitted scripts. Site URLs are inventory metadata: health describes agent/worker reports, not an external uptime probe.

### Choosing a BambouBotAI preset

In a site's **Configuration**, enter its BambouBotAI API key and click **Load presets**, or use the automatically loaded presets when a key is already saved. The hub calls `https://bambouaibot.com/api/assistant/presets` on the server; the saved key is never sent back to the dashboard. Select an option formatted as `Preset Name (Preset ID)` and save the configuration. Loading with a newly entered key does not save that key until you click **Save configuration**. Archived presets are shown separately and cannot be newly selected. Your existing selection is preserved if the provider is unavailable. Restart workers after changing the preset.

## Local quick start

Requires Python 3.12+ and Node 22+.

```bash
cd HubDashboard
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt -r agent/requirements.txt
export HUB_ADMIN_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(36))')"
echo "$HUB_ADMIN_PASSWORD"  # save in your password manager; needed to log in
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

In a second terminal:

```bash
cd HubDashboard/frontend
npm ci
npm run dev -- --host 127.0.0.1
```

Open the Vite URL (normally `http://127.0.0.1:5173`) and log in with `HUB_ADMIN_PASSWORD`. The dev server proxies `/api` to port 8000. No cross-origin configuration is needed. The backend does not automatically load `.env`; export environment variables for direct runs. Compose reads `.env` itself.

To serve the production UI from Python instead:

```bash
cd frontend
npm ci
npm run build
cd ..
uvicorn backend.app:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`. Restart the backend after the first frontend build if it was started without a built UI.

## Managing proxies

For manual entry, choose **Proxy type** (HTTP, HTTPS, or SOCKS5), then enter only `host:port` in **Host:port**. Supply credentials in the separate fields. Use **Import proxies** to upload a UTF-8 `.txt` or `.list` file, preview validation and duplicates, and confirm the import. See [supported file formats](docs/PROXY_IMPORT.md). Restart workers after changing their proxy pool.

## Backups

The **Backups** site tab configures schedules and cloud destinations and queues on-demand requests. Scripts upload arbitrary files to the hub; the hub stages and hashes them, then routes them to configured rclone remotes. Archives are never extracted or executed. To use automatic codebase packaging, configure the source on the VPS with `--backup-dir /path/to/script`; cloud credentials belong only in the hub's private rclone configuration. **Cloud setup is required before backups can be routed.** See [backup setup, Google Drive authentication, upload examples, limits, and recovery](docs/BACKUPS.md).

## Site statistics and logs

The **Statistics** tab and Overview show **Links Sent Successfully** and **Average Messages Per Chat** from site-authenticated aggregate snapshots. Your automation defines/calculates those values; the hub never invents activity. See [statistics reporting](docs/STATISTICS.md). Logs use inline 10-row pagination and a bounded table viewport; changing a log page does not reload the dashboard. Site tabs scroll horizontally only on small screens.

## Connect an automation VPS

For new automation projects, use the [Python, Node.js, or Go VPS templates](templates/README.md). These include local `config.json`/`proxies.txt` synchronization, lifecycle hooks, telemetry/logging, and backups without requiring captcha integration.

1. Add a site in the dashboard. Copy its **one-time agent token** and store it securely. Each site needs its own token. Rotation invalidates the previous token immediately.
2. Install Python and copy the `agent/` directory onto the automation VPS. Install `agent/requirements.txt` in a virtual environment.
3. Set the hub origin URL and agent token, then start the supervisor with a **locally configured** command:

```bash
export HUB_URL=https://hub.example.com
export HUB_AGENT_TOKEN='the-site-token'
python agent/agent.py --state-dir ./agent-state \
  --command '/absolute/path/to/python /absolute/path/to/your_worker.py'
```

For a harmless test use `--command '/absolute/path/to/python /absolute/path/to/agent/demo_worker.py'`. The supervisor initially follows the site's desired state; press **Start** in the dashboard to launch workers. The hub's worker count launches that many copies of your local command. Use only one supervisor per site; create separate sites for independent VPS pools. A site token can read that site's secrets, so only install it on trusted machines.

### Worker configuration

Each worker receives these environment variables at process creation:

| Variable | Meaning |
| --- | --- |
| `HUB_WORKER_ID` | Stable UUID for this site's worker slot (dashboard name: `worker-1`, etc.) |
| `AI_API_KEY` | Site's AI key, or empty |
| `AI_PRESET_ID` | Site's preset ID |
| `HUB_PROXIES_JSON` | JSON array of `{id,url,username,password}` |

The supervisor's agent token is removed from the worker environment. Worker count changes reconcile within about 30 seconds. **Restart after changing API keys, preset, or proxies**, as existing process environments cannot be updated. Output is discarded by the sample supervisor to avoid accidental secret leakage; configure application logging explicitly in your own worker, without credentials. CPU/memory cover each direct worker process, not its whole descendant tree. The Python starter provides a local IPC hook for actual task counts and sanitized errors; uninstrumented workers correctly report zero completed tasks.

The supervisor also writes local runtime files (default `./runtime`; set `--runtime-dir` to your script's existing file directory). On first enrollment it imports local proxies/settings only when the hub site is still pristine; subsequent dashboard edits and deletions are authoritative and update those files on refresh. See [local file behavior and conflict policy](templates/README.md#existing-proxiestxt-and-local-configuration). Site deletion does not erase VPS files. Captcha remains a legacy optional dashboard field; the new starter templates do not integrate it.

Heartbeat interval: 15 seconds. Command polling: 5 seconds. Config refresh: 30 seconds. Failed workers remain visible as errors and require an explicit Restart instead of entering a crash loop. During hub/network outages the supervisor keeps its current workload; it retries requests without disabling TLS verification. A dashboard Stop cannot reach an offline VPS: stop its service directly in an emergency.

### Run the agent with systemd (Linux)

Install the project and virtual environment under `/opt/HubDashboard`, create a non-root `automation` user, and grant that user access to the worker's files. Copy `deploy/hub-agent.service` to `/etc/systemd/system/hub-agent.service` and edit its `ExecStart` to your worker's command. Create `/etc/hub-agent.env`, owned by root with mode `600`:

```dotenv
HUB_URL=https://hub.example.com
HUB_AGENT_TOKEN=your-site-token
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hub-agent
sudo systemctl status hub-agent
sudo journalctl -u hub-agent -f
```

The sample service hardens filesystem access; adjust it narrowly if your worker needs write access. Use a separate service and state directory for each site on a shared VPS. Normal service termination sends SIGTERM to all worker process groups, waits against a shared ten-second deadline, then force-kills remaining children.

## Public HTTPS deployment

See [deploy/README.md](deploy/README.md) for DNS, firewall, TLS, backups, updates, and recovery. Do not expose the raw Uvicorn port publicly.

## Custom script integration

The complete endpoint and payload reference is [CONTRACT.md](CONTRACT.md). Administrator requests use the access token from `POST /api/auth/login`; agents use `Authorization: Bearer <site-token>` under `/api/agent` only.

Typical custom agent flow:

1. `GET /api/agent/config` to load that site's config and secrets.
2. `POST /api/agent/heartbeat` every 15 seconds with the **complete** worker snapshot.
3. `GET /api/agent/commands` every 5 seconds; execute allowed local lifecycle actions and persist command IDs to deduplicate delivery.
4. `POST /api/agent/commands/{id}/ack` with `{"status":"completed"}` or `{"status":"failed","message":"sanitized explanation"}`.
5. `POST /api/agent/errors` with sanitized `{level,message,worker_id?}` events. Never include passwords, keys, or proxy credentials.

Commands have at-least-once delivery, not exactly-once execution. The sample persists completed IDs before acknowledging so acknowledgement retries do not repeat actions. A crash between executing an action and persisting its ID can still repeat an action; design lifecycle hooks to be idempotent. Keep the agent's state directory across restarts. Start/stop/restart control the local worker process, not the remote VPS OS.

## Tests

```bash
pip install -r backend/requirements-dev.txt -r agent/requirements.txt
python -m pytest backend/tests agent/tests tests -q
cd frontend
npm run build
```

Optional real-browser checks (after building the frontend):

```bash
pip install -r tests/requirements-browser.txt
python -m playwright install chromium
python tests/browser_smoke.py
```

Alternatively set `BROWSER_EXECUTABLE=/path/to/chrome` to use an installed browser. The smoke test uses temporary databases and saves screenshots under `.qa/screenshots/`. To verify the built Docker image's non-root runtime and backup recovery, run `python tests/container_smoke.py` after `docker compose build hub` (Compose requires the values in `.env`).

The API is a single-administrator control plane. For teams, add an identity provider, per-user authorization/audit, and stronger gateway-level rate limiting before production use. Keep the host patched and restrict dashboard access using a VPN or gateway policy when possible while allowing trusted VPS agents through.
