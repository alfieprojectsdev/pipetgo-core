# Plan

## Overview

ADMIN has no in-app surface to view all platform orders, their transactions, and payouts. T-13b adds a strictly read-only oversight slice mirroring the T-13 kyc-review admin pattern.

**Approach**: Approach A: two RSC routes (list + [orderId] detail) under src/app/dashboard/admin/orders/, backed by a new VSA slice src/features/admin/order-oversight/. Read-only: findMany list, findUnique detail. Two-layer ADMIN auth (layout + per-page/per-action re-check). Inline-map Decimal->.toFixed(2)/Date->.toISOString() DTO serialization at the RSC boundary.

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | Two RSC routes (list + [orderId] detail) under a new slice src/features/admin/order-oversight/, mirroring kyc-review | Admin reads are full-platform unscoped -> a single page bloats one payload and diverges from the shipped admin list+detail shape -> separate list and detail fetches reuse the established kyc-review pattern and keep payloads bounded |
| DL-002 | List shows id, status, lab name, quotedPrice, timestamps, client display name only; full ClientProfile is detail-only behind the ADMIN gate | An order joins ClientProfile PII (email/phone/org/address) -> RA 10173 favors data minimization -> minimize PII in the broad list feed and justify full PII only in per-order detail behind the gate; no analytics on these pages |
| DL-003 | Cursor-based bidirectional pagination over compound order (createdAt desc, id desc), PAGE_SIZE=25. Forward (dir absent or next): findMany with the display orderBy [{createdAt:desc},{id:desc}], take PAGE_SIZE+1, and when cursor present { cursor:{id:cursor}, skip:1 }; the (PAGE_SIZE+1)th row signals hasNextPage and is sliced off. Backward (dir=prev): findMany with the REVERSED orderBy [{createdAt:asc},{id:asc}], take PAGE_SIZE+1, { cursor:{id:cursor}, skip:1 }; the extra row signals a further previous page, then the kept rows are .reverse()d back into display (desc) order. Page cursors are always derived from the final displayed rows: prevCursor = displayedRows[0].id, nextCursor = displayedRows[at last].id. Next/Prev are links carrying ?cursor=&dir=. | Reads are unscoped full-platform and the order feed grows unbounded -> offset paging degrades and the createdAt ties risk skip/dup -> compound (createdAt desc, id desc) order with an id cursor is stable; backward traversal requires querying in the reversed sort direction (asc) from the cursor then reversing the result, because Prisma cursor+take always walks forward from the cursor in the orderBy direction -> deriving both cursors from the final displayed rows guarantees Next-then-Prev lands on the original page with no skipped/duplicated rows. |
| DL-004 | ADMIN-gated viewOrderAttachment Server Action mints a 300s presigned GET on click; detail UI client component opens the URL, surfacing every failure branch | Admins must inspect spec/result files for support -> metadata-only is insufficient -> mirror kyc-review/view-document-action.ts (findUnique r2Key, re-check ADMIN, 300s presigned GET allowedPrefix orders/) so each access binds a fresh gate + bounded TTL rather than a payload-embedded URL |
| DL-005 | Layer-2 ADMIN re-check duplicated in both RSC pages and the view-attachment action; layout guard is layer 1 only | The layout guard runs only on RSC render -> Server Actions and RSC pages are independently invocable (TOCTOU) -> each page and the action must re-check session.user.role===ADMIN or cross-tenant order+PII+financial data leaks |
| DL-006 | findUnique on Order.@id for detail; null guaranteed relation (lab/service/client) after explicit include throws; missing order calls notFound() | order.lab/service/client are schema-guaranteed FKs -> a null after explicit include is a referential-integrity violation, not a missing row -> throw to surface in monitoring; only a genuinely absent order is a 404 (quote-provide/page.tsx canonical) |
| DL-007 | Inline per-field .toFixed(2)/.toISOString() serialization at each page boundary; DTO money/date fields typed string; no shared util | Raw Decimal/Date across the RSC->client boundary is a runtime crash invisible to tsc -> serialize at the boundary and type DTOs string -> follow the established wallet/page.tsx inline-map convention not a shared helper |

### Constraints

- Strictly read-only: no update/create/delete/upsert anywhere in slice
- Two-layer ADMIN auth: layout guard layer 1, per-page RSC + per-action re-check layer 2 (DL-001 TOCTOU)
- Serialize every Prisma.Decimal via .toFixed(2) and every Date via .toISOString() at RSC->client boundary; DTO fields typed as string
- findUnique on @id detail; null schema-guaranteed relation after include throws; missing order notFound()
- Inline-map serialization convention (no shared util)
- No analytics/event tracking on these pages
- No schema change; no prisma db push owed

## Invisible Knowledge

### System

