# dispute — Design Decisions

## Dispute & Redress (ITA 2023 IDRM)

A CLIENT may dispute a COMPLETED order within `DISPUTE_WINDOW_DAYS` (14 days from
`Order.completedAt`). An ADMIN resolves each dispute in either direction
(`RESOLVED_COMPLETED` or `RESOLVED_REFUND`); the lab payout is held while the dispute
is open.

**Response-time SLA (documented, not code-enforced):** In line with ITA 2023 internal
dispute & redress expectations, the platform commits to acknowledging a filed dispute
within **2 business days** and issuing an admin resolution within **15 business days**
of filing. This SLA is operational policy only — code-enforced SLA timers are not
implemented. Track it via the `OrderDispute.openedAt`/`resolvedAt` timestamps for later
reporting.

**Legacy orders:** Orders that reached COMPLETED before `Order.completedAt` existed carry
`completedAt = null`. The dispute action treats a null `completedAt` as out-of-window and
rejects the dispute with an explicit error rather than crashing or silently bypassing the
window. No historical backfill is performed; see DL-010.

## completedAt anchor — not updatedAt (DL-001)

The 14-day window is keyed on `Order.completedAt`, a dedicated nullable field written
once inside the `IN_PROGRESS -> COMPLETED` `$transaction` and never mutated thereafter.
`Order.updatedAt` was rejected because it mutates on every subsequent write (notes edits,
payout writes, status changes), so a window anchored there would silently extend or
corrupt itself after completion.

## Domain-layer window constant (DL-002)

`DISPUTE_WINDOW_DAYS = 14` and `isWithinDisputeWindow` live in
`src/domain/orders/dispute.ts`, mirroring the commission-rate style of
`src/domain/payments/commission.ts`. A value inlined in the action would duplicate a
business rule across call sites and hide it from the domain layer. An expired-window
dispute attempt returns an explicit error — a silent no-op would leave the client
believing the dispute was filed.

## OrderDispute model — not a column on Order (DL-003)

ITA 2023 redress requires an auditable who-resolved-what-when trail. A single `reason`
column on `Order` cannot record resolver identity, resolution direction, timestamps, or
admin note. The separate `OrderDispute` model has `orderId @unique`, enforcing
one-dispute-per-order at the DB level and capturing the full audit record.
`resolvedById` uses a named User relation so the back-reference does not collide with
`Order.clientId`.

## Exactly 3 new state-machine edges (DL-004)

`isValidStatusTransition()` is the single enforcement point. Authorized new edges:
`COMPLETED -> DISPUTED`, `DISPUTED -> COMPLETED`, `DISPUTED -> REFUND_PENDING`. There is
no `DISPUTED -> CANCELLED` edge; it would create a refund-bypass path with no regulatory
basis.

## Ownership guard mirrors acceptQuote (DL-006)

`openDispute` enforces `order.clientId === session.user.id` inside the `$transaction`,
the same pattern as `acceptQuote`/`rejectQuote`. The page-level auth guard is layer-1; the
action re-check is layer-2 (TOCTOU — a POST can arrive without navigating through the
page layout).

## Two-layer auth / TOCTOU (DL-006)

Every page performs an `auth()` call and checks `session.user.role === 'CLIENT'` before
data access. `openDispute` re-checks ownership inside the `$transaction` at execution time.
The layout guard is layer-1 only and does not protect Server Actions.
