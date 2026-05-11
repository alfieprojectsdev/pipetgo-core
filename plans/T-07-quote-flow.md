# T-07 — Quote Flow

**Ticket:** T-07  
**Branch:** `feat/T07-quote-flow`  
**Status:** Ready to implement  
**Last reviewed:** 2026-05-11 (steelman + QR — all findings resolved)

---

## Architecture Decisions (locked)

| # | Decision | Rationale |
|---|---|---|
| D1 | Status dispatch at app router level | App router is the composition point per ADR-001; dispatch is exhaustive (`default: notFound()`) so new statuses are never silently routed |
| D2 | `acceptQuote` writes QUOTE_PROVIDED→PAYMENT_PENDING directly | Added as a direct edge to the state machine; phantom PENDING write inside a transaction was architecturally dishonest — PENDING is an observable state for FIXED orders, not a millisecond waypoint |
| D3 | Client quote actions inline on `order-detail/` (not a separate slice) | QUOTE_PROVIDED renders the same order summary as all other statuses plus an action panel — a dispatcher would require duplicating the base rendering or an ADR-001-violating cross-slice import. Asymmetry with lab-side dispatcher is intentional and documented. |
| D4 | QUOTE_REJECTED terminal for T-07 | Re-request loop (QUOTE_REJECTED→QUOTE_REQUESTED) is T-09; QUOTE_REJECTED view must show explanatory copy so clients don't perceive the system as broken |

---

## Requirements Summary

End-to-end quote flow for `QUOTE_REQUIRED` (and `HYBRID`) priced services:

1. **LAB_ADMIN** views a `QUOTE_REQUESTED` order, enters a price, and submits it.
2. **CLIENT** views the quoted price on the order detail page and either accepts or rejects.
3. **Accept** → QUOTE_PROVIDED→PAYMENT_PENDING (single direct transition) → redirect to checkout.
4. **Reject** → QUOTE_REJECTED (terminal for T-07; T-09 adds re-request loop).
5. The lab dashboard must surface `QUOTE_REQUESTED` orders in a new "Quoting" tab.

---

## Acceptance Criteria

- [ ] A `QUOTE_REQUESTED` order appears in the "Quoting" tab of the lab dashboard (`/dashboard/lab`).
- [ ] Navigating to `/dashboard/lab/orders/[orderId]` for a `QUOTE_REQUESTED` order renders the `QuoteProvidePage`, not the `LabFulfillmentPage`.
- [ ] Navigating to the same route for an `ACKNOWLEDGED` or `IN_PROGRESS` order still renders `LabFulfillmentPage` (regression guard).
- [ ] Navigating to `/dashboard/lab/orders/[orderId]` for any status not handled by the dispatcher returns 404 (exhaustive dispatch guard).
- [ ] The `provideQuote` action writes `quotedPrice` and `quotedAt` atomically and advances the order to `QUOTE_PROVIDED`; a non-positive, non-numeric, or partial-numeric price (e.g. `"1.5abc"`) returns an error state and leaves the DB unmodified.
- [ ] The `cancelOrder` action (quote-provide slice) transitions a `QUOTE_REQUESTED` order to `CANCELLED` inside a `$transaction` with ownership check, then redirects to `/dashboard/lab`.
- [ ] The client order detail page (`/dashboard/orders/[orderId]`) shows a quote action panel (quoted price + Accept + Reject) when and only when `status === QUOTE_PROVIDED`.
- [ ] `acceptQuote` transitions QUOTE_PROVIDED→PAYMENT_PENDING in a single `$transaction` and redirects to `/checkout/[orderId]`.
- [ ] `rejectQuote` transitions QUOTE_PROVIDED→QUOTE_REJECTED and `revalidatePath` the order detail page (no redirect); the page re-renders showing QUOTE_REJECTED status badge and explanatory copy.
- [ ] Every action re-verifies auth and ownership inside the `$transaction` (TOCTOU guard).
- [ ] `isValidStatusTransition()` is called before every `Order.status` write.
- [ ] `npx tsc --noEmit` is clean; `npm test -- --run` is clean.

---

## Implementation Steps

### Step 1 — Patch the state machine

**File:** `src/domain/orders/state-machine.ts`, lines 13–17

Add `OrderStatus.PAYMENT_PENDING` to the `QUOTE_PROVIDED` outbound edges:

