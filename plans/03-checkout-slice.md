# Plan

## Overview

Clients with PAYMENT_PENDING orders have no way to pay. The create-order action redirects to /dashboard/orders/[orderId]/pay, but that page does not exist. A payment summary page and Xendit invoice creation flow are needed to complete the order-to-payment pipeline.

**Approach**: A vertical slice at src/features/payments/checkout/ containing an RSC page (auth gate, order fetch, Decimal-to-string DTO), a client-side payment summary UI, and a Server Action that idempotently creates a Xendit invoice via src/lib/payments/xendit.ts, writes a Transaction record, and redirects the client to the Xendit-hosted checkout URL.

### Checkout Slice Data Flow

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Native fetch for Xendit HTTP calls, no abstraction layer | ADR-001 rejects premature abstraction (Hexagonal rejected) -> only one payment provider (Xendit) -> schema already provider-agnostic (String field) -> swapping later requires only writing paymongo.ts and changing one import in action.ts |
| DL-002 | Xendit call before Prisma write in action sequence | If Prisma-first and Xendit fails, user has no invoice URL -> if Xendit-first and DB fails, orphaned Xendit invoice is recoverable via idempotency re-creation on retry -> Xendit-first minimizes user-facing failure |
| DL-003 | Two distinct IDs: a pre-generated cuid is sent to Xendit as external_id (the Xendit API parameter); the Xendit invoice ID returned in the response is stored in Transaction.externalId (the DB column). Transaction.id = the pre-generated cuid. | PAYMENT_FAILED allows retry back to PAYMENT_PENDING (state machine) -> retry creates a second Transaction for same order -> Transaction.externalId (Xendit invoice ID) has UNIQUE constraint -> each Xendit call returns a unique invoice ID -> orderId cannot be used as Transaction.id because retries create multiple Transactions per order -> pre-generated cuid as Transaction.id is unique per attempt and serves as the Xendit external_id parameter for correlation |
| DL-004 | Idempotency guard queries existing PENDING Transaction by orderId before calling Xendit | Double-submit or browser back+resubmit fires action twice -> without guard, two Xendit invoices created -> guard checks for existing PENDING Transaction -> if found, redirect to its checkoutUrl immediately -> prevents double-charging |
| DL-005 | No automated tests in this plan | No test framework installed (no vitest/jest in package.json) -> existing create-order slice has no tests -> acceptance criteria use manual verification -> consistent with established project pattern |
| DL-006 | page.tsx lives in src/features/payments/checkout/, not src/app/ | src/app/ contains only .gitkeep -> existing create-order slice puts page.tsx in src/features/ -> App Router route file re-exports from features/ (not yet wired) -> follow established pattern |
| DL-007 | MUST NOT call isValidStatusTransition in checkout action | Checkout action creates a Transaction record only -> no Order.status mutation happens -> isValidStatusTransition guard applies only to status mutations -> calling it here is misleading and violates the Required Slice Pattern scope |
| DL-008 | Hardcode currency to PHP in xendit.ts | PipetGo operates in the Philippines only -> Transaction.currency schema default is PHP -> all prices are in PHP -> no multi-currency requirement exists -> hardcoding avoids unnecessary parameterization per ADR-001 YAGNI principle |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| PayMongo as payment provider | Rejected at business level; Xendit required for PESONet B2B high-value transfers that bypass e-wallet limits (ref: DL-001) |
| Inline Xendit HTTP calls in action.ts | ADR-001 VSA requires infrastructure helpers in src/lib/, not inside feature slices (ref: DL-001) |
| Set Order.status to PROCESSING in checkout action | Status transition belongs to the webhook handler after Xendit confirms payment, not before; checkout action only creates a Transaction record (ref: DL-007) |

## Invisible Knowledge

### System

The checkout slice is the second half of a two-phase flow: create-order redirects PAYMENT_PENDING orders to /dashboard/orders/[orderId]/pay, where this slice picks up. The Xendit webhook (separate slice, out of scope) completes the cycle by advancing Order.status to ACKNOWLEDGED after Xendit confirms payment. Two distinct IDs are in play: Transaction.id is a pre-generated cuid that is also sent to Xendit as external_id (API parameter) for correlation; Transaction.externalId (DB column) stores the Xendit invoice ID returned in the response (unique per attempt). This supports PAYMENT_FAILED retry flows where multiple Transactions exist for the same orderId.

### Invariants

