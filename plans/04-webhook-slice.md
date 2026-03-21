# Plan

## Overview

After a client pays on the Xendit-hosted invoice page, Xendit sends a webhook to confirm payment. No handler exists to receive this webhook, verify authenticity, mark the Transaction as captured, or advance the Order from PAYMENT_PENDING to ACKNOWLEDGED.

**Approach**: Implement the ADR-001 fan-out pattern: a webhook route in src/features/payments/webhooks/ verifies the x-callback-token header and dispatches to processPaymentCapture, which updates the Transaction within a Prisma $transaction and delegates Order status advancement to handlePaymentCaptured in src/features/orders/handle-payment-captured/. The App Router wiring re-exports POST from src/app/api/webhooks/xendit/route.ts.

### Xendit Webhook Payment Capture Flow

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | ADR-001 fan-out pattern for webhook dispatch | ADR-001 explicitly mandates webhook handler dispatches typed events to feature slice handlers -> orders slice owns Order.status transitions -> prevents God Slice coupling |
| DL-002 | Static x-callback-token header verification using crypto.timingSafeEqual, not HMAC | Xendit uses static token in x-callback-token header -> PayMongo HMAC pattern from stale doc is inapplicable -> timing-safe comparison via crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected)) prevents timing attacks on token comparison |
| DL-003 | TransactionStatus.CAPTURED not SUCCESS | User prompt says SUCCESS -> Prisma schema enum defines CAPTURED not SUCCESS -> schema is authoritative source of truth |
| DL-004 | findFirst + status-check idempotency INSIDE $transaction boundary | Need orderId from Transaction for PaymentCapturedEvent construction -> updateMany returns count only, not record -> findFirst + status check reads orderId and enables idempotency -> MUST be inside $transaction to prevent race condition where concurrent webhooks both pass idempotency check before either writes CAPTURED |
| DL-005 | PaymentCapturedEvent.amount from Transaction.amount (Decimal), not payload number | Xendit payload amount is a float -> Decimal from DB avoids floating-point drift -> Transaction.amount was validated at checkout creation time |
| DL-006 | 500 on $transaction failure to trigger Xendit retry | Xendit retries on non-2xx -> 200 on failure would suppress retry and lose the payment event -> 500 lets Xendit retry automatically |
| DL-007 | No auth() call in webhook handler | Webhook is server-to-server from Xendit -> no user session exists -> authentication is via x-callback-token header only |
| DL-008 | Order.paymentMethod populated via PaymentCapturedEvent.paymentMethod field, extended from domain event interface | Order.paymentMethod column exists in schema -> webhook payload contains payment_method -> PaymentCapturedEvent interface must be extended with optional paymentMethod field to carry this data across slice boundary -> handlePaymentCaptured reads it from event, not from a separate Transaction query -> keeps handler decoupled from Transaction model |
| DL-009 | Extend PaymentCapturedEvent with optional paymentMethod: string field | handlePaymentCaptured in orders slice must not query Transaction (cross-slice boundary violation) -> event is the contract between slices -> paymentMethod on event allows orders handler to set Order.paymentMethod without importing payments domain -> field is optional because some gateways may not provide it |
| DL-010 | Order-not-found in handlePaymentCaptured throws (causing $transaction rollback and 500) | If Order does not exist for a valid Transaction, this is a data integrity issue, not a normal case -> throwing causes $transaction rollback -> 500 triggers Xendit retry -> if genuinely orphaned, will exhaust retries and surface in error monitoring -> silent 200 would hide data corruption |
| DL-011 | Leave PayMongo references in domain/payments/events.ts header and CLAUDE.md as-is; update in a separate cleanup pass | events.ts types are provider-agnostic (no PayMongo-specific fields) -> header comment is cosmetic -> changing it in this slice risks merge conflicts with concurrent work -> tracked as follow-up cleanup, not blocking |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| PayMongo HMAC-SHA256 verification | Stale docs/research/webhooks-slice.md uses PayMongo HMAC pattern -> Xendit uses static x-callback-token header not HMAC -> inapplicable (ref: DL-002) |
| updateMany idempotency pattern | Stale doc proposes updateMany for idempotency -> updateMany returns count only, not record -> need orderId from Transaction to construct PaymentCapturedEvent -> findFirst required (ref: DL-004) |
| TransactionStatus.SUCCESS | User prompt says SUCCESS -> Prisma schema enum has CAPTURED not SUCCESS -> schema is authoritative (ref: DL-003) |
| Order.status target 'PENDING' for webhook | Stale doc suggests PENDING -> isValidStatusTransition map shows PAYMENT_PENDING -> ACKNOWLEDGED -> correct target is ACKNOWLEDGED (ref: DL-001) |
| Inline order update inside handlers.ts | Rejected per ADR-001 -> handlePaymentCaptured lives in src/features/orders/ so orders slice owns its status transitions -> prevents cross-slice coupling (ref: DL-001) |
| Query Transaction inside handlePaymentCaptured to get paymentMethod | Would require orders handler to import/query payments Transaction model -> violates slice boundary -> paymentMethod on PaymentCapturedEvent is the correct cross-slice contract (ref: DL-009) |
| Idempotency check outside $transaction boundary | findFirst + status check outside $transaction allows concurrent webhooks to both pass the check before either writes CAPTURED -> race condition causes duplicate processing -> idempotency guard must be inside transaction (ref: DL-004) |

