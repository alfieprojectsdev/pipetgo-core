# payments/

Domain event types for PayMongo webhook-driven payment transitions.

## Files

| File        | What                                                           | When to read                                                      |
| ----------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `events.ts` | `PaymentCapturedEvent` and `PaymentFailedEvent` interface types | Implementing webhook handlers; dispatching payment events to feature slices |
