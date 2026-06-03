# Plan

## Overview

A CLIENT has no way to dispute a COMPLETED order and an ADMIN has no resolution surface, so the platform cannot satisfy the ITA 2023 internal dispute & redress (IDRM) requirement. The lab payout for a disputed order must be held while the dispute is open; today the (dormant) settlement path would release it once it activates. There is no completion timestamp to anchor a dispute window, and OrderStatus has no DISPUTED state.

**Approach**: Add a DISPUTED OrderStatus member and an immutable Order.completedAt anchor (set once at IN_PROGRESS->COMPLETED). Add exactly 3 state-machine transitions: COMPLETED->DISPUTED, DISPUTED->COMPLETED, DISPUTED->REFUND_PENDING. Store dispute data in a new OrderDispute model (orderId @unique one-to-one, free-form reason, openedAt/resolvedAt, DisputeResolution enum, admin resolvedById + resolutionNote) for an auditable ITA redress trail. A client slice (src/features/orders/dispute/) opens disputes — ownership-guarded, enforcing a 14-day DISPUTE_WINDOW_DAYS domain constant; an admin slice (src/features/orders/dispute-resolution/) resolves them in either direction with a layer-2 ADMIN re-check. The payout-hold lives in processSettlement: both the first-delivery findFirst and the updateMany CAS write predicate exclude orders whose related Order.status is DISPUTED, so a held QUEUED payout cannot settle until DISPUTED->COMPLETED clears it. DISPUTED->REFUND_PENDING sets status (+ resolution record) only; refund execution stays manual/out of scope. Deliverable: plans/T-19-dispute-redress.md only.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Add an immutable Order.completedAt DateTime? anchor set at the IN_PROGRESS->COMPLETED transition, rather than reusing updatedAt for the dispute window. | The 14-day window must be measured from the completion instant -> updatedAt mutates on every subsequent write (notes edits, payout writes, status changes) so it drifts away from the true completion time -> a window keyed on updatedAt would silently extend or corrupt itself; a dedicated field written once alongside status=COMPLETED is a stable, auditable anchor. |
| DL-002 | Window is a domain constant DISPUTE_WINDOW_DAYS = 14 in src/domain/orders/dispute.ts; out-of-window dispute attempts throw/return an error, never silently no-op. | A window value inlined in the action duplicates a business rule across call sites and hides it from the domain layer -> mirroring src/domain/payments/commission.ts keeps the rule single-sourced and testable in isolation; a silent no-op on an expired window would leave the client believing a dispute was filed -> the action must surface an explicit out-of-window error so the contract violation is visible. |
| DL-003 | Store dispute data in a new OrderDispute model (orderId @unique one-to-one, reason String, openedAt, resolvedAt DateTime?, resolution DisputeResolution?, resolvedById String? -> User named relation, resolutionNote String?), not a field on Order. | ITA 2023 redress requires an auditable who-resolved-what-when trail -> a single reason column on Order cannot record resolver identity, resolution direction, timestamps, or admin note -> a dedicated model with orderId @unique enforces one-dispute-per-order at the DB level and captures the full audit record; resolvedById uses a User named relation mirroring Lab.kycReviewedById so the admin back-reference does not collide with Order.clientId. |
| DL-004 | Exactly 3 new state-machine transitions: COMPLETED->DISPUTED, DISPUTED->COMPLETED, DISPUTED->REFUND_PENDING. No DISPUTED->CANCELLED or any other edge. | isValidStatusTransition() is the single enforcement point -> every new lifecycle path must be an explicit edge in validStatusTransitions or it is rejected -> COMPLETED gains a DISPUTED branch and DISPUTED maps to [COMPLETED, REFUND_PENDING]; an unrequested DISPUTED->CANCELLED edge would create a refund-bypass path with no regulatory basis, so it is excluded. |
| DL-005 | Payout hold lives in processSettlement: both the first-delivery findFirst predicate and the updateMany CAS write predicate exclude orders whose related Order.status is DISPUTED, using updateMany + count===0 early-return. | At COMPLETED an order already has a QUEUED Payout; the dormant settlement path (DL-012) would later move QUEUED->COMPLETED and release funds -> if the predicate ignores Order.status a disputed order would settle and release money before resolution -> adding a relation filter (order.status not DISPUTED) to the lookup AND the CAS write predicate holds the payout; a bare update could not detect concurrent delivery, so the webhook CAS discipline (updateMany + count===0) is preserved. DISPUTED->COMPLETED re-permits release automatically because the guard keys off current Order.status. |
| DL-006 | Two vertical slices: client src/features/orders/dispute/ (ownership guard, mirrors acceptQuote) and admin src/features/orders/dispute-resolution/ (layer-2 ADMIN re-check, mirrors kyc-review/action.ts). | Client open and admin resolve are distinct actors with distinct auth models -> co-locating them in one slice would mix a CLIENT ownership guard with an ADMIN role guard -> separate slices keep each authorization model self-contained; the admin action re-checks session.user.role===ADMIN independently (DL-006 TOCTOU; the project-level TOCTOU invisible-knowledge fact) because the route-group layout guard is layer-1 only and does not protect Server Actions. |
| DL-007 | DISPUTED->REFUND_PENDING sets Order.status only; no refund is executed in T-19 (refund stays separate/manual). | Refund execution requires Xendit refund integration not in scope -> coupling refund execution into the resolution action would expand the slice into payment-provider territory -> the admin RESOLVED_REFUND path writes status=REFUND_PENDING and the OrderDispute resolution record only, leaving the existing REFUND_PENDING->REFUNDED path and actual refund as a later manual/separate step. |
| DL-008 | Add DISPUTED to the 2 `as const satisfies Record<OrderStatus>` badge maps (order-oversight ui.tsx + detail-ui.tsx) and to the 2 exhaustive `: Record<OrderStatus>` annotated maps (clients dashboard ui.tsx + order-detail page.tsx); migrate touched non-satisfies maps to `as const satisfies` per the compounding rule. Preserve order-detail page.tsx ?? fallback. | A new enum member is a compile error only where the map is exhaustively typed -> the 2 satisfies maps and the 2 annotated Record<OrderStatus> maps all error on a missing DISPUTED key, while Partial<Record<OrderStatus>> step maps do not -> all four must gain a DISPUTED entry; the order-detail page.tsx ?? fallback is intentional deploy-safety for the migration<->client-regen window and is left in place. |
| DL-009 | Enum value DISPUTED and OrderDispute table/columns are applied per environment via npx prisma db push (dev/CI/prod); prisma/migrations stays gitignored, schema.prisma is the source of truth. | DL-011: prisma/migrations is gitignored and branches are db-push-managed not migrate-dev -> a new enum value or table that is not pushed to a given env causes a runtime crash, not a type error -> the plan records an explicit per-env db push as an acceptance step so the DISPUTED value and OrderDispute table exist before the code runs in each environment. |
| DL-010 | Legacy COMPLETED orders carry completedAt=null (column is DateTime? with no default and is not backfilled); the dispute action treats null completedAt as out-of-window and rejects with an explicit error, never crashes or silently bypasses the window. No historical backfill is performed in T-19. | Order.completedAt is added nullable with no default, so every pre-existing COMPLETED order has completedAt=null -> a window check now - completedAt would throw or coerce wrongly on null, silently making legacy orders either un-disputable by crash or disputable forever -> openDispute must guard `completedAt == null` FIRST and return the same explicit out-of-window error path (DL-002), making legacy orders cleanly non-disputable without a crash; a one-time backfill of historical completion instants has no reliable source (updatedAt drifted, DL-001) so it is deliberately not attempted and the SLA/README documents the transition-state behavior. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Reuse Order.updatedAt as the dispute-window anchor instead of adding Order.completedAt. | updatedAt mutates on every subsequent write (notes edits, payout writes, later status changes), so the 14-day window would silently drift or extend; a dedicated write-once field is the only stable anchor. (ref: DL-001) |
| Store the dispute as a single free-form reason column on Order (no separate model). | ITA 2023 redress requires an auditable who/what/when trail (resolver identity, direction, timestamps, admin note); a lone column cannot capture it and cannot enforce one-dispute-per-order at the DB level. (ref: DL-003) |
| Add a DISPUTED->CANCELLED (or other extra) state-machine edge for flexibility. | Out of scope and unrequested; it would create a refund-bypass path with no regulatory basis. Exactly 3 edges are authorized. (ref: DL-004) |
| Execute the actual refund when an admin resolves DISPUTED->REFUND_PENDING. | Refund execution requires Xendit refund integration not in scope; the resolution writes status + audit record only, leaving refund manual/separate. (ref: DL-007) |
| Use a bare Prisma update for the payout-hold guard in processSettlement. | A bare update cannot detect concurrent webhook delivery and would silently overwrite state; the established webhook CAS discipline (updateMany + count===0 early-return) is mandatory. (ref: DL-005) |
| Wire an admin role grant/revoke surface as part of this ticket. | That is T-13c, deferred behind its own privilege-escalation audit; T-19 only re-checks the existing ADMIN role (layer-2). (ref: DL-006) |

### Constraints

