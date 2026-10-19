# Optional supervisor telemetry

These thin helpers follow the completed [backend contract](../backend/README.md#receipt-only-chat-proxy-and-ai-telemetry).
The wire name is `duration` (seconds), not `duration_seconds`. Server validation
remains authoritative, particularly for same-site proxy ownership.

No helper is called by a starter loop or worker. Nothing invents counters,
aggregates chats, measures AI calls, changes automation, discovers credentials,
persists events, or implements retries. Supply real measurements and generate
one UUID per logical event/batch; reuse that UUID and the same payload for retries.
The helpers do not make provider calls, implement AI logic, or update the existing
whole-site statistics snapshot.

## Wire payloads

Existing authenticated clients prepend `/api/agent` to these helper paths:

| POST path | Required fields | Optional fields (omitted when absent) |
| --- | --- | --- |
| `/chats` | `event_id`, `worker_id`: UUID; `msgs_in`, `msgs_out`, `links`: counts; `converted`: bool; `duration`: seconds | `proxy_id`: UUID; `room`: pseudonym; `random`: bool (all nullable) |
| `/ai-usage` | `event_id`: UUID; `key_id`: nonsecret alias; `calls`, `error_429`, `error_502`: counts; `latency_ms`: batch-average measurement | None |
| `/errors` | Helper supplies `worker_id`: UUID; `level`: `error`; `message`: fixed `Proxy status event`; caller supplies `code` | `proxy_id`: UUID |

Allowed codes: `proxy_blocked`, `proxy_auth`, `proxy_timeout`, `proxy_recovered`,
`other`. This convenience helper uses a fixed sanitized message even for recovery;
it does not change existing error-reporting flows.

Client count bounds: integers 0–9007199254740991 (booleans rejected in dynamic
languages). `duration`: finite seconds 0–604800. `latency_ms`: finite nonnegative
batch average over **all HTTP attempts**, including retries and failures.
`error_429 + error_502 <= calls`; zero calls requires zero latency and errors.
Required fields must be supplied by Python/Node
callers; Go structs are typed but zero-valued fields cannot distinguish omitted
from measured zero, so initialize them from real accounting explicitly.

Key aliases use 1–80 characters `[A-Za-z0-9_.-]`; case-insensitive substrings
`bbk_`, `sk_`, `sk-`, and `Bearer` are rejected. This is **not a secret detector**:
choose a short nonsecret label such as a locally assigned key nickname. Never
send an API key/hash, token, proxy password/URL, user handle, actual room name,
message text, or upstream response body. `links` is a count, never URL content.
`room` must be an assigned opaque pseudonym matching `[A-Za-z0-9_-]{1,128}`,
not a person's name, account identifier, actual room name, or chat text.
UUID checks validate textual form, not ownership.

Chat/AI POSTs return HTTP 200 `{event_id, duplicate, timestamp}`. Event UUIDs share
one `(site_id,event_id)` namespace **across both endpoints**: use a distinct ID
for every chat and AI batch. An identical normalized payload returns the original
UTC timestamp and `duplicate:true`; changed payload/endpoint with the same UUID
returns 409. Omitted/null options normalize identically. Dedup receipts last
seven days after first receipt, even if bounded history is pruned. Stop retries
before expiry: after seven days the UUID may count as a new event. Receipt
capacity can reject new IDs with 429; callers own durable queues/backoff.
Error reports remain HTTP 201 `{id}` and **non-idempotent** (no event ID).

## Worker correlation without worker tokens

Use the UUID already reported in heartbeat as `worker_id`, not an invented
display name or a newly generated event UUID:

- **Python:** each child receives `HUB_WORKER_ID`; supervisor integrations can
  call `agent.telemetry_id(local_worker_name)` or use heartbeat snapshot `id`.
  Child task IPC currently carries counters/errors only, not chat/AI payloads
  or proxy-attributed error fields.
  Explicitly implement trusted supervisor-side event delivery if collecting in a
  worker; never give that worker the hub token.
- **Node:** `performTask({config, signal, workerId})` receives the supervisor's
  persisted slot UUID, matching `state.slots` / `snapshot()[i].id` and heartbeat.
  Spawn and config-update IPC both supply `workerId` separately from config.
  Use it as `worker_id` when collecting measured summaries. Existing IPC does
  not carry chat/AI events or proxy-attributed hook errors: explicitly integrate
  supervisor reporting helpers for those. No hub token or automatic reporting
  is added to the worker.
- **Go:** `Hook(ctx, id, config)` already receives the pool worker UUID in its
  second argument; `Pool.snapshot()` exposes the same IDs. Hooks run in process.
  Use a trusted supervisor integration to invoke the helpers with that ID.

No helper logs payloads or upstream bodies. Existing authentication, timeouts,
TLS checks, and sanitized HTTP errors remain in the clients. Keep reporting
inside trusted supervisor code; no token is passed to workers.

## Python

`agent/telemetry_reporting.py`, re-exported by `templates/python/telemetry.py`.
Repository-root import context, using the existing `Agent.request`:

```python
from agent.telemetry_reporting import report_chat, report_ai_usage, report_proxy_error

def publish_measured_events(agent, measured_chat, measured_ai_batch, proxy_status):
    report_chat(agent.request, **measured_chat)
    report_ai_usage(agent.request, **measured_ai_batch)
    report_proxy_error(agent.request, **proxy_status)
```

The dictionaries contain the fields above (proxy status supplies `worker_id`,
`code`, and optionally `proxy_id`). Python rejects unknown keyword arguments.
Absent optional values use `None` and are omitted, not sent as JSON null.

## Node

From trusted supervisor-side code at the Node starter root:

```js
import { reportChat, reportAIUsage, reportProxyError } from './lib/telemetry.mjs';

export async function publishMeasuredEvents(api, measuredChat, measuredAIBatch, proxyStatus) {
  await reportChat(api, measuredChat);
  await reportAIUsage(api, measuredAIBatch);
  await reportProxyError(api, proxyStatus);
}
```

Pass the existing `API` instance. Only whitelisted fields are serialized, even
if callers supply extra object keys. Optional properties may be absent,
`undefined`, or null; the helper omits nulls. No automatic `.env` forwarding or
child IPC is added.

## Go

Methods on the existing `*API`, from supervisor-side `package main` code:

```go
func publishMeasuredEvents(ctx context.Context, api *API, chat ChatEvent,
    batch AIUsageEvent, workerID, code string, proxyID *string) error {
    if err := api.ReportChat(ctx, chat); err != nil { return err }
    if err := api.ReportAIUsage(ctx, batch); err != nil { return err }
    return api.ReportProxyError(ctx, workerID, code, proxyID)
}
```

Import `context`. Use `*string` / `*bool` for optional chat fields (`nil` omits;
a pointer to false sends false). These methods return errors and discard success
bodies. Python/Node return their existing client's parsed success response; no
particular response schema is assumed.
