# Plan

## Overview

Clients have no way to view their submitted orders. The system has a lab dashboard (LAB_ADMIN) but no equivalent client-facing view, leaving clients unable to track order status after submission.

**Approach**: A single VSA slice at src/features/clients/dashboard/ following the established lab dashboard pattern: RSC page with CLIENT auth guard fetches all orders for the authenticated user, maps to a serialization-safe DTO, and passes to a use-client component that renders a flat table with status badges and order detail links.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Mirror lab dashboard RSC+client component split pattern | Lab dashboard (src/features/labs/dashboard/) is the canonical VSA page pattern -> reusing identical structure ensures consistency and reduces review friction -> client dashboard follows same page.tsx (RSC auth+fetch+DTO) + ui.tsx (use client render) split |
| DL-002 | Flat table without tabs or status filtering | Clients view their own orders chronologically (no triage responsibility) -> tab partitioning adds complexity without UX benefit -> flat newest-first table shows full order history; filtering is out of scope per spec |
| DL-003 | Status badge config as exhaustive Record<OrderStatus, {label, className}> covering all 12 values | 12 enum values exist in OrderStatus schema -> missing any causes blank badge at runtime -> Record<OrderStatus,...> (not Record<string,...>) enforces exhaustiveness at compile time via TypeScript; fallback for unknown values is dead code under exhaustive type and should be omitted |
| DL-004 | No shared Badge component — inline badge styling in client dashboard ui.tsx | V2 has no Badge in src/components/ui/ (only in _legacy_v1) -> creating a shared component for one consumer is premature abstraction -> inline span with Tailwind classes is sufficient; extract to shared component when second consumer appears |
| DL-005 | CLIENT role auth guard with redirect, no secondary ownership guard | Lab dashboard requires secondary ownership guard (Lab.ownerId indirection) because lab is a separate entity -> client dashboard queries Order.clientId == session.user.id directly -> the WHERE clause IS the ownership check; no extra guard needed |
| DL-006 | DTO excludes quotedPrice (Decimal) and includes createdAt as ISO string | Next.js RSC serialization throws on Date and Decimal objects -> lab dashboard DTO already excludes quotedPrice for same reason -> client DTO maps createdAt to .toISOString() and omits quotedPrice to prevent serialization crash |
| DL-007 | No test files in this slice | V2 has no test framework configured (no jest/vitest in package.json) -> existing V2 slices (lab dashboard, create-order, checkout) have zero test files -> adding tests requires framework setup which is out of scope for this feature slice |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Tab-partitioned UI (Active/History tabs like lab dashboard) | Clients view their own orders chronologically — no triage responsibility; flat table is sufficient and simpler (ref: DL-002) |
| Filter orders by status (only show active orders) | Clients need full history to see completed lab results; status filter excluded per spec (ref: DL-002) |
| Inline badge logic in JSX using ternary chains | Ternary chains become unreadable at 12 status values; typed Record<OrderStatus,...> map is explicit and statically exhaustive (ref: DL-003) |
| Shared Badge component in src/components/ui/ | No Badge exists in V2 components (only v1 legacy); creating shared component for single consumer is premature; inline span with Tailwind is sufficient (ref: DL-004) (ref: DL-004) |

### Constraints

- MUST: VSA — mount at src/features/clients/dashboard/; no cross-slice imports (ADR-001)
- MUST: Auth guard — CLIENT role; redirect to /auth/signin if unauthenticated or wrong role (ref: DL-005)
- MUST: Fetch orders where Order.clientId == session.user.id; no status filter
- MUST: Status badges — styled visual indicator; exhaustive Record<OrderStatus,...> covering all 12 values (ref: DL-003)
- MUST: Each row links to /dashboard/orders/[orderId] (href only — detail view out of scope)
- MUST: App router re-export at src/app/dashboard/client/page.tsx
- MUST-NOT: No cross-slice imports — VSA boundary (ADR-001)
- SHOULD: DTO maps createdAt (Date) to ISO string; excludes quotedPrice (Decimal) — RSC serialization (ref: DL-006)

