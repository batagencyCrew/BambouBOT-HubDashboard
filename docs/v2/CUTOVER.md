# Cutting over from v1 to v2

The live v1 hub keeps running untouched until every check here passes. v2 runs on a
different port (8000) and a separate database; nothing in v1 changes until step 6.

## 0. What stays compatible

* Sites imported from v1 keep their ids and agent-token hashes, so **deployed v1 agents
  keep working** through the compatibility API once v2 is the live service.
* v1 dashboard URLs are gone; the v2 dashboard replaces it.

## 1. Set up v2 (on the hub host)

```bash
sudo deploy/setup-postgres.sh hubv2 hubv2          # prints HUB_DATABASE_URL
sudo mkdir -p /opt/bambou-hub && sudo rsync -a --exclude .venv --exclude node_modules \
     HubDashboard-v2/ /opt/bambou-hub/
cd /opt/bambou-hub && sudo python3 -m venv .venv && sudo .venv/bin/pip install -r hub/requirements.txt
sudo cp deploy/bambou-hub.service /etc/systemd/system/
sudo install -m 600 /dev/null /etc/bambou-hub.env   # then edit:
```

```dotenv
HUB_DATABASE_URL=postgresql://hubv2:...@127.0.0.1:5432/hubv2
HUB_DATA_DIR=/var/lib/bambou-hub
HUB_SECURE_COOKIES=true
HUB_RCLONE_CONFIG=/var/lib/bambou-hub/rclone.conf
```

Run the one-time setup:

```bash
set -a; . /etc/bambou-hub.env; set +a
/opt/bambou-hub/.venv/bin/python -m hub.cli migrate
# Import v1 data from a SNAPSHOT, never the live file:
sqlite3 /root/Projects/BambouBOT/HubDashboard/data/hub.sqlite3 ".backup /tmp/v1-snapshot.sqlite3"
/opt/bambou-hub/.venv/bin/python -m hub.cli import-v1 \
  --sqlite /tmp/v1-snapshot.sqlite3 --key /root/Projects/BambouBOT/HubDashboard/data/encryption.key
/opt/bambou-hub/.venv/bin/python -m hub.cli create-user <you> --role owner
```

Copy the rclone config from wherever v1's backups used it, and create the bot token:

```bash
/opt/bambou-hub/.venv/bin/python -m hub.cli bot-token      # → HUB_BOT_TOKEN for the bot
```

## 2. Verify v2 in parallel

* Build the frontend: `cd frontend && npm ci && npm run build`, then copy `dist/` to
  `/opt/bambou-hub/frontend/dist` (or set `HUB_FRONTEND_DIR`).
* `sudo systemctl start bambou-hub` — listens on 127.0.0.1:8000 only.
* Point Caddy at :8000 for a staging hostname, or SSH-tunnel:
  `ssh -L 8000:127.0.0.1:8000 hub` and browse localhost:8000.
* Log in, check the imported sites appear with correct proxies/config, run a **manual
  backup** on one site, open a log search, edit a masked `.env` value and confirm it
  reaches the VPS, and confirm a `start`/`stop` round-trip on a site whose agent is v1.
* Run the bot locally with `HUB_URL=http://127.0.0.1:8000 HUB_BOT_TOKEN=...` and try
  `/hub sites`, `/hub stats`, `/hub logs`.

## 3. Cut over

```bash
# keep a copy of v1 for rollback
sudo cp -a /root/Projects/BambouBOT/HubDashboard/data /var/backups/hub-v1-data-$(date +%F)
sudo systemctl stop hub-dashboard.service
# Caddy: reverse_proxy 127.0.0.1:8010 → 127.0.0.1:8000   (edit /etc/caddy/Caddyfile)
sudo systemctl reload caddy
sudo systemctl enable --now bambou-hub
```

Agents reconnect on their own (v1 agents via the compatibility API). Point the bot's
`HUB_URL` at the public host, restart the bot service.

## 4. Rollback (any time in the first days)

```bash
sudo systemctl disable --now bambou-hub
sudo systemctl start hub-dashboard.service
# revert the Caddy upstream to :8010 and reload
```

v2 data written after the cutover is not in v1; re-import (step 1) before a later
retry.

## 5. Move agents to v2 (per site, when convenient)

Install `agent2/` on the VPS, add `/etc/bambou-agent/<site>.conf`, and
`systemctl enable --now bambou-agent@<site>`. The site's token does not change.
Retire the old v1 agent process afterwards. Integration guide: `INTEGRATION.md`.

## 6. After cutover

* Set default alert channels and the bot token in the dashboard (**Alerts**, **Users →
  Bot token**), then link your Discord/Telegram account with `/hub link <code>`.
* Add backup destinations (rclone remotes) and per-site schedules.
* Disable the v1 service permanently and delete its code only after a quiet week.
