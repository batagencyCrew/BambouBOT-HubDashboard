# Go VPS starter

Runnable Linux starter, standard library only, Go 1.24+ (verified with Go 1.24.6).
No captcha integration, target-site automation, cloud credentials, or remote shell.

```sh
umask 077
cp --no-clobber .env.example .env
mkdir -p runtime
cp --no-clobber config.example.json runtime/config.json
cp --no-clobber proxies.example.txt runtime/proxies.txt
chmod 600 .env runtime/config.json runtime/proxies.txt
# Edit .env locally (replace HUB_AGENT_TOKEN placeholder), then in a trusted shell:
set -a
. ./.env
set +a
go run .
# Or build/run without arguments:
go build -o /tmp/bambou-agent .
/tmp/bambou-agent
```

Configure environment variables from `.env.example` in your service manager or
shell. The program deliberately does **not** load `.env` files or persist tokens.
Only HTTPS origins are accepted, except loopback HTTP for development. TLS
certificate verification stays enabled, redirects and environment HTTP proxies
are disabled, requests have deadlines. Responses/errors never get logged verbatim.
Use one process per site/runtime/state directory (no cross-process lock).

Actual `.env`/credential files are intentionally absent. GNU `cp --no-clobber`
does not overwrite existing content. Sourcing `.env` executes shell syntax: only
source your own trusted file. The shown shell exports its values (overriding
existing ones); Go itself never parses `.env`. A service manager may load an
external environment file instead. Relative paths use the working directory.

| Environment name | Required/default |
| --- | --- |
| `HUB_URL` | Required HTTPS origin |
| `HUB_AGENT_TOKEN` | Required site token |
| `HUB_RUNTIME_DIR` | Optional `./runtime` |
| `HUB_STATE_DIR` | Optional `state/` under runtime |
| `HUB_LOCAL_CONFIG` | Optional `./localconfig.json`, only if runtime config missing |
| `HUB_LOCAL_PROXIES` | Optional `./localproxies.txt`, only if runtime proxies missing |
| `HUB_BACKUP_DIR` | Optional; unset disables archive source |
| `HUB_BACKUP_TEMP_DIR` | Optional; existing OS temp directory, outside source |
| `HUB_BACKUP_MAX_BYTES` | Optional positive integer, 1073741824 |

These are explicit paths, not automatic directory/file discovery. Copy examples
to the runtime you select; fallback seed files are never overwritten.

## Local files and enrollment

- `HUB_RUNTIME_DIR` defaults to `./runtime`; `HUB_STATE_DIR` defaults to its `state/`
  subdirectory. Both directories are owner-only; files are mode 0600. An existing
  script root is allowed as runtime (its directory permissions become 0700).
- Before first launch, optionally place `config.json` and `proxies.txt` in runtime.
  Missing files fall back to `HUB_LOCAL_CONFIG` (`./localconfig.json`) and
  `HUB_LOCAL_PROXIES` (`./localproxies.txt`). Config seed example:
  `{"ai_api_key":"…","number_of_workers":2,"ai_preset_id":"…"}`. Revision is ignored.
- Proxy URL lines support HTTP/HTTPS/SOCKS5, comments and blank lines. Credentials
  must be percent-encoded, e.g. `http://user:p%40ss@[::1]:8080`. Hub proxy API URL
  fields remain credential-free; local publication uses `net/url` credential
  escaping and preserves IPv6 brackets. Local seeds are validated atomically by
  the hub; a rejected import leaves the seed files unchanged.
- Enrollment first GETs `/api/agent/config`, then POSTs `/local-sync` with its
  expected revision, even with no seed fields. Only a pristine hub imports seeds.
  A 409 triggers one fresh GET and a revision-only retry, never a stale reimport.
  Missing local checkpoints cannot resurrect deleted hub proxies: server-side
  enrollment/admin-modification guards are authoritative.
