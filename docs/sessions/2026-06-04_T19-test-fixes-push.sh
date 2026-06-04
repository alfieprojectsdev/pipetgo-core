#!/usr/bin/env bash
# T-19 follow-up: commit two test-isolation/hoisting fixes found while running the
# suite against a local Postgres, push to update PR #21.
set -euo pipefail

WT=/mnt/ssd/home/ltpt420/repos_finch/pipetgo-core/wt/T19-dispute-redress
cd "$WT"

git add \
  src/features/orders/lab-fulfillment/__tests__/action.test.ts \
  src/features/payments/payouts/__tests__/handlers.test.ts

git commit -F - <<'EOF'
test: T-19 fix vi.mock hoisting + settlement idempotency-key cleanup

Two test bugs surfaced running the suite against a local Postgres:

- lab-fulfillment/action.test.ts: the `@/lib/auth` mock factory referenced
  the top-level `TEST_USER_LAB_ID` const, but vi.mock is hoisted above the
  const init — "Cannot access 'TEST_USER_LAB_ID' before initialization",
  failing the whole suite to load (fails in CI too, DB-independent). Moved to
  the repo's vi.hoisted() mock-fn pattern, setting the session in beforeEach.
- payouts/handlers.test.ts: cleanup() did not delete the IdempotencyKey rows
  for EXT_SETTLE_DISPUTED / EXT_SETTLE_5, so a settled key persisted across
  runs on a non-ephemeral DB and deduped the "settlement proceeds after
  DISPUTED->COMPLETED" retry (payout stuck QUEUED). Added both keys to the
  cleanup deleteMany list.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF

git push origin feat/T19-dispute-redress
