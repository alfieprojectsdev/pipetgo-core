#!/usr/bin/env bash
# T-19 dispute & redress — commit staged changes, push branch, open PR.
# Runs against the worktree at wt/T19-dispute-redress (branch feat/T19-dispute-redress).
set -euo pipefail

WT=/mnt/ssd/home/ltpt420/repos_finch/pipetgo-core/wt/T19-dispute-redress
cd "$WT"

COMMIT_MSG=$(cat <<'EOF'
feat: T-19 dispute & redress — client dispute + admin resolution + payout hold

Implements ITA 2023 internal dispute & redress (IDRM):

- DISPUTED OrderStatus + immutable Order.completedAt anchor (write-once at
  IN_PROGRESS->COMPLETED); 3 new state-machine edges (COMPLETED->DISPUTED,
  DISPUTED->COMPLETED, DISPUTED->REFUND_PENDING) via the single
  isValidStatusTransition guard. No DISPUTED->CANCELLED.
- OrderDispute model (orderId @unique one-to-one) for the auditable
  who/what/when redress trail; DISPUTE_WINDOW_DAYS=14 domain constant.
- Client slice src/features/orders/dispute/ — openDispute (ownership +
  14-day window + legacy null-completedAt out-of-window guard, DL-010).
- Admin slice src/features/orders/dispute-resolution/ — resolveDispute
  (layer-2 ADMIN re-check, updateMany CAS, resolution audit incl.
  resolutionNote); list + detail routes under /dashboard/admin/disputes.
- Payout hold: processSettlement excludes DISPUTED orders from both the
  first-delivery findFirst and the updateMany CAS write predicate.
- DISPUTED badge added to all exhaustive OrderStatus maps; clients
  dashboard map migrated to `as const satisfies`; exhaustiveness test.

Refund execution stays manual/out of scope (DL-007). Per-env
`npx prisma db push` owed for the DISPUTED value + order_disputes table.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)

# Stage (idempotent) and commit.
git add -A
git commit -F - <<<"$COMMIT_MSG"

# Push branch and set upstream.
git push -u origin feat/T19-dispute-redress

# Open PR against main.
gh pr create \
  --base main \
  --head feat/T19-dispute-redress \
  --title "feat: T-19 dispute & redress — client dispute, admin resolution, payout hold" \
  --body "$(cat <<'EOF'
## Summary

Implements ITA 2023 internal dispute & redress (IDRM) per `plans/T-19-dispute-redress.md`.

- **State machine**: adds `DISPUTED` `OrderStatus` and an immutable `Order.completedAt` anchor (written once at `IN_PROGRESS->COMPLETED`). Exactly 3 new edges — `COMPLETED->DISPUTED`, `DISPUTED->COMPLETED`, `DISPUTED->REFUND_PENDING` — all through the single `isValidStatusTransition` guard. No `DISPUTED->CANCELLED`.
- **Audit model**: new `OrderDispute` (orderId `@unique` one-to-one) capturing reason, resolver identity, direction, timestamps, and `resolutionNote` for the ITA redress trail. `DISPUTE_WINDOW_DAYS = 14` domain constant in `src/domain/orders/dispute.ts`.
- **Client slice** `src/features/orders/dispute/`: `openDispute` enforces ownership, the 14-day window, and treats a legacy `null` `completedAt` as out-of-window (no crash, no silent bypass — DL-010).
- **Admin slice** `src/features/orders/dispute-resolution/`: `resolveDispute` re-checks `ADMIN` independently (layer-2 TOCTOU), uses `updateMany` CAS + `count===0` early-return, writes the resolution audit record. List + detail routes under `/dashboard/admin/disputes`.
- **Payout hold**: `processSettlement` excludes orders whose related `Order.status===DISPUTED` from BOTH the first-delivery `findFirst` and the `updateMany` CAS write predicate; the hold lifts automatically on resolution.
- **Badge maps**: `DISPUTED` added to all exhaustive `OrderStatus` maps; clients dashboard map migrated to `as const satisfies`; exhaustiveness test added.

Refund execution stays manual / out of scope (DL-007).

## Verification

- `npx tsc --noEmit` clean.
- Tests added (state-machine edges, write-once anchor, client/admin actions, payout-hold skip+resume, badge exhaustiveness). Run in CI — the local Neon test DB was unreachable this session.

## Deploy note

- ⚠️ `npx prisma db push` owed per env (dev/CI/prod) for the `DISPUTED` enum value + `order_disputes` table before this runs (DL-009 — unpushed = runtime crash, not a type error). `prisma/migrations` is gitignored; `schema.prisma` is source of truth.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
