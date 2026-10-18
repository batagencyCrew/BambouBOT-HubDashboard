# Architecture and operational model

```text
Browser dashboard ─── HTTPS /api + admin bearer ───┐
                                                 │
                                                 ▼
                                         Caddy TLS gateway
                                                 │
                                                 ▼
                                           FastAPI hub
                                                 │
                                                 ▼
                                       SQLite + encrypted secrets
                                                 ▲
                                                 │
VPS agent ─────────── HTTPS /api/agent + site token┘
   │
   └── locally configured worker processes × configured worker count
```

Agents make outbound requests; the hub does not SSH into VPSes or run scripts from site URLs. Neither the hub nor the browser needs access to inbound ports on agent VPSes. The site's URL is descriptive inventory metadata.

## Why Python / FastAPI?

The hub does relatively small, I/O-heavy operations: authenticate, validate telemetry, persist configuration, and enqueue lifecycle requests. Python is a practical fit, with straightforward typed request validation and an accessible integration ecosystem. The compute-intensive automation lives elsewhere.

Go is a strong alternative for a low-memory standalone service or very large connection counts. Node/TypeScript is a strong alternative for a single-language product team. Neither is intrinsically required for this workload. The HTTP contract is language-neutral; agents and a future replacement hub can use any language.

For growth, first measure database contention, request latency, heartbeat volume, and log storage. Moving to PostgreSQL, managing log retention, introducing gateway rate limits, and separating ingestion from admin requests may provide more benefit than a language rewrite. This implementation intentionally uses one application process with SQLite rather than claiming multi-node availability.

## Control is eventually consistent

The dashboard submits a durable request; it does not execute a process itself. A command progresses from pending to delivered to completed/failed. Only a completed acknowledgement means the agent applied the lifecycle hook; even then, a process can subsequently fail. Worker health comes from subsequent heartbeats.

The desired state and observed worker state are different concepts. An offline site with desired state `stopped` does **not** prove its workers have stopped. A hub outage does not forcibly terminate agents' existing workloads. Operators need direct VPS access for emergency intervention.

Delivery is at least once. Persist completed command IDs before acknowledging, make start/stop hooks idempotent, and retain agent state. Exactly-once process restart cannot be guaranteed across a crash between the process action and the deduplication write. The included generic agent is a process supervisor, not a transactional task scheduler.

The worker heartbeat is an authoritative snapshot for one site. Running two supervisors under the same site token would make their snapshots overwrite each other; use separate sites/tokens for separate pools.

## Trust boundaries

- The administrator can change every site's configuration and rotate agent credentials.
- Each agent can access its own site's plaintext runtime secrets, telemetry, and commands only.
- A worker receives its runtime configuration, but the sample supervisor removes hub authentication credentials from its environment.
- The hub host is trusted. Application-layer encryption protects stored fields and backups from casual inspection; it is not protection from a host compromise when decryption keys are on that host.
- Error messages and worker metadata are untrusted display content. Do not put credentials into them; application logging cannot reliably discover and redact every possible secret.
- Public traffic must use verified HTTPS. CORS is not authentication, and a private-looking URL is not an access control mechanism.

The single-admin authentication model is intentionally modest. A team or regulated deployment should add individual identities, permission boundaries, explicit audit trails, centralized secret management, and appropriate retention policies.
