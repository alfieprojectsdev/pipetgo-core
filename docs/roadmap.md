# PipetGo V2 — Feature Roadmap

Tickets are ordered by dependency. Each ticket maps to one plan file and one PR.
Status: `done` | `ready` (unblocked) | `blocked` (dependency not done)
Workflow: `[planner]` = requires explore → plan → /clear → execute sequence before implementation.
         No tag = implement directly (pattern is clear, single slice, no financial risk).

## Dependency tree

```
T-01 Auth providers                        [ready] [planner]
├── T-02 Lab onboarding                    [blocked: T-01]
│   └── T-03 Lab service management        [blocked: T-02]
│       └── T-04 Service marketplace       [blocked: T-03]
│           └── T-05 ClientProfile on      [blocked: T-04] [planner]
│                    create-order
└── T-06 Order detail page (client)        [blocked: T-01]
    ├── T-07 Quote flow                    [blocked: T-06, T-03] [planner]
    └── T-08 Payment failure retry         [blocked: T-06] [planner]

T-09 Payout creation on completion         [ready — lab-fulfillment done] [planner]
└── T-10 Payout disbursement webhook       [blocked: T-09] [planner]
    └── T-11 Lab wallet dashboard          [blocked: T-10]

T-12 Attachment uploads                    [blocked: T-06, storage decision] [planner]
T-13 Admin panel                           [blocked: T-01, post-MVP] [planner]

T-14 Payment provider normalization        [ready — refactor, no feature deps] [planner]

── Phase 2 infrastructure ──────────────────────────────────────────────────
T-15 Lab KYC document upload              [blocked: T-02] [planner]
T-16 Idempotency key table                [ready — schema migration] [planner]
T-17 PESONet virtual account integration  [blocked: T-14, payment research] [planner]

── Phase 3 regulatory ──────────────────────────────────────────────────────
T-18 Lab accreditation verification       [blocked: T-02, T-13] [planner]
    (ISO 17025 / ITA solidary liability)
T-19 Dispute and redress mechanism        [blocked: T-06, schema migration] [planner]
    (ITA 2023 internal redress requirement)
T-20 RA 10173 privacy compliance          [blocked: T-05] [planner]
```

---

## Tickets

### T-01 — Auth providers `[planner]`
**Branch:** `feat/T01-auth-providers`
**Status:** ready
**Why planner:** NextAuth v5 beta callback shape, JWT session augmentation for `role` field, role-based redirect logic, and provider credential env vars all have non-obvious decisions. Plan must document session type extension and role-routing invariants before any implementation sub-agent touches `src/lib/auth.ts`.

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

### T-05 — ClientProfile collection on create-order `[planner]`
**Branch:** `feat/T05-client-profile`
**Status:** blocked by T-04
**Why planner:** Modifies existing production action. Decisions needed: transaction boundary (ClientProfile inside same `$transaction` as Order), domain schema import discipline (`clientDetailsSchema` must be the sole validator), and whether to rewrite or surgically patch the existing action and UI without breaking the FIXED-mode happy path.

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

### T-07 — Quote flow `[planner]`
**Branch:** `feat/T07-quote-flow`
**Status:** blocked by T-06, T-03
**Why planner:** Two sub-slices (lab-side provide, client-side respond), three state transitions (`QUOTE_REQUESTED→QUOTE_PROVIDED`, `QUOTE_PROVIDED→PENDING`, `QUOTE_PROVIDED→QUOTE_REJECTED`), TOCTOU guards on each, and the accept path must hand off to the existing checkout slice without coupling. Multiple non-obvious decisions about where to surface the quote UI on the order detail page.

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

### T-08 — Payment failure retry `[planner]`
**Branch:** `feat/T08-payment-retry`
**Status:** blocked by T-06
**Why planner:** Touches the existing webhook handler (adding failure path alongside the capture path), creates a new Transaction on retry (not updating the failed one — the two-ID scheme must be preserved), and the retry CTA on the order detail page must be gated on `PAYMENT_FAILED` status without introducing client-component sprawl.

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

