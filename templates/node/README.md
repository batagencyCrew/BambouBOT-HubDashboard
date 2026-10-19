# Node.js VPS starter

Node **22+**, Linux, and GNU `tar` on PATH. No npm dependencies, captcha integration, remote shell, or target-site automation. All code needed is here.

```sh
umask 077
cp --no-clobber .env.example .env
mkdir -p runtime
cp --no-clobber config.example.json runtime/config.json
cp --no-clobber proxies.example.txt runtime/proxies.txt
chmod 600 .env runtime/config.json runtime/proxies.txt
# Edit .env locally: HTTPS hub origin and site-scoped agent token required.
node --env-file=.env main.mjs
# Or export the variables yourself and run: node main.mjs
node --test
```

Never commit `.env`, runtime files, proxy credentials or cloud configuration. Tokens stay in the environment, never in runtime files or child environments. HTTPS certificate verification remains enabled; HTTP is allowed only for localhost/loopback development. Redirects are rejected. Errors are deliberately generic to avoid leaking secrets.

Actual secret files are intentionally absent; replace the sample `HUB_AGENT_TOKEN`
placeholder locally. GNU `cp --no-clobber` never overwrites existing content.
Node does **not** auto-load `.env`: the shown `--env-file=.env` flag loads it
relative to the working directory. Already exported environment values win.

| Environment name | Required/default |
| --- | --- |
| `HUB_URL` | Required HTTPS origin |
| `HUB_AGENT_TOKEN` | Required site token |
| `HUB_RUNTIME_DIR` | Optional `./runtime` |
| `HUB_STATE_DIR` | Optional; runtime directory |
| `HUB_BACKUP_DIR` | Optional; unset disables archive source |
| `HUB_BACKUP_SOURCE` | Optional fallback alias for `HUB_BACKUP_DIR` |
| `HUB_BACKUP_MAX_BYTES` | Optional positive integer, 1073741824 |
| `HUB_BACKUP_TIMEOUT_MS` | Optional positive integer, 300000 |
| `HUB_BACKUP_TEMP` | Optional; OS temp directory, outside source |

All paths resolve from the working directory. Copy examples into the chosen
runtime directory; no automatic directory search or arbitrary-file discovery.

## Local configuration

`HUB_RUNTIME_DIR` defaults to `./runtime`. Before the first run you may place `config.json` (`ai_api_key`, `number_of_workers` 0–100, `ai_preset_id`) and `proxies.txt` there. Set `HUB_RUNTIME_DIR=.` to recognize existing files at the script root. Proxy lines are canonical `http`, `https` or `socks5` URLs with explicit ports and percent-encoded credentials; blank/comment lines are ignored. No captcha key or token is written.

Enrollment always GETs config first, then local-syncs against its revision. The hub imports only while pristine. A revision conflict retries once **without** local data. Initialized hubs never reimport local edits, even if `.sync.json` is lost. Invalid local input leaves files intact. After enrollment the hub is authoritative: cleared keys and removed proxies become empty/reduced files. Config/proxy files use private temp files, fsync, rename, then `.sync.json` last. Publication is atomic **per file**, not across files; use config revision when reloading. Files are 0600 and runtime directory 0700. Site deletion revokes access but does not delete local files.

`HUB_STATE_DIR` defaults to runtime and holds stable worker UUIDs/counters, command results and backup outcomes. Do not remove command state while using the same agent identity. Paths are chosen locally only. Use private, trusted parent directories; this is not a sandbox against another process running as the same user.

No seed file or JSON key is required. Only `ai_api_key` (string),
`number_of_workers` (integer 0–100, not boolean), and `ai_preset_id` (string)
are uploaded at first enrollment; an empty AI key and zero workers are valid,
but `ai_preset_id` must be nonempty (sample `default`).
`revision` is hub-owned. Unknown keys in `config.json`, including nested settings
and secrets, survive refreshes locally but are never uploaded by configuration
sync or exposed as dynamic dashboard fields. Invalid/non-object JSON blocks
publication without replacing runtime files, even after enrollment.
Prefer separate `automation-settings.json` and local `.env` for extra settings.
There is no automatic secret inventory. AI usage key identifiers should be
nonsecret aliases, never credentials; this starter adds no AI-usage config fields
or automatic usage reporting. Optional whole-codebase backups may include these
files inside the chosen source; keep secret env files outside it or encrypt
backups when needed. Configuration-sync privacy is not a backup exclusion.

Preserved local extras do not become hub DTOs or child IPC config. Child
environments allowlist `PATH`/`NODE_ENV` plus explicit worker plumbing, so extra
`.env` secrets are **not** automatically available in hooks. Load an explicitly
chosen local settings file in your hook or locally approve passing specific
variables; never forward all `.env` values or `HUB_AGENT_TOKEN`. No automatic
runtime-path forwarding is added. See [opt-in telemetry](../TELEMETRY.md).

## Automation hooks and lifecycle