- redirect() in Next.js Server Actions throws NEXT_REDIRECT internally -- never wrap in try/catch or the redirect is swallowed
- Xendit HTTP call precedes Prisma Transaction.create -- orphaned Xendit invoices are recoverable via idempotency; missing local records are not
- Idempotency guard (PENDING Transaction lookup by orderId) is the first-line defense; Transaction.externalId UNIQUE constraint is the DB-level fallback
- Order.status is never mutated by the checkout action -- only the webhook handler advances status after Xendit confirms payment
- Decimal fields (quotedPrice, amount) are converted to string before crossing RSC-to-client boundary to prevent Next.js serialization crash
- xendit.ts lives in src/lib/payments/ (infrastructure) and must not import from @/features/ or @/domain/

### Tradeoffs

- No provider abstraction interface -- ADR-001 explicitly rejects premature abstraction; PayMongo swap later requires writing paymongo.ts and changing one import
- Two-ID scheme (Transaction.id = cuid sent as Xendit external_id; Transaction.externalId = Xendit invoice ID from response) adds mapping complexity but enables PAYMENT_FAILED retry correctness and Xendit correlation in both directions

## Milestones

### Milestone 1: Xendit invoice HTTP helper

**Files**: src/lib/payments/xendit.ts

**Requirements**:

- xendit.ts compiles with npx tsc --noEmit
- xendit.ts passes npx eslint src/lib/payments/xendit.ts
- No imports from @/features/ or @/domain/

**Acceptance Criteria**:

- createXenditInvoice() exported with typed params and result
- XenditApiError class exported for catch-specific handling in action.ts
- Basic Auth header uses XENDIT_SECRET_KEY env var as username
- Currency hardcoded to PHP per DL-008
- Non-2xx responses throw XenditApiError with status code and body

#### Code Intent

- **CI-M-001-001** `src/lib/payments/xendit.ts`: Exports a createXenditInvoice() function that accepts {externalId: string, amount: number, payerEmail: string, description: string, successRedirectUrl: string} and returns {invoiceId: string, invoiceUrl: string, rawResponse: Record<string, unknown>}. Reads XENDIT_SECRET_KEY from process.env. Sends POST to https://api.xendit.co/v2/invoices with Basic Auth (secret key as username, empty password). Sets currency to PHP (DL-008: single-currency constraint, matches Transaction.currency default). Throws a typed XenditApiError on non-2xx response with status code and response body. Exports the XenditApiError class and the XenditInvoiceParams / XenditInvoiceResult types. Does not import from @/features/ (infrastructure boundary). Does not import from @/domain/ (no domain dependency needed). (refs: DL-001, DL-008)

#### Code Changes