- MUST: every Order.status write calls isValidStatusTransition() before writing (single enforcement point in state-machine.ts).
- MUST: exactly 3 new transitions — COMPLETED->DISPUTED, DISPUTED->COMPLETED, DISPUTED->REFUND_PENDING — no others (no DISPUTED->CANCELLED).
- MUST: payout-hold uses updateMany + guard predicate + count===0 early-return, never bare update; the predicate excludes DISPUTED orders so QUEUED->COMPLETED settlement cannot release funds during an open dispute.
- MUST: admin resolution action re-checks session.user.role===ADMIN independently in the Server Action (layer-2 TOCTOU; layout guard is layer-1 only, DL-006).
- MUST: client dispute action enforces ownership (order.clientId===session.user.id) like acceptQuote/rejectQuote.
- MUST: findUnique on Order.@id; a null guaranteed-relation-after-include throws; only a genuinely missing order is notFound().
- MUST: redirect() called after — never inside — any try/catch in Server Actions.
- MUST: formData.get('reason') runtime-narrowed (typeof === 'string') before use, never `as string`.
- MUST: npx prisma db push owed per env (dev/CI/prod) for the DISPUTED enum value and order_disputes table; prisma/migrations gitignored (DL-011), schema.prisma is source of truth.
- MUST: add DISPUTED to the 2 `as const satisfies Record<OrderStatus>` maps and the 2 exhaustive annotated Record<OrderStatus> maps; hand-audit Partial maps; migrate touched non-satisfies maps to `as const satisfies`; preserve order-detail page.tsx ?? fallback.
- MUST: no Prisma.Decimal/Date crosses RSC->client unserialized (.toFixed(2)/.toISOString(); DTO fields typed string).
- MUST: no bare toLocaleString() in new client components (deterministic fixed locale+timeZone or RSC-side format).
- SHOULD: out-of-window dispute throws/rejects, never silently no-ops; DISPUTE_WINDOW_DAYS lives in the domain layer.
- SHOULD: document an ITA-compliant response-time SLA in the plan/README even though it is not code-enforced.

### Known Risks

- **The payout-hold predicate is added to processSettlement (DL-012 dormant) but is partly forward-looking; a wrong relation-filter shape would let a disputed order settle and release funds once the settlement path activates.**: Apply the filter to BOTH the first-delivery findFirst and the updateMany CAS write; cover with a unit test asserting settlement is skipped for a DISPUTED order and proceeds after DISPUTED->COMPLETED.
- **A new OrderStatus member is a runtime crash (not a type error) in maps that are Partial or use a ?? fallback, and an unpushed enum value crashes at runtime.**: Add DISPUTED to all exhaustive maps and hand-audit Partial maps; assert exhaustiveness with a unit test in src/features/orders/order-detail/__tests__/status-badge.test.ts that iterates every OrderStatus enum member (Object.values) and asserts statusBadgeConfig has a defined, non-fallback entry for each — so a future enum member without a badge fails the test, not just tsc. Record an explicit per-env npx prisma db push acceptance step for the enum value.
- **The settlement uniqueness invariant relies on completeOrder being called exactly once per Order; writing completedAt on a re-entrant path would corrupt the window anchor.**: Set completedAt only inside the existing single IN_PROGRESS->COMPLETED tx update, guarded by isValidStatusTransition; cover with a unit test in src/features/orders/lab-fulfillment/__tests__/action.test.ts asserting that a second completeOrder call on an already-COMPLETED order is rejected by isValidStatusTransition (re-entrancy guarded) and does NOT rewrite completedAt — proving the write-once anchor invariant by test, not by structural reasoning alone.

## Invisible Knowledge

### System

Order lifecycle is enforced through a single guard (isValidStatusTransition in src/domain/orders/state-machine.ts); every status write must pass it. At IN_PROGRESS->COMPLETED, completeOrder (T-09) creates a QUEUED Payout inside the same $transaction. processSettlement (T-10, payouts/handlers.ts) later moves that Payout QUEUED->COMPLETED and shifts platformFee pendingBalance->availableBalance — but is DORMANT until checkout migrates to sub-account invoices (DL-012). The dispute hold = block that QUEUED->COMPLETED move while Order.status===DISPUTED, by excluding DISPUTED orders from both the first-delivery lookup and the CAS write predicate. The admin route group has a layout guard (layer-1) that does NOT protect Server Actions/RSC pages — each action re-checks ADMIN independently (layer-2; the TOCTOU re-check decision is DL-006, distinct from the DL-001 completedAt-anchor decision).

### Invariants

- Every Order.status write passes isValidStatusTransition() — the single enforcement point.
- Exactly 3 new transitions exist: COMPLETED->DISPUTED, DISPUTED->COMPLETED, DISPUTED->REFUND_PENDING.
- OrderDispute.orderId is @unique — at most one dispute per order.
- Order.completedAt is written exactly once, at the terminal IN_PROGRESS->COMPLETED transition, and never mutated thereafter.
- A DISPUTED order's QUEUED Payout cannot settle; DISPUTED->COMPLETED re-permits it automatically because the guard keys off current Order.status.
- Webhook/settlement status writes use updateMany + guard predicate + count===0 early-return, never bare update.
- Enum dispatch tables use `as const satisfies Record<OrderStatus|DisputeResolution>` so a new member is a compile error.
- completeOrder is called exactly once per Order (terminal COMPLETED); settlement uniqueness relies on this.

### Tradeoffs

- The payout-hold is implemented in a dormant settlement path (DL-012); it is forward-looking insurance required by the acceptance criteria, not exercised by live traffic yet.
- DISPUTED->REFUND_PENDING sets status + audit record only; actual refund stays manual to avoid pulling Xendit refund integration into this slice.
- order-detail/page.tsx keeps an intentional ?? badge fallback as deploy-safety for the migration<->client-regen window — deliberately not removed despite the exhaustive-map preference.
- A dedicated OrderDispute model + completedAt column add schema surface (and a per-env db push) over a lighter single-column approach, traded for the auditable ITA redress trail.

## Milestones

### Milestone 1: Foundation — DISPUTED enum, OrderDispute model, completedAt anchor, domain constant, state-machine edges

**Files**: prisma/schema.prisma, src/domain/orders/state-machine.ts, src/domain/orders/dispute.ts, src/features/orders/lab-fulfillment/action.ts

**Requirements**:

- Add DISPUTED to OrderStatus enum
- Add completedAt DateTime? to Order set once at IN_PROGRESS->COMPLETED
- Add OrderDispute model + DisputeResolution enum
- Add DISPUTE_WINDOW_DAYS=14 domain constant
- Add exactly 3 state-machine transitions

**Acceptance Criteria**:

- npx tsc --noEmit clean after enum + model added
- validStatusTransitions has COMPLETED->[REFUND_PENDING DISPUTED] and DISPUTED->[COMPLETED REFUND_PENDING] and no other new edges
- completeOrder writes completedAt alongside status=COMPLETED in same tx update
- DISPUTE_WINDOW_DAYS exported from src/domain/orders/dispute.ts
- npx prisma db push applied per env so DISPUTED value + order_disputes table exist before runtime
- state-machine unit tests assert 3 new edges valid and invalid edges (e.g. DISPUTED->CANCELLED COMPLETED->REFUNDED) rejected

**Tests**:

- unit:src/domain/orders/__tests__/state-machine.test.ts — new edges valid + invalid rejected|unit:src/features/orders/lab-fulfillment/__tests__/action.test.ts — second completeOrder on already-COMPLETED order rejected by isValidStatusTransition and completedAt not rewritten (write-once anchor
- R-003)

#### Code Intent

- **CI-M-001-001** `prisma/schema.prisma::OrderStatus enum`: OrderStatus includes a DISPUTED member positioned after COMPLETED. The addition is additive; the value is applied per environment via npx prisma db push. (refs: DL-004, DL-009)
- **CI-M-001-002** `prisma/schema.prisma::Order model + OrderDispute model + DisputeResolution enum`: Order gains completedAt DateTime? (nullable, no default, written once at completion). A DisputeResolution enum holds RESOLVED_COMPLETED and RESOLVED_REFUND. A new OrderDispute model has id @id @default(cuid), orderId String @unique, an order Order relation, reason String, openedAt DateTime @default(now), resolvedAt DateTime?, resolution DisputeResolution?, resolutionNote String?, resolvedById String?, and a resolvedBy User relation declared with @relation(name) so its User back-reference does not collide with Order.clientId. Order gains a dispute OrderDispute? back-reference; User gains a named back-reference list for resolved disputes. @@map(order_disputes). (refs: DL-001, DL-003, DL-009)
- **CI-M-001-003** `src/domain/orders/dispute.ts::DISPUTE_WINDOW_DAYS + isWithinDisputeWindow`: Exports DISPUTE_WINDOW_DAYS = 14 and a pure helper isWithinDisputeWindow(completedAt: Date, now: Date): boolean returning whether now is within DISPUTE_WINDOW_DAYS of completedAt. Mirrors the domain-constant style of src/domain/payments/commission.ts. No I/O, no Prisma import. (refs: DL-002)
- **CI-M-001-004** `src/domain/orders/state-machine.ts::validStatusTransitions`: COMPLETED maps to [REFUND_PENDING, DISPUTED]; a DISPUTED key maps to [COMPLETED, REFUND_PENDING]. No other edges added; DISPUTED has no CANCELLED edge. isValidStatusTransition remains the single guard. (refs: DL-004)
- **CI-M-001-005** `src/features/orders/lab-fulfillment/action.ts::completeOrder`: The tx.order.update that sets status=COMPLETED also sets completedAt: new Date() in the same data block, inside the existing $transaction after the IN_PROGRESS->COMPLETED isValidStatusTransition guard. completedAt is written exactly once. (refs: DL-001)

#### Code Changes

**CC-M-001-001** (prisma/schema.prisma) - implements CI-M-001-001

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -39,6 +39,7 @@ enum OrderStatus {
   IN_PROGRESS
   COMPLETED
+  DISPUTED
   CANCELLED
   REFUND_PENDING
   REFUNDED
 }
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -39,6 +39,8 @@ enum OrderStatus {
   IN_PROGRESS
   COMPLETED
+  /// Client-opened dispute on a COMPLETED order; payout is held until admin
+  /// resolves to COMPLETED (no refund) or REFUND_PENDING (ref: DL-004, DL-005).
   DISPUTED
   CANCELLED
   REFUND_PENDING
   REFUNDED
 }

