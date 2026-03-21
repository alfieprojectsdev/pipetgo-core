# ADR-001: Vertical Slice Architecture with Minimal Domain Kernel

| Field | Value |
|-------|-------|
| **ID** | ADR-001 |
| **Date** | 2026-03-13 |
| **Status** | Accepted |
| **Deciders** | Engineering Lead |
| **Supersedes** | N/A (first V2 architecture decision) |

---

## Context

PipetGo V2 is a ground-up rewrite of the V1 MVP (`pipetgo-mvp`). The rewrite was triggered by a systematic analysis of V1's architectural debt (`docs/STATE_OF_THE_SYSTEM_V1.md`), which identified several compounding structural failures:

1. **Three incompatible `clientDetails` schemas** coexisted simultaneously: `validations/order.ts:clientDetailsSchema`, `orders/route.ts` (inline), and `types/index.ts:ClientDetails`. All three described the same domain concept with different field names and shapes. The shared validation file existed; it was simply never imported.

2. **Dead state machine enforcement**: `isValidStatusTransition()` was defined in `validations/order.ts:120` and was correct, but was never called by any route handler. The `PATCH /api/orders/[id]` route allowed a LAB_ADMIN to transition an order directly to `COMPLETED` from any status, bypassing the entire RFQ workflow.

3. **Pricing logic as invisible knowledge**: All pricing-mode decision logic (QUOTE_REQUIRED / FIXED / HYBRID branching) lived as a 32-line undocumented conditional block inside a single route handler, with no extraction, no naming, and no tests at the domain level.

4. **`PENDING` with dual semantics**: The same `OrderStatus.PENDING` value was reached by two structurally different paths — (a) client approving a lab quote, and (b) FIXED-mode instant booking with `quotedPrice` auto-set from `service.pricePerUnit` — with no field distinguishing which path was taken.

The V2 architecture must prevent recurrence of all four failure modes.

---

## Decision

**We will use Vertical Slice Architecture (VSA) for all feature delivery, with a minimal, explicitly bounded Domain Kernel for shared invariants.**

### Feature Delivery — VSA

All new features are implemented as self-contained slices under `src/features/`. Each slice owns its own Server Action (or API route), Zod validation schema, Prisma query, and React components.

```
src/features/
├── orders/
│   ├── create-order/
│   │   ├── action.ts          # Server Action
│   │   ├── schema.ts          # Zod schema (imports from domain kernel)
│   │   ├── query.ts           # Prisma query
│   │   └── CreateOrderForm.tsx
│   ├── approve-quote/
│   │   ├── action.ts
│   │   ├── schema.ts
│   │   └── query.ts
│   ├── provide-quote/
│   ├── reject-quote/
│   ├── patch-order-status/
│   └── request-custom-quote/
├── services/
│   ├── list-services/
│   └── get-service/
├── payments/
│   ├── initiate-payment/
│   └── webhook/               # See Domain Kernel section for fan-out strategy
├── labs/
│   └── ...
└── auth/
    └── ...
```

### Shared Infrastructure — Minimal Domain Kernel

A small, explicitly bounded `src/domain/` directory contains **only** the canonical definitions of shared invariants. It has no business logic beyond what is necessary to enforce these invariants. It imports from Prisma types and Zod, never from any feature slice.

```
src/domain/
├── orders/
│   ├── state-machine.ts       # validStatusTransitions map + isValidStatusTransition()
│   ├── client-details.ts      # ONE canonical clientDetailsSchema (Zod)
│   └── pricing.ts             # resolveOrderInitialState(service, requestCustomQuote)
└── payments/
    └── events.ts              # PaymentCapturedEvent, PaymentFailedEvent (types only)
```

**Estimated size: ~125–150 lines total.** This is not a domain service layer. There are no abstract repository interfaces, no DTO mappers, and no dependency injection containers.

### Enforcement Rule

One ESLint rule enforces the kernel boundary:

```jsonc
// eslint.config.js — applied ONLY within src/domain/
{
  "rules": {
    "no-restricted-imports": ["error", {
      "patterns": ["@/features/*"],
      "message": "Domain kernel must not import from feature slices."
    }]
  }
}
```

