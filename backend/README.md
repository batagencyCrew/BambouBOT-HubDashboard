# Dashboard backend

From `HubDashboard/`:

```sh
python -m pip install -r backend/requirements.txt
export HUB_ADMIN_PASSWORD='a-long-unique-password'
export HUB_DATA_DIR='./data'
uvicorn backend.app:app --host 0.0.0.0 --port 8000
```

`HUB_ADMIN_PASSWORD` is required; the process fails closed without it. Supply it
through a secret manager in production, not a committed file. Use HTTPS at the
reverse proxy. Only trust forwarded headers from your own proxy. The public
health check is `GET /api/health`. OpenAPI/docs are disabled.

## Storage and secrets

SQLite, `signing.key`, and (unless supplied through `HUB_ENCRYPTION_KEY`)
`encryption.key` persist in `HUB_DATA_DIR` (default `./data`, relative to cwd).
Directory permissions are 0700; database/key files are 0600. Mount a persistent,
private volume and back up the database **together with both keys**. Keys are
generated once, never regenerated on restart. `HUB_ENCRYPTION_KEY` must be a
valid Fernet key; changing/loss of this key makes existing secrets unreadable.
Generate one with `python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`.

API/captcha keys and proxy passwords are Fernet-encrypted. Agent tokens are
random, stored only as SHA-256 hashes, and returned only on creation/rotation.
Admin bearer tokens are signed with a persistent signing key, expire after eight
hours, and are distinct from site-scoped agent tokens. Rotating an agent token
immediately invalidates the old token. Treat agent config responses as secrets.
Do not log request bodies or Authorization headers. Error/ack text is displayed
verbatim to admins: agents must never include credentials in those messages.

Login is limited to 10 attempts per client IP per minute per process. For public
deployments, add proxy-level distributed rate limiting. One Uvicorn worker is
recommended; SQLite transactions also serialize multiple processes, but the
login limiter is process-local. Key creation is atomic across competing workers.

## Behavior and limits

- Same-origin by default. For local development, optionally set
  `HUB_CORS_ORIGINS=http://localhost:5173` (comma-separated explicit HTTP(S)
  origins, no wildcard or path).
- Configured workers and heartbeat snapshots are capped at 100; sites and
  proxies per site at 1000; request bodies at 1 MiB. Error/command history is
  retained up to 1000 records per site; admin commands list the latest 20.
- Site URLs/proxy URLs are validated and stored only; the server never connects
  to them. Local agent software is responsible for its own network policy.
- Heartbeats atomically replace workers. After 60 seconds a site is offline;
  fresh degraded reports or workers in `error` make it degraded. Running/idle
  workers count as healthy. Offline workers remain visible as the last snapshot.
- `summary.running` counts workers in the last snapshot with status `running`.
- Commands are durable, at-least-once. Agents must deduplicate IDs and retry
  acknowledgements. Repeated identical-status acknowledgements are idempotent.
  New lifecycle actions atomically supersede unacknowledged older commands
  (`failed`, message `Superseded by newer command`) and update desired state.
  An already-executing command cannot be recalled: agents should reconcile
  heartbeat desired state before/after hooks. No arbitrary remote shell exists.
- Omitted API keys preserve values; explicit empty strings clear them; null is
  rejected. Worker config defaults to 1 and preset `default`.

Built `frontend/dist` is served by the API with SPA fallback. Unknown `/api`
routes and missing assets never return the SPA. Until frontend is built, only
API endpoints are available.

## Agent local enrollment

`GET /api/agent/config` includes `revision` and `local_sync_initialized`.
Site-token-only `POST /api/agent/local-sync` accepts a required nonnegative
integer `expected_revision`, optional partial `config` (`ai_api_key`,
`number_of_workers`, `ai_preset_id` only), and optional `proxies_content`.
It returns the full decrypted agent configuration. Treat the response as secret.

The first enrollment imports local values only for a pristine site; validation,
encrypted storage, initialization, and revision increment are one transaction.
Even empty enrollment initializes the site. Later calls never reimport files.
Any administrator config PUT or proxy add/delete, and any proxy import inserting
at least one row, permanently prevents automatic local import and increments
the revision. Dry runs, rejected requests, and duplicate-only imports do neither.
A stale revision returns 409 without mutation: fetch the latest configuration,
then retry with only its `expected_revision` to finalize safely.

Startup automatically adds persistent revision/enrollment columns to existing
databases. All legacy sites are conservatively marked admin-modified: historical
deletions cannot be inferred from an empty table. Their hub values remain
authoritative; intentional proxy changes can use the admin import endpoint.

## Tests

```sh
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest
```

Tests use isolated temporary SQLite databases and key files, never production
data. `hub.app.create_app` accepts explicit test settings without importing the
production entrypoint (which intentionally requires the environment password).

## Receipt-only chat, proxy, and AI telemetry

