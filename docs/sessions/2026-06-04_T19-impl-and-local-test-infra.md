# Session — 2026-06-04 — T-19 implementation + offline local test infrastructure

## Scope

Two threads in one session:
1. Implemented `plans/T-19-dispute-redress.md` on a worktree via the planner executor.
2. Stood up offline local test infrastructure (local Postgres container) and fixed the
   repo-wide test-runnability gaps that surfaced while verifying T-19.

## Thread 1 — T-19 dispute & redress (PR #21, branch `feat/T19-dispute-redress`)

Ran the planner executor end-to-end (waves → code QR → docs → doc QR → retrospective) on a
worktree at `wt/T19-dispute-redress`.

- **M-1 foundation**: `DISPUTED` `OrderStatus`, `DisputeResolution` enum, `OrderDispute` model
  (orderId `@unique`), immutable `Order.completedAt` anchor, `DISPUTE_WINDOW_DAYS=14` domain
  constant, 3 state-machine edges (COMPLETED→DISPUTED, DISPUTED→COMPLETED, DISPUTED→REFUND_PENDING).
- **M-2 client slice** `src/features/orders/dispute/`: `openDispute` (ownership + 14-day window +
  legacy null-`completedAt` out-of-window guard, DL-010); route `/dashboard/orders/[orderId]/dispute`.
- **M-3 admin slice** `src/features/orders/dispute-resolution/`: `resolveDispute` (layer-2 ADMIN
  re-check, `updateMany` CAS, resolution audit incl. `resolutionNote`); routes under
  `/dashboard/admin/disputes`.
- **M-4 payout hold**: `processSettlement` excludes DISPUTED orders from both the `findFirst`
  lookup and the `updateMany` CAS write predicate.
- **M-5 badge maps**: `DISPUTED` added to all exhaustive `OrderStatus` maps; clients dashboard
  migrated to `as const satisfies`; exhaustiveness test.

**QR outcomes (both addressed before merge-ready):**
- Code QR PASS_WITH_CONCERNS → fixed `resolutionNote` write path (CI-M-003-001/DL-003) +
  replaced `as string` casts in lab-fulfillment with `typeof` narrowing.
- Doc QR NEEDS_CHANGES → removed 4 "T-19" temporal-contamination refs from permanent docs;
  moved the payout-hold constraint prose from `payouts/CLAUDE.md` into `payouts/README.md`.

**Follow-up commit** (`9168b7b`): two test bugs found while running the suite against a local
DB — a `vi.mock` auth-hoisting TDZ in `lab-fulfillment/action.test.ts` (fails in CI too,
DB-independent) and a missing `EXT_SETTLE_DISPUTED` idempotency-key in the payouts test
`cleanup()` (settled key persisted across runs on a non-ephemeral DB).

**Still owed before deploy:** `npx prisma db push` per env (dev/CI/prod) for the `DISPUTED`
enum value + `order_disputes` table (DL-009 — unpushed = runtime crash, not a type error).

T-19 suite: **39/39 green** locally.

## Thread 2 — offline local test infrastructure (PR #22, branch `chore/local-test-infra`)

The cloud Neon test DB is unreachable from local dev (`P1001`), which killed the whole suite in
`global-setup`'s `prisma db push`. Stood up a local container and fixed the latent
test-runnability gaps. Full suite went from **9 failed files / 29 failed tests → 33 files /
267 tests, all green.**

- **`scripts/test-local.sh`** — provisions a `postgres:16-alpine` container (`pipetgo-test-db`,
  host port **5433**; dev Postgres holds 5432), points `DATABASE_TEST_URL` at it, regenerates
  the Prisma client + `db push`es the schema **for the current checkout**, then runs vitest.
- **`vitest.config.ts`** — `esbuild.jsx: 'automatic'` (fixes "React is not defined" in node-env
  component renders; `tsconfig` uses `jsx: "preserve"`) + `server-only` aliased to a no-op stub
  (`src/test/server-only-stub.ts`) so `src/lib/storage/r2.ts` and its importers load.
- **Two pre-existing `vi.mock` hoisting bugs** fixed via `vi.hoisted()` (lab-fulfillment +
  order-detail action tests).

**Worktree gotchas discovered (now documented):**
- `wt/` worktrees resolve `node_modules` up to the main checkout → they share ONE generated
  Prisma client; a worktree on a branch with a different `schema.prisma` emits SQL for the wrong
  columns (`column orders.completedAt does not exist`) until re-generated.
- The single local test DB carries whatever schema was last pushed; a branch switch can need a
  destructive `db push --accept-data-loss` (e.g. dropping an enum value another branch added).
- `scripts/test-local.sh` encodes both re-syncs, so prefer it over a bare `npx vitest`.
- No R2/S3 service needed locally — storage tests mock the `@aws-sdk/client-s3` boundary; do
  **not** set `R2_*` in `.env.test` (a test asserts they are absent). MinIO image pulled then
  removed (unnecessary).

**Docs in PR #22** (intentionally bundled with the code they reference, not committed to main
separately): README Testing section, root CLAUDE.md Development, new `src/test/CLAUDE.md`,
`docs/devops-discipline.md` (1 Pre-Flight line + 5 lessons), `docs/roadmap.md` (local
dev/testing subsection + CI service-container note).

## Hardware context (ThinkPad T420)

`lshw`: i5-2540M (2c/4t, 2.6/3.3 GHz, Sandy Bridge), **16 GiB RAM**, Intel HD 3000, SATA-II SSD,
1 Gbit ethernet (wifi disabled). RAM is comfortable; **CPU is the bottleneck** (full suite ~80 s).
Keep concurrent containers light; `docker stop pipetgo-test-db` when idle; prune images for SSD.

## Open state at session end

- PR #21 (T-19) and PR #22 (test-infra) open; both green locally; awaiting CodeRabbit + merge.
- Test DB container `pipetgo-test-db` left running on :5433 (data disposable).
- Shared generated Prisma client currently reflects `main` (last `prisma generate`); re-run
  `scripts/test-local.sh` in a feature worktree before testing it.
- `.env.test` is machine-local (gitignored), pointed at the local container.
