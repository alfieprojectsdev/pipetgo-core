# Plan

## Overview

T-10 implements the Xendit settlement webhook handler. When Xendit settles PipetGo's commission split into PipetGo's account, the webhook fires; the handler must look up the QUEUED Payout, mark it COMPLETED, and atomically move the commission amount from LabWallet.pendingBalance to LabWallet.availableBalance inside one $transaction. Pre-condition gap from T-09: completeOrder creates Payout(QUEUED) but does NOT credit LabWallet.pendingBalance. T-10 M-0 must patch completeOrder so the pendingBalance starts populated before settlement decrements it.

**Approach**: TBD pending step 4. Likely: (1) M-0 patch completeOrder to upsert LabWallet.pendingBalance += <figure> atomically with Payout.create; (2) new slice src/features/payments/payouts/ with route.ts (x-callback-token auth) + handlers.ts (processSettlement); (3) new app-router re-export at src/app/api/webhooks/xendit-settlement/route.ts; (4) integration tests against test DB mirroring src/features/payments/webhooks/__tests__/handlers.test.ts; (5) docs/README for the new slice.

### T-10 Settlement Flow — Xendit settlement webhook to LabWallet

[Diagram pending Technical Writer rendering: DIAG-001]

## Planning Context

### Decision Log

| ID | Decision | Reasoning Chain |
|---|---|---|
| DL-001 | LabWallet ledger figure is Payout.platformFee (PipetGo commission), not Payout.netAmount | AD-001 defines LabWallet as PipetGo commission ledger per lab -> the figure moving through pending/available IS PipetGo commission -> Payout.platformFee = PipetGo cut (10%); Payout.netAmount = lab keep (90%) -> roadmap text saying netAmount was imprecise; platformFee is semantically correct. Grounding: prisma/schema.prisma:274 defines platformFee Decimal @db.Decimal(12,2) on the Payout model (confirmed real column, not assumed); same model defines netAmount alongside, so the choice between them is real, not nominal. |
| DL-002 | M-0 patches completeOrder to upsert LabWallet.pendingBalance += Payout.platformFee inside the existing T-09 $transaction | Schema comment (schema.prisma:295) states pendingBalance credited at Payout QUEUED -> T-09 creates QUEUED Payout without that credit (gap) -> T-10 cannot subtract pendingBalance at settlement unless QUEUED time has already credited it -> credit at completeOrder closes the invariant gap in one atomic $transaction; doing it at settlement instead would create a window where Order is COMPLETED, Payout QUEUED, but pendingBalance is zero (T-11 dashboard would mislead) |
| DL-003 | New settlement slice at src/features/payments/payouts/ mirroring src/features/payments/webhooks/ three-layer pattern | Settlement is a structurally different Xendit event from invoice payment (different product, different payload, separate webhook registration, independent token rotation) -> putting it in the invoice webhooks/ slice mixes concerns and inflates a slice that already owns capture + failure paths -> separate slice keeps each route file aligned to one Xendit event class and matches T-14 normalization goal of one route per provider event type |
| DL-004 | Idempotency key is Payout.externalPayoutId @unique with status guard (no separate IdempotencyKey table) | Payout.externalPayoutId is @unique nullable (schema.prisma:278) and starts NULL on Payout creation at completeOrder -> at settlement, set externalPayoutId to the Xendit settlement ID; duplicate deliveries see the @unique row with status=COMPLETED -> a dedicated IdempotencyKey table (T-16) would be redundant when the domain model already carries the natural idempotency key |
| DL-005 | Lookup uses tx.payout.findUnique({where: {externalPayoutId: payload.id}}) for established Payouts, plus an orderId-scoped findFirst on (orderId, status=QUEUED, externalPayoutId=null) for the first-time-settlement case | Two valid Payout states arrive at this webhook: (a) duplicate delivery — externalPayoutId already written, status COMPLETED — caught by findUnique on @unique and early-returned; (b) first delivery — externalPayoutId still NULL, status QUEUED — cannot be located by externalPayoutId since it has not been written -> needs lookup by alternative key. Schema has only @@index([orderId]) (prisma/schema.prisma), no uniqueness on orderId, so multiple historical Payouts on one order are physically possible (manual reissue, partial refunds in future tickets). Safety reasoning: (1) the current state machine writes exactly one QUEUED Payout per Order at completeOrder (T-09 single-completion guarantee) — no two QUEUED Payouts on one order coexist; (2) externalPayoutId=null filter further excludes any Payout that has already been settled, so even if future tickets introduce additional Payouts on the same orderId (refund-replacement), only the un-settled one matches; (3) findFirst is correct here because uniqueness is enforced by the (orderId, status=QUEUED, externalPayoutId=null) compound predicate plus state-machine invariant, not by a single column. Implementation Discipline (findUnique on @unique) applies to externalPayoutId @unique; it does NOT require findUnique on non-unique columns where compound-predicate state-machine reasoning guarantees uniqueness. |
| DL-006 | Settlement webhook auth uses static x-callback-token via crypto.timingSafeEqual against env XENDIT_SETTLEMENT_WEBHOOK_TOKEN | Existing Xendit invoice webhook uses static token (Xendit does not provide HMAC for these callbacks per Payment-Processor-eval-PipetGo.md research) -> settlement webhook follows the same Xendit convention -> separate env var (XENDIT_SETTLEMENT_WEBHOOK_TOKEN) so the two webhooks rotate independently; same env-missing -> 500 pattern as invoice route surfaces misconfiguration before any comparison |
| DL-007 | Negative LabWallet.pendingBalance after subtraction throws; never clamp | Negative balance is a contract violation: either M-0 missed crediting pendingBalance at QUEUED time, or a duplicate settlement bypassed the idempotency guard -> clamping hides the bug and corrupts the ledger silently -> per CLAUDE.md Implementation Discipline rule, throw new Error so the violation surfaces in dev/staging instead of producing wrong production numbers |
| DL-008 | Payout in PROCESSING or FAILED on settlement is a contract violation that throws; only QUEUED and COMPLETED are valid | PayoutStatus enum in prisma/schema.prisma:54-58 defines QUEUED, PROCESSING, COMPLETED, FAILED (grounding: schema confirms all four variants exist as real enum values, so the throw branch is non-dead-code at runtime). T-10 is the only writer of Payout.status transitions to COMPLETED in the current codebase -> PROCESSING and FAILED are not produced by any current slice (PROCESSING reserved for future Xendit disbursement flow, FAILED for future disbursement failure) -> encountering them on the settlement webhook means another writer mutated Payout outside the documented flow, which is a contract violation by Implementation Discipline (unhandled enum branches must throw, never default silently). |
| DL-009 | Orphan tolerance returns 200 without writes; Payout-not-found means settlement arrived before our completeOrder fired (or for an unrelated Xendit event) | Webhook delivery and completeOrder are ordered by external clock — Xendit may push a settlement event that is correlated to one of our prior Payouts but is also valid for an unrelated Xendit invoice (sub-account splits not driven by our checkout) -> erroring out would force Xendit to keep retrying forever -> mirrors processPaymentCapture orphan-tolerance pattern (handlers.ts:34) |
| DL-010 | Webhook payload shape is assumed and flagged; pre-merge sandbox verification gate (AC-006) is the mitigation, not a blocking research milestone | Xendit settlement webhook payload shape is not documented in the repo (docs/research/Payment-Processor-eval-PipetGo.md covers invoice webhooks only) -> blocking implementation on a full research milestone delays T-11 unnecessarily -> plan assumes shape {id, status, amount, external_id} with id mapping to externalPayoutId and external_id mapping to our orderId. Mitigation: R-001 captures the assumption as a tracked risk with a pre-merge sandbox verification AC (AC-006 on M-002) that requires triggering one real Xendit sandbox settlement, capturing the actual JSON, and reconciling types.ts before merge; the dispatch literal COMPLETED is surfaced as named constant SETTLEMENT_STATUS_COMPLETED in route.ts with a TODO comment (R-002) so the provisional value is visible at the code level, not buried in plan prose. |
| DL-011 | Integration tests run against real test DB (testPrisma); rollback tests use full Prisma mock — exactly mirroring src/features/payments/webhooks/__tests__/ split | Financial ledger correctness requires real Decimal arithmetic and FK constraint validation — mocking hides Decimal toFixed regressions and balance-never-negative invariant violations -> testPrisma + DATABASE_TEST_URL matches the established webhook-slice pattern -> rollback error propagation cannot be exercised on real DB without schema breakage, so a separate full-mock file isolates that single concern |
| DL-012 | Checkout slice receives no changes in this ticket; sub-account split configuration deferred to a later checkout-migration ticket. Dormancy is treated as an assumption that must be verified against the Xendit dashboard before merge. | Current src/features/payments/checkout/action.ts creates a regular Xendit invoice on the PipetGo account (not a Managed Sub-Account split) -> migrating checkout is a larger architectural change with separate test surface (sub-account creation, KYC, split percentage config) -> this ticket builds the settlement handler against the assumed sub-account payload shape so production wiring becomes a single config flip when the checkout-migration ticket lands. Risk: any pre-existing Managed Sub-Account registration in the Xendit dashboard could already produce settlement webhooks, activating the handler immediately on deploy. R-004 captures this as a tracked risk with AC-007 on M-002 requiring a pre-merge check of the Xendit dashboard for existing settlement webhook registrations; if any exist, they are documented in the slice README Production Wiring section before merge. |

### Rejected Alternatives

| Alternative | Why Rejected |
|---|---|
| Use existing /api/webhooks/xendit route with new status dispatch for settlement events | Settlement is a structurally different Xendit product (sub-account split vs invoice payment) with different payload shape and possibly different token; mixing into the invoice slice inflates a slice that already owns capture + failure paths and works against T-14's normalization goal of one route per provider event type (ref: DL-003) |
| Credit LabWallet.pendingBalance at settlement time inside processSettlement instead of M-0 patching completeOrder | Creates a window where Order is COMPLETED and Payout is QUEUED but pendingBalance is 0, breaking the schema.prisma:295 invariant and making T-11 dashboard show incorrect pending figures between order completion and settlement (ref: DL-002) |
| Use T-16 IdempotencyKey table for deduplicating settlement webhook deliveries | Payout.externalPayoutId is already @unique nullable; a dedicated key table is additional complexity with no benefit when the domain model already carries the natural idempotency key (ref: DL-004) |
| Use findFirst on Payout by externalPayoutId for the duplicate-detection query | externalPayoutId is @unique per prisma/schema.prisma:278; findFirst on @unique fields violates Implementation Discipline (CLAUDE.md compounding-protocol rule); findUnique is required so the uniqueness constraint is enforced at query level (ref: DL-005) |
| Clamp LabWallet.pendingBalance to 0 if subtraction would go negative | Negative balance indicates an upstream bug (M-0 credit missed or double-settlement bypassed idempotency guard); clamping hides the bug and corrupts the ledger silently; Implementation Discipline mandates throw so the contract violation surfaces in dev/staging (ref: DL-007) |

### Constraints

