# T-13b — Admin order oversight (read-only): planning session complete

**Date:** 2026-06-03
**Plan file:** `plans/T-13b-admin-order-oversight.md` (1759 lines, QR-verified)
**Playbook:** `docs/sessions/2026-06-03_T-13b-playbook.md`
**Branch for implementation (not yet cut):** `feat/T13b-admin-order-oversight`
**Status:** plan written + committed; implementation NOT started.

---

## What happened this session

Ran the **planner skill in planning mode** end-to-end (orchestrator delegates every phase to
sub-agents; main thread never edits). The playbook front-loaded 5 decisions, so the architect
interview only had to resolve two open design choices, both answered by the user:

- **Attachment download → on-demand** (DL-004): ADMIN-gated `viewOrderAttachment` Server Action
  mirroring `kyc-review/view-document-action.ts`; 300s presigned GET, `allowedPrefix: 'orders/'`;
  plus a client `AttachmentListUi` that opens the tab synchronously before the await.
- **Pagination → cursor-based** (DL-003): `findMany take = PAGE_SIZE+1` over-fetch, `cursor +
  skip:1`, compound `orderBy [{createdAt desc},{id desc}]` for tie stability; backward (`dir=prev`)
  traversal uses reversed orderBy + `.reverse()` to restore display order; Next/Prev as `next/link`.

## Plan shape

**7 decisions (DL-001..007):**
1. Two routes — `orders/page.tsx` (list) + `orders/[orderId]/page.tsx` (detail), mirroring kyc-review.
2. PII minimization — list shows minimal fields; full `ClientProfile` only in the gated detail (RA 10173).
3. Cursor pagination (above).
4. On-demand attachment download (above).
5. Two-layer ADMIN auth — layout guard is layer 1; every Server Action + every admin RSC page
   independently re-checks `role === 'ADMIN'` (DL-001/TOCTOU). Highest-consequence invariant:
   getting it wrong leaks cross-tenant order + PII + financial data.
6. Split null-relation guards — `!order → notFound()`; null `lab`/`service`/`client` after explicit
   include → `throw`; `clientProfile` is `ClientProfile?` so null is a valid data state (no throw).
7. ADMIN bootstrap-only — no in-app promotion path (DL-008); ADMIN set via direct DB UPDATE per env.

**4 milestones, 3 waves:** W-001 list page + attachment action/UI (parallel) → W-002 detail page
(depends on AttachmentListUi) → W-003 tests + `vitest.unit.config.ts` glob + slice docs.

**Invariants baked into code intents:** strictly read-only (no update/create/delete/upsert);
inline `.toFixed(2)`/`.toISOString()` serialization into string-typed DTOs (wallet/page.tsx
convention; `feePercentage.toFixed(4)` because schema is `Decimal(5,4)`); enum badge maps
`as const satisfies Record<EnumType,…>` covering all 12 OrderStatus / 5 TransactionStatus /
4 PayoutStatus members. **No schema change → no `npx prisma db push` owed.**

DIAG-001 captures the on-demand download flow (admin → client UI → action → Prisma/R2) with the
layer-2 gate and bounded-TTL presign.

## QR cycle — every gate reached PASS

| Phase | Iterations | What the fix iteration caught |
|-------|-----------|-------------------------------|
| plan-design | 2 (1 fix) | backward (`dir=prev`) cursor traversal was unspecified |
| plan-code | 2 (1 fix) | 3 defects: `window.open(''', …)` syntax error (build-breaker); `let rows: Awaited<ReturnType<typeof prisma.order.findMany>>` is the unselected `Order[]` type (no `lab`/`clientProfile`) → strict-TS failure; both new RSC page tests mocked `redirect` as a no-op so the non-ADMIN cases fell through to `findMany`/`findUnique` and the auth-gate assertion never held |
| plan-docs | 2 (1 fix) | README/CLAUDE.md substance was authored in the `diff` field with only a stub `doc_diff` (for doc files the doc_diff IS the deliverable); DL-002 (PII min), DL-005 (TOCTOU), DL-008 (bootstrap) absent from in-code doc comments |

**Notable:** the plan-code QR caught exactly the failure class the recent Compounding bullet
targets — a client handler awaiting a Server Action with broken popup/error handling — plus the
serialization-typing trap that is invisible to `tsc`. Validates keeping those QR checks.

## Resilience note

- **Session-limit reset hit at plan-code QR re-verify:** all 3 re-verify agents returned the
  account-level limit error with **0 subagent tokens** (never ran). On "resume" they were
  re-dispatched verbatim and passed. No partial state (same pattern as T-12 W-001 start).
- **QR-decompose agents twice tried to return a narrative review instead of running the script to
  completion** (qr-*.json not written). Re-dispatched with an explicit "follow every script step
  until it writes the json" instruction; succeeded. Worth front-loading that instruction in the
  decompose dispatch for future runs.

## Outstanding (for the implementation session)

- Cut `feat/T13b-admin-order-oversight` from up-to-date `main`; run the planner **executor** on
  `plans/T-13b-admin-order-oversight.md`.
- Pre-existing debts unrelated to T-13b: CI/prod `npx prisma db push` for T-12 + T-18 columns;
  real ≥10 MB RESULT PDF end-to-end upload check.
- Compounding Protocol next run after the next 3–5 merged PRs (≥ #20); runner-up cluster to watch
  = doc/docstring drift vs code.