### T-09 — Payout creation on order completion `[planner]`
**Branch:** `feat/T09-payout-creation`
**Status:** ready (lab-fulfillment done)
**Why planner:** Modifies the existing production `completeOrder` action. Fee arithmetic must use `Decimal` throughout (no float intermediate). The plan must decide where the platform fee constant lives (domain kernel vs env config), whether the Payout write belongs inside the existing `$transaction` or as a follow-on, and ensure `LabWallet.pendingBalance` is not double-credited.

**Prerequisite decision (resolve before planning):** Choose the money routing model:
- **Aggregator model** (current architecture): client pays PipetGo → PipetGo disburses to lab net of platform fee. PipetGo is the merchant of record; BIR withholding agent obligations apply.
- **Direct payment model**: client pays lab directly through the gateway; PipetGo invoices the lab separately for its commission. Avoids withholding agent complexity but requires separate commission collection infrastructure.

The choice materially changes what T-09 and T-10 implement. Resolve with legal counsel before writing the plan.

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

### T-10 — Payout disbursement webhook `[planner]`
**Branch:** `feat/T10-payout-disbursement`
**Status:** blocked by T-09
**Why planner:** New webhook slice with financial atomicity requirements (`availableBalance += netAmount`, `pendingBalance -= netAmount` in one `$transaction`), idempotency guard pattern, and the balance-never-negative invariant. Also the first use of the payout provider's webhook auth mechanism — decisions about HMAC vs token must be documented and consistent with T-14's normalization pattern.

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

### T-12 — Attachment uploads `[planner]`
**Branch:** `feat/T12-attachments`
**Status:** blocked by T-06, requires storage decision (S3 / Supabase Storage / Cloudflare R2)
**Why planner:** Storage provider integration, signed URL pattern vs direct upload, file type/size validation at the action boundary, and two distinct upload actors (client uploads specs, lab uploads results) with different permission guards. Storage provider must be decided and documented before the plan can be written.

Client uploads specification documents at order creation; lab uploads result
documents at order completion. Uses the `Attachment` model.

**Note:** Requires a file storage provider decision before planning. Open a
separate spike ticket to evaluate options.

---

### T-13 — Admin panel `[planner]`
**Branch:** `feat/T13-admin`
**Status:** post-MVP, blocked by T-01
**Why planner:** Scope is deliberately undefined at this stage — plan must define the surface area (which operations, which pages) before implementation. Touches role-gating across multiple existing slices and will likely require new middleware or layout-level auth guards.

Lab verification (`isVerified`), user role management, order oversight.
`UserRole.ADMIN` exists in schema; no admin slices exist.

---

### T-14 — Payment provider normalization `[planner]`
**Branch:** `feat/T14-payment-provider-normalization`
**Status:** ready (refactor, no feature dependencies)
**Why planner:** Cross-cutting refactor across `src/lib/payments/`, `src/features/payments/webhooks/`, and `src/domain/payments/`. The plan must define the exact shape of `NormalizedWebhookPayload`, the location of the normalizer function, and confirm that existing webhook tests pass without modification after the type boundary moves.

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

### T-15 — Lab KYC document upload `[planner]`
**Branch:** `feat/T15-lab-kyc-upload`
**Status:** blocked by T-02
**Why planner:** Integrates with the payment gateway's KYC API (Xendit business verification or equivalent) to submit lab business documents (BIR 2303, DTI/SEC registration). Two surfaces: (1) upload UI for the LAB_ADMIN during onboarding, (2) status polling/webhook from the gateway confirming KYC approval. Gateway KYC API shape and error vocabulary must be documented in the plan before implementation.

Labs must submit business registration documents to the payment gateway before they
can receive payouts. `AttachmentType.ACCREDITATION_CERTIFICATE` already in schema
for file storage; this ticket adds the gateway KYC submission layer.

**Files:** `src/features/labs/kyc/` (new slice), `src/lib/payments/xendit.ts` (add KYC API calls)

