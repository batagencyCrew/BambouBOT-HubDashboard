-- Small key/value store for hub-wide settings (default alert channels, etc.).
CREATE TABLE hub_settings (
    key             text PRIMARY KEY,
    value           jsonb NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    updated_by      uuid REFERENCES users(id)
);

-- v1 → v2 migration bookkeeping so re-running the importer is a no-op.
CREATE TABLE legacy_imports (
    source          text NOT NULL,
    legacy_id       text NOT NULL,
    new_id          text NOT NULL,
    imported_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (source, legacy_id)
);
