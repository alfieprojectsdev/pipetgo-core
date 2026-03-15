# PipetGo V2

Lab testing marketplace connecting clients with accredited labs. V2 is a ground-up
rewrite of the V1 MVP, driven by four structural failure modes identified in V1 that
cannot be fixed incrementally.

## Why V2 Exists

V1 analysis (`docs/architecture/STATE_OF_THE_SYSTEM_V1.md`) identified four compounding
failures that motivated the rewrite:

1. **Three incompatible `clientDetails` schemas** coexisted simultaneously across
   `validations/order.ts`, `orders/route.ts` (inline), and `types/index.ts`. The shared
   validation file existed but was never imported. V2 has one canonical Zod schema in
   `src/domain/orders/client-details.ts`; the ESLint boundary rule makes importing it
   the path of least resistance.

2. **Dead state machine enforcement**: `isValidStatusTransition()` was correctly defined
   in V1 but never called. Any route could transition an order to any status, bypassing
   the RFQ workflow. V2's `src/domain/orders/state-machine.ts` gives the function a
   canonical, bounded home. Every slice that writes `Order.status` must import it.

3. **Invisible pricing logic**: The QUOTE_REQUIRED / FIXED / HYBRID branching lived as
   a 32-line undocumented conditional inside a single route handler with no naming and no
   tests. V2 extracts this into `src/domain/orders/pricing.ts` where it is named,
   tested, and imported explicitly.

4. **`PENDING` with dual semantics**: The same `OrderStatus.PENDING` was reached by two
   structurally different paths — quote approval and FIXED-mode instant booking — with
   no distinguishing field. V2 resolves this by routing FIXED and HYBRID (no custom
   quote) orders directly to `PAYMENT_PENDING`, never to `PENDING`.

## Architecture

V2 uses Vertical Slice Architecture (VSA) for all feature delivery, with a minimal
Domain Kernel for shared invariants. See `docs/architecture/ADR-001-vertical-slice.md`
for the full decision record.

```
src/
├── features/           # Vertical slices — each slice owns action + schema + query + UI
│   ├── orders/
│   ├── services/
│   ├── payments/
│   ├── labs/
│   └── auth/
├── domain/             # Domain kernel — shared invariants only (target: <300 lines)
│   ├── orders/
│   │   ├── state-machine.ts    # OrderStatus transition map + isValidStatusTransition()
│   │   ├── client-details.ts   # Canonical clientDetailsSchema (Zod)
│   │   └── pricing.ts          # resolveOrderInitialState()
│   └── payments/
│       └── events.ts           # PaymentCapturedEvent, PaymentFailedEvent (types only)
├── app/                # Next.js App Router — thin routing shell only
├── components/         # Generic UI components (Button, Input, Card)
├── lib/                # Shared infrastructure (Prisma client, Auth config)
└── styles/             # Global CSS
```

### Domain Kernel Boundary

`src/domain/**` files must never import from `src/features/**`. Feature slices may
import from domain; the inverse is forbidden. This is enforced by the ESLint
`no-restricted-imports` rule in `eslint.config.js`.

The kernel is not a service layer. There are no abstract repository interfaces, DTO
mappers, or DI containers. It contains only the canonical type definitions and guard
functions that must be shared across multiple slices.

### PayMongo Webhook Pattern

A `payment.paid` event must atomically update `Transaction`, `Order`, `LabWallet`, and
optionally `Notification` — four domain objects across four feature slices. Rather than
a God Slice that imports from all four, the webhook handler dispatches typed
`PaymentCapturedEvent` / `PaymentFailedEvent` values (from `src/domain/payments/events.ts`)
to per-slice handlers, called sequentially inside a single `prisma.$transaction`. The
domain kernel defines the contract; the slices own the state transitions.

PayMongo signature verification requires reading the raw request body as text before
JSON parsing. Re-serializing a parsed body breaks the HMAC-SHA256 comparison.

## Stack

| Layer | Choice | Constraint |
|---|---|---|
| Framework | Next.js 14+ App Router | Server Actions replace explicit API routes for mutations |
| Language | TypeScript strict mode | `tsconfig.json` `strict: true` is non-negotiable |
| Database | PostgreSQL (Neon) + Prisma 5.x | Prisma 7 drops `url` from datasource; pinned at `^5.22.0` |
| Auth | NextAuth.js v5 (beta) | JWT strategy — no `Session` table in schema |
| Validation | Zod | Single source of truth; domain kernel schemas imported by all slices |
| Payments | PayMongo | HMAC-SHA256 webhook verification; raw body required |
| UI | Tailwind CSS + shadcn/ui | |

## Invariants

These rules are enforced by ESLint, TypeScript, or Prisma — or they must be enforced
by code review where tooling cannot reach:

- `src/domain/**` never imports from `src/features/**` (ESLint — `eslint.config.js`)
- Every slice action that writes `Order.status` must call `isValidStatusTransition()` before the Prisma update (code review)
- `clientDetailsSchema` in `src/domain/orders/client-details.ts` is the only Zod definition for client contact fields — no inline duplicates in slices (code review)
- `ClientProfile` persists client contact data as a normalized one-to-one row; slices validate through `clientDetailsSchema` at the action boundary, then write to `ClientProfile` (not `Order.clientDetails`)
- Domain kernel total line count must stay under 300 lines — review at each quarterly architecture session

## Setup

```bash
npm install
npx prisma generate
```

Set `DATABASE_URL` in `.env` to a real PostgreSQL connection string before running
migrations:

```bash
npx prisma migrate dev
```
