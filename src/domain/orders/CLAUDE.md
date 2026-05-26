# orders/

Domain kernel for order business rules.

## Files

| File                | What                                                           | When to read                                                |
| ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| `state-machine.ts`  | `validStatusTransitions` map + `isValidStatusTransition()`     | Writing any action that mutates `Order.status`              |
| `client-details.ts` | `clientDetailsSchema` (Zod) + `ClientDetails` type; `SENSITIVE_SERVICE_CATEGORIES` record + `isSensitiveServiceCategory()` — compile-time enum-drift fence for RA 10173 sensitivity classification | Adding client contact fields; modifying RA 10173 consent validation; classifying a new `ServiceCategory` as sensitive or non-sensitive |
| `pricing.ts`        | `resolveOrderInitialState()` — maps `PricingMode` to initial order state | Creating orders; understanding FIXED vs QUOTE_REQUIRED flow |
