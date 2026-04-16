# dashboard/

Vertical slice serving `/dashboard/client` — CLIENT order listing, flat table,
newest-first.

## Auth and Ownership

`page.tsx` uses `auth()` to verify `session.user.role === 'CLIENT'`. If the
session is missing, `session.user.id` is falsy, or the role is not CLIENT, the
user is redirected to `/auth/signin`. (ref: DL-005)

No secondary ownership guard is needed. The Prisma query `where: { clientId:
session.user.id }` IS the ownership check — `Order.clientId` is set to the
authenticated user's id at order creation. The lab dashboard requires a
separate lab-ownership guard because `Lab.ownerId` is an indirect relationship;
the client dashboard does not.

## Query Strategy

A single `prisma.order.findMany({ where: { clientId: session.user.id }, include:
{ service: true }, orderBy: { createdAt: 'desc' } })` returns all orders for
the client. `Order.@@index([clientId])` in the schema makes this query
index-backed. (ref: DL-002)

A flat table is used instead of the Active/History/Incoming tab partition from
the lab dashboard — clients view their full history chronologically and have no
triage responsibility. Tab partitioning adds complexity without UX benefit.
(ref: DL-002)

All orders are returned without status filtering — clients need full history
to see completed lab results. (ref: DL-002)

No pagination is applied at MVP scale. `Order.@@index([clientId])` keeps the
query fast; pagination can be added later without structural changes. (ref: DL-002)

## DTO

`ClientDashboardOrderDTO` uses primitive types only. `createdAt` is mapped to
`.toISOString()` so Next.js can pass it across the RSC-to-client boundary
without a serialization crash on `Date` objects. `quotedPrice` is excluded —
the listing view does not display pricing, and Decimal fields also throw on RSC
serialization. (ref: DL-006)

`LabService.name` is non-nullable in the schema (line 153: `name String`), so
`serviceName` in the DTO never needs a fallback. `Order.serviceId` is a
non-nullable `String`, so `include: { service: true }` always returns a non-null
service relation — no null guard needed on `order.service.name`.

## Status Badge Config

`statusBadgeConfig` in `ui.tsx` is typed as `Record<OrderStatus, { label:
string; className: string }>`. The `OrderStatus` enum has 12 values; the record
enumerates all of them. Using `Record<OrderStatus, ...>` (not `Record<string,
...>`) means TypeScript emits a compile error if any enum member is missing —
caught by `npx tsc --noEmit` before deploy. A `??` fallback in the render loop
guards against unknown status values at runtime (e.g. a new enum value added
before the next deploy). Inline ternary chains were not used
because they become unreadable at 12 values and provide no compile-time
exhaustiveness guarantee. (ref: DL-003)

No shared Badge component is used. V2 has no Badge in `src/components/ui/`
(only in `_legacy_v1`). A shared component for a single consumer is premature
abstraction; inline span with Tailwind classes is sufficient. (ref: DL-004)

## Tests

No test files are included. V2 has no test framework configured; existing slices
have no test coverage. Tests require framework setup outside this slice's scope.
(ref: DL-007)

## App Router Mount

`src/app/dashboard/client/page.tsx` is a re-export only. All logic lives in
this slice per VSA boundary rules (ADR-001).