**Acceptance criteria:**
- LAB_ADMIN can upload BIR 2303 and DTI/SEC docs from their dashboard
- Documents are submitted to the payment gateway KYC endpoint
- Gateway KYC status (`pending` / `approved` / `rejected`) is reflected on the lab dashboard
- Labs with unapproved KYC cannot receive payouts (gate in T-10)

---

### T-16 — Idempotency key table `[planner]`
**Branch:** `feat/T16-idempotency-keys`
**Status:** ready (schema migration, no feature dependencies)
**Why planner:** Schema migration adds `IdempotencyKey` model; existing webhook handlers must be updated to use it without breaking the current CAPTURED-status guard. Plan must define key composition (provider + externalId + event type), TTL strategy, and whether the table replaces or supplements the existing status-based guard.

Current idempotency relies on `Transaction.status === CAPTURED` inside `$transaction`,
which is sufficient for the payment capture webhook but not for payout disbursement
callbacks, PESONet callbacks, or future provider webhooks. A formal `IdempotencyKey`
table provides a general deduplication layer across all async webhook types.

**Schema addition:**
```prisma
model IdempotencyKey {
  id          String   @id @default(cuid())
  key         String   @unique  // e.g. "xendit:invoice:PAID:{externalId}"
  processedAt DateTime @default(now())
  @@map("idempotency_keys")
}
```

**Files:** `prisma/schema.prisma`, `src/features/payments/webhooks/handlers.ts` (add key check), `src/features/payments/payouts/` (use key in T-10 handler)

**Acceptance criteria:**
- Duplicate webhook delivery for any event type returns 200 without re-processing
- `IdempotencyKey` check is inside the same `$transaction` as the business logic write
- Existing payment capture tests continue to pass

---

### T-17 — PESONet virtual account integration `[planner]`
**Branch:** `feat/T17-pesonet-virtual-account`
**Status:** blocked by T-14 (normalization), pending payment processor research
**Why planner:** New payment provider integration. PESONet virtual account creation, payment notification webhook (different auth mechanism from Xendit invoice webhook), and amount reconciliation against Order. Must follow T-14's `NormalizedWebhookPayload` pattern so the existing capture handler requires no changes.

B2B lab contracts frequently exceed InstaPay's ₱50,000 per-transaction ceiling.
PESONet has no per-transaction limit, making it a prerequisite for enterprise clients.
Requires virtual account creation per order and a separate webhook endpoint.

**Files:** `src/lib/payments/pesonet.ts` (new provider client), `src/features/payments/webhooks/pesonet/route.ts` (new webhook route), `src/app/api/webhooks/pesonet/route.ts`

**Acceptance criteria:**
- CLIENT can select PESONet as payment method for orders above ₱50,000
- Virtual account number is generated per order and shown on the order detail page
- Payment confirmation webhook updates Transaction and Order atomically using the same `processPaymentCapture` handler as Xendit (via normalized payload)
- No changes to `handlers.ts` required

---

### T-18 — Lab accreditation verification `[planner]`
**Branch:** `feat/T18-lab-verification`
**Status:** blocked by T-02 (labs exist), T-13 (admin panel exists)
**Why planner:** Under the Internet Transactions Act (ITA) of 2023, PipetGo has solidary liability for unsafe or unaccredited services listed on the platform. `Lab.isVerified` and `AttachmentType.ACCREDITATION_CERTIFICATE` already exist in schema; this ticket enforces them. Plan must define the verification workflow, what the admin reviews, and where `isVerified` gates are enforced in the marketplace and order creation flow.

Labs must hold a DTI-PAB ISO 17025 accreditation certificate. Platform must verify
this before a lab's services appear in the marketplace. `Lab.isVerified = false`
by default; only ADMIN can set it to `true` after reviewing submitted documents.

**Files:** `src/features/labs/verification/` (admin review slice), marketplace filter (gate on `isVerified`), create-order guard (prevent orders on unverified labs)