- MUST: Payout.status = COMPLETED and LabWallet balance move happen inside the same prisma.$transaction so no window exists where Payout is COMPLETED without LabWallet reflecting it
- MUST: availableBalance += platformFee AND pendingBalance -= platformFee in one $transaction (atomic transfer of PipetGo's commission ledger figure)
- MUST: Idempotency guard — if Payout.externalPayoutId already set on a COMPLETED Payout, return early (200, no re-write); duplicate-detection lookup uses findUnique on @unique externalPayoutId per Implementation Discipline
- MUST: LabWallet.pendingBalance must never go negative — throw new Error if (pendingBalance - platformFee) < 0, never silently default or clamp
- MUST: No Number coercion on Prisma Decimal values anywhere in fee arithmetic or balance writes — Decimal.sub/add or Prisma {increment}/{decrement} only
- MUST: Webhook route auth uses static x-callback-token via crypto.timingSafeEqual matching the existing xendit/route.ts pattern; env var XENDIT_SETTLEMENT_WEBHOOK_TOKEN (separate from XENDIT_WEBHOOK_TOKEN so both can rotate independently)
- MUST: Orphan tolerance — if no QUEUED or COMPLETED Payout found for the externalPayoutId AND no QUEUED Payout for payload.external_id, return 200 without error (Xendit may deliver settlements for non-PipetGo sub-account events)
- MUST: findUnique on Payout.externalPayoutId (@unique) per Implementation Discipline; NOT findFirst
- MUST: Throw if Payout found but in unexpected status (PROCESSING or FAILED is a contract violation, not an orphan) — unhandled enum branches throw per CLAUDE.md
- SHOULD: Follow the existing xendit/route.ts -> feature route.ts -> handlers.ts three-layer pattern (app-router re-export / route / handler separation) for the new payouts/ slice
- SHOULD: Integration test against real test DB (testPrisma + DATABASE_TEST_URL) matching the pattern in src/features/payments/webhooks/__tests__/handlers.test.ts; rollback tests use full Prisma mock

### Known Risks

- **Xendit settlement webhook payload field names are assumed (id/status/amount/external_id) without sandbox verification — wrong field names cause idempotency-key lookup and orderId fallback to silently miss every settlement at production launch**: Block PR merge on a pre-merge sandbox verification gate: trigger one real Xendit settlement in sandbox, capture the actual JSON payload, and either confirm the field names in types.ts match or update types.ts + handlers.ts + tests in the same PR. AC-006 (added to M-002) makes this gate explicit; types.ts TODO comments name each field that requires verification.
- **Xendit settlement payload status string value is unconfirmed — could be 'COMPLETED', 'SUCCEEDED', or another variant; route.ts dispatch is keyed on this literal so a mismatch routes every real settlement to the no-op 'acknowledged' arm**: Surface the dispatch literal as a named constant SETTLEMENT_STATUS_COMPLETED in route.ts with a TODO comment flagging it for sandbox verification; the same pre-merge sandbox verification gate (AC-006) captures the actual status value; the no-op arm logs payload.status so an unexpected value is visible in staging.
- **Settlement webhook auth shape is assumed to be static x-callback-token (same mechanism as invoice webhook); if Xendit settlement actually uses HMAC-SHA256 or a different header, every settlement returns 401**: Same pre-merge sandbox verification gate (AC-006) covers auth header inspection; XENDIT_SETTLEMENT_WEBHOOK_TOKEN env-missing returns 500 so misconfiguration surfaces immediately on first invocation rather than silently 401-ing.
- **DL-012 asserts T-10 is 'dormant in production until checkout-migration ticket' — but if any pre-existing Xendit Managed Sub-Account in the dashboard already produces settlement webhooks, the handler activates on deploy without warning**: Add AC-007 to M-002 requiring a pre-merge check of the Xendit dashboard for any existing settlement webhook registrations against the production account; if any exist, document them in the slice README's Production Wiring section before merge.
- **LabWallet row may not exist when processSettlement runs (settlement arrives before M-0 patched completeOrder credits pendingBalance) — current design relies on Prisma's not-found-on-update error to throw**: CI-M-002-003 Step 2.5 explicitly tx.labWallet.findUnique({where:{labId: payout.labId}}) so a null wallet throws a typed Error('LabWallet missing for lab ${labId}') instead of an opaque Prisma error. M-0 ordering guarantee (Payout.create and LabWallet.upsert in same $transaction) means a Payout existing without a wallet is itself a contract violation worth a precise throw.

## Invisible Knowledge

### System

AD-001 (Direct Payment model): client pays the lab directly via a Xendit Managed Sub-Account invoice; Xendit splits PipetGo's commission at settlement and pushes the commission portion into PipetGo's own Xendit account. PipetGo never holds the gross. LabWallet is therefore PipetGo's commission ledger per lab — pendingBalance = commission confirmed (Payout QUEUED) but Xendit has not yet settled into PipetGo's account; availableBalance = commission settled (Payout COMPLETED). LabWallet is NOT an escrow that PipetGo owes back to the lab (aggregator model). Confusing the two produces disbursement logic (Xendit Disbursement API outbound) where none should exist. Payout is the per-order commission record: created QUEUED at completeOrder (T-09), transitioned to COMPLETED here at T-10 when Xendit settlement webhook fires. Payout.externalPayoutId is @unique nullable: starts NULL on creation, set to the Xendit settlement transfer ID on first delivery, making it the natural idempotency key.

### Invariants

- LabWallet.pendingBalance is credited at Payout-QUEUED creation time per prisma/schema.prisma:295 comment — T-09 created Payout(QUEUED) but did NOT credit pendingBalance; T-10 M-0 closes this gap so the schema invariant holds before settlement decrements pendingBalance
- The figure moving through LabWallet pending->available IS Payout.platformFee (PipetGo's commission cut, per prisma/schema.prisma:274 Decimal @db.Decimal(12,2)) — NOT Payout.netAmount (lab's keep). Roadmap text saying 'netAmount' was imprecise; LabWallet is PipetGo's ledger so the figure must be PipetGo's income
- LabWallet.pendingBalance is never negative — a negative result from subtraction is a contract violation (M-0 credit missed, double-settlement bypassed idempotency, or duplicate Payout); throw new Error per CLAUDE.md Implementation Discipline rather than clamp
- Payout.externalPayoutId @unique (prisma/schema.prisma:278) is the natural idempotency key — NULL on QUEUED, set on first settlement delivery; duplicate detection is findUnique on this column, no separate IdempotencyKey table needed
- PayoutStatus enum in prisma/schema.prisma:54-58 defines QUEUED, PROCESSING, COMPLETED, FAILED — but T-10 is the only writer of transitions to COMPLETED, and no current slice writes PROCESSING or FAILED. Encountering PROCESSING or FAILED on the settlement webhook means another writer mutated Payout outside the documented flow; this is a contract violation and throws (unhandled-enum-branch rule) — the throw is NOT dead code because the enum variants exist in schema

### Tradeoffs

- Dual-lookup strategy in processSettlement: findUnique by externalPayoutId first (honors @unique Implementation Discipline for the duplicate-delivery case), then findFirst by (orderId, status=QUEUED, externalPayoutId=null) for the first-delivery case where externalPayoutId has not yet been written. A uniform single-query design isn't possible because the lookup key only exists after first delivery. The findFirst-on-non-unique is safe because (a) only one QUEUED Payout per order can exist at any time per state-machine invariant (Order completes once -> Payout created once), and (b) the externalPayoutId=null filter further constrains to Payouts that have not yet been settled, eliminating any race with manual reissue or partial refund scenarios that would create additional historical Payouts on the same orderId
- Separate payouts/ slice instead of extending the existing webhooks/ slice with a new status arm: webhooks/ owns invoice-payment events (different Xendit product, different payload shape, different webhook URL); putting settlement into webhooks/ would inflate it and works against T-14's one-route-per-provider-event-type goal. Cost: more boilerplate (separate types.ts, route.ts, handlers.ts, tests). Benefit: clean slice boundary, independent token rotation, independent test surface
- Static x-callback-token via crypto.timingSafeEqual instead of HMAC-SHA256: matches the existing xendit/route.ts pattern because Xendit does not provide HMAC for these callbacks (per docs/research/Payment-Processor-eval-PipetGo.md). Cost: rotating the token requires redeploying the env var. Benefit: implementation parity with the existing webhook slice; reviewers don't have to re-learn auth flow
- Assumed Xendit settlement payload shape ({id, status, amount, external_id}) instead of blocking on a research milestone: T-11 (lab wallet UI) depends on T-10 data being written, and a research milestone would push T-11 by days. Cost: ASSUMPTION_UNVALIDATED on field names that drive the idempotency-key lookup and balance accounting — captured as R-001 with a pre-merge sandbox verification AC (AC-006) so the assumption fails fast before merge, not in production

## Milestones

### Milestone 1: M-0 — Patch completeOrder to credit LabWallet.pendingBalance += Payout.platformFee atomically with Payout.create

**Files**: src/features/orders/lab-fulfillment/action.ts, src/features/orders/lab-fulfillment/README.md, src/features/orders/lab-fulfillment/__tests__/action.test.ts, src/features/payments/webhooks/handlers.ts

#### Code Intent

- **CI-M-001-001** `src/features/orders/lab-fulfillment/action.ts`: Inside the existing completeOrder $transaction, after tx.payout.create({status: QUEUED, ...}), upsert tx.labWallet({where:{labId: order.lab.id}, update:{pendingBalance:{increment: platformFee}}, create:{labId: order.lab.id, pendingBalance: platformFee}}). The platformFee value used is the same Prisma Decimal already computed for the Payout (grossAmount.mul(COMMISSION_RATE)) — no recomputation, no Number coercion, identical instance reuse. Upsert handles the first-payout-per-lab case where no LabWallet row exists yet. The labWallet.upsert participates in the same $transaction so a failure rolls back Order.update and Payout.create. No new imports beyond Prisma client types already in scope. The completeOrder return contract (ActionState | null), redirect target, and revalidatePath calls are unchanged. (refs: DL-001, DL-002)
- **CI-M-001-002** `src/features/orders/lab-fulfillment/README.md`: Document that completeOrder writes three records in one $transaction: Order.status -> COMPLETED, Payout (status=QUEUED) commission record, and LabWallet.pendingBalance += Payout.platformFee (PipetGo commission ledger credit). State the AD-001 framing: LabWallet tracks PipetGo commission per lab, not lab escrow. Cross-reference DL-001 (platformFee not netAmount) and DL-002 (credit at QUEUED time satisfies schema.prisma:295 invariant before T-10 settlement decrements pendingBalance). Update existing $transaction-content listing to add the LabWallet upsert step. No reference to feat/T09-commission-record branch — write as though T-09 has already merged to main (final-state convention). (refs: DL-001, DL-002)
- **CI-M-001-003** `src/features/orders/lab-fulfillment/__tests__/action.test.ts`: Integration test against testPrisma (real test DB via DATABASE_TEST_URL). Seed Order(IN_PROGRESS), CAPTURED Transaction (amount=1500.00), authenticate as the labs owner via mocked auth(), call completeOrder with valid formData. Assert: (a) Order.status = COMPLETED; (b) one Payout row exists with platformFee = grossAmount.mul(0.1000) (assert .toFixed(2) string equality), netAmount = gross - fee, status=QUEUED, externalPayoutId=null; (c) LabWallet row exists with labId matching, pendingBalance.toFixed(2) equal to the Payouts platformFee.toFixed(2). Second test: second order for the same lab increments LabWallet.pendingBalance instead of creating a new row. Reuse the auth and seed helper patterns from src/features/payments/webhooks/__tests__/handlers.test.ts (testPrisma + vi.mock of @/lib/prisma). (refs: DL-002, DL-011)
- **CI-M-001-004** `src/features/payments/webhooks/handlers.ts::processPaymentCapture`: Remove the LabWallet.upsert block from processPaymentCapture (lines 86-93). The QUEUED-time credit (M-0 patch to completeOrder) now owns pendingBalance crediting, making the capture-time gross credit redundant and incorrect. After this removal, pendingBalance is credited exactly once per order at QUEUED time (Payout.platformFee), consistent with the schema.prisma:295 comment and DL-001. The removal is safe because processSettlement (T-10) decrements pendingBalance by platformFee, which now matches the credited amount exactly. (refs: DL-001, DL-002)

#### Code Changes

**CC-M-001-001** (src/features/orders/lab-fulfillment/action.ts) - implements CI-M-001-001

**Code:**

```diff
--- a/src/features/orders/lab-fulfillment/action.ts
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -19,7 +19,8 @@
 import { revalidatePath } from 'next/cache'
 import { redirect } from 'next/navigation'
-import { OrderStatus } from '@prisma/client'
+import { OrderStatus, PayoutStatus, TransactionStatus } from '@prisma/client'
+import { Decimal } from '@prisma/client/runtime/library'
 import { prisma } from '@/lib/prisma'
 import { auth } from '@/lib/auth'
 import { isValidStatusTransition } from '@/domain/orders/state-machine'
@@ -108,7 +109,42 @@
       data: {
         status: OrderStatus.COMPLETED,
         ...(notes != null ? { notes } : {}),
       },
     })
 
-    return null
+    const transaction = await tx.transaction.findFirst({
+      where: { orderId, status: TransactionStatus.CAPTURED },
+      orderBy: { capturedAt: 'desc' },
+    })
+
+    if (!transaction) {
+      // FIXED-mode orders may have no CAPTURED Transaction (payment not required).
+      // Payout is only created for paid orders; skip silently for FIXED-mode completions.
+      return null
+    }
+
+    const COMMISSION_RATE = new Decimal('0.1000')
+    const grossAmount = transaction.amount
+    const platformFee = grossAmount.mul(COMMISSION_RATE)
+    const netAmount = grossAmount.sub(platformFee)
+
+    await tx.payout.create({
+      data: {
+        labId: order.lab.id,
+        orderId,
+        transactionId: transaction.id,
+        grossAmount,
+        platformFee,
+        netAmount,
+        feePercentage: COMMISSION_RATE,
+        status: PayoutStatus.QUEUED,
+      },
+    })
+
+    // Credit LabWallet.pendingBalance with platformFee (PipetGo commission share).
+    // processPaymentCapture's gross credit is removed (CC-M-001-004); this upsert
+    // is the single source of pendingBalance credit, matching what processSettlement
+    // decrements, so the ledger nets to zero after settlement.
+    await tx.labWallet.upsert({
+      where: { labId: order.lab.id },
+      update: { pendingBalance: { increment: platformFee } },
+      create: { labId: order.lab.id, pendingBalance: platformFee },
+    })
+
+    return null
   })
 
   if (result !== null) return result
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/action.ts
+++ b/src/features/orders/lab-fulfillment/action.ts
@@ -1,4 +1,4 @@
     const COMMISSION_RATE = new Decimal('0.1000')
+    // Hardcoded at 10 % (AD-001 MVP rate). Payout.feePercentage stores the
+    // applied rate for historical accuracy if the rate changes in the future.
     const grossAmount = transaction.amount
     const platformFee = grossAmount.mul(COMMISSION_RATE)
     const netAmount = grossAmount.sub(platformFee)
@@ -1,5 +1,8 @@
     await tx.payout.create({ ... })
+
+    // Credit LabWallet.pendingBalance with platformFee — PipetGo's 10 % commission.
+    // LabWallet is PipetGo's income ledger per lab, not lab escrow.
+    // platformFee (not netAmount) is the ledger figure. (ref: DL-001)
+    // Credited at Payout-QUEUED creation time so processSettlement can decrement atomically
+    // at settlement without a zero-pendingBalance window. (ref: DL-002)
     await tx.labWallet.upsert({

```


**CC-M-001-002** (src/features/orders/lab-fulfillment/README.md) - implements CI-M-001-002

**Code:**

```diff
--- a/src/features/orders/lab-fulfillment/README.md
+++ b/src/features/orders/lab-fulfillment/README.md
@@ -38,6 +38,10 @@
   completeOrder:
     -> TOCTOU re-fetch: re-verify ownership + status (DL-007)
     -> isValidStatusTransition(IN_PROGRESS, COMPLETED)
-    -> prisma.order.update status = COMPLETED, notes = formData.notes (DL-003)
-    -> revalidatePath then redirect('/dashboard/lab') (DL-006)
+    -> prisma.order.update status = COMPLETED, notes = formData.notes (DL-003)
+    -> tx.transaction.findFirst (CAPTURED) — returns null for FIXED-mode (no Payout created)
+    -> tx.payout.create status=QUEUED, platformFee=grossAmount*0.10, netAmount=gross-fee
+    -> revalidatePath then redirect('/dashboard/lab') (DL-006)
 
 ## Design Decisions
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/README.md
+++ b/src/features/orders/lab-fulfillment/README.md
@@ -1,4 +1,5 @@
-    -> tx.payout.create status=QUEUED, platformFee=grossAmount*0.10, netAmount=gross-fee
-    -> revalidatePath then redirect('/dashboard/lab') (DL-006)
+    -> tx.payout.create status=QUEUED, platformFee=grossAmount*0.10, netAmount=gross-fee
+    -> tx.labWallet.upsert pendingBalance += platformFee (PipetGo commission ledger; not lab escrow)
+       Atomically inside the same $transaction as Payout.create. (ref: DL-002)
+    -> revalidatePath then redirect('/dashboard/lab') (DL-006)

```


**CC-M-001-003** (src/features/orders/lab-fulfillment/__tests__/action.test.ts) - implements CI-M-001-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/orders/lab-fulfillment/__tests__/action.test.ts
@@ -0,0 +1,155 @@
+import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
+import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
+import { Decimal } from '@prisma/client/runtime/library'
+import { testPrisma } from '@/test/test-prisma'
+import { completeOrder } from '../action'
+
+vi.mock('@/lib/prisma', async () => {
+  const { testPrisma: client } = await import('@/test/test-prisma')
+  return { prisma: client }
+})
+
+vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
+vi.mock('next/navigation', () => ({ redirect: vi.fn() }))
+
+const TEST_USER_CLIENT_ID = 'test-lf-client-1'
+const TEST_USER_LAB_ID = 'test-lf-lab-user-1'
+const TEST_LAB_ID = 'test-lf-lab-1'
+const TEST_SERVICE_ID = 'test-lf-svc-1'
+const TEST_ORDER_ID_1 = 'test-lf-order-1'
+const TEST_ORDER_ID_2 = 'test-lf-order-2'
+const TEST_TX_ID_1 = 'test-lf-tx-1'
+const TEST_TX_ID_2 = 'test-lf-tx-2'
+const TEST_TX_EXT_1 = 'xendit-lf-ext-1'
+const TEST_TX_EXT_2 = 'xendit-lf-ext-2'
+
+async function cleanup() {
+  await testPrisma.payout.deleteMany({ where: { orderId: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
+  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
+  await testPrisma.transaction.deleteMany({ where: { id: { in: [TEST_TX_ID_1, TEST_TX_ID_2] } } })
+  await testPrisma.order.deleteMany({ where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
+  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
+  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
+  await testPrisma.user.deleteMany({ where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } } })
+}
+
+async function seedBase() {
+  await testPrisma.user.createMany({
+    data: [
+      { id: TEST_USER_CLIENT_ID, email: 'lf-client@test.local', role: UserRole.CLIENT },
+      { id: TEST_USER_LAB_ID, email: 'lf-lab@test.local', role: UserRole.LAB_ADMIN },
+    ],
+    skipDuplicates: true,
+  })
+  await testPrisma.lab.upsert({
+    where: { id: TEST_LAB_ID },
+    update: {},
+    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab LF' },
+  })
+  await testPrisma.labService.upsert({
+    where: { id: TEST_SERVICE_ID },
+    update: {},
+    create: {
+      id: TEST_SERVICE_ID,
+      labId: TEST_LAB_ID,
+      name: 'Test Service LF',
+      category: ServiceCategory.CHEMICAL_TESTING,
+      pricingMode: PricingMode.FIXED,
+    },
+  })
+}
+
+vi.mock('@/lib/auth', () => ({
+  auth: vi.fn().mockResolvedValue({
+    user: { id: TEST_USER_LAB_ID, role: 'LAB_ADMIN' },
+  }),
+}))
+
+beforeEach(async () => {
+  await cleanup()
+  await seedBase()
+})
+
+afterAll(async () => {
+  await cleanup()
+  await testPrisma.$disconnect()
+})
+
+describe('completeOrder — Payout and LabWallet writes', () => {
+  it('creates Payout(QUEUED) and LabWallet.pendingBalance on first order completion', async () => {
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_1,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.IN_PROGRESS,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: TEST_TX_ID_1,
+        orderId: TEST_ORDER_ID_1,
+        externalId: TEST_TX_EXT_1,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.CAPTURED,
+        capturedAt: new Date(),
+      },
+    })
+
+    const formData = new FormData()
+    formData.set('orderId', TEST_ORDER_ID_1)
+
+    await completeOrder(null, formData)
+
+    const order = await testPrisma.order.findUnique({ where: { id: TEST_ORDER_ID_1 } })
+    expect(order!.status).toBe(OrderStatus.COMPLETED)
+
+    const payout = await testPrisma.payout.findFirst({ where: { orderId: TEST_ORDER_ID_1 } })
+    expect(payout).not.toBeNull()
+    expect(payout!.status).toBe(PayoutStatus.QUEUED)
+    expect(payout!.externalPayoutId).toBeNull()
+    const gross = new Decimal('1500.00')
+    const fee = gross.mul(new Decimal('0.1000'))
+    expect(payout!.platformFee.toFixed(2)).toBe(fee.toFixed(2))
+    expect(payout!.netAmount.toFixed(2)).toBe(gross.sub(fee).toFixed(2))
+
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet).not.toBeNull()
+    expect(wallet!.pendingBalance.toFixed(2)).toBe(fee.toFixed(2))
+  })
+
+  it('increments LabWallet.pendingBalance on second order completion for the same lab', async () => {
+    const fee = new Decimal('1500.00').mul(new Decimal('0.1000'))
+    await testPrisma.labWallet.create({
+      data: { labId: TEST_LAB_ID, pendingBalance: fee.toString() },
+    })
+    await testPrisma.order.create({
+      data: {
+        id: TEST_ORDER_ID_2,
+        clientId: TEST_USER_CLIENT_ID,
+        labId: TEST_LAB_ID,
+        serviceId: TEST_SERVICE_ID,
+        status: OrderStatus.IN_PROGRESS,
+        quantity: 1,
+      },
+    })
+    await testPrisma.transaction.create({
+      data: {
+        id: TEST_TX_ID_2,
+        orderId: TEST_ORDER_ID_2,
+        externalId: TEST_TX_EXT_2,
+        provider: 'xendit',
+        amount: '1500.00',
+        status: TransactionStatus.CAPTURED,
+        capturedAt: new Date(),
+      },
+    })
+
+    const formData = new FormData()
+    formData.set('orderId', TEST_ORDER_ID_2)
+
+    await completeOrder(null, formData)
+
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.pendingBalance.toFixed(2)).toBe(fee.add(fee).toFixed(2))
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/orders/lab-fulfillment/__tests__/action.test.ts
+++ b/src/features/orders/lab-fulfillment/__tests__/action.test.ts
@@ -1,3 +1,8 @@
+/**
+ * Integration tests for completeOrder — Payout and LabWallet.pendingBalance atomicity.
+ * Validates the M-0 invariant: pendingBalance must be credited at Payout-QUEUED creation
+ * time so processSettlement can decrement atomically without a zero-balance window.
+ * Real DB (testPrisma) required for Decimal arithmetic and FK constraint validation. (ref: DL-011)
+ */
 import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

```


**CC-M-001-004** (src/features/payments/webhooks/handlers.ts) - implements CI-M-001-004

**Code:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -73,23 +73,7 @@
     // Delegates Order.status transition to orders slice — ADR-001 fan-out pattern. (ref: DL-001)
     await handlePaymentCaptured(event, tx)
 
-    // Fetch Order for labId — Order.labId is non-nullable; same-tx fetch is read-consistent. (ref: DL-004)
-    // Order is fetched twice per transaction (once in handlePaymentCaptured, once here) — accepted at MVP scale.
-    const order = await tx.order.findUnique({
-      where: { id: transaction.orderId },
-      select: { labId: true },
-    })
-
-    if (!order) {
-      throw new Error(`Order not found for orderId ${transaction.orderId} during LabWallet credit`)
-    }
-
-    // Credit LabWallet.pendingBalance — upsert creates on first payment, increments on subsequent.
-    // Uses Transaction.amount (Decimal) not payload float. (ref: DL-002, DL-003, DL-005)
-    // labId @unique (schema:299) + $transaction row lock makes this race-free under concurrent delivery.
-    await tx.labWallet.upsert({
-      where: { labId: order.labId },
-      update: { pendingBalance: { increment: transaction.amount } },
-      create: { labId: order.labId, pendingBalance: transaction.amount },
-    })
   })
 }
```

**Documentation:**

```diff
--- a/src/features/payments/webhooks/handlers.ts
+++ b/src/features/payments/webhooks/handlers.ts
@@ -1,3 +1,4 @@
     await handlePaymentCaptured(event, tx)
+    // LabWallet.pendingBalance is credited at Payout-QUEUED creation time in
+    // lab-fulfillment/action.ts (completeOrder). Crediting at capture time would
+    // use Transaction.amount (gross) rather than Payout.platformFee (commission share),
+    // producing an incorrect ledger figure. (ref: DL-001, DL-002)
   })

```


### Milestone 2: M-1 — Settlement slice + app-router re-export + integration and rollback tests

**Files**: src/features/payments/payouts/route.ts, src/features/payments/payouts/handlers.ts, src/features/payments/payouts/types.ts, src/features/payments/payouts/README.md, src/features/payments/payouts/CLAUDE.md, src/features/payments/payouts/__tests__/handlers.test.ts, src/features/payments/payouts/__tests__/handlers-rollback.test.ts, src/app/api/webhooks/xendit-settlement/route.ts, src/features/payments/CLAUDE.md

**Acceptance Criteria**:

- ["AC-001: POST /api/webhooks/xendit-settlement returns 401 when x-callback-token does not match XENDIT_SETTLEMENT_WEBHOOK_TOKEN
- and 500 when the env var is missing."
- "AC-002: First delivery of a settlement webhook (payload.id
- payload.external_id matching a QUEUED Payout) results in Payout.status=COMPLETED
- Payout.externalPayoutId=payload.id
- Payout.completedAt set
- LabWallet.pendingBalance decremented by Payout.platformFee
- LabWallet.availableBalance incremented by Payout.platformFee — all in one $transaction (verified by integration test in handlers.test.ts)."
- "AC-003: Duplicate delivery (Payout already COMPLETED with externalPayoutId=payload.id) returns 200 with no DB writes (verified by integration test)."
- "AC-004: Orphan delivery (no Payout matching either externalPayoutId or orderId-with-QUEUED) returns 200 with no DB writes (verified by integration test)."
- "AC-005: Negative-balance precondition throws and rolls back the entire $transaction; Payout.status remains QUEUED and LabWallet unchanged (verified by integration test)."
- "AC-006 (pre-merge sandbox verification gate
- mitigates R-001/R-002/R-003): Before squash-merging the T-10 PR
- trigger one real Xendit settlement event in sandbox against the staging-registered settlement webhook URL; capture the JSON payload and HTTP headers; confirm field names id/status/amount/external_id match XenditSettlementPayload OR update types.ts + handlers.ts + tests in the same PR; confirm the status string value matches SETTLEMENT_STATUS_COMPLETED constant OR update the constant; confirm the auth header is x-callback-token OR update route.ts auth. Sandbox payload sample committed to docs/research/xendit-settlement-sandbox-payload.json before merge."
- "AC-007 (pre-merge dormancy verification
- mitigates R-004): Before merge
- check the Xendit dashboard for the production account: enumerate any existing Managed Sub-Account registrations and any settlement webhook URLs already registered. If any settlement webhook is registered (sandbox or production)
- document the registration in the slice README Production Wiring section before merge so the handler activating on deploy is an expected outcome
- not a surprise."
- "AC-008: TypeScript compile clean (npx tsc --noEmit) and ESLint domain-boundary rule passes (npx eslint src/) before opening PR."]

