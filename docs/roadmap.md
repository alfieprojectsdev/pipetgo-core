# PipetGo V2 — Feature Roadmap

Tickets are ordered by dependency. Each ticket maps to one plan file and one PR.
Status: `done` | `ready` (unblocked) | `blocked` (dependency not done)
Workflow: `[planner]` = requires explore → plan → /clear → execute sequence before implementation.
         No tag = implement directly (pattern is clear, single slice, no financial risk).

## Architecture Decisions

Resolved decisions that affect multiple tickets. Read before planning any payment slice.

### AD-002 — Payment processor strategy: multi-processor hybrid (pending one verification)

**Research conclusion (2026-05-06):** `docs/research/Payment-Processor-eval-PipetGo.md`

Eliminated outright: **Maya Business** (no HMAC, IP-whitelist-only webhooks, broken sandbox) and **DragonPay** (XML/SOAP legacy APIs, RSA key pairs, incompatible with modern TS stack).

**Recommended hybrid:**
- **Inbound capture (checkout + webhooks):** Migrate to PayMongo. Timestamp-bound HMAC-SHA256 is best-in-class; Checkout API is modern and sandbox is deterministic (specific card/OTP codes trigger exact failure states). PayMongo preferential card rate (3.125% + PHP 13.39) applies once BIR Form 2303 is registered.
- **Outbound disbursements:** Retain Xendit. Bank Account Name Validator API pre-validates lab bank routing before transfer, eliminating bounce fees and manual reconciliation overhead. No other provider offers an equivalent.
- **HitPay:** Strong cost-optimization fallback (QR Ph at 1.0%, cards ~3%). Viable alternative to PayMongo for inbound if PayMongo sub-merchant support is confirmed absent. Suitable candidate once T-14 normalization is in place.

**Blocking question before migrating inbound to PayMongo (verify before writing T-14 plan):**
The direct payment model (AD-001) uses Xendit Managed Sub-Accounts for automatic payment splitting to lab sub-accounts. PayMongo must support an equivalent sub-merchant or split-payment mechanism for this model to work with PayMongo on the inbound side. If PayMongo does not support this, inbound capture must stay on Xendit until switching to the aggregator model — at which point the PayMongo migration is straightforward.

**Consequence for T-14:** Scope expanded — the normalization layer must abstract both the webhook payload shape AND the auth mechanism (static token vs. HMAC-SHA256 + timestamp). Switching from Xendit to PayMongo on the inbound side must require only a new provider file + route, with no changes to handlers.ts or the domain layer.

**Xendit static token risk assessment:** Mitigated at current scale by TLS + `$transaction`-bounded idempotency guard. T-16 (idempotency key table) closes the remaining concurrent-delivery window. Acceptable until PayMongo sub-merchant compatibility is confirmed and migration is planned.

---

### AD-001 — Money routing model: Direct Payment (resolved 2026-05-06)

**Decision:** Direct Payment model for launch. Client pays lab directly via Xendit
Managed Sub-Accounts. Xendit automatically splits PipetGo's commission to PipetGo's
account at settlement. PipetGo is never the payor to the lab.

**Consequences for the codebase:**

