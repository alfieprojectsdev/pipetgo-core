# domain/

Domain kernel — shared business invariants for order processing and payment events.
Read `README.md` first for boundary rules and design decisions.

## Subdirectories

| Directory    | What                                                          | When to read                                          |
| ------------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| `orders/`    | State machine, client validation schema, pricing logic        | Any slice that writes `Order.status` or creates orders |
| `payments/`  | Payment event types and commission rate constant              | Implementing payment webhook handlers or Payout creation |
