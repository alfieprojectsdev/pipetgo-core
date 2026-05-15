# payments/webhooks/

Xendit invoice webhook slice — authenticates callbacks and atomically captures payments.

## Index

| File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `route.ts`    | Next.js route handler; x-callback-token verification; exhaustive PAID/EXPIRED dispatch          | Modifying webhook auth or adding new Xendit event types       |
| `handlers.ts` | `processPaymentCapture` (PAID) — Transaction CAPTURED, Order fan-out, no LabWallet write (AD-001); `processPaymentFailed` (EXPIRED) — Transaction FAILED, Order PAYMENT_FAILED | Modifying payment capture or failure logic |
| `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
| `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
| `__tests__/handlers.test.ts` | processPaymentCapture (tests 1-4) and processPaymentFailed (tests 5-7) integration tests — real test database | Running or modifying payment handler integration tests |
| `__tests__/handlers-rollback.test.ts` | processPaymentCapture and processPaymentFailed rollback tests — full Prisma mock: error propagation | Running or modifying rollback error propagation tests |
