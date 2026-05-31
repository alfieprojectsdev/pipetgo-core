# PipetGo V2 — Feature Roadmap

Tickets are ordered by dependency. Each ticket maps to one plan file and one PR.
Status: `done` | `ready` (unblocked) | `blocked` (dependency not done)
Workflow: `[planner]` = requires explore → plan → /clear → execute sequence before implementation.
         No tag = implement directly (pattern is clear, single slice, no financial risk).

---

## Executive Summary

*For CEO / CMO / CFO context. Engineering detail follows below.*

### Where we are (as of 2026-05-31)

PipetGo V2 has a working, end-to-end lab testing marketplace. A client can discover a lab, place an order, pay (card or bank transfer), and the platform splits the commission automatically. Labs can manage services, receive orders, issue quotes, and track their commission balance. The full payment infrastructure is built and tested.

**What's done:**
- Full order lifecycle: browse → quote → pay → fulfil → complete
- Two payment methods: card/e-wallet (Xendit invoice) and bank transfer (PESONet virtual account, no ₱50k ceiling)
- Automatic commission splitting via Xendit Managed Sub-Accounts — PipetGo receives its cut at settlement without manual reconciliation
- Lab wallet dashboard showing earned commissions (pending vs settled)
- RA 10173 (Data Privacy Act) consent capture — clients consent at order creation; privacy notice live at `/privacy`
- Webhook idempotency and payment retry handling — resilient to duplicate deliveries and failed payments
- PayMongo migration path ready (T-14 normalisation layer in place)
- **Admin KYC review panel (T-13, PR #17)** — an ADMIN can view a lab's submitted documents and approve/reject; `kycStatus` reaches APPROVED through the UI, not just a direct DB write. This closes the lab-approval path that gates first revenue.

**What's next (engineering — no longer blocks lab approval):**
- **T-18 Lab accreditation verification** — ISO 17025 / ITA solidary-liability gate (`Lab.isVerified`, distinct from KYC). Unblocked by T-13; recommended next.
- **T-12 Attachment uploads** — client spec documents and lab result PDFs. R2 provisioned; unblocked.
- **T-13b / T-13c** — spun out of T-13: T-13b is read-only admin order/transaction oversight (pull forward only on a real ops need); T-13c is admin role management, deferred until its own privilege-escalation audit.

**What must happen before first revenue (non-engineering):**
1. **BIR Form 2303** — business registration certificate; required before issuing official receipts
2. **NPC registration** as Personal Information Controller — RA 10173 requires this since T-20 merged; active legal obligation
3. **Privacy notice legal review** — stub is live at `/privacy`; a lawyer must review controller identity, retention periods, and data subject rights language before first paying customer
4. **Xendit KYB** — Xendit business account verification; required before live payment processing
5. **DTI/SEC registration** — prerequisite for BIR 2303

---

### Launch readiness by stakeholder

| Stakeholder | Status | Blocker |
|---|---|---|
| **CEO** | Platform is feature-complete for MVP. KYC gate is live (T-15) and the admin approval UI shipped (T-13, PR #17). Remaining blockers are legal, not engineering. | Legal prerequisites above (BIR 2303, NPC registration, Xendit KYB) |
| **CMO** | Client-facing flows are complete. Labs upload KYC documents and an admin can review and approve them in-app (T-13). | At least one lab completing KYC + admin review |
| **CFO** | Commission accounting is built: every order generates a `Payout` record with `grossAmount`, `platformFee`, `netAmount` using `Decimal` (no float errors). BIR compliance (Form 2303, OR issuance) is a legal track, not an engineering track. VAT threshold tracking must start from transaction #1. | BIR 2303 + NPC registration (both non-engineering) |

---

### Revenue model implemented

| Component | Status | Notes |
|---|---|---|
| Commission split | ✅ Live | Xendit Managed Sub-Accounts; automatic at settlement |
| Commission rate constant | ✅ Live | `COMMISSION_RATE` in `src/domain/payments/commission.ts` |
| Commission accounting | ✅ Live | `Payout` model; `LabWallet` tracks pending vs settled per lab |
| Withholding tax (1% CWT) | ⏳ Deferred | Only required when PipetGo becomes payor (aggregator model). Not needed at launch under Direct Payment model (AD-001) |
| VAT on PipetGo commission | ⚠️ Legal track | 12% if VAT-registered; tracked via accounting export from transaction data. Must track from transaction #1 |
| Official receipt issuance | ⚠️ Legal track | BIR Form 2303 → printed OR or ePOS OR for PipetGo commission invoices to labs |

---

### Key risks

| Risk | Severity | Mitigation |
|---|---|---|
| NPC registration not completed before first transaction | **High** — RA 10173 violation | Non-engineering; escalate immediately. T-20 is already live. |
| Labs onboard before KYC gate is enforced | **High** — lab can receive payments without verification | ✅ T-15 + T-13 merged — KYC gate live on both checkout paths; an admin reviews and approves/rejects in-app (T-13, PR #17). Labs default to PENDING and require admin approval to reach APPROVED. |
| Xendit KYB not approved before launch | **High** — live payment processing blocked | Start KYB submission in parallel with T-15 engineering |
| PayMongo sub-merchant support unconfirmed | **Medium** — affects payment processor migration | T-14 normalisation layer makes migration low-risk whenever confirmed |
| `Lab.isVerified` (ISO 17025) gate not yet enforced | **Medium** — ITA 2023 solidary liability | T-18 post-MVP; admin runbook required before first lab goes live |

---

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

**Xendit static token risk assessment:** Mitigated at current scale by TLS + `$transaction`-bounded idempotency guard + `IdempotencyKey` dedup table (T-16, PR #12). Acceptable until PayMongo sub-merchant compatibility is confirmed and migration is planned.

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

## Infrastructure & DevOps Provisioning

Checklist of everything that must be provisioned outside the codebase for the platform to function end-to-end. Mark items `[x]` as completed.

---

### Hosting & Deployment

- [ ] Vercel project created and linked to GitHub repo (`alfieprojectsdev/pipetgo-core`)
- [ ] Production branch set to `main` — auto-deploys on push
- [ ] Preview deployments enabled for feature branches
- [ ] Build command: `npx prisma generate && next build`
- [ ] Root directory: `.` (monorepo — no subdirectory needed)

### Domain & TLS

- [ ] Domain registered (e.g. `pipetgo.com`)
- [ ] DNS records pointed to Vercel (CNAME or A)
- [ ] Vercel custom domain configured + HTTPS verified
- [ ] `www` → apex redirect configured

### Database — Neon PostgreSQL

- [ ] Neon project created (region: Southeast Asia / Singapore)
- [ ] Production branch (`main`) — connection string is `DATABASE_URL`
- [ ] Dev/test branch for local development — connection string is `DATABASE_TEST_URL`
- [ ] `DATABASE_URL` set in Vercel production environment
- [ ] `DATABASE_TEST_URL` set in local `.env.test` (not committed)
- [ ] Prisma migrations applied to production DB (`npx prisma migrate deploy`)
- [ ] **T-13 audit columns applied per-environment** — `prisma/migrations/` is gitignored (DL-011); run `npx prisma migrate dev` locally and on each Neon branch after pulling T-13. `schema.prisma` is the committed source of truth; missing this step causes a runtime crash on the audit fields, not a type error.
- [ ] **First ADMIN user bootstrapped** — `UPDATE "users" SET role = 'ADMIN' WHERE email = '<admin-email>';` on the target Neon branch (DL-008). No in-app promotion path exists.
- [ ] Connection pooling confirmed (Neon serverless driver or PgBouncer)

### Authentication — Google OAuth

- [ ] Google Cloud Console project created
- [ ] OAuth 2.0 credentials created (Web Application type)
- [ ] Authorized JavaScript origins: `https://<domain>` + `http://localhost:3000`
- [ ] Authorized redirect URIs: `https://<domain>/api/auth/callback/google` + `http://localhost:3000/api/auth/callback/google`
- [ ] `GOOGLE_CLIENT_ID` set in Vercel env
- [ ] `GOOGLE_CLIENT_SECRET` set in Vercel env
- [ ] `NEXTAUTH_SECRET` generated (`openssl rand -base64 32`) and set in Vercel env
- [ ] `NEXTAUTH_URL` set to `https://<domain>` in Vercel env

### Payments — Xendit (primary processor)

**Account setup**
- [ ] Xendit business account created (`https://dashboard.xendit.co`)
- [ ] KYB (Know Your Business) verification submitted
- [ ] KYB approved — live mode unlocked
- [ ] `XENDIT_SECRET_KEY` (live) set in Vercel env
- [ ] Sandbox secret key set in local `.env` for development

**Managed Sub-Accounts (AD-001 Direct Payment model)**
- [ ] Managed Sub-Accounts feature enabled on account (contact Xendit support if not visible)
- [ ] Commission split percentage confirmed and configured per sub-account (matches `COMMISSION_RATE` constant in `src/domain/payments/commission.ts`)
- [ ] Process defined for creating a sub-account per onboarded lab (manual Xendit API call or admin slice — not yet ticketed)

**Fixed Virtual Accounts — PESONet (T-17)**
- [ ] Fixed Virtual Account feature enabled on Xendit account
- [ ] Supported bank codes confirmed against `PESONET_BANK_CODES` in `src/domain/payments/pesonet.ts` (`BPI`, `BDO`, `RCBC`, `LANDBANK`, `UNIONBANK`)

**Webhooks**
- [ ] `XENDIT_WEBHOOK_TOKEN` generated and set in Vercel env
- [ ] `XENDIT_SETTLEMENT_WEBHOOK_TOKEN` generated (separate token) and set in Vercel env
- [ ] Invoice webhook registered in Xendit dashboard → `https://<domain>/api/webhooks/xendit` (events: `invoice.paid`, `invoice.expired`)
- [ ] FVA webhook registered → `https://<domain>/api/webhooks/xendit-va` (events: `fixed_virtual_account.payment.succeeded`, `fixed_virtual_account.payment.expired`)
- [ ] Settlement webhook registered → `https://<domain>/api/webhooks/xendit-settlement` (events: `managed_account.payment.settled`)
- [ ] Webhook delivery confirmed end-to-end in sandbox before going live

### Payments — PayMongo (deferred, AD-002)

These are blocked on confirming sub-merchant support (see AD-002 blocking question above).

- [ ] **Blocker resolved:** Confirm PayMongo supports sub-merchant or split-payment equivalent for the Direct Payment model
- [ ] PayMongo account created (`https://dashboard.paymongo.com`)
- [ ] Business verification completed
- [ ] `PAYMONGO_SECRET_KEY` set in Vercel env
- [ ] `PAYMONGO_WEBHOOK_SECRET` (HMAC-SHA256 key) set in Vercel env — this is the secret used by `verifyPayMongoHmac` stub in `src/lib/payments/webhook-auth.ts`
- [ ] PayMongo webhook registered → `https://<domain>/api/webhooks/paymongo`

### File Storage — Cloudflare R2 (decided; required for T-15 KYC uploads, T-12 attachments)

Provider decided: **Cloudflare R2** (zero egress cost, S3-compatible API, Philippine edge presence). T-15 merged (PR #16).

- [x] **R2 bucket created** — APAC region
- [x] **API token created** — Object Read & Write scope on the bucket only
- [ ] CORS policy configured: allow `PUT` from `https://<domain>` and `http://localhost:3000` — **required before first upload from production or localhost**
- [x] `CLOUDFLARE_ACCOUNT_ID` set in `.env.local`
- [x] `R2_ACCESS_KEY_ID` set in `.env.local`
- [x] `R2_SECRET_ACCESS_KEY` set in `.env.local`
- [x] `R2_BUCKET_NAME` set in `.env.local`
- [x] `R2_ENDPOINT` set in `.env.local`
- [ ] All five R2 vars set in **Vercel env** (production + preview) — not yet confirmed
- [ ] File size limit: 20 MB for KYC docs (enforced in `upload-action.ts`); 50 MB for lab result PDFs (T-12, separate)

### CI / Automated Checks

- [ ] GitHub Actions workflow: runs `npx tsc --noEmit` + `npx eslint src/` on every PR
- [ ] `DATABASE_TEST_URL` added to GitHub repo secrets (for Vitest integration tests against Neon dev branch in CI)
- [ ] Vitest integration test step added to CI workflow (`npm test -- --run`)
- [ ] CI status check required before merge (branch protection rule on `main`)

### Monitoring & Observability

- [ ] Error tracking configured — recommended: Sentry (Next.js SDK) or Vercel built-in error tracking
- [ ] Uptime monitoring configured — recommended: Better Uptime or UptimeRobot (ping `/api/health` or homepage)
- [ ] Vercel Analytics enabled (free tier, no configuration required)
- [ ] Log drain configured if structured logging is needed (Vercel → Axiom or Logtail)

### Transactional Email *(not yet ticketed)*

No email sending exists in the codebase yet. Required before commercial launch for:
order confirmation, quote notification, payment received, and lab payout notifications.

- [ ] Email provider selected — recommended: Resend (generous free tier, Next.js SDK)
- [ ] Sender domain verified (SPF + DKIM records on domain DNS)
- [ ] API key obtained and set in Vercel env (`RESEND_API_KEY`)
- [ ] Email templates drafted (order confirmation, quote request, payment confirmation)
- [ ] Email sending slice added to relevant Server Actions (not yet a ticket — create when ready)

### Legal & Regulatory (Philippines)

These are prerequisites for commercial revenue, not code tickets. None can be deferred past first paying customer.

- [ ] **DTI registration** (sole proprietor) or **SEC registration** (OPC / partnership) — required before operating as a business
- [ ] **BIR Form 2303** (Certificate of Registration) — required before issuing official receipts and before first commercial revenue (explicitly called out in AD-001)
- [ ] **BIR OR (Official Receipts)** — printed or ePOS OR for PipetGo commission invoices issued to labs; manual process acceptable at early stage
- [ ] **VAT threshold tracking** — PipetGo must register for VAT if gross annual revenues exceed PHP 3,000,000; track from first transaction
- [ ] **NPC registration** as Personal Information Controller — required under RA 10173 (Data Privacy Act); **T-20 is now merged — this is an active prerequisite before first commercial transaction**
- [ ] **Privacy notice legal review** — stub copy is live at `/privacy` (T-20 merged); legal must review controller identity, retention periods, and NPC contact wording **before first paying customer**
- [ ] **ISO 17025 accreditation check process** — admin runbook for verifying lab certificates before `Lab.isVerified = true` (T-18 prerequisite)

### Environment Variables — Full Production Reference

All variables required in Vercel production environment:

| Variable | Source | Required by |
|---|---|---|
| `DATABASE_URL` | Neon dashboard → production branch | All DB queries |
| `NEXTAUTH_SECRET` | `openssl rand -base64 32` | NextAuth session signing |
| `NEXTAUTH_URL` | `https://<domain>` | NextAuth callback URLs |
| `GOOGLE_CLIENT_ID` | Google Cloud Console | T-01 OAuth |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console | T-01 OAuth |
| `XENDIT_SECRET_KEY` | Xendit dashboard → API keys | checkout/action.ts, xendit-va.ts |
| `XENDIT_WEBHOOK_TOKEN` | Xendit dashboard → Webhooks | invoice + FVA webhook auth |
| `XENDIT_SETTLEMENT_WEBHOOK_TOKEN` | Xendit dashboard → Webhooks | settlement webhook auth |
| `PAYMONGO_SECRET_KEY` | PayMongo dashboard | deferred (AD-002) |
| `PAYMONGO_WEBHOOK_SECRET` | PayMongo dashboard | deferred (AD-002) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard | T-15 R2 storage |
| `R2_ACCESS_KEY_ID` | R2 API token | T-15 R2 storage |
| `R2_SECRET_ACCESS_KEY` | R2 API token | T-15 R2 storage |
| `R2_BUCKET_NAME` | R2 bucket name | T-15 R2 storage |
| `R2_ENDPOINT` | `https://<CLOUDFLARE_ACCOUNT_ID>.r2.cloudflarestorage.com` | T-15 R2 storage |
| `RESEND_API_KEY` | Resend dashboard | not yet ticketed |

Local dev also needs `DATABASE_TEST_URL` in `.env.test` (gitignored).

---

## Dependency tree

```
T-01 Auth providers                        [done] [planner]
├── T-02 Lab onboarding                    [done]
│   └── T-03 Lab service management        [done]
│       └── T-04 Service marketplace       [done]
│           └── T-05 ClientProfile on      [done]
│                    create-order
└── T-06 Order detail page (client)        [done]
    ├── T-07 Quote flow                    [done]
    └── T-08 Payment failure retry         [done]

T-04.5 Tailwind CSS setup                  [done — CSS pipeline; T-07 UI blocker cleared]

T-09 Commission record on completion       [done — PR #9] [planner]
└── T-10 Commission settlement webhook     [done — PR #10] [planner]
    └── T-11 Lab wallet dashboard          [done — PR #11]

T-12 Attachment uploads                    [ready — T-06 ✅, R2 provisioned ✅] [planner]
T-13 Admin panel — KYC review surface      [done — PR #17] [planner]
T-13b Admin order oversight (read-only)     [ready — T-13 ✅] [planner]
T-13c Admin role management                 [deferred — needs privilege-escalation audit] [planner]
<!-- T-13 shipped KYC-review only. T-13b = read-only order/transaction oversight; T-13c = UserRole grant/revoke, deferred until its own security audit. -->

T-14 Payment provider normalization        [done — PR #13] [planner]

── Phase 2 infrastructure ──────────────────────────────────────────────────
T-15 Lab KYC document upload              [done — PR #16] [planner]
T-16 Idempotency key table                [done — PR #12] [planner]
T-17 PESONet virtual account integration  [done — PR #14] [planner]

── Phase 3 regulatory ──────────────────────────────────────────────────────
T-18 Lab accreditation verification       [ready — T-02 ✅, T-13 ✅ (merged PR #17)] [planner]
    (ISO 17025 / ITA solidary liability)
T-19 Dispute and redress mechanism        [blocked: T-06, schema migration] [planner]
    (ITA 2023 internal redress requirement)
T-20 RA 10173 privacy compliance          [done — PR #15] [planner]
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

### Phase 1 — Core user flows ✅ COMPLETE (2026-05-11)

All 5/5 tickets done.

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-03 merge | — | — | ✅ done (PR #3) |
| T-04 Service marketplace | T-03 ✅ | 1 | ✅ done (PR #5) |
| T-06 Order detail page (client) | T-01 ✅ | 1 | ✅ done (PR #4) |
| T-04.5 Tailwind CSS setup | ready now | 1 | ✅ done (PR #6) |
| T-16 Idempotency key table | ready now | 1 | ✅ done (PR #12) |

**End state:** Lab-side and client-side read flows exist. T-07's blockers (T-03, T-06, T-04.5) all cleared.

### Phase 2 — Transactional flows ✅ COMPLETE (2026-05-29)

All `[planner]` tagged; each requires a plan session, `/clear`, then implementation session.

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-05 ClientProfile on create-order | T-04 ✅ | 2 | ✅ done (foundation commit `1b23c0b`) |
| T-07 Quote flow | T-06 ✅ + T-03 ✅ | 2 | ✅ done (PR #7) |
| T-08 Payment failure retry | T-06 ✅ | 2 | ✅ done (PR #8) |
| T-09 Commission record | T-09 ✅ | 2 | ✅ done (PR #9) |
| T-15 Lab KYC upload | T-02 ✅ | 2 | ✅ done (PR #16) — LabDocument model, KycStatus enum, R2 presigned PUT, checkout gate on both invoice + VA paths |

**End state:** Full order lifecycle functional (create → quote → pay → complete). Commission records written on completion. KYC gate live on all checkout paths (T-15). All Phase 2 tickets done.

### Phase 3 — Financial + infrastructure ✅ COMPLETE (2026-05-26)

All 4/4 tickets done (T-17 pulled forward from Phase 4 as it unblocked on T-14).

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-10 Commission settlement webhook | T-09 ✅ | 2 | ✅ done (PR #10) |
| T-11 Lab wallet dashboard | T-10 ✅ | 1 | ✅ done (PR #11) |
| T-14 Payment provider normalization | ready now ✅ | 3 | ✅ done (PR #13) — NormalizedWebhookPayload boundary; verifyXenditToken; route.ts sole Xendit-aware file |
| T-17 PESONet virtual account | T-14 ✅ | 3 | ✅ done (PR #14) — FVA payment for orders above PHP 50k; Xendit fixed virtual account; PESONet bank codes dispatch map |

**End state:** Financial flows closed. Xendit→PayMongo migration path ready (T-14). PESONet B2B payment path ready (T-17). MVP infrastructure complete.

### Phase 4 — Post-MVP / compliance (target: 2026-06-08 → 2026-07-06)

4/6 done (T-17 pulled into Phase 3, T-20 merged, T-15 done, T-13 KYC-review done).

| Ticket | Blocker clears | Sessions | Notes |
|--------|----------------|----------|-------|
| T-17 PESONet virtual account | T-14 ✅ | 3 | ✅ done (PR #14) — pulled forward, completed in Phase 3 |
| T-20 RA 10173 privacy compliance | T-05 ✅ | 2 | ✅ done (PR #15) — consent capture, privacy notice, enum-drift fence |
| T-15 Lab KYC upload | T-02 ✅ | 2 | ✅ done (PR #16) — LabDocument model, KycStatus enum, R2 presigned PUT, checkout gate |
| T-13 Admin panel — KYC review surface | T-01 ✅ + T-15 ✅ | 1 | ✅ done (PR #17, merged `2e9c8cc`) — ADMIN-gated KYC review queue + approve/reject; deployed to dev + admin bootstrapped (`alfieprojects.dev@gmail.com`); T-13b (role mgmt + order oversight) is follow-up |
| T-18 Lab accreditation verification | T-02 ✅ + T-13 ✅ | 2 | **Now unblocked (T-13 merged)** — ITA 2023 / ISO 17025; reuses the admin slice + auth patterns; operates `Lab.isVerified` (distinct from `kycStatus`). **Recommended next.** |
| T-12 Attachment uploads | T-06 ✅ + R2 ✅ | 3 | **Now unblocked** — R2 provisioned (T-15); reuses src/lib/storage/r2.ts (presigned GET added in T-13); client spec + lab result PDFs |
| T-13b Admin order oversight (read-only) | T-13 ✅ | 1 | Read-only admin view of all orders/transactions/payouts; clones the T-13 admin read patterns + reuses the route-group guard — no `UserRole` writes. Pull forward only on a concrete ops/support need. |
| T-13c Admin role management | T-13 ✅ | 2 | **Deferred — privilege-escalation surface.** `UserRole` grant/revoke; needs last-admin + self-demotion invariants, an audit log, and a dedicated security review. Manual-SQL bootstrap (DL-008) stays the only ADMIN-minting path until then. |
| T-19 Dispute and redress | T-06 ✅ + T-07 ✅ | 2 | ITA 2023 internal redress; schema migration needed (DISPUTED status) |

**End state:** Full roadmap complete, including regulatory compliance layer.

### Summary

| Phase | Status | Coverage | MVP gate |
|-------|--------|----------|----------|
| 1 — Core flows | ✅ **COMPLETE** | 5/5 | |
| 2 — Transactional | ✅ **COMPLETE** | 5/5 | |
| 3 — Financial | ✅ **COMPLETE** | 4/4 | ✅ **MVP gate cleared** |
| 4 — Post-MVP | 4/6 done | 67% | |

**Phases 1–3 are complete.** T-13 KYC-review surface merged (closes the approve path for labs). T-18 (accreditation, ISO 17025) is recommended next; T-12 (attachments) follows. The remaining T-13 scope is split into T-13b (read-only order oversight) and T-13c (role management, deferred — privilege-escalation audit).

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
**Status:** done (PR #6)

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
**Status:** done (foundation commit `1b23c0b`)
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
**Status:** done (PR #7)
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
**Branch:** `feat/T08-payment-failure-retry`
**Status:** done (PR #8)
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
**Status:** done (PR #9)
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
**Status:** done (PR #10)
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
**Status:** done (PR #11)

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
**Status:** ready — T-06 ✅, storage decided (Cloudflare R2, provisioned via T-15)
**Why planner:** Storage provider integration, signed URL pattern vs direct upload, file type/size validation at the action boundary, and two distinct upload actors (client uploads specs, lab uploads results) with different permission guards. Storage provider must be decided and documented before the plan can be written.

Client uploads specification documents at order creation; lab uploads result
documents at order completion. Uses the `Attachment` model.

**Note:** Requires a file storage provider decision before planning. Open a
separate spike ticket to evaluate options.

---

### T-13 — Admin panel `[planner]`
**Branch:** `feat/T13-admin`
**Status:** done (KYC-review surface, PR #17) — follow-ups: T-13b (order oversight, read-only), T-13c (role management, deferred)
**Why planner:** Scope is deliberately undefined at this stage — plan must define the surface area (which operations, which pages) before implementation. Touches role-gating across multiple existing slices and will likely require new middleware or layout-level auth guards.

Lab verification (`isVerified`) → T-18. Order oversight → T-13b (read-only). Role management → T-13c (deferred — needs privilege-escalation audit). KYC review surface shipped.
`UserRole.ADMIN` exists in schema; no admin slices exist.

---

### T-14 — Payment provider normalization `[planner]`
**Branch:** `feat/T14-payment-provider-normalization`
**Status:** done (PR #13)
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
**Status:** done (PR #16, 2026-05-29)
**Plan file:** `plans/T-15-lab-kyc-upload.md`
**Why planner:** New `LabDocument` model (cannot reuse `Attachment.orderId` which is NOT NULL), new `KycStatus` enum (distinct from `Lab.isVerified` which is reserved for T-18 ISO 17025), presigned PUT URL pattern to bypass Next.js 4.5 MB limit, checkout gate on both invoice and PESONet paths.

Labs must upload business registration documents (BIR 2303, DTI/SEC) to Cloudflare R2.
`Lab.kycStatus` must be `APPROVED` (set manually by admin via T-13) before a lab can
accept payments through checkout. Xendit KYC API submission is deferred — manual admin review (shipped in T-13) is the gate (T-15 DL-004). Xendit KYC API integration is not yet planned.

**Key decisions (from plan):**
- Storage: Cloudflare R2 via presigned PUT URL — client uploads directly, bypassing Next.js 4.5 MB limit
- Schema: New `LabDocument` model (not modifying `Attachment.orderId`)
- Gate: Checkout-only (`initiateCheckout` + `initiateVaCheckout`) — not settlement handler
- KYC API: Deferred — admin manually sets `Lab.kycStatus = APPROVED` until T-13 admin panel ships
- `Lab.ownerId` promoted to `@unique` — migrates `findFirst→findUnique` in onboarding and service-management

**Files:** `src/lib/storage/r2.ts` (new), `src/features/labs/kyc-upload/` (new slice), `prisma/schema.prisma` (KycStatus enum + LabDocument model), `src/features/payments/checkout/action.ts` (KYC gate)

**Acceptance criteria:**
- LAB_ADMIN can upload BIR 2303 and DTI/SEC docs from `/dashboard/lab/kyc`
- Documents are stored in Cloudflare R2; `LabDocument` rows track status (PENDING → UPLOADED)
- `Lab.kycStatus` transitions PENDING → SUBMITTED after first successful upload
- Labs with `kycStatus !== APPROVED` cannot proceed through checkout (both invoice and VA paths)
- `Lab.isVerified` is untouched (reserved for T-18 ISO 17025 accreditation)

---

### T-16 — Idempotency key table `[planner]`
**Branch:** `feat/T16-idempotency-keys`
**Status:** done (PR #12)
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
**Status:** done — PR #15
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
| T-05 ClientProfile on create-order | foundation `1b23c0b` | clientDetailsSchema validation, all five contact fields, atomic Order + ClientProfile $transaction |
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
| T-07 Quote flow | PR #7 `0bf6c4e` | End-to-end quote flow: LAB_ADMIN provides quote (QUOTE_REQUESTED→QUOTE_PROVIDED), client accepts (→PAYMENT_PENDING) or rejects (→QUOTE_REJECTED); inline action panel on order-detail |
| T-08 Payment failure retry | PR #8 `ab1d355` | EXPIRED webhook handler (processPaymentFailed); retryPayment action + OrderDetailRetryPayment UI; checkout app router mount at /dashboard/orders/[orderId]/pay; acceptQuote redirect fix |
| T-09 Commission record on completion | PR #9 `9182b0a` | Remove LabWallet credit from processPaymentCapture (AD-001); add COMMISSION_RATE domain constant; create QUEUED Payout inside completeOrder $transaction with Decimal fee arithmetic |
| T-10 Commission settlement webhook | PR #10 `059219d` | Xendit settlement webhook (payouts/ slice); Payout QUEUED→COMPLETED; LabWallet pendingBalance→availableBalance atomic move; M-0 patch credits pendingBalance at Payout creation |
| T-11 Lab wallet dashboard | PR #11 `b3cd3d8` | /dashboard/lab/wallet — balance cards (pending/available/withdrawn), Payout history table with PayoutStatus badges; satisfies Record<PayoutStatus> exhaustiveness guard |
| E1 integrity guard split | PR #12 `aa23d67` | Split compound `!order \|\| !order.lab` guards in quote-provide and lab-fulfillment pages; referential integrity violations now throw instead of calling notFound() |
| T-16 Idempotency key table | PR #12 `aa23d67` | IdempotencyKey model; dedup key check+create in all three Xendit webhook handlers (PAID, EXPIRED, settlement); create-last invariant; three-layer dedup model |
| T-14 Payment provider normalization | PR #13 `38546f6` | NormalizedWebhookPayload boundary; verifyXenditToken + HMAC stubs; normalizeXenditInvoicePayload adapter; route.ts sole Xendit-aware file; handlers accept only NormalizedWebhookPayload; tx.transaction.updateMany guard |
| T-17 PESONet virtual account | PR #14 `657e601` | FVA payment method for orders above PHP 50k; Xendit fixed virtual account creation; PESONET_BANK_CODES dispatch map; pesonet/route.ts uses NormalizedWebhookPayload; AbortSignal.timeout on all fetch calls |
| T-20 RA 10173 privacy compliance | PR #15 `0341d8e` | consentGiven + consentGivenAt on ClientProfile; z.literal(true) gate in clientDetailsSchema; hidden-input consent checkbox; /privacy static RSC; SENSITIVE_SERVICE_CATEGORIES enum-drift fence; 5-test unit suite |
| T-15 Lab KYC document upload | PR #16 `dadbbdf` | KycStatus enum + LabDocument model; Cloudflare R2 presigned PUT via src/lib/storage/r2.ts; kyc-upload VSA slice (requestUploadUrl + confirmUpload + page + ui); KYC gate on both initiateCheckout and initiateVaCheckout; Lab.ownerId @unique; 36 unit tests |