### Constraints

- MUST: Xendit auth via x-callback-token header using crypto.timingSafeEqual with Buffer conversion against XENDIT_WEBHOOK_TOKEN env var
- MUST: Return 401 on token mismatch; return 200 (no-op) for non-PAID payloads
- MUST: Idempotency — if Transaction already TransactionStatus.CAPTURED, return 200 early; idempotency check MUST be inside $transaction boundary
- MUST: Lookup Transaction by Transaction.externalId == Xendit payload.id (the Xendit invoice ID)
- MUST: handlePaymentCaptured MUST call isValidStatusTransition(PAYMENT_PENDING, ACKNOWLEDGED) before writing Order.status
- MUST: Use TransactionStatus.CAPTURED — user prompt says 'SUCCESS' but Prisma schema enum has CAPTURED; schema is authoritative
- MUST: Prisma $transaction wraps findFirst + Transaction.update + Order.update atomically
- MUST: Set Transaction.capturedAt = new Date() on capture
- MUST: Set Order.paidAt = new Date() in handlePaymentCaptured
- MUST: App Router route at src/app/api/webhooks/xendit/route.ts re-exports POST from src/features/payments/webhooks/route.ts
- MUST NOT: HMAC signature verification (stale doc uses PayMongo HMAC — rejected for Xendit)
- MUST NOT: Call isValidStatusTransition inside route.ts — guard belongs in the order handler

### Known Risks

- **XENDIT_WEBHOOK_TOKEN env var not set at deploy — all webhooks fail with 401**: Fail fast at handler entry if env var is undefined; document required env var in deployment checklist
- **Xendit retry storms if 500s persist from transient DB failures**: Xendit has built-in exponential backoff; $transaction failure is intentional 500 (DL-006); monitor error rates; transient DB issues self-heal
- **Duplicate concurrent webhooks may race past idempotency check**: Idempotency check (findFirst + status guard) MUST be inside $transaction boundary (DL-004 v2); Prisma interactive transaction provides row-level isolation

## Invisible Knowledge

### System

Two-ID scheme (plan 03 DL-003): Transaction.id = our cuid sent to Xendit as external_id param; Transaction.externalId = Xendit invoice ID returned in response; webhook lookup uses Transaction.externalId = payload.id. Domain events.ts header mentions PayMongo but types are provider-agnostic — usable for Xendit without changes (DL-011).

### Invariants

