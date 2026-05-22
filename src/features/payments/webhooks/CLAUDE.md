# payments/webhooks/

Xendit invoice webhook slice — authenticates callbacks and atomically captures payments.

## Files

| File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `route.ts`    | Next.js route handler; `verifyXenditToken` auth via `webhook-auth` module; `XenditInvoicePayload` parse and normalize to `NormalizedWebhookPayload`; exhaustive PAID/EXPIRED dispatch | Modifying webhook auth or adding new Xendit event types       |
| `handlers.ts` | `processPaymentCapture` and `processPaymentFailed` accept `NormalizedWebhookPayload` (provider-agnostic); no `XenditInvoicePayload` dependency | Modifying payment capture or failure logic |
| `types.ts`    | `XenditInvoicePayload` raw webhook body shape and `normalizeXenditInvoicePayload` adapter producing `NormalizedWebhookPayload` | Adding fields from Xendit payload or modifying type contracts |
| `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
| `__tests__/handlers.test.ts` | Real-DB integration: processPaymentCapture (AD-001 no-wallet-write, idempotency, FAILED guard, IdempotencyKey dedup, IdempotencyKey creation atomicity); completeOrder Payout creation; processPaymentFailed (EXPIRED key dedup, cross-event key isolation, FAILED transition, idempotency, orphan tolerance) | Running or modifying payment handler integration tests |
| `__tests__/handlers-rollback.test.ts` | Full-mock rollback: processPaymentCapture transaction.update failure + idempotencyKey.create atomicity; processPaymentFailed order.update failure + idempotencyKey.create atomicity | Running or modifying rollback error propagation tests |
