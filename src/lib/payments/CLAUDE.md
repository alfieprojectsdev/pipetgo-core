# payments/

Payment gateway HTTP clients and provider-agnostic types. One file per provider.

## Files

| File | What | When to read |
| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `xendit.ts` | Xendit Invoice API client — `createXenditInvoice`, `XenditApiError` | Modifying invoice flow or adding Xendit-specific params |
| `xendit-va.ts` | Xendit Fixed Virtual Account API client — `createXenditVa`, `XenditVaError`, `XenditVaParams`, `XenditVaResult`; POSTs to `/fixed-virtual-accounts` with `is_closed: true` and `expected_amount` | Modifying PESONet VA creation or handling Xendit FVA errors |
| `types.ts` | `NormalizedWebhookPayload` — provider-agnostic payload interface with `externalId`, `paymentMethod`, `idempotencyKeyPrefix?`, `failureReason?`; passed from every route handler to `handlers.ts` | Adding fields to the normalized payload or changing the handler contract |
| `webhook-auth.ts` | Per-provider webhook auth verifiers — `verifyXenditToken` (live, shared by invoice and VA routes), `verifyPayMongoHmac`/`verifyHitPayHmac` (stubs) | Adding a new provider verifier or modifying Xendit token verification |