```ts
[OrderStatus.QUOTE_PROVIDED]: [
  OrderStatus.QUOTE_REJECTED,
  OrderStatus.PENDING,
  OrderStatus.PAYMENT_PENDING,  // ← add: direct accept path; PENDING edge retained for any future use
  OrderStatus.CANCELLED,
],
```

Update the file-level comment (lines 5–7) to document the new edge:
> "PAYMENT_PENDING is reachable from PENDING (FIXED auto-price) and directly from QUOTE_PROVIDED (client accepts quote)."

---

### Step 2 — Create the `quote-provide` slice

New directory: `src/features/orders/quote-provide/`

**`action.ts`**

```
'use server'
```

Two server actions, each with TOCTOU guard mirroring `lab-fulfillment/action.ts:47–71`.

`provideQuote(_prevState, formData)`:
- Extract `orderId` (string), `price` (string) from formData.
- Validate: `orderId` present; `const n = Number(price); if (!Number.isFinite(n) || n <= 0) return { message: '...' }` — use `Number()` not `parseFloat` because `parseFloat('1.5abc')` returns `1.5` and passes `isFinite`, but `Number('1.5abc')` is `NaN` and correctly rejects partial strings.
- Auth guard: `session.user.role === 'LAB_ADMIN'`.
- `$transaction`:
  1. `tx.order.findUnique({ where: { id: orderId }, include: { lab: true } })`
  2. Ownership (canonical three-part guard matching `lab-fulfillment/action.ts:53`): `if (!order || !order.lab || order.lab.ownerId !== session.user.id) return { message: 'Order not found.' }`
  3. `isValidStatusTransition(order.status, OrderStatus.QUOTE_PROVIDED)` → return error if false.
  4. `tx.order.update({ data: { status: QUOTE_PROVIDED, quotedPrice: new Prisma.Decimal(price), quotedAt: new Date() } })`
  5. Return `null`.