**CC-M-001-001** (src/lib/payments/xendit.ts) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ b/src/lib/payments/xendit.ts
@@ -0,0 +1,57 @@
+export type XenditInvoiceParams = {
+  externalId: string
+  amount: number
+  payerEmail: string
+  description: string
+  successRedirectUrl: string
+}
+
+export type XenditInvoiceResult = {
+  invoiceId: string
+  invoiceUrl: string
+  rawResponse: Record<string, unknown>
+}
+
+export class XenditApiError extends Error {
+  constructor(
+    message: string,
+    public readonly status: number,
+    public readonly body: unknown,
+  ) {
+    super(message)
+    this.name = 'XenditApiError'
+  }
+}
+
+export async function createXenditInvoice(
+  params: XenditInvoiceParams,
+): Promise<XenditInvoiceResult> {
+  const secretKey = process.env.XENDIT_SECRET_KEY
+  if (!secretKey) {
+    throw new XenditApiError('XENDIT_SECRET_KEY is not set', 500, null)
+  }
+
+  const credentials = Buffer.from(`${secretKey}:`).toString('base64')
+
+  const response = await fetch('https://api.xendit.co/v2/invoices', {
+    method: 'POST',
+    headers: {
+      'Content-Type': 'application/json',
+      Authorization: `Basic ${credentials}`,
+    },
+    body: JSON.stringify({
+      external_id: params.externalId,
+      amount: params.amount,
+      payer_email: params.payerEmail,
+      description: params.description,
+      success_redirect_url: params.successRedirectUrl,
+      currency: 'PHP',
+    }),
+  })
+
+  if (!response.ok) {
+    const errorBody = await response.text()
+    throw new XenditApiError(
+      `Xendit API error: ${response.status}`,
+      response.status,
+      errorBody,
+    )
+  }
+
+  const raw = (await response.json()) as Record<string, unknown>
+
+  return {
+    invoiceId: raw['id'] as string,
+    invoiceUrl: raw['invoice_url'] as string,
+    rawResponse: raw,
+  }
+}
```

**Documentation:**

```diff
--- a/src/lib/payments/xendit.ts
+++ b/src/lib/payments/xendit.ts
@@ -1,3 +1,14 @@
+/**
+ * Xendit payment gateway integration — infrastructure layer.
+ *
+ * Provides a typed interface to the Xendit Invoice API (POST /v2/invoices).
+ * Currency is hardcoded to PHP; PipetGo operates in the Philippines only (ref: DL-008).
+ * Swap to a different provider by adding a parallel file (e.g. paymongo.ts) and
+ * updating the import in action.ts — no schema migration required (ref: DL-001).
+ *
+ * Must not import from @/features/ or @/domain/; this is infrastructure.
+ */
+
+/** Parameters sent to the Xendit Invoice API to create a hosted payment page. */
 export type XenditInvoiceParams = {
   externalId: string
   amount: number
@@ -6,6 +17,12 @@ export type XenditInvoiceParams = {
   description: string
   successRedirectUrl: string
 }
+
+/**
+ * Normalised result from a successful Xendit invoice creation.
+ *
+ * invoiceId   — Xendit's invoice ID, stored in Transaction.externalId (DB column).
+ * invoiceUrl  — Hosted checkout URL; user is redirected here.
+ * rawResponse — Full Xendit response body, stored in Transaction.metadata for audit.
+ */

 export type XenditInvoiceResult = {
   invoiceId: string
@@ -13,6 +30,9 @@ export type XenditInvoiceResult = {
   rawResponse: Record<string, unknown>
 }

+/**
+ * Thrown when the Xendit API returns a non-2xx response.
+ * Carries the HTTP status code and raw response body for caller inspection.
+ */
 export class XenditApiError extends Error {
   constructor(
     message: string,
@@ -25,6 +45,22 @@ export class XenditApiError extends Error {
   }
 }

+/**
+ * Creates a Xendit-hosted invoice and returns the checkout URL.
+ *
+ * Sequence (ref: DL-002):
+ *   1. Reads XENDIT_SECRET_KEY from env — throws XenditApiError(500) if absent.
+ *   2. POST /v2/invoices with Basic Auth (secretKey as username, empty password).
+ *   3. Returns invoiceId (stored in Transaction.externalId), invoiceUrl (redirect
+ *      target), and rawResponse (stored in Transaction.metadata).
+ *
+ * Call ordering in the checkout action: this function is called BEFORE the Prisma
+ * Transaction.create write. If the DB write fails, the orphaned Xendit invoice is
+ * recoverable via the idempotency guard on retry. The inverse — DB write first,
+ * Xendit call second — leaves the user with no invoice URL on Xendit failure
+ * (ref: DL-002).
+ *
+ * Currency is always PHP (ref: DL-008).
+ */
 export async function createXenditInvoice(
   params: XenditInvoiceParams,
 ): Promise<XenditInvoiceResult> {

```


**CC-M-001-002** (src/lib/payments/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/lib/payments/CLAUDE.md
@@ -0,0 +1,10 @@
+# payments/
+
+Payment gateway HTTP clients. One file per provider.
+
+## Files
+
+| File         | What                                                                  | When to read                                                    |
+| ------------ | --------------------------------------------------------------------- | --------------------------------------------------------------- |
+| `xendit.ts`  | Xendit Invoice API client — `createXenditInvoice`, `XenditApiError`   | Modifying Xendit integration or adding Xendit-specific params   |

```


### Milestone 2: Checkout feature slice

**Files**: src/features/payments/checkout/page.tsx, src/features/payments/checkout/ui.tsx, src/features/payments/checkout/action.ts

**Requirements**:

- All three files compile with npx tsc --noEmit
- All three files pass npx eslint src/features/payments/checkout/

**Acceptance Criteria**:

- Happy path: CLIENT with PAYMENT_PENDING order sees payment summary, clicks Pay Now, is redirected to Xendit checkout URL
- Idempotency: clicking Pay Now twice (or browser back + resubmit) reuses existing PENDING Transaction checkoutUrl without creating a second Xendit invoice
- TOCTOU: if order status changes between page load and form submit (e.g., admin cancels), action returns error message instead of creating invoice
- Auth guard: non-CLIENT role or unauthenticated user cannot access page or submit action
- Ownership guard: client cannot pay for another client's order
- Null clientProfile: order without clientProfile returns notFound on page, error on action
- Xendit API failure: non-2xx response shows user-friendly error message, no Transaction created
- Network failure: DNS/timeout errors show 'Unable to reach payment service' message, no Transaction created
- Decimal serialization: quotedPrice crosses RSC-to-client boundary as string, no serialization crash

#### Code Intent

- **CI-M-002-001** `src/features/payments/checkout/page.tsx`: Async RSC. Receives params: {orderId: string}. Calls auth(); redirects to /auth/signin if no session or role !== CLIENT. Fetches Order by id with include: {clientProfile: true, service: true}. Calls notFound() if order missing or order.clientId !== session.user.id. Calls notFound() if order.status !== PAYMENT_PENDING. Calls notFound() if order.clientProfile is null (ClientProfile is optional in schema; defensive guard ensures downstream email/name access is safe). Maps Order to a CheckoutOrderDTO: {id, serviceName: order.service.name, quotedPrice: order.quotedPrice!.toFixed(2), clientEmail: order.clientProfile.email, clientName: order.clientProfile.name, createdAt: order.createdAt.toISOString()}. Decimal.toFixed(2) for quotedPrice prevents Next.js serialization crash. Renders <PaymentSummary order={dto} />. (refs: DL-006)
- **CI-M-002-002** `src/features/payments/checkout/ui.tsx`: use client component. Exports PaymentSummary accepting CheckoutOrderDTO. Displays a Card with order summary: service name, quoted price formatted as PHP currency, client name and email, order creation date. Contains a form with a hidden orderId input and a submit button labeled Pay Now. Uses useActionState(initiateCheckout, null) with ActionState type matching the canonical pattern: {message?: string} | null (same shape as create-order/action.ts ActionState). Initial state is null. Destructures as [state, formAction, isPending]. Shows isPending state on button as Processing.... Shows error message via state?.message in Alert variant=destructive. Layout follows existing Card/CardHeader/CardContent/Button pattern from create-order/ui.tsx. (refs: DL-006)
- **CI-M-002-003** `src/features/payments/checkout/action.ts`: use server action. Defines ActionState type as {message?: string} | null (matching canonical create-order pattern). Exports initiateCheckout(prevState: ActionState, formData: FormData) -> Promise<ActionState>. Extracts orderId from formData. Calls auth(); returns {message: 'Unauthorized.'} if no session or role !== CLIENT. Re-fetches Order from DB with clientProfile and service relations (TOCTOU guard). Returns error if order not found, or order.clientId !== session.user.id, or order.status !== PAYMENT_PENDING. Returns error if order.clientProfile is null (defensive guard). Guards against null quotedPrice (returns error). Idempotency guard: queries Transaction where orderId AND status PENDING; if found and checkoutUrl exists, redirects to checkoutUrl immediately without calling Xendit. Generates a cuid as the Transaction.id (also sent to Xendit as the external_id API parameter for correlation). Calls createXenditInvoice from @/lib/payments/xendit.ts with externalId set to the generated cuid, amount set to order.quotedPrice.toNumber(), payerEmail from order.clientProfile.email, description containing service name, successRedirectUrl pointing to /dashboard/orders/[orderId]. Creates Transaction record via prisma.transaction.create with: id set to the pre-generated cuid, orderId, externalId set to Xendit invoice ID from response (invoiceId), provider set to 'xendit' string literal, amount from order.quotedPrice, currency 'PHP', status PENDING, checkoutUrl from Xendit response invoiceUrl, metadata storing raw Xendit response. Error handling: catches XenditApiError and returns {message: 'Payment service error. Please try again.'}; catches generic Error (network failures, DNS, timeouts) and returns {message: 'Unable to reach payment service. Please try again later.'}. redirect() to checkoutUrl as last statement in success path -- placed OUTSIDE the try/catch block to avoid swallowing NEXT_REDIRECT. (refs: DL-002, DL-003, DL-004, DL-007)

#### Code Changes

**CC-M-002-001** (src/features/payments/checkout/page.tsx) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/checkout/page.tsx
@@ -0,0 +1,46 @@
+import { notFound, redirect } from 'next/navigation'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { PaymentSummary } from './ui'
+
+export type CheckoutOrderDTO = {
+  id: string
+  serviceName: string
+  quotedPrice: string
+  clientEmail: string
+  clientName: string
+  createdAt: string
+}
+
+export default async function CheckoutPage({
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
+    include: { clientProfile: true, service: true },
+  })
+
+  if (!order || order.clientId !== session.user.id) notFound()
+  if (order.status !== OrderStatus.PAYMENT_PENDING) notFound()
+  if (!order.clientProfile) notFound()
+
+  const dto: CheckoutOrderDTO = {
+    id: order.id,
+    serviceName: order.service.name,
+    quotedPrice: order.quotedPrice!.toFixed(2),
+    clientEmail: order.clientProfile.email,
+    clientName: order.clientProfile.name,
+    createdAt: order.createdAt.toISOString(),
+  }
+
+  return <PaymentSummary order={dto} />
+}

```

**Documentation:**

```diff
--- a/src/features/payments/checkout/page.tsx
+++ b/src/features/payments/checkout/page.tsx
@@ -1,3 +1,14 @@
+/**
+ * RSC entry point for the deferred-payment checkout page.
+ *
+ * Route: /dashboard/orders/[orderId]/pay
+ * Auth:  CLIENT role only; redirects to /auth/signin otherwise.
+ * Guard: Renders 404 for any order that is not PAYMENT_PENDING, belongs to a
+ *        different client, or lacks a clientProfile.
+ *
+ * Decimal fields (Order.quotedPrice) are converted to string before being passed
+ * to the client component to prevent Next.js RSC serialization failure on
+ * Prisma.Decimal values.
+ */
+
 import { notFound, redirect } from 'next/navigation'
 import { OrderStatus } from '@prisma/client'
 import { prisma } from '@/lib/prisma'
@@ -5,6 +16,14 @@ import { auth } from '@/lib/auth'
 import { PaymentSummary } from './ui'

+/**
+ * All fields are primitive strings so Next.js can serialize them across the
+ * RSC-to-client boundary without crashing on Prisma.Decimal or Date objects.
+ * Adding any non-serializable type here will cause a runtime crash.
+ */
 export type CheckoutOrderDTO = {
   id: string
   serviceName: string
@@ -15,6 +34,11 @@ export type CheckoutOrderDTO = {
   createdAt: string
 }

+/**
+ * quotedPrice non-null assertion is safe: resolveOrderInitialState always sets
+ * quotedPrice before transitioning to PAYMENT_PENDING, so reaching this page
+ * guarantees a non-null value. The status guard above enforces this precondition.
+ */
 export default async function CheckoutPage({
   params,
 }: {

```


**CC-M-002-002** (src/features/payments/checkout/ui.tsx) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/checkout/ui.tsx
@@ -0,0 +1,60 @@
+'use client'
+
+import { useActionState } from 'react'
+import { Button } from '@/components/ui/button'
+import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
+import { Alert, AlertDescription } from '@/components/ui/alert'
+import { initiateCheckout } from './action'
+import type { CheckoutOrderDTO } from './page'
+
+type PaymentSummaryProps = {
+  order: CheckoutOrderDTO
+}
+
+export function PaymentSummary({ order }: PaymentSummaryProps) {
+  const [state, formAction, isPending] = useActionState(initiateCheckout, null)
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <a href="/dashboard/client" className="text-sm text-gray-600 hover:text-gray-900">
+            ← Back to dashboard
+          </a>
+        </div>
+
+        <Card>
+          <CardHeader>
+            <CardTitle>Payment Summary</CardTitle>
+          </CardHeader>
+          <CardContent className="space-y-4">
+            <div className="space-y-2">
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Service</span>
+                <span className="font-medium">{order.serviceName}</span>
+              </div>
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Amount</span>
+                <span className="text-lg font-semibold text-green-600">₱{order.quotedPrice}</span>
+              </div>
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Name</span>
+                <span className="font-medium">{order.clientName}</span>
+              </div>
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Email</span>
+                <span className="font-medium">{order.clientEmail}</span>
+              </div>
+            </div>
+
+            {state?.message && (
+              <Alert variant="destructive">
+                <AlertDescription>{state.message}</AlertDescription>
+              </Alert>
+            )}
+
+            <form action={formAction}>
+              <input type="hidden" name="orderId" value={order.id} />
+              <Button type="submit" className="w-full" disabled={isPending}>
+                {isPending ? 'Processing...' : 'Pay Now'}
+              </Button>
+            </form>
+          </CardContent>
+        </Card>
+      </div>
+    </div>
+  )
+}

```

**Documentation:**

```diff
--- a/src/features/payments/checkout/ui.tsx
+++ b/src/features/payments/checkout/ui.tsx
@@ -1,4 +1,14 @@
 'use client'
 
+/**
+ * useActionState drives the form — success path never returns to this component;
+ * the server action calls redirect() to Xendit. Error path surfaces action's
+ * returned message as a destructive alert, avoiding a separate error page.
+ */
+
 import { useActionState } from 'react'
@@ -8,6 +18,10 @@ import { initiateCheckout } from './action'
 import type { CheckoutOrderDTO } from './page'

 type PaymentSummaryProps = {
   order: CheckoutOrderDTO
 }

+/**
+ * Accepts pre-serialised DTO (all strings) so no Prisma.Decimal crosses the
+ * RSC boundary. The hidden orderId input avoids exposing it in the URL.
+ */
 export function PaymentSummary({ order }: PaymentSummaryProps) {

```


**CC-M-002-003** (src/features/payments/checkout/action.ts) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/checkout/action.ts
@@ -0,0 +1,78 @@
+'use server'
+
+import { redirect } from 'next/navigation'
+import { OrderStatus, TransactionStatus } from '@prisma/client'
+import { createId } from '@paralleldrive/cuid2'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { createXenditInvoice, XenditApiError } from '@/lib/payments/xendit'
+
+type ActionState = { message?: string } | null
+
+export async function initiateCheckout(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderId = formData.get('orderId') as string | null
+  if (!orderId) return { message: 'Missing order ID.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { clientProfile: true, service: true },
+  })
+
+  if (!order || order.clientId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+  if (order.status !== OrderStatus.PAYMENT_PENDING) {
+    return { message: 'Order is not awaiting payment.' }
+  }
+  if (!order.clientProfile) {
+    return { message: 'Order profile is incomplete.' }
+  }
+  if (!order.quotedPrice) {
+    return { message: 'Order does not have a quoted price.' }
+  }
+
+  const existing = await prisma.transaction.findFirst({
+    where: { orderId, status: TransactionStatus.PENDING },
+  })
+  if (existing?.checkoutUrl) {
+    redirect(existing.checkoutUrl)
+  }
+
+  const transactionId = createId()
+
+  let checkoutUrl: string
+  try {
+    const result = await createXenditInvoice({
+      externalId: transactionId,
+      amount: order.quotedPrice.toNumber(),
+      payerEmail: order.clientProfile.email,
+      description: `PipetGo Lab Test: ${order.service.name}`,
+      successRedirectUrl: `${process.env.NEXT_PUBLIC_APP_URL ?? ''}/dashboard/orders/${orderId}`,
+    })
+
+    await prisma.transaction.create({
+      data: {
+        id: transactionId,
+        orderId,
+        externalId: result.invoiceId,
+        provider: 'xendit',
+        amount: order.quotedPrice,
+        currency: 'PHP',
+        status: TransactionStatus.PENDING,
+        checkoutUrl: result.invoiceUrl,
+        metadata: result.rawResponse,
+      },
+    })
+
+    checkoutUrl = result.invoiceUrl
+  } catch (err) {
+    if (err instanceof XenditApiError) {
+      return { message: 'Payment service error. Please try again.' }
+    }
+    return { message: 'Unable to reach payment service. Please try again later.' }
+  }
+
+  redirect(checkoutUrl)
+}

```

**Documentation:**

```diff
--- a/src/features/payments/checkout/action.ts
+++ b/src/features/payments/checkout/action.ts
@@ -1,3 +1,28 @@
+'use server'
+
+/**
+ * Server action for the deferred-payment checkout flow.
+ *
+ * Sequence:
+ *   1. Validate formData (orderId present).
+ *   2. Auth guard — CLIENT session required (TOCTOU re-check; page already gated).
+ *   3. Re-fetch Order from DB and verify clientId + status === PAYMENT_PENDING
+ *      (TOCTOU guard: order status may change between page load and action execution).
+ *   4. Idempotency guard — if a PENDING Transaction already exists for the order,
+ *      redirect to its checkoutUrl immediately; skip Xendit call (ref: DL-004).
+ *   5. Generate a cuid. This becomes Transaction.id AND the Xendit external_id
+ *      parameter. Xendit's returned invoice ID is stored in Transaction.externalId
+ *      (DB column). Two distinct IDs in play — see DL-003.
+ *   6. Call createXenditInvoice BEFORE writing to DB (ref: DL-002).
+ *   7. Prisma Transaction.create — provider='xendit' (String, not enum) (ref: DL-001).
+ *   8. redirect(checkoutUrl) as the LAST statement in the success path.
+ *
+ * Invariants:
+ *   - redirect() is never inside try/catch — Next.js throws NEXT_REDIRECT
+ *     internally; catching it swallows the redirect.
+ *   - Order.status is NOT mutated here. The webhook handler advances status
+ *     after Xendit confirms payment (ref: DL-007).
+ *   - isValidStatusTransition() is NOT called — no status mutation occurs (ref: DL-007).
+ */
+
 'use server'

 import { redirect } from 'next/navigation'
@@ -10,6 +35,7 @@ import { createXenditInvoice, XenditApiError } from '@/lib/payments/xendit'

 type ActionState = { message?: string } | null

+/** useActionState-compatible signature. Wraps the full checkout flow. */
 export async function initiateCheckout(
   _prevState: ActionState,
   formData: FormData,
@@ -35,11 +61,19 @@ export async function initiateCheckout(
     return { message: 'Order does not have a quoted price.' }
   }

+  // Idempotency guard: double-submit or browser back+resubmit must not create a
+  // second Xendit invoice. If a PENDING Transaction exists, redirect immediately
+  // without calling Xendit again. (ref: DL-004)
   const existing = await prisma.transaction.findFirst({
     where: { orderId, status: TransactionStatus.PENDING },
   })
   if (existing?.checkoutUrl) {
     redirect(existing.checkoutUrl)
   }

+  // Transaction.id doubles as the Xendit external_id parameter for correlation.
+  // Transaction.externalId (DB column) stores the Xendit invoice ID from the response.
+  // Two distinct IDs support PAYMENT_FAILED retry flows where multiple Transactions
+  // exist per orderId. (ref: DL-003)
   const transactionId = createId()

   let checkoutUrl: string
   try {
+    // Xendit call precedes DB write (ref: DL-002): orphaned Xendit invoices are
+    // recoverable via idempotency on retry; missing local records are not.
     const result = await createXenditInvoice({

```


**CC-M-002-004** (src/features/payments/checkout/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/payments/checkout/README.md
@@ -0,0 +1,90 @@
+# checkout
+
+## Overview
+
+Deferred-payment checkout slice. A CLIENT whose `Order.status === PAYMENT_PENDING` visits
+`/dashboard/orders/[orderId]/pay`, reviews a payment summary, and clicks to be redirected
+to a Xendit-hosted invoice page. The Server Action creates a `Transaction` record and
+redirects. Order status is **not** mutated here — the webhook handler advances it after
+Xendit confirms payment.
+
+## Architecture
+
+```
+page.tsx (RSC)
+  -> auth() — CLIENT only; redirect /auth/signin otherwise
+  -> prisma.order (include clientProfile, service)
+  -> guard: clientId match + status === PAYMENT_PENDING
+  -> CheckoutOrderDTO (Decimal -> string, Date -> ISO string)
+  -> <PaymentSummary order={dto} />  (ui.tsx)
+       -> useActionState(initiateCheckout)
+       -> <form action={formAction}>  (hidden orderId input)
+
+action.ts (Server Action)
+  -> TOCTOU re-fetch: re-verify clientId + status === PAYMENT_PENDING
+  -> idempotency guard: PENDING Transaction by orderId -> redirect(checkoutUrl)
+  -> createId() -> transactionId (used as Transaction.id AND Xendit external_id param)
+  -> createXenditInvoice() [src/lib/payments/xendit.ts] — BEFORE Prisma write
+  -> prisma.transaction.create (externalId = Xendit invoice ID from response)
+  -> redirect(checkoutUrl)
+```
+
+## Design Decisions
+
+**TOCTOU guard — re-fetch Order in action (DL-004 / context invariant)**: The action
+re-fetches the Order from the DB and re-verifies `clientId + status === PAYMENT_PENDING`
+even though `page.tsx` already performed the same check. Order status can change between
+page load and form submission — for example, an admin may cancel the order. Without the
+re-check, the action could create a Xendit invoice for an order that is no longer
+awaiting payment.
+
+**Xendit call before Prisma write (DL-002)**: If Prisma write fails after Xendit call,
+the orphaned Xendit invoice is recoverable — on retry the idempotency guard finds
+the PENDING Transaction from the successful second attempt. The inverse (Prisma first,
+Xendit second) leaves the user with a local record but no invoice URL; that failure
+mode is not recoverable without manual intervention.
+
+**Two-ID scheme (DL-003)**: `Transaction.id` is a pre-generated cuid sent to Xendit
+as the `external_id` API parameter. `Transaction.externalId` (DB column) stores the
+Xendit invoice ID returned in the response. The two-ID separation supports
+PAYMENT_FAILED retry flows: multiple Transactions may exist per `orderId`, each with
+a distinct Xendit invoice ID. Using `orderId` as `Transaction.id` would violate the
+`@id` uniqueness constraint on retry.
+
+**Idempotency guard (DL-004)**: The action checks for an existing PENDING Transaction
+by `orderId` before calling Xendit. Double-submit or browser back+resubmit fire the
+action twice; without this guard, two Xendit invoices would be created and the client
+double-charged. `Transaction.externalId` UNIQUE constraint is the DB-level fallback if
+the guard is bypassed by a race condition.
+
+**`Decimal` → `string` at RSC boundary**: `Order.quotedPrice` is `Prisma.Decimal` at
+runtime. Passing it as a Client Component prop causes a Next.js serialization crash.
+The RSC converts it with `.toFixed(2)`. `Prisma.Decimal` must not appear in `ui.tsx`
+props.
+
+**No provider abstraction interface (DL-001)**: ADR-001 rejects premature abstraction.
+Switching to PayMongo requires adding `src/lib/payments/paymongo.ts` and updating one
+import in `action.ts` — no schema migration, no interface changes.
+
+**`isValidStatusTransition()` not called (DL-007)**: The checkout action creates a
+Transaction record only. No `Order.status` mutation occurs, so the state-machine guard
+does not apply. Calling it here would be misleading; the webhook handler uses it when
+advancing status after Xendit confirms payment.
+
+**Currency hardcoded to PHP (DL-008)**: PipetGo operates in the Philippines only.
+`Transaction.currency` schema default is `PHP` and all quoted prices are in PHP.
+No multi-currency requirement exists; parameterizing currency would be YAGNI per ADR-001.
+
+**`xendit.ts` infrastructure boundary**: `src/lib/payments/xendit.ts` must not import
+from `@/features/*`. It is an infrastructure helper consumed by feature slices, not
+part of any slice itself. This mirrors the direction of the ADR-001 boundary rule:
+features may import from `src/lib/`, but `src/lib/` must not import from `src/features/`.
+
+## Invariants
+
+- `redirect()` is never wrapped in `try/catch` in `action.ts` — Next.js throws
+  `NEXT_REDIRECT` internally; catching it swallows the redirect silently.
+- `Order.status` is never mutated by this slice. The webhook handler is the sole
+  writer of status transitions for PAYMENT_PENDING orders.
+- `Transaction.provider` is the string literal `'xendit'` — the schema column is
+  `String`, not an enum, to remain provider-agnostic.
+- `CheckoutOrderDTO` fields are all `string` — no `Prisma.Decimal` or `Date` objects
+  cross the RSC-to-client boundary.
+- The idempotency guard (PENDING Transaction lookup) precedes every Xendit API call.
+- `Order.quotedPrice` is always non-null when `status === PAYMENT_PENDING` —
+  `resolveOrderInitialState` sets `quotedPrice` before transitioning to that status.
+  The non-null assertion (`!`) in `page.tsx` and the null guard in `action.ts` are
+  safe for PAYMENT_PENDING orders; the null guard in the action provides defense
+  against any future state-machine changes that might relax this guarantee.

```


**CC-M-002-005** (src/features/payments/checkout/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/payments/checkout/CLAUDE.md
@@ -0,0 +1,13 @@
+# checkout/
+
+Vertical slice: CLIENT with a PAYMENT_PENDING order is redirected to Xendit-hosted
+invoice. Read `README.md` for the two-ID scheme, idempotency guard, and Xendit-first
+ordering invariants.
+
+## Files
+
+| File        | What                                                                                         | When to read                                                    |
+| ----------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
+| `page.tsx`  | Async RSC — authenticates, guards PAYMENT_PENDING status, maps Decimal to string, renders summary | Modifying auth gate, order fetch, or `CheckoutOrderDTO`    |
+| `action.ts` | Server Action — TOCTOU guard, idempotency check, Xendit invoice creation, Transaction write | Modifying checkout flow, idempotency, or DB write               |
+| `ui.tsx`    | `'use client'` summary card — `useActionState`, Pay Now form, inline error display          | Modifying summary layout, error display, or button behaviour    |

```


**CC-M-002-006** (src/features/payments/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/payments/CLAUDE.md
@@ -0,0 +1,11 @@
+# payments/
+
+Payment feature slices. Each subdirectory is one vertical slice.
+
+## Subdirectories
+
+| Directory    | What                                                                       | When to read                                              |
+| ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
+| `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |

```

