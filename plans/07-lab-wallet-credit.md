# Plan

## Overview

processPaymentCapture marks Transaction CAPTURED and advances Order status but never credits the lab wallet — labs receive no earnings from completed payments

**Approach**: Add Order fetch (for labId) and LabWallet upsert (incrementing pendingBalance by Transaction.amount) inside the existing prisma.$transaction in processPaymentCapture, after the handlePaymentCaptured fan-out call

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Inline LabWallet upsert in processPaymentCapture after handlePaymentCaptured call | Task scope restricts to handlers.ts only -> no new files or cross-slice imports -> inline upsert is the minimal change that satisfies atomicity within existing $transaction |
| DL-002 | Credit pendingBalance via Prisma increment, not availableBalance | Schema comment at prisma/schema.prisma:295-296 states pendingBalance credited at capture time -> availableBalance only at Payout COMPLETED -> crediting availableBalance violates wallet lifecycle invariant |
| DL-003 | Use Transaction.amount (Decimal) as credit amount, not payload.paid_amount (float) | Existing handlers.ts line 50-51 documents float-safety: Transaction.amount is the validated Decimal set at checkout creation; payload.paid_amount is a float from Xendit API and carries drift risk for financial amounts. This is consistent with the codebase's established pattern. |
| DL-004 | Fetch Order via tx.order.findUnique for labId rather than modifying PaymentCapturedEvent | Adding labId to PaymentCapturedEvent broadens domain kernel interface -> Order fetch within same transaction is read-consistent (same-tx buffer) and cheap at MVP order volumes -> stays within webhook slice boundary per VSA rules; double-read tradeoff documented in invisible_knowledge |
| DL-005 | Use upsert (not update) for LabWallet row | LabWallet row may not exist for a lab receiving first payment -> update would throw on missing row -> upsert creates with pendingBalance=amount if absent, increments if present -> safe for first-payment scenario |
| DL-006 | Throw on Order-not-found at LabWallet step as defensive guard | handlePaymentCaptured throws on missing Order first (codebase throw-on-integrity-violation pattern, see handle-payment-captured/handler.ts) -> LabWallet Order fetch throw is theoretically unreachable -> defensive throw is consistent and rolls back $transaction for Xendit retry |
| DL-007 | Idempotency on Xendit retry is guaranteed by the existing CAPTURED guard before any writes | processPaymentCapture already returns early (no writes) if Transaction.status === CAPTURED -> a Xendit retry after successful capture hits the idempotency guard and exits before reaching the LabWallet upsert -> no double-credit risk; no additional guard needed on the upsert itself |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Create src/features/wallets/credit-wallet/handler.ts and call it from handlers.ts | User spec requires keeping changes strictly within the webhook slice; also introduces a new cross-slice import from payments to a hypothetical wallets slice, violating VSA boundary rules (ref: DL-001) |
| Add labId to PaymentCapturedEvent domain type and carry it through the event | Broadens domain kernel interface scope beyond payment capture semantics; Order fetch in handlers.ts is simpler and stays within slice boundary (ref: DL-004) |
| Use Order.quotedPrice instead of Transaction.amount for credit amount | quotedPrice can be null for QUOTE_REQUIRED orders; Transaction.amount is the validated, float-safe Decimal set at checkout creation (ref: DL-003) |
| Credit availableBalance instead of pendingBalance | Schema invariant (prisma/schema.prisma:296): pendingBalance is credited at capture time; availableBalance is credited only when Payout reaches COMPLETED; crediting availableBalance skips the payout lifecycle (ref: DL-002) |

### Constraints

- MUST: LabWallet upsert must execute inside the existing prisma.$transaction in processPaymentCapture — atomicity with Transaction and Order updates is non-negotiable
- MUST: credit LabWallet.pendingBalance, not availableBalance — schema lifecycle invariant
- MUST: use Transaction.amount (Decimal) as credit amount, not payload.paid_amount (float) — float-safety invariant
- MUST: use upsert not update — LabWallet row may not exist for first payment
- MUST: throw on Order-not-found at LabWallet step (defensive guard, rolls back $transaction for Xendit retry)
- MUST-NOT: import from any other feature slice for this addition — VSA boundary rule
- SHOULD: fetch Order via transaction.orderId to obtain labId without modifying domain event types

### Known Risks

- **Double LabWallet credit on Xendit retry**: Mitigated by existing CAPTURED idempotency guard at top of $transaction — retried requests exit before any writes if Transaction is already CAPTURED
- **Order double-read within same transaction (once in handlePaymentCaptured, once for labId)**: Acceptable at MVP order volumes; PostgreSQL read-consistency within a transaction means both reads see the same snapshot; can be eliminated later if needed
- **LabWallet upsert Prisma error (e.g., DB connection loss mid-transaction)**: $transaction rollback is sufficient — any throw at any step rolls back all three writes atomically; Xendit retries on 500 and the full capture is safely reattempted

