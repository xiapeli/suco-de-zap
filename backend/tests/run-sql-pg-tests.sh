#!/usr/bin/env bash
# Reproducible run of the five PostgreSQL-backed test suites against an
# isolated, throwaway PostgreSQL 16 (Docker). Requires: docker, Node 22+.
#
#   bash tests/run-sql-pg-tests.sh
#
# The synthetic roles mirror what Supabase gives you: CREATEROLE + BYPASSRLS
# owner per database, and membership (with SET) in anon/authenticated/
# service_role so tests can SET LOCAL ROLE the API caller.
set -euo pipefail

CONTAINER=${SUCO_SQL_TEST_CONTAINER:-suco-sql-tests}
PORT=${SUCO_SQL_TEST_PORT:-55433}

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=pg \
  -p 127.0.0.1:"$PORT":5432 postgres:16-alpine >/dev/null
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
  sleep 1
done

DBS="suco_auth_000000000001 suco_spool_000000000001 suco_meta_000000000001
     suco_private_000000000001 suco_private_000000000002"
for db in $DBS; do
  docker exec "$CONTAINER" psql -U postgres -q \
    -c "CREATE ROLE \"$db\" LOGIN PASSWORD '$db' CREATEROLE BYPASSRLS;" \
    -c "CREATE DATABASE \"$db\" OWNER \"$db\";"
done

docker exec "$CONTAINER" psql -U postgres -q -c "
  CREATE ROLE anon NOLOGIN;
  CREATE ROLE authenticated NOLOGIN;
  CREATE ROLE service_role NOLOGIN;"
for db in $DBS; do
  docker exec "$CONTAINER" psql -U postgres -q \
    -c "GRANT anon, authenticated, service_role TO \"$db\" WITH SET TRUE;"
done

cd "$(dirname "$0")/.."
export SUCO_AUTH_SQL_TEST_DATABASE_URL="postgresql://suco_auth_000000000001:suco_auth_000000000001@127.0.0.1:$PORT/suco_auth_000000000001"
export SUCO_SPOOL_SQL_TEST_DATABASE_URL="postgresql://suco_spool_000000000001:suco_spool_000000000001@127.0.0.1:$PORT/suco_spool_000000000001"
export SUCO_META_SQL_TEST_DATABASE_URL="postgresql://suco_meta_000000000001:suco_meta_000000000001@127.0.0.1:$PORT/suco_meta_000000000001"
export SUCO_PRIVATE_MESSAGE_TEST_DATABASE_URL="postgresql://suco_private_000000000001:suco_private_000000000001@127.0.0.1:$PORT/suco_private_000000000001"
export SUCO_PRIVATE_GATE_TEST_DATABASE_URL="postgresql://suco_private_000000000002:suco_private_000000000002@127.0.0.1:$PORT/suco_private_000000000002"
exec node --experimental-transform-types --test \
  tests/supabase-auth-pg.test.ts \
  tests/supabase-ingestion-spool-pg.test.ts \
  tests/confidential-metadata-pg.test.ts \
  tests/private-messages-pg.test.ts \
  tests/private-account-write-gate-pg.test.ts
