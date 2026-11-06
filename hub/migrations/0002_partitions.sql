-- Monthly partitions for append-only telemetry. Data is kept forever; partitions
-- keep indexes small and let old months be archived/compressed independently.

CREATE OR REPLACE FUNCTION hub_ensure_partitions(months_ahead integer DEFAULT 2) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    tbl text;
    start_month date;
    m date;
    part text;
BEGIN
    start_month := date_trunc('month', now() - interval '1 month')::date;
    FOREACH tbl IN ARRAY ARRAY['event_logs', 'worker_samples', 'metrics'] LOOP
        FOR i IN 0..(months_ahead + 1) LOOP
            m := (start_month + (i || ' month')::interval)::date;
            part := format('%s_%s', tbl, to_char(m, 'YYYYMM'));
            IF to_regclass(part) IS NULL THEN
                EXECUTE format(
                    'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                    part, tbl, m, (m + interval '1 month')::date
                );
            END IF;
        END LOOP;
        -- Catch-all for clock-skewed or back-filled rows (e.g. v1 migration).
        IF to_regclass(tbl || '_default') IS NULL THEN
            EXECUTE format('CREATE TABLE %I PARTITION OF %I DEFAULT', tbl || '_default', tbl);
        END IF;
    END LOOP;
END $$;

SELECT hub_ensure_partitions(2);

CREATE INDEX event_logs_site_ts ON event_logs(site_id, ts DESC);
CREATE INDEX event_logs_worker_ts ON event_logs(site_id, worker_id, ts DESC);
CREATE INDEX event_logs_level_ts ON event_logs(site_id, level, ts DESC) WHERE level >= 3;
CREATE INDEX event_logs_message_trgm ON event_logs USING gin (message gin_trgm_ops);
CREATE INDEX worker_samples_lookup ON worker_samples(site_id, worker_id, ts DESC);
CREATE INDEX metrics_lookup ON metrics(site_id, name, ts DESC);
CREATE INDEX cost_events_site_ts ON cost_events(site_id, ts DESC);
CREATE INDEX cost_events_provider ON cost_events(site_id, provider, ts DESC);
