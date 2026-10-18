# Public hub deployment (Docker Compose + Caddy)

## 1. Prepare a hub VPS

Use a current Linux distribution, Docker Engine, and Docker Compose v2. A small hub can start with 1 CPU / 1 GB RAM, but building the frontend may require more memory. Keep automations on their separate VPSes.

Create a DNS `A` record, e.g. `hub.example.com`, pointing at the hub VPS's public IPv4. Add `AAAA` **only if IPv6 actually works**. With a DNS proxy provider, start with DNS-only until certificate issuance works.

Allow inbound TCP 80 and 443 (optionally UDP 443 for HTTP/3) in both the provider firewall and host firewall. Keep SSH restricted to trusted IPs. **Do not open TCP 8000 or SQLite to the internet.** Agents only require outbound HTTPS to the hub; no inbound agent ports are needed. Do not enable a restrictive firewall before ensuring SSH remains allowed.

## 2. Configure and launch

Copy this entire `HubDashboard/` directory to the hub VPS, then:

```bash
cd /opt/HubDashboard
cp .env.example .env
chmod 600 .env
python3 -c 'import secrets; print(secrets.token_urlsafe(36))'
```

Edit `.env`: set `HUB_DOMAIN` to a bare hostname (no scheme/path), `ACME_EMAIL` to a real certificate contact address, and `HUB_ADMIN_PASSWORD` to the generated password. Store it in a password manager. Do not commit `.env` or share it.

```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 hub caddy
```

Caddy obtains and renews TLS certificates automatically and redirects HTTP to HTTPS. Open `https://hub.example.com`, log in, create a site, and enroll its agent using the one-time token. Test public connectivity from the automation VPS:

```bash
curl --fail https://hub.example.com/api/health
```

Expected: `{"status":"ok"}`. Do not use `curl -k`, disable certificate checking, or transmit keys over public HTTP.

The `hub` container has no published host port. Docker's named `hub_data` volume holds the database and generated cryptographic keys; `caddy_data` holds TLS assets. **Do not run `docker compose down -v`** unless you intend to destroy persistent data. Use only one hub application process/replica with this SQLite setup. Multi-node HA needs a shared database and shared session/key management.

## 3. Credentials and trust

- Use a long unique administrator password. Dashboard access tokens expire after eight hours; treat them as credentials. Use a private browser on trusted devices.
- To rotate the administrator password, update `.env` and run `docker compose up -d hub` to recreate the service. Sessions issued under the old password are invalidated.
- Agent tokens are site-scoped and stored hashed by the hub. Regenerate compromised tokens in the site dashboard, update `/etc/hub-agent.env`, and restart the affected agent service.
- AI keys, captcha keys, and proxy passwords are encrypted at rest, but the trusted agent receives plaintext over TLS. Disk encryption protects against more host-level exposure; application encryption does not protect a compromised running hub.
- Preserve the generated encryption/signing keys alongside the database in `hub_data`. Losing encryption keys makes stored secrets unrecoverable. Restoring an old database can revive older agent credentials: rotate them after a security incident.
- Never place production keys into screenshots, bug reports, URLs, source control, or error messages.
- For higher assurance, place admin access behind a VPN/SSO gateway. Ensure its policy still permits authenticated agent API requests and health checks. No CORS wildcard is needed with the bundled same-origin dashboard.

## 4. Backup and recovery

Back up the **whole** data volume, including hidden files and encryption/signing keys. The simplest consistent backup stops the application briefly (agents continue their current workload). From the project directory:

```bash
mkdir -p backups
chmod 700 backups
docker compose stop hub
docker compose run --rm --no-deps --entrypoint tar hub -C /app/data -czf - . > backups/hub-data.tgz
docker compose start hub
chmod 600 backups/hub-data.tgz
```

Always restart the hub if a backup command fails. Store encrypted, versioned copies off-host, and back up `.env` separately in a secrets manager. Copying a live SQLite database file alone is unsafe, especially with WAL enabled. Back up agent state directories too; those hold completed-command deduplication records.

To restore on a compatible installation, first stop the hub and restore the archive into an **empty** data volume, preserving file ownership (UID 10001). Do not overwrite a live database. For example, with a fresh Compose project/volume:

```bash
docker compose create hub
docker compose run --rm --no-deps --entrypoint tar -T hub -C /app/data --no-same-owner -xzf - < backups/hub-data.tgz
docker compose up -d
```

If the destination already has data, first retain a backup and use a fresh volume/project rather than merging databases and key files. Test recovery periodically.

## 5. Updates and troubleshooting

Back up first, copy new source, then run `docker compose up -d --build`. Keep the previous source/image and a matching backup for rollback; future database changes may need migration-aware recovery. Update Caddy periodically with `docker compose pull caddy` and `docker compose up -d`.

| Symptom | Check |
| --- | --- |
| TLS certificate fails | DNS, stale AAAA, TCP 80/443 reachability, other services occupying ports, ACME logs |
| Dashboard says offline | Agent service logs, correct site token, outbound HTTPS, hub time synchronization |
| Command stays delivered/pending | Agent reachability and local worker command; delivered is not an acknowledgement |
| Workers error | Local script dependencies, absolute paths, permissions; use Restart after fixing |
| Config seems stale | Agent polls every 30s; restart workers after secret/preset/proxy changes |
| Login fails | Correct container environment/password, host clock; inspect hub logs without publishing secrets |
| Browser cannot call API | Use bundled same-origin deployment or the Vite dev proxy, not an unrestricted CORS workaround |

Monitor disk capacity and log growth; SQLite and site error history are intended for a modest control plane, not a high-volume log warehouse. Add external monitoring for `/api/health`, VM disk/memory, and backups. The health endpoint confirms the hub is reachable, not that every site is healthy.

## Script backup routing

The image includes rclone. Configure a provider remote using `docker compose exec hub rclone config --config /app/data/rclone.conf`, then add/select its destination in the dashboard's **Backups** tab. The same persistent volume holds staging files and the private rclone configuration; account for cache size when backing up the volume itself. Application quotas default to 1 GiB/upload and 10 GiB total cache, so provision additional VM disk capacity or tune `.env` accordingly. Only the backup-upload route bypasses the regular 1 MiB request limit in the included Caddy configuration. See [full backup setup and recovery](../docs/BACKUPS.md).