#### Code Intent

- **CI-M-002-001** `src/features/payments/payouts/types.ts`: Export interface XenditSettlementPayload with fields: id (string — Xendit settlement transfer ID, maps to Payout.externalPayoutId via @unique); status (string — case-normalized uppercase, expected values COMPLETED/SUCCEEDED case TBD per sandbox verification); amount (number — Xendit settlement gross, used for logging only, not for ledger math); external_id (string — the orderId we send to Xendit at sub-account invoice creation time, maps to Payout.orderId for first-time lookup). Add TODO comment flagging each field for verification against Xendit sandbox before merge. The exact field name for orderId in Xendit settlement payloads is provisionally external_id mirroring the invoice webhook convention. Mirror the single-file type-contract convention from src/features/payments/webhooks/types.ts. (refs: DL-010)
- **CI-M-002-002** `src/features/payments/payouts/route.ts`: Next.js POST handler. Read env XENDIT_SETTLEMENT_WEBHOOK_TOKEN — return 500 if missing (surfaces misconfiguration before token comparison, matching webhooks/route.ts pattern). Read x-callback-token header, Buffer-compare via crypto.timingSafeEqual with equal-length precondition check; mismatch returns 401. Parse JSON body cast to XenditSettlementPayload. Uppercase-normalize payload.status. Empty status throws. Surface the dispatch literal as a module-level named constant: const SETTLEMENT_STATUS_COMPLETED = "COMPLETED"; // TODO(sandbox-verify): confirm Xendit settlement status string is COMPLETED (could be SUCCEEDED or other value — see R-002 in plan and AC-006 pre-merge gate). Dispatch on status: if (status === SETTLEMENT_STATUS_COMPLETED) -> call processSettlement(payload); any other non-empty status is acknowledged-without-processing (200, console.info log including payload.status so unexpected values are visible in staging). $transaction errors propagate as 500 so Xendit retries. No auth() call — webhook is server-to-server with the static token as sole credential. Console.info logs payload.id and status at entry and at each dispatch arm, mirroring webhooks/route.ts log shape. (refs: DL-006, DL-010)
- **CI-M-002-003** `src/features/payments/payouts/handlers.ts`: Export async function processSettlement(payload: XenditSettlementPayload): Promise<void>. Wrap all DB work in prisma.$transaction(async (tx) => {...}). Step 1: tx.payout.findUnique({where:{externalPayoutId: payload.id}}) — if found and status=COMPLETED, return early (idempotent duplicate delivery); if found and status in {PROCESSING, FAILED}, throw new Error (contract violation per Implementation Discipline, grounded in PayoutStatus enum prisma/schema.prisma:54-58); if found and status=QUEUED proceed to step 3 with this Payout. Step 2 (only if findUnique returned null): tx.payout.findFirst({where:{orderId: payload.external_id, status: PayoutStatus.QUEUED, externalPayoutId: null}}) — externalPayoutId:null filter excludes any historical Payouts already settled (state-machine safety per DL-005); if null, return early (orphan tolerance, Xendit may deliver for non-PipetGo settlements). Step 2.5: tx.labWallet.findUnique({where:{labId: payout.labId}}) — explicit wallet read; if null, throw new Error(`LabWallet missing for lab ${payout.labId} — M-0 invariant violated`) so the contract violation (Payout existing without its LabWallet row) surfaces with a typed message instead of an opaque Prisma update-not-found error. Step 3: compute newPending = currentWallet.pendingBalance.sub(payout.platformFee). If newPending.isNegative() throw new Error(`LabWallet.pendingBalance would go negative for lab ${payout.labId}: current=${currentWallet.pendingBalance} debit=${payout.platformFee}`). Step 4: tx.payout.update({where:{id: payout.id}, data:{status: COMPLETED, externalPayoutId: payload.id, completedAt: new Date()}}) — sets externalPayoutId only when it was null (first delivery). Step 5: tx.labWallet.update({where:{labId: payout.labId}, data:{pendingBalance:{decrement: payout.platformFee}, availableBalance:{increment: payout.platformFee}}}) — both deltas in one update call so PostgreSQL applies them atomically; uses Prisma Decimal increment/decrement, no Number coercion. NO upsert here: M-0 guarantees LabWallet row exists by Payout-creation time; absence throws via Step 2.5 with a typed error. All console.info messages match the webhooks/handlers.ts log shape (payload.id at entry, idempotent no-op log, orphan tolerance log). (refs: DL-001, DL-004, DL-005, DL-007, DL-008, DL-009)
- **CI-M-002-004** `src/app/api/webhooks/xendit-settlement/route.ts`: App-router wiring. Single export: export { POST } from "@/features/payments/payouts/route". Mirrors src/app/api/webhooks/xendit/route.ts pattern — keeps Next.js convention in app/ and business logic in the feature slice. (refs: DL-003)
- **CI-M-002-005** `src/features/payments/payouts/__tests__/handlers.test.ts`: Integration tests against testPrisma (real DB via DATABASE_TEST_URL), mirroring webhooks/__tests__/handlers.test.ts structure: vi.mock @/lib/prisma to return testPrisma; beforeEach cleanup+seedBase (user, lab, labService); afterAll cleanup+disconnect. Scenarios: (1) first delivery — seed Order(COMPLETED) + CAPTURED Transaction + Payout(QUEUED, externalPayoutId=null, platformFee=150.00, netAmount=1350.00) + LabWallet(pendingBalance=150.00, availableBalance=0); call processSettlement with payload {id: ext-settle-1, status: COMPLETED, external_id: orderId}; assert Payout.status=COMPLETED, Payout.externalPayoutId=ext-settle-1, Payout.completedAt not null, LabWallet.pendingBalance=0.00, LabWallet.availableBalance=150.00. (2) idempotent duplicate — seed Payout with status=COMPLETED, externalPayoutId already=ext-settle-2, LabWallet.availableBalance=300.00; call processSettlement with same id; assert no DB change (Payout.updatedAt unchanged, LabWallet unchanged). (3) orphan tolerance — call processSettlement with id and external_id matching no rows; assert resolves without throw and no rows created or mutated. (4) negative-balance guard — seed Payout(QUEUED, platformFee=500.00) + LabWallet(pendingBalance=200.00) (deliberately under-credited); call processSettlement; assert rejects with Error matching /negative/ AND assert no Payout.status change AND no LabWallet change (atomicity). (5) PROCESSING contract violation — seed Payout(status=PROCESSING, externalPayoutId=ext-settle-5); call processSettlement; assert rejects with Error matching /contract/ or /PROCESSING/. All Decimal assertions use .toFixed(2) string equality to surface scale mismatches. (refs: DL-004, DL-005, DL-007, DL-008, DL-009, DL-011)
- **CI-M-002-006** `src/features/payments/payouts/__tests__/handlers-rollback.test.ts`: Full Prisma mock test mirroring webhooks/__tests__/handlers-rollback.test.ts. vi.fn stubs for tx.payout.findUnique (returns a QUEUED Payout), tx.labWallet.findUnique (returns a wallet with sufficient pendingBalance), tx.payout.update (resolves), and tx.labWallet.update (rejects with Error wallet-update-failure). vi.mock @/lib/prisma so prisma.$transaction invokes callback with the mock tx. Assert processSettlement rejects with that error message — confirms error propagation that triggers Prisma rollback. Second test: tx.payout.update rejects; assert processSettlement rejects with that error. This file isolates the cases where forcing the failure on a real DB would require schema breakage. (refs: DL-011)
- **CI-M-002-007** `src/features/payments/payouts/README.md`: Slice-level documentation. Sections: (1) Request flow — POST to /api/webhooks/xendit-settlement; x-callback-token via timingSafeEqual against XENDIT_SETTLEMENT_WEBHOOK_TOKEN; status switch dispatches COMPLETED -> processSettlement. (2) Settlement handler steps — findUnique by externalPayoutId for duplicates, findFirst by orderId+QUEUED for first delivery, balance-never-negative throw, atomic Payout update + LabWallet pendingBalance decrement / availableBalance increment. (3) AD-001 framing — LabWallet is PipetGo commission ledger per lab; figure moving through pending/available is Payout.platformFee (PipetGo commission), not Payout.netAmount (cross-reference DL-001). (4) Two-ID scheme — payload.id maps to Payout.externalPayoutId (settlement key); payload.external_id maps to Payout.orderId (first-delivery key). (5) Idempotency — duplicate detection by Payout.externalPayoutId @unique + status guard; same dual-purpose lookup as webhook capture. (6) Invariants — $transaction atomicity; pendingBalance never negative; PROCESSING/FAILED never written by this handler; LabWallet existence pre-guaranteed by completeOrder (M-0). (7) Required env: XENDIT_SETTLEMENT_WEBHOOK_TOKEN. Missing returns 500. (8) Test strategy — same split as webhooks slice: real DB for ledger correctness; full mock for rollback. (9) Production wiring note — checkout currently issues regular Xendit invoices (not sub-account split invoices); this handler is dormant until a later checkout-migration ticket configures sub-account invoices in src/features/payments/checkout/action.ts. (10) Xendit payload shape verification — flag fields in types.ts as TBD pending sandbox verification before merge. (refs: DL-001, DL-003, DL-004, DL-006, DL-009, DL-010, DL-012)
- **CI-M-002-008** `src/features/payments/payouts/CLAUDE.md`: Per-slice CLAUDE.md index following the established pattern (cf. src/features/payments/webhooks/CLAUDE.md). Heading: payouts/ — Xendit commission settlement webhook slice. One-line slice purpose. Table with columns File | What (WHAT) | Read When (WHEN). Rows: route.ts (Next.js POST; x-callback-token; status dispatch | modifying auth or adding new settlement statuses); handlers.ts (processSettlement — Payout QUEUED -> COMPLETED, LabWallet pending->available transfer | modifying settlement logic or balance invariants); types.ts (XenditSettlementPayload | adding fields from Xendit payload); README.md (request flow, AD-001 framing, two-ID scheme, invariants | understanding settlement lifecycle or debugging); __tests__/handlers.test.ts (real-DB integration: idempotency, orphan tolerance, negative-balance, contract-violation | running or modifying settlement integration tests); __tests__/handlers-rollback.test.ts (full-mock rollback propagation | running or modifying rollback tests). (refs: DL-003)
- **CI-M-002-009** `src/features/payments/CLAUDE.md`: Add a row to the Subdirectories table for the payouts/ slice. Row: payouts/ | Xendit settlement webhook — confirms commission split settled into PipetGo account, transitions Payout QUEUED -> COMPLETED, moves Payout.platformFee from LabWallet.pendingBalance to availableBalance; integration tests in payouts/__tests__/ | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests. Position the row alphabetically after checkout/ and before webhooks/. No other content changes. (refs: DL-003)

