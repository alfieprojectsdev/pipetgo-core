# payments/webhooks/xendit-va

Xendit Fixed Virtual Account (FVA) webhook handler. Receives POST callbacks from
Xendit after a PESONet bank transfer, authenticates, and advances Transaction and
Order records by reusing the shared `handlers.ts` — identical to the invoice slice.

## Request flow

1. Client submits bank selector form on order-detail; `initiateVaCheckout` creates
   a Xendit FVA via POST `/fixed-virtual-accounts` and writes a PENDING Transaction
   with `externalId = Xendit FVA id` and `vaNumber = account_number`.
   `initiateVaCheckout` redirects to `/dashboard/orders/{orderId}` rather than a
   Xendit-hosted payment page because FVA has no hosted page — the VA number displayed
   on order-detail IS the payment instruction.
2. Client bank-transfers the exact `expected_amount` to the VA number.
3. Xendit POSTs `{ callback_virtual_account_id, status, bank_code, ... }` to
   `/api/webhooks/xendit-va`.
4. `route.ts` calls `verifyXenditToken` — same `x-callback-token` mechanism and
   `XENDIT_WEBHOOK_TOKEN` env var as the invoice webhook.
5. `route.ts` casts body to `XenditVaPayload`, calls `normalizeXenditVaPayload` to
   produce `NormalizedWebhookPayload { externalId, paymentMethod, idempotencyKeyPrefix: 'xendit:va' }`.
6. `route.ts` dispatches on `payload.status`:
   - `COMPLETED` → `processPaymentCapture`
   - `EXPIRED` | `FAILED` → `processPaymentFailed`
   - `PENDING`, `ACTIVE`, unknown → 200 no-op (prevents Xendit retry storms)
7. `processPaymentCapture` and `processPaymentFailed` run unchanged — the only
   difference is `idempotencyKeyPrefix = 'xendit:va'` producing keys
   `xendit:va:PAID:{fvaId}` and `xendit:va:EXPIRED:{fvaId}`.
8. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.

## Two-ID scheme (VA path)

| Field | Value | Direction | Purpose |
|---|---|---|---|
| `Transaction.id` | Our cuid | Sent TO Xendit as `external_id` at FVA creation | Internal primary key |
| `Transaction.externalId` | Xendit FVA `id` | Stored FROM Xendit FVA creation response | Webhook lookup key |

`callback_virtual_account_id` in the webhook payload equals `Transaction.externalId`
(the Xendit FVA id, not our cuid). `normalizeXenditVaPayload` maps
`callback_virtual_account_id → externalId` — not `external_id → externalId`.

## Idempotency

Identical two-layer structure to the invoice webhook:

- Layer 1: `IdempotencyKey` with keys `xendit:va:PAID:{fvaId}` and
  `xendit:va:EXPIRED:{fvaId}`. Keys in the `xendit:va` namespace are distinct from
  `xendit:invoice` keys — no cross-product collision.
- Layer 2: `Transaction.status` guard — CAPTURED/FAILED terminal checks inside
  `$transaction`.

## FVA constraints enforced at creation

| Constraint | Xendit parameter | Effect |
|---|---|---|
| Full-amount only | `expected_amount = Transaction.amount.toNumber()` | Xendit only fires COMPLETED when the exact amount is received |
| Single-payment | `is_closed: true` | VA auto-closes after first deposit; prevents double-credit |
| 72h expiry | `expiration_date = Date.now() + 72h` | Orphaned FVAs expire without manual cleanup; EXPIRED webhook transitions payment to FAILED |

## EXPIRED / FAILED recovery

`EXPIRED` and `FAILED` route to `processPaymentFailed`, transitioning Order to
`PAYMENT_FAILED`. The retry CTA from T-08 lets clients call `initiateVaCheckout`
again. A second call creates a new Transaction row; `order-detail` fetches
`take: 1, orderBy: { createdAt: desc }` to show the most recent VA.

## Invariants

- `handlers.ts` imports zero provider-specific types; only `xendit-va/route.ts`
  references `XenditVaPayload`.
- `processPaymentCapture` and `processPaymentFailed` contain zero VA-specific logic.
  The `idempotencyKeyPrefix` one-liner in `handlers.ts` is the only change shared
  between invoice and VA paths.
- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Decimal), not the
  webhook-reported amount — prevents float drift.
- `Transaction.vaNumber` is a typed nullable column, not stored in `metadata` JSON.
  RSC DTOs can SELECT it directly without a cast.

## Required env vars

| Variable | Description |
|---|---|
| `XENDIT_WEBHOOK_TOKEN` | Shared with invoice webhook — Xendit uses the same token for FVA callbacks |
| `XENDIT_SECRET_KEY` | Used by `createXenditVa` in `initiateVaCheckout` for FVA creation |
