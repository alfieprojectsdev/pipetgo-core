# Plan

## Overview

Lab technicians have no interface to view acknowledged orders, begin processing, or mark orders as completed with result notes.

**Approach**: A single vertical slice under src/features/orders/lab-fulfillment/ with an RSC page (auth + ownership guard + DTO), two server actions (startProcessing, completeOrder) using isValidStatusTransition as the domain gate, and a conditional client component. Mounted at /dashboard/lab/orders/[orderId] via app router re-export.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Use LAB_ADMIN role for auth guard (not LAB) | Schema enum has CLIENT, LAB_ADMIN, ADMIN -> no LAB role exists -> user prompt misstates role name -> schema is authoritative |
| DL-002 | Single page with conditional UI for both transitions | Two transitions (ACKNOWLEDGED->IN_PROGRESS, IN_PROGRESS->COMPLETED) on same order -> separate pages duplicate auth/ownership guards -> single page with conditional rendering matches checkout pattern and reduces files |
| DL-003 | Completion notes stored in Order.notes field via update | Order model has notes String? field -> file upload is out of scope -> plain text completion notes map directly to existing column -> no schema change needed |
| DL-004 | notFound() for unauthorized order access | checkout/page.tsx uses notFound() for wrong-owner access -> consistent pattern prevents information leakage about order existence -> follows established convention |
| DL-005 | App router route re-exports RSC page from feature slice | No dashboard routes exist yet -> app router route.tsx at src/app/dashboard/lab/orders/[orderId]/page.tsx imports and re-exports from feature slice -> matches Next.js app router convention with VSA |
| DL-006 | revalidatePath after mutations, no redirect after startProcessing | startProcessing keeps lab on same page to see updated status -> revalidatePath triggers RSC re-render with IN_PROGRESS state -> completeOrder redirects to lab dashboard via redirect() |
| DL-007 | TOCTOU guard in both server actions re-fetches order from DB | Order status may change between page render and form submission -> server action must re-fetch and re-check status -> formData orderId alone is untrusted -> matches checkout/action.ts TOCTOU pattern |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Use UserRole.LAB for auth guard | LAB does not exist in the Prisma schema enum; only CLIENT, LAB_ADMIN, ADMIN exist. Schema is authoritative over user prompt. (ref: DL-001) |
| Reuse UI components from create-order slice | Strict VSA boundary prohibits cross-slice UI imports. Each slice owns its own UI components per ADR-001. (ref: DL-002) |
| Implement file upload for result attachments | Scoped out of this slice. Plain text notes field is the stub; file upload is a future slice. (ref: DL-003) |

### Constraints

- MUST: Auth guard checks UserRole.LAB_ADMIN (schema enum — no LAB role exists)
- MUST: Ownership guard — order.lab.ownerId === session.user.id before rendering
- MUST: startProcessing uses isValidStatusTransition(ACKNOWLEDGED, IN_PROGRESS) before Prisma write
- MUST: completeOrder uses isValidStatusTransition(IN_PROGRESS, COMPLETED) before Prisma write
- MUST NOT: Import or reuse UI components from create-order slice (strict VSA)
- MUST: DTO maps Dates to ISO strings and Decimals to fixed strings before passing to client component
- MUST: File upload stubbed as plain text notes field — out of scope for this slice
- SHOULD: Follow checkout/page.tsx RSC pattern for auth + fetch + DTO + render

### Known Risks

- **TOCTOU race — order status changes between page render and form submission, causing server action to write invalid state transition**: Both server actions re-fetch order from DB and re-check status via isValidStatusTransition before Prisma write; formData orderId alone is untrusted
- **Role mismatch — user prompt says LAB but schema has LAB_ADMIN; auth guard using nonexistent role would deny all lab users**: DL-001 resolves this: use LAB_ADMIN from schema enum; documented in rejected_alternatives and invisible_knowledge

## Invisible Knowledge

### System

UserRole enum has CLIENT, LAB_ADMIN, ADMIN — no LAB role. Decimal->string uses .toFixed(2), Date->string uses .toISOString() (checkout DTO pattern). isValidStatusTransition is a domain gate called BEFORE prisma write, not post-write validation. Two actions in one action.ts is fine (checkout pattern).

