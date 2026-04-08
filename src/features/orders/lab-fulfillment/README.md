# lab-fulfillment

## Overview

Lab fulfillment slice. A LAB_ADMIN who owns an order visits
`/dashboard/lab/orders/[orderId]`, views order details, and advances the order
through two status transitions:

- ACKNOWLEDGED -> IN_PROGRESS (Start Processing)
- IN_PROGRESS  -> COMPLETED   (Complete Order, with result notes)

Both transitions are gated by `isValidStatusTransition()` from the domain
state machine. File uploads are out of scope; result notes are stored as plain
text in `Order.notes`.

## Architecture

```
page.tsx (RSC)
  -> auth() — LAB_ADMIN only; redirect /auth/signin otherwise (DL-001)
  -> prisma.order (include lab, service, clientProfile)
  -> guard: lab.ownerId === session.user.id (ownership) (DL-004)
  -> guard: status === ACKNOWLEDGED or IN_PROGRESS
  -> LabOrderDTO (Decimal -> .toFixed(2), Date -> .toISOString())
  -> <LabFulfillmentUI order={dto} />  (ui.tsx)
       -> status === 'ACKNOWLEDGED': <StartProcessingForm />
            -> useActionState(startProcessing)
       -> status === 'IN_PROGRESS':  <CompleteOrderForm />
            -> useActionState(completeOrder)

action.ts (Server Actions)
  startProcessing:
    -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
    -> isValidStatusTransition(ACKNOWLEDGED, IN_PROGRESS)
    -> prisma.order.update status = IN_PROGRESS
    -> revalidatePath — page re-renders with updated state (DL-006)

  completeOrder:
    -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
    -> isValidStatusTransition(IN_PROGRESS, COMPLETED)
    -> prisma.order.update status = COMPLETED, notes = formData.notes (DL-003)
    -> revalidatePath then redirect('/dashboard/lab') (DL-006)
```

## Design Decisions

**LAB_ADMIN role, not LAB (DL-001)**: The Prisma `UserRole` enum contains
`CLIENT`, `LAB_ADMIN`, and `ADMIN`. There is no `LAB` variant. Auth guards in
both `page.tsx` and `action.ts` compare `session.user.role !== 'LAB_ADMIN'`.
Any guard using `'LAB'` would deny all lab users.

**Single page for both transitions (DL-002)**: `ACKNOWLEDGED -> IN_PROGRESS`
and `IN_PROGRESS -> COMPLETED` are rendered conditionally in one page. Separate
pages would duplicate the auth and ownership guard logic.

**Completion notes in Order.notes (DL-003)**: `Order.notes` is a nullable
`String` column. File upload is scoped out of this slice. The textarea value
is trimmed before write; empty string is treated as null.

**notFound() for unauthorized access (DL-004)**: Both a missing order and an
ownership mismatch return 404. This prevents information leakage about whether
an order exists.

**App router re-export (DL-005)**: `src/app/dashboard/lab/orders/[orderId]/page.tsx`
is a single-line re-export of the RSC from this slice. App router convention
mounts the route; VSA keeps the implementation in the feature directory.

**TOCTOU guard — re-fetch in both server actions (DL-007)**: Order status can
change between page load and form submission (e.g., an admin cancels the
order). Both actions re-fetch the order from the DB and re-verify ownership and
status before calling `isValidStatusTransition()` and writing to Prisma.
`formData.orderId` alone is untrusted.

**revalidatePath after startProcessing; redirect after completeOrder (DL-006)**:
`startProcessing` keeps the lab technician on the same page to see the updated
IN_PROGRESS state — `revalidatePath` triggers RSC re-render. `completeOrder`
redirects to `/dashboard/lab` because the order is terminal for this view.

## Invariants

- Auth guard uses `'LAB_ADMIN'` — the string representation of the schema enum.
  Session role is stored as a string in the JWT token.
- `isValidStatusTransition()` is called BEFORE every Prisma write. It is a
  domain gate, not a post-write validation.
- No cross-slice UI imports. `ui.tsx` imports only from `@/components/ui/`,
  `react`, and sibling files. Domain imports (`state-machine`) are allowed per
  the ESLint boundary rule in `eslint.config.js`.
- `LabOrderDTO` fields are all primitive strings. No `Prisma.Decimal` or `Date`
  objects cross the RSC-to-client boundary.
- Both server actions re-fetch the order to guard against TOCTOU races.
