# payments/

Domain event types and commission constants for payment processing.

## Files

| File            | What                                                           | When to read                                                      |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `events.ts`     | Provider-agnostic domain event types — `PaymentCapturedEvent`, `PaymentFailedEvent`; consumed by webhook handlers and constructed inside per-provider routes after normalization | Changing the payment domain event contract |
| `commission.ts` | `COMMISSION_RATE` — global commission rate Decimal constant for AD-001 Direct Payment fee arithmetic | Implementing Payout creation or modifying commission rate |