### Known Risks

- **Non-exhaustive badge config causes blank/broken badge at runtime if new OrderStatus value added**: Use Record<OrderStatus, ...> typed map — TypeScript compile error if any status is missing; tsc --noEmit gate catches omissions before deploy
- **RSC serialization crash if Date or Decimal object crosses RSC boundary**: DTO maps createdAt to .toISOString() string; quotedPrice excluded from DTO entirely (ref: DL-006)
- **N+1 query if service relation is lazily loaded per row**: findMany includes service relation in single query; Prisma eager-loads the join — no N+1

## Invisible Knowledge

### System

Next.js RSC serialization throws on Date and Prisma Decimal objects crossing the RSC-to-client boundary. Order.@@index([clientId]) exists in schema — the findMany query is index-backed. LabService.name is non-nullable (schema:153: name String) — serviceName DTO field needs no fallback. Order.serviceId is non-nullable String — include: { service: true } never returns null for the service relation.

### Invariants

- Order.clientId == session.user.id IS the ownership check — no secondary guard needed (unlike lab dashboard lab.ownerId indirection)
- LabService.name is non-nullable; serviceName in DTO has no null risk and requires no fallback
- Record<OrderStatus, ...> badge config must be exhaustive — missing any of the 12 values silently renders blank badge at runtime
- createdAt must be converted to ISO string in DTO; raw Date throws on RSC serialization; quotedPrice (Decimal) must be excluded entirely

### Tradeoffs

- Flat table (no tabs): client dashboard omits the Active/History/Incoming tab partition from lab dashboard — clients have no triage need; flat newest-first table shows full history
- No pagination: accepted at MVP order volumes per user spec; can be added later without structural changes to page.tsx
- No shared Badge component: premature abstraction for single consumer; extract when second consumer appears

## Milestones

### Milestone 1: Client dashboard slice

**Files**: src/features/clients/dashboard/page.tsx, src/features/clients/dashboard/ui.tsx, src/app/dashboard/client/page.tsx

**Acceptance Criteria**:

- Authenticated CLIENT user visiting /dashboard/client sees their orders listed newest-first
- Unauthenticated user or non-CLIENT role is redirected to /auth/signin
- Each order row shows Order ID (truncated, linked to /dashboard/orders/{id}), Service Name, Status badge, and Date
- All 12 OrderStatus values render a non-empty, correctly colored badge (no blank badges)
- Empty state (no orders) renders without error and shows descriptive message
- TypeScript compiles without errors (npx tsc --noEmit)

#### Code Intent

- **CI-M-001-001** `src/features/clients/dashboard/page.tsx`: Async RSC default export. Calls auth() and redirects to /auth/signin if session is missing, session.user.id is falsy, or session.user.role is not CLIENT. Queries prisma.order.findMany where clientId equals session.user.id with no status filter, includes service relation, orders by createdAt desc (newest first). Maps results to ClientDashboardOrderDTO with fields: id (string), serviceName (string, from order.service.name), status (string, from order.status), createdAt (string, ISO via .toISOString()). Exports the DTO type. Renders ClientDashboardUI passing the DTO array. (refs: DL-001, DL-002, DL-005, DL-006)
- **CI-M-001-002** `src/features/clients/dashboard/ui.tsx`: use client component. Exports ClientDashboardUI accepting orders: ClientDashboardOrderDTO[]. Defines statusBadgeConfig as Record<OrderStatus, {label: string, className: string}> — exhaustive map covering all 12 OrderStatus values: COMPLETED (green), CANCELLED/PAYMENT_FAILED/QUOTE_REJECTED (red), IN_PROGRESS/ACKNOWLEDGED (blue), QUOTE_PROVIDED/PAYMENT_PENDING/PENDING/REFUND_PENDING (yellow), REFUNDED (gray), QUOTE_REQUESTED (gray). No fallback — Record<OrderStatus,...> is exhaustive by type. Imports OrderStatus enum from @prisma/client for the Record key type. Renders page title Client Dashboard, a Card containing a flat table with columns: Order ID (truncated to first 8 chars, monospace font, linked to /dashboard/orders/{id} via anchor tag with blue hover:underline), Service Name, Status (inline badge span using statusBadgeConfig[order.status as OrderStatus]), Date (createdAt parsed and formatted via new Date(order.createdAt).toLocaleDateString()). Empty state: centered gray text when orders array is empty. (refs: DL-002, DL-003, DL-004)
- **CI-M-001-003** `src/app/dashboard/client/page.tsx`: Single re-export file. Default export re-exported from @/features/clients/dashboard/page. Comment documents this is the app router mount point and that implementation lives in the feature slice per VSA boundary rules. (refs: DL-001)

