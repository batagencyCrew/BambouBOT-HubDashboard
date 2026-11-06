"""Postgres access: a small sync pool plus migration runner.

The hub uses synchronous psycopg from FastAPI's worker threadpool. That keeps
every query easy to reason about and lets blocking tasks (rclone, preset fetch)
run without touching an event loop.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from pathlib import Path

from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

LOG = logging.getLogger("hub.db")
MIGRATIONS = Path(__file__).with_name("migrations")


class Database:
    def __init__(self, url: str, *, min_size: int = 1, max_size: int = 20):
        self.url = url
        self.pool = ConnectionPool(url, min_size=min_size, max_size=max_size,
                                   kwargs={"row_factory": dict_row, "application_name": "hub"},
                                   open=False)

    def open(self):
        self.pool.open(wait=True, timeout=30)
        self.pool.wait(timeout=30)

    def close(self):
        self.pool.close()

    @contextmanager
    def connection(self):
        with self.pool.connection() as conn:
            with conn.cursor() as cur:
                yield cur
            conn.commit()

    @contextmanager
    def transaction(self):
        """One transaction; exceptions roll back. Use for multi-statement writes."""
        with self.pool.connection() as conn:
            with conn.transaction():
                with conn.cursor() as cur:
                    yield cur

    def query(self, sql: str, params=None) -> list[dict]:
        with self.connection() as cur:
            cur.execute(sql, params)
            return cur.fetchall() if cur.description else []

    def one(self, sql: str, params=None) -> dict | None:
        rows = self.query(sql, params)
        return rows[0] if rows else None

    def execute(self, sql: str, params=None) -> int:
        with self.connection() as cur:
            cur.execute(sql, params)
            return cur.rowcount

    # -- migrations -------------------------------------------------------
    def migrate(self) -> list[int]:
        applied = []
        with self.transaction() as cur:
            cur.execute("SELECT pg_advisory_xact_lock(918273645)")
            cur.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())")
            cur.execute("SELECT version FROM schema_migrations")
            done = {row["version"] for row in cur.fetchall()}
            for path in sorted(MIGRATIONS.glob("*.sql")):
                version = int(path.name.split("_", 1)[0])
                if version in done:
                    continue
                LOG.info("Applying migration %s", path.name)
                cur.execute(path.read_text())
                cur.execute("INSERT INTO schema_migrations(version) VALUES(%s)", (version,))
                applied.append(version)
        return applied

    def ensure_partitions(self, months_ahead: int = 2) -> None:
        self.execute("SELECT hub_ensure_partitions(%s)", (months_ahead,))
