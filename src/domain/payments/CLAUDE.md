# payments/

Domain event types, commission constants, and PESONet business rules.

## Files

| File            | What                                                           | When to read                                                      |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `events.ts`     | Provider-agnostic domain event types — `PaymentCapturedEvent`, `PaymentFailedEvent`; consumed by webhook handlers and constructed inside per-provider routes after normalization | Changing the payment domain event contract |
| `commission.ts` | `COMMISSION_RATE` — global commission rate Decimal constant for AD-001 Direct Payment fee arithmetic | Implementing Payout creation or modifying commission rate |
| `pesonet.ts`    | `PESONET_MIN_AMOUNT` (PHP 50,000 floor), `PESONET_BANK_CODES` allowlist, `PesonetBankCode` type, `isPesonetBankCode` type guard, `PESONET_BANK_LABELS` display map — server-side business rules imported by both checkout action and order-detail page | Adding PESONet banks, changing the VA threshold, or validating bank codes |