- PaymentCapturedEvent.gatewayRef = Xendit invoice ID (= Transaction.externalId) for dispute resolution
- PaymentCapturedEvent.transactionId = Transaction.id (our cuid, not the Xendit ID)
- PaymentCapturedEvent.amount = Transaction.amount (Decimal from DB, not raw payload number — avoids floating point)
- State machine: PAYMENT_PENDING -> ACKNOWLEDGED is the correct webhook transition; confirmed in validStatusTransitions map
- No auth() call in webhook handler — server-to-server; verified only by x-callback-token
- 500 on $transaction failure is intentional — triggers Xendit retry; 200 would suppress retry
- x-callback-token is the correct Xendit webhook header name (confirmed against Xendit API docs)

### Tradeoffs

- PayMongo references left in domain/payments/events.ts header and CLAUDE.md — cosmetic stale references; types are provider-agnostic; cleanup deferred to avoid merge conflict risk (DL-011)
- paymentMethod added as optional field on PaymentCapturedEvent — slightly enlarges domain contract but avoids cross-slice Transaction query in orders handler (DL-009)

## Milestones

### Milestone 1: Webhook route and payment handlers

**Files**: src/features/payments/webhooks/route.ts, src/features/payments/webhooks/handlers.ts, src/app/api/webhooks/xendit/route.ts, src/domain/payments/events.ts

**Acceptance Criteria**:

- POST /api/webhooks/xendit with invalid x-callback-token returns 401
- POST /api/webhooks/xendit with valid token and status != PAID returns 200 (no-op)
- POST /api/webhooks/xendit with valid token and status PAID for unknown externalId returns 200 (orphan tolerance)
- POST /api/webhooks/xendit with valid token and status PAID for already-CAPTURED Transaction returns 200 (idempotent)
- POST /api/webhooks/xendit with valid token and status PAID for PENDING Transaction updates Transaction to CAPTURED with capturedAt set, and Order to ACKNOWLEDGED with paidAt set, atomically
- Token comparison uses crypto.timingSafeEqual, not ===
- findFirst + status check is inside $transaction boundary

#### Code Intent

- **CI-M-001-001** `src/features/payments/webhooks/route.ts`: Next.js App Router POST handler. Reads x-callback-token header and compares to XENDIT_WEBHOOK_TOKEN env var using crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected)). Returns 401 on mismatch. Parses JSON body. If payload status is not PAID, returns 200 (no-op acknowledgement). Calls processPaymentCapture from handlers.ts. Returns 200 on success. Does NOT catch $transaction errors — lets them propagate as 500 for Xendit retry. (refs: DL-002, DL-006, DL-007)
- **CI-M-001-002** `src/features/payments/webhooks/handlers.ts`: processPaymentCapture function. Opens prisma.$transaction (interactive). Inside the transaction: looks up Transaction by externalId (Xendit invoice ID from payload.id). If not found, returns early (orphan tolerance). If Transaction.status is already CAPTURED, returns early (idempotency — guard is inside transaction to prevent race condition). Updates Transaction status to CAPTURED, sets capturedAt to now, sets paymentMethod from payload. Constructs PaymentCapturedEvent with orderId from Transaction, transactionId (Transaction.id), amount (Transaction.amount Decimal), gatewayRef (Transaction.externalId), capturedAt, paymentMethod (from payload.payment_method, optional). Calls handlePaymentCaptured(event, tx) from orders slice inside the transaction. Transaction boundary ensures atomicity of findFirst + Transaction update + Order update. (refs: DL-001, DL-003, DL-004, DL-005, DL-008, DL-009)
- **CI-M-001-003** `src/app/api/webhooks/xendit/route.ts`: Re-exports POST from src/features/payments/webhooks/route.ts. One-line wiring file following App Router convention. (refs: DL-001)
- **CI-M-001-004** `src/domain/payments/events.ts`: Add optional paymentMethod?: string field to PaymentCapturedEvent interface. No other changes to the file (PayMongo references in header comment left as-is per DL-011). (refs: DL-009, DL-011)