T-13 shipped the /dashboard/admin/* route group + its layout guard + the two-layer-auth + list/detail admin slice shape (kyc-review, accreditation-review). T-13b applies that pattern to read-only order/transaction/payout data. Admin reads are UNSCOPED (no clientId/labId predicate — admin sees every order).

### Invariants

- Slice is strictly read-only: grep the finished slice for update/create/delete/upsert => must be none (Decision 1, playbook).
- Two-layer ADMIN auth: layout = layer 1; every admin RSC page AND the view-attachment action independently re-check session.user.role==='ADMIN' (DL-001 TOCTOU).
- Every Prisma.Decimal serialized via .toFixed(2) and every Date via .toISOString() at the RSC->client boundary; DTO fields typed string. Decimal scope: Order.quotedPrice, Transaction.amount, Payout.grossAmount/platformFee/netAmount/feePercentage. Date scope: Order.quotedAt/paidAt/refundedAt/createdAt/updatedAt, Transaction.capturedAt/refundedAt/createdAt, Payout.scheduledDate/completedAt/createdAt.
- findUnique on Order.@id detail; null guaranteed relation after include throws; missing order notFound().
- No schema change => no `npx prisma db push` owed for T-13b (unlike T-12/T-18 pre-existing debts).
- Admin access requires an ADMIN user in the target env (DL-008, no in-app promotion); dev bootstrapped (alfieprojects.dev@gmail.com).

### Tradeoffs

- On-demand presigned GET (vs embedding URLs in payload): each click is tied to a fresh ADMIN re-check and a bounded 300s TTL rather than a page-lifetime credential (DL-004).
- A client component that awaits the view-attachment action must surface every failure branch to a rendered error state and open the window before the await (Implementation Discipline #18-#19; canonical orders/spec-upload/ui.tsx).

## Milestones

### Milestone 1: Admin order list page (cursor-paginated, PII-minimized)

**Files**: src/features/admin/order-oversight/page.tsx, src/features/admin/order-oversight/ui.tsx, src/app/dashboard/admin/orders/page.tsx

**Requirements**:

- Lists every platform Order unscoped (no clientId/labId predicate), newest-first
- Cursor-based paging: page size 25; Next/Prev rendered as links carrying cursor + dir query params
- List row exposes only id, status, lab name, quotedPrice, createdAt, client display name — no raw email/phone/address
- Layer-2 ADMIN re-check at the top of the RSC page (redirect non-ADMIN to /auth/signin)
- No write paths; no analytics/event tracking on the page

**Acceptance Criteria**:

- Non-ADMIN session hitting the list route is redirected to /auth/signin
- List renders 25 rows ordered by (createdAt desc, id desc); a 26th matching row enables the Next link
- Following Next then Prev returns to the original page with no skipped or duplicated rows
- No raw client email/phone/address appears in the list payload
- grep of the slice for update|create|delete|upsert returns nothing

**Tests**:

- Structurally covered by M-004 page.test.ts: ADMIN gate redirect, (createdAt desc, id desc) ordering predicate, cursor/take args passed to findMany, PII-minimized DTO shape

#### Code Intent

- **CI-M-001-001** `src/features/admin/order-oversight/page.tsx::AdminOrderListPage`: Async RSC. Calls auth(); when session is absent or session.user.role !== ADMIN, redirect(/auth/signin). Reads optional searchParams.cursor (string) and searchParams.dir (next | prev); treat any value other than prev (including absent) as forward. Selects only Order.id, status, quotedPrice, createdAt and lab.name plus clientProfile.name. PAGE_SIZE = 25. Forward branch (dir !== prev): prisma.order.findMany unscoped with orderBy [{createdAt:desc},{id:desc}], take = PAGE_SIZE+1, and when cursor present { cursor:{id:cursor}, skip:1 }; if the result length === PAGE_SIZE+1 set hasNextPage=true and drop the extra (last) row to get displayedRows, else hasNextPage=false. Backward branch (dir === prev, cursor required): prisma.order.findMany with the REVERSED orderBy [{createdAt:asc},{id:asc}], take = PAGE_SIZE+1, { cursor:{id:cursor}, skip:1 }; if length === PAGE_SIZE+1 set hasPrevMore=true and drop the extra (last) row, else hasPrevMore=false; then displayedRows = keptRows.reverse() to restore display (desc) order. After either branch: when displayedRows is empty, nextCursor=null and prevCursor=null; otherwise nextCursor = displayedRows[displayedRows.length-1].id, prevCursor = displayedRows[0].id. Show Next only when a further forward page exists (forward: hasNextPage; backward: always true, since arriving via prev means a next page exists) and show Prev only when a previous page exists (forward: cursor was present; backward: hasPrevMore). Map each displayed row into AdminOrderRowDTO with quotedPrice serialized via ?.toFixed(2) ?? null and createdAt via .toISOString(). Pass the DTO array plus { nextCursor, prevCursor, showNext, showPrev } to AdminOrderListUi. No write calls, no analytics. (refs: DL-001, DL-002, DL-003, DL-005, DL-007)
- **CI-M-001-002** `src/features/admin/order-oversight/ui.tsx::AdminOrderListUi`: Client component rendering a table of AdminOrderRowDTO: order id (linking to ./orders/{id}), an OrderStatus badge built from a STATUS_BADGE map typed as const satisfies Record<OrderStatus, {label,className}> (compile error if a status is unhandled), lab name, client display name, quotedPrice string (or an em-dash when null), and createdAt rendered via new Date(iso).toLocaleString(). Takes { rows, nextCursor, prevCursor, showNext, showPrev }. Renders Prev as a next/link anchor to ?cursor={prevCursor}&dir=prev (rendered only when showPrev) and Next as a next/link anchor to ?cursor={nextCursor}&dir=next (rendered only when showNext). No mutation forms. (refs: DL-002, DL-003)
- **CI-M-001-003** `src/app/dashboard/admin/orders/page.tsx::default`: App-router entry that re-exports the slice list page: `export { default } from '@/features/admin/order-oversight/page'`. Lives inside the /dashboard/admin route group already guarded by layout.tsx (layer 1). (refs: DL-001, DL-005)

#### Code Changes

**CC-M-001-001** (src/features/admin/order-oversight/page.tsx) - implements CI-M-001-001

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/page.tsx
@@ -0,0 +1,95 @@
+/**
+ * Admin order list RSC.
+ * Role check duplicated from layout.tsx: Server Actions and RSCs are independently
+ * invocable; the layout guard does not protect them. (ref: DL-001)
+ * Cursor pagination with PAGE_SIZE=25; forward/backward branches with reversed orderBy
+ * for backward traversal. quotedPrice serialized via ?.toFixed(2) ?? null;
+ * createdAt via .toISOString(). (ref: DL-002, DL-003, DL-007)
+ */
+import { redirect } from 'next/navigation'
+import { type OrderStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AdminOrderListUi } from './ui'
+
+const PAGE_SIZE = 25
+
+export type AdminOrderRowDTO = {
+  id: string
+  status: OrderStatus
+  labName: string
+  clientDisplayName: string | null
+  quotedPrice: string | null
+  createdAt: string
+}
+
+export type AdminOrderListProps = {
+  rows: AdminOrderRowDTO[]
+  nextCursor: string | null
+  prevCursor: string | null
+  showNext: boolean
+  showPrev: boolean
+}
+
+export default async function AdminOrderListPage({
+  searchParams,
+}: {
+  searchParams: { cursor?: string; dir?: string }
+}) {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    redirect('/auth/signin')
+  }
+
+  const cursor = searchParams.cursor
+  const dir = searchParams.dir
+
+  let rows
+
+  if (dir === 'prev' && cursor) {
+    rows = await prisma.order.findMany({
+      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+      take: PAGE_SIZE + 1,
+      cursor: { id: cursor },
+      skip: 1,
+      select: {
+        id: true,
+        status: true,
+        quotedPrice: true,
+        createdAt: true,
+        lab: { select: { name: true } },
+        clientProfile: { select: { name: true } },
+      },
+    })
+  } else {
+    rows = await prisma.order.findMany({
+      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
+      take: PAGE_SIZE + 1,
+      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
+      select: {
+        id: true,
+        status: true,
+        quotedPrice: true,
+        createdAt: true,
+        lab: { select: { name: true } },
+        clientProfile: { select: { name: true } },
+      },
+    })
+  }
+
+  let displayedRows: typeof rows
+  let hasExtra: boolean
+
+  if (dir === 'prev' && cursor) {
+    hasExtra = rows.length === PAGE_SIZE + 1
+    displayedRows = hasExtra ? rows.slice(0, PAGE_SIZE) : rows
+    displayedRows = [...displayedRows].reverse()
+  } else {
+    hasExtra = rows.length === PAGE_SIZE + 1
+    displayedRows = hasExtra ? rows.slice(0, PAGE_SIZE) : rows
+  }
+
+  const nextCursor = displayedRows.length > 0 ? displayedRows[displayedRows.length - 1].id : null
+  const prevCursor = displayedRows.length > 0 ? displayedRows[0].id : null
+
+  const showNext = dir === 'prev' && cursor ? true : hasExtra
+  const showPrev = dir === 'prev' && cursor ? hasExtra : (cursor !== undefined && cursor !== null && cursor !== '')
+
+  const dtos: AdminOrderRowDTO[] = displayedRows.map((row) => ({
+    id: row.id,
+    status: row.status,
+    labName: row.lab.name,
+    clientDisplayName: row.clientProfile?.name ?? null,
+    quotedPrice: row.quotedPrice?.toFixed(2) ?? null,
+    createdAt: row.createdAt.toISOString(),
+  }))
+
+  return (
+    <AdminOrderListUi
+      rows={dtos}
+      nextCursor={nextCursor}
+      prevCursor={prevCursor}
+      showNext={showNext}
+      showPrev={showPrev}
+    />
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/page.tsx
+++ b/src/features/admin/order-oversight/page.tsx
@@ -47,6 +47,9 @@ export default async function AdminOrderListPage({
   const cursor = searchParams.cursor
   const dir = searchParams.dir

+  // Backward traversal requires reversing orderBy so Prisma's cursor walks
+  // in the opposite direction from the cursor, then the result is reversed
+  // back to display (newest-first) order. (ref: DL-003)
   let rows

   if (dir === 'prev' && cursor) {
@@ -77,6 +80,11 @@ export default async function AdminOrderListPage({
   if (dir === 'prev' && cursor) {
     hasExtra = rows.length === PAGE_SIZE + 1
     displayedRows = hasExtra ? rows.slice(0, PAGE_SIZE) : rows
+    // Restore display (newest-first) order after the asc fetch. (ref: DL-003)
     displayedRows = [...displayedRows].reverse()
   } else {
     hasExtra = rows.length === PAGE_SIZE + 1
@@ -86,6 +90,10 @@ export default async function AdminOrderListPage({
   const nextCursor = displayedRows.length > 0 ? displayedRows[displayedRows.length - 1].id : null
   const prevCursor = displayedRows.length > 0 ? displayedRows[0].id : null

+  // showNext: on backward traversal a next page always exists (we came from it);
+  // on forward traversal the extra +1 row signals more rows exist. showPrev: on
+  // backward traversal the extra +1 row signals a further prev page; on forward
+  // traversal any cursor means there is a prior page. (ref: DL-003)
   const showNext = dir === 'prev' && cursor ? true : hasExtra
   const showPrev = dir === 'prev' && cursor ? hasExtra : (cursor !== undefined && cursor !== null && cursor !== '')

```


**CC-M-001-002** (src/features/admin/order-oversight/ui.tsx) - implements CI-M-001-002

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/ui.tsx
@@ -0,0 +1,90 @@
+'use client'
+
+import Link from 'next/link'
+import { type OrderStatus } from '@prisma/client'
+import type { AdminOrderRowDTO, AdminOrderListProps } from './page'
+
+const STATUS_BADGE = {
+  QUOTE_REQUESTED:  { label: 'Quote requested',  className: 'bg-gray-100 text-gray-700' },
+  QUOTE_PROVIDED:   { label: 'Quote provided',   className: 'bg-blue-100 text-blue-700' },
+  QUOTE_REJECTED:   { label: 'Quote rejected',   className: 'bg-red-100 text-red-700' },
+  PENDING:          { label: 'Pending',           className: 'bg-gray-200 text-gray-700' },
+  PAYMENT_PENDING:  { label: 'Payment pending',  className: 'bg-yellow-100 text-yellow-700' },
+  PAYMENT_FAILED:   { label: 'Payment failed',   className: 'bg-red-200 text-red-800' },
+  ACKNOWLEDGED:     { label: 'Acknowledged',     className: 'bg-indigo-100 text-indigo-700' },
+  IN_PROGRESS:      { label: 'In progress',      className: 'bg-purple-100 text-purple-700' },
+  COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
+  CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
+  REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
+  REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
+} as const satisfies Record<OrderStatus, { label: string; className: string }>
+
+export function AdminOrderListUi({
+  rows,
+  nextCursor,
+  prevCursor,
+  showNext,
+  showPrev,
+}: AdminOrderListProps) {
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
+        <div className="mb-6">
+          <h1 className="text-2xl font-bold text-gray-900">Order Oversight</h1>
+          <p className="mt-1 text-sm text-gray-500">
+            {rows.length === 0 ? 'No orders found.' : `${rows.length} order${rows.length === 1 ? '' : 's'} shown.`}
+          </p>
+        </div>
+
+        {rows.length > 0 && (
+          <div className="bg-white rounded-lg shadow overflow-hidden">
+            <table className="min-w-full divide-y divide-gray-200">
+              <thead className="bg-gray-50">
+                <tr>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Order ID</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Lab</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Client</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Amount</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
+                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Action</th>
+                </tr>
+              </thead>
+              <tbody className="bg-white divide-y divide-gray-200">
+                {rows.map((row: AdminOrderRowDTO) => {
+                  const badge = STATUS_BADGE[row.status]
+                  return (
+                    <tr key={row.id}>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-700">
+                        {row.id.slice(0, 12)}&hellip;
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap">
+                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${badge.className}`}>
+                          {badge.label}
+                        </span>
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{row.labName}</td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.clientDisplayName ?? '—'}</td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">{row.quotedPrice ?? '—'}</td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
+                        {new Date(row.createdAt).toLocaleString()}
+                      </td>
+                      <td className="px-6 py-4 whitespace-nowrap text-sm">
+                        <Link
+                          href={`/dashboard/admin/orders/${row.id}`}
+                          className="text-blue-600 hover:text-blue-800 font-medium"
+                        >
+                          View
+                        </Link>
+                      </td>
+                    </tr>
+                  )
+                })}
+              </tbody>
+            </table>
+          </div>
+        )}
+
+        <div className="mt-4 flex gap-4">
+          {showPrev && prevCursor && (
+            <Link
+              href={`?cursor=${prevCursor}&dir=prev`}
+              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
+            >
+              &larr; Prev
+            </Link>
+          )}
+          {showNext && nextCursor && (
+            <Link
+              href={`?cursor=${nextCursor}&dir=next`}
+              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
+            >
+              Next &rarr;
+            </Link>
+          )}
+        </div>
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/ui.tsx
+++ b/src/features/admin/order-oversight/ui.tsx
@@ -6,6 +6,8 @@ import type { AdminOrderRowDTO, AdminOrderListProps } from './page'

+// satisfies Record<OrderStatus,...> makes a missing enum member a compile-time
+// error rather than a runtime wrong-label. (Implementation Discipline — enum dispatch)
 const STATUS_BADGE = {
   QUOTE_REQUESTED:  { label: 'Quote requested',  className: 'bg-gray-100 text-gray-700' },
   QUOTE_PROVIDED:   { label: 'Quote provided',   className: 'bg-blue-100 text-blue-700' },

```


**CC-M-001-003** (src/app/dashboard/admin/orders/page.tsx) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ src/app/dashboard/admin/orders/page.tsx
@@ -0,0 +1,2 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+export { default } from '@/features/admin/order-oversight/page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/orders/page.tsx
+++ b/src/app/dashboard/admin/orders/page.tsx
@@ -1,2 +1,2 @@
 // Route entry point. Logic lives in the feature slice (ADR-001 VSA).
 export { default } from '@/features/admin/order-oversight/page'

```


### Milestone 2: Admin order detail page (serialized DTO, relation guards)

**Files**: src/features/admin/order-oversight/detail-page.tsx, src/features/admin/order-oversight/detail-ui.tsx, src/app/dashboard/admin/orders/[orderId]/page.tsx

**Requirements**:

- Detail fetches a single Order by @id via findUnique with explicit include of client, clientProfile, lab, service, transactions, payouts, attachments
- Layer-2 ADMIN re-check at top of detail RSC
- After include: null order.lab / order.service / order.client throws (referential-integrity); genuinely missing order calls notFound()
- Every Decimal serialized via .toFixed(2) and every Date via .toISOString() into a string-typed DTO before crossing to the client component
- Detail surfaces full ClientProfile (name/email/phone/organization/address) behind the ADMIN gate, plus transaction(s) and payout(s)

**Acceptance Criteria**:

- Non-ADMIN hitting the detail route is redirected to /auth/signin
- Missing orderId renders Next.js notFound (404)
- A fetched order with a null guaranteed relation (lab/service/client) throws an Error, not notFound()
- DTO money/date fields are strings (amount: string, createdAt: string) — no raw Decimal/Date crosses the boundary
- Detail renders client PII, transaction(s), and payout(s) for an existing order

**Tests**:

- Covered by M-004 detail-page.test.ts: ADMIN gate, notFound on missing order, throw on null guaranteed relation, Decimal->toFixed(2) / Date->toISOString string assertions

#### Code Intent

- **CI-M-002-001** `src/features/admin/order-oversight/detail-page.tsx::AdminOrderDetailPage`: Async RSC taking params.orderId. Calls auth(); non-ADMIN -> redirect('/auth/signin'). Runs prisma.order.findUnique({ where: { id: params.orderId }, include: { client: true, clientProfile: true, lab: true, service: true, transactions: { orderBy: { createdAt: 'desc' } }, payouts: { orderBy: { createdAt: 'desc' } }, attachments: { orderBy: { createdAt: 'desc' } } } }). If !order -> notFound(). If !order.lab / !order.service / !order.client -> throw new Error('Order.<rel> missing after explicit include — referential integrity violation') (clientProfile is a nullable 1:1, so it does NOT throw — handled as optional). Builds AdminOrderDetailDTO: serialize Order.quotedPrice via ?.toFixed(2) ?? null; quotedAt/paidAt/refundedAt/createdAt/updatedAt via ?.toISOString() ?? null (createdAt/updatedAt non-null); each Transaction.amount.toFixed(2) and capturedAt/refundedAt/createdAt date strings; each Payout grossAmount/platformFee/netAmount/feePercentage .toFixed via appropriate precision (.toFixed(2) for money, .toFixed(4) for feePercentage) and scheduledDate/completedAt/createdAt date strings; full clientProfile fields (name/email/phone/organization/address) and lab.name/service.name as plain strings; attachment metadata (id, fileName, attachmentType, createdAt string) only — no r2Key, no URL. Passes the DTO to AdminOrderDetailUi. (refs: DL-005, DL-006, DL-007, DL-002)
- **CI-M-002-002** `src/features/admin/order-oversight/detail-ui.tsx::AdminOrderDetailUi`: Client component rendering the AdminOrderDetailDTO read-only: order header with OrderStatus badge (`as const satisfies Record<OrderStatus, …>`), a client section showing full ClientProfile PII, a lab/service summary, a transactions table (amount, status, paymentMethod, capturedAt) and a payouts table (gross/fee/net strings, status, scheduledDate/completedAt). Renders the AttachmentListUi (from M-003) for the order's attachments. No mutation forms, no Accept/Reject/refund controls. (refs: DL-002, DL-007)
- **CI-M-002-003** `src/app/dashboard/admin/orders/[orderId]/page.tsx::default`: App-router dynamic-segment entry re-exporting the slice detail page: `export { default } from '@/features/admin/order-oversight/detail-page'`. Inside the layer-1-guarded /dashboard/admin route group. (refs: DL-005)

#### Code Changes

**CC-M-002-001** (src/features/admin/order-oversight/detail-page.tsx) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/detail-page.tsx
@@ -0,0 +1,138 @@
+/**
+ * Admin order detail RSC.
+ * Role check duplicated from layout.tsx (ref: DL-001). findUnique on @id;
+ * null relation after explicit include throws (not notFound) except clientProfile
+ * which is a nullable 1:1. (ref: DL-005, DL-006)
+ * All Decimal fields serialized via .toFixed(2) / .toFixed(4); all Date fields
+ * via .toISOString(). (ref: DL-007, DL-002)
+ */
+import { notFound, redirect } from 'next/navigation'
+import { type OrderStatus, type TransactionStatus, type PayoutStatus, type AttachmentType } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import { auth } from '@/lib/auth'
+import { AdminOrderDetailUi } from './detail-ui'
+
+export type AdminOrderDetailDTO = {
+  id: string
+  status: OrderStatus
+  quotedPrice: string | null
+  quotedAt: string | null
+  paidAt: string | null
+  refundedAt: string | null
+  createdAt: string
+  updatedAt: string
+  lab: { name: string }
+  service: { name: string }
+  client: { name: string | null; email: string }
+  clientProfile: {
+    name: string
+    email: string
+    phone: string
+    organization: string | null
+    address: string | null
+  } | null
+  transactions: {
+    id: string
+    amount: string
+    status: TransactionStatus
+    paymentMethod: string | null
+    capturedAt: string | null
+    createdAt: string
+  }[]
+  payouts: {
+    id: string
+    grossAmount: string
+    platformFee: string
+    netAmount: string
+    feePercentage: string
+    status: PayoutStatus
+    scheduledDate: string | null
+    completedAt: string | null
+    createdAt: string
+  }[]
+  attachments: {
+    id: string
+    fileName: string
+    attachmentType: AttachmentType
+    createdAt: string
+  }[]
+}
+
+export default async function AdminOrderDetailPage({
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
+      client: true,
+      clientProfile: true,
+      lab: true,
+      service: true,
+      transactions: { orderBy: { createdAt: 'desc' } },
+      payouts: { orderBy: { createdAt: 'desc' } },
+      attachments: { orderBy: { createdAt: 'desc' } },
+    },
+  })
+
+  if (!order) notFound()
+  if (!order.lab) {
+    throw new Error(`Order.lab missing after explicit include — referential integrity violation`)
+  }
+  if (!order.service) {
+    throw new Error(`Order.service missing after explicit include — referential integrity violation`)
+  }
+  if (!order.client) {
+    throw new Error(`Order.client missing after explicit include — referential integrity violation`)
+  }
+
+  const dto: AdminOrderDetailDTO = {
+    id: order.id,
+    status: order.status,
+    quotedPrice: order.quotedPrice?.toFixed(2) ?? null,
+    quotedAt: order.quotedAt?.toISOString() ?? null,
+    paidAt: order.paidAt?.toISOString() ?? null,
+    refundedAt: order.refundedAt?.toISOString() ?? null,
+    createdAt: order.createdAt.toISOString(),
+    updatedAt: order.updatedAt.toISOString(),
+    lab: { name: order.lab.name },
+    service: { name: order.service.name },
+    client: {
+      name: order.client.name ?? null,
+      email: order.client.email,
+    },
+    clientProfile: order.clientProfile
+      ? {
+          name: order.clientProfile.name,
+          email: order.clientProfile.email,
+          phone: order.clientProfile.phone,
+          organization: order.clientProfile.organization ?? null,
+          address: order.clientProfile.address ?? null,
+        }
+      : null,
+    transactions: order.transactions.map((t) => ({
+      id: t.id,
+      amount: t.amount.toFixed(2),
+      status: t.status,
+      paymentMethod: t.paymentMethod ?? null,
+      capturedAt: t.capturedAt?.toISOString() ?? null,
+      createdAt: t.createdAt.toISOString(),
+    })),
+    payouts: order.payouts.map((p) => ({
+      id: p.id,
+      grossAmount: p.grossAmount.toFixed(2),
+      platformFee: p.platformFee.toFixed(2),
+      netAmount: p.netAmount.toFixed(2),
+      feePercentage: p.feePercentage.toFixed(4),
+      status: p.status,
+      scheduledDate: p.scheduledDate?.toISOString() ?? null,
+      completedAt: p.completedAt?.toISOString() ?? null,
+      createdAt: p.createdAt.toISOString(),
+    })),
+    attachments: order.attachments.map((a) => ({
+      id: a.id,
+      fileName: a.fileName,
+      attachmentType: a.attachmentType,
+      createdAt: a.createdAt.toISOString(),
+    })),
+  }
+
+  return <AdminOrderDetailUi dto={dto} />
+}
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/detail-page.tsx
+++ b/src/features/admin/order-oversight/detail-page.tsx
@@ -30,6 +30,8 @@ export type AdminOrderDetailDTO = {
   service: { name: string }
   client: { name: string | null; email: string }
+  // clientProfile is a nullable 1:1 (not all Orders have a ClientProfile row);
+  // null here is a valid data state, not a referential integrity violation. (ref: DL-006)
   clientProfile: {
     name: string
     email: string
@@ -84,6 +86,8 @@ export default async function AdminOrderDetailPage({
   if (!order) notFound()
   if (!order.lab) {
+    // lab is schema-guaranteed via FK — null after explicit include is a referential
+    // integrity violation, not a missing-row scenario. (ref: DL-006)
     throw new Error(`Order.lab missing after explicit include — referential integrity violation`)
   }
   if (!order.service) {

```


**CC-M-002-002** (src/features/admin/order-oversight/detail-ui.tsx) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/detail-ui.tsx
@@ -0,0 +1,168 @@
+'use client'
+
+import { type OrderStatus, type TransactionStatus, type PayoutStatus } from '@prisma/client'
+import type { AdminOrderDetailDTO } from './detail-page'
+import { AttachmentListUi } from './attachment-list-ui'
+
+const ORDER_STATUS_BADGE = {
+  QUOTE_REQUESTED:  { label: 'Quote requested',  className: 'bg-gray-100 text-gray-700' },
+  QUOTE_PROVIDED:   { label: 'Quote provided',   className: 'bg-blue-100 text-blue-700' },
+  QUOTE_REJECTED:   { label: 'Quote rejected',   className: 'bg-red-100 text-red-700' },
+  PENDING:          { label: 'Pending',           className: 'bg-gray-200 text-gray-700' },
+  PAYMENT_PENDING:  { label: 'Payment pending',  className: 'bg-yellow-100 text-yellow-700' },
+  PAYMENT_FAILED:   { label: 'Payment failed',   className: 'bg-red-200 text-red-800' },
+  ACKNOWLEDGED:     { label: 'Acknowledged',     className: 'bg-indigo-100 text-indigo-700' },
+  IN_PROGRESS:      { label: 'In progress',      className: 'bg-purple-100 text-purple-700' },
+  COMPLETED:        { label: 'Completed',        className: 'bg-green-200 text-green-800' },
+  CANCELLED:        { label: 'Cancelled',        className: 'bg-gray-300 text-gray-600' },
+  REFUND_PENDING:   { label: 'Refund pending',   className: 'bg-orange-100 text-orange-700' },
+  REFUNDED:         { label: 'Refunded',         className: 'bg-orange-200 text-orange-800' },
+} as const satisfies Record<OrderStatus, { label: string; className: string }>
+
+const TRANSACTION_STATUS_BADGE = {
+  PENDING:    { label: 'Pending',    className: 'bg-gray-100 text-gray-600' },
+  PROCESSING: { label: 'Processing', className: 'bg-blue-100 text-blue-700' },
+  CAPTURED:   { label: 'Captured',   className: 'bg-green-100 text-green-700' },
+  FAILED:     { label: 'Failed',     className: 'bg-red-100 text-red-700' },
+  REFUNDED:   { label: 'Refunded',   className: 'bg-orange-100 text-orange-700' },
+} as const satisfies Record<TransactionStatus, { label: string; className: string }>
+
+const PAYOUT_STATUS_BADGE = {
+  QUEUED:     { label: 'Queued',     className: 'bg-gray-100 text-gray-600' },
+  PROCESSING: { label: 'Processing', className: 'bg-blue-100 text-blue-700' },
+  COMPLETED:  { label: 'Completed',  className: 'bg-green-100 text-green-700' },
+  FAILED:     { label: 'Failed',     className: 'bg-red-100 text-red-700' },
+} as const satisfies Record<PayoutStatus, { label: string; className: string }>
+
+export function AdminOrderDetailUi({ dto }: { dto: AdminOrderDetailDTO }) {
+  const orderBadge = ORDER_STATUS_BADGE[dto.status]
+
+  return (
+    <div className="min-h-screen bg-gray-50 py-8">
+      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 space-y-6">
+        <div>
+          <h1 className="text-2xl font-bold text-gray-900">Order {dto.id}</h1>
+          <div className="mt-2">
+            <span className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-medium ${orderBadge.className}`}>
+              {orderBadge.label}
+            </span>
+          </div>
+          <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
+            <dt className="text-gray-500">Lab</dt>
+            <dd className="text-gray-900">{dto.lab.name}</dd>
+            <dt className="text-gray-500">Service</dt>
+            <dd className="text-gray-900">{dto.service.name}</dd>
+            <dt className="text-gray-500">Quoted price</dt>
+            <dd className="text-gray-900">{dto.quotedPrice ?? '—'}</dd>
+            <dt className="text-gray-500">Quoted at</dt>
+            <dd className="text-gray-900">{dto.quotedAt ? new Date(dto.quotedAt).toLocaleString() : '—'}</dd>
+            <dt className="text-gray-500">Paid at</dt>
+            <dd className="text-gray-900">{dto.paidAt ? new Date(dto.paidAt).toLocaleString() : '—'}</dd>
+            <dt className="text-gray-500">Refunded at</dt>
+            <dd className="text-gray-900">{dto.refundedAt ? new Date(dto.refundedAt).toLocaleString() : '—'}</dd>
+            <dt className="text-gray-500">Created</dt>
+            <dd className="text-gray-900">{new Date(dto.createdAt).toLocaleString()}</dd>
+            <dt className="text-gray-500">Updated</dt>
+            <dd className="text-gray-900">{new Date(dto.updatedAt).toLocaleString()}</dd>
+          </dl>
+        </div>
+
+        <div className="bg-white rounded-lg shadow p-4">
+          <h2 className="text-sm font-semibold text-gray-700 mb-3">Client</h2>
+          {dto.clientProfile ? (
+            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
+              <dt className="text-gray-500">Name</dt>
+              <dd className="text-gray-900">{dto.clientProfile.name}</dd>
+              <dt className="text-gray-500">Email</dt>
+              <dd className="text-gray-900">{dto.clientProfile.email}</dd>
+              <dt className="text-gray-500">Phone</dt>
+              <dd className="text-gray-900">{dto.clientProfile.phone}</dd>
+              {dto.clientProfile.organization && (
+                <>
+                  <dt className="text-gray-500">Organization</dt>
+                  <dd className="text-gray-900">{dto.clientProfile.organization}</dd>
+                </>
+              )}
+              {dto.clientProfile.address && (
+                <>
+                  <dt className="text-gray-500">Address</dt>
+                  <dd className="text-gray-900">{dto.clientProfile.address}</dd>
+                </>
+              )}
+            </dl>
+          ) : (
+            <p className="text-sm text-gray-500">
+              {dto.client.name ?? dto.client.email} ({dto.client.email}) — no profile snapshot
+            </p>
+          )}
+        </div>
+
+        {dto.transactions.length > 0 && (
+          <div className="bg-white rounded-lg shadow overflow-hidden">
+            <div className="px-4 py-3 border-b">
+              <h2 className="text-sm font-semibold text-gray-700">Transactions</h2>
+            </div>
+            <table className="min-w-full divide-y divide-gray-200">
+              <thead className="bg-gray-50">
+                <tr>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Amount</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Method</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Captured</th>
+                </tr>
+              </thead>
+              <tbody className="divide-y divide-gray-200">
+                {dto.transactions.map((t) => {
+                  const tb = TRANSACTION_STATUS_BADGE[t.status]
+                  return (
+                    <tr key={t.id}>
+                      <td className="px-4 py-2 text-sm text-gray-900">{t.amount}</td>
+                      <td className="px-4 py-2">
+                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${tb.className}`}>
+                          {tb.label}
+                        </span>
+                      </td>
+                      <td className="px-4 py-2 text-sm text-gray-500">{t.paymentMethod ?? '—'}</td>
+                      <td className="px-4 py-2 text-sm text-gray-500">
+                        {t.capturedAt ? new Date(t.capturedAt).toLocaleString() : '—'}
+                      </td>
+                    </tr>
+                  )
+                })}
+              </tbody>
+            </table>
+          </div>
+        )}
+
+        {dto.payouts.length > 0 && (
+          <div className="bg-white rounded-lg shadow overflow-hidden">
+            <div className="px-4 py-3 border-b">
+              <h2 className="text-sm font-semibold text-gray-700">Payouts</h2>
+            </div>
+            <table className="min-w-full divide-y divide-gray-200">
+              <thead className="bg-gray-50">
+                <tr>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Gross</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Fee</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Net</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Scheduled</th>
+                  <th className="px-4 py-2 text-left text-xs font-medium text-gray-500 uppercase">Completed</th>
+                </tr>
+              </thead>
+              <tbody className="divide-y divide-gray-200">
+                {dto.payouts.map((p) => {
+                  const pb = PAYOUT_STATUS_BADGE[p.status]
+                  return (
+                    <tr key={p.id}>
+                      <td className="px-4 py-2 text-sm text-gray-900">{p.grossAmount}</td>
+                      <td className="px-4 py-2 text-sm text-gray-500">{p.platformFee}</td>
+                      <td className="px-4 py-2 text-sm text-gray-900">{p.netAmount}</td>
+                      <td className="px-4 py-2">
+                        <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${pb.className}`}>
+                          {pb.label}
+                        </span>
+                      </td>
+                      <td className="px-4 py-2 text-sm text-gray-500">
+                        {p.scheduledDate ? new Date(p.scheduledDate).toLocaleString() : '—'}
+                      </td>
+                      <td className="px-4 py-2 text-sm text-gray-500">
+                        {p.completedAt ? new Date(p.completedAt).toLocaleString() : '—'}
+                      </td>
+                    </tr>
+                  )
+                })}
+              </tbody>
+            </table>
+          </div>
+        )}
+
+        <AttachmentListUi attachments={dto.attachments} />
+      </div>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/detail-ui.tsx
+++ b/src/features/admin/order-oversight/detail-ui.tsx
@@ -4,6 +4,8 @@ import type { AdminOrderDetailDTO } from './detail-page'
 import { AttachmentListUi } from './attachment-list-ui'

+// satisfies Record<EnumType,...> on all three badge tables makes a missing enum
+// member a compile-time error rather than a runtime wrong-label.
+// (Implementation Discipline — enum dispatch)
 const ORDER_STATUS_BADGE = {
   QUOTE_REQUESTED:  { label: 'Quote requested',  className: 'bg-gray-100 text-gray-700' },
   QUOTE_PROVIDED:   { label: 'Quote provided',   className: 'bg-blue-100 text-blue-700' },

```


**CC-M-002-003** (src/app/dashboard/admin/orders/[orderId]/page.tsx) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ src/app/dashboard/admin/orders/[orderId]/page.tsx
@@ -0,0 +1,2 @@
+// Route entry point. Logic lives in the feature slice (ADR-001 VSA).
+export { default } from '@/features/admin/order-oversight/detail-page'
```

**Documentation:**

```diff
--- a/src/app/dashboard/admin/orders/[orderId]/page.tsx
+++ b/src/app/dashboard/admin/orders/[orderId]/page.tsx
@@ -1,2 +1,2 @@
 // Route entry point. Logic lives in the feature slice (ADR-001 VSA).
 export { default } from '@/features/admin/order-oversight/detail-page'

```


### Milestone 3: On-demand admin attachment download

**On-demand admin attachment download**

[Diagram pending Technical Writer rendering: DIAG-001]

**Files**: src/features/admin/order-oversight/view-attachment-action.ts, src/features/admin/order-oversight/attachment-list-ui.tsx

**Requirements**:

- ADMIN-gated viewOrderAttachment Server Action mirroring kyc-review/view-document-action.ts
- Loads r2Key from the Attachment row via findUnique (server-trusted; never from client input)
- Mints a 300s presigned GET via generatePresignedGetUrl with allowedPrefix 'orders/'
- Client component opens the URL on click, surfacing every failure branch to a rendered error state
- Re-checks session.user.role === 'ADMIN' on every invocation (layer 2); never mutates

**Acceptance Criteria**:

- Non-ADMIN (absent session or non-ADMIN role) returns { message: 'Unauthorized.' } and does not query or presign
- Missing attachment returns { message } and does not presign
- findUnique is called with the server-supplied attachmentId selecting r2Key; generatePresignedGetUrl receives the DB r2Key with allowedPrefix 'orders/'
- On success returns { url }; the client opens a new tab and shows an error string on any failure branch
- Action contains no update/create/delete/upsert

**Tests**:

- Covered by M-004 view-attachment-action.test.ts: unauthorized (absent + non-ADMIN), not-found, success path asserting findUnique args and generatePresignedGetUrl(r2Key, { allowedPrefix: 'orders/' })

#### Code Intent

- **CI-M-003-001** `src/features/admin/order-oversight/view-attachment-action.ts::viewOrderAttachment`: 'use server' action taking attachmentId: string, returning { message: string } | { url: string }. Calls auth(); when session is absent, session.user.id missing, or role !== 'ADMIN' returns { message: 'Unauthorized.' }. Wraps prisma.attachment.findUnique({ where: { id: attachmentId }, select: { r2Key: true } }) in try/catch returning { message: 'Unable to retrieve attachment.' } on error; null result returns { message: 'Attachment not found.' }. Calls generatePresignedGetUrl(doc.r2Key, { allowedPrefix: 'orders/' }) in try/catch and returns { url } on success, { message } on failure. No ownership-by-client check (ADMIN is cross-tenant by design); no mutation. (refs: DL-004, DL-005)
- **CI-M-003-002** `src/features/admin/order-oversight/attachment-list-ui.tsx::AttachmentListUi`: Client component taking attachments: { id, fileName, attachmentType, createdAt }[]. For each attachment renders metadata plus a View button. On click: open a placeholder tab synchronously (window.open('', '_blank')) BEFORE awaiting, then call viewOrderAttachment(id); on { url } set the opened tab's location to the url; on { message } close the placeholder tab and render the message to a per-component error state. Returns null when attachments is empty. No download URL is embedded in the rendered payload. (refs: DL-004)

#### Code Changes

**CC-M-003-001** (src/features/admin/order-oversight/view-attachment-action.ts) - implements CI-M-003-001

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/view-attachment-action.ts
@@ -0,0 +1,41 @@
+'use server'
+
+import { auth } from '@/lib/auth'
+import { prisma } from '@/lib/prisma'
+import { generatePresignedGetUrl } from '@/lib/storage/r2'
+
+type ViewAttachmentResult = { message: string } | { url: string }
+
+/**
+ * Mints a 300s presigned GET URL for an order attachment on admin click.
+ * ADMIN is cross-tenant by design — no clientId ownership check. (ref: DL-004, DL-005)
+ */
+export async function viewOrderAttachment(
+  attachmentId: string,
+): Promise<ViewAttachmentResult> {
+  const session = await auth()
+  if (!session || !session.user.id || session.user.role !== 'ADMIN') {
+    return { message: 'Unauthorized.' }
+  }
+
+  let doc: { r2Key: string } | null
+  try {
+    doc = await prisma.attachment.findUnique({
+      where: { id: attachmentId },
+      select: { r2Key: true },
+    })
+  } catch (e) {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  if (!doc) {
+    return { message: 'Attachment not found.' }
+  }
+
+  let url: string
+  try {
+    url = await generatePresignedGetUrl(doc.r2Key, { allowedPrefix: 'orders/' })
+  } catch (e) {
+    return { message: 'Unable to retrieve attachment.' }
+  }
+
+  return { url }
+}
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/view-attachment-action.ts
+++ b/src/features/admin/order-oversight/view-attachment-action.ts
@@ -1 +1 @@
 'use server'

```


**CC-M-003-002** (src/features/admin/order-oversight/attachment-list-ui.tsx) - implements CI-M-003-002

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/attachment-list-ui.tsx
@@ -0,0 +1,55 @@
+'use client'
+
+import { useState } from 'react'
+import { type AttachmentType } from '@prisma/client'
+import { viewOrderAttachment } from './view-attachment-action'
+
+type AttachmentItem = {
+  id: string
+  fileName: string
+  attachmentType: AttachmentType
+  createdAt: string
+}
+
+export function AttachmentListUi({ attachments }: { attachments: AttachmentItem[] }) {
+  const [errors, setErrors] = useState<Record<string, string>>({})
+
+  if (attachments.length === 0) return null
+
+  async function handleView(id: string) {
+    setErrors((prev) => ({ ...prev, [id]: '' }))
+    const win = window.open('', '_blank')
+    const result = await viewOrderAttachment(id)
+    if ('url' in result) {
+      if (win) {
+        win.location.href = result.url
+      } else {
+        window.location.href = result.url
+      }
+    } else {
+      win?.close()
+      setErrors((prev) => ({ ...prev, [id]: result.message ?? 'Unable to retrieve file.' }))
+    }
+  }
+
+  return (
+    <div className="bg-white rounded-lg shadow p-4">
+      <h2 className="text-sm font-semibold text-gray-700 mb-3">Attachments</h2>
+      <ul className="divide-y divide-gray-100">
+        {attachments.map((a) => (
+          <li key={a.id} className="py-3 flex items-center justify-between gap-4">
+            <div className="min-w-0">
+              <p className="text-sm text-gray-800 truncate">{a.fileName}</p>
+              <p className="text-xs text-gray-500">{a.attachmentType} &middot; {new Date(a.createdAt).toLocaleString()}</p>
+              {errors[a.id] && (
+                <p className="text-xs text-red-600 mt-1">{errors[a.id]}</p>
+              )}
+            </div>
+            <button
+              type="button"
+              onClick={() => void handleView(a.id)}
+              className="shrink-0 text-blue-600 hover:text-blue-800 text-sm font-medium"
+            >
+              View
+            </button>
+          </li>
+        ))}
+      </ul>
+    </div>
+  )
+}
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/attachment-list-ui.tsx
+++ b/src/features/admin/order-oversight/attachment-list-ui.tsx
@@ -17,6 +17,10 @@ export function AttachmentListUi({ attachments }: { attachments: AttachmentItem[

   async function handleView(id: string) {
     setErrors((prev) => ({ ...prev, [id]: '' }))
+    // window.open must be called synchronously (before the await) so popup
+    // blockers do not suppress it. The blank window is navigated to the presigned
+    // URL on success, or closed on error. (ref: DL-004; Implementation Discipline
+    // — client Server Action error surfacing)
     const win = window.open('', '_blank')
     const result = await viewOrderAttachment(id)
     if ('url' in result) {

```


### Milestone 4: Tests, vitest registration, slice docs

**Files**: src/features/admin/order-oversight/__tests__/view-attachment-action.test.ts, src/features/admin/order-oversight/__tests__/page.test.ts, src/features/admin/order-oversight/__tests__/detail-page.test.ts, vitest.unit.config.ts, src/features/admin/order-oversight/CLAUDE.md, src/features/admin/order-oversight/README.md, src/features/admin/CLAUDE.md

**Requirements**:

- Unit tests (vitest, no-DB full-mock) for the action and both RSC pages following kyc-review/__tests__ shape
- Register the new __tests__ glob in vitest.unit.config.ts
- Slice CLAUDE.md + README.md documenting the read-only, no-mutation design and decisions
- Add the order-oversight row to src/features/admin/CLAUDE.md

**Acceptance Criteria**:

- vitest.unit.config.ts includes 'src/features/admin/order-oversight/__tests__/**/*.test.ts'
- npm test -- --run is green; npx tsc --noEmit is clean
- Tests assert: ADMIN gate on action + both pages, cursor/order args to findMany, notFound vs throw split on detail, Decimal->string / Date->string DTO serialization
- src/features/admin/CLAUDE.md lists order-oversight; slice CLAUDE.md/README.md describe files and the read-only invariant

**Tests**:

- view-attachment-action.test.ts mirrors kyc-review/view-document-action.test.ts (hoisted mocks for prisma.attachment.findUnique, auth, generatePresignedGetUrl)
- page.test.ts: ADMIN gate redirect, ordering + cursor args to order.findMany, PII-minimized DTO, no-write assertion
- detail-page.test.ts: ADMIN gate, notFound on null order, throw on null guaranteed relation, Decimal->toFixed(2)/Date->toISOString string assertions

#### Code Intent

- **CI-M-004-001** `src/features/admin/order-oversight/__tests__/view-attachment-action.test.ts`: Vitest suite for viewOrderAttachment using vi.hoisted mocks named identically to the handler's Prisma calls: attachmentFindUnique, auth, generatePresignedGetUrl. Cases: absent session -> Unauthorized (no query/presign); non-ADMIN role -> Unauthorized; ADMIN + null row -> Attachment not found (no presign); ADMIN + row -> asserts findUnique called with { where: { id }, select: { r2Key: true } } and generatePresignedGetUrl called with (r2Key, { allowedPrefix: 'orders/' }), returns { url }. (refs: DL-004, DL-005)
- **CI-M-004-002** `src/features/admin/order-oversight/__tests__/page.test.ts`: Vitest suite for the list page. Mocks auth, prisma.order.findMany, and next/navigation redirect. Cases: non-ADMIN session triggers redirect(/auth/signin) and no query; ADMIN forward with no cursor passes orderBy [{createdAt:desc},{id:desc}] and take = PAGE_SIZE+1 with no cursor arg; ADMIN forward with a cursor searchParam passes the same desc orderBy plus { cursor:{id}, skip:1 }; ADMIN dir=prev with a cursor passes the REVERSED orderBy [{createdAt:asc},{id:asc}], take = PAGE_SIZE+1, { cursor:{id}, skip:1 }, and the resulting DTO rows are in display (desc) order (assert the reverse happened); a forward result of length PAGE_SIZE+1 yields PAGE_SIZE displayed rows with showNext=true and the extra row dropped; DTO mapping yields string quotedPrice/createdAt and contains no client email/phone/address keys. (refs: DL-001, DL-002, DL-003, DL-005)
- **CI-M-004-003** `src/features/admin/order-oversight/__tests__/detail-page.test.ts`: Vitest suite for the detail page. Mocks auth, prisma.order.findUnique, next/navigation (notFound + redirect). Cases: non-ADMIN -> redirect; null order -> notFound() called; order with null lab -> throws Error (not notFound); valid order -> DTO has string amount/gross/net/fee and ISO date strings (assert typeof === 'string', not Decimal/Date). (refs: DL-005, DL-006, DL-007)
- **CI-M-004-004** `vitest.unit.config.ts`: Add 'src/features/admin/order-oversight/__tests__/**/*.test.ts' to the test.include globs so the new directory's tests run (a missing glob silently drops them).
- **CI-M-004-005** `src/features/admin/order-oversight/CLAUDE.md`: Slice navigation index: Files table (page.tsx, ui.tsx, detail-page.tsx, detail-ui.tsx, view-attachment-action.ts, attachment-list-ui.tsx, README.md) and an Invariants note that the slice is strictly read-only and ADMIN-gated in both pages and the action. (refs: DL-001, DL-005)
- **CI-M-004-006** `src/features/admin/order-oversight/README.md`: Invisible-knowledge README: why read-only (T-13c privilege-escalation audit deferral), two-layer auth/TOCTOU, cursor pagination choice over offset, PII minimization (list vs detail) under RA 10173, on-demand presigned GET rationale (DL-004), and inline Decimal/Date serialization convention. (refs: DL-002, DL-003, DL-004, DL-005, DL-007)
- **CI-M-004-007** `src/features/admin/CLAUDE.md`: Add an order-oversight row to the Subdirectories table: 'Read-only ADMIN oversight of all orders, their transactions, and payouts; cursor-paginated list + per-order detail with on-demand attachment download'. (refs: DL-001)

#### Code Changes

**CC-M-004-001** (src/features/admin/order-oversight/__tests__/view-attachment-action.test.ts) - implements CI-M-004-001

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/__tests__/view-attachment-action.test.ts
@@ -0,0 +1,80 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  attachmentFindUnique: vi.fn(),
+  auth: vi.fn(),
+  generatePresignedGetUrl: vi.fn(),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    attachment: { findUnique: mocks.attachmentFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('@/lib/storage/r2', () => ({
+  generatePresignedGetUrl: mocks.generatePresignedGetUrl,
+}))
+
+import { viewOrderAttachment } from '../view-attachment-action'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const ADMIN_SESSION = {
+  user: { id: 'admin-1', role: 'ADMIN' },
+  expires: '2099-01-01',
+}
+
+describe('viewOrderAttachment (admin)', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+  })
+
+  it('returns Unauthorized when session is absent — no query or presign', async () => {
+    mockAuth.mockResolvedValue(null)
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns Unauthorized when role is non-ADMIN', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+    const result = await viewOrderAttachment('att-1')
+    expect(result).toEqual({ message: 'Unauthorized.' })
+    expect(mocks.attachmentFindUnique).not.toHaveBeenCalled()
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns Attachment not found when row is null — no presign', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue(null)
+    const result = await viewOrderAttachment('att-missing')
+    expect(result).toEqual({ message: 'Attachment not found.' })
+    expect(mocks.generatePresignedGetUrl).not.toHaveBeenCalled()
+  })
+
+  it('returns presigned URL for existing attachment — findUnique called with correct args', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.attachmentFindUnique.mockResolvedValue({ r2Key: 'orders/ord-1/file.pdf' })
+    mocks.generatePresignedGetUrl.mockResolvedValue('https://r2.example.com/signed'
+    )
+
+    const result = await viewOrderAttachment('att-1')
+
+    expect(mocks.attachmentFindUnique).toHaveBeenCalledWith({
+      where: { id: 'att-1' },
+      select: { r2Key: true },
+    })
+    expect(mocks.generatePresignedGetUrl).toHaveBeenCalledWith(
+      'orders/ord-1/file.pdf',
+      { allowedPrefix: 'orders/' },
+    )
+    expect(result).toEqual({ url: 'https://r2.example.com/signed' })
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/__tests__/view-attachment-action.test.ts
+++ b/src/features/admin/order-oversight/__tests__/view-attachment-action.test.ts
@@ -1 +1 @@
 import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

```


**CC-M-004-002** (src/features/admin/order-oversight/__tests__/page.test.ts) - implements CI-M-004-002

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/__tests__/page.test.ts
@@ -0,0 +1,155 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindMany: vi.fn(),
+  auth: vi.fn(),
+  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findMany: mocks.orderFindMany },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('next/navigation', () => ({
+  redirect: mocks.redirect,
+}))
+
+import AdminOrderListPage from '../page'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const ADMIN_SESSION = { user: { id: 'admin-1', role: 'ADMIN' }, expires: '2099-01-01' }
+const PAGE_SIZE = 25
+
+function makeOrder(id: string, overrides: Record<string, unknown> = {}) {
+  return {
+    id,
+    status: 'PENDING',
+    quotedPrice: null,
+    createdAt: new Date('2024-01-01T00:00:00.000Z'),
+    lab: { name: 'Lab A' },
+    clientProfile: { name: 'Client A' },
+    ...overrides,
+  }
+}
+
+describe('AdminOrderListPage', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+  })
+
+  it('redirects non-ADMIN session and does not query', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+    await expect(AdminOrderListPage({ searchParams: {} })).rejects.toThrow('NEXT_REDIRECT')
+    expect(mocks.redirect).toHaveBeenCalledWith('/auth/signin')
+    expect(mocks.orderFindMany).not.toHaveBeenCalled()
+  })
+
+  it('forward with no cursor passes desc orderBy and take=PAGE_SIZE+1 with no cursor arg', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.orderFindMany.mockResolvedValue([])
+    await AdminOrderListPage({ searchParams: {} })
+    expect(mocks.orderFindMany).toHaveBeenCalledWith(
+      expect.objectContaining({
+        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
+        take: PAGE_SIZE + 1,
+      }),
+    )
+    const call = mocks.orderFindMany.mock.calls[0][0] as Record<string, unknown>
+    expect(call).not.toHaveProperty('cursor')
+  })
+
+  it('forward with cursor passes desc orderBy plus cursor and skip:1', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.orderFindMany.mockResolvedValue([])
+    await AdminOrderListPage({ searchParams: { cursor: 'abc', dir: 'next' } })
+    expect(mocks.orderFindMany).toHaveBeenCalledWith(
+      expect.objectContaining({
+        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
+        take: PAGE_SIZE + 1,
+        cursor: { id: 'abc' },
+        skip: 1,
+      }),
+    )
+  })
+
+  it('dir=prev with cursor passes reversed asc orderBy and cursor/skip', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    const orders = [makeOrder('id-2'), makeOrder('id-1')]
+    mocks.orderFindMany.mockResolvedValue(orders)
+    const result = await AdminOrderListPage({ searchParams: { cursor: 'id-0', dir: 'prev' } })
+    expect(mocks.orderFindMany).toHaveBeenCalledWith(
+      expect.objectContaining({
+        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
+        take: PAGE_SIZE + 1,
+        cursor: { id: 'id-0' },
+        skip: 1,
+      }),
+    )
+    // result is JSX; check it renders without throwing
+    expect(result).toBeDefined()
+  })
+
+  it('forward result of PAGE_SIZE+1 yields PAGE_SIZE rows with showNext=true and extra row dropped', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    const extraRow = makeOrder('extra')
+    const rows = Array.from({ length: PAGE_SIZE }, (_, i) => makeOrder(`id-${i}`))
+    mocks.orderFindMany.mockResolvedValue([...rows, extraRow])
+    // Render and check props passed to child via JSX
+    const jsx = await AdminOrderListPage({ searchParams: {} })
+    // jsx.props.rows should have PAGE_SIZE entries, showNext=true
+    expect(jsx.props.rows).toHaveLength(PAGE_SIZE)
+    expect(jsx.props.showNext).toBe(true)
+    expect(jsx.props.rows.find((r: { id: string }) => r.id === 'extra')).toBeUndefined()
+  })
+
+  it('DTO mapping serializes quotedPrice and createdAt to strings', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    const { Decimal } = await import('@prisma/client/runtime/library')
+    mocks.orderFindMany.mockResolvedValue([
+      makeOrder('id-1', {
+        quotedPrice: new Decimal('150.50'),
+        createdAt: new Date('2024-06-01T12:00:00.000Z'),
+      }),
+    ])
+    const jsx = await AdminOrderListPage({ searchParams: {} })
+    const row = jsx.props.rows[0] as Record<string, unknown>
+    expect(typeof row.quotedPrice).toBe('string')
+    expect(typeof row.createdAt).toBe('string')
+    expect(row.quotedPrice).toBe('150.50')
+    expect(row.createdAt).toBe('2024-06-01T12:00:00.000Z')
+  })
+
+  it('DTO row contains no client email or phone keys (PII minimization)', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.orderFindMany.mockResolvedValue([makeOrder('id-1')])
+    const jsx = await AdminOrderListPage({ searchParams: {} })
+    const row = jsx.props.rows[0] as Record<string, unknown>
+    expect(row).not.toHaveProperty('email')
+    expect(row).not.toHaveProperty('phone')
+    expect(row).not.toHaveProperty('address')
+  })
+
+  it('backward traversal reverses rows to restore desc display order', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    // Prisma returns asc order for prev; page should reverse to desc
+    const asc = [makeOrder('id-1'), makeOrder('id-2'), makeOrder('id-3')]
+    mocks.orderFindMany.mockResolvedValue(asc)
+    const jsx = await AdminOrderListPage({ searchParams: { cursor: 'id-0', dir: 'prev' } })
+    const rows = jsx.props.rows as Array<{ id: string }>
+    expect(rows[0].id).toBe('id-3')
+    expect(rows[rows.length - 1].id).toBe('id-1')
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/__tests__/page.test.ts
+++ b/src/features/admin/order-oversight/__tests__/page.test.ts
@@ -1 +1 @@
 import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

```


**CC-M-004-003** (src/features/admin/order-oversight/__tests__/detail-page.test.ts) - implements CI-M-004-003

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/__tests__/detail-page.test.ts
@@ -0,0 +1,117 @@
+import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
+
+const mocks = vi.hoisted(() => ({
+  orderFindUnique: vi.fn(),
+  auth: vi.fn(),
+  redirect: vi.fn(() => { throw new Error('NEXT_REDIRECT') }),
+  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
+}))
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    order: { findUnique: mocks.orderFindUnique },
+  },
+}))
+
+vi.mock('@/lib/auth', () => ({
+  auth: mocks.auth,
+}))
+
+vi.mock('next/navigation', () => ({
+  redirect: mocks.redirect,
+  notFound: mocks.notFound,
+}))
+
+import AdminOrderDetailPage from '../detail-page'
+import { auth } from '@/lib/auth'
+
+const mockAuth = auth as unknown as Mock
+
+const ADMIN_SESSION = { user: { id: 'admin-1', role: 'ADMIN' }, expires: '2099-01-01' }
+
+function makeOrder(overrides: Record<string, unknown> = {}) {
+  return {
+    id: 'order-1',
+    status: 'COMPLETED',
+    quotedPrice: null,
+    quotedAt: null,
+    paidAt: null,
+    refundedAt: null,
+    createdAt: new Date('2024-01-01T00:00:00.000Z'),
+    updatedAt: new Date('2024-01-02T00:00:00.000Z'),
+    lab: { name: 'Lab A', id: 'lab-1' },
+    service: { name: 'Service A', id: 'svc-1' },
+    client: { id: 'client-1', name: 'Alice', email: 'alice@example.com' },
+    clientProfile: null,
+    transactions: [],
+    payouts: [],
+    attachments: [],
+    ...overrides,
+  }
+}
+
+describe('AdminOrderDetailPage', () => {
+  beforeEach(() => {
+    vi.clearAllMocks()
+  })
+
+  it('redirects non-ADMIN session', async () => {
+    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'CLIENT' }, expires: '2099-01-01' })
+    await expect(AdminOrderDetailPage({ params: { orderId: 'order-1' } })).rejects.toThrow('NEXT_REDIRECT')
+    expect(mocks.redirect).toHaveBeenCalledWith('/auth/signin')
+  })
+
+  it('calls notFound when order is null', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(null)
+    await expect(AdminOrderDetailPage({ params: { orderId: 'missing' } })).rejects.toThrow('NEXT_NOT_FOUND')
+    expect(mocks.notFound).toHaveBeenCalled()
+  })
+
+  it('throws when order.lab is null after explicit include', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    mocks.orderFindUnique.mockResolvedValue(makeOrder({ lab: null }))
+    await expect(
+      AdminOrderDetailPage({ params: { orderId: 'order-1' } }),
+    ).rejects.toThrow(/referential integrity violation/i)
+    expect(mocks.notFound).not.toHaveBeenCalled()
+  })
+
+  it('returns DTO with string amount and ISO date strings for valid order', async () => {
+    mockAuth.mockResolvedValue(ADMIN_SESSION)
+    const { Decimal } = await import('@prisma/client/runtime/library')
+    mocks.orderFindUnique.mockResolvedValue(
+      makeOrder({
+        quotedPrice: new Decimal('200.00'),
+        quotedAt: new Date('2024-02-01T00:00:00.000Z'),
+        paidAt: new Date('2024-02-02T00:00:00.000Z'),
+        transactions: [
+          {
+            id: 'txn-1',
+            amount: new Decimal('200.00'),
+            status: 'CAPTURED',
+            paymentMethod: 'card',
+            capturedAt: new Date('2024-02-02T00:00:00.000Z'),
+            createdAt: new Date('2024-02-01T00:00:00.000Z'),
+          },
+        ],
+        payouts: [
+          {
+            id: 'payout-1',
+            grossAmount: new Decimal('190.00'),
+            platformFee: new Decimal('19.00'),
+            netAmount: new Decimal('171.00'),
+            feePercentage: new Decimal('0.1000'),
+            status: 'COMPLETED',
+            scheduledDate: null,
+            completedAt: new Date('2024-02-10T00:00:00.000Z'),
+            createdAt: new Date('2024-02-03T00:00:00.000Z'),
+          },
+        ],
+      }),
+    )
+    const jsx = await AdminOrderDetailPage({ params: { orderId: 'order-1' } })
+    const dto = jsx.props.dto as Record<string, unknown>
+    expect(typeof dto.quotedPrice).toBe('string')
+    expect(typeof dto.createdAt).toBe('string')
+    const txn = (dto.transactions as Array<Record<string, unknown>>)[0]
+    expect(typeof txn.amount).toBe('string')
+    expect(typeof txn.capturedAt).toBe('string')
+    const payout = (dto.payouts as Array<Record<string, unknown>>)[0]
+    expect(typeof payout.grossAmount).toBe('string')
+    expect(typeof payout.netAmount).toBe('string')
+    expect(typeof payout.completedAt).toBe('string')
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/admin/order-oversight/__tests__/detail-page.test.ts
+++ b/src/features/admin/order-oversight/__tests__/detail-page.test.ts
@@ -1 +1 @@
 import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'

```


**CC-M-004-004** (vitest.unit.config.ts) - implements CI-M-004-004

**Code:**

```diff
--- a/vitest.unit.config.ts
+++ b/vitest.unit.config.ts
@@ -27,6 +27,7 @@ export default defineConfig({
       'src/features/orders/spec-upload/__tests__/**/*.test.ts',
       'src/features/orders/result-upload/__tests__/**/*.test.ts',
+      'src/features/admin/order-oversight/__tests__/**/*.test.ts',
     ],
   },
 })