#### Code Changes

**CC-M-001-001** (src/features/clients/dashboard/page.tsx) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/clients/dashboard/page.tsx
@@ -0,0 +1,52 @@
+/**
+ * RSC entry point for the client dashboard.
+ *
+ * Route: /dashboard/client
+ * Auth:  CLIENT role only; redirects to /auth/signin otherwise.
+ *
+ * Date fields are converted to ISO strings before being passed to the client
+ * component to prevent Next.js RSC serialization failure on Date objects.
+ */
+
+import { redirect } from 'next/navigation'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { ClientDashboardUI } from './ui'
+
+/**
+ * All fields are primitive types so Next.js can serialize them across the
+ * RSC-to-client boundary without crashing on Date objects. Does not include
+ * quotedPrice because the listing view does not display pricing.
+ */
+export type ClientDashboardOrderDTO = {
+  id: string
+  serviceName: string
+  status: string
+  createdAt: string
+}
+
+export default async function ClientDashboardPage() {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'CLIENT') {
+    redirect('/auth/signin')
+  }
+
+  const orders = await prisma.order.findMany({
+    where: { clientId: session.user.id },
+    include: { service: true },
+    orderBy: { createdAt: 'desc' },
+  })
+
+  const dtos: ClientDashboardOrderDTO[] = orders.map((order) => ({
+    id: order.id,
+    serviceName: order.service.name,
+    status: order.status,
+    createdAt: order.createdAt.toISOString(),
+  }))
+
+  return <ClientDashboardUI orders={dtos} />
+}
```

**Documentation:**

```diff
--- a/src/features/clients/dashboard/page.tsx
+++ b/src/features/clients/dashboard/page.tsx
@@ -27,6 +27,15 @@ export type ClientDashboardOrderDTO = {
   createdAt: string
 }
 
