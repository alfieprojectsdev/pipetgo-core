# Plan

## Overview

completeOrder in lab-fulfillment redirects to /dashboard/lab which 404s because no page exists at that route. LAB_ADMIN users have no way to see their lab orders after completing fulfillment.

**Approach**: A single VSA slice at src/features/labs/dashboard/ with an RSC page.tsx (auth + lab ownership + single findMany query + DTO mapping) and a use client ui.tsx (three-tab order listing with useState switching). App router mount at src/app/dashboard/lab/page.tsx as a single-line re-export.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Single Prisma query with client-side tab filtering | Order table has @@index([labId]) backing the findMany -> single query returns all lab orders -> client-side .filter() splits into three tabs with zero additional DB calls -> simpler than three parallel queries which triple auth/ownership guard code. Scale note: order growth is unbounded; for MVP this is acceptable since lab order volumes are low (tens to low hundreds). If volume grows beyond ~500 orders, pagination should be added as a follow-up slice — captured as a known limitation, not addressed now per explicit out-of-scope constraint. |
| DL-002 | Client-side useState tab switching, not URL-based searchParams | User spec says no direct-link requirement -> useState is simpler -> no URL sync overhead -> matches lab-fulfillment conditional rendering pattern |
| DL-003 | Incoming/Active tabs sorted oldest-first (FIFO); History tab newest-first via toReversed() | Lab processes orders in FIFO order for fairness -> Prisma query uses orderBy createdAt asc -> History reverses client-side so most recent completions appear first -> avoids two separate queries with different sort orders |
| DL-004 | clientProfile?.name with Unknown Client fallback instead of filtering out null clientProfile orders | Prior QR found critical bug: filtering orders where clientProfile is null silently drops orders -> lab admin loses visibility of real orders -> fallback string preserves all orders in the listing |
| DL-006 | Use findMany for lab lookup and guard against multiple labs | Lab.ownerId has @@index but NOT @@unique — schema permits multiple labs per owner -> findFirst silently picks one, dropping orders from other labs -> use prisma.lab.findMany({ where: { ownerId } }) and if result.length !== 1, throw or return notFound() -> this guards against silent data loss while keeping MVP simplicity -> when multi-lab support is added later, the query and UI will be explicitly redesigned |
| DL-005 | No tests for this slice | Read-only RSC page with no server actions or mutations -> existing lab-fulfillment slice has no tests -> no test infrastructure in project -> testing a page component requires integration test setup that does not exist yet -> consistent with established pattern |
| DL-007 | Mount slice at src/features/labs/dashboard/ per user specification and features/ CLAUDE.md convention | User explicitly specified labs/ directory -> features/ CLAUDE.md confirms labs/ is for lab-facing features -> orders/ would violate feature directory ownership convention |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Separate page per tab (/dashboard/lab/incoming, /dashboard/lab/active, etc.) | Duplicates auth and ownership guard logic across three pages; single page with client-side tabs matches the conditional rendering pattern used in lab-fulfillment (ref: DL-002) |
| Fetch all orders in three parallel Prisma queries (one per tab status group) | Single query with all statuses + client-side split is simpler; Order has @@index([labId]) so findMany is index-backed; three queries triple DB round-trips for marginal benefit at current scale (ref: DL-001) |
| Mount slice in src/features/orders/lab-dashboard/ instead of src/features/labs/dashboard/ | User explicitly specified src/features/labs/dashboard/; features/ CLAUDE.md confirms labs/ is the correct directory for lab-facing features (ref: DL-007) |

## Milestones

### Milestone 1: Lab dashboard slice — RSC page, client UI, app router mount

**Files**: src/features/labs/dashboard/page.tsx, src/features/labs/dashboard/ui.tsx, src/app/dashboard/lab/page.tsx, src/features/labs/CLAUDE.md

#### Code Intent

