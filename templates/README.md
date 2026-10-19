# VPS automation starters

Choose one implementation per site/VPS worker pool:

| Language | Starter | Runtime |
| --- | --- | --- |
| Python | [python/](python/README.md) | Python 3.12+, shared `agent/` modules |
| Node.js | [node/](node/README.md) | Node.js 22+ on Linux |
| Go | [go/](go/README.md) | Go 1.24+ on Linux |

These are runnable infrastructure starters, not finished site automations. Add permitted business logic at each starter's documented worker hook. They implement authentication, lifecycle commands, worker health/telemetry, error reporting, local config/proxy synchronization, periodic/on-demand backups, and arbitrary-file uploads. Captcha integration is intentionally omitted.

## Common setup

1. Create a site in the dashboard and save its one-time agent token.
2. Install/copy the selected template and its required shared files to the VPS.
3. Set these environment variables (do not commit real values):

```bash
export HUB_URL=https://bamboubot.duckdns.org
export HUB_AGENT_TOKEN='your-site-token'
export HUB_RUNTIME_DIR=/opt/your-script/runtime
export HUB_STATE_DIR=/var/lib/your-script-hub
export HUB_BACKUP_DIR=/opt/your-script
```

4. Start the selected language's entrypoint following its README. Use a non-root service account and retain its state directory across restarts.
5. Configure AI key, workers, preset, proxies, and backup destinations in the dashboard. Start worker processes with **Start**. Periodic backups are configured separately and can run while workers are stopped.

Only one supervisor should use a site's token. Use separate runtime and state directories per site; do not reuse one site's secret files/checkpoints for another site. If multiple languages/VPSes each have independent worker pools, give them separate sites/tokens. Starting a second supervisor under the same site token overwrites worker snapshots and competes for lifecycle requests.

## Existing `proxies.txt` and local configuration

Set `HUB_RUNTIME_DIR` (or Python `--runtime-dir`) to the directory containing your existing `proxies.txt` and optional `config.json`. If they live at the script root, point it there instead of creating a new `runtime` subdirectory. Existing proxy files support the formats in [proxy import documentation](../docs/PROXY_IMPORT.md).

On first enrollment, local configuration and proxies are imported **only if the site's dashboard settings are still untouched**. If an administrator already configured the site, the dashboard wins. Enrollment uses a revision check to avoid races. Invalid local files are rejected without silently overwriting them. Files must be UTF-8; `config.json` is a JSON object, for example:

```json
{
  "ai_api_key": "",
  "number_of_workers": 2,
  "ai_preset_id": "default"
}
```

All three starters ship `.env.example`, `config.example.json`, and comments-only
`proxies.example.txt`. Actual secret files are intentionally absent. From your
selected language directory, create actual files without overwriting local work:

```sh
umask 077
cp --no-clobber .env.example .env
mkdir -p runtime
cp --no-clobber config.example.json runtime/config.json
cp --no-clobber proxies.example.txt runtime/proxies.txt
chmod 600 .env runtime/config.json runtime/proxies.txt
```

Replace the `HUB_AGENT_TOKEN` placeholder locally. Commands assume GNU `cp` on
Linux; match the copy destination to `HUB_RUNTIME_DIR`. For an existing script
root use `config.json` / `proxies.txt` there and `HUB_RUNTIME_DIR=.` instead.

Required environment: **`HUB_URL`, `HUB_AGENT_TOKEN`**. Optional names/defaults
are listed in each language README. Python loads `.env` beside `main.py` using
python-dotenv without overriding existing environment variables. Node loads it
only with `node --env-file=.env`; Go does not load it (use shell/service exports).

No JSON field is required. Optional first-enrollment upload fields are exactly
`ai_api_key` (string), `number_of_workers` (integer 0–100, not boolean), and
`ai_preset_id` (nonempty string; sample `default`). An empty AI key and zero workers are supported. `revision`
is hub-owned, not an enrollment field. Proxy input is optional; the comments-only
sample imports an empty pool.

After enrollment, the hub is authoritative for managed fields. Agents publish these owner-only local files:

| File | Contents |
| --- | --- |
| `config.json` | AI API key, worker count, preset ID, hub revision; existing extra local keys preserved |
| `proxies.txt` | Complete proxy pool, including URL-encoded credentials if needed |
| `backup-config.json` | Latest backup schedule and destination IDs, never cloud credentials |
| `.sync.json` | Enrollment/revision checkpoint, never a hub token |

Dashboard saves update the files on the next config poll (normally within 30 seconds). Start/restart reloads immediately. Proxy deletions remove corresponding lines; deleting the last proxy produces an empty `proxies.txt`. Clearing the AI key writes an empty string. Per-file updates use private temporary files and atomic replacement; publication is not a multi-file filesystem transaction.

