# PipetGo V2 — Feature Roadmap

Tickets are ordered by dependency. Each ticket maps to one plan file and one PR.
Status: `done` | `ready` (unblocked) | `blocked` (dependency not done)

## Dependency tree

```
T-01 Auth providers                        [ready]
├── T-02 Lab onboarding                    [blocked: T-01]
│   └── T-03 Lab service management        [blocked: T-02]
│       └── T-04 Service marketplace       [blocked: T-03]
│           └── T-05 ClientProfile on      [blocked: T-04]
│                    create-order
└── T-06 Order detail page (client)        [blocked: T-01]
    ├── T-07 Quote flow                    [blocked: T-06, T-03]
    └── T-08 Payment failure retry         [blocked: T-06]

T-09 Payout creation on completion         [ready — lab-fulfillment done]
└── T-10 Payout disbursement webhook       [blocked: T-09]
    └── T-11 Lab wallet dashboard          [blocked: T-10]

T-12 Attachment uploads                    [blocked: T-06, storage decision]
T-13 Admin panel                           [blocked: T-01, post-MVP]

T-14 Payment provider normalization        [ready — refactor, no feature deps]
```

---

## Tickets

### T-01 — Auth providers
**Branch:** `feat/T01-auth-providers`
**Status:** ready

Set up a real OAuth provider (Google recommended) in `src/lib/auth.ts`.
Currently `providers: []` — no user can log in. Without this, nothing works
end-to-end.

