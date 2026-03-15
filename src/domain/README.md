# src/domain

Domain kernel for PipetGo V2. Contains shared business logic that has no natural
home in any single feature slice. (ref: ADR-001)

## Invariant

Files under `src/domain/` MUST NOT import from `src/features/**`. This is enforced
by the ESLint `no-restricted-imports` rule in `eslint.config.js`. Feature slices
may import from domain; the inverse is forbidden. (ref: DL-012)

## Contents

```
src/domain/
  orders/
    state-machine.ts   -- OrderStatus transition map and isValidStatusTransition()
    client-details.ts  -- Zod schema for client contact data (action boundary validation)
    pricing.ts         -- resolveOrderInitialState() maps PricingMode to initial OrderStatus
  payments/
    events.ts          -- PaymentCapturedEvent and PaymentFailedEvent types
```

## Design decisions

**Why a domain kernel at all?**
Pure VSA (no shared domain) leaves the state machine without a slice home, would allow
clientDetails schemas to diverge across slices, and makes the webhook handler a God
Slice. (ref: RA-001)

**ClientProfile vs clientDetails Json**
`client-details.ts` (Zod schema) validates at the Server Action boundary.
`ClientProfile` (Prisma model) persists the normalized record. The Zod schema is the single source of truth for client contact shape. (ref: DL-002)

**PAYMENT_PENDING semantics**
`resolveOrderInitialState()` in `pricing.ts` returns `PAYMENT_PENDING` for FIXED-mode
and HYBRID (no custom quote) orders, not `PENDING`. This resolves the ADR-001
documented PENDING dual-semantics. (ref: DL-009)

**Payment events subdomain**
`payments/events.ts` is owned by the payments subdomain (not orders) because these
events originate from PayMongo webhooks, not from state machine transitions. (ref: DL-011)

## Webhook signature verification

PayMongo uses HMAC-SHA256. The raw request body MUST be read as text before JSON
parsing. If the framework parses JSON first and re-serializes, the signature
comparison will fail. Webhook route handlers must buffer the raw body before
dispatching to feature slice handlers.

## Size budget

ADR-001 constrains the domain kernel to under 300 lines total across all files.
Estimated distribution: state-machine ~40 lines, client-details ~15 lines,
pricing ~30 lines, events ~15 lines. (ref: RISK-004)
