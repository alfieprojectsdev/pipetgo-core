# dashboard/

Vertical slice serving `/dashboard/lab` — LAB_ADMIN order listing with
three status tabs.

## Auth and Ownership Guard

`page.tsx` uses `auth()` to verify `session.user.role === 'LAB_ADMIN'` then
calls `prisma.lab.findUnique({ where: { ownerId: session.user.id } })`. If the
result is null, `notFound()` is returned.

`Lab.ownerId` is `@unique` — one lab per owner enforced at the schema level (T-15).
`findUnique` enforces the constraint at the query level and makes the lookup intent explicit.

## Query Strategy

A single `prisma.order.findMany({ where: { labId: lab.id } })` returns all lab
orders. Client-side `.filter()` splits them into the three tab arrays. (ref: DL-001)

Three parallel queries were rejected: they triple the auth and ownership guard
code without a meaningful performance difference. `Order` has `@@index([labId])`
so the `findMany` is index-backed. Pagination is deferred to a follow-up slice
when order volume warrants it.

## Sort Order

Prisma query uses `orderBy: { createdAt: 'asc' }`. Incoming and Active tabs
display in this FIFO order (oldest first = next to process). History tab calls
`.toReversed()` in `ui.tsx` to show most recent completions first. (ref: DL-003)

Two queries with different `orderBy` were rejected: adds complexity for a
client-side operation that has no observable performance cost at MVP scale.

## Tab Switching

Tab selection is `useState` only — no URL `searchParams`. (ref: DL-002)

Direct-linking to a specific tab was not specified as a requirement. `useState`
matches the `lab-fulfillment` conditional rendering pattern already in the
codebase.

## Client Name Fallback

`clientProfile?.name ?? 'Unknown Client'` is used for every order row.
(ref: DL-004)

Orders where `clientProfile` is `null` must not be filtered out — they
represent real orders where the client profile is missing, not invalid orders.
Filtering silently drops visible orders from the lab admin's view.

## DTO

`LabDashboardOrderDTO` uses primitive types only. `createdAt` is serialized to
ISO string so Next.js can pass it across the RSC-to-client boundary. The DTO
does not include `quotedPrice` — the listing view does not display pricing.
