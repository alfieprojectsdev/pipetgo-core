# payouts/

Xendit commission settlement webhook slice. Receives Xendit sub-account split settlement
callbacks and atomically transitions Payout QUEUED -> COMPLETED, moving Payout.platformFee
from LabWallet.pendingBalance to availableBalance.

Handler is dormant until checkout is migrated to Xendit Managed Sub-Account invoices. (ref: DL-012)

## Files

| File | What | When to read |
| ---- | ---- | ------------ |
| `route.ts` | Next.js POST; x-callback-token via timingSafeEqual against XENDIT_SETTLEMENT_WEBHOOK_TOKEN; COMPLETED dispatches to processSettlement | Modifying webhook auth or adding settlement statuses |
| `handlers.ts` | `processSettlement` — Payout QUEUED -> COMPLETED; LabWallet pendingBalance decrement + availableBalance increment in one $transaction | Modifying settlement logic or balance invariants |
| `types.ts` | `XenditSettlementPayload` — provisional field shape; all fields marked TODO(sandbox-verify) | Adding fields from Xendit payload |
| `README.md` | Request flow, AD-001 framing, two-ID scheme, idempotency design, invariants, production wiring | Understanding settlement lifecycle or debugging |
| `__tests__/handlers.test.ts` | Real-DB integration: first delivery, idempotent duplicate, orphan tolerance, negative-balance guard, PROCESSING contract violation | Running or modifying settlement integration tests |
| `__tests__/handlers-rollback.test.ts` | Full-mock rollback error propagation: walletUpdate failure, payoutUpdate failure | Running or modifying rollback tests |
