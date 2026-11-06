-- Core inventory, identity, configuration, and event storage for the Bambou hub.

-- Requires extensions pgcrypto and pg_trgm (installed by deploy/setup-postgres.sh as superuser).

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username        text NOT NULL UNIQUE CHECK (username = lower(username) AND username ~ '^[a-z0-9_.-]{2,64}$'),
    display_name    text NOT NULL DEFAULT '',
    password_hash   text NOT NULL,
    role            text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'viewer')),
    permissions     text[] NOT NULL DEFAULT '{}',    -- extra grants beyond the role defaults
    site_scope      uuid[] ,                          -- NULL = all sites; otherwise visible site ids
    disabled        boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id),
    password_changed_at timestamptz NOT NULL DEFAULT now(),
    last_login_at   timestamptz
);

CREATE TABLE sessions (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      text NOT NULL UNIQUE,
    user_agent      text NOT NULL DEFAULT '',
    ip              text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id, expires_at DESC);

-- ---------------------------------------------------------------------------
-- Sites (one script / one VPS) and instruments attached to them
-- ---------------------------------------------------------------------------

CREATE TABLE sites (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug            text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
    name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    url             text NOT NULL DEFAULT '',
    description     text NOT NULL DEFAULT '',
    timezone        text NOT NULL DEFAULT 'UTC',
    desired_state   text NOT NULL DEFAULT 'stopped' CHECK (desired_state IN ('running', 'paused', 'stopped')),
    crash_restart   boolean NOT NULL DEFAULT true,
    config_revision bigint NOT NULL DEFAULT 0,
    created_at      timestamptz NOT NULL DEFAULT now(),
    archived_at     timestamptz
);

CREATE TABLE site_tokens (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    token_hash      text NOT NULL UNIQUE,
    label           text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    created_by      uuid REFERENCES users(id),
    revoked_at      timestamptz,
    last_used_at    timestamptz
);
CREATE INDEX site_tokens_site ON site_tokens(site_id);

CREATE TABLE workers (
    id              uuid PRIMARY KEY,
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    name            text NOT NULL,
    status          text NOT NULL DEFAULT 'unknown'
                    CHECK (status IN ('starting', 'running', 'idle', 'error', 'stopped', 'unknown')),
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- script-defined status metadata
    pid             integer,
    cpu_percent     double precision NOT NULL DEFAULT 0,
    memory_mb       double precision NOT NULL DEFAULT 0,
    tasks_completed bigint NOT NULL DEFAULT 0,
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    UNIQUE (site_id, name)
);
CREATE INDEX workers_site_status ON workers(site_id, status);

CREATE TABLE agent_reports (
    site_id         uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    last_seen_at    timestamptz,
    agent_version   text NOT NULL DEFAULT '',
    host            jsonb NOT NULL DEFAULT '{}'::jsonb,  -- os, cpu, memory, disk, uptime
    script_process  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- pid, state, restarts, command
    backup_state    jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Configuration files the hub can read and edit on each VPS
-- ---------------------------------------------------------------------------

-- The full file text is stored encrypted (``sealed``); ``view`` is the parsed
-- document with secret values masked, safe to show without secrets:reveal.
CREATE TABLE site_files (
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    path            text NOT NULL,         -- relative to the script root
    format          text NOT NULL CHECK (format IN ('json', 'env', 'proxies', 'proxy-json', 'text')),
    secret_keys     text[] NOT NULL DEFAULT '{}',
    revision        bigint NOT NULL DEFAULT 1,
    sealed          text NOT NULL,
    view            jsonb NOT NULL DEFAULT 'null'::jsonb,
    sha256          text NOT NULL,
    applied_revision bigint NOT NULL DEFAULT 0,   -- last revision the agent confirmed on disk
    applied_at      timestamptz,
    apply_error     text,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id),
    PRIMARY KEY (site_id, path)
);

CREATE TABLE site_file_history (
    id              bigserial PRIMARY KEY,
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    path            text NOT NULL,
    revision        bigint NOT NULL,
    sealed          text NOT NULL,
    sha256          text NOT NULL,
    action          text NOT NULL,        -- initial | update | restore | local-change
    changed_at      timestamptz NOT NULL DEFAULT now(),
    changed_by      uuid REFERENCES users(id),
    summary         jsonb NOT NULL DEFAULT '{}'::jsonb   -- keys added/changed/removed (names only)
);
CREATE INDEX site_file_history_lookup ON site_file_history(site_id, path, id DESC);

