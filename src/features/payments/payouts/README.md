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
   - Step 4: `tx.payout.updateMany({ where: { id: payout.id, externalPayoutId: null }, ... })` — CAS guard; if `updateResult.count === 0`, another delivery already wrote `externalPayoutId` → return early without persisting IdempotencyKey.
   - Step 5: `tx.labWallet.update` — pendingBalance decrement + availableBalance increment in one call.
5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.

## Two-ID scheme

| Field | Value | Purpose |
|-------|-------|---------|
| `payload.id` | Xendit settlement transfer ID | Maps to `Payout.externalPayoutId` — idempotency key |
| `payload.external_id` | Our orderId sent to Xendit at invoice creation | Maps to `Payout.orderId` — first-delivery lookup key |

## Idempotency

Duplicate detection uses three layered guards:

**Layer 1 — IdempotencyKey table (broad, schema-level):**
The first step inside `processSettlement`'s `$transaction` looks up an `IdempotencyKey` row with key `xendit:settlement:COMPLETED:{payload.id}`. If the key row exists, the handler returns early (200 to Xendit). The key row is created as the last step before commit — AFTER the `Payout.updateMany count===0` short-circuit check — so concurrent-first-delivery losers (which return early via `count===0`) do not persist a key. Only the winning delivery does. A handler throw rolls back both the key and the writes, allowing Xendit retries to land cleanly on an empty key lookup. The key is created last — not first — because a transient mid-handler error after an early create would leave the key persisted with the business writes undone; Xendit retries would then see the key and skip work that never completed, causing permanent silent data loss.

**Layer 2 — Dual Payout lookup (entity-state, @unique column):**
- Step 1: `tx.payout.findUnique({ where: { externalPayoutId: payload.id } })` — idempotency for deliveries where `externalPayoutId` is already set.
  - `COMPLETED` → return early.
  - `PROCESSING` or `FAILED` → throw (contract violation).
  - `QUEUED` → proceed with this Payout.
- Step 2 (only if Step 1 found nothing): `tx.payout.findFirst({ where: { orderId: payload.external_id, status: QUEUED, externalPayoutId: null } })` — first-delivery lookup.
  - `null` → return early (orphan tolerance).

**Layer 3 — updateMany compare-and-set (concurrent first-delivery):**
`tx.payout.updateMany({ where: { id: payout.id, externalPayoutId: null }, ... })` with `count===0` short-circuit handles simultaneous first-delivery races. Only the first delivery wins the update; the concurrent loser returns early via `count===0` and does not persist an IdempotencyKey row.

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
  first delivery, idempotent duplicate (COMPLETED early-return), IdempotencyKey dedup (Layer 1 early-return), IdempotencyKey creation atomicity, orphan tolerance, negative-balance guard, PROCESSING contract violation.
- `__tests__/handlers-rollback.test.ts` — full Prisma mock for rollback error propagation:
  walletUpdate failure, payoutUpdateMany failure, idempotencyKey.create atomicity.

## Payout Hold

`processSettlement` excludes payouts whose related `Order.status === DISPUTED` from both
the first-delivery `findFirst` lookup and the `updateMany` CAS write. The hold lifts
automatically when admin resolves the dispute: resolving to `COMPLETED` returns
`Order.status` to `COMPLETED`; resolving to `REFUND_PENDING` advances it to
`REFUND_PENDING`. In either case `Order.status` is no longer `DISPUTED` and the held
`QUEUED` payout becomes eligible for settlement on the next webhook delivery.

Any modification to the `findFirst` or `updateMany` predicates in `handlers.ts` must
preserve the `order: { status: { not: OrderStatus.DISPUTED } }` relation filter on both
clauses.

## Production Wiring

Checkout currently issues regular Xendit invoices (not sub-account split invoices). This
handler is dormant until a later ticket migrates `src/features/payments/checkout/action.ts`
to configure sub-account invoices. The webhook route and handler are production-ready;
only the invoice creation needs updating to enable the settlement flow end-to-end. (ref: DL-012)
