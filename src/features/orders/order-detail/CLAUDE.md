# order-detail/

Vertical slice: CLIENT views a single order by ID. Read-only; no actions.

Route: `/dashboard/orders/[orderId]`
Auth:  CLIENT role only; redirects to `/auth/signin` otherwise.
Guard: Renders 404 for any order that does not belong to the authenticated client (prevents info leakage — caller cannot distinguish a missing order from one owned by another client).

## Files

| File       | What                                                                             | When to read                                                         |
| ---------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `page.tsx` | Async RSC — CLIENT auth guard, ownership guard, Decimal/Date DTO, full render   | Modifying auth gate, order fetch, DTO fields, badge map, or timeline |

No `ui.tsx` — page is a pure RSC with no client components (no state, no forms, no event handlers). No `action.ts` — T-06 is read-only; T-07 adds quote actions, T-08 adds payment retry.

## Invariants

- `statusBadgeConfig` is typed `Record<OrderStatus, ...>` — a missing enum value is a compile error at build time. The `??` fallback on the badge lookup is intentional deploy-safety (guards the window between a DB migration and Prisma client regeneration); do not remove it.
- `OrderDetailDTO` fields are all primitive types (string, number, null). No `Prisma.Decimal` or `Date` crosses the RSC boundary.
- `order.quotedPrice` serialized as `Decimal.toFixed(2)` or `null`. Null means no quote set yet; UI renders "Not yet quoted".
- `statusBadgeConfig` is intentionally duplicated from `clients/dashboard/ui.tsx`. Cross-slice import is an ADR-001 violation; both slices own their copy.
- `getTimelineSteps()` is a pure function — no hooks, no React imports beyond JSX, safe in RSC.
- `clientProfile` null does not trigger `notFound()` — unlike lab-fulfillment and checkout, a client must be able to view their order at any status even if the profile snapshot is absent.
