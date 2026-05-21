# payouts/

Xendit commission settlement webhook slice — dormant until checkout migrates to sub-account invoices (ref: DL-012); transitions Payout QUEUED→COMPLETED and moves `platformFee` between wallet balances.

## Files

| File | Contents (WHAT) | Read When (WHEN) |
| ---- | --------------- | ---------------- |
| `route.ts` | Next.js POST; x-callback-token via timingSafeEqual against XENDIT_SETTLEMENT_WEBHOOK_TOKEN; COMPLETED dispatches to processSettlement | Modifying webhook auth or adding settlement statuses |
| `handlers.ts` | `processSettlement` — three-layer idempotency (IdempotencyKey table + COMPLETED early-return + updateMany CAS); Payout QUEUED -> COMPLETED; LabWallet pendingBalance decrement + availableBalance increment in one $transaction | Modifying settlement logic, idempotency behavior, or balance invariants |
| `types.ts` | `XenditSettlementPayload` — provisional field shape; all fields marked TODO(sandbox-verify) | Adding fields from Xendit payload |
| `README.md` | Request flow, AD-001 framing, two-ID scheme, three-layer idempotency design, invariants, production wiring | Understanding settlement lifecycle or debugging |
| `__tests__/handlers.test.ts` | Real-DB integration: first delivery, idempotent duplicate (COMPLETED early-return), IdempotencyKey dedup (Layer 1 early-return), IdempotencyKey creation atomicity, orphan tolerance, negative-balance guard, PROCESSING contract violation | Running or modifying settlement integration tests |
| `__tests__/handlers-rollback.test.ts` | Full-mock rollback: walletUpdate failure, payoutUpdateMany failure, idempotencyKey.create failure | Running or modifying rollback error propagation tests |
