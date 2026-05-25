# payments/webhooks/xendit-va/

Xendit Fixed Virtual Account webhook sub-slice — authenticates PESONet bank transfer callbacks and dispatches to the shared handlers.

## Files

| File          | Contents (WHAT)                                                                                                   | Read When (WHEN)                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `types.ts`    | `XenditVaPayload` raw FVA callback body; `normalizeXenditVaPayload` adapter maps `callback_virtual_account_id` → `externalId`, sets `idempotencyKeyPrefix: 'xendit:va'` | Adding FVA payload fields, changing the two-ID mapping, or modifying idempotency key namespace |
| `route.ts`    | POST handler: `verifyXenditToken` auth (shared with invoice route); parse + normalize `XenditVaPayload`; dispatch COMPLETED → `processPaymentCapture`, EXPIRED/FAILED → `processPaymentFailed`, other → 200 no-op | Modifying VA webhook dispatch logic or auth |
| `__tests__/normalize.test.ts` | Unit tests for `normalizeXenditVaPayload` — field mapping, missing `callback_virtual_account_id` throw, `idempotencyKeyPrefix` value | Running or modifying VA normalizer tests |
| `__tests__/handlers.test.ts` | Integration tests using real test DB — COMPLETED capture, duplicate dedup, EXPIRED failure, orphan no-op | Running or modifying VA webhook integration tests |
