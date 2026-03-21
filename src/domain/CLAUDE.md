# domain/

Domain kernel — shared business invariants for order processing and payment events.
Read `README.md` first for boundary rules and design decisions.

## Subdirectories

| Directory    | What                                                          | When to read                                          |
| ------------ | ------------------------------------------------------------- | ----------------------------------------------------- |
| `orders/`    | State machine, client validation schema, pricing logic        | Any slice that writes `Order.status` or creates orders |
| `payments/`  | PayMongo webhook event types                                  | Implementing payment webhook handlers                 |