## Invisible Knowledge

### System

Transaction.amount is a Prisma Decimal type — passing it directly to Prisma's { increment: amount } on a Decimal field is type-correct and float-safe with no conversion needed. LabWallet.labId is @unique in the schema (prisma/schema.prisma:299), making it a safe upsert key with no race condition because the $transaction holds a row lock.

### Invariants

- The $transaction boundary means any throw at any step (Transaction update, handlePaymentCaptured, LabWallet upsert) rolls back all three writes atomically — Xendit's retry on 500 safely reattempts the full capture
- LabWallet.labId is @unique (prisma/schema.prisma:299) — upsert by labId is safe and race-free inside the $transaction
- Order.labId is a required non-nullable field (prisma/schema.prisma:179: labId String, no ?) — labId is guaranteed to be present for any Order row; no null-guard needed on order.labId
- The existing CAPTURED guard (Transaction.status === CAPTURED check before any write) prevents double-credit on Xendit retry — no additional idempotency logic is needed on the LabWallet upsert

### Tradeoffs

- LabWallet credit is inlined in handlers.ts rather than extracted to a separate wallets/credit-wallet/handler.ts slice — accepted per user scope constraint; ADR-001 example names creditLabWallet from a wallets slice but that pattern is aspirational documentation, not a binding constraint
- Order is fetched twice within the same $transaction: once inside handlePaymentCaptured (for status transition) and once in handlers.ts (for labId) — accepted at MVP scale; PostgreSQL same-transaction read-consistency means both reads see the same snapshot at negligible cost

## Milestones

### Milestone 1: Credit LabWallet.pendingBalance in processPaymentCapture

**Files**: src/features/payments/webhooks/handlers.ts

**Requirements**:

- When processPaymentCapture successfully marks a Transaction as CAPTURED, the corresponding lab's LabWallet.pendingBalance must be incremented by Transaction.amount within the same $transaction
- If no LabWallet row exists for the lab, one must be created (upsert pattern)
- The operation must be idempotent: a Xendit retry after successful capture must not double-credit the wallet
- All writes (Transaction, Order status, LabWallet) must be atomic — partial failure of any step must roll back all writes

**Acceptance Criteria**:

- After a payment capture, LabWallet.pendingBalance for the lab is incremented by exactly Transaction.amount (Decimal)
- If LabWallet row does not exist for the lab, it is created with pendingBalance=Transaction.amount
- A second invocation with the same Xendit payload (retry) produces no change to LabWallet.pendingBalance — CAPTURED guard exits before any write
- If LabWallet upsert throws, Transaction and Order updates are also rolled back — no partial state persisted
- No new imports from any feature slice other than the existing @/features/orders/handle-payment-captured/handler
- TypeScript compiles without errors (npx tsc --noEmit)

#### Code Intent

- **CI-M-001-001** `src/features/payments/webhooks/handlers.ts::processPaymentCapture`: After handlePaymentCaptured(event, tx) call: fetch Order via tx.order.findUnique({ where: { id: transaction.orderId } }) to obtain labId. Throw new Error if Order not found (defensive guard — consistent with codebase throw-on-integrity-violation pattern; rolls back $transaction for Xendit retry). Upsert LabWallet: tx.labWallet.upsert({ where: { labId: order.labId }, create: { labId: order.labId, pendingBalance: transaction.amount }, update: { pendingBalance: { increment: transaction.amount } } }). Use transaction.amount (Decimal), not payload.paid_amount (float). All operations remain inside the existing prisma.$transaction closure. Update module-level JSDoc to reflect three-write fan-out (Transaction, Order, LabWallet). Add inline comments per documentation section. (refs: DL-001, DL-002, DL-003, DL-004, DL-005, DL-006, DL-007)

#### Code Changes

**CC-M-001-001** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-001

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -61,4 +61,21 @@
     // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
     await handlePaymentCaptured(event, tx)
