#!/usr/bin/env bash
#
# test-local.sh — provision a local test environment and run the vitest suite.
#
# Replaces the cloud Neon test DB with a local Postgres container so the suite
# runs offline. Safe to run from any worktree: it re-syncs the generated Prisma
# client AND the DB schema to THIS checkout's prisma/schema.prisma first, which
# is what makes per-branch worktrees work (a worktree on a different branch would
# otherwise share a stale generated client / a DB schema from another branch).
#
# Usage:
#   ./scripts/test-local.sh                 # provision, then run the full suite
#   ./scripts/test-local.sh src/lib/...     # provision, then run matching files
#   PGPORT=5433 ./scripts/test-local.sh     # override host port (default 5433)
#
# Resource note (ThinkPad T420 / i5-2540M, 2c/4t): the container idles ~80 MB;
# the CPU is the bottleneck, so the full suite takes ~80 s. `docker stop
# pipetgo-test-db` when done to free the port; data is disposable.
set -euo pipefail

CONTAINER=pipetgo-test-db
IMAGE=postgres:16-alpine
PGPORT="${PGPORT:-5433}"
PGPASSWORD_LOCAL=postgres
PGDB=pipetgo_test
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

c() { printf '\033[1;36m== %s\033[0m\n' "$*"; }

# 1. .env.test must point DATABASE_TEST_URL at the local container.
if [ ! -e .env.test ]; then
  c "creating .env.test (local Postgres)"
  cat > .env.test <<EOF
# Local test Postgres (docker container \`$CONTAINER\`, $IMAGE on host port $PGPORT).
DATABASE_TEST_URL=postgresql://postgres:$PGPASSWORD_LOCAL@localhost:$PGPORT/$PGDB
EOF
fi
TEST_URL="$(grep -E '^DATABASE_TEST_URL=' .env.test | head -1 | cut -d= -f2-)"

# 2. Ensure the container exists and is running.
if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  c "creating container $CONTAINER on :$PGPORT"
  docker run -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD="$PGPASSWORD_LOCAL" -e POSTGRES_USER=postgres -e POSTGRES_DB="$PGDB" \
    -p "$PGPORT:5432" "$IMAGE" >/dev/null
elif ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  c "starting container $CONTAINER"
  docker start "$CONTAINER" >/dev/null
fi

c "waiting for Postgres"
for _ in $(seq 1 30); do
  docker exec "$CONTAINER" pg_isready -U postgres -d "$PGDB" >/dev/null 2>&1 && break
  sleep 1
done

# 3. Sync the generated Prisma client to THIS worktree's schema.
c "prisma generate (this worktree's schema)"
npx prisma generate >/dev/null

# 4. Sync the DB schema to THIS worktree's schema. --accept-data-loss is safe:
#    the test DB holds only disposable fixtures, and a branch switch can require
#    a destructive diff (e.g. dropping an enum value the other branch added).
c "prisma db push (sync test DB schema)"
DATABASE_URL="$TEST_URL" npx prisma db push --accept-data-loss --skip-generate >/dev/null

# 5. Run the suite (global-setup's own db push is now a no-op).
c "vitest"
exec npx vitest run "$@"