Feature slices may import from `src/domain/`. The domain kernel may never import from feature slices.

---

## Rationale

### Why VSA (and not pure technical layering)

Next.js App Router and Server Actions co-locate data-fetching with the component tree by design. The V1 codebase already approximated VSA (route handlers in `app/api/`, not in a separate `services/` directory), but without the discipline of explicit slice ownership. VSA formalizes what V1 was already doing implicitly, adds ownership clarity, and removes the cross-directory distance that caused import discipline failures.

Technical layering (Controllers → Services → Repositories) in a Next.js App Router application creates friction without proportional benefit for a small team: Server Actions are effectively controllers, and adding a mandatory Service layer between them and Prisma doubles the call depth for no isolation gain when the team is too small to benefit from independent layer testing.

### Why NOT pure VSA (the case for the Domain Kernel)

The decision-critic analysis identified three specific failure modes that pure VSA cannot address:

**1. The state machine has no slice home.**
`isValidStatusTransition()` must be callable from five different slices (`create-order`, `provide-quote`, `approve-quote`, `patch-order-status`, `request-custom-quote`). Pure VSA gives this no designed home. In practice it ends up in an organic `src/lib/` folder — exactly what happened in V1, exactly why it never got called. The domain kernel gives it a canonical, bounded home that every order-touching slice imports explicitly.

**2. `clientDetails` will diverge again without a canonical definition.**
V1 analysis confirmed the root cause of the three-schema divergence was not folder distance but absent import discipline. VSA co-location does not prevent a second developer writing an inline schema in a different slice. The canonical Zod schema in `src/domain/orders/client-details.ts` is the single definition; the ESLint rule makes importing it the path of least resistance.

**3. The PayMongo webhook is a horizontal cross-cutter.**
A `payment.paid` event must atomically update `Transaction`, `Order`, `LabWallet`, and optionally `Notification` — four domain objects across four feature slices. A webhook handler that imports from all four slices is not a vertical slice; it is a God Slice that couples the entire domain through the payments feature. The domain kernel's `PaymentCapturedEvent` interface (in `src/domain/payments/events.ts`) allows the webhook handler to dispatch a typed event, and each affected feature slice exports a handler for it. The webhook handler calls these handlers directly and sequentially within a Prisma transaction — no event bus required, no God Slice, coupling is explicit and unidirectional.

### Why NOT Hexagonal Architecture

Full Hexagonal Architecture (ports & adapters) requires: abstract repository interfaces (e.g., `IOrderRepository`), concrete adapter implementations (e.g., `PrismaOrderRepository implements IOrderRepository`), DTO mapping layers between domain objects and Prisma models, and a dependency injection mechanism to wire adapters to ports.

For a two-to-three person team with a near-term PayMongo integration deadline, this overhead is real and front-loaded. The key benefit of Hexagonal — swapping infrastructure implementations without touching domain logic — is irrelevant when there is one database, one payment provider, and one framework. The minimal domain kernel captures the actual benefits (canonical types, enforced invariants) without the ceremony.

---

## Consequences

### Positive

- **V1 failure modes are structurally prevented**: Three incompatible schemas cannot coexist because there is one canonical Zod definition in the kernel, and the ESLint rule makes importing it the default. The state machine function has a home and a clear ownership story.
- **PayMongo webhook lands cleanly on Day 1**: The event type interfaces in `src/domain/payments/events.ts` define the contract up front. The webhook handler dispatches; slices handle. No refactoring required when wallet and notification slices are added later.
- **Feature delivery velocity is preserved**: No mandatory service layer, no DTO mappers. A new feature slice is `action.ts + schema.ts + query.ts`. The domain kernel adds one import per action, not an entire boilerplate ceremony.
- **State machine is testable in isolation**: `src/domain/orders/state-machine.ts` is pure TypeScript with no framework dependency. `isValidStatusTransition()` can be unit tested exhaustively in 20 lines. Every feature slice's action calls it before writing `Order.status`.

