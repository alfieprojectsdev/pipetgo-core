# Session Log — 2026-05-17 — T-10 Commission Settlement

## What was done

Implemented `plans/T-10-commission-settlement.md` in full. PR #10 is open against `main`.

Branch: `feat/T10-commission-settlement`
PR: https://github.com/alfieprojectsdev/pipetgo-core/pull/10

---

## M-0 — completeOrder patch (lab-fulfillment)

**Problem closed**: T-09 had created `Payout(QUEUED)` but never credited `LabWallet.pendingBalance`, violating the `schema.prisma:295` invariant. T-10's settlement handler would have decremented a balance that was never credited.

**Files changed:**

- `src/features/orders/lab-fulfillment/action.ts` — after `Order.status → COMPLETED`, finds the most-recent `CAPTURED` Transaction, computes `platformFee = gross × 0.1000` (Decimal, no Number coercion), creates `Payout(QUEUED)`, and upserts `LabWallet.pendingBalance += platformFee` — all inside the existing `$transaction`. FIXED-mode orders (no CAPTURED Transaction) skip Payout/LabWallet writes silently.
- `src/features/payments/webhooks/handlers.ts` — removed the old `labWallet.upsert` from `processPaymentCapture`. That block was crediting `Transaction.amount` (gross, wrong figure) at capture time (wrong moment). Replaced with a comment explaining the M-0 invariant.
- `src/features/orders/lab-fulfillment/README.md` — updated Architecture pseudocode to show the three-record `$transaction`: Order update → Payout.create → LabWallet.upsert.
- `src/features/orders/lab-fulfillment/__tests__/action.test.ts` — new integration test file (real test DB). Two scenarios: (1) first order for a lab creates Payout(QUEUED) and LabWallet with correct `pendingBalance`; (2) second order for the same lab increments `pendingBalance`.

---

## M-1 — payouts/ settlement slice

New slice at `src/features/payments/payouts/`. Mirrors the `webhooks/` three-layer pattern.

**Files created:**

- `src/features/payments/payouts/types.ts` — `XenditSettlementPayload` interface. All four field names (`id`, `status`, `amount`, `external_id`) are provisional and carry `TODO(AC-006)` comments pending sandbox verification.
- `src/features/payments/payouts/route.ts` — Next.js POST handler. Auth via `crypto.timingSafeEqual` against `XENDIT_SETTLEMENT_WEBHOOK_TOKEN` (separate env from `XENDIT_WEBHOOK_TOKEN`). Status uppercased; `COMPLETED` dispatches to `processSettlement`; unknown statuses acknowledged at 200 with console.info log. `SETTLEMENT_STATUS_COMPLETED` named constant with TODO comment flags provisional status string value.
- `src/features/payments/payouts/handlers.ts` — `processSettlement`. Five-step `$transaction`:
  1. `findUnique` by `externalPayoutId` (@unique) — idempotency; COMPLETED → return early; PROCESSING/FAILED → throw (contract violation per Implementation Discipline).
  2. `findFirst` by `(orderId, status=QUEUED, externalPayoutId=null)` — first-delivery lookup. null → return early (orphan tolerance).
  3. `findUnique` on `LabWallet` — null → throw typed error (M-0 invariant violated).
  4. Negative-balance guard: `pendingBalance - platformFee < 0` → throw (never clamp).
  5. `updateMany` with `{ id, externalPayoutId: null }` filter as concurrent-delivery guard (Prisma type constraint required `updateMany` over `update` for the null filter). Then `labWallet.update` with `{ decrement: platformFee, increment: platformFee }` in one call.
- `src/features/payments/payouts/__tests__/handlers.test.ts` — integration tests (real DB). Five scenarios: first delivery, idempotent duplicate, orphan tolerance, negative-balance guard (asserts no DB change), PROCESSING contract violation.
- `src/features/payments/payouts/__tests__/handlers-rollback.test.ts` — full Prisma mock. Two scenarios: `labWallet.update` failure propagates; `payout.updateMany` failure propagates.
- `src/features/payments/payouts/README.md` — request flow, AD-001 framing, two-ID scheme, idempotency design, invariants, required env, test strategy, production wiring note, sandbox verification notice.
- `src/features/payments/payouts/CLAUDE.md` — per-slice index.
- `src/app/api/webhooks/xendit-settlement/route.ts` — app-router re-export of `POST` from the feature slice.

**Files updated:**

- `src/features/payments/CLAUDE.md` — added `payouts/` row between `checkout/` and `webhooks/`; updated `webhooks/` row to remove stale "credits LabWallet.pendingBalance" description.

---

## Key decisions made (from plan decision log)

| Decision | Outcome |
|----------|---------|
| LabWallet figure is `platformFee`, not `netAmount` | LabWallet is PipetGo's commission ledger — `platformFee` is PipetGo's income; `netAmount` is the lab's share |
| Credit at Payout-QUEUED (completeOrder), not at settlement | Closes the zero-balance window between Order COMPLETED and Xendit settlement |
| Separate `payouts/` slice from `webhooks/` | Different Xendit product, different payload shape, independent token rotation |
| `updateMany` for concurrent-delivery guard | Prisma's `update.where` does not accept null filters on non-PK fields; `updateMany` with count check is the correct pattern |
| Orphan tolerance returns 200 | Xendit may deliver settlements for non-PipetGo sub-account events; erroring forces infinite retry |

---

## TypeScript fix during implementation

The plan specified `where: { id: payout.id, externalPayoutId: null }` in `tx.payout.update`. Prisma 5 types `update.where` as accepting only unique-identifier fields without null filters, producing:

```
TS2322: Type 'null' is not assignable to type 'string | undefined'
```

Fixed by switching to `tx.payout.updateMany` with `where: { id, externalPayoutId: null }` and checking `result.count === 0` for the concurrent-delivery early-return. Semantics are equivalent.

---

## Pre-merge gates (not yet done)

- **AC-006**: Trigger one real Xendit sandbox settlement; capture JSON; confirm field names and status string against `types.ts`. Commit sample payload to `docs/research/xendit-settlement-sandbox-payload.json`.
- **AC-007**: Check Xendit dashboard for existing Managed Sub-Account settlement webhook registrations. Document in `payouts/README.md` Production Wiring section if any exist.

---

## CI status

- `npx tsc --noEmit` — clean
- `npx eslint src/domain/ src/features/payments/payouts/` — clean
- Integration tests: require `DATABASE_TEST_URL` — not run in this session