- After enrollment the hub wins for managed fields, including empty keys and deleted proxies. Each
  startup reloads immediately; config polls every 30s. `config.json` contains
  AI key, worker count, preset and revision plus preserved extra local fields;
  `proxies.txt` contains canonical URLs.
  Private temp files are fsynced and renamed, then `.sync.json` is written last.
  Publication is **per-file atomic**, not a multi-file transaction: consumers
  should check/re-read config revision after reload. Manual managed-field edits are overwritten.
- Every backup-config GET also publishes the latest safe settings in
  `backup-config.json` (no cloud credentials). Poll cadence is 30s when backup
  work is idle. Dashboard site deletion revokes access, but never deletes local
  code or private files. Local operator cleanup is explicit.

No seed file or JSON key is required. First-enrollment upload allowlist:
`ai_api_key` (string), `number_of_workers` (integer 0–100, not boolean),
`ai_preset_id` (nonempty string; sample `default`). Empty AI keys and zero workers are valid. `revision`
is hub-owned. Unknown keys in runtime `config.json` are preserved locally,
including nested settings/secrets, but never uploaded through configuration sync
or exposed in the dashboard. Invalid/non-object JSON blocks publication without
replacing runtime files, even after enrollment. Fallback `localconfig.json`
remains untouched; its extra keys are not copied into runtime or uploaded.
Prefer separate `automation-settings.json` and local `.env` for extra settings.
There is no automatic secret inventory or dynamic dashboard configuration.
AI usage key identifiers should be nonsecret aliases, not credentials; no AI-usage
config fields or automatic reporting are added. Optional backups may include
these files inside the source; keep secret env files outside it or encrypt
backups when needed. Configuration-sync privacy is not a backup exclusion.

Preservation does not wire extras into the typed hub `Config`. Hooks must load
explicitly selected local settings themselves. Go hooks run in the supervisor
process and share its environment: do not expose its token or indiscriminately
forward environment secrets to subprocesses. See the
[opt-in telemetry helpers](../TELEMETRY.md).

## Workers and integration hooks

Independent goroutines handle heartbeat (15s), lifecycle commands (5s), config
(30s), error reporting and backups. `workers.go`'s `placeholder` / `Hook` is the
only business-logic extension point: replace it with a bounded, context-aware unit
of **your own** work. The provided hook is harmless and completes no tasks.
Return `completed=true` only for real work. Hooks receive the current config;
they must honor cancellation for stop/restart/shutdown to finish. Hook errors and
panics produce static sanitized worker error reports, not secret-bearing strings.

Worker count reconciles live context workers. Random UUIDs identify each worker
lifetime. Tasks are actual hook-completion counters (not durable across worker
replacement). Memory is the actual Go allocated heap apportioned across workers,
not individual goroutine RSS; CPU is unavailable and reported as zero. Snapshot
status reflects idle/running/error work. No synthetic task/CPU measurements.

`desired_state` is used for initial recovery only; explicit start/stop/restart
commands then control local state. Unknown actions fail, never execute.
Start/restart first fetch and publish fresh configuration, including key clearing,
proxy deletions and worker-count changes; a refresh failure fails the command
without performing its lifecycle action. Stop does not depend on config access.
Durable
`commands.json` records outcomes **after the local action and before ack**;
failed acknowledgements retry without repeating the action. Successful/pruned/
superseded acknowledgements are marked separately; completed IDs are retained.
A crash between action and journal publication can replay an action: this is
at-least-once, **not exactly-once**. Corrupt journals fail closed. Keep state across
restarts; do not share or casually delete it. Journals grow with command history.

## Opt-in site statistics

`API.ReportStatistics(ctx, linksSentSuccessfully, averageMessagesPerChat)` is
never called automatically. Add a supervisor-side function in this template's
`package main`, using the existing API instance and real accounting arguments:

```go
package main

import "context"

func publishSiteSnapshot(ctx context.Context, api *API, siteLinksSentSuccessfully int64,
    siteAverageMessagesPerChat *float64) (Statistics, error) {
    return api.ReportStatistics(ctx, siteLinksSentSuccessfully, siteAverageMessagesPerChat)
}
```