#### Code Changes

**CC-M-001-001** (src/domain/payments/events.ts) - implements CI-M-001-004

**Code:**

```diff
--- a/src/domain/payments/events.ts
+++ b/src/domain/payments/events.ts
@@ -15,6 +15,7 @@ export interface PaymentCapturedEvent {
   orderId: string;
   transactionId: string;
   amount: Decimal;
   gatewayRef: string;
   // gatewayRef is captured here so dispute resolution and payout reconciliation
   // can reference the gateway record without re-querying PayMongo.
   capturedAt: Date;
+  paymentMethod?: string;
 }
```

**Documentation:**

```diff
--- a/src/domain/payments/events.ts
+++ b/src/domain/payments/events.ts
@@ -18,6 +18,8 @@ export interface PaymentCapturedEvent {
   gatewayRef: string;
   // gatewayRef is captured here so dispute resolution and payout reconciliation
   // can reference the gateway record without re-querying PayMongo.
   capturedAt: Date;
+  // paymentMethod carried on the event so orders slice can write Order.paymentMethod
+  // without querying the Transaction model (cross-slice boundary violation). (ref: DL-009)
+  paymentMethod?: string;
 }

```


**CC-M-001-002** (src/features/payments/webhooks/route.ts) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/route.ts
@@ -0,0 +1,39 @@
+import { NextRequest, NextResponse } from 'next/server'
+import crypto from 'crypto'
+import { processPaymentCapture } from './handlers'
+
+interface XenditInvoicePayload {
+  id: string
+  status: string
+  paid_amount: number
+  payer_email: string
+  payment_method?: string
+}
+
+export async function POST(req: NextRequest): Promise<NextResponse> {
+  const expected = process.env.XENDIT_WEBHOOK_TOKEN
+  if (!expected) {
+    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
+  }
+
+  const token = req.headers.get('x-callback-token') ?? ''
+  const tokenBuf = Buffer.from(token)
+  const expectedBuf = Buffer.from(expected)
+  const tokensMatch =
+    tokenBuf.length === expectedBuf.length &&
+    crypto.timingSafeEqual(tokenBuf, expectedBuf)
+
+  if (!tokensMatch) {
+    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
+  }
+
+  const payload = (await req.json()) as XenditInvoicePayload
+
+  if (payload.status !== 'PAID') {
+    return NextResponse.json({ received: true })
+  }
+
+  await processPaymentCapture(payload)
+
+  return NextResponse.json({ received: true })
+}
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/route.ts
+++ b/src/features/payments/webhooks/route.ts
@@ -1,3 +1,12 @@
+/**
+ * Xendit invoice webhook POST handler.
+ *
+ * Authenticates via x-callback-token header (static token, not HMAC).
+ * Non-PAID payloads return 200 immediately — Xendit expects acknowledgement for
+ * all delivery attempts regardless of business relevance. (ref: DL-002, DL-006)
+ *
+ * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
+ * No auth() call — webhook is server-to-server; token header is the only credential. (ref: DL-007)
+ */
 import { NextRequest, NextResponse } from 'next/server'
 import crypto from 'crypto'
 import { processPaymentCapture } from './handlers'
