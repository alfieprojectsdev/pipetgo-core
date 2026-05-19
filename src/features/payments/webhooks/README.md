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
   - No LabWallet write. Commission tracking is handled by Payout records created inside `completeOrder` at order completion. (ref: DL-001, DL-016)
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

- Idempotency check (`findUnique` on `Transaction.externalId` + status guard) is inside `$transaction` to
  prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
  not `payload.paid_amount` (float). (ref: DL-005)
- Order status transitions are owned by the orders slice — this handler never
  writes `Order.status` directly. (ref: DL-001)
- Webhook capture writes only `Transaction.status` and (via fan-out) `Order.status`;
  commission settlement is tracked via Payout records created at order completion,
  not at payment capture. (ref: DL-016)

## Design decisions

**AD-001 Direct Payment**: Under the AD-001 model, the client pays the lab directly
via Xendit Managed Sub-Account. The webhook handler's job is solely to advance
Transaction and Order state. Commission tracking moves to `Payout` records created
inside `completeOrder` — see `src/features/orders/lab-fulfillment/` and
`docs/roadmap.md` AD-001 section.

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
| `__tests__/handlers.test.ts` | 1-2: AD-001 wallet-untouched assertions, idempotency | Real test database (`DATABASE_TEST_URL`) | Confirms no LabWallet write occurs and Transaction.status is CAPTURED — mocking hides Decimal type mismatches and FK constraint errors |
| `__tests__/handlers.test.ts` | 3: idempotency (already CAPTURED) | Real test database | Confirms early-return guard; wallet remains null |
| `__tests__/handlers.test.ts` | 4: processPaymentCapture FAILED guard (EXPIRED-then-PAID race) | Real test database | Tests the guard that throws on FAILED transaction — same real-DB rationale |
| `__tests__/handlers.test.ts` | 5-6: completeOrder Payout creation, no CAPTURED Transaction throws | Real test database | Confirms Payout record is created with correct fee split and that missing CAPTURED Transaction surfaces as thrown error |
| `__tests__/handlers.test.ts` | 7-9: processPaymentFailed transitions, idempotency, orphan tolerance | Real test database | Same rationale as above; confirms status field writes and failureReason |
| `__tests__/handlers-rollback.test.ts` | 10: processPaymentCapture rollback error propagation | Full Prisma mock (`vi.fn()` stubs) | Forcing `tx.transaction.update` to fail on a real database requires schema changes; `$transaction` atomicity is a Prisma/PostgreSQL guarantee, so this test verifies error propagation only |
| `__tests__/handlers-rollback.test.ts` | 11: processPaymentFailed rollback | Full Prisma mock | Same rationale — forcing `tx.order.update` to fail; atomicity is a Prisma guarantee |

Tests 1-3 require `DATABASE_TEST_URL` set in `.env.test`. The global setup
(`src/test/global-setup.ts`) runs `prisma db push` against the test database
before any tests execute.

### Why the split matters

A test added to `handlers.test.ts` that mocks Prisma would silently defeat the
purpose of the real-DB tests — mocked Decimal arithmetic does not catch
`toFixed()` regressions or FK constraint violations. Keep tests 1-3 on the real
DB; add new mock-based tests to `handlers-rollback.test.ts`.