### Negative / Accepted Risks

- **The kernel boundary requires active maintenance.** If the kernel grows beyond its defined scope (state machine, canonical types, payment event interfaces), it will become V1's `lib/` dumping ground under a different name. The ESLint rule prevents slices from entering the kernel, but it does not prevent the kernel itself from growing. An explicit size budget (target: under 300 lines total) should be reviewed at each quarterly architecture review.
- **Inter-slice calls within the payment webhook require explicit documentation.** The pattern of "webhook handler calls `handlePaymentCaptured()` from the orders slice" is non-obvious and must be documented in each affected slice's README. Without this, future developers will write a God Slice instead.
- **PENDING's dual semantics are resolved in `pricing.ts` but remain in the schema.** The `OrderStatus.PENDING` enum value still represents two different paths (quote-approved and FIXED auto-price). V2 will NOT add a new status for this distinction (scope: V2.1 or later). The `resolveOrderInitialState()` function in the domain kernel documents this explicitly. Any query that needs to distinguish the two paths must examine `quotedAt` and the related service's `pricingMode`.

---

## Alternatives Considered

### Alternative A: Pure Vertical Slice Architecture (no domain kernel)

**Rejected.** The state machine has no slice home and will inevitably drift back to V1's dead-function pattern. The PayMongo webhook becomes a God Slice. This was the original proposal; the decision-critic analysis surfaced the failure modes.

### Alternative B: Full Hexagonal Architecture (ports & adapters)

**Rejected.** Front-loaded boilerplate (abstract repository interfaces, DTO mappers, DI container) has no proportional benefit for a team of this size with one database and one payment provider. The key Hexagonal benefit (infrastructure swap without domain changes) does not apply to this context.

### Alternative C: Layered Architecture (Controller → Service → Repository)

**Rejected.** Creates mandatory indirection for every Prisma query. In Next.js App Router, Server Actions already serve the controller role. A mandatory Service layer between Server Actions and Prisma adds call depth without adding isolation that the team can exploit at current scale.

### Alternative D: VSA + Minimal Domain Kernel (this decision)

**Accepted.** VSA for feature delivery preserves velocity. The 125-line domain kernel prevents the specific failure modes identified in V1 analysis. The ESLint boundary rule prevents kernel pollution without requiring architectural ceremony.

---

## Implementation Notes

### Day-1 Domain Kernel Contents (non-negotiable)

```typescript
// src/domain/orders/state-machine.ts
// Migrated verbatim from V1's validations/order.ts:100-125
// MUST be imported and called by every slice that writes Order.status

export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
  QUOTE_REQUESTED: ['QUOTE_PROVIDED', 'CANCELLED'],
  QUOTE_PROVIDED:  ['QUOTE_REJECTED', 'PENDING', 'CANCELLED'],
  QUOTE_REJECTED:  ['QUOTE_REQUESTED'],
  PENDING:         ['ACKNOWLEDGED', 'CANCELLED'],
  ACKNOWLEDGED:    ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS:     ['COMPLETED', 'CANCELLED'],
  COMPLETED:       [],
  CANCELLED:       []
}

export function isValidStatusTransition(
  from: OrderStatus,
  to: OrderStatus
): boolean {
  return validStatusTransitions[from].includes(to)
}
```

```typescript
// src/domain/orders/client-details.ts
// THE canonical definition. All feature slices import from here.
// Resolves V1's three-schema conflict.

export const clientDetailsSchema = z.object({
  name:         z.string().min(2).max(100).trim(),
  email:        z.string().email().toLowerCase().trim(),
  phone:        z.string().min(10).max(20).regex(/^[0-9\s\-\+\(\)]+$/),
  organization: z.string().max(200).optional(),
  address:      z.string().max(500).optional()
})

export type ClientDetails = z.infer<typeof clientDetailsSchema>
```

