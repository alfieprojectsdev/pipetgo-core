# payments/webhooks/

Xendit webhook slices — invoice and Fixed Virtual Account (FVA) callbacks. `handlers.ts` is provider-agnostic; each `route.ts` normalizes its provider payload before dispatch.

## Files

| File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `route.ts`    | Xendit invoice webhook POST handler; `verifyXenditToken` auth; `XenditInvoicePayload` parse and normalize to `NormalizedWebhookPayload`; PAID/EXPIRED/other dispatch | Modifying invoice webhook auth or invoice event handling |
| `handlers.ts` | `processPaymentCapture` and `processPaymentFailed` — provider-agnostic; accept `NormalizedWebhookPayload`; `idempotencyKeyPrefix ?? 'xendit:invoice'` key construction; shared by invoice and VA routes | Modifying payment capture or failure business logic |
| `types.ts`    | `XenditInvoicePayload` raw body shape and `normalizeXenditInvoicePayload` adapter | Adding invoice payload fields or modifying invoice normalization |
| `README.md`   | Request flow, two-ID scheme, idempotency design, normalization boundary description, VA sub-slice pointer | Understanding capture lifecycle, debugging webhook behavior, or onboarding to the payment slice |
| `__tests__/handlers.test.ts` | Real-DB integration: processPaymentCapture (idempotency, FAILED guard, IdempotencyKey dedup, atomicity); completeOrder Payout creation; processPaymentFailed (EXPIRED key dedup, cross-event isolation, orphan tolerance) | Running or modifying payment handler integration tests |
| `__tests__/handlers-rollback.test.ts` | Full-mock rollback: processPaymentCapture and processPaymentFailed atomicity with aligned mock method names | Running or modifying rollback error propagation tests |

## Subdirectories

| Directory    | What                                                                                 | When to read                                              |
| ------------ | ------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `xendit-va/` | Xendit FVA payment webhook sub-slice — `XenditVaPayload`, `normalizeXenditVaPayload`, POST route dispatching COMPLETED/EXPIRED/FAILED; mirrors invoice slice structure | Modifying PESONet VA webhook handling or adding VA-specific logic |
