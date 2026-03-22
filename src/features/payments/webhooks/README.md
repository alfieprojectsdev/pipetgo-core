# payments/webhooks

Xendit invoice webhook handler. Receives POST callbacks from Xendit after a
hosted-invoice payment, authenticates the request, and advances the Transaction
and Order records atomically.

## Request flow

1. Xendit POSTs `{ id, status, paid_amount, payer_email, payment_method }` to
   `/api/webhooks/xendit`.
2. `route.ts` verifies `x-callback-token` header against `XENDIT_WEBHOOK_TOKEN`
   env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
3. Non-`PAID` status values return 200 immediately (no-op acknowledgement).
4. `handlers.ts:processPaymentCapture` runs a Prisma `$transaction`:
   - Finds `Transaction` by `Transaction.externalId == payload.id`.
   - Returns early if not found (orphan tolerance) or already `CAPTURED` (idempotency).
   - Updates `Transaction` to `CAPTURED`, sets `capturedAt`.
   - Constructs `PaymentCapturedEvent` and calls `handlePaymentCaptured` from the
     orders slice inside the same transaction.
5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.

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

## Required env vars

| Variable | Description |
|----------|-------------|
| `XENDIT_WEBHOOK_TOKEN` | Static token from Xendit dashboard webhook settings |

Missing `XENDIT_WEBHOOK_TOKEN` returns 500 (not 401) to surface misconfiguration
in error monitoring before any token comparison.