Edit `hooks.mjs:performTask({config, signal, workerId})` for your own authorized logic. `workerId` is the local supervisor slot UUID used as heartbeat `id`; use it as chat-summary `worker_id`. Spawn and config-update IPC both provide it, independently of the hub DTO. The default child loop does nothing and returns false; return true only for an actually completed task. The config includes AI settings and proxies, not the hub token. Child stdout/stderr are discarded; hook failures send sanitized `/errors` events. Generic hook-error IPC does not carry `proxy_id`: use explicit supervisor reporting helpers for attributed errors. CPU and RSS come from each child process; task counters are real hook events, persisted best-effort (a crash can lose the latest task event).

Independent loops: heartbeat 15s, lifecycle 5s, config 30s, backups 10s. Worker counts reconcile; UUID slots survive restarts and count changes. Heartbeat desired state is used **only initially**; later explicit start/stop/restart commands drive the pool. Start/restart immediately refresh config. Commands are whitelisted and completion is persisted before ack; lost acks retry without repeating actions. **Not exactly once:** a crash between local action and durable completion may repeat an action; a crash after persistence but before ack may recover according to initial desired state. Unexpected child exits respawn on lifecycle polling. No executable strings or paths from the hub are used.

## Opt-in site statistics

`API.reportStatistics(linksSentSuccessfully, averageMessagesPerChat)` is never
called automatically. In a trusted supervisor-side module at the template root:

```js
import { API } from './lib/api.mjs';

const api = new API(process.env.HUB_URL, process.env.HUB_AGENT_TOKEN);
export async function publishSiteSnapshot(siteLinksSentSuccessfully, siteAverageMessagesPerChat) {
  return api.reportStatistics(siteLinksSentSuccessfully, siteAverageMessagesPerChat);
}
```

Pass your actual whole-site accounting variables, not fabricated defaults.
This POSTs `/api/agent/statistics` with exactly `links_sent_successfully` and
`average_messages_per_chat`, both required. Counter: safe integer
0–9007199254740991; average: finite number 0–1000000000 or `null` for unknown/no
chats. Booleans, negatives, NaN/Infinity, missing and out-of-range values are
rejected before a request. The returned promise resolves to the hub snapshot.

Use one reporter per site. Reports replace both absolute values, never increment;
reposting the same snapshot is idempotent. You own aggregation, persistence and
explicit resets. Nothing automatically sends zero or derives statistics from
tasks/workers. Define successful links/chats yourself; use total messages / total
chats for a weighted average only if that matches your definitions. Otherwise
supply your real computed average or `null` when unknown. Workers have no agent
token: publish aggregates from the supervisor only, or a trusted custom caller
with the token in its environment. Never pass it to worker hooks.

## Backups

Set `HUB_BACKUP_DIR` to a local source directory (`HUB_BACKUP_SOURCE` is an alias). No source means unconfigured; on-demand requests receive a sanitized failure ack. The hub controls schedule/destinations only. Latest safe settings are atomically saved to runtime `backup-config.json`. Periodic backup is off by default on the hub; enabled intervals are clamped to >=15 minutes. On-demand works while periodic is off. Cloud credentials exist only on the hub.

Archives use fixed `tar` argv without a shell and without symlink dereferencing. Compression streams to a private temporary directory **outside the source**, never into RAM. Strictly nested runtime/state directories are excluded. Runtime and state may equal source: only known state filenames and their private temporary files are excluded at the root, not ordinary code. Local config/proxies remain source content, including secrets. `HUB_BACKUP_TEMP` defaults to the OS temp directory and must be outside the source. `HUB_BACKUP_MAX_BYTES` defaults to 1 GiB (compressed archive/upload cap); `HUB_BACKUP_TIMEOUT_MS` defaults to 300000 per archive or upload phase. Hub quotas/size failures are respected, temporary archives are cleaned on cancellation and normal failures. SIGKILL/power loss can leave a private `hub-backup-*` temporary directory for local operator cleanup.

`uploadFile(api, localFile, options)` in `lib/backup.mjs` streams arbitrary files (including empty files, no extension filter) as octet-stream, with filename/source/request ID, Content-Length, timeout and Node fetch `duplex:'half'`. Opened files must be regular, non-symlink files. Do not modify them during upload.

Upload acceptance is **not** cloud completion. Durable outcomes retain last upload time and hub backup ID. If a response is lost, request status remains unknown; the next queue poll reconciles missing requests without falsely acknowledging failure. Still-delivered requests retry. Only definite pre-upload failures or definitive client errors produce failure acks; ambiguous server/network errors do not. Scheduled ambiguous uploads wait until the next interval (no exactly-once upload guarantee). Backup journals intentionally retain outcomes; operators should archive/rotate state only with the agent stopped and no pending requests. No cloud credentials are required on the VPS.

Archives are live-tree views, not filesystem snapshots: pause writers or supply a stable snapshot directory for consistent recovery. **Whole-codebase archives include `.env` and other secrets** unless outside the selected source; protect backup destinations accordingly. Tar warnings/change detection can fail a backup. Cancellation of network requests is bounded by HTTP timeouts; shutdown aborts active backup work and stops children. Stopping a worker uses SIGTERM then SIGKILL after 3s; implement durable/idempotent task logic before adding production work.