### Invariants

- No cross-slice imports of UI components; ui.tsx must not import from create-order or any other feature slice. Domain imports (state-machine, events) are allowed per ESLint boundary rule.
- TOCTOU: server action must re-fetch order from DB and re-check status before writing — formData orderId alone is not trusted
- ADR-001: each slice owns its status transitions; lab-fulfillment owns ACKNOWLEDGED->IN_PROGRESS and IN_PROGRESS->COMPLETED

## Milestones

### Milestone 1: Lab fulfillment slice — server actions and RSC page

**Files**: src/features/orders/lab-fulfillment/page.tsx, src/features/orders/lab-fulfillment/action.ts, src/features/orders/lab-fulfillment/ui.tsx, src/app/dashboard/lab/orders/[orderId]/page.tsx

**Acceptance Criteria**:

- npx tsc --noEmit passes with no errors on all 4 new files
- npx eslint src/features/orders/lab-fulfillment/ passes with no cross-slice import violations
- page.tsx redirects unauthenticated users and returns notFound() for non-LAB_ADMIN, missing order, or ownership mismatch
- startProcessing action transitions ACKNOWLEDGED order to IN_PROGRESS and revalidates /dashboard/lab/orders/[orderId]
- completeOrder action transitions IN_PROGRESS order to COMPLETED with notes, revalidates path, and redirects to /dashboard/lab
- Both actions return { message: 'Order cannot be transitioned to <target> from current status.' } when isValidStatusTransition returns false
- ui.tsx imports only from @/components/ui/, react, and sibling files — no cross-slice UI imports

#### Code Intent

- **CI-M-001-001** `src/features/orders/lab-fulfillment/page.tsx`: Async RSC entry point. Calls auth() and redirects to /auth/signin if session missing or role is not LAB_ADMIN (DL-001). Fetches Order by params.orderId with include { lab: true, service: true, clientProfile: true }. Guards: notFound() if order missing, if order.lab.ownerId !== session.user.id (ownership check), or if status is not ACKNOWLEDGED and not IN_PROGRESS. Builds LabFulfillmentOrderDTO with all Dates mapped to ISO strings via .toISOString() and Decimals mapped to fixed strings via .toFixed(2). Exports DTO type for ui.tsx import. Renders LabFulfillmentView client component passing the DTO. (refs: DL-001, DL-004, DL-005)
- **CI-M-001-002** `src/features/orders/lab-fulfillment/action.ts`: Two exported server actions with use server directive. ActionState type: { message?: string } | null. (1) startProcessing: extracts orderId from formData, calls auth() with LAB_ADMIN guard, re-fetches order with include { lab: true } (TOCTOU), checks order.lab.ownerId === session.user.id, calls isValidStatusTransition(order.status, OrderStatus.IN_PROGRESS) — if false, returns { message: 'Order cannot be transitioned to IN_PROGRESS from current status.' }; then prisma.order.update setting status to IN_PROGRESS. Calls revalidatePath(`/dashboard/lab/orders/${orderId}`). Returns null on success. (2) completeOrder: same auth and TOCTOU pattern, extracts notes from formData as string, calls isValidStatusTransition(order.status, OrderStatus.COMPLETED) — if false, returns { message: 'Order cannot be transitioned to COMPLETED from current status.' }; then prisma.order.update setting status to COMPLETED and notes to the form value. Calls revalidatePath(`/dashboard/lab/orders/${orderId}`) then redirect('/dashboard/lab'). (refs: DL-001, DL-003, DL-006, DL-007)
- **CI-M-001-003** `src/features/orders/lab-fulfillment/ui.tsx`: use client component. Imports useActionState from react. Receives LabFulfillmentOrderDTO prop. Conditionally renders based on order.status string: when ACKNOWLEDGED, shows order details card (service name, client name, email, quoted price, created date, existing notes) and a Start Processing form with hidden orderId input and submit button bound to startProcessing action via useActionState. When IN_PROGRESS, shows same order details plus a textarea for completion notes (name=notes) and a Complete Order form bound to completeOrder action via useActionState. Both forms display error messages from ActionState via destructive Alert. Uses Button, Card, CardHeader, CardTitle, CardContent, Alert, AlertDescription from @/components/ui/. Plain HTML textarea element for notes input (no shadcn Textarea component exists). (refs: DL-002, DL-003)
- **CI-M-001-004** `src/app/dashboard/lab/orders/[orderId]/page.tsx`: App router page that re-exports the default export from @/features/orders/lab-fulfillment/page. Single line: export { default } from the feature slice page. This mounts the RSC at the /dashboard/lab/orders/[orderId] route. (refs: DL-005)