```


**CC-M-001-002** (prisma/schema.prisma) - implements CI-M-001-002

**Code:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -44,6 +44,14 @@ enum OrderStatus {
   REFUNDED
 }
 
+enum DisputeResolution {
+  RESOLVED_COMPLETED
+  RESOLVED_REFUND
+}
+
 enum TransactionStatus {
   PENDING
   PROCESSING
@@ -208,6 +208,7 @@ model Order {
   paidAt          DateTime?
   paymentMethod   String?
   refundedAt      DateTime?
+  completedAt     DateTime?
   createdAt       DateTime    @default(now())
   updatedAt       DateTime    @updatedAt
 
@@ -231,6 +231,7 @@ model Order {
   transactions  Transaction[]
   payouts       Payout[]
+  dispute       OrderDispute?
 
   @@index([clientId])
   @@index([labId])
@@ -258,6 +258,24 @@ model ClientProfile {
   @@map("client_profiles")
 }
 
+model OrderDispute {
+  id           String            @id @default(cuid())
+  orderId      String            @unique
+  reason       String
+  resolution   DisputeResolution?
+  resolvedAt   DateTime?
+  resolvedById String?
+  openedAt     DateTime          @default(now())
+  updatedAt    DateTime          @updatedAt
+
+  order      Order @relation(fields: [orderId], references: [id])
+  resolvedBy User? @relation("DisputeResolver", fields: [resolvedById], references: [id])
+
+  @@index([orderId])
+  @@map("order_disputes")
+}
+
 model Attachment {
```

**Documentation:**

```diff
--- a/prisma/schema.prisma
+++ b/prisma/schema.prisma
@@ -44,6 +44,8 @@ enum OrderStatus {
   REFUNDED
 }
 
+/// Admin verdict on a dispute. RESOLVED_COMPLETED lifts the payout hold;
+/// RESOLVED_REFUND moves the order to REFUND_PENDING for manual processing (ref: DL-007).
 enum DisputeResolution {
   RESOLVED_COMPLETED
   RESOLVED_REFUND
 }
@@ -208,6 +208,9 @@ model Order {
   paidAt          DateTime?
   paymentMethod   String?
   refundedAt      DateTime?
+  /// Immutable completion timestamp written once at IN_PROGRESS->COMPLETED.
+  /// Anchors the DISPUTE_WINDOW_DAYS check; must not use updatedAt
+  /// because updatedAt mutates on every subsequent write (ref: DL-001).
   completedAt     DateTime?
   createdAt       DateTime    @default(now())
   updatedAt       DateTime    @updatedAt
@@ -258,6 +258,11 @@ model ClientProfile {
   @@map("client_profiles")
 }
 
+/// One-to-one audit record per disputed order. orderId @unique enforces
+/// one-dispute-per-order at the DB level. Captures resolver identity,
+/// direction, timestamps, and admin note for ITA 2023 redress audit trail
+/// (ref: DL-003). Applied per-env via npx prisma db push (ref: DL-009).
 model OrderDispute {
   id           String            @id @default(cuid())
   orderId      String            @unique
   reason       String
   resolution   DisputeResolution?
+  /// Null while the dispute is open; set atomically with Order.status write in resolveDispute.
   resolvedAt   DateTime?
   resolvedById String?
   openedAt     DateTime          @default(now())
   updatedAt    DateTime          @updatedAt
 
   order      Order @relation(fields: [orderId], references: [id])
+  /// Named relation avoids collision with Order.clientId (ref: DL-003).
   resolvedBy User? @relation("DisputeResolver", fields: [resolvedById], references: [id])
 
   @@index([orderId])
   @@map("order_disputes")
 }

```


**CC-M-001-003** (src/domain/orders/dispute.ts) - implements CI-M-001-003

**Code:**

```diff
--- a/src/domain/orders/dispute.ts
+++ b/src/domain/orders/dispute.ts
@@ -0,0 +1,14 @@
+/**
+ * ITA 2023 dispute window — clients have 14 days from order completion
+ * to open a dispute. Constant lives in the domain layer so slice code
+ * does not inline magic numbers.
+ */
+
+export const DISPUTE_WINDOW_DAYS = 14
+
+export function isWithinDisputeWindow(completedAt: Date, now: Date): boolean {
+  const windowMs = DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
+  return now.getTime() - completedAt.getTime() <= windowMs
+}
```

**Documentation:**

```diff
--- a/src/domain/orders/dispute.ts
+++ b/src/domain/orders/dispute.ts
@@ -7,6 +7,10 @@ export const DISPUTE_WINDOW_DAYS = 14
 
+/**
+ * Returns true if `now` falls within DISPUTE_WINDOW_DAYS of `completedAt`.
+ * Pure (no I/O); accepts an explicit `now` for deterministic unit testing.
+ * A null completedAt is not accepted here — callers guard that case first (ref: DL-010).
+ */
 export function isWithinDisputeWindow(completedAt: Date, now: Date): boolean {
   const windowMs = DISPUTE_WINDOW_DAYS * 24 * 60 * 60 * 1000
   return now.getTime() - completedAt.getTime() <= windowMs
 }

```


**CC-M-001-004** (src/domain/orders/state-machine.ts) - implements CI-M-001-004

**Code:**

```diff
--- a/src/domain/orders/state-machine.ts
+++ b/src/domain/orders/state-machine.ts
@@ -33,7 +33,10 @@ export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
   [OrderStatus.ACKNOWLEDGED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
   [OrderStatus.IN_PROGRESS]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
-  [OrderStatus.COMPLETED]: [OrderStatus.REFUND_PENDING],
+  [OrderStatus.COMPLETED]: [OrderStatus.REFUND_PENDING, OrderStatus.DISPUTED],
+  // DISPUTED has no CANCELLED edge — cancellation after dispute is out of scope for T-19.
+  [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.REFUND_PENDING],
   [OrderStatus.REFUND_PENDING]: [OrderStatus.REFUNDED],
   [OrderStatus.REFUNDED]: [],
   [OrderStatus.CANCELLED]: [],
 }
```

**Documentation:**

```diff
--- a/src/domain/orders/state-machine.ts
+++ b/src/domain/orders/state-machine.ts
@@ -33,7 +33,10 @@ export const validStatusTransitions: Record<OrderStatus, OrderStatus[]> = {
   [OrderStatus.ACKNOWLEDGED]: [OrderStatus.IN_PROGRESS, OrderStatus.CANCELLED],
   [OrderStatus.IN_PROGRESS]: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
+  // COMPLETED permits DISPUTED: a client may open a dispute within the window (ref: DL-004).
   [OrderStatus.COMPLETED]: [OrderStatus.REFUND_PENDING, OrderStatus.DISPUTED],
   // DISPUTED has no CANCELLED edge — cancellation after dispute is out of scope for T-19.
   [OrderStatus.DISPUTED]: [OrderStatus.COMPLETED, OrderStatus.REFUND_PENDING],
   [OrderStatus.REFUND_PENDING]: [OrderStatus.REFUNDED],
   [OrderStatus.REFUNDED]: [],
   [OrderStatus.CANCELLED]: [],
 }

```


**CC-M-001-005** (src/features/orders/lab-fulfillment/action.ts) - implements CI-M-001-005

**Code:**

```diff
--- a/src/features/orders/lab-fulfillment/action.ts
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -110,6 +110,7 @@ export async function completeOrder(
     await tx.order.update({
       where: { id: orderId },
       data: {
         status: OrderStatus.COMPLETED,
+        completedAt: new Date(),
         ...(notes != null ? { notes } : {}),
       },
     })
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/action.ts
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -110,6 +110,8 @@ export async function completeOrder(
     await tx.order.update({
       where: { id: orderId },
       data: {
         status: OrderStatus.COMPLETED,
+        // Write-once anchor for the 14-day dispute window; must be set here
+        // and never overwritten because isWithinDisputeWindow keys off this value (ref: DL-001, R-003).
         completedAt: new Date(),
         ...(notes != null ? { notes } : {}),
       },
     })

```


**CC-M-001-006** (src/domain/orders/CLAUDE.md)

**Documentation:**

```diff
--- a/src/domain/orders/CLAUDE.md
+++ b/src/domain/orders/CLAUDE.md
@@ -7,6 +7,7 @@ Domain kernel for order business rules.
 | File                | What                                                           | When to read                                                |
 | ------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
 | `state-machine.ts`  | `validStatusTransitions` map + `isValidStatusTransition()`     | Writing any action that mutates `Order.status`              |
+| `dispute.ts`        | `DISPUTE_WINDOW_DAYS = 14` + `isWithinDisputeWindow(completedAt, now)` — ITA 2023 14-day dispute window constant and pure helper | Writing or testing the `openDispute` action; any code that must check whether a COMPLETED order is still within the dispute window |
 | `client-details.ts` | `clientDetailsSchema` (Zod) + `ClientDetails` type; `SENSITIVE_SERVICE_CATEGORIES` record + `isSensitiveServiceCategory()` — compile-time enum-drift fence for RA 10173 sensitivity classification | Adding client contact fields; modifying RA 10173 consent validation; classifying a new `ServiceCategory` as sensitive or non-sensitive |
 | `pricing.ts`        | `resolveOrderInitialState()` — maps `PricingMode` to initial order state | Creating orders; understanding FIXED vs QUOTE_REQUIRED flow |

```


### Milestone 2: Client dispute slice — open a dispute on a COMPLETED order within the 14-day window

**Files**: src/features/orders/dispute/action.ts, src/features/orders/dispute/ui.tsx, src/features/orders/dispute/page.tsx, src/features/orders/dispute/__tests__/action.test.ts

**Requirements**:

- Server Action opens an OrderDispute and transitions COMPLETED->DISPUTED
- Enforce ownership order.clientId===session.user.id
- Enforce 14-day window from completedAt
- Runtime-narrow formData reason

**Acceptance Criteria**:

- Non-owner client attempt returns notFound / not authorized — no write|Out-of-window attempt (now - completedAt > 14d) returns explicit error and does not write|Legacy COMPLETED order with completedAt=null returns the same explicit out-of-window error and does not write (no crash no silent bypass) (DL-010)|Non-COMPLETED order rejected by isValidStatusTransition|formData.get(reason) narrowed via typeof===string never as-string|Happy path creates OrderDispute(reason openedAt) and sets status=DISPUTED in one $transaction|redirect/revalidatePath called after the try/$transaction never inside|findUnique on Order.@id; genuinely missing order -> notFound

