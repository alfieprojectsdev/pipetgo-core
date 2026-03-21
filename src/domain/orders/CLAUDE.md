# orders/

Domain kernel for order business rules.

## Files

| File                | What                                                           | When to read                                                |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `state-machine.ts`  | `validStatusTransitions` map + `isValidStatusTransition()`     | Writing any action that mutates `Order.status`              |
| `client-details.ts` | `clientDetailsSchema` (Zod) + `ClientDetails` type             | Adding client contact fields; validating at action boundary |
| `pricing.ts`        | `resolveOrderInitialState()` — maps `PricingMode` to initial order state | Creating orders; understanding FIXED vs QUOTE_REQUIRED flow |
