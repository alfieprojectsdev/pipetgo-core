# dispute-resolution — Design Decisions

## Two-layer auth / TOCTOU (DL-006)

Every page and `resolveDispute` re-checks `session.user.role === 'ADMIN'` independently
of the layout guard. The layout guard is layer-1 only; a POST can arrive directly at the
action endpoint without navigating through any layout. This is the same dual-layer pattern
used in `kyc-review` and `accreditation-review`.

## Resolve in either direction (DL-004, DL-007)

`resolveDispute` accepts two resolution values:

- `RESOLVED_COMPLETED` — transitions `DISPUTED -> COMPLETED`; payout hold lifts
  automatically because `processSettlement` guards on current `Order.status`.
- `RESOLVED_REFUND` — transitions `DISPUTED -> REFUND_PENDING`; no refund is executed;
  refund execution requires Xendit refund integration scoped to a later ticket.

Both paths write the `OrderDispute` resolution audit record (`resolution`, `resolvedAt`,
`resolvedById`, `resolutionNote`) atomically inside the same `$transaction` as the
`Order.status` write. `resolutionNote` is the admin's optional rationale note.

## CAS write — updateMany + count === 0 (DL-005)

`resolveDispute` advances `Order.status` via:
```ts
tx.order.updateMany({ where: { id: orderId, status: OrderStatus.DISPUTED }, data: { status: targetStatus } })
```
`count === 0` means another admin already resolved the dispute — idempotent early-return
without overwriting the first decision. A bare `update` cannot detect a concurrent
resolution and would silently clobber whichever decision arrived second.

## Null dispute after explicit include throws (DL-003)

A `DISPUTED` order must have a related `OrderDispute` row (`orderId @unique`). A null
`dispute` after `include: { dispute: true }` is a referential-integrity violation, not a
missing-row scenario, so it throws rather than calling `notFound()`.

## Payout hold lift is automatic (DL-005)

No extra code lifts the payout hold. `processSettlement` excludes orders with
`status === DISPUTED` from its `findFirst` and `updateMany` predicates. When admin
resolves to `COMPLETED`, `Order.status` is no longer `DISPUTED` and the held `QUEUED`
payout becomes eligible for settlement on the next webhook delivery.

## Response-time SLA (documented, not code-enforced)

In line with ITA 2023 IDRM expectations, the platform commits to acknowledging a filed
dispute within **2 business days** and issuing an admin resolution within **15 business
days** of filing. Track via `OrderDispute.openedAt`/`resolvedAt` for later reporting.
Code-enforced SLA timers are not implemented.