**Tests**:

- unit:src/features/orders/dispute/__tests__/action.test.ts — non-owner reject|out-of-window reject|null-completedAt (legacy) reject|non-COMPLETED reject|happy path

#### Code Intent

- **CI-M-002-001** `src/features/orders/dispute/action.ts::openDispute`: Server Action: load session, narrow formData.get(reason) via typeof===string (never as string), trim and require non-empty. Inside $transaction: findUnique Order by @id; if genuinely missing -> notFound(); enforce ownership order.clientId===session.user.id (else notFound); guard isValidStatusTransition(order.status, DISPUTED); guard order.completedAt != null FIRST (a null completedAt — legacy COMPLETED order predating the column, DL-010 — takes the same explicit out-of-window error path, never a crash or silent bypass); then enforce isWithinDisputeWindow(order.completedAt, now) else return an explicit out-of-window error (never silent no-op); create OrderDispute(orderId, reason, openedAt) and tx.order.update status=DISPUTED. revalidatePath/redirect called AFTER the transaction, never inside it. (refs: DL-002, DL-003, DL-004, DL-006, DL-010)
- **CI-M-002-002** `src/features/orders/dispute/page.tsx::DisputePage (RSC)`: RSC route under the client order area that loads the order via findUnique, enforces ownership, confirms status===COMPLETED and within-window, and renders the dispute form. Serializes any Decimal via .toFixed(2) and Date via .toISOString() before passing to the client component; DTO fields typed string. (refs: DL-006)
- **CI-M-002-003** `src/features/orders/dispute/ui.tsx::DisputeForm (client)`: Client component rendering the reason textarea and submit bound to openDispute. Surfaces the out-of-window / validation error branch to a rendered error state. No bare toLocaleString(); any date display uses a fixed locale+timeZone or a pre-formatted RSC string. (refs: DL-002, DL-006)

#### Code Changes

**CC-M-002-001** (src/features/orders/dispute/action.ts) - implements CI-M-002-001

**Code:**

```diff
--- a/src/features/orders/dispute/action.ts
+++ b/src/features/orders/dispute/action.ts
@@ -0,0 +1,74 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { isValidStatusTransition } from '@/domain/orders/state-machine'
+import { isWithinDisputeWindow } from '@/domain/orders/dispute'
+
+type ActionState = { message?: string } | null
+
+/**
+ * Transitions a COMPLETED order to DISPUTED and creates an OrderDispute row.
+ *
+ * Authorization: CLIENT role; ownership enforced inside $transaction (DL-006).
+ * Window guard: order must have completedAt set and be within DISPUTE_WINDOW_DAYS.
+ * State guard: isValidStatusTransition(COMPLETED, DISPUTED) via single enforcement point.
+ * Dispute creation is atomic with the status write; both roll back on any throw.
+ * redirect() is called after — never inside — the transaction block.
+ */
+export async function openDispute(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderIdValue = formData.get('orderId')
+  const reasonValue = formData.get('reason')
+
+  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
+  const reason = typeof reasonValue === 'string' ? reasonValue.trim() : ''
+
+  if (!orderId) return { message: 'Missing order ID.' }
+  if (!reason) return { message: 'Dispute reason is required.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let result: ActionState = null
+
+  try {
+    result = await prisma.$transaction(async (tx) => {
+      const order = await tx.order.findUnique({
+        where: { id: orderId },
+      })
+
+      if (!order) return { message: 'Order not found.' }
+      if (order.clientId !== session.user.id) return { message: 'Order not found.' }
+
+      if (!order.completedAt) {
+        return { message: 'Order has no completion timestamp — dispute window cannot be determined.' }
+      }
+      if (!isWithinDisputeWindow(order.completedAt, new Date())) {
+        return { message: 'The 14-day dispute window for this order has passed.' }
+      }
+      if (!isValidStatusTransition(order.status, OrderStatus.DISPUTED)) {
+        return { message: 'Order cannot be disputed from its current status.' }
+      }
+
+      await tx.order.update({
+        where: { id: orderId },
+        data: { status: OrderStatus.DISPUTED },
+      })
+
+      await tx.orderDispute.create({
+        data: { orderId, reason },
+      })
+
+      return null
+    })
+  } catch (e) {
+    throw new Error(`openDispute transaction failed: ${e instanceof Error ? e.message : String(e)}`)
+  }
+
+  if (result !== null) return result
+
+  revalidatePath(`/dashboard/orders/${orderId}`)
+  return null
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute/action.ts
+++ b/src/features/orders/dispute/action.ts
@@ -139,6 +139,8 @@ export async function openDispute(
   const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
   const reason = typeof reasonValue === 'string' ? reasonValue.trim() : ''
 
+  // typeof guards enforce runtime narrowing of FormDataEntryValue | null
+  // before any string operations — 'as string' is forbidden (CLAUDE.md discipline).
   if (!orderId) return { message: 'Missing order ID.' }
   if (!reason) return { message: 'Dispute reason is required.' }
@@ -163,6 +163,9 @@ export async function openDispute(
       if (order.clientId !== session.user.id) return { message: 'Order not found.' }
 
+      // completedAt null means the order predates the dispute-window feature; treat as out-of-window,
+      // not a crash — callers of isWithinDisputeWindow must not receive null (ref: DL-010).
       if (!order.completedAt) {
         return { message: 'Order has no completion timestamp — dispute window cannot be determined.' }
       }

```


**CC-M-002-002** (src/features/orders/dispute/page.tsx) - implements CI-M-002-002

**Code:**

```diff
--- a/src/features/orders/dispute/page.tsx
+++ b/src/features/orders/dispute/page.tsx
@@ -0,0 +1,60 @@
+import { notFound, redirect } from 'next/navigation'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { isWithinDisputeWindow } from '@/domain/orders/dispute'
+import { DisputeForm } from './ui'
+
+export type DisputePageDTO = {
+  orderId: string
+  serviceName: string
+  labName: string
+  completedAt: string
+}
+
+/**
+ * Route: /dashboard/orders/[orderId]/dispute
+ * Auth:  CLIENT role; ownership enforced here and again in the action (TOCTOU).
+ * Guard: COMPLETED status + within-window required; out-of-window renders the
+ *        form pre-populated with an error via the DTO or redirects — handled in
+ *        the action. Missing order or wrong owner -> notFound().
+ */
+export default async function DisputePage({
+  params,
+}: {
+  params: { orderId: string }
+}) {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    redirect('/auth/signin')
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: params.orderId },
+    include: {
+      service: { select: { name: true } },
+      lab: { select: { name: true } },
+    },
+  })
+
+  if (!order) notFound()
+  if (order.clientId !== session.user.id) notFound()
+  if (!order.service) throw new Error('Order.service missing after explicit include — referential integrity violation')
+  if (!order.lab) throw new Error('Order.lab missing after explicit include — referential integrity violation')
+
+  if (order.status !== OrderStatus.COMPLETED) notFound()
+  if (!order.completedAt || !isWithinDisputeWindow(order.completedAt, new Date())) notFound()
+
+  const dto: DisputePageDTO = {
+    orderId: order.id,
+    serviceName: order.service.name,
+    labName: order.lab.name,
+    completedAt: order.completedAt.toISOString(),
+  }
+
+  return <DisputeForm dto={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute/page.tsx
+++ b/src/features/orders/dispute/page.tsx
@@ -6,6 +6,10 @@ import { isWithinDisputeWindow } from '@/domain/orders/dispute'
 import { DisputeForm } from './ui'
 
+/**
+ * All Date fields serialized to ISO string before crossing the RSC boundary.
+ * Prisma.Decimal and Date cannot be serialized by Next.js; DTO fields are
+ * typed string to reflect the serialized form (ref: CLAUDE.md discipline).
+ */
 export type DisputePageDTO = {
   orderId: string
   serviceName: string
   labName: string
   completedAt: string
 }

```


**CC-M-002-003** (src/features/orders/dispute/ui.tsx) - implements CI-M-002-003

**Code:**

```diff
--- a/src/features/orders/dispute/ui.tsx
+++ b/src/features/orders/dispute/ui.tsx
@@ -0,0 +1,53 @@
+'use client'
+
+import { useActionState } from 'react'
+import { openDispute } from './action'
+import type { DisputePageDTO } from './page'
+
+export function DisputeForm({ dto }: { dto: DisputePageDTO }) {
+  const [state, formAction, isPending] = useActionState(openDispute, null)
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-4">
+          <a href={`/dashboard/orders/${dto.orderId}`} className="text-sm text-blue-600 hover:underline">
+            ← Back to order
+          </a>
+        </div>
+        <h1 className="text-2xl font-bold text-gray-900 mb-2">Dispute Order</h1>
+        <p className="text-sm text-gray-500 mb-6">
+          {dto.serviceName} — {dto.labName}
+        </p>
+
+        <div className="bg-white rounded-lg shadow p-6">
+          <form action={formAction}>
+            <input type="hidden" name="orderId" value={dto.orderId} />
+
+            <div className="mb-4">
+              <label htmlFor="reason" className="block text-sm font-medium text-gray-700 mb-1">
+                Reason for dispute <span className="text-red-500">*</span>
+              </label>
+              <textarea
+                id="reason"
+                name="reason"
+                rows={5}
+                required
+                className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
+                placeholder="Describe the issue with this order…"
+              />
+            </div>
+
+            {state?.message && (
+              <p className="text-sm text-red-600 mb-3">{state.message}</p>
+            )}
+
+            <button
+              type="submit"
+              disabled={isPending}
+              className="w-full rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
+            >
+              {isPending ? 'Submitting dispute…' : 'Submit dispute'}
+            </button>
+          </form>
+        </div>
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute/ui.tsx
+++ b/src/features/orders/dispute/ui.tsx
@@ -1,5 +1,9 @@
 'use client'
 
+/**
+ * Client dispute form. Submits to openDispute via useActionState and renders
+ * every error branch returned by the action — no silent failures.
+ * completedAt is a pre-serialized ISO string from the RSC page DTO.
+ */
 import { useActionState } from 'react'
 import { openDispute } from './action'
 import type { DisputePageDTO } from './page'

```