```

**Documentation:**

```diff
--- a/vitest.unit.config.ts
+++ b/vitest.unit.config.ts
@@ -27,6 +27,7 @@
       'src/features/orders/spec-upload/__tests__/**/*.test.ts',
       'src/features/orders/result-upload/__tests__/**/*.test.ts',
+      'src/features/admin/order-oversight/__tests__/**/*.test.ts',
     ],
   },
 })

```


**CC-M-004-005** (src/features/admin/order-oversight/CLAUDE.md) - implements CI-M-004-005

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/CLAUDE.md
@@ -0,0 +1,26 @@
+# order-oversight/
+
+Read-only ADMIN oversight of all platform orders, their transactions, and payouts.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `page.tsx` | RSC list page — cursor-paginated, PII-minimized; renders `AdminOrderListUi` | Modifying list query, pagination, or DTO shape |
+| `ui.tsx` | `AdminOrderListUi` — table with status badges, Prev/Next cursor links | Modifying list table layout |
+| `detail-page.tsx` | RSC detail page — full order with transactions, payouts, attachments; renders `AdminOrderDetailUi` | Modifying detail data shape, relation guards, or DTO |
+| `detail-ui.tsx` | `AdminOrderDetailUi` — order header, client PII section, transactions table, payouts table, attachment list | Modifying detail layout |
+| `view-attachment-action.ts` | `viewOrderAttachment` — ADMIN-gated; mints 300s presigned GET for an attachment | Modifying attachment download |
+| `attachment-list-ui.tsx` | `AttachmentListUi` — renders attachment list with on-click View (window.open before await) | Modifying attachment UI |
+| `README.md` | Invisible-knowledge design decisions | Before changing auth, pagination, PII policy, or attachment access |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for `view-attachment-action.ts`, list page, and detail page | Adding or debugging tests |
+
+## Invariants
+
+- Slice is strictly read-only — zero write paths (no update/create/delete/upsert).
+- ADMIN role re-checked independently in every RSC page and Server Action (two-layer auth, TOCTOU).
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/admin/order-oversight/CLAUDE.md
@@ -0,0 +1,29 @@
+# order-oversight/
+
+Read-only ADMIN oversight of all platform orders, their transactions, and payouts.
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `page.tsx` | RSC list page — cursor-paginated, PII-minimized (DL-002); renders `AdminOrderListUi` | Modifying list query, pagination, or DTO shape |
+| `ui.tsx` | `AdminOrderListUi` — table with status badges, Prev/Next cursor links | Modifying list table layout |
+| `detail-page.tsx` | RSC detail page — full order with transactions, payouts, attachments; renders `AdminOrderDetailUi` | Modifying detail data shape, relation guards, or DTO |
+| `detail-ui.tsx` | `AdminOrderDetailUi` — order header, client PII section, transactions table, payouts table, attachment list | Modifying detail layout |
+| `view-attachment-action.ts` | `viewOrderAttachment` — ADMIN-gated (DL-005); mints 300s presigned GET for an attachment | Modifying attachment download |
+| `attachment-list-ui.tsx` | `AttachmentListUi` — renders attachment list with on-click View (window.open before await) | Modifying attachment UI |
+| `README.md` | Invisible-knowledge design decisions | Before changing auth, pagination, PII policy, or attachment access |
+
+## Subdirectories
+
+| Directory | What | When to read |
+| --------- | ---- | ------------ |
+| `__tests__/` | Unit tests for `view-attachment-action.ts`, list page, and detail page | Adding or debugging tests |
+
+## Invariants
+
+- Slice is strictly read-only — zero write paths (no update/create/delete/upsert).
+- ADMIN role re-checked independently in every RSC page and Server Action — layout guard is layer 1 only (TOCTOU, DL-005).
+- List view surfaces PII-minimized fields only; full ClientProfile visible in detail behind the ADMIN gate (DL-002, RA 10173).
+- ADMIN access requires a bootstrapped ADMIN user — no in-app role promotion path exists.

```


