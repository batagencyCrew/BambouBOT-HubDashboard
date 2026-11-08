# Deployment and operations (hub host)

How v2 runs on the hub host, how it got there from v1, and how to operate,
update and roll back. Run commands as root.

## Layout

| Piece | Where |
| --- | --- |
| Public URL | `https://bamboubot.duckdns.org` (Caddy, Let's Encrypt) |
| Hub service | `bambou-hub.service`, uvicorn `hub.main:app` on **127.0.0.1:8020** (port 8000 is used by another service on this box) |
| Hub code | `/opt/bambou-hub` (root-owned, read-only to the service) |
| Hub env | `/etc/bambou-hub.env` (mode 600) |
| Hub data | `/var/lib/bambou-hub`: `hub-secret.key`, `rclone.conf`, `backups/` staging (owned by `bambou`) |
| Database | Postgres 16, database `bambouhub`, role `bambouhub` |
| Bot service | `bambou.service`: one Node process for Discord and Telegram, code in `/opt/bambou-bot` |
| Bot env | `/opt/bambou-bot/.env` (mode 600): bot tokens plus `HUB_URL`, `HUB_BOT_TOKEN` |
| Bot state | `/var/lib/bambou/access.json` (merged approvals from both old bots) |
| v1 backup | `/var/backups/hub-v1-<timestamp>/` (path in `/root/.hub-v1-backup-path`) |
| Disabled v1 units | `hub-dashboard.service`, `hub-dashboard-tunnel.service`, `bambou-discord.service`, `bambou-telegram.service` |

`/etc/bambou-hub.env`:

```dotenv
HUB_DATABASE_URL=postgresql://bambouhub:<generated>@127.0.0.1:5432/bambouhub
HUB_DATA_DIR=/var/lib/bambou-hub
HUB_SECURE_COOKIES=true
HUB_RCLONE_CONFIG=/var/lib/bambou-hub/rclone.conf
HUB_FRONTEND_DIR=/opt/bambou-hub/frontend/dist
```

**Back up `/var/lib/bambou-hub/hub-secret.key` together with the database.** Stored
config files (including `.env` secrets) are encrypted with it. A database restore
without this key cannot decrypt them.

## Logging in

User `admin` (role owner), with the same password as v1's `HUB_ADMIN_PASSWORD`.
Create more users under **Users** in the dashboard, or from the command line:

```bash
cd /opt/bambou-hub && set -a && . /etc/bambou-hub.env && set +a
.venv/bin/python -m hub.cli create-user <name> --role operator    # prompts for a password
```

Running `create-user` for an existing name resets its password.

## How the v1 → v2 switch was done (for reference / repeat)

1. **Backup.** Copied v1's `hub.sqlite3` (online `.backup`), `encryption.key`,
   `signing.key`, `/etc/hub-dashboard.env`, the Caddyfile and `rclone.conf` to
   `/var/backups/hub-v1-<timestamp>/`.
2. **Install.** Rsynced the repo to `/opt/bambou-hub` and created its venv:
   `pip install -r hub/requirements.txt`. Built the dashboard with
   `cd frontend && npm ci && npm run build`.
3. **Database.** Ran `deploy/setup-postgres.sh bambouhub bambouhub`, wrote
   `/etc/bambou-hub.env`, then ran `hub.cli migrate`.
4. **Owner.** Ran `hub.cli create-user admin --role owner` with v1's admin password.
5. **Parallel check.** Started `bambou-hub` on :8020 next to v1 (:8010), then:
   * replayed every v1 agent call against it with a temporary token
   * logged in through a browser and opened every screen
6. **Freeze and final import.**
   * Stopped `hub-dashboard` and its tunnel.
   * Took a final SQLite backup.
   * Recreated the `bambouhub` schema and ran
     `hub.cli import-v1 --sqlite <final backup> --key <encryption.key>`.
   * The import brought over 4 sites with their ids and agent-token hashes, managed
     `config.json` and `proxies.txt`, 2,001 log entries, 9 commands and 36,001 metric
     points.
7. **Switch.** In `/etc/caddy/Caddyfile`, the `bamboubot.duckdns.org` block's
   `reverse_proxy 127.0.0.1:8010` became `127.0.0.1:8020`. Ran `caddy validate`, then
   `systemctl reload caddy`. Original saved as `Caddyfile.bak-before-hub-v2`.
8. **Boot.** Enabled `bambou-hub`; disabled `hub-dashboard` and `hub-dashboard-tunnel`.
9. **Agents.** The two live VPS agents reconnected on their own through the v1
   compatibility API, with no token changes. Every call returned 200 or 201.
10. **Bots.**
    * Copied `BambouBot/` to `/opt/bambou-bot`, keeping its `.env`, and created a
      bot token with `hub.cli bot-token`.
    * Appended `HUB_URL` and `HUB_BOT_TOKEN` to `.env`.
    * Merged the two old access files with `npm run migrate:access … --write`
      (4 approved Discord users).
    * Disabled `bambou-discord` and `bambou-telegram`, then installed and started
      `bambou.service`.

## Day-to-day

```bash
systemctl status bambou-hub bambou            # health
journalctl -u bambou-hub -f                    # hub log
journalctl -u bambou -f                        # bot log
curl -s https://bamboubot.duckdns.org/api/health
```

Link your Discord or Telegram account to your hub user: **Users → Link code** in the
dashboard, then send `/hub link <code>` to the bot. Set where alerts go under
**Alerts → Default channels**:
* Discord: `guildId:channelId`
* Telegram: chat id, or `chatId:threadId` for a forum topic

## Updating

```bash
cd /root/Projects/BambouBOT/HubDashboard-v2 && git pull           # or any checkout of main
rsync -a --delete --exclude .venv --exclude node_modules --exclude .git --exclude data \
      --exclude 'BambouBot/.env' --exclude 'BambouBot/data' ./ /opt/bambou-hub/
cd /opt/bambou-hub && .venv/bin/pip install -q -r hub/requirements.txt
(cd frontend && npm ci && npm run build)
chown -R root:root /opt/bambou-hub
systemctl restart bambou-hub          # runs pending database migrations on start

# bot
rsync -a --delete --exclude .env --exclude data --exclude node_modules BambouBot/ /opt/bambou-bot/
(cd /opt/bambou-bot && npm ci --omit=dev)
systemctl restart bambou
```

## Backups of the hub itself

```bash
sudo -u postgres pg_dump -Fc bambouhub > /var/backups/bambouhub-$(date +%F).dump
cp /var/lib/bambou-hub/hub-secret.key /var/backups/hub-secret.key    # once; it never changes
```

Restore with `pg_restore -d bambouhub --clean <dump>`, using the same `hub-secret.key`.

## Rolling back to v1

v1's code and data are untouched in `/root/Projects/BambouBOT/HubDashboard`.

```bash
systemctl disable --now bambou-hub bambou
cp /etc/caddy/Caddyfile.bak-before-hub-v2 /etc/caddy/Caddyfile && systemctl reload caddy
systemctl enable --now hub-dashboard hub-dashboard-tunnel bambou-discord bambou-telegram
```

v1 resumes from its state at the switch. Anything recorded in v2 after the switch
stays in Postgres but is not visible in v1.

## Moving a VPS to the v2 agent

The two live VPSes still run the **v1** agent, which works through the compatibility
API. Moving them to `bambou-agent` adds:
* per-worker logs from inside the script
* costs
* pause/resume
* file sync for `.env`
* instant commands

Follow [INTEGRATION.md](INTEGRATION.md). The site's token stays the same. Stop the v1
agent on that VPS once the new one is reporting.
