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

## Tests

```sh
cd backend
python -m pip install -r requirements-dev.txt
python -m pytest
```

Tests use isolated temporary SQLite databases and key files, never production
data. `hub.app.create_app` accepts explicit test settings without importing the
production entrypoint (which intentionally requires the environment password).