-- ---------------------------------------------------------------------------
-- Commands issued to a site; the agent acknowledges them
-- ---------------------------------------------------------------------------

CREATE TABLE commands (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    action          text NOT NULL,        -- start|stop|restart|pause|resume|set_workers|reload_config|custom:<name>
    args            jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'delivered', 'running', 'completed', 'failed', 'superseded')),
    created_at      timestamptz NOT NULL DEFAULT now(),
    delivered_at    timestamptz,
    completed_at    timestamptz,
    result          text,
    requested_by    uuid REFERENCES users(id),
    source          text NOT NULL DEFAULT 'dashboard',  -- dashboard|bot|api|system
    expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX commands_site ON commands(site_id, created_at DESC);
CREATE INDEX commands_open ON commands(site_id) WHERE status IN ('pending', 'delivered', 'running');

-- ---------------------------------------------------------------------------
-- Telemetry: stored by value/time (see 0002 for partitioning)
-- ---------------------------------------------------------------------------

CREATE TABLE event_logs (
    id              bigserial,
    site_id         uuid NOT NULL,
    worker_id       uuid,
    worker_name     text,
    ts              timestamptz NOT NULL,
    level           smallint NOT NULL CHECK (level BETWEEN 0 AND 5),  -- debug..critical
    source          text NOT NULL DEFAULT '',  -- logger name / module
    message         text NOT NULL,
    context         jsonb,
    exception       text,
    received_at     timestamptz NOT NULL DEFAULT now()
) PARTITION BY RANGE (ts);

CREATE TABLE worker_samples (
    site_id         uuid NOT NULL,
    worker_id       uuid NOT NULL,
    ts              timestamptz NOT NULL,
    status          text NOT NULL,
    cpu_percent     double precision,
    memory_mb       double precision,
    tasks_completed bigint
) PARTITION BY RANGE (ts);

CREATE TABLE metrics (
    site_id         uuid NOT NULL,
    worker_id       uuid,
    name            text NOT NULL,
    labels          jsonb NOT NULL DEFAULT '{}'::jsonb,
    ts              timestamptz NOT NULL,
    kind            text NOT NULL CHECK (kind IN ('count', 'gauge', 'duration')),
    value           double precision NOT NULL
) PARTITION BY RANGE (ts);

CREATE TABLE cost_events (
    id              bigserial,
    site_id         uuid NOT NULL,
    ts              timestamptz NOT NULL,
    category        text NOT NULL,
    provider        text NOT NULL,
    amount          numeric(18, 6) NOT NULL,
    currency        char(3) NOT NULL DEFAULT 'USD',
    quantity        numeric(18, 6),
    unit            text,
    worker_id       uuid,
    meta            jsonb NOT NULL DEFAULT '{}'::jsonb,
    receipt         text NOT NULL,   -- client event id; dedups offline retries
    received_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, receipt)
);

CREATE TABLE account_balances (
    id              bigserial PRIMARY KEY,
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    provider        text NOT NULL,
    label           text NOT NULL DEFAULT '',
    currency        char(3) NOT NULL DEFAULT 'USD',
    balance         numeric(18, 6) NOT NULL,
    low_threshold   numeric(18, 6),
    reported_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, provider, label)
);

CREATE TABLE proxy_observations (
    id              bigserial PRIMARY KEY,
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    proxy_key       text NOT NULL,   -- stable hash of url+username; credentials never stored here
    label           text NOT NULL DEFAULT '',
    state           text NOT NULL CHECK (state IN ('ok', 'slow', 'blocked', 'auth', 'timeout', 'unknown')),
    detail          text NOT NULL DEFAULT '',
    ts              timestamptz NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX proxy_observations_lookup ON proxy_observations(site_id, proxy_key, ts DESC);

CREATE TABLE proxies (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    url             text NOT NULL,
    username        text NOT NULL DEFAULT '',
    encrypted_password text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, url, username)
);

-- ---------------------------------------------------------------------------
-- Alerts
-- ---------------------------------------------------------------------------

