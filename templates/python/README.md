# Python VPS starter

Requires Linux and Python 3.10+. Keep this template inside the repository: it
imports the shared `agent/` supervisor and streaming backup code, not a copy.

```sh
cd templates/python
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit .env locally, then:
python main.py
```

Use a site-scoped agent token, not an admin token. Public HUB_URL must be an
HTTPS origin (HTTP localhost is allowed for development). Redirects are disabled.
The token stays in the supervisor environment; it is not written to runtime
files or inherited by workers. Protect the local `.env` with mode 0600.

## Local configuration

CLI flags override environment settings. Runtime defaults to `./runtime` relative
to the current directory. To discover an existing script's `config.json` and
`proxies.txt`, use `python main.py --runtime-dir /opt/script` (or HUB_RUNTIME_DIR).
That directory becomes mode 0700. Do not choose a shared directory.

On first enrollment, GET config precedes a revision-guarded POST local-sync,
even without local files. Optional JSON fields are `ai_api_key`,
`number_of_workers` (0–100), and `ai_preset_id`; other fields are ignored.
Proxy import accepts URL lines and ignores blanks/comments. The hub validates
the import atomically. Invalid imports preserve local files. An enrollment race
refetches and retries once without local data, never overwriting admin edits.
An initialized hub prevents deleted proxies being resurrected after checkpoint loss.

Thereafter the hub is authoritative: manual local edits are overwritten on each
30-second config poll and on start/restart. Runtime contains private mode-0600
`config.json`, `proxies.txt`, `.sync.json`, and `backup-config.json` (safe schedule,
destination IDs and status only; no cloud credentials). Proxy credentials are
percent-encoded in canonical URLs. Clearing keys/proxies writes empty values/files.
Each file is fsynced and atomically replaced; checkpoint is published last, not a
cross-file transaction. Readers should check config revision after reload.
Site deletion revokes authentication but does not delete VPS files.

## Integration hooks

`exampleworker.py` is a harmless idle loop, **not business logic**. Implement
`AutomationHooks.process_next_task`, returning True only after a real task.
Use bounded timeouts and cancellation. `task_completed()` and `error()` report
over a local inherited Unix datagram socket, without a hub token. Error events
have fixed sanitized messages; never add secrets to logs. IPC is best effort,
bounded, and counters are in-memory, not a durable accounting system.
The default placeholder reports zero completed tasks. CPU/RSS come from psutil.
AI key/preset and proxy pool are provided in worker environment at spawn;
restart workers to apply changed environment values. No captcha integration.

Heartbeat is every 15 seconds, lifecycle polling every 5 seconds. Only
start/stop/restart are accepted; the worker command is chosen locally using
`--command` or HUB_WORKER_COMMAND, parsed without a shell. Completed lifecycle
commands are persisted before acknowledgment and acknowledgments retried without
repeating actions. A crash between action and persistence can repeat it: this is
not exactly-once execution. Failed workers require explicit restart.

## Opt-in site statistics

`Agent.report_statistics(links_sent_successfully, average_messages_per_chat)` is
an explicit supervisor-side API wrapper. It is never called by the starter loop.
The template also exports a function accepting the existing authenticated
`Agent.request` helper. Example from repository-root import context, inside your
trusted supervisor integration (arguments come from your real accounting):

```python
from agent.agent import Agent
from templates.python.site_statistics import report_statistics

def publish_site_snapshot(agent: Agent, site_links_sent_successfully,
                          site_average_messages_per_chat):
    return report_statistics(agent.request, site_links_sent_successfully,
                             site_average_messages_per_chat)
    # Equivalent: agent.report_statistics(site_links_sent_successfully,
    #                                     site_average_messages_per_chat)
```

POST `/api/agent/statistics` sends exactly `links_sent_successfully` and
`average_messages_per_chat`, both required. Counter: integer 0–9007199254740991;
average: finite number 0–1000000000 or `None` for unknown/no chats. Booleans,
negative, nonfinite and out-of-range values fail before any request.
Use one reporter per site. Supply real accumulated **whole-site** snapshots, not
increments or worker/task counters. Every report overwrites both values; retries
of the same snapshot do not add counts. You own aggregation, persistence and
explicit resets. Nothing sends zero automatically; send zero only if measured.
The helper does not define a successful link or chat. Derive a weighted average
as total messages / total chats only if those match your definitions; otherwise
provide your actual computed average, or `None` when unknown.
Workers have no agent token: report aggregates from the supervisor only (or a
trusted custom caller with its own authenticated request helper and token from
the environment). Do not add the token to worker environments or payloads.

## Backups

Set HUB_BACKUP_DIR or `--backup-dir` to a local codebase directory. The independent
backup thread polls schedule/requests without blocking lifecycle control.
Periodic backups default off; minimum interval is 15 minutes. On-demand requests
still work while periodic backups are off. `BackupRunner.upload(path, source,
request_id=None)` streams arbitrary files without an extension filter.
Archives are bounded (default 1 GiB, `--backup-max-bytes`), streamed to private
temporary storage, canceled/cleaned on shutdown, and never buffered in RAM.
Keep state/scratch outside the source when possible; nested agent state and a
strictly nested runtime directory are excluded. If runtime equals the source,
ordinary codebase files remain included, including managed config/proxy files.
Other codebase configuration **including
`.env`** is included and may contain secrets: review your source tree. Do not
store the hub token inside the selected backup source. Symlinks are archived
without following them. Use a stable tree or filesystem snapshot for consistency.
Last accepted upload time persists; ambiguous responses are reconciled with the
request queue instead of falsely reporting failure. Cloud credentials stay on
the hub. No dashboard-supplied paths or executable commands are accepted.
