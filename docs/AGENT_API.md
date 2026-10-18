# Integrating an existing automation script

Use the included supervisor for process-level start/stop/restart, or integrate directly when your script already has a worker pool. **Do not run both approaches under one site token**: each heartbeat replaces the whole site's worker snapshot.

Agents always initiate HTTPS connections to the central hub. The hub persists commands until polled; no inbound HTTP listener, SSH connection, or port forwarding is needed on the automation VPS.

For complete working examples rather than individual requests, use the [Python, Node.js, and Go starters](../templates/README.md). They also implement revision-safe local `config.json`/`proxies.txt` enrollment and dashboard-to-file mirroring. Custom integrations should follow the [local-sync contract](VPS_TEMPLATE_CONTRACT.md) if they need the same enrollment/deletion guarantees.

## Minimal authenticated client

Install `requests` and set `HUB_URL=https://hub.example.com` and `HUB_AGENT_TOKEN` from the site's enrollment dialog. Use a verified HTTPS origin, not an endpoint path.

```python
import os
import requests
from uuid import UUID, uuid5

origin = os.environ["HUB_URL"].rstrip("/")
session = requests.Session()
session.headers["Authorization"] = "Bearer " + os.environ["HUB_AGENT_TOKEN"]

def api(method, path, **kwargs):
    response = session.request(
        method, origin + "/api/agent" + path,
        timeout=(5, 20), allow_redirects=False, **kwargs,
    )
    if not 200 <= response.status_code < 300:
        # Do not print response bodies, request headers, or runtime config.
        raise RuntimeError(f"Hub request failed: HTTP {response.status_code}")
    return response.json()

config = api("GET", "/config")  # contains secrets; keep private

# Enrollment heartbeat: get site ID, then derive stable per-site worker IDs.
enrollment = api("POST", "/heartbeat", json={"status": "healthy", "workers": []})
worker_id = str(uuid5(UUID(enrollment["site_id"]), "worker-1"))

api("POST", "/heartbeat", json={
    "status": "healthy",
    "workers": [{
        "id": worker_id,
        "name": "worker-1",
        "status": "running",
        "cpu_percent": 12.5,
        "memory_mb": 84.0,
        "tasks_completed": 42,
    }],
})

api("POST", "/errors", json={
    "worker_id": worker_id,
    "level": "warning",
    "message": "Job timed out; queued for a permitted retry",
})
```

This example reports a single snapshot, not a complete background loop. Add your own scheduling: heartbeats every 15s, command polling every 5s, config refresh every 30s. Report all current workers in **one** heartbeat. Use actual metrics, not the example values. CPU uses 100% per core and may exceed 100% for a multithreaded process.

## Runtime configuration

`GET /api/agent/config` returns:

```json
{
  "number_of_workers": 2,
  "ai_preset_id": "default",
  "ai_api_key": "site-secret",
  "captcha_api_key": "site-secret",
  "proxies": [
    {
      "id": "4a05c811-126c-486f-95c4-e8b04f235ec6",
      "url": "socks5://proxy.example.com:1080",
      "username": "service-user",
      "password": "proxy-secret"
    }
  ]
}
```

Proxy credentials are separate from their URLs. Your worker chooses how to use the configured services and proxy pool; the hub does not make requests through them or validate their availability. Never print this payload.

## Lifecycle commands

`GET /api/agent/commands` returns pending/delivered commands and marks them delivered. Map `start`, `stop`, and `restart` to your own **locally defined** worker-pool methods. Never interpret hub data as shell commands or executable code.

Persist each completed command ID and its result **before** sending acknowledgement:

```python
api("POST", f"/commands/{command_id}/ack", json={
    "status": "completed",  # or 'failed'
    "message": "Worker pool stopped",
})
```

Retry acknowledgements without repeating the action. New dashboard commands supersede older unacknowledged commands. An acknowledgement of a superseded action returns HTTP 409; poll again for the latest request rather than retrying an obsolete action forever. A superseded action already executing locally cannot be remotely recalled. Design local hooks so stop takes precedence promptly and start is safe to repeat.

Heartbeats also return `desired_state` (`running` or `stopped`) and `server_time`. Use desired state for recovery when your supervisor restarts. It does not substitute for executing and acknowledging explicit restart requests.

## Failures, limits, and security

- 401: token invalid/rotated or wrong credential type. Fix enrollment; do not fall back to an admin password.
- 404: site/command no longer exists, or endpoint path is incorrect.
- 409: command superseded/already terminal, or a configured resource limit was reached.
- 413: request exceeds 1 MiB; bound error messages and telemetry.
- 422: invalid payload; worker IDs must be UUIDs, snapshots have at most 100 unique workers, metrics must be finite and nonnegative.
- Connection errors/5xx: retry with bounded backoff. Decide explicitly whether workloads continue on loss of hub contact; the sample supervisor keeps them running.

Per-site error and command history is bounded to 1,000 records; dashboard command history shows the latest 20. Forward high-volume diagnostics to a proper log service. Authentication tokens, AI/captcha keys, proxy credentials, and sensitive job data must never appear in error messages.