These endpoints store reports only. They never call an AI provider, enforce
provider rate limits, execute chat logic, or update worker tasks, heartbeat state,
or the existing whole-site `/statistics` snapshot. Callers define what counts as
a chat, conversion, message, or link. Send **counts**, never URLs, transcripts,
prompts, personal information, actual API keys, or proxy credentials. Do not log
request bodies or Authorization headers. Validation responses do not echo input.

### Agent writes (site-scoped agent bearer token only)

`POST /api/agent/chats` — required fields:

```json
{"event_id":"UUID", "worker_id":"UUID", "msgs_in":2, "msgs_out":3,
 "links":1, "converted":false, "duration":12.5}
```

- `event_id` is a required retry identifier, not generated by the hub.
- `worker_id` is a UUID; the worker may already have exited and need not exist
  in the current heartbeat snapshot.
- `msgs_in`, `msgs_out`, `links`: strict integers 0..9007199254740991, not booleans.
- `converted`: strict boolean. `duration`: finite JSON number of seconds,
  0..604800; strings and booleans are rejected.
- Optional nullable `proxy_id`: UUID of a current same-site proxy or a retained
  same-site deleted-proxy reference. Unknown/cross-site references return a
  generic 422. Omit or use null when no proxy was used.
- Optional nullable `room`: opaque pseudonymous identifier, 1..128 characters
  from `[A-Za-z0-9_-]` only. Generate an identifier; never use a person's name,
  email, IP address, account ID, or room URL.
- Optional nullable `random`: strict boolean describing caller-defined mode.
- Unknown fields are rejected. The hub assigns a durable UTC receipt timestamp.

`POST /api/agent/ai-usage` — all fields required:

```json
{"event_id":"UUID", "key_id":"primary-slot", "calls":10,
 "error_429":2, "error_502":1, "latency_ms":120.5}
```

- `key_id`: **nonsecret label**, 1..80 characters `[A-Za-z0-9_.-]`.
  Labels containing `bbk_`, `sk_`, `sk-`, or `Bearer` (case insensitive) are
  rejected. Use a locally assigned slot name, never a key or fragment of a key.
- `calls` counts HTTP attempts, including retries; `error_429` and `error_502`
  count mutually exclusive response statuses for those attempts. All three are
  strict nonnegative safe integers; `error_429 + error_502 <= calls`.
- `latency_ms`: finite nonnegative JSON number, the arithmetic average across
  **all attempts in this batch**, including failed attempts. Zero calls requires
  zero latency and zero errors. Unknown fields are rejected.

Both POSTs return HTTP 200:
`{event_id:string, duplicate:boolean, timestamp:UTC-string}`.
The receipt's timestamp is unchanged on retries. Uniqueness is enforced in SQLite
on `(site_id,event_id)` **across both endpoints**. An identical normalized body
returns `duplicate:true`; reusing the identifier with another body or endpoint
returns 409. Optional omitted and explicit-null fields normalize identically.
No mutation happens on duplicate receipt. Generate one UUID per event and keep
the exact payload for retries; separate sites may use the same event UUID.

`POST /api/agent/errors` retains existing `{worker_id?,level,message}` and
HTTP 201 `{id}` response; adds optional nullable `proxy_id:UUID` and
`code:'proxy_blocked'|'proxy_auth'|'proxy_timeout'|'proxy_recovered'|'other'`.
`level` remains required (`info|warning|error`); explicit recovery can use `info`.
Proxy ownership checks match chat writes. Credential-bearing URL/userinfo and
obvious Authorization/key patterns are rejected in message text; agents must
still sanitize **all** messages because arbitrary free text cannot reliably be
classified as secret. Errors remain non-idempotent; no event_id was added.
Existing admin error objects additionally include nullable `proxy_id` and `code`.

### Admin reads (admin bearer token only)

- `GET /api/sites/{id}/chats?limit=100&offset=0` => array of chat bodies with
  all optional fields present (null if omitted), plus `site_id` and `timestamp`.
  Latest receipt first, deterministic insertion order for ties. `limit` 1..1000,
  `offset` 0..100000. Pagination is offset-based, not a stable cursor under writes.
- `GET /api/sites/{id}/ai-usage` => `{site_id,keys:[{key_id,events,calls,
  error_429,error_502,latency_ms}]}` sorted by key_id. Sums use retained batches;
  `latency_ms = sum(batch_latency_ms * batch_calls) / sum(batch_calls)` using
  numerically bounded weighted averaging; null when total calls is zero.
- `GET /api/sites/{id}/proxy-health` => `{site_id,proxies:[{proxy_id,current,
  chats,links,converted,errors,proxy_blocked,proxy_auth,proxy_timeout,
  proxy_recovered,other,blocked_status,blocked_reported}]}` sorted by proxy_id.
  `converted` counts true chat flags. Error code fields count reports, with
  absent code counted as `other`. `blocked_status` is `unknown|blocked|recovered`;
  only the latest retained **explicit** blocked/recovered report changes it.
  `blocked_reported` is true iff status is `blocked`, never an inferred blacklist
  verdict. Generic errors, successful chats, and timeout/auth reports neither
  infer blocking nor recovery. If explicit reports age out, status is unknown.
  Includes current proxies with zero reports and deleted IDs referenced by
  retained chats/errors. Unattributed reports (`proxy_id:null`) are not grouped.
  Returns IDs/counters only: no URL, username, password, or secret metadata.

