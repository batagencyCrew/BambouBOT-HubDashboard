# Script → Hub → Cloud backups

The hub accepts any file type as opaque binary data: `.zip`, `.rar`, `.tar.gz`, ordinary source files, database snapshots, and anything else. It does **not** extract, inspect, or execute uploaded files. Every upload is site-authenticated, streamed to private staging, hashed with SHA-256, and queued for transfer to the site's selected cloud destinations.

The dashboard's **Backups** tab manages site schedules, on-demand requests, cloud destinations, local cache, and transfer history. A queued request is not a finished backup; **Completed** means all selected cloud transfers succeeded.

## 1. Configure cloud access on the hub

The hub uses [rclone](https://rclone.org/) so the same pipeline can target Google Drive, OneDrive, S3, Dropbox, or other supported providers. Cloud credentials stay in the hub's private rclone configuration, not in scripts or dashboard API responses.

For Docker deployments, rclone is included in the image. Create a remote interactively:

```bash
docker compose exec hub rclone config --config /app/data/rclone.conf
```

For a native deployment, install rclone from its official distribution or your OS package manager, then run it as the hub service account:

```bash
rclone config --config /absolute/path/to/HubDashboard/data/rclone.conf
chmod 600 /absolute/path/to/HubDashboard/data/rclone.conf
```

The default config path is `<HUB_DATA_DIR>/rclone.conf`; override with `HUB_RCLONE_CONFIG` if needed. The hub account must be able to read **and write** this file because OAuth providers refresh their tokens. Back up the configuration privately. It contains credentials and must never be committed to GitHub.

### Google Drive

1. In `rclone config`, choose **New remote**, name it `gdrive`, and select **Google Drive**.
2. Follow rclone's OAuth instructions. On a headless VPS, choose manual/headless authentication and run `rclone authorize drive` on a trusted desktop with a browser when prompted. Paste its result only into the private configuration prompt.
3. Choose the correct Drive account/shared drive and finish configuration. See [rclone Drive setup](https://rclone.org/drive/) for provider-specific scopes and an optional private OAuth client.
4. In a site's **Backups → Cloud destinations**, refresh remotes, select `gdrive`, give the destination a name, and use a folder such as `BambouHub`.
5. Select that destination in the site's schedule configuration and save. You can select multiple destinations for independent copies.

For S3, OneDrive, or another provider, create the appropriate rclone remote and select it the same way. A destination is a configured remote name plus a relative folder—not an arbitrary URL, credential, command, or local path.

Cloud files are placed under `<folder>/<site-id>/<backup-id>/<filename>`. A new backup gets a unique ID, so later snapshots do not overwrite earlier ones. Retries of the same backup use its original target path. Changing a destination does not redirect backups already queued.

**Encryption:** rclone credentials and staged artifacts are protected by private filesystem permissions, but staged archive contents are not application-encrypted. Use encrypted hub disks and an [rclone crypt remote](https://rclone.org/crypt/) for encrypted cloud storage, or encrypt files before uploading. Preserve crypt passwords/configuration separately: losing them makes the backups unreadable. Backing up the entire codebase may include `.env` files and other secrets.

## 2. Enable the VPS supervisor's backup source

The hub never chooses a filesystem path or sends arbitrary shell commands to a VPS. Configure the source locally:

```bash
export HUB_URL=https://bamboubot.duckdns.org
export HUB_AGENT_TOKEN='your-site-agent-token'
python agent/agent.py --state-dir /var/lib/hub-agent \
  --backup-dir /opt/your-script \
  --command '/opt/your-script/.venv/bin/python /opt/your-script/main.py'
```

For the sample systemd service, add `--backup-dir /opt/your-script` to its `ExecStart` (or set `HUB_BACKUP_DIR` in `/etc/hub-agent.env`) and restart that agent service. Ensure its service user can read the source and write the agent state directory. The source must be an existing directory, not `/`, the agent state directory, or a directory beneath the agent state directory.

The Linux agent archives the directory into `.tar.gz`, including hidden files. It excludes its own state/temp directory if nested in the source, uses directory-relative descriptors with no-follow checks to prevent symlink substitution from redirecting reads, and does not silently omit `.git`, dependencies, or virtual environments. Plan file sizes accordingly. Symlinks are stored as links; runtime sockets and device nodes are not ordinary codebase file data and are skipped. Files modified while packaging may produce a failed or inconsistent snapshot: pause writes or create a consistent source/database snapshot first if required.

Point the source at the site's script tree, not the hub's staging/cache directory. Custom packers should write archives outside the source tree so previous archives do not recursively inflate future backups.

Backup packaging/upload runs on a separate thread from heartbeats and lifecycle controls. Workloads keep running during backups. A Stop command stops the worker processes, not the backup supervisor. Periodic schedules default to off; enable them in the dashboard, set an interval (15 minutes to 30 days), and select destinations. The first scheduled backup is due immediately when enabled if the agent has no previous successful upload. Schedule timing uses the VPS clock; keep time synchronized.

**Request backup** works even when the periodic schedule is off. It queues a request for the agent; an offline agent must reconnect before it can run. If no local source is configured, the agent reports an actionable failure rather than guessing a path. An upload being accepted by the hub is distinct from the cloud transfer completing.

The sample agent limits compressed archives to 1 GiB; change `--backup-max-bytes` to match the hub's configured upload limit. Packaging and transmission can take time. Graceful shutdown signals cancellation and waits briefly; blocked network I/O may outlast that wait and be abandoned at process exit. The backup thread owns its session, and interrupted private temporary files are cleaned on the next startup. No offline snapshot spool is maintained: the hub must be reachable for scheduled capture/upload, and snapshots missed during outages cannot be reconstructed afterward.

The agent saves its last accepted-upload timestamp in `backup-state.json`. If that file is corrupt, unreadable, or unwritable, only periodic backup scheduling is paused: worker supervision continues. The agent reports a sanitized warning. Repair the file/permissions and restart, or request a manual backup to establish a fresh writable checkpoint. If the hub accepts an upload but checkpoint persistence fails, the agent does not falsely acknowledge backup failure; it retries persistence separately. Lost network responses are reconciled through the request queue, though scheduled snapshots can still duplicate after crashes or uncertain acceptance (delivery is not exactly once).

## 3. Upload from any custom script

You do not have to use the supervisor, and you do not have to use an archive format. Select destination(s) for the site in the dashboard first, then send raw bytes:

```python
import os
from pathlib import Path
import requests

artifact = Path('/path/to/codebase.zip')  # any filename/type; no compression requirement
with artifact.open('rb') as stream:
    response = requests.post(
        os.environ['HUB_URL'].rstrip('/') + '/api/agent/backups/upload',
        params={'filename': artifact.name, 'source': 'direct'},
        headers={
            'Authorization': 'Bearer ' + os.environ['HUB_AGENT_TOKEN'],
            'Content-Type': 'application/octet-stream',
        },
        data=stream,
        timeout=(10, 120),
        allow_redirects=False,
    )
    if response.status_code != 201:
        raise RuntimeError(f'Backup upload failed: HTTP {response.status_code}')
    backup_id = response.json()['id']  # accepted into hub staging, not yet cloud-complete
```

Do not use `files={...}` multipart encoding for this endpoint: its body is the file itself. Requests streams the file without loading it all into RAM. Keep TLS verification enabled and use a site token, never the administrator password. A cron job or your existing scheduler can invoke your uploader periodically.

For custom on-demand handling, poll `GET /api/agent/backup-requests`, package your own codebase, then upload with `source=on_demand` and the request's `request_id`. Successful upload marks the request uploaded automatically. If packaging fails, `POST /api/agent/backup-requests/{id}/ack` with `{"status":"failed","message":"sanitized explanation"}`. Requests are delivered at least once; do not blindly repeat an upload after a lost response without checking current request state. See [full API contract](BACKUP_CONTRACT.md).

## Storage, retries, and retention

| Hub environment variable | Default |
| --- | --- |
| `HUB_BACKUP_MAX_UPLOAD_BYTES` | 1 GiB per file |
| `HUB_BACKUP_MAX_STORAGE_BYTES` | 10 GiB total local staging/cache |
| `HUB_BACKUP_RETENTION_DAYS` | 7 days for completed local cache |
| `HUB_BACKUP_TRANSFER_TIMEOUT_SECONDS` | 3,600 seconds per cloud attempt |
| `HUB_RCLONE_CONFIG` | `<HUB_DATA_DIR>/rclone.conf` |
| `HUB_RCLONE_BINARY` | `rclone` from the service's PATH |

Set Compose variables in `.env`, or export them for a native/systemd service. Restart the hub after changing settings. Update any external reverse proxy's upload size and timeouts too: the included Caddyfile permits large bodies only on the authenticated upload route. The live host's independently configured gateway may also need matching limits.

Uploads enforce per-file and shared staging quotas, including chunked uploads and concurrent reservations. HTTP 413 means file too large; 507 means staging quota exhausted; missing/invalid destinations or credentials cause rejection. A cloud outage does not turn a failed transfer into a successful backup: the hub retries with backoff and exposes terminal failures for manual retry. Retry requires the artifact still be cached and the destination enabled.

Count limits also protect against empty/tiny-file exhaustion: cached/incoming artifacts are capped at 2,000 per site and 10,000 globally; active backups at 100 per site / 1,000 globally; concurrent uploads at 5 per site / 20 globally. A site can select at most 20 of the hub's 100 destinations. Backup/request metadata is capped at 10,000 combined rows per site / 100,000 globally. At those limits, the oldest eligible terminal history with no cached file or pending-request dependency is pruned; active/cached records are protected. This never deletes cloud files. If nothing is eligible, new work is rejected with an actionable limit error. Export any long-term audit records you require separately.

Completed local artifacts expire after retention. Failed artifacts remain available for retry or manual local-cache eviction. The dashboard's cache deletion removes only the hub copy, not cloud copies or history. It refuses eviction while an upload/transfer is active. Cloud retention is **not** automatically destructive: configure lifecycle/retention policies with the cloud provider if desired. Monitor actual VM disk space as well as application quotas.

Run only one hub application process/replica with this SQLite-backed worker. Queue state survives restart; interrupted transfers are retried, incomplete uploads are failed/cleaned, and transfer success is recorded only after rclone exits successfully. The SHA-256 shown by the hub covers bytes received into staging; provider-dependent rclone checksum verification is not a universal end-to-end integrity guarantee.

Blocking disk/database upload operations run in a bounded background thread pool, not on the API event loop. Cloud outcomes are journaled privately before database finalization so a transient database error or restart does not unnecessarily repeat a successfully finished copy.

## Recovery

Download a cached artifact from the dashboard while available, or use rclone to retrieve its cloud folder into a separate restore directory. Verify the SHA-256 and inspect the archive before extracting it into an application tree. The hub never automatically restores or executes backups. Keep copies of the hub database, encryption/signing keys, rclone config, and any crypt passwords in separate secure recovery storage. A backup is only useful if restoration is tested.

Dashboard downloads are authenticated and buffer into browser memory. For very large artifacts or slow links, retrieve the cloud copy directly with rclone instead. Avoid secrets in filenames, which may appear in access logs. If a cloud transfer fails, check the configured remote privately with rclone using the same service account/config file; do not paste OAuth tokens or unreviewed diagnostic output into bug reports.