+
+    // Fetch Order for labId — Order.labId is non-nullable; same-tx fetch is read-consistent. (ref: DL-004)
+    const order = await tx.order.findUnique({
+      where: { id: transaction.orderId },
+      select: { labId: true },
+    })
+
+    if (!order) {
+      throw new Error(`Order not found for orderId ${transaction.orderId} during LabWallet credit`)
+    }
+
+    // Credit LabWallet.pendingBalance — upsert creates on first payment, increments on subsequent.
+    // Uses Transaction.amount (Decimal) not payload float. (ref: DL-002, DL-003, DL-005)
+    await tx.labWallet.upsert({
+      where: { labId: order.labId },
+      update: { pendingBalance: { increment: transaction.amount } },
+      create: { labId: order.labId, pendingBalance: transaction.amount },
+    })
   })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -1,7 +1,8 @@
 /**
  * Payment capture processor for Xendit invoice webhooks.
  *
- * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
- * idempotency check, Transaction update, and Order update are atomic.
- * Errors propagate as 500 so Xendit retries on transient DB failures. (ref: DL-004, DL-006)
+ * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
+ * idempotency check, Transaction update, Order status transition, and LabWallet credit are atomic.
+ * Any throw at any step rolls back all writes; Xendit retries on 500 reattempt the full capture.
+ * (ref: DL-001, DL-004, DL-006)
  */
@@ -14,9 +15,11 @@
 /**
  * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
  * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
+ * Credits LabWallet.pendingBalance atomically after Order status transition. (ref: DL-002, DL-005)
  *
  * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
  * already CAPTURED (idempotency). Both guards are inside the transaction boundary
- * to prevent race conditions from concurrent webhook deliveries. (ref: DL-004)
+ * to prevent race conditions from concurrent webhook deliveries; retried Xendit requests
+ * exit before the LabWallet upsert, preventing double-credit. (ref: DL-004, DL-007)
  */

```

> **Developer notes**: Line 61 is the fan-out comment; line 62 is await handlePaymentCaptured; lines 63-64 are closing }) and }. Insertion point is after line 62. DL-004 ref on Order fetch (not DL-005 which is upsert-vs-update). DL-005 ref on upsert is correct.

**CC-M-001-002** (src/features/payments/webhooks/README.md)

**Documentation:**

```diff
--- a/src/features/payments/webhooks/README.md
+++ b/src/features/payments/webhooks/README.md
@@ -14,10 +14,13 @@
 4. `handlers.ts:processPaymentCapture` runs a Prisma `$transaction`:
    - Finds `Transaction` by `Transaction.externalId == payload.id`.
    - Returns early if not found (orphan tolerance) or already `CAPTURED` (idempotency).
    - Updates `Transaction` to `CAPTURED`, sets `capturedAt`.
    - Constructs `PaymentCapturedEvent` and calls `handlePaymentCaptured` from the
      orders slice inside the same transaction.
+   - Fetches `Order.labId` (read-consistent within same transaction). (ref: DL-004)
+   - Upserts `LabWallet.pendingBalance += Transaction.amount` (Decimal, not payload float) for the lab. (ref: DL-002, DL-003, DL-005)
 5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.
+6. A Xendit retry on a previously-captured Transaction hits the `CAPTURED` guard and exits
+   before any writes, preventing double-credit of `LabWallet.pendingBalance`. (ref: DL-007)

 ## Two-ID scheme
@@ -40,8 +43,12 @@
 ## Invariants

 - Idempotency check (`findFirst` + status guard) is inside `$transaction` to
   prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
 - `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
   not `payload.paid_amount` (float). (ref: DL-005)
 - Order status transitions are owned by the orders slice — this handler never
   writes `Order.status` directly. (ref: DL-001)
+- `LabWallet.pendingBalance` is credited at capture time; `availableBalance` is only
+  incremented when a Payout reaches `COMPLETED`. Crediting `availableBalance` here would
+  skip the payout lifecycle. (ref: DL-002)
+- `LabWallet` upsert uses `upsert` (not `update`) — a row may not exist for a lab's
+  first payment. (ref: DL-005)

```


#### Documentation

**Module Comment**:

Update file-level JSDoc first sentence: change 'idempotency check, Transaction update, and Order update are atomic' to 'idempotency check, Transaction update, Order update, and LabWallet credit are atomic'

**Function Blocks**:

- `processPaymentCapture` (ref: DL-001): Update JSDoc: change 'marks it CAPTURED, and dispatches PaymentCapturedEvent to the orders slice handler' to 'marks it CAPTURED, dispatches PaymentCapturedEvent to the orders slice handler, and credits the lab’s LabWallet.pendingBalance by Transaction.amount'

**Inline Comments**:

- `processPaymentCapture:before-order-fetch` (ref: DL-004): // Fetch Order for labId — Order.labId is non-nullable; same-tx fetch is read-consistent. (ref: DL-004)
- `processPaymentCapture:before-labwallet-upsert` (ref: DL-002): // Credit LabWallet.pendingBalance — upsert creates on first payment, increments on subsequent. Uses Transaction.amount (Decimal) not payload float. (ref: DL-002, DL-003, DL-005)

## Execution Waves

- W-001: M-001
