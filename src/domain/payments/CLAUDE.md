# payments/

Domain event types and commission constants for payment processing.

## Files

| File            | What                                                           | When to read                                                      |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `events.ts`     | `PaymentCapturedEvent` and `PaymentFailedEvent` interface types | Implementing webhook handlers; dispatching payment events to feature slices |
| `commission.ts` | `COMMISSION_RATE` — global commission rate Decimal constant for AD-001 Direct Payment fee arithmetic | Implementing Payout creation or modifying commission rate |