Pass a pointer to your actual computed average, or `nil` for unknown/no chats.
POST `/api/agent/statistics` contains exactly `links_sent_successfully` and
`average_messages_per_chat`, both required (nil encodes as null, not omitted).
Counter: integer 0–9007199254740991; average: finite number 0–1000000000 or nil.
Typed parameters exclude boolean/noninteger counters; negatives, NaN/Infinity
and out-of-range values fail before any request. The result is the hub snapshot.

Use one reporter per site. Supply absolute **whole-site** snapshots, not increments
or worker/task counters: each report replaces both values, so identical retries
do not add counts. You own aggregation, persistence and explicit resets. Nothing
sends zero automatically; zero must be a real measured value. Define successful
links/chats yourself. Use total messages / total chats for a weighted average
only if those match your definitions, otherwise your real computed average or
nil when unknown. Report only from trusted supervisor-side code (or a trusted
custom caller using the agent token from its environment), not worker hooks;
never expose the token to child processes.

## Backups

Set `HUB_BACKUP_DIR` to the locally authorized source directory. It is never taken
from the dashboard. `HUB_BACKUP_TEMP_DIR` defaults to the OS temp directory and
must exist **outside** that source. `HUB_BACKUP_MAX_BYTES` (default 1 GiB) bounds
both total uncompressed regular-file bytes and the compressed artifact. Upload
limits on the hub may be lower. Files and gzip/tar output stream, not whole-RAM
buffering; temporary archives are private and removed on cancellation/failure.

The backup goroutine polls `/backup-config`, reports `/backup-status`, and polls
`/backup-requests` every 5s when idle. Scheduled backups are off by default in the
hub and require an interval of 15+ minutes; a fresh enabled agent runs its first
scheduled backup immediately. On-demand requests work even with periodic off.
Accepted upload timestamps and attempts persist in state. Slow backups cannot
block lifecycle, heartbeat or worker config polling. Within the backup goroutine,
archive/upload work is serialized and can delay further backup polls/status.

`API.UploadFile(ctx, localPath, filename, source, requestID, maxBytes)` also streams
any regular file as `application/octet-stream`, including empty files, without an
extension filter. Source is `direct`, `scheduled` or `on_demand`; on-demand requires
the request UUID. No rclone/cloud credentials are required on the VPS.

Archives preserve symlinks **without dereferencing**, skip devices/FIFOs/sockets,
and exclude nested runtime/state/temp directories. If runtime/state equals source,
only this agent's managed files are excluded, retaining the codebase. Final-file
symlink swaps are rejected using Linux `O_NOFOLLOW`; this is **not a snapshot** or
a defense against an adversary concurrently replacing parent directories. Use a
stable tree or filesystem snapshot. Whole-codebase backups can contain `.env`,
local seed keys and other secrets: configure trusted hub destinations accordingly.

Known pre-upload archive failures and definite client rejections (such as 413)
are acknowledged failed only after a **fresh** request-queue GET confirms the same
request is still delivered with no `backup_id`. Prior ambiguous attempts always
prevent a failure ack, even if a later attempt is rejected. Before upload, a
durable `uncertain` record and attempt count are saved. Lost response, timeout or
cancellation never falsely claims failure after possible acceptance. The next
queue poll reconciles disappearance or a linked `backup_id` before any retry.
Success responses record acceptance, not cloud delivery. A still-delivered request
with no `backup_id` retries using the same ID after 30s then 60s backoff, with a
strict **three total attempts**, persisted across restart. This is not exactly-once:
a fresh queue read cannot prove a previous server operation has finished. At the
limit an ambiguous request stays unfailed and emits a sanitized warning with its
UUID; inspect hub history and, if necessary, manually upload using that request ID
or ask the hub operator to resolve it. Terminal queue absence does not fabricate
a successful-upload timestamp. A crash before network dispatch can consume an
attempt. State must be preserved to retain the retry bound.
Scheduled attempts are rate-limited by the configured interval even on errors;
an ambiguous scheduled upload is not immediately duplicated. No claim of exactly
once delivery or successful cloud transfer is made.

```sh
gofmt -w *.go
go test ./...
go test -race ./...
go build -o /tmp/bambou-agent .
```
