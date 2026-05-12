# order-detail/

Vertical slice: CLIENT views a single order by ID. Read-only; no actions.

Route: `/dashboard/orders/[orderId]`
Auth:  CLIENT role only; redirects to `/auth/signin` otherwise.
Guard: Renders 404 for any order that does not belong to the authenticated client (prevents info leakage — caller cannot distinguish a missing order from one owned by another client).

## Files

| File        | What                                                                             | When to read                                                         |
| ----------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `page.tsx`  | Async RSC — CLIENT auth guard, ownership guard, Decimal/Date DTO, full render   | Modifying auth gate, order fetch, DTO fields, badge map, or timeline |
| `ui.tsx`    | `'use client'` — `OrderDetailQuoteActions` (Accept/Reject, QUOTE_PROVIDED), `OrderDetailRetryPayment` (Retry Payment, PAYMENT_FAILED) | Modifying action panel layout or error display |
| `action.ts` | `acceptQuote` (QUOTE_PROVIDED→PAYMENT_PENDING, redirect to checkout), `rejectQuote` (→QUOTE_REJECTED), `retryPayment` (PAYMENT_FAILED→PAYMENT_PENDING, redirect to checkout) | Modifying accept/reject/retry transitions |

## Invariants

- `statusBadgeConfig` is typed `Record<OrderStatus, ...>` — a missing enum value is a compile error at build time. The `??` fallback on the badge lookup is intentional deploy-safety (guards the window between a DB migration and Prisma client regeneration); do not remove it.
- `OrderDetailDTO` fields are all primitive types (string, number, null). No `Prisma.Decimal` or `Date` crosses the RSC boundary.
- `order.quotedPrice` serialized as `Decimal.toFixed(2)` or `null`. Null means no quote set yet; UI renders "Not yet quoted".
- `statusBadgeConfig` is intentionally duplicated from `clients/dashboard/ui.tsx`. Cross-slice import is an ADR-001 violation; both slices own their copy.
- `getTimelineSteps()` is a pure function — no hooks, no React imports beyond JSX, safe in RSC.
- `clientProfile` null does not trigger `notFound()` — unlike lab-fulfillment and checkout, a client must be able to view their order at any status even if the profile snapshot is absent.
- `acceptQuote` writes a single `PAYMENT_PENDING` update via the direct `QUOTE_PROVIDED→PAYMENT_PENDING` edge added to the state machine in T-07. It does NOT pass through `PENDING` — that is a FIXED-mode path.
- `rejectQuote` is terminal for T-07. The `QUOTE_REJECTED→QUOTE_REQUESTED` re-request loop is T-09.
- Client quote actions are inline (not a separate slice) because `QUOTE_PROVIDED` renders the same order summary as all other statuses plus an action panel — a dispatcher would require duplicating the base rendering or an ADR-001-violating cross-slice import.
- `OrderDetailQuoteActions` is only rendered when `dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null`. Both checks are intentional: the status check is the logic gate; the null check is deploy-safety.
- `retryPayment` does not create a Xendit invoice — it only transitions PAYMENT_FAILED→PAYMENT_PENDING and redirects to the checkout page; `initiateCheckout` creates the fresh invoice when the client clicks Pay.
- `retryPayment` redirect target is `/dashboard/orders/${orderId}/pay` — the canonical checkout route mounted at `src/app/dashboard/orders/[orderId]/pay/page.tsx`.
- `acceptQuote` redirect target is `/dashboard/orders/${orderId}/pay` (same canonical checkout route). The historical `/checkout/${orderId}` target had no app router mount.
- `OrderDetailRetryPayment` is only rendered when `dto.status === 'PAYMENT_FAILED'`.
