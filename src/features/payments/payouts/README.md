# payments/payouts

Xendit sub-account split settlement webhook slice. When Xendit settles PipetGo's
commission into PipetGo's account, it fires a settlement event. This slice handles
that event: looks up the QUEUED Payout by externalPayoutId, marks it COMPLETED, and
atomically moves Payout.platformFee from LabWallet.pendingBalance to availableBalance.

## AD-001 framing

Under the AD-001 direct payment model, clients pay labs directly via Xendit Managed
Sub-Accounts. Xendit automatically splits PipetGo's commission at settlement; PipetGo
never holds the gross. LabWallet is PipetGo's commission ledger per lab — not lab
escrow. The figure moving through pending/available is Payout.platformFee (PipetGo's
commission share), not Payout.netAmount (the lab's net).

## Request flow

1. Xendit POSTs settlement payload to `/api/webhooks/xendit-settlement`.
2. `route.ts` verifies `x-callback-token` header against `XENDIT_SETTLEMENT_WEBHOOK_TOKEN`
   env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
3. `route.ts` normalises `payload.status` to uppercase and dispatches:
   - `COMPLETED` → `processSettlement` (see `SETTLEMENT_STATUS_COMPLETED` constant)
   - Other non-empty statuses → acknowledged without processing (200, console.info log)
   - Empty/missing status → throws (500) so Xendit retries
4. `handlers.ts:processSettlement` runs a Prisma `$transaction`:
   - Step 1: `tx.payout.findUnique({ where: { externalPayoutId: payload.id } })` — idempotency.
     - COMPLETED → return early (duplicate delivery).
     - PROCESSING or FAILED → throw (contract violation per Implementation Discipline).
     - QUEUED → proceed with this Payout.
   - Step 2 (only if Step 1 found nothing): `tx.payout.findFirst({ where: { orderId: payload.external_id, status: QUEUED, externalPayoutId: null } })` — first-delivery lookup.
     - null → return early (orphan tolerance).
   - Step 2.5: `tx.labWallet.findUnique({ where: { labId: payout.labId } })` — explicit wallet read.
     - null → throw with typed message (M-0 invariant violated).
   - Step 3: compute `newPending = pendingBalance - platformFee`. Negative → throw.
   - Step 4: `tx.payout.update` — status=COMPLETED, externalPayoutId=payload.id, completedAt=now.
   - Step 5: `tx.labWallet.update` — pendingBalance decrement + availableBalance increment in one call.
5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.

## Two-ID scheme

| Field | Value | Purpose |
|-------|-------|---------|
| `payload.id` | Xendit settlement transfer ID | Maps to `Payout.externalPayoutId` — idempotency key |
| `payload.external_id` | Our orderId sent to Xendit at invoice creation | Maps to `Payout.orderId` — first-delivery lookup key |

## Idempotency

Duplicate detection uses `Payout.externalPayoutId` (`@unique`) as the native idempotency
key. No separate IdempotencyKey table is needed (Payout already carries the key natively).
The dual-lookup (Step 1 by externalPayoutId, Step 2 by orderId+QUEUED) handles both
duplicate deliveries and first deliveries in a single handler path.

## Invariants

- `$transaction` atomicity: Payout.status=COMPLETED and LabWallet balance move are one atomic unit.
- `pendingBalance` never goes negative: throw on contract violation, never clamp.
- PROCESSING or FAILED Payouts are never written by this handler — throw on unexpected status.
- LabWallet existence is pre-guaranteed by `completeOrder` (M-0 patch): absence throws with typed message.
- `findUnique` on `Payout.externalPayoutId` (@unique) per Implementation Discipline — never `findFirst` on a `@unique` field.
- No Number coercion on Prisma Decimal values — Prisma Decimal methods only.

## Required env

| Var | Purpose |
|-----|---------|
| `XENDIT_SETTLEMENT_WEBHOOK_TOKEN` | Static x-callback-token for Xendit settlement webhook. Missing returns 500. Separate from `XENDIT_WEBHOOK_TOKEN` so both can be rotated independently. |

## Test strategy

Same split as `webhooks/` slice:
- `__tests__/handlers.test.ts` — real test DB (DATABASE_TEST_URL) for ledger correctness:
  first delivery, idempotent duplicate, orphan tolerance, negative-balance guard, PROCESSING contract violation.
- `__tests__/handlers-rollback.test.ts` — full Prisma mock for rollback error propagation.

## Production Wiring

Checkout currently issues regular Xendit invoices (not sub-account split invoices). This
handler is dormant until a later ticket migrates `src/features/payments/checkout/action.ts`
to configure sub-account invoices. The webhook route and handler are production-ready;
only the invoice creation needs updating to enable the settlement flow end-to-end. (ref: DL-012)

Pre-merge: verify the Xendit dashboard for any existing settlement webhook registrations
per AC-007. If any exist, document them here before merge.

## Xendit payload shape verification

All field names in `types.ts` are provisional and marked with `TODO(sandbox-verify)`. Verify
against Xendit sub-account settlement webhook documentation and sandbox before enabling
production traffic on this route.
