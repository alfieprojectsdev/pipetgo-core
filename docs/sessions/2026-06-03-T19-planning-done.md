# T-19 — Dispute and redress mechanism: planning session complete

**Date:** 2026-06-03
**Plan file:** `plans/T-19-dispute-redress.md` (1577 lines, QR-verified)
**Playbook:** `docs/sessions/2026-06-03_T-19-playbook.md`
**Branch for implementation (not yet cut):** `feat/T19-dispute-redress`
**Status:** plan written; NOT yet committed; implementation NOT started.

---

## What happened this session

Ran the **planner skill in planning mode** end-to-end (orchestrator delegates every phase to
sub-agents; main thread never edits). The playbook front-loaded the decision surface; the
architect interview only had to resolve two open choices, both answered by the user:

- **Dispute window → 14 days** — `DISPUTE_WINDOW_DAYS = 14` in `src/domain/orders/dispute.ts`;
  out-of-window attempts throw/reject, never silently no-op.
- **Dispute data → new `OrderDispute` model** — `orderId @unique`, `reason`, `openedAt`,
  `resolvedAt`, `DisputeResolution` enum (`RESOLVED_COMPLETED | RESOLVED_REFUND`), `resolvedById`
  (User named relation `"DisputeResolver"`, mirroring `Lab.kycReviewedById` to avoid colliding
  with `Order.clientId`), `resolutionNote`. Auditable who-resolved-it trail for the ITA IDRM.

## Plan shape

**Decisions (DL-001..010):** completedAt anchor (DL-001); 14-day window constant (DL-002);
resolution-note storage (DL-003); exactly-3 transitions (DL-004); payout-hold money guard (DL-005);
two-slice + layer-2 ADMIN/TOCTOU separation (DL-006); plus DL-007..009; **DL-010 added in a QR fix
iteration** — legacy COMPLETED orders predate `completedAt` so a null is treated as out-of-window
(not a crash), with an explicit backfill stance logged.

**5 milestones, 2 waves:**
- **M-1 Foundation** (shared, Wave 1): `prisma/schema.prisma` (`DISPUTED` enum + `DisputeResolution`
  enum + `Order.completedAt` + `OrderDispute` model & User back-relation), `src/domain/orders/dispute.ts`
  (window constant + `isWithinDisputeWindow`), `state-machine.ts` (3 edges:
  `COMPLETED→DISPUTED`, `DISPUTED→COMPLETED`, `DISPUTED→REFUND_PENDING`),
  `lab-fulfillment/action.ts` (`completedAt: new Date()` at the COMPLETED update).
- **Wave 2 (parallel):** M-2 client dispute slice (`src/features/orders/dispute/`), M-3 admin
  resolution slice (`src/features/orders/dispute-resolution/`, two-layer ADMIN auth), M-4 payout
  hold (`payments/payouts/handlers.ts` — exclude `OrderStatus.DISPUTED` from settlement on both the
  `findFirst` and the `updateMany` CAS predicate), M-5 badge maps (add `DISPUTED` label).

**Invariants baked into code intents:** every `Order.status` write via `isValidStatusTransition()`;
payout hold via `updateMany` guard predicate + `count===0` early-return (never bare update); client
ownership guard + admin layer-2 re-check; `findUnique` on `@id`; null guaranteed relation throws;
`redirect()` after (not inside) try/catch; `formData` runtime-narrowed; Decimal/Date serialized to
string DTOs; deterministic timestamp formatting (fixed `en-PH`/`Asia/Manila`, no bare
`toLocaleString()`); badge maps `as const satisfies Record<OrderStatus,…>`.

## QR cycle — every gate reached PASS

| Phase | Iterations | What the fix iterations caught |
|-------|-----------|-------------------------------|
| plan-design | 4 (3 fix) | DL-001 id collision with the existing "DL-001 TOCTOU" fact; unlogged `completedAt` backfill for legacy COMPLETED orders (→ DL-010); missing `DisputeResolution` dispatch decision; SLA constraint had no milestone/readme home + empty `readme_entries`; risk R-001..003 mitigation/test coverage; a residual stale `DL-001` ref in a constraint |
| plan-code | 2 (1 fix) | 5 defects: `notFound()` inside a re-throwing `$transaction` try/catch (NEXT_NOT_FOUND control-flow signal swallowed → 500 instead of 404 on the ownership-deny path); 2 wrong DL markers in docstrings (`DL-004`/`DL-001` for TOCTOU → `DL-006`); string literal `'DISPUTED'` instead of `OrderStatus.DISPUTED` on the settlement money filter; list page coerced a guaranteed `OrderDispute` relation (`?? ''`) instead of throwing |
| plan-docs | 2 (1 fix) | 3 temporal-contamination comments (Timeless Present Rule): "Migrated from … to", "pre-T19" ticket tags, "COMPLETED gains DISPUTED" — all reframed to enduring present tense |

**Notable:** plan-code QR caught the `notFound()`-in-try/catch control-flow trap — same class as the
`redirect()`-in-try/catch discipline bullet, but for the not-found signal. The canonical peer
`acceptQuote` returns `{ message }` rather than calling `notFound()` inside a tx; the plan now matches.

## Resilience note

- **Session-limit reset hit during the first architect fix-mode dispatch** (0 subagent tokens, never
  ran). Scheduled a 30-min wakeup; on resume the architect was re-dispatched verbatim and the cycle
  ran to completion. STATE_DIR (`/tmp/claude-1000/planner-uwrl3ss6`) survived the wait (it is in
  `/tmp` — a reboot would have forced a re-run from planner step 1).

## Outstanding (for the implementation session)

- **Commit the plan + this note + roadmap update to `main`** before `/clear` (plan currently
  uncommitted in the working tree).
- Cut `feat/T19-dispute-redress` from up-to-date `main`; run the planner **executor** on
  `plans/T-19-dispute-redress.md`.
- **Three implementation caveats flagged by the developer phase** (verify during execution):
  1. `OrderDispute.resolvedBy` needs the matching `disputeResolutions OrderDispute[] @relation("DisputeResolver")`
     back-reference on the `User` model (Prisma compile-time requirement).
  2. List + detail resolution pages need **separate app-router files** (`/dashboard/admin/disputes/page.tsx`
     and `/dashboard/admin/disputes/[orderId]/page.tsx`) — one default export per route.
  3. **Verify Prisma 5.22 supports a nested relation filter (`order: { status: { not: DISPUTED } }`)
     inside `updateMany`** — the money-risk line. If unsupported, fall back to collect-eligible-ids →
     `updateMany({ where: { id: { in } } })`.
- **`npx prisma db push` owed per env** (dev/CI/prod) for the `DISPUTED` enum value + `completedAt`
  column + `OrderDispute` table. Pre-existing unrelated debts still open: T-18 + T-12 CI/prod pushes.
- **DISPUTE_WINDOW_DAYS = 14** and the documented ITA SLA live in `dispute.ts` + slice docs.
- Compounding Protocol next run after the next 3–5 merged PRs (≥ #21); last run after PR #20.