**CC-M-004-006** (src/features/admin/order-oversight/README.md) - implements CI-M-004-006

**Code:**

```diff
--- /dev/null
+++ src/features/admin/order-oversight/README.md
@@ -0,0 +1,46 @@
+# order-oversight — Design Decisions
+
+## Why read-only
+
+T-13b is deliberately mutation-free. Refund, force-status, and reassign-lab touches
+the payment-event state machine and requires a separate privilege-escalation audit
+(T-13c). Any write reintroduces the audit burden that deferred T-13c. The layout
+guard provides layer-1 protection; every RSC page and Server Action independently
+re-checks `session.user.role === 'ADMIN'` to prevent TOCTOU (DL-001).
+
+## Two-layer auth / TOCTOU
+
+Server Actions and RSC pages are independently POST-invocable — the layout guard
+does not protect them. Every file in this slice performs its own role check.
+
+## Cursor pagination over offset
+
+`findMany` with `cursor + skip:1` provides stable pagination under concurrent
+inserts/deletes; offset pagination drifts when rows are added or removed between
+page loads. PAGE_SIZE=25 caps each query to a small result set. The backward branch
+reverses `orderBy` to `[{createdAt:asc},{id:asc}]`, fetches, then `.reverse()`s
+the result to restore display (newest-first) order.
+
+## PII minimization — list vs detail
+
+The list view surfaces only order id, status, lab name, client display name, amount,
+and timestamps. Full `ClientProfile` PII (email, phone, address) appears only on the
+detail page, justified by support use behind the ADMIN gate per RA 10173 data
+minimization.
+
+## On-demand presigned GET (DL-004)
+
+Attachment URLs are not embedded in the RSC payload. `viewOrderAttachment` mints a
+300s presigned GET URL per click, re-checking ADMIN role on every call. The R2 key
+is loaded from the stored `Attachment.r2Key` row — never derived from client input.
+`generatePresignedGetUrl` enforces the `orders/` prefix guard as defense-in-depth.
+ADMIN has cross-tenant access by design — no `clientId` ownership check.
+
+## Inline Decimal / Date serialization
+
+All `Prisma.Decimal` fields are serialized via `.toFixed(2)` (`.toFixed(4)` for
+`feePercentage`) and all `Date` fields via `.toISOString()` at the RSC boundary.
+Next.js cannot serialize these types; the failure is a runtime crash, not a tsc
+error. DTO field types reflect the serialized form (`amount: string`, not
+`amount: Decimal`). No shared serialize helper is introduced — the inline-map
+convention (per `src/features/labs/wallet/page.tsx`) is followed.
```