- **CI-M-001-001** `src/features/labs/dashboard/page.tsx`: Async RSC entry point for /dashboard/lab. Calls auth() and redirects to /auth/signin if session missing or role is not LAB_ADMIN. Finds labs via prisma.lab.findMany({ where: { ownerId: session.user.id } }); returns notFound() if labs.length === 0 or labs.length > 1 (guards against silent multi-lab data loss since ownerId has no unique constraint). Sets lab = labs[0]. Queries prisma.order.findMany({ where: { labId: lab.id, status: { in: [ACKNOWLEDGED, IN_PROGRESS, COMPLETED, CANCELLED] } }, include: { service: true, clientProfile: true }, orderBy: { createdAt: asc } }). Maps each order to a LabDashboardOrderDTO with fields: id (string), serviceName (order.service.name), clientName (order.clientProfile?.name ?? Unknown Client), status (string), createdAt (order.createdAt.toISOString()). Exports LabDashboardOrderDTO type for ui.tsx import. Renders <LabDashboardUI orders={dtos} />. (refs: DL-001, DL-003, DL-004, DL-006)
- **CI-M-001-002** `src/features/labs/dashboard/ui.tsx`: use client component. Accepts orders: LabDashboardOrderDTO[] prop. Uses useState<Incoming|Active|History> for active tab (default: Incoming). Filters orders into three groups: Incoming (status === ACKNOWLEDGED), Active (status === IN_PROGRESS), History (status === COMPLETED or CANCELLED). History array uses toReversed() for newest-first display. Renders three tab buttons with active styling. Renders a table with columns: Order ID, Service Name, Client Name, Date (formatted from ISO string). Each row is an <a> link to /dashboard/lab/orders/{orderId}. Empty state message per tab when no orders match. Imports only from @/components/ui/ (Card, Button) and sibling page.tsx type. (refs: DL-001, DL-002, DL-003)
- **CI-M-001-003** `src/app/dashboard/lab/page.tsx`: Single-line re-export: export { default } from @/features/labs/dashboard/page. Comment line references the VSA slice location. Follows exact pattern of src/app/dashboard/lab/orders/[orderId]/page.tsx.
- **CI-M-001-004** `src/features/labs/CLAUDE.md`: Navigation index for the labs/ feature directory. Contains a Files table (no files at this level) and Subdirectories table listing dashboard/ with description Lab dashboard — LAB_ADMIN order listing with Incoming/Active/History tabs and When to read trigger Implementing or modifying the lab dashboard page. Follows the pattern of src/features/orders/CLAUDE.md.

#### Code Changes