**Acceptance criteria:**
- Services from unverified labs are hidden from the marketplace
- LAB_ADMIN can submit ISO 17025 certificate via the platform (stored as `AttachmentType.ACCREDITATION_CERTIFICATE`)
- ADMIN can approve or reject, setting `Lab.isVerified`
- Clients cannot create orders against unverified labs (server-side guard, not just UI)
- Verification status is visible to the lab owner on their dashboard

---

### T-19 — Dispute and redress mechanism `[planner]`
**Branch:** `feat/T19-dispute-redress`
**Status:** blocked by T-06, T-07; requires schema migration
**Why planner:** The Internet Transactions Act (ITA) of 2023 requires an internal redress mechanism. This ticket adds a `DISPUTED` order status (schema migration), the state machine transitions into and out of it, a dispute initiation slice for the client, an admin resolution slice, and the fund-holding logic that prevents lab payout release while a dispute is open. Multiple actors, multiple transitions, financial hold semantics.

**Schema migration required:** add `DISPUTED` to `OrderStatus` enum.

**New transitions (state machine update required):**
- `COMPLETED → DISPUTED` (client initiates within dispute window)
- `DISPUTED → COMPLETED` (admin resolves in lab's favour — payout released)
- `DISPUTED → REFUND_PENDING` (admin resolves in client's favour)

**Files:** `prisma/schema.prisma` (new status), `src/domain/orders/state-machine.ts` (new transitions), `src/features/orders/dispute/` (client initiation slice), `src/features/orders/dispute-resolution/` (admin resolution slice), T-10 payout handler (gate: do not release payout if Order is DISPUTED)

**Acceptance criteria:**
- Client can dispute a COMPLETED order within a configurable window (e.g. 7 days)
- Disputing an order blocks payout release for that order
- ADMIN can resolve the dispute in either direction
- All transitions call `isValidStatusTransition()` before writing `Order.status`
- ITA-compliant response time SLA is documented (even if not yet enforced in code)

---

### T-20 — RA 10173 privacy compliance `[planner]`
**Branch:** `feat/T20-privacy-compliance`
**Status:** blocked by T-05 (ClientProfile collection)
**Why planner:** Republic Act 10173 (Data Privacy Act) requires explicit informed consent at the point of personal data collection, a stated purpose, and data subject rights. Chemical and clinical test data is sensitive personal information under NPC guidelines. Plan must identify all collection points, define the consent notice text (legal review required), and specify data retention and deletion handling.

**Scope:**
- **Consent notice** at ClientProfile collection (create-order form) — explicit checkbox, purpose statement
- **Privacy notice page** at `/privacy` linked from all data collection forms
- **Sensitive data flag** on orders involving `CHEMICAL_TESTING` or `BIOLOGICAL_TESTING` categories — API routes serving these results must confirm NPC-compliant encryption in transit (HTTPS already enforced by Neon + Vercel; document this)
- **Data subject rights** — email-based deletion request flow (can be manual process initially, documented in admin runbook)

**Files:** `src/features/orders/create-order/ui.tsx` (consent checkbox), `src/app/privacy/page.tsx` (privacy notice), `src/lib/auth.ts` (privacy notice acceptance flag on session if required)

**Acceptance criteria:**
- ClientProfile collection form includes a consent checkbox that is required before submission
- Consent checkbox links to the privacy notice page
- Privacy notice correctly identifies data controller, purpose, and NPC contact
- Orders involving chemical or clinical test categories are flagged in the DB for retention policy enforcement

---

## Phase 4 — Future / Post-Scale

These items are identified from the four-phase regulatory/business document but are
too distant to specify as tickets. Revisit when T-09–T-20 are complete.

| Item | Description |
|------|-------------|
| LIMS integration | Connect to lab LIMS (Scispot, QT9) for ISO 17025 traceability. Quotation-first project data flows directly into lab testing workflows. |
| ERP integration | SAP / NetSuite connectors for corporate clients to generate POs from PipetGo. Reduces maverick spending, enables enterprise adoption. |
| Supply chain financing | Early payouts to labs at a fee, funded by PipetGo using mature transaction data as credit signal. Requires BSP regulatory assessment. |

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