@@ -13,14 +22,18 @@ export async function POST(req: NextRequest): Promise<NextResponse> {
   const expected = process.env.XENDIT_WEBHOOK_TOKEN
   if (!expected) {
     return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
   }

   const token = req.headers.get('x-callback-token') ?? ''
   const tokenBuf = Buffer.from(token)
   const expectedBuf = Buffer.from(expected)
+  // Buffer length check required before timingSafeEqual — equal-length is a precondition.
+  // timingSafeEqual prevents timing attacks on constant-time comparison. (ref: DL-002)
   const tokensMatch =
     tokenBuf.length === expectedBuf.length &&
     crypto.timingSafeEqual(tokenBuf, expectedBuf)

   if (!tokensMatch) {
     return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
   }

   const payload = (await req.json()) as XenditInvoicePayload

+  // Acknowledge non-PAID events without processing — Xendit sends PENDING, EXPIRED etc. (ref: DL-006)
   if (payload.status !== 'PAID') {
     return NextResponse.json({ received: true })
   }

```


**CC-M-001-003** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/handlers.ts
@@ -0,0 +1,49 @@
+import { TransactionStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { PaymentCapturedEvent } from '@/domain/payments/events'
+import { handlePaymentCaptured } from '@/features/orders/handle-payment-captured/handler'
+
+interface XenditInvoicePayload {
+  id: string
+  status: string
+  paid_amount: number
+  payer_email: string
+  payment_method?: string
+}
+
+export async function processPaymentCapture(payload: XenditInvoicePayload): Promise<void> {
+  await prisma.$transaction(async (tx) => {
+    const transaction = await tx.transaction.findFirst({
+      where: { externalId: payload.id },
+    })
+
+    if (!transaction) {
+      return
+    }
+
+    if (transaction.status === TransactionStatus.CAPTURED) {
+      return
+    }
+
+    const capturedAt = new Date()
+
+    await tx.transaction.update({
+      where: { id: transaction.id },
+      data: {
+        status: TransactionStatus.CAPTURED,
+        capturedAt,
+        paymentMethod: payload.payment_method ?? null,
+      },
+    })
+
+    const event: PaymentCapturedEvent = {
+      orderId: transaction.orderId,
+      transactionId: transaction.id,
+      amount: transaction.amount,
+      gatewayRef: transaction.externalId,
+      capturedAt,
+      paymentMethod: payload.payment_method,
+    }
+
+    await handlePaymentCaptured(event, tx)
+  })
+}
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -1,3 +1,10 @@
+/**
+ * Payment capture processor for Xendit invoice webhooks.
+ *
+ * processPaymentCapture runs all DB writes inside a single Prisma $transaction:
+ * idempotency check, Transaction update, and Order update are atomic.
+ * Errors propagate as 500 so Xendit retries on transient DB failures. (ref: DL-004, DL-006)
+ */
 import { TransactionStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
 import { PaymentCapturedEvent } from '@/domain/payments/events'
@@ -13,16 +20,26 @@ interface XenditInvoicePayload {
   payment_method?: string
 }

+/**
+ * Finds the Transaction by Xendit invoice ID, marks it CAPTURED, and dispatches
+ * PaymentCapturedEvent to the orders slice handler — all within one $transaction.
+ *
+ * Returns early (200 to caller) if Transaction is not found (orphan tolerance) or
+ * already CAPTURED (idempotency). Both guards are inside the transaction boundary
+ * to prevent race conditions from concurrent webhook deliveries. (ref: DL-004)
+ */
 export async function processPaymentCapture(payload: XenditInvoicePayload): Promise<void> {
   await prisma.$transaction(async (tx) => {
+    // Lookup by externalId (Xendit invoice ID), not Transaction.id (our cuid). (ref: DL-004)
     const transaction = await tx.transaction.findFirst({
       where: { externalId: payload.id },
     })

     if (!transaction) {
+      // Orphan tolerance — Xendit may deliver for invoices not in our DB.
       return
     }

     if (transaction.status === TransactionStatus.CAPTURED) {
+      // Idempotency guard — inside $transaction to close concurrent-delivery race. (ref: DL-004)
       return
     }

     const capturedAt = new Date()

     await tx.transaction.update({
       where: { id: transaction.id },
       data: {
         status: TransactionStatus.CAPTURED,
         capturedAt,
         paymentMethod: payload.payment_method ?? null,
       },
     })

+    // amount from Transaction.amount (Decimal), not payload.paid_amount (float) —
+    // avoids floating-point drift; amount was validated at checkout creation. (ref: DL-005)
     const event: PaymentCapturedEvent = {
       orderId: transaction.orderId,
       transactionId: transaction.id,
       amount: transaction.amount,
       gatewayRef: transaction.externalId,
       capturedAt,
       paymentMethod: payload.payment_method,
     }

+    // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
     await handlePaymentCaptured(event, tx)
   })
 }

```


**CC-M-001-004** (src/app/api/webhooks/xendit/route.ts) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/src/app/api/webhooks/xendit/route.ts
@@ -0,0 +1 @@
+export { POST } from '@/features/payments/webhooks/route'
```

**Documentation:**

```diff
--- a/src/app/api/webhooks/xendit/route.ts
+++ b/src/app/api/webhooks/xendit/route.ts
@@ -1 +1,2 @@
+// App Router wiring — logic lives in src/features/payments/webhooks/route.ts.
 export { POST } from '@/features/payments/webhooks/route'

```


**CC-M-001-005** (src/features/payments/webhooks/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/payments/webhooks/README.md
@@ -0,0 +1,55 @@
+# payments/webhooks
+
+Xendit invoice webhook handler. Receives POST callbacks from Xendit after a
+hosted-invoice payment, authenticates the request, and advances the Transaction
+and Order records atomically.
+
+## Request flow
+
+1. Xendit POSTs `{ id, status, paid_amount, payer_email, payment_method }` to
+   `/api/webhooks/xendit`.
+2. `route.ts` verifies `x-callback-token` header against `XENDIT_WEBHOOK_TOKEN`
+   env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
+3. Non-`PAID` status values return 200 immediately (no-op acknowledgement).
+4. `handlers.ts:processPaymentCapture` runs a Prisma `$transaction`:
+   - Finds `Transaction` by `Transaction.externalId == payload.id`.
+   - Returns early if not found (orphan tolerance) or already `CAPTURED` (idempotency).
+   - Updates `Transaction` to `CAPTURED`, sets `capturedAt`.
+   - Constructs `PaymentCapturedEvent` and calls `handlePaymentCaptured` from the
+     orders slice inside the same transaction.
+5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.
+
+## Two-ID scheme
+
+| Field | Value | Direction | Purpose |
+|-------|-------|-----------|---------|
+| `Transaction.id` | Our cuid | Sent TO Xendit as `external_id` param at invoice creation | Internal primary key; sent so Xendit embeds it for our reference |
+| `Transaction.externalId` | Xendit invoice ID | Stored FROM Xendit invoice creation response | Webhook lookup key — `payload.id` in webhook callback |
+
+Both directions are set by the checkout slice:
+- `Transaction.id` (cuid) is passed to Xendit's create-invoice API as `external_id`.
+- Xendit returns an invoice `id`; the checkout slice stores it as `Transaction.externalId`.
+
+On webhook receipt, the handler looks up `Transaction` by `externalId == payload.id`.
+`Transaction.id` is never present in the Xendit webhook payload.
+
+If the lookup fails or the Transaction is already `CAPTURED`, the handler returns 200
+(orphan tolerance / idempotency) without retrying. DB errors propagate as 500 so
+Xendit retries automatically on transient failures.
+
+## Invariants
+
+- Idempotency check (`findFirst` + status guard) is inside `$transaction` to
+  prevent race conditions from concurrent Xendit deliveries. (ref: DL-004)
+- `PaymentCapturedEvent.amount` comes from `Transaction.amount` (Prisma `Decimal`),
+  not `payload.paid_amount` (float). (ref: DL-005)
+- Order status transitions are owned by the orders slice — this handler never
+  writes `Order.status` directly. (ref: DL-001)
+
+## Required env vars
+
+| Variable | Description |
+|----------|-------------|
+| `XENDIT_WEBHOOK_TOKEN` | Static token from Xendit dashboard webhook settings |
+
+Missing `XENDIT_WEBHOOK_TOKEN` returns 500 (not 401) to surface misconfiguration
+in error monitoring before any token comparison.

```


### Milestone 2: Order payment-captured handler

**Files**: src/features/orders/handle-payment-captured/handler.ts

**Acceptance Criteria**:

- handlePaymentCaptured calls isValidStatusTransition(PAYMENT_PENDING, ACKNOWLEDGED) before updating Order
- handlePaymentCaptured throws if Order not found by event.orderId (causing $transaction rollback and 500)
- handlePaymentCaptured throws if isValidStatusTransition returns false
- On success, Order.status = ACKNOWLEDGED, Order.paidAt = event.capturedAt, Order.paymentMethod = event.paymentMethod

#### Code Intent

- **CI-M-002-001** `src/features/orders/handle-payment-captured/handler.ts`: handlePaymentCaptured(event: PaymentCapturedEvent, tx: PrismaTransactionClient). Fetches Order by event.orderId within the transaction client. If Order not found, throws Error (data integrity violation — causes $transaction rollback and 500, triggering Xendit retry per DL-010). Calls isValidStatusTransition(order.status, OrderStatus.ACKNOWLEDGED) — throws if invalid (defensive guard; expected path is PAYMENT_PENDING to ACKNOWLEDGED). Updates Order via tx: status = ACKNOWLEDGED, paidAt = event.capturedAt, paymentMethod = event.paymentMethod. Order.status transition is guarded by isValidStatusTransition per ADR-001 required slice pattern. (refs: DL-001, DL-008, DL-009, DL-010)

#### Code Changes

**CC-M-002-001** (src/features/orders/handle-payment-captured/handler.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/handle-payment-captured/handler.ts
@@ -0,0 +1,28 @@
+import { OrderStatus, Prisma } from '@prisma/client'
+import { PaymentCapturedEvent } from '@/domain/payments/events'
+import { isValidStatusTransition } from '@/domain/orders/state-machine'
+
+type PrismaTransactionClient = Omit<
+  Prisma.TransactionClient,
+  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
+>
+
+export async function handlePaymentCaptured(
+  event: PaymentCapturedEvent,
+  tx: PrismaTransactionClient,
+): Promise<void> {
+  const order = await tx.order.findUnique({ where: { id: event.orderId } })
+
+  if (!order) {
+    throw new Error(`Order not found for payment capture: orderId=${event.orderId}`)
+  }
+
+  if (!isValidStatusTransition(order.status, OrderStatus.ACKNOWLEDGED)) {
+    throw new Error(`Invalid status transition: ${order.status} -> ACKNOWLEDGED`)
+  }
+
+  await tx.order.update({
+    where: { id: event.orderId },
+    data: { status: OrderStatus.ACKNOWLEDGED, paidAt: event.capturedAt, paymentMethod: event.paymentMethod ?? null },
+  })
+}
```

**Documentation:**

```diff
--- a/src/features/orders/handle-payment-captured/handler.ts
+++ b/src/features/orders/handle-payment-captured/handler.ts
@@ -1,3 +1,11 @@
+/**
+ * Orders slice handler for PaymentCapturedEvent.
+ *
+ * Called inside the payments webhook $transaction — receives the shared Prisma
+ * transaction client so Order.update is atomic with Transaction.update. (ref: DL-001)
+ *
+ * Throws on data integrity violations (order not found, invalid transition) to
+ * roll back the $transaction and return 500, triggering Xendit retry. (ref: DL-010)
+ */
 import { OrderStatus, Prisma } from '@prisma/client'
 import { PaymentCapturedEvent } from '@/domain/payments/events'
 import { isValidStatusTransition } from '@/domain/orders/state-machine'
@@ -10,17 +18,26 @@ type PrismaTransactionClient = Omit<
   '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
 >

+/**
+ * Advances Order.status from PAYMENT_PENDING to ACKNOWLEDGED within the caller's
+ * Prisma transaction. Sets Order.paidAt and Order.paymentMethod from the event.
+ *
+ * Throws if Order is not found — this is a data integrity violation, not a
+ * recoverable case; the throw rolls back $transaction and yields 500 for retry. (ref: DL-010)
+ *
+ * Throws if isValidStatusTransition rejects the transition — defensive guard;
+ * expected path is PAYMENT_PENDING → ACKNOWLEDGED. (ref: DL-001)
+ */
 export async function handlePaymentCaptured(
   event: PaymentCapturedEvent,
   tx: PrismaTransactionClient,
 ): Promise<void> {
   const order = await tx.order.findUnique({ where: { id: event.orderId } })

   if (!order) {
+    // Throw (not return) — causes $transaction rollback and 500 for Xendit retry. (ref: DL-010)
     throw new Error(`Order not found for payment capture: orderId=${event.orderId}`)
   }

+  // isValidStatusTransition enforces state machine rules before any DB write. (ref: DL-001)
   if (!isValidStatusTransition(order.status, OrderStatus.ACKNOWLEDGED)) {
     throw new Error(`Invalid status transition: ${order.status} -> ACKNOWLEDGED`)
   }

   await tx.order.update({
     where: { id: event.orderId },
+    // paymentMethod from event, not from a separate Transaction query — keeps handler
+    // decoupled from payments slice model. (ref: DL-008, DL-009)
     data: { status: OrderStatus.ACKNOWLEDGED, paidAt: event.capturedAt, paymentMethod: event.paymentMethod ?? null },
   })
 }

```


### Milestone 3: CLAUDE.md navigation updates

**Files**: src/features/payments/CLAUDE.md, src/features/orders/CLAUDE.md

**Acceptance Criteria**:

- src/features/payments/CLAUDE.md has webhooks/ directory entry in subdirectories table
- src/features/orders/CLAUDE.md has handle-payment-captured/ directory entry in subdirectories table

#### Code Intent

- **CI-M-003-001** `src/features/payments/CLAUDE.md`: Add webhooks/ directory entry to the subdirectories table. Description: Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler.
- **CI-M-003-002** `src/features/orders/CLAUDE.md`: Add handle-payment-captured/ directory entry to the subdirectories table. Description: Handles PaymentCapturedEvent from webhook — advances Order status from PAYMENT_PENDING to ACKNOWLEDGED.

#### Code Changes

**CC-M-003-001** (src/features/payments/CLAUDE.md) - implements CI-M-003-001

**Code:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -7,3 +7,4 @@ Payment feature slices. Each subdirectory is one vertical slice.
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
+| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler | Implementing or modifying webhook payment capture |
```

**Documentation:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -7,3 +7,4 @@ Payment feature slices. Each subdirectory is one vertical slice.
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
+| `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler | Implementing or modifying webhook payment capture |

```


**CC-M-003-002** (src/features/orders/CLAUDE.md) - implements CI-M-003-002

**Code:**

```diff
--- a/src/features/orders/CLAUDE.md
+++ b/src/features/orders/CLAUDE.md
@@ -7,3 +7,4 @@ Order feature slices. Each subdirectory is a vertical slice scoped to one order workflow.
 | --------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
 | `create-order/` | Client submits a test request for a `LabService`; writes `Order` + `ClientProfile` in one transaction | Implementing or modifying order creation flow |
+| `handle-payment-captured/` | Handles PaymentCapturedEvent from webhook — advances Order status from PAYMENT_PENDING to ACKNOWLEDGED | Implementing or modifying post-payment order advancement |
```

**Documentation:**

```diff
--- a/src/features/orders/CLAUDE.md
+++ b/src/features/orders/CLAUDE.md
@@ -7,3 +7,4 @@ Order feature slices. Each subdirectory is a vertical slice scoped to one order workflow.
 | --------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
 | `create-order/` | Client submits a test request for a `LabService`; writes `Order` + `ClientProfile` in one transaction | Implementing or modifying order creation flow |
+| `handle-payment-captured/` | Handles PaymentCapturedEvent from webhook — advances Order status from PAYMENT_PENDING to ACKNOWLEDGED | Implementing or modifying post-payment order advancement |

```

