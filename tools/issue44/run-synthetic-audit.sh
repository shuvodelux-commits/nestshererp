#!/usr/bin/env bash
# ISSUE #44 — PREPARED ONLY, NEVER EXECUTE WITHOUT SECOND EXPLICIT OWNER APPROVAL.
# No production credentials, tenant backup, persistent volumes or live DB endpoints.
set -euo pipefail
umask 077

gate="issue44-synthetic-only-explicit-second-approval"
if [[ "${ISSUE44_OWNER_APPROVED_RUN:-}" != "$gate" ]]; then
  echo "Issue 44: second explicit owner approval for SQL execution is missing" >&2
  exit 64
fi
if [[ -z "${ISSUE44_APPROVED_HEAD:-}" || ! "$ISSUE44_APPROVED_HEAD" =~ ^[a-f0-9]{40}$ ]]; then
  echo "Issue 44: exact approved GitHub head SHA is required" >&2
  exit 64
fi

root="/home/shoaib/Projects/hisabiq-issue44-synthetic-prepare-20261113"
container_name="hisabiq-issue44-synthetic-pg16-20261113"
db_name="hisabiq_issue44_synthetic_20261113"
cd "$root"
if [[ "$(git rev-parse HEAD)" != "$ISSUE44_APPROVED_HEAD" ]] || [[ -n "$(git status --porcelain=v1)" ]]; then
  echo "Issue 44: source head differs from approved SHA or worktree is not clean" >&2
  exit 64
fi
if podman container exists "$container_name"; then
  echo "Issue 44: disposable container name is already in use; refusing to reuse" >&2
  exit 64
fi
if ss -lnt | grep -q ":55544 "; then
  echo "Issue 44: localhost port 55544 is not free" >&2
  exit 64
fi

export POSTGRES_PASSWORD
export ISSUE44_AUDIT_PASSWORD
export ISSUE44_ALLOW_SYNTHETIC_SQL="$gate"
export ISSUE44_ADMIN_DATABASE_URL
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
ISSUE44_AUDIT_PASSWORD="$(openssl rand -hex 32)"
ISSUE44_ADMIN_DATABASE_URL="postgres://postgres:${POSTGRES_PASSWORD}@127.0.0.1:55544/${db_name}"
container_id=""
cleanup() {
  if [[ -n "$container_id" ]]; then
    podman stop "$container_id" >/dev/null 2>&1 || true
  fi
  unset POSTGRES_PASSWORD ISSUE44_AUDIT_PASSWORD ISSUE44_ALLOW_SYNTHETIC_SQL ISSUE44_ADMIN_DATABASE_URL
}
trap cleanup EXIT

container_id="$(podman run --rm -d --pull=never \
  --name "$container_name" \
  --tmpfs /var/lib/postgresql/data:rw,size=512m \
  -p 127.0.0.1:55544:5432 \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD \
  -e POSTGRES_DB="$db_name" \
  docker.io/library/postgres:16-alpine)"

ready=0
for attempt in $(seq 1 25); do
  if podman exec "$container_id" pg_isready -U postgres -d "$db_name" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ "$ready" != 1 ]]; then
  echo "Issue 44: synthetic PostgreSQL 16 was not ready" >&2
  exit 70
fi

# The ONLY SQL execution step; the source test includes an independent DB gate.
podman run --rm --pull=never --userns=keep-id --network host \
  -v "$root:/work:rw" -w /work/apps/api \
  -e ISSUE44_ALLOW_SYNTHETIC_SQL \
  -e ISSUE44_ADMIN_DATABASE_URL \
  -e ISSUE44_AUDIT_PASSWORD \
  docker.io/library/node:20-bookworm-slim bash -lc \
  "../../node_modules/.bin/vitest run test/issue44-historical-audit.spec.ts --maxWorkers=1 --minWorkers=1"

echo "Issue 44: synthetic-only checks finished; disposable container will be removed by EXIT trap"
