# payments/

Payment gateway HTTP clients. One file per provider.

## Files

| File | What | When to read |
| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `xendit.ts` | Xendit Invoice API client — `createXenditInvoice`, `XenditApiError` | Modifying Xendit integration or adding Xendit-specific params |
| `types.ts` | `NormalizedWebhookPayload` — provider-agnostic payload interface passed from route handlers to handlers | Adding fields to the normalized payload or changing the handler contract |
| `webhook-auth.ts` | Per-provider webhook auth verifiers — `verifyXenditToken` (live), `verifyPayMongoHmac`/`verifyHitPayHmac` (stubs) | Adding a new provider verifier or modifying Xendit token verification |