**Documentation:**

```diff
--- /dev/null
+++ b/src/features/admin/order-oversight/README.md
@@ -0,0 +1,52 @@
+# order-oversight — Design Decisions
+
+## Why read-only
+
+T-13b is deliberately mutation-free. Refund, force-status, and reassign-lab touches
+the payment-event state machine and requires a separate privilege-escalation audit
+(T-13c). Any write reintroduces the audit burden that deferred T-13c. The layout
+guard provides layer-1 protection; every RSC page and Server Action independently
+re-checks `session.user.role === 'ADMIN'` to prevent TOCTOU (DL-001).
+
+## Two-layer auth / TOCTOU (DL-005)
+
+Server Actions and RSC pages are independently POST-invocable — the layout guard
+does not protect them. Every file in this slice performs its own role check.
+Relying on the layout guard alone leaks cross-tenant order, PII, and financial
+data to an unauthenticated POST.
+
+## PII minimization — list vs detail (DL-002)
+
+The list view surfaces only order id, status, lab name, client display name, amount,
+and timestamps. Full `ClientProfile` PII (email, phone, address) appears only on the
+detail page, justified by support use behind the ADMIN gate per RA 10173 data
+minimization. No PII or financial data is tracked in analytics (global standard).
+
+## Cursor pagination over offset (DL-003)
+
+`findMany` with `cursor + skip:1` provides stable pagination under concurrent
+inserts/deletes; offset pagination drifts when rows are added or removed between
+page loads. PAGE_SIZE=25 caps each query to a small result set. The backward branch
+reverses `orderBy` to `[{createdAt:asc},{id:asc}]`, fetches, then `.reverse()`s
+the result to restore display (newest-first) order.
+
+## On-demand presigned GET (DL-004)
+
+Attachment URLs are not embedded in the RSC payload. `viewOrderAttachment` mints a
+300s presigned GET URL per click, re-checking ADMIN role on every call. The R2 key
+is loaded from the stored `Attachment.r2Key` row — never derived from client input.
+`generatePresignedGetUrl` enforces the `orders/` prefix guard as defense-in-depth.
+ADMIN has cross-tenant access by design — no `clientId` ownership check.
+
+## Inline Decimal / Date serialization (DL-007)
+
+All `Prisma.Decimal` fields are serialized via `.toFixed(2)` (`.toFixed(4)` for
+`feePercentage`) and all `Date` fields via `.toISOString()` at the RSC boundary.
+Next.js cannot serialize these types; the failure is a runtime crash, not a tsc
+error. DTO field types reflect the serialized form (`amount: string`, not
+`amount: Decimal`). No shared serialize helper is introduced — the inline-map
+convention (per `src/features/labs/wallet/page.tsx`) is followed.
+
+## ADMIN bootstrap — no in-app promotion
+
+ADMIN role is provisioned via direct database UPDATE per environment. No in-app
+promotion path exists — any UI that granted or revoked ADMIN would require its own
+privilege-escalation audit. Dev environment: alfieprojects.dev@gmail.com is
+bootstrapped.

```