#### Code Changes

**CC-M-002-001** (src/features/payments/payouts/types.ts) - implements CI-M-002-001

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/types.ts
@@ -0,0 +1,26 @@
+/**
+ * Shape of the Xendit sub-account split settlement webhook payload.
+ * Shared by route.ts (parse + cast) and handlers.ts (process).
+ *
+ * TODO(sandbox-verify): All field names and values below are provisional.
+ * Verify against Xendit sub-account settlement webhook documentation and sandbox
+ * before merging this slice into production traffic.
+ */
+export interface XenditSettlementPayload {
+  /** Xendit settlement transfer ID — maps to Payout.externalPayoutId via @unique. */
+  // TODO(sandbox-verify): confirm this field is named "id" in the settlement payload.
+  id: string
+
+  /** Settlement status — case-normalized to uppercase before dispatch. */
+  // TODO(sandbox-verify): confirm whether Xendit uses "COMPLETED" or "SUCCEEDED" for a settled split.
+  status: string
+
+  /** Gross settlement amount from Xendit. Used for logging only — ledger math uses Payout.platformFee. */
+  // TODO(sandbox-verify): confirm field name is "amount" and unit (PHP centavos vs pesos).
+  amount: number
+
+  /** The orderId we sent to Xendit at sub-account invoice creation time. Used for first-delivery Payout lookup. */
+  // TODO(sandbox-verify): confirm this field is named "external_id" mirroring the invoice webhook convention.
+  external_id: string
+}
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/types.ts
+++ b/src/features/payments/payouts/types.ts
@@ -1,4 +1,9 @@
-/**
- * Shape of the Xendit sub-account split settlement webhook payload.
- * Shared by route.ts (parse + cast) and handlers.ts (process).
- *
- * TODO(sandbox-verify): All field names and values below are provisional.
- * Verify against Xendit sub-account settlement webhook documentation and sandbox
- * before merging this slice into production traffic.
- */
+/**
+ * Shape of the Xendit sub-account split settlement webhook payload.
+ * Shared by route.ts (parse + cast) and handlers.ts (process).
+ *
+ * Field names and values are provisional — assumed from Xendit invoice webhook
+ * conventions (docs/research/Payment-Processor-eval-PipetGo.md). Each field
+ * carries a per-field TODO(AC-006) comment; all must be confirmed against the
+ * Xendit sub-account settlement sandbox before merge. (ref: DL-010)
+ */
+export interface XenditSettlementPayload {
+  /** Xendit settlement transfer ID — maps to Payout.externalPayoutId (@unique). */
+  // TODO(AC-006): confirm Xendit settlement payload field is named "id". (ref: R-001)
+  id: string
+
+  /** Settlement status — uppercase-normalized before route.ts dispatch. */
+  // TODO(AC-006): confirm Xendit settlement status string is "COMPLETED" not "SUCCEEDED". (ref: R-002)
+  status: string
+
+  /** Gross settlement amount. Used for logging only; ledger math uses Payout.platformFee. */
+  // TODO(AC-006): confirm field name is "amount" and whether unit is PHP pesos or centavos. (ref: R-001)
+  amount: number
+
+  /** orderId sent to Xendit at sub-account invoice creation — first-delivery Payout lookup key. */
+  // TODO(AC-006): confirm Xendit settlement payload field is named "external_id". (ref: R-001)
+  external_id: string
+}

