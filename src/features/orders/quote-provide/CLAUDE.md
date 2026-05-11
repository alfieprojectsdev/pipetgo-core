# quote-provide/

Vertical slice: LAB_ADMIN views a QUOTE_REQUESTED order and provides a price quote.

Route: /dashboard/lab/orders/[orderId] (via status dispatch — see app/dashboard/lab/orders/[orderId]/page.tsx)
Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
Guard: notFound() for ownership mismatch. notFound() for any status other than QUOTE_REQUESTED.

## Files

| File        | What                                                                              | When to read                                              |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `page.tsx`  | Async RSC — LAB_ADMIN auth, ownership guard, status guard, DTO, renders UI       | Modifying auth gate, order fetch, or QuoteOrderDTO        |
| `ui.tsx`    | `'use client'` — price input form (provideQuote), cancel form (cancelOrder)      | Modifying form layout or error display                    |
| `action.ts` | `provideQuote` (QUOTE_REQUESTED→QUOTE_PROVIDED), `cancelOrder` (→CANCELLED)     | Modifying quote write or cancellation                     |

## Invariants

- `QuoteOrderDTO` contains no `Prisma.Decimal` or `Date` — all fields are primitives.
- `quotedPrice` is absent from the DTO (order has no price yet at QUOTE_REQUESTED).
- `provideQuote` sets both `quotedPrice` (Prisma.Decimal) and `quotedAt` (new Date()) atomically.
- Price validation uses `Number()` not `parseFloat` — `parseFloat('1.5abc')` returns 1.5 and passes isFinite; `Number('1.5abc')` is NaN and correctly rejects partial strings.
- Status guard (`order.status !== QUOTE_REQUESTED → notFound()`) is intentionally redundant with the dispatch page — defense-in-depth per DL-007.