**CC-M-004-007** (src/features/admin/CLAUDE.md) - implements CI-M-004-007

**Code:**

```diff
--- a/src/features/admin/CLAUDE.md
+++ b/src/features/admin/CLAUDE.md
@@ -10,4 +10,5 @@ Admin-only feature slices. All slices under this directory are protected by
 | `kyc-review/` | KYC document review — queue of SUBMITTED labs, per-lab detail, approve/reject CAS on `kycStatus` | Implementing or modifying the KYC review flow |
 | `accreditation-review/` | ISO 17025 accreditation review — queue of unverified labs with an uploaded cert, verify/reject boolean CAS on `isVerified` | Implementing or modifying the accreditation review flow |
+| `order-oversight/` | Read-only ADMIN oversight of all orders, their transactions, and payouts; cursor-paginated list + per-order detail with on-demand attachment download | Implementing or modifying order oversight |
```

**Documentation:**

```diff
--- a/src/features/admin/CLAUDE.md
+++ b/src/features/admin/CLAUDE.md
@@ -10,4 +10,5 @@ Admin-only feature slices. All slices under this directory are protected by
 | `kyc-review/` | KYC document review — queue of SUBMITTED labs, per-lab detail, approve/reject CAS on `kycStatus` | Implementing or modifying the KYC review flow |
 | `accreditation-review/` | ISO 17025 accreditation review — queue of unverified labs with an uploaded cert, verify/reject boolean CAS on `isVerified` | Implementing or modifying the accreditation review flow |
+| `order-oversight/` | Read-only ADMIN oversight of all orders, their transactions, and payouts; cursor-paginated list + per-order detail with on-demand attachment download | Implementing or modifying order oversight |

```


## Execution Waves

- W-001: M-001, M-003
- W-002: M-002
- W-003: M-004