```


**CC-M-002-002** (src/features/payments/payouts/route.ts) - implements CI-M-002-002

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/route.ts
@@ -0,0 +1,57 @@
+/**
+ * Xendit sub-account settlement webhook POST handler.
+ *
+ * Authenticates via x-callback-token header (static token, not HMAC).
+ * COMPLETED dispatches to processSettlement; unknown statuses are acknowledged without processing.
+ * Missing or empty status throws so Xendit retries.
+ *
+ * $transaction errors propagate as 500 to trigger Xendit's automatic retry.
+ * No auth() call — webhook is server-to-server; token header is the only credential.
+ */
+import { NextRequest, NextResponse } from 'next/server'
+import crypto from 'crypto'
+import { processSettlement } from './handlers'
+import type { XenditSettlementPayload } from './types'
+
+// TODO(sandbox-verify): confirm Xendit settlement status string is COMPLETED
+// (could be SUCCEEDED or other value — see R-002 in plan and AC-006 pre-merge gate).
+const SETTLEMENT_STATUS_COMPLETED = 'COMPLETED'
+
+export async function POST(req: NextRequest): Promise<NextResponse> {
+  const expected = process.env.XENDIT_SETTLEMENT_WEBHOOK_TOKEN
+  if (!expected) {
+    return NextResponse.json({ error: 'Webhook token not configured.' }, { status: 500 })
+  }
+
+  const token = req.headers.get('x-callback-token') ?? ''
+  const tokenBuf = Buffer.from(token)
+  const expectedBuf = Buffer.from(expected)
+  // Buffer length check required before timingSafeEqual — equal-length is a precondition.
+  // timingSafeEqual prevents timing attacks on constant-time comparison.
+  const tokensMatch =
+    tokenBuf.length === expectedBuf.length &&
+    crypto.timingSafeEqual(tokenBuf, expectedBuf)
+
+  if (!tokensMatch) {
+    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })
+  }
+
+  const payload = (await req.json()) as XenditSettlementPayload
+
+  const status = (payload.status ?? '').toUpperCase()
+  console.info(`[settlement-webhook] received payload id=${payload.id} status=${status}`)
+
+  if (status === '') {
+    throw new Error('Xendit settlement webhook missing payload.status')
+  }
+
+  if (status === SETTLEMENT_STATUS_COMPLETED) {
+    console.info(`[settlement-webhook] dispatch to processSettlement id=${payload.id}`)
+    await processSettlement(payload)
+  } else {
+    console.info(`[settlement-webhook] acknowledged-without-processing id=${payload.id} status=${status}`)
+  }
+
+  return NextResponse.json({ received: true })
+}
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/route.ts
+++ b/src/features/payments/payouts/route.ts
@@ -1,2 +1,6 @@
+// TODO(sandbox-verify): confirm Xendit settlement status string is COMPLETED.
+// Could be SUCCEEDED or another variant — payload status is unverified (ref: DL-010, R-002).
+// The constant is named rather than inlined so it is visible at code level; see AC-006 pre-merge gate.
 const SETTLEMENT_STATUS_COMPLETED = 'COMPLETED'
+
+// Auth uses static x-callback-token (crypto.timingSafeEqual) not HMAC-SHA256 —
+// Xendit does not provide HMAC for settlement callbacks (ref: DL-006).
+// XENDIT_SETTLEMENT_WEBHOOK_TOKEN is a separate env var from XENDIT_WEBHOOK_TOKEN
+// so each webhook endpoint can rotate its token independently. (ref: DL-006)

```


