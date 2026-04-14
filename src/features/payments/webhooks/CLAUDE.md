# payments/webhooks/

Xendit invoice webhook slice — authenticates callbacks and atomically captures payments.

## Index

| File          | Contents (WHAT)                                                                                  | Read When (WHEN)                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `route.ts`    | Next.js route handler; x-callback-token verification; status filtering                          | Modifying webhook auth or adding new Xendit event types       |
| `handlers.ts` | `processPaymentCapture` — Transaction CAPTURED update, Order fan-out, LabWallet credit (atomic) | Modifying payment capture logic or LabWallet crediting        |
| `types.ts`    | `XenditInvoicePayload` — webhook request body shape                                              | Adding fields from Xendit payload or modifying type contracts |
| `README.md`   | Request flow, two-ID scheme, invariants, idempotency design                                      | Understanding capture lifecycle or debugging webhook behavior |
