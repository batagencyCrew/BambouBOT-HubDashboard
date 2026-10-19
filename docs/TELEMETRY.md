# Automation telemetry

Telemetry describes real work reported by each site's automation. It does not
enable a rate limiter or add dashboard screens. Use the administrator API to
inspect event history and aggregates.

## Authentication and isolation

Send agent requests with `Authorization: Bearer <site-token>` to `/api/agent`.
The token determines the site; never accept a site ID from a job or send another
site's worker/proxy IDs. Administrator reads use the access token returned by
`POST /api/auth/login`, not a site token.

Keep credentials in private environment/service configuration. The examples
below use synthetic identifiers and a nonsecret AI-key alias, not actual keys.

## Chat completion events

Send one `POST /api/agent/chats` event when a chat finishes:

```json
{
  "event_id": "11111111-1111-4111-8111-111111111111",
  "worker_id": "22222222-2222-4222-8222-222222222222",
  "msgs_in": 4,
  "msgs_out": 3,
  "links": 1,
  "converted": true,
  "duration": 42.5
}
```

`event_id` and `worker_id` are UUIDs. Counts are nonnegative safe integers;
`converted` is a boolean. `duration` is finite seconds from 0 through 604800.
Optional nullable fields are `proxy_id` (UUID), `room` (pseudonymous identifier,
1..128 characters using only letters, digits, underscores, and hyphens), and
`random` (boolean). Unknown fields are rejected.

Create the event UUID once, persist it with your pending event, and reuse the
same UUID and payload after a network failure. Retries are idempotent: they must
not become new activity. Do not use a new UUID for each HTTP attempt. Both chat
and AI writes return HTTP 200 `{event_id, duplicate, timestamp}`. Identical
retries preserve the timestamp; changed payloads or reuse across the two routes
return 409. UUID uniqueness is per site across both routes.

Read site history with administrator
`GET /api/sites/{site_id}/chats?limit=100&offset=0`. Use pagination rather than
repeatedly fetching the complete history.

## Proxy errors and health

`POST /api/agent/errors` accepts optional `proxy_id` and `code` alongside the
existing `level`, `message`, and optional `worker_id`. Codes are:

- `proxy_blocked`: an explicit blocked-proxy result;
- `proxy_auth`: proxy authentication failure;
- `proxy_timeout`: proxy timeout;
- `proxy_recovered`: an explicit recovered-proxy result;
- `other`: another sanitized error.

Use a short, sanitized message. A timeout or a message containing the word
“blocked” is not itself an explicit blocked-proxy signal. Set the appropriate
code based on the actual result, not a guess.

Administrator `GET /api/sites/{site_id}/proxy-health` aggregates associated
history, including history for deleted proxies. Removing a proxy from the pool
does not erase its historical activity. Only explicit `proxy_blocked` codes
contribute to blocked counts. The latest explicit blocked/recovered report sets
`blocked_status` to `blocked` or `recovered`; otherwise it is `unknown`.
`blocked_reported` is true only for `blocked`. Generic errors and successful chats
do not imply recovery. This is reported visibility, not automatic blacklisting,
pool removal, or a network probe.

The response is `{site_id, proxies:[...]}`. Each proxy entry has `proxy_id`,
`current`, `chats`, `links`, `converted`, `errors`, `proxy_blocked`, `proxy_auth`,
`proxy_timeout`, `proxy_recovered`, `other`, `blocked_status`, and
`blocked_reported`. It contains no proxy URL or credentials.

## AI usage batches

Send `POST /api/agent/ai-usage` with a stable event UUID and a nonsecret key alias:

```json
{
  "event_id": "33333333-3333-4333-8333-333333333333",
  "key_id": "primary-ai",
  "calls": 10,
  "error_429": 1,
  "error_502": 0,
  "latency_ms": 250.5
}
```

`key_id` is an alias of 1..80 letters, digits, underscores, dots, or hyphens,
**never the API key**, a key
fragment, authorization header, or credential-bearing URL. Use a stable label
such as `primary-ai` or `fallback-ai`. Counts are nonnegative safe integers;
the sum of both error counts must not exceed `calls`. Count all HTTP attempts,
including provider retries. `latency_ms` is a finite nonnegative average across
all attempts in the batch, including failed attempts. Zero calls requires zero
errors and zero latency. Reuse the event ID and unchanged payload on retries,
as with chat events.

Administrator `GET /api/sites/{site_id}/ai-usage` returns
`{site_id, keys:[{key_id,events,calls,error_429,error_502,latency_ms}]}`, sorted by
alias. Latency averages are weighted by call count, not by the number of batches;
zero total calls produces null latency.
Report actual calls and observed failures; the hub does not call the AI provider
or enforce provider rate limits on behalf of workers. Batch AI usage rather than
posting a new event for every call. Size storage admission limits for your actual
multiworker workload; see the [backend limits reference](../backend/README.md).

## Privacy and retention

Do not send chat contents, prompts, AI responses, participant names, contact
details, raw upstream bodies, AI keys, proxy credentials, or tokens. A `room`
value must be a pseudonymous internal identifier, not identifying chat data.
Error messages must not contain those values either. These rules apply to local
queues and logs as well as HTTP payloads.

Telemetry storage is bounded, so event history is not an unlimited audit archive.
Default chat/AI payload caps are 9000 per site and 90000 globally, shared across
both event kinds. Payloads also expire after seven days. Pruning retains
deduplication receipts until seven days after first receipt. Default receipt
caps are 20000 per site and 200000 globally: new IDs at capacity return 429 with
`Retry-After: 3600`, while existing IDs still retry. Stop retrying before the
seven-day receipt window expires. These are storage limits, not provider rate
limits. Aggregates describe retained history, not lifetime totals.

Set these on the **hub service**, not workers, to size storage for your workload:

| Environment variable | Default |
| --- | ---: |
| `HUB_TELEMETRY_HISTORY_SITE` | 9000 |
| `HUB_TELEMETRY_HISTORY_GLOBAL` | 90000 |
| `HUB_TELEMETRY_RECEIPTS_SITE` | 20000 |
| `HUB_TELEMETRY_RECEIPTS_GLOBAL` | 200000 |
| `HUB_TELEMETRY_RETENTION_DAYS` | 7 |

All values must be positive integers; invalid settings fail startup. Retention
days cannot exceed 36500 and count limits cannot exceed SQLite's signed 64-bit
maximum. Changes require a hub restart. Keep receipt capacity large enough for
all new chat events plus AI batches during your retention window, with headroom
for every site; increasing history alone does not increase receipt capacity.
Lowering history caps can discard retained payloads. Retention changes affect
new receipts only: each existing receipt keeps its assigned expiration, even
after a restart with a different setting. The seven-day descriptions above are
defaults; match retry deadlines to each event's original retention window.
Compose forwards all five variables from `.env`; direct/systemd runs must export
them in the backend service environment. Batch usage per key per minute where
appropriate, and do not send overlapping batches.
Keep any required long-term reporting in your own privacy-preserving system.
Chat events and AI batches are separate from the existing absolute
[site statistics snapshots](STATISTICS.md); do not substitute retry-prone
increments for those snapshots. Ingestion does not update Statistics cards,
worker `tasks_completed`, or heartbeat status.

Additional local configuration fields stay local: they are not automatically
uploaded or made into dashboard inventory. Backup archives can include private
configuration files; protect backup storage independently of telemetry privacy.