Unknown sites return 404. Agent tokens cannot read admin telemetry; admin tokens
cannot submit agent telemetry. All aggregations are **retained-history views**,
not lifetime totals. Aggregate integer sums may exceed JavaScript's safe integer
range even though individual event counters cannot; clients should account for
that when displaying very large totals.

### Retention, bounded storage, and migration

SQLite startup migrations are additive, transactional, and repeatable, including
on existing databases. Site deletion cascades through all new tables. All writes,
dedup checks, and pruning run within `BEGIN IMMEDIATE`, including across processes.

Chat and AI history share a cap of **9000 payloads/site, 90000 globally**; oldest
payloads are pruned first. Existing error history is capped at 1000/site and now
10000 globally (oldest first). Thus detailed telemetry is bounded conservatively
to 10000/site and 100000 globally. Chat/AI payloads and aggregates additionally
expire **seven days after receipt**. Reads exclude expired history immediately;
physical expired receipt cleanup occurs on the next accepted telemetry write.
Errors retain their existing count-based rather than age-based retention.

Pruning a payload preserves its UUID, payload hash, and timestamp for **seven
days after first receipt**, so retries cannot recreate pruned history within that
window. Receipt-only rows are separately capped at 20000/site, 200000 globally.
At receipt capacity, new IDs return 429 with Retry-After: 3600 rather than evict
unexpired deduplication data; existing IDs still retry normally. Stop retrying
before seven days: after expiry, the same UUID is a new event and can count again.
These are bounded storage admission limits, not AI/provider rate limits.

Deleting a proxy records only `{proxy_id,site_id,timestamp}` ownership, never
credentials. Late reports can reference that tombstone for seven days, subject
to conservative 9000/site and 90000 global oldest-first tombstone caps. Unknown,
expired, or evicted historical references are rejected, not assigned to a site.
Already-received chat retries still deduplicate even if the tombstone has gone.
Deleted proxies from before this migration have no provable ownership and cannot
be referenced by new reports. No historic totals or backfill are fabricated.

### Telemetry capacity configuration

Set these environment variables **before starting the backend**; restart all
backend processes together after changes. They apply to chat and AI events
combined, not separately per endpoint:

| Variable | Default | Meaning |
| --- | ---: | --- |
| `HUB_TELEMETRY_HISTORY_SITE` | 9000 | Retained chat/AI payloads per site |
| `HUB_TELEMETRY_HISTORY_GLOBAL` | 90000 | Retained chat/AI payloads globally |
| `HUB_TELEMETRY_RECEIPTS_SITE` | 20000 | Deduplication receipts per site |
| `HUB_TELEMETRY_RECEIPTS_GLOBAL` | 200000 | Deduplication receipts globally |
| `HUB_TELEMETRY_RETENTION_DAYS` | 7 | Payload/receipt lifetime assigned on receipt |

All values must be positive decimal integers; invalid values fail startup without
echoing their contents. Count settings cannot exceed 9223372036854775807; days
cannot exceed 36500. These are validation ceilings, not recommended capacities.
Keep site caps no higher than global caps and receipt caps at least as high as
payload caps. Smaller receipt caps are permitted but become the effective intake
limit. Raising limits increases SQLite disk use, pruning work, and aggregate
response cost; size them for the deployment. Error history caps remain fixed.
Deleted-proxy reference caps follow the configured payload caps and their
lifetime is assigned using the configured retention days at deletion.

**Batch AI usage per key per minute is recommended**, rather than sending one
event per HTTP attempt. For example, 20 calls/minute grouped into one batch per
minute use 10080 receipts/key over seven days rather than 201600; include chat
events and all keys/workers when budgeting capacity. Sum attempts/errors and
compute the call-weighted batch latency locally. Assign one UUID to each batch,
retain that exact batch for retries, and do not send overlapping batches. This
is reporting guidance only: the hub does not schedule batches or limit AI calls.

Budget receipts as `(chat events + AI batches) per day * retention days`, with
headroom for peaks, separately per site and globally. The conservative defaults
can fill under normal high-volume traffic; override them for the actual workload
without changing code. New IDs receive 429 at capacity; unexpired dedup receipts
are **never evicted** to make room. Reducing a cap below current usage likewise
rejects new IDs until usage falls; retries of existing receipts continue working.

Each receipt now persists its expiration timestamp. Changing retention days
affects **new receipts only**, never shortens or extends existing promises;
pre-configuration receipts migrate with their original seven-day expiration.
Likewise, existing deleted-proxy references retain their assigned expiration
(but remain subject to their separately documented oldest-first count caps).
This supersedes the fixed seven-day wording above when an override is supplied.