**CC-M-002-004** (src/features/orders/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/orders/CLAUDE.md
+++ b/src/features/orders/CLAUDE.md
@@ -14,6 +14,8 @@ Order feature slices. Each subdirectory is a vertical slice scoped to one order
 | `spec-upload/`     | CLIENT uploads SPECIFICATION documents (PDF/JPEG/PNG, 20 MB) via presigned R2 PUT; `viewOrderAttachment` serves both SPECIFICATION and RESULT attachments to the owning CLIENT | Implementing or modifying spec upload or CLIENT attachment download |
 | `result-upload/`   | LAB_ADMIN uploads RESULT documents (PDF-only, 50 MB) via presigned R2 PUT; `viewResultAttachment` gated by `order.lab.ownerId` | Implementing or modifying result upload or LAB_ADMIN attachment download |
+| `dispute/`         | CLIENT opens a dispute on a COMPLETED order within the 14-day window (`DISPUTE_WINDOW_DAYS`); writes `Order.status=DISPUTED` + `OrderDispute` row atomically; ownership guard mirrors `acceptQuote` | Implementing or modifying the client dispute open flow |
+| `dispute-resolution/` | ADMIN resolves a DISPUTED order — list of open disputes + per-dispute detail; `resolveDispute` writes `DISPUTED->COMPLETED` or `DISPUTED->REFUND_PENDING` via updateMany CAS; layer-2 ADMIN re-check on every page and action | Implementing or modifying the admin dispute resolution flow |

```


### Milestone 3: Admin dispute-resolution slice — resolve a DISPUTED order in either direction

**Files**: src/features/orders/dispute-resolution/action.ts, src/features/orders/dispute-resolution/ui.tsx, src/features/orders/dispute-resolution/list-ui.tsx, src/features/orders/dispute-resolution/page.tsx, src/features/orders/dispute-resolution/__tests__/action.test.ts

**Requirements**:

- Admin list of open disputes + detail|Server Action resolves DISPUTED->COMPLETED (RESOLVED_COMPLETED) or DISPUTED->REFUND_PENDING (RESOLVED_REFUND)|Layer-2 ADMIN re-check independent of layout guard|Write resolution audit record (resolution resolvedAt resolvedById resolutionNote)|Document the ITA-compliant response-time SLA (2 business days to acknowledge
- 15 business days to resolve) in plans/T-19-dispute-redress.md and the slice README — policy only
- not code-enforced (DL-002 SHOULD)

**Acceptance Criteria**:

- Action re-checks session.user.role===ADMIN independently — non-admin rejected even past layout guard (layer-2 TOCTOU re-check DL-006)|RESOLVED_COMPLETED sets status=COMPLETED via isValidStatusTransition + writes OrderDispute resolution fields|RESOLVED_REFUND sets status=REFUND_PENDING (status only no refund executed) + writes resolution fields|resolvedById set from session.user.id; resolvedAt set; both directions auditable|no Prisma.Decimal/Date crosses RSC->client unserialized (.toFixed(2)/.toISOString(); DTO fields typed string)|no bare toLocaleString() in new client components (fixed locale+timeZone or RSC-side format)|redirect after try/catch; findUnique + null-guaranteed-relation-after-include throws

**Tests**:

- unit:src/features/orders/dispute-resolution/__tests__/action.test.ts — non-admin reject
- RESOLVED_COMPLETED path
- RESOLVED_REFUND path

#### Code Intent

- **CI-M-003-001** `src/features/orders/dispute-resolution/action.ts::resolveDispute`: Server Action: re-check session.user.role===ADMIN independently of the layout guard (layer-2 TOCTOU re-check decision DL-006 — distinct from the DL-001 completedAt-anchor decision; the layout guard is layer-1 only and does not protect Server Actions). Narrow formData (orderId, resolution, resolutionNote) via typeof===string. Inside $transaction: findUnique Order by @id with include of dispute; a null dispute after explicit include throws (referential integrity), a genuinely missing order -> notFound(). Map resolution: RESOLVED_COMPLETED -> target COMPLETED, RESOLVED_REFUND -> target REFUND_PENDING via an exhaustive dispatch (as const satisfies Record<DisputeResolution>). Guard isValidStatusTransition(DISPUTED, target); tx.order.update status=target; tx.orderDispute.update sets resolution, resolvedAt=new Date(), resolvedById=session.user.id, resolutionNote. No refund executed. redirect AFTER try/catch. (refs: DL-006, DL-007, DL-004)
- **CI-M-003-002** `src/features/orders/dispute-resolution/page.tsx::DisputeResolutionPage (RSC)`: Admin RSC (detail) that re-checks ADMIN, loads the disputed order + dispute via findUnique include, and serializes all Decimal (.toFixed(2)) and Date (.toISOString()) fields into a DTO with string-typed fields before passing to the client detail component. (refs: DL-006)
- **CI-M-003-003** `src/features/orders/dispute-resolution/list-ui.tsx::DisputeList (client)`: Client list of open disputes (status===DISPUTED) consuming a pre-serialized DTO (string dates/amounts). No bare toLocaleString(); fixed locale+timeZone or RSC-side formatting. (refs: DL-006)
- **CI-M-003-004** `src/features/orders/dispute-resolution/ui.tsx::DisputeResolutionForm (client)`: Client detail/resolution form: shows reason and offers RESOLVED_COMPLETED and RESOLVED_REFUND actions bound to resolveDispute, surfacing failure branches to a rendered error state. (refs: DL-006, DL-007)

#### Code Changes

**CC-M-003-001** (src/features/orders/dispute-resolution/action.ts) - implements CI-M-003-001

**Code:**

```diff
--- a/src/features/orders/dispute-resolution/action.ts
+++ b/src/features/orders/dispute-resolution/action.ts
@@ -0,0 +1,88 @@
+'use server'
+
+import { revalidatePath } from 'next/cache'
+import { redirect } from 'next/navigation'
+import { OrderStatus, DisputeResolution } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { isValidStatusTransition } from '@/domain/orders/state-machine'
+
+type ActionState = { message?: string } | null
+
+/**
+ * Resolves a DISPUTED order in either direction.
+ *
+ * Authorization: ADMIN role re-checked here independently of the layout guard.
+ * The layout guard is layer-1 only; Server Actions are POST-invocable without
+ * navigating through the layout (TOCTOU, DL-006).
+ *
+ * Resolution: RESOLVED_COMPLETED -> DISPUTED->COMPLETED (payout hold lifted).
+ *             RESOLVED_REFUND    -> DISPUTED->REFUND_PENDING (refund manual).
+ *
+ * CAS: updateMany on Order.status===DISPUTED so two admins resolving concurrently
+ * results in the second write observing count===0 without clobbering the first.
+ * OrderDispute.resolvedAt is also written atomically inside the same $transaction.
+ */
+export async function resolveDispute(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderIdValue = formData.get('orderId')
+  const resolutionValue = formData.get('resolution')
+
+  const orderId = typeof orderIdValue === 'string' ? orderIdValue : null
+  const resolution = typeof resolutionValue === 'string' ? resolutionValue : null
+
+  if (!orderId) return { message: 'Missing order ID.' }
+  if (
+    resolution !== DisputeResolution.RESOLVED_COMPLETED &&
+    resolution !== DisputeResolution.RESOLVED_REFUND
+  ) {
+    return { message: 'Invalid resolution value.' }
+  }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const targetStatus =
+    resolution === DisputeResolution.RESOLVED_COMPLETED
+      ? OrderStatus.COMPLETED
+      : OrderStatus.REFUND_PENDING
+
+  if (!isValidStatusTransition(OrderStatus.DISPUTED, targetStatus)) {
+    throw new Error(`resolveDispute: unexpected targetStatus ${targetStatus} — state-machine contract violated`)
+  }
+
+  let result: ActionState = null
+  let shouldRedirect = false
+
+  try {
+    await prisma.$transaction(async (tx) => {
+      const updateResult = await tx.order.updateMany({
+        where: { id: orderId, status: OrderStatus.DISPUTED },
+        data: { status: targetStatus },
+      })
+
+      if (updateResult.count === 0) {
+        result = { message: 'Order is no longer in DISPUTED status — resolution may have already been recorded.' }
+        return
+      }
+
+      await tx.orderDispute.update({
+        where: { orderId },
+        data: {
+          resolution,
+          resolvedAt: new Date(),
+          resolvedById: session.user.id,
+        },
+      })
+
+      shouldRedirect = true
+    })
+  } catch (e) {
+    throw new Error(`resolveDispute transaction failed: ${e instanceof Error ? e.message : String(e)}`)
+  }
+
+  if (result !== null) return result
+
+  revalidatePath('/dashboard/admin/disputes')
+
+  if (shouldRedirect) {
+    redirect('/dashboard/admin/disputes')
+  }
+
+  return null
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute-resolution/action.ts
+++ b/src/features/orders/dispute-resolution/action.ts
@@ -370,6 +370,8 @@ export async function resolveDispute(
   try {
     await prisma.$transaction(async (tx) => {
       const updateResult = await tx.order.updateMany({
+        // CAS write: where predicate locks on status===DISPUTED so a second
+        // concurrent resolution sees count===0 and returns without clobbering (ref: DL-005).
         where: { id: orderId, status: OrderStatus.DISPUTED },
         data: { status: targetStatus },
       })

```


**CC-M-003-002** (src/features/orders/dispute-resolution/page.tsx) - implements CI-M-003-002

**Code:**

```diff
--- a/src/features/orders/dispute-resolution/page.tsx
+++ b/src/features/orders/dispute-resolution/page.tsx
@@ -0,0 +1,80 @@
+import { notFound, redirect } from 'next/navigation'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { DisputeResolutionForm } from './ui'
+import { DisputeListUi } from './list-ui'
+
+export type DisputedOrderDTO = {
+  id: string
+  serviceName: string
+  labName: string
+  clientEmail: string
+  quotedPrice: string | null
+  completedAt: string | null
+  disputeReason: string
+  disputeOpenedAt: string
+}
+
+export type DisputeDetailDTO = DisputedOrderDTO & {
+  disputeId: string
+}
+
+/**
+ * List route: /dashboard/admin/disputes
+ * Auth: ADMIN role re-checked here (layer-2 TOCTOU; layout is layer-1 only).
+ */
+export async function DisputeListPage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const orders = await prisma.order.findMany({
+    where: { status: OrderStatus.DISPUTED },
+    include: {
+      service: { select: { name: true } },
+      lab: { select: { name: true } },
+      client: { select: { email: true } },
+      dispute: true,
+    },
+    orderBy: { updatedAt: 'asc' },
+  })
+
+  const rows: DisputedOrderDTO[] = orders.map((o) => {
+    if (!o.dispute) throw new Error(`Order ${o.id} DISPUTED but OrderDispute missing after explicit include — referential integrity violation`)
+    return {
+      id: o.id,
+      serviceName: o.service.name,
+      labName: o.lab.name,
+      clientEmail: o.client.email,
+      quotedPrice: o.quotedPrice != null ? o.quotedPrice.toFixed(2) : null,
+      completedAt: o.completedAt ? o.completedAt.toISOString() : null,
+      disputeReason: o.dispute.reason,
+      disputeOpenedAt: o.dispute.openedAt.toISOString(),
+    }
+  })
+
+  return <DisputeListUi rows={rows} />
+}
+
+export default async function DisputeDetailPage({
+  params,
+}: {
+  params: { orderId: string }
+}) {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: params.orderId },
+    include: {
+      service: { select: { name: true } },
+      lab: { select: { name: true } },
+      client: { select: { email: true } },
+      dispute: true,
+    },
+  })
+
+  if (!order) notFound()
+  if (!order.dispute) throw new Error('Order.dispute missing after explicit include — referential integrity violation for DISPUTED order')
+
+  const dto: DisputeDetailDTO = {
+    id: order.id,
+    disputeId: order.dispute.id,
+    serviceName: order.service.name,
+    labName: order.lab.name,
+    clientEmail: order.client.email,
+    quotedPrice: order.quotedPrice != null ? order.quotedPrice.toFixed(2) : null,
+    completedAt: order.completedAt ? order.completedAt.toISOString() : null,
+    disputeReason: order.dispute.reason,
+    disputeOpenedAt: order.dispute.openedAt.toISOString(),
+  }
+
+  return <DisputeResolutionForm dto={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute-resolution/page.tsx
+++ b/src/features/orders/dispute-resolution/page.tsx
@@ -6,6 +6,10 @@ import { DisputeResolutionForm } from './ui'
 import { DisputeListUi } from './list-ui'
 
+/**
+ * All Date/Decimal fields serialized before crossing the RSC boundary.
+ * completedAt is null for orders that predate the dispute-window feature; treat as out-of-window (ref: DL-010).
+ * quotedPrice is null when no quote was accepted.
+ */
 export type DisputedOrderDTO = {
   id: string
   serviceName: string
   labName: string
   clientEmail: string
   quotedPrice: string | null
   completedAt: string | null
   disputeReason: string
   disputeOpenedAt: string
 }
@@ -484,6 +484,12 @@ export async function DisputeListPage() {
   return <DisputeListUi rows={rows} />
 }
 
+/**
+ * Detail route: /dashboard/admin/disputes/[orderId]
+ * Auth: ADMIN role re-checked here (layer-2 TOCTOU; layout is layer-1 only, ref: DL-006).
+ * Null order -> notFound(); null dispute after explicit include -> throws
+ * (referential integrity violation, not a missing-row scenario).
+ */
 export default async function DisputeDetailPage({
   params,
 }: {
   params: { orderId: string }
 }) {

```


**CC-M-003-003** (src/features/orders/dispute-resolution/list-ui.tsx) - implements CI-M-003-003

**Code:**

```diff
--- a/src/features/orders/dispute-resolution/list-ui.tsx
+++ b/src/features/orders/dispute-resolution/list-ui.tsx
@@ -0,0 +1,55 @@
+'use client'
+
+import Link from 'next/link'
+import type { DisputedOrderDTO } from './page'
+
+export function DisputeListUi({ rows }: { rows: DisputedOrderDTO[] }) {
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <h1 className="text-2xl font-bold text-gray-900">Disputes</h1>
+          <p className="mt-1 text-sm text-gray-500">
+            {rows.length === 0
+              ? 'No open disputes.'
+              : `${rows.length} open dispute${rows.length === 1 ? '' : 's'}.`}
+          </p>
+        </div>
+
+        {rows.length > 0 && (
+          <div className="bg-white rounded-lg shadow overflow-hidden">
+            <table className="min-w-full divide-y divide-gray-200">
+              <thead className="bg-gray-50">
+                <tr>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lab</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Opened</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
+                </tr>
+              </thead>
+              <tbody className="bg-white divide-y divide-gray-200">
+                {rows.map((row) => (
+                  <tr key={row.id}>
+                    <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-700">
+                      {row.id.slice(0, 12)}&hellip;
+                    </td>
+                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.labName}</td>
+                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.clientEmail}</td>
+                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.quotedPrice ?? '—'}</td>
+                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
+                      {new Date(row.disputeOpenedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
+                    </td>
+                    <td className="px-6 py-4 whitespace-nowrap text-sm">
+                      <Link
+                        href={`/dashboard/admin/disputes/${row.id}`}
+                        className="text-blue-600 hover:text-blue-800 font-medium"
+                      >
+                        Resolve
+                      </Link>
+                    </td>
+                  </tr>
+                ))}
+              </tbody>
+            </table>
+          </div>
+        )}
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute-resolution/list-ui.tsx
+++ b/src/features/orders/dispute-resolution/list-ui.tsx
@@ -1,5 +1,9 @@
 'use client'
 
+/**
+ * Admin dispute list. Consumes pre-serialized DisputedOrderDTO (string dates/amounts).
+ * Dates rendered with fixed locale + timeZone ('en-PH', 'Asia/Manila') —
+ * bare toLocaleString() is forbidden in client components (CLAUDE.md discipline).
+ */
 import Link from 'next/link'
 import type { DisputedOrderDTO } from './page'

```


**CC-M-003-004** (src/features/orders/dispute-resolution/ui.tsx) - implements CI-M-003-004

**Code:**

```diff
--- a/src/features/orders/dispute-resolution/ui.tsx
+++ b/src/features/orders/dispute-resolution/ui.tsx
@@ -0,0 +1,75 @@
+'use client'
+
+import { useActionState } from 'react'
+import { resolveDispute } from './action'
+import type { DisputeDetailDTO } from './page'
+
+export function DisputeResolutionForm({ dto }: { dto: DisputeDetailDTO }) {
+  const [resolveCompletedState, resolveCompletedAction, resolveCompletedPending] =
+    useActionState(resolveDispute, null)
+  const [resolveRefundState, resolveRefundAction, resolveRefundPending] =
+    useActionState(resolveDispute, null)
+
+  const isPending = resolveCompletedPending || resolveRefundPending
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
+        <div className="mb-4">
+          <a href="/dashboard/admin/disputes" className="text-sm text-blue-600 hover:underline">
+            ← Back to disputes
+          </a>
+        </div>
+        <h1 className="text-2xl font-bold text-gray-900">Resolve Dispute</h1>
+
+        <div className="bg-white rounded-lg shadow p-4">
+          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
+            <dt className="text-gray-500">Order ID</dt>
+            <dd className="text-gray-900 font-mono">{dto.id.slice(0, 12)}…</dd>
+            <dt className="text-gray-500">Lab</dt>
+            <dd className="text-gray-900">{dto.labName}</dd>
+            <dt className="text-gray-500">Client</dt>
+            <dd className="text-gray-900">{dto.clientEmail}</dd>
+            <dt className="text-gray-500">Amount</dt>
+            <dd className="text-gray-900">{dto.quotedPrice ?? '—'}</dd>
+            <dt className="text-gray-500">Dispute opened</dt>
+            <dd className="text-gray-900">
+              {new Date(dto.disputeOpenedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}
+            </dd>
+          </dl>
+        </div>
+
+        <div className="bg-white rounded-lg shadow p-4">
+          <h2 className="text-sm font-semibold text-gray-700 mb-2">Client&apos;s dispute reason</h2>
+          <p className="text-sm text-gray-800 whitespace-pre-wrap">{dto.disputeReason}</p>
+        </div>
+
+        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
+          <form action={resolveCompletedAction} className="bg-white rounded-lg shadow p-4">
+            <input type="hidden" name="orderId" value={dto.id} />
+            <input type="hidden" name="resolution" value="RESOLVED_COMPLETED" />
+            <h3 className="text-sm font-semibold text-gray-700 mb-3">Mark as resolved — no refund</h3>
+            <p className="text-xs text-gray-500 mb-3">Order returns to COMPLETED; payout hold is lifted.</p>
+            {resolveCompletedState?.message && (
+              <p className="text-sm text-red-600 mb-2">{resolveCompletedState.message}</p>
+            )}
+            <button
+              type="submit"
+              disabled={isPending}
+              className="w-full rounded-md bg-green-600 px-4 py-2 text-sm font-semibold text-white hover:bg-green-700 disabled:opacity-50"
+            >
+              {resolveCompletedPending ? 'Processing…' : 'Resolve — no refund'}
+            </button>
+          </form>
+
+          <form action={resolveRefundAction} className="bg-white rounded-lg shadow p-4">
+            <input type="hidden" name="orderId" value={dto.id} />
+            <input type="hidden" name="resolution" value="RESOLVED_REFUND" />
+            <h3 className="text-sm font-semibold text-gray-700 mb-3">Mark as resolved — issue refund</h3>
+            <p className="text-xs text-gray-500 mb-3">Order moves to REFUND_PENDING; refund processed separately.</p>
+            {resolveRefundState?.message && (
+              <p className="text-sm text-red-600 mb-2">{resolveRefundState.message}</p>
+            )}
+            <button
+              type="submit"
+              disabled={isPending}
+              className="w-full rounded-md bg-orange-600 px-4 py-2 text-sm font-semibold text-white hover:bg-orange-700 disabled:opacity-50"
+            >
+              {resolveRefundPending ? 'Processing…' : 'Resolve — issue refund'}
+            </button>
+          </form>
+        </div>
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/orders/dispute-resolution/ui.tsx
+++ b/src/features/orders/dispute-resolution/ui.tsx
@@ -1,5 +1,10 @@
 'use client'
 
+/**
+ * Admin dispute resolution form. Two separate useActionState instances share
+ * the same resolveDispute action so each submit button has its own pending/error
+ * state. Both error branches are surfaced to rendered text — no silent failures.
+ * Dates rendered with fixed locale + timeZone (ref: CLAUDE.md discipline).
+ */
 import { useActionState } from 'react'
 import { resolveDispute } from './action'
 import type { DisputeDetailDTO } from './page'

```


### Milestone 4: Payout hold — exclude DISPUTED orders from settlement

**Files**: src/features/payments/payouts/handlers.ts, src/features/payments/payouts/__tests__/handlers.test.ts

**Requirements**:

- processSettlement must not select or settle a QUEUED Payout whose Order.status is DISPUTED
- Preserve updateMany + count===0 CAS discipline

**Acceptance Criteria**:

- first-delivery findFirst predicate excludes orders where related Order.status===DISPUTED
- updateMany CAS write predicate also excludes DISPUTED so a concurrent delivery cannot settle a held payout
- count===0 early-return retained; no bare update introduced
- DISPUTED->COMPLETED re-permits settlement automatically (guard keys off current Order.status — no extra code)
- test mock method named identically to handler call (updateMany not update)

**Tests**:

- unit:src/features/payments/payouts/__tests__/handlers.test.ts — settlement skips DISPUTED order
- settles after DISPUTED->COMPLETED
- mock named identically to handler call

#### Code Intent

- **CI-M-004-001** `src/features/payments/payouts/handlers.ts::processSettlement`: The first-delivery findFirst predicate gains a relation filter excluding orders whose related Order.status===DISPUTED (e.g. order: { status: { not: DISPUTED } }), so a held QUEUED Payout is not selected. The updateMany CAS write predicate also excludes DISPUTED (compare-and-set still keyed on id + externalPayoutId=null), preserving count===0 early-return; no bare update introduced. DISPUTED->COMPLETED automatically re-permits settlement because the guard reads current Order.status. (refs: DL-005)

#### Code Changes

**CC-M-004-001** (src/features/payments/payouts/handlers.ts) - implements CI-M-004-001

**Code:**

```diff
--- a/src/features/payments/payouts/handlers.ts
+++ b/src/features/payments/payouts/handlers.ts
@@ -7,7 +7,7 @@ import type { XenditSettlementPayload } from './types'
-import { PayoutStatus } from '@prisma/client'
+import { PayoutStatus, OrderStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import type { XenditSettlementPayload } from './types'
@@ -57,9 +57,14 @@ export async function processSettlement(payload: XenditSettlementPayload): Promi
     if (!payout) {
       payout = await tx.payout.findFirst({
         where: {
           orderId: payload.external_id,
           status: PayoutStatus.QUEUED,
           externalPayoutId: null,
+          // Exclude payouts on DISPUTED orders — the hold is lifted when admin
+          // resolves to COMPLETED (status transitions back) or REFUND_PENDING.
+          order: { status: { not: OrderStatus.DISPUTED } },
         },
       })
 
@@ -104,7 +104,8 @@ export async function processSettlement(payload: XenditSettlementPayload): Promi
     const updateResult = await tx.payout.updateMany({
-      where: { id: payout.id, externalPayoutId: null },
+      where: { id: payout.id, externalPayoutId: null, order: { status: { not: OrderStatus.DISPUTED } } },
       data: {
         status: PayoutStatus.COMPLETED,
         externalPayoutId: payload.id,
         completedAt: new Date(),
       },
     })
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/handlers.ts
+++ b/src/features/payments/payouts/handlers.ts
@@ -57,9 +57,14 @@ export async function processSettlement(payload: XenditSettlementPayload): Promi
     if (!payout) {
       payout = await tx.payout.findFirst({
         where: {
           orderId: payload.external_id,
           status: PayoutStatus.QUEUED,
           externalPayoutId: null,
           // Exclude payouts on DISPUTED orders — the hold is lifted when admin
           // resolves to COMPLETED (status transitions back) or REFUND_PENDING.
+          // Applied to BOTH the first-delivery lookup AND the CAS updateMany
+          // predicate so disputed orders are excluded at both checkpoints (ref: DL-005, R-001).
           order: { status: { not: OrderStatus.DISPUTED } },
         },
       })
@@ -104,7 +104,8 @@ export async function processSettlement(payload: XenditSettlementPayload): Promi
     const updateResult = await tx.payout.updateMany({
+      // CAS predicate: order.status checked here as well as in findFirst to
+      // prevent a race where status changes between lookup and write (ref: DL-005).
       where: { id: payout.id, externalPayoutId: null, order: { status: { not: OrderStatus.DISPUTED } } },
       data: {
         status: PayoutStatus.COMPLETED,
         externalPayoutId: payload.id,
         completedAt: new Date(),
       },
     })

```


**CC-M-004-002** (src/features/payments/payouts/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/payments/payouts/CLAUDE.md
+++ b/src/features/payments/payouts/CLAUDE.md
@@ -9,6 +9,9 @@ Xendit commission settlement webhook slice — dormant until checkout migrates t
 | `route.ts` | Next.js POST; x-callback-token via timingSafeEqual against XENDIT_SETTLEMENT_WEBHOOK_TOKEN; COMPLETED dispatches to processSettlement | Modifying webhook auth or adding settlement statuses |
 | `handlers.ts` | `processSettlement` — three-layer idempotency (IdempotencyKey table + COMPLETED early-return + updateMany CAS); Payout QUEUED -> COMPLETED; LabWallet pendingBalance decrement + availableBalance increment in one $transaction | Modifying settlement logic, idempotency behavior, or balance invariants |
+
+## Payout Hold (T-19)
+
+`processSettlement` excludes payouts whose related `Order.status === DISPUTED` from both the first-delivery `findFirst` lookup and the `updateMany` CAS write. The hold lifts automatically when admin resolves the dispute (status returns to `COMPLETED` or advances to `REFUND_PENDING`). Any modification to the `findFirst` or `updateMany` predicates in `handlers.ts` must preserve the `order: { status: { not: OrderStatus.DISPUTED } }` relation filter on both clauses.
+
 | `types.ts` | `XenditSettlementPayload` — provisional field shape; all fields marked TODO(sandbox-verify) | Adding fields from Xendit payload |
 | `README.md` | Request flow, AD-001 framing, two-ID scheme, three-layer idempotency design, invariants, production wiring | Understanding settlement lifecycle or debugging |
 | `__tests__/handlers.test.ts` | Real-DB integration: first delivery, idempotent duplicate (COMPLETED early-return), IdempotencyKey dedup (Layer 1 early-return), IdempotencyKey creation atomicity, orphan tolerance, negative-balance guard, PROCESSING contract violation | Running or modifying settlement integration tests |

```


### Milestone 5: OrderStatus badge maps — add DISPUTED label across exhaustive maps

**Files**: src/features/admin/order-oversight/ui.tsx, src/features/admin/order-oversight/detail-ui.tsx, src/features/clients/dashboard/ui.tsx, src/features/orders/order-detail/page.tsx

**Requirements**:

- Add DISPUTED entry to all exhaustively-typed OrderStatus maps
- Migrate touched non-satisfies maps to as const satisfies per compounding rule

**Acceptance Criteria**:

- DISPUTED entry added to the 2 as-const-satisfies Record<OrderStatus> maps (order-oversight ui.tsx detail-ui.tsx)
- DISPUTED entry added to the 2 annotated : Record<OrderStatus> maps (clients dashboard ui.tsx order-detail page.tsx)
- touched non-satisfies maps migrated to as const satisfies Record<OrderStatus>
- order-detail page.tsx intentional ?? fallback preserved (deploy-safety — not removed)
- order-detail page.tsx Partial<Record<OrderStatus>> step/timeline maps hand-audited for whether DISPUTED needs a step
- npx tsc --noEmit clean

**Tests**:

- unit:src/features/orders/order-detail/__tests__/status-badge.test.ts — iterate every OrderStatus enum member and assert statusBadgeConfig has a defined non-fallback entry for each (exhaustiveness guard
- R-002)

#### Code Intent

- **CI-M-005-001** `src/features/admin/order-oversight/ui.tsx::status badge map (as const satisfies Record<OrderStatus>)`: The OrderStatus badge map gains a DISPUTED entry (label + className). Map remains as const satisfies Record<OrderStatus, ...> so omission would be a compile error. (refs: DL-008)
- **CI-M-005-002** `src/features/admin/order-oversight/detail-ui.tsx::status badge map (as const satisfies Record<OrderStatus>)`: The OrderStatus badge map gains a DISPUTED entry, preserving the as const satisfies Record<OrderStatus> typing. (refs: DL-008)
- **CI-M-005-003** `src/features/clients/dashboard/ui.tsx::status label map (: Record<OrderStatus>)`: The exhaustively-annotated OrderStatus label map gains a DISPUTED entry; the map is migrated to as const satisfies Record<OrderStatus> per the compounding rule. (refs: DL-008)
- **CI-M-005-004** `src/features/orders/order-detail/page.tsx::statusBadgeConfig + step/timeline meta maps`: statusBadgeConfig (annotated Record<OrderStatus>) gains a DISPUTED entry; its intentional ?? fallback is preserved as deploy-safety and not removed. The Partial<Record<OrderStatus>> step/timeline meta maps are hand-audited for whether DISPUTED warrants a timeline step; add one only if the timeline should render the disputed state. (refs: DL-008)

#### Code Changes

**CC-M-005-001** (src/features/admin/order-oversight/ui.tsx) - implements CI-M-005-001

**Code:**

```diff
--- a/src/features/admin/order-oversight/ui.tsx
+++ b/src/features/admin/order-oversight/ui.tsx
@@ -19,6 +19,7 @@ const STATUS_BADGE = {
   COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
+  DISPUTED:         { label: 'Disputed',         className: 'bg-amber-200 text-amber-800' },
   CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
   REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
   REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
 } as const satisfies Record<OrderStatus, { label: string; className: string }>
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/ui.tsx
+++ b/src/features/admin/order-oversight/ui.tsx
@@ -19,6 +19,8 @@ const STATUS_BADGE = {
   COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
+  // amber-200 visually distinct from green (COMPLETED) and orange (REFUND_PENDING) (ref: DL-008).
   DISPUTED:         { label: 'Disputed',         className: 'bg-amber-200 text-amber-800' },
   CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
   REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
   REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
 } as const satisfies Record<OrderStatus, { label: string; className: string }>

```


**CC-M-005-002** (src/features/admin/order-oversight/detail-ui.tsx) - implements CI-M-005-002

**Code:**

```diff
--- a/src/features/admin/order-oversight/detail-ui.tsx
+++ b/src/features/admin/order-oversight/detail-ui.tsx
@@ -19,6 +19,7 @@ const ORDER_STATUS_BADGE = {
   COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
+  DISPUTED:         { label: 'Disputed',         className: 'bg-amber-200 text-amber-800' },
   CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
   REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
   REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
 } as const satisfies Record<OrderStatus, { label: string; className: string }>
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/detail-ui.tsx
+++ b/src/features/admin/order-oversight/detail-ui.tsx
@@ -19,6 +19,8 @@ const ORDER_STATUS_BADGE = {
   COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
+  // amber-200: visual distinction from adjacent COMPLETED (green-200) and REFUND_PENDING (orange-100) (ref: DL-008).
   DISPUTED:         { label: 'Disputed',         className: 'bg-amber-200 text-amber-800' },
   CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
   REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
   REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
 } as const satisfies Record<OrderStatus, { label: string; className: string }>

```


**CC-M-005-003** (src/features/clients/dashboard/ui.tsx) - implements CI-M-005-003

**Code:**

```diff
--- a/src/features/clients/dashboard/ui.tsx
+++ b/src/features/clients/dashboard/ui.tsx
@@ -26,7 +26,8 @@ const statusBadgeConfig: Record<OrderStatus, { label: string; className: string
-const statusBadgeConfig: Record<OrderStatus, { label: string; className: string }> = {
+const statusBadgeConfig = {
   [OrderStatus.QUOTE_REQUESTED]: { label: 'Quote Requested', className: 'bg-gray-100 text-gray-700' },
   [OrderStatus.QUOTE_PROVIDED]: { label: 'Quote Provided', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.QUOTE_REJECTED]: { label: 'Quote Rejected', className: 'bg-red-100 text-red-800' },
   [OrderStatus.PENDING]: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.PAYMENT_FAILED]: { label: 'Payment Failed', className: 'bg-red-100 text-red-800' },
   [OrderStatus.ACKNOWLEDGED]: { label: 'Acknowledged', className: 'bg-blue-100 text-blue-800' },
   [OrderStatus.IN_PROGRESS]: { label: 'In Progress', className: 'bg-blue-100 text-blue-800' },
   [OrderStatus.COMPLETED]: { label: 'Completed', className: 'bg-green-100 text-green-800' },
+  [OrderStatus.DISPUTED]: { label: 'Disputed', className: 'bg-amber-100 text-amber-800' },
   [OrderStatus.CANCELLED]: { label: 'Cancelled', className: 'bg-red-100 text-red-800' },
   [OrderStatus.REFUND_PENDING]: { label: 'Refund Pending', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.REFUNDED]: { label: 'Refunded', className: 'bg-gray-100 text-gray-700' },
-}
+} as const satisfies Record<OrderStatus, { label: string; className: string }>
```

**Documentation:**

```diff
--- a/src/features/clients/dashboard/ui.tsx
+++ b/src/features/clients/dashboard/ui.tsx
@@ -26,7 +26,11 @@ const statusBadgeConfig: Record<OrderStatus, { label: string; className: string
+// `as const satisfies Record<OrderStatus>` ensures a missing enum member is
+// a compile-time error, not a silent runtime miss (ref: DL-008).
 const statusBadgeConfig = {
   [OrderStatus.QUOTE_REQUESTED]: { label: 'Quote Requested', className: 'bg-gray-100 text-gray-700' },
   [OrderStatus.QUOTE_PROVIDED]: { label: 'Quote Provided', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.QUOTE_REJECTED]: { label: 'Quote Rejected', className: 'bg-red-100 text-red-800' },
   [OrderStatus.PENDING]: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.PAYMENT_FAILED]: { label: 'Payment Failed', className: 'bg-red-100 text-red-800' },
   [OrderStatus.ACKNOWLEDGED]: { label: 'Acknowledged', className: 'bg-blue-100 text-blue-800' },
   [OrderStatus.IN_PROGRESS]: { label: 'In Progress', className: 'bg-blue-100 text-blue-800' },
   [OrderStatus.COMPLETED]: { label: 'Completed', className: 'bg-green-100 text-green-800' },
   [OrderStatus.DISPUTED]: { label: 'Disputed', className: 'bg-amber-100 text-amber-800' },
   [OrderStatus.CANCELLED]: { label: 'Cancelled', className: 'bg-red-100 text-red-800' },
   [OrderStatus.REFUND_PENDING]: { label: 'Refund Pending', className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.REFUNDED]: { label: 'Refunded', className: 'bg-gray-100 text-gray-700' },
 } as const satisfies Record<OrderStatus, { label: string; className: string }>

```


**CC-M-005-004** (src/features/orders/order-detail/page.tsx) - implements CI-M-005-004

**Code:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -24,6 +24,7 @@ const statusBadgeConfig: Record<OrderStatus, { label: string; className: string
   [OrderStatus.IN_PROGRESS]:     { label: 'In Progress',     className: 'bg-blue-100 text-blue-800' },
   [OrderStatus.COMPLETED]:       { label: 'Completed',       className: 'bg-green-100 text-green-800' },
+  [OrderStatus.DISPUTED]:        { label: 'Disputed',        className: 'bg-amber-100 text-amber-800' },
   [OrderStatus.CANCELLED]:       { label: 'Cancelled',       className: 'bg-red-100 text-red-800' },
   [OrderStatus.REFUND_PENDING]:  { label: 'Refund Pending',  className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.REFUNDED]:        { label: 'Refunded',        className: 'bg-gray-100 text-gray-700' },
 }
```

**Documentation:**

```diff
--- a/src/features/orders/order-detail/page.tsx
+++ b/src/features/orders/order-detail/page.tsx
@@ -24,6 +24,7 @@ const statusBadgeConfig: Record<OrderStatus, { label: string; className: string
   [OrderStatus.IN_PROGRESS]:     { label: 'In Progress',     className: 'bg-blue-100 text-blue-800' },
   [OrderStatus.COMPLETED]:       { label: 'Completed',       className: 'bg-green-100 text-green-800' },
+  // amber-100: distinct from COMPLETED (green) and REFUND_PENDING (yellow).
   [OrderStatus.DISPUTED]:        { label: 'Disputed',        className: 'bg-amber-100 text-amber-800' },
   [OrderStatus.CANCELLED]:       { label: 'Cancelled',       className: 'bg-red-100 text-red-800' },
   [OrderStatus.REFUND_PENDING]:  { label: 'Refund Pending',  className: 'bg-yellow-100 text-yellow-800' },
   [OrderStatus.REFUNDED]:        { label: 'Refunded',        className: 'bg-gray-100 text-gray-700' },
+  // ?? fallback below is intentional deploy-safety for the migration<->client-regen window
+  // and must not be removed (ref: DL-008, invisible_knowledge).
 }

```


## README Entries

### src/features/orders/dispute/README.md

## Dispute & Redress (ITA 2023 IDRM)

A CLIENT may dispute a COMPLETED order within `DISPUTE_WINDOW_DAYS` (14 days from `Order.completedAt`). An ADMIN resolves each dispute in either direction (`RESOLVED_COMPLETED` or `RESOLVED_REFUND`); the lab payout is held while the dispute is open.

**Response-time SLA (documented, not code-enforced):** In line with ITA 2023 internal dispute & redress expectations, the platform commits to acknowledging a filed dispute within **2 business days** and issuing an admin resolution within **15 business days** of filing. This SLA is operational policy only — T-19 does not implement code-enforced SLA timers (deferred). Track it via the `OrderDispute.openedAt`/`resolvedAt` timestamps for later reporting.

**Legacy orders:** Orders that reached COMPLETED before `Order.completedAt` existed carry `completedAt = null`. The dispute action treats a null `completedAt` as out-of-window and rejects the dispute with an explicit error rather than crashing or silently bypassing the window. No historical backfill is performed in T-19 (see DL-010).

## Execution Waves

- W-001: M-001
- W-002: M-002, M-003, M-004, M-005
