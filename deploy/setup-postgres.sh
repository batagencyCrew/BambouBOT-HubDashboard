#!/usr/bin/env bash
# One-time Postgres setup for the Bambou hub v2. Run as a sudo-capable user.
#   sudo deploy/setup-postgres.sh [dbname] [role]
set -euo pipefail
DB="${1:-hubv2}"
ROLE="${2:-hubv2}"
PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN
    CREATE ROLE ${ROLE} LOGIN PASSWORD '${PASSWORD}';
  ELSE
    ALTER ROLE ${ROLE} WITH LOGIN PASSWORD '${PASSWORD}';
  END IF;
END \$\$;
SQL

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB}'" | grep -q 1; then
  sudo -u postgres createdb -O "${ROLE}" "${DB}"
fi
for ext in pgcrypto pg_trgm; do
  sudo -u postgres psql -q -d "${DB}" -c "CREATE EXTENSION IF NOT EXISTS ${ext};"
done

cat <<EOF

Database ready: ${DB} (owner ${ROLE})
Add to /etc/bambou-hub.env:

HUB_DATABASE_URL=postgresql://${ROLE}:${PASSWORD}@127.0.0.1:5432/${DB}

Keep that file mode 600. Run migrations once with:

  set -a; . /etc/bambou-hub.env; set +a
  /opt/bambou-hub/.venv/bin/python -m hub.cli migrate
  /opt/bambou-hub/.venv/bin/python -m hub.cli create-user <name> --role owner
EOF