**CC-M-001-001** (src/features/labs/dashboard/page.tsx) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/dashboard/page.tsx
@@ -0,0 +1,79 @@
+/**
+ * RSC entry point for the lab dashboard.
+ *
+ * Route: /dashboard/lab
+ * Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
+ * Guard: Returns 404 if the authenticated user has zero labs or more than one
+ *        lab (Lab.ownerId has no unique constraint, so multi-lab is guarded
+ *        explicitly to avoid silent data loss).
+ *
+ * Date fields are converted to ISO strings before being passed to the client
+ * component to prevent Next.js RSC serialization failure on Date objects.
+ */
+
+import { notFound, redirect } from 'next/navigation'
+import { OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { LabDashboardUI } from './ui'
+
+/**
+ * All fields are primitive types so Next.js can serialize them across the
+ * RSC-to-client boundary without crashing on Date objects.
+ */
+export type LabDashboardOrderDTO = {
+  id: string
+  serviceName: string
+  clientName: string
+  status: string
+  createdAt: string
+}
+
+export default async function LabDashboardPage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  // Lab.ownerId has @@index but NOT @@unique — multiple labs per owner is
+  // schema-valid. findMany guards against silent data loss that findFirst
+  // would cause by silently picking one lab. (ref: DL-006)
+  const labs = await prisma.lab.findMany({
+    where: { ownerId: session.user.id },
+  })
+
+  if (labs.length !== 1) notFound()
+
+  const lab = labs[0]
+
+  const orders = await prisma.order.findMany({
+    where: {
+      labId: lab.id,
+      status: {
+        in: [
+          OrderStatus.ACKNOWLEDGED,
+          OrderStatus.IN_PROGRESS,
+          OrderStatus.COMPLETED,
+          OrderStatus.CANCELLED,
+        ],
+      },
+    },
+    include: { service: true, clientProfile: true },
+    orderBy: { createdAt: 'asc' },
+  })
+
+  // clientProfile?.name fallback preserves all orders in the listing.
+  // Filtering out null clientProfile orders would silently drop real orders
+  // from the lab admin view. (ref: DL-004)
+  const dtos: LabDashboardOrderDTO[] = orders.map((order) => ({
+    id: order.id,
+    serviceName: order.service.name,
+    clientName: order.clientProfile?.name ?? 'Unknown Client',
+    status: order.status,
+    createdAt: order.createdAt.toISOString(),
+  }))
+
+  return <LabDashboardUI orders={dtos} />
+}
```

**Documentation:**

```diff
--- a/src/features/labs/dashboard/page.tsx
+++ b/src/features/labs/dashboard/page.tsx
@@ -20,7 +20,8 @@ import { LabDashboardUI } from './ui'
 
 /**
  * All fields are primitive types so Next.js can serialize them across the
- * RSC-to-client boundary without crashing on Date objects.
+ * RSC-to-client boundary without crashing on Date objects. Does not include
+ * quotedPrice because the listing view does not display pricing.
  */
 export type LabDashboardOrderDTO = {

```


**CC-M-001-002** (src/features/labs/dashboard/ui.tsx) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/dashboard/ui.tsx
@@ -0,0 +1,115 @@
+'use client'
+
+/**
+ * Client component for the lab dashboard.
+ *
+ * Renders three tabs — Incoming (ACKNOWLEDGED), Active (IN_PROGRESS),
+ * History (COMPLETED or CANCELLED) — with client-side useState switching.
+ * Incoming and Active tabs display orders oldest-first (FIFO).
+ * History tab displays orders newest-first via toReversed().
+ */
+
+import { useState } from 'react'
+import { Button } from '@/components/ui/button'
+import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
+import type { LabDashboardOrderDTO } from './page'
+
+type Tab = 'Incoming' | 'Active' | 'History'
+
+type LabDashboardUIProps = {
+  orders: LabDashboardOrderDTO[]
+}
+
+function OrderTable({ orders }: { orders: LabDashboardOrderDTO[] }) {
+  if (orders.length === 0) {
+    return (
+      <p className="text-sm text-gray-500 py-4 text-center">No orders to display.</p>
+    )
+  }
+
+  return (
+    <table className="w-full text-sm">
+      <thead>
+        <tr className="border-b text-left text-gray-600">
+          <th className="pb-2 pr-4 font-medium">Order ID</th>
+          <th className="pb-2 pr-4 font-medium">Service Name</th>
+          <th className="pb-2 pr-4 font-medium">Client Name</th>
+          <th className="pb-2 font-medium">Date</th>
+        </tr>
+      </thead>
+      <tbody>
+        {orders.map((order) => (
+          <tr key={order.id} className="border-b last:border-0">
+            <td className="py-3 pr-4">
+              <a
+                href={`/dashboard/lab/orders/${order.id}`}
+                className="font-mono text-xs text-blue-600 hover:underline"
+              >
+                {order.id.slice(0, 8)}…
+              </a>
+            </td>
+            <td className="py-3 pr-4">{order.serviceName}</td>
+            <td className="py-3 pr-4">{order.clientName}</td>
+            <td className="py-3">
+              {new Date(order.createdAt).toLocaleDateString()}
+            </td>
+          </tr>
+        ))}
+      </tbody>
+    </table>
+  )
+}
+
+export function LabDashboardUI({ orders }: LabDashboardUIProps) {
+  const [activeTab, setActiveTab] = useState<Tab>('Incoming')
+
+  const incoming = orders.filter((o) => o.status === 'ACKNOWLEDGED')
+  const active = orders.filter((o) => o.status === 'IN_PROGRESS')
+  // History is newest-first so lab admins see the most recent completions
+  // at the top. The Prisma query returns all orders oldest-first (asc) to
+  // satisfy FIFO for Incoming/Active; History reverses client-side. (ref: DL-003)
+  const history = orders
+    .filter((o) => o.status === 'COMPLETED' || o.status === 'CANCELLED')
+    .toReversed()
+
+  const tabs: { label: Tab; count: number }[] = [
+    { label: 'Incoming', count: incoming.length },
+    { label: 'Active', count: active.length },
+    { label: 'History', count: history.length },
+  ]
+
+  const currentOrders =
+    activeTab === 'Incoming' ? incoming : activeTab === 'Active' ? active : history
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <h1 className="text-2xl font-bold text-gray-900">Lab Dashboard</h1>
+        </div>
+
+        <Card>
+          <CardHeader>
+            <CardTitle>Orders</CardTitle>
+          </CardHeader>
+          <CardContent>
+            <div className="flex gap-2 mb-6">
+              {tabs.map(({ label, count }) => (
+                <Button
+                  key={label}
+                  variant={activeTab === label ? 'default' : 'outline'}
+                  onClick={() => setActiveTab(label)}
+                >
+                  {label}
+                  <span className="ml-1.5 rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
+                    {count}
+                  </span>
+                </Button>
+              ))}
+            </div>
+
+            <OrderTable orders={currentOrders} />
+          </CardContent>
+        </Card>
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/labs/dashboard/ui.tsx
+++ b/src/features/labs/dashboard/ui.tsx
@@ -72,6 +72,14 @@ function OrderTable({ orders }: { orders: LabDashboardOrderDTO[] }) {
   )
 }
 
+/**
+ * Receives all lab orders in a single array and partitions them client-side
+ * into the three tabs. A single RSC fetch avoids three separate round-trips
+ * and keeps the auth + ownership guard logic in one place. (ref: DL-001)
+ *
+ * Tab state is managed with useState; no URL query param is used because
+ * direct-linking to a specific tab is not required. (ref: DL-002)
+ */
 export function LabDashboardUI({ orders }: LabDashboardUIProps) {
   const [activeTab, setActiveTab] = useState<Tab>('Incoming')

```


**CC-M-001-003** (src/app/dashboard/lab/page.tsx) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/lab/page.tsx
@@ -0,0 +1,3 @@
+// App router mount point for the lab dashboard RSC.
+// Implementation lives in src/features/labs/dashboard/page.tsx (DL-007).
+// This file is a re-export only; all logic belongs to the feature slice.
+export { default } from '@/features/labs/dashboard/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/lab/page.tsx
+++ b/src/app/dashboard/lab/page.tsx
@@ -1,3 +1,5 @@
 // App router mount point for the lab dashboard RSC.
 // Implementation lives in src/features/labs/dashboard/page.tsx (DL-007).
 // This file is a re-export only; all logic belongs to the feature slice.
+// Keeping logic in the feature slice preserves VSA boundary isolation
+// and allows the slice to be tested independently of the app router.
 export { default } from '@/features/labs/dashboard/page'

```


**CC-M-001-004** (src/features/labs/CLAUDE.md) - implements CI-M-001-004

**Code:**

```diff
--- /dev/null
+++ b/src/features/labs/CLAUDE.md
@@ -0,0 +1,13 @@
+# labs/
+
+Lab feature slices. Each subdirectory is a vertical slice scoped to one lab workflow.
+
+## Files
+
+No files at this level.
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `dashboard/` | Lab dashboard — LAB_ADMIN order listing with Incoming/Active/History tabs | Implementing or modifying the lab dashboard page |
```

**Documentation:**

```diff
--- a/src/features/labs/CLAUDE.md
+++ b/src/features/labs/CLAUDE.md
@@ -1,6 +1,8 @@
 # labs/
 
-Lab feature slices. Each subdirectory is a vertical slice scoped to one lab workflow.
+Lab feature slices. Each subdirectory is a vertical slice scoped to one lab
+workflow. Per VSA boundary rules (ADR-001), slices under labs/ must not import
+UI components from other feature slices. (ref: DL-007)
 
 ## Files

```


**CC-M-001-005** (src/features/labs/dashboard/CLAUDE.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/labs/dashboard/CLAUDE.md
@@ -0,0 +1,12 @@
+# dashboard/
+
+## Files
+
+| File       | What                                                                    | When to read                                                             |
+| ---------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------ |
+| `page.tsx` | Async RSC — LAB_ADMIN auth guard, lab ownership guard, order fetch, DTO | Modifying auth gate, order fetch, ownership guard, or `LabDashboardOrderDTO` |
+| `ui.tsx`   | `'use client'` — client-side tab switching; order partitioning; `OrderTable` sub-component | Modifying tab layout, table columns, sort order, or empty state |
+| `README.md` | Architecture decisions, invariants, sort order, query guard rationale   | Understanding design decisions before modifying fetch or render logic    |

```


**CC-M-001-006** (src/features/labs/dashboard/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/labs/dashboard/README.md
@@ -0,0 +1,55 @@
+# dashboard/
+
+Vertical slice serving `/dashboard/lab` — LAB_ADMIN order listing with
+three status tabs.
+
+## Auth and Ownership Guard
+
+`page.tsx` uses `auth()` to verify `session.user.role === 'LAB_ADMIN'` then
+calls `prisma.lab.findMany({ where: { ownerId: session.user.id } })`. If the
+result is not exactly one lab, `notFound()` is returned. (ref: DL-006)
+
+`Lab.ownerId` has `@@index` but NOT `@@unique` — the schema permits multiple
+labs per owner. `findFirst` would silently pick one lab and drop orders from
+others. `findMany` with a length guard prevents silent data loss while keeping
+the MVP query simple. When multi-lab support is added, the query and UI will
+be redesigned explicitly.
+
+## Query Strategy
+
+A single `prisma.order.findMany({ where: { labId: lab.id } })` returns all lab
+orders. Client-side `.filter()` splits them into the three tab arrays. (ref: DL-001)
+
+Three parallel queries were rejected: they triple the auth and ownership guard
+code without a meaningful performance difference. `Order` has `@@index([labId])`
+so the `findMany` is index-backed. Pagination is deferred to a follow-up slice
+when order volume warrants it.
+
+## Sort Order
+
+Prisma query uses `orderBy: { createdAt: 'asc' }`. Incoming and Active tabs
+display in this FIFO order (oldest first = next to process). History tab calls
+`.toReversed()` in `ui.tsx` to show most recent completions first. (ref: DL-003)
+
+Two queries with different `orderBy` were rejected: adds complexity for a
+client-side operation that has no observable performance cost at MVP scale.
+
+## Tab Switching
+
+Tab selection is `useState` only — no URL `searchParams`. (ref: DL-002)
+
+Direct-linking to a specific tab was not specified as a requirement. `useState`
+matches the `lab-fulfillment` conditional rendering pattern already in the
+codebase.
+
+## Client Name Fallback
+
+`clientProfile?.name ?? 'Unknown Client'` is used for every order row.
+(ref: DL-004)
+
+Orders where `clientProfile` is `null` must not be filtered out — they
+represent real orders where the client profile is missing, not invalid orders.
+Filtering silently drops visible orders from the lab admin's view.
+
+## DTO
+
+`LabDashboardOrderDTO` uses primitive types only. `createdAt` is serialized to
+ISO string so Next.js can pass it across the RSC-to-client boundary. The DTO
+does not include `quotedPrice` — the listing view does not display pricing.

```


## README Entries

### src/features/labs/dashboard/README.md/README.md

Auth guard checks `session.user.role === 'LAB_ADMIN'` (UserRole enum: CLIENT, LAB_ADMIN, ADMIN — no LAB variant). Lab lookup uses `findMany` not `findFirst`; `notFound()` if result count is not exactly 1. Lab.ownerId has `@@index` but NOT `@@unique` — multiple labs per owner is schema-valid, so `findFirst` would silently pick one and drop orders from others. (ref: DL-006)

### src/features/labs/dashboard/README.md/README.md

All orders are fetched in one query filtered by `labId`; tab partitioning is client-side in `ui.tsx`. (ref: DL-001) Prisma query uses `orderBy: { createdAt: 'asc' }`; History tab calls `.toReversed()` in ui.tsx for newest-first display. (ref: DL-003) `clientProfile?.name ?? 'Unknown Client'` — orders with null clientProfile are never filtered out. (ref: DL-004) DTO maps `createdAt` to ISO string; no Prisma.Decimal in this DTO (quotedPrice is not included in the listing view).

### src/features/labs/dashboard/README.md/README.md

Tab switching uses `useState`; no URL query param is used because direct-linking to a specific tab is not required. (ref: DL-002)

### src/features/labs/dashboard/README.md/README.md

No automated tests exist for this slice. This is a read-only RSC page with no server actions or mutations. No test infrastructure exists in the project; consistent with the established pattern in lab-fulfillment. (ref: DL-005)