#### Code Changes

**CC-M-001-001** (src/features/orders/lab-fulfillment/page.tsx) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/lab-fulfillment/page.tsx
@@ -0,0 +1,66 @@
+/**
+ * RSC entry point for the lab fulfillment page.
+ *
+ * Route: /dashboard/lab/orders/[orderId]
+ * Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
+ * Guard: Renders 404 for any order that does not belong to the authenticated
+ *        lab admin (lab.ownerId !== session.user.id), lacks a lab relation,
+ *        or is not in ACKNOWLEDGED or IN_PROGRESS status.
+ *
+ * Decimal fields (Order.quotedPrice) are converted to string before being passed
+ * to the client component to prevent Next.js RSC serialization failure on
+ * Prisma.Decimal values.
+ */
+
+import { notFound, redirect } from 'next/navigation'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { LabFulfillmentUI } from './ui'
+
+/**
+ * All fields are primitive strings so Next.js can serialize them across the
+ * RSC-to-client boundary without crashing on Prisma.Decimal or Date objects.
+ */
+export type LabOrderDTO = {
+  id: string
+  serviceName: string
+  quotedPrice: string
+  status: string
+  notes: string | null
+  clientName: string
+  clientEmail: string
+  createdAt: string
+}
+
+export default async function LabFulfillmentPage({
+  params,
+}: {
+  params: { orderId: string }
+}) {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: params.orderId },
+    include: { lab: true, service: true, clientProfile: true },
+  })
+
+  if (!order || !order.lab) notFound()
+  if (order.lab.ownerId !== session.user.id) notFound()
+  if (
+    order.status !== OrderStatus.ACKNOWLEDGED &&
+    order.status !== OrderStatus.IN_PROGRESS
+  ) {
+    notFound()
+  }
+  if (!order.clientProfile) notFound()
+
+  const dto: LabOrderDTO = {
+    id: order.id,
+    serviceName: order.service.name,
+    quotedPrice: order.quotedPrice != null ? order.quotedPrice.toFixed(2) : '0.00',
+    status: order.status,
+    notes: order.notes ?? null,
+    clientName: order.clientProfile.name,
+    clientEmail: order.clientProfile.email,
+    createdAt: order.createdAt.toISOString(),
+  }
+
+  return <LabFulfillmentUI order={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/page.tsx
+++ b/src/features/orders/lab-fulfillment/page.tsx
@@ -44,6 +44,11 @@ export default async function LabFulfillmentPage({
   const session = await auth()
   if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
     redirect('/auth/signin')
   }

+  // LAB_ADMIN is the correct schema enum value. The Prisma UserRole enum has
+  // CLIENT, LAB_ADMIN, and ADMIN — there is no LAB variant. (ref: DL-001)
   const order = await prisma.order.findUnique({
     where: { id: params.orderId },
     include: { lab: true, service: true, clientProfile: true },
   })

   if (!order || !order.lab) notFound()
+  // notFound() prevents information leakage: the caller cannot distinguish
+  // a missing order from one that belongs to a different lab. (ref: DL-004)
   if (order.lab.ownerId !== session.user.id) notFound()

```


**CC-M-001-002** (src/features/orders/lab-fulfillment/action.ts) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -0,0 +1,87 @@
+'use server'
+
+/**
+ * Server actions for the lab fulfillment flow.
+ *
+ * startProcessing: ACKNOWLEDGED -> IN_PROGRESS
+ * completeOrder:   IN_PROGRESS  -> COMPLETED
+ *
+ * Both actions:
+ *   1. Validate formData (orderId present).
+ *   2. Auth guard — LAB_ADMIN session required (TOCTOU re-check).
+ *   3. Re-fetch Order from DB with lab relation and re-check ownership + status
+ *      (TOCTOU guard: status may change between page load and action execution).
+ *   4. Call isValidStatusTransition() before any Prisma write.
+ *   5. Write new status to DB.
+ *   6. revalidatePath so the page reflects the updated state.
+ */
+
+import { revalidatePath } from 'next/cache'
+import { redirect } from 'next/navigation'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { isValidStatusTransition } from '@/domain/orders/state-machine'
+
+type ActionState = { message?: string } | null
+
+export async function startProcessing(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderId = formData.get('orderId') as string | null
+  if (!orderId) return { message: 'Missing order ID.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { lab: true },
+  })
+
+  if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+  if (!isValidStatusTransition(order.status, OrderStatus.IN_PROGRESS)) {
+    return { message: 'Order cannot be moved to in-progress from its current status.' }
+  }
+
+  await prisma.order.update({
+    where: { id: orderId },
+    data: { status: OrderStatus.IN_PROGRESS },
+  })
+
+  revalidatePath(`/dashboard/lab/orders/${orderId}`)
+  return null
+}
+
+export async function completeOrder(
+  _prevState: ActionState,
+  formData: FormData,
+): Promise<ActionState> {
+  const orderId = formData.get('orderId') as string | null
+  if (!orderId) return { message: 'Missing order ID.' }
+
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  const order = await prisma.order.findUnique({
+    where: { id: orderId },
+    include: { lab: true },
+  })
+
+  if (!order || !order.lab || order.lab.ownerId !== session.user.id) {
+    return { message: 'Order not found.' }
+  }
+  if (!isValidStatusTransition(order.status, OrderStatus.COMPLETED)) {
+    return { message: 'Order cannot be completed from its current status.' }
+  }
+
+  const notes = (formData.get('notes') as string | null)?.trim() || null
+
+  await prisma.order.update({
+    where: { id: orderId },
+    data: {
+      status: OrderStatus.COMPLETED,
+      ...(notes != null ? { notes } : {}),
+    },
+  })
+
+  revalidatePath('/dashboard/lab')
+  redirect('/dashboard/lab')
+}
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/action.ts
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -28,6 +28,10 @@ import { isValidStatusTransition } from '@/domain/orders/state-machine'

 type ActionState = { message?: string } | null

+/**
+ * Transitions an ACKNOWLEDGED order to IN_PROGRESS. Re-fetches the order
+ * from the DB on every invocation to guard against TOCTOU races where the
+ * order status changes between page load and form submission. (ref: DL-007)
+ * Ownership is re-verified against Lab.ownerId — formData orderId alone is
+ * untrusted. Page re-renders via revalidatePath; no redirect. (ref: DL-006)
+ */
 export async function startProcessing(
   _prevState: ActionState,
   formData: FormData,
@@ -64,6 +68,10 @@ export async function startProcessing(
   return null
 }

+/**
+ * Transitions an IN_PROGRESS order to COMPLETED and writes the lab
+ * technician's result notes to Order.notes. Applies the same TOCTOU and
+ * ownership guards as startProcessing. Redirects to /dashboard/lab on
+ * success. (ref: DL-006, DL-007)
+ */
 export async function completeOrder(
   _prevState: ActionState,
   formData: FormData,

```


**CC-M-001-003** (src/features/orders/lab-fulfillment/ui.tsx) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/lab-fulfillment/ui.tsx
@@ -0,0 +1,103 @@
+'use client'
+
+/**
+ * Client component for the lab fulfillment page.
+ *
+ * Renders order details and two forms:
+ *   - Start Processing (ACKNOWLEDGED -> IN_PROGRESS)
+ *   - Complete Order   (IN_PROGRESS  -> COMPLETED) with a notes text field
+ *
+ * Each form uses useActionState with its own server action. Only the
+ * relevant form is shown based on the current order status.
+ */
+
+import { useActionState } from 'react'
+import { Button } from '@/components/ui/button'
+import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
+import { Alert, AlertDescription } from '@/components/ui/alert'
+import { startProcessing, completeOrder } from './action'
+import type { LabOrderDTO } from './page'
+
+type LabFulfillmentUIProps = {
+  order: LabOrderDTO
+}
+
+function StartProcessingForm({ orderId }: { orderId: string }) {
+  const [state, formAction, isPending] = useActionState(startProcessing, null)
+
+  return (
+    <div className="space-y-3">
+      {state?.message && (
+        <Alert variant="destructive">
+          <AlertDescription>{state.message}</AlertDescription>
+        </Alert>
+      )}
+      <form action={formAction}>
+        <input type="hidden" name="orderId" value={orderId} />
+        <Button type="submit" className="w-full" disabled={isPending}>
+          {isPending ? 'Starting...' : 'Start Processing'}
+        </Button>
+      </form>
+    </div>
+  )
+}
+
+function CompleteOrderForm({ orderId }: { orderId: string }) {
+  const [state, formAction, isPending] = useActionState(completeOrder, null)
+
+  return (
+    <div className="space-y-3">
+      {state?.message && (
+        <Alert variant="destructive">
+          <AlertDescription>{state.message}</AlertDescription>
+        </Alert>
+      )}
+      <form action={formAction} className="space-y-3">
+        <input type="hidden" name="orderId" value={orderId} />
+        <div className="space-y-1">
+          <label htmlFor="notes" className="text-sm font-medium text-gray-700">
+            Results / Notes
+          </label>
+          <textarea
+            id="notes"
+            name="notes"
+            rows={4}
+            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
+            placeholder="Enter results or notes for this order..."
+          />
+        </div>
+        <Button type="submit" className="w-full" disabled={isPending}>
+          {isPending ? 'Completing...' : 'Complete Order'}
+        </Button>
+      </form>
+    </div>
+  )
+}
+
+export function LabFulfillmentUI({ order }: LabFulfillmentUIProps) {
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-lg mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <a href="/dashboard/lab" className="text-sm text-gray-600 hover:text-gray-900">
+            ← Back to dashboard
+          </a>
+        </div>
+
+        <Card>
+          <CardHeader>
+            <CardTitle>Order Fulfillment</CardTitle>
+          </CardHeader>
+          <CardContent className="space-y-4">
+            <div className="space-y-2">
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Service</span>
+                <span className="font-medium">{order.serviceName}</span>
+              </div>
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Amount</span>
+                <span className="font-medium">₱{order.quotedPrice}</span>
+              </div>
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Client</span>
+                <span className="font-medium">{order.clientName}</span>
+              </div>
+              <div className="flex justify-between">
+                <span className="text-sm text-gray-600">Status</span>
+                <span className="font-medium">{order.status}</span>
+              </div>
+              {order.notes && (
+                <div className="pt-2">
+                  <span className="text-sm text-gray-600">Order Notes</span>
+                  <p className="text-sm mt-1">{order.notes}</p>
+                </div>
+              )}
+            </div>
+
+            {order.status === 'ACKNOWLEDGED' && (
+              <StartProcessingForm orderId={order.id} />
+            )}
+            {order.status === 'IN_PROGRESS' && (
+              <CompleteOrderForm orderId={order.id} />
+            )}
+          </CardContent>
+        </Card>
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/ui.tsx
+++ b/src/features/orders/lab-fulfillment/ui.tsx
@@ -25,6 +25,9 @@ type LabFulfillmentUIProps = {
   order: LabOrderDTO
 }

+/**
+ * Form for the ACKNOWLEDGED -> IN_PROGRESS transition. Submits orderId as a
+ * hidden field; displays the server action error message on failure.
+ */
 function StartProcessingForm({ orderId }: { orderId: string }) {
   const [state, formAction, isPending] = useActionState(startProcessing, null)

@@ -45,6 +49,10 @@ function StartProcessingForm({ orderId }: { orderId: string }) {
   )
 }

+/**
+ * Form for the IN_PROGRESS -> COMPLETED transition. Includes a plain HTML
+ * textarea for result notes (no shadcn Textarea component exists). Notes are
+ * optional; the server action treats an empty value as null. (ref: DL-003)
+ */
 function CompleteOrderForm({ orderId }: { orderId: string }) {
   const [state, formAction, isPending] = useActionState(completeOrder, null)

```


**CC-M-001-004** (src/app/dashboard/lab/orders/[orderId]/page.tsx) - implements CI-M-001-004

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/lab/orders/[orderId]/page.tsx
@@ -0,0 +1,3 @@
+export { default } from '@/features/orders/lab-fulfillment/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/lab/orders/[orderId]/page.tsx
+++ b/src/app/dashboard/lab/orders/[orderId]/page.tsx
@@ -1,1 +1,4 @@
+// App router mount point for the lab fulfillment RSC.
+// Implementation lives in src/features/orders/lab-fulfillment/page.tsx (DL-005).
+// This file is a re-export only; all logic belongs to the feature slice.
 export { default } from '@/features/orders/lab-fulfillment/page'

```


**CC-M-001-005** (src/features/orders/lab-fulfillment/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/lab-fulfillment/README.md
@@ -0,0 +1,90 @@
+# lab-fulfillment
+
+## Overview
+
+Lab fulfillment slice. A LAB_ADMIN who owns an order visits
+`/dashboard/lab/orders/[orderId]`, views order details, and advances the order
+through two status transitions:
+
+- ACKNOWLEDGED -> IN_PROGRESS (Start Processing)
+- IN_PROGRESS  -> COMPLETED   (Complete Order, with result notes)
+
+Both transitions are gated by `isValidStatusTransition()` from the domain
+state machine. File uploads are out of scope; result notes are stored as plain
+text in `Order.notes`.
+
+## Architecture
+
+```
+page.tsx (RSC)
+  -> auth() — LAB_ADMIN only; redirect /auth/signin otherwise (DL-001)
+  -> prisma.order (include lab, service, clientProfile)
+  -> guard: lab.ownerId === session.user.id (ownership) (DL-004)
+  -> guard: status === ACKNOWLEDGED or IN_PROGRESS
+  -> LabOrderDTO (Decimal -> .toFixed(2), Date -> .toISOString())
+  -> <LabFulfillmentUI order={dto} />  (ui.tsx)
+       -> status === 'ACKNOWLEDGED': <StartProcessingForm />
+            -> useActionState(startProcessing)
+       -> status === 'IN_PROGRESS':  <CompleteOrderForm />
+            -> useActionState(completeOrder)
+
+action.ts (Server Actions)
+  startProcessing:
+    -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
+    -> isValidStatusTransition(ACKNOWLEDGED, IN_PROGRESS)
+    -> prisma.order.update status = IN_PROGRESS
+    -> revalidatePath — page re-renders with updated state (DL-006)
+
+  completeOrder:
+    -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
+    -> isValidStatusTransition(IN_PROGRESS, COMPLETED)
+    -> prisma.order.update status = COMPLETED, notes = formData.notes (DL-003)
+    -> revalidatePath then redirect('/dashboard/lab') (DL-006)
+```
+
+## Design Decisions
+
+**LAB_ADMIN role, not LAB (DL-001)**: The Prisma `UserRole` enum contains
+`CLIENT`, `LAB_ADMIN`, and `ADMIN`. There is no `LAB` variant. Auth guards in
+both `page.tsx` and `action.ts` compare `session.user.role !== 'LAB_ADMIN'`.
+Any guard using `'LAB'` would deny all lab users.
+
+**Single page for both transitions (DL-002)**: `ACKNOWLEDGED -> IN_PROGRESS`
+and `IN_PROGRESS -> COMPLETED` are rendered conditionally in one page. Separate
+pages would duplicate the auth and ownership guard logic.
+
+**Completion notes in Order.notes (DL-003)**: `Order.notes` is a nullable
+`String` column. File upload is scoped out of this slice. The textarea value
+is trimmed before write; empty string is treated as null.
+
+**notFound() for unauthorized access (DL-004)**: Both a missing order and an
+ownership mismatch return 404. This prevents information leakage about whether
+an order exists.
+
+**App router re-export (DL-005)**: `src/app/dashboard/lab/orders/[orderId]/page.tsx`
+is a single-line re-export of the RSC from this slice. App router convention
+mounts the route; VSA keeps the implementation in the feature directory.
+
+**TOCTOU guard — re-fetch in both server actions (DL-007)**: Order status can
+change between page load and form submission (e.g., an admin cancels the
+order). Both actions re-fetch the order from the DB and re-verify ownership and
+status before calling `isValidStatusTransition()` and writing to Prisma.
+`formData.orderId` alone is untrusted.
+
+**revalidatePath after startProcessing; redirect after completeOrder (DL-006)**:
+`startProcessing` keeps the lab technician on the same page to see the updated
+IN_PROGRESS state — `revalidatePath` triggers RSC re-render. `completeOrder`
+redirects to `/dashboard/lab` because the order is terminal for this view.
+
+## Invariants
+
+- Auth guard uses `'LAB_ADMIN'` — the string representation of the schema enum.
+  Session role is stored as a string in the JWT token.
+- `isValidStatusTransition()` is called BEFORE every Prisma write. It is a
+  domain gate, not a post-write validation.
+- No cross-slice UI imports. `ui.tsx` imports only from `@/components/ui/`,
+  `react`, and sibling files. Domain imports (`state-machine`) are allowed per
+  the ESLint boundary rule in `eslint.config.js`.
+- `LabOrderDTO` fields are all primitive strings. No `Prisma.Decimal` or `Date`
+  objects cross the RSC-to-client boundary.
+- Both server actions re-fetch the order to guard against TOCTOU races.

```


**CC-M-001-006** (src/features/orders/lab-fulfillment/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/orders/lab-fulfillment/CLAUDE.md
@@ -0,0 +1,18 @@
+# lab-fulfillment/
+
+Vertical slice: LAB_ADMIN views an ACKNOWLEDGED or IN_PROGRESS order, begins
+processing, and completes it with result notes. Read `README.md` for role
+invariants, TOCTOU guard rationale, and transition ownership rules.
+
+## Files
+
+| File        | What                                                                                              | When to read                                                       |
+| ----------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
+| `page.tsx`  | Async RSC — LAB_ADMIN auth, ownership guard, status guard, Decimal->string DTO, renders UI       | Modifying auth gate, order fetch, ownership check, or `LabOrderDTO` |
+| `action.ts` | Two server actions — `startProcessing` (ACKNOWLEDGED->IN_PROGRESS) and `completeOrder` (IN_PROGRESS->COMPLETED); TOCTOU guards | Modifying transitions, notes write, or revalidation |
+| `ui.tsx`    | `'use client'` — conditional rendering per status; `StartProcessingForm` and `CompleteOrderForm` with `useActionState` | Modifying form layout, error display, or notes textarea |

```


**CC-M-001-007** (src/features/orders/CLAUDE.md)

**Documentation:**

```diff
--- a/src/features/orders/CLAUDE.md
+++ b/src/features/orders/CLAUDE.md
@@ -9,3 +9,4 @@ Order feature slices. Each subdirectory is a vertical slice scoped to one order
 | --------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
 | `create-order/` | Client submits a test request for a `LabService`; writes `Order` + `ClientProfile` in one transaction | Implementing or modifying order creation flow |
 | `handle-payment-captured/` | Handles PaymentCapturedEvent from webhook — advances Order status from PAYMENT_PENDING to ACKNOWLEDGED | Implementing or modifying post-payment order advancement |
+| `lab-fulfillment/` | LAB_ADMIN views ACKNOWLEDGED/IN_PROGRESS orders, starts processing (ACKNOWLEDGED->IN_PROGRESS), and completes with notes (IN_PROGRESS->COMPLETED) | Implementing or modifying lab-side order fulfillment |

```