The managed JSON keys are `ai_api_key`, `number_of_workers`, `ai_preset_id`, and
`revision`. Other keys, including nested settings and arbitrary secrets, are
preserved locally, **not uploaded through configuration sync or exposed in the
dashboard**. Invalid/non-object JSON blocks publication without replacing runtime
files; repair it locally. Prefer a separate `automation-settings.json` and local
`.env` for unrelated settings/secrets. There is no automatic secret inventory,
file discovery, arbitrary-key upload, or dynamic dashboard configuration.
AI usage reporting key identifiers should be **nonsecret aliases**, never raw
credentials; these starters add no AI-usage config fields or automatic reporting.

This is a configuration-sync guarantee, **not a backup exclusion**. Optional
whole-codebase backups may include config, `automation-settings.json`, and `.env`
inside the selected source (see language-specific exclusions). Keep secret env
files outside the backup source or encrypt backups when needed. Explicit file
uploads also send the file you select.

Preservation does **not** automatically wire extras into worker config/IPC or
hub DTOs. Developers must load local settings explicitly inside worker hooks or
approve specific environment variables locally. Python inherits the supervisor
environment minus hub credentials; Node child environments allowlist `PATH` and
`NODE_ENV` plus explicit worker plumbing (no automatic extra `.env` secrets);
Go hooks run in the same process. Never forward all `.env` values or
`HUB_AGENT_TOKEN` to workers. See [opt-in telemetry](TELEMETRY.md).

**Local edits are not continuously pushed back.** After enrollment edits to managed fields are overwritten by the next hub refresh; extra keys remain local. This prevents stale VPS files, restores, or lost checkpoints from resurrecting proxies deleted in the dashboard. To intentionally add a changed local proxy pool later, use the dashboard's file import. Site deletion revokes authentication but does not remotely erase local code or files; an operator must remove them on the VPS if desired.

Sites that existed before the local-sync upgrade are conservatively treated as already configured, because the hub cannot prove their settings were never edited. Their existing dashboard state wins; use dashboard proxy-file import for an intentional initial merge.

## Worker integration

The sample workers are harmless and have no target website behavior. Replace their work hooks, not the control-plane authentication or remote-command validation. Report actual completed tasks and sanitized errors. CPU accounting differs by language/runtime and may cover a process or worker pool rather than an individual async task; consult each README. Zero metrics are “not instrumented,” not a claim of zero resource usage.

Start/stop/restart are the only accepted lifecycle operations. Never evaluate arbitrary strings from the hub as shell commands or code. Completed IDs are persisted before acknowledgment so retries do not usually repeat actions; a crash between the local action and its persistence still creates an unavoidable at-least-once delivery window. Make hooks idempotent.

## Backups

Configure a source locally through `HUB_BACKUP_DIR`, and select cloud destinations in the dashboard. The source path is never supplied by the hub. Templates package `.tar.gz` snapshots and also expose an arbitrary-file upload helper; files go **VPS → hub staging → rclone cloud destination(s)**. No cloud credentials belong on a VPS.

The backup loop runs independently of worker controls. On-demand requests are distinct from lifecycle commands and cloud transfer completion. Archives include hidden files and may contain secrets—use encrypted storage or encrypt artifacts before uploading. Do not dereference symlinks, write temporary archives into the source, or back up a directory while a separate process can maliciously replace its entries; use a stable tree or filesystem snapshot for consistency. Read each language's archive safety limitations. The Python shared agent additionally uses no-follow descriptor traversal.

Cloud setup, quotas, integrity, retention, and recovery: [BACKUPS.md](../docs/BACKUPS.md). API reference: [CONTRACT.md](../CONTRACT.md), [backup contract](../docs/BACKUP_CONTRACT.md), and [local sync contract](../docs/VPS_TEMPLATE_CONTRACT.md).

## Security and deployment

A [systemd service example](site-agent.service.example) supports all three entrypoints. Choose one `ExecStart`, create the non-root `automation` user, set the proper source/runtime permissions, and put environment settings in root-owned mode-0600 `/etc/your-script-hub.env`. The service user must be able to write `HUB_RUNTIME_DIR` and `HUB_STATE_DIR` and read the backup source. Do not run all three services for one site. Copy the edited unit to `/etc/systemd/system/your-script-agent.service`, then use `systemctl daemon-reload` and `systemctl enable --now your-script-agent`.

- Use HTTPS with certificate verification. HTTP is allowed only on localhost for testing.
- Hub tokens stay in environment/service secrets. Runtime files contain AI/proxy credentials: keep them mode `0600`, their directory private, and out of Git.
- Archive contents, AI keys, proxy passwords, authorization headers, and raw upstream response bodies must never appear in logs.
- Configure a systemd/container restart policy, suitable shutdown grace period, restricted filesystem access, and reliable clocks.
- Losing hub connectivity does not automatically stop running workers. Use direct VPS access for emergency intervention.
- The templates synchronize infrastructure; you remain responsible for site authorization, business logic, service limits, and safe handling of any job data.