- `revalidatePath('/dashboard/lab')` after transaction — no redirect (stays on quote-provide page, which re-renders with updated status triggering the dispatch page's 404 guard if navigated again).

`cancelOrder(_prevState, formData)`:
- Extract `orderId`.
- Auth guard: `LAB_ADMIN`.
- `$transaction`: canonical three-part ownership guard + `isValidStatusTransition(order.status, CANCELLED)` + update to CANCELLED.
- `revalidatePath('/dashboard/lab')` then `redirect('/dashboard/lab')` — outside try/catch, same pattern as `lab-fulfillment/action.ts:121–122`.

**`page.tsx`**

Async RSC. Accepts `{ params: { orderId: string } }`.

- Auth: `LAB_ADMIN` or redirect.
- `prisma.order.findUnique` with `include: { service: true, lab: true, clientProfile: true }`.
- Ownership guard: canonical three-part — `if (!order || !order.lab || order.lab.ownerId !== session.user.id) notFound()`.
- Status guard: `order.status !== QUOTE_REQUESTED` → `notFound()` (defense-in-depth; dispatch routes here only for QUOTE_REQUESTED).
- Build `QuoteOrderDTO` (all primitives):
  ```ts
  type QuoteOrderDTO = {
    id: string
    serviceName: string
    clientName: string | null
    clientEmail: string | null
    quantity: number
    notes: string | null
    createdAt: string
  }
  ```
  `quotedPrice` intentionally excluded — it doesn't exist yet for QUOTE_REQUESTED orders.
- Render `<QuoteProvideUI orderId={order.id} order={dto} />`.

**`ui.tsx`**

`'use client'`

`QuoteProvideUI({ orderId, order: QuoteOrderDTO })`:
- Order summary card: service name, client name/email, quantity, notes, submitted date.
- `useActionState(provideQuote, null)` → `ProvideQuoteForm`: `<input name="price" type="number" step="0.01" min="0.01" />`, hidden `orderId`, submit button "Provide Quote".
- `useActionState(cancelOrder, null)` → `CancelOrderForm`: hidden `orderId`, submit button "Cancel Order" (destructive style).
- Inline error display from action state.

**`CLAUDE.md`**

```markdown
# quote-provide/

Vertical slice: LAB_ADMIN views a QUOTE_REQUESTED order and provides a price quote.

Route: /dashboard/lab/orders/[orderId] (via status dispatch — see app/dashboard/lab/orders/[orderId]/page.tsx)
Auth:  LAB_ADMIN role only; redirects to /auth/signin otherwise.
Guard: notFound() for ownership mismatch. notFound() for any status other than QUOTE_REQUESTED.

## Files

| File        | What                                                                              | When to read                                              |
| ----------- | --------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `page.tsx`  | Async RSC — LAB_ADMIN auth, ownership guard, status guard, DTO, renders UI       | Modifying auth gate, order fetch, or QuoteOrderDTO        |
| `ui.tsx`    | `'use client'` — price input form (provideQuote), cancel form (cancelOrder)      | Modifying form layout or error display                    |
| `action.ts` | `provideQuote` (QUOTE_REQUESTED→QUOTE_PROVIDED), `cancelOrder` (→CANCELLED)     | Modifying quote write or cancellation                     |

## Invariants

- `QuoteOrderDTO` contains no `Prisma.Decimal` or `Date` — all fields are primitives.
- `quotedPrice` is absent from the DTO (order has no price yet at QUOTE_REQUESTED).
- `provideQuote` sets both `quotedPrice` (Prisma.Decimal) and `quotedAt` (new Date()) atomically.
- Price validation uses `Number()` not `parseFloat` — `parseFloat('1.5abc')` returns 1.5 and passes isFinite; `Number('1.5abc')` is NaN and correctly rejects partial strings.
- Status guard (`order.status !== QUOTE_REQUESTED → notFound()`) is intentionally redundant with the dispatch page — defense-in-depth per DL-007.
```

---

### Step 3 — Convert dispatch page to exhaustive status router

**File:** `src/app/dashboard/lab/orders/[orderId]/page.tsx`

Currently (line 1–4): thin re-export of `lab-fulfillment/page`.

Replace with an async RSC status dispatcher. The app router layer is the composition point per ADR-001 and may import from multiple slices. The `switch` is exhaustive — `default: notFound()` so a new lab-facing status never silently falls into the wrong slice.

```tsx
import { notFound, redirect } from 'next/navigation'
import { OrderStatus } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { auth } from '@/lib/auth'
import QuoteProvidePage from '@/features/orders/quote-provide/page'
import LabFulfillmentPage from '@/features/orders/lab-fulfillment/page'

export default async function LabOrderDispatchPage({
  params,
}: {
  params: { orderId: string }
}) {
  const session = await auth()
  if (!session || !session.user.id || session.user.role !== 'LAB_ADMIN') {
    redirect('/auth/signin')
  }

  const order = await prisma.order.findUnique({
    where: { id: params.orderId },
    select: { status: true },
  })

  if (!order) notFound()

  switch (order.status) {
    case OrderStatus.QUOTE_REQUESTED:
      return <QuoteProvidePage params={params} />
    case OrderStatus.ACKNOWLEDGED:
    case OrderStatus.IN_PROGRESS:
      return <LabFulfillmentPage params={params} />
    default:
      notFound()
  }
}
```

**Key invariants:**
- Minimal `select: { status: true }` — ownership is re-checked inside each slice page.
- `default: notFound()` makes the dispatch exhaustive — new statuses (T-08 onwards) produce a 404 rather than silently routing to the wrong slice. The implementer adding a new lab-facing status is forced to update this switch.
- Each slice page's own status and ownership guards remain intact (defense-in-depth).

---

### Step 4 — Patch the lab dashboard query

**File:** `src/features/labs/dashboard/page.tsx`, lines 53–60

Add `OrderStatus.QUOTE_REQUESTED` and `OrderStatus.QUOTE_REJECTED` to the `status: { in: [...] }` filter:

```ts
status: {
  in: [
    OrderStatus.QUOTE_REQUESTED,   // ← add: new Quoting tab
    OrderStatus.QUOTE_REJECTED,    // ← add: show in History so lab admins can see rejected outcomes
    OrderStatus.ACKNOWLEDGED,
    OrderStatus.IN_PROGRESS,
    OrderStatus.COMPLETED,
    OrderStatus.CANCELLED,
  ],
},
```

No DTO change required — `quotedPrice` is intentionally absent from `LabDashboardOrderDTO`.

---

### Step 5 — Add "Quoting" tab to the lab dashboard UI

**File:** `src/features/labs/dashboard/ui.tsx`

Four changes:

1. **Tab type** (line 17): `type Tab = 'Quoting' | 'Incoming' | 'Active' | 'History'`

2. **Partitions** (after line 74): add `quoting` before `incoming`:
   ```ts
   const quoting = orders.filter((o) => o.status === 'QUOTE_REQUESTED')
   const incoming = orders.filter((o) => o.status === 'ACKNOWLEDGED')  // unchanged
   ```
   Add `QUOTE_REJECTED` to History:
   ```ts
   const history = orders
     .filter((o) =>
       o.status === 'COMPLETED' ||
       o.status === 'CANCELLED'  ||
       o.status === 'QUOTE_REJECTED'   // ← add
     )
     .toReversed()
   ```

3. **`tabs` array** (lines 83–87): prepend Quoting:
   ```ts
   const tabs: { label: Tab; count: number }[] = [
     { label: 'Quoting',  count: quoting.length },
     { label: 'Incoming', count: incoming.length },
     { label: 'Active',   count: active.length },
     { label: 'History',  count: history.length },
   ]
   ```

4. **`currentOrders` expression** (lines 89–90):
   ```ts
   const currentOrders =
     activeTab === 'Quoting'  ? quoting  :
     activeTab === 'Incoming' ? incoming :
     activeTab === 'Active'   ? active   : history
   ```

Default tab stays `'Incoming'` — no change to `useState` initial value.

---

### Step 6 — Add `action.ts` to the `order-detail` slice

New file: `src/features/orders/order-detail/action.ts`

```
'use server'
```

`acceptQuote(_prevState, formData)`:
- Extract `orderId` from formData.
- Auth: `session.user.role === 'CLIENT'`.
- `$transaction`:
  1. `tx.order.findUnique({ where: { id: orderId } })` — `clientId` is on Order directly, no include needed (confirmed: `order-detail/page.tsx:190`, `checkout/action.ts:55`).
  2. Ownership: `if (!order || order.clientId !== session.user.id) return { message: 'Order not found.' }`
  3. `isValidStatusTransition(order.status, OrderStatus.PAYMENT_PENDING)` → return error if false.
  4. `tx.order.update({ data: { status: OrderStatus.PAYMENT_PENDING } })` — single update via the direct edge added in Step 1.
  5. Return `null`.
- `` redirect(`/checkout/${orderId}`) `` — outside try/catch, same pattern as `lab-fulfillment/action.ts:122`.

`rejectQuote(_prevState, formData)`:
- Extract `orderId`.
- Auth: `CLIENT`.
- `$transaction`: `if (!order || order.clientId !== session.user.id) return { message: 'Order not found.' }` + `isValidStatusTransition(order.status, QUOTE_REJECTED)` + update to QUOTE_REJECTED.
- `` revalidatePath(`/dashboard/orders/${orderId}`) `` — page refreshes and shows QUOTE_REJECTED badge and explanatory copy; no redirect.

---

### Step 7 — Add `ui.tsx` to the `order-detail` slice

New file: `src/features/orders/order-detail/ui.tsx`

`'use client'`

`OrderDetailQuoteActions({ orderId, quotedPrice }: { orderId: string; quotedPrice: string })`:
- Two `useActionState` hooks: `acceptQuote` and `rejectQuote`.
- Card: "You have a quote of ₱{quotedPrice}. Accept to proceed to payment, or reject to decline."
- Accept form: hidden `orderId`, "Accept Quote" button (primary).
- Reject form: hidden `orderId`, "Reject Quote" button (outline/destructive).
- Inline error display from either action state.

---

### Step 8 — Patch `order-detail/page.tsx`

**File:** `src/features/orders/order-detail/page.tsx`

Two changes:

1. Add import at top: `import { OrderDetailQuoteActions } from './ui'`

2. After the Status Timeline card (line 365), before the closing `</div></div>`, add:
   ```tsx
   {dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null && (
     <OrderDetailQuoteActions orderId={dto.id} quotedPrice={dto.quotedPrice} />
   )}
   ```

3. After the Status Timeline card, add QUOTE_REJECTED explanatory copy:
   ```tsx
   {dto.status === 'QUOTE_REJECTED' && (
     <Card className="mt-4">
       <CardContent className="pt-6">
         <p className="text-sm text-gray-600">
           This quote was rejected. To proceed, contact the lab directly or create a new order.
           Re-requesting a quote from this order will be available in a future update.
         </p>
       </CardContent>
     </Card>
   )}
   ```

The `dto.quotedPrice != null` guard is deploy-safety — a `QUOTE_PROVIDED` order should always have `quotedPrice` set, but this prevents a crash during the migration window between a DB write and a Prisma client regeneration.

---

### Step 9 — Update CLAUDE.md files

**`src/features/orders/order-detail/CLAUDE.md`** — replace the "No ui.tsx" sentence and add to Invariants:

Files table additions:
```markdown
| `ui.tsx`    | `'use client'` — `OrderDetailQuoteActions`: Accept/Reject forms with `useActionState`, rendered only when status === `QUOTE_PROVIDED` | Modifying quote action panel layout or error display |
| `action.ts` | `acceptQuote` (QUOTE_PROVIDED→PAYMENT_PENDING direct transition, redirect to checkout), `rejectQuote` (→QUOTE_REJECTED, revalidatePath) | Modifying accept/reject transitions |
```

New invariants:
- `acceptQuote` writes a single `PAYMENT_PENDING` update via the direct `QUOTE_PROVIDED→PAYMENT_PENDING` edge added to the state machine in T-07. It does NOT pass through `PENDING` — that is a FIXED-mode path.
- `rejectQuote` is terminal for T-07. The `QUOTE_REJECTED→QUOTE_REQUESTED` re-request loop is T-09.
- Client quote actions are inline (not a separate slice) because `QUOTE_PROVIDED` renders the same order summary as all other statuses plus an action panel — a dispatcher would require duplicating the base rendering or an ADR-001-violating cross-slice import.
- `OrderDetailQuoteActions` is only rendered when `dto.status === 'QUOTE_PROVIDED' && dto.quotedPrice != null`. Both checks are intentional: the status check is the logic gate; the null check is deploy-safety.

**`src/features/labs/dashboard/CLAUDE.md`** — update the `page.tsx` row to note `QUOTE_REQUESTED` and `QUOTE_REJECTED` are now included in the query.

**`src/features/orders/quote-provide/CLAUDE.md`** — created in Step 2.

---

## Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| Dispatch page reads status; slice page re-reads — tiny TOCTOU window | Each slice page has its own ownership + status guards; any race surfaces as a correct error (notFound or "cannot transition") |
| New lab-facing status added in future ticket silently routes to wrong slice | `default: notFound()` in the switch — the implementer is forced to add a case, not rely on fall-through |
| Client double-submits Accept (race condition) | Second attempt finds order at PAYMENT_PENDING; `isValidStatusTransition(PAYMENT_PENDING, PAYMENT_PENDING)` is false → error state |
| Lab provides quote while order is already QUOTE_PROVIDED (double-submit) | `isValidStatusTransition(QUOTE_PROVIDED, QUOTE_PROVIDED)` is false; action returns error state |
| `checkout/action.ts` expects PAYMENT_PENDING; redirect fires before checkout fetch | `redirect()` is outside the `$transaction` call; Prisma commits synchronously before redirect executes |

---

## Verification Steps

1. `npx tsc --noEmit` — must be clean (state machine change adds a new edge; all `Record<OrderStatus, ...>` maps remain exhaustive since no new status is added).
2. `npm test -- --run` — all tests must pass.
3. Manual happy path (QUOTE_REQUIRED service):
   - Client creates order → status QUOTE_REQUESTED.
   - Lab dashboard: order appears in "Quoting" tab.
   - Lab navigates to order → QuoteProvidePage renders (not LabFulfillmentPage).
   - Lab enters price → order advances to QUOTE_PROVIDED.
   - Client navigates to order detail → quote action panel visible with quoted price.
   - Client clicks Accept → redirected to `/checkout/[orderId]`.
4. Manual reject path:
   - From QUOTE_PROVIDED, client clicks Reject → page reloads with QUOTE_REJECTED badge and explanatory copy; action panel is gone.
   - Rejected order appears in lab dashboard History tab.
5. Regression — FIXED order at ACKNOWLEDGED still loads LabFulfillmentPage.
6. Regression — unknown status at `/dashboard/lab/orders/[orderId]` returns 404 (exhaustive dispatch).
7. Price validation — entering `"1.5abc"` in the quote form returns an error; DB unmodified.