**CC-M-002-003** (src/features/payments/payouts/handlers.ts) - implements CI-M-002-003

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/handlers.ts
@@ -0,0 +1,82 @@
+/**
+ * Settlement processor for Xendit sub-account split settlement webhooks.
+ *
+ * processSettlement runs all DB writes inside a single Prisma $transaction.
+ * Any throw at any step rolls back all writes; Xendit retries on 500.
+ */
+import { PayoutStatus } from '@prisma/client'
+import { prisma } from '@/lib/prisma'
+import type { XenditSettlementPayload } from './types'
+
+/**
+ * Transitions a QUEUED Payout to COMPLETED and atomically moves Payout.platformFee
+ * from LabWallet.pendingBalance to LabWallet.availableBalance.
+ *
+ * Idempotent: duplicate delivery (externalPayoutId already set, status COMPLETED) returns early.
+ * Orphan-tolerant: no Payout found for the settlement ID or orderId returns early.
+ * Throws for unexpected Payout statuses (PROCESSING/FAILED) — contract violation.
+ * Throws if LabWallet.pendingBalance would go negative — upstream invariant violated.
+ */
+export async function processSettlement(payload: XenditSettlementPayload): Promise<void> {
+  console.info(`[processSettlement] enter id=${payload.id} external_id=${payload.external_id}`)
+
+  await prisma.$transaction(async (tx) => {
+    // Step 1: idempotency check — look up by externalPayoutId (@unique, Implementation Discipline).
+    let payout = await tx.payout.findUnique({
+      where: { externalPayoutId: payload.id },
+    })
+
+    if (payout) {
+      if (payout.status === PayoutStatus.COMPLETED) {
+        console.info(`[processSettlement] idempotent no-op id=${payload.id}`)
+        return
+      }
+      if (payout.status === PayoutStatus.PROCESSING || payout.status === PayoutStatus.FAILED) {
+        throw new Error(
+          `processSettlement: contract violation — Payout ${payout.id} has status ${payout.status} which is unexpected for settlement id=${payload.id}`,
+        )
+      }
+      // payout.status === QUEUED, externalPayoutId already set — concurrent delivery; proceed.
+    }
+
+    // Step 2: first-delivery lookup — find QUEUED Payout with no externalPayoutId by orderId.
+    // State-machine invariant: completeOrder (T-09) is called exactly once per Order (terminal
+    // COMPLETED transition). At most one QUEUED Payout per orderId can exist with a null
+    // externalPayoutId at any time. findFirst is safe because uniqueness is enforced by the
+    // (orderId, status=QUEUED, externalPayoutId=null) compound predicate plus the state machine.
+    if (!payout) {
+      payout = await tx.payout.findFirst({
+        where: {
+          orderId: payload.external_id,
+          status: PayoutStatus.QUEUED,
+          externalPayoutId: null,
+        },
+      })
+
+      if (!payout) {
+        // Orphan tolerance — Xendit may deliver for settlements not in our DB.
+        console.info(`[processSettlement] orphan tolerance id=${payload.id} external_id=${payload.external_id}`)
+        return
+      }
+    }
+
+    // Step 2.5: explicit wallet read — absence means M-0 invariant was violated.
+    const currentWallet = await tx.labWallet.findUnique({
+      where: { labId: payout.labId },
+    })
+
+    if (!currentWallet) {
+      throw new Error(
+        `LabWallet missing for lab ${payout.labId} — M-0 invariant violated: no LabWallet row exists for a lab with a QUEUED Payout`,
+      )
+    }
+
+    // Step 3: negative-balance guard — throw on contract violation, never clamp.
+    const newPending = currentWallet.pendingBalance.sub(payout.platformFee)
+    if (newPending.isNegative()) {
+      throw new Error(
+        `LabWallet.pendingBalance would go negative for lab ${payout.labId}: current=${currentWallet.pendingBalance} debit=${payout.platformFee}`,
+      )
+    }

+    // Step 4: mark Payout COMPLETED; externalPayoutId=null guard prevents double-settlement
+    // under concurrent first-delivery: if two requests reach this point simultaneously,
+    // only the first update matches (externalPayoutId still null); the second throws
+    // RecordNotFound, rolling back the transaction. Xendit retries the loser, which then
+    // finds the COMPLETED Payout in Step 1 and returns early.
+    await tx.payout.update({
+      where: { id: payout.id, externalPayoutId: null },
+      data: {
+        status: PayoutStatus.COMPLETED,
+        externalPayoutId: payload.id,
+        completedAt: new Date(),
+      },
+    })

+    // Step 5: atomic balance move — both deltas in one update call.
+    await tx.labWallet.update({
+      where: { labId: payout.labId },
+      data: {
+        pendingBalance: { decrement: payout.platformFee },
+        availableBalance: { increment: payout.platformFee },
+      },
+    })
+  })
+}
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/handlers.ts
+++ b/src/features/payments/payouts/handlers.ts
@@ -1,6 +1,6 @@
-    // Step 2: first-delivery lookup — find QUEUED Payout with no externalPayoutId by orderId.
-    // State-machine invariant: completeOrder (T-09) is called exactly once per Order (terminal
-    // COMPLETED transition). At most one QUEUED Payout per orderId can exist with a null
-    // externalPayoutId at any time. findFirst is safe because uniqueness is enforced by the
-    // (orderId, status=QUEUED, externalPayoutId=null) compound predicate plus the state machine.
+    // Step 2: first-delivery lookup — find QUEUED Payout with no externalPayoutId by orderId. (ref: DL-005)
+    // State-machine invariant: completeOrder (T-09) is called exactly once per Order (terminal
+    // COMPLETED transition). At most one QUEUED Payout per orderId can exist with a null
+    // externalPayoutId at any time. findFirst is safe here because uniqueness is enforced by the
+    // (orderId, status=QUEUED, externalPayoutId=null) compound predicate + state machine, not a
+    // single column — Implementation Discipline's findUnique-on-@unique rule does not apply.
     if (!payout) {
@@ -1,3 +1,5 @@
-      if (!payout) {
+      if (!payout) {
         // Orphan tolerance — Xendit may deliver for settlements not in our DB.
+        // Return 200 so Xendit does not retry indefinitely. Mirrors processPaymentCapture
+        // orphan-tolerance pattern. (ref: DL-009)
         console.info(`[processSettlement] orphan tolerance id=${payload.id} external_id=${payload.external_id}`)
@@ -1,5 +1,9 @@
     // Step 2.5: explicit wallet read — absence means M-0 invariant was violated.
+    // findUnique on labId (@unique per schema.prisma:299) per Implementation Discipline. (ref: R-005)
+    // Explicit read throws a typed Error instead of relying on an opaque Prisma update-not-found error.
     const currentWallet = await tx.labWallet.findUnique({
       where: { labId: payout.labId },
     })

     if (!currentWallet) {
       throw new Error(
-        `LabWallet missing for lab ${payout.labId} — M-0 invariant violated: no LabWallet row exists for a lab with a QUEUED Payout`,
+        `LabWallet missing for lab ${payout.labId}: Payout exists without LabWallet row — M-0 invariant violated`,
       )
     }

-    // Step 3: negative-balance guard — throw on contract violation, never clamp.
+    // Step 3: negative-balance guard — throw on contract violation, never clamp. (ref: DL-007)
+    // Negative result means M-0 credit was missed or idempotency guard was bypassed.
+    // Clamping hides the bug and corrupts the ledger silently per Implementation Discipline.
     const newPending = currentWallet.pendingBalance.sub(payout.platformFee)
     if (newPending.isNegative()) {
       throw new Error(
         `LabWallet.pendingBalance would go negative for lab ${payout.labId}: current=${currentWallet.pendingBalance} debit=${payout.platformFee}`,
       )
     }
@@ -1,5 +1,7 @@
+    // PROCESSING and FAILED are contract violations — no current slice writes these on the
+    // settlement path. Encountering them means another writer mutated Payout outside the
+    // documented flow. Throw per Implementation Discipline (unhandled enum branches must throw). (ref: DL-008)
     if (payout.status === PayoutStatus.PROCESSING || payout.status === PayoutStatus.FAILED) {
       throw new Error(
         `processSettlement: contract violation — Payout ${payout.id} has status ${payout.status} which is unexpected for settlement id=${payload.id}`,
       )
     }

```


**CC-M-002-004** (src/app/api/webhooks/xendit-settlement/route.ts) - implements CI-M-002-004

**Code:**

```diff
--- /dev/null
+++ b/src/app/api/webhooks/xendit-settlement/route.ts
@@ -0,0 +1,2 @@
+// App Router wiring — logic lives in src/features/payments/payouts/route.ts.
+export { POST } from '@/features/payments/payouts/route'
```

**Documentation:**

```diff
--- a/src/app/api/webhooks/xendit-settlement/route.ts
+++ b/src/app/api/webhooks/xendit-settlement/route.ts
@@ -1,2 +1,4 @@
-// App Router wiring — logic lives in src/features/payments/payouts/route.ts.
+// App Router wiring for Xendit settlement webhook. ADR-001 slice boundary: logic lives
+// in src/features/payments/payouts/route.ts; this file is the app-router entry point only.
+// Separate route from the invoice webhook (src/app/api/webhooks/xendit/) — one route per
+// provider event type keeps slice boundaries clean. (ref: DL-003)
+// Register this URL in the Xendit dashboard as the settlement webhook endpoint.
 export { POST } from '@/features/payments/payouts/route'

```


**CC-M-002-005** (src/features/payments/payouts/__tests__/handlers.test.ts) - implements CI-M-002-005

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/__tests__/handlers.test.ts
@@ -0,0 +1,178 @@
+import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
+import { OrderStatus, TransactionStatus, UserRole, ServiceCategory, PricingMode, PayoutStatus } from '@prisma/client'
+import { testPrisma } from '@/test/test-prisma'
+import { processSettlement } from '../handlers'
+import type { XenditSettlementPayload } from '../types'
+
+vi.mock('@/lib/prisma', async () => {
+  const { testPrisma: client } = await import('@/test/test-prisma')
+  return { prisma: client }
+})
+
+const TEST_USER_CLIENT_ID = 'test-settle-client-1'
+const TEST_USER_LAB_ID = 'test-settle-lab-user-1'
+const TEST_LAB_ID = 'test-settle-lab-1'
+const TEST_SERVICE_ID = 'test-settle-svc-1'
+const TEST_ORDER_ID_1 = 'test-settle-order-1'
+const TEST_ORDER_ID_2 = 'test-settle-order-2'
+const TEST_TX_ID_1 = 'test-settle-tx-1'
+const TEST_TX_EXT_1 = 'xendit-settle-ext-1'
+const TEST_PAYOUT_ID_1 = 'test-settle-payout-1'
+const TEST_PAYOUT_ID_2 = 'test-settle-payout-2'
+const TEST_PAYOUT_ID_3 = 'test-settle-payout-3'
+const TEST_PAYOUT_ID_4 = 'test-settle-payout-4'
+const TEST_PAYOUT_ID_5 = 'test-settle-payout-5'
+const EXT_SETTLE_1 = 'ext-settle-1'
+const EXT_SETTLE_2 = 'ext-settle-2'
+const EXT_SETTLE_5 = 'ext-settle-5'
+
+async function cleanup() {
+  await testPrisma.payout.deleteMany({
+    where: {
+      id: { in: [TEST_PAYOUT_ID_1, TEST_PAYOUT_ID_2, TEST_PAYOUT_ID_3, TEST_PAYOUT_ID_4, TEST_PAYOUT_ID_5] },
+    },
+  })
+  await testPrisma.labWallet.deleteMany({ where: { labId: TEST_LAB_ID } })
+  await testPrisma.transaction.deleteMany({ where: { id: TEST_TX_ID_1 } })
+  await testPrisma.order.deleteMany({ where: { id: { in: [TEST_ORDER_ID_1, TEST_ORDER_ID_2] } } })
+  await testPrisma.labService.deleteMany({ where: { id: TEST_SERVICE_ID } })
+  await testPrisma.lab.deleteMany({ where: { id: TEST_LAB_ID } })
+  await testPrisma.user.deleteMany({ where: { id: { in: [TEST_USER_CLIENT_ID, TEST_USER_LAB_ID] } } })
+}
+
+async function seedBase() {
+  await testPrisma.user.createMany({
+    data: [
+      { id: TEST_USER_CLIENT_ID, email: 'settle-client@test.local', role: UserRole.CLIENT },
+      { id: TEST_USER_LAB_ID, email: 'settle-lab@test.local', role: UserRole.LAB_ADMIN },
+    ],
+    skipDuplicates: true,
+  })
+  await testPrisma.lab.upsert({
+    where: { id: TEST_LAB_ID },
+    update: {},
+    create: { id: TEST_LAB_ID, ownerId: TEST_USER_LAB_ID, name: 'Test Lab Settlement' },
+  })
+  await testPrisma.labService.upsert({
+    where: { id: TEST_SERVICE_ID },
+    update: {},
+    create: {
+      id: TEST_SERVICE_ID,
+      labId: TEST_LAB_ID,
+      name: 'Test Service Settlement',
+      category: ServiceCategory.CHEMICAL_TESTING,
+      pricingMode: PricingMode.FIXED,
+    },
+  })
+  await testPrisma.order.create({
+    data: {
+      id: TEST_ORDER_ID_1,
+      clientId: TEST_USER_CLIENT_ID,
+      labId: TEST_LAB_ID,
+      serviceId: TEST_SERVICE_ID,
+      status: OrderStatus.COMPLETED,
+      quantity: 1,
+    },
+  })
+  await testPrisma.transaction.create({
+    data: {
+      id: TEST_TX_ID_1,
+      orderId: TEST_ORDER_ID_1,
+      externalId: TEST_TX_EXT_1,
+      provider: 'xendit',
+      amount: '1500.00',
+      status: TransactionStatus.CAPTURED,
+    },
+  })
+}
+
+beforeEach(async () => {
+  await cleanup()
+  await seedBase()
+})
+
+afterAll(async () => {
+  await cleanup()
+  await testPrisma.$disconnect()
+})
+
+describe('processSettlement', () => {
+  it('first delivery — transitions Payout QUEUED->COMPLETED and moves platformFee pending->available', async () => {
+    await testPrisma.payout.create({
+      data: {
+        id: TEST_PAYOUT_ID_1,
+        labId: TEST_LAB_ID,
+        orderId: TEST_ORDER_ID_1,
+        transactionId: TEST_TX_ID_1,
+        grossAmount: '1500.00',
+        platformFee: '150.00',
+        netAmount: '1350.00',
+        feePercentage: '0.1000',
+        status: PayoutStatus.QUEUED,
+      },
+    })
+    await testPrisma.labWallet.create({
+      data: { labId: TEST_LAB_ID, pendingBalance: '150.00', availableBalance: '0.00' },
+    })
+
+    const payload: XenditSettlementPayload = {
+      id: EXT_SETTLE_1,
+      status: 'COMPLETED',
+      amount: 1500,
+      external_id: TEST_ORDER_ID_1,
+    }
+
+    await processSettlement(payload)
+
+    const payout = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_1 } })
+    expect(payout!.status).toBe(PayoutStatus.COMPLETED)
+    expect(payout!.externalPayoutId).toBe(EXT_SETTLE_1)
+    expect(payout!.completedAt).not.toBeNull()
+
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.pendingBalance.toFixed(2)).toBe('0.00')
+    expect(wallet!.availableBalance.toFixed(2)).toBe('150.00')
+  })
+
+  it('idempotent duplicate — no DB change when Payout already COMPLETED', async () => {
+    await testPrisma.payout.create({
+      data: {
+        id: TEST_PAYOUT_ID_2,
+        labId: TEST_LAB_ID,
+        orderId: TEST_ORDER_ID_1,
+        transactionId: TEST_TX_ID_1,
+        grossAmount: '1500.00',
+        platformFee: '150.00',
+        netAmount: '1350.00',
+        feePercentage: '0.1000',
+        status: PayoutStatus.COMPLETED,
+        externalPayoutId: EXT_SETTLE_2,
+        completedAt: new Date(),
+      },
+    })
+    await testPrisma.labWallet.create({
+      data: { labId: TEST_LAB_ID, pendingBalance: '0.00', availableBalance: '300.00' },
+    })
+
+    const before = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_2 } })
+
+    const payload: XenditSettlementPayload = {
+      id: EXT_SETTLE_2,
+      status: 'COMPLETED',
+      amount: 1500,
+      external_id: TEST_ORDER_ID_1,
+    }
+
+    await processSettlement(payload)
+
+    const after = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_2 } })
+    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString())
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.availableBalance.toFixed(2)).toBe('300.00')
+  })
+
+  it('orphan tolerance — resolves without throw and no rows created when no Payout matches', async () => {
+    const payload: XenditSettlementPayload = {
+      id: 'ext-settle-orphan',
+      status: 'COMPLETED',
+      amount: 500,
+      external_id: 'non-existent-order-id',
+    }
+
+    await expect(processSettlement(payload)).resolves.not.toThrow()
+  })
+
+  it('negative-balance guard — rejects with Error and makes no DB changes', async () => {
+    await testPrisma.payout.create({
+      data: {
+        id: TEST_PAYOUT_ID_4,
+        labId: TEST_LAB_ID,
+        orderId: TEST_ORDER_ID_1,
+        transactionId: TEST_TX_ID_1,
+        grossAmount: '5000.00',
+        platformFee: '500.00',
+        netAmount: '4500.00',
+        feePercentage: '0.1000',
+        status: PayoutStatus.QUEUED,
+      },
+    })
+    await testPrisma.labWallet.create({
+      data: { labId: TEST_LAB_ID, pendingBalance: '200.00', availableBalance: '0.00' },
+    })
+
+    const payload: XenditSettlementPayload = {
+      id: 'ext-settle-neg',
+      status: 'COMPLETED',
+      amount: 5000,
+      external_id: TEST_ORDER_ID_1,
+    }
+
+    await expect(processSettlement(payload)).rejects.toThrow(/negative/)
+    // Guard fires at Step 3, before any write — Payout.status and LabWallet are unchanged
+    // because no writes were attempted (not because $transaction rolled back).
+    const payout = await testPrisma.payout.findUnique({ where: { id: TEST_PAYOUT_ID_4 } })
+    expect(payout!.status).toBe(PayoutStatus.QUEUED)
+    const wallet = await testPrisma.labWallet.findUnique({ where: { labId: TEST_LAB_ID } })
+    expect(wallet!.availableBalance.toFixed(2)).toBe('0.00')
+  })
+
+  it('PROCESSING contract violation — rejects with Error matching /PROCESSING/', async () => {
+    await testPrisma.payout.create({
+      data: {
+        id: TEST_PAYOUT_ID_5,
+        labId: TEST_LAB_ID,
+        orderId: TEST_ORDER_ID_1,
+        transactionId: TEST_TX_ID_1,
+        grossAmount: '1500.00',
+        platformFee: '150.00',
+        netAmount: '1350.00',
+        feePercentage: '0.1000',
+        status: PayoutStatus.PROCESSING,
+        externalPayoutId: EXT_SETTLE_5,
+      },
+    })
+
+    const payload: XenditSettlementPayload = {
+      id: EXT_SETTLE_5,
+      status: 'COMPLETED',
+      amount: 1500,
+      external_id: TEST_ORDER_ID_1,
+    }
+
+    await expect(processSettlement(payload)).rejects.toThrow(/PROCESSING/)
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/__tests__/handlers.test.ts
+++ b/src/features/payments/payouts/__tests__/handlers.test.ts
@@ -1,3 +1,8 @@
+/**
+ * Integration tests for processSettlement against real test DB (testPrisma + DATABASE_TEST_URL).
+ * Real DB validates Decimal arithmetic, FK constraints, and $transaction atomicity. (ref: DL-011)
+ * Covers: first delivery, idempotent duplicate, orphan tolerance (unknown externalPayoutId),
+ * orphan tolerance (unknown orderId), negative-balance guard, PROCESSING contract violation.
+ */
 import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'

```


**CC-M-002-006** (src/features/payments/payouts/__tests__/handlers-rollback.test.ts) - implements CI-M-002-006

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
@@ -0,0 +1,72 @@
+import { describe, it, expect, vi } from 'vitest'
+import { Decimal } from '@prisma/client/runtime/library'
+import { PayoutStatus } from '@prisma/client'
+
+const mockPayoutFindUnique = vi.fn().mockResolvedValue(null)
+const mockPayoutFindFirst = vi.fn().mockResolvedValue({
+  id: 'mock-payout-id',
+  labId: 'mock-lab-id',
+  orderId: 'mock-order-id',
+  platformFee: new Decimal('150.00'),
+  status: PayoutStatus.QUEUED,
+  externalPayoutId: null,
+})
+const mockWalletFindUnique = vi.fn().mockResolvedValue({
+  labId: 'mock-lab-id',
+  pendingBalance: new Decimal('500.00'),
+  availableBalance: new Decimal('0.00'),
+})
+const mockPayoutUpdate = vi.fn().mockResolvedValue({})
+const mockWalletUpdate = vi.fn().mockRejectedValue(new Error('wallet-update-failure'))
+
+const mockTx = {
+  payout: {
+    findUnique: mockPayoutFindUnique,
+    findFirst: mockPayoutFindFirst,
+    update: mockPayoutUpdate,
+  },
+  labWallet: {
+    findUnique: mockWalletFindUnique,
+    update: mockWalletUpdate,
+  },
+}
+
+vi.mock('@/lib/prisma', () => ({
+  prisma: {
+    $transaction: vi.fn((callback: (tx: typeof mockTx) => Promise<void>) => callback(mockTx)),
+  },
+}))
+
+import { processSettlement } from '../handlers'
+import type { XenditSettlementPayload } from '../types'
+
+const basePayload: XenditSettlementPayload = {
+  id: 'ext-settle-mock',
+  status: 'COMPLETED',
+  amount: 1500,
+  external_id: 'mock-order-id',
+}
+
+describe('processSettlement — rollback error propagation', () => {
+  it('rejects with the wallet update error, confirming error propagation that triggers Prisma rollback', async () => {
+    await expect(processSettlement(basePayload)).rejects.toThrow('wallet-update-failure')
+  })
+
+  it('rejects when payout.update throws, confirming error propagation triggers Prisma rollback', async () => {
+    mockPayoutUpdate.mockRejectedValueOnce(new Error('payout-update-failure'))
+
+    await expect(processSettlement(basePayload)).rejects.toThrow('payout-update-failure')
+  })
+})
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
+++ b/src/features/payments/payouts/__tests__/handlers-rollback.test.ts
@@ -1,3 +1,8 @@
+/**
+ * Rollback error propagation tests using a full Prisma mock. (ref: DL-011)
+ * Real DB cannot exercise rollback isolation without schema-breaking teardown, so mocks
+ * are used for this single concern. Confirms that errors from payout.update and
+ * labWallet.update propagate out of $transaction, causing Xendit to receive 500 and retry.
+ */
 import { describe, it, expect, vi } from 'vitest'

```


**CC-M-002-007** (src/features/payments/payouts/README.md) - implements CI-M-002-007

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/README.md
@@ -0,0 +1,109 @@
+# payments/payouts
+
+Xendit sub-account split settlement webhook slice. When Xendit settles PipetGo's
+commission into PipetGo's account, it fires a settlement event. This slice handles
+that event: looks up the QUEUED Payout by externalPayoutId, marks it COMPLETED, and
+atomically moves Payout.platformFee from LabWallet.pendingBalance to availableBalance.
+
+## AD-001 framing
+
+Under the AD-001 direct payment model, clients pay labs directly via Xendit Managed
+Sub-Accounts. Xendit automatically splits PipetGo's commission at settlement; PipetGo
+never holds the gross. LabWallet is PipetGo's commission ledger per lab — not lab
+escrow. The figure moving through pending/available is Payout.platformFee (PipetGo's
+commission share), not Payout.netAmount (the lab's net).
+
+## Request flow
+
+1. Xendit POSTs settlement payload to `/api/webhooks/xendit-settlement`.
+2. `route.ts` verifies `x-callback-token` header against `XENDIT_SETTLEMENT_WEBHOOK_TOKEN`
+   env var using `crypto.timingSafeEqual`. Returns 401 on mismatch.
+3. `route.ts` normalises `payload.status` to uppercase and dispatches:
+   - `COMPLETED` → `processSettlement` (see `SETTLEMENT_STATUS_COMPLETED` constant)
+   - Other non-empty statuses → acknowledged without processing (200, console.info log)
+   - Empty/missing status → throws (500) so Xendit retries
+4. `handlers.ts:processSettlement` runs a Prisma `$transaction`:
+   - Step 1: `tx.payout.findUnique({ where: { externalPayoutId: payload.id } })` — idempotency.
+     - COMPLETED → return early (duplicate delivery).
+     - PROCESSING or FAILED → throw (contract violation per Implementation Discipline).
+     - QUEUED → proceed with this Payout.
+   - Step 2 (only if Step 1 found nothing): `tx.payout.findFirst({ where: { orderId: payload.external_id, status: QUEUED, externalPayoutId: null } })` — first-delivery lookup.
+     - null → return early (orphan tolerance).
+   - Step 2.5: `tx.labWallet.findUnique({ where: { labId: payout.labId } })` — explicit wallet read.
+     - null → throw with typed message (M-0 invariant violated).
+   - Step 3: compute `newPending = pendingBalance - platformFee`. Negative → throw.
+   - Step 4: `tx.payout.update` — status=COMPLETED, externalPayoutId=payload.id, completedAt=now.
+   - Step 5: `tx.labWallet.update` — pendingBalance decrement + availableBalance increment in one call.
+5. `$transaction` errors propagate as 500 — Xendit retries on non-2xx.
+
+## Two-ID scheme
+
+| Field | Value | Purpose |
+|-------|-------|---------|
+| `payload.id` | Xendit settlement transfer ID | Maps to `Payout.externalPayoutId` — idempotency key |
+| `payload.external_id` | Our orderId sent to Xendit at invoice creation | Maps to `Payout.orderId` — first-delivery lookup key |
+
+## Idempotency
+
+Duplicate detection uses `Payout.externalPayoutId` (`@unique`) as the native idempotency
+key. No separate IdempotencyKey table is needed (Payout already carries the key natively).
+The dual-lookup (Step 1 by externalPayoutId, Step 2 by orderId+QUEUED) handles both
+duplicate deliveries and first deliveries in a single handler path.
+
+## Invariants
+
+- `$transaction` atomicity: Payout.status=COMPLETED and LabWallet balance move are one atomic unit.
+- `pendingBalance` never goes negative: throw on contract violation, never clamp.
+- PROCESSING or FAILED Payouts are never written by this handler — throw on unexpected status.
+- LabWallet existence is pre-guaranteed by `completeOrder` (M-0 patch): absence throws with typed message.
+- `findUnique` on `Payout.externalPayoutId` (@unique) per Implementation Discipline — never `findFirst` on a `@unique` field.
+- No Number coercion on Prisma Decimal values — Prisma Decimal methods only.
+
+## Required env
+
+| Var | Purpose |
+|-----|---------|
+| `XENDIT_SETTLEMENT_WEBHOOK_TOKEN` | Static x-callback-token for Xendit settlement webhook. Missing returns 500. Separate from `XENDIT_WEBHOOK_TOKEN` so both can be rotated independently. |
+
+## Test strategy
+
+Same split as `webhooks/` slice:
+- `__tests__/handlers.test.ts` — real test DB (DATABASE_TEST_URL) for ledger correctness:
+  first delivery, idempotent duplicate, orphan tolerance, negative-balance guard, PROCESSING contract violation.
+- `__tests__/handlers-rollback.test.ts` — full Prisma mock for rollback error propagation.
+
+## Production wiring note
+
+Checkout currently issues regular Xendit invoices (not sub-account split invoices). This
+handler is dormant until a later ticket migrates `src/features/payments/checkout/action.ts`
+to configure sub-account invoices. The webhook route and handler are production-ready;
+only the invoice creation needs updating to enable the settlement flow end-to-end.
+
+## Xendit payload shape verification
+
+All field names in `types.ts` are provisional and marked with `TODO(sandbox-verify)`. Verify
+against Xendit sub-account settlement webhook documentation and sandbox before enabling
+production traffic on this route.
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/README.md
+++ b/src/features/payments/payouts/README.md
@@ -1,3 +1,9 @@
 # payments/payouts
+
+## Production Wiring
+
+Checkout issues regular Xendit invoices (not sub-account split invoices). This handler
+is dormant until a later ticket migrates checkout to Xendit Managed Sub-Account invoices. (ref: DL-012)
+Pre-merge: verify the Xendit dashboard for any existing settlement webhook registrations
+per AC-007. If any exist, document them here before merge.
+
+**AD-001**: LabWallet is PipetGo's commission ledger per lab — not lab escrow.
+The figure moving through pending/available is Payout.platformFee (PipetGo's commission share),
+not Payout.netAmount (the lab's net). (ref: DL-001)
+
+Payout.externalPayoutId (@unique) is the native idempotency key — NULL at QUEUED creation,
+set on first settlement delivery. Duplicate detection uses findUnique on this field; no
+separate IdempotencyKey table is needed. (ref: DL-004)

```


**CC-M-002-008** (src/features/payments/payouts/CLAUDE.md) - implements CI-M-002-008

**Code:**

```diff
--- /dev/null
+++ b/src/features/payments/payouts/CLAUDE.md
@@ -0,0 +1,22 @@
+# payouts/
+
+Xendit commission settlement webhook slice. Receives Xendit sub-account split settlement
+callbacks and atomically transitions Payout QUEUED -> COMPLETED, moving Payout.platformFee
+from LabWallet.pendingBalance to availableBalance.
+
+## Index
+
+| File | What (WHAT) | Read When (WHEN) |
+| ---- | ----------- | ---------------- |
+| `route.ts` | Next.js POST; x-callback-token via timingSafeEqual against XENDIT_SETTLEMENT_WEBHOOK_TOKEN; COMPLETED dispatches to processSettlement | Modifying webhook auth or adding new settlement statuses |
+| `handlers.ts` | `processSettlement` — Payout QUEUED -> COMPLETED; LabWallet pendingBalance decrement + availableBalance increment in one $transaction | Modifying settlement logic or balance invariants |
+| `types.ts` | `XenditSettlementPayload` — provisional field shape; all fields marked TODO(sandbox-verify) | Adding fields from Xendit payload or modifying type contracts |
+| `README.md` | Request flow, AD-001 framing, two-ID scheme, idempotency design, invariants, production wiring note | Understanding settlement lifecycle or debugging |
+| `__tests__/handlers.test.ts` | Real-DB integration: first delivery, idempotent duplicate, orphan tolerance, negative-balance guard, PROCESSING contract violation | Running or modifying settlement integration tests |
+| `__tests__/handlers-rollback.test.ts` | Full-mock rollback error propagation: walletUpdate failure, payoutUpdate failure | Running or modifying rollback tests |
```

**Documentation:**

```diff
--- a/src/features/payments/payouts/CLAUDE.md
+++ b/src/features/payments/payouts/CLAUDE.md
@@ -1,3 +1,18 @@
+# payouts/
+
+Xendit commission settlement webhook slice. Receives Xendit sub-account split settlement
+callbacks and atomically transitions Payout QUEUED -> COMPLETED, moving Payout.platformFee
+from LabWallet.pendingBalance to availableBalance.
+
+Handler is dormant until checkout is migrated to Xendit Managed Sub-Account invoices. (ref: DL-012)
+
+## Files
+
+| File | What | When to read |
+| ---- | ---- | ------------ |
+| `route.ts` | Next.js POST; x-callback-token via timingSafeEqual against XENDIT_SETTLEMENT_WEBHOOK_TOKEN; COMPLETED dispatches to processSettlement | Modifying webhook auth or adding settlement statuses |
+| `handlers.ts` | `processSettlement` — Payout QUEUED -> COMPLETED; LabWallet pendingBalance decrement + availableBalance increment in one $transaction | Modifying settlement logic or balance invariants |
+| `types.ts` | `XenditSettlementPayload` — provisional field shape; all fields marked TODO(sandbox-verify) | Adding fields from Xendit payload |
+| `README.md` | Request flow, AD-001 framing, two-ID scheme, idempotency design, invariants, production wiring | Understanding settlement lifecycle or debugging |
+| `__tests__/handlers.test.ts` | Real-DB integration: first delivery, idempotent duplicate, orphan tolerance, negative-balance guard, PROCESSING contract violation | Running or modifying settlement integration tests |
+| `__tests__/handlers-rollback.test.ts` | Full-mock rollback error propagation: walletUpdate failure, payoutUpdate failure | Running or modifying rollback tests |

```


**CC-M-002-009** (src/features/payments/CLAUDE.md) - implements CI-M-002-009

**Code:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -9,4 +9,5 @@
 | Directory    | What                                                                       | When to read                                              |
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
+| `payouts/`   | Xendit settlement webhook — confirms commission split settled into PipetGo account, transitions Payout QUEUED -> COMPLETED, moves Payout.platformFee from LabWallet.pendingBalance to availableBalance; integration tests in `payouts/__tests__/` | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests |
 | `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler, credits LabWallet.pendingBalance; integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture, lab wallet crediting, or payment capture tests |
```

**Documentation:**

```diff
--- a/src/features/payments/CLAUDE.md
+++ b/src/features/payments/CLAUDE.md
@@ -9,4 +9,5 @@
 | Directory    | What                                                                       | When to read                                              |
 | ------------ | -------------------------------------------------------------------------- | --------------------------------------------------------- |
 | `checkout/`  | Deferred-payment checkout — Xendit invoice creation and redirect           | Implementing or modifying the PAYMENT_PENDING pay flow    |
+| `payouts/`   | Xendit settlement webhook — confirms commission split settled into PipetGo account, transitions Payout QUEUED -> COMPLETED, moves Payout.platformFee from LabWallet.pendingBalance to availableBalance; integration tests in `payouts/__tests__/` | Implementing or modifying commission settlement, lab wallet balance moves, or settlement integration tests |
 | `webhooks/`  | Xendit invoice webhook — verifies x-callback-token, marks Transaction CAPTURED, dispatches to order handler; integration tests in `webhooks/__tests__/` | Implementing or modifying webhook payment capture or payment capture tests |

```