```typescript
// src/domain/orders/pricing.ts
// Extracted from V1's orders/route.ts:47-83.
// Naming this function makes the business rule visible and testable.

export function resolveOrderInitialState(
  service: Pick<LabService, 'pricingMode' | 'pricePerUnit'>,
  requestCustomQuote: boolean | undefined
): { status: 'QUOTE_REQUESTED' | 'PAYMENT_PENDING'; quotedPrice: Decimal | null; quotedAt: Date | null } {
  if (service.pricingMode === 'QUOTE_REQUIRED') {
    return { status: 'QUOTE_REQUESTED', quotedPrice: null, quotedAt: null }
  }
  if (service.pricingMode === 'FIXED') {
    // NOTE: FIXED mode is an implicit pre-approved quote. The lab's pricePerUnit
    // becomes the quotedPrice without client approval action. This is intentional
    // backward-compatibility behavior. quotedAt is set to order creation time.
    return { status: 'PAYMENT_PENDING', quotedPrice: service.pricePerUnit, quotedAt: new Date() }
  }
  if (service.pricingMode === 'HYBRID') {
    if (requestCustomQuote === true) {
      return { status: 'QUOTE_REQUESTED', quotedPrice: null, quotedAt: null }
    }
    // NOTE: undefined (omitted) falls through to instant-booking, same as false.
    // This is intentional: opt-in to custom quote is explicit; default is fixed-price booking.
    return { status: 'PAYMENT_PENDING', quotedPrice: service.pricePerUnit, quotedAt: new Date() }
  }
  // Safety fallback: unknown pricing mode defaults to quote-required
  return { status: 'QUOTE_REQUESTED', quotedPrice: null, quotedAt: null }
}
```

```typescript
// src/domain/payments/events.ts
// Typed event interfaces for PayMongo/Xendit webhook fan-out.
// The webhook handler dispatches these; feature slices handle them.

export interface PaymentCapturedEvent {
  orderId:           string
  transactionId:     string
  amount:            Decimal
  gatewayRef:        string
  capturedAt:        Date
}

export interface PaymentFailedEvent {
  orderId:           string
  transactionId:     string
  failureReason:     string
  failedAt:          Date
}
```

### Required Slice Pattern for Order Status Writes

**Applies to status mutations on existing orders.** Initial order creation is exempt — there is no prior status to transition from; `resolveOrderInitialState()` serves as the domain gate for the initial status (see `src/domain/orders/pricing.ts`).

Every feature slice action that **mutates** `Order.status` on an existing order MUST follow this pattern:

```typescript
// src/features/orders/patch-order-status/action.ts — example
import { isValidStatusTransition } from '@/domain/orders/state-machine'

// ... fetch order ...

if (!isValidStatusTransition(order.status, validatedData.status)) {
  return { error: `Cannot transition from ${order.status} to ${validatedData.status}` }
}

// ... proceed with update ...
```

This is enforced by code review, not by tooling. The state machine import should be visible in every PR that touches order status.

### PayMongo Webhook Pattern

```typescript
// src/features/payments/webhook/route.ts
import { verifyPayMongoSignature } from '@/lib/paymongo'   // infrastructure
import { PaymentCapturedEvent } from '@/domain/payments/events'
import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'
import { creditLabWallet } from '@/features/wallets/credit-wallet/handler'

export async function POST(req: Request) {
  // 1. Verify HMAC-SHA256 signature (timing-safe)
  // 2. Parse event type
  // 3. Dispatch to feature slice handlers within a single Prisma transaction
  await prisma.$transaction(async (tx) => {
    await handlePaymentCaptured(event, tx)   // advances Order.status
    await creditLabWallet(event, tx)          // credits LabWallet
  })
}
```

The webhook handler imports from feature slices (allowed). Feature slice handlers do not import from each other (enforced). The domain kernel events.ts provides the shared type contract.

---

## Review Schedule

This ADR should be revisited at the following milestones:

| Milestone | Review trigger |
|-----------|---------------|
| PayMongo integration complete | Validate that the webhook pattern held; check for God Slice emergence |
| 10+ feature slices exist | Check domain kernel size against 300-line budget |
| Second developer onboarded | Verify slice discipline held without original author present |
| V2.1 planning | Reassess PENDING dual-semantics — add `OrderOrigin` enum if needed |