| Location | Change required |
|---|---|
| `processPaymentCapture` (handlers.ts) | Remove `LabWallet.pendingBalance` credit — the lab already has the money via sub-account split. This is a known inconsistency with the current code; fix is scoped to T-09. |
| Checkout action (action.ts) | Switch from PipetGo's Xendit invoice to a sub-account invoice targeting the lab's Managed Sub-Account. Commission split percentage configured at invoice creation. |
| `Payout` model | Repurpose as commission settlement record (PipetGo's received commission per order), not a disbursement record (PipetGo paying the lab). |
| `LabWallet` model | Repurpose as PipetGo commission ledger (commissions received per lab), not a lab escrow ledger. `pendingBalance` = commission confirmed but not yet settled by Xendit; `availableBalance` = settled commission. |
| T-09 | Implements commission record creation on order completion, not payout disbursement. |
| T-10 | Handles Xendit split-settlement webhook confirming commission received, not a disbursement webhook. |

**What is explicitly deferred:**
- BIR 1% creditable withholding tax slice — only required when PipetGo becomes the
  payor (aggregator model). No engineering work until aggregator migration.
- BIR withholding agent registration — legal/admin prerequisite for aggregator switch.

**What is NOT deferred (legal, not a code ticket):**
- PipetGo's own VAT on commission income (12% if VAT-registered) — tracked via
  accounting export from transaction data from first commercial transaction.
- BIR Form 2303 registration for PipetGo as a business — legal prerequisite before
  first commercial revenue regardless of model.
- Official receipts for PipetGo commission invoices to labs — can be issued manually
  or via a lightweight PDF slice at early commercial stage.

**Migration path to aggregator at scale:**
When transaction volume justifies it, switching to aggregator requires: (1) updating
the checkout action to use PipetGo's main account instead of sub-accounts, (2)
restoring `processPaymentCapture` LabWallet credit as escrow, (3) implementing the
withholding deduction slice in T-09/T-10, and (4) BIR withholding agent registration.
The schema fields (`pendingBalance`, `grossAmount`, `platformFee`, `netAmount`)
survive the migration — only their business semantics change.

## Dependency tree

```
T-01 Auth providers                        [done] [planner]
├── T-02 Lab onboarding                    [done]
│   └── T-03 Lab service management        [done]
│       └── T-04 Service marketplace       [PR #5]
│           └── T-05 ClientProfile on      [blocked: T-04] [planner]
│                    create-order
└── T-06 Order detail page (client)        [done]
    ├── T-07 Quote flow                    [blocked: T-06, T-03, T-04.5] [planner]
    └── T-08 Payment failure retry         [blocked: T-06] [planner]

T-04.5 Tailwind CSS setup                  [done — CSS pipeline; T-07 UI blocker cleared]

T-09 Commission record on completion       [ready — lab-fulfillment done] [planner]
└── T-10 Commission settlement webhook     [blocked: T-09] [planner]
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

## Implementation timeline

Projected from **2026-05-08** (T-01/T-02 merged, T-03 in PR).

### Session budget assumptions (Claude Pro $20/month)

- Rate-limit window resets roughly every 5 hours; realistic pace is 2–3 focused implementation sessions per day before throttling.
- **Simple ticket (no `[planner]`):** 1 session — write plan file + implement + open PR.
- **`[planner]` ticket:** 2 sessions — session 1: explore + plan skill + write plan file; `/clear`; session 2: implement + open PR.
- **Complex `[planner]` ticket** (T-12, T-14, T-17, T-18, T-19): 3 sessions — heavier research or cross-cutting scope.
- Assumes ~3–4 working days/week on this project.

### Phase 1 — Core user flows (target: week of 2026-05-11)

Unblocked immediately or by T-03 merge. All directly implementable (no `[planner]`).

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-03 merge | — | — | ✅ done (PR #3) |
| T-04 Service marketplace | T-03 ✅ | 1 | ✅ PR #5 open |
| T-06 Order detail page (client) | T-01 ✅ | 1 | ✅ done (PR #4) |
| T-04.5 Tailwind CSS setup | ready now | 1 | postcss + tailwind.config + globals.css; required before T-07 |
| T-16 Idempotency key table | ready now | 1 | Schema migration + handler patch |

**End state:** Lab-side and client-side read flows exist. T-07's blockers (T-03, T-06, T-04.5) all cleared.

### Phase 2 — Transactional flows (target: 2026-05-18 → 2026-05-25)

All `[planner]` tagged; each requires a plan session, `/clear`, then implementation session.

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-05 ClientProfile on create-order | T-04 | 2 | Modifies existing production action |
| T-07 Quote flow | T-06 + T-03 | 2 | Two sub-slices, three state transitions |
| T-08 Payment failure retry | T-06 | 2 | Webhook failure path + retry CTA |
| T-09 Commission record | ready now | 2 | AD-001 direct payment model |
| T-15 Lab KYC upload | T-02 ✅ | 2 | Gateway KYC API integration |

**End state:** Full order lifecycle functional (create → quote → pay → complete). Commission records written on completion.

### Phase 3 — Financial + infrastructure (target: 2026-05-25 → 2026-06-08)

Depends on Phase 2 completing. T-14 is the prerequisite for T-17.

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-10 Commission settlement webhook | T-09 | 2 | LabWallet balance move |
| T-11 Lab wallet dashboard | T-10 | 1 | No `[planner]` |
| T-14 Payment provider normalization | ready now | 3 | Complex refactor; AD-002 expanded scope |

**End state:** Financial flows closed. Xendit→PayMongo migration path ready (T-14 done).

### Phase 4 — Post-MVP / compliance (target: 2026-06-08 → 2026-07-06)

Lower urgency. T-13 (admin panel) gates T-18.

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-13 Admin panel | T-01 ✅ | 3 | Large scope; post-MVP |
| T-12 Attachment uploads | T-06 + storage decision | 3 | Storage provider must be selected first |
| T-17 PESONet virtual account | T-14 | 3 | New provider; payment research gate |
| T-18 Lab accreditation verification | T-02 ✅ + T-13 | 2 | ITA 2023 compliance |
| T-19 Dispute and redress | T-06 + migration | 2 | ITA 2023 internal redress requirement |
| T-20 RA 10173 privacy compliance | T-05 | 2 | DPA consent + privacy notice |

**End state:** Full roadmap complete, including regulatory compliance layer.

### Summary

| Phase | Target window | MVP gate |
|-------|---------------|----------|
| 1 — Core flows | week of 2026-05-11 | |
| 2 — Transactional | 2026-05-18 → 2026-05-25 | |
| 3 — Financial | 2026-05-25 → 2026-06-08 | ✅ **MVP** |
| 4 — Post-MVP | 2026-06-08 → 2026-07-06 | |

**MVP (phases 1–3): ~4–5 weeks from today (target 2026-06-08).**
The main wildcard is T-14 (payment normalization) — AD-002 expanded its scope to include auth abstraction, making it a 3-session architectural ticket. If T-14 slips, T-17 slips with it; all other tickets are on a predictable single-dependency cadence.

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
**Status:** done (PR #3)

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
**Status:** done (PR #5)

Public listing of labs and active services. Filter by `ServiceCategory`.
Entry point for client order creation — links to `/orders/new?serviceId=...`.

**Files:** `src/features/services/browse/`, `src/app/services/page.tsx`

**Acceptance criteria:**
- Unauthenticated users can browse services
- Category filter works
- Each service card links to create-order with serviceId prefilled

---

### T-04.5 — Tailwind CSS setup
**Branch:** `feat/T04.5-tailwind-setup`
**Status:** ready (no feature dependencies)

The project writes Tailwind class names throughout but has no CSS pipeline wired up.
`tailwindcss` is not in `package.json`; there is no `tailwind.config.js`,
`postcss.config.js`, or global CSS import in `layout.tsx`. All components render
unstyled HTML today. This is a three-step fix: install deps, create config, import
`globals.css` in the root layout.

**Why now:** T-07 (quote flow) is the first slice a real user sees end-to-end.
Implementing or demoing it without CSS produces an unusable UI and makes it
impossible to catch layout bugs (overflow, z-index, responsive breakpoints) that
are invisible when class names do nothing. Every UI-bearing ticket from T-07 onward
assumes styles render.

**Other tickets blocked on UI correctness (all require T-04.5 before demo/QA):**

| Ticket | UI concern |
|--------|-----------|
| T-07 Quote flow | Accept/reject quote form; inline on order detail page |
| T-08 Payment failure retry | Retry CTA visibility on order detail |
| T-11 Lab wallet dashboard | Financial balances must be legible |
| T-17 PESONet | Virtual account number display |
| T-19 Dispute / redress | Dispute initiation form (ITA compliance) |
| T-20 RA 10173 privacy | Consent checkbox must render and be usable |

**Files:**
- `package.json` — add `tailwindcss`, `postcss`, `autoprefixer` to `devDependencies`
- `tailwind.config.js` — content paths: `./src/**/*.{ts,tsx}`, `./src/app/**/*.{ts,tsx}`
- `postcss.config.js` — `{ plugins: { tailwindcss: {}, autoprefixer: {} } }`
- `src/styles/globals.css` — `@tailwind base; @tailwind components; @tailwind utilities;`
- `src/app/layout.tsx` — `import '@/styles/globals.css'`

**Acceptance criteria:**
- `npx tailwindcss --version` returns ^3.4.x
- Tailwind utility classes render correctly in the browser (e.g. `/services` page shows card grid with colour badges)
- `line-clamp-2` on service descriptions clamps correctly (core utility since Tailwind v3.3 — no plugin needed)
- No existing TSC errors introduced

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
**Status:** done (PR #4)

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
**Status:** blocked by T-06 ✅, T-03 ✅, T-04.5 ✅
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

### T-09 — Commission record on order completion `[planner]`
**Branch:** `feat/T09-commission-record`
**Status:** ready (lab-fulfillment done)
**Routing model:** Direct Payment (AD-001)
**Why planner:** Modifies the existing production `completeOrder` action and `processPaymentCapture`. Two changes in one ticket: (1) remove the `LabWallet.pendingBalance` credit in `processPaymentCapture` — that write is wrong under the direct model since the lab already received the money via Xendit sub-account split; (2) create a `Payout` commission record when `completeOrder` fires. Fee arithmetic must use `Decimal` throughout. Plan must confirm Xendit sub-account split percentage config and where the commission rate constant lives.

Under the direct payment model (AD-001), Xendit splits PipetGo's commission
automatically at settlement. When `completeOrder` fires (`IN_PROGRESS → COMPLETED`),
create a `Payout` record representing PipetGo's confirmed commission for that order.
`LabWallet.pendingBalance` tracks commission received by PipetGo per lab (not lab escrow).

**Files:** `src/features/payments/webhooks/handlers.ts` (remove LabWallet credit),
`src/features/orders/lab-fulfillment/` (modify `completeOrder` to write commission Payout),
`src/domain/payments/` (add commission rate constant)

**Acceptance criteria:**
- `processPaymentCapture` no longer writes to `LabWallet` (removed)
- `Payout` commission record created inside the same `$transaction` as the Order COMPLETED update
- `Payout.grossAmount` = `Transaction.amount`, `platformFee` = gross × commission rate, `netAmount` = gross − fee
- All fee arithmetic uses `Decimal`, no float intermediates
- Existing webhook integration tests updated to reflect removal of LabWallet credit

---

### T-10 — Commission settlement webhook `[planner]`
**Branch:** `feat/T10-commission-settlement`
**Status:** blocked by T-09
**Routing model:** Direct Payment (AD-001)
**Why planner:** New webhook slice from Xendit confirming commission split has settled into PipetGo's account. Financial atomicity required (`LabWallet.availableBalance += netAmount`, `pendingBalance -= netAmount`), idempotency guard, and balance-never-negative invariant. Must follow T-14's `NormalizedWebhookPayload` pattern and T-16's idempotency key table if that is implemented first.

Under the direct payment model, Xendit fires a settlement webhook when the commission
split completes. This handler marks `Payout.status = COMPLETED` and moves the amount
from `LabWallet.pendingBalance` to `availableBalance` in PipetGo's commission ledger.
`LabWallet` here tracks PipetGo's commission income per lab, not lab escrow (AD-001).

**Files:** `src/features/payments/payouts/` (new slice), `src/app/api/webhooks/xendit-settlement/route.ts`

**Acceptance criteria:**
- `Payout.status` updated to `COMPLETED` atomically with `LabWallet` balance move
- `availableBalance += netAmount`, `pendingBalance -= netAmount` in one `$transaction`
- Idempotency guard prevents double-credit on duplicate Xendit delivery
- `LabWallet` balances never go negative (throw if they would)
- Webhook auth uses HMAC or token per Xendit settlement webhook spec (document in plan)

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
**Why planner:** Cross-cutting refactor across `src/lib/payments/`, `src/features/payments/webhooks/`, and `src/domain/payments/`. The plan must define `NormalizedWebhookPayload`, the webhook auth abstraction interface, the location of per-provider verifier functions, and confirm that existing webhook tests pass without modification after the boundary moves.

**Scope (expanded per AD-002):** The normalization layer must abstract two things, not one:
1. **Payload shape** — `XenditInvoicePayload` must not leak into `handlers.ts`
2. **Webhook auth mechanism** — static token (Xendit) vs. HMAC-SHA256 + timestamp (PayMongo) must be swappable per provider without touching `handlers.ts`. Each provider's route owns its own auth verification.

The goal: migrating from Xendit to PayMongo on the inbound side requires only adding `src/lib/payments/paymongo.ts` + `src/features/payments/webhooks/paymongo/route.ts`. Zero changes to `handlers.ts` or `src/domain/`.

**Files to create:**
- `src/lib/payments/types.ts` — `NormalizedWebhookPayload` interface:
  ```ts
  export interface NormalizedWebhookPayload {
    externalId: string      // maps to Transaction.externalId for DB lookup
    status: 'paid' | 'failed' | 'other'
    paymentMethod?: string
  }
  ```
- `src/lib/payments/webhook-auth.ts` — per-provider verifier functions:
  ```ts
  export function verifyXenditToken(req: NextRequest, secret: string): boolean
  export function verifyPayMongoHmac(rawBody: string, header: string, secret: string): boolean
  export function verifyHitPayHmac(rawBody: string, header: string, salt: string): boolean
  ```

**Files to modify:**
- `src/features/payments/webhooks/types.ts` — keep `XenditInvoicePayload` for raw body parsing; add `normalizeXenditPayload()` returning `NormalizedWebhookPayload`
- `src/features/payments/webhooks/route.ts` — use `verifyXenditToken()` from `webhook-auth.ts`; call `normalizeXenditPayload`; pass normalized payload to `processPaymentCapture`
- `src/features/payments/webhooks/handlers.ts` — accept `NormalizedWebhookPayload`; remove `XenditInvoicePayload` import
- `src/domain/payments/events.ts` — fix stale "PayMongo" JSDoc references
- `src/domain/payments/CLAUDE.md` — same stale reference fix

**Acceptance criteria:**
- `processPaymentCapture` imports no provider-specific type
- `route.ts` is the only file referencing `XenditInvoicePayload`
- `verifyXenditToken`, `verifyPayMongoHmac`, `verifyHitPayHmac` all implemented in `webhook-auth.ts` (even if only Xendit route is wired — others are ready to use)
- `npx tsc --noEmit` passes; existing webhook integration tests pass unchanged
- Adding a PayMongo route requires only a new route file + `paymongo.ts` provider client; zero changes to `handlers.ts` or `src/domain/`

**Note:** Do not introduce a `PaymentProvider` interface or factory — YAGNI. The normalized type + per-provider verifier functions are sufficient.

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

| Ticket | PR / Commit | Description |
|--------|-------------|-------------|
| foundation | `cfbda99` | Domain kernel, Prisma schema, ESLint boundary rule |
| create-order | — | FIXED/HYBRID order creation (ClientProfile not yet collected — see T-05) |
| checkout | — | Xendit invoice creation |
| webhook | `fb7e1c1` | Payment capture, idempotency, LabWallet pendingBalance credit |
| lab-fulfillment | `9f0785e` | ACKNOWLEDGED→IN_PROGRESS→COMPLETED |
| lab-dashboard | `4ca736a` | LAB_ADMIN order listing |
| lab-wallet-credit | `5034def` | pendingBalance upsert in webhook handler |
| client-dashboard | `9219012` | CLIENT order listing |
| webhook-tests | `400d5ed` | Vitest integration tests for processPaymentCapture |
| T-01 Auth providers | PR #1 `57f5e63` | Google OAuth via NextAuth v5-beta; JWT strategy; role seeding |
| T-02 Lab onboarding | PR #2 `8531cfe` | Lab registration form; atomic Lab + LAB_ADMIN role promotion |
| T-03 Lab service management | PR #3 `504300c` | CRUD for LabService; FIXED/HYBRID price validation; isActive toggle |
| T-06 Order detail page | PR #4 `b5fef41` | Client order detail at /dashboard/orders/[orderId]; status timeline; PricingMode-aware |
| T-04 Service marketplace | PR #5 `d5e35ec` | Public /services browse; category filter; order CTA links to create-order |
| T-04.5 Tailwind CSS setup | PR #6 `2ffa22d` | tailwindcss ^3.4, postcss, autoprefixer; V2 green brand palette; .tailwindignore |