**Files:** `src/lib/auth.ts`, `src/app/api/auth/[...nextauth]/route.ts`
(create if absent), `.env` additions (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

**Acceptance criteria:**
- A CLIENT user can sign in with Google and land on `/dashboard/client`
- A LAB_ADMIN user can sign in with Google and land on `/dashboard/lab`
- Unauthenticated users are redirected to the sign-in page

---

### T-02 — Lab onboarding
**Branch:** `feat/T02-lab-onboarding`
**Status:** blocked by T-01

Server Action that creates a `Lab` record for a `LAB_ADMIN` user. Includes
a form (name, description, location) and sets `User.role = LAB_ADMIN` if not
already set (or is a separate admin-triggered role grant).

**Files:** `src/features/labs/onboarding/`

**Acceptance criteria:**
- A signed-in user can register a lab and is redirected to the lab dashboard
- Duplicate lab registration for the same user is prevented

---

### T-03 — Lab service management
**Branch:** `feat/T03-lab-service-management`
**Status:** blocked by T-02

CRUD for `LabService`. Lab owner can create, edit, and deactivate services
(name, category, pricingMode, pricePerUnit, unit, description).

**Files:** `src/features/labs/service-management/`

**Acceptance criteria:**
- LAB_ADMIN can create a FIXED-priced service and a QUOTE_REQUIRED service
- Deactivated services are not shown in the marketplace
- `isActive` toggle works

---

### T-04 — Service marketplace / browse
**Branch:** `feat/T04-service-marketplace`
**Status:** blocked by T-03

Public listing of labs and active services. Filter by `ServiceCategory`.
Entry point for client order creation — links to `/orders/new?serviceId=...`.

**Files:** `src/features/services/browse/`, `src/app/services/page.tsx`

**Acceptance criteria:**
- Unauthenticated users can browse services
- Category filter works
- Each service card links to create-order with serviceId prefilled

---

### T-05 — ClientProfile collection on create-order
**Branch:** `feat/T05-client-profile`
**Status:** blocked by T-04

Enhancement to the existing `create-order` slice. The current Server Action
creates an `Order` but does not write `ClientProfile`. Add contact fields
(name, email, phone, organization, address) to the form, validate through
`clientDetailsSchema` (domain kernel), and persist to `ClientProfile` inside
the same `$transaction` as the `Order` creation.

**Files:** `src/features/orders/create-order/` (modify existing)

**Acceptance criteria:**
- Submitting create-order writes both `Order` and `ClientProfile` atomically
- `clientDetailsSchema` from `src/domain/orders/client-details.ts` is the
  sole validator — no inline Zod schema in the slice action

---

### T-06 — Order detail page (client-facing)
**Branch:** `feat/T06-order-detail`
**Status:** blocked by T-01

`/dashboard/orders/[orderId]` — shows Order status, service name, lab name,
amount, `ClientProfile` contact snapshot, and a status timeline. Client
dashboard already links here (`href` only, no page exists yet).

**Files:** `src/features/orders/order-detail/`, `src/app/dashboard/orders/[orderId]/page.tsx`

**Acceptance criteria:**
- CLIENT can view their own order; any other orderId returns 404
- Status is rendered with the same badge map as the client dashboard
- Page is an RSC with no client components unless interactivity is needed

---

### T-07 — Quote flow
**Branch:** `feat/T07-quote-flow`
**Status:** blocked by T-06, T-03

Lab-side: LAB_ADMIN sets `quotedPrice` on a `QUOTE_REQUESTED` order
(→ `QUOTE_PROVIDED`). Client-side: accept (→ `PENDING` → checkout) or reject
(→ `QUOTE_REJECTED`). Applies to `QUOTE_REQUIRED` and `HYBRID` services.

**Files:** `src/features/orders/quote-provide/`, `src/features/orders/quote-respond/`

**Acceptance criteria:**
- All transitions call `isValidStatusTransition()` before writing `Order.status`
- Lab cannot provide a quote on an order not belonging to their lab
- Client cannot accept/reject a quote not belonging to their order
- Accepted quote routes to the existing checkout slice

---

### T-08 — Payment failure retry
**Branch:** `feat/T08-payment-retry`
**Status:** blocked by T-06

Xendit delivers a failure webhook → `Transaction.status = FAILED`,
`Order.status = PAYMENT_FAILED`. Client sees retry CTA on order detail page;
action creates a new Xendit invoice and transitions back to `PAYMENT_PENDING`.

**Files:** `src/features/payments/webhooks/` (add failure handler),
`src/features/orders/order-detail/` (add retry CTA)

**Acceptance criteria:**
- `PAYMENT_FAILED` webhook updates Transaction and Order atomically
- Retry creates a new Transaction (not updates the failed one)
- Only the order owner can trigger retry

---

### T-09 — Payout creation on order completion
**Branch:** `feat/T09-payout-creation`
**Status:** ready (lab-fulfillment done)

When `completeOrder` action fires (`IN_PROGRESS → COMPLETED`), create a
`Payout` record (`QUEUED`) with `grossAmount = Transaction.amount`,
`platformFee = grossAmount * feePercentage`, `netAmount = gross - fee`.
Platform fee percentage is a config constant for now.

**Files:** `src/features/orders/lab-fulfillment/` (modify `completeOrder`),
`src/domain/payments/` (add fee constant or pricing fn)

**Acceptance criteria:**
- `Payout` row created inside the same `$transaction` as the Order update
- `LabWallet.pendingBalance` unchanged (already credited at capture)
- Fee arithmetic uses `Decimal`, not float

---

### T-10 — Payout disbursement webhook
**Branch:** `feat/T10-payout-disbursement`
**Status:** blocked by T-09

External payout provider (Xendit disbursement) webhook marks `Payout.status =
COMPLETED`. Handler increments `LabWallet.availableBalance` by `Payout.netAmount`
and decrements `pendingBalance` by the same amount atomically.

**Files:** `src/features/payments/payouts/` (new slice)

**Acceptance criteria:**
- `availableBalance += netAmount`, `pendingBalance -= netAmount` in one `$transaction`
- Idempotency guard on `Payout.status === COMPLETED`
- `LabWallet` balances never go negative (throw if they would)

---

### T-11 — Lab wallet dashboard
**Branch:** `feat/T11-lab-wallet`
**Status:** blocked by T-10

`/dashboard/lab/wallet` — shows `pendingBalance`, `availableBalance`,
`withdrawnTotal`, and a paginated `Payout` history table with status badges.

**Files:** `src/features/labs/wallet/`, `src/app/dashboard/lab/wallet/page.tsx`

**Acceptance criteria:**
- Balances match `LabWallet` values to 2 decimal places
- Payout history is ordered newest-first
- Only the lab owner can view their wallet

---

### T-12 — Attachment uploads
**Branch:** `feat/T12-attachments`
**Status:** blocked by T-06, requires storage decision (S3 / Supabase Storage / Cloudflare R2)

Client uploads specification documents at order creation; lab uploads result
documents at order completion. Uses the `Attachment` model.

**Note:** Requires a file storage provider decision before planning. Open a
separate spike ticket to evaluate options.

---

### T-13 — Admin panel
**Branch:** `feat/T13-admin`
**Status:** post-MVP, blocked by T-01

Lab verification (`isVerified`), user role management, order oversight.
`UserRole.ADMIN` exists in schema; no admin slices exist.

---

### T-14 — Payment provider normalization
**Branch:** `feat/T14-payment-provider-normalization`
**Status:** ready (refactor, no feature dependencies)

The current webhook handler (`processPaymentCapture`) accepts `XenditInvoicePayload`
directly — Xendit's raw payload shape leaks into the business logic layer. Adding a
second payment processor (HitPay, PayMongo, etc.) would require either duplicating the
handler or casting a foreign payload to Xendit's type.

**The fix:** introduce a provider-neutral internal type and move all provider-specific
mapping into each provider's route before it reaches the handler.

**Files to create:**
- `src/lib/payments/types.ts` — `NormalizedWebhookPayload` interface:
  ```ts
  export interface NormalizedWebhookPayload {
    externalId: string      // maps to Transaction.externalId for DB lookup
    status: 'paid' | 'failed' | 'other'
    paymentMethod?: string
  }
  ```

**Files to modify:**
- `src/features/payments/webhooks/types.ts` — keep `XenditInvoicePayload` for
  parsing the raw request body; add a `normalizeXenditPayload(payload: XenditInvoicePayload): NormalizedWebhookPayload` function
- `src/features/payments/webhooks/route.ts` — call `normalizeXenditPayload` after
  parsing; pass `NormalizedWebhookPayload` to `processPaymentCapture`
- `src/features/payments/webhooks/handlers.ts` — change signature to accept
  `NormalizedWebhookPayload` instead of `XenditInvoicePayload`; remove
  `XenditInvoicePayload` import
- `src/domain/payments/events.ts` — fix stale "PayMongo" references in JSDoc
  (project uses Xendit; these are copy-paste artifacts from original design)
- `src/domain/payments/CLAUDE.md` — same stale reference fix

**Acceptance criteria:**
- `processPaymentCapture` imports nothing from `XenditInvoicePayload` or any
  provider-specific type
- `src/features/payments/webhooks/route.ts` is the only file that references
  `XenditInvoicePayload` (mapping happens at the boundary)
- `npx tsc --noEmit` passes; existing webhook tests pass without modification
- Adding a second provider (`src/lib/payments/hitpay.ts` + new route) requires
  no changes to `handlers.ts` or `src/domain/`

**Note:** Do not introduce a `PaymentProvider` interface or factory pattern — that
abstraction is YAGNI until a second provider is actually being added. The normalized
type alone is sufficient to decouple the boundary.

---

## Done

| Ticket | Commit | Description |
|--------|--------|-------------|
| foundation | `cfbda99` | Domain kernel, Prisma schema, ESLint boundary rule |
| create-order | — | FIXED/HYBRID order creation (ClientProfile not yet collected — see T-05) |
| checkout | — | Xendit invoice creation |
| webhook | `fb7e1c1` | Payment capture, idempotency, LabWallet pendingBalance credit |
| lab-fulfillment | `9f0785e` | ACKNOWLEDGED→IN_PROGRESS→COMPLETED |
| lab-dashboard | `4ca736a` | LAB_ADMIN order listing |
| lab-wallet-credit | `5034def` | pendingBalance upsert in webhook handler |
| client-dashboard | `9219012` | CLIENT order listing |
| webhook-tests | `400d5ed` | Vitest integration tests for processPaymentCapture |
