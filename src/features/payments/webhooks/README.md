# payments/webhooks

Xendit invoice webhook handler. Receives POST callbacks from Xendit after a
hosted-invoice payment, authenticates the request, and advances the Transaction
and Order records atomically.

## Request flow

1. Xendit POSTs `{ id, status, paid_amount, payer_email, payment_method }` to
   `/api/webhooks/xendit`.
2. `route.ts` verifies `x-callback-token` header against `XENDIT_WEBHOOK_TOKEN`
   env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
3. `route.ts` normalises `payload.status` to uppercase and dispatches:
   - `PAID` → `processPaymentCapture`
   - `EXPIRED` → `processPaymentFailed`
   - Other non-empty statuses → acknowledged without processing (200, no DB write)
   - Empty/missing status → throws (500) so Xendit retries
4. `handlers.ts:processPaymentCapture` runs a Prisma `$transaction` (PAID path):
   - Finds `Transaction` by `Transaction.externalId == payload.id`.
   - Returns early if not found (orphan tolerance) or already `CAPTURED` (idempotency). Throws if `FAILED` (EXPIRED-then-PAID race guard, ref: R-007).
   - Updates `Transaction` to `CAPTURED`, sets `capturedAt`.
   - Constructs `PaymentCapturedEvent` and calls `handlePaymentCaptured` from the
     orders slice inside the same transaction.
   - Fetches `Order.labId` (read-consistent within same transaction). (ref: DL-004)
   - Upserts `LabWallet.pendingBalance += Transaction.amount` (Decimal, not payload float) for the lab. (ref: DL-002, DL-003, DL-005)
5. `handlers.ts:processPaymentFailed` runs a Prisma `$transaction` (EXPIRED path):
   - Finds `Transaction` by `Transaction.externalId == payload.id`.
   - Returns early if not found (orphan tolerance) or already `FAILED` (idempotency).
   - Updates `Transaction` to `FAILED`, sets `failureReason = 'Xendit invoice EXPIRED'`.
   - Transitions `Order.status` from `PAYMENT_PENDING` to `PAYMENT_FAILED` via `isValidStatusTransition`.
   - No `LabWallet` write — failed payments produce no lab credit.
6. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.
7. Idempotency guards for both handlers are inside their `$transaction` boundaries to prevent
   race conditions from concurrent Xendit webhook deliveries. (ref: DL-004)

## Two-ID scheme

| Field | Value | Direction | Purpose |
|-------|-------|-----------|---------|
| `Transaction.id` | Our cuid | Sent TO Xendit as `external_id` param at invoice creation | Internal primary key; sent so Xendit embeds it for our reference |
| `Transaction.externalId` | Xendit invoice ID | Stored FROM Xendit invoice creation response | Webhook lookup key — `payload.id` in webhook callback |

Both directions are set by the checkout slice:
- `Transaction.id` (cuid) is passed to Xendit's create-invoice API as `external_id`.
- Xendit returns an invoice `id`; the checkout slice stores it as `Transaction.externalId`.

On webhook receipt, the handler looks up `Transaction` by `externalId == payload.id`.
`Transaction.id` is never present in the Xendit webhook payload.

If the lookup fails or the Transaction is already `CAPTURED`, the handler returns 200
(orphan tolerance / idempotency) without retrying. DB errors propagate as 500 so
Xendit retries automatically on transient failures.

## Invariants

- Idempotency check (`findFirst` + status guard) is inside `$transaction` to
  prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
  not `payload.paid_amount` (float). (ref: DL-005)
- Order status transitions are owned by the orders slice — this handler never
  writes `Order.status` directly. (ref: DL-001)
- `LabWallet.pendingBalance` is credited at capture time; `availableBalance` is only
  incremented when a Payout reaches `COMPLETED`. Crediting `availableBalance` here would
  skip the payout lifecycle. (ref: DL-002)
- `LabWallet` upsert uses `upsert` (not `update`) — a row may not exist for a lab's
  first payment. (ref: DL-005)
- `LabWallet.labId` is `@unique` (prisma/schema.prisma:299); the Prisma `$transaction`
  holds a row lock for the upsert, making concurrent webhook deliveries race-free — no
  separate application-level guard is needed.

## Design decisions

**LabWallet credit is inlined in `handlers.ts`** rather than extracted to a separate
`wallets/credit-wallet` slice. ADR-001 uses a `creditLabWallet` fan-out example that
names a hypothetical `@/features/wallets/credit-wallet/handler` — that example is
aspirational documentation for a future wallets slice, not a binding constraint. The
implementation was deliberately scoped to the webhook slice only; extracting a wallets
slice would introduce a new cross-slice import from payments to wallets, which is a
larger architectural change requiring its own plan.

**Order is fetched twice within the same `$transaction`** — once inside
`handlePaymentCaptured` (for status transition) and once in `handlers.ts` (for
`labId`). This double-read is an accepted tradeoff at MVP order volumes: PostgreSQL
read-consistency guarantees both reads see the same snapshot at negligible cost. If
needed, this can be eliminated later by returning `labId` from `handlePaymentCaptured`.

## Required env vars

| Variable | Description |
|----------|-------------|
| `XENDIT_WEBHOOK_TOKEN` | Static token from Xendit dashboard webhook settings |

Missing `XENDIT_WEBHOOK_TOKEN` returns 500 (not 401) to surface misconfiguration
in error monitoring before any token comparison.

## Test strategy

Integration tests for `processPaymentCapture` are split across two files by mocking strategy:

| File | Tests | DB strategy | Why |
|------|-------|-------------|-----|
| `__tests__/handlers.test.ts` | 1-3: wallet creation, balance increment, idempotency | Real test database (`DATABASE_TEST_URL`) | Financial ledger correctness requires DB-level verification — mocking hides Decimal type mismatches and FK constraint errors |
| `__tests__/handlers.test.ts` | 4: processPaymentCapture FAILED guard (EXPIRED-then-PAID race) | Real test database | Tests the guard that throws on FAILED transaction — same real-DB rationale |
| `__tests__/handlers.test.ts` | 5-7: processPaymentFailed transitions, idempotency, orphan tolerance | Real test database | Same rationale as above; confirms status field writes and failureReason |
| `__tests__/handlers-rollback.test.ts` | 8: processPaymentCapture rollback error propagation | Full Prisma mock (`vi.fn()` stubs) | Forcing `tx.labWallet.upsert` to fail on a real database requires schema changes; `$transaction` atomicity is a Prisma/PostgreSQL guarantee, so this test verifies error propagation only |
| `__tests__/handlers-rollback.test.ts` | 9: processPaymentFailed rollback | Full Prisma mock | Same rationale — forcing `tx.order.update` to fail; atomicity is a Prisma guarantee |

Tests 1-3 require `DATABASE_TEST_URL` set in `.env.test`. The global setup
(`src/test/global-setup.ts`) runs `prisma db push` against the test database
before any tests execute.

### Why the split matters

A test added to `handlers.test.ts` that mocks Prisma would silently defeat the
purpose of the real-DB tests — mocked Decimal arithmetic does not catch
`toFixed()` regressions or FK constraint violations. Keep tests 1-3 on the real
DB; add new mock-based tests to `handlers-rollback.test.ts`.
