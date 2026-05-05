# payments/webhooks/

Xendit invoice webhook slice — authenticates callbacks and atomically captures payments.

## Index

| File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `route.ts`    | Next.js route handler; x-callback-token verification; status filtering                          | Modifying webhook auth or adding new Xendit event types       |
| `handlers.ts` | `processPaymentCapture` — Transaction CAPTURED update, Order fan-out, LabWallet credit (atomic) | Modifying payment capture logic or LabWallet crediting        |
| `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
| `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
| `__tests__/handlers.test.ts` | processPaymentCapture integration tests (tests 1-3) — real test database: wallet creation, balance increment, idempotency | Running or modifying integration tests for payment capture |
| `__tests__/handlers-rollback.test.ts` | processPaymentCapture rollback test (test 4) — full Prisma mock: wallet upsert failure error propagation | Running or modifying the rollback error propagation test |
