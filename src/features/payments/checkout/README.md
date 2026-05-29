# checkout

## Overview

Deferred-payment checkout slice. A CLIENT whose `Order.status === PAYMENT_PENDING` visits
`/dashboard/orders/[orderId]/pay`, reviews a payment summary, and clicks to be redirected
to a Xendit-hosted invoice page. The Server Action creates a `Transaction` record and
redirects. Order status is **not** mutated here — the webhook handler advances it after
Xendit confirms payment.

## Architecture

### Invoice flow

```
page.tsx (RSC)
  -> auth() — CLIENT only; redirect /auth/signin otherwise
  -> prisma.order (include clientProfile, service)
  -> guard: clientId match + status === PAYMENT_PENDING
  -> CheckoutOrderDTO (Decimal -> string, Date -> ISO string)
  -> <PaymentSummary order={dto} />  (ui.tsx)
       -> useActionState(initiateCheckout)
       -> <form action={formAction}>  (hidden orderId input)

action.ts — initiateCheckout (Server Action)
  -> TOCTOU re-fetch: re-verify clientId + status === PAYMENT_PENDING
  -> idempotency guard: PENDING Transaction by orderId -> redirect(checkoutUrl)
  -> createId() -> transactionId (used as Transaction.id AND Xendit external_id param)
  -> createXenditInvoice() [src/lib/payments/xendit.ts] — BEFORE Prisma write
  -> prisma.transaction.create (externalId = Xendit invoice ID from response)
  -> redirect(checkoutUrl)
```

### VA flow

```text
bank selector form
  -> initiateVaCheckout (Server Action)
  -> bank code + amount validation
  -> createXenditVa() [src/lib/payments/xendit-va.ts] — BEFORE Prisma write
  -> prisma.transaction.create (vaNumber = account_number from Xendit response)
  -> redirect(/dashboard/orders/{orderId})
```

## Design Decisions

**`initiateVaCheckout` is a separate Server Action — not a discriminator branch in `initiateCheckout`**:
The two flows diverge at step 3 (Xendit API call: `createXenditInvoice` vs `createXenditVa`),
idempotency guard behavior (VA returns an error rather than a `checkoutUrl` redirect on duplicate),
and Transaction shape (`vaNumber` column populated, no `checkoutUrl`). Two named actions are
independently testable; a single action with a payment-method discriminator would require
branching every assertion in every test.

**TOCTOU guard — re-fetch Order in action (DL-004 / context invariant)**: The action
re-fetches the Order from the DB and re-verifies `clientId + status === PAYMENT_PENDING`
even though `page.tsx` already performed the same check. Order status can change between
page load and form submission — for example, an admin may cancel the order. Without the
re-check, the action could create a Xendit invoice for an order that is no longer
awaiting payment.

**Xendit call before Prisma write (DL-002)**: If Prisma write fails after Xendit call,
the orphaned Xendit invoice is recoverable — on retry the idempotency guard finds
the PENDING Transaction from the successful second attempt. The inverse (Prisma first,
Xendit second) leaves the user with a local record but no invoice URL; that failure
mode is not recoverable without manual intervention.

**Two-ID scheme (DL-003)**: `Transaction.id` is a pre-generated cuid sent to Xendit
as the `external_id` API parameter. `Transaction.externalId` (DB column) stores the
Xendit invoice ID returned in the response. The two-ID separation supports
PAYMENT_FAILED retry flows: multiple Transactions may exist per `orderId`, each with
a distinct Xendit invoice ID. Using `orderId` as `Transaction.id` would violate the
`@id` uniqueness constraint on retry.

**Idempotency guard (DL-004)**: The action checks for an existing PENDING Transaction
by `orderId` before calling Xendit. Double-submit or browser back+resubmit fire the
action twice; without this guard, two Xendit invoices would be created and the client
double-charged. `Transaction.externalId` UNIQUE constraint is the DB-level fallback if
the guard is bypassed by a race condition.

**`Decimal` → `string` at RSC boundary**: `Order.quotedPrice` is `Prisma.Decimal` at
runtime. Passing it as a Client Component prop causes a Next.js serialization crash.
The RSC converts it with `.toFixed(2)`. `Prisma.Decimal` must not appear in `ui.tsx`
props.