+/**
+ * Redirects on three conditions: missing session, falsy user id, or non-CLIENT
+ * role. The WHERE clause `clientId == session.user.id` is the ownership check —
+ * no secondary guard is needed because Order.clientId is set to the authenticated
+ * user at creation. (ref: DL-005)
+ *
+ * `include: { service: true }` eager-loads the join in a single query; no N+1.
+ * `orderBy: { createdAt: 'desc' }` returns newest orders first. (ref: DL-002)
+ */
 export default async function ClientDashboardPage() {
   const session = await auth()
   if (!session || !session.user.id || session.user.role !== 'CLIENT') {

```


**CC-M-001-002** (src/features/clients/dashboard/ui.tsx) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/clients/dashboard/ui.tsx
@@ -0,0 +1,95 @@
+'use client'
+
+import { OrderStatus } from '@prisma/client'
+import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
+import type { ClientDashboardOrderDTO } from './page'
+
+const statusBadgeConfig: Record<OrderStatus, { label: string; className: string }> = {
+  [OrderStatus.QUOTE_REQUESTED]: { label: 'Quote Requested', className: 'bg-gray-100 text-gray-700' },
+  [OrderStatus.QUOTE_PROVIDED]: { label: 'Quote Provided', className: 'bg-yellow-100 text-yellow-800' },
+  [OrderStatus.QUOTE_REJECTED]: { label: 'Quote Rejected', className: 'bg-red-100 text-red-800' },
+  [OrderStatus.PENDING]: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
+  [OrderStatus.PAYMENT_PENDING]: { label: 'Payment Pending', className: 'bg-yellow-100 text-yellow-800' },
+  [OrderStatus.PAYMENT_FAILED]: { label: 'Payment Failed', className: 'bg-red-100 text-red-800' },
+  [OrderStatus.ACKNOWLEDGED]: { label: 'Acknowledged', className: 'bg-blue-100 text-blue-800' },
+  [OrderStatus.IN_PROGRESS]: { label: 'In Progress', className: 'bg-blue-100 text-blue-800' },
+  [OrderStatus.COMPLETED]: { label: 'Completed', className: 'bg-green-100 text-green-800' },
+  [OrderStatus.CANCELLED]: { label: 'Cancelled', className: 'bg-red-100 text-red-800' },
+  [OrderStatus.REFUND_PENDING]: { label: 'Refund Pending', className: 'bg-yellow-100 text-yellow-800' },
+  [OrderStatus.REFUNDED]: { label: 'Refunded', className: 'bg-gray-100 text-gray-700' },
+}
+
+type ClientDashboardUIProps = {
+  orders: ClientDashboardOrderDTO[]
+}
+
+export function ClientDashboardUI({ orders }: ClientDashboardUIProps) {
+  if (orders.length === 0) {
+    return (
+      <div className="min-h-screen bg-gray-50 py-8">
+        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
+          <div className="mb-6">
+            <h1 className="text-2xl font-bold text-gray-900">Client Dashboard</h1>
+          </div>
+          <Card>
+            <CardHeader>
+              <CardTitle>Your Orders</CardTitle>
+            </CardHeader>
+            <CardContent>
+              <p className="text-sm text-gray-500 py-4 text-center">You have no orders yet.</p>
+            </CardContent>
+          </Card>
+        </div>
+      </div>
+    )
+  }
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <h1 className="text-2xl font-bold text-gray-900">Client Dashboard</h1>
+        </div>
+
+        <Card>
+          <CardHeader>
+            <CardTitle>Your Orders</CardTitle>
+          </CardHeader>
+          <CardContent>
+            <table className="w-full text-sm">
+              <thead>
+                <tr className="border-b text-left text-gray-600">
+                  <th className="pb-2 pr-4 font-medium">Order ID</th>
+                  <th className="pb-2 pr-4 font-medium">Service Name</th>
+                  <th className="pb-2 pr-4 font-medium">Status</th>
+                  <th className="pb-2 font-medium">Date</th>
+                </tr>
+              </thead>
+              <tbody>
+                {orders.map((order) => {
+                  const badge = statusBadgeConfig[order.status as OrderStatus]
+                  return (
+                    <tr key={order.id} className="border-b last:border-0">
+                      <td className="py-3 pr-4">
+                        <a
+                          href={`/dashboard/orders/${order.id}`}
+                          className="font-mono text-xs text-blue-600 hover:underline"
+                        >
+                          {order.id.slice(0, 8)}…
+                        </a>
+                      </td>
+                      <td className="py-3 pr-4">{order.serviceName}</td>
+                      <td className="py-3 pr-4">
+                        <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}>
+                          {badge.label}
+                        </span>
+                      </td>
+                      <td className="py-3">
+                        {new Date(order.createdAt).toLocaleDateString()}
+                      </td>
+                    </tr>
+                  )
+                })}
+              </tbody>
+            </table>
+          </CardContent>
+        </Card>
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/clients/dashboard/ui.tsx
+++ b/src/features/clients/dashboard/ui.tsx
@@ -1,4 +1,11 @@
 'use client'
 
+/**
+ * Client component for the client dashboard order listing.
+ *
+ * Renders a flat table of all orders for the authenticated client, newest-first.
+ * No tabs or status filtering — clients view full order history chronologically. (ref: DL-002)
+ */
+
 import { OrderStatus } from '@prisma/client'
 import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
 import type { ClientDashboardOrderDTO } from './page'
@@ -5,6 +12,14 @@ import type { ClientDashboardOrderDTO } from './page'
 
+/**
+ * Exhaustive map covering all 12 OrderStatus enum values.
+ *
+ * Typed as Record<OrderStatus, ...> (not Record<string, ...>) so TypeScript
+ * enforces that every enum member is present — a missing entry is a compile
+ * error caught by `tsc --noEmit` before deploy. No fallback branch is needed
+ * or provided. (ref: DL-003)
+ *
+ * No shared Badge component exists in V2; inline span with Tailwind classes
+ * is sufficient for this single consumer. (ref: DL-004)
+ */
 const statusBadgeConfig: Record<OrderStatus, { label: string; className: string }> = {

```


**CC-M-001-003** (src/app/dashboard/client/page.tsx) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/src/app/dashboard/client/page.tsx
@@ -0,0 +1,5 @@
+// App router mount point for the client dashboard RSC.
+// Implementation lives in src/features/clients/dashboard/page.tsx per VSA boundary rules.
+// This file is a re-export only; all logic belongs to the feature slice.
+export { default } from '@/features/clients/dashboard/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/client/page.tsx
+++ b/src/app/dashboard/client/page.tsx
@@ -1,4 +1,4 @@
 // App router mount point for the client dashboard RSC.
-// Implementation lives in src/features/clients/dashboard/page.tsx per VSA boundary rules.
+// Implementation lives in src/features/clients/dashboard/page.tsx per VSA boundary rules (ADR-001). (ref: DL-001)
 // This file is a re-export only; all logic belongs to the feature slice.
 export { default } from '@/features/clients/dashboard/page'

```


**CC-M-001-004** (src/features/clients/dashboard/README.md)

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/clients/dashboard/README.md
@@ -0,0 +1,72 @@
+# dashboard/
+
+Vertical slice serving `/dashboard/client` — CLIENT order listing, flat table,
+newest-first.
+
+## Auth and Ownership
+
+`page.tsx` uses `auth()` to verify `session.user.role === 'CLIENT'`. If the
+session is missing, `session.user.id` is falsy, or the role is not CLIENT, the
+user is redirected to `/auth/signin`. (ref: DL-005)
+
+No secondary ownership guard is needed. The Prisma query `where: { clientId:
+session.user.id }` IS the ownership check — `Order.clientId` is set to the
+authenticated user's id at order creation. The lab dashboard requires a
+separate lab-ownership guard because `Lab.ownerId` is an indirect relationship;
+the client dashboard does not.
+
+## Query Strategy
+
+A single `prisma.order.findMany({ where: { clientId: session.user.id }, include:
+{ service: true }, orderBy: { createdAt: 'desc' } })` returns all orders for
+the client. `Order.@@index([clientId])` in the schema makes this query
+index-backed. (ref: DL-002)
+
+A flat table is used instead of the Active/History/Incoming tab partition from
+the lab dashboard — clients view their full history chronologically and have no
+triage responsibility. Tab partitioning adds complexity without UX benefit.
+(ref: DL-002)
+
+All orders are returned without status filtering — clients need full history
+to see completed lab results. (ref: DL-002)
+
+No pagination is applied at MVP scale. `Order.@@index([clientId])` keeps the
+query fast; pagination can be added later without structural changes. (ref: DL-002)
+
+## DTO
+
+`ClientDashboardOrderDTO` uses primitive types only. `createdAt` is mapped to
+`.toISOString()` so Next.js can pass it across the RSC-to-client boundary
+without a serialization crash on `Date` objects. `quotedPrice` is excluded —
+the listing view does not display pricing, and Decimal fields also throw on RSC
+serialization. (ref: DL-006)
+
+`LabService.name` is non-nullable in the schema (line 153: `name String`), so
+`serviceName` in the DTO never needs a fallback. `Order.serviceId` is a
+non-nullable `String`, so `include: { service: true }` always returns a non-null
+service relation — no null guard needed on `order.service.name`.
+
+## Status Badge Config
+
+`statusBadgeConfig` in `ui.tsx` is typed as `Record<OrderStatus, { label:
+string; className: string }>`. The `OrderStatus` enum has 12 values; the record
+enumerates all of them. Using `Record<OrderStatus, ...>` (not `Record<string,
+...>`) means TypeScript emits a compile error if any enum member is missing —
+caught by `npx tsc --noEmit` before deploy. No fallback branch is provided or
+needed because the type is exhaustive. Inline ternary chains were not used
+because they become unreadable at 12 values and provide no compile-time
+exhaustiveness guarantee. (ref: DL-003)
+
+No shared Badge component is used. V2 has no Badge in `src/components/ui/`
+(only in `_legacy_v1`). A shared component for a single consumer is premature
+abstraction; inline span with Tailwind classes is sufficient. (ref: DL-004)
+
+## Tests
+
+No test files are included. V2 has no test framework configured; existing slices
+have no test coverage. Tests require framework setup outside this slice's scope.
+(ref: DL-007)
+
+## App Router Mount
+
+`src/app/dashboard/client/page.tsx` is a re-export only. All logic lives in
+this slice per VSA boundary rules (ADR-001).
```


**CC-M-001-005** (src/features/CLAUDE.md) - implements CI-M-001-003

**Documentation:**

```diff
--- a/src/features/CLAUDE.md
+++ b/src/features/CLAUDE.md
@@ -8,5 +8,6 @@
 | `orders/`  | Order creation and management slices       | Implementing any order flow                       |
 | `auth/`    | Authentication UI and flows                | Modifying sign-in, sign-out, or session handling  |
 | `labs/`    | Lab profile and listing slices             | Implementing lab-facing or marketplace features   |
 | `payments/`| Payment flow slices                        | Implementing checkout or payment status pages     |
 | `services/`| Lab service listing and detail slices      | Implementing service browsing or search           |
+| `clients/` | Client-facing feature slices               | Implementing client dashboard or order views      |
```


**CC-M-001-006** (src/features/clients/CLAUDE.md) - implements CI-M-001-003

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/clients/CLAUDE.md
@@ -0,0 +1,14 @@
+# clients/
+
+Client feature slices. Each subdirectory is a vertical slice scoped to one
+client workflow. Per VSA boundary rules (ADR-001), slices under clients/ must
+not import UI components from other feature slices.
+
+## Files
+
+No files at this level.
+
+## Subdirectories
+
+| Directory   | What                                                              | When to read                                          |
+| ----------- | ----------------------------------------------------------------- | ----------------------------------------------------- |
+| `dashboard/`| Client dashboard — CLIENT order listing, flat table, newest-first | Implementing or modifying the client dashboard page  |
```


**CC-M-001-007** (src/features/clients/dashboard/CLAUDE.md) - implements CI-M-001-003

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/clients/dashboard/CLAUDE.md
@@ -0,0 +1,12 @@
+# dashboard/
+
+## Files
+
+| File        | What                                                                              | When to read                                                                      |
+| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
+| `page.tsx`  | Async RSC — CLIENT auth guard, order fetch (no status filter), DTO                | Modifying auth gate, order fetch, or `ClientDashboardOrderDTO`                    |
+| `ui.tsx`    | `'use client'` — flat table, status badge config, order detail links             | Modifying table columns, badge styling, or empty state                            |
+| `README.md` | Auth guard, query strategy, DTO serialization constraints, badge exhaustiveness   | Understanding design decisions before modifying fetch or render logic             |
```


## README Entries

### src/features/clients/dashboard//README.md

Auth guard (CLIENT role, redirect to /auth/signin), query strategy (no status filter, @@index([clientId])-backed, newest-first), DTO serialization constraints (createdAt->ISO string, quotedPrice excluded), status badge exhaustiveness (Record<OrderStatus,...> covering all 12 values), link-only pattern for order detail (/dashboard/orders/[orderId] href only).

## Execution Waves

- W-001: M-001