CREATE TABLE alert_rules (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         uuid REFERENCES sites(id) ON DELETE CASCADE,   -- NULL = all sites
    name            text NOT NULL,
    kind            text NOT NULL,   -- worker_idle|offline|error_spike|issue|cost|balance|backup_failed|proxy
    params          jsonb NOT NULL DEFAULT '{}'::jsonb,
    severity        text NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    enabled         boolean NOT NULL DEFAULT true,
    channels        jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{platform:'discord', chat_id:'…'}]
    cooldown_seconds integer NOT NULL DEFAULT 900,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE alerts (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    rule_id         uuid REFERENCES alert_rules(id) ON DELETE SET NULL,
    site_id         uuid REFERENCES sites(id) ON DELETE CASCADE,
    worker_id       uuid,
    dedup_key       text NOT NULL,
    severity        text NOT NULL,
    title           text NOT NULL,
    body            text NOT NULL DEFAULT '',
    data            jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'muted')),
    opened_at       timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    ack_by          uuid REFERENCES users(id),
    ack_at          timestamptz,
    resolved_at     timestamptz,
    muted_until     timestamptz
);
CREATE UNIQUE INDEX alerts_open_dedup ON alerts(dedup_key) WHERE status = 'open';
CREATE INDEX alerts_recent ON alerts(opened_at DESC);

CREATE TABLE alert_deliveries (
    id              bigserial PRIMARY KEY,
    alert_id        uuid NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
    platform        text NOT NULL,
    channel         text NOT NULL,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    attempts        integer NOT NULL DEFAULT 0,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz
);

-- ---------------------------------------------------------------------------
-- Backups
-- ---------------------------------------------------------------------------

CREATE TABLE backup_destinations (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name            text NOT NULL UNIQUE,
    remote          text NOT NULL,      -- rclone remote name
    folder          text NOT NULL DEFAULT '',
    enabled         boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_backup_config (
    site_id         uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    enabled         boolean NOT NULL DEFAULT false,
    interval_minutes integer NOT NULL DEFAULT 1440 CHECK (interval_minutes BETWEEN 15 AND 43200),
    destination_ids uuid[] NOT NULL DEFAULT '{}',
    keep_count      integer NOT NULL DEFAULT 14 CHECK (keep_count BETWEEN 1 AND 365),
    include_files   text[] NOT NULL DEFAULT '{}',   -- extra globs beyond the script root
    exclude_files   text[] NOT NULL DEFAULT '{.git,node_modules,__pycache__,.venv,venv}',
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE backups (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id         uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
    source          text NOT NULL CHECK (source IN ('scheduled', 'manual', 'pre_change')),
    status          text NOT NULL DEFAULT 'uploading'
                    CHECK (status IN ('uploading', 'uploaded', 'completed', 'partial', 'failed')),
    filename        text NOT NULL,
    size_bytes      bigint NOT NULL DEFAULT 0,
    sha256          text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz,
    expires_at      timestamptz,
    requested_by    uuid REFERENCES users(id),
    note            text NOT NULL DEFAULT ''
);

CREATE TABLE backup_files (
    backup_id       uuid PRIMARY KEY REFERENCES backups(id) ON DELETE CASCADE,
    stored_path     text NOT NULL,   -- relative to HUB_DATA_DIR/backups
    local_available boolean NOT NULL DEFAULT false
);

CREATE TABLE backup_transfers (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    backup_id       uuid NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
    destination_id  uuid NOT NULL REFERENCES backup_destinations(id) ON DELETE CASCADE,
    remote_path     text NOT NULL,
    status          text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'completed', 'failed')),
    attempts        integer NOT NULL DEFAULT 0,
    error           text,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);
CREATE INDEX backup_transfers_due ON backup_transfers(next_attempt_at) WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TABLE audit_log (
    id              bigserial PRIMARY KEY,
    ts              timestamptz NOT NULL DEFAULT now(),
    user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
    actor           text NOT NULL,       -- username snapshot, or system/agent name
    source          text NOT NULL,       -- dashboard|bot|api|agent|system
    action          text NOT NULL,       -- e.g. site.start, file.update, user.create
    site_id         uuid REFERENCES sites(id) ON DELETE SET NULL,
    target          text,
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb,
    ip              text NOT NULL DEFAULT ''
);
CREATE INDEX audit_log_time ON audit_log(ts DESC);
CREATE INDEX audit_log_site ON audit_log(site_id, ts DESC);

CREATE TABLE bot_links (
    platform        text NOT NULL CHECK (platform IN ('discord', 'telegram')),
    platform_user   text NOT NULL,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, platform_user)
);