**No provider abstraction interface (DL-001)**: ADR-001 rejects premature abstraction.
Switching to PayMongo requires adding `src/lib/payments/paymongo.ts` and updating one
import in `action.ts` — no schema migration, no interface changes.

**`isValidStatusTransition()` not called (DL-007)**: The checkout action creates a
Transaction record only. No `Order.status` mutation occurs, so the state-machine guard
does not apply. Calling it here would be misleading; the webhook handler uses it when
advancing status after Xendit confirms payment.

**Currency hardcoded to PHP (DL-008)**: PipetGo operates in the Philippines only.
`Transaction.currency` schema default is `PHP` and all quoted prices are in PHP.
No multi-currency requirement exists; parameterizing currency would be YAGNI per ADR-001.

**`xendit.ts` infrastructure boundary**: `src/lib/payments/xendit.ts` must not import
from `@/features/*`. It is an infrastructure helper consumed by feature slices, not
part of any slice itself. This mirrors the direction of the ADR-001 boundary rule:
features may import from `src/lib/`, but `src/lib/` must not import from `src/features/`.

## KYC Gate (T-15)

Both `initiateCheckout` and `initiateVaCheckout` gate on `Lab.kycStatus === APPROVED` before any Xendit call.

**DL-003 rationale — gate at checkout, not settlement**: By settlement time Xendit has already collected client funds and the platform owes the lab. Gating at settlement can only delay payout — it cannot prevent the invoice from being issued. The checkout actions are the first point where the platform commits to creating a Xendit invoice or FVA in the lab's name; rejecting before that call is the only point where no money has moved.

**`lab: true` include is required — do not remove**: Both `initiateCheckout` and `initiateVaCheckout` include `lab: true` in the `Order` lookup. This include populates `order.lab.kycStatus`, which the gate reads. Removing the include as "unused" silently bypasses the gate on every checkout.

**Null relation after explicit include is a data corruption event**: After an explicit `include: { lab: true }`, a null `order.lab` is a referential-integrity violation — not a missing-row scenario. The guard must `throw new Error('Order.lab missing after explicit include — referential integrity violation')`, not call `notFound()`. A `notFound()` here buries a data-layer failure in production monitoring as a normal 404.

**Gate ordering (DL-011)**: The KYC gate runs after the order-validity guards (`order not found`, `wrong status`, `missing quotedPrice`) but **before** the PENDING-Transaction idempotency lookup. An unverified lab must never reach Xendit even if a pre-existing PENDING Transaction exists for the same order. The redirect-to-existing-PENDING-Transaction branch is intentionally preempted: any pre-T-15 PENDING Transaction on an unverified lab would silently route the user to a Xendit invoice the lab cannot collect on. The KYC error message is the correct outcome.

**Sub-account routing (DL-012)**: The KYC gate is orthogonal to sub-account invoice routing (T-17) — this gate is not related to that migration.

## Invariants

- `redirect()` is never wrapped in `try/catch` in `action.ts` — Next.js throws
  `NEXT_REDIRECT` internally; catching it swallows the redirect silently.
- `Order.status` is never mutated by this slice. The webhook handler is the sole
  writer of status transitions for PAYMENT_PENDING orders.
- `initiateVaCheckout` redirects to `/dashboard/orders/{orderId}` — not a Xendit-hosted
  URL — because FVA has no hosted payment page. The VA number displayed on order-detail
  IS the payment instruction.
- `Transaction.provider` is the string literal `'xendit'` — the schema column is
  `String`, not an enum, to remain provider-agnostic.
- `CheckoutOrderDTO` fields are all `string` — no `Prisma.Decimal` or `Date` objects
  cross the RSC-to-client boundary.
- The idempotency guard (PENDING Transaction lookup) precedes every Xendit API call.
- `Order.quotedPrice` is always non-null when `status === PAYMENT_PENDING` —
  `resolveOrderInitialState` sets `quotedPrice` before transitioning to that status.
  The non-null assertion (`!`) in `page.tsx` and the null guard in `action.ts` are
  safe for PAYMENT_PENDING orders; the null guard in the action provides defense
  against any future state-machine changes that might relax this guarantee.
